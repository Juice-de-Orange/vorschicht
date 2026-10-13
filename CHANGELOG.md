# Changelog

All notable changes to Vorschicht. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- README: the AI note is the one line "Built with AI assistance."; the build-loop warning for
  `vorschicht-build.sh` moved to *Development*; the CI-harness issue is listed as help wanted, not
  as a good first issue.

## [0.1.1] - 2026-10-13

A patch release: two fixes and a dependency update. No migrations, no new settings.

### Fixed

- The container gate heals a stale Playwright browser volume. `in-container.sh` installed the
  browsers only if *some* `chromium_headless_shell-*` existed, so after the bump to Playwright 1.64
  a volume holding 1.63's build skipped the install, every browser case failed with "Executable
  doesn't exist", and the step reported INFRA instead of testing anything. `playwright install
  chromium` now runs on every start; it downloads only what the lockfile's version lacks (#41).
- A Claude session that never reaches the API (no network, DNS) ends as `unreachable` and is
  classified as an infrastructure failure ("Anthropic nicht erreichbar …") instead of hanging for
  the start probe's full three-minute wall clock and reporting "Wanduhr-Grenze des Laufs erreicht
  (A32)". A task run in that state is retried rather than marked red; an API that answered with an
  error, or a session whose model already spoke, still ends as `timeout` (#41).

### Changed

- Dependencies: vite 8 with `@vitejs/plugin-react` 6 for the dashboard build (#31),
  `@simplewebauthn/browser` 14 for passkey sign-in (#33), and the minor and patch group (#37):
  Playwright 1.64 (the gate image's system libraries pinned to match), `@modelcontextprotocol/sdk`
  1.32.1, hono 4.13.13, `@hono/node-server` 2.1.4, drizzle-orm 0.45.4, pino 10.4, vitest 5.0.3,
  Biome 2.5.15, `@types/node` 22.20.5.

## [0.1.0] - 2026-10-12

### Added

- First public release, experimental and not in production use (see the README's status section).
  Phases 0–8 of the build plan (`CLAUDE.md` §22) are closed: budget guardian on official rate-limit
  data, model access layer with a headless Claude Code backend, locked and optional gates, Planner →
  Coder → Reviewer chain with file claims and a merge queue, containment hooks, deploy engine with
  auto-rollback, escalation inbox with policy memory, document vault, source registry, radar scans,
  idle audits, the internal audit department (Betriebsprüfung), the dashboard PWA with office view,
  weekly report and Controlling analytics.
- Apache-2.0 licence, contributor documentation, hardened CI, CodeQL and Dependabot.

### Changed

- The operator's own acts outside a dashboard session (manual pause, answered ntfy cards, waived
  audit findings) and the passkey user name are logged under `VORSCHICHT_OWNER_ACTOR`, default
  `operator`, instead of a hard-wired first name. Existing rows are not rewritten; an installation
  that ran an earlier build sets `VORSCHICHT_OWNER_ACTOR=max` to keep its log and its passkey user
  handle continuous.
- The projects root no longer lands on a root-owned host directory or on `/opt`. With the base
  compose file and `VORSCHICHT_PROJECTS_ROOT` unset it is the named volume `vorschicht_projects`
  (owned by the orchestrator's uid 10001) instead of `infra/.vorschicht-data/projects`, which Docker
  created as root; the production overlay falls back to `/srv/vorschicht-projects` instead of `/opt`.
  **Upgrading:** a stack that relied on either old fallback sets `VORSCHICHT_PROJECTS_ROOT` explicitly
  (`./.vorschicht-data/projects`, relative to `infra/`, or `/opt`) or moves the checkouts — project
  rows store the container path `/projects/<dir>`, so they stay valid. The studio manages itself only
  if its own checkout is `<projects root>/vorschicht`.
- The specification's 162-item assumption diary is condensed into `docs/adr/`; `CLAUDE.md` carries an
  index (Appendix A) that the audit reads.
- Host-specific deployment files are generic templates (`infra/docker-compose.override.example.yml`,
  `infra/nginx/*.conf`, the `*-remote.sh` scripts take `--host`).

### Fixed

- A Claude token that does not authenticate is an auth incident again (§6.1). The pinned CLI reports
  the 401 as the text of an error result with an empty stderr; the headless backend matched stderr
  only, so the start-up probe ended as "Ergebnis erfüllt den Rollenvertrag nicht", no `auth.incident`
  was written, the log said "Daemon ist bereit" on every pass and `pnpm onboard` exited 3 instead of 2.
- The backup sidecar's first run waits for the migrated schema instead of dumping an empty database
  and reporting success.
- The passkey hints in the dashboard and `docs/OPERATIONS.md` name the command that exists
  (`exec app node dist/cli/invite.js --purpose=rescue`), not `vorschicht-invite` / `exec orchestrator`.
- `.env.example` no longer sets `VORSCHICHT_PROJECTS_ROOT=/opt`, which bind-mounted the host's whole
  `/opt` read-write into the orchestrator when the quick start was followed literally.
- The documented restore works: `DROP DATABASE` / `CREATE DATABASE` run as two commands on a
  connection to `postgres` (one `-c` with both is a transaction block, and a database cannot be
  dropped from a session connected to it). `docs/OPERATIONS.md` also covers the base compose file's
  named volumes, for the probe (`restore-probe.sh --backups`) and for the restore itself.
- `install-host.sh` hands `backups/` to uid 10001, the user the backup image runs as, instead of
  uid 70 — the sidecar refuses a directory it cannot write, so a fresh host install stopped there.
- The invite CLI reads `--purpose rescue` as well as `--purpose=rescue` and refuses arguments it
  does not know; the spelling with a space used to mint a `bootstrap` invitation without a word.
- A self-check alert that ntfy does not accept is logged and recorded on the event
  (`announced: false`), instead of being discarded.
- The overview names a running auth incident as the reason behind "Keine Budgetdaten".
- `onboard.mjs` archives the session transcript under `VORSCHICHT_TRANSCRIPTS_ROOT` instead of its
  scratch directory, which it deletes; `--actor` has no default any more (flag or
  `VORSCHICHT_ACTOR`, required to apply).
- An unknown task or run id says so instead of reporting a defect in the application; the state
  filter no longer lists "Wartet auf deine Entscheidung" twice.
- The host overlay `infra/docker-compose.override.yml` is git-ignored, so `rollout-remote.sh`'s
  clean-tree check no longer refuses every rollout on a host that follows the documented layout.
  `docs/OPERATIONS.md` names that path everywhere (it used to say the stack root, where none of the
  scripts look).
- The bot identity of agent commits comes from `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` in `.env`, as
  `.env.example` always said; nothing read them before and every commit carried the placeholder
  address. Unset or blank, the neutral default `Vorschicht Bot <vorschicht-bot@example.com>` applies.
- The daemon no longer logs "Selbstprüfung bestanden — Daemon ist bereit." while a start-up probe that
  failed for a reason other than authentication keeps failing; such a probe is a failed self-check
  (alert, `system.selfcheck_failed`, no work) until one passes, and its recovery is not announced as
  a restored login.
- A Claude token that expires or is revoked after the start-up probe passed now raises the
  daemon-level auth incident (ntfy alert, `auth.incident`, all running work parked) as soon as a
  session is refused, instead of only parking the task that noticed.
- `pnpm db:generate` works: `packages/db/drizzle.config.ts` and a baseline snapshot in
  `packages/db/migrations/meta/` make it report "No schema changes" on the current tree and draft the
  next migration as `00NN_<name>.sql` in the existing layout (it used to fail with "drizzle.config.json
  file does not exist", and without a baseline it would have written a `0000_*.sql` that recreates the
  tables).
- With the host overlay the orchestrator reads `/backups` from the same bind the backup sidecar writes
  to; it kept the base file's named volume before, never saw `.last-result` and reported neither a
  successful nor a failed backup.
- `node …/node_modules/@vorschicht/db/dist/migrate.js` migrates when the path is a symlink, as pnpm
  lays it out in the orchestrator image; it used to run nothing and exit 0.

### Known limitations

- The onboarding procedure ("First project") has not been executed end to end in the published
  state; it needs a subscription. `docs/OPERATIONS.md` says what was and was not run.
- Phase 9 (supervised pilot operation) has not started; five gates are deferred to a target host.
- The dashboard UI is German by specification; an English UI is an open issue.
- An auth incident is announced over ntfy, in `event_log` and in the overview's strip, but it does
  not create an inbox card.
- Unknown `VORSCHICHT_*` variables in `.env` are not reported at start; a misspelt setting is
  silently ignored.
