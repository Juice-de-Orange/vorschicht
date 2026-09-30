# Personas: do they cost quality?

**Observation on §22 Phase 6, exit gate 7** · dated observation from 2026-08-10 · script: `infra/scripts/check-persona-ab.mjs`

This is a dated observation about a gate that has since been ticked (P6.G7). It is deliberately
not updated to the present — a measurement that is adjusted to the current state is no longer a
measurement.

The gate sentence reads:

> Persona A/B check: identical task with personas on (display-only) vs fully off produces
> equivalent-quality results (spot comparison documented) — personas verifiably cost nothing

That splits into two questions, and only one of them needs a model call at all.

---

## 1. The pair the gate sentence names — answered without a model call

"Display" and "Off" differ **exclusively** in what the UI renders. At neither of the two levels
does §8 put a persona sentence into a prompt. `renderSystemPrompt` is the only place where a
prompt can differ, and there the following holds:

```
✓ 18 Profile, Prompt byte-identisch (5807 Zeichen bei "qa")
```

(18 profiles, prompt byte-identical, 5807 characters for `qa`.)

That is not a sample but an assertion over the **whole** profile table, and it runs in
`pnpm gate` as:

`packages/core/src/profiles/profiles.test.ts` →
*"sends byte-identical prompts with personas off, for every profile (A9)"*

Two real runs could not improve on that. They could only show that two **identical** prompts
behave identically — which they do, because they are the same bytes. So this part of the gate is
proven mechanically, not empirically: A9's sentence "quality must never compete with theater" is
thereby checkable rather than believed.

Counter-check in the same script, so that the assertion is not satisfied by a function that
ignores its argument:

```
✓ Stufe "prompt" stellt 139 Zeichen voran und lässt den Auftrag unangetastet
```

(Level `prompt` prepends 139 characters and leaves the mandate untouched.)

**Mutation executed:** the early `return` in `renderSystemPrompt` removed, so that the persona
sentence is always prepended. Three cases go red, among them

```
AssertionError: expected 'You are Bruno. You take nothing on th…'
                to be 'You are an agent of Vorschicht, an au…'
```

— and that is the evidence that the assertion covers the whole table and not only the two
profiles the older cases name explicitly (Bruno is touched by none of them).

---

## 2. The pair that *can* differ — two real sessions

The only interesting comparison is "Display" against "Display and prompt", because that is the
only configuration in which the persona layer touches a session at all.

**Setup.** Same task, same model (`haiku`), same tools (none), same working directory, same
profile (`qa` — Quentin's character sentence is the most opinionated in the table; a blander one
would have picked the case least likely to fail). Single variable: the 139 prepended characters.

**Task.** Deliberately factual rather than a matter of taste, so that "equivalent" hangs on
something checkable: a `pytest` suite exits with code 0 while 60 % of its files skipped
themselves via `pytest.skip` (A61 and A79.4 — the same defect in two repositories). Two
questions: may a gate count that as green, and which single metric is missing?

**Runs.** CLI 2.1.226, 2026-08-10.

| Level | Run id | Exit | Duration | Equivalent |
|---|---|---|---|---|
| Display (without persona sentence) | `1e34188c-eb2f-4471-894d-4dc5983ab97f` | 0 | 12.9 s | 0.0233 USD-eq. |
| Prompt (with persona sentence) | `ebdf44e2-a89c-49a2-a6e0-5ef8c0be4d1e` | 0 | 11.7 s | 0.0231 USD-eq. |

*("USD-equivalent" is the vendor's weighted summary of the tokens, not money spent — §2's hard
rule stands, nothing is billed. A60.1.)*

**Result.** Both sessions arrive at the same answer, in both parts:

* Question 1 — both: **No**, with the same reasoning (exit code 0 means "nothing failed", not
  "everything was checked"; the skipped third is a false green signal).
* Question 2 — both: the **number or share of skipped tests**, and both add unprompted that the
  threshold must be set explicitly.

The differences are in wording ("silent failure risk" versus "false green signal"), not in
content, care or structure. The run with the persona sentence was marginally **faster** and
minimally cheaper; with two runs that is noise and is mentioned here only so that nobody takes
the figures for a statement.

---

## What this proves — and what it does not

**Proven:** at the levels "Off" and "Display", the persona layer demonstrably costs *nothing*,
because the prompt is the same byte for byte. That is the half that matters, because it is the
default and the level below it.

**Observed:** at the level "Prompt", the character sentence changed nothing of substance in this
pair.

**Not proven, explicitly:**

1. **Two runs are not a distribution.** The gate sentence asks for a "spot comparison
   documented", and this is no more than that. A quality difference that shows up in one of
   twenty runs is invisible with this setup.
2. **One model, one profile, one task.** What was tested is `haiku` with the `qa` profile. About
   the strongest tier, about long sessions with tools, and about the roles whose verdict a merge
   waits on, this run says nothing.
3. **The task has a correct answer.** That is exactly what makes it usable — but a task with
   room for judgement is the case in which a character sentence is most likely to have an
   effect, and that one was not run.

Anyone who wants to sharpen this runs the same script with `--model sonnet` and over several runs
per level. As long as "Display" is the default (A9), nothing hangs on it: the level that could
cost something is the one the operator has to switch on explicitly — and the page tells them so
right there.

## Repeating

```
node infra/scripts/check-persona-ab.mjs [--model haiku|sonnet]
```

Exit 0 = ran and compared · 1 = finding (byte equality violated, or a run without a usable
result) · 2 = nothing checked, so no verdict (A25).
