# ADR 0015 — Contingency backends ship as typed stubs, and a fourth `fake` backend proves the guardian for free

- **Status:** accepted
- **Date:** 2026-07-31
- **Context:** §6.0 (model access layer), §22 Phase 1 step 4 and exit gate 2
- **Condenses:** A31, A37

## Decision

1. The `interactive-pty` and `api-key` backends ship from Phase 1 as **typed stubs**
   implementing the full `ModelBackend` contract (failing fast), wired into the shared backend
   contract-test suite, each with a one-page design note. Actual implementation only ever
   follows an explicit operator decision (§6.0); `api-key` additionally requires revising §2's
   hard rule.
2. A fourth backend, **`fake`**, runs in-process alongside `headless` and the two stubs. It
   must pass the full `ModelBackend` contract suite; the two stubs must fail that same suite
   identically.

## Why

§6.0's reason for the seams is the vendor's paused plan to move programmatic usage off the
subscription. The playbook is that Vorschicht implements its own fallback as its first
emergency task inside the announced notice window — which only works if the slot is prepared:
a typed stub with the interface, a design note, and a contract suite that says what "done"
means. Designing under pressure is what the stubs prevent.

The `fake` backend answers a different problem: Phase 1's exit gate demands that simulated
usage streams prove guardian behaviour *as automated tests*, for both a 5-hour and a weekly
window, without spending subscription budget on every gate run. It doubles as the fault
injector for the adversarial cases — `rate_limits_available: false`, null utilisation, resets
in the past, an 84.9 → 95.1 jump — that a real account cannot be steered into on demand.

## Consequences

- **A fake that drifts from the real thing tests nothing.** Every time a fake was found to
  differ it had hidden a defect: `FakeBackend.resume` reported no tools, so every §6.4
  continuation would have failed the session-tools verdict while the repair leg passed
  (A78.9); `FakeDeployTarget.prune` deleted the release it was serving (A87.1); a usage fixture
  froze a `resets_at` that had long expired, which only surfaced when a new assertion started
  reading the sample's age (A98.5). The contract suite is the mechanism that surfaces these,
  and it is applied to the fake as strictly as to `headless`.
- The contract suite must run against both configurations of a capability switch (A74.3): a
  usage-query case whose only expectation sat inside `if (!supportsUsageQuery)` executed zero
  expectations against the one backend that hard-coded the capability to true. `FakeBackend`
  gained the switch, and the suite runs twice.
- The stubs are a **prepared slot, not dead wiring**: the suite asserts that they fail, which
  is the difference between "not built" and "reads as built" (§8.2 domain 6).
- `interactive-pty` is ToS-grey (it automates the interactive surface) and technically brittle
  (screen-scraping); the design note says so, and the activation decision must include a fresh
  legality and viability assessment at that time.
- `SessionSpec` carries the result schema as a **value** rather than a filename (ADR 0002) so
  the same spec survives a backend swap — an `api-key` backend would put it into a tool
  definition, where a filename means nothing.
- Where a fake would cancel out a shared misunderstanding — "what is serving" after a deploy,
  "did the MCP handshake land" — the proof runs against the real thing instead: a real docker
  daemon (A89), the vendor's own MCP client (ADR 0003). The fake is for the guardian's logic,
  not for the machine's answers.

## Evidence

- `packages/core/src/backend/contract.test.ts` — one suite, applied to `headless`, `fake` and
  the stubs in `packages/core/src/backend/stubs.ts`; `backend/types.ts` — the contract.
- `packages/core/src/backend/fake.ts` — the fault injector; P1.G2 in `CLAUDE.md` §22
  (30 assertions across both windows, no real model call).
