/**
 * §21's idle audits — the standing audit programme, run when nothing is queued.
 *
 * ## Why this is not `AuditService` with a flag
 *
 * The obvious build is a `kind: 'idle' | 'betriebspruefung'` on the existing
 * audit service, and it is the one mistake this file exists to avoid. §8.2 draws
 * the line in as many words: *"§21's idle audits examine **projects**; the
 * Betriebsprüfung examines **Vorschicht's claims about its own work**. Different
 * object, different trigger."* A flag would make Bruno and this the same session
 * with a parameter, and then the department whose entire purpose is to be a
 * second party would be reading its own subject matter half the time.
 *
 * They differ in every property that matters, which is why sharing a class would
 * cost more than it saved:
 *
 * | | Betriebsprüfung (§8.2) | Idle audit (§21) |
 * |---|---|---|
 * | Object | this studio's claims | a project's code |
 * | Trigger | schedule + events; idleness is irrelevant | idleness only |
 * | Consequence | can un-tick a gate, reopen a phase | a P2 task |
 * | Frequency under A22 | drops to weekly, tier never | **off** |
 * | Domains | §8.2's eight | §21's ten |
 *
 * That last row is the trap the two sit closest to. §8.2's third independence
 * rule exempts *the auditor* from Sparbetrieb; A22 switches *idle audits* off.
 * One shared class with a `sparbetrieb` check would have to get that backwards
 * for one of the two, and the cost of getting it backwards for Bruno is that the
 * studio quietly stops noticing things exactly when budget is short.
 *
 * ## What a run is
 *
 * One project, one domain, one read-only session, and every finding it reports
 * becomes a P2 task through the ordinary chain (§21, A17). Four decisions:
 *
 * **A17's three conditions are asked mechanically, and the third one had no
 * reader.** `IDLE_AUDIT_MAX_USAGE_PERCENT` has existed as a constant since
 * Phase 1 and nothing anywhere referenced it — the declaration and nothing else,
 * which is exactly the dead wiring §8.2's sixth domain is about. The empty queue
 * and `normal` come from the tick (see `Scheduler.maybeIdleAudit`); the usage
 * ceiling is asked here, and it **fails closed**: a window that cannot be read
 * is not a window below 50 %. A17 exists so that idle work never competes with
 * real work for a budget nobody can see, and "we could not find out" and "there
 * is room" are the same sentence only to a system that has decided not to notice
 * (A83.6, A87.6, A99.4).
 *
 * **The session runs in a scratch directory and reads the project by absolute
 * path.** §6.2 would put a project-facing session in the worktree so that the
 * project's own `CLAUDE.md` loads as conventions, and that is right for a Coder.
 * It is wrong here for the reason §8.2's second independence rule and A70.1 both
 * give: a repository must not be able to instruct the session that examines it.
 * Of the ten domains, `Security` and `DSGVO` are the two where that matters
 * most, and a per-domain exception would be a rule nobody can state.
 *
 * **Findings arrive as `followups`, not as a new contract.** The staff roles
 * share `agentResultSchema`, whose `followups` field is documented as "work this
 * run deliberately did not do — becomes candidate tasks". That is precisely
 * §21's sentence. Inventing a structured finding contract here would mean a new
 * role in `ROLE_RESULT_SCHEMAS` and therefore a new profile, and the domains
 * already have departments that own them (§8).
 *
 * **A finding is never a blocker.** §11's "every finding is a blocker" governs
 * gates on work in flight; §21 files P2 tasks and says so. An idle audit that
 * could block a merge would let a session with no acceptance criteria stop work
 * that passed its gates.
 */
import {
  type AgentResult,
  IDLE_AUDIT_MAX_USAGE_PERCENT,
  type Priority,
  type UsageSample,
} from '@vorschicht/shared';
import type postgres from 'postgres';
import type { EventLog } from './event-log.js';
import { AGENT_PROFILES, type ProfileId, profileWrites } from './profiles/index.js';
import type { ProjectRecord, ProjectService } from './project-service.js';
import type { AgentRunner } from './runner.js';
import type { TaskService } from './task-service.js';

/** §21, A17: an idle-audit finding is a P2 task. Never a blocker (§11). */
export const IDLE_FINDING_PRIORITY: Priority = 'P2';

/** How many findings one run may file, so a chatty session cannot flood §9. */
export const MAX_IDLE_FINDINGS_PER_RUN = 8;

