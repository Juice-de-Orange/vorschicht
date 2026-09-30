# ADR 0013 — Gate failures are classified as finding or infra, and a step declares which exit-code convention it speaks

- **Status:** accepted
- **Date:** 2026-07-31
- **Context:** §11 (Rules), §22 Phase 3 step 3, §9 (red path)
- **Condenses:** A25, A50, A67

## Decision

1. Every gate execution distinguishes a **finding** (red, blocker semantics — §11 has no
   warning mode) from an **infra failure** (network, registry, runner environment). Infra
   failures retry up to 3× with backoff and never count as red; a persistent infra failure
   raises an Ops alert and the task stays queued.
2. The convention "exit 1 = finding, exit 2 = infra" is **ours** and only the scripts under
   `infra/scripts/` follow it. Each gate step therefore declares `classify: 'a25'` or
   `classify: 'any-failure'`; third-party tools (`tsc`, `biome`, `vitest`, `vite build`) are
   `any-failure` — any non-zero exit is a finding.
3. The retry lives where the classification is made — **per step** inside `GateSuite.run` —
   with a wall-clock budget for the whole run, and the Ops alert is counted from the event log
   and fires exactly once.

## Why

A docker daemon that was unreachable for ten seconds proves nothing about the change.
Colouring the task red would requeue it at lower priority and, on the second such outage,
escalate to the operator with a Debugger diagnosis of a defect that does not exist. But "run it
again and hope" on a real finding is a warning mode arriving through the back door — invisible,
because the symptom would be a gate that is simply green more often. The two classes need
different responses, and the retry must never touch a finding.

`tsc` exits 2 on a plain type error. Before A50, `pnpm gate` reported every type error as
"INFRA — not a code problem": non-zero, so nothing shipped broken, but labelled as the class to
retry rather than block on. Applied to an onboarded project it would have retried a type error
three times and left the task queued instead of red. The safe direction is deliberate: a
misread infra failure costs a pointless investigation, a misread finding ships.

## Consequences

- **Per step, not per suite.** A suite-level retry re-runs the project's whole test command —
  up to fifteen minutes, three times — to learn whether docker came back. The proof counts
  executions on disk, not the `attempts` number the loop reports about itself.
- **The retry stops on green**, asserted separately: a loop that always ran three attempts
  would pass every "did it recover" test while wasting two container starts per recovery.
- **Five minutes per run, shared across its steps**, because the merge queue holds a
  per-project advisory lock for the whole suite (A55.2) and every second of backoff is
  borrowed from every other candidate. When the budget cuts the loop short, the step's detail
  line says so — a truncation nobody can see reads as "we tried everything".
- **Discarded attempts survive into the record**: `GateStepResult` carries `attempts` and
  `retries`, and `gate.finished` carries them even for a green step. A gate that needs three
  attempts on every merge is a machine problem hiding inside a green run.
- **The Ops alert counts consecutive infra requeues from `task_events`**, not from memory —
  the process doing the retrying is the one restarted while a machine is down (a deploy is a
  restart), and a counter that resets on restart never reaches its threshold. It fires on the
  attempt that crosses `OPS_ALERT_AFTER_INFRA_ATTEMPTS` and not above it: a channel that
  pushes every fifteen seconds while a registry is unreachable is a channel that gets muted.
  The same half was missing in the dev chain (A84): four tasks failed every 15 s for two hours
  with nobody told.
- **"Never started" is a third fact** (A125): a binary that could not be spawned is `infra`
  regardless of `classify`, because `spawn` errors had surfaced as exit 2 and turned four
  unstartable steps into four findings on a machine without the toolchain. `spawned` is a
  field, not a code, and it outranks everything, even exit 0.
- A missing gate command on a locked baseline gate is a **finding** (the configuration is
  incomplete), while a binary that could not be started is `infra` (A55.3). A gate session
  that ran and produced nothing usable is a finding; one that could not run is never green
  (A63.5). The migration gate is retried like any other step, so an infra failure there can
  cost up to three sessions — the same bargain every role already makes.
- Found while closing a related gap: `tsconfig.test.json` was referenced by nothing, so no test
  file had ever been typechecked. `gate:typecheck` now runs it; fifteen errors surfaced and
  were fixed.

## Evidence

- `infra/scripts/gate.mjs` — `classify` per step; `infra/scripts/gate-verdict.mjs` — the pure
  verdict including `spawned`, with `gate-verdict.test.ts`.
- `packages/core/src/gate-suite.ts` — per-step retry, wall-clock budget, `attempts`/`retries`
  on `gate.finished`; `gate-suite.test.ts` — five unit assertions pinning the loop.
- `packages/core/src/merge-queue.itest.ts` — a persistent simulated outage keeps the task in
  `merge_queue` across four attempts with `retryCount` 0 and no `red` anywhere in its
  lifecycle, raising exactly one `ops.alert`; a real failing test on the same candidate still
  goes red. P3.G3 in `CLAUDE.md` §22.
