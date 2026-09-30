/**
 * Budget guardian service (§7.2, §7.3).
 *
 * §7 calls this the most safety-critical component, and the failure it exists
 * to prevent is specific: hitting 100% of a usage window uncontrolled, which
 * kills sessions mid-edit and leaves worktrees in states nobody planned.
 *
 * The state is a **projection**, never a stored variable. It is recomputed from
 * `usage_samples` plus `guardian_events` on every evaluation, which buys three
 * things: the Phase 1 exit gate becomes fixture replay rather than orchestration,
 * a crash cannot leave a stale "everything is fine" behind, and the reasoning is
 * auditable after the fact because every transition is an append-only row.
 *
 * The decision itself lives in `evaluateGuardian` (pure, 15 tests). This class
 * is only the wiring: read, decide, act, record.
 */
import {
  describeGuardian,
  evaluateGuardian,
  type GuardianDecision,
  type GuardianState,
  HARD_STOP_GRACE_MS,
  type WindowLatch,
} from '@vorschicht/shared';
import type postgres from 'postgres';
import type { StoppableRun } from './active-runs.js';
import type { EventLog } from './event-log.js';
import type { Notifier } from './notify.js';
import type { UsageMeter } from './usage-meter.js';

/**
 * The half of §7.3 the guardian does not own.
 *
 * The guardian stops sessions and enforces the grace period; preserving the
 * work — WIP commit, handover note, park, resume — belongs to `WrapUpService`.
 * Declared structurally rather than by import so that this module keeps no
 * dependency on the task layer, and so a guardian test needs no database of
 * tasks to assert threshold behaviour.
 */
export interface WrapUpProtocol {
  parkAll(
    reason: 'guardian_wrap_up' | 'guardian_hard_stop',
    options?: { interruptSessions?: boolean },
  ): Promise<Array<{ taskId: string; parked: boolean }>>;
  resumeAll(): Promise<unknown[]>;
}

export interface GuardianDeps {
  sql: postgres.Sql;
  meter: UsageMeter;
  eventLog: EventLog;
  notifier?: Notifier;
  /** Pause/resume the job queue. Pausing is the "no new tasks start" half. */
  queue: { pause(): Promise<void>; resume(): Promise<void>; isPaused: boolean };
  /** Currently running model sessions, for the wrap-up and hard-stop paths. */
  activeRuns: () => StoppableRun[];
  /** §7.3 steps 2–5. Absent only where there are no tasks to park. */
  wrapUp?: WrapUpProtocol;
  /**
   * A26's switch, read from where the operator set it (§17.8).
   *
   * The daemon and the dashboard are **two processes**, so `setPause` — an
   * in-memory field on this object — can never be reached by a person clicking
   * a button: the API runs in `apps/server` and this runs in
   * `apps/orchestrator`. Until this hook existed A26 was therefore a mechanism
   * with no caller, which is the shape this repository has now produced six
   * times (A71, A74.2, A86, A105, A108, and this).
   *
   * A hook rather than a `ControllingSettings` import, for the reason
   * `WrapUpProtocol` is declared structurally: this module would otherwise gain
   * a dependency on the settings layer, and a guardian test would need a
   * `config` table to assert a threshold.
   *
   * Optional, and absent means "nobody wired it" rather than "not paused" — the
   * two differ only in what a *failure* means, which is why the read below
   * fails closed rather than defaulting. `setPause` stays for the in-process
   * callers it already has; when both are present the stored value wins, so
   * there is one answer rather than two that can disagree.
   */
  manualPause?: () => Promise<ManualPause>;
  now?: () => number;
  /** Overridable so the hard-stop grace can be tested without waiting a minute. */
  graceMs?: number;
}

export interface ManualPause {
  active: boolean;
  hard: boolean;
}

