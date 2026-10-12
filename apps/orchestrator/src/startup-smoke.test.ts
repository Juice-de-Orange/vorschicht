/**
 * §6.1's startup probe, and the deadlock it exists to break.
 *
 * The property that matters is not "a session ran". It is that the three
 * outcomes are told apart: the probe failed, the probe ran but the budget could
 * not be read, the probe ran and the meter is seeded. They need different
 * responses and from outside they all look like a studio doing nothing.
 */

import { classifyRun } from '@vorschicht/core';
import type { UsageSample } from '@vorschicht/shared';
import { describe, expect, it, vi } from 'vitest';
import { isAuthIncident, selfCheckCycle } from './incident-cycle.js';
import {
  runStartupSmoke,
  SMOKE_RETRY_MS,
  SmokeGate,
  type SmokeRunner,
  smokeAndReport,
} from './startup-smoke.js';

type RunFn = SmokeRunner['run'];
type Outcome = Awaited<ReturnType<RunFn>>;

const summary = { status: 'done' as const, summary: 'Läuft.', artifacts: [], followups: [] };

function outcome(over: Partial<Outcome> = {}): Outcome {
  return {
    status: 'ok',
    run: { runId: 'r-1' },
    result: summary,
    ...over,
  } as Outcome;
}

function sample(): UsageSample {
  return { window: 'five_hour', usedPercent: 12, source: 'official', anomaly: null } as UsageSample;
}

/**
 * What the meter stores when the budget cannot be read.
 *
 * Not an absence — `projectSamples` never returns an empty list, exactly so
 * that "nothing to report" and "cannot see" are distinguishable. Which means a
 * check written as `samples.length > 0` answers "budget read" in the one case
 * it exists to catch, and this fixture is what pins that down.
 */
function blindSample(): UsageSample {
  return {
    window: 'five_hour',
    usedPercent: 0,
    source: 'estimated',
    anomaly: { kind: 'unavailable' },
  } as UsageSample;
}

/**
 * What the runner returns for a session the vendor refused to authenticate.
 *
 * The sentence comes from `classifyRun` and is not written out here, for the
 * reason `incident-cycle.test.ts` gives: `isAuthIncident` is a regular
 * expression over German prose, and a paraphrase would keep matching after the
 * real wording had stopped.
 */
function authOutcome(): Outcome {
  const signals = { termination: 'auth_incident' } as Parameters<typeof classifyRun>[0];
  const verdict = classifyRun(signals);
  return outcome({ status: verdict.status, problem: verdict.problem } as Partial<Outcome>);
}

/** A notifier that records what would have been pushed. */
function notifier() {
  const sent: Array<{ topic: string; title: string }> = [];
  return {
    sent,
    send: async (message: { topic: string; title: string }) => {
      sent.push({ topic: message.topic, title: message.title });
      return { ok: true } as never;
    },
  };
}

