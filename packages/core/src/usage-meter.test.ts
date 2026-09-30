import { evaluateGuardian, type UsageSample } from '@vorschicht/shared';
import { describe, expect, it } from 'vitest';
import { MAX_SAMPLE_AGE_MS, projectSamples } from './usage-meter.js';

const NOW = 1_800_000_000_000;

function sample(overrides: Partial<UsageSample> = {}): UsageSample {
  return {
    window: 'five_hour',
    modelClass: null,
    usedPercent: 12,
    resetsAt: NOW + 3_600_000,
    source: 'official',
    anomaly: null,
    observedAt: NOW,
    ...overrides,
  };
}

describe('projectSamples — die Fail-closed-Regel', () => {
  it('reicht frische Proben unverändert durch', () => {
    const fresh = [sample(), sample({ window: 'seven_day', usedPercent: 40 })];
    expect(projectSamples(fresh, NOW)).toEqual(fresh);
  });

  // An empty list reads as "nothing to worry about" — the one thing missing
  // budget data must never look like.
  it('gibt auf leerer Datenlage eine unavailable-Probe statt einer leeren Liste', () => {
    const projected = projectSamples([], NOW);
    expect(projected).toHaveLength(1);
    expect(projected[0]?.anomaly).toEqual({ kind: 'unavailable' });
    expect(evaluateGuardian({ samples: projected, latches: [], now: NOW }).state).toBe('wrap_up');
  });

  it('entwertet eine zu alte Probe, statt sie weiterzureichen', () => {
    const stale = [sample({ observedAt: NOW - MAX_SAMPLE_AGE_MS - 1 })];
    const projected = projectSamples(stale, NOW);
    expect(projected[0]?.anomaly).toEqual({ kind: 'unavailable' });
    // A number that said 12% an hour ago is not evidence about now.
    expect(evaluateGuardian({ samples: projected, latches: [], now: NOW }).state).toBe('wrap_up');
  });

  it('lässt eine Probe exakt an der Altersgrenze noch gelten', () => {
    const edge = [sample({ observedAt: NOW - MAX_SAMPLE_AGE_MS })];
    expect(projectSamples(edge, NOW)[0]?.anomaly).toBeNull();
  });

  it('behält beim Entwerten die Modellklasse, damit das Fenster erkennbar bleibt', () => {
    const stale = [
      sample({
        window: 'seven_day_model',
        modelClass: 'Opus',
        observedAt: NOW - 10 * MAX_SAMPLE_AGE_MS,
      }),
    ];
    const projected = projectSamples(stale, NOW);
    expect(projected[0]?.window).toBe('seven_day_model');
    expect(projected[0]?.modelClass).toBe('Opus');
  });

  // 100 would render as "budget exhausted" in the dashboard, which is a
  // different and wrong statement. The anomaly is what closes the gate.
  it('meldet Blindheit nicht als 100 Prozent', () => {
    expect(projectSamples([], NOW)[0]?.usedPercent).toBe(0);
  });

  it('entwertet nur die veralteten Fenster, nicht die frischen', () => {
    const mixed = [
      sample(),
      sample({ window: 'seven_day', observedAt: NOW - 10 * MAX_SAMPLE_AGE_MS }),
    ];
    const projected = projectSamples(mixed, NOW);
    expect(projected[0]?.anomaly).toBeNull();
    expect(projected[1]?.anomaly).toEqual({ kind: 'unavailable' });
  });
});

/**
 * §7.1's ranking — "official-first", with the estimate as the fallback.
 *
 * This became load-bearing when the estimating meter (A6) started writing on a
 * timer: it produces a sample every tick, so "newest wins" would have made the
 * estimate outrank every official reading within seconds of one arriving. And
 * because an `unavailable` sentinel is *also* stored as `source: 'estimated'`,
 * the same rule would have let a failed budget read mask a perfectly good
 * estimate written moments earlier — leaving the studio shut on exactly the
 * blindness the estimate exists to cover.
 */
describe('projectSamples — offiziell zuerst, Schätzung als Rückfall (§7.1)', () => {
  const estimated = (overrides: Partial<UsageSample> = {}) =>
    sample({ source: 'estimated', ...overrides });
  const blind = (overrides: Partial<UsageSample> = {}) =>
    sample({ source: 'estimated', usedPercent: 0, anomaly: { kind: 'unavailable' }, ...overrides });

  it('zieht die offizielle Lesung der neueren Schätzung vor', () => {
    const projected = projectSamples(
      [
        sample({ usedPercent: 88, observedAt: NOW - 60_000 }),
        estimated({ usedPercent: 10, observedAt: NOW }),
      ],
      NOW,
    );
    expect(projected).toHaveLength(1);
    expect(projected[0]?.source).toBe('official');
    expect(projected[0]?.usedPercent).toBe(88);
  });

  it('nimmt die Schätzung, wenn die offizielle Lesung veraltet ist', () => {
    const projected = projectSamples(
      [
        sample({ usedPercent: 88, observedAt: NOW - 10 * MAX_SAMPLE_AGE_MS }),
        estimated({ usedPercent: 40, observedAt: NOW }),
      ],
      NOW,
    );
    expect(projected[0]?.source).toBe('estimated');
    expect(projected[0]?.usedPercent).toBe(40);
  });

  // The case that made this whole ranking necessary: A59's blind `get_usage`
  // writes a sentinel on every run, and it must not bury the estimate.
  it('lässt eine neuere Blind-Probe die Schätzung nicht verdecken', () => {
    const projected = projectSamples(
      [estimated({ usedPercent: 40, observedAt: NOW - 60_000 }), blind({ observedAt: NOW })],
      NOW,
    );
    expect(projected).toHaveLength(1);
    expect(projected[0]?.anomaly).toBeNull();
    expect(projected[0]?.usedPercent).toBe(40);
    expect(evaluateGuardian({ samples: projected, latches: [], now: NOW }).state).toBe('normal');
  });

  it('bleibt blind, wenn es nur Blind-Proben gibt', () => {
    const projected = projectSamples([blind()], NOW);
    expect(projected[0]?.anomaly).toEqual({ kind: 'unavailable' });
    expect(evaluateGuardian({ samples: projected, latches: [], now: NOW }).state).toBe('wrap_up');
  });

  /**
   * The failure this guards against is not a wrong number but a *missing
   * window*: `evaluateGuardian` only considers the samples it is handed, so a
   * window dropped from the list stops being able to close the gate. A
   * fail-closed rule that disappears is an open gate nobody edited.
   */
  it('behält ein unlesbares Fenster in der Liste, statt es fallen zu lassen', () => {
    const projected = projectSamples(
      [
        estimated({ window: 'seven_day', usedPercent: 10 }),
        blind({ window: 'five_hour', observedAt: NOW - 10 * MAX_SAMPLE_AGE_MS }),
      ],
      NOW,
    );
    expect(projected.map((s) => s.window).sort()).toEqual(['five_hour', 'seven_day']);
    expect(evaluateGuardian({ samples: projected, latches: [], now: NOW }).state).toBe('wrap_up');
  });

  it('hält Modellklassen desselben Fensters auseinander', () => {
    const projected = projectSamples(
      [
        sample({ window: 'seven_day_model', modelClass: 'Opus', usedPercent: 90 }),
        sample({ window: 'seven_day_model', modelClass: 'Sonnet', usedPercent: 10 }),
      ],
      NOW,
    );
    expect(projected).toHaveLength(2);
    expect(projected.map((s) => s.usedPercent).sort((a, b) => a - b)).toEqual([10, 90]);
  });
});