/**
 * A shorter leash than the department's own, because nothing is waiting on it.
 *
 * A32's caps are sized for a session somebody needs an answer from; this one
 * runs because the studio had nothing better to do, and it competes for the
 * same window as the work that arrives tomorrow. A ceiling never widens
 * (`capsCeiling`), so a department whose profile is already tighter keeps its
 * own number.
 */
export const IDLE_AUDIT_CAPS = { maxTurns: 30 } as const;

/**
 * One of §21's ten standing audit domains.
 *
 * `profile` is which department examines it, and the mapping is §8's table read
 * in the other direction rather than a new opinion: Security is Sasha's
 * question, DSGVO is Lena's, a11y is Uli's.
 *
 * **`profile: null` means the domain cannot run today**, and three of the ten
 * are in that state. The constraint is not §21's and not a shortcut — it comes
 * from the profile table: an idle audit is a read-only examination, and the
 * department that owns Testing and Robustness (`qa`) and the one nearest to Code
 * quality (`docs`) both hold `Edit`/`Write`. Pointing a writing role at a
 * read-only session is not a small compromise: §6.6's monitor treats a writing
 * run's containment differently, and the session would spend its turns being
 * denied edits it was built to make.
 *
 * So they are declared unavailable, with the sentence naming what they wait for
 * — A62.3's `availableFrom` shape, for the same reason it exists there: a
 * catalogue entry that cannot carry a signal reads as covered, and the way not
 * to ship one is to make it impossible to enable and to check that at import.
 * Adding a read-only profile for them later is one line here.
 */
export interface IdleAuditDomain {
  id: IdleAuditDomainId;
  /** German, for the task title and the timeline (§2). */
  label: string;
  /** English — it goes into the session's prompt. */
  question: string;
  /** Null when no read-only profile owns this domain yet — see `availableFrom`. */
  profile: ProfileId | null;
  /** German: what this domain is waiting for. Non-null exactly when `profile` is null. */
  availableFrom?: string;
}

export const IDLE_AUDIT_DOMAIN_IDS = [
  'security',
  'robustness',
  'performance',
  'code_quality',
  'ux',
  'design',
  'a11y',
  'dsgvo',
  'testing',
  'ops',
] as const;
export type IdleAuditDomainId = (typeof IDLE_AUDIT_DOMAIN_IDS)[number];

/**
 * §21's list, verbatim and in its order, as data.
 *
 * As data for `AUDIT_DOMAINS`' reason one department over: a domain is a
 * question plus who asks it, and a `switch` in the runner would put the two in
 * different places. The order is §21's own, so the rotation's first pass over a
 * fresh project follows the list the operator wrote down.
 */
