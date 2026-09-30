/**
 * The estimating usage meter (A6, §7.1's fallback) — pure arithmetic.
 *
 * §7.1 makes the official rate-limit reading primary and keeps token accounting
 * "for when official data is missing". As of 2026-08-01 official data *is*
 * missing: `control_request { get_usage }` answers `rate_limits_available:
 * false` on the same token that produced real numbers hours earlier (A59, ADR
 * 0001 addendum). The guardian therefore fails closed and the studio idles,
 * which is correct and which nothing here weakens. This module is the way out
 * that §7.1 already designated.
 *
 * Everything is a pure function over recorded spend, for the same reason
 * `evaluateGuardian` is: the number that decides whether an autonomous system
 * starts work must be reproducible from the event log alone, with no clock of
 * its own and no I/O.
 *
 * Three properties this file exists to guarantee
 * ----------------------------------------------
 *
 * 1. **It cannot silently undercount.** Every approximation leans towards
 *    reporting *more* usage than was measured. An estimate that reads low
 *    authorises spending that is not there, and the failure mode is the
 *    uncontrolled limit event §1 principle 3 forbids; an estimate that reads
 *    high costs idle time, which is visible and recoverable.
 *
 * 2. **It never derives a budget at all.** The configured figure is used as
 *    given. Until 2026-08-09 this module also ratcheted a plan budget *down* on
 *    a "throttled window proves the cap was reached at that spend" inference;
 *    A101 removed it, because that inference is only sound if our spend is the
 *    account's spend, and property 3 says in the next paragraph that it is not.
 *    Unchanged and still stated plainly rather than hidden: the configured
 *    number is a decision, not a discovery.
 *
 * 3. **It says what it could not see.** The estimator observes Vorschicht's own
 *    runs. The operator works on the same subscription (§1 principle 3 reserves 5% for
 *    him) and his interactive sessions are invisible here, so the estimate is a
 *    lower bound on *account* usage by construction. `basis` carries that, and
 *    the dashboard's budget-confidence indicator (§7.1) reads it.
 */
import {
  DEGRADED_WRAP_UP_PERCENT,
  ESTIMATE_SAFETY_FACTOR,
  type PlanBudget,
  type UsageWindowKind,
  WINDOW_NOMINAL_MS,
} from './constants.js';

/**
 * One recorded unit of spend — a finished run leg, at the moment it finished.
 *
 * `costUsd` is the whole run's `total_cost_usd`, attributed to the instant the
 * result arrived rather than spread over the run's duration. Attribution at the
 * *end* is the conservative choice for a window that has just reset: a session
 * that straddles a boundary counts entirely against the newer window, so the
 * newer window over-counts and the older one — already spent — under-counts
 * nothing that can still be spent.
 */
export interface SpendEntry {
  /** Epoch milliseconds the spend was recorded. */
  at: number;
  costUsd: number;
  /** Cost-equivalent per canonical model, when the backend reported it. */
  byModel?: Readonly<Record<string, number>>;
}

/** Where a window's boundary came from — the difference between exact and safe. */
export type WindowBasis =
  /** Anchored on an observed `resets_at`, so the window start is exact. */
  | { kind: 'anchored'; windowStart: number; resetsAt: number }
  /**
   * No anchor: the window is treated as rolling over the last `WINDOW_NOMINAL_MS`.
   *
   * This over-counts and cannot under-count, which is why it is an acceptable
   * fallback rather than a guess. Proof: a fixed window that has not yet reset
   * began at some `T0` with `now - length < T0 ≤ now`, so `[T0, now]` is a
   * subset of `[now - length, now]` and the rolling sum is ≥ the true one.
   */
  | { kind: 'rolling'; windowStart: number };

export interface EstimatedWindow {
  window: UsageWindowKind;
  modelClass: string | null;
  /** 0–100, against the safety-adjusted budget. */
  usedPercent: number;
  spendUsd: number;
  /** The safety-adjusted denominator actually used. */
  budgetUsd: number;
  /**
   * When this window's reading will next fall below the wrap-up threshold.
   *
   * For an anchored window that is the observed reset. For a rolling window it
   * is computed from the spend timeline — the instant enough old entries have
   * aged out — because the alternative (`null`, letting the guardian's latch
   * fall back to a full nominal window) would rest the studio for five hours
   * over spending that expires in twenty minutes. §7.2's weekly policy is
   * explicitly greedy; resting longer than the data requires is not caution,
   * it is waste. Null when the window is below the threshold anyway.
   */
  resetsAt: number | null;
  basis: WindowBasis;
}

export interface EstimateInput {
  /** Every recorded spend entry. Entries outside every window are ignored. */
  entries: readonly SpendEntry[];
  budget: PlanBudget;
  /**
   * The newest observed reset for a window, when one is known.
   *
   * The CLI's `rate_limit_event` still carries `resetsAt` and `rateLimitType`
   * even though it no longer carries a percentage (A59), and the observed
   * five-hour resets land exactly on aligned boundaries (10:00, 15:00, 20:00
   * UTC), so `resetsAt - 5h` is the window start rather than an approximation
   * of one. No `seven_day` frame has ever been observed, so that window falls
   * back to rolling.
   */
  anchors?: Readonly<Partial<Record<UsageWindowKind, number>>>;
  now: number;
}

/** Windows the estimator produces. See the `seven_day_model` note in `estimate`. */
const ESTIMATED_WINDOWS: ReadonlyArray<{ window: UsageWindowKind; budgetKey: keyof PlanBudget }> = [
  { window: 'five_hour', budgetKey: 'fiveHourUsd' },
  { window: 'seven_day', budgetKey: 'sevenDayUsd' },
];

