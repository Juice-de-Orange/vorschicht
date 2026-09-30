/**
 * The caller for §14's answered proposal cards.
 *
 * Two things are asserted, and the second is the weaker one on purpose.
 *
 * The **cadence** is real behaviour and is tested with an injected clock: a pass
 * that ran on every tick would cost two indexed lookups every fifteen seconds
 * forever, and one that never re-armed would carry out a decision once and then
 * stop. Both failures are silent in operation and neither is visible without a
 * clock somebody controls.
 *
 * The **call site** is the honest limit A86.6 states in full: `main.ts` has no
 * test, which is exactly how `EscalationMailService.tick()` came to have no
 * caller at all. Deleting the call from the daemon's loop kills nothing in this
 * file, so the net is a grep over that file — it proves the call site exists,
 * never that it is reached, and it is the only mechanical guard available
 * without restructuring an entry point outside this change.
 */
import { readFileSync } from 'node:fs';
import type { ApplyProposalsResult } from '@vorschicht/core';
import { describe, expect, it } from 'vitest';
import {
  newSourcesPassState,
  runSourcesPass,
  SOURCES_PASS_INTERVAL_MS,
  type SourcesPassDeps,
} from './sources-pass.js';

function logger() {
  const lines: Array<{ level: string; message: string }> = [];
  return {
    lines,
    info: (_obj: unknown, message?: string) =>
      lines.push({ level: 'info', message: message ?? '' }),
    warn: (_obj: unknown, message?: string) =>
      lines.push({ level: 'warn', message: message ?? '' }),
  };
}

function deps(
  results: ApplyProposalsResult[],
  now: () => number,
): { deps: SourcesPassDeps; calls: () => number; log: ReturnType<typeof logger> } {
  let calls = 0;
  const log = logger();
  return {
    calls: () => calls,
    log,
    deps: {
      proposals: {
        applyAnswers: async () => {
          const result = results[calls] ?? { applied: [], problems: [] };
          calls += 1;
          return result;
        },
      },
      logger: log,
      now,
    },
  };
}

const NICHTS: ApplyProposalsResult = { applied: [], problems: [] };

describe('Quellen-Durchlauf (§14)', () => {
  it('läuft beim ersten Durchgang sofort — auch direkt nach einem Neustart', () => {
    // Zero rather than "now + interval": a daemon that has just restarted should
    // carry out a decision the operator made while it was down on its first pass.
    expect(newSourcesPassState().nextRunAt).toBe(0);
  });

  it('läuft nicht bei jedem Tick, sondern auf seiner eigenen Frist', async () => {
    let jetzt = 1_000_000;
    const fixture = deps([NICHTS, NICHTS], () => jetzt);
    const state = newSourcesPassState();

    expect((await runSourcesPass(fixture.deps, state)).ran).toBe(true);
    expect(fixture.calls()).toBe(1);

    // Four ticks inside the interval: the pass has to stay silent, and "silent"
    // means the query is not made — not merely that nothing was reported.
    for (const versatz of [15_000, 30_000, 45_000, SOURCES_PASS_INTERVAL_MS - 1]) {
      jetzt = 1_000_000 + versatz;
      expect((await runSourcesPass(fixture.deps, state)).ran).toBe(false);
    }
    expect(fixture.calls()).toBe(1);

    jetzt = 1_000_000 + SOURCES_PASS_INTERVAL_MS;
    expect((await runSourcesPass(fixture.deps, state)).ran).toBe(true);
    expect(fixture.calls()).toBe(2);
  });

  it('meldet jeden Ausgang, auch die, bei denen nichts kuratiert wurde', async () => {
    const fixture = deps(
      [
        {
          applied: [
            { escalationNumber: 7, sourceId: 'a', outcome: 'accepted', detail: null },
            {
              escalationNumber: 8,
              sourceId: 'b',
              outcome: 'unentschieden',
              detail: 'Die Antwort war reiner Freitext.',
            },
          ],
          problems: [],
        },
      ],
      () => 0,
    );

    const result = await runSourcesPass(fixture.deps, newSourcesPassState());
    expect(result.applied).toHaveLength(2);
    // Both, and the second one especially: a free-text answer that curated
    // nothing is a state the operator would want to see rather than infer from silence.
    expect(fixture.log.lines.map((line) => line.message)).toEqual([
      'Quellenvorschlag #7 ausgeführt: accepted',
      'Die Antwort war reiner Freitext.',
    ]);
  });

  it('protokolliert ein Problem als Warnung und pusht es nicht', async () => {
    const fixture = deps(
      [{ applied: [], problems: ['Quellenvorschlag #3 konnte nicht ausgeführt werden: weg'] }],
      () => 0,
    );
    const result = await runSourcesPass(fixture.deps, newSourcesPassState());
    expect(result.problems).toHaveLength(1);
    expect(fixture.log.lines).toEqual([
      { level: 'warn', message: 'Quellenvorschlag #3 konnte nicht ausgeführt werden: weg' },
    ]);
    // Deliberately no notifier in the deps at all: a card that could not be
    // carried out is retried on the next pass, so a push per pass would be
    // A67.6's muted channel — and there is nothing for the operator to do about it that
    // answering the card again would not already do.
    expect(Object.keys(fixture.deps)).not.toContain('notifier');
  });

  it('setzt die Frist vor der Arbeit, damit ein langsamer Durchgang sich nicht staut', async () => {
    const jetzt = 500;
    const state = newSourcesPassState();
    const fixture = deps([NICHTS], () => jetzt);
    await runSourcesPass(fixture.deps, state);
    // Measured from when the pass *started*, not from when it ended.
    expect(state.nextRunAt).toBe(500 + SOURCES_PASS_INTERVAL_MS);
  });

  it('wird vom Daemon aufgerufen (A86.6s Netz, und seine Grenze)', () => {
    const main = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    expect(main).toContain('runSourcesPass(');
    expect(main).toContain('newSourcesPassState()');
    // It sits in the `while` body next to the other passes rather than behind
    // §6.1's smoke gate — a decision the operator already made is worth carrying out
    // during an auth incident too.
    expect(main).toContain('runNotificationsPass(');
  });
});
