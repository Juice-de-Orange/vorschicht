-- =============================================================================
-- 0017 — the continuation of a parked session, queryable (§6.4, A78.5)
--
-- §6.4's round trip makes a continuation its own run, linked to the run that
-- parked. The link is written into `agent_run_events.created` as `resumeOf`,
-- exactly as §6.3's repair leg writes `repairOf` — and `repair_of` has been a
-- column of `agent_runs` since 0011 while its twin would have stayed a JSON
-- probe. One column, one behaviour: the pair is what a trace reads, and leaving
-- half of it in raw payload is the asymmetry that later reads as "resumption
-- was never recorded".
--
-- `CREATE OR REPLACE VIEW` permits appended columns and nothing else, so the
-- existing select list is repeated verbatim (0014's note) and the new column
-- goes at the end.
-- =============================================================================

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
  (array_agg(e.payload ORDER BY e.seq DESC) FILTER (WHERE e.kind = 'result'))[1] -> 'raw'
                                                                            AS result_raw,
  count(*) FILTER (WHERE e.kind = 'hook_event')                             AS hook_events,
  count(*) FILTER (WHERE e.kind = 'tool_use')                               AS tool_uses,
  bool_or(e.kind = 'terminated')                                            AS is_finished,
  count(*) FILTER (WHERE e.kind = 'permission_denied')                      AS permission_denials,
  max(e.payload ->> 'repairOf')  FILTER (WHERE e.kind = 'created')          AS repair_of,
  max((e.payload ->> 'cacheReadTokens')::bigint) FILTER (WHERE e.kind = 'result')
                                                                       AS cache_read_tokens,
  max((e.payload ->> 'cacheCreationTokens')::bigint) FILTER (WHERE e.kind = 'result')
                                                                   AS cache_creation_tokens,
  (array_agg(e.payload ORDER BY e.seq DESC) FILTER (WHERE e.kind = 'result'))[1] -> 'byModel'
                                                                              AS by_model,
  max(e.occurred_at) FILTER (WHERE e.kind = 'result')                       AS spent_at,
  -- --- appended in 0017 ---
  -- Which run this one continues (§6.4). Distinct from `repair_of`, and the
  -- distinction is the whole point: a repair restates a result it already has,
  -- a continuation goes back to work with the operator's decision in hand. Both are the
  -- same session id; only this pair says which of the two happened.
  max(e.payload ->> 'resumeOf')  FILTER (WHERE e.kind = 'created')          AS resumed_of
FROM agent_run_events e
GROUP BY e.run_id;

GRANT SELECT ON agent_runs TO vorschicht_app;
