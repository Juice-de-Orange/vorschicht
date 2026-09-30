/**
 * The shared `ModelBackend` contract suite (A31).
 *
 * Every backend is held to the same promises, and the contingency stubs are
 * held to *failing* them in the same way. That second half is not ceremony:
 * §6.0's playbook is that if Anthropic's paused billing change returns,
 * Vorschicht implements a fallback backend as its first emergency task inside
 * the announced notice window. Filling a slot whose shape is already pinned
 * down and already under test is a different job from designing one under
 * pressure.
 *
 * The `headless` backend participates too, but only when explicitly asked —
 * it costs subscription budget on every run. `infra/scripts/demo-phase1.sh`
 * turns it on; the everyday gate runs the free half.
 */
import type { BackendEvent, SessionSpec } from '@vorschicht/shared';
import { describe, expect, it } from 'vitest';
import { FakeBackend, type FakeEvent } from './fake.js';
import { ApiKeyBackend, InteractivePtyBackend } from './stubs.js';
import { BackendNotImplementedError, type ModelBackend } from './types.js';

export function spec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    runId: '00000000-0000-4000-8000-000000000001',
    role: 'coder',
    prompt: 'tu nichts',
    systemPromptAppend: '',
    cwd: process.cwd(),
    model: 'haiku',
    allowedTools: ['Read'],
    settingsPath: '/app/claude/settings.coder.json',
    mcpConfigPath: null,
    env: { VORSCHICHT_RUN_POLICY: '/data/runs/r1/containment.json' },
    resultSchema: null,
    caps: { maxTurns: 1, maxBudgetUsd: null, wallClockMs: 60_000 },
    ...overrides,
  };
}

async function collect(backend: ModelBackend, session = spec()): Promise<BackendEvent[]> {
  const handle = await backend.spawn(session);
  const events: BackendEvent[] = [];
  for await (const event of handle.events()) events.push(event);
  return events;
}

/** The promises every working backend makes. Reused by the real-backend run. */
export function describeWorkingBackend(name: string, make: () => ModelBackend): void {
  describe(`${name}: ModelBackend-Vertrag`, () => {
    it('meldet seine Fähigkeiten als Booleans', () => {
      const caps = make().capabilities();
      for (const key of [
        'supportsResume',
        'supportsStructuredOutput',
        'supportsUsageQuery',
        'supportsInterrupt',
      ] as const) {
        expect(typeof caps[key], key).toBe('boolean');
      }
    });

    it('beginnt mit run_started und endet mit genau einem terminated', async () => {
      const events = await collect(make());
      expect(events[0]?.type).toBe('run_started');
      expect(events.at(-1)?.type).toBe('terminated');
      expect(events.filter((e) => e.type === 'terminated')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'run_started')).toHaveLength(1);
    });

    it('trägt dieselbe runId durch jedes Ereignis', async () => {
      const session = spec({ runId: '00000000-0000-4000-8000-00000000abcd' });
      const events = await collect(make(), session);
      // The handle owns the id; nothing downstream has to correlate by timing.
      for (const event of events) expect(event.runId).toBe(session.runId);
    });

    it('gibt eine Session-Kennung und das Arbeitsverzeichnis heraus', async () => {
      const handle = await make().spawn(spec());
      expect(handle.sessionId).toBeTruthy();
      // §6.2: resume is scoped to the directory the session started in.
      expect(handle.cwd).toBe(spec().cwd);
      await handle.kill();
    });

    it('liefert Usage nur, wenn es das auch behauptet', async () => {
      const backend = make();
      const handle = await backend.spawn(spec());
      const usage = await handle.queryUsage();

      if (backend.capabilities().supportsUsageQuery) {
        // Null stays legal: a session that has made no API call yet has no
        // reading to give (A58.3). What is not legal is a shape the meter
        // cannot switch on — `rate_limits_available` is the field every caller
        // branches on first.
        if (usage !== null) expect(typeof usage.rate_limits_available).toBe('boolean');
      } else {
        expect(usage).toBeNull();
      }
      await handle.kill();
    });

    it('beantwortet die Frage nach dem Sitzungsprotokoll, ohne zu werfen', async () => {
      // §6.2 wants a copy of the transcript, and §18 keeps it for a year — but
      // a backend without one has to say so rather than throw, because the
      // runner archives after termination and a missing transcript may cost
      // traceability for a run, never the run.
      const handle = await make().spawn(spec());
      const path = await handle.transcriptPath();
      expect(path === null || typeof path === 'string').toBe(true);
      await handle.kill();
    });
  });
}

