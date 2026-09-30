# Contributing to Vorschicht

Thanks for taking the time! Bug reports, questions, translations and pull requests are welcome.
Larger changes are best discussed in an issue first — especially anything that changes what a gate
asserts.

## Before you start

- **`CLAUDE.md` is the normative specification.** Behaviour changes start there; the code follows.
  Section numbers (§7.2, §22 …) and assumption ids (A38 …) are the project's citation scheme — keep
  them working.
- **Every finding is a blocker.** There is no warning mode in this repository; a red gate step is a
  red gate.
- **Never weaken a gate to make it pass.** If a gate is wrong, change the gate *and* say why in the
  same commit.
- **Language:** code, commits and repository docs are English; the dashboard UI, inbox cards and
  audit reports are German by specification (§2). Many test titles and comments are still German —
  translating a module is a welcome first contribution.

## Development setup

The gate is a POSIX tool and runs in a container that mirrors the orchestrator image:

```bash
pnpm install                                     # Node 22, pnpm 11 via corepack
infra/scripts/gate-in-container.sh               # all twelve gate steps (~6 min)
infra/scripts/gate-in-container.sh --only=typecheck,lint,test
infra/scripts/with-test-db.sh pnpm vitest run    # unit + Postgres integration tests
pnpm fix                                         # Biome formatting
```

`--only=<step>` does not build `packages/*/dist` first; take `typecheck` along or run the full gate.
More in [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md). The `pnpm check:*` scripts start real Claude
sessions and cost subscription budget — they are not part of the gate and CI does not run them.

### Secret guard

The repository ships a [pre-commit](https://pre-commit.com/) hook that runs
[gitleaks](https://github.com/gitleaks/gitleaks) on every commit, with the same rule set the gate
uses (`.gitleaks.toml`):

```bash
pip install pre-commit
pre-commit install
```

CI runs the same scanner over the full history. Never commit a `.env`, an OAuth token, an ntfy token,
a passkey credential id, a real hostname or a transcript.

## Branch and commit conventions

- Fork, then branch from `main`: `<kind>/<short-slug>` (e.g. `fix/guardian-latch`, `feat/english-ui`).
- Commits follow [Conventional Commits 1.0.0](https://www.conventionalcommits.org/): `feat:`, `fix:`,
  `docs:`, `test:`, `refactor:`, `ci:`, `chore:`. `infra/scripts/gate-commits.mjs` checks the range.
- Sign off your commits with the [Developer Certificate of Origin](https://developercertificate.org/):
  `git commit -s`. There is no CLA.

## Pull requests

- A bug fix comes with a test that fails without it. Integration tests (`*.itest.ts`) run against a
  real Postgres; deploy journeys against a real Docker daemon; browser cases against the real API.
- Do not let a test skip itself when a dependency is missing — the gate treats a silent skip as a
  finding (A61).
- If you touch a demo script's `ran_green '<title>'` line, the test title must still exist
  (`infra/scripts/demo-names.test.ts` checks).
- A change to `CLAUDE.md` §22 keeps every ticked gate's evidence clause; `gate-doku.mjs` holds the
  tally in `README.md` against the spec.
- User-facing changes update `CHANGELOG.md` under *Unreleased*.
- Keep the migration rules: append-only tables stay append-only; every migration grants to
  `vorschicht_app`; `gate-migrations.mjs` checks both.

## Licence

By contributing you agree that your contributions are licensed under the [Apache License 2.0](LICENSE).
