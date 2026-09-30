import { describe, expect, it } from 'vitest';
import {
  DEGRADED_WRAP_UP_PERCENT,
  GUARDIAN_THRESHOLDS,
  type UsageWindowKind,
  WINDOW_NOMINAL_MS,
} from './constants.js';
import { evaluateGuardian, type GuardianInput, type WindowLatch } from './guardian.js';
import type { UsageSample } from './usage.js';

const NOW = 1_800_000_000_000;

function sample(
  window: UsageWindowKind,
  usedPercent: number,
  overrides: Partial<UsageSample> = {},
): UsageSample {
  return {
    window,
    modelClass: null,
    usedPercent,
    resetsAt: NOW + 3_600_000,
    source: 'official',
    anomaly: null,
    observedAt: NOW,
    ...overrides,
  };
}

function evaluate(input: Partial<GuardianInput> & { samples: UsageSample[] }) {
  return evaluateGuardian({ latches: [], now: NOW, ...input });
}

describe('evaluateGuardian — thresholds', () => {
  it('runs normally below the wrap-up threshold', () => {
    const d = evaluate({ samples: [sample('five_hour', 40), sample('seven_day', 61)] });
    expect(d.state).toBe('normal');
    expect(d.reason.kind).toBe('below_thresholds');
  });

  it('enters wrap_up at exactly 85 percent', () => {
    const d = evaluate({ samples: [sample('five_hour', GUARDIAN_THRESHOLDS.WRAP_UP_PERCENT)] });
    expect(d.state).toBe('wrap_up');
    expect(d.governingWindow).toBe('five_hour');
  });

  it('enters hard_stop at exactly 95 percent', () => {
    const d = evaluate({ samples: [sample('five_hour', GUARDIAN_THRESHOLDS.HARD_STOP_PERCENT)] });
    expect(d.state).toBe('hard_stop');
  });

  // §7.1: "the tightest governing window wins everywhere" — including when the
  // window that is nearly spent is the weekly one and the 5h window looks calm.
  it('lets the tightest window govern, whichever it is', () => {
    const d = evaluate({ samples: [sample('five_hour', 3), sample('seven_day', 96)] });
    expect(d.state).toBe('hard_stop');
    expect(d.governingWindow).toBe('seven_day');
  });

  it('applies the same logic to per-model weekly windows', () => {
    const d = evaluate({
      samples: [
        sample('five_hour', 10),
        sample('seven_day', 20),
        sample('seven_day_model', 91, { modelClass: 'Opus' }),
      ],
    });
    expect(d.state).toBe('wrap_up');
    expect(d.governingWindow).toBe('seven_day_model');
  });
});

describe('evaluateGuardian — fail-closed behaviour', () => {
  // An autonomous system that cannot see its budget must not start new work.
  it('treats "no samples at all" as wrap_up, not as normal', () => {
    const d = evaluate({ samples: [] });
    expect(d.state).toBe('wrap_up');
    expect(d.reason.kind).toBe('no_data');
  });

  it('treats an explicitly unavailable window as wrap_up', () => {
    const d = evaluate({
      samples: [sample('five_hour', 0, { anomaly: { kind: 'unavailable' } })],
    });
    expect(d.state).toBe('wrap_up');
  });

  it('stops earlier when the number is only estimated', () => {
    const justUnder = DEGRADED_WRAP_UP_PERCENT - 1;
    expect(
      evaluate({ samples: [sample('five_hour', justUnder, { source: 'estimated' })] }).state,
    ).toBe('normal');
    const atDegraded = evaluate({
      samples: [sample('five_hour', DEGRADED_WRAP_UP_PERCENT, { source: 'estimated' })],
    });
    expect(atDegraded.state).toBe('wrap_up');
    expect(atDegraded.reason.kind).toBe('degraded_source');
    // The same number from the official source is still perfectly fine.
    expect(evaluate({ samples: [sample('five_hour', DEGRADED_WRAP_UP_PERCENT)] }).state).toBe(
      'normal',
    );
  });
});

