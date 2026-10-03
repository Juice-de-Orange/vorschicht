/**
 * The daemon's clock for scheduled work (§18, §21, §6.0, §16).
 *
 * Everything that arrives from here on hangs off a deadline: the radar scans
 * (§6.0), the idle-audit rotation (§21), the disk watch (A30), §16's weekly
 * report. Today `main()` carries four of those deadlines as `let` variables
 * with their comparisons inlined, in an entry point that has no test — and a
 * fifth, sixth and seventh in the same file is how a caller goes missing (A86).
 * So the cadence gets a name and a test, starting with one registered job.
 *
 * **What this does not replace, and why**, because a header that claimed the
 * four existing variables would be claiming more than the mechanism can carry
 * (A76.4's shape):
 *
 *  * `nextEstimateAt` **cannot** move here. A101 removed
 *    `UsageEstimatorDeps.eventLog` as dead wiring, so `estimator.sample()`
 *    writes `usage_samples` and no event at all — a job registered here would
 *    find no row, read as never-run and fire on every tick. Giving the
 *    estimator an event back to fix that would reinstate exactly the
 *    dependency A101 deleted and write a permanent row every minute, which is
 *    the flood A98 and A101 both ended.
 *  * `nextEstimateAt` and the probe backoff (`SmokeGate`) are also **order**,
 *    not cadence: `main.ts` argues at length that the estimate must run *before* the
 *    guardian is consulted and the smoke probe before both (A58). A generic
 *    pass in the loop body would silently retire that ordering, and no test
 *    would see it, because both calls would still happen.
 *  * the probe backoff is a backoff behind a one-shot latch, not a recurrence.
 *  * `nextMailAt` belongs to `notifications-pass.ts`, which owns both halves of
 *    A13 together and reports them as one outcome.
 *
 *  `lastWorktreeGc` is the one that would fit — `WorktreeManager.gc()` writes
 *  `worktree.gc` unconditionally — and it is deliberately left where it is:
 *  moving a working daily job is a change with no defect behind it, and this
 *  commit is already carrying the queue and two audit triggers.
 *
 * Five decisions.
 *
 *  1. **A deadline is read from `event_log`, never from a process variable.**
 *     `scheduler.ts` gives the reason in as many words for the audit cadence,
 *     and it is the reason here: the process that would hold the variable is
 *     exactly the one that gets restarted, and a deploy is a restart (A57). A
 *     counter that resets on restart either re-runs a nightly job on every
 *     rollout or, worse, never reaches its threshold at all. The precedents are
 *     `EscalationMailService`'s `lastDigestAt` and the scheduler's
 *     `audits.recent(1)`; both read the row the work itself wrote.
 *
 *  2. **The clock is Postgres's, so no clock is injected.** The age of a row is
 *     computed in the same database that stamped it, which removes the one
 *     failure a `Date.now()` comparison against `occurred_at` can have and
 *     nobody would ever see: a container whose clock has drifted from the
 *     database's. `backup-pass.ts` reaches the same arrangement from the other
 *     direction (a run's identity is its own `finished_at`), and it is worth
 *     saying out loud because every other module here injects `now`.
 *
 *  3. **A job that ran and wrote nothing runs again on the next pass.** That is
 *     not a bug to guard against here, it is the contract handed to the job: it
 *     must write its own event even when it has nothing to report, or it has no
 *     deadline at all. Stated in `PeriodicJob.lastRunKind` and asserted in the
 *     disk watch, which writes `disk.checked` on every run including the ones
 *     that failed to measure anything.
 *
 *  4. **It never throws, and each job is guarded separately.** Same reasoning
 *     as `notifications-pass.ts` property 1 and 2: this is called from the
 *     `while` body of `main()`, where a rejection reaches `main().catch()` and
 *     becomes `process.exit(1)` — a restart carousel under compose. And a radar
 *     scan that blew up must not cost the disk watch its hour.
 *
 *  5. **One query for all deadlines, not one per job.** The pass runs at tick
 *     frequency (15 s) and will carry half a dozen jobs by Phase 8; six indexed
 *     lookups every fifteen seconds, forever, to learn that nothing is due is
 *     the kind of cost that is invisible until it is not.
 */
