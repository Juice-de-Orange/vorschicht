/**
 * The Betriebsprüfung (§8.2, A52) — one audit, end to end.
 *
 * Rita reads a diff and asks *is this correct*. Bruno reads the studio and asks
 * *is what this system says about itself true*. This class is the second
 * question executed: it picks a domain, gathers evidence mechanically, draws a
 * sample it records, runs one read-only session in a scratch directory, and
 * then carries out the consequences §8.2 attaches to each class of finding.
 *
 * Four properties are the design.
 *
 * **The auditor never acts; the service does.** §8.2's independence rule 1 —
 * "whoever can make a finding disappear must not decide whether it is real" —
 * has a mirror image that is just as important: whoever decides a finding is
 * real must not be the one who then has to live with the consequence. The
 * session reports; this class un-ticks the gate, files the task, raises the
 * inbox item. The session has no tool that could do any of it.
 *
 * **A `gate_invalid` really does edit `CLAUDE.md`.** It is the only authority in
 * this system that runs backwards through §0's phase discipline, and it would
 * be advisory — which is to say, a log line — if it did not. The safeguards are
 * placed in front of it rather than instead of it: the gate is addressed by id
 * (`gate-book.ts`), an unknown id changes nothing, a `read_only` project (A44.3)
 * refuses the write at the write site, and the same finding always also reaches
 * the operator as a P1 inbox item — through `EscalationService.raise`, so a phase never
 * reopens silently overnight and never fails to reopen silently either.
 *
 * **A consequence says whether it happened.** Every `applied` event carries an
 * explicit `ok`, and a German `problem` beside it when the answer is false.
 * Until 0018 the column was `bool_or(kind = 'applied')` and this class appended
 * that event for every finding including the refusals — so the record said
 * "carried out" about an un-tick that had failed with `EACCES`, and the reason
 * sat under a key the view did not read. A claim about what happened is made by
 * the code that made it happen or it is not made at all.
 *
 * **The un-tick proves itself.** After writing, the file is read back and parsed
 * again: the named gate must actually stand open and must carry the note. A
 * write whose result nobody looks at is the same class of claim as the column
 * above.
 *
 * **An audit that could not run still leaves a row.** §8.2 measures the auditor
 * on finding nothing, and a crashed audit and a clean one are indistinguishable
 * if only completions are recorded. `started` is appended before the session is
 * spawned, exactly as the runner writes `created` before it touches a backend.
 *
 * **The dismissal rule is arithmetic, not etiquette.** §8.2 gives a dismissal
 * exactly one re-examination and then hands the disagreement to the operator. That is
 * enforced by counting `dismissed` events, not by an agreement between two
 * models about whose turn it is.
 */
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import {
  type AuditorResult,
  type EscalateAskInput,
  escalateAskInput,
  MAX_ESCALATION_CONTEXT_LENGTH,
  MAX_ESCALATION_QUESTION_LENGTH,
  type Priority,
  type RunCaps,
} from '@vorschicht/shared';
import type postgres from 'postgres';
import type { EscalationService } from '../escalation-service.js';
import type { EventLog } from '../event-log.js';
import { AGENT_PROFILES } from '../profiles/index.js';
import type { ProjectService } from '../project-service.js';
import type { AgentRunner } from '../runner.js';
import type { TaskService } from '../task-service.js';
import {
  AUDIT_DOMAIN_IDS,
  type AuditDomainId,
  type EvidenceContext,
  getAuditDomain,
  runCommand,
} from './domains.js';
import { findGate, parseGateBook, untickGate } from './gate-book.js';
import { auditorPrompt, type DismissedFinding } from './prompt.js';
import { findingKey, renderPruefbericht } from './report.js';
import { drawSample, seededRng } from './sampling.js';

/** §8.2's cadence, as the reasons an audit starts. */
export const AUDIT_TRIGGERS = [
  /** After a phase closes, before the next one starts. Mandatory, and a gate. */
  'phase_close',
  /** Sunday, so the Monday report (§16) carries the verdict. */
  'weekly',
  'pre_self_deploy',
  'post_rollback',
  'post_hard_stop',
  'post_auth_incident',
  /** A gate flipped red → green with no intervening code change. */
  'gate_flip',
  'manual',
] as const;
export type AuditTrigger = (typeof AUDIT_TRIGGERS)[number];

export type AuditFindingClass = AuditorResult['findings'][number]['class'];
export type AuditVerdict = AuditorResult['verdict'];

/** Priority of the fix task a `defect` produces (§8.2's taxonomy). */
const DEFECT_PRIORITY: Priority = 'P1';
/** A mechanical guard is worth building and is not on fire. */
const GUARD_PRIORITY: Priority = 'P2';
/**
 * A missing proof (A65).
 *
 * P2 rather than P1 deliberately: a coverage gap does not say anything is
 * broken, only that nobody could tell — which is a real cost and not an
 * emergency. P1 here would let a thorough audit fill the queue with urgent work
 * that has no known defect behind it, and the class would be turned off within
 * a week.
 */
const COVERAGE_PRIORITY: Priority = 'P2';

/**
 * The two filesystem operations the un-tick performs, as a seam.
 *
 * Injectable for one reason only, and it is the reason the read-back exists at
 * all: a verification whose failure mode cannot be produced in a test is a line
 * that proves nothing, which is the class of defect this file is being repaired
 * for. The test supplies a writer that silently discards the write, and the
 * read-back has to catch it.
 */
export interface SpecFile {
  read(path: string): Promise<string>;
  write(path: string, source: string): Promise<void>;
}

const REAL_SPEC_FILE: SpecFile = {
  read: (path) => readFile(path, 'utf8'),
  write: (path, source) => writeFile(path, source, 'utf8'),
};

/** Longest free-text fragment quoted into a §15 card, so the card still fits. */
const CARD_FRAGMENT_MAX = 700;

