/**
 * Project-wide constants that safety logic depends on.
 *
 * These are deliberately not "configuration": the guardian thresholds in
 * particular are the contract from §7.2, and §0.3 forbids weakening a gate to
 * make something pass. Operational knobs that *are* meant to move (concurrency,
 * model mapping, Sparbetrieb) live in the `config` table instead.
 */

/** Every schedule, report and window boundary in this system (§2). */
export const TIMEZONE = 'Europe/Vienna';

/**
 * Guardian thresholds, in percent of a usage window (§7.2).
 *
 * The 5% above HARD_STOP is the operator's personal reserve, not slack for Vorschicht —
 * see §1 principle 3. Raising these is a spec change, not a tuning decision.
 */
export const GUARDIAN_THRESHOLDS = {
  /** ≥ this: no new tasks start, running work executes the wrap-up protocol. */
  WRAP_UP_PERCENT: 85,
  /** ≥ this: Vorschicht's budget is spent; sessions get 60s grace then die. */
  HARD_STOP_PERCENT: 95,
} as const;

/** Grace period a running session gets after `hard_stop` before termination (§7.2). */
export const HARD_STOP_GRACE_MS = 60_000;

/**
 * When the official meter is unavailable we fall back to token estimation,
 * which is less trustworthy — so we also stop earlier (§7.1 fail-closed).
 */
export const DEGRADED_WRAP_UP_PERCENT = 75;

/** Usage windows the guardian tracks. The tightest governing window wins (§7.1). */
export const USAGE_WINDOWS = ['five_hour', 'seven_day', 'seven_day_model'] as const;
export type UsageWindowKind = (typeof USAGE_WINDOWS)[number];

/**
 * Nominal length of each window, used only as a fallback.
 *
 * A latch normally clears when the observed `resets_at` passes. But a reading
 * can arrive without one — the field is optional, and the endpoint is
 * experimental — and a latch with no reset time would never clear at all. That
 * turns fail-closed into fail-forever: the studio would stay shut with no path
 * out short of someone editing the database.
 *
 * So an unknown reset falls back to the window's own length. Erring long is
 * deliberate; the point is that the state is bounded, not that it is prompt.
 */
export const WINDOW_NOMINAL_MS: Record<UsageWindowKind, number> = {
  five_hour: 5 * 60 * 60_000,
  seven_day: 7 * 24 * 60 * 60_000,
  seven_day_model: 7 * 24 * 60 * 60_000,
};

/** Default parallel agent sessions per subscription plan (A7). */
export const PLAN_PROFILES = {
  max_20x: { concurrency: 2 },
  max_5x: { concurrency: 1 },
} as const;
export type PlanProfile = keyof typeof PLAN_PROFILES;

/**
 * A6's safety factor: only this share of a plan budget is treated as spendable.
 *
 * Applied to the *denominator*, so the reported percentage comes out higher than
 * the raw ratio — an estimate that errs reports more usage than it measured,
 * never less.
 */
export const ESTIMATE_SAFETY_FACTOR = 0.9;

