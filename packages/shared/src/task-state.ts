/**
 * The task lifecycle (§9).
 *
 * §9 draws the lifecycle as a diagram and adds one sentence that decides how it
 * has to be built: "Every state change = one `task_events` row. No silent
 * transitions." So the transition map is not documentation — it is the rule,
 * and it lives here as data rather than as a `switch` scattered over the
 * services that move tasks around.
 *
 * The same map is seeded into the `task_transitions` table by migration 0006 so
 * that Postgres refuses an illegal transition too. Two copies of a rule is
 * normally a defect; here it is deliberate and follows the precedent set by the
 * Drizzle mirror — hand-written twice, with a test that fails on drift. The
 * reason is that the guard has to hold against a writer that never went through
 * this file, and a check constraint cannot import TypeScript.
 */

/**
 * Every state a task can be in.
 *
 * `interrupted` is worth reading twice: it is **not** a failure state. §7.2
 * gives it to work that a hard stop cut off, and requires the Debugger to
 * verify the worktree before it resumes. Treating it as red would turn a budget
 * event into fifteen broken tasks, which is exactly the confusion §6.1 forbids
 * for auth incidents and the same reasoning applies here.
 */
export const TASK_STATES = [
  'draft',
  'queued',
  'planning',
  'claimed',
  'coding',
  'review',
  'gates',
  'merge_queue',
  'merging',
  'deploying',
  'done',
  'red',
  'escalated',
  'parked',
  'needs_decision',
  'interrupted',
  'aborted',
] as const;
export type TaskState = (typeof TASK_STATES)[number];

/** Nothing follows these. Claims are released when a task reaches one (§10). */
export const TERMINAL_TASK_STATES = ['done', 'aborted'] as const;

/**
 * States from which the tick may start a dev-chain pass (§8.1).
 *
 * Here rather than in the scheduler, and that placement is the whole point: two
 * components have to agree about which tasks *would be running if nothing were
 * in the way*. The tick uses it to decide what to dispatch; the overview uses it
 * to decide which tasks are lying still on a `read_only` project (A44.3) and
 * therefore belong on a page a human reads. Two lists would be two answers, and
 * the one that drifts is the one nobody executes — the overview's — so a task
 * would vanish from the page while the tick kept skipping it, which is the
 * shape §8.2's sixth domain looks for.
 *
 * The three in-flight entries are not an oversight. Every suspension returns a
 * task to the state it was suspended *from* (A43.4), so `parked → coding` and
 * §7.2's re-check both land here; a list stopping at `planning` left three
 * resume paths at a state no dispatcher looked at.
 */
export const DISPATCHABLE_TASK_STATES = [
  'queued',
  'planning',
  'claimed',
  'coding',
  'review',
] as const;
export type DispatchableTaskState = (typeof DISPATCHABLE_TASK_STATES)[number];

/**
 * States a task waits in, holding its claims (§10, §15).
 *
 * All three record where they came from, and a resume must return exactly
 * there. Without that, "resume" silently becomes "restart at whatever the
 * scheduler feels like", and a task parked mid-review would be re-planned.
 */
export const SUSPENDED_TASK_STATES = ['parked', 'needs_decision', 'interrupted'] as const;

/**
 * States in which a task owns a worktree and may own a live model session.
 *
 * This is the set the wrap-up protocol (§7.3) walks: exactly the tasks that can
 * be interrupted mid-work and therefore need a WIP commit and a handover note.
 */
export const ACTIVE_TASK_STATES = [
  'planning',
  'claimed',
  'coding',
  'review',
  'gates',
  'merge_queue',
  'merging',
  'deploying',
] as const;

/**
 * The subset of active states in which something could have been *mid-step*.
 *
 * `claimed` and `merge_queue` are active but idle: the task holds its claims and
 * waits for a coder or for its turn in the FIFO, and no process is touching the
 * worktree. That distinction matters exactly once — at restart. §7.2's mandatory
 * integrity re-check is performed by the Debugger, which is a model session, so
 * marking a merely-waiting task `interrupted` buys nothing and spends budget
 * every single time the orchestrator restarts. A deploy restarts it.
 *
 * The wrap-up protocol still walks the wider `ACTIVE_TASK_STATES`: parking a
 * waiting task is free and makes "everything is parked" true rather than
 * approximately true.
 */
export const IN_FLIGHT_TASK_STATES = [
  'planning',
  'coding',
  'review',
  'gates',
  'merging',
  'deploying',
] as const;

export type TerminalTaskState = (typeof TERMINAL_TASK_STATES)[number];
export type SuspendedTaskState = (typeof SUSPENDED_TASK_STATES)[number];
export type ActiveTaskState = (typeof ACTIVE_TASK_STATES)[number];
export type InFlightTaskState = (typeof IN_FLIGHT_TASK_STATES)[number];