export const IDLE_AUDIT_DOMAINS: Record<IdleAuditDomainId, IdleAuditDomain> = {
  security: {
    id: 'security',
    label: 'Sicherheit',
    profile: 'security',
    question:
      'Where can this codebase be made to do something its author did not intend? Injection, ' +
      'authentication and authorisation boundaries, secret handling, unsafe deserialisation, ' +
      'path traversal. Describe the attack with inputs somebody could type.',
  },
  robustness: {
    id: 'robustness',
    label: 'Robustheit',
    // §8 gives robustness to nobody by name, and the nearest owner is QA — the
    // question is the one a regression suite asks. Quentin writes (§8 row 3
    // gives him "writes/maintains unit/integration/E2E" deliberately), so he
    // cannot hold a read-only session.
    profile: null,
    availableFrom:
      'Es fehlt ein nur lesendes Profil für diese Frage. QA (Quentin) ist die zuständige ' +
      'Abteilung nach §8, darf aber schreiben — und ein schreibendes Profil in einer ' +
      'Leerlauf-Sitzung würde seine Züge damit verbringen, abgelehnt zu werden.',
    question:
      'What happens here on the inputs nobody planned for? Empty, absent, enormous, ' +
      'concurrent, out of order, and the failure of every dependency in turn. Name the code ' +
      'path that has no answer, not the one that has an ugly answer.',
  },
  performance: {
    id: 'performance',
    label: 'Performance',
    // Also unassigned in §8. Ops owns health checks and the deployed system's
    // behaviour under load, which is where a performance defect is observed;
    // §11's Lighthouse budget is a gate rather than a department.
    profile: 'ops',
    question:
      'What in here gets slower as the data grows? Queries in loops, unbounded reads, work ' +
      'repeated per request that could be done once. Say which input size turns it from ' +
      'fine into a problem.',
  },
  code_quality: {
    id: 'code_quality',
    label: 'Codequalität',
    // The Reviewer owns this question in §8.1 and cannot be used for a second,
    // independent reason: that profile judges a *diff* against a plan and
    // returns a merge verdict, so pointing it at a whole repository asks it to
    // approve or refuse something nobody proposed. Doris reads for
    // comprehensibility and writes. Neither fits.
    profile: null,
    availableFrom:
      'Es fehlt ein nur lesendes Profil für diese Frage. Die Reviewerin (§8.1) beurteilt einen ' +
      'Diff gegen einen Plan und gibt ein Merge-Urteil ab — auf ein ganzes Repository ' +
      'gerichtet, hätte sie nichts, worüber sie urteilen könnte; Doku (Doris) darf schreiben.',
    question:
      'Which part of this codebase would cost the most to change, and why? Duplication that ' +
      'has to be edited in step, names that mean different things in different files, ' +
      'abstractions with one caller. Point at the change that would be expensive.',
  },
  ux: {
    id: 'ux',
    label: 'Bedienbarkeit',
    profile: 'ux',
    question:
      'Where does this interface make the user guess? Actions with no feedback, errors that ' +
      'do not say what to do next, state that is not visible. Name the screen and the moment.',
  },
  design: {
    id: 'design',
    label: 'Gestaltung',
    profile: 'ux',
    question:
      'Where is this interface inconsistent with itself? Spacing, wording, control shapes and ' +
      'the same concept named two ways. Consistency is the finding; taste is not.',
  },
  a11y: {
    id: 'a11y',
    label: 'Barrierefreiheit',
    profile: 'ux',
    question:
      'What here is unusable without a mouse or without sight? Focus order, labels, contrast, ' +
      'roles, live regions, and anything conveyed by colour alone. Cite the element.',
  },
  dsgvo: {
    id: 'dsgvo',
    label: 'DSGVO',
    profile: 'legal',
    question:
      'What personal data does this handle, on which legal basis, for how long, and who can ' +
      'read it? Name the field and the article. Where you cite, cite a source of level L4 or ' +
      'above (§14).',
  },
  testing: {
    id: 'testing',
    label: 'Tests',
    // QA's own question, and QA writes — see `robustness` above.
    profile: null,
    availableFrom:
      'Es fehlt ein nur lesendes Profil für diese Frage. Es ist QAs eigene Frage nach §8, und ' +
      'QA darf schreiben.',
    question:
      'Which of these tests could never fail? A suite that skips itself when a dependency is ' +
      'absent and still exits 0 is the worst case (A79). Name the test and what you would ' +
      'break to prove it.',
  },
  ops: {
    id: 'ops',
    label: 'Betrieb',
    profile: 'ops',
    question:
      'If this broke at three in the morning, what would be missing? Health checks that ' +
      'report the wrong thing, logs without correlation, no way back from a bad release, ' +
      'alerts nobody receives. Name the failure and the blind spot it sits in.',
  },
};

/** The domains that can actually run today — `IDLE_AUDIT_DOMAINS` minus the nulls. */
export function runnableIdleDomains(): IdleAuditDomain[] {
  return IDLE_AUDIT_DOMAIN_IDS.map((id) => IDLE_AUDIT_DOMAINS[id]).filter(
    (domain) => domain.profile !== null,
  );
}

/**
 * The catalogue and the profile table must agree, and the import fails if not.
 *
 * A62.3's `assertInternalRunnersComplete` one department over, and it checks the
 * same two directions for the same reason. A domain naming a profile that
 * **writes** would put a writing role in a read-only session — the session would
 * be denied every edit and would look, from the outside, exactly like a session
 * that found nothing. And a domain with neither a profile nor a sentence saying
 * what it waits for is a silently missing tenth of §21's programme.
 *
 * At module load rather than in a test, because the failure this prevents is
 * only visible at three in the morning in a role that runs once a rotation: the
 * way not to ship a signal path that cannot carry a signal is to make the build
 * refuse it.
 */
