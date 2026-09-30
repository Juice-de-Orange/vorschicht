# ADR 0008 — Concurrency follows the plan profile, and Sparbetrieb is one switch

- **Status:** accepted
- **Date:** 2026-07-31
- **Context:** §6.0 (Sparbetrieb), §6.5, §7.2, §8.2 rule 3
- **Condenses:** A7, A22

## Decision

1. Parallel agent sessions default **per plan profile**: `max_20x` → 2, `max_5x` → 1.
   Range 0–4, adjustable from the Controlling page and by the guardian's wrap-up mode (which
   sets new-session concurrency to 0).
2. **Sparbetrieb** (the emergency low-budget profile) is a single switch: concurrency 1,
   standard model tier for every role except the Reviewer (strongest tier), idle audits off,
   radar reduced to weekly. It is activated manually by the operator or auto-proposed via an
   inbox item when the effective budget shrinks (plan downgrade, a billing-model change caught
   by the radar).
3. The internal auditor (§8.2) is exempt from the tier downgrade; under Sparbetrieb only its
   frequency drops.

## Why

Concurrency is the one knob that converts directly into window consumption, and the two plan
tiers differ by roughly the factor the defaults encode. A single hard-coded number would be
wrong for one of the two accounts; a per-profile default makes a plan switch a config change
rather than a tuning session.

Sparbetrieb is a *profile* rather than a set of individual knobs because the moment it is
needed is the moment nobody wants to reason about six settings. The Reviewer keeps the
strongest tier because everything merges through that gate — cutting review quality to save
budget is how a studio ships regressions cheaply. The auditor keeps its tier for the reason
§8.2 states: cutting the auditor first is how a studio stops noticing.

## Consequences

- Sparbetrieb is applied as a **ceiling after any Controlling override** (A46.2), so an
  override cannot lift a role back above the emergency profile — otherwise the switch would be
  decorative exactly when budget is short. An economy-tier role is never *promoted* by an
  emergency measure.
- The Debugger and the DB specialist (A46) are strong by default — a weak diagnosis after two
  failures produces a confident third failure, and a migration is the one artefact a rollback
  does not undo — but rare enough that Sparbetrieb may drop them to standard.
- Idle audits (§21) switch off under Sparbetrieb while the internal audit does not; they are
  two services, not one flag on `AuditService` (A119.4), precisely because the two rules point
  in opposite directions and one class would get it wrong for one of them.
- Defaults are code (`PLAN_PROFILES` in `packages/shared/src/constants.ts`); the live values
  are rows in the `config` table, audit-logged on every change (§19).
- A plan change also changes the budget denominators of the estimating meter (ADR 0005,
  ADR 0023); those are configured per profile in the same place and are a decision, not a
  discovery.

## Evidence

- `packages/shared/src/constants.ts` — `max_20x: { concurrency: 2 }`,
  `max_5x: { concurrency: 1 }`, with the header stating which knobs live in `config` instead.
- `packages/core/src/scheduler.ts` — concurrency read per tick; outside `normal` nothing new
  starts (§7.2).
- The agent-profile tests (A46) — tier ceiling under Sparbetrieb, Reviewer exemption.
