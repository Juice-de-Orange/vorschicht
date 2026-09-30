/**
 * The registry of model sessions that are running *right now*.
 *
 * It exists because of one line in the daemon that was true when it was written
 * and became a hole the moment the runner arrived:
 *
 * ```ts
 * const wrapUp = new WrapUpService({ tasks, eventLog, activeSessions: () => [] });
 * ```
 *
 * The guardian's §7.2 paths both iterate the active runs — `wrap_up` calls
 * `interrupt()` on each so §7.3 step 1 ("finish the current atomic step, never
 * mid-edit") can happen at all, and `hard_stop` calls `kill()` after the 60-second
 * grace. Against an empty list both loops are no-ops: the guardian would record
 * the transition, pause the queue, park the tasks — and leave the sessions those
 * tasks own running until their own wall clock expired. The budget window it was
 * defending would be crossed by exactly the sessions it thought it had stopped,
 * and nothing in the log would say so, because a loop over nothing logs nothing.
 *
 * So the registry is deliberately dumb and deliberately owned by the runner
 * rather than by the scheduler: a session is registered by the code that spawned
 * it, one line after the spawn, and deregistered in the `finally` that ends it.
 * Anything that spawns a session gets this for free, including the ones the
 * scheduler never sees — §6.3's repair leg, §9's Debugger diagnosis, §8.2's
 * auditor. A registry the scheduler maintained would list only what the scheduler
 * started, which is the subset that is easiest to remember and least likely to be
 * the one still running when a window fills up.
 */

/**
 * A run the guardian may have to stop (§7.2).
 *
 * Structural rather than `RunHandle` itself: the guardian has no business
 * knowing about backends, event streams or transcripts, and a guardian test
 * should not need a CLI. `RunHandle` satisfies this shape as it stands, which is
 * how the runner can register its handle unchanged.
 */
export interface StoppableRun {
  readonly runId: string;
  /** §7.3 step 1. The only stop that can be graceful. */
  interrupt(reason: 'guardian_wrap_up' | 'guardian_hard_stop'): Promise<void>;
  /** Last resort, after the grace. Terminates the process group. */
  kill(): Promise<void>;
}

/**
 * What the registry knows about a live session, beyond how to stop it.
 *
 * `cwd` is here rather than derived because the *other* consumer needs it:
 * `WrapUpService.ActiveSession` carries "where the session works" so §7.3 step 2
 * knows which worktree to write the WIP commit into. One registry answering both
 * §7.2's "stop it" and §7.3's "preserve it" is deliberate — two lists of live
 * sessions maintained separately would disagree exactly once, on the day the
 * guardian fires.
 */
export interface ActiveRunEntry {
  readonly runId: string;
  /** Null for a session that serves no task — §8.2's auditor, so far only it. */
  readonly taskId: string | null;
  readonly role: string;
  /** Where the session works; null for a staff role in a scratch dir (§6.2). */
  readonly cwd: string | null;
  /** Epoch ms. Used by the office view (§17.2) and by nothing load-bearing. */
  readonly startedAt: number;
}

export type ActiveRun = StoppableRun & ActiveRunEntry;

export class ActiveRunRegistry {
  private readonly live = new Map<string, ActiveRun>();

  /**
   * Register a live session and get back the one call that ends its entry.
   *
   * The deregister function rather than a `remove(runId)` method, because the
   * caller then cannot get the id wrong and cannot forget which id it used. It
   * is idempotent, so a `finally` that runs after an early return is harmless.
   */
  register(run: ActiveRun): () => void {
    this.live.set(run.runId, run);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.live.delete(run.runId);
    };
  }

  /** Everything running now, in registration order. */
  list(): ActiveRun[] {
    return [...this.live.values()];
  }

  /** Live sessions belonging to one task — §7.3 parks one task at a time. */
  forTask(taskId: string): ActiveRun[] {
    return this.list().filter((run) => run.taskId === taskId);
  }

  has(runId: string): boolean {
    return this.live.has(runId);
  }

  get size(): number {
    return this.live.size;
  }
}
