# Changelog

All notable changes to Vorschicht. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Initial public release. Phases 0–8 of the build plan (`CLAUDE.md` §22) are closed: budget guardian
  on official rate-limit data, model access layer with a headless Claude Code backend, locked and
  optional gates, Planner → Coder → Reviewer chain with file claims and a merge queue, containment
  hooks, deploy engine with auto-rollback, escalation inbox with policy memory, document vault, source
  registry, radar scans, idle audits, the internal audit department (Betriebsprüfung), the dashboard
  PWA with office view, weekly report and Controlling analytics.
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

### Known limitations

- The onboarding procedure ("First project") has not been executed end to end in the published
  state; it needs a subscription. `docs/OPERATIONS.md` says what was and was not run.

- Phase 9 (supervised pilot operation) has not started; five gates are deferred to a target host.
- The dashboard UI is German by specification; an English UI is an open issue.