export interface AuditServiceDeps {
  sql: postgres.Sql;
  eventLog: EventLog;
  runner: AgentRunner;
  /** The repository under examination. */
  repoRoot: string;
  /**
   * Where the session runs — a scratch directory, never a worktree.
   *
   * §8.2 independence rule 2: a repository must not be able to instruct its own
   * auditor through a `CLAUDE.md` that loads as system context. The auditor
   * reads that file through `Read`, which is the correct posture towards
   * evidence.
   */
  scratchDir: string;
  /**
   * Where `defect` and `process` fix tasks are filed, and by whom.
   *
   * Optional, and its absence is *reported* rather than hidden: an audit that
   * cannot file a task still produces its report and says in it that the
   * consequence could not be carried out. Losing the report because the
   * follow-up machinery was not configured would be the wrong trade by a wide
   * margin.
   */
  tasks?: TaskService;
  projectId?: string | null;
  /**
   * The file a `gate_invalid` edits. Required, and deliberately not defaulted.
   *
   * It used to default to `<repoRoot>/CLAUDE.md`, and the daemon relied on that
   * default while every test injected the path — so the branch the studio
   * actually took was the one branch nothing exercised. Worse, the fixture set
   * `specPath` to a value that happened to *equal* the default, so deleting the
   * injection would have left the suite green. A default for the path of the
   * only irreversible edit in this system is the wrong shape: the caller that
   * knows which repository is under examination is the caller that must say so.
   */
  specPath: string;
  /**
   * A44.3's `read_only`, enforced where this class touches the filesystem.
   *
   * The flag is described as refusing "worktree, branch and any write at the
   * manager's entrance", and `WorktreeManager` does exactly that — but the
   * auditor reaches `CLAUDE.md` through its own write and never asks. A second
   * door beside a guarded one is §8.2's sixth domain inside the flag built to
   * close it. Wired here, the un-tick is *refused* on a read-only project and
   * the P1 inbox item still fires: the authority §8.2 grants is exercised
   * through the operator rather than through a file nobody merges (§8.2 rule 3 — the
   * auditor is never weakened, only redirected).
   *
   * Fail-closed when a `projectId` is set and this is not: an audit that cannot
   * establish whether it may write does not write.
   */
  projects?: Pick<ProjectService, 'get'>;
  /**
   * §15's inbox. §8.2: a `gate_invalid` "always also reaches the operator as a P1 item".
   *
   * Optional for the reason `tasks` is, and its absence is *reported* in the
   * same way: the finding records that the card could not be delivered and
   * `audit_findings.escalation_number` stays NULL, which is the queryable form
   * of "a phase reopened and nobody was told".
   */
  escalations?: Pick<EscalationService, 'raise'>;
  /** Injected so the un-tick's read-back can be falsified. See `SpecFile`. */
  spec?: SpecFile;
  /** Injected so domain 5's real check can be stood in for. */
  exec?: EvidenceContext['exec'];
  now?: () => Date;
  /** Injected so a sample is reproducible in a test (§8.2: recorded). */
  rng?: (seed: string) => () => number;
  onWarning?(message: string): void;
  /** Tighten the session's caps below the profile's (A32). Never widens. */
  capsCeiling?: Partial<RunCaps>;
}

export interface AuditRequest {
  trigger: AuditTrigger;
  /** German — quoted verbatim in the Prüfbericht. */
  scope: string;
  /** Omitted: chosen from the trigger and the rotation. */
  domain?: AuditDomainId;
  /** Supplied only by tests that need a stable id. */
  auditId?: string;
}

export interface RaisedFinding {
  id: string;
  class: AuditFindingClass;
  summary: string;
  evidence: string;
  gate: string | null;
  guard: string | null;
  reopens: string | null;
  /**
   * What the consequence did, or why it could not. German, for the report.
   *
   * Named `applied` until 0018, which put it one letter away from the boolean
   * column of the same name meaning something else entirely — a German sentence
   * and "was this carried out" are not the same fact and must not share a name
   * in a record whose whole job is to tell claims from evidence.
   */
  consequence: string;
  /** Was the consequence §8.2 attaches to this class actually carried out? */
  consequenceApplied: boolean;
  /** German, non-null exactly when `consequenceApplied` is false. */
  consequenceProblem: string | null;
  /** §15's "#X" — the P1 item this finding became. Null when none was delivered. */
  escalationNumber: number | null;
  /** The fix task, where one was created. */
  taskId: string | null;
  /** The gate this finding un-ticked, where it un-ticked one. */
  untickedGate: string | null;
  /**
   * The consequence was suppressed because the matter is already the operator's (§8.2).
   *
   * Set when the finding re-raises something the dev chain has dismissed twice.
   * A flag rather than a phrase in `applied`, because the escalation path reads
   * it — deciding on the wording of a German sentence is how a rule quietly
   * stops firing the day someone rewrites the sentence.
   */
  blocked: boolean;
}

/** What carrying out one finding's consequence produced. */
interface Consequence {
  /**
   * Did it happen? This is what `audit_findings.applied` reads (0018).
   *
   * Set by the branch that did or did not do the thing, never derived from the
   * existence of a record — the derivation is what made the column lie.
   */
  ok: boolean;
  /** German, for the report and the timeline. */
  note: string;
  /** German, non-null exactly when `ok` is false. Queryable as `apply_problem`. */
  problem: string | null;
  taskId: string | null;
  untickedGate: string | null;
  blocked: boolean;
}

/**
 * The consequence was carried out and it produced nothing else.
 *
 * `suspicion` and `assumption_expired` end here legitimately — §8.2's
 * consequence for them *is* the record and the card — as does a `process`
 * finding that named no guard, where not inventing one is the specified
 * behaviour rather than a failure.
 */
const done = (note: string): Consequence => ({
  ok: true,
  note,
  problem: null,
  taskId: null,
  untickedGate: null,
  blocked: false,
});

/**
 * The consequence did not happen, and this is why.
 *
 * The note and the problem carry the same German sentence on purpose: one is
 * printed in the Prüfbericht, the other is queried in SQL, and a reader of
 * either must not have to find the other to learn that nothing happened.
 */
const refused = (problem: string): Consequence => ({
  ok: false,
  note: problem,
  problem,
  taskId: null,
  untickedGate: null,
  blocked: false,
});

/** Shape check before anything reaches a `uuid` column. See `finding()`. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AuditRun {
  id: string;
  domain: AuditDomainId;
  trigger: AuditTrigger;
  scope: string;
  outcome: 'done' | 'failed';
  verdict: AuditVerdict | null;
  /** The rendered German Prüfbericht (§8.2). */
  report: string | null;
  problem: string | null;
  /** What the service drew and recorded. */
  sample: string[];
  /** What the auditor says it examined. */
  reportedSample: string[];
  scopeLimits: string[];
  findings: RaisedFinding[];
  /** Gates this audit un-ticked, and the phases thereby reopened. */
  unticked: string[];
  /** Prepared decisions for the operator (§15). Phase 4 turns these into inbox cards. */
  escalations: EscalateAskInput[];
  runId: string | null;
}

export class AuditServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuditServiceError';
  }
}