describe('evaluateGuardian — the latch', () => {
  // get_usage has a "seeded" state, so a cached low reading right after a high
  // one is a real thing that happens. Without the latch it would reopen the
  // gate with the budget nearly gone.
  it('does not return to normal on a friendlier reading alone', () => {
    const first = evaluate({ samples: [sample('five_hour', 88)] });
    expect(first.state).toBe('wrap_up');

    const second = evaluateGuardian({
      samples: [sample('five_hour', 60)],
      latches: first.latches,
      now: NOW + 60_000,
    });
    expect(second.state).toBe('wrap_up');
    expect(second.reason.kind).toBe('latched');
  });

  it('clears the latch once the window has demonstrably reset', () => {
    const resetsAt = NOW + 3_600_000;
    const first = evaluate({ samples: [sample('five_hour', 88, { resetsAt })] });

    const afterReset = evaluateGuardian({
      samples: [
        sample('five_hour', 5, { resetsAt: resetsAt + 18_000_000, observedAt: resetsAt + 1 }),
      ],
      latches: first.latches,
      now: resetsAt + 1,
    });
    expect(afterReset.state).toBe('normal');
    expect(afterReset.latches).toHaveLength(0);
  });

  it('keeps a hard_stop latch from softening into wrap_up', () => {
    const first = evaluate({ samples: [sample('five_hour', 97)] });
    expect(first.state).toBe('hard_stop');

    const second = evaluateGuardian({
      samples: [sample('five_hour', 86)],
      latches: first.latches,
      now: NOW + 1000,
    });
    expect(second.state).toBe('hard_stop');
  });

  // Without a fallback expiry, fail-closed becomes fail-forever: a reading
  // that arrived without resets_at would shut the studio permanently.
  it('lets a latch without a known reset expire after the window length', () => {
    const latched: WindowLatch[] = [
      { window: 'five_hour', modelClass: null, state: 'wrap_up', since: NOW, resetsAt: null },
    ];
    const stillHeld = evaluateGuardian({
      samples: [sample('five_hour', 5)],
      latches: latched,
      now: NOW + WINDOW_NOMINAL_MS.five_hour - 1,
    });
    expect(stillHeld.state).toBe('wrap_up');

    const released = evaluateGuardian({
      samples: [sample('five_hour', 5)],
      latches: latched,
      now: NOW + WINDOW_NOMINAL_MS.five_hour,
    });
    expect(released.state).toBe('normal');
  });

  it('prefers an observed reset time over the fallback', () => {
    const latched: WindowLatch[] = [
      { window: 'five_hour', modelClass: null, state: 'wrap_up', since: NOW, resetsAt: NOW + 1000 },
    ];
    const released = evaluateGuardian({
      samples: [sample('five_hour', 5)],
      latches: latched,
      now: NOW + 1000,
    });
    expect(released.state).toBe('normal');
  });

  it('latches per window, so an unrelated window resetting does not free it', () => {
    const latched: WindowLatch[] = [
      { window: 'seven_day', modelClass: null, state: 'wrap_up', since: NOW, resetsAt: NOW + 1e9 },
    ];
    const d = evaluateGuardian({
      samples: [sample('five_hour', 5, { resetsAt: NOW - 1 })],
      latches: latched,
      now: NOW,
    });
    expect(d.state).toBe('wrap_up');
  });

  // A jump straight past wrap-up with no sample in between must still latch as
  // hard_stop — the guardian may not assume it saw every intermediate value.
  it('handles a jump from below wrap-up straight into hard_stop', () => {
    const first = evaluate({ samples: [sample('five_hour', 84.9)] });
    expect(first.state).toBe('normal');
    const second = evaluateGuardian({
      samples: [sample('five_hour', 95.1)],
      latches: first.latches,
      now: NOW + 1000,
    });
    expect(second.state).toBe('hard_stop');
  });
});

describe('evaluateGuardian — manual pause (A26)', () => {
  it('maps a soft pause to wrap-up semantics', () => {
    const d = evaluate({
      samples: [sample('five_hour', 1)],
      manualPause: { active: true, hard: false },
    });
    expect(d.state).toBe('wrap_up');
    expect(d.reason).toEqual({ kind: 'manual_pause', hard: false });
  });

  it('maps a hard pause to hard-stop semantics', () => {
    const d = evaluate({
      samples: [sample('five_hour', 1)],
      manualPause: { active: true, hard: true },
    });
    expect(d.state).toBe('hard_stop');
  });
});
