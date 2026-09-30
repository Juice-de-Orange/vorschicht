# ADR 0017 — Pilot projects are analysed and not built on; the studio is its own pilot, read-only until audited

- **Status:** accepted
- **Date:** 2026-08-01
- **Context:** §12 (Self-management), §20, §22 Phase 3 gate 1 and Phase 9, A16, A44.3
- **Condenses:** A41, A42, A85

## Decision

1. **A private pilot project is analysed, never built on.** Onboarding runs in dry-run only:
   the agent reads the repository and produces a proposal (gate set, commands, claim
   granularity, deploy shape) for the operator to review. No writes, no tasks, no merges
   without explicit approval. If writes are ever approved they target that project's
   integration branch (`dev`, where its development actually happens), never `main`.
   *(Operator, 2026-08-01.)*
2. **Vorschicht is its own primary pilot**, superseding A16's "one external project plus two
   more". The Phase 9 floor of ≥ 15 gate-green merged tasks is to be met from Vorschicht's own
   backlog — hardening, test coverage, parked appendix items, idle-audit findings. Self-deploy
   stays approval-gated (ADR 0010). *(Operator, 2026-08-01.)*
3. **The self-managed project is `read_only` until the studio is fully built and audited;
   afterwards it works on a clone of itself.** This dates decision 2 rather than replacing it.
   *(Operator, 2026-08-02.)*

## Why

A mistake in the studio's own repository reaches nobody but this project — the more honest test
bench. A mistake in someone's private project reaches a real codebase, and a proposal the owner
has not read is work nobody will act on. Read-only is therefore the default posture for every
project until a human has said otherwise, and for the studio itself until an auditor has.

## Consequences

- Read-only is a **schema-level** flag (`projects.read_only`), refused at the worktree
  manager's entrance for worktree, branch and any write (A44.3). The boundary was a sentence in
  the spec until the one component that could break it got built; a rule that depends on
  everyone remembering it is not a rule.
- The dev chain and the merge queue skip a read-only project entirely, so **the studio's
  contribution to the Phase 9 floor is zero while the flag stands**; that gate is unreachable
  until the clone exists or the flag is cleared. Clearing it is one audit-logged call
  (`ProjectService.setReadOnly`) and it is the operator's.
- §8.2 audits still run — an audit is read-only by construction — but every `gate_invalid` now
  takes the refusal branch and reaches the operator as a P1 item instead of editing `CLAUDE.md`
  unattended (A83.6). Without that refusal the flag would have left `applied = true` on a
  consequence that could never happen; the two changes belong in one commit.
- A self-managed project at a **different path** is refused, not silently accepted: the stored
  row had won over the configured `rootPath` on every start after the first, and §8.2 derives
  the file a `gate_invalid` edits from that row — a studio configured against one checkout
  would un-tick gates in another. Refusing is the only answer that does not pick a winner
  between two paths a human has reason to believe in. The price: a mismatch means no audits at
  all, said out loud at every start.
- The first pilot was withdrawn by its owner on 2026-08-02 (he develops it himself) and
  replaced by a second private project; P3.G1 re-opened and closed on 2026-08-18 when the
  operator chose "adopt, analyse only". A condition travels with that project: its test gate
  must never read the return code, because most of its test files call `pytest.skip` when a
  container is unavailable and `pytest` exits 0 on a run made of skips (A79.4) — ADR 0022's
  failure mode in someone else's repository.
- WIP commits are refused on `main`, `master`, `trunk`, `develop` and `dev` (§7.3), which also
  covers decision 1's integration branch.
- Both pilots found defects only a foreign repository could: the command verifier refused a
  correct monorepo command (A72), spoke one package manager's dialect (A80), and accepted a
  proposal built on an empty survey as "ok" (A162). A checker's first live run is worth more
  than its unit tests, and it fails in the direction nobody reports.

## Evidence

- `packages/core/src/onboarding/self.ts` — self-onboarding with `readOnly: true` and the
  `readOnlyEverDecided` trail; `packages/core/src/onboarding/verify.ts` — proposal
  verification.
- `apps/orchestrator/src/build-scheduler.ts` — path-mismatch refusal;
  `build-scheduler.itest.ts` — the un-tick reaching the inbox on a read-only project.
- `packages/core/src/audit/audit-service.ts` — `writeRefusal` for read-only and unknown
  projects.
