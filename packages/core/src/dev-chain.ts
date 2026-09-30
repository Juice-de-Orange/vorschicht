/**
 * The dev chain (§8.1) — Planner → Coder → Reviewer over one task.
 *
 * The runner executes one session and moves nothing (A53.1). This is the
 * component that calls it three times in a row, does with each result what §8.1
 * says, and owns §9's lifecycle while it does. Everything below is one of those
 * two jobs; there is no third.
 *
 * Five properties are the design.
 *
 *  1. **The five run outcomes are five different futures, not two.** `ok`
 *     advances the chain; `infra` retries with backoff and never colours a task
 *     (§11, A25); `auth_incident` parks and leaves the alerting to §6.1;
 *     `interrupted` parks so §7.3's wrap-up finds a coherent task; only `failed`
 *     takes the red path. Collapsing any pair of these is how a bad network
 *     afternoon becomes fifteen red tasks — the failure §11's classification
 *     rule exists to prevent, applied one layer up.
 *
 *  2. **The agent's own `status` is a second axis.** A run can be perfectly
 *     healthy and come back `needs_decision` (§6.4) or `parked` (§7.3) or
 *     `failed`. `ok` means the harness worked and the contract was satisfied; it
 *     does not mean the work is done. Reading only one of the two axes was
 *     available and would have been wrong in both directions.
 *
 *  3. **`claimsRespected` is verified, not believed.** §8.1 gives the Reviewer
 *     the claim-compliance check and §10 makes a violation a blocker. But
 *     whether a diff stayed inside a set of globs is a mechanical fact, and a
 *     model's boolean about a mechanical fact is the weakest available evidence
 *     for it. The chain computes the answer from the diff and treats a
 *     divergence as a finding *about the review* — that class of defect is
 *     exactly what §8.2 exists for, and here it costs one `git diff` to close.
 *
 *  4. **The review loop is bounded and its bound is red, not a shrug.** §8.1
 *     sends `changes_requested` back to the Coder, and nothing in the spec stops
 *     that cycling forever. A task that cannot satisfy its reviewer in a few
 *     rounds has a problem no further round will find; §9's red path is where
 *     that goes, and from there the second failure reaches the operator with a diagnosis.
 *
 *  5. **A halt never leaves a task mid-air.** Every exit either advances the
 *     task, parks it, reds it, or leaves it exactly where a retry can pick it
 *     up. §1 principle 2 has no "mostly done", and the state a chain abandons is
 *     the state an unattended studio wakes up to.
 *
 *  6. **A chain can be entered in the middle, and had to become able to.** A54.6
 *     recorded the opposite — "mid-chain resumption is deliberately not this
 *     method" — and that was right about `interrupted`, where §7.2's re-check is
 *     the way back, and wrong about everything downstream of it. Every suspension
 *     in this system returns a task to the state it was suspended *from* (A43.4,
 *     enforced by the database): a task parked mid-implementation comes back at
 *     `coding`, and until now nothing in the studio started a chain from there.
 *     §7.3's park, §7.2's re-check and §6.4's decision all ended at a state no
 *     dispatcher looked at — three resume paths whose last step led nowhere,
 *     which is precisely the dead wiring §8.2's sixth domain hunts. So the entry
 *     states are §9's dev positions, and what a re-entered pass does *not* do is
 *     re-run the Planner: the plan is read back from the run that produced it and
 *     the claim set is still held, because re-planning would spend a session to
 *     produce a *different* plan than the one the half-finished worktree was
 *     built from.
 */
import {
  claimAllowsPath,
  decisionMessage,
  decisionSummary,
  type PlannerResult,
  parseAgentResult,
  type ReviewerResult,
  type RoleName,
  type RoleResult,
  SUSPENDED_TASK_STATES,
  type TaskState,
} from '@vorschicht/shared';
import type { ClaimConflict, ClaimRegistry } from './claim-registry.js';
import {
  type ChainPromptContext,
  coderPrompt,
  plannerPrompt,
  type ReviewFeedback,
  reviewerPrompt,
} from './dev-chain-prompts.js';
import type { EscalationService } from './escalation-service.js';
import type { EventLog } from './event-log.js';
import type { FindingRecord, FindingsService } from './findings.js';
import { changedPaths } from './git.js';
import { AGENT_PROFILES, type AgentProfile, type ProfileId } from './profiles/index.js';
import type { ProjectRecord, ProjectService } from './project-service.js';
import { RedPath, type RedPathResult } from './red-path.js';
import type { RunRecords } from './run-records.js';
import type { AgentRunner, RunOutcomeStatus } from './runner.js';
import type { TaskRecord, TaskService } from './task-service.js';
import type { WorktreeAssignment, WorktreeManager } from './worktree.js';

/** How often the Coder may be sent back before §9's red path takes over. */
export const DEFAULT_REVIEW_ROUNDS = 3;

/** §11/A25: an infra failure is retried this often before the chain gives up. */
export const DEFAULT_INFRA_ATTEMPTS = 3;
export const DEFAULT_INFRA_BACKOFF_MS = 2_000;

export interface DevChainLeg {
  role: ProfileId;
  runId: string;
  /** How the harness ended (A53.2). */
  outcome: RunOutcomeStatus;
  /** What the agent said about its own work. Null when the run never returned one. */
  agentStatus: string | null;
  /** Attempts including infra retries — 1 in the ordinary case. */
  attempts: number;
  round: number;
}

