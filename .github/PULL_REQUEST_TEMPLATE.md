## What and why

<!-- What does this change and which problem does it solve? Link the issue: Closes #123 -->

## How it was tested

<!-- Which gate steps you ran (infra/scripts/gate-in-container.sh …) and what they showed.
     A bug fix comes with a test that fails without it. -->

## Checklist

- [ ] Commits follow Conventional Commits and are signed off (`git commit -s`)
- [ ] The gate is green in the container (or the failing step is named and explained)
- [ ] No test skips itself when a dependency is missing
- [ ] `CLAUDE.md` changed? Every ticked gate keeps its evidence clause; `README.md` tally still matches
- [ ] No tokens, hostnames, credential ids, transcripts or `.env` contents in code, tests or docs
- [ ] `CHANGELOG.md` updated for user-facing changes
