/**
 * Job queue (§4, §22 Phase 1 step 3).
 *
 * §4 says "pg-boss carries all executable work", and what that means in this
 * build was settled by A57.1: the **dev chain is dispatched in-process** and
 * deliberately not through here, because the three things a queue buys — a
 * retry policy, a dead-letter queue, an idempotent key — are three things a
 * dev-chain pass must not have (§9 owns the retry, and a queue-level one would
 * burn a model session and destroy the first observation). What is left for the
 * queue is the *periodic and deferrable* work of Phases 6 and 8: the radar
 * scans, the transcript-leak scan, the weekly report.
 *
 * Stated plainly because the sentence above used to claim more than the tree
 * held: **no worker is registered today.** The queue is wired as the guardian's
 * work gate (`work-gate.ts`), so §7.2's pause reaches a real component with a
 * real schema instead of an in-memory boolean, and the first `work()` call
 * arrives with Phase 6. Until then `pause()` unregisters an empty set and the
 * layer that actually enforces "no new tasks start" is the scheduler's guardian
 * check at the head of every tick. §18's own passes — the backup report, the
 * disk watch, §15's push — are deliberately *not* on the queue: they are Ops
 * signals that have to keep working while the guardian has stopped everything
 * else, which is exactly when they matter most (A86.3's reasoning, one channel
 * over).
 *
 * Three properties matter more than the wrapper itself:
 *
 *  * **A closed job taxonomy.** Queue names are typed, so a job nobody
 *    registered a worker for is a compile error rather than a message that
 *    quietly ages in a table.
 *  * **Retry policies that distinguish kinds of failure.** A25 separates
 *    findings from infra failures; the queue mirrors that. A gate run that
 *    failed because the registry was unreachable should be retried, a gate run
 *    that failed because a test failed must not be.
 *  * **Idempotent by construction.** Every job carries a stable key derived
 *    from what it is about — `run_id` for agent runs — and pg-boss's singleton
 *    key refuses a duplicate. An orchestrator that crashes between "job sent"
 *    and "job recorded" must not produce two model sessions when it comes back.
 */
import PgBoss from 'pg-boss';

/** Every kind of executable work in the system (§4). */
export const JOB_NAMES = [
  'agent_run',
  'gate_run',
  'merge',
  'deploy',
  'scan',
  'report',
  'usage_sample',
] as const;
export type JobName = (typeof JOB_NAMES)[number];

/** Payload shapes, deliberately narrow — a job carries ids, not objects. */
export interface JobPayloads {
  agent_run: { runId: string; taskId: string | null; role: string };
  gate_run: { gateRunId: string; projectId: string; taskId: string | null };
  merge: { projectId: string; taskId: string };
  deploy: { deployId: string; projectId: string };
  scan: { kind: 'radar' | 'transcript_leak' | 'disk'; target?: string };
  report: { kind: 'weekly'; forWeek: string };
  usage_sample: Record<string, never>;
}

export interface RetryPolicy {
  retryLimit: number;
  retryDelaySeconds: number;
  retryBackoff: boolean;
  expireInSeconds: number;
}

/**
 * Per-job retry policy.
 *
 * `agent_run` is deliberately **not** retried by the queue. §9 owns the red
 * path — first failure requeues with lower priority and an attached learnings
 * note, second failure escalates with a diagnosis. A queue-level retry would
 * silently burn a second model session and rob that policy of its first
 * observation, which is the one carrying the information.
 */
export const RETRY_POLICIES: Record<JobName, RetryPolicy> = {
  agent_run: { retryLimit: 0, retryDelaySeconds: 0, retryBackoff: false, expireInSeconds: 3600 },
  // A25: infra failures retry three times with backoff and never count as red.
  gate_run: { retryLimit: 3, retryDelaySeconds: 30, retryBackoff: true, expireInSeconds: 1800 },
  merge: { retryLimit: 2, retryDelaySeconds: 15, retryBackoff: true, expireInSeconds: 1800 },
  // A failed deploy must reach the rollback path, not be retried into it twice.
  deploy: { retryLimit: 0, retryDelaySeconds: 0, retryBackoff: false, expireInSeconds: 3600 },
  scan: { retryLimit: 2, retryDelaySeconds: 60, retryBackoff: true, expireInSeconds: 3600 },
  report: { retryLimit: 3, retryDelaySeconds: 300, retryBackoff: true, expireInSeconds: 3600 },
  usage_sample: { retryLimit: 1, retryDelaySeconds: 5, retryBackoff: false, expireInSeconds: 120 },
};

