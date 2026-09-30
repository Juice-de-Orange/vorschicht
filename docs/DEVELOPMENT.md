# Development

Vorschicht is a pnpm monorepo (Node 22, TypeScript `strict`, Biome, Vitest, Playwright). The
project's own quality gate (`pnpm gate`, CLAUDE.md §11) is a POSIX tool by design and runs inside a
container that mirrors the orchestrator image — same node digest, same pinned gitleaks and Claude
CLI, unprivileged uid, no docker socket (A117, A127).

## Prerequisites

- Docker with Compose v2 (the gate, the demo scripts and the integration tests use it)
- Node 22 and pnpm 11 via `corepack enable` (for editing, `pnpm fix`, and the few host-side scripts)
- Optional: the Claude Code CLI on the host for the paid `pnpm check:*` scripts

```bash
git clone https://github.com/Juice-de-Orange/vorschicht.git
cd vorschicht
pnpm install
```

## The gate

```bash
infra/scripts/gate-in-container.sh              # all twelve steps, ~6 min on a warm cache
infra/scripts/gate-in-container.sh --only=typecheck,lint,test
infra/scripts/gate-in-container.sh --fail-fast
infra/scripts/in-container.sh <command>         # anything else in the same environment
```

The twelve steps, in order: typecheck (builds `packages/*/dist`) · lint (`biome check
--error-on-warnings`) · unit tests · integration tests against a real Postgres (`*.itest.ts`) ·
secrets scan (gitleaks over history and tree) · migrations (append-only guards, grants) · result
contracts · CLI contract (needs the pinned CLI; reports `infra` outside the container) · build ·
e2e (Playwright, real API, real database) · performance budget file consistent with its rationale ·
documentation guard (`gate-doku.mjs`: the README tally against `CLAUDE.md` §22).

Exit codes follow A25/A50: **0** green · **1** at least one finding · **2** nothing ran (infra).

Traps worth knowing:

- `--only=<step>` does **not** build `packages/*/dist` first; a narrowed run can fail with "Failed to
  resolve entry for package". Take `typecheck` along.
- Integration tests never skip silently: without `TEST_DATABASE_URL` they are a finding, not a skip
  (A61). `infra/scripts/with-test-db.sh <command>` starts a throwaway Postgres for a host-side run:
  `infra/scripts/with-test-db.sh pnpm vitest run`.
- Several tests assert what an unprivileged process cannot do (a `chmod 000` file, a directory it does
  not own). As root they go green without proving anything — never run the gate as root.
- The merge-queue tests assert that every commit is the bot's; the container carries the bot identity
  `Vorschicht Bot <vorschicht-bot@example.com>` globally. On the host, set the same identity for the
  duration of a test run or those tests go red for a reason unrelated to the code.

## Phase evidence: the demo scripts

`infra/scripts/demo-phase<N>.sh` (0–9) run the assertions behind that phase's exit gates in
`CLAUDE.md` §22 and say of each gate whether it is green, deferred (A38) or open. They look up test
**titles** (`ran_green '<title>'`) in the vitest log; `infra/scripts/demo-names.test.ts` fails the
build when a referenced title no longer exists. Run them in the container:

```bash
infra/scripts/in-container.sh infra/scripts/demo-phase3.sh
infra/scripts/demo-phase5.sh --with-docker       # the deploy journeys against a real daemon (~90 s)
infra/scripts/demo-phase0.sh --on-host           # on the target host: settles the deferred gates
```

## The paid checks

These start real Claude Code sessions on the subscription and are **not** part of the gate:

```bash
pnpm check:mcp-handshake      # the real CLI must see all MCP tools
pnpm check:hook-containment   # the real CLI must refuse an escaping write (P2.G3)
pnpm check:runner             # one real session end to end through the runner
pnpm check:reviewer-claims    # a real Reviewer must catch an out-of-claim diff (P2.G5)
pnpm check:migration-review   # a real specialist must tell a safe migration from a breaking one
pnpm check:legal-review       # two real sessions: the legal gate must distinguish its cases (P6.G1)
pnpm onboard -- --path /abs/repo --slug foo --read-only    # §20's dry run: analyse, propose, write nothing
```

Host-side measurements: `pnpm check:kaltstart` (cold load of the overview against a live host),
`pnpm check:leistungsbudget` (Lighthouse + bundle budget, `infra/leistungsbudget.json`),
`pnpm check:kennzahlen` (recomputes the weekly report's headline numbers a different way, P8.G2),
`infra/scripts/kennzahlen-remote.sh --host <ssh-host>` and `budgetfenster-remote.sh` (the same
against a live database over an SSH tunnel).

## Screenshots

The dashboard screenshots in `docs/media/` are rendered from synthetic fixtures by the repo's own
scripts against the built bundle — no database, no passkey ceremony:

```bash
infra/scripts/in-container.sh bash -c 'pnpm gate:build && node infra/scripts/seiten-bildschirmfotos.mjs && node infra/scripts/buero-bildschirmfotos.mjs'
```

The payloads pass the same zod schemas as production; a page that does not accept its payload renders
its German error sentence, and the image shows it.

## Repository conventions

- `CLAUDE.md` is normative; behaviour changes start there. Decisions go to `docs/adr/`.
- Code, commits and docs are English; the UI, inbox cards and audit reports are German (§2). Test
  titles and comments are partly German — a trace of the build, translate freely.
- Conventional Commits, signed off (`git commit -s`); `infra/scripts/gate-commits.mjs` checks the range.
- Never commit `.env`, tokens, transcripts, credential ids or hostnames. `pre-commit install` gives
  you the gitleaks hook; CI runs the same scanner over the full history.
- The append-only tables stay append-only and every migration grants to `vorschicht_app`
  (`gate-migrations.mjs`).
- Base images are pinned by digest, gitleaks and the Claude CLI by version and checksum
  (`gate-image-pins.test.ts`, `gitleaks-pin.test.ts`); the four places must agree.

## Layout

```
apps/web/          Vite React PWA (German UI, "pixel office" design system — docs/DESIGN.md)
apps/server/       Hono API, SSE hub, static serving, CLI (invite, report-build)
apps/orchestrator/ daemon: scheduler, passes (backup, disk, notifications, radar, audit findings), runner
packages/core/     domain logic: tasks, gates, budget guardian, merge queue, deploy, audit, onboarding, vault
packages/db/       Drizzle schema, migration runner, 24 migrations with append-only triggers
packages/mcp/      the internal "vorschicht" MCP stdio server agent sessions talk to
packages/shared/   types, zod schemas, constants, containment policy, escalation model
contracts/         result-contract JSON schemas per role
infra/             compose, Dockerfiles, nginx template, systemd watchdog, gate + demo + check scripts
e2e/               Playwright specs against the real API (projects: default, a11y, traces)
docs/              ADRs, OPERATIONS.md, ARCHITECTURE.md, DESIGN.md, sample audit reports, media
```
