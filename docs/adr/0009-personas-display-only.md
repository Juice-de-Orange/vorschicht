# ADR 0009 — Personas are display-only by default; quality never pays for theatre

- **Status:** accepted
- **Date:** 2026-07-31
- **Context:** §8 (agent profiles), §17.2 (office view), §2 (language policy)
- **Condenses:** A9

## Decision

- Every department has a default persona (name, avatar) for the office view. By default the
  persona is **display-only**: it is rendered on screen and never enters a prompt.
- Persona flavour text in prompts is **opt-in** (`personaFlavorInPrompts`); when enabled it
  may only *prepend* to the role mandate, never edit it (A46).
- A full off switch exists: neutral role labels on screen, nothing in prompts.
- The three levels are one enum, not two independent switches (A119.7).

## Why

The office view is a monitoring surface, and a persona is a good label for a desk. But a name
in a system prompt is tokens that carry no engineering content, and a model told "you are
Rita" is being told something that is neither true nor useful. §1 puts quality first; "quality
never pays for theatre" is the shortest form of that priority applied here.

Two switches would have made representable the one state the word *fully* excludes: neutral
labels on screen while "You are Rita" still sits in the prompt — paying the cost of the layer
without any of its benefit. An enum with three values cannot express it. The named price: that
combination is no longer configurable.

## Consequences

- The persona layer is provably free: with flavour off, `systemPromptAppend` is
  **byte-identical** to `profile.systemPrompt` for every profile — not "does not contain the
  name", which a prompt differing by a blank line would satisfy. The assertion is derived over
  `PROFILE_IDS` rather than enumerated, so a new profile is covered automatically, and the
  counter-case (flavour on changes the prompt) stands beside it, without which the first
  assertion says nothing. That is the mechanical form of A9 (P6.G7).
- The A/B comparison the exit gate asks for was run on the pair that *can* differ (flavour on
  vs off), because display-only and fully-off produce byte-identical prompts and a model
  comparison between them would only show that two equal prompts behave equally. Documented in
  `docs/personas-ab-vergleich.md` with two real run ids: same answer in both parts,
  differences only in wording.
- The two Coders in §8's table (Clara and Chris) are one profile at two desks, recorded as
  `persona.alternates`, so the office view keeps both names without the model mapping gaining
  a second entry that could drift (A46).
- All user-facing persona text renders in German (§2); role ids and prompts stay English.

## Evidence

- `packages/shared/src/personas.ts` — the `PersonaMode` enum and
  `parsePersonaModeSubmission`; `personas.test.ts`.
- P6.G7 in `CLAUDE.md` §22 — 67 test cases, byte-identity assertion, documented A/B run.
