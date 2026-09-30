-- =============================================================================
-- 0007_build_reports — the build's own progress, where the operator actually looks.
--
-- Until now the build reported to four places: the build log for the state,
-- the git log for what got done, `.build-logs/*.jsonl` for what it is thinking,
-- and a Markdown section for its questions. All of them on the machine doing
-- the building, none of them in the dashboard on the production host — so the one screen
-- that is supposed to answer "is everything fine" could not see the build at
-- all.
--
-- A report is a snapshot rather than a diff: it is cheap, it survives a missed
-- push, and the latest row is always the whole truth. Append-only like the rest
-- of the history, so "what did it look like on Tuesday" stays answerable.
-- =============================================================================

CREATE TABLE IF NOT EXISTS build_reports (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  reported_at    timestamptz NOT NULL DEFAULT now(),
  -- Free text from the build log — the phase line as a human wrote it.
  phase          text NOT NULL,
  step           text,
  gates_green    integer NOT NULL DEFAULT 0,
  gates_deferred integer NOT NULL DEFAULT 0,
  gates_open     integer NOT NULL DEFAULT 0,
  commits        integer NOT NULL DEFAULT 0,
  head_sha       text,
  head_subject   text,
  -- Whether the unattended loop was alive when this was reported. A report that
  -- says "loop stopped" is as informative as one that says it is working.
  loop_running   boolean NOT NULL DEFAULT false,
  -- The open questions, as headings. The full text stays in the operator's checklist
  -- until the escalation inbox (§15, Phase 4) can carry it properly.
  questions      jsonb NOT NULL DEFAULT '[]'::jsonb,
  raw            jsonb,
  CONSTRAINT build_reports_counts_sane CHECK (
    gates_green >= 0 AND gates_deferred >= 0 AND gates_open >= 0 AND commits >= 0
  )
);

CREATE INDEX IF NOT EXISTS build_reports_reported_at_idx ON build_reports (reported_at DESC);

CREATE OR REPLACE TRIGGER build_reports_append_only
  BEFORE UPDATE OR DELETE ON build_reports
  FOR EACH ROW EXECUTE FUNCTION vorschicht_deny_mutation();

CREATE OR REPLACE TRIGGER build_reports_no_truncate
  BEFORE TRUNCATE ON build_reports
  FOR EACH STATEMENT EXECUTE FUNCTION vorschicht_deny_truncate();

GRANT SELECT, INSERT ON build_reports TO vorschicht_app;
REVOKE UPDATE, DELETE, TRUNCATE ON build_reports FROM vorschicht_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vorschicht_app;
