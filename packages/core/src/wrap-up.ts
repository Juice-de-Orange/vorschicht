/**
 * The wrap-up protocol (§7.3).
 *
 * This is the direct answer to the failure mode §7 names: "limit crash →
 * consistency errors". A session that dies at 100% of a window dies mid-edit,
 * and what it leaves behind is a worktree nobody planned, a task whose state is
 * a guess, and a next session that has to reconstruct intent from a diff.
 *
 * §7.3 replaces that with five steps, and this module is those five steps in
 * order:
 *
 *   1. finish the current atomic step — the caller interrupts the run and
 *      awaits it; a kill here would be exactly the mid-edit stop being avoided;
 *   2. commit WIP to the task branch with a `wip:` prefix, never to main;
 *   3. write a handover note into `task_events`: state, next step, open questions;
 *   4. keep the file claims and set the task `parked`;
 *   5. log everything, and confirm zero active sessions before declaring the
 *      wrap-up complete.
 *
 * Step 4's "keep claims" is the one that looks like an oversight and is not:
 * §10 releases claims on merge or abort only, so a parked task keeps its area
 * of the project reserved. Releasing them would let a second task start editing
 * files the parked one has half-changed, which is the interference the claim
 * system exists to prevent.
 */
import type { ParkReason, TaskState } from '@vorschicht/shared';
import { PARK_REASON_LABELS } from '@vorschicht/shared';
import type { EventLog } from './event-log.js';
import { commitWip, type WipCommitResult } from './git.js';
import { TaskConflictError, type TaskRecord, type TaskService } from './task-service.js';

/** A live model session, as far as the wrap-up needs to know. */
export interface ActiveSession {
  readonly runId: string;
  readonly taskId: string | null;
  /** Where the session works; null for staff roles in scratch dirs (§6.2). */
  readonly cwd: string | null;
  /** Ask it to stop gracefully and wait for the current turn to end. */
  interrupt(reason: 'guardian_wrap_up' | 'guardian_hard_stop'): Promise<void>;
}

export interface WrapUpOutcome {
  taskId: string;
  runId: string | null;
  /** The state the task will resume into. */
  resumeState: TaskState;
  commit: WipCommitResult | null;
  handover: string;
  parked: boolean;
  /** Present when the task could not be parked; the timeline shows it. */
  problem?: string;
}

export interface WrapUpDeps {
  tasks: TaskService;
  eventLog: EventLog;
  /** Sessions currently running, keyed by nothing — the list is walked. */
  activeSessions: () => ActiveSession[];
  /** Overridable for tests; production passes the real git. */
  commit?: typeof commitWip;
  /** §7.2's in-flight-deploy exception says so out loud when it applies. */
  onWarning?: (message: string) => void;
}

/**
 * Text handed to the next session that picks this task up.
 *
 * Kept factual and German (§2): a note that says "continue where you left off"
 * is worse than no note, because it costs a session the time to discover that
 * it says nothing.
 */
export function handoverText(task: TaskRecord, reason: ParkReason, commit: WipCommitResult | null) {
  const lines = [
    `Geparkt im Zustand "${task.state}" — ${PARK_REASON_LABELS[reason]}.`,
    commit?.committed
      ? `Zwischenstand gesichert als ${commit.sha?.slice(0, 12)} auf ${commit.branch} (${commit.files.length} Datei(en)).`
      : `Kein WIP-Commit: ${commit?.skipped ?? 'kein Arbeitsverzeichnis hinterlegt'}.`,
    `Fortsetzung führt zurück nach "${task.state}"; die Dateireservierungen bleiben bestehen (§10).`,
  ];
  return lines.join('\n');
}

export class WrapUpService {
  constructor(private readonly deps: WrapUpDeps) {}

  private get commit() {
    return this.deps.commit ?? commitWip;
  }

