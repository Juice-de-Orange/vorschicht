# ADR 0003 — The internal MCP server races the CLI, and loses with the vendor SDK

- **Status:** accepted
- **Date:** 2026-08-01
- **Context:** §3, §6.2, §13, Phase 2 step 3
- **Evidence:** six probes against CLI **2.1.220** (the pinned version). Four
  cost nothing — the `system:init` message arrives before the model is
  consulted, so a probe reads one line and kills the session. Two were one-turn
  `haiku` sessions, needed to establish what an agent actually *does* when its
  tools are missing.

## The questions

§6.2 prescribes `--mcp-config /app/mcp/vorschicht.json` and §22 asks for
"Internal MCP server v1". Four things had to be established before writing it,
none of which the spec settles and all of which fail silently when wrong.

## What we found

### 1. Dots become underscores in the exposed name — and only there

A server registering `claims.list` is offered to the model as
`mcp__vorschicht__claims_list`, and the `tools/call` that comes back over
JSON-RPC carries the original `claims.list`. So the server registers dotted
names, `whitelistNames` performs the substitution, and the two agree.

**The substitution is not injective.** A probe server registered three tools —
`task.get_context`, `task_get_context` and `claims.list` — and the CLI offered
two. The collision is resolved silently, with no warning in the stream and no
entry in `mcp_servers`. `assertNoWhitelistCollision` runs at module load so a
future addition fails the import instead.

### 2. The MCP child's environment merges over the parent's, and blanking works

Probed by having a server dump its environment:

| what was tested | result |
|---|---|
| variable inherited from the orchestrator | present |
| variable set in the config's `env` block | present |
| variable set to `""` in that block | present, empty |
| `${VAR}` in a value | expanded from the parent |

So `DATABASE_URL` arrives by inheritance and is deliberately **not** written
into the config file (§19 — the file has no access control worth the name), and
`CLAUDE_CODE_OAUTH_TOKEN` is actively blanked: this process talks to Postgres,
never to Anthropic.

### 3. A server that is not connected by `system:init` leaves the first turn with no tools

This is the finding that changed the design. With a server that stalls its
handshake, `system:init` reports `status: "pending"` and **zero** of its tools.
The model is then told, in effect, that the tools do not exist. Two one-turn
sessions:

| handshake delay | init status | what the session did |
|---|---|---|
| 12 s | `pending` | answered "the vorschicht MCP server is still connecting … the claims list tool cannot be called", and stopped — one turn spent, nothing done |
| 2.5 s | `pending` | recovered: the tool became available on a later turn and the call succeeded |

So `pending` is not fatal, but it is not cosmetic either. The first turn is
blind, and whether the session recovers or gives up is the model's choice, not
ours. For a Reviewer capped at 30 turns that is a wasted run on a metered
subscription — and it is exactly the "half measure" §1 principle 2 forbids,
because the run neither finishes nor parks nor escalates.

### 4. The vendor SDK loses that race about half the time

Timing, measured on the build host with a wrapper recording process start:

| | |
|---|---|
| CLI spawns the server → CLI emits `init` | ~400 ms |
| `@modelcontextprotocol/sdk/server` import alone | 317 ms |
| spawn → `initialize` answered, SDK server | 424–494 ms |
| `@vorschicht/db` import (Drizzle + schema) | 879 ms |
| `@vorschicht/core` barrel import (pg-boss, backends, git) | 174 ms |

Five consecutive handshakes with the SDK build: three `pending`, two
`connected`.

## The decision

**The wire is hand-rolled; the vendor SDK stays as the client in tests.**

`packages/mcp/src/protocol.ts` implements `initialize`, `tools/list`,
`tools/call`, `ping` and notification handling directly over stdio — about 150
lines, the exact surface the CLI uses. Two subpath exports remove the rest of
the startup cost: `@vorschicht/db/sql` (a connection without Drizzle) and
`@vorschicht/core/agent` (the services without the queue and the backends).

Result: spawn → `initialize` answered in **179–352 ms**, and eight consecutive
handshakes against the real CLI all `connected` with all seven tools visible.

What the SDK was providing — protocol conformance — is kept and strengthened
rather than dropped. `server.itest.ts` spawns the real `main.js` and drives it
with the SDK's own `Client` over real stdio against a real Postgres, so every
response is validated against the vendor's schemas. That is a better check than
running the SDK on both ends, where a shared misunderstanding cancels out.

**And the runner does not rely on winning.** The `headless` backend now emits a
`session_ready` event from `system:init`, carrying the MCP statuses and the tool
list; `assessSessionTools` turns that into a verdict. A session that started
without its tools is an infra failure to retry (§11, A25), never a red task —
nothing about the work was wrong.

## Consequences

- `@modelcontextprotocol/sdk` moves to `devDependencies`. The orchestrator image
  no longer carries it or its 87 transitive packages (express, hono, ajv).
- We own protocol conformance across CLI upgrades. Three things guard it: the
  vendor client in `server.itest.ts`, the unit tests in `protocol.test.ts` for
  the paths a healthy client never takes, and `check-mcp-handshake.mjs`, which
  asserts against the real CLI that the server connects and all seven tools are
  visible — for free, without a model turn.
- `SUPPORTED_PROTOCOL_VERSIONS` is an explicit list. An unrecognised revision
  gets our newest rather than an echo, because echoing a version we have never
  tested against is a claim we cannot back.
- Startup cost is now a property worth protecting. A future import added to
  `@vorschicht/core/agent` — or a heavy dependency in `shared` — puts the race
  back in play, and the symptom will be sessions that occasionally do nothing.
  `check-mcp-handshake.mjs` is what catches it.