export class AuditService {
  constructor(private readonly deps: AuditServiceDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private warn(message: string): void {
    this.deps.onWarning?.(message);
  }

  private get spec(): SpecFile {
    return this.deps.spec ?? REAL_SPEC_FILE;
  }

  /**
   * Which domain this run examines.
   *
   * A phase close always takes `gate_truth` (A56): it is the run whose
   * consequence — a gate un-ticks and the phase reopens — is the entire reason
   * §8.2 puts an audit *between* two phases rather than merely on a schedule.
   * Everything else rotates by least-recently-examined, so no domain can go a
   * long time unexamined just because it never triggers anything.
   */
  async selectDomain(trigger: AuditTrigger): Promise<AuditDomainId> {
    if (trigger === 'phase_close') return 'gate_truth';

    const rows = await this.deps.sql<Array<{ domain: string; last: Date }>>`
      SELECT domain, max(started_at) AS last FROM audits
      WHERE domain IS NOT NULL GROUP BY domain
    `;
    const seen = new Map(rows.map((row) => [row.domain, row.last.getTime()]));
    let best: AuditDomainId = 'gate_truth';
    let bestAt = Number.POSITIVE_INFINITY;
    for (const id of AUDIT_DOMAIN_IDS) {
      const at = seen.get(id) ?? -1;
      if (at < bestAt) {
        best = id;
        bestAt = at;
      }
    }
    return best;
  }

  /** One audit, from the domain to the consequences. */
  async run(request: AuditRequest): Promise<AuditRun> {
    const auditId = request.auditId ?? randomUUID();
    const domainId = request.domain ?? (await this.selectDomain(request.trigger));
    const domain = getAuditDomain(domainId);
    const exec: EvidenceContext['exec'] =
      this.deps.exec ??
      ((file, args, opts) => runCommand(file, args, this.deps.repoRoot, opts?.timeoutMs));

    let evidence: Awaited<ReturnType<typeof domain.collect>>;
    try {
      evidence = await domain.collect({ repoRoot: this.deps.repoRoot, sql: this.deps.sql, exec });
    } catch (error) {
      // Evidence gathering that throws is a harness failure, and it has to leave
      // a row: an audit that never started and one that found nothing are the
      // same shape from outside (§8.2 rule 5).
      const problem = `Beweisaufnahme fehlgeschlagen: ${(error as Error).message}`;
      await this.append(auditId, 'started', {
        domain: domainId,
        trigger: request.trigger,
        scope: request.scope,
        sample: [],
      });
      return this.fail(auditId, domainId, request, problem, null, []);
    }

    const passed = await this.previouslyPassed(domainId);
    const sample = drawSample({
      pool: evidence.pool,
      size: domain.sampleSize,
      passed,
      rng: (this.deps.rng ?? seededRng)(auditId),
    });
    const dismissed = await this.dismissedOnce();

    await this.append(auditId, 'started', {
      domain: domainId,
      trigger: request.trigger,
      scope: request.scope,
      sample: sample.items,
      regression: sample.regression,
      sampleNote: sample.note,
      poolSize: evidence.pool.length,
    });
    await this.deps.eventLog.append({
      kind: 'audit.started',
      actor: 'auditor',
      payload: { auditId, domain: domainId, trigger: request.trigger, scope: request.scope },
    });

    // Gathered after the draw, because it is about the items that were drawn
    // (A56). A collector that could not answer must not lose the audit: the
    // failure becomes a scope limit, which is the honest shape for it.
    let detail: string[] = [];
    if (domain.detail && sample.items.length > 0) {
      try {
        detail = await domain.detail(
          { repoRoot: this.deps.repoRoot, sql: this.deps.sql, exec },
          sample.items,
        );
      } catch (error) {
        const problem = `Zusatzbelege zur Stichprobe nicht ermittelbar: ${(error as Error).message}`;
        this.warn(problem);
        evidence.limits = [...evidence.limits, problem];
      }
    }

    const prompt = auditorPrompt({
      auditId,
      domain,
      scope: request.scope,
      trigger: request.trigger,
      sample,
      brief: evidence.brief,
      detail,
      limits: evidence.limits,
      dismissed,
      cwd: this.deps.scratchDir,
      repoRoot: this.deps.repoRoot,
    });

    const outcome = await this.deps.runner.run({
      // No task: an audit examines the studio rather than a unit of work, and a
      // run without a task runs without MCP by construction (see the runner).
      taskId: null,
      projectId: this.deps.projectId ?? null,
      profile: AGENT_PROFILES.auditor,
      prompt,
      cwd: this.deps.scratchDir,
      containment: { writeRoot: null, claims: null, readOnlyProject: false },
      ...(this.deps.capsCeiling ? { capsCeiling: this.deps.capsCeiling } : {}),
    });

    if (outcome.status !== 'ok') {
      return this.fail(
        auditId,
        domainId,
        request,
        `Die Prüfsitzung endete als "${outcome.status}": ${outcome.problem}`,
        outcome.run.runId,
        sample.items,
      );
    }

    const result = outcome.result;
    const findings = await this.raise(auditId, domainId, result);
    const report = renderPruefbericht({
      auditId,
      domainLabel: domain.label,
      domain: domainId,
      scope: request.scope,
      trigger: request.trigger,
      proposedSample: sample.items,
      result,
      taskRefs: Object.fromEntries(
        result.findings
          .map((finding, index) => [findingKey(finding), findings[index]?.taskId] as const)
          .filter((entry): entry is readonly [string, string] => typeof entry[1] === 'string'),
      ),
      consequences: Object.fromEntries(
        result.findings.map(
          (finding, index) => [findingKey(finding), findings[index]?.consequence ?? ''] as const,
        ),
      ),
      date: this.now().toISOString().slice(0, 10),
    });

    const unticked = findings
      .map((finding) => finding.untickedGate)
      .filter((gate): gate is string => gate !== null);

    const escalations = await this.escalate(auditId, domainId, findings, result);

    await this.append(auditId, 'finished', {
      verdict: result.verdict,
      report,
      // The auditor's own prose, unabridged. The report is capped (§8.2); the
      // record is not, and the first real audit is why the two are separated —
      // its findings filled the whole cap and the prose was cut to nothing.
      summary: result.summary,
      reportedSample: result.sample,
      scopeLimits: result.scopeLimits,
      runId: outcome.run.runId,
      findings: findings.length,
      unticked,
    });
    await this.deps.eventLog.append({
      kind: 'audit.finished',
      actor: 'auditor',
      runId: outcome.run.runId,
      payload: {
        auditId,
        domain: domainId,
        verdict: result.verdict,
        findings: findings.length,
        suspicions: findings.filter((f) => f.class === 'suspicion').length,
        scopeLimits: result.scopeLimits.length,
        unticked,
      },
    });

    return {
      id: auditId,
      domain: domainId,
      trigger: request.trigger,
      scope: request.scope,
      outcome: 'done',
      verdict: result.verdict,
      report,
      problem: null,
      sample: sample.items,
      reportedSample: [...result.sample],
      scopeLimits: [...result.scopeLimits],
      findings,
      unticked,
      escalations,
      runId: outcome.run.runId,
    };
  }

  // --- the taxonomy's consequences (§8.2) ------------------------------------

  /**
   * Record every finding, then carry out what its class obliges.
   *
   * Order matters within one finding: it is written down *before* the
   * consequence is attempted, so a consequence that throws leaves a recorded
   * finding with a recorded problem rather than a finding nobody knows about.
   */
  private async raise(
    auditId: string,
    domain: AuditDomainId,
    result: AuditorResult,
  ): Promise<RaisedFinding[]> {
    const raised: RaisedFinding[] = [];

    for (const finding of result.findings) {
      const id = randomUUID();
      await this.appendFinding(id, 'raised', 'auditor', {
        auditId,
        domain,
        class: finding.class,
        summary: finding.summary,
        evidence: finding.evidence,
        gate: finding.gate ?? null,
        guard: finding.guard ?? null,
        reopens: finding.reopens ?? null,
      });

      // Wrapped for the same reason `finding()` checks the id: one finding with
      // a reference nobody can resolve must cost that reference and nothing
      // else. An audit lost on the way to being recorded is the one outcome
      // §8.2 cannot distinguish from an auditor that found nothing.
      let reopen: { blocked: boolean; note: string } | null = null;
      if (finding.reopens) {
        try {
          reopen = await this.applyReopen(id, finding.reopens);
        } catch (error) {
          const problem = `Wiederaufnahme nicht auswertbar: ${(error as Error).message}`;
          this.warn(`Fund ${id}: ${problem}`);
          reopen = { blocked: false, note: problem };
        }
      }

      const consequence: Consequence = reopen?.blocked
        ? // Deliberately `ok: false`. §8.2 prescribes the suppression, so this is
          // not a malfunction — but the consequence the *class* carries (an
          // un-tick, a fix task) did not happen, and a column that said "carried
          // out" here would be the same overstatement 0018 removed one branch
          // over. The reason names §8.2, and `blocked` says which kind of
          // not-happening this is.
          { ...refused(reopen.note), blocked: true }
        : await this.applyConsequence(auditId, id, finding).catch((error: Error) => {
            // A consequence that throws must not lose the finding: the record is
            // already written, and the problem belongs beside it rather than in
            // place of it.
            this.warn(`Fund ${id}: Folge konnte nicht ausgeführt werden — ${error.message}`);
            return refused(`Folge nicht ausgeführt: ${error.message}`);
          });

      const note =
        reopen && !reopen.blocked ? `${reopen.note} ${consequence.note}` : consequence.note;
      await this.appendFinding(id, 'applied', 'orchestrator', {
        // 0018 reads this key and nothing else. Everything beside it is context
        // for a human; this is the claim.
        ok: consequence.ok,
        note,
        problem: consequence.problem,
        fixTaskId: consequence.taskId,
        untickedGate: consequence.untickedGate,
        ...(reopen ? { reopens: finding.reopens, blocked: reopen.blocked } : {}),
      });

      raised.push({
        id,
        class: finding.class,
        summary: finding.summary,
        evidence: finding.evidence,
        gate: finding.gate ?? null,
        guard: finding.guard ?? null,
        reopens: finding.reopens ?? null,
        consequence: note,
        consequenceApplied: consequence.ok,
        consequenceProblem: consequence.problem,
        escalationNumber: null,
        taskId: consequence.taskId,
        untickedGate: consequence.untickedGate,
        blocked: consequence.blocked,
      });

      await this.deps.eventLog.append({
        kind: 'audit.finding',
        actor: 'auditor',
        taskId: consequence.taskId,
        payload: {
          auditId,
          findingId: id,
          class: finding.class,
          summary: finding.summary,
          gate: finding.gate ?? null,
          untickedGate: consequence.untickedGate,
          applied: consequence.ok,
          problem: consequence.problem,
        },
      });
    }

    return raised;
  }

  /** §8.2: a dismissal is re-opened exactly once; the second one goes to the operator. */
  private async applyReopen(
    newFindingId: string,
    priorId: string,
  ): Promise<{ blocked: boolean; note: string }> {
    const prior = await this.finding(priorId);
    if (!prior) {
      return {
        blocked: false,
        note:
          `Der Fund verweist auf einen früheren Fund ${priorId.slice(0, 8)}, den es nicht gibt; ` +
          'er wird als neuer Fund behandelt.',
      };
    }
    if (prior.dismissals >= 2) {
      // The loop stops here by construction: two agents disagreeing twice is a
      // decision, not a cycle to keep running.
      await this.appendFinding(priorId, 'escalated', 'orchestrator', {
        reason: 'Zweite Zurückweisung — die Sache geht an den Betreiber (§8.2).',
        reraisedBy: newFindingId,
      });
      return {
        blocked: true,
        note:
          `Bereits zweimal zurückgewiesen (Fund ${priorId.slice(0, 8)}). Die Wiederaufnahme ` +
          'löst keine Folge mehr aus; die Entscheidung liegt beim Betreiber (§8.2).',
      };
    }
    await this.appendFinding(priorId, 'reopened', 'auditor', { reraisedBy: newFindingId });
    return {
      blocked: false,
      note: `Wiederaufnahme von Fund ${priorId.slice(0, 8)} nach Zurückweisung.`,
    };
  }

  private async applyConsequence(
    auditId: string,
    findingId: string,
    finding: AuditorResult['findings'][number],
  ): Promise<Consequence> {
    switch (finding.class) {
      case 'gate_invalid':
        return this.untick(findingId, finding);
      case 'defect':
        return this.fileTask(auditId, findingId, finding, DEFECT_PRIORITY, 'Prüfungsfund beheben');
      case 'process':
        return finding.guard
          ? this.fileTask(
              auditId,
              findingId,
              finding,
              GUARD_PRIORITY,
              'Mechanische Absicherung bauen',
            )
          : done(
              'Verfahrensfund festgehalten. Der Bericht nennt keine mechanische Absicherung, ' +
                'also wurde keine Aufgabe erfunden.',
            );
      // Unconditional, which is the whole difference to `process` above (A65).
      // There the guard is a proposal and inventing one is worse than recording
      // that a rule was broken. Here the work is the finding: a proof the
      // project should have and does not. A read-only auditor is the wrong
      // party to have to know the build system well enough to specify how, so
      // requiring `guard` would put this class back where it came from —
      // reported, and quietly producing nothing.
      case 'coverage_gap':
        return this.fileTask(
          auditId,
          findingId,
          finding,
          COVERAGE_PRIORITY,
          'Fehlenden Nachweis bauen',
        );
      case 'assumption_expired':
        return done(
          'Als Entscheidung für den Betreiber vorbereitet (revidieren, bestätigen oder zurückziehen).',
        );
      case 'suspicion':
        return done(
          'Verdacht festgehalten. Er blockiert nichts und wird zur nächsten Prüfung mitgenommen.',
        );
      default:
        // A class the taxonomy gained and this switch did not. Not "carried
        // out": nothing was, and `leaves no finding class without a consequence`
        // is the test that fails when it happens.
        return refused('Keine Folge vorgesehen.');
    }
  }

  /**
   * The un-tick (§8.2), against the real `CLAUDE.md`.
   *
   * Deliberately not committed here. The edit is a fact about the repository and
   * belongs in whatever commit the session that reads this report makes — a
   * service that committed on its own would put a change into the history with
   * no gate run behind it, which is the very thing domain 7 audits.
   */
  private async untick(
    findingId: string,
    finding: AuditorResult['findings'][number],
  ): Promise<Consequence> {
    if (!finding.gate) {
      return refused(
        'Der Fund entwertet ein Gate, nennt aber keine Gate-Id. Es wurde kein Haken ' +
          'entfernt — ein ungefährer Treffer würde das falsche Gate öffnen.',
      );
    }

    const forbidden = await this.writeRefusal();
    if (forbidden) return refused(forbidden);

    let source: string;
    try {
      source = await this.spec.read(this.deps.specPath);
    } catch (error) {
      return refused(
        `CLAUDE.md unter ${this.deps.specPath} war nicht lesbar (${(error as Error).message}); ` +
          'der Haken blieb stehen.',
      );
    }

    const result = untickGate({
      source,
      gateId: finding.gate,
      reason: finding.summary,
      findingId,
      date: this.now().toISOString().slice(0, 10),
    });
    if (!result.ok) return refused(result.problem);

    try {
      await this.spec.write(this.deps.specPath, result.source);
    } catch (error) {
      return refused(
        `Der Haken von ${result.gate.id} konnte nicht entfernt werden: ` +
          `${(error as Error).message}. Die Datei ist unverändert.`,
      );
    }

    const unproven = await this.proveUntick(result.gate.id, result.note);
    if (unproven) return refused(unproven);

    return {
      ok: true,
      note:
        `Gate ${result.gate.id} (Phase ${result.gate.phase}) wurde in CLAUDE.md geöffnet; ` +
        `die Phase ist wieder offen. Vermerk: ${result.note}`,
      problem: null,
      taskId: null,
      untickedGate: result.gate.id,
      blocked: false,
    };
  }

  /**
   * May this audit write to the spec file at all? (A44.3.)
   *
   * Fails closed in both directions that are not a plain "yes". A project set to
   * read-only refuses, which is A44.3's rule reaching the second door; and a
   * `projectId` with no way to look it up refuses too, because "we could not
   * find out whether we are allowed" and "we are allowed" are the same sentence
   * only to a system that has decided not to notice. An audit bound to no
   * project has no flag to obey and writes — that is `run-audit.mjs` against a
   * scratch database, and it is stated rather than silently permitted.
   */
  private async writeRefusal(): Promise<string | null> {
    const projectId = this.deps.projectId;
    if (!projectId) return null;

    if (!this.deps.projects) {
      return (
        'Ob dieses Projekt beschrieben werden darf, ließ sich nicht feststellen — der Prüfung ' +
        'ist ein Projekt zugeordnet, aber kein Projektverzeichnis. Der Haken blieb stehen ' +
        '(A44.3, im Zweifel nicht schreiben). Der Fund ist unverändert gültig und liegt als ' +
        'Entscheidung im Postfach.'
      );
    }

    const project = await this.deps.projects.get(projectId);
    if (!project) {
      return (
        `Das Projekt ${projectId} gibt es nicht (mehr); der Haken blieb stehen. Der Fund ist ` +
        'unverändert gültig und liegt als Entscheidung im Postfach.'
      );
    }
    if (project.readOnly) {
      return (
        `Das Projekt „${project.slug}" ist auf Nur-Lesen gestellt (A44.3), also wurde in ` +
        'CLAUDE.md nichts geändert. Die Befugnis der Betriebsprüfung bleibt bestehen — sie ' +
        'wird über die Entscheidung im Postfach ausgeübt statt über eine Datei, die niemand ' +
        'zusammenführt (§8.2).'
      );
    }
    return null;
  }

  /**
   * Read the file back and check that the un-tick is actually in it.
   *
   * A write whose result nobody looks at is a claim, and this class is being
   * repaired for making claims. Three things have to hold afterwards: the gate
   * is still findable by its id, it stands `open`, and it carries the note. The
   * third is what separates "the file changed" from "the file changed in the
   * way we meant" — a writer that dropped the tail, or an editor that saved over
   * the file in between, passes the first two.
   */
  private async proveUntick(gateId: string, note: string): Promise<string | null> {
    let after: string;
    try {
      after = await this.spec.read(this.deps.specPath);
    } catch (error) {
      return (
        `Der Haken von ${gateId} wurde geschrieben, aber CLAUDE.md war danach nicht mehr ` +
        `lesbar (${(error as Error).message}) — es ist nicht belegt, dass die Phase wirklich ` +
        'wieder offen ist.'
      );
    }

    const gate = findGate(parseGateBook(after), gateId);
    if (!gate) {
      return (
        `Nach dem Schreiben findet sich ${gateId} nicht mehr in CLAUDE.md. Es ist nicht ` +
        'belegt, dass die Phase wieder offen ist.'
      );
    }
    if (gate.state !== 'open') {
      return (
        `Nach dem Schreiben steht ${gateId} in CLAUDE.md weiterhin auf „${gate.state}". Der ` +
        'Haken ist nicht entfernt worden.'
      );
    }
    if (!after.includes(note)) {
      return (
        `${gateId} steht zwar offen, aber der Vermerk der Betriebsprüfung fehlt in der Datei. ` +
        'Ein Haken ohne Begründung ist kein nachvollziehbarer Vorgang (§8.2).'
      );
    }
    return null;
  }

  private async fileTask(
    auditId: string,
    findingId: string,
    finding: AuditorResult['findings'][number],
    priority: Priority,
    prefix: string,
  ): Promise<Consequence> {
    const projectId = this.deps.projectId;
    if (!this.deps.tasks || !projectId) {
      return refused(
        'Es konnte keine Aufgabe angelegt werden: der Prüfung ist kein Projekt zugeordnet. ' +
          'Der Fund steht im Bericht und ist unverändert gültig.',
      );
    }
    const task = await this.deps.tasks.create({
      projectId,
      title: `${prefix}: ${clampTitle(finding.summary)}`,
      description: [
        `Aus der Betriebsprüfung ${auditId.slice(0, 8)} (Fund ${findingId.slice(0, 8)}, ` +
          `Klasse \`${finding.class}\`).`,
        '',
        finding.summary,
        '',
        `**Beleg des Prüfers:** ${finding.evidence}`,
        ...(finding.guard ? ['', `**Vorgeschlagene Absicherung:** ${finding.guard}`] : []),
      ].join('\n'),
      acceptanceCriteria: [
        'Der Fund ist behoben, oder mit einem Beleg widerlegt, der so konkret ist wie der des Prüfers.',
        'Die Änderung geht durch die normale Kette und die normalen Gates (§8.1, §11).',
      ],
      priority,
      department: 'Entwicklung',
      type: 'audit_finding',
      actor: 'auditor',
    });
    return {
      ok: true,
      note: `Aufgabe ${task.id} mit Priorität ${priority} angelegt.`,
      problem: null,
      taskId: task.id,
      untickedGate: null,
      blocked: false,
    };
  }

  // --- what goes to the operator (§15) ------------------------------------------------

  /**
   * The prepared decisions this audit produced — and their delivery (§15).
   *
   * §15's format is enforced by parsing each card with the same schema
   * `escalate.ask` uses, so a card this service builds cannot be shaped
   * differently from one an agent builds. Until Phase 4 the cards travelled only
   * as `event_log` rows carrying `source: 'audit'` — a string that is not a
   * member of `ESCALATION_SOURCES` — so §8.2's stated safeguard ("the same
   * finding always also reaches the operator as a P1 item") was a shape nobody could
   * find in the inbox. They now go through `EscalationService.raise`, and what
   * happened to each one is recorded on the finding.
   *
   * **`taskId` is null, deliberately.** `Scheduler.resumeDecided` reads the
   * latest escalation *of a task* and continues the session parked on it; an
   * audit card hung on the fix task would sit in exactly that slot and answer a
   * question about a session that never asked one. The linkage runs the other
   * way — the escalation number on the finding's `escalated` event, and the
   * audit and finding ids inside the German context the operator reads.
   *
   * **`audit_finding` is not policy memory** (`POLICY_MEMORY_SOURCES`), and this
   * is the sharpest reason the list is short: "Fund verwerfen — Haken wieder
   * setzen" answered once would otherwise re-tick a *later* gate from memory,
   * with nobody asked.
   */
  private async escalate(
    auditId: string,
    domain: AuditDomainId,
    findings: RaisedFinding[],
    result: AuditorResult,
  ): Promise<EscalateAskInput[]> {
    const cards: EscalateAskInput[] = [];

    for (const finding of findings) {
      const card = finding.blocked
        ? twiceDismissedCard({
            summary: finding.summary,
            evidence: finding.evidence,
            reason: finding.consequence,
          })
        : finding.class === 'gate_invalid'
          ? gateInvalidCard(finding)
          : finding.class === 'assumption_expired'
            ? assumptionCard(finding)
            : null;
      if (!card) continue;

      const parsed = escalateAskInput.safeParse(card);
      if (!parsed.success) {
        // A malformed card is our defect, not a reason to lose the finding.
        this.warn(`Fund ${finding.id}: Entscheidungskarte ungültig — ${parsed.error.message}`);
        continue;
      }
      cards.push(parsed.data);
      await this.deps.eventLog.append({
        kind: 'escalation.requested',
        actor: 'auditor',
        payload: {
          source: 'audit_finding',
          auditId,
          domain,
          findingId: finding.id,
          verdict: result.verdict,
          ...parsed.data,
        },
      });
      finding.escalationNumber = await this.deliver(auditId, domain, finding.id, parsed.data);
    }

    return cards;
  }

  /**
   * Put one card in the inbox and record what became of it.
   *
   * Never throws. §8.2's consequence has already been carried out (or refused)
   * by the time this runs, and losing the audit because the inbox was briefly
   * unreachable would be the same trade `RedPath.raiseInboxItem` already
   * refuses. What is left instead is a fact an audit can find: a `gate_invalid`
   * whose `audit_findings.escalation_number` is NULL is a phase that reopened —
   * or failed to — with nobody told.
   */
  private async deliver(
    auditId: string,
    domain: string,
    findingId: string,
    card: EscalateAskInput,
  ): Promise<number | null> {
    const trail =
      `Betriebsprüfung ${auditId.slice(0, 8)}, Fund ${findingId.slice(0, 8)}, ` +
      `Domäne \`${domain}\`.`;

    if (!this.deps.escalations) {
      const problem = `Kein Postfach angebunden — die Entscheidung wurde nicht zugestellt. ${trail}`;
      this.warn(`Fund ${findingId}: ${problem}`);
      await this.appendFinding(findingId, 'escalated', 'orchestrator', { problem, auditId });
      return null;
    }

    try {
      const escalation = await this.deps.escalations.raise({
        source: 'audit_finding',
        question: clip(card.question, MAX_ESCALATION_QUESTION_LENGTH),
        context: clip(`${card.context} ${trail}`, MAX_ESCALATION_CONTEXT_LENGTH),
        urgency: card.urgency,
        options: card.options,
        projectId: this.deps.projectId ?? null,
        taskId: null,
        runId: null,
        raisedBy: 'auditor',
      });
      await this.appendFinding(findingId, 'escalated', 'orchestrator', {
        reason: 'Als Entscheidung für den Betreiber ins Postfach gelegt (§8.2, §15).',
        escalationNumber: escalation.number,
        escalationId: escalation.id,
        auditId,
      });
      return escalation.number;
    } catch (error) {
      const problem =
        `Die Entscheidung konnte nicht ins Postfach gelegt werden: ${(error as Error).message}. ` +
        `${trail}`;
      this.warn(`Fund ${findingId}: ${problem}`);
      await this.appendFinding(findingId, 'escalated', 'orchestrator', { problem, auditId });
      return null;
    }
  }

  // --- the finding's later life ---------------------------------------------

  /** The dev chain accepted the finding. */
  async confirm(findingId: string, actor: string, reason?: string): Promise<void> {
    await this.appendFinding(findingId, 'confirmed', actor, { reason: reason ?? null });
  }

  /**
   * The dev chain rejected the finding (§8.2).
   *
   * The second rejection *stands* — the finding closes as dismissed — and goes
   * to the operator as a decision. That is the whole rule, and it is counted rather than
   * remembered: an orchestrator restart between the two dismissals changes
   * nothing, which is the property that matters in an unattended system.
   */
  async dismiss(
    findingId: string,
    actor: string,
    reason: string,
  ): Promise<{ dismissals: number; escalated: boolean }> {
    const prior = await this.finding(findingId);
    if (!prior) throw new AuditServiceError(`Prüfungsfund ${findingId} ist unbekannt.`);

    await this.appendFinding(findingId, 'dismissed', actor, { reason });
    const dismissals = prior.dismissals + 1;
    if (dismissals < 2) return { dismissals, escalated: false };

    await this.appendFinding(findingId, 'escalated', 'orchestrator', {
      reason: 'Zweite Zurückweisung — die Sache geht an den Betreiber (§8.2).',
    });
    const card = escalateAskInput.parse(
      twiceDismissedCard({ summary: prior.summary, evidence: prior.evidence, reason }),
    );
    await this.deps.eventLog.append({
      kind: 'escalation.requested',
      actor: 'orchestrator',
      payload: { source: 'audit_finding', findingId, dismissals, ...card },
    });
    // The same delivery the run itself uses. Without it this branch was the
    // second place a card was prepared and never posted.
    await this.deliver(prior.auditId, prior.domain, findingId, card);
    return { dismissals, escalated: true };
  }

  /** The fix merged. */
  async resolve(findingId: string, actor: string, taskId?: string): Promise<void> {
    await this.appendFinding(findingId, 'resolved', actor, { taskId: taskId ?? null });
  }

  /** The operator decided it stands as it is (§22's "or explicitly waived by the operator"). */
  async waive(findingId: string, reason: string): Promise<void> {
    await this.appendFinding(findingId, 'waived', 'max', { reason });
  }

  // --- reads ----------------------------------------------------------------

  async get(auditId: string): Promise<AuditRecord | null> {
    const rows = await this.deps.sql<AuditRow[]>`SELECT * FROM audits WHERE id = ${auditId}`;
    const row = rows[0];
    return row ? mapAudit(row) : null;
  }

  async recent(limit = 20): Promise<AuditRecord[]> {
    const rows = await this.deps.sql<AuditRow[]>`
      SELECT * FROM audits ORDER BY started_at DESC LIMIT ${limit}
    `;
    return rows.map(mapAudit);
  }

  /**
   * One finding by id, or null.
   *
   * The id is checked for shape before it reaches the query, and that is not
   * defensive habit — it is a defect the first real audit produced. The model
   * set `reopens` to `"Phase 1"`, Postgres refused to cast it to `uuid`, and an
   * otherwise complete audit was lost to an exception on the way to recording
   * it. An unknown reference is a fact about one finding; it must never cost
   * the report.
   */
  async finding(id: string): Promise<AuditFindingRecord | null> {
    if (!UUID.test(id.trim())) return null;
    const rows = await this.deps.sql<FindingRow[]>`
      SELECT * FROM audit_findings WHERE id = ${id.trim()}
    `;
    const row = rows[0];
    return row ? mapFinding(row) : null;
  }

  async findingsOf(auditId: string): Promise<AuditFindingRecord[]> {
    const rows = await this.deps.sql<FindingRow[]>`
      SELECT * FROM audit_findings WHERE audit_id = ${auditId} ORDER BY raised_at
    `;
    return rows.map(mapFinding);
  }

  /**
   * Controlling's metric on the auditor itself (§8.2 rule 5).
   *
   * Both failure directions are visible here and both are inbox items: drift
   * into noise, and prolonged silence while other channels keep finding
   * defects. From outside, a working auditor and a broken one look identical —
   * this ratio is the only thing that separates them.
   */
  async scorecard(since?: Date): Promise<AuditScorecard> {
    const from = since ?? new Date(0);
    const rows = await this.deps.sql<Array<{ status: string; class: string; n: string }>>`
      SELECT status, class, count(*)::text AS n FROM audit_findings
      WHERE raised_at >= ${from} GROUP BY status, class
    `;
    const audits = await this.deps.sql<Array<{ outcome: string; n: string }>>`
      SELECT outcome, count(*)::text AS n FROM audits WHERE started_at >= ${from} GROUP BY outcome
    `;
    const count = (predicate: (row: { status: string; class: string }) => boolean): number =>
      rows.filter(predicate).reduce((sum, row) => sum + Number(row.n), 0);

    return {
      audits: audits.reduce((sum, row) => sum + Number(row.n), 0),
      auditsFailed: audits
        .filter((row) => row.outcome === 'failed')
        .reduce((s, r) => s + Number(r.n), 0),
      findings: count(() => true),
      suspicions: count((row) => row.class === 'suspicion'),
      confirmed: count((row) => row.status === 'confirmed' || row.status === 'resolved'),
      dismissed: count((row) => row.status === 'dismissed'),
      open: count((row) => row.status === 'open'),
    };
  }

  /**
   * Items previous audits of this domain examined and did not fault (§8.2).
   *
   * "Did not fault" is read from the audit's own record rather than from a flag:
   * a sampled item is *passed* when no finding of that audit mentions it. That
   * is a text match, and deliberately a generous one — the cost of a false
   * "passed" is that a clean item gets re-examined, and the cost of the opposite
   * is that a faulted item is presented to the next audit as previously fine.
   */
  private async previouslyPassed(domain: AuditDomainId): Promise<string[]> {
    const rows = await this.deps.sql<Array<{ id: string; sample: string[] }>>`
      SELECT id::text, sample FROM audits
      WHERE domain = ${domain} AND outcome = 'done'
      ORDER BY started_at ASC LIMIT 20
    `;
    if (rows.length === 0) return [];

    const faulted = await this.deps.sql<
      Array<{ audit_id: string; summary: string; evidence: string }>
    >`
      SELECT audit_id::text, summary, evidence FROM audit_findings
      WHERE audit_id = ANY(${rows.map((row) => row.id)}::uuid[])
    `;
    const byAudit = new Map<string, string>();
    for (const row of faulted) {
      byAudit.set(
        row.audit_id,
        `${byAudit.get(row.audit_id) ?? ''} ${row.summary} ${row.evidence}`,
      );
    }

    const passed: string[] = [];
    for (const row of rows) {
      const text = byAudit.get(row.id) ?? '';
      for (const item of row.sample ?? []) {
        if (!text.includes(item)) passed.push(item);
      }
    }
    return passed;
  }

  /** Findings the dev chain rejected once, owed one re-examination (§8.2). */
  private async dismissedOnce(): Promise<DismissedFinding[]> {
    const rows = await this.deps.sql<FindingRow[]>`
      SELECT * FROM audit_findings
      WHERE status = 'dismissed' AND dismissals = 1
      ORDER BY raised_at DESC LIMIT 10
    `;
    return rows.map((row) => ({
      id: row.id,
      domain: row.domain,
      class: row.class,
      summary: row.summary,
      evidence: row.evidence,
      reason: row.status_reason,
      dismissals: Number(row.dismissals),
    }));
  }

  // --- writes ---------------------------------------------------------------

  private async append(
    auditId: string,
    kind: 'started' | 'finished' | 'failed',
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.sql`
      INSERT INTO audit_events (audit_id, seq, kind, payload)
      SELECT ${auditId}, COALESCE(max(seq) + 1, 0), ${kind},
             ${this.deps.sql.json(payload as postgres.JSONValue)}
      FROM audit_events WHERE audit_id = ${auditId}
    `;
  }

  private async appendFinding(
    findingId: string,
    kind: string,
    actor: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.sql`
      INSERT INTO audit_finding_events (finding_id, seq, kind, actor, payload)
      SELECT ${findingId}, COALESCE(max(seq) + 1, 0), ${kind}, ${actor},
             ${this.deps.sql.json(payload as postgres.JSONValue)}
      FROM audit_finding_events WHERE finding_id = ${findingId}
    `;
  }

  private async fail(
    auditId: string,
    domain: AuditDomainId,
    request: AuditRequest,
    problem: string,
    runId: string | null,
    sample: string[],
  ): Promise<AuditRun> {
    this.warn(`Betriebsprüfung ${auditId.slice(0, 8)}: ${problem}`);
    await this.append(auditId, 'failed', { problem, runId });
    await this.deps.eventLog.append({
      kind: 'audit.finished',
      actor: 'auditor',
      runId,
      payload: { auditId, domain, outcome: 'failed', problem },
    });
    return {
      id: auditId,
      domain,
      trigger: request.trigger,
      scope: request.scope,
      outcome: 'failed',
      verdict: null,
      report: null,
      problem,
      sample,
      reportedSample: [],
      scopeLimits: [],
      findings: [],
      unticked: [],
      escalations: [],
      runId,
    };
  }
}

// --- records ----------------------------------------------------------------

export interface AuditRecord {
  id: string;
  startedAt: Date;
  finishedAt: Date | null;
  domain: string | null;
  trigger: string | null;
  scope: string | null;
  sample: string[];
  reportedSample: string[];
  scopeLimits: string[];
  verdict: AuditVerdict | null;
  report: string | null;
  problem: string | null;
  runId: string | null;
  outcome: 'running' | 'done' | 'failed';
}

export interface AuditFindingRecord {
  id: string;
  auditId: string;
  domain: string;
  class: AuditFindingClass;
  summary: string;
  evidence: string;
  gate: string | null;
  guard: string | null;
  reopens: string | null;
  raisedAt: Date;
  status: string;
  statusReason: string | null;
  dismissals: number;
  /** Was the consequence carried out? Since 0018 this is a fact, not a row count. */
  applied: boolean;
  fixTaskId: string | null;
  /** German — why it was not. Non-null exactly when `applied` is false. */
  applyProblem: string | null;
  /** German — what happened, whichever way it went. */
  applyNote: string | null;
  /** The gate this finding really opened. Null when none was. */
  untickedGate: string | null;
  /** §15's "#X" — the P1 item this finding became (§8.2). */
  escalationNumber: number | null;
}

export interface AuditScorecard {
  audits: number;
  auditsFailed: number;
  findings: number;
  suspicions: number;
  confirmed: number;
  dismissed: number;
  open: number;
}

interface AuditRow {
  id: string;
  started_at: Date;
  finished_at: Date | null;
  domain: string | null;
  trigger: string | null;
  scope: string | null;
  sample: string[] | null;
  reported_sample: string[] | null;
  scope_limits: string[] | null;
  verdict: string | null;
  report: string | null;
  problem: string | null;
  run_id: string | null;
  outcome: string;
}

interface FindingRow {
  id: string;
  audit_id: string;
  domain: string;
  class: string;
  summary: string;
  evidence: string;
  gate: string | null;
  guard: string | null;
  reopens: string | null;
  raised_at: Date;
  status: string;
  status_reason: string | null;
  dismissals: string | number;
  applied: boolean;
  fix_task_id: string | null;
  apply_problem: string | null;
  apply_note: string | null;
  unticked_gate: string | null;
  escalation_number: string | number | null;
}

function mapAudit(row: AuditRow): AuditRecord {
  return {
    id: row.id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    domain: row.domain,
    trigger: row.trigger,
    scope: row.scope,
    sample: row.sample ?? [],
    reportedSample: row.reported_sample ?? [],
    scopeLimits: row.scope_limits ?? [],
    verdict: (row.verdict as AuditVerdict | null) ?? null,
    report: row.report,
    problem: row.problem,
    runId: row.run_id,
    outcome: row.outcome as AuditRecord['outcome'],
  };
}

function mapFinding(row: FindingRow): AuditFindingRecord {
  return {
    id: row.id,
    auditId: row.audit_id,
    domain: row.domain,
    class: row.class as AuditFindingClass,
    summary: row.summary,
    evidence: row.evidence,
    gate: row.gate,
    guard: row.guard,
    reopens: row.reopens,
    raisedAt: row.raised_at,
    status: row.status,
    statusReason: row.status_reason,
    dismissals: Number(row.dismissals),
    applied: row.applied,
    fixTaskId: row.fix_task_id,
    applyProblem: row.apply_problem,
    applyNote: row.apply_note,
    untickedGate: row.unticked_gate,
    escalationNumber: row.escalation_number === null ? null : Number(row.escalation_number),
  };
}

/**
 * Cut a free-text fragment down so the §15 card it goes into still validates.
 *
 * The card's schema caps question and context, and `safeParse` *discards* a card
 * it refuses — so an auditor with a thorough evidence line used to cost the
 * whole inbox item, silently. Same failure A77.10 found in §9's card, and the
 * same answer: clip, and say that it was clipped.
 */
function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 2)}…`;
}

// --- §15 cards --------------------------------------------------------------

function clampTitle(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function gateInvalidCard(finding: {
  id: string;
  summary: string;
  evidence: string;
  gate: string | null;
  consequence: string;
}): EscalateAskInput {
  return {
    // The gate id comes from the model and the contract does not bound it
    // (`auditFinding.gate` is a plain optional string). An auditor that pasted a
    // gate's *text* where its id belongs — A56.7's exact accident, one field
    // over — would push this past §15's 500-character question cap, and the card
    // would then be dropped by `safeParse` with a warning. That is the very
    // failure this section is being repaired for, so the id is clamped here.
    question: `Gate ${clampTitle(finding.gate ?? '(ohne Id)', 80)} wurde von der Betriebsprüfung entwertet — wie weiter?`,
    context:
      'Die Betriebsprüfung hält den Beleg dieses Gates für nicht tragfähig: ' +
      `${clip(finding.summary, CARD_FRAGMENT_MAX)} ` +
      `Beleg des Prüfers: ${clip(finding.evidence, CARD_FRAGMENT_MAX)} ` +
      `${clip(finding.consequence, CARD_FRAGMENT_MAX)} ` +
      'Ein entwertetes Gate öffnet die zugehörige Phase wieder; ohne deine Entscheidung ' +
      'bleibt sie offen.',
    urgency: 'P1',
    options: [
      {
        title: 'Befund annehmen — Phase bleibt offen, bis das Gate echt belegt ist',
        pros: [
          'Die Phase schließt erst, wenn ihr Beleg trägt — genau dafür gibt es die Prüfung.',
          'Der Fehler wird dort behoben, wo er entstanden ist, statt später teurer.',
        ],
        cons: ['Der Bau der nächsten Phase verzögert sich um die Nacharbeit.'],
        recommended: true,
      },
      {
        title: 'Fund verwerfen — Haken wieder setzen',
        pros: ['Der Bau läuft ohne Unterbrechung weiter.'],
        cons: [
          'Wenn der Prüfer recht hat, steht die nächste Phase auf einem Beleg, der nichts belegt.',
          'Der nächste Prüflauf nimmt denselben Fund erneut auf (§8.2).',
        ],
        recommended: false,
      },
      {
        title: 'Zweite Prüfung anfordern, bevor entschieden wird',
        pros: ['Eine unabhängige zweite Meinung, bevor eine Phase wieder aufgeht.'],
        cons: ['Kostet einen weiteren Prüflauf und verschiebt die Entscheidung.'],
        recommended: false,
      },
    ],
  };
}

function assumptionCard(finding: { summary: string; evidence: string }): EscalateAskInput {
  return {
    question:
      'Eine Annahme aus Anhang A gilt möglicherweise nicht mehr — revidieren, bestätigen oder zurückziehen?',
    context:
      `Die Betriebsprüfung hält eine Annahme für überholt: ${clip(finding.summary, CARD_FRAGMENT_MAX)} ` +
      `Beleg: ${clip(finding.evidence, CARD_FRAGMENT_MAX)} ` +
      'Annahmen aus Anhang A wurden unter Bedingungen entschieden, die sich ändern können; ' +
      'eine, die niemand mehr nachprüft, ist eine Entscheidung, die still aufgehört hat zu gelten.',
    urgency: 'P2',
    options: [
      {
        title: 'Annahme revidieren — neuen Wortlaut festlegen',
        pros: ['Anhang A bildet wieder ab, was tatsächlich gilt.'],
        cons: ['Braucht deine Entscheidung über den neuen Wortlaut.'],
        recommended: true,
      },
      {
        title: 'Annahme bestätigen — sie gilt unverändert',
        pros: ['Kein Aufwand; der Prüfer hat sich geirrt und das ist festgehalten.'],
        cons: ['Wenn sich die Lage doch geändert hat, bleibt der Widerspruch bestehen.'],
        recommended: false,
      },
      {
        title: 'Annahme zurückziehen — sie wird nicht mehr gebraucht',
        pros: ['Anhang A wird kürzer und enthält nur noch Geltendes.'],
        cons: ['Was auf ihr aufbaut, muss neu begründet werden.'],
        recommended: false,
      },
    ],
  };
}

function twiceDismissedCard(finding: {
  summary: string;
  evidence: string;
  reason: string;
}): EscalateAskInput {
  return {
    question: `Prüfer und Entwicklung sind sich zweimal uneinig: ${clampTitle(finding.summary, 70)}`,
    context:
      'Die Betriebsprüfung hat diesen Fund erhoben, die Entwicklung hat ihn zweimal ' +
      `zurückgewiesen. Fund: ${clip(finding.summary, CARD_FRAGMENT_MAX)} ` +
      `Beleg des Prüfers: ${clip(finding.evidence, CARD_FRAGMENT_MAX)} ` +
      `Letzte Begründung der Zurückweisung: ${clip(finding.reason, CARD_FRAGMENT_MAX)} ` +
      'Zwei Agenten, die zweimal widersprechen, sind eine Entscheidung und keine Schleife (§8.2).',
    urgency: 'P2',
    options: [
      {
        title: 'Dem Prüfer folgen — der Fund wird behoben',
        pros: ['Im Zweifel gewinnt die Instanz, die von außen schaut.'],
        cons: ['Kostet Arbeit an etwas, das die Entwicklung zweimal für in Ordnung hielt.'],
        recommended: true,
      },
      {
        title: 'Der Entwicklung folgen — der Fund wird endgültig verworfen',
        pros: ['Keine Nacharbeit; die Zurückweisung ist damit dokumentiert und endgültig.'],
        cons: ['Wenn der Prüfer recht hatte, bleibt der Defekt im System.'],
        recommended: false,
      },
    ],
  };
}
