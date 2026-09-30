-- =============================================================================
-- 0008_worktrees — where a coder is allowed to work (§10), and where it is not
-- allowed to work at all (A41).
--
-- Three changes, each with a reason that outlives the commit:
--
--   1. **`projects.read_only`.** A41 makes the first pilot project analysis-only: it may be
--      read, never written, never given tasks. Until now that boundary existed
--      as a sentence in CLAUDE.md, and the component that would violate it —
--      the worktree manager — is being built in this same commit. A rule that
--      guards the one thing that could break it belongs next to the data, not
--      in a paragraph.
--
--   2. **`projects.default_branch`.** §10 branches "off current `main` of the
--      target project", but A41 already names a project whose development
--      happens on `dev`. The base branch is per-project configuration; assuming
--      `main` everywhere would silently branch off a stale integration point.
--
--   3. **`worktree_assigned` / `worktree_released` events.** The `tasks` view
--      of 0006 read `worktree_path` and `branch` out of the `created` payload,
--      which meant a worktree could only ever be known at creation time — and
--      a worktree is assigned *after* planning and released on merge. Following
--      A43, the assignment becomes an event rather than a mutable column, and
--      the view projects the most recent of the two kinds. A released worktree
--      therefore reads back as NULL rather than as a directory that is gone.
-- =============================================================================

-- --- projects ----------------------------------------------------------------
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS read_only      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS default_branch text    NOT NULL DEFAULT 'main';

COMMENT ON COLUMN projects.read_only IS
  'A41: the project may be analysed but never written to — no worktree, no branch, no task.';
COMMENT ON COLUMN projects.default_branch IS
  '§10: the branch task branches are cut from. Not always "main" (A41: a pilot project may develop on `dev`).';

-- --- task_events: two more kinds ---------------------------------------------
ALTER TABLE task_events DROP CONSTRAINT IF EXISTS task_events_kind;
ALTER TABLE task_events ADD CONSTRAINT task_events_kind CHECK (kind IN (
  'created', 'state_changed', 'reprioritised', 'note',
  'claims_registered', 'integrity_check',
  'worktree_assigned', 'worktree_released'
));

-- --- tasks (derived) ---------------------------------------------------------
-- Identical to 0006 except for the worktree projection. Column names, types and
-- order are unchanged, which is what lets CREATE OR REPLACE work here.
CREATE OR REPLACE VIEW tasks AS
WITH latest AS (
  SELECT DISTINCT ON (task_id)
    task_id, project_id, state, priority, resume_state, seq, occurred_at
  FROM task_events ORDER BY task_id, seq DESC
),
origin AS (
  SELECT task_id, occurred_at AS created_at, payload
  FROM task_events WHERE kind = 'created'
),
-- The most recent worktree decision, whichever way it went.
worktree AS (
  SELECT DISTINCT ON (task_id) task_id, kind, payload
  FROM task_events
  WHERE kind IN ('worktree_assigned', 'worktree_released')
  ORDER BY task_id, seq DESC
),
tallies AS (
  SELECT
    task_id,
    count(*) FILTER (WHERE kind = 'state_changed' AND state = 'red')   AS red_count,
    count(*) FILTER (WHERE kind = 'state_changed' AND state = 'parked') AS park_count,
    count(*) FILTER (WHERE kind = 'state_changed' AND state = 'interrupted') AS interrupt_count
  FROM task_events GROUP BY task_id
)
SELECT
  l.task_id                              AS id,
  l.project_id,
  l.state,
  l.priority,
  l.resume_state,
  l.seq                                  AS version,
  l.occurred_at                          AS updated_at,
  o.created_at,
  o.payload ->> 'title'                  AS title,
  o.payload ->> 'department'             AS department,
  o.payload ->> 'type'                   AS type,
  o.payload ->> 'goalId'                 AS goal_id,
  (o.payload ->> 'parentTaskId')::uuid   AS parent_task_id,
  CASE w.kind
    WHEN 'worktree_assigned' THEN w.payload ->> 'path'
    WHEN 'worktree_released' THEN NULL
    ELSE o.payload ->> 'worktreePath'
  END                                    AS worktree_path,
  CASE w.kind
    WHEN 'worktree_assigned' THEN w.payload ->> 'branch'
    WHEN 'worktree_released' THEN NULL
    ELSE o.payload ->> 'branch'
  END                                    AS branch,
  -- §9's retry count: how often this task has been through the red path.
  t.red_count                            AS retry_count,
  t.park_count,
  t.interrupt_count
FROM latest l
JOIN origin o USING (task_id)
LEFT JOIN worktree w USING (task_id)
JOIN tallies t USING (task_id);

COMMENT ON VIEW tasks IS
  'The §5 task entity, projected from task_events. `version` is the optimistic-concurrency token; the worktree is the most recent worktree_assigned/worktree_released event.';

GRANT SELECT ON tasks TO vorschicht_app;
