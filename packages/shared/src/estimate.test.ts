/**
 * The estimating meter's arithmetic (A6, §7.1).
 *
 * The property under test throughout is not "the number is right" — no estimate
 * is right — but **"the number never errs downward"**. An estimate that reads
 * low authorises spending that is not there, and the outcome is the
 * uncontrolled limit event §1 principle 3 exists to prevent. Reading high costs
 * idle time. So nearly every case here asserts a direction rather than a value.
 */
import { describe, expect, it } from 'vitest';
import {
  DEGRADED_WRAP_UP_PERCENT,
  ESTIMATE_SAFETY_FACTOR,
  PLAN_BUDGETS,
  type PlanBudget,
  WINDOW_NOMINAL_MS,
} from './constants.js';
import { describeEstimate, estimate, type SpendEntry, spendByModel } from './estimate.js';

const NOW = Date.parse('2026-08-01T14:00:00Z');
const HOUR = 60 * 60_000;
const BUDGET: PlanBudget = { fiveHourUsd: 100, sevenDayUsd: 700 };

function spend(hoursAgo: number, costUsd: number, byModel?: Record<string, number>): SpendEntry {
  return { at: NOW - hoursAgo * HOUR, costUsd, ...(byModel ? { byModel } : {}) };
}

const five = (windows: ReturnType<typeof estimate>) =>
  windows.find((w) => w.window === 'five_hour');
const week = (windows: ReturnType<typeof estimate>) =>
  windows.find((w) => w.window === 'seven_day');

describe('estimate — windows and their boundaries', () => {
  it('reports both tracked windows and nothing else', () => {
    const windows = estimate({ entries: [], budget: BUDGET, now: NOW });
    expect(windows.map((w) => w.window)).toEqual(['five_hour', 'seven_day']);
    // §7.1 asks for a per-model weekly window "where the plan defines them", and
    // without the official reading nothing says what the plan defines. Inventing
    // a cap would either idle the studio on a number with no evidence or, set
    // generously, do nothing. Asserted so the omission stays a decision.
    expect(windows.some((w) => w.window === 'seven_day_model')).toBe(false);
  });

  it('applies A6 safety factor to the denominator, so the percentage reads high', () => {
    const windows = estimate({ entries: [spend(1, 45)], budget: BUDGET, now: NOW });
    // 45 / (100 * 0.9) = 50%, not 45%.
    expect(five(windows)?.usedPercent).toBe(50);
    expect(five(windows)?.budgetUsd).toBe(100 * ESTIMATE_SAFETY_FACTOR);
  });

  it('counts a rolling window when no anchor is known, and says so', () => {
    const windows = estimate({ entries: [spend(4.5, 10)], budget: BUDGET, now: NOW });
    expect(five(windows)?.basis.kind).toBe('rolling');
    expect(five(windows)?.spendUsd).toBe(10);
  });

  it('drops spend that has aged out of the rolling window', () => {
    const windows = estimate({
      entries: [spend(6, 90), spend(1, 9)],
      budget: BUDGET,
      now: NOW,
    });
    expect(five(windows)?.spendUsd).toBe(9);
    // …but the weekly window still sees both.
    expect(week(windows)?.spendUsd).toBe(99);
  });

  it('uses an observed reset as an exact boundary', () => {
    // Reset at 15:00Z → this window began at 10:00Z, i.e. four hours ago.
    const resetsAt = NOW + HOUR;
    const windows = estimate({
      entries: [spend(4.5, 50), spend(3, 20)],
      budget: BUDGET,
      anchors: { five_hour: resetsAt },
      now: NOW,
    });
    const w = five(windows);
    expect(w?.basis).toEqual({ kind: 'anchored', windowStart: resetsAt - 5 * HOUR, resetsAt });
    // The 4.5h-old entry predates the boundary and does not count.
    expect(w?.spendUsd).toBe(20);
  });

  /**
   * The one case where being clever would be dangerous. A `resets_at` in the
   * past describes a window that has since rolled over; anchoring on it would
   * put the window start further back than it is and then *drop* entries that
   * belong to the live window — an undercount, by construction.
   */
  it('ignores an anchor that has already passed and falls back to rolling', () => {
    const windows = estimate({
      entries: [spend(1, 45)],
      budget: BUDGET,
      anchors: { five_hour: NOW - HOUR },
      now: NOW,
    });
    expect(five(windows)?.basis.kind).toBe('rolling');
    expect(five(windows)?.spendUsd).toBe(45);
  });

  /**
   * The property that makes the rolling fallback acceptable rather than a
   * guess: for any window that has not yet reset, the rolling sum is ≥ the true
   * one, because the true window start lies inside the rolling one.
   */
  it('rolling never reads lower than the anchored truth, for any boundary', () => {
    const entries = Array.from({ length: 40 }, (_, i) => spend(i * 0.12, 1));
    const rolling = five(estimate({ entries, budget: BUDGET, now: NOW }))?.spendUsd ?? 0;
    // Every possible position of a live five-hour window.
    for (let minutes = 1; minutes <= 300; minutes += 7) {
      const resetsAt = NOW + minutes * 60_000;
      const anchored =
        five(estimate({ entries, budget: BUDGET, anchors: { five_hour: resetsAt }, now: NOW }))
          ?.spendUsd ?? 0;
      expect(rolling).toBeGreaterThanOrEqual(anchored);
    }
  });
});