/**
 * The transition map of §9.
 *
 * Read the suspended rows with the resume rule below in mind: they list every
 * state that *could* be resumed into, but only the recorded `resumeState` is
 * legal for a given task. The map is the coarse filter, `canTransition` the
 * exact one.
 */
export const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  draft: ['queued', 'aborted'],
  queued: ['planning', 'aborted'],
  planning: ['claimed', 'red', 'needs_decision', 'parked', 'interrupted', 'aborted'],
  claimed: ['coding', 'red', 'needs_decision', 'parked', 'interrupted', 'aborted'],
  coding: ['review', 'red', 'needs_decision', 'parked', 'interrupted', 'aborted'],
  // §8.1: `changes_requested` sends the diff back to the coder, and a finding
  // is a blocker, so this edge is walked far more often than the happy one.
  review: ['gates', 'coding', 'red', 'needs_decision', 'parked', 'interrupted', 'aborted'],
  // §11: finding → fix → re-run. The fix loop returns to coding on the same task.
  gates: ['merge_queue', 'coding', 'red', 'needs_decision', 'parked', 'interrupted', 'aborted'],
  merge_queue: ['merging', 'red', 'parked', 'interrupted', 'aborted'],
  // §10: a red candidate leaves the queue back to the task — it never bounces
  // straight back to coding without passing through the red path.
  // A24: `deploy: none` makes a green merge terminal, hence the edge to `done`.
  // A55: back to `merge_queue` is what A25's "task stays queued" means once the
  // candidate is already being merged — a registry that was briefly unreachable
  // proves nothing about the change and must not colour it.
  merging: ['deploying', 'done', 'merge_queue', 'red', 'parked', 'interrupted', 'aborted'],
  // §12: a rollback marks the merged change red.
  //
  // `needs_decision` is the edge A12 and A24 both need, and it is the only one
  // Phase 5 adds to §9's map. Two situations reach it and neither can be
  // expressed anywhere earlier: **A12** reserves every self-deploy for the operator
  // personally, so the task must be able to stand still *at the deploy* and
  // wait for an inbox answer — asking before the merge would ask about a
  // candidate that has not been proven yet. And **A24** stops a deploy whose
  // migration review found the change not backward-compatible: it merged
  // legitimately (§11 has no finding against it) and must not roll out
  // unattended, because a rollback restores the previous release's *code* and
  // cannot undo what a migration did to the data.
  //
  // The way back needs no new edge: `deploying` is an `ACTIVE_TASK_STATE`, so
  // `needs_decision → deploying` already exists, and A43.4's `resume_state`
  // guarantees the answer returns the task exactly here rather than to
  // wherever a scheduler felt like.
  deploying: ['done', 'red', 'needs_decision', 'parked', 'interrupted', 'aborted'],
  done: [],
  // §9 red policy: first red requeues with lower priority, second escalates.
  red: ['queued', 'escalated', 'aborted'],
  escalated: ['queued', 'aborted'],
  parked: [...ACTIVE_TASK_STATES, 'aborted'],
  needs_decision: [...ACTIVE_TASK_STATES, 'aborted'],
  // §7.2: the integrity re-check may find the worktree unusable, which is the
  // one honest route from an interrupt to red.
  interrupted: [...ACTIVE_TASK_STATES, 'red', 'aborted'],
  aborted: [],
};

export function isTerminalTaskState(state: TaskState): state is TerminalTaskState {
  return (TERMINAL_TASK_STATES as readonly TaskState[]).includes(state);
}

export function isSuspendedTaskState(state: TaskState): state is SuspendedTaskState {
  return (SUSPENDED_TASK_STATES as readonly TaskState[]).includes(state);
}

export function isActiveTaskState(state: TaskState): state is ActiveTaskState {
  return (ACTIVE_TASK_STATES as readonly TaskState[]).includes(state);
}

export function isInFlightTaskState(state: TaskState): state is InFlightTaskState {
  return (IN_FLIGHT_TASK_STATES as readonly TaskState[]).includes(state);
}

/** A task's position, as far as a transition decision is concerned. */
export interface TaskPosition {
  state: TaskState;
  /** Where a suspended task must return to. Null in every other state. */
  resumeState: TaskState | null;
  /** Whether the integrity re-check §7.2 demands has passed since the interrupt. */
  integrityChecked?: boolean;
}

export type TransitionVerdict = { ok: true } | { ok: false; reason: string };

/**
 * May this task move to `to`?
 *
 * Three rules, in order of how expensive they are to get wrong:
 *
 *  1. The edge must exist in the map above.
 *  2. Resuming out of a suspended state must land exactly on the recorded
 *     `resumeState` — anything else loses the work in progress.
 *  3. Resuming out of `interrupted` additionally requires the integrity check
 *     of §7.2. A hard stop cut that worktree off mid-step; resuming without
 *     looking is how a half-applied edit becomes a merged one.
 *
 * Reasons are German because they surface in the inbox and the task timeline
 * (§2), not only in a log nobody reads.
 */
