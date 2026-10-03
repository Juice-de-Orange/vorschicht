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

### Known limitations

- Phase 9 (supervised pilot operation) has not started; five gates are deferred to a target host.
- The dashboard UI is German by specification; an English UI is an open issue.
