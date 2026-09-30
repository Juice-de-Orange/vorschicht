# Result contracts (§6.3)

One JSON Schema per agent role, as §6.3 asks for. **Generated — do not edit by
hand.** The source of truth is `ROLE_RESULT_SCHEMAS` in
`packages/shared/src/agent-result.ts`; `pnpm gate:contracts` fails the build when
these files have drifted from it, and `--write` regenerates them.

```
node infra/scripts/gate-contracts.mjs --write
```

## Why they exist as files at all

The runner does **not** read them. §6.2 prescribes
`--json-schema /app/contracts/<role>.result.schema.json`, and on the pinned CLI
(2.1.220) that flag does not take a path — it parses its argument as JSON and
answers `--json-schema is not valid JSON: Unrecognized token '/'`. The runner
therefore passes the schema inline, generated from zod at spawn time (ADR 0002).

What the files are for is review. A change to what an agent is required to
produce should be visible as a diff in a pull request, not only as a change to a
zod expression three call sites away from where it is used. The gate is what
keeps that diff truthful.

## Dialect

Draft-07, not zod's default of draft 2020-12. The pinned CLI's validator cannot
resolve the 2020-12 meta-schema and rejects the whole run at startup:

```
Error: --json-schema is not a valid JSON Schema:
no schema with key or ref "https://json-schema.org/draft/2020-12/schema"
```

`gate:contracts` asserts the dialect on every run, so a zod or CLI bump that
changes it fails the build instead of failing every dev-chain session at 3am.
