# ADR 0022 — The gate must run its proofs where they count: integration tests in `pnpm gate`, and the gate itself in a Linux container

- **Status:** accepted
- **Date:** 2026-08-01
- **Context:** §11 (baseline gates), §22 Phase 0 step 4 and gate 2, §6.6, §19
- **Condenses:** A61, A127

## Decision

1. A gate step `test-integration` runs every `*.itest.ts` through
   `infra/scripts/with-test-db.sh`, classified `a25`: the script exits 2 when docker is
   unreachable and passes vitest's own code through otherwise. The unit step stays separate and
   docker-free, which keeps proving that the unit tests need no database.
2. `pnpm gate` runs inside a container built from `infra/docker/Dockerfile.gate` — a
   **sibling** of the orchestrator image: same base digest, same pnpm, same pinned gitleaks
   binary, same pinned CLI, **no docker socket**, uid 10001.
   `infra/scripts/gate-in-container.sh` streams the working tree in; the build machine only
   has to hold Docker.
3. This is explicitly not a Windows port. The 27 tests that cannot pass there assert POSIX
   file modes and path separators that §6.6 and §19 depend on.

## Why

Every `*.itest.ts` skips itself without `TEST_DATABASE_URL`, and the gate never set it — so a
run reporting "Tests: green" had silently skipped 282 of them, which is most of what Phases 1
and 2 claim to prove. The first internal audit recorded it as a suspicion; it was closed rather
than carried because the estimating meter's central safety claim (ADR 0005) rests on exactly
such a proof, and a gate that skips it claims more than it checks.

On the build machine not one of the nine gate steps started. Porting would have meant
weakening the assertions that make the file-mode and containment tests worth having. Running
the gate in the environment the studio runs in is the stronger answer anyway: a gate that runs
somewhere else is a gate whose green means something else. A docker socket was ruled out twice
— a container that can talk to the daemon can start a privileged one that mounts `/`, and the
daemon resolves `-v` against the host, so the container's own paths would not even work.

## Consequences

The first containerised run found things no test could:

- **Not root is load-bearing, not hygiene.** As root, five tests were green that cannot fail as
  root — "does not read an unreadable file", "detects a non-writable directory" — which is
  worse than not running them.
- **A configuration that looked set and was invisible to the code under test.** The rebase
  died with `Committer identity unknown` while `git config user.email` answered correctly in a
  shell of the same image. `packages/core/src/git.ts:45` runs every git call with
  `GIT_CONFIG_NOSYSTEM=1`, deliberately, so a foreign machine cannot influence the studio — and
  a `--system` identity is invisible to exactly the code that needs it. The check "is the
  identity set?" was green and proved nothing. `--global`, and the **bot** identity (A36),
  because the merge queue verifies that every commit it brings in belongs to the bot.
- `.git` through a tar is what git refuses as `dubious ownership`; and setting
  `TEST_DATABASE_URL` globally made the docker-free unit step run the integration suite too —
  every integration file ran twice and the second pass tripped over the first's rows. The
  runner's variable is therefore `VORSCHICHT_TEST_DB_URL`, not the one the tests read. The same
  variable later turned out to carry a second meaning for the browser suite, which now gets its
  own database (A129).
- Two integration tests constructed the docker-based `GitleaksSecretScanner` and called it "the
  production path" — true on a developer machine, false for the shipped studio, which has no
  docker at all (A104). They use `AutoSecretScanner`, which takes the pinned binary when
  present; a binary that is not the pin is not a cheaper path but a different gate.
  `gitleaks-pin.test.ts` now knows four places.
- The working tree is streamed, not `HEAD`: a `git archive` export checks what is committed and
  is useless before the commit. One archive, one `tar -x`; concatenated streams would need
  `--ignore-zeros`, which also accepts a truncated stream — the one fault a script that then
  reports gate results must not swallow.
- The CLI is in the image so that `gate:cli-contract` does not report `infra` on every run —
  honestly, and still a step that never checks anything. It costs nothing: the contract pairs
  each flag with an unknown one and never starts a session (ADR 0014).
- The demo scripts got the same container (`in-container.sh`) plus a browser, and their first
  run found a colour-sensitive `ran_green` and a test title renamed in a parallel worktree while
  `pnpm gate` stayed green; `demo-names.test.ts` now holds every cited title against the real
  test corpus (A128).
- Cost stated: the browser step (later the tenth gate step, A122) and the real-daemon deploy
  journeys add minutes to every gate run. A proof that only runs when somebody remembers a flag
  is a proof that stops running.

## Evidence

- `infra/scripts/gate.mjs` — the `test-integration` step; `infra/scripts/with-test-db.sh`.
- `infra/docker/Dockerfile.gate`, `infra/scripts/gate-in-container.sh`, `in-container.sh`;
  `packages/core/src/gitleaks-pin.test.ts`, `infra/scripts/gate-image-pins.test.ts`.
- P0.G2 in `CLAUDE.md` §22 — reproducible as a script since this change.
