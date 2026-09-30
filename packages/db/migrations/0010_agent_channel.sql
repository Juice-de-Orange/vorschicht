-- =============================================================================
-- 0010_agent_channel — what an agent may learn, and what it may record.
--
-- The internal MCP server (§6.2, §22 Phase 2 step 3) is the only channel an
-- agent session has back into this system. Everything it can read comes from
-- here; everything it can write lands here. Two changes, and they are two sides
-- of the same sentence.
--
-- **What it may learn.** §8 row 1 has the Product Lead decompose goals into
-- "tasks with acceptance criteria", and the Planner's role prompt already tells
-- its agent to read "the task and its acceptance criteria via
-- `task.get_context`". The task model had neither field. A `title` is not a
-- mandate: an agent handed "Cache-Invalidierung reparieren" and nothing else
-- has to guess what "repaired" means, and a guess is what §1 principle 6
-- forbids. Both live in the `created` payload — a task's brief is decided when
-- it is created and does not change afterwards; a re-scoped task is a new plan,
-- which is what the `note` timeline is for.
--
-- **What it may record.** Two new event kinds. Neither is a state change: the
-- MCP server can append to a task's history and cannot move it through §9's
-- lifecycle, which is deliberate — an agent that could transition its own task
-- could mark its own work reviewed. Findings and escalations are *reported* by
-- the agent and *acted on* by the orchestrator.
--
--   * `finding_reported` — §11's finding, always a blocker, never a warning.
--   * `escalation_requested` — the agent's half of §6.4's round trip. The inbox
--     item, the notification and the resume are Phase 4; the question, its
--     context and its options are recorded now, so that nothing an agent
--     prepared for the operator is lost in the meantime.
--
-- Following A43, neither gets a table. `findings` and `escalations` are §5
-- entities that Phase 3 and Phase 4 own, and they will be projections over
-- these events for the same reason `claims` and `tasks` are: the fact belongs
-- in the task's log, and a second mutable copy is one more thing that can
-- disagree with it.
-- =============================================================================

-- --- task_events: two more kinds ---------------------------------------------
ALTER TABLE task_events DROP CONSTRAINT IF EXISTS task_events_kind;
ALTER TABLE task_events ADD CONSTRAINT task_events_kind CHECK (kind IN (
  'created', 'state_changed', 'reprioritised', 'note',
  'claims_registered', 'claims_released', 'integrity_check',
  'worktree_assigned', 'worktree_released',
  'finding_reported', 'escalation_requested'
));

-- --- tasks (derived) ---------------------------------------------------------
-- Identical to 0008 except for the two columns appended at the end. Appending
-- is the only edit CREATE OR REPLACE permits, and it is also what keeps the
-- `claims` view of 0009 — which selects from this one — valid.
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
  t.red_count                            AS retry_count,
  t.park_count,
  t.interrupt_count,
  -- The brief. Free text for the "what and why", a list for "when is it done".
  o.payload ->> 'description'            AS description,
  COALESCE(o.payload -> 'acceptanceCriteria', '[]'::jsonb) AS acceptance_criteria
FROM latest l
JOIN origin o USING (task_id)
LEFT JOIN worktree w USING (task_id)
JOIN tallies t USING (task_id);

COMMENT ON VIEW tasks IS
  'The §5 task entity, projected from task_events. `version` is the optimistic-concurrency token; the worktree is the most recent worktree_assigned/worktree_released event; description and acceptance_criteria are the brief fixed at creation.';

GRANT SELECT ON tasks TO vorschicht_app;

-- --- findings a session has reported -----------------------------------------
-- Not the §5 `findings` entity — that one carries gate-run linkage and belongs
-- to Phase 3. This is the narrower fact the MCP server can produce on its own:
-- a defect an agent named, against a task, with no gate behind it yet. Phase 3
-- widens the projection rather than replacing it.
--
-- `open` is derived from the task rather than stored, because §11 gives a
-- finding exactly one way to stop being a blocker: the work goes back through
-- the gates and comes out green. A finding on a task that has merged is
-- history; a finding on a task still in flight is a blocker.
CREATE OR REPLACE VIEW task_findings AS
SELECT
  e.task_id,
  e.project_id,
  e.seq,
  e.occurred_at                    AS reported_at,
  e.actor                          AS reported_by,
  e.payload ->> 'file'             AS file,
  (e.payload ->> 'line')::integer  AS line,
  e.payload ->> 'summary'          AS summary,
  e.payload ->> 'detail'           AS detail,
  'blocker'::text                  AS severity,
  t.state                          AS task_state,
  t.state NOT IN ('done', 'aborted') AS open
FROM task_events e
JOIN tasks t ON t.id = e.task_id
WHERE e.kind = 'finding_reported';

COMMENT ON VIEW task_findings IS
  'Findings reported through the MCP channel (§11). Every one is a blocker; `open` is derived from the task, since a finding stops blocking only when the work goes green.';

GRANT SELECT ON task_findings TO vorschicht_app;

-- --- escalations an agent prepared -------------------------------------------
-- The agent's half of §6.4. Phase 4 owns the inbox item, the notification and
-- the resume; what it will need from this side is the question, the context and
-- the prepared options, and those are recorded from now on.
--
-- `answered` is false throughout Phase 2 by construction: nothing writes a
-- decision yet. It is projected rather than omitted so that the Phase 4 join
-- has somewhere to land and the dashboard's "N Tasks warten auf deine
-- Entscheidung" counter (§15/§17) is a query against a stable shape.
CREATE OR REPLACE VIEW task_escalations AS
SELECT
  e.task_id,
  e.project_id,
  e.seq,
  e.occurred_at             AS raised_at,
  e.actor                   AS raised_by,
  e.payload ->> 'question'  AS question,
  e.payload ->> 'context'   AS context,
  e.payload ->> 'urgency'   AS urgency,
  COALESCE(e.payload -> 'options', '[]'::jsonb) AS options,
  t.state                   AS task_state,
  false                     AS answered
FROM task_events e
JOIN tasks t ON t.id = e.task_id
WHERE e.kind = 'escalation_requested';

COMMENT ON VIEW task_escalations IS
  'Escalations prepared by agents (§6.4, §15). Phase 4 adds the inbox item, the answer and the resume; the question and its options are recorded from Phase 2 so nothing prepared for the operator is lost.';

GRANT SELECT ON task_escalations TO vorschicht_app;