export type DevChainStatus =
  /** The Reviewer approved; the task is in `gates` and belongs to §11 now. */
  | 'approved'
  /** §10: another task holds overlapping claims. This one waits in `planning`. */
  | 'blocked'
  /** §9: first failure. Requeued with lower priority and the learnings attached. */
  | 'red'
  /** §9: second failure. With the Debugger's diagnosis, waiting for the operator. */
  | 'escalated'
  /** §6.4: an agent prepared a decision. Parked with claims held. */
  | 'needs_decision'
  /** §7.3 / §6.1: budget or authentication. Parked, never red. */
  | 'parked'
  /** §11/A25: the harness kept failing. The task is untouched; try again later. */
  | 'infra';

export interface DevChainResult {
  taskId: string;
  status: DevChainStatus;
  /** German, for the timeline (§2). Null only when the chain succeeded. */
  problem: string | null;
  legs: DevChainLeg[];
  /** Set once the Planner has produced one. */
  plan: PlannerResult | null;
  /** The last review, whatever its verdict. */
  review: ReviewerResult | null;
  /** Paths the chain itself found outside the claim set (§10). */
  outOfClaims: string[];
  /** Non-empty exactly when `status` is `blocked`. */
  conflicts: ClaimConflict[];
  /**
   * Which §8.1 round the pass ended in. 1 when the first diff was approved.
   *
   * The round the *task* is in, not the number of legs this pass ran: a pass
   * re-entered after a suspension (header 6) picks the count up from the log
   * where it left off, so a chain resumed in round two reports two even though
   * it ran one Coder.
   */
  rounds: number;
  /** Present when §9's red path ran. */
  red: RedPathResult | null;
  /** §11's findings this pass was briefed with. Empty on a first attempt. */
  briefedFindings: FindingRecord[];
}

export class DevChainError extends Error {
  constructor(
    readonly taskId: string,
    message: string,
  ) {
    super(message);
    this.name = 'DevChainError';
  }
}

export interface DevChainDeps {
  tasks: TaskService;
  projects: ProjectService;
  claims: ClaimRegistry;
  worktrees: WorktreeManager;
  runner: AgentRunner;
  eventLog: EventLog;
  /**
   * §11's pipeline: what this task still owes, read once at the top of the pass.
   *
   * Required, not optional. A chain that silently briefed nobody would be
   * indistinguishable from one that had nothing to brief — and the failure it
   * produces is the expensive kind, a fix attempt that starts by re-deriving
   * the failure it exists to fix.
   */
  findings: FindingsService;
  /**
   * §15's inbox — passed through to the `RedPath` this builds when the caller
   * supplies none. Required for the same reason `findings` is: an optional
   * dependency nobody passes is indistinguishable from a working one, and the
   * symptom would be §9's second failure silently never reaching the operator.
   */
  escalations: EscalationService;
  /**
   * Reading a session back (§6.4) — the parked one, and the Planner's result.
   *
   * Required for the same reason `findings` is. A chain re-entered at `coding`
   * with no way to read the plan would have to either re-plan (a fresh session,
   * a different plan, and a worktree half-built from the old one) or continue
   * without one — and an optional dependency nobody passes is indistinguishable
   * from a working one from every vantage point inside this repository.
   */
  runs: RunRecords;
  redPath?: RedPath;
  /**
   * The project's own build and gate commands as Bash scopes (§11, A46.4).
   *
   * Not part of a profile, because §11 makes them per-project config discovered
   * at onboarding. Until Phase 3 supplies them, a Coder can edit and commit and
   * cannot run a build — the honest state, rather than a guessed `Bash(pnpm:*)`.
   */
  gateTools?(project: ProjectRecord): readonly string[];
  maxReviewRounds?: number;
  infra?: { attempts: number; backoffMs: number };
  sleep?(ms: number): Promise<void>;
  onWarning?(message: string): void;
}

/**
 * States a pass may be entered from — §9's dev-chain positions (see header 6).
 *
 * `gates` and everything after it are deliberately absent: from there the task
 * belongs to §10's merge queue, and a chain that re-entered it would run a
 * Coder over a diff already approved. `interrupted` is absent for A54.6's
 * original reason, which still holds — §7.2's re-check is the way back, and it
 * puts the task into one of these states itself.
 */
const ENTRY_STATES = ['queued', 'planning', 'claimed', 'coding', 'review'] as const;

/** Entry states that start the pass from the top, plan and claim set included. */
const FRESH_STATES: readonly TaskState[] = ['queued', 'planning'];

/**
 * Which leg a task's position belongs to (§6.4).
 *
 * Used to cross-check the parked session's role against the state the task
 * resumed into: a record in which the escalation came from a Coder while the
 * task returns to `planning` is inconsistent, and continuing anyway would inject
 * the operator's decision into whichever leg happened to run next.
 */
const LEG_OF_STATE: Partial<Record<TaskState, ProfileId>> = {
  planning: 'planner',
  claimed: 'coder',
  coding: 'coder',
  review: 'reviewer',
};

