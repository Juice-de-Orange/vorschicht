# ADR 0018 — A task is its event stream, and a claim's status is a computed answer

- **Status:** accepted
- **Date:** 2026-08-01
- **Context:** §5, §9, §10, §7.2 (integrity re-check), ADR 0003
- **Condenses:** A43, A45

## Decision

1. `task_events` is the append-only log and `tasks` is a **view** over it — one entity, not
   two. The §9 transition map lives in `task_transitions` (database) and `TASK_TRANSITIONS`
   (`@vorschicht/shared`), written twice with a drift test that fails the build.
2. `seq` must be exactly `max(seq) + 1`; together with `UNIQUE (task_id, seq)` this is
   optimistic concurrency at no extra cost.
3. The §7.2 integrity re-check is a database rule: an `interrupted` task cannot leave that
   state, except to `red` or `aborted`, until an `integrity_check` event with `ok: true`
   exists *after* the most recent interrupt.
4. A resume returns to the state it was suspended from (`resume_state` on `parked`,
   `needs_decision`, `interrupted`). `aborted` is an explicit terminal state reachable from
   every non-terminal one.
5. Claims have a fourth status, **`pending`**, between registration and acquisition. `claims`
   is a view over `task_events`; a set counts as held only once the task entered `claimed`
   *after* that set was registered. A terminal task holds nothing. The claim grammar is `*`,
   `?`, `**`, `{a,b}` and nothing else; overlap is a glob-vs-glob intersection that leans
   towards "they overlap". Acquisition is serialised per project by a transaction-scoped
   advisory lock.

## Why

§9 ends with "Every state change = one `task_events` row. No silent transitions", and a mutable
`tasks.state` column is exactly where that sentence dies. ADR 0003 set the precedent for
`agent_runs`; this is the same bargain. A check constraint cannot import TypeScript, so the
map is written twice and a test fails the build on drift — a guard that only exists in the
application language is not a guard.

§10 separates registration ("the Planner emits a claim set … registered before any coder
starts") from acquisition ("claim conflict check at scheduling time"), and the gap needs a
name. Without `pending`, writing down what a task *intends* to touch would block the project
from that moment, including the task queued behind it. The "after" in rule 5 is what makes §9's
red path safe: a re-planned task with a different claim set returns to `pending` and is
re-checked instead of inheriting a permission granted for other files. Overlap is a different
question from matching a path, and every approximation leans one way: a false collision costs
throughput, a false disjointness puts two coders in one file.

## Consequences

- Two schedulers that both read `coding` and both try to write the same `seq`: exactly one
  succeeds. The trigger catches the stale reader, the unique index the genuine in-flight race;
  both are tested.
- An older passing integrity check does not authorise a later resume. A state with no route
  out would hold its claims forever, hence `aborted`.
- A forgotten claim release in an unattended system is not an inconsistency but a project-wide
  deadlock with nobody awake to clear it — hence "a terminal task holds nothing" whether or not
  the release event was written.
- Anything outside the small grammar (character classes, negation, backslashes, `**` sharing a
  segment) is refused at registration with a German sentence. A fuzz test asserts only the
  "leans towards overlap" direction.
- The advisory lock is proven by holding it from a second transaction and watching `acquire()`
  wait — two `acquire()` calls under `Promise.all` pass just as happily with the lock removed,
  and therefore prove nothing (P2.G2). The merge queue uses a *session-level* lock on a
  reserved connection instead, because holding a transaction open for a test-suite run pins a
  connection and blocks autovacuum (A55.2).
- The pattern was reused for audits, findings, escalations, sources, deployments and gate runs,
  and deliberately **not** for the document vault, whose only history is the one `audit_log`
  already keeps (A107.1, A112.1). The deciding question is "does this entity have a history
  somebody must reconstruct".
- Later additions to the map — `merging → merge_queue` for infra requeues (A55.1), re-entry
  into `coding`/`review` for §6.4 continuations (A78.1) — went through the same drift test.
  Three resume paths had previously led to states no dispatcher touched.
- A claim-blocked task is shown on the overview as "blockiert durch Entscheidung #X" naming the
  **holder**; the first implementation rendered only the task that had *asked*, and code and
  test shared the misreading until the auditor read the spec against both (A100).

## Evidence

- `packages/db/migrations/0006_tasks.sql`, `0009_claims.sql`;
  `packages/shared/src/task-state.ts` (`TASK_TRANSITIONS`), `packages/shared/src/claims.ts`
  (grammar, overlap).
- `packages/core/src/task-service.ts`; `packages/core/src/claim-registry.ts` with
  `claim-registry.itest.ts` (17 specs; `audit()` asserting §10's invariant in `afterEach`
  since ADR 0024).
