# ADR 0025 — "Docs current" is held against the spec by a script, for the half of it that is number and form

- **Status:** accepted
- **Date:** 2026-08-18
- **Context:** §0.6, §22 (every phase's "docs current" gate), §8.2 domains 1 and 2, A38
- **Condenses:** A134, A152

## Decision

`infra/scripts/gate-doku.mjs` is the twelfth gate step. It checks:

1. The project's status document carries a written-out **tally line** with A38's three states
   (green · deferred · open), and the tally matches the count of `[x]`, `[~]` and `[ ]` in
   `CLAUDE.md` §22. The tally is a human's claim and is compared, never computed — a number the
   script derives itself is right by construction and checks nothing.
2. Every ticked **and** every deferred gate line ends with an evidence bracket.
3. Fewer than 40 gate lines found is exit 2, not a finding: the format changed, and the count
   is no statement. Without this the step would pass over a restructured document and read as
   "docs current" — §8.2's sixth domain applied to the tool itself.
4. In every companion document that states a phase (A152): any claim of the form
   "Phases 0–N closed" / "Phase N under way", in either language, is held against
   `geschlossenBis` — the highest N for which phases 0..N carry no `[ ]` **without a gap**;
   every gate id mentioned must exist in §22; and an id on the **same line** as a deferral word
   must really be `[~]`. Anything under `docs/archiv/**` or below a `<!-- archiv -->` mark —
   until the next `## ` heading — is never checked.

It deliberately does **not** check whether an evidence bracket is *true*. No script can, and
pretending to would be the class it is built against; §8.2's first domain is exactly that
question and needs an auditor who reads the artefact. The script takes the mechanical half so
the auditor's session goes to the other.

## Why

Two exit gates failed on exactly this: P5.G8 ("docs current" ticked, the status document not
updated) and P6.G8 (ticked with the sentence "docs in the same commit as the ticks", while the
same file listed five ticked gates where six stood) — both found by the auditor twenty minutes
after the tick, both invisible to every test because an evidence line is read only by a human
or the auditor (ADR 0024). The auditor proposed the guard at the end of its Phase 6 report.

Then, on 2026-08-25, the gate *number* was right in every guarded file because the script held
it, while the gate *sentence* was wrong in five documents because nothing held it: they said
"Phase 8 under way" while §22 listed all eight of its gates as `[x]` or `[~]`, two named the
same wrong five deferred ids (the counter was satisfied, five equals five), and one
contradicted itself inside a table cell. A guard that holds the number and not the sentence
beside it is half a guard, and A94 records why that is worse than none: a gap readable as a
gap costs hardening; a gap readable as protection costs trust in every other assurance next to
it.

## Consequences

- The tally line lives in **running text**, not an HTML comment: an invisible mark is not
  updated exactly when it matters. Same construction as the drift check between the
  performance-budget JSON and its document (A107).
- The first run against the real documents was red as it should be: no tally line yet, and
  **one** of 53 ticked lines without evidence. That it was one and not twenty is the
  precondition under which the assertion is viable at all — a permanent red is a red everyone
  learns to skip.
- It was not wired into `gate.mjs` on the day it was written, on purpose: the document
  contradictions had to stand until the auditor had formed its judgement on the artefact
  (§8.2 method: evidence before claim), and a step that reddens every run for two files an
  implementer may not write is a step that gets disabled. No `gate:doku` npm script existed
  before the caller did (A71's form). Wired after the audit; it rejected the author's first
  tally line, which said 53 where 52 were counted.
- The archive exception has two cases, and the second is the one you leave out: a mark that
  silently applies to the rest of the file is a guard switched off with one line. Chronicles
  carry sentences that were true when written; without the exception every historically
  correct line is a false alarm, and a false alarm that accuses a healthy artefact is the most
  expensive failure a check can have — three times in three days (A150.5, A151.5, A152.3).
- "Same line", not "same vicinity": an approximation produces exactly the false alarms that
  make a guard untrustworthy, and merely *mentioning* an id says nothing about its state. Where
  a sentence had to mention a ticked gate next to the word "deferred" (a negation), the
  **text** was changed rather than the rule (A155.5) — the named price is a line the guard
  cannot check.
- Stated limit: a phase status split across table columns is not found. The cell was corrected
  by hand; a pattern reading table rows would be an approximation, which the previous point
  forbids.
- Mutations run, and one killed less than expected: removing the "Phases 0–N" loop kills one
  case, not two — the "under way" check is its own loop and needed its own mutation. Reported
  as measured rather than made to sound stronger.
- The guard runs after a session's documentation changes, not before: a green run over the
  code with the appendix appended afterwards let a duplicate assumption number ship once
  (A140), caught by `gate-book.test.ts` on the next run.

## Evidence

- `infra/scripts/gate-doku.mjs` with `gate-doku.test.ts`; step twelve in
  `infra/scripts/gate.mjs`.
- `packages/core/src/audit/gate-book.ts` — the §22 parser both the auditor and the guard use
  (`parseGates`).
- P3.G6, P6.G8 and P8.G4 in `CLAUDE.md` §22 — the re-ticks that name the script.