describe('estimate — relief times', () => {
  it('reports no relief time while below the threshold', () => {
    const windows = estimate({ entries: [spend(1, 10)], budget: BUDGET, now: NOW });
    expect(five(windows)?.resetsAt).toBeNull();
  });

  it('reports the observed reset for an anchored window over the threshold', () => {
    const resetsAt = NOW + HOUR;
    const windows = estimate({
      entries: [spend(1, 90)],
      budget: BUDGET,
      anchors: { five_hour: resetsAt },
      now: NOW,
    });
    expect(five(windows)?.usedPercent).toBe(100);
    expect(five(windows)?.resetsAt).toBe(resetsAt);
  });

  /**
   * Without this the guardian's latch falls back to a full nominal window from
   * the moment it latched — five hours of idling over spend that expires in
   * one. §7.2's weekly policy is explicitly greedy; resting longer than the
   * data requires is waste, not caution.
   */
  it('computes when a rolling window drops back under the threshold', () => {
    // 80 spent 4h ago, 5 spent now. Threshold is 75% of 90 = 67.5.
    // Dropping the 4h-old entry leaves 5, which is under. It leaves the window
    // one hour from now.
    const windows = estimate({
      entries: [spend(4, 80), spend(0, 5)],
      budget: BUDGET,
      now: NOW,
    });
    const w = five(windows);
    expect(w?.usedPercent).toBeGreaterThanOrEqual(DEGRADED_WRAP_UP_PERCENT);
    expect(w?.resetsAt).toBe(NOW - 4 * HOUR + WINDOW_NOMINAL_MS.five_hour);
  });

  it('walks forward over several entries until the reading is genuinely under', () => {
    // Four entries of 25 each; threshold 67.5. Dropping one leaves 75 (still
    // over), dropping two leaves 50 (under) — so relief is when the *second*
    // ages out, not the first.
    const windows = estimate({
      entries: [spend(4.5, 25), spend(4, 25), spend(3, 25), spend(1, 25)],
      budget: BUDGET,
      now: NOW,
    });
    expect(five(windows)?.resetsAt).toBe(NOW - 4 * HOUR + WINDOW_NOMINAL_MS.five_hour);
  });

  it('falls back to the last entry ageing out when nothing else suffices', () => {
    // A single entry larger than the whole threshold: only its own expiry helps.
    const windows = estimate({ entries: [spend(2, 500)], budget: BUDGET, now: NOW });
    expect(five(windows)?.resetsAt).toBe(NOW - 2 * HOUR + WINDOW_NOMINAL_MS.five_hour);
  });
});

describe('estimate — degenerate input', () => {
  it('reads 0% with no spend at all', () => {
    const windows = estimate({ entries: [], budget: BUDGET, now: NOW });
    expect(windows.every((w) => w.usedPercent === 0)).toBe(true);
  });

  it('caps at 100 rather than reporting an impossible percentage', () => {
    const windows = estimate({ entries: [spend(1, 10_000)], budget: BUDGET, now: NOW });
    expect(five(windows)?.usedPercent).toBe(100);
  });

  /**
   * A budget of zero is not "unlimited". It is a configuration that cannot
   * authorise anything, and reading it as 0% used would open the gate on the
   * strength of a missing number.
   */
  it('treats a zero or negative budget as fully consumed', () => {
    for (const fiveHourUsd of [0, -5]) {
      const windows = estimate({
        entries: [],
        budget: { fiveHourUsd, sevenDayUsd: 700 },
        now: NOW,
      });
      expect(five(windows)?.usedPercent).toBe(100);
    }
  });

  it('ignores negative spend rather than crediting it back', () => {
    const windows = estimate({
      entries: [spend(1, 45), spend(1, -1000)],
      budget: BUDGET,
      now: NOW,
    });
    expect(five(windows)?.spendUsd).toBe(45);
  });

  it('ignores spend recorded in the future', () => {
    const windows = estimate({
      entries: [{ at: NOW + HOUR, costUsd: 90 }],
      budget: BUDGET,
      now: NOW,
    });
    expect(five(windows)?.spendUsd).toBe(0);
  });
});