export function assertIdleDomainsRunnable(): void {
  for (const id of IDLE_AUDIT_DOMAIN_IDS) {
    const domain = IDLE_AUDIT_DOMAINS[id];
    if (domain.profile === null) {
      if (!domain.availableFrom?.trim()) {
        throw new Error(
          `Leerlauf-Domäne „${id}" hat kein Profil und nennt auch nicht, worauf sie wartet. ` +
            'Eine Domäne, die stillschweigend nie läuft, liest sich wie eine, die abgedeckt ist.',
        );
      }
      continue;
    }
    if (domain.availableFrom) {
      throw new Error(
        `Leerlauf-Domäne „${id}" nennt ein Profil und trotzdem einen Grund zu warten. ` +
          'Einer der beiden Sätze ist falsch, und von außen ist nicht zu sehen, welcher.',
      );
    }
    const profile = AGENT_PROFILES[domain.profile];
    if (!profile) {
      throw new Error(`Leerlauf-Domäne „${id}" nennt das unbekannte Profil „${domain.profile}".`);
    }
    if (profileWrites(profile)) {
      throw new Error(
        `Leerlauf-Domäne „${id}" ist dem schreibenden Profil „${profile.id}" zugeordnet. ` +
          'Ein Leerlauf-Audit ist eine nur lesende Prüfung (§21): die Sitzung bekäme jede ' +
          'Änderung verweigert und sähe von außen aus wie eine, die nichts gefunden hat.',
      );
    }
  }
}

assertIdleDomainsRunnable();

/** One (project, domain) pair the rotation may pick. */
export interface IdleAuditSlot {
  project: ProjectRecord;
  domain: IdleAuditDomain;
  /** When this pair was last examined, or null — the rotation's whole input. */
  lastAt: Date | null;
}

export interface IdleAuditDeps {
  sql: postgres.Sql;
  eventLog: EventLog;
  runner: AgentRunner;
  tasks: Pick<TaskService, 'create'>;
  projects: Pick<ProjectService, 'listActive'>;
  /** §7.1's current reading, per window. A17's third condition is read from it. */
  usage: () => Promise<UsageSample[]>;
  /** The session's cwd — a scratch dir, never a worktree. See the header. */
  scratchDir: string;
  /**
   * A22: "idle audits off" under Sparbetrieb.
   *
   * A hook rather than a config read, and **it has no producer today** — the
   * switch itself is §22's Phase 6 step 6 and is not built. Named here rather
   * than left implicit, because the alternative is an emergency profile that
   * silently does not apply to the one kind of work it names first. Absent
   * means not in Sparbetrieb, which is the state of the studio today.
   */
  sparbetrieb?: () => boolean | Promise<boolean>;
  now?: () => Date;
  onWarning?(message: string): void;
}

/** Why an idle slot produced no audit. Null when one ran. */
export type IdleAuditSkip =
  /** A22's emergency profile switches idle work off entirely. */
  | { reason: 'sparbetrieb' }
  /** A17: a window is at or above the ceiling. */
  | { reason: 'budget'; window: string; usedPercent: number }
  /** A17, fail closed: the budget could not be read at all. */
  | { reason: 'budget_unreadable'; problem: string }
  /** Nothing to examine: no active, writable project. */
  | { reason: 'no_project' }
  /** The session did not deliver. Never a red task — nothing was at stake. */
  | { reason: 'session'; status: string; problem: string };

export interface IdleAuditRun {
  projectId: string;
  projectSlug: string;
  domain: IdleAuditDomainId;
  runId: string;
  /** The P2 tasks this run filed (§21). */
  taskIds: string[];
  summary: string;
}

