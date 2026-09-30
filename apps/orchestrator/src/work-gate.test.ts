/**
 * The adapter between §7.2's guardian and §4's queue.
 *
 * What is under examination is one property and its consequences: **the
 * guardian's transition must survive a queue that is not there.**
 * `GuardianService.applyTransition` awaits `queue.pause()` with no guard of its
 * own, inside `evaluate()`, inside `Scheduler.tick()` — so handing it a raw
 * `JobQueue` would mean that a failed `start()` stops the studio ever reaching
 * `wrap_up`, and the symptom would be one "Tick fehlgeschlagen" line every
 * fifteen seconds with nothing naming the cause.
 *
 * No Postgres: the queue is faked here on purpose. `JobQueue` itself is proved
 * against a real database in `packages/core/src/queue.itest.ts`, and what this
 * file asks is what the adapter does when that queue misbehaves — which a real
 * one cannot be made to do on demand.
 */
import { describe, expect, it, vi } from 'vitest';
import { type PausableQueue, WorkGate } from './work-gate.js';

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A queue that can be told to fail on any of its four calls. */
function fakeQueue(fail: Partial<Record<keyof PausableQueue, string>> = {}) {
  const calls: string[] = [];
  let paused = false;
  const at = (name: 'start' | 'stop' | 'pause' | 'resume') => async () => {
    calls.push(name);
    const problem = fail[name];
    if (problem) throw new Error(problem);
    if (name === 'pause') paused = true;
    if (name === 'resume') paused = false;
  };
  return {
    calls,
    queue: {
      start: at('start'),
      stop: at('stop'),
      pause: at('pause'),
      resume: at('resume'),
      get isPaused() {
        return paused;
      },
    } satisfies PausableQueue,
  };
}

function recordingNotifier() {
  const sent: Array<{ title: string }> = [];
  return {
    sent,
    send: vi.fn(async (message: { title: string }) => {
      sent.push(message);
      return { ok: true };
    }),
  };
}