/**
 * Plan budgets for the estimating meter (A6), in **cost-equivalent US dollars**
 * per window — the figure `total_cost_usd` reports, not money that is billed.
 *
 * Why dollars and not tokens
 * --------------------------
 * A6 says "token accounting", and the literal reading is wrong in a way that is
 * dangerous rather than merely imprecise: one Opus output token and one Haiku
 * cache-read token differ by roughly three orders of magnitude in what they
 * consume, and §7.1's per-model weekly caps exist precisely because the two are
 * not fungible. `total_cost_usd` is the vendor's own weighting of exactly those
 * tokens, it is populated under subscription auth (observed), and A32 already
 * relies on it for `--max-budget-usd`. So this is token accounting with the
 * weights applied, which is what A6 meant.
 *
 * Where the numbers come from, and how much to trust them
 * -------------------------------------------------------
 * These are **decisions, not measurements**, and the honest reading of the
 * evidence is that they sit above the real ceiling. That is deliberate and it
 * is safe only because of A73; read both halves before changing anything.
 *
 * *What was measured.* On 2026-08-01 this repo's build loop spent $157.28
 * cost-equivalent inside the five-hour window ending 22:00 CEST, and the
 * vendor's own `rate_limit_event` reported `utilization` rising 0.91 → 0.97 in
 * that same window. So the true five-hour ceiling is around **$162**
 * cost-equivalent. An earlier reading of the 10:00–15:00 window ($160.33, all
 * frames `allowed`) was recorded as a demonstrated *lower* bound with unknown
 * headroom above it; the warning frames show there is essentially none.
 *
 * *What was decided.* the operator chose 250 on 2026-08-01, after being shown the
 * measurement, for throughput: §7.2's weekly policy is explicitly greedy and he
 * would rather the studio work than idle. At 250 the guardian's degraded
 * threshold lands near $169 — i.e. **above** the measured ceiling, so on the
 * estimate alone it would never fire. Written down plainly because a safety
 * number that cannot fire must not look like one that can.
 *
 * *Why that is nonetheless defensible.* Since A73 the guardian no longer
 * depends on this number in the band where it matters. Above the vendor's 75%
 * warning threshold `rate_limit_event` carries the real percentage, it is
 * persisted as an `official` sample, and `projectSamples` ranks official above
 * estimated — so from 75% upwards §7.2 acts on a measurement and these figures
 * stop being consulted. Their remaining job is the range *below* 75%, where
 * being wrong costs throughput rather than a limit event. Should the pushed
 * figure ever stop arriving, this comment is the reason to put 162 back.
 *
 * `sevenDayUsd` is the least-evidenced number here and is **not** part of that
 * decision — the operator was asked about the five-hour window only, so the previous
 * rule (seven times the five-hour budget) is deliberately left standing at its
 * old base rather than rescaled to 1750 behind his back. Note for whoever
 * revisits it: on 2026-08-01 the seven-day window reported `utilization` 0.77
 * while this loop had spent ~$399 cost-equivalent in total, which points at a
 * weekly ceiling nearer $520 than $1120 — with the caveat that the operator's own work
 * on the same subscription is invisible to this meter and inflates the account
 * side of that comparison.
 *
 * `max_5x` is the old figures scaled by the plan multiplier, 5/20, and is also
 * untouched: the 250 decision was made against an observed 20x window and
 * carrying it over would be inventing evidence for a plan nobody has measured.
 *
 * All four are config-editable (A6) and the estimate is thresholded against
 * `DEGRADED_WRAP_UP_PERCENT`, not the official 85%. Raising them is the operator's call
 * and belongs on the Controlling page.
 */
export interface PlanBudget {
  /** Cost-equivalent USD spendable in one five-hour window. */
  fiveHourUsd: number;
  /** Cost-equivalent USD spendable in one seven-day window. */
  sevenDayUsd: number;
}

export const PLAN_BUDGETS: Record<PlanProfile, PlanBudget> = {
  // 250 is the operator's decision of 2026-08-01, not a measurement — see above.
  max_20x: { fiveHourUsd: 250, sevenDayUsd: 1120 },
  max_5x: { fiveHourUsd: 40, sevenDayUsd: 280 },
};

/** Concurrency is adjustable by Controlling, but only inside this range (A7). */
export const CONCURRENCY_RANGE = { min: 0, max: 4 } as const;

/**
 * Where one inbox card lives, for everyone who names it (§15, §17.5).
 *
 * Here rather than in either half that uses it, because both halves used to own
 * a copy and the copies disagreed: `inboxUrl` built `/inbox/<n>` while the
 * dashboard routed `/posteingang`, so **every deep link in every notification
 * landed on the overview** — §15's "deep link straight to the item" and the exit
 * gate that names it, both defeated by two string literals in two packages.
 *
 * The drift was invisible because each side tested its own literal. What catches
 * it now is one constant plus a test that spans the packages: build a URL with
 * `inboxUrl` and read the number back out of its path with the dashboard's own
 * parser. Nothing shorter than that crossing could have failed.
 */
export const INBOX_PATH = '/posteingang';

/** ntfy topics (§16). Names are also the env-var suffixes. */
export const NTFY_TOPICS = {
  inbox: 'vorschicht-inbox',
  alerts: 'vorschicht-alerts',
  info: 'vorschicht-info',
} as const;
export type NtfyTopic = keyof typeof NTFY_TOPICS;

/** Task priorities (§8/§9). P0 is "wake the operator up", P3 is "whenever". */
export const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type Priority = (typeof PRIORITIES)[number];

/**
 * Idle audits only run when the queue is empty, the guardian is `normal`, and
 * usage is below this (A17).
 */
export const IDLE_AUDIT_MAX_USAGE_PERCENT = 50;

/**
 * Minimum Claude Code CLI version (A27). Below 2.1.214 the stream-json exit
 * drain is broken, which would truncate results at exactly the wrong moment.
 */
export const MIN_CLI_VERSION = '2.1.214';

/**
 * Secret file patterns agents may never read, anywhere in the mount (§6.6/A21).
 * Extendable per project via config — never shrinkable below this list.
 */
export const SECRET_READ_DENY_GLOBS = [
  '**/.env',
  '**/.env.*',
  '**/*.pem',
  '**/*.key',
  '**/id_rsa*',
  '**/id_ed25519*',
  '**/*.p12',
  '**/credentials*',
  '**/secrets*',
  '**/.npmrc',
  '**/.git-credentials',
] as const;