export class GuardianService {
  private manualPause: ManualPause = { active: false, hard: false };
  /**
   * The pending hard-stop grace, so that leaving `hard_stop` can retire it.
   *
   * Held rather than discarded because the timer's callback reads
   * `activeRuns()` *when it fires*, not when it was scheduled — so a forgotten
   * one does not kill the sessions it was meant for, it kills whatever is
   * running a minute later. See `scheduleGrace`.
   */
  private graceTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: GuardianDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Set the pause in this process and re-evaluate at once (A26).
   *
   * **Not the path the Controlling page takes**, and the comment used to say it
   * was. The page runs in `apps/server` and this runs in the daemon, so a
   * button could never reach this field; what it reaches is `config`, which
   * `deps.manualPause` reads on the next evaluation. This stays for callers
   * inside the daemon and for the tests that drive the state machine directly —
   * and when the hook is wired it wins, because the next `evaluate()` overwrites
   * whatever was set here with the stored position. One answer, not two.
   */
  async setPause(pause: ManualPause): Promise<GuardianDecision> {
    this.manualPause = pause;
    return this.evaluate();
  }

  get pauseState(): ManualPause {
    return { ...this.manualPause };
  }

  /**
   * A26's switch as it stands right now, and what an unreachable one means.
   *
   * Fails **closed**: if the stored position cannot be read, the studio parks
   * rather than carrying on. "We could not find out whether the operator stopped us" and
   * "The operator did not stop us" are the same sentence only to a system that has
   * decided not to notice (A83.6, A87.6, A99.4, A104.4 — four subsystems, one
   * rule), and this is the one switch whose whole purpose is to be obeyed.
   * `wrap_up` and not `hard_stop`, for the reason `PAUSE_MODE_UNREADABLE` is
   * the milder of the two: a wrap-up preserves the work, a hard stop costs
   * every running task a §7.2 integrity re-check, and that must not be the
   * price of one failed query.
   *
   * The effective value is kept in `manualPause` so `record()` still attributes
   * a paused transition to `max` rather than to the scheduler — the row would
   * otherwise say the budget stopped the studio when a person did.
   */
  private async readManualPause(): Promise<ManualPause> {
    if (!this.deps.manualPause) return this.manualPause;
    try {
      this.manualPause = await this.deps.manualPause();
    } catch (error) {
      this.manualPause = { active: true, hard: false };
      await this.deps.eventLog.append({
        kind: 'guardian.anomaly',
        actor: 'controlling',
        payload: {
          kind: 'pause_unreadable',
          error: (error as Error).message,
          text:
            'Die Pause-Einstellung konnte nicht gelesen werden — das Studio räumt ' +
            'vorsichtshalber auf, statt weiterzuarbeiten (§7.2).',
        },
      });
    }
    return this.manualPause;
  }

  /**
   * Recompute the state from scratch and act on any change.
   *
   * Safe to call at any frequency and after any crash: nothing here depends on
   * what the previous evaluation left in memory, only on what it wrote down.
   */
  async evaluate(): Promise<GuardianDecision> {
    const now = this.now();
    const samples = await this.deps.meter.currentSamples();
    const previous = await this.readLast();
    const pause = await this.readManualPause();

    const decision = evaluateGuardian({
      samples,
      latches: previous?.latches ?? [],
      now,
      // Spread rather than an explicit `undefined`: with
      // exactOptionalPropertyTypes an absent option and one set to undefined
      // are different things, and only the former means "no manual pause".
      ...(pause.active ? { manualPause: pause } : {}),
    });

    if (previous?.state === decision.state) {
      // No transition, but latches may have changed (a window reset clearing,
      // a new window latching at the same severity). Record only if they did,
      // so an idle system does not write a row every minute forever.
      if (!sameLatches(previous.latches, decision.latches)) {
        await this.record(decision, 'latch_changed');
      }
      return decision;
    }

    await this.applyTransition(previous?.state ?? 'normal', decision);
    await this.record(decision, 'state_changed');
    return decision;
  }