/** §6.4: the session this pass continues, instead of starting a fresh one. */
export interface ChainResumption {
  /** Which leg parked. Must match the position the task resumed into. */
  role: ProfileId;
  sessionId: string;
  /**
   * The directory that session began in — from the record, never recomputed.
   *
   * §6.2: "session resume is scoped to the directory it started in (CLI
   * behaviour)". The worktree path this pass computes is the same string today
   * and is a *derivation*; the recorded one is the fact.
   */
  cwd: string;
  /** The parked run, linked on the continuation's own record. */
  runId: string;
  /** The next message: the operator's decision, rendered (`decisionMessage`). */
  message: string;
  /** §15's "#X" — for the timeline and the event log. */
  escalationNumber: number;
}

export class DevChain {
  private readonly redPath: RedPath;

  constructor(private readonly deps: DevChainDeps) {
    this.redPath =
      deps.redPath ??
      new RedPath({
        tasks: deps.tasks,
        eventLog: deps.eventLog,
        escalations: deps.escalations,
        runner: deps.runner,
        ...(deps.onWarning ? { onWarning: deps.onWarning } : {}),
      });
  }

  /**
   * One pass of §8.1 over one task.
   *
   * Returns rather than throws for every outcome the studio has a response to;
   * a `DevChainError` means the caller asked for something that cannot be done
   * at all — a task in the wrong state, a read-only project (A41) — which is a
   * defect in the scheduler rather than a task that failed.
   */
  async run(taskId: string): Promise<DevChainResult> {
    return this.pass(taskId, null);
  }

  /**
   * §6.4's round trip: The operator answered, so the parked session goes back to work.
   *
   * "The orchestrator parks the task (claims kept), and after the operator answers,
   * resumes the exact session from the same cwd with the decision injected as
   * the next message. No context is lost."
   *
   * Everything here is preparation for one call; the continuation itself is an
   * ordinary leg of an ordinary pass, which is the point. Four things happen
   * before the task moves, and the order is deliberate:
   *
   *   1. **The decision is checked.** An unanswered escalation is not an error —
   *      it is the ordinary state of a task waiting — so it comes back
   *      `needs_decision`, having changed nothing, rather than throwing. Only an
   *      inconsistent *record* throws (A54.6).
   *   2. **The parked session is located** — `runId` off the escalation,
   *      `session_id` and `cwd` off `agent_runs`. Resume is scoped to the
   *      directory the session began in, so the directory comes from the record
   *      and is never re-derived.
   *   3. **The decision is written into the timeline, in German, before the task
   *      moves.** If the continuation then fails, the next session still finds
   *      the answer through `task.get_context` rather than asking again.
   *   4. **The task returns to exactly where it was suspended from** —
   *      `TaskService.resume` takes no target, because A43.4 makes the return
   *      point a property of the suspension rather than of the caller.
   */
  async resume(taskId: string): Promise<DevChainResult> {
    const task = await this.requireTask(taskId);
    const project = await this.deps.projects.require(task.projectId);
    const idle = (status: DevChainStatus, problem: string): DevChainResult => ({
      taskId,
      status,
      problem,
      legs: [],
      plan: null,
      review: null,
      outOfClaims: [],
      conflicts: [],
      rounds: 0,
      red: null,
      briefedFindings: [],
    });

    if (task.state !== 'needs_decision') {
      throw new DevChainError(
        taskId,
        `Fortsetzen nach einer Entscheidung (§6.4) beginnt bei "needs_decision" — ` +
          `die Aufgabe ist "${task.state}".`,
      );
    }
    if (project.readOnly) {
      throw new DevChainError(
        taskId,
        `Projekt "${project.slug}" ist als nur lesbar gekennzeichnet (A41) — ` +
          'die Entwicklungskette schreibt und wird deshalb nicht fortgesetzt.',
      );
    }

    const escalation = await this.deps.escalations.latestForTask(taskId);
    if (!escalation) {
      throw new DevChainError(
        taskId,
        'Die Aufgabe wartet auf eine Entscheidung, im Postfach steht dazu aber ' +
          'nichts. Ohne Frage gibt es keine Antwort, auf die hin fortzusetzen wäre.',
      );
    }
    if (escalation.state !== 'answered') {
      return idle('needs_decision', `Entscheidung #${escalation.number} ist noch offen.`);
    }
    if (!escalation.runId) {
      throw new DevChainError(
        taskId,
        `Entscheidung #${escalation.number} nennt keinen Lauf — sie stammt nicht aus ` +
          'einer Sitzung und kann deshalb keine fortsetzen (§6.4).',
      );
    }

    const parked = await this.deps.runs.get(escalation.runId);
    if (!parked?.sessionId || !parked.cwd || !parked.role) {
      throw new DevChainError(
        taskId,
        `Der Lauf ${escalation.runId} zu Entscheidung #${escalation.number} ist nicht ` +
          'vollständig aufgezeichnet (Sitzung, Verzeichnis oder Rolle fehlen) — die ' +
          'Sitzung ist damit nicht wieder aufnehmbar (§6.2).',
      );
    }
    const expected = task.resumeState ? LEG_OF_STATE[task.resumeState] : undefined;
    if (parked.role !== expected) {
      throw new DevChainError(
        taskId,
        `Die geparkte Sitzung lief als "${parked.role}", die Aufgabe kehrt aber nach ` +
          `"${task.resumeState}" zurück (erwartet: "${expected ?? 'keine Rolle'}"). ` +
          'Die Entscheidung würde in die falsche Etappe eingespielt.',
      );
    }

    // Before the task moves: an answer that reached the timeline survives a
    // continuation that does not (see 3 above).
    await this.deps.tasks.note(taskId, {
      text:
        `${decisionSummary(escalation)} — die Sitzung wird mit dieser Antwort ` +
        'fortgesetzt (§6.4).',
      actor: 'orchestrator',
      payload: {
        escalationId: escalation.id,
        escalationNumber: escalation.number,
        resumedRunId: escalation.runId,
        sessionId: parked.sessionId,
      },
    });
    await this.deps.eventLog.append({
      kind: 'escalation.resumed',
      actor: 'orchestrator',
      projectId: task.projectId,
      taskId,
      runId: escalation.runId,
      payload: {
        escalationId: escalation.id,
        number: escalation.number,
        role: parked.role,
        sessionId: parked.sessionId,
        resumeState: task.resumeState,
      },
    });

    await this.deps.tasks.resume(taskId, {
      actor: 'orchestrator',
      reason: `Entscheidung #${escalation.number} beantwortet — Sitzung wird fortgesetzt (§6.4)`,
    });

    return this.pass(taskId, {
      role: parked.role as ProfileId,
      sessionId: parked.sessionId,
      cwd: parked.cwd,
      runId: escalation.runId,
      message: decisionMessage({
        number: escalation.number,
        question: escalation.question,
        chosen:
          escalation.chosenIndex !== null && escalation.options[escalation.chosenIndex]
            ? {
                index: escalation.chosenIndex,
                title: escalation.options[escalation.chosenIndex]?.title ?? '',
                pros: [...(escalation.options[escalation.chosenIndex]?.pros ?? [])],
                cons: [...(escalation.options[escalation.chosenIndex]?.cons ?? [])],
              }
            : null,
        freeText: escalation.freeText,
        decidedBy: escalation.answeredBy ?? 'max',
        decidedAt: escalation.answeredAt?.toISOString() ?? new Date().toISOString(),
      }),
      escalationNumber: escalation.number,
    });
  }