describe('WorkGate (§7.2, §4)', () => {
  it('reicht die Entscheidung an die Warteschlange durch', async () => {
    const { queue, calls } = fakeQueue();
    const gate = new WorkGate({ queue, logger: silentLogger() });

    expect((await gate.start()).started).toBe(true);
    await gate.pause();
    expect(gate.isPaused).toBe(true);
    await gate.resume();
    expect(gate.isPaused).toBe(false);
    expect(calls).toEqual(['start', 'pause', 'resume']);
  });

  it('startet nicht und nimmt den Daemon trotzdem nicht mit', async () => {
    const { queue } = fakeQueue({ start: 'Verbindung abgelehnt' });
    const logger = silentLogger();
    const gate = new WorkGate({ queue, logger });

    const result = await gate.start();

    expect(result.started).toBe(false);
    expect(result.problem).toContain('Verbindung abgelehnt');
    expect(logger.error).toHaveBeenCalled();
  });

  /**
   * The case this class exists for.
   *
   * With `JobQueue` handed to the guardian directly, `pause()` on an unstarted
   * queue raises `JobQueue ist nicht gestartet` — inside `applyTransition`,
   * with no catch anywhere between there and `Scheduler.tick()`. §7.2 would
   * then never record a `wrap_up` at all, on a studio at 85% of its budget.
   */
  it('meldet §7.2s Pause auch dann, wenn die Warteschlange nie hochkam', async () => {
    const { queue, calls } = fakeQueue({ start: 'Verbindung abgelehnt' });
    const gate = new WorkGate({ queue, logger: silentLogger() });
    await gate.start();

    await expect(gate.pause()).resolves.toBeUndefined();

    // The decision stands and is readable; the queue was not even asked,
    // because there is nothing there to ask.
    expect(gate.isPaused).toBe(true);
    expect(calls).toEqual(['start']);
  });

  it('hält die Entscheidung fest, wenn die Warteschlange die Pause verweigert', async () => {
    const { queue } = fakeQueue({ pause: 'pg-boss antwortet nicht' });
    const logger = silentLogger();
    const gate = new WorkGate({ queue, logger });
    await gate.start();

    await expect(gate.pause()).resolves.toBeUndefined();

    // Decision 2: `isPaused` is what the guardian decided, never what pg-boss
    // managed. A gate that reported "not paused" here would be the dangerous
    // direction — the scheduler would read it as an open gate.
    expect(gate.isPaused).toBe(true);
    expect(logger.error).toHaveBeenCalled();
  });

  it('meldet eine anhaltende Störung genau einmal, nicht bei jedem Übergang', async () => {
    const { queue } = fakeQueue({ pause: 'pg-boss antwortet nicht', resume: 'immer noch nicht' });
    const notifier = recordingNotifier();
    const gate = new WorkGate({ queue, logger: silentLogger(), notifier });
    await gate.start();

    // Three guardian transitions against a queue that is down for all of them
    // — normal → wrap_up → normal → wrap_up is an ordinary morning at 85%.
    await gate.pause();
    await gate.resume();
    await gate.pause();

    // A67.6 and A86.5: a push per transition for as long as Postgres is
    // unhappy is a channel that gets muted, and then the next real alert is
    // invisible.
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.title).toContain('Job-Warteschlange');
  });

  /**
   * The other half, found by the first version of the test above rather than
   * foreseen: a call that *succeeds* in between is the outage ending.
   *
   * So a later failure is a new outage and is announced again. Asserted
   * explicitly because the alternative — one alert per process lifetime — would
   * mean a queue that broke, recovered and broke again in the same week said so
   * once, which is the silence this whole rule is trading against.
   */
  it('meldet eine zweite Störung nach einer zwischenzeitlichen Erholung erneut', async () => {
    const failing = { pause: 'pg-boss antwortet nicht' } as Record<string, string>;
    const calls: string[] = [];
    let paused = false;
    const queue: PausableQueue = {
      start: async () => undefined,
      stop: async () => undefined,
      pause: async () => {
        calls.push('pause');
        if (failing.pause) throw new Error(failing.pause);
        paused = true;
      },
      resume: async () => {
        calls.push('resume');
        paused = false;
      },
      get isPaused() {
        return paused;
      },
    };
    const notifier = recordingNotifier();
    const logger = silentLogger();
    const gate = new WorkGate({ queue, logger, notifier });
    await gate.start();

    await gate.pause();
    // The queue answers again: `resume` succeeds and clears the state.
    delete failing.pause;
    await gate.resume();
    expect(logger.info).toHaveBeenCalledWith({}, 'Job-Warteschlange nimmt wieder Befehle an');

    failing.pause = 'und wieder weg';
    await gate.pause();

    expect(notifier.sent).toHaveLength(2);
  });

  it('merkt eine abgewiesene Meldung nicht als zugestellt vor', async () => {
    const { queue } = fakeQueue({ pause: 'pg-boss antwortet nicht' });
    // ntfy is down as well. `escalation-push.ts` decision 2: an alert ntfy
    // refused is an alert nobody got, so the next failure must try again.
    const send = vi.fn(async () => ({ ok: false }));
    const gate = new WorkGate({ queue, logger: silentLogger(), notifier: { send } });
    await gate.start();

    await gate.pause();
    await gate.resume();
    await gate.pause();

    expect(send).toHaveBeenCalledTimes(2);
  });

  it('stoppt nur, was gestartet wurde, und schluckt dabei', async () => {
    const { queue, calls } = fakeQueue({ start: 'Verbindung abgelehnt' });
    const gate = new WorkGate({ queue, logger: silentLogger() });
    await gate.start();

    // Nothing to stop. The shutdown path runs this inside a `Promise.race`
    // against a 20 s deadline, where a rejection would skip §7.3's park.
    await expect(gate.stop()).resolves.toBeUndefined();
    expect(calls).toEqual(['start']);
  });

  it('nimmt den Herunterfahr-Pfad nicht mit, wenn der Stopp scheitert', async () => {
    const { queue } = fakeQueue({ stop: 'pg-boss hängt' });
    const logger = silentLogger();
    const gate = new WorkGate({ queue, logger });
    await gate.start();

    await expect(gate.stop()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalled();
  });
});