  private async applyTransition(from: GuardianState, decision: GuardianDecision): Promise<void> {
    const to = decision.state;

    // Leaving hard_stop retires its pending grace. The kill is the consequence
    // of *that* hard stop and of nothing else, and A26 hands the operator a switch that
    // reaches hard_stop directly — so releasing a hard pause inside the minute
    // is an ordinary use of a documented control, not an edge case. Without
    // this the stale timer fires into a resumed studio and kills sessions that
    // started after it, each one leaving its task `interrupted` and therefore
    // needing a §7.2 Debugger session before it can move again.
    //
    // Only on a *transition*: hard_stop → hard_stop never reaches this method,
    // so a deadline that is still legitimately running is left alone.
    if (to !== 'hard_stop') this.cancelGrace();

    if (to === 'normal') {
      // §7.2: after a reset, parked work resumes first, in priority order.
      // Order matters here — the parked tasks are moved back to their own
      // states *before* the queue starts handing out work, or a freshly queued
      // P3 could be picked up ahead of a P0 that was three quarters finished.
      await this.deps.wrapUp?.resumeAll();
      await this.deps.queue.resume();
      return;
    }

    // Both wrap_up and hard_stop stop new work being picked up. That is the
    // whole of "concurrency for new sessions = 0", and `JobQueue.pause()` has
    // exactly these semantics: queued jobs stay queued, in-flight finishes.
    //
    // What that sentence does *not* claim, because it used to and was read as
    // more: the queue is not the enforcing layer today. The dev chain is
    // dispatched in-process (A57.1) and no worker is registered yet, so the
    // thing that actually stops work starting is the scheduler's own guardian
    // check at the head of every tick. This call closes the second gate — the
    // one Phase 6's radar and Phase 8's report will arrive behind — and the
    // daemon hands in an adapter that never throws (`work-gate.ts`), because a
    // queue that could raise here would take a §7.2 transition down with it.
    await this.deps.queue.pause();

    if (to === 'wrap_up') {
      // Running work executes the wrap-up protocol (§7.3): finish the current
      // atomic step, commit WIP, hand over. `interrupt` is what makes that
      // possible — a kill here would be the mid-edit stop §7.3 forbids.
      for (const run of this.deps.activeRuns()) {
        await run.interrupt('guardian_wrap_up');
      }
      await this.parkRunningWork('guardian_wrap_up');
      return;
    }

    // hard_stop: Vorschicht's 95% is spent and the rest belongs to the operator.
    for (const run of this.deps.activeRuns()) {
      await run.interrupt('guardian_hard_stop');
    }
    await this.parkRunningWork('guardian_hard_stop');
    this.scheduleGrace(from);
  }

  /**
   * Steps 2–5 of §7.3, delegated.
   *
   * `interruptSessions: false` because step 1 just happened above: the runs
   * were asked to stop and the calls were awaited. Asking twice would be
   * harmless but dishonest about who owns which step.
   *
   * A failure here must not abort the transition. The budget state is already
   * decided and the queue is already paused; losing that because a WIP commit
   * failed would trade a parked task for an uncontrolled limit event.
   */
  private async parkRunningWork(reason: 'guardian_wrap_up' | 'guardian_hard_stop'): Promise<void> {
    if (!this.deps.wrapUp) return;
    try {
      const outcomes = await this.deps.wrapUp.parkAll(reason, { interruptSessions: false });
      const failed = outcomes.filter((o) => !o.parked);
      if (failed.length > 0) {
        await this.deps.eventLog.append({
          kind: 'guardian.anomaly',
          actor: 'controlling',
          payload: {
            kind: 'wrap_up_incomplete',
            reason,
            tasks: failed.map((o) => o.taskId),
            text: `${failed.length} Aufgabe(n) konnten beim Aufräumen nicht geparkt werden`,
          },
        });
      }
    } catch (error) {
      await this.deps.eventLog.append({
        kind: 'guardian.anomaly',
        actor: 'controlling',
        payload: {
          kind: 'wrap_up_failed',
          reason,
          error: (error as Error).message,
          text: 'Das Aufräumprotokoll ist fehlgeschlagen — Aufgaben prüfen',
        },
      });
    }
  }

