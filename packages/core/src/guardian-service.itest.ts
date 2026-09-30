/**
 * Integration tests for the budget guardian (§7.2, §7.3).
 *
 * This is the Phase 1 exit gate that says: "simulated usage streams prove, for
 * **both** a 5h and a weekly window, that no new task starts at ≥ 85%, that all
 * running work parks cleanly by 95%, and that parked tasks resume first after a
 * reset — as automated tests."
 *
 * Not one real model call is needed for any of it. That is what the `fake`
 * backend (A37) and the pure `evaluateGuardian` were for.
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoppableRun } from './active-runs.js';
import { EventLog } from './event-log.js';
import { GuardianService } from './guardian-service.js';
import { UsageMeter } from './usage-meter.js';

const url = process.env.TEST_DATABASE_URL;

/**
 * A get_usage payload.
 *
 * Every window is always present, because the real endpoint always reports all
 * of them — and because a window that stops reporting is correctly treated as
 * `unavailable` by the meter. Omitting one here would test that path by
 * accident instead of the threshold under examination.
 */
function usage(windows: { fiveHour?: number; weekly?: number; model?: number }, resetsAt?: string) {
  const at = resetsAt ?? null;
  return {
    rate_limits_available: true,
    rate_limits: {
      limits: [
        { kind: 'session', percent: windows.fiveHour ?? 1, resets_at: at, scope: null },
        { kind: 'weekly_all', percent: windows.weekly ?? 1, resets_at: at, scope: null },
        {
          kind: 'weekly_scoped',
          percent: windows.model ?? 1,
          resets_at: at,
          scope: { model: { display_name: 'Opus' } },
        },
      ],
    },
  };
}

/** A run that records what was done to it, instead of spawning anything. */
function stoppableRun(runId: string) {
  const log: string[] = [];
  const run: StoppableRun = {
    runId,
    interrupt: async (reason) => {
      log.push(`interrupt:${reason}`);
    },
    kill: async () => {
      log.push('kill');
    },
  };
  return { run, log };
}

