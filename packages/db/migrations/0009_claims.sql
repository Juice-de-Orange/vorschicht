-- =============================================================================
-- 0009_claims — the other half of §10.
--
-- The worktree manager (0008) stops two sessions sharing a *checkout*. Claims
-- stop two tasks sharing a *file*, and §10 states the invariant plainly: "Two
-- active tasks never hold overlapping claims in the same project."
--
-- Following A43, `claims` is a view rather than a table: the claim set is a fact
-- about a task, it belongs in that task's log, and a second mutable table would
-- be one more thing that can disagree with the log about what a task is doing.
-- The projection is the same shape 0008 used for worktrees — the most recent of
-- `claims_registered` / `claims_released` wins.
--
-- The status column is where §5 ("active/parked/released") meets §10, and it
-- carries one value §5 does not name: `pending`. §10 separates registration
-- ("the Planner emits a claim set … registered before any coder starts") from
-- acquisition ("claim conflict check at scheduling time"), so the gap between
-- the two needs a name. Without it a registered-but-not-yet-scheduled task
-- would look like a holder and block the very task it is queued behind.
--
-- Two rules are deliberately encoded here rather than in the registry:
--
--   * **Terminal means released.** A `done` or `aborted` task holds nothing,
--     even if the release event was never written. In an unattended system a
--     forgotten release is not an inconsistency, it is a project-wide deadlock
--     that nobody is awake to clear.
--   * **Suspended means still held** (§10: "Claims survive parking"; §15: held
--     indefinitely while the operator has not answered). That is what makes the waiting
--     task's "blockiert durch Entscheidung #X" true rather than decorative.
-- =============================================================================

-- --- task_events: one more kind ----------------------------------------------
ALTER TABLE task_events DROP CONSTRAINT IF EXISTS task_events_kind;
ALTER TABLE task_events ADD CONSTRAINT task_events_kind CHECK (kind IN (
  'created', 'state_changed', 'reprioritised', 'note',
  'claims_registered', 'claims_released', 'integrity_check',
  'worktree_assigned', 'worktree_released'
));

-- --- claims (derived) --------------------------------------------------------
-- One row per (task, glob) — the §5 entity "task ↔ path globs", in the shape a
-- dashboard can list and a conflict report can point at.
--
-- Acquisition is derived from the lifecycle rather than from a separate event:
-- every route to `coding` passes through `claimed` (§9), so entering `claimed`
-- *after* the current claim set was registered is exactly "this task has taken
-- these claims". One fact, one place; a `claims_acquired` event beside the
-- state change would be a second copy of the same sentence, free to drift.
--
-- The "after" matters. §9's red path sends a failed task back through planning,
-- where it may register a different set — and a set that has not been checked
-- against the project since it changed must not read as held. Comparing against
-- the claim event's own `seq` makes re-planning re-queue for acquisition
-- automatically, instead of inheriting a permission granted for other files.
CREATE OR REPLACE VIEW claims AS
WITH latest AS (
  SELECT DISTINCT ON (task_id)
    task_id, project_id, seq, kind, payload, occurred_at
  FROM task_events
  WHERE kind IN ('claims_registered', 'claims_released')
  ORDER BY task_id, seq DESC
),
acquired AS (
  SELECT l.task_id FROM latest l
  WHERE EXISTS (
    SELECT 1 FROM task_events e
    WHERE e.task_id = l.task_id AND e.kind = 'state_changed'
      AND e.state = 'claimed' AND e.seq > l.seq
  )
)
SELECT
  l.task_id,
  l.project_id,
  g.glob,
  l.occurred_at                       AS recorded_at,
  t.state                             AS task_state,
  t.priority                          AS task_priority,
  CASE
    WHEN l.kind = 'claims_released'                        THEN 'released'
    WHEN t.state IN ('done', 'aborted')                    THEN 'released'
    WHEN a.task_id IS NULL                                 THEN 'pending'
    WHEN t.state IN ('parked', 'needs_decision', 'interrupted') THEN 'parked'
    ELSE 'active'
  END                                 AS status
FROM latest l
JOIN tasks t ON t.id = l.task_id
LEFT JOIN acquired a ON a.task_id = l.task_id
CROSS JOIN LATERAL jsonb_array_elements_text(
  COALESCE(l.payload -> 'globs', '[]'::jsonb)
) AS g(glob);

COMMENT ON VIEW claims IS
  'The §5 claims entity, projected from task_events. status: pending (registered, not yet scheduled) · active · parked (held across a pause, §10/§15) · released.';

GRANT SELECT ON claims TO vorschicht_app;
