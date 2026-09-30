# ADR 0005 — What the estimating usage meter meters on

- **Status:** accepted
- **Date:** 2026-08-01
- **Context:** §7.1 (usage meter), §7.2 (guardian), A6 (token accounting), A59 (the
  official source stopped answering), ADR 0001 and its addendum

## Problem

§7.1 makes the official rate-limit reading primary and keeps token accounting
"for when official data is missing". On 2026-08-01 official data went missing
(A59): `control_request { get_usage }` answers `rate_limits_available: false` on
the same subscription token that produced real numbers hours earlier. The
guardian correctly fails closed, the scheduler starts nothing outside `normal`,
and the studio therefore idles indefinitely.

`UsageMeter.ingestEstimate` had existed and been tested since Phase 1. Nothing
computed the percentage it takes. Building that producer needed three questions
answered, and A6's one-line description answers none of them:

1. What unit? A6 says "token accounting".
2. Where does a window begin, with no `resets_at` from the official source?
3. What is the denominator — how large is a plan's budget?

## Decision 1 — the unit is cost-equivalent USD, not raw tokens

**Measured, from a real result message of this repository's own build loop:**

```json
"usage": { "input_tokens": 200,
           "cache_creation_input_tokens": 231069,
           "cache_read_input_tokens": 19213630,
           "output_tokens": 108360 },
"total_cost_usd": 14.629604,
"modelUsage": {
  "claude-opus-5[1m]":        { "costUSD": 14.627505, "canonicalModel": "claude-opus-5" },
  "claude-haiku-4-5-2025...": { "costUSD":  0.002099, "canonicalModel": "claude-haiku-4-5" } }
```

`input_tokens` is **200**. `cache_read_input_tokens` is **19.2 million**. The
`headless` backend emitted only the first pair, so a meter built on `tokensIn +
tokensOut` would have read `108_560` for a session that consumed roughly
19.5 million tokens of context — about 0.5% of the truth, in the direction that
authorises spending that is not there.

Summing all four raw numbers instead is better and still wrong: one Opus output
token and one Haiku cache-read token differ by roughly three orders of magnitude
in what they consume, and §7.1's per-model weekly caps exist precisely because
the two are not fungible. `total_cost_usd` is the vendor's own weighting of
exactly those four numbers. It is populated under subscription auth, nothing is
billed (§2 is unaffected; the account has overage disabled, verified), and A32
already relies on it for `--max-budget-usd`.

**So: token accounting with the weights applied**, which is what A6 meant.

Consequence, found while wiring it: `agent_runs.cost_usd` has read
`(payload ->> 'costUsd')` off the `result` event since migration **0003** and the
runner never wrote that key. The column was NULL on every run this system has
ever recorded — a view column with no producer, §8.2's sixth domain, found by
needing it. Migration 0014 adds the cache columns and `by_model` beside it.

## Decision 2 — window boundaries come from `rate_limit_event`, else roll

The CLI still emits `rate_limit_event`. Since A59 it carries no percentage,
which makes it useless to the official meter and decisive for this one:

```json
{"type":"rate_limit_event","rate_limit_info":{
  "status":"allowed","resetsAt":1785578400,"rateLimitType":"five_hour", ...}}
```

Across 18 such frames in this repo's build logs the `resetsAt` values were
10:00, 15:00 and 20:00 UTC — **aligned five-hour boundaries**, not "five hours
after your first message". So `resetsAt − 5h` is the window start *exactly*, and
the five-hour estimate is not an approximation at all. Verified live: the
daemon's very first estimate after this change was already anchored, because the
§6.1 smoke session supplies the anchor before the estimator runs.

No `seven_day` frame has ever been observed, so the weekly window falls back to
a **rolling** sum over the last seven days. That is sound rather than a guess:
a fixed window that has not yet reset began at some `T0` with
`now − length < T0 ≤ now`, so `[T0, now] ⊆ [now − length, now]` and the rolling
sum is ≥ the true one. It over-counts and cannot under-count. A property test
asserts exactly that, over every possible boundary position.

