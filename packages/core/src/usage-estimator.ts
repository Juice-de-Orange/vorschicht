/**
 * The estimating meter's producer (§7.1, A6) — reads what runs cost, hands
 * §7.2's guardian a number it can act on.
 *
 * `UsageMeter.ingestEstimate` has existed and been tested since Phase 1; what
 * did not exist was anything that computed the percentage it takes. That gap
 * was harmless while the official source answered and became the thing standing
 * between the studio and any work at all when it stopped (A59): no sample →
 * guardian `wrap_up / no_data` → scheduler starts nothing → no session → no
 * sample. Each link is correct; the cycle is what is wrong, and this closes it
 * from outside without touching the guardian, which §0.3 forbids.
 *
 * The arithmetic is in `@vorschicht/shared/estimate`, pure and exhaustively
 * tested. This class is the wiring: read spend, read anchors, decide, persist.
 *
 * It used to calibrate as well, and that is the one thing it must never do
 * again (A101). The budget in force is the configured budget, full stop. A real
 * refusal is still acted on — but by the *official* path, which is strictly
 * better evidence: `rate_limit_event` frames carry the vendor's own utilisation
 * whenever they carry a number at all, the runner ingests it as an `official`
 * sample (`runner.ts`, gated on `utilization !== null` rather than on the status
 * string, A73.4), and an official sample outranks every estimate in
 * `projectSamples`. Nothing about the studio's response to a genuine limit
 * event was lost by removing the calibration; what was removed is a guess about
 * the *size of the cap* that this process is not in a position to make.
 */
import {
  DEGRADED_WRAP_UP_PERCENT,
  describeEstimate,
  type EstimatedWindow,
  estimate as estimateWindows,
  PLAN_BUDGETS,
  type PlanBudget,
  type PlanProfile,
  type SpendEntry,
  spendByModel,
  type UsageWindowKind,
  WINDOW_NOMINAL_MS,
} from '@vorschicht/shared';
import type postgres from 'postgres';
import type { UsageMeter } from './usage-meter.js';

/**
 * How far back spend is read.
 *
 * The seven-day window is the longest the estimator tracks, so anything older
 * cannot contribute to any reading. A margin is added so that a clock skew or a
 * late-arriving row cannot silently drop spend that still counts — dropping
 * spend reads as budget that is not there.
 */
const LOOKBACK_MS = WINDOW_NOMINAL_MS.seven_day + 60 * 60_000;

export interface UsageEstimatorDeps {
  sql: postgres.Sql;
  meter: UsageMeter;
  /*
   * `eventLog` stood here until A101 and is removed with the calibration it
   * served. The estimator now appends nothing: a dependency nothing reads is
   * the dead wiring §8.2's sixth domain hunts, and leaving it because "a later
   * feature might want it" is how the list of such fields grows.
   */
  /** Which plan's budgets apply (A6). */
  planProfile: PlanProfile;
  /**
   * Budget override, for Controlling's editable figures (A6).
   *
   * Config rather than constant because these numbers are a *decision* — see
   * `PLAN_BUDGETS` for where the defaults come from and how much they are
   * worth. Absent means the plan default.
   */
  budget?: PlanBudget;
  now?: () => number;
  onWarning?: (message: string) => void;
}

export interface EstimateReport {
  windows: EstimatedWindow[];
  /** Cost-equivalent per canonical model over the weekly window (display only). */
  byModel: Record<string, number>;
  /** The budgets used — the configured ones, always (A101). */
  budget: PlanBudget;
  /** German one-liner for the daemon log and the Controlling page. */
  text: string;
}