describe('Startprobe (§6.1)', () => {
  it('meldet Erfolg, wenn die Sitzung lief und ein Budgetwert vorliegt', async () => {
    const result = await runStartupSmoke({
      runner: { run: async () => outcome() },
      cwd: '/tmp/smoke',
      meter: { currentSamples: async () => [sample()] },
    });

    expect(result.ok).toBe(true);
    expect(result.sampled).toBe(true);
    expect(result.problem).toBeNull();
  });

  it('zählt den Blind-Platzhalter des Zählers nicht als gelesenes Budget', async () => {
    const result = await runStartupSmoke({
      runner: { run: async () => outcome() },
      cwd: '/tmp/smoke',
      meter: { currentSamples: async () => [blindSample()] },
    });
    expect(result.ok).toBe(true);
    expect(result.sampled).toBe(false);
  });

  it('trennt „Sitzung lief" von „Budget gelesen"', async () => {
    // The case the whole module exists for. A healthy session that produces no
    // sample leaves `evaluateGuardian` fail-closed on `no_data`, and the only
    // outward symptom is a studio that never starts anything — which is
    // indistinguishable from an empty queue unless somebody says so.
    const result = await runStartupSmoke({
      runner: { run: async () => outcome() },
      cwd: '/tmp/smoke',
      meter: { currentSamples: async () => [] },
    });

    expect(result.ok).toBe(true);
    expect(result.sampled).toBe(false);
  });

  it('läuft mit dem billigsten Profil, ohne Aufgabe und ohne Werkzeuge', async () => {
    const run = vi.fn(async (_request: Parameters<RunFn>[0]) => outcome());
    await runStartupSmoke({ runner: { run: run as RunFn }, cwd: '/tmp/smoke' });

    const request = run.mock.calls[0]?.[0];
    expect(request?.profile.id).toBe('smoke');
    expect(request?.profile.tier).toBe('economy');
    expect(request?.profile.allowedTools).toEqual([]);
    // No task means no MCP (A56.5) and no way to touch anything: this session is
    // a liveness probe, and every capability it were given is one more thing
    // that can fail in a check whose value is saying nothing is wrong.
    expect(request?.taskId).toBeNull();
    expect(request?.containment.writeRoot).toBeNull();
    expect(request?.profile.caps.maxTurns).toBe(1);
  });

  it('macht aus einem gescheiterten Lauf keinen Absturz', async () => {
    const result = await runStartupSmoke({
      runner: { run: async () => outcome({ status: 'infra', problem: 'CLI nicht gefunden' }) },
      cwd: '/tmp/smoke',
    });
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/CLI nicht gefunden/);
  });

  it('trennt den Anmeldefehler von jedem anderen Scheitern der Probe', async () => {
    const auth = await runStartupSmoke({
      runner: { run: async () => authOutcome() },
      cwd: '/tmp/smoke',
    });
    expect(auth.ok).toBe(false);
    expect(auth.authIncident).toBe(true);

    const other = await runStartupSmoke({
      runner: { run: async () => outcome({ status: 'infra', problem: 'CLI nicht gefunden' }) },
      cwd: '/tmp/smoke',
    });
    expect(other.authIncident).toBe(false);
  });

  it('macht auch aus einer geworfenen Ausnahme keinen Absturz', async () => {
    // A probe that throws would take down the daemon whose health it reports —
    // the check becoming the outage.
    const result = await runStartupSmoke({
      runner: {
        run: async () => {
          throw new Error('kein Platz auf dem Gerät');
        },
      },
      cwd: '/tmp/smoke',
    });
    expect(result.ok).toBe(false);
    expect(result.problem).toMatch(/kein Platz/);
  });

  describe('Meldungen', () => {
    it('überlässt auch den Alarm zu jedem anderen Scheitern der Selbstprüfung (#26)', async () => {
      // The failed probe is a failed self-check now, and `selfCheckCycle`
      // alerts for it — with the event recording whether ntfy took it. A second
      // push from here would be the same failure announced twice.
      const push = notifier();
      const result = await smokeAndReport({
        runner: { run: async () => outcome({ status: 'infra', problem: 'kaputt' }) },
        cwd: '/tmp/smoke',
        notifier: push,
      });
      expect(result.ok).toBe(false);
      expect(push.sent).toEqual([]);
    });

    it('überlässt den Alarm zum Anmeldefehler dem Auth-Vorfall, statt doppelt zu melden', async () => {
      const push = notifier();
      const result = await smokeAndReport({
        runner: { run: async () => authOutcome() },
        cwd: '/tmp/smoke',
        notifier: push,
      });
      expect(result.authIncident).toBe(true);
      expect(push.sent).toEqual([]);
    });

    it('meldet ein nicht lesbares Budget als Information, nicht als Alarm', async () => {
      const push = notifier();
      await smokeAndReport({
        runner: { run: async () => outcome() },
        cwd: '/tmp/smoke',
        meter: { currentSamples: async () => [] },
        notifier: push,
      });
      expect(push.sent).toEqual([{ topic: 'info', title: 'Vorschicht: Budget nur geschätzt' }]);
    });

    it('schweigt, wenn alles in Ordnung ist', async () => {
      const push = notifier();
      await smokeAndReport({
        runner: { run: async () => outcome() },
        cwd: '/tmp/smoke',
        meter: { currentSamples: async () => [sample()] },
        notifier: push,
      });
      expect(push.sent).toEqual([]);
    });
  });
});

