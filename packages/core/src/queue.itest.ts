/**
 * Integration tests for the job queue against a real Postgres.
 *
 * The properties under test are the ones that only exist end to end: that a
 * duplicate send is genuinely refused by the database rather than by our own
 * bookkeeping, and that pausing actually stops work being picked up — which is
 * what §7.2's wrap-up depends on.
 *
 * Its own database, like every other integration file: pg-boss keeps polling
 * workers alive for the length of the run, and sharing a database with files
 * that create, migrate and drop schemas around it makes every timing assertion
 * here a statement about the rest of the suite.
 */
import { createTestDatabase, type TestDatabase } from '@vorschicht/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JobQueue, POLLING_INTERVAL_SECONDS } from './queue.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('JobQueue', () => {
  let queue: JobQueue;
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('queue');
    queue = new JobQueue({ connectionString: database.url });
    await queue.start();
  }, 60_000);

  afterAll(async () => {
    await queue?.stop();
    await database?.drop();
  });

  it('nimmt einen Job an und liefert ihn an den Worker aus', async () => {
    const seen: string[] = [];
    await queue.work('scan', async (payload) => {
      seen.push(payload.kind);
    });

    await queue.send('scan', { kind: 'radar' });

    const deadline = Date.now() + 15_000;
    while (seen.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(seen).toEqual(['radar']);
  }, 30_000);

  // The crash window: orchestrator dies between "job sent" and "job recorded",
  // restarts, and sends again. Two model sessions for one run would be a real
  // budget loss and a real consistency problem.
  it('weist einen zweiten Job mit derselben Identität ab', async () => {
    const payload = { runId: 'crash-window-run', taskId: null, role: 'coder' };
    const first = await queue.send('agent_run', payload);
    const second = await queue.send('agent_run', payload);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('lässt wiederholbare Jobs mehrfach zu', async () => {
    const first = await queue.send('usage_sample', {});
    const second = await queue.send('usage_sample', {});
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first).not.toBe(second);
  });

  // §7.2 wrap-up: nothing new starts, what is queued stays queued, and the
  // work resumes untouched afterwards.
  //
  // This one failed about one run in three inside the full suite and never on
  // its own, which is what pointed at `pause()` returning before pg-boss's
  // workers had actually stopped — a busy host widens exactly that gap. The
  // wait is now inside `pause()`, so a job sent after it returns cannot be
  // picked up, whatever the machine is doing.
  it('hält im Pausenzustand Jobs zurück und arbeitet sie danach ab', async () => {
    const seen: string[] = [];
    await queue.work('merge', async (payload) => {
      seen.push(payload.taskId);
    });
    await queue.pause();
    expect(queue.isPaused).toBe(true);

    await queue.send('merge', { projectId: 'p1', taskId: 'waehrend-pause' });
    // Two polling intervals: long enough that a worker which had not stopped
    // would certainly have fetched.
    await new Promise((resolve) => setTimeout(resolve, POLLING_INTERVAL_SECONDS * 2000));
    expect(seen).toEqual([]);
    expect(await queue.depth('merge')).toBeGreaterThan(0);

    await queue.resume();
    const deadline = Date.now() + 15_000;
    while (seen.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(seen).toEqual(['waehrend-pause']);
  }, 40_000);

  it('kennt die Tiefe der Dead-Letter-Queue', async () => {
    expect(await queue.deadLetterDepth()).toBeGreaterThanOrEqual(0);
  });

  /**
   * The state the studio is actually in today, and the reason it is asserted.
   *
   * No worker is registered until Phase 6 (A57.1: the dev chain is dispatched
   * in-process), and the guardian now reaches this class on every transition to
   * `wrap_up`. The settle exists to wait for fetches already in flight; with no
   * worker there has never been a fetch, so waiting three seconds inside
   * `GuardianService.applyTransition` — which `Scheduler.tick()` awaits — would
   * be three seconds spent on a guarantee that holds vacuously.
   *
   * Its own queue: `beforeAll` registers no worker, but the case above does,
   * and this must be a statement about a queue that never had one.
   */
  it('wartet nicht auf Worker, die es nie gab', async () => {
    const bare = await createTestDatabase('queue_ohne_worker');
    const idle = new JobQueue({ connectionString: bare.url });
    try {
      await idle.start();

      const started = Date.now();
      await idle.pause();

      expect(idle.isPaused).toBe(true);
      // Well under one polling interval, let alone the full settle.
      expect(Date.now() - started).toBeLessThan(500);
    } finally {
      await idle.stop();
      await bare.drop();
    }
  }, 60_000);

  /**
   * A queue that was never started must not report itself as closed.
   *
   * The daemon's `WorkGate` catches this and records §7.2's decision anyway
   * (`work-gate.ts` decision 1), but the refusal has to come from here: a
   * `pause()` that quietly succeeded on a queue that does not exist would make
   * "the gate is closed" and "there is no gate" the same answer.
   */
  it('verweigert die Pause, wenn sie nie gestartet wurde', async () => {
    const never = new JobQueue({ connectionString: 'postgres://localhost/nirgends' });
    await expect(never.pause()).rejects.toThrow(/nicht gestartet/);
    expect(never.isPaused).toBe(false);
  });
});