describe('spendByModel', () => {
  it('totals cost-equivalent per canonical model inside the window', () => {
    const entries = [
      spend(1, 10, { 'claude-opus-5': 9, 'claude-haiku-4-5': 1 }),
      spend(2, 5, { 'claude-opus-5': 5 }),
      spend(200, 99, { 'claude-opus-5': 99 }),
    ];
    expect(spendByModel(entries, NOW - 5 * HOUR, NOW)).toEqual({
      'claude-opus-5': 14,
      'claude-haiku-4-5': 1,
    });
  });

  it('is empty when no backend reported a breakdown', () => {
    expect(spendByModel([spend(1, 10)], NOW - 5 * HOUR, NOW)).toEqual({});
  });
});

describe('plan budgets', () => {
  it('scales max_5x below max_20x on every window', () => {
    expect(PLAN_BUDGETS.max_5x.fiveHourUsd).toBeLessThan(PLAN_BUDGETS.max_20x.fiveHourUsd);
    expect(PLAN_BUDGETS.max_5x.sevenDayUsd).toBeLessThan(PLAN_BUDGETS.max_20x.sevenDayUsd);
  });

  it('keeps the stated weekly rule wherever the weekly figure is still derived', () => {
    // The rule — seven five-hour windows per week — was a *derivation* adopted
    // because no weekly evidence existed. It still governs every plan in that
    // position, and it is asserted here so that changing one number without the
    // other is a failing build rather than a silent drift between the comment
    // and the constant.
    expect(PLAN_BUDGETS.max_5x.sevenDayUsd).toBe(PLAN_BUDGETS.max_5x.fiveHourUsd * 7);
  });

  it('does not let the max_20x weekly figure be derived from a decision about the five-hour one', () => {
    // max_20x left that position on 2026-08-01. Its five-hour budget became a
    // throughput decision by the operator (250, against a measured ceiling near 162),
    // while its weekly budget stayed where it was — because he was asked about
    // the five-hour window only, and because the weekly evidence points the
    // other way: `utilization` 0.77 at roughly $399 cost-equivalent implies a
    // ceiling nearer $520 than $1120.
    //
    // Applying the ×7 rule here would turn a decision he did make into one he
    // did not, and would raise the weekly cap to $1750 in the same motion. This
    // assertion exists so that doing so is a failing build, and so that the
    // *next* change to either number is a deliberate one.
    expect(PLAN_BUDGETS.max_20x.fiveHourUsd).toBe(250);
    expect(PLAN_BUDGETS.max_20x.sevenDayUsd).toBe(1120);
    expect(PLAN_BUDGETS.max_20x.sevenDayUsd).not.toBe(PLAN_BUDGETS.max_20x.fiveHourUsd * 7);
  });

  /**
   * A week holds 33.6 five-hour windows. A weekly budget at or above that
   * multiple could never bind, which would make the weekly window decorative —
   * and the weekly cap is the one that governs a 24/7 studio.
   */
  it('keeps the weekly window capable of binding before the five-hour one', () => {
    for (const budget of Object.values(PLAN_BUDGETS)) {
      expect(budget.sevenDayUsd).toBeLessThan(budget.fiveHourUsd * 33.6);
    }
  });
});

describe('describeEstimate', () => {
  it('is German, marks a rolling window as such, and marks an anchored one not', () => {
    const windows = estimate({
      entries: [spend(1, 45)],
      budget: BUDGET,
      anchors: { five_hour: NOW + HOUR },
      now: NOW,
    });
    const text = describeEstimate(windows);
    expect(text).toContain('5 h');
    expect(text).toContain('Woche');
    expect(text).toContain('(gleitend)'); // the weekly window has no anchor
    expect(text.split('·')[0]).not.toContain('gleitend'); // the five-hour one does
  });

  it('says so rather than pretending, with nothing to describe', () => {
    expect(describeEstimate([])).toBe('Keine Schätzung verfügbar');
  });
});
