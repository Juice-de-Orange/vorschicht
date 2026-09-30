-- =============================================================================
-- 0011_run_records — what the runner has to be able to write down.
--
-- Three changes, each of them a gap that only appeared once a session was
-- actually executed end to end rather than described.
--
--   1. Two new event kinds. `session_ready` records what a session started
--      with — which MCP servers answered and which tools it actually had —
--      because "the server was still pending at init" is invisible afterwards
--      and is the difference between a task that failed and a harness that did
--      (§11, A25, A49). `permission_denied` records every refused tool call,
--      which is the §6.6 audit trail the Phase 2 containment gate asks for; it
--      was being dropped on the floor because the CHECK constraint had no name
--      for it.
--
--   2. `session_id` may now also come from the `started` event. The runner
--      writes `created` **before** it touches the backend, so that no process
--      can exist without a run row to reconcile — and at that moment the
--      session id does not exist yet, because the backend assigns it when it
--      spawns. Reading the id from either event keeps both properties: the run
--      is recorded before it can run, and §6.2's resume still finds the pair
--      (session_id, cwd) it needs.
--
--   3. `permission_denials` as a count on the view, beside `hook_events` and
--      `tool_uses`. A run where containment refused something is a fact about
--      that run, and it should be answerable without reading the event stream.
--
-- New columns are appended at the end of the view's select list: CREATE OR
-- REPLACE VIEW permits additions there and nothing else, which is why the
-- existing columns are repeated verbatim.
-- =============================================================================

ALTER TABLE agent_run_events DROP CONSTRAINT IF EXISTS agent_run_events_kind;
ALTER TABLE agent_run_events ADD CONSTRAINT agent_run_events_kind CHECK (kind IN (
  -- `created` is written *before* the process is spawned (crash safety):
  -- a run that dies during startup is still a known run, not a ghost.
  'created', 'started', 'session_ready', 'assistant_text', 'tool_use',
  'hook_event', 'permission_denied', 'usage_sample', 'result', 'terminated'
));

CREATE OR REPLACE VIEW agent_runs AS
SELECT
  e.run_id,
  min(e.occurred_at)                                             AS created_at,
  min(e.occurred_at) FILTER (WHERE e.kind = 'started')            AS started_at,
  max(e.occurred_at) FILTER (WHERE e.kind = 'terminated')         AS ended_at,
  max(e.payload ->> 'role')      FILTER (WHERE e.kind = 'created')    AS role,
  max(e.payload ->> 'model')     FILTER (WHERE e.kind = 'created')    AS model,
  max(e.payload ->> 'backend')   FILTER (WHERE e.kind = 'created')    AS backend,
  max(e.payload ->> 'cwd')       FILTER (WHERE e.kind = 'created')    AS cwd,
  -- The session id is assigned by the backend at spawn time, i.e. after
  -- `created` has been written. `created` still carries it for any backend that
  -- knows the id up front; `started` carries it for the ones that do not.
  COALESCE(
    max(e.payload ->> 'sessionId') FILTER (WHERE e.kind = 'created'),
    max(e.payload ->> 'sessionId') FILTER (WHERE e.kind = 'started')
  )                                                                   AS session_id,
  max(e.payload ->> 'taskId')    FILTER (WHERE e.kind = 'created')    AS task_id,
  max(e.payload ->> 'transcriptPath') FILTER (WHERE e.kind IN ('started', 'terminated'))
                                                                      AS transcript_path,
  max(e.payload ->> 'reason')    FILTER (WHERE e.kind = 'terminated')  AS terminal_reason,
  max((e.payload ->> 'exitCode')::int) FILTER (WHERE e.kind = 'terminated') AS exit_code,
  max((e.payload ->> 'tokensIn')::bigint)  FILTER (WHERE e.kind = 'result') AS tokens_in,
  max((e.payload ->> 'tokensOut')::bigint) FILTER (WHERE e.kind = 'result') AS tokens_out,
  max((e.payload ->> 'costUsd')::numeric)  FILTER (WHERE e.kind = 'result') AS cost_usd,
  -- No max() for jsonb, and none is wanted: take the last `result` payload by
  -- sequence, which is the one a repair re-prompt would have replaced (§6.3).
  (array_agg(e.payload ORDER BY e.seq DESC) FILTER (WHERE e.kind = 'result'))[1] -> 'raw'
                                                                            AS result_raw,
  count(*) FILTER (WHERE e.kind = 'hook_event')                             AS hook_events,
  count(*) FILTER (WHERE e.kind = 'tool_use')                               AS tool_uses,
  -- A run with no `terminated` event is either live or was interrupted; the
  -- reconciler on startup decides which, and §7.2 marks the latter
  -- `interrupted` for a mandatory integrity re-check.
  bool_or(e.kind = 'terminated')                                            AS is_finished,
  -- --- appended in 0011 ---
  count(*) FILTER (WHERE e.kind = 'permission_denied')                      AS permission_denials,
  -- Which run this one repairs (§6.3: exactly one repair attempt per result).
  max(e.payload ->> 'repairOf')  FILTER (WHERE e.kind = 'created')          AS repair_of
FROM agent_run_events e
GROUP BY e.run_id;

GRANT SELECT ON agent_runs TO vorschicht_app;
