-- =============================================================================
-- 0012_merge_queue — §5's `merge_queue` entity, and one new edge in §9's map.
--
-- Following A43 and the precedent of `claims` (0009) and `worktrees` (0008), the
-- queue is a **view** rather than a table. A task's position in it is entirely a
-- consequence of facts already in `task_events` — it is in state `merge_queue`,
-- and it entered that state at a particular moment — so a second table would be
-- one more thing that can disagree with the log about what a task is doing, and
-- would need its own guard against the disagreement.
--
-- The ordering is §10's "FIFO by priority", and the entry time is read from the
-- task's own log rather than from `tasks.updated_at`. That distinction is not
-- cosmetic: `updated_at` moves on every note, so a reviewer comment or a
-- handover would silently push a candidate to the back of its own queue.
--
-- The new edge, `merging → merge_queue` (A55), is what A25's "persistent infra
-- failure → Ops alert, task stays queued" means once a candidate is already
-- being merged. Every other route out of `merging` either merges it, colours it
-- red, or suspends it — and a docker daemon that was unreachable for ten seconds
-- proves nothing about the change, so all three would be lies of a different
-- kind. §9's diagram does not draw this edge because §9 does not describe the
-- inside of a merge attempt; §10 does, and §11 classifies its failures.
-- =============================================================================

INSERT INTO task_transitions (state_from, state_to) VALUES ('merging', 'merge_queue')
ON CONFLICT DO NOTHING;

-- --- merge_queue (derived) ---------------------------------------------------
-- One row per waiting candidate, already in the order §10 merges them.
--
-- `entered_at` is the most recent transition *into* `merge_queue`, not the
-- first: a candidate that came back from an infra failure (A55) has been
-- attempted since, and putting it at the head of the queue on the strength of
-- its original entry would make a broken machine starve every other task.
CREATE OR REPLACE VIEW merge_queue AS
SELECT
  t.id                AS task_id,
  t.project_id,
  t.title,
  t.priority,
  t.branch,
  t.worktree_path,
  (
    SELECT max(e.occurred_at) FROM task_events e
    WHERE e.task_id = t.id AND e.kind = 'state_changed' AND e.state = 'merge_queue'
  )                   AS entered_at
FROM tasks t
WHERE t.state = 'merge_queue'
ORDER BY t.priority ASC, entered_at ASC;

COMMENT ON VIEW merge_queue IS
  'The §5 merge_queue entity, projected from task_events: candidates in state merge_queue, ordered FIFO by priority (§10).';

GRANT SELECT ON merge_queue TO vorschicht_app;
