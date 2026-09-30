/**
 * The tick — the thing that calls everything Phase 2 built.
 *
 * Until now the dev chain, the merge queue, the claim registry and the
 * Betriebsprüfung were libraries with no caller. `main.ts` said so in a comment:
 * it handed `WrapUpService` an empty session list and its loop body did
 * self-checks and nothing else. This module is the caller, and its whole job is
 * to decide, repeatedly and cheaply, what may start now.
 *
 * ## Why a tick and not a queue
 *
 * §4 says pg-boss carries all executable work, and the dev chain is dispatched
 * here instead. The reason is specific rather than a shortcut (A57): pg-boss buys
 * retry policy, a dead-letter queue and an idempotent key, and a dev-chain pass
 * wants none of the three. `agent_run` is configured with `retryLimit: 0`
 * *deliberately*, because §9 owns the retry — first failure requeues with the
 * learnings attached, second escalates with a diagnosis — and a queue-level retry
 * would burn a model session and destroy the observation that carries the
 * information. Double dispatch is already impossible without it: the task state
 * machine moves a task out of `queued` on first touch and A43.2's gap-free `seq`
 * refuses the second writer. And crash safety is already stronger than a requeue
 * — `reconcile()` marks the task `interrupted` and §7.2 re-verifies the worktree
 * before anything resumes, where a job retry would re-run blindly over whatever
 * the crash left behind. The queue keeps the periodic work it is good at.
 *
 * ## What a tick may do, in order
 *
 * 1. **Ask the guardian.** Anything below can spawn a model session — a merge
 *    that goes red starts a Debugger, an audit is a session, a chain is three.
 *    §7.2's `wrap_up` says "concurrency for new sessions = 0", so outside
 *    `normal` the tick starts nothing at all and says which window stopped it.
 * 2. **Resume before starting** (§7.2). Interrupted tasks get their mandatory
 *    re-check; only then does anything new begin. A task three quarters finished
 *    outranks one that has not started, and the alternative — starting fresh work
 *    while verified work waits — is how a budget window fills up with beginnings.
 * 3. **Finish before starting.** One rollout and one merge attempt per project.
 *    A merge releases claims, which is what unblocks the tasks waiting on them,
 *    so doing it first means the same tick can start work the merge just made
 *    possible. The rollout goes ahead of the merge for the same reason step 2
 *    goes ahead of both: a task in `deploying` is the furthest through §9's
 *    pipeline of anything the tick can see, and a pass that merged first would
 *    routinely run a full gate suite *and* a health poll before starting
 *    anything at all.
 * 4. **Start what fits.** Up to the concurrency limit (A7), tightest priority
 *    first, skipping anything that would only find out it is blocked.
 * 5. **The audit, when due** (§8.2's cadence). Last, because it is the only item
 *    that examines the studio rather than moving it.
 * 6. **An idle audit, when there was nothing else** (§21). Strictly after
 *    everything above, and gated on the tick having produced *no work at all* —
 *    which is A17's "empty queue" made mechanical instead of asserted. Note the
 *    order against step 5 rather than the other way round: §8.2's cadence is a
 *    schedule that idleness must not influence ("never as idle filler"), so it
 *    is decided first and this fills what is left.
 *
 * ## Three things a tick must never do
 *
 * **Await the work it starts.** A Coder has a 90-minute wall clock. A tick that
 * awaited one would not re-ask the guardian for 90 minutes, which is the entire
 * failure §7 exists to prevent. So `tick()` starts and returns; the daemon's
 * guardian timer runs independently, and `settle()` exists for tests and for
 * shutdown.
 *
 * **Re-plan a blocked task.** `DevChain.run()` entered at `planning` runs the
 * Planner again. A task whose claims collide with a running task's would
 * therefore re-plan on every tick, for as long as the collision lasted — a
 * session every few seconds, all of it discarded. So a task that already has a
 * registered claim set is asked `blockers()` *before* a session is spawned; the
 * answer costs one query and prevents the loop.
 *
 * **Retry a defect forever.** A `DevChainError` means the caller asked for
 * something impossible (A54.6). Re-asking every tick produces the same error at
 * tick frequency. Such a task is quarantined in memory, recorded once as
 * `scheduler.defect`, and left for a human — because that is what it is.
 *
 * **Retry a broken machine in silence.** A25 has two halves and the tick used to
 * build only the first: an `infra` chain outcome backed off and came round
 * again, for as long as the fault lasted, with nothing said. Observed: four
 * tasks failing every fifteen seconds for two hours, `rounds: 0`, nobody told —
 * a studio that has stopped working and looks busy. The count now comes off the
 * event log (`infraHistory`), the alert fires exactly once when it crosses
 * `OPS_ALERT_AFTER_INFRA_ATTEMPTS`, and the task stays queued (A25, A67.6).
 */
import { DISPATCHABLE_TASK_STATES, type Priority } from '@vorschicht/shared';
import type { AuditRun, AuditTrigger } from './audit/index.js';
import type { ClaimRegistry } from './claim-registry.js';
import type { DeployResult } from './deploy/service.js';
import { DevChainError, type DevChainResult } from './dev-chain.js';
import type { EventLog } from './event-log.js';
import type { GuardianService } from './guardian-service.js';
import type { IdleAuditRun, IdleAuditSkip } from './idle-audit.js';
import { IntegrityCheckError, type IntegrityCheckResult } from './integrity-check.js';
import {
  type MergeAttempt,
  MergeQueueError,
  OPS_ALERT_AFTER_INFRA_ATTEMPTS,
  type OpsAlert,
} from './merge-queue.js';
import type { ProjectRecord, ProjectService } from './project-service.js';
import type { Queryable } from './sql.js';
import type { TaskRecord, TaskService } from './task-service.js';

/** How long a task blocked by another's claims is left alone (§10). */
export const DEFAULT_BLOCKED_BACKOFF_MS = 60_000;

/** How long a task waits after its harness failed, before the tick tries again. */
export const DEFAULT_HARNESS_BACKOFF_MS = 5 * 60_000;

/** §8.2: "Weekly, Sunday, so the Monday report carries the verdict." */
export const WEEKLY_AUDIT_INTERVAL_MS = 7 * 24 * 60 * 60_000;

/**
 * States the tick may start a dev-chain pass from. Mirrors `DevChain`'s.
 *
 * The list itself lives in `@vorschicht/shared` (`DISPATCHABLE_TASK_STATES`),
 * because the overview needs the same answer to say which tasks are lying still
 * on a `read_only` project — see that constant for why one list rather than two.
 */
const STARTABLE = DISPATCHABLE_TASK_STATES;

/**
 * What the scheduler needs from each collaborator — and nothing else.
 *
 * Declared structurally rather than as the concrete classes, following what
 * `GuardianDeps` does with `WrapUpProtocol` and for the same two reasons. It
 * documents the surface this module actually depends on, which is a small part
 * of each of these services; and it lets the decision logic be driven by stubs
 * in a test without a cast. `as unknown as DevChain` type-checks and lies —
 * it would happily accept a stub whose `run` had drifted from the real
 * signature, which is precisely the drift a test of the dispatcher exists to
 * catch. The real classes satisfy these shapes as they stand.
 */