export class UsageEstimator {
  constructor(private readonly deps: UsageEstimatorDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * The budgets in force.
   *
   * There is deliberately no second source. A getter that could return
   * something other than the configured figure is the shape A101 removed, and
   * the reason it stayed invisible for a week is that the divergence was a
   * *number* rather than a branch: everything downstream kept working, it
   * merely worked against 3 instead of 1120.
   */
  get budget(): PlanBudget {
    return this.deps.budget ?? PLAN_BUDGETS[this.deps.planProfile];
  }

  /**
   * Compute the estimate and feed it to the meter.
   *
   * Called on a timer rather than only after a run, and that matters: a window
   * ages *down* as spend leaves it, and a studio that only re-estimated when it
   * spent something would latch at 80% and never observe itself recovering —
   * the meter's own staleness rule (15 minutes) would then turn the last
   * estimate into `unavailable`, which fails closed forever.
   */
  async sample(): Promise<EstimateReport> {
    const now = this.now();
    const entries = await this.readSpend(now - LOOKBACK_MS);
    const anchors = await this.readAnchors();

    const windows = estimateWindows({
      entries,
      budget: this.budget,
      anchors: anchors.resets,
      now,
    });

    for (const window of windows) {
      await this.deps.meter.ingestEstimate(window.window, window.usedPercent, {
        resetsAt: window.resetsAt,
      });
    }

    return {
      windows,
      byModel: spendByModel(entries, now - WINDOW_NOMINAL_MS.seven_day, now),
      budget: this.budget,
      text: describeEstimate(windows),
    };
  }

  /*
   * `recalibrate` and `readRefusals` stood here until 2026-08-09 (A101).
   *
   * What they did, in the one case they ever ran: an anchor whose status was
   * merely `allowed_warning` — the vendor's *warning*, which A73 documents as
   * carrying a utilisation figure precisely because it is not a refusal — was
   * matched by `WHERE status <> 'allowed'`, and the weekly budget was lowered
   * from 1120 to `Math.floor(3.6356)` = 3. Every subsequent reading was
   * `3.6867 / (3 × 0.9)` = 136%, clamped to 100, and the guardian sat on
   * `hard_stop` for seven days over 3.53 USD-equivalent of actual spend.
   *
   * Three separate faults, so that a future reader does not fix only the first:
   *   1. a deny-list of one (`<> 'allowed'`) treats every unknown status —
   *      including the literal 'unbekannt' the backend writes for a shape it
   *      does not recognise — as a refusal. Fail-open, in a safety device.
   *   2. even for a *genuine* refusal the inference is unsound: the signal is
   *      account-wide and the spend is Vorschicht's own (A60.6), so the derived
   *      cap is our share of the account rather than the account's cap.
   *   3. the lowered figure was never released — the early return skipped the
   *      reset — so a process kept a budget derived from evidence that had
   *      since aged out of its own lookback window.
   */

  /**
   * Every run's cost, at the instant its result arrived.
   *
   * Read from `agent_runs`, which is a view over the append-only event stream,
   * so this is derived from the same source §18 keeps forever and there is
   * nothing to keep in step. A run with no `result` event contributes nothing —
   * correctly: a crashed session that never produced a result also never
   * reported what it cost, and inventing a figure for it would be the one kind
   * of error this meter is built not to make in the other direction.
   *
   * Honest limit, recorded rather than papered over: a session interrupted by
   * §7.3 has spent real budget and left no `result`, so its spend is invisible
   * here. That is the estimator undercounting, which is the dangerous
   * direction — mitigated only by the safety factor and by the fact that
   * wrap-up happens at the *top* of a window, where the remaining headroom is
   * the operator's reserve anyway. Fixing it properly needs per-turn accounting from the
   * stream, which is a Phase 8 job.
   */
  private async readSpend(since: number): Promise<SpendEntry[]> {
    const rows = await this.deps.sql<
      Array<{ spent_at: Date; cost_usd: string | null; by_model: unknown }>
    >`
      SELECT spent_at, cost_usd, by_model
      FROM agent_runs
      WHERE spent_at IS NOT NULL AND spent_at >= ${new Date(since)}
      ORDER BY spent_at ASC
    `;

    return rows.map((row) => {
      const byModel: Record<string, number> = {};
      if (row.by_model && typeof row.by_model === 'object') {
        for (const [model, cost] of Object.entries(row.by_model as Record<string, unknown>)) {
          if (typeof cost === 'number' && Number.isFinite(cost)) byModel[model] = cost;
        }
      }
      return {
        at: row.spent_at.getTime(),
        costUsd: row.cost_usd === null ? 0 : Number(row.cost_usd),
        byModel,
      };
    });
  }

  /**
   * The newest future reset per window.
   *
   * "Future" is the whole point: an anchor that has already passed describes a
   * window that has since rolled over, and using it would place the window
   * start further back than it is and then drop entries belonging to the live
   * window. `estimate` guards this too — twice, because the consequence is an
   * undercount.
   */
  private async readAnchors(): Promise<{ resets: Partial<Record<UsageWindowKind, number>> }> {
    const rows = await this.deps.sql<Array<{ window_kind: UsageWindowKind; resets_at: Date }>>`
      SELECT DISTINCT ON (window_kind) window_kind, resets_at
      FROM usage_window_anchors
      ORDER BY window_kind, resets_at DESC
    `;
    const resets: Partial<Record<UsageWindowKind, number>> = {};
    for (const row of rows) resets[row.window_kind] = row.resets_at.getTime();
    return { resets };
  }
}

/**
 * Does this estimate permit new work?
 *
 * Not a second policy — the guardian remains the only authority, and this is
 * the same threshold it applies to an estimated sample (`DEGRADED_WRAP_UP_PERCENT`,
 * lower than the official 85% precisely because an estimate is worth less).
 * Exported so the daemon can say *why* it is idle in one line without
 * re-deriving the rule, and so a test can assert the two agree.
 */
export function estimatePermitsWork(windows: readonly EstimatedWindow[]): boolean {
  return windows.every((window) => window.usedPercent < DEGRADED_WRAP_UP_PERCENT);
}