An anchor whose `resetsAt` lies in the *past* is discarded rather than used: it
describes a window that has since rolled over, and anchoring on it would move
the window start backwards and then drop entries belonging to the live window —
an undercount by construction. Guarded twice, in the pure function and in the
query that feeds it.

## Decision 3 — the denominator is a decision, and it defaults to what was demonstrated

`max_20x.fiveHourUsd` defaults to a **measured** figure: on 2026-08-01 this
repo's build loop spent a known amount of cost-equivalent inside a single
five-hour window (10:00–15:00 UTC) while all 18 rate-limit frames in that
period said `status: "allowed"`. That amount is a demonstrated lower bound on
the real cap, and it became the default (anonymised example: on the order of
150 cost-equivalent units per five-hour window; the configured value lives in
`packages/shared/src/constants.ts`).

A safety device defaults to what has been demonstrated rather than to what is
plausible, because the two errors are not symmetric: too low costs idle time,
too high costs the uncontrolled limit event §1 principle 3 forbids.

`sevenDayUsd` is the least-evidenced number in the system and is derived by a
stated rule rather than invented: **seven times the five-hour budget** — one
full five-hour window's spending per day, sustained. A week holds 33.6 such
windows, so this is ~21% of the theoretical maximum, which matches what weekly
caps are for (bounding continuous 24/7 use — exactly what this studio is). A
test asserts the rule holds and that the weekly figure can still bind.

`max_5x` is both figures scaled by 5/20.

### The asymmetry, stated plainly

Calibration can lower a budget and can never raise one:

- **Down:** an anchor with `status ≠ allowed` means the account refused at the
  spend accumulated in that window, so that spend *is* the cap.
- **Up:** impossible by construction. The guardian stops the studio at
  `0.9 × 0.75 = 67.5%` of the configured figure, so a larger one can never be
  demonstrated, and reading "we did not hit the wall" as "the wall is further
  away" is the inference that produces the event this whole subsystem exists to
  prevent.

**The configured number is therefore a decision, not something the system can
discover.** It is config-editable and the question is with the operator, raised
as an inbox decision with these measurements attached.

## What this does not see

Two blind spots, reported rather than mitigated:

1. **The operator's own usage is invisible.** The estimator observes
   Vorschicht's runs; the operator works on the same subscription and §1
   principle 3 reserves 5% for them. The estimate is a lower bound on *account*
   usage by construction. The official meter did not have this problem — it was
   account-wide.
2. **An interrupted session leaves no `result`,** so its spend is invisible. A
   §7.3 wrap-up happens at the top of a window where the remaining headroom is
   the operator's reserve anyway, but this is an undercount and it is the dangerous
   direction. Fixing it properly needs per-turn accounting off the stream, which
   is Phase 8 work.

Both are why the estimate is thresholded against `DEGRADED_WRAP_UP_PERCENT`
(75%) rather than §7.2's official 85%, and why §7.2 itself was not touched.

## Consequences

- New: `packages/shared/src/estimate.ts` (pure), `packages/core/src/usage-estimator.ts`
  (wiring), migration 0014, `usage_window_anchors`.
- `BackendEvent`'s `result` gains `cacheReadTokens`, `cacheCreationTokens`,
  `costUsd`, `byModel`; a new `rate_limit_anchor` event carries the boundary.
- `projectSamples` now ranks candidates — fresh official, else fresh estimate,
  else blind — because a timer-driven estimate would otherwise mask every
  official reading, and an `unavailable` sentinel (stored as `source:
  'estimated'`) would otherwise mask the estimate.
- `seven_day_model` is **not** estimated. §7.1 asks for it "where the plan
  defines them" and without the official reading nothing says what the plan
  defines. Per-model spend is computed and exposed for Controlling, but does not
  reach the guardian. Recorded as a scope limit, not omitted quietly.
