# ADR 0023 — The official utilisation figure speaks only above 75 %, and downward budget calibration is removed rather than repaired

- **Status:** accepted
- **Date:** 2026-08-01
- **Context:** §7.1, §7.2, §1 principle 3, A6, ADR 0005 (A60), A64
- **Condenses:** A73, A101

## Decision

1. `rate_limit_event` frames come in two shapes. With `status: "allowed"` they carry no
   utilisation figure; with `status: "allowed_warning"` — above the vendor's own 75 %
   threshold — they carry `utilization` (0–1) and `surpassedThreshold`, for `five_hour` and
   `seven_day` alike. Such a figure is ingested as an **`official`** sample through a dedicated
   `ingestOfficialWindow` that hard-codes the `'fraction'` scale, and it outranks the estimate
   in `projectSamples`. The ingest keys on the **presence of the number**, not on the status
   string.
2. The estimating meter (ADR 0005) governs below 75 %, where being wrong costs throughput.
   Above 75 % the guardian acts on a measurement.
3. A6's "self-calibrating on observed limit events" is **retired**. `calibrateDown` and the
   estimator's event-log dependency are removed; the configured budget is used as given.

## Why

Two earlier assumptions had each read one of the two frame shapes and generalised. Across every
build-loop transcript of 2026-08-01 there were 35 frames: 29 `allowed` without a number,
6 `allowed_warning` every one with a number. The second shape had never been seen because the
account had never been that deep into a window. The official reading is therefore obtainable
under token auth (ADR 0007) — not on demand, not below 75 %, but exactly in the band where
§7.2 has to act.

The calibration defect was found on 2026-08-09 on the running server, not in a test: the
guardian had stood on `hard_stop` for seven days with a few dollars-equivalent of actual spend
against a four-digit weekly budget. Three separate errors: (a) `readRefusals` filtered
`status <> 'allowed'`, so a warning — and any unknown status literal — counted as a refusal,
fail-open in the most safety-critical component; (b) the inference "the account refused, so
our spend so far is the ceiling" is unsound even for a real refusal, because the operator works
on the same subscription and is invisible to this meter (A60.6); (c) an early `return` skipped
releasing a calibration once its evidence had aged out of the look-back window. Result:
`floor(spend)` became the weekly budget, every subsequent reading computed to over 100 % and
was clamped, and 18,411 of 18,747 rows in the permanent event log were the divergence message
of that one mistake. A repair addressing (a) and (c) would leave (b) untouched — the inference
would merely be drawn less often, and a safety device that is rarely wrong is harder to
discover than one that is often wrong. And decision 1 has overtaken the reason the calibration
existed: in the band a calibration was ever for, the vendor's own figure arrives.

## Consequences

- Two official sources, two scales, nothing infers either: `get_usage` reports 0–100, the
  frame 0–1. 0.97 read as "0.97 percent" retires §7.2 in silence, so the two paths are
  separate methods; switching the scale kills three tests by mutation.
- Absence means different things: no figure from `get_usage` is blindness and writes the
  `unavailable` sentinel; no figure in a frame means "below 75 %" and writes nothing. One
  method cannot hold both meanings without a flag that will eventually be passed wrongly.
- **The window ceiling can be measured from the warning band** — stated as the mechanism, not
  as an account figure: if a window shows spend *S* while reported utilisation rises from *a*
  to *b*, the ceiling is roughly *S / (b − a)*. That reading showed the five-hour default in
  ADR 0005 — recorded there as a demonstrated *lower* bound with unknown headroom — had in fact
  been almost exactly the cap. The operator then raised the configured five-hour figure for
  `max_20x` above the measured ceiling, choosing throughput under §7.2's greedy policy; on the
  estimate alone the guardian would then never fire, which is written into the constants file
  in those words. It is safe only because from 75 % upward the estimate is not consulted — the
  two decisions belong together.
- The weekly figure was not asked about and stays as configured; the ×7 derivation rule is
  retired for `max_20x`, with the drift test asserting *that* so the next change is deliberate.
  The weekly evidence points at a different ceiling than the default, with the same caveat
  about the operator's own sessions; that is an open question for the operator, not an edit.
- The studio's response to a real limit event is not weaker for the removal: a refusal frame
  that carries a figure still reaches the guardian immediately. What is gone is a guess about
  the *size* of the ceiling that this process cannot make.
- The regression is an assertion: the time series of 2026-08-02, replayed, yields a fraction of
  a percent instead of 100. Restoring the old code turned 4 of 16 cases red. The old test used
  only `'rejected'` and never knew `allowed_warning` — the error sat in code and test
  identically, §8.2's founding thesis in the component that watches its own budget.
- The cross-check between official and estimate later needed the same age limit the guardian
  uses (`MAX_SAMPLE_AGE_MS`, one constant for both questions) and became one-directional:
  official above estimate is expected, since the official figure includes the operator's own
  sessions; only the impossible direction is reported, and only on a transition (A98, A149).

## Evidence

- `packages/core/src/usage-meter.ts` — `ingestOfficialWindow`, `MAX_SAMPLE_AGE_MS`,
  `projectSamples` ranking; `packages/core/src/backend/headless.ts` — frame parsing keyed on
  `utilization !== null`.
- `packages/core/src/usage-estimator.ts` and `usage-estimator.itest.ts` — no calibration; the
  four regression cases.
- `packages/shared/src/estimate.ts`, `packages/shared/src/constants.ts` — plan budgets as
  configured decisions.
