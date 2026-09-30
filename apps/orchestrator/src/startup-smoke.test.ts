/**
 * §6.1's startup probe, and the deadlock it exists to break.
 *
 * The property that matters is not "a session ran". It is that the three
 * outcomes are told apart: the probe failed, the probe ran but the budget could
 * not be read, the probe ran and the meter is seeded. They need different
 * responses and from outside they all look like a studio doing nothing.
 */
import type { UsageSample } from '@vorschicht/shared';
import { describe, expect, it, vi } from 'vitest';
import { runStartupSmoke, type SmokeRunner, smokeAndReport } from './startup-smoke.js';

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
    it('alarmiert bei gescheiterter Probe', async () => {
      const push = notifier();
      await smokeAndReport({
        runner: { run: async () => outcome({ status: 'infra', problem: 'kaputt' }) },
        cwd: '/tmp/smoke',
        notifier: push,
      });
      expect(push.sent).toEqual([
        { topic: 'alerts', title: 'Vorschicht: Startprobe fehlgeschlagen' },
      ]);
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