  private async pass(taskId: string, resumption: ChainResumption | null): Promise<DevChainResult> {
    const entry = await this.requireTask(taskId);
    const project = await this.deps.projects.require(entry.projectId);

    // A41, before anything is created. The worktree manager refuses too; this
    // check exists so the refusal names the chain rather than surfacing three
    // frames deeper as a failed worktree.
    if (project.readOnly) {
      throw new DevChainError(
        taskId,
        `Projekt "${project.slug}" ist als nur lesbar gekennzeichnet (A41) — ` +
          'die Entwicklungskette schreibt und wird deshalb nicht gestartet.',
      );
    }
    if (!(ENTRY_STATES as readonly string[]).includes(entry.state)) {
      throw new DevChainError(
        taskId,
        `Die Entwicklungskette läuft ab ${ENTRY_STATES.join(', ')} — die Aufgabe ist ` +
          `"${entry.state}". Unterbrochene Arbeit kommt über §7.2 zurück, geprüfte ` +
          'Arbeit über §10s Warteschlange, nicht hier.',
      );
    }

    const state: ChainState = {
      taskId,
      project,
      legs: [],
      plan: null,
      review: null,
      outOfClaims: [],
      rounds: 0,
      openFindings: [],
    };

    try {
      const result = await this.chain(entry, state, resumption);
      await this.record(state, result);
      return result;
    } catch (error) {
      if (error instanceof DevChainError) throw error;
      // Anything unexpected in the orchestration itself — a database that went
      // away, a git command that failed. It is not the task's fault and must not
      // colour it; the task is left where it stands and the caller retries.
      const problem = `Entwicklungskette abgebrochen: ${(error as Error).message}`;
      this.deps.onWarning?.(problem);
      const result = this.result(state, 'infra', problem);
      await this.record(state, result);
      return result;
    }
  }

  // --- the chain ---------------------------------------------------------------