describe('Startprobe als Selbstprüfung (§6.1)', () => {
  const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

  /** The gate over a scripted sequence of runner outcomes, with a clock to move. */
  function gate(script: Outcome[]) {
    const clock = { now: 1_000_000 };
    const run = vi.fn(async () => script[Math.min(run.mock.calls.length - 1, script.length - 1)]);
    const smokeGate = new SmokeGate(
      () => smokeAndReport({ runner: { run: run as unknown as RunFn }, cwd: '/tmp/smoke' }),
      () => clock.now,
    );
    return { smokeGate, run, clock };
  }

  it('reicht den Anmeldefehler der Probe als gescheiterte Prüfung weiter', async () => {
    const { smokeGate } = gate([authOutcome()]);
    const check = await smokeGate.check();

    expect(check.ok).toBe(false);
    expect(smokeGate.passed).toBe(false);
    // The classification the cycle will make of it, on the real sentence.
    expect(isAuthIncident([check as { ok: false; reason: string }])).toBe(true);
  });

  it('meldet bei ungültigem Token einen Auth-Vorfall und nicht „bereit"', async () => {
    // The defect, end to end: `claude auth status` passes for any token that is
    // set, the probe is the first thing to find out — and the cycle used to log
    // "Selbstprüfung bestanden — Daemon ist bereit." every pass above a daemon
    // that took no work, with no `auth.incident` in the log.
    const { smokeGate } = gate([authOutcome()]);
    const info = vi.fn();
    const appendEvent = vi.fn(
      async (_kind: 'auth.incident' | 'system.selfcheck_failed', _reasons: string[]) => undefined,
    );
    const send = vi.fn(async (_message: { topic: string; title: string }) => ({
      ok: true as const,
    }));
    const onReady = vi.fn(async () => undefined);

    const cycle = await selfCheckCycle(
      {
        runChecks: async () => [{ ok: true }, await smokeGate.check()],
        wrapUp: { parkAll: async () => [], resumeAll: async () => [] },
        notifier: { send },
        appendEvent,
        onReady,
        logger: { ...silentLogger, info },
        retryMs: 300_000,
        readyMs: 15_000,
      },
      { authIncidentParked: false },
    );

    expect(cycle.ready).toBe(false);
    expect(cycle.authIncident).toBe(true);
    expect(appendEvent.mock.calls[0]?.[0]).toBe('auth.incident');
    expect(send.mock.calls[0]?.[0].title).toMatch(/Auth-Vorfall/);
    expect(onReady).not.toHaveBeenCalled();
    expect(info.mock.calls.map((call) => call[1])).not.toContain(
      'Selbstprüfung bestanden — Daemon ist bereit.',
    );
  });

  it('wiederholt den Befund während der Wartezeit, ohne eine weitere Sitzung zu starten', async () => {
    const { smokeGate, run, clock } = gate([authOutcome()]);
    await smokeGate.check();
    clock.now += SMOKE_RETRY_MS - 1;

    expect((await smokeGate.check()).ok).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('gibt nach einem neuen Token frei und fragt danach nie wieder', async () => {
    const { smokeGate, run, clock } = gate([authOutcome(), outcome()]);
    await smokeGate.check();
    clock.now += SMOKE_RETRY_MS;

    expect(await smokeGate.check()).toEqual({ ok: true });
    expect(smokeGate.passed).toBe(true);
    await smokeGate.check();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('reicht jedes andere Scheitern der Probe als gescheiterte Prüfung weiter, ohne Auth-Vorfall (#26)', async () => {
    const { smokeGate } = gate([outcome({ status: 'infra', problem: 'CLI nicht gefunden' })]);
    const check = await smokeGate.check();

    expect(check.ok).toBe(false);
    expect(smokeGate.passed).toBe(false);
    expect(isAuthIncident([check as { ok: false; reason: string; auth?: boolean }])).toBe(false);
  });

  it('meldet bei einer Probe, die aus anderem Grund scheitert, nicht „bereit" (#26)', async () => {
    const { smokeGate } = gate([outcome({ status: 'infra', problem: 'CLI nicht gefunden' })]);
    const info = vi.fn();
    const appendEvent = vi.fn(
      async (_kind: 'auth.incident' | 'system.selfcheck_failed', _reasons: string[]) => undefined,
    );
    const send = vi.fn(async (_message: { topic: string; title: string }) => ({
      ok: true as const,
    }));
    const onReady = vi.fn(async () => undefined);

    const cycle = await selfCheckCycle(
      {
        runChecks: async () => [{ ok: true }, await smokeGate.check()],
        wrapUp: { parkAll: async () => [], resumeAll: async () => [] },
        notifier: { send },
        appendEvent,
        onReady,
        logger: { ...silentLogger, info },
        retryMs: 300_000,
        readyMs: 15_000,
      },
      { authIncidentParked: false },
    );

    expect(cycle.ready).toBe(false);
    expect(cycle.authIncident).toBe(false);
    expect(appendEvent.mock.calls[0]?.[0]).toBe('system.selfcheck_failed');
    expect(appendEvent.mock.calls[0]?.[1]).toEqual([expect.stringMatching(/CLI nicht gefunden/)]);
    expect(send.mock.calls[0]?.[0].title).toBe('Vorschicht: Selbstprüfung fehlgeschlagen');
    expect(onReady).not.toHaveBeenCalled();
    expect(info.mock.calls.map((call) => call[1])).not.toContain(
      'Selbstprüfung bestanden — Daemon ist bereit.',
    );
  });

  describe('ein Token, das mitten im Betrieb abläuft (#26)', () => {
    it('macht aus der abgewiesenen Sitzung einen Auth-Vorfall des Daemons', async () => {
      const { smokeGate, run } = gate([outcome()]);
      expect(await smokeGate.check()).toEqual({ ok: true });

      smokeGate.reportAuthIncident('Sitzung abgewiesen (Lauf r-9): Auth-Vorfall (§6.1).');
      const check = await smokeGate.check();

      expect(check.ok).toBe(false);
      expect(smokeGate.passed).toBe(false);
      expect(isAuthIncident([check as { ok: false; reason: string; auth?: boolean }])).toBe(true);
      // Reported, not probed: the session that was refused is the evidence.
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('alarmiert über den Vorfallsweg und parkt die Arbeit', async () => {
      const { smokeGate } = gate([outcome()]);
      await smokeGate.check();
      smokeGate.reportAuthIncident('Sitzung abgewiesen (Lauf r-9): Auth-Vorfall (§6.1).');

      const appendEvent = vi.fn(
        async (_kind: 'auth.incident' | 'system.selfcheck_failed', _reasons: string[]) => undefined,
      );
      const send = vi.fn(async (_message: { topic: string; title: string }) => ({
        ok: true as const,
      }));
      const parkAll = vi.fn(async (_reason: 'auth_incident' | 'manual_pause') => [
        { parked: true },
      ]);
      const cycle = await selfCheckCycle(
        {
          runChecks: async () => [{ ok: true }, await smokeGate.check()],
          wrapUp: { parkAll, resumeAll: async () => [] },
          notifier: { send },
          appendEvent,
          logger: silentLogger,
          retryMs: 300_000,
          readyMs: 15_000,
        },
        { authIncidentParked: false },
      );

      expect(cycle.authIncident).toBe(true);
      expect(appendEvent.mock.calls[0]?.[0]).toBe('auth.incident');
      expect(send.mock.calls[0]?.[0].title).toMatch(/Auth-Vorfall/);
      expect(parkAll).toHaveBeenCalledWith('auth_incident');
    });

    it('prüft nach der Wartezeit wieder mit einer Probe und gibt bei neuem Token frei', async () => {
      const { smokeGate, run, clock } = gate([outcome(), authOutcome(), outcome()]);
      await smokeGate.check();
      smokeGate.reportAuthIncident('Sitzung abgewiesen (Lauf r-9): Auth-Vorfall (§6.1).');

      clock.now += SMOKE_RETRY_MS;
      expect((await smokeGate.check()).ok).toBe(false);
      expect(run).toHaveBeenCalledTimes(2);

      clock.now += SMOKE_RETRY_MS;
      expect(await smokeGate.check()).toEqual({ ok: true });
      expect(smokeGate.passed).toBe(true);
    });
  });
});
