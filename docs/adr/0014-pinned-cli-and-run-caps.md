# ADR 0014 — The CLI is pinned to an exact version, and run caps are enforced by the backend, never by a flag alone

- **Status:** accepted
- **Date:** 2026-07-31
- **Context:** §3 (CLI pinning), §6.2 (hard caps), §7.3 step 1, §6.6
- **Condenses:** A27, A32

## Decision

1. The orchestrator image pins an exact Claude Code CLI version (≥ 2.1.214, the stream-json
   exit-drain fix). Updates are never automatic; they arrive as radar tasks through the normal
   gates (§11), and flag semantics are re-verified on every bump.
2. Every run carries **three independent caps**, all enforced by the `ModelBackend`:
   - `maxTurns`, passed as `--max-turns`;
   - `maxBudgetUsd`, passed as `--max-budget-usd` (documented; result subtype
     `error_max_budget_usd`), sized per role by a rule (`maxTurns × 0.4 USD`, A46.5) and
     inert-safe when `total_cost_usd` is 0 under subscription auth;
   - a backend-side turn counter and wall-clock deadline derived from the event stream,
     enforced via `control_request { subtype: "interrupt" }` followed by a 60 s SIGTERM grace
     on the **process group**.
3. Hooks are never used for turn capping; they remain containment-only (§6.6).

## Why

The vendor is actively evolving headless behaviour. A pinned CLI plus fully explicit flags is
what keeps the runner deterministic; an unpinned one would replace the model access layer's
runtime unattended — which is also why every container carries the watchtower opt-out label
and every image is pinned by digest (A34).

`--max-turns` was removed from `--help` on 2.1.220 but still parses and still yields result
subtype `error_max_turns`. It is therefore treated as an **unsupported surface**: useful, and
one release away from vanishing. A cap that can vanish silently is not a cap, so a `pnpm gate`
contract test asserts both parse acceptance and a real `error_max_turns` result, making a CLI
bump that drops the flag fail the build instead of uncapping every run.

The backend-side cap is the only one that needs no CLI support and the only one that stops a
run *gracefully* — §7.3 step 1 requires "finish the current atomic step, never mid-edit", and
only an interrupt through the control channel can do that. Stop-hook semantics are
block-to-continue and themselves capped, which is the wrong tool for a hard ceiling. The budget
cap is a backstop, not a throttle: the guardian (§7.2) is the real budget authority, and the
only shape this cap catches is the one the guardian is blind to — few turns, enormous context,
repeating.

## Consequences

- `gate:cli-contract` runs the pinned binary with each flag paired with a deliberately unknown
  one, so argument parsing is checked without a session, a token or any budget (A127.7). The
  gate image carries the CLI for that reason alone.
- One assistant turn arrives as several `assistant` messages sharing a `message.id`; the first
  turn counter incremented per message and fired at roughly *n/2*. Counting distinct ids fixed
  it, with `headless.test.ts` covering both directions (ADR 0002).
- The CLI does not exit after its result while stdin is open (A51.5): without closing stdin
  every run would hold a concurrency slot for its full wall clock — 90 minutes for a Coder —
  and be recorded as a timeout rather than as done. The backend closes stdin on the result.
- `AgentRunRequest.capsCeiling` is a ceiling in both directions of use: a call site cannot
  raise a Coder to 500 turns any more than it can lower it below the profile (A53.7).
- The self-check compares the running CLI against `CLAUDE_CLI_VERSION` at daemon start; the
  Phase 0 demo script did not until the second audit found the gate text claiming it
  (ADR 0024).
- A CLI bump is a real change to what every session can do: the radar files it as an ordinary
  task, the gates run, the contract tests decide. The billing/CLI radar demo (P6.G3) asserts
  that a seeded CLI release becomes a task and **not** an inbox card.

## Evidence

- `infra/scripts/gate-cli-contract.mjs`; `packages/core/src/backend/headless.ts` and
  `headless.test.ts` (turn counter over distinct ids, stdin close, interrupt + grace);
  `apps/orchestrator/src/self-check.ts` (`assertPinnedCliVersion`).
- `infra/docker/Dockerfile.orchestrator` and `Dockerfile.gate` — the same pinned version, held
  together by `infra/scripts/gate-image-pins.test.ts`.