/** The promises a prepared-but-unimplemented slot makes (A31). */
export function describeStubBackend(name: string, make: () => ModelBackend): void {
  describe(`${name}: vorbereiteter Platz`, () => {
    it('meldet Fähigkeiten, ohne zu werfen', () => {
      expect(() => make().capabilities()).not.toThrow();
    });

    // A stub that returned empty results would let a caller believe it had
    // reached a model. That is the one failure worse than having no backend.
    it('scheitert beim spawn laut und benennbar', async () => {
      await expect(make().spawn(spec())).rejects.toThrow(BackendNotImplementedError);
    });

    it('scheitert beim resume genauso', async () => {
      await expect(
        make().resume({
          sessionId: 'sess',
          cwd: '/tmp',
          message: 'weiter',
          settingsPath: '/app/claude/settings.coder.json',
          env: {},
        }),
      ).rejects.toThrow(BackendNotImplementedError);
    });

    it('nennt in der Meldung, wessen Entscheidung die Aktivierung ist', async () => {
      await expect(make().spawn(spec())).rejects.toThrow(/Betreiber|operator/);
      await expect(make().spawn(spec())).rejects.toThrow(/§6.0|A31/);
    });
  });
}

describeWorkingBackend('fake', () => new FakeBackend());
/**
 * The same contract against a backend that declares no usage query.
 *
 * Without this registration the suite only ever saw one capability
 * configuration — `FakeBackend` with everything true — so the `else` branch of
 * "liefert Usage nur, wenn es das auch behauptet" executed no expectations at
 * all and the case was decorative. A contract suite that never varies the
 * capabilities is not testing a contract, it is testing one implementation.
 */
describeWorkingBackend(
  'fake ohne Usage-Abfrage',
  () => new FakeBackend({ supportsUsageQuery: false }),
);
describeStubBackend('interactive-pty', () => new InteractivePtyBackend());
describeStubBackend('api-key', () => new ApiKeyBackend());

describe('fake: die Fälle, die es überhaupt erst rechtfertigen', () => {
  // None of these can be requested from a real service, and all of them have
  // to work — which is exactly why A37 adds this backend.
  it('spielt eine Usage-Bahn ab, ohne Budget zu verbrauchen', async () => {
    const backend = new FakeBackend({
      usage: [
        {
          rate_limits_available: true,
          rate_limits: { limits: [{ kind: 'session', percent: 10 }] },
        },
        {
          rate_limits_available: true,
          rate_limits: { limits: [{ kind: 'session', percent: 96 }] },
        },
        { rate_limits_available: false },
      ],
    });
    const handle = await backend.spawn(spec());
    expect((await handle.queryUsage())?.rate_limits?.limits?.[0]?.percent).toBe(10);
    expect((await handle.queryUsage())?.rate_limits?.limits?.[0]?.percent).toBe(96);
    expect((await handle.queryUsage())?.rate_limits_available).toBe(false);
    // Holds on the last entry, so a test describes a trajectory rather than
    // counting calls.
    expect((await handle.queryUsage())?.rate_limits_available).toBe(false);
    await handle.kill();
  });

  it('endet nach einem Interrupt als interrupted, nicht als Fehler', async () => {
    const backend = new FakeBackend({
      stepDelayMs: 20,
      events: Array.from(
        { length: 20 },
        (): FakeEvent => ({ type: 'assistant_text', text: 'arbeite' }),
      ),
    });
    const handle = await backend.spawn(spec());
    const events: BackendEvent[] = [];
    const reading = (async () => {
      for await (const event of handle.events()) events.push(event);
    })();
    await new Promise((resolve) => setTimeout(resolve, 60));
    await handle.interrupt('guardian_wrap_up');
    await reading;

    const terminated = events.at(-1);
    expect(terminated?.type).toBe('terminated');
    // §7.3: a parked run is not a failed run, and must never render red.
    expect(terminated && 'reason' in terminated && terminated.reason).toBe('interrupted');
    expect(events.length).toBeLessThan(22);
  });

  it('kann einen Spawn-Fehler nachstellen', async () => {
    const backend = new FakeBackend({ failOnSpawn: 'kein Platz auf dem Gerät' });
    await expect(backend.spawn(spec())).rejects.toThrow(/kein Platz/);
  });

  it('reicht ein strukturiertes Ergebnis vor der Terminierung durch', async () => {
    const backend = new FakeBackend({
      result: { raw: { status: 'done', summary: 'fertig' }, tokensIn: 10, tokensOut: 3 },
    });
    const events = await collect(backend);
    const result = events.find((e) => e.type === 'result');
    expect(result && 'raw' in result && result.raw).toEqual({ status: 'done', summary: 'fertig' });
    expect(events.indexOf(result as BackendEvent)).toBeLessThan(events.length - 1);
  });
});
