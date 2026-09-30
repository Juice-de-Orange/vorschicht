-- =============================================================================
-- 0003_runs_and_budget — agent runs, usage samples, guardian state (Phase 1).
--
-- Everything here is append-only, and `agent_runs` is deliberately a **view**
-- rather than a table. §5 makes append-only the rule wherever state history
-- matters, and an `agent_runs` row is precisely where that rule erodes in
-- practice: the run starts, and then something wants to UPDATE it with the
-- final token counts. Modelling the run as its event stream and deriving the
-- summary removes the temptation instead of resisting it — and it makes the
-- Phase 1 chaos test meaningful, because a run interrupted by SIGKILL leaves
-- exactly the events it had emitted, not a half-written row.
-- =============================================================================

-- --- agent_run_events --------------------------------------------------------
CREATE TABLE IF NOT EXISTS agent_run_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id      uuid NOT NULL,
  -- Per-run ordering, assigned by the runner. Wall-clock alone is not enough:
  -- several events can share a millisecond, and their order carries meaning.
  seq         integer NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT agent_run_events_kind CHECK (kind IN (
    -- `created` is written *before* the process is spawned (crash safety):
    -- a run that dies during startup is still a known run, not a ghost.
    'created', 'started', 'assistant_text', 'tool_use', 'hook_event',
    'usage_sample', 'result', 'terminated'
  )),
  CONSTRAINT agent_run_events_seq_positive CHECK (seq >= 0),
  UNIQUE (run_id, seq)
);

CREATE INDEX IF NOT EXISTS agent_run_events_run_idx ON agent_run_events (run_id, seq);
CREATE INDEX IF NOT EXISTS agent_run_events_occurred_at_idx ON agent_run_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS agent_run_events_kind_idx ON agent_run_events (kind, occurred_at DESC);

CREATE OR REPLACE TRIGGER agent_run_events_append_only
  BEFORE UPDATE OR DELETE ON agent_run_events
  FOR EACH ROW EXECUTE FUNCTION vorschicht_deny_mutation();

-- --- agent_runs (derived) ----------------------------------------------------
-- The §5 entity, reconstructed. Note `session_id` and `cwd` come from the
-- `created` event: §6.2 requires resuming from the same directory the session
-- started in, so the pair must survive an orchestrator restart.
CREATE OR REPLACE VIEW agent_runs AS
SELECT
  e.run_id,
  min(e.occurred_at)                                             AS created_at,
  min(e.occurred_at) FILTER (WHERE e.kind = 'started')           AS started_at,
  max(e.occurred_at) FILTER (WHERE e.kind = 'terminated')        AS ended_at,
  max(e.payload ->> 'role')      FILTER (WHERE e.kind = 'created')    AS role,
  max(e.payload ->> 'model')     FILTER (WHERE e.kind = 'created')    AS model,
  max(e.payload ->> 'backend')   FILTER (WHERE e.kind = 'created')    AS backend,
  max(e.payload ->> 'cwd')       FILTER (WHERE e.kind = 'created')    AS cwd,
  max(e.payload ->> 'sessionId') FILTER (WHERE e.kind = 'created')    AS session_id,
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
  bool_or(e.kind = 'terminated')                                            AS is_finished
FROM agent_run_events e
GROUP BY e.run_id;

-- --- usage_samples -----------------------------------------------------------
-- ADR 0001: the raw `rate_limits` object is stored verbatim beside the
-- normalised value, so a later change of shape — or a wrongly configured scale —
-- stays forensically recoverable. `behaviors` from the same response is
-- deliberately NOT stored: unrelated account telemetry, and §18 keeps this
-- forever.
CREATE TABLE IF NOT EXISTS usage_samples (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  observed_at   timestamptz NOT NULL DEFAULT now(),
  window_kind   text NOT NULL,
  model_class   text,
  used_percent  numeric(7,4) NOT NULL,
  resets_at     timestamptz,
  source        text NOT NULL,
  anomaly       jsonb,
  -- Which run produced the reading, when it came from one.
  run_id        uuid,
  raw           jsonb,
  CONSTRAINT usage_samples_source CHECK (source IN ('official', 'estimated')),
  CONSTRAINT usage_samples_percent_range CHECK (used_percent >= 0 AND used_percent <= 100)
);

CREATE INDEX IF NOT EXISTS usage_samples_window_idx
  ON usage_samples (window_kind, model_class, observed_at DESC);
CREATE INDEX IF NOT EXISTS usage_samples_observed_at_idx ON usage_samples (observed_at DESC);

CREATE OR REPLACE TRIGGER usage_samples_append_only
  BEFORE UPDATE OR DELETE ON usage_samples
  FOR EACH ROW EXECUTE FUNCTION vorschicht_deny_mutation();

-- --- guardian_events ---------------------------------------------------------
-- The guardian's state is a projection over usage_samples plus these events;
-- it is never stored as a mutable column. That is what lets the Phase 1 exit
-- gate be met by replaying fixtures, and what lets the live state be rebuilt
-- from scratch after a crash without trusting anything that survived it.
CREATE TABLE IF NOT EXISTS guardian_events (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  state            text NOT NULL,
  reason           jsonb NOT NULL,
  governing_window text,
  latches          jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Manual pause is an operator action (A26) and is audited separately, but the
  -- guardian's own view of it belongs in its history too.
  actor            text NOT NULL DEFAULT 'system',
  CONSTRAINT guardian_events_state CHECK (state IN ('normal', 'wrap_up', 'hard_stop'))
);

CREATE INDEX IF NOT EXISTS guardian_events_occurred_at_idx ON guardian_events (occurred_at DESC);

CREATE OR REPLACE TRIGGER guardian_events_append_only
  BEFORE UPDATE OR DELETE ON guardian_events
  FOR EACH ROW EXECUTE FUNCTION vorschicht_deny_mutation();

-- --- grants ------------------------------------------------------------------
GRANT SELECT, INSERT ON agent_run_events, usage_samples, guardian_events TO vorschicht_app;
REVOKE UPDATE, DELETE, TRUNCATE ON agent_run_events, usage_samples, guardian_events
  FROM vorschicht_app;
GRANT SELECT ON agent_runs TO vorschicht_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vorschicht_app;