  private async chain(
    entry: TaskRecord,
    state: ChainState,
    resumption: ChainResumption | null,
  ): Promise<DevChainResult> {
    const fresh = FRESH_STATES.includes(entry.state);
    let task =
      entry.state === 'queued'
        ? await this.deps.tasks.transition(entry.id, 'planning', {
            actor: 'orchestrator',
            reason: 'Entwicklungskette gestartet (§8.1)',
          })
        : entry;

    const worktree = await this.deps.worktrees.ensure(task.id);

    // §11's open findings, read once for the whole pass rather than per leg.
    // Per leg would be the obvious build and would be wrong: a gate run only
    // happens *after* this chain hands the task to the merge queue, so the set
    // cannot change while the chain runs — and re-reading it three times would
    // suggest to a later reader that it can.
    const openFindings = await this.deps.findings.open(task.id);
    state.openFindings = openFindings;

    const context = (current: TaskRecord): ChainPromptContext => ({
      task: current,
      project: state.project,
      worktree: assignmentToContext(worktree),
      openFindings,
    });

    /** §6.4: this leg continues the parked session — and only ever once. */
    const continuationFor = (role: ProfileId): ChainResumption | undefined => {
      if (!resumption || resumption.role !== role) return undefined;
      const use = resumption;
      resumption = null;
      return use;
    };

    let plan: PlannerResult;
    let claims: string[];

    if (fresh) {
      // --- 1. Planner (§8.1 step 1) -------------------------------------------
      const planned = await this.leg(state, {
        profile: AGENT_PROFILES.planner,
        task,
        prompt: plannerPrompt(context(task)),
        cwd: worktree.path,
        // No write root at all: the Planner has no editing tool either, and two
        // layers saying the same thing is what §6.6 asks for.
        containment: { writeRoot: null, claims: null },
        round: 0,
        resume: continuationFor('planner'),
      });
      if (planned.kind !== 'ok') return this.halt(state, task, worktree, planned);
      plan = planned.result;
      state.plan = plan;

      // --- 2. Claims (§10) ----------------------------------------------------
      await this.deps.claims.register(task.id, plan.claimSet, { actor: 'planner' });
      const acquired = await this.deps.claims.acquire(task.id, { actor: 'orchestrator' });
      if (!acquired.acquired) {
        // §10 serialises rather than fails: the task keeps its registered set and
        // waits in `planning`. No event is written — a scheduler asking every tick
        // would fill the log with identical rows (see `ClaimRegistry`).
        return {
          ...this.result(state, 'blocked', blockedProblem(acquired.conflicts)),
          conflicts: acquired.conflicts,
        };
      }
      task = acquired.task;
      claims = await this.deps.claims.heldGlobs(task.id);
    } else {
      // A pass re-entered past the Planner (header 6). Neither the plan nor the
      // claim set is re-derived: the plan is read back from the run that produced
      // it, and the claims are still held — §10 keeps them across a suspension
      // precisely so the half-finished worktree stays the only one that may touch
      // those paths. Re-planning here would spend a session to produce a plan the
      // existing diff was not built from.
      plan = await this.recoverPlan(task);
      state.plan = plan;
      claims = await this.deps.claims.heldGlobs(task.id);
    }

    // --- 3. Coder ⇄ Reviewer (§8.1 steps 2 and 3) ------------------------------
    let feedback: ReviewFeedback | undefined;
    const maxRounds = this.deps.maxReviewRounds ?? DEFAULT_REVIEW_ROUNDS;
    // Counted from the log, not from this loop: a re-entered pass is in the round
    // the task already reached, and restarting the count would hand §8.1's bound
    // three fresh rounds every time somebody escalated.
    const firstRound = fresh
      ? 1
      : Math.min(
          maxRounds,
          Math.max(
            1,
            await this.deps.tasks.countEntries(task.id, 'coding', {
              since: 'planning',
              // A return is not a round: `parked → coding` and
              // `needs_decision → coding` are how a suspension ends, and
              // counting them would spend §8.1's budget on waiting.
              notFrom: SUSPENDED_TASK_STATES,
            }),
          ),
        );
    // A task that comes back at `review` has had its Coder run for that round
    // already; running it again would throw away the diff under review.
    const reviewOnlyRound = !fresh && entry.state === 'review' ? firstRound : 0;

    for (let round = firstRound; round <= maxRounds; round += 1) {
      state.rounds = round;

      let coderSummary = '';
      if (round === reviewOnlyRound) {
        coderSummary = await this.recoveredCoderSummary(task.id);
      } else {
        task = await this.ensureState(
          task,
          'coding',
          round === 1 ? 'Umsetzung beginnt (§8.1)' : `Nachbesserung, Runde ${round}`,
        );

        const coded = await this.leg(state, {
          profile: AGENT_PROFILES.coder,
          task,
          prompt: coderPrompt({
            ...context(task),
            plan,
            claims,
            ...(feedback ? { feedback } : {}),
          }),
          cwd: worktree.path,
          containment: { writeRoot: worktree.path, claims },
          extraTools: this.deps.gateTools?.(state.project) ?? [],
          round,
          resume: continuationFor('coder'),
        });
        if (coded.kind !== 'ok') return this.halt(state, task, worktree, coded);
        coderSummary = coded.result.summary;

        task = await this.ensureState(task, 'review', 'Umsetzung übergeben (§8.1)');
      }

      // §8.1 step 3: a *different* session, always. Nothing of the Coder's
      // context travels except what the prompt carries deliberately.
      const reviewed = await this.leg(state, {
        profile: AGENT_PROFILES.reviewer,
        task,
        prompt: reviewerPrompt({
          ...context(task),
          plan,
          claims,
          coderSummary,
          round,
        }),
        cwd: worktree.path,
        containment: { writeRoot: null, claims: null },
        round,
        resume: continuationFor('reviewer'),
      });
      if (reviewed.kind !== 'ok') return this.halt(state, task, worktree, reviewed);

      state.review = reviewed.result;
      const verdict = await this.judge(worktree, claims, reviewed.result);
      state.outOfClaims = verdict.outOfClaims;

      if (verdict.approved) {
        task = await this.deps.tasks.transition(task.id, 'gates', {
          actor: 'reviewer',
          reason: 'Review erteilt (§8.1) — Prüfungen können laufen',
          payload: { rounds: round, findings: 0 },
        });
        return this.result(state, 'approved', null);
      }

      await this.deps.tasks.note(task.id, {
        text: verdict.note,
        actor: 'reviewer',
        payload: {
          round,
          verdict: reviewed.result.verdict,
          claimsRespected: reviewed.result.claimsRespected,
          outOfClaims: verdict.outOfClaims,
          findings: reviewed.result.findings,
        },
      });

      if (round === maxRounds) {
        return this.fail(
          state,
          task,
          worktree,
          `Nach ${maxRounds} Review-Runden lagen weiterhin Blocker vor (§8.1). ` +
            `Zuletzt: ${verdict.note}`,
          reviewed.result.findings.map((f) => `${f.file}: ${f.summary}`),
        );
      }
      feedback = {
        round,
        verdict: reviewed.result.verdict,
        summary: reviewed.result.summary,
        findings: reviewed.result.findings,
        outOfClaims: verdict.outOfClaims,
      };
    }

    // Unreachable: the loop either returns or completes its last round through
    // the `round === maxRounds` branch. Kept because a silent fall-through here
    // would leave a task in `review` with nobody working on it.
    return this.result(state, 'infra', 'Review-Schleife ohne Ergebnis verlassen');
  }