export function canTransition(from: TaskPosition, to: TaskState): TransitionVerdict {
  const allowed = TASK_TRANSITIONS[from.state];
  if (!allowed.includes(to)) {
    return {
      ok: false,
      reason: `Übergang ${from.state} → ${to} ist nicht vorgesehen (§9)`,
    };
  }

  if (isSuspendedTaskState(from.state) && to !== 'aborted' && to !== 'red') {
    if (from.resumeState === null) {
      return {
        ok: false,
        reason: `Zustand ${from.state} ohne gemerkten Rückkehrpunkt — Fortsetzung nicht möglich`,
      };
    }
    if (to !== from.resumeState) {
      return {
        ok: false,
        reason: `Fortsetzung muss nach ${from.resumeState} zurückkehren, nicht nach ${to} (§7.3)`,
      };
    }
  }

  if (from.state === 'interrupted' && to !== 'aborted' && to !== 'red' && !from.integrityChecked) {
    return {
      ok: false,
      reason: 'Unterbrochene Arbeit braucht zuerst die Integritätsprüfung des Worktrees (§7.2)',
    };
  }

  return { ok: true };
}

/** German labels for the dashboard and the inbox (§2). */
export const TASK_STATE_LABELS: Record<TaskState, string> = {
  draft: 'Entwurf',
  queued: 'In der Warteschlange',
  planning: 'In Planung',
  claimed: 'Dateien reserviert',
  coding: 'In Umsetzung',
  review: 'In Review',
  gates: 'Prüfungen laufen',
  merge_queue: 'Wartet auf Merge',
  merging: 'Wird zusammengeführt',
  deploying: 'Wird ausgerollt',
  done: 'Erledigt',
  red: 'Fehlgeschlagen',
  escalated: 'Wartet auf deine Entscheidung',
  parked: 'Geparkt (Budget)',
  needs_decision: 'Wartet auf deine Entscheidung',
  interrupted: 'Unterbrochen — Prüfung nötig',
  aborted: 'Abgebrochen',
};

/** Kinds of row in `task_events`. The lifecycle log of §5. */
export const TASK_EVENT_KINDS = [
  'created',
  'state_changed',
  'reprioritised',
  /** Free-form: wrap-up handover (§7.3 step 3), learnings, reviewer verdicts. */
  'note',
  /** The Planner's claim set (§10), registered before any coder starts. */
  'claims_registered',
  /**
   * The claim set was given back (§10: on merge or task abort).
   *
   * Carries the globs it released, so the timeline still shows what this task
   * had held after the fact — a release event with an empty payload would make
   * the history of a finished task unreadable exactly when someone is asking
   * why a *different* task waited on it.
   */
  'claims_released',
  /** The §7.2 re-check that has to pass before interrupted work resumes. */
  'integrity_check',
  /**
   * The worktree and branch this task works in (§10).
   *
   * A separate event rather than a column, for the reason A43 gives: the
   * assignment is a fact about the task and belongs in its log. The `tasks`
   * view projects the most recent of these two kinds, so a released worktree
   * reads back as null instead of as a directory that is no longer there.
   */
  'worktree_assigned',
  /** The worktree was removed — after a merge, an abort, or by the orphan GC. */
  'worktree_released',
  /**
   * A defect an agent named through `finding.report` (§11).
   *
   * Always a blocker — §11 has no severity below it — and never a state change:
   * reporting is the agent's half, acting on it is the orchestrator's.
   */
  'finding_reported',
  /**
   * A decision an agent prepared for the operator through `escalate.ask` (§6.4, §15).
   *
   * The question, its context and its options are recorded here from Phase 2;
   * the inbox item, the notification and the resume arrive in Phase 4. Parking
   * the task is the runner's act on seeing `status: needs_decision`, not this
   * event's — an agent cannot move its own task through §9's lifecycle.
   */
  'escalation_requested',
] as const;
export type TaskEventKind = (typeof TASK_EVENT_KINDS)[number];

/**
 * Why a task was suspended. Carried in the event payload so that the timeline
 * distinguishes "the budget ran out" from "the token expired" from "the operator paused
 * it" — three very different things that all look like `parked`.
 */
export const PARK_REASONS = [
  'guardian_wrap_up',
  'guardian_hard_stop',
  'auth_incident',
  'manual_pause',
  'awaiting_decision',
] as const;
export type ParkReason = (typeof PARK_REASONS)[number];

export const PARK_REASON_LABELS: Record<ParkReason, string> = {
  guardian_wrap_up: 'Budgetfenster fast erschöpft (Aufräummodus)',
  guardian_hard_stop: 'Budgetgrenze erreicht (Notstopp)',
  auth_incident: 'Anmeldung am Claude-Konto gestört',
  manual_pause: 'Von dir pausiert',
  awaiting_decision: 'Wartet auf deine Entscheidung',
};