/**
 * Estimate every tracked window from recorded spend.
 *
 * `seven_day_model` is deliberately **not** estimated. §7.1 asks for it "where
 * the plan defines them", and without the official reading nothing says what
 * the plan defines: a per-model cap invented here would either idle the studio
 * on a number with no evidence behind it or, set generously, do nothing at all.
 * The per-model spend is still computed and returned by `spendByModel` so
 * Controlling can show it — visible, but not load-bearing. Reported as a scope
 * limit rather than quietly omitted.
 */
export function estimate(input: EstimateInput): EstimatedWindow[] {
  return ESTIMATED_WINDOWS.map(({ window, budgetKey }) =>
    estimateWindow(window, input.budget[budgetKey], input),
  );
}

function estimateWindow(
  window: UsageWindowKind,
  nominalBudgetUsd: number,
  input: EstimateInput,
): EstimatedWindow {
  const length = WINDOW_NOMINAL_MS[window];
  const anchor = input.anchors?.[window] ?? null;

  // An anchor is only usable while it is in the future: a `resets_at` that has
  // already passed describes a window that has since rolled over, and treating
  // it as current would place the window start further back than it is and
  // then *drop* entries that belong to the live window. Stale anchors fall
  // back to rolling, which over-counts instead.
  const basis: WindowBasis =
    anchor !== null && anchor > input.now
      ? { kind: 'anchored', windowStart: anchor - length, resetsAt: anchor }
      : { kind: 'rolling', windowStart: input.now - length };

  const inWindow = input.entries
    .filter((entry) => entry.at > basis.windowStart && entry.at <= input.now)
    .sort((a, b) => a.at - b.at);

  const spendUsd = inWindow.reduce((sum, entry) => sum + Math.max(0, entry.costUsd), 0);
  const budgetUsd = Math.max(0, nominalBudgetUsd) * ESTIMATE_SAFETY_FACTOR;
  const usedPercent = budgetUsd > 0 ? clampPercent((spendUsd / budgetUsd) * 100) : 100;

  return {
    window,
    modelClass: null,
    usedPercent,
    spendUsd: round(spendUsd),
    budgetUsd: round(budgetUsd),
    resetsAt: projectRelief(usedPercent, inWindow, spendUsd, budgetUsd, basis, length),
    basis,
  };
}

/**
 * When will this window stop blocking work?
 *
 * Anchored: at its reset, which is observed fact. Rolling: at the moment enough
 * of the oldest spend has aged out for the reading to fall back under the
 * wrap-up threshold — walked forward over the actual entries rather than
 * extrapolated, so the answer is a time at which the condition is genuinely
 * false and not merely likely to be.
 *
 * Returning a time that is too *early* is harmless by construction: the latch
 * clears, the guardian re-evaluates against a freshly computed sample, and a
 * window still over the threshold latches straight back. Returning one that is
 * too late idles the studio for nothing, which is the failure this function
 * exists to avoid.
 */
function projectRelief(
  usedPercent: number,
  inWindow: readonly SpendEntry[],
  spendUsd: number,
  budgetUsd: number,
  basis: WindowBasis,
  length: number,
): number | null {
  if (usedPercent < DEGRADED_WRAP_UP_PERCENT) return null;
  if (basis.kind === 'anchored') return basis.resetsAt;
  if (budgetUsd <= 0) return null;

  const target = (DEGRADED_WRAP_UP_PERCENT / 100) * budgetUsd;
  let remaining = spendUsd;
  for (const entry of inWindow) {
    remaining -= Math.max(0, entry.costUsd);
    // This entry leaves the rolling window `length` after it was recorded; at
    // that instant everything at-or-before it has gone too, since the list is
    // in time order.
    if (remaining < target) return entry.at + length;
  }
  // Every entry has to age out. The last one decides.
  const last = inWindow[inWindow.length - 1];
  return last ? last.at + length : null;
}

/**
 * Cost-equivalent per canonical model over a window, for Controlling's display.
 *
 * Not fed to the guardian — see the `seven_day_model` note on `estimate`.
 */
export function spendByModel(
  entries: readonly SpendEntry[],
  since: number,
  now: number,
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const entry of entries) {
    if (entry.at <= since || entry.at > now) continue;
    for (const [model, cost] of Object.entries(entry.byModel ?? {})) {
      totals[model] = round((totals[model] ?? 0) + Math.max(0, cost));
    }
  }
  return totals;
}

/*
 * `calibrateDown` stood here until 2026-08-09 and is deleted rather than left
 * unused, because an exported function with no caller is the dead wiring §8.2's
 * sixth domain hunts. The reasoning is A101; the two-line version is that it
 * concluded "the account refused, therefore our spend so far is the cap" from
 * an account-wide signal and a Vorschicht-only measurement, and that the one
 * time it ever fired it lowered the weekly budget from 1120 to 3 and stopped
 * the studio for seven days.
 *
 * Do not reintroduce it without reading A101 first. What replaced it is not a
 * safer calibration but *no* calibration: since A73 the vendor's own utilisation
 * governs from 75% upward, which is the band a calibration was ever for.
 */

/** German summary for the Controlling page and the daemon log (§2). */
export function describeEstimate(windows: readonly EstimatedWindow[]): string {
  if (windows.length === 0) return 'Keine Schätzung verfügbar';
  return windows
    .map((w) => {
      const label = w.window === 'five_hour' ? '5 h' : 'Woche';
      const exact = w.basis.kind === 'anchored' ? '' : ' (gleitend)';
      return `${label} ≈ ${w.usedPercent.toFixed(1).replace('.', ',')} %${exact}`;
    })
    .join(' · ');
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 100;
  return round(Math.min(100, value));
}

function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}