  // --- one leg -----------------------------------------------------------------

  /**
   * Run one role, retrying the harness and never the work (§11, A25).
   *
   * The retry loop covers `infra` only. A `failed` run is not retried here on
   * purpose: §9 already prescribes what a failure gets — a requeue with the
   * learnings attached, at a lower priority, starting again from planning — and
   * silently re-running the same session against the same state would spend
   * budget to reach the same place while hiding that it happened.
   *
   * `input.resume` makes this leg §6.4's continuation instead of a fresh
   * session: same role, same containment, same caps, and the parked session's
   * cwd rather than the worktree path this pass computed — resume is scoped to
   * the directory the session began in, and for a task whose worktree was
   * recreated in between those two are not the same string.
   */
  private async leg<R extends RoleName>(
    state: ChainState,
    input: LegInput<R>,
  ): Promise<LegResult<R>> {
    const attempts = this.deps.infra?.attempts ?? DEFAULT_INFRA_ATTEMPTS;
    const backoff = this.deps.infra?.backoffMs ?? DEFAULT_INFRA_BACKOFF_MS;
    let last = '';

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const request = {
        taskId: input.task.id,
        projectId: state.project.id,
        profile: input.profile,
        prompt: input.resume ? input.resume.message : input.prompt,
        cwd: input.resume ? input.resume.cwd : input.cwd,
        containment: {
          writeRoot: input.containment.writeRoot,
          claims: input.containment.claims,
          readOnlyProject: state.project.readOnly,
        },
        ...(input.extraTools ? { extraTools: input.extraTools } : {}),
      };
      // Retried like any other leg when the harness fails, and that is a
      // deliberate acceptance rather than an oversight: continuing the same
      // session twice branches it, which costs one duplicated turn, while
      // falling back to a fresh session would silently discard everything §6.4
      // exists to preserve. The expensive direction is the one not taken.
      const outcome = input.resume
        ? await this.deps.runner.resume({
            ...request,
            sessionId: input.resume.sessionId,
            resumeOf: input.resume.runId,
          })
        : await this.deps.runner.run(request);

      const agentStatus = outcome.status === 'ok' ? outcome.result.status : null;
      state.legs.push({
        role: input.profile.id,
        runId: outcome.run.runId,
        outcome: outcome.status,
        agentStatus,
        attempts: attempt,
        round: input.round,
      });

      if (outcome.status === 'infra') {
        last = outcome.problem;
        this.deps.onWarning?.(
          `${input.profile.id}: Infrastrukturfehler (Versuch ${attempt}/${attempts}) — ${last}`,
        );
        if (attempt < attempts) {
          await this.sleep(backoff * 2 ** (attempt - 1));
          continue;
        }
        return { kind: 'infra', problem: last };
      }
      if (outcome.status === 'auth_incident') return { kind: 'auth', problem: outcome.problem };
      if (outcome.status === 'interrupted')
        return { kind: 'interrupted', problem: outcome.problem };
      if (outcome.status === 'failed') return { kind: 'failed', problem: outcome.problem };

      // `ok` is about the harness; the agent's own verdict is the second axis.
      const result = outcome.result;
      if (result.status === 'needs_decision') {
        return { kind: 'needs_decision', problem: result.summary };
      }
      if (result.status === 'parked') return { kind: 'parked', problem: result.summary };
      if (result.status === 'failed') {
        return {
          kind: 'failed',
          problem: `${input.profile.id}: ${result.summary}`,
        };
      }
      return { kind: 'ok', result };
    }

