# Vorschicht build loop — iteration instructions

> This is the prompt `vorschicht-build.sh` hands to every iteration of the unattended build loop.
> The loop runs `claude -p` with `--dangerously-skip-permissions` and must only ever run in a
> sandbox (a throwaway VM or container with nothing else on it). It is kept as the record of how
> the studio was built; nobody has to use it.

You are ONE iteration of an unattended build loop for the Vorschicht project. The operator is not
watching and cannot be asked anything during this iteration. Iterations ran before you and more
will run after you; `docs/STATE.md` is the shared memory between all of them — create it if it
does not exist.

## Start of iteration (always, in this order)

1. Read `CLAUDE.md` completely. It is the single source of truth; §0 binds you fully. Read
   `docs/adr/` for the decisions earlier work made — that is where the surprises are recorded.
2. Read `docs/STATE.md`. Its `## Next step` names the files and facts you would otherwise
   rediscover; `## Decisions & dead ends` exists so you do not re-walk a blocked path.
3. If the working tree is dirty (a previous session was killed mid-work): inspect the changes
   first, then either complete-and-commit or commit as `wip:` with an explanatory note in
   `docs/STATE.md` before doing anything else.

## Work rules

- **Phase discipline (§0.2).** Strictly phase by phase. A phase is finished only when every exit
  gate is ticked *or* deferred per A38. Never weaken a gate.
- **One coherent unit of work per iteration** — a step of the current phase, finished and gated.
  `pnpm gate` (in the container: `infra/scripts/gate-in-container.sh`) must be green before you
  commit anything that is not `wip:`.
- **Decisions you may take** go to `docs/adr/` in the same commit. **Decisions you may not take**
  (security-relevant, data-loss-relevant, changing agreed behaviour) go to `docs/STATE.md` under
  `## WAITING FOR OPERATOR` as a prepared multiple-choice question, and you end the iteration.
- **Never** write real credentials, hostnames or personal data into any file; `.env` is the only
  place for secrets and it is git-ignored.
- Conventional commits, authored as the bot identity configured in `.env`.

## End of iteration (always)

1. Update `docs/STATE.md`: what was done, decisions, dead ends, the exact next step.
2. Update `CHANGELOG.md` and any affected docs or `.env.example`.
3. Tick completed gates in `CLAUDE.md` with an evidence clause `*(…)*`; make sure the README tally
   still matches (`node infra/scripts/gate-doku.mjs`).
4. Commit.
5. Your last line is exactly one of:
   - `CONTINUE` — there is more to do in this or the next phase;
   - `BUILD_BLOCKED_WAITING_FOR_OPERATOR` — a decision is pending in `docs/STATE.md`;
   - `ALL_PHASES_DONE` — every gate in `CLAUDE.md` is ticked or deferred (the loop verifies this
     against the file before it believes you).