/**
 * Which job kinds carry a stable identity.
 *
 * These queues get pg-boss's `stately` policy, which permits one job per
 * singleton key per state. A `singletonKey` on a `standard` queue is only a
 * label — it does not deduplicate, and assuming otherwise would leave the
 * duplicate-send window wide open while looking closed.
 */
export const HAS_IDENTITY: Record<JobName, boolean> = {
  agent_run: true,
  gate_run: true,
  merge: true,
  deploy: true,
  report: true,
  // Periodic by nature: giving them an identity would silently drop the second
  // nightly radar run.
  scan: false,
  usage_sample: false,
};

/**
 * Stable identity for a job, so a duplicate send is refused rather than run.
 *
 * Returns null for jobs that are legitimately repeatable (a periodic scan).
 */
export function singletonKey<N extends JobName>(name: N, payload: JobPayloads[N]): string | null {
  switch (name) {
    case 'agent_run':
      return `agent_run:${(payload as JobPayloads['agent_run']).runId}`;
    case 'gate_run':
      return `gate_run:${(payload as JobPayloads['gate_run']).gateRunId}`;
    case 'merge': {
      const merge = payload as JobPayloads['merge'];
      return `merge:${merge.projectId}:${merge.taskId}`;
    }
    case 'deploy':
      return `deploy:${(payload as JobPayloads['deploy']).deployId}`;
    case 'report': {
      const report = payload as JobPayloads['report'];
      return `report:${report.kind}:${report.forWeek}`;
    }
    default:
      return null;
  }
}

export interface QueueDeps {
  connectionString: string;
  /** Bounded by the guardian and the plan profile (A7); 0 means accept nothing. */
  concurrency?: number;
  onError?: (error: unknown, context: { job?: string }) => void;
  /** Override the pause settle (see `pause`). Only tests should need this. */
  pauseSettleMs?: number;
}

/** How long a worker polls between fetches. pg-boss's floor is 500 ms. */
export const POLLING_INTERVAL_SECONDS = 2;

/**
 * How long `pause()` waits for pg-boss's workers to actually stop.
 *
 * One polling interval plus a margin for a fetch already in flight. See
 * `pause()` for why this is a wait rather than a condition.
 */
export const PAUSE_SETTLE_MS = POLLING_INTERVAL_SECONDS * 1000 + 1_000;

export type JobHandler<N extends JobName> = (
  payload: JobPayloads[N],
  meta: { jobId: string; attempt: number },
) => Promise<void>;

/** Where jobs go when their retries are exhausted. Nothing is ever discarded. */
export const DEAD_LETTER_QUEUE = 'dead_letter';

export class JobQueue {
  private boss: PgBoss | null = null;
  /** Kept so a paused queue can be resumed with the same workers (§7.2). */
  // biome-ignore lint/suspicious/noExplicitAny: handlers are heterogeneous by job name
  private readonly handlers = new Map<JobName, JobHandler<any>>();
  private paused = false;

  constructor(private readonly deps: QueueDeps) {}

  async start(): Promise<void> {
    this.boss = new PgBoss({
      connectionString: this.deps.connectionString,
      // pg-boss keeps its own bookkeeping out of `public`, so the append-only
      // guards and the migration lint never have to reason about its tables.
      schema: 'pgboss',
      max: 4,
    });
    this.boss.on('error', (error) => this.deps.onError?.(error, {}));
    await this.boss.start();

    // Created first, so every other queue can point at it.
    await this.boss.createQueue(DEAD_LETTER_QUEUE);
    for (const name of JOB_NAMES) {
      // A job whose retries are exhausted lands here rather than vanishing.
      // §1 principle 4 wants every failure traceable; a job that simply stopped
      // existing is the opposite of that.
      await this.boss.createQueue(name, {
        deadLetter: DEAD_LETTER_QUEUE,
        policy: HAS_IDENTITY[name] ? 'stately' : 'standard',
      });
    }
  }

  async stop(): Promise<void> {
    await this.boss?.stop({ graceful: true, close: true });
    this.boss = null;
  }

  private require(): PgBoss {
    if (!this.boss) throw new Error('JobQueue ist nicht gestartet');
    return this.boss;
  }

  /** Enqueue work. Returns null when a job with the same identity already exists. */
  async send<N extends JobName>(
    name: N,
    payload: JobPayloads[N],
    options: { priority?: number; startAfterSeconds?: number } = {},
  ): Promise<string | null> {
    const policy = RETRY_POLICIES[name];
    const key = singletonKey(name, payload);
    return this.require().send(name, payload, {
      retryLimit: policy.retryLimit,
      retryDelay: policy.retryDelaySeconds,
      retryBackoff: policy.retryBackoff,
      expireInSeconds: policy.expireInSeconds,
      ...(key ? { singletonKey: key } : {}),
      ...(options.priority !== undefined ? { priority: options.priority } : {}),
      ...(options.startAfterSeconds !== undefined ? { startAfter: options.startAfterSeconds } : {}),
    });
  }

