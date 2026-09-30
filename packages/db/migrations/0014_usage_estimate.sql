-- =============================================================================
-- 0014_usage_estimate — what §7.1's fallback meter needs in order to exist.
--
-- Context: on 2026-08-01 the official rate-limit source stopped answering
-- (A59). §7.1 already names the fallback — token accounting — and
-- `UsageMeter.ingestEstimate` was already built and tested. Nothing computed
-- the number. Building the producer surfaced two gaps in what gets written
-- down, and neither is cosmetic.
--
--   1. **`agent_runs.cost_usd` has never been populated.** The view has read
--      `(payload ->> 'costUsd')` off the `result` event since migration 0003
--      and the runner never wrote that key, so the column has been NULL on
--      every run this system has ever recorded. A column with no producer reads
--      as covered — §8.2's sixth domain, found by needing it.
--
--   2. **`input_tokens` is not the input.** Measured on a real result message
--      of this repository's own build loop: `input_tokens: 200` beside
--      `cache_read_input_tokens: 19_213_630`. A meter fed `tokens_in +
--      tokens_out` would have read about half a percent of what the session
--      actually consumed — and undercounting is the direction that authorises
--      spending. The cache figures are therefore recorded alongside, and the
--      estimator meters on `cost_usd`, which is the vendor's own weighting of
--      all four numbers.
--
-- The new table is the third piece. `rate_limit_event` still arrives and still
-- carries `resetsAt` and `rateLimitType` even though it no longer carries a
-- percentage, and the observed five-hour resets land on aligned boundaries
-- (10:00, 15:00, 20:00 UTC) — so `resets_at - 5h` is a window start exactly,
-- and the five-hour estimate stops being a rolling approximation. It is a table
-- rather than an event-stream query because the estimator asks for the newest
-- anchor per window on every tick, and scanning an append-only stream that
-- §18 keeps forever would get slower every day.
-- =============================================================================

ALTER TABLE agent_run_events DROP CONSTRAINT IF EXISTS agent_run_events_kind;
ALTER TABLE agent_run_events ADD CONSTRAINT agent_run_events_kind CHECK (kind IN (
  'created', 'started', 'session_ready', 'assistant_text', 'tool_use',
  'hook_event', 'permission_denied', 'usage_sample',
  -- A window boundary the vendor pushed at us (§7.1, A59).
  'rate_limit_anchor',
  'result', 'terminated'
));

-- --- usage_window_anchors ----------------------------------------------------
-- Append-only like everything else that records observation rather than
-- configuration. `status` is kept because it is the *only* calibration evidence
-- that exists: anything other than 'allowed' means the account was refused at
-- the spend accumulated in that window, which is the cap (A6).
CREATE TABLE IF NOT EXISTS usage_window_anchors (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  observed_at  timestamptz NOT NULL DEFAULT now(),
  window_kind  text NOT NULL,
  resets_at    timestamptz NOT NULL,
  status       text NOT NULL,
  run_id       uuid,
  CONSTRAINT usage_window_anchors_window CHECK (window_kind IN ('five_hour', 'seven_day'))
);

-- One row per boundary, not one per frame: the CLI repeats the same anchor on
-- every request, and eighteen identical rows an hour would bury the one that
-- differs. ON CONFLICT DO NOTHING in the writer relies on this.
CREATE UNIQUE INDEX IF NOT EXISTS usage_window_anchors_unique
  ON usage_window_anchors (window_kind, resets_at);
CREATE INDEX IF NOT EXISTS usage_window_anchors_recent_idx
  ON usage_window_anchors (window_kind, resets_at DESC);

CREATE OR REPLACE TRIGGER usage_window_anchors_append_only
  BEFORE UPDATE OR DELETE ON usage_window_anchors
  FOR EACH ROW EXECUTE FUNCTION vorschicht_deny_mutation();

-- TRUNCATE fires no row-level trigger at all, so this is not redundant with the
-- guard above — that is the hole 0004 exists to close.
CREATE OR REPLACE TRIGGER usage_window_anchors_no_truncate
  BEFORE TRUNCATE ON usage_window_anchors
  FOR EACH STATEMENT EXECUTE FUNCTION vorschicht_deny_truncate();

-- --- agent_runs, widened -----------------------------------------------------
-- CREATE OR REPLACE VIEW permits appended columns and nothing else, so the
-- existing select list is repeated verbatim and the new columns go at the end.
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
  -- --- appended in 0014 ---
  max((e.payload ->> 'cacheReadTokens')::bigint) FILTER (WHERE e.kind = 'result')
                                                                       AS cache_read_tokens,
  max((e.payload ->> 'cacheCreationTokens')::bigint) FILTER (WHERE e.kind = 'result')
                                                                   AS cache_creation_tokens,
  (array_agg(e.payload ORDER BY e.seq DESC) FILTER (WHERE e.kind = 'result'))[1] -> 'byModel'
                                                                              AS by_model,
  -- When the run's spend was recorded. The estimator attributes a whole run to
  -- the instant its result arrived, which is the conservative attribution for a
  -- session straddling a window boundary: the newer window over-counts.
  max(e.occurred_at) FILTER (WHERE e.kind = 'result')                       AS spent_at
FROM agent_run_events e
GROUP BY e.run_id;

GRANT SELECT ON agent_runs TO vorschicht_app;
GRANT SELECT, INSERT ON usage_window_anchors TO vorschicht_app;
REVOKE UPDATE, DELETE, TRUNCATE ON usage_window_anchors FROM vorschicht_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vorschicht_app;