  /**
   * Park every task that is currently being worked on.
   *
   * Returns one outcome per task, including the ones that failed to park —
   * §1 principle 2 has no "mostly done", and a task that could not be parked is
   * information the guardian needs before it declares the wrap-up complete.
   */
  async parkAll(
    reason: ParkReason,
    options: {
      /**
       * Whether step 1 (the graceful interrupt) still has to happen here.
       *
       * The guardian interrupts before it calls this — stopping sessions and
       * the 60-second hard-stop grace are its job (§7.2), preserving the work
       * is this one's. Every other caller starts with running sessions and
       * therefore leaves this at its default.
       */
      interruptSessions?: boolean;
    } = {},
  ): Promise<WrapUpOutcome[]> {
    const sessions = this.deps.activeSessions();
    const sessionByTask = new Map<string, ActiveSession>();
    for (const session of sessions) {
      if (session.taskId) sessionByTask.set(session.taskId, session);
    }

    /*
     * §7.2's one exception, and it is written into that table in so many words:
     * *"No new deploys; **in-flight deploys finish their health check**."*
     *
     * Without this, a guardian threshold crossed between the swap and the health
     * check parks a task in `deploying` — and then the deploy finishes, wants
     * `done`, and §9's map refuses it, because `parked` leads back to the active
     * states and `done` is not one of them. The net result is the worst outcome
     * this system can produce: **production is swapped, the record says
     * "parked", and nothing anywhere says whether it worked.** Reported by the
     * stream wiring the engine up, and confirmed by reading the transition map
     * rather than by running into it.
     *
     * The exception holds for `hard_stop` too, and that is deliberate rather
     * than an oversight of the same rule: §7.2 has hard-stop terminate running
     * *sessions*, and a deploy is not one. Killing it between the swap and the
     * health check would leave exactly the state the rollback exists to avoid,
     * with nobody left to perform the rollback. The bound is the health
     * timeout, which the config caps at thirty minutes.
     */
    const active = await this.deps.tasks.listActive();
    const outcomes: WrapUpOutcome[] = [];
    const running: string[] = [];
    for (const task of active) {
      if (task.state === 'deploying') {
        running.push(task.id);
        continue;
      }
      outcomes.push(
        await this.parkOne(task, reason, sessionByTask.get(task.id) ?? null, {
          interrupt: options.interruptSessions ?? true,
        }),
      );
    }
    if (running.length > 0) {
      // Said out loud: a wrap-up that reports fewer parked tasks than there were
      // active ones is otherwise indistinguishable from one that missed some.
      this.deps.onWarning?.(
        `${running.length} laufende(s) Deployment(s) nicht geparkt — §7.2 lässt sie ihre ` +
          'Gesundheitsprüfung zu Ende führen.',
      );
    }

    await this.deps.eventLog.append({
      kind: 'task.state_changed',
      actor: 'controlling',
      payload: {
        protocol: 'wrap_up',
        reason,
        parked: outcomes.filter((o) => o.parked).length,
        failed: outcomes
          .filter((o) => !o.parked)
          .map((o) => ({ taskId: o.taskId, why: o.problem })),
      },
    });

    return outcomes;
  }