  /**
   * Register a worker.
   *
   * A handler that throws hands the job back to pg-boss, which applies the
   * policy above. That is the only place retry behaviour is decided — handlers
   * never implement their own, or the policy becomes a suggestion.
   */
  async work<N extends JobName>(name: N, handler: JobHandler<N>): Promise<string> {
    this.handlers.set(name, handler);
    return this.register(name, handler);
  }

  private async register<N extends JobName>(name: N, handler: JobHandler<N>): Promise<string> {
    return this.require().work<JobPayloads[N]>(
      name,
      { batchSize: 1, pollingIntervalSeconds: POLLING_INTERVAL_SECONDS },
      async ([job]) => {
        if (!job) return;
        try {
          await handler(job.data, { jobId: job.id, attempt: 1 });
        } catch (error) {
          this.deps.onError?.(error, { job: name });
          throw error;
        }
      },
    );
  }

  /**
   * Stop accepting new work without tearing the queue down (§7.2 wrap-up).
   *
   * pg-boss has no queue-level pause, so this unregisters the workers: jobs
   * keep arriving and keep waiting, nothing new is picked up, and work already
   * in flight finishes — which is exactly the wrap-up semantics §7.2 asks for.
   *
   * **`offWork` returns before its workers have stopped**, and that is the
   * whole reason for the wait below. It sets a flag on each worker and hands
   * the actual teardown to a detached loop that polls once a second
   * (pg-boss 11.1.2, `manager.js`); a worker sitting in `await fetch()` at that
   * moment completes that fetch and runs whatever it found. So `pause()`
   * returning was not the same as "nothing more will be picked up", and the gap
   * widened exactly when the host was busy — which is when the guardian is most
   * likely to be pausing in the first place.
   *
   * That much is pg-boss's documented behaviour, read out of its source. What
   * is inference rather than proof: it is also the leading explanation for an
   * integration test that passed alone and failed about one run in three inside
   * the full suite, where eight test files contend for one Postgres. The leak
   * could not be reproduced synthetically — blocking our own event loop does
   * not recreate it, because the delay that matters is on the database side —
   * so the flake is not *proven* to be this. The wait is warranted either way:
   * `pause()` returning while a worker can still fetch is wrong on its own
   * terms, and the production consequence is quieter than a red test — one more
   * agent session starting after the guardian said stop, at 85% of a window.
   *
   * The wait is time-based because pg-boss exposes no worker state to wait on.
   * One polling interval plus a margin for the in-flight fetch is enough for
   * the loop to reach its `while (!this.stopping)` check and exit. Erring long
   * is free here: a wrap-up is not latency-critical, and the alternative —
   * returning early — is the defect.
   *
   * **With no worker registered there is nothing to settle**, and the wait is
   * skipped. Not an optimisation for its own sake: until Phase 6 registers the
   * first `work()` this is every call, and three seconds of sleep inside
   * `GuardianService.applyTransition` — which the scheduler awaits at the head
   * of a tick — would be three seconds spent waiting for fetches that provably
   * cannot be in flight, because nothing has ever fetched. The property the
   * wait defends is stated in terms of workers; with none, it holds vacuously.
   */
  async pause(): Promise<void> {
    if (this.paused) return;
    // Asked before anything is recorded: `paused` must not be a state reachable
    // on a queue that was never started, or a failed `start()` would leave the
    // guardian believing it had closed a gate that does not exist.
    this.require();
    // Set first, so anything consulting `isPaused` during the settle already
    // sees the decision that has been taken.
    this.paused = true;
    if (this.handlers.size === 0) return;
    for (const name of this.handlers.keys()) await this.require().offWork(name);
    await new Promise((resolve) => setTimeout(resolve, this.deps.pauseSettleMs ?? PAUSE_SETTLE_MS));
  }

  async resume(): Promise<void> {
    if (!this.paused) return;
    for (const [name, handler] of this.handlers) await this.register(name, handler);
    this.paused = false;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** Jobs waiting to be picked up — the queue depth the dashboard shows (§18). */
  async depth(name: JobName): Promise<number> {
    const stats = await this.require().getQueueStats(name);
    return stats.queuedCount;
  }

  async deadLetterDepth(): Promise<number> {
    const stats = await this.require().getQueueStats(DEAD_LETTER_QUEUE);
    return stats.queuedCount;
  }
}