describe.skipIf(!url)('GuardianService', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let clock = Date.parse('2026-08-01T06:00:00Z');
  let queueState: { paused: boolean; calls: string[] };
  let runs: Array<ReturnType<typeof stoppableRun>>;

  beforeAll(async () => {
    // Its own database: the guardian's state is global by design, so sharing
    // one with another test file would mean sharing a budget.
    database = await createTestDatabase('guardian');
    sql = createSql({ url: database.url, max: 2 });
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
  });

  beforeEach(async () => {
    // Append-only tables cannot be cleaned between tests, and the guardian's
    // state is deliberately global — there is one budget. So each test starts
    // by appending a clean baseline, which is exactly what a genuine window
    // reset looks like from the projection's point of view.
    clock += 6 * 60 * 60_000;
    await sql`
      INSERT INTO guardian_events (state, reason, latches)
      VALUES ('normal', ${sql.json({ kind: 'below_thresholds' })}, ${sql.json([])})
    `;
    queueState = { paused: false, calls: [] };
    runs = [];
  });

  function makeService(graceMs = 20) {
    const meter = new UsageMeter({ sql, now: () => clock });
    return {
      meter,
      service: new GuardianService({
        sql,
        meter,
        eventLog: new EventLog(sql),
        queue: {
          pause: async () => {
            queueState.paused = true;
            queueState.calls.push('pause');
          },
          resume: async () => {
            queueState.paused = false;
            queueState.calls.push('resume');
          },
          get isPaused() {
            return queueState.paused;
          },
        },
        activeRuns: () => runs.map((r) => r.run),
        now: () => clock,
        graceMs,
      }),
    };
  }

  describe('Schwellen — beide Fenster, wie das Gate es verlangt', () => {
    it('bleibt unter 85 Prozent im Normalbetrieb und lässt die Queue laufen', async () => {
      const { meter, service } = makeService();
      await meter.ingestOfficial(usage({ fiveHour: 40, weekly: 61 }));
      const decision = await service.evaluate();
      expect(decision.state).toBe('normal');
      expect(queueState.paused).toBe(false);
    });

    it('startet ab 85 Prozent im 5h-Fenster nichts Neues mehr', async () => {
      const { meter, service } = makeService();
      const active = stoppableRun('11111111-1111-4111-8111-111111111111');
      runs.push(active);

      await meter.ingestOfficial(usage({ fiveHour: 85, weekly: 10 }));
      const decision = await service.evaluate();

      expect(decision.state).toBe('wrap_up');
      expect(queueState.paused).toBe(true);
      // §7.3: interrupt, never kill — a kill here is the mid-edit stop the
      // wrap-up protocol exists to prevent.
      expect(active.log).toEqual(['interrupt:guardian_wrap_up']);
    });

    it('tut dasselbe, wenn das Wochenfenster das engste ist', async () => {
      const { meter, service } = makeService();
      await meter.ingestOfficial(usage({ fiveHour: 3, weekly: 88 }));
      const decision = await service.evaluate();
      expect(decision.state).toBe('wrap_up');
      expect(decision.governingWindow).toBe('seven_day');
    });

    it('greift auch beim Wochenfenster je Modellklasse', async () => {
      const { meter, service } = makeService();
      await meter.ingestOfficial(usage({ fiveHour: 5, weekly: 20, model: 91 }));
      const decision = await service.evaluate();
      expect(decision.state).toBe('wrap_up');
      expect(decision.governingWindow).toBe('seven_day_model');
    });

    /**
     * Die Gnadenfrist ist hier großzügig, und das ist der Punkt.
     *
     * Der Test behauptet zwischen zwei Zeilen etwas **Negatives**: unmittelbar
     * nach `evaluate()` ist unterbrochen, aber noch nicht getötet. Mit 20 ms
     * Frist wurde dieses Fenster über zwei echte Postgres-Runden gemessen —
     * unter Last ist der Timer dann längst gefeuert, und der Test wird rot,
     * ohne dass am Code etwas falsch wäre. A68s Form, und in einem
     * unbeaufsichtigten Lauf kostet so ein Rotlicht eine ganze Iteration.
     *
     * Eine Sekunde Frist ändert an der geprüften Eigenschaft nichts — erst
     * unterbrechen, dann nach Ablauf töten — und gibt ihr eine Spanne, die
     * Datenbank-I/O nicht überschreitet. Der Preis ist gut eine Sekunde
     * Laufzeit; die Alternative wäre, die negative Zusicherung zu streichen,
     * und genau die ist die Hälfte, die A74.1 gefunden hat (ein Timer, der nie
     * abbestellt wurde und frisch gestartete Sitzungen erschlug).
     */
    it('parkt alles sauber bei 95 Prozent und tötet erst nach der Gnadenfrist', async () => {
      const GNADENFRIST_MS = 1_000;
      const { meter, service } = makeService(GNADENFRIST_MS);
      const active = stoppableRun('22222222-2222-4222-8222-222222222222');
      runs.push(active);

      await meter.ingestOfficial(usage({ fiveHour: 96, weekly: 30 }));
      const decision = await service.evaluate();
      expect(decision.state).toBe('hard_stop');
      expect(active.log).toEqual(['interrupt:guardian_hard_stop']);

      await new Promise((resolve) => setTimeout(resolve, GNADENFRIST_MS + 300));
      expect(active.log).toEqual(['interrupt:guardian_hard_stop', 'kill']);

      const [event] = await sql<Array<{ payload: { reason: string } }>>`
        SELECT payload FROM event_log WHERE kind = 'run.interrupted'
        ORDER BY id DESC LIMIT 1
      `;
      // `interrupted` is a re-check state, not a failure: §7.2 requires the
      // worktree to be verified before that task resumes.
      expect(event?.payload.reason).toBe('hard_stop_grace_expired');
    });

    /**
     * The grace belongs to the hard stop that scheduled it, and to nothing else.
     *
     * A26 gives the operator a hard pause, which reaches `hard_stop` directly and
     * unconditionally. Releasing it inside the minute is an ordinary use of a
     * documented control — and until the timer handle was kept, the pending
     * deadline survived the release and killed whatever was running when it
     * fired. Not the sessions it was meant for: those were already parked. The
     * *fresh* ones, each of which would then land in `interrupted` and need a
     * §7.2 Debugger session before it could move again.
     *
     * So the assertion is deliberately about a run that did not exist when the
     * timer was scheduled. Asserting on the parked one would pass either way.
     */
    it('nimmt die Gnadenfrist zurück, wenn die harte Pause vor ihrem Ablauf endet', async () => {
      const { meter, service } = makeService(300);
      const parked = stoppableRun('33333333-3333-4333-8333-333333333333');
      runs.push(parked);
      await meter.ingestOfficial(usage({ fiveHour: 4, weekly: 4 }));

      expect((await service.setPause({ active: true, hard: true })).state).toBe('hard_stop');
      // The hard stop really happened — without this the rest is vacuous.
      expect(parked.log).toEqual(['interrupt:guardian_hard_stop']);

      expect((await service.setPause({ active: false, hard: false })).state).toBe('normal');

      // A session started *after* the release, i.e. one the expired deadline
      // has no claim on whatsoever.
      runs.length = 0;
      const fresh = stoppableRun('44444444-4444-4444-8444-444444444444');
      runs.push(fresh);

      await new Promise((resolve) => setTimeout(resolve, 450));

      expect(fresh.log).toEqual([]);
      const killed = await sql<Array<{ run_id: string }>>`
        SELECT run_id FROM event_log
        WHERE kind = 'run.interrupted' AND payload ->> 'reason' = 'hard_stop_grace_expired'
          AND run_id = ${fresh.run.runId}
      `;
      expect(killed).toHaveLength(0);
    });
  });

  describe('Latch und Reset', () => {
    // get_usage has a "seeded" state, so a cached low reading right after a
    // high one is real. Without the latch it would reopen the gate.
    it('öffnet nicht wieder, nur weil die nächste Probe freundlicher ist', async () => {
      const { meter, service } = makeService();
      await meter.ingestOfficial(
        usage({ fiveHour: 88 }, new Date(clock + 3_600_000).toISOString()),
      );
      expect((await service.evaluate()).state).toBe('wrap_up');

      clock += 60_000;
      await meter.ingestOfficial(
        usage({ fiveHour: 60 }, new Date(clock + 3_600_000).toISOString()),
      );
      const second = await service.evaluate();
      expect(second.state).toBe('wrap_up');
      expect(second.reason.kind).toBe('latched');
      expect(queueState.paused).toBe(true);
    });

    it('nimmt den Betrieb nach einem echten Fensterreset wieder auf', async () => {
      const { meter, service } = makeService();
      const resetsAt = clock + 3_600_000;
      await meter.ingestOfficial(usage({ fiveHour: 88 }, new Date(resetsAt).toISOString()));
      expect((await service.evaluate()).state).toBe('wrap_up');

      clock = resetsAt + 60_000;
      await meter.ingestOfficial(
        usage({ fiveHour: 4 }, new Date(clock + 18_000_000).toISOString()),
      );
      const resumed = await service.evaluate();

      expect(resumed.state).toBe('normal');
      expect(queueState.calls).toContain('resume');
    });
  });

  describe('Manuelle Pause (A26)', () => {
    it('bildet die weiche Pause auf Wrap-up-Semantik ab', async () => {
      const { meter, service } = makeService();
      await meter.ingestOfficial(usage({ fiveHour: 1 }));
      const decision = await service.setPause({ active: true, hard: false });
      expect(decision.state).toBe('wrap_up');
      expect(queueState.paused).toBe(true);
    });

    it('bildet die harte Pause auf Hard-Stop-Semantik ab und kehrt zurück', async () => {
      const { meter, service } = makeService();
      await meter.ingestOfficial(usage({ fiveHour: 1 }));
      expect((await service.setPause({ active: true, hard: true })).state).toBe('hard_stop');
      const back = await service.setPause({ active: false, hard: false });
      expect(back.state).toBe('normal');
      expect(queueState.paused).toBe(false);
    });
  });

  describe('Zustand als Projektion', () => {
    it('schreibt jeden Übergang als Zeile und meldet ihn als Ereignis', async () => {
      const { meter, service } = makeService();
      await meter.ingestOfficial(usage({ fiveHour: 90 }));
      await service.evaluate();

      const [row] = await sql<Array<{ state: string; governing_window: string }>>`
        SELECT state, governing_window FROM guardian_events ORDER BY id DESC LIMIT 1
      `;
      expect(row?.state).toBe('wrap_up');
      expect(row?.governing_window).toBe('five_hour');

      const [event] = await sql<Array<{ payload: { text: string } }>>`
        SELECT payload FROM event_log WHERE kind = 'guardian.state_changed'
        ORDER BY id DESC LIMIT 1
      `;
      // §2: user-facing text is German.
      expect(event?.payload.text).toContain('Aufräummodus');
    });

    it('schreibt keine Zeile, wenn sich nichts geändert hat', async () => {
      const { meter, service } = makeService();
      await meter.ingestOfficial(usage({ fiveHour: 12 }));
      await service.evaluate();
      const [before] = await sql<
        Array<{ count: string }>
      >`SELECT count(*)::text FROM guardian_events`;

      clock += 1000;
      await meter.ingestOfficial(usage({ fiveHour: 13 }));
      await service.evaluate();
      const [after] = await sql<
        Array<{ count: string }>
      >`SELECT count(*)::text FROM guardian_events`;

      // An idle system must not write a row every minute forever.
      expect(after?.count).toBe(before?.count);
    });

    it('lässt sich vollständig aus der Historie neu berechnen', async () => {
      const { meter, service } = makeService();
      await meter.ingestOfficial(usage({ fiveHour: 91 }));
      const live = await service.evaluate();
      const replayed = await service.replay();
      // Why it stopped on a Thursday has to be reconstructible.
      expect(replayed?.state).toBe(live.state);
    });
  });

  it('schließt das Tor, wenn das Budget gar nicht sichtbar ist', async () => {
    const { meter, service } = makeService();
    await meter.ingestOfficial({ rate_limits_available: false });
    const decision = await service.evaluate();
    expect(decision.state).toBe('wrap_up');
    expect(decision.reason.kind).toBe('no_data');
    expect(queueState.paused).toBe(true);
  });
});