    /* c8 ignore next */
    return { kind: 'infra', problem: last };
  }

  // --- re-entry ------------------------------------------------------------------

  /**
   * The plan a re-entered pass works from (header 6).
   *
   * Read back through the role's own contract rather than trusted as stored
   * shape: `parseAgentResult` is the one validation §6.3 defines, and a plan
   * that no longer satisfies it must not reach a Coder prompt as though it did.
   * The failure is a `DevChainError` — the record is inconsistent, which is a
   * defect rather than a task that failed (A54.6), and it names the run so the
   * next reader starts at the right row.
   */
  private async recoverPlan(task: TaskRecord): Promise<PlannerResult> {
    const record = await this.deps.runs.lastResultFor(task.id, 'planner');
    if (!record) {
      throw new DevChainError(
        task.id,
        `Die Aufgabe steht bei "${task.state}", es gibt aber keinen Planer-Lauf mit ` +
          'Ergebnis. Ohne Plan lässt sich weder eine Umsetzung noch ein Review ' +
          'fortsetzen — und ein neuer Plan wäre ein anderer als der, aus dem der ' +
          'vorhandene Diff entstanden ist.',
      );
    }
    const parsed = parseAgentResult('planner', record.resultRaw);
    if (!parsed.ok) {
      throw new DevChainError(
        task.id,
        `Der Plan aus Lauf ${record.runId} erfüllt den Rollenvertrag nicht mehr: ` +
          `${parsed.problem}.`,
      );
    }
    return parsed.result;
  }

  /**
   * What the Coder said, for a pass re-entered at `review`.
   *
   * Only the Reviewer's prompt uses it, and in the case it is needed the
   * Reviewer is usually being *continued* rather than started — so this is a
   * fallback that keeps the prompt honest rather than load-bearing evidence. An
   * unreadable one says so in words: the Reviewer reads the diff, and §8.1
   * already treats the Coder's account as a claim to check rather than a fact.
   */
  private async recoveredCoderSummary(taskId: string): Promise<string> {
    const record = await this.deps.runs.lastResultFor(taskId, 'coder');
    if (!record) return 'Keine Zusammenfassung des Coders aufgezeichnet.';
    const parsed = parseAgentResult('coder', record.resultRaw);
    return parsed.ok ? parsed.result.summary : 'Keine Zusammenfassung des Coders aufgezeichnet.';
  }

  /**
   * Move the task to `target`, unless it is already there.
   *
   * A re-entered pass starts *at* one of the states the loop would otherwise
   * transition into, and §9's map has no `coding → coding` edge — correctly, a
   * self-transition is not a state change. Without this the first act of every
   * resumed implementation would be an illegal transition.
   */
  private async ensureState(
    task: TaskRecord,
    target: TaskState,
    reason: string,
  ): Promise<TaskRecord> {
    if (task.state === target) return task;
    return this.deps.tasks.transition(task.id, target, { actor: 'orchestrator', reason });
  }

  // --- the review verdict --------------------------------------------------------

  /**
   * Is this diff mergeable, and does the Reviewer's own account of it hold?
   *
   * Two independent questions, answered together because the second is only
   * askable here. `claimsRespected` is a claim about the diff; `changedPaths`
   * plus the registered globs *is* the diff. Where they disagree the machine
   * wins, and the divergence is written into the note — a Reviewer that approves
   * a diff which left the claim set is a defect in the review, and it would
   * otherwise be invisible until §11's gates or §8.2's audit found it.
   */
  private async judge(
    worktree: WorktreeAssignment,
    claims: readonly string[],
    review: ReviewerResult,
  ): Promise<{ approved: boolean; outOfClaims: string[]; note: string }> {
    let outOfClaims: string[] = [];
    let checkProblem: string | null = null;
    try {
      const changed = await changedPaths(worktree.path, worktree.baseSha);
      outOfClaims = changed.filter((path) => !claimAllowsPath(claims, path));
    } catch (error) {
      // Fail closed. A claim check that could not run is not a claim check that
      // passed, and merging on the strength of one is precisely §10's failure.
      checkProblem = `Claim-Prüfung nicht möglich: ${(error as Error).message}`;
      this.deps.onWarning?.(checkProblem);
    }

    const lines: string[] = [];
    if (checkProblem) lines.push(checkProblem);
    if (outOfClaims.length > 0) {
      lines.push(
        `Der Diff verlässt die reservierten Pfade (§10): ${outOfClaims.join(', ')}.`,
        review.claimsRespected
          ? 'Das Review hat die Einhaltung dagegen bestätigt — die Aussage ist durch den ' +
              'Diff widerlegt und selbst ein Befund.'
          : 'Das Review hat es ebenfalls festgestellt.',
      );
    } else if (!review.claimsRespected) {
      lines.push(
        'Das Review meldet einen Verstoß gegen die Dateireservierung, der Diff zeigt ' +
          'aber keinen. Blockierend behandelt: die Prüfung ist Sache des Reviews (§8.1), ' +
          'und eine unerklärte Abweichung wird nicht wegoptimiert.',
      );
    }
    if (review.verdict === 'changes_requested') {
      lines.push(
        review.findings.length > 0
          ? `Review verlangt Änderungen: ${review.findings.length} Blocker.`
          : 'Review verlangt Änderungen, ohne einen Befund zu benennen.',
      );
    }

    const approved =
      review.verdict === 'approve' &&
      review.claimsRespected &&
      outOfClaims.length === 0 &&
      checkProblem === null;

    if (approved) return { approved, outOfClaims, note: 'Review erteilt.' };
    return {
      approved,
      outOfClaims,
      note: [review.summary.trim(), ...lines].filter(Boolean).join('\n'),
    };
  }

  // --- exits ---------------------------------------------------------------------

  /** Turn a non-`ok` leg into the task state §9/§7.3/§6.1 prescribe for it. */
  private async halt(
    state: ChainState,
    task: TaskRecord,
    worktree: WorktreeAssignment,
    leg: Exclude<LegResult<RoleName>, { kind: 'ok' }>,
  ): Promise<DevChainResult> {
    switch (leg.kind) {
      case 'infra':
        // Deliberately no state change. The harness broke, the work did not, and
        // the task is left exactly where the next attempt can pick it up (A25).
        return this.result(state, 'infra', leg.problem);
      case 'auth':
        await this.park(task, 'auth_incident', leg.problem);
        return this.result(state, 'parked', leg.problem);
      case 'interrupted':
        await this.park(task, 'guardian_wrap_up', leg.problem);
        return this.result(state, 'parked', leg.problem);
      case 'parked':
        await this.park(task, 'guardian_wrap_up', leg.problem);
        return this.result(state, 'parked', leg.problem);
      case 'needs_decision':
        await this.park(task, 'awaiting_decision', leg.problem);
        return this.result(state, 'needs_decision', leg.problem);
      case 'failed':
        return this.fail(state, task, worktree, leg.problem, []);
    }
  }

  /**
   * Park, unless something already did (§7.3).
   *
   * The guardian interrupts a session and then walks every active task itself,
   * so by the time an `interrupted` outcome reaches here the task is often
   * already `parked` with a WIP commit and a handover note. Parking again would
   * overwrite the resume point with the state the chain happens to hold, which
   * is how a task parked mid-review comes back as if it were mid-planning.
   */
  private async park(
    task: TaskRecord,
    reason: 'auth_incident' | 'guardian_wrap_up' | 'awaiting_decision',
    problem: string,
  ): Promise<void> {
    const current = await this.deps.tasks.get(task.id);
    if (!current) return;
    if (current.state === 'parked' || current.state === 'needs_decision') return;
    if (current.state === 'interrupted') return;

    const target = reason === 'awaiting_decision' ? 'needs_decision' : 'parked';
    await this.deps.tasks.note(current.id, {
      text: problem,
      actor: 'orchestrator',
      payload: { parkReason: reason },
    });
    await this.deps.tasks.transition(current.id, target, {
      actor: 'orchestrator',
      reason: problem,
      resumeState: current.state,
      // §10: claims survive the pause. Saying so in the payload is what makes
      // the timeline readable when a *different* task explains why it waited.
      payload: { parkReason: reason, claimsKept: true },
    });
  }

  /** §9's red path, with whatever the chain learned attached. */
  private async fail(
    state: ChainState,
    task: TaskRecord,
    worktree: WorktreeAssignment,
    problem: string,
    learnings: readonly string[],
  ): Promise<DevChainResult> {
    const current = (await this.deps.tasks.get(task.id)) ?? task;
    const red = await this.redPath.fail({
      task: current,
      project: state.project,
      problem,
      learnings,
      actor: 'orchestrator',
      worktree: assignmentToContext(worktree),
    });
    return {
      ...this.result(state, red.status === 'escalated' ? 'escalated' : 'red', problem),
      red,
    };
  }

  private result(
    state: ChainState,
    status: DevChainStatus,
    problem: string | null,
  ): DevChainResult {
    return {
      taskId: state.taskId,
      status,
      problem,
      legs: state.legs,
      plan: state.plan,
      review: state.review,
      outOfClaims: state.outOfClaims,
      conflicts: [],
      rounds: state.rounds,
      red: null,
      briefedFindings: state.openFindings,
    };
  }

  private async record(state: ChainState, result: DevChainResult): Promise<void> {
    await this.deps.eventLog.append({
      kind: 'chain.finished',
      actor: 'orchestrator',
      projectId: state.project.id,
      taskId: state.taskId,
      payload: {
        status: result.status,
        problem: result.problem,
        rounds: result.rounds,
        outOfClaims: result.outOfClaims,
        legs: result.legs,
        // §11's linkage, from the other end: this pass was told to fix these.
        // Without it the trace runs only one way — a finding names the task it
        // blocks, and nothing says which attempt was sent to clear it.
        briefedFindingIds: state.openFindings.map((finding) => finding.id),
      },
    });
  }

  private async sleep(ms: number): Promise<void> {
    if (this.deps.sleep) return this.deps.sleep(ms);
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async requireTask(taskId: string): Promise<TaskRecord> {
    const task = await this.deps.tasks.get(taskId);
    if (!task) throw new DevChainError(taskId, `Aufgabe ${taskId} existiert nicht`);
    return task;
  }
}