  /** Steps 1–5 for a single task. */
  async parkOne(
    task: TaskRecord,
    reason: ParkReason,
    session: ActiveSession | null,
    options: { interrupt?: boolean } = {},
  ): Promise<WrapUpOutcome> {
    const resumeState = task.state;

    // Step 1 — finish the current atomic step. The interrupt is graceful by
    // contract (A32); waiting for it is what makes "never mid-edit" true.
    if (session && options.interrupt !== false) {
      try {
        await session.interrupt(
          reason === 'guardian_hard_stop' ? 'guardian_hard_stop' : 'guardian_wrap_up',
        );
      } catch (error) {
        // A session that refuses to stop still has to be parked — otherwise the
        // budget event leaves a task in limbo, which is the whole failure mode.
        await this.deps.eventLog.append({
          kind: 'run.interrupted',
          actor: 'controlling',
          taskId: task.id,
          runId: session.runId,
          payload: { reason, error: (error as Error).message, graceful: false },
        });
      }
    }

    // Step 2 — WIP commit on the task branch, never on main.
    const cwd = session?.cwd ?? task.worktreePath;
    let commit: WipCommitResult | null = null;
    if (cwd) {
      try {
        commit = await this.commit(cwd, `wip: ${task.title} (${resumeState})`);
      } catch (error) {
        commit = {
          committed: false,
          sha: null,
          branch: task.branch ?? '',
          files: [],
          skipped: `WIP-Commit fehlgeschlagen: ${(error as Error).message}`,
        };
      }
    }

    const handover = handoverText(task, reason, commit);

    try {
      // Step 3 — the handover note, written *before* the state moves so that a
      // crash between the two leaves the note rather than losing it.
      await this.deps.tasks.note(task.id, {
        text: handover,
        actor: 'controlling',
        payload: {
          protocol: 'wrap_up',
          reason,
          resumeState,
          commit: commit
            ? { committed: commit.committed, sha: commit.sha, branch: commit.branch }
            : null,
          runId: session?.runId ?? null,
        },
      });

      // Step 4 — park, keeping the claims (§10).
      await this.deps.tasks.transition(task.id, 'parked', {
        actor: 'controlling',
        reason: PARK_REASON_LABELS[reason],
        resumeState,
        payload: { parkReason: reason, claimsKept: true, wipSha: commit?.sha ?? null },
      });
    } catch (error) {
      const problem =
        error instanceof TaskConflictError
          ? 'Aufgabe wurde zwischenzeitlich verändert — Parken übersprungen'
          : (error as Error).message;
      return {
        taskId: task.id,
        runId: session?.runId ?? null,
        resumeState,
        commit,
        handover,
        parked: false,
        problem,
      };
    }

    return {
      taskId: task.id,
      runId: session?.runId ?? null,
      resumeState,
      commit,
      handover,
      parked: true,
    };
  }

  /**
   * Step 5 — the guardian's confirmation that the wrap-up actually finished.
   *
   * "No active sessions" is the observable form of "nothing is mid-edit any
   * more". Declaring wrap-up complete while a session still runs would be the
   * same optimism that produced the failure mode in the first place.
   */
  isComplete(outcomes: WrapUpOutcome[]): { complete: boolean; reason: string } {
    const stillRunning = this.deps.activeSessions().length;
    if (stillRunning > 0) {
      return { complete: false, reason: `${stillRunning} Sitzung(en) laufen noch` };
    }
    const failed = outcomes.filter((o) => !o.parked);
    if (failed.length > 0) {
      return {
        complete: false,
        reason: `${failed.length} Aufgabe(n) konnten nicht geparkt werden`,
      };
    }
    return { complete: true, reason: 'Alle Aufgaben geparkt, keine Sitzung aktiv' };
  }

  /**
   * Resume parked work after a window reset (§7.2).
   *
   * Parked tasks come back first and in priority order — that is the sentence
   * §7.2 ends on, and it matters because the alternative (fair queueing) would
   * let a fresh P3 overtake a P0 that was three quarters finished.
   */
  async resumeAll(): Promise<TaskRecord[]> {
    const parked = await this.deps.tasks.listResumable();
    const resumed: TaskRecord[] = [];
    for (const task of parked) {
      try {
        resumed.push(
          await this.deps.tasks.resume(task.id, {
            actor: 'controlling',
            reason: 'Budgetfenster zurückgesetzt — Arbeit wird fortgesetzt',
          }),
        );
      } catch (error) {
        await this.deps.eventLog.append({
          kind: 'task.state_changed',
          actor: 'controlling',
          taskId: task.id,
          payload: { protocol: 'resume', failed: true, error: (error as Error).message },
        });
      }
    }
    return resumed;
  }
}