export class IdleAuditService {
  constructor(private readonly deps: IdleAuditDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private warn(message: string): void {
    this.deps.onWarning?.(message);
  }

  /**
   * A17's third condition, and the first reader `IDLE_AUDIT_MAX_USAGE_PERCENT`
   * has ever had.
   *
   * Every window is asked, not the governing one: §7.1 says the tightest window
   * wins everywhere, and a five-hour window at 20 % says nothing about a weekly
   * one at 60 %. An unreadable reading refuses — see the header.
   */
  async budgetAllows(): Promise<IdleAuditSkip | null> {
    let samples: UsageSample[];
    try {
      samples = await this.deps.usage();
    } catch (error) {
      return { reason: 'budget_unreadable', problem: (error as Error).message };
    }
    if (samples.length === 0) {
      return {
        reason: 'budget_unreadable',
        problem: 'Es liegt überhaupt keine Fenster-Messung vor.',
      };
    }

    for (const sample of samples) {
      if (sample.anomaly?.kind === 'unavailable' || !Number.isFinite(sample.usedPercent)) {
        return {
          reason: 'budget_unreadable',
          problem: `Das Fenster „${sample.window}" ist nicht lesbar.`,
        };
      }
      if (sample.usedPercent >= IDLE_AUDIT_MAX_USAGE_PERCENT) {
        return {
          reason: 'budget',
          window: sample.window,
          usedPercent: sample.usedPercent,
        };
      }
    }
    return null;
  }

  /**
   * Which (project, domain) pair is owed a look — least recently examined first.
   *
   * `AuditService.selectDomain`'s shape, over two axes instead of one, because
   * §21 rotates "across projects, one domain per idle slot". A pair that has
   * never run sorts ahead of every pair that has, so a newly onboarded project
   * gets its first ten looks before any project gets an eleventh.
   *
   * A `read_only` project is excluded (A44.3) and that is not squeamishness:
   * its findings would become tasks the tick can never dispatch, which is the
   * hole `TickReport.readOnly` exists to make visible and which this must not
   * deliberately fill.
   */
  async nextSlot(): Promise<IdleAuditSlot | null> {
    const projects = (await this.deps.projects.listActive()).filter((project) => !project.readOnly);
    if (projects.length === 0) return null;

    const rows = await this.deps.sql<Array<{ project_id: string; domain: string; last: Date }>>`
      SELECT project_id::text, payload ->> 'domain' AS domain, max(occurred_at) AS last
      FROM event_log
      WHERE kind = 'idle_audit.finished' AND project_id IS NOT NULL
      GROUP BY project_id, payload ->> 'domain'
    `;
    const seen = new Map(
      rows.map((row) => [`${row.project_id}:${row.domain}`, row.last.getTime()]),
    );

    // Only the domains that have a read-only owner. A domain waiting for a
    // profile is skipped here rather than picked and then refused, so it never
    // consumes an idle slot — and `assertIdleDomainsRunnable` guarantees each
    // such domain says what it is waiting for.
    const domains = runnableIdleDomains();
    if (domains.length === 0) return null;

    let best: IdleAuditSlot | null = null;
    let bestAt = Number.POSITIVE_INFINITY;
    for (const project of projects) {
      for (const domain of domains) {
        const at = seen.get(`${project.id}:${domain.id}`) ?? -1;
        if (at >= bestAt) continue;
        best = { project, domain, lastAt: at === -1 ? null : new Date(at) };
        bestAt = at;
      }
    }
    return best;
  }

  /**
   * One idle slot: check A17, pick a pair, run it, file what it found.
   *
   * Returns the run, or why there was none. Never throws for a condition the
   * studio has an answer to — the caller is a tick, and a tick that has to catch
   * exceptions to stay alive is a tick that will one day not.
   */
  async runOnce(): Promise<{ run: IdleAuditRun | null; skip: IdleAuditSkip | null }> {
    if (await this.deps.sparbetrieb?.()) return { run: null, skip: { reason: 'sparbetrieb' } };

    const budget = await this.budgetAllows();
    if (budget) return { run: null, skip: budget };

    const slot = await this.nextSlot();
    if (!slot) return { run: null, skip: { reason: 'no_project' } };

    return this.examine(slot);
  }

  /** Run one slot unconditionally. A17 has already been decided by the caller. */
  async examine(slot: IdleAuditSlot): Promise<{
    run: IdleAuditRun | null;
    skip: IdleAuditSkip | null;
  }> {
    const { project, domain } = slot;
    if (domain.profile === null) {
      // Unreachable through `nextSlot`, which filters these out; reachable by a
      // caller that built a slot itself. Refused rather than defaulted to some
      // profile, because the whole point of `availableFrom` is that nothing
      // silently stands in for a domain nobody owns.
      return {
        run: null,
        skip: {
          reason: 'session',
          status: 'unavailable',
          problem: `Domäne „${domain.id}": ${domain.availableFrom ?? 'kein Profil zugeordnet.'}`,
        },
      };
    }
    const profile = AGENT_PROFILES[domain.profile];

    await this.deps.eventLog.append({
      kind: 'idle_audit.started',
      actor: profile.id,
      projectId: project.id,
      payload: {
        domain: domain.id,
        label: domain.label,
        profile: profile.id,
        lastAt: slot.lastAt?.toISOString() ?? null,
      },
    });

    const outcome = await this.deps.runner.run({
      // No task: §21's audit examines a project, not a unit of work. A run
      // without a task runs without MCP (A56.5), which is why the findings come
      // back in the result rather than through `finding.report`.
      taskId: null,
      projectId: project.id,
      profile,
      prompt: idleAuditPrompt({ project, domain, scratchDir: this.deps.scratchDir }),
      cwd: this.deps.scratchDir,
      // Read-only session in a directory that belongs to no repository. The
      // write boundary is stated rather than left to the profile's tool list,
      // because §6.6's monitor reads this and a writing role reaching here by a
      // later edit would otherwise be contained by nothing.
      containment: { writeRoot: null, claims: null, readOnlyProject: true },
      capsCeiling: IDLE_AUDIT_CAPS,
    });

    if (outcome.status !== 'ok') {
      // Never a red task and never an Ops alert: nothing was waiting on this and
      // §21 fills gaps rather than producing obligations. The next idle slot
      // picks the same pair again, because nothing was recorded as finished.
      const skip: IdleAuditSkip = {
        reason: 'session',
        status: outcome.status,
        problem: outcome.problem,
      };
      this.warn(
        `Leerlauf-Audit (${domain.label}, ${project.slug}) endete als „${outcome.status}": ` +
          `${outcome.problem}`,
      );
      await this.deps.eventLog.append({
        kind: 'idle_audit.finished',
        actor: profile.id,
        projectId: project.id,
        runId: outcome.run.runId,
        payload: {
          domain: domain.id,
          outcome: 'failed',
          status: outcome.status,
          problem: outcome.problem,
          findings: 0,
        },
      });
      return { run: null, skip };
    }

    const result: AgentResult = outcome.result;
    const taskIds = await this.fileFindings({
      project,
      domain,
      profile,
      runId: outcome.run.runId,
      result,
    });

    await this.deps.eventLog.append({
      kind: 'idle_audit.finished',
      actor: profile.id,
      projectId: project.id,
      runId: outcome.run.runId,
      payload: {
        domain: domain.id,
        outcome: 'done',
        findings: taskIds.length,
        reported: result.followups.length,
        taskIds,
        // §18's traceability chain, on the row a later audit reads: the session
        // that produced these tasks, and the file its turns are in.
        transcriptPath: outcome.run.transcriptPath,
        summary: result.summary,
      },
    });

    return {
      run: {
        projectId: project.id,
        projectSlug: project.slug,
        domain: domain.id,
        runId: outcome.run.runId,
        taskIds,
        summary: result.summary,
      },
      skip: null,
    };
  }

  /**
   * Every finding becomes exactly one P2 task, and every task carries the run.
   *
   * The trace is the half that is easy to lose and the one §22's gate names
   * ("filed as P2 tasks with correct **traces**"). Without `runId` on the
   * `task.created` row, a P2 task filed at four in the morning is a sentence
   * with no author: the session that wrote it, its transcript and its domain are
   * all unreachable from the task, and the first question anybody asks about an
   * unexplained task is where it came from.
   *
   * Capped, because the cap protects §9 rather than the budget: a session that
   * decided everything is a finding would otherwise put forty tasks into a queue
   * whose priority ordering then means nothing. The truncation is *said*, in the
   * log line and in the last task's own description — a silent cut reads as a
   * complete answer.
   */
  private async fileFindings(input: {
    project: ProjectRecord;
    domain: IdleAuditDomain;
    /**
     * The profile that ran, passed rather than looked up again.
     *
     * `IdleAuditDomain.profile` is nullable — a domain waiting for a read-only
     * owner has none — and `examine` has already established that this one is
     * not. Re-deriving it here would mean either a second narrowing or a
     * non-null assertion, and the second is how a domain with no profile would
     * one day file tasks attributed to `undefined`.
     */
    profile: (typeof AGENT_PROFILES)[ProfileId];
    runId: string;
    result: AgentResult;
  }): Promise<string[]> {
    const findings = input.result.followups
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const filed = findings.slice(0, MAX_IDLE_FINDINGS_PER_RUN);
    const dropped = findings.length - filed.length;
    if (dropped > 0) {
      this.warn(
        `Leerlauf-Audit (${input.domain.label}, ${input.project.slug}) meldete ` +
          `${findings.length} Funde; ${dropped} davon sind nicht als Aufgabe angelegt worden ` +
          `(Höchstzahl ${MAX_IDLE_FINDINGS_PER_RUN}). Sie stehen im Ereignisprotokoll des Laufs.`,
      );
    }

    const taskIds: string[] = [];
    for (const [index, finding] of filed.entries()) {
      try {
        const task = await this.deps.tasks.create({
          projectId: input.project.id,
          title: `${input.domain.label}: ${clampTitle(finding)}`,
          description: [
            `Aus dem Leerlauf-Audit vom ${this.now().toISOString().slice(0, 10)} ` +
              `(§21, Domäne \`${input.domain.id}\`, Lauf ${input.runId}).`,
            '',
            finding,
            '',
            `**Zusammenfassung des Laufs:** ${input.result.summary}`,
            ...(dropped > 0 && index === filed.length - 1
              ? [
                  '',
                  `_Derselbe Lauf meldete ${findings.length} Funde; ${dropped} weitere sind ` +
                    'nicht als Aufgabe angelegt worden und stehen nur im Ereignisprotokoll._',
                ]
              : []),
          ].join('\n'),
          acceptanceCriteria: [
            'Der Fund ist behoben, oder mit einem Beleg widerlegt, der so konkret ist wie der des Prüfers.',
            'Die Änderung geht durch die normale Kette und die normalen Gates (§8.1, §11).',
          ],
          // §21: P2. Never a blocker — §11's rule governs work in flight, and
          // this examines a tree that merged long ago.
          priority: IDLE_FINDING_PRIORITY,
          // §8's own label for the department that raised it, not "Entwicklung"
          // for everything: the office view and the weekly report both group on
          // this, and a finding attributed to the department that will *fix* it
          // rather than the one that *found* it makes both unreadable.
          department: input.profile.department,
          type: 'idle_audit_finding',
          actor: input.profile.id,
          // The trace. See this method's own reasoning.
          runId: input.runId,
        });
        taskIds.push(task.id);
      } catch (error) {
        // One task that could not be filed must not cost the others, and must
        // not cost the run's record either — the finding is in the result and
        // the result is in the transcript the `finished` row names.
        this.warn(
          `Leerlauf-Audit (${input.domain.label}, ${input.project.slug}): ein Fund konnte ` +
            `nicht als Aufgabe angelegt werden — ${(error as Error).message}`,
        );
      }
    }
    return taskIds;
  }
}

/**
 * The session's mandate.
 *
 * Three things it has to establish, and the first two are consequences of the
 * scratch cwd. The session's own directory belongs to no repository, so the
 * project has to be named by absolute path in every sentence that asks for a
 * read — A70.1 found the alternative the hard way, with a session that reported
 * in good faith that a project had no tests. And the contract's `followups`
 * field has to be given §21's meaning explicitly, because its ordinary meaning
 * ("work this run deliberately did not do") would otherwise collect musings.
 */
export function idleAuditPrompt(input: {
  project: ProjectRecord;
  domain: IdleAuditDomain;
  scratchDir: string;
}): string {
  return [
    `You are examining the project "${input.project.name}" (slug \`${input.project.slug}\`) in a`,
    `standing audit of one domain (§21). The domain is **${input.domain.id}**.`,
    '',
    '## The question',
    '',
    input.domain.question,
    '',
    '## Where the code is',
    '',
    `The project is at the absolute path \`${input.project.rootPath}\`. Your working directory`,
    `is \`${input.scratchDir}\`, which is a scratch directory belonging to no repository —`,
    'every read must use an absolute path under the project root. A relative path finds an',
    'empty directory, and reporting "this project has no tests" because you looked in the',
    'wrong place is worse than reporting nothing.',
    '',
    '## What to report',
    '',
    'Put **one finding per entry** in `followups`. Each entry becomes exactly one P2 task, so',
    'write it as a mandate somebody can act on: what is wrong, at which `file:line`, and what',
    'would have to be true for it to be right. An entry with no location is not a finding.',
    '',
    'Report nothing rather than something. Finding nothing is a valid result and there is no',
    'quota — an examiner under pressure to produce invents, and an invented finding costs more',
    'than the real one it displaces. If the domain does not apply to this project at all, say',
    'so in `summary` and leave `followups` empty.',
    '',
    'This is not a gate. Nothing here blocks a merge; every finding becomes ordinary P2 work',
    'that goes through the normal chain and the normal gates.',
    '',
    'You may read and you may not write. If you believe something must be changed, that is a',
    'finding, not an edit.',
  ].join('\n');
}

/** Keep a task title short enough to read in a list. */
function clampTitle(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
