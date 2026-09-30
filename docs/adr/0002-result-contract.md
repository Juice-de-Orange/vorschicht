# ADR 0002 — How a role's result contract reaches the CLI

- **Status:** accepted
- **Date:** 2026-08-01
- **Context:** §6.2, §6.3, Phase 2 step 2
- **Evidence:** four probes against CLI **2.1.220** (the pinned version) on
  subscription auth. Two cost nothing — they fail during argument validation,
  before any request. Two were one-turn `haiku` sessions, ~0.05 USD each.

## The question

§6.3 left one item open and marked it "Phase 1 verification":

> Confirm whether `--json-schema` combines with `stream-json` on the pinned
> version. If yes → used everywhere. If it is JSON-mode-only → long dev-chain
> sessions keep `stream-json` with the v1.0 prompt-based contract plus one
> repair `--resume`.

Phase 2 step 2 is where the result contracts get built, so it is answered here.
Three further facts turned up alongside it, and two of them would each have
broken every dev-chain session at spawn time.

## What we found

### 1. `--json-schema` does combine with `stream-json` — §6.3's fallback is not needed

A one-turn session with `--output-format stream-json --verbose --json-schema
<inline>` produced a normal stream ending in a `result` message carrying a
populated `structured_output` field. The same worked under `--output-format
json`. The prompt-based contract and the repair `--resume` that §6.3 held in
reserve are therefore not required for long sessions; the single mechanism is
used everywhere, as §6.3 preferred.

### 2. The flag does **not** take a file path — §6.2's prescribed invocation is wrong

§6.2 writes `--json-schema /app/contracts/<role>.result.schema.json`. The flag
parses its argument as JSON:

```
$ claude -p --json-schema /definitely/missing-schema.json …
Error: --json-schema is not valid JSON: JSON Parse error: Unrecognized token '/'
```

There is no path handling to fall back to; a filename is simply invalid JSON.
The schema is therefore passed **inline**, and `SessionSpec` carries it as a
value rather than as a filename. That is also the shape that survives a backend
swap (A31): an `api-key` backend would put the same schema into a tool
definition, where a filename would mean nothing.

### 3. Draft 2020-12 is rejected outright — the dialect must be draft-07

zod's `toJSONSchema` emits draft 2020-12 by default. The CLI's validator cannot
resolve that meta-schema:

```
Error: --json-schema is not a valid JSON Schema:
no schema with key or ref "https://json-schema.org/draft/2020-12/schema"
```

Both `draft-07` and a schema with no `$schema` key at all were accepted. We emit
draft-07 explicitly, because a contract that states its own dialect is one fewer
thing to infer, and because `gate:contracts` can then assert it — a zod or CLI
bump that changes the dialect fails the build rather than failing every session.

This is the one that would have hurt most: it is not a degraded result, it is
the run dying during argument validation, for every role, on every attempt.

### 4. Structured output is produced by a `StructuredOutput` tool call — and it is exempt from `--allowedTools`

The mechanism is visible in the stream: the model calls a tool named
`StructuredOutput` whose input *is* the result object, and the CLI answers
`Structured output provided successfully`.

The obvious worry is that §6.2's per-role tool whitelists would deny it, leaving
an agent unable to finish. They do not. A session run with `--allowedTools Read`
— which grants nothing else — still produced `structured_output`, with
`permission_denials: []`. Recorded because the opposite conclusion is the
tempting one: adding `StructuredOutput` to every role's whitelist would look
prudent and would in fact widen five whitelists for no reason.

## Consequences

- `SessionSpec.resultSchema` is a JSON Schema **value**; `resultSchemaPath` is
  gone. Only the `headless` backend knows the CLI wants it stringified.
- `roleJsonSchema(role)` generates from the zod schema with `io: 'input'` and
  `target: 'draft-7'`. Input mode matters separately: in output mode zod marks
  every `.default()` field as required, and the model omitting `artifacts: []`
  would fail a run for leaving out an empty list.
- `contracts/*.result.schema.json` stays checked in, per §6.3, but the runner
  does not read it. Its purpose is review — a change to what an agent must
  produce should be visible as a diff — and `gate:contracts` is what keeps that
  diff truthful.
- §6.2's invocation example in `CLAUDE.md` is inaccurate on this point. It is
  left as written (the spec is the operator's document) and corrected here and in A47.

## Aside: a defect this found

The probe stream showed one assistant turn arriving as **two** `assistant`
messages sharing a `message.id` — a thinking block, then a `tool_use` block. The
backend-side turn counter of A32 incremented per message, so a single turn
counted as two and a cap of *n* fired at roughly *n/2*. Fixed to count distinct
message ids, with `headless.test.ts` covering both directions.