import type { EventKind, Queryable } from '@vorschicht/core';

/** One scheduled job. Registered by `main()`, run here. */
export interface PeriodicJob {
  /** For the log and the result. Not persisted anywhere. */
  name: string;
  /** How long after its last recorded run this job is due again. */
  intervalMs: number;
  /**
   * The event kind whose most recent row dates the last run (decision 1).
   *
   * The job **must** write one on every run, including the runs where it found
   * nothing — that row is its only memory, and a job that writes only on a
   * transition has no deadline and runs on every pass forever (decision 3).
   */
  lastRunKind: EventKind;
  /** German, for the log. Anything thrown is caught and reported (decision 4). */
  run(): Promise<string | null>;
}

export interface PeriodicPassDeps {
  jobs: readonly PeriodicJob[];
  sql: Queryable;
  logger: {
    info(obj: unknown, message?: string): void;
    warn(obj: unknown, message?: string): void;
    error(obj: unknown, message?: string): void;
  };
}

export interface PeriodicPassResult {
  /** Jobs that were due and ran to completion on this pass. */
  ran: string[];
  /** Jobs whose deadline had not passed. The ordinary case. */
  waiting: string[];
  /** Jobs that threw. German, for the caller (decision 4). */
  problems: string[];
}

/** How old the last recorded run of each kind is, in milliseconds. */
type Ages = Map<EventKind, number>;

export async function runPeriodicPass(deps: PeriodicPassDeps): Promise<PeriodicPassResult> {
  const result: PeriodicPassResult = { ran: [], waiting: [], problems: [] };
  if (deps.jobs.length === 0) return result;

  let ages: Ages;
  try {
    ages = await lastRunAges(
      deps.sql,
      deps.jobs.map((job) => job.lastRunKind),
    );
  } catch (error) {
    // Without the deadlines nothing can be decided. Running everything anyway
    // would turn an unreachable database into a radar scan every fifteen
    // seconds; skipping is the direction that costs an hour of latency at most.
    const problem = `Fristen konnten nicht gelesen werden: ${(error as Error).message}`;
    result.problems.push(problem);
    deps.logger.error({ err: error }, problem);
    return result;
  }

  for (const job of deps.jobs) {
    const age = ages.get(job.lastRunKind);
    // No row at all: never run on this installation, so it is due now. A fresh
    // stack should measure its disk on the first pass rather than in an hour.
    if (age !== undefined && age < job.intervalMs) {
      result.waiting.push(job.name);
      continue;
    }

    try {
      const report = await job.run();
      result.ran.push(job.name);
      if (report) deps.logger.info({ job: job.name }, report);
    } catch (error) {
      const problem = `Periodischer Lauf «${job.name}» ist gescheitert: ${(error as Error).message}`;
      result.problems.push(problem);
      deps.logger.error({ err: error, job: job.name }, problem);
    }
  }

  return result;
}

/**
 * The age of the newest row of each kind, in milliseconds, from the database's
 * own clock (decision 2).
 *
 * `DISTINCT ON` with `ORDER BY kind, id DESC` rather than `occurred_at DESC`:
 * two events written in the same millisecond still have a total order by id,
 * which is the reason `EventLog.since` gives for the same choice. Kinds with no
 * row are absent from the map, which is what "never run" reads as above.
 */
async function lastRunAges(sql: Queryable, kinds: readonly EventKind[]): Promise<Ages> {
  const rows = await sql<Array<{ kind: EventKind; age_ms: string }>>`
    SELECT DISTINCT ON (kind)
      kind,
      EXTRACT(EPOCH FROM (now() - occurred_at)) * 1000 AS age_ms
    FROM event_log
    WHERE kind = ANY(${[...kinds] as string[]})
    ORDER BY kind, id DESC
  `;
  const ages: Ages = new Map();
  for (const row of rows) {
    const age = Number(row.age_ms);
    // A row from the future (a clock that moved backwards) reads as age 0,
    // which holds the job back for one interval rather than running it every
    // pass until the clock catches up.
    ages.set(row.kind, Number.isFinite(age) ? Math.max(0, age) : 0);
  }
  return ages;
}