// --- internals -----------------------------------------------------------------

interface ChainState {
  taskId: string;
  project: ProjectRecord;
  legs: DevChainLeg[];
  plan: PlannerResult | null;
  review: ReviewerResult | null;
  outOfClaims: string[];
  rounds: number;
  openFindings: FindingRecord[];
}

interface LegInput<R extends RoleName> {
  profile: AgentProfile & { role: R };
  task: TaskRecord;
  prompt: string;
  cwd: string;
  containment: { writeRoot: string | null; claims: readonly string[] | null };
  extraTools?: readonly string[];
  round: number;
  /** §6.4: continue this session rather than starting one. `prompt` is unused. */
  resume?: ChainResumption | undefined;
}

type LegResult<R extends RoleName> =
  | { kind: 'ok'; result: RoleResult<R> }
  | {
      kind: 'infra' | 'auth' | 'interrupted' | 'parked' | 'needs_decision' | 'failed';
      problem: string;
    };

function assignmentToContext(worktree: WorktreeAssignment): ChainPromptContext['worktree'] {
  return {
    path: worktree.path,
    branch: worktree.branch,
    baseBranch: worktree.baseBranch,
    baseSha: worktree.baseSha,
  };
}

/** German, and it names the tasks — §15's "blockiert durch …" starts here. */
export function blockedProblem(conflicts: readonly ClaimConflict[]): string {
  if (conflicts.length === 0) return 'Dateireservierung konnte nicht belegt werden';
  return conflicts.map((conflict) => conflict.reason).join(' · ');
}
