# ADR 0019 — The internal audit is a department, not a gate, and it may undo a gate

- **Status:** accepted
- **Date:** 2026-08-01
- **Context:** §8 (department 11), §8.2, §0.2, §22 Phase 2 step 9
- **Condenses:** A52

## Decision

Department 11, the Betriebsprüfung (internal audit), audits the studio's claims about its own
work. It is designed as a control **over** the process rather than inside it:

1. It is not a second Reviewer. The Reviewer reads a diff; the auditor reads the studio's
   claims about itself — gate ticks, evidence lines, run summaries, headline numbers.
2. It may **un-tick an exit gate** in `CLAUDE.md`, the only authority that runs backwards
   through §0's phase discipline. A `gate_invalid` must quote the tick, quote the cited
   evidence and show the gap, and it always reaches the operator as a P1 inbox item rather
   than silently reopening a phase overnight.
3. It has no other power: no writes, no pause, no config, no task control.
4. It is allowed to find nothing and is measured on that: no quota, and Controlling tracks
   confirmed-vs-dismissed in **both** failure directions.
5. It is built in Phase 2, not in Phase 6 with the other staff profiles, and its first run
   audits Phases 0–2 retrospectively rather than administratively reopening two closed phases.

## Why

The operator asked, on 2026-08-01, for an internal auditor that keeps asking exactly the
questions an autonomous build cannot ask itself — after being shown its honest weakness: it
marks its own homework. Every serious defect shipped and then caught belonged to one class:
the test encoded the same misunderstanding as the code, so the gate went green on a claim
nobody had tried to falsify (§8.2 lists four real examples; all four passed their own tests).
More self-testing does not help; only a different party asking a different question does.
Building it as "review, but again" would produce a second opinion on the same question, and
that class survives any number of those.

Without the un-tick authority the role is advisory, and an advisory auditor in an unattended
system is a log line. Without the limit to that one power, the auditor would be the one
component able to erase the evidence of its own mistakes — the separation is the same one that
keeps a coder from approving their own diff. An auditor arriving in Phase 6 would let Phases
2–5 close unexamined, which is the arrangement it exists to prevent; it is buildable in Phase 2
because it needs only the profile machinery, the read-only MCP tools and the event log.

## Consequences

- Every phase from 2 onward closes with an audit as an exit gate of its own. The record so far:
  the audits closing Phases 2 through 8 invalidated ticks in Phases 0, 1, 2, 4, 5, 6 and 8,
  most of them ticks written hours earlier by the same session (ADR 0024, A100, A122, A141,
  A151).
- Silence is not health: finding nothing across several runs while other channels keep finding
  defects is an inbox item just as drift into noise is (§8.2 rule 5). That metric is the only
  thing that distinguishes a working auditor from a broken one from outside.
- The design was validated by its own subject matter in the same commit: the unattended build
  loop decided "the build is finished" with `grep -q ALL_PHASES_DONE` over the whole session
  transcript, so any iteration that read the loop's own prompt file — which documents the
  sentinel, and is the first thing an iteration reads — ended the build. It did, after five
  iterations. A control signal fired by evidence rather than by intent; the loop now reads only
  the final result message's last line and discards a completion claim that `CLAUDE.md`
  contradicts.
- The un-tick has been **refused rather than silently executed** five times so far (A83.6):
  when the audit is handed a project id without a way to look up the project, or the project is
  read-only (ADR 0017), the finding survives as a P1 item and the un-tick is done by hand with
  the auditor's reasoning. The authority is exercised through the operator instead of through a
  file nobody merges — and no finding has been lost that way.
- What building the department settled in detail, and how findings and reports are kept
  durable, is in ADR 0020 and ADR 0021.

## Evidence

- `packages/core/src/audit/` — service, domains, sampling, report, gate book;
  `packages/db/migrations/0013_audits.sql`, `0018_audit_consequences.sql`.
- `docs/pruefberichte/` — the committed reports; P2.G8 in `CLAUDE.md` §22 (first run,
  `phase_nicht_abschliessbar`, two ticks invalidated through `AuditService` unattended).