export interface ChainDispatch {
  run(taskId: string): Promise<DevChainResult>;
  /** §6.4: continue the session parked on a decision the operator has now answered. */
  resume(taskId: string): Promise<DevChainResult>;
}

/** What the tick needs from §15's inbox: has this task's question been answered? */
export interface EscalationLookup {
  latestForTask(taskId: string): Promise<{ state: string; number: number } | null>;
}

export interface QueueDispatch {
  list(projectId: string): Promise<Array<{ taskId: string }>>;
  runOnce(projectId: string): Promise<MergeAttempt>;
  enqueue(taskId: string, options?: { actor?: string }): Promise<unknown>;
}

export interface IntegrityDispatch {
  verify(taskId: string): Promise<IntegrityCheckResult>;
}

/**
 * §12's engine, as the tick sees it: one call, five answers.
 *
 * The task and the project travel together because the engine needs both and
 * the tick has already resolved them — passing ids would make the engine repeat
 * two queries the dispatcher just made, once per pass.
 *
 * **The sha is passed rather than derived**, and that is the whole reason this
 * parameter exists. The engine's first version read `task.branch`, which is a
 * branch *name* (`vorschicht/task-<id>`) and is projected as NULL once the merge
 * queue releases the worktree — so every release produced out of a merge would
 * have been recorded as `HEAD`, with an artifact named after it and a rollback
 * destination nobody could name. A value with that much reach must not be
 * guessed out of a field that means something else.
 */
export interface DeployDispatch {
  deploy(task: TaskRecord, project: ProjectRecord, sha: string): Promise<DeployResult>;
}

/**
 * Where that sha comes from: the handover the merge queue already wrote.
 *
 * §10's fast-forward knows exactly which commit landed and puts it on the
 * `deploying` transition as `baseShaAfter`. Reading it back is one query and
 * costs nothing; re-deriving it here — `git rev-parse` on the integration
 * branch — would answer a *different* question, because a second candidate may
 * have merged in the meantime and the rollout would then quietly ship a commit
 * that never went through a deploy decision.
 *
 * Declared as a dependency for `InfraHistory`'s reason (A57.6): the tick's
 * policy stays drivable by a stub, and a rollout that cannot find its sha is
 * then testable as the dispatcher defect it is.
 */
export interface DeployHandover {
  /** Null when no `deploying` transition on this task carries one. */
  mergedSha(taskId: string): Promise<string | null>;
}

/**
 * The real lookup, over `task_events`.
 *
 * Newest first and **only rows that carry the key**: a task returns to
 * `deploying` from `parked` and from `needs_decision` too (A43.4), and those
 * transitions say nothing about which commit is being rolled out. Taking the
 * newest `deploying` row regardless would answer null for exactly the task that
 * came back from A12's approval — the one case §12 built that edge for.
 */
export function taskDeployHandover(sql: Queryable): DeployHandover {
  return {
    async mergedSha(taskId: string): Promise<string | null> {
      const [row] = await sql<Array<{ sha: string }>>`
        SELECT payload ->> 'baseShaAfter' AS sha FROM task_events
        WHERE task_id = ${taskId}
          AND kind = 'state_changed' AND state = 'deploying'
          AND payload ->> 'baseShaAfter' IS NOT NULL
        ORDER BY seq DESC LIMIT 1
      `;
      return row?.sha ?? null;
    },
  };
}

/**
 * A25's second half needs a count, and the count has to survive a restart.
 *
 * Declared as a dependency rather than reached for directly so the tick's policy
 * stays drivable by a stub (A57.6), and implemented by `chainInfraHistory`
 * below. Deliberately **not** merged with `MergeQueue`'s equivalent query: they
 * share A25's number and nothing else. The merge queue counts re-entries into a
 * *state*, because a candidate whose gates could not run goes back to
 * `merge_queue` and says so in the payload; a dev-chain pass that ends `infra`
 * changes no state at all — that is the whole point of it (`dev-chain.ts`: "the
 * harness broke, the work did not"). Folding the two would mean editing the
 * evidence behind a ticked gate (P3.G3) to serve a case it never claimed.
 */
export interface InfraHistory {
  /**
   * Consecutive dev-chain passes that ended `infra` since this task last moved.
   *
   * "Since it last moved" is the reference point A25 needs and the one the
   * merge queue could not use: a task that reached `coding` and then failed has
   * made progress, and a task that has stood in `planning` since its first
   * attempt has not. So the anchor is the most recent state change of any kind.
   */
  consecutiveInfraChains(taskId: string): Promise<number>;
}

/**
 * The real count, over `event_log`.
 *
 * `chain.finished` is the durable record of a dev-chain pass and its status, and
 * it is written for every outcome including `infra` (`DevChain.record`). Read
 * from the log rather than held in memory for A67.6's reason, which applies with
 * more force here: the process doing the retrying is exactly the process that
 * gets restarted while a machine is down (a deploy is a restart, A57), and a
 * counter that resets on restart never reaches a threshold at all.
 *
 * The anchor crosses two tables, so it is compared on time rather than on ids.
 * A tie — a state change and a chain outcome sharing a microsecond — undercounts
 * by one and therefore delays an alert rather than inventing one, which is the
 * direction to be wrong in.
 */
