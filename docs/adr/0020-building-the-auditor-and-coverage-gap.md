# ADR 0020 — What building the auditor settled, and why a missing proof is a finding

- **Status:** accepted
- **Date:** 2026-08-01
- **Context:** §8.2 (programme, method, taxonomy, independence), §22 Phase 2 step 9
- **Condenses:** A56, A65

## Decision

1. A phase close always takes domain 1 (`gate_truth`); the other domains rotate by
   least-recently-examined. Phase 9's final gate requires every domain at least once.
2. Gates are addressed by **id** (`P2.G4`, position-derived), never by their text. An unknown
   id changes nothing and says so; the finding survives with its consequence unapplied.
3. The Prüfbericht is **rendered from the structured result**, not written by the model. The
   report is capped; the record is not — the unabridged prose lives on the audit's `finished`
   event, and a truncated report says it was cut.
4. The auditor has `Read`, `Grep`, `Glob` and **no shell at all**. Git evidence arrives through
   collectors that run the real commands and quote them beside their output, and
   `AuditDomain.detail(context, items)` runs *after* the draw so a sampled commit can be shown
   with `git show --stat`.
5. An audit serves no task and therefore runs without MCP (`AgentRunRequest.taskId` may be
   null).
6. `audit_events`/`audit_finding_events` are append-only; `audits`/`audit_findings` are views
   (ADR 0018's precedent). `started` is written before the session spawns. "Re-opened exactly
   once" is `count(*) FILTER (WHERE kind = 'dismissed')`.
7. The taxonomy gains **`coverage_gap`**: a proof the project should have and does not — the
   reason an examination could not conclude. It files a P2 task **unconditionally**.
   `scope_limit` keeps its original meaning, and its silence, for limits that are the
   auditor's own.

## Why

Gate truth is the domain whose consequence — a gate un-ticks and the phase reopens — is the
entire reason an audit sits *between* two phases rather than on a calendar. Matching a model's
paraphrase of a gate line against `CLAUDE.md` would be a fuzzy step immediately before an
irreversible edit, and it fails in the worst direction: a near-match opens a gate nobody was
discussing, in a file nobody re-reads.

§8.2's six report sections map exactly onto fields the auditor already returns; asking for six
headings as well would add a way for report and record to disagree and would make the length
cap a request. `Bash(git log:*)` runs in the session's own scratch directory, which §8.2 rule 2
requires, so every such call would answer "not a git repository" — five tools that read as
covered and could not carry a signal, in the profile whose sixth domain is exactly that.

The first real audit wrote that it could not determine whether the Phase 1 and 2 proofs had
ever run against a real test database. That was not a limit of the auditor: `pnpm gate` never
set `TEST_DATABASE_URL` and 285 of 962 tests were silently skipping (ADR 0022). The taxonomy
had no route for it, and it was closed only because a human happened to read the report. A
`process` finding needs the auditor to name a mechanical guard before work is filed, because
inventing a guard is worse than recording that a rule was broken; a coverage gap carries its
work inherently — "build this proof" — and a read-only auditor is exactly the wrong party to
be required to know the build system well enough to specify how.

## Consequences

- A crashed audit is distinguishable from a clean one because `started` precedes the spawn; a
  restart between two dismissals changes nothing because the count is arithmetic over the log.
- Found by the first run, in the run itself: the auditor set `reopens` to `"Phase 1"` — a
  reasonable reading of an unconstrained string — Postgres refused the `uuid` cast, and a
  complete audit was lost on the way to being recorded. The field now carries a
  contract-enforced pattern (so the §6.3 repair re-prompt can name it) *and* the service
  returns null for a malformed reference. Two layers, because the one outcome §8.2 cannot
  afford is an audit that reached a verdict and never wrote it down.
- Every audit since has closed with an explicit list of scope limits; the sharpest recurring
  one is that the auditor executes nothing — what it judges is what tests and scripts *assert*,
  never that they are green at this commit.
- A `coverage_gap` does not block a phase (P3.G7 closed on `funde_zu_beheben` with two of
  them) but always leaves a task — provided the task survives the run, which is ADR 0021's
  subject.
- The `gate_flip` trigger compares the sha of the tree each gate run checked (A69.3), so "did
  a gate go red → green with no code change in between" became a comparison rather than a
  belief.
- The auditor's own findings are closed on evidence, not by decision: a finding resolves when
  its fix task is genuinely `done`, and "the dev chain accepted the finding" is a judgement that
  needs a session, not the side effect of a finished ticket (A149.9).

## Evidence

- `packages/core/src/audit/domains.ts`, `sampling.ts`, `report.ts` (`REPORT_MAX_CHARS`,
  `renderPruefbericht`), `gate-book.ts`; `packages/shared/src/agent-result.ts` —
  `coverage_gap` among the finding classes.
- `packages/core/src/audit/audit-service.itest.ts`; P2.G8 and P3.G7 in `CLAUDE.md` §22.
