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

### Known limitations

- Phase 9 (supervised pilot operation) has not started; five gates are deferred to a target host.
- The dashboard UI is German by specification; an English UI is an open issue.
