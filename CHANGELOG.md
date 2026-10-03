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

### Known limitations

- The onboarding procedure ("First project") has not been executed end to end in the published
  state; it needs a subscription. `docs/OPERATIONS.md` says what was and was not run.

- Phase 9 (supervised pilot operation) has not started; five gates are deferred to a target host.
- The dashboard UI is German by specification; an English UI is an open issue.
