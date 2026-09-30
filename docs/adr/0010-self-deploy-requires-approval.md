# ADR 0010 — Deploying Vorschicht onto itself always requires the operator's explicit approval

- **Status:** accepted
- **Date:** 2026-07-31
- **Context:** §12 (Self-management), §8.2 (Cadence), §15
- **Condenses:** A12

## Decision

The Vorschicht repository is onboarded as a project with `selfManaged: true` and merges under
the normal gates like any other project. A **deploy** of that project, however, never runs
unattended: the deploy engine raises an inbox item and the rollout proceeds only when the
operator chooses the approval option. This applies every time, with no standing approval and
no expiry.

## Why

An autonomous system must not hot-swap its own brain unsupervised. Every other project's
rollback restores a previous release of *that* project; a bad self-deploy replaces the
component that would perform the rollback. The approval is cheap — one card, one tap — and it
is the only place where a human is guaranteed to look at what the studio is about to become.

## Consequences

- The refusal is enforced by the **task's state**, not by the engine remembering: raising the
  card moves the task out of `deploying`, so from the second tick on the engine is not asked
  at all. The honest assertions are therefore "nothing swapped, nothing *built*, exactly one
  card" over five ticks (A90.4) — a refusal that happens after the artifact was built is a
  different, weaker guarantee.
- **"Answered" is not "approved."** The first implementation read `state === 'answered'`, so
  the option "Not yet — later, by hand" released the deploy. It now reads
  `chosenIndex === APPROVE_INDEX`, and a free-text answer never approves: "go ahead" and
  "absolutely not" are both prose, and inferring consent from prose for the most consequential
  unattended action in the system would be guessing (§1 principle 6). `APPROVE_INDEX` is an
  exported constant with its own assertion that `options[APPROVE_INDEX].title === 'Ausrollen'`,
  so a reordered option list cannot silently approve (A93.5–6). The same defect existed in the
  migration-stop card, there over the *recommended* option, and was fixed the same way with its
  own constant (A97).
- The approval card carries the internal auditor's verdict (§8.2 cadence: "before any
  self-deploy"), so the operator answers with the audit in hand.
- The approval source is **not** in `POLICY_MEMORY_SOURCES`: §15's policy memory would
  otherwise answer the second self-deploy from the first one's precedent, and this is the one
  question that must be asked every time. The design sign-off card was given its own source
  for the same reason (A137).
- While the self-managed project is `read_only` (ADR 0017) the dev chain never reaches this
  card; the rollout script for the production host takes the operator's approval as a named
  argument and **records** it, so it is on file what the rollout relied on (A136).

## Evidence

- `packages/core/src/deploy/service.ts` — `APPROVE_INDEX`, `awaitingDecision`;
  `packages/core/src/deploy/service.itest.ts` — "Not yet" does not roll out and raises no
  second card, free text does not roll out, option title pinned.
- `apps/orchestrator/src/build-scheduler.itest.ts` — the five-tick refusal and the approved
  rollout through the daemon's real wiring.
- P5.G7 in `CLAUDE.md` §22.