  /**
   * The 60-second grace from §7.2, then termination.
   *
   * Anything still running after the grace is killed and its task marked
   * `interrupted` — which is not a failure state but a *re-check* state: §7.2
   * requires the Debugger to verify the worktree before that task resumes.
   */
  private scheduleGrace(from: GuardianState): void {
    // Never two deadlines at once: re-entering hard_stop replaces the pending
    // one rather than adding to it.
    this.cancelGrace();
    const grace = this.deps.graceMs ?? HARD_STOP_GRACE_MS;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      void (async () => {
        for (const run of this.deps.activeRuns()) {
          await run.kill();
          await this.deps.eventLog.append({
            kind: 'run.interrupted',
            actor: 'controlling',
            runId: run.runId,
            payload: { reason: 'hard_stop_grace_expired', previousState: from },
          });
        }
      })();
    }, grace);
    this.graceTimer.unref?.();
  }

  /** Retire a pending grace. Idempotent, and safe when none is scheduled. */
  private cancelGrace(): void {
    if (this.graceTimer === null) return;
    clearTimeout(this.graceTimer);
    this.graceTimer = null;
  }

  private async record(decision: GuardianDecision, trigger: string): Promise<void> {
    await this.deps.sql`
      INSERT INTO guardian_events (state, reason, governing_window, latches, actor)
      VALUES (
        ${decision.state},
        ${this.deps.sql.json(decision.reason as postgres.JSONValue)},
        ${decision.governingWindow},
        ${this.deps.sql.json(decision.latches as unknown as postgres.JSONValue)},
        ${this.manualPause.active ? 'max' : 'system'}
      )
    `;

    const text = describeGuardian(decision);
    await this.deps.eventLog.append({
      kind: 'guardian.state_changed',
      actor: this.manualPause.active ? 'max' : 'controlling',
      payload: {
        state: decision.state,
        trigger,
        governingWindow: decision.governingWindow,
        reason: decision.reason,
        text,
      },
    });

    if (trigger === 'state_changed') {
      // §7.2: guardian state changes emit info notifications. German, per §2 —
      // describeGuardian already produces the user-facing wording.
      await this.deps.notifier?.send({
        topic: 'info',
        title: 'Vorschicht: Budgetzustand',
        message: text,
        priority: decision.state === 'hard_stop' ? 'high' : 'default',
      });
    }
  }

  /** The newest recorded state, which is what the latches carry forward. */
  private async readLast(): Promise<{ state: GuardianState; latches: WindowLatch[] } | null> {
    const [row] = await this.deps.sql<Array<{ state: GuardianState; latches: WindowLatch[] }>>`
      SELECT state, latches FROM guardian_events ORDER BY id DESC LIMIT 1
    `;
    if (!row) return null;
    return { state: row.state, latches: row.latches ?? [] };
  }

  /**
   * Replay the whole history to a state, for auditing and for tests.
   *
   * That this is possible at all is the point of storing events rather than a
   * variable: the answer to "why did it stop on Thursday" is reconstructible.
   */
  async replay(): Promise<GuardianDecision | null> {
    const rows = await this.deps.sql<Array<{ state: GuardianState; latches: WindowLatch[] }>>`
      SELECT state, latches FROM guardian_events ORDER BY id ASC
    `;
    if (rows.length === 0) return null;
    const last = rows[rows.length - 1];
    if (!last) return null;
    return evaluateGuardian({
      samples: await this.deps.meter.currentSamples(),
      latches: last.latches ?? [],
      now: this.now(),
    });
  }
}

function sameLatches(a: readonly WindowLatch[], b: readonly WindowLatch[]): boolean {
  if (a.length !== b.length) return false;
  const key = (latch: WindowLatch) => `${latch.window}:${latch.modelClass ?? ''}:${latch.state}`;
  const left = a.map(key).sort();
  const right = b.map(key).sort();
  return left.every((value, index) => value === right[index]);
}