export function chainInfraHistory(sql: Queryable): InfraHistory {
  return {
    async consecutiveInfraChains(taskId: string): Promise<number> {
      const [row] = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM event_log
        WHERE task_id = ${taskId}
          AND kind = 'chain.finished'
          AND payload ->> 'status' = 'infra'
          AND occurred_at > COALESCE((
            SELECT max(occurred_at) FROM task_events
            WHERE task_id = ${taskId} AND kind = 'state_changed'
          ), '-infinity'::timestamptz)
      `;
      return row?.n ?? 0;
    },
  };
}

/**
 * §21's idle audit, as the tick sees it: one call, a run or a reason.
 *
 * Structurally declared for A57.6's reason, and with one property the tick
 * depends on: **it decides A17 itself.** The tick can establish two of A17's
 * three conditions from what it already knows — the guardian is `normal`
 * (nothing below the early return runs otherwise) and the queue produced no
 * work — and the third is a budget reading the scheduler has no business
 * fetching. So `runOnce` asks, and answers with the reason when it refuses.
 * A scheduler that pre-checked the budget would be the second place A17 lives.
 */
export interface IdleAuditDispatch {
  runOnce(): Promise<{ run: IdleAuditRun | null; skip: IdleAuditSkip | null }>;
}

export interface AuditDispatch {
  run(request: { trigger: AuditTrigger; scope: string }): Promise<AuditRun>;
  /**
   * `trigger` is here for `gate_flip`'s watermark, and it is nullable because
   * `audits` projects it from a payload — an audit whose `started` row predates
   * the field reads as "some audit", which the watermark treats as not-a-flip.
   */
  recent(limit?: number): Promise<Array<{ startedAt: Date; trigger?: string | null }>>;
}

/**
 * §8.2's `gate_flip` trigger: "a gate flips red → green with no intervening
 * code change."
 *
 * Structurally declared, as `InfraHistory` is, so a scheduler test needs no
 * `gate_runs` table to assert everything else. `FindingsService` implements it;
 * 0015's decision 3 built the view for this question and said so in as many
 * words, and until now nothing asked it — `AUDIT_TRIGGERS` carried the value
 * and no producer, which is §8.2's own sixth domain inside §8.2.
 */
export interface GateFlipWatch {
  flipsWithoutCodeChange(
    withinMs: number,
    limit?: number,
  ): Promise<Array<{ gateId: string; taskId: string; projectId: string; resolvedAt: Date }>>;
}

/**
 * How far back a flip is still worth a session.
 *
 * Two days: long enough that a weekend or a `wrap_up` does not swallow one,
 * short enough that turning the watch on for the first time on a repository
 * with history does not reach back through all of it. It also bounds the result
 * set of a view that expands every step of every gate run.
 */
export const GATE_FLIP_WINDOW_MS = 2 * 24 * 60 * 60_000;

/**
 * How many audits back the `gate_flip` watermark looks.
 *
 * A flip is examined at most once, so the audit that examined it is recent by
 * construction — unless a burst of other triggers has pushed it out of the
 * window, in which case the cost of not finding it is one further session and
 * not a missed examination. Twenty is `AuditService.recent`'s own default.
 */
export const AUDIT_WATERMARK_LOOKBACK = 20;

export interface SchedulerDeps {
  /**
   * `resume` is here for §12's half of §6.4, and only for it.
   *
   * A task parked on A12's approval or A24's migration stop has no agent session
   * behind it — `DeployService` raises those cards with `runId: null`. So the
   * dev chain cannot continue one, and the tick performs the lifecycle step
   * itself (A43.4's `resume_state` decides where to) and lets the rollout pick
   * it up. Everything else still goes through `ChainDispatch`.
   */
  tasks: Pick<TaskService, 'get' | 'listByState' | 'resume'>;
  projects: Pick<ProjectService, 'get' | 'listActive'>;
  claims: Pick<ClaimRegistry, 'blockers'>;
  guardian: Pick<GuardianService, 'evaluate'>;
  devChain: ChainDispatch;
  mergeQueue: QueueDispatch;
  integrity: IntegrityDispatch;
  /**
   * §12's deploy engine. Required, for the reason `escalations` is.
   *
   * A merge of a deployable project ends at `deploying` and nothing else in this
   * system moves a task out of that state. Optional here would mean a studio in
   * which every rollout stops silently one step short of production, with the
   * task sitting in a state that reads as "in Arbeit" forever — and no test
   * could tell that from a studio with nothing to deploy.
   */
  deploys: DeployDispatch;
  /** Where §12's rollout gets the commit it rolls out. Required, as `deploys` is. */
  deployHandover: DeployHandover;
  /**
   * §15's inbox — required, for the reason `DevChainDeps.findings` is.
   *
   * Optional here would mean a studio in which answering a decision changes
   * nothing and no test could tell: the task stays `needs_decision`, the claims
   * stay held, and every task behind it waits on a question that *has* been
   * answered. That is the failure §15's "no escalation timeout" makes
   * indefinite by design.
   */
  escalations: EscalationLookup;
  /**
   * A25's second half. Required, for the reason `escalations` is.
   *
   * Optional would mean a studio in which a broken machine is retried forever
   * and nothing says so — which is not a hypothesis: it ran for two hours.
   */
  infraHistory: InfraHistory;
  eventLog: Pick<EventLog, 'append'>;
  /** §8.2. Omitted means the cadence does not fire — a test's choice, not a mode. */
  audits?: AuditDispatch;
  /**
   * §21's idle audits. Optional for the reason `audits` is.
   *
   * Absent means the studio simply does nothing when the queue empties, which
   * is what it did before this existed — and it is visible as such, because
   * `report.idle` still says `no_work` and `report.idleAudit` is null. A
   * silently missing filler and a genuinely quiet studio would otherwise look
   * identical, which is the one thing §8.2's fifth rule asks us never to build.
   */
  idleAudits?: IdleAuditDispatch;
  /**
   * §8.2's `gate_flip` trigger. Optional for the reason `audits` is, and for
   * one more: without `audits` it could not fire anyway, so a required
   * dependency here would be one every scheduler test had to satisfy in order
   * to reach a code path none of them exercise.
   */
  gateFlips?: GateFlipWatch;
  /** A7: parallel agent sessions. `max_20x` → 2, `max_5x` → 1. */
  concurrency: number;
  blockedBackoffMs?: number;
  infraBackoffMs?: number;
  weeklyAuditIntervalMs?: number;
  now?: () => number;
  /**
   * A25's "persistent infra failure → Ops alert" for the dev chain.
   *
   * Its own callback rather than the merge queue's: `attempts` counts something
   * else here (chain passes, not merge attempts) and the German sentence the operator
   * reads has to say which of the two stopped. One number, two channels.
   */
  onOpsAlert?(alert: OpsAlert): void | Promise<void>;
  onWarning?(message: string): void;
  logger?: {
    info(obj: unknown, message?: string): void;
    warn(obj: unknown, message?: string): void;
    error(obj: unknown, message?: string): void;
  };
}

/** Why a tick started nothing. Null when it started something. */
export type IdleReason =
  /** §7.2: the guardian is not `normal`. Named window in `guardianState`. */
  | 'guardian'
  /** Every slot is occupied by work already running. */
  | 'concurrency'
  /** There was nothing eligible: an empty queue, or everything backed off. */
  | 'no_work';

/** One rollout this tick attempted, in the shape the daemon logs. */
export interface DeployReport {
  taskId: string;
  projectId: string;
  outcome: DeployResult['outcome'];
  deploymentId: string | null;
  /** German, from the engine. Null when it rolled out cleanly. */
  problem: string | null;
}

export interface TickReport {
  /** What the guardian said this tick. */
  guardianState: string;
  idle: IdleReason | null;
  /** §7.2's re-checks carried out this tick. */
  integrity: IntegrityCheckResult[];
  /** §6.4: sessions continued this tick because the operator answered — started, not finished. */
  decided: Array<{ taskId: string; escalationNumber: number }>;
  /** §12: at most one rollout per project, awaited — see `deployOnce`. */
  deploys: DeployReport[];
  /** At most one attempt per project. `idle`/`busy` attempts are included. */
  merges: MergeAttempt[];
  /** Chains started this tick — started, not finished. */
  started: Array<{ taskId: string; projectId: string; priority: Priority }>;
  /** Tasks skipped because another task holds overlapping claims (§10). */
  blocked: string[];
  /**
   * Tasks skipped because their project is `read_only` (A44.3, A85).
   *
   * Separate from `blocked` and not folded into it, because they are different
   * facts with different answers: a claim collision clears itself when the
   * holder merges, and this one clears only when the operator flips a flag. Reported at
   * all because until now such a task appeared **nowhere** — the `continue` sat
   * ahead of `blocked.push`, so it was absent from the tick's own account of
   * what it did, and the overview knew two kinds of waiting and not this one.
   * That is A100's finding one door over, and idle audits make it real: §21
   * files P2 tasks, and a P2 task on a read-only project is one nothing will
   * ever start and nothing would have said so.
   */
  readOnly: string[];
  audit: AuditRun | null;
  /** §21: the idle audit this tick ran, or null. */
  idleAudit: IdleAuditRun | null;
  /**
   * Why no idle audit ran, when the tick was idle enough to have wanted one.
   *
   * Null both when one ran and when the tick was not idle at all — the two are
   * told apart by `idle` and `idleAudit`, and a third value here would be a
   * fourth way to say the same thing.
   */
  idleAuditSkip: IdleAuditSkip | null;
  /** Dev-chain passes running right now, this one included. */
  inFlight: number;
}

/** A chain the scheduler started and has not seen finish. */
interface InFlight {
  taskId: string;
  startedAt: number;
  promise: Promise<void>;
}

export class Scheduler {
  private readonly inFlight = new Map<string, InFlight>();
  /** taskId → epoch ms before which the tick will not look at it again. */
  private readonly backoff = new Map<string, number>();
  /** projectId → epoch ms; set when §10's queue refused the project itself. */
  private readonly projectBackoff = new Map<string, number>();
  /** Tasks the dispatcher itself could not handle. Never retried in-process. */
  private readonly quarantined = new Set<string>();
  /** Audit triggers observed while the guardian was not `normal` (§8.2). */
  private readonly pendingAuditTriggers = new Set<AuditTrigger>();
  private lastGuardianState = 'normal';
  private auditRunning = false;
  /** Its own latch, not the audit's: §21 and §8.2 must not gate each other. */
  private idleAuditRunning = false;

  constructor(private readonly deps: SchedulerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private warn(message: string): void {
    this.deps.onWarning?.(message);
    this.deps.logger?.warn({}, message);
  }

  /** Dev-chain passes running right now. The office view reads this (§17.2). */
  get running(): string[] {
    return [...this.inFlight.keys()];
  }

  /** Tasks the dispatcher put aside. Visible so it is not a silent hole. */
  get quarantinedTasks(): string[] {
    return [...this.quarantined];
  }

  /**
   * Wait for everything this scheduler started.
   *
   * For shutdown and for tests. Deliberately not part of `tick()`: see the
   * header — a tick that awaited its own work would leave the guardian unasked
   * for the length of a Coder session.
   */
  async settle(): Promise<void> {
    while (this.inFlight.size > 0) {
      await Promise.allSettled([...this.inFlight.values()].map((entry) => entry.promise));
    }
  }

  /** One pass. Cheap, non-blocking, safe to call at any frequency. */
  async tick(): Promise<TickReport> {
    const decision = await this.deps.guardian.evaluate();
    const report: TickReport = {
      guardianState: decision.state,
      idle: null,
      integrity: [],
      decided: [],
      deploys: [],
      merges: [],
      started: [],
      blocked: [],
      readOnly: [],
      audit: null,
      idleAudit: null,
      idleAuditSkip: null,
      inFlight: this.inFlight.size,
    };

    // §8.2's triggered cadence. Observed here because the guardian's own
    // transition happens wherever `evaluate()` is called, and the audit it asks
    // for cannot run while the state that triggered it persists — no sessions
    // start outside `normal`. So the trigger is remembered and fires on the way
    // back, which is also when there is budget for it.
    this.observeGuardian(decision.state);

    if (decision.state !== 'normal') {
      report.idle = 'guardian';
      return report;
    }

    // §7.2: parked and interrupted work comes back first. Parked tasks are
    // resumed by the guardian's own transition to `normal`; interrupted ones
    // need the re-check, and nothing else in the system performs it.
    report.integrity = await this.recheckInterrupted();

    // §6.4, ahead of new work for the same reason: a task waiting on a decision
    // the operator has already made is the most nearly finished work in the studio, and
    // its claims are blocking whatever queued behind it.
    report.decided = await this.resumeDecided();

    // §12, ahead of the merge: a task in `deploying` has already been through
    // the gates and the merge, and the rollout is all that stands between it and
    // `done`. Also keeps one pass from doing a whole gate suite and a whole
    // health poll back to back.
    report.deploys = await this.deployOnce();

    // A merge releases claims, so it happens before the tick decides what to
    // start — the same pass can then begin a task the merge just unblocked.
    report.merges = await this.mergeOnce();

    const { started, blocked, readOnly } = await this.dispatch();
    report.started = started;
    report.blocked = blocked;
    report.readOnly = readOnly;
    report.inFlight = this.inFlight.size;

    // §8.2's second triggered cadence, immediately before the run it may ask
    // for, so a flip noticed on this pass is examined on this pass.
    await this.observeGateFlips();

    report.audit = await this.maybeAudit();

    if (
      report.started.length === 0 &&
      report.integrity.length === 0 &&
      report.decided.length === 0 &&
      report.audit === null &&
      // A deferred rollout did nothing, the way an `idle` merge attempt did
      // nothing — reporting it as activity would make "the studio is working"
      // true whenever the guardian flipped mid-tick.
      !report.deploys.some((deploy) => deploy.outcome !== 'deferred') &&
      !report.merges.some((attempt) => attempt.status !== 'idle' && attempt.status !== 'busy')
    ) {
      report.idle = this.inFlight.size >= this.deps.concurrency ? 'concurrency' : 'no_work';
    }

    // §21, and the sixth step: only on `no_work`, which is A17's "empty queue"
    // made mechanical. `concurrency` deliberately does not qualify — the studio
    // is busy, its slots are full, and adding an eleventh session there is the
    // opposite of filling a gap.
    await this.maybeIdleAudit(report);
    return report;
  }

  // --- §7.2's re-check ---------------------------------------------------------

  /**
   * Verify every interrupted task, one per tick.
   *
   * One rather than all, because each is a model session and a restart can
   * produce several at once — starting four Debuggers in one tick would spend a
   * chunk of a window on bookkeeping before any work resumes. They are ordered
   * by priority like everything else, so the next tick takes the next one.
   */
  private async recheckInterrupted(): Promise<IntegrityCheckResult[]> {
    if (this.inFlight.size >= this.deps.concurrency) return [];

    const candidates = await this.deps.tasks.listByState(['interrupted'], { limit: 50 });
    const task = candidates.find((candidate) => this.eligible(candidate));
    if (!task) return [];

    try {
      const result = await this.deps.integrity.verify(task.id);
      if (result.status === 'infra' || result.status === 'blocked') {
        this.backoff.set(task.id, this.now() + this.infraBackoffMs());
      }
      this.deps.logger?.info(
        { taskId: task.id, status: result.status, withoutSession: result.withoutSession },
        'Integritätsprüfung (§7.2)',
      );
      return [result];
    } catch (error) {
      if (error instanceof IntegrityCheckError) {
        await this.setAside(task, error.message);
        return [];
      }
      // Anything else is the environment rather than the task: back off and
      // come back to it, exactly as an infra outcome would.
      this.backoff.set(task.id, this.now() + this.infraBackoffMs());
      this.warn(`Integritätsprüfung für ${task.id} abgebrochen: ${(error as Error).message}`);
      return [];
    }
  }

  // --- §6.4's round trip -------------------------------------------------------

  /**
   * Continue every task whose decision has been answered.
   *
   * Three properties, each of them the answer to a way this could go wrong.
   *
   * **All of them, not one per tick.** The re-check above takes one task per
   * tick because each is a model session spent on bookkeeping; these are the
   * opposite — the session already exists, it is most of the way through its
   * work, and the operator is waiting to see something happen after he answered. They are
   * still bounded by the concurrency limit, because `start()` tracks them like
   * any other chain.
   *
   * **The inbox is asked per task rather than the other way round.** A query for
   * "answered escalations whose task is still waiting" would put §9's task
   * states inside §15's service, and the two would then have to agree about
   * which states count as waiting. The list of tasks in `needs_decision` is
   * short by construction — every one of them is a decision the operator has open or has
   * just closed.
   *
   * **An unanswered question is not an event.** Most ticks find only open items
   * and must produce no log line, no warning and no work; §15 holds claims
   * indefinitely, so this is the *ordinary* state of a blocked task and not a
   * condition to report every fifteen seconds.
   */
  private async resumeDecided(): Promise<TickReport['decided']> {
    const decided: TickReport['decided'] = [];
    if (this.inFlight.size >= this.deps.concurrency) return decided;

    const waiting = await this.deps.tasks.listByState(['needs_decision'], { limit: 100 });
    for (const task of waiting) {
      if (this.inFlight.size >= this.deps.concurrency) break;
      if (!this.eligible(task)) continue;

      let escalation: Awaited<ReturnType<EscalationLookup['latestForTask']>>;
      try {
        escalation = await this.deps.escalations.latestForTask(task.id);
      } catch (error) {
        this.backoff.set(task.id, this.now() + this.infraBackoffMs());
        this.warn(`Postfach für ${task.id} nicht lesbar: ${(error as Error).message}`);
        continue;
      }
      if (escalation?.state !== 'answered') continue;

      // §12's two cards have no session behind them (A12's approval, A24's
      // migration stop): `DeployService` raises them with `runId: null`, and
      // §6.4's continuation needs a run to resume. Handing one to the dev chain
      // therefore throws — and the tick would quarantine the task the operator has just
      // approved, which is the round trip failing precisely when it worked.
      // So the lifecycle step happens here, A43.4 decides where it lands, and
      // `deployOnce` — the next phase of this same tick — rolls it out.
      if (task.resumeState === 'deploying') {
        try {
          await this.deps.tasks.resume(task.id, {
            actor: 'orchestrator',
            reason: `Entscheidung #${escalation.number} beantwortet — Rollout wird fortgesetzt (§12)`,
            payload: { escalationNumber: escalation.number },
          });
        } catch (error) {
          this.backoff.set(task.id, this.now() + this.infraBackoffMs());
          this.warn(`Rollout von ${task.id} nicht fortsetzbar: ${(error as Error).message}`);
          continue;
        }
        decided.push({ taskId: task.id, escalationNumber: escalation.number });
        this.deps.logger?.info(
          { taskId: task.id, escalation: escalation.number },
          'Rollout wird nach Entscheidung fortgesetzt (§12, A12)',
        );
        continue;
      }

      this.start(task, (id) => this.deps.devChain.resume(id));
      decided.push({ taskId: task.id, escalationNumber: escalation.number });
      this.deps.logger?.info(
        { taskId: task.id, escalation: escalation.number },
        'Sitzung wird nach Entscheidung fortgesetzt (§6.4)',
      );
    }
    return decided;
  }

  // --- §12's rollout -----------------------------------------------------------

  /**
   * Roll out what the merge queue handed over — at most one per project.
   *
   * `DeployService` answers five ways and each gets exactly one response,
   * because collapsing any two of them loses something the next reader needs:
   *
   *   * **`deployed` / `rolled_back` / `rollback_failed` / `failed`** — the
   *     engine has already moved the task (`done` or §9's red path) and already
   *     raised the card where §12 asks for one. There is nothing left to decide
   *     here, and re-deciding it would be a second copy of §12's policy. The
   *     four are distinguished in the report and the log line rather than in
   *     the handling, because they differ in what happened and not in what is
   *     left to do — and `failed` had said `rolled_back` until A93, which is
   *     exactly the difference this log line exists to record.
   *   * **`deferred`** — the guardian said not now, which §12 permits explicitly
   *     ("no new deploys in wrap-up/hard-stop"). **No backoff, no counter, no
   *     alert**: nothing failed and nothing was attempted, so the next tick asks
   *     again. A backoff here would push a rollout minutes past the moment the
   *     window reopened, for a condition that is not a fault.
   *   * **`needs_decision`** — A12's approval or A24's migration stop. The
   *     engine has parked the task and raised the card; §15 holds it as long as
   *     it takes.
   *   * **`unsupported`** — a task reached `deploying` for a method with no
   *     target, which the merge queue refuses to produce. So it is a defect in
   *     the dispatcher rather than a failed rollout (A54.6/A57.4): quarantined
   *     in memory, recorded once as `scheduler.defect`, and left for a human.
   *     Retrying it every fifteen seconds would produce the same answer forever.
   *
   * One per project, and awaited: two rollouts of one project would race on the
   * same machine, and the alternative to awaiting — tracking it like a chain —
   * would let the next tick start a second one before the first swapped.
   *
   * A **read-only project is deliberately not skipped.** A44.3's flag refuses
   * writes to the *repository*; a rollout of already-merged code is not one, and
   * skipping here would strand a task in `deploying` with nothing to move it.
   * A12's approval is what guards the self-managed case, and the engine asks for
   * it every time.
   */
  private async deployOnce(): Promise<DeployReport[]> {
    const reports: DeployReport[] = [];
    const waiting = await this.deps.tasks.listByState(['deploying'], { limit: 50 });
    const attempted = new Set<string>();

    for (const task of waiting) {
      if (!this.eligible(task)) continue;
      if (attempted.has(task.projectId)) continue;

      const project = await this.deps.projects.get(task.projectId);
      if (!project) {
        await this.setAside(task, `Projekt ${task.projectId} existiert nicht (mehr).`);
        continue;
      }
      attempted.add(task.projectId);

      // A task that reached `deploying` without the merge queue's handover on
      // its timeline is a defect in whatever put it there — nothing else writes
      // that state. Quarantined rather than rolled out from a guessed commit:
      // "we do not know which commit this is" and "we will deploy HEAD" are the
      // same sentence only to a system that has decided not to notice.
      const sha = await this.deps.deployHandover.mergedSha(task.id);
      if (!sha) {
        await this.setAside(
          task,
          'Die Aufgabe steht auf `deploying`, aber kein Zustandswechsel nennt den ' +
            'zusammengeführten Commit (`baseShaAfter`) — es ist unklar, was ausgerollt werden ' +
            'soll.',
        );
        continue;
      }

      let result: DeployResult;
      try {
        result = await this.deps.deploys.deploy(task, project, sha);
      } catch (error) {
        // The engine catches its own failures and answers with an outcome, so
        // reaching here means the failure was outside it — the database, most
        // likely. Back off and come back, exactly as an infra chain outcome
        // would; the task keeps its state and §12's record says how far it got.
        this.backoff.set(task.id, this.now() + this.infraBackoffMs());
        this.warn(`Rollout für ${task.id} abgebrochen: ${(error as Error).message}`);
        continue;
      }

      reports.push({
        taskId: task.id,
        projectId: project.id,
        outcome: result.outcome,
        deploymentId: result.deploymentId,
        problem: result.problem,
      });
      this.deps.logger?.info(
        {
          taskId: task.id,
          projectId: project.id,
          sha,
          outcome: result.outcome,
          deploymentId: result.deploymentId,
        },
        'Rollout (§12)',
      );

      if (result.outcome === 'unsupported') {
        await this.setAside(
          task,
          result.problem ??
            'Die Aufgabe steht auf `deploying`, aber für dieses Projekt gibt es kein Deploy-Ziel.',
        );
      }
    }
    return reports;
  }

  // --- §10's queue -------------------------------------------------------------

  /**
   * One merge attempt per project with a non-empty queue.
   *
   * `runOnce` rather than `drain`: a drain runs the full gate suite once per
   * candidate, and a tick that took five test suites would hold the loop for as
   * long as they take. The next tick takes the next candidate, which costs one
   * tick interval and keeps every pass bounded.
   */
  private async mergeOnce(): Promise<MergeAttempt[]> {
    const projects = await this.deps.projects.listActive();
    const attempts: MergeAttempt[] = [];

    for (const project of projects) {
      if (project.readOnly) continue;
      const until = this.projectBackoff.get(project.id);
      if (until !== undefined && this.now() < until) continue;

      let queued: Array<{ taskId: string }>;
      try {
        queued = await this.deps.mergeQueue.list(project.id);
      } catch (error) {
        this.warn(`Warteschlange von ${project.slug} nicht lesbar: ${(error as Error).message}`);
        continue;
      }
      if (queued.length === 0) continue;

      try {
        const attempt = await this.deps.mergeQueue.runOnce(project.id);
        attempts.push(attempt);
        this.deps.logger?.info(
          { projectId: project.id, taskId: attempt.taskId, status: attempt.status },
          'Merge-Versuch',
        );
      } catch (error) {
        if (error instanceof MergeQueueError) {
          // The same class as a `DevChainError`, one level up: the queue was
          // asked for something it cannot do *for this project* at all — a
          // deploy method that does not exist yet is the case that exists today
          // (A55.6). It is a **project** condition, not a task's fault, so the
          // whole project's queue backs off rather than one candidate being
          // blamed. Backoff rather than quarantine, because the answer lives in
          // `deployConfig` and can be corrected without a restart.
          this.projectBackoff.set(project.id, this.now() + this.infraBackoffMs());
          await this.recordDefect({
            projectId: project.id,
            taskId: null,
            message: error.message,
          });
        } else {
          this.warn(`Merge in ${project.slug} abgebrochen: ${(error as Error).message}`);
        }
      }
    }
    return attempts;
  }

  // --- §8.1's chain ------------------------------------------------------------

  /** Fill the free slots with the tightest-priority work that can actually run. */
  private async dispatch(): Promise<{
    started: TickReport['started'];
    blocked: string[];
    readOnly: string[];
  }> {
    const started: TickReport['started'] = [];
    const blocked: string[] = [];
    const readOnly: string[] = [];
    if (this.inFlight.size >= this.deps.concurrency) return { started, blocked, readOnly };

    const candidates = await this.deps.tasks.listByState([...STARTABLE], { limit: 200 });
    const projectCache = new Map<string, ProjectRecord | null>();

    for (const task of candidates) {
      if (this.inFlight.size >= this.deps.concurrency) break;
      if (!this.eligible(task)) continue;

      let project = projectCache.get(task.projectId);
      if (project === undefined) {
        project = await this.deps.projects.get(task.projectId);
        projectCache.set(task.projectId, project);
      }
      if (!project) {
        await this.setAside(task, `Projekt ${task.projectId} existiert nicht (mehr).`);
        continue;
      }
      // A41/A44.3. Not a defect of this task — a project may be switched to
      // read-only while tasks exist — so it is skipped rather than quarantined.
      //
      // **Skipped, but no longer quietly.** This `continue` used to stand ahead
      // of every accumulator, so such a task appeared in no list at all: not in
      // `started`, not in `blocked`, and therefore nowhere in the tick's own
      // account of what it did. It is the shape A100 found on the overview —
      // a task that is real, is not moving, and about which nothing anywhere
      // says a word — and §21's idle audits turn it from latent into ordinary,
      // because a P2 finding filed against a read-only project is exactly this
      // task. `IdleAuditService.nextSlot` refuses such projects for that reason;
      // this list is what makes the ones that already exist findable.
      if (project.readOnly) {
        readOnly.push(task.id);
        continue;
      }

      // The check that stops the re-planning loop: a task that already has a
      // registered claim set and collides with a holder would spend a Planner
      // session only to be told to wait. Costs one query; saves a session per
      // tick for as long as the collision lasts.
      const conflicts = await this.deps.claims.blockers(task.id);
      if (conflicts.length > 0) {
        blocked.push(task.id);
        this.backoff.set(task.id, this.now() + this.blockedBackoffMs());
        continue;
      }

      this.start(task);
      started.push({ taskId: task.id, projectId: task.projectId, priority: task.priority });
    }

    return { started, blocked, readOnly };
  }

  /**
   * Start one chain and stop watching it — the promise is tracked, not awaited.
   *
   * `enter` is which entry point: an ordinary pass, or §6.4's continuation.
   * Everything after that is identical on purpose — a resumed chain returns the
   * same result shape, takes the same slot, and gets the same treatment when it
   * finishes, so nothing downstream has to know which one ran.
   */
  private start(
    task: TaskRecord,
    enter: (taskId: string) => Promise<DevChainResult> = (id) => this.deps.devChain.run(id),
  ): void {
    const startedAt = this.now();
    const promise = enter(task.id)
      .then(
        (result) => this.finished(task, result),
        (error) => this.crashed(task, error),
      )
      .finally(() => {
        this.inFlight.delete(task.id);
      });

    this.inFlight.set(task.id, { taskId: task.id, startedAt, promise });
    this.deps.logger?.info(
      { taskId: task.id, projectId: task.projectId, priority: task.priority },
      'Entwicklungskette gestartet',
    );
  }

  /**
   * What the scheduler does with a finished chain.
   *
   * Almost nothing, and that is the design: `DevChain` already wrote every
   * consequence to the task (§9's red path, the park, the claim release). What
   * is decided here is only whether and when this task may be looked at again,
   * plus the one transition the chain deliberately does not make — handing an
   * approved task to the merge queue, which is §10's job and not §8.1's.
   */
  private async finished(task: TaskRecord, result: DevChainResult): Promise<void> {
    this.deps.logger?.info(
      { taskId: task.id, status: result.status, rounds: result.rounds },
      'Entwicklungskette beendet',
    );

    switch (result.status) {
      case 'approved':
        try {
          await this.deps.mergeQueue.enqueue(task.id, { actor: 'orchestrator' });
        } catch (error) {
          // The task is in `gates` and stays there; the next tick will not pick
          // it up (it is not a startable state), so this has to be loud.
          this.warn(
            `Aufgabe ${task.id} ist freigegeben, konnte aber nicht in die ` +
              `Merge-Warteschlange: ${(error as Error).message}`,
          );
        }
        break;
      case 'blocked':
        this.backoff.set(task.id, this.now() + this.blockedBackoffMs());
        break;
      case 'infra':
        this.backoff.set(task.id, this.now() + this.infraBackoffMs());
        await this.reportPersistentInfra(task, result.problem);
        break;
      case 'red':
        // §9 requeued it at a lower priority. A backoff here would be a second,
        // undeclared policy on top of that one — the priority drop is the
        // throttle, and the tick honours it by ordering on priority.
        break;
      default:
        // `escalated`, `needs_decision`, `parked`: the task is out of the
        // startable states entirely and the tick will not see it again until
        // something else moves it.
        break;
    }
  }

  /**
   * A25's second half for the dev chain: say something, once (A67.6).
   *
   * **Exactly at the threshold, never above it.** This runs on every pass for as
   * long as the machine stays broken, and `>=` would push a notification every
   * few minutes. Crossing the line is the news; staying behind it is what the
   * task list already shows. A channel that pushes continuously is a channel
   * that gets muted, and then the next real alert is invisible.
   *
   * **The task stays where it is.** A25 again: nothing about the code was
   * established, so nothing about the task changes. The backoff its caller sets
   * is the whole of the retry policy.
   *
   * **Nothing here may throw.** `finished` is invoked from `start().then(…)` and
   * no one catches the rejection; an unreachable database at this moment would
   * otherwise turn a reported infrastructure fault into an unhandled rejection.
   */
  private async reportPersistentInfra(task: TaskRecord, problem: string | null): Promise<void> {
    const detail = problem ?? 'Kein Grund überliefert.';
    try {
      const attempts = await this.deps.infraHistory.consecutiveInfraChains(task.id);
      if (attempts !== OPS_ALERT_AFTER_INFRA_ATTEMPTS) return;

      const alert: OpsAlert = {
        projectId: task.projectId,
        taskId: task.id,
        attempts,
        problem: detail,
      };
      await this.deps.eventLog.append({
        kind: 'ops.alert',
        actor: 'orchestrator',
        projectId: task.projectId,
        taskId: task.id,
        payload: { classification: 'infra', stage: 'dev_chain', attempts, problem: detail },
      });
      this.warn(
        `Anhaltender Infrastrukturfehler: Aufgabe ${task.id} ist ${attempts} Anläufe hintereinander ` +
          `an der Umgebung gescheitert, ohne dass die Entwicklungskette vorangekommen ist (A25). ${detail}`,
      );
      await this.deps.onOpsAlert?.(alert);
    } catch (error) {
      this.warn(
        `Anhaltender Infrastrukturfehler für ${task.id} nicht meldbar: ${(error as Error).message}`,
      );
    }
  }

  private async crashed(task: TaskRecord, error: unknown): Promise<void> {
    if (error instanceof DevChainError) {
      await this.setAside(task, error.message);
      return;
    }
    // `DevChain.run()` catches everything else and returns `infra`, so reaching
    // here means the failure was in the catch path itself — the database, most
    // likely. Back off rather than quarantine: the task is probably fine.
    this.backoff.set(task.id, this.now() + this.infraBackoffMs());
    this.warn(`Entwicklungskette für ${task.id} warf: ${(error as Error).message}`);
  }

  // --- §8.2's cadence ----------------------------------------------------------

  /**
   * Note the triggers §8.2 attaches to guardian behaviour.
   *
   * `post_hard_stop` is in §8.2's list and the guardian is the only thing that
   * knows a hard stop happened. It is remembered rather than run, because an
   * audit is a model session and no session may start outside `normal` — so it
   * fires on the way back, which is also the first moment there is budget for it.
   */
  private observeGuardian(state: string): void {
    if (state === this.lastGuardianState) return;
    if (state === 'hard_stop') this.pendingAuditTriggers.add('post_hard_stop');
    this.lastGuardianState = state;
  }

  /** Queue an audit trigger from outside — the auth-incident path uses this. */
  requestAudit(trigger: AuditTrigger): void {
    this.pendingAuditTriggers.add(trigger);
  }

  /**
   * §8.2's `gate_flip`: a gate that went red and then green on the same tree.
   *
   * The watermark is the last `gate_flip` audit's own `startedAt`, not a field
   * in this process. Held in memory it would re-fire after every restart — a
   * model session for a flip already examined — and a deploy is a restart
   * (A57). Read from the record it survives both.
   *
   * The order is deliberately "flip first, watermark second": the flip query is
   * bounded and usually returns nothing, so on almost every tick this costs one
   * query and the audits lookup never happens. It is also why the flip query
   * asks for a single row — what is wanted is "is there one", not a list.
   *
   * Guarded, because this runs inside `tick()` immediately before the audit and
   * a failure to *notice* a flip must not cost the pass its merges and its
   * dispatch, which have already happened by the time it is reached.
   */
  private async observeGateFlips(): Promise<void> {
    const flips = this.deps.gateFlips;
    const audits = this.deps.audits;
    if (!flips || !audits || this.pendingAuditTriggers.has('gate_flip')) return;

    try {
      const [flip] = await flips.flipsWithoutCodeChange(GATE_FLIP_WINDOW_MS, 1);
      if (!flip) return;

      const recent = await audits.recent(AUDIT_WATERMARK_LOOKBACK);
      const last = recent.find((audit) => audit.trigger === 'gate_flip');
      // Strictly newer: an audit started in the same millisecond as the flip
      // was resolved cannot have examined it, and being wrong here costs one
      // session rather than a missed examination.
      if (last && last.startedAt.getTime() >= flip.resolvedAt.getTime()) return;

      this.pendingAuditTriggers.add('gate_flip');
      this.warn(
        `Gate ${flip.gateId} stand bei Aufgabe ${flip.taskId} erst rot und dann grün, ohne dass ` +
          'sich der geprüfte Baum geändert hat — Betriebsprüfung vorgemerkt (§8.2).',
      );
    } catch (error) {
      this.warn(`Gate-Umschwünge nicht prüfbar: ${(error as Error).message}`);
    }
  }

  /**
   * Run the audit that is due, if one is.
   *
   * Awaited rather than tracked, unlike a chain: an audit is a single session
   * with a much shorter cap, it starts at most once per tick, and it is the one
   * piece of work whose result the tick itself reports. `auditRunning` guards
   * against a slow audit being started twice by two ticks.
   */
  private async maybeAudit(): Promise<AuditRun | null> {
    const audits = this.deps.audits;
    if (!audits || this.auditRunning) return null;

    const trigger = await this.dueAudit(audits);
    if (!trigger) return null;

    this.auditRunning = true;
    try {
      const run = await audits.run({
        trigger,
        scope:
          trigger === 'weekly'
            ? 'Wöchentliche Betriebsprüfung (§8.2) über den laufenden Betrieb.'
            : `Anlassprüfung (§8.2), ausgelöst durch: ${trigger}.`,
      });
      this.pendingAuditTriggers.delete(trigger);
      this.deps.logger?.info(
        { auditId: run.id, domain: run.domain, verdict: run.verdict },
        'Betriebsprüfung abgeschlossen',
      );
      return run;
    } catch (error) {
      // §8.2 measures the auditor on finding nothing, so an audit that could not
      // run must not look like one that found nothing. The trigger stays pending
      // and the next tick tries again.
      this.warn(`Betriebsprüfung fehlgeschlagen: ${(error as Error).message}`);
      return null;
    } finally {
      this.auditRunning = false;
    }
  }

  // --- §21's idle audits -------------------------------------------------------

  /**
   * Fill an empty slot with a standing audit (§21), or say why not.
   *
   * **The gate is `report.idle === 'no_work'` and nothing else**, which is the
   * whole reason this sits at the very end of the tick: by that line the report
   * already knows whether anything started, resumed, merged, rolled out or was
   * audited, so A17's "empty queue" is *read off what this pass actually did*
   * rather than asserted from a query that might disagree with it. The guardian
   * condition comes free — `tick()` returned long ago if the state was not
   * `normal`. The third condition, usage below `IDLE_AUDIT_MAX_USAGE_PERCENT`,
   * belongs to the service (see `IdleAuditDispatch`).
   *
   * **`concurrency` is not idle.** The tick reports that reason when every slot
   * is taken by work already running, and starting a session then is not filling
   * a gap — it is queue-jumping past the limit A7 sets.
   *
   * **Awaited, like the audit above it and unlike a chain.** It is one session
   * at a time by construction (nothing else calls it), the tick reports its
   * result, and `idleAuditRunning` stops a slow one being started twice.
   *
   * **Nothing here may throw.** This runs after everything the tick has already
   * done; an exception would discard a report describing real merges and real
   * dispatches in order to complain about optional filler work.
   */
  private async maybeIdleAudit(report: TickReport): Promise<void> {
    const idleAudits = this.deps.idleAudits;
    if (!idleAudits || this.idleAuditRunning) return;
    if (report.idle !== 'no_work') return;

    this.idleAuditRunning = true;
    try {
      const { run, skip } = await idleAudits.runOnce();
      report.idleAudit = run;
      report.idleAuditSkip = skip;
      if (run) {
        this.deps.logger?.info(
          {
            projectId: run.projectId,
            domain: run.domain,
            runId: run.runId,
            findings: run.taskIds.length,
          },
          'Leerlauf-Audit (§21)',
        );
      }
    } catch (error) {
      this.warn(`Leerlauf-Audit nicht ausführbar: ${(error as Error).message}`);
    } finally {
      this.idleAuditRunning = false;
    }
  }

  /** Which trigger, if any, is owed a run right now. Triggered beats weekly. */
  private async dueAudit(audits: AuditDispatch): Promise<AuditTrigger | null> {
    const pending = [...this.pendingAuditTriggers][0];
    if (pending) return pending;

    const [last] = await audits.recent(1);
    if (!last) return 'weekly';
    const interval = this.deps.weeklyAuditIntervalMs ?? WEEKLY_AUDIT_INTERVAL_MS;
    return this.now() - last.startedAt.getTime() >= interval ? 'weekly' : null;
  }

  // --- eligibility -------------------------------------------------------------

  /** Is this task one the tick may look at at all, right now? */
  private eligible(task: TaskRecord): boolean {
    if (this.inFlight.has(task.id)) return false;
    if (this.quarantined.has(task.id)) return false;
    const until = this.backoff.get(task.id);
    if (until !== undefined) {
      if (this.now() < until) return false;
      this.backoff.delete(task.id);
    }
    return true;
  }

  private blockedBackoffMs(): number {
    return this.deps.blockedBackoffMs ?? DEFAULT_BLOCKED_BACKOFF_MS;
  }

  private infraBackoffMs(): number {
    return this.deps.infraBackoffMs ?? DEFAULT_HARNESS_BACKOFF_MS;
  }

  /**
   * Put a task aside, once, loudly.
   *
   * Quarantine is in memory on purpose: it is a statement about this process's
   * dispatcher, not about the task, and a restart with corrected code should
   * pick the task straight back up. What survives the restart is the event —
   * which is the half that matters, because an in-memory set nobody can see is
   * indistinguishable from a task that silently stopped moving.
   */
  private async setAside(task: TaskRecord, message: string): Promise<void> {
    if (this.quarantined.has(task.id)) return;
    this.quarantined.add(task.id);
    this.warn(`Aufgabe ${task.id} zurückgestellt: ${message}`);
    await this.recordDefect({ projectId: task.projectId, taskId: task.id, message });
  }

  private async recordDefect(input: {
    projectId: string | null;
    taskId: string | null;
    message: string;
  }): Promise<void> {
    try {
      await this.deps.eventLog.append({
        kind: 'scheduler.defect',
        actor: 'orchestrator',
        projectId: input.projectId,
        taskId: input.taskId,
        payload: {
          problem: input.message,
          text:
            'Der Ablaufplaner konnte damit nichts anfangen und hat es zurückgestellt. ' +
            'Das ist ein Fehler im Ablauf, keine gescheiterte Aufgabe (§9 gilt hier nicht).',
        },
      });
    } catch (error) {
      this.warn(`Ablaufplaner-Befund nicht protokollierbar: ${(error as Error).message}`);
    }
  }
}
