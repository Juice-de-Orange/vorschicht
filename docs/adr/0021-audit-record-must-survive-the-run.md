# ADR 0021 — The audit record must survive the run: reports are named by id, and a real audit needs a persistent database

- **Status:** accepted
- **Date:** 2026-08-02
- **Context:** §8.2 (finding taxonomy, the Prüfbericht), §18, ADR 0020, ADR 0024
- **Condenses:** A92, A117

## Decision

1. The committed Prüfbericht is named `<date>-<audit-id-prefix>-<domain>.md`; name and heading
   are derived from the same constant (`ID_PREFIX`). It is written with `flag: 'wx'` so a
   collision fails the run instead of replacing an older report. A repository-wide test reads
   `docs/pruefberichte/` and requires every report's first line to carry the id in its own
   filename.
2. `run-audit.sh` **refuses** a real run without `DATABASE_URL` (exit 2) instead of starting a
   throwaway Postgres. `--dry-run` may still use the throwaway, because it files nothing.
   `infra/scripts/audit-db.sh` provides the persistent database the refusal demands.

## Why

A phase close always takes `gate_truth` (ADR 0020), and there is no reason two phases cannot
close on the same day. On 2026-08-02 exactly that happened: Phase 3 closed (audit `5d60476e`,
`funde_zu_beheben`), Phase 4 closed (audit `67ac096c`, `phase_nicht_abschliessbar`), and the
second report — named `<date>-<domain>.md` — overwrote the first. P3.G7's evidence line then
pointed at a document about a different audit, with a different verdict and a different
sample: the worst kind of dead link, because it resolves and is wrong. The collision case is
the normal case, not the exception.

An audit is half a write. §8.2's consequences are tasks, cards and counts: a `coverage_gap`
files a P2 task unconditionally, a `gate_invalid` a P1 card, and "re-opened exactly once" is a
count that only means something if it outlives the run. The Phase 3 audit filed four evidenced
findings as P2 tasks into a throwaway database that was deleted seconds later while the run
reported success (ADR 0024); they were rescued only because a human read the committed report
— the mechanism ADR 0020 declared insufficient. The committed report carries the prose well;
what it cannot carry is a task somebody works on.

## Consequences

- The overwritten Phase 3 report was **restored from history**, not regenerated: re-running an
  audit would have been more expensive *and* wrong, because what is asked for is the evidence
  of what was examined then. Every evidence line was re-pointed at the report it means.
- The first drift test survived the mutation `slice(0, 6)` in the heading — `toContain(short)`
  is one-directional, a shorter prefix is inside the longer one. Only with the delimiters
  (`-${head}-`) is it an equality. Recorded because A74.3 found the same weakness in three
  tests: an assertion that checks one direction reads like one that checks both.
- The existence test is the only one of the three that would have gone red on the tree
  *before* the repair, and the reason the finding got a guard rather than a rename. It had to
  state its own exception when the reports directory gained an index file: reports are
  recognised by name pattern, and the set of non-reports is asserted as `['README.md']` — a
  `!== 'README.md'` shortcut would let a misnamed report escape as "not a report", shown by
  mutation (A153.6).
- "Refused" and "could not start" differ by exit code, and 2 means *nothing checked*
  (ADR 0013) — true here, and something a 1 would falsely claim. Both branches were executed.
- With a database per run, every dismissal is forever the first: §8.2's "exactly once"
  arithmetic only works over a database that outlives the run. On 2026-08-24 three P2 tasks
  survived their audit for the first time (A146.4).
- The audit's transcript had the same failure one level down: the run's `transcriptsRoot`
  pointed into the scratch directory that the run's own `finally` deleted, so every audit
  session's transcript was gone as soon as the audit finished, while `agent_runs` still pointed
  at it (A150.6). It now lands in the transcripts volume; the scratch cwd stays, because §8.2
  rule 2 requires it. Found by the restore drill, which is what a restore drill is for.
- Three reports existed only as a database column, two of them the sole runs of their domain;
  they were exported byte-for-byte (`md5` against the column) and the reports index now says
  where each run's evidence does *not* exist (A153).

## Evidence

- `packages/core/src/audit/report.ts` — `pruefberichtDateiname` beside `renderPruefbericht`;
  `report.test.ts` — the three assertions.
- `infra/scripts/run-audit.sh` (refusal), `run-audit.mjs` (`flag: 'wx'`), `audit-db.sh`.
- `docs/pruefberichte/` — reports carry the id in name and heading.
