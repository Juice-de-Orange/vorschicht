-- =============================================================================
-- 0013_audits — §5's `audits` / `audit_findings`, and the record behind the one
-- authority in this system that runs backwards.
--
-- Both entities follow A43's precedent for the third time (tasks 0006, claims
-- 0009, worktrees 0008): the append-only log is the table, the entity is a view
-- over it. Here the reason is not merely consistency. §8.2 gives an audit
-- finding a *history* — it is raised, then confirmed or dismissed, then possibly
-- re-opened exactly once, then resolved or waived — and §5 asks for "the
-- dismissal/confirmation history each one accumulates". A mutable `status`
-- column would answer "what is it now" and lose "how did it get there", which is
-- precisely the question that decides whether a re-raise is the auditor's first
-- word or its last.
--
-- Two properties of the audit record are §8.2 requirements rather than schema
-- taste:
--
--   * **The sample is stored, not just the verdict.** "Sampling is randomised
--     but recorded, so a later audit can re-check the same sample, and every
--     sample must include at least one item a previous audit passed." That is a
--     column, not a convention — without it, regression testing the auditor is
--     impossible after the fact.
--
--   * **A run that never finished still leaves a row.** §8.2 measures Bruno on
--     finding nothing (rule 5: prolonged silence is itself an inbox item), and
--     an audit that crashed and an audit that found nothing are indistinguishable
--     if only completions are written. `started` is appended before the session
--     is spawned, exactly as the runner writes `created` before it touches the
--     backend.
-- =============================================================================

-- --- audit_events ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  audit_id    uuid NOT NULL,
  seq         integer NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL CHECK (kind IN ('started', 'finished', 'failed')),
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (audit_id, seq)
);

CREATE INDEX IF NOT EXISTS audit_events_audit_idx ON audit_events (audit_id, seq);
CREATE INDEX IF NOT EXISTS audit_events_occurred_idx ON audit_events (occurred_at DESC);

CREATE OR REPLACE TRIGGER audit_events_append_only
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION vorschicht_deny_mutation();

CREATE OR REPLACE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION vorschicht_deny_truncate();

-- --- audits (derived) --------------------------------------------------------
-- One row per Betriebsprüfung run (§8.2), in the shape the Prüfbericht archive
-- and the weekly report (§16.5) read.
--
-- `sample` is what the service proposed and `reported_sample` is what the
-- auditor says it actually examined. Keeping both is the cheapest possible
-- check on the auditor itself: a run whose reported sample has nothing to do
-- with the one it was handed examined something else, and only the pair can say
-- so.
CREATE OR REPLACE VIEW audits AS
SELECT
  e.audit_id                                                          AS id,
  min(e.occurred_at)                                                  AS started_at,
  max(e.occurred_at) FILTER (WHERE e.kind IN ('finished', 'failed'))   AS finished_at,
  max(e.payload ->> 'domain')  FILTER (WHERE e.kind = 'started')       AS domain,
  max(e.payload ->> 'trigger') FILTER (WHERE e.kind = 'started')       AS trigger,
  max(e.payload ->> 'scope')   FILTER (WHERE e.kind = 'started')       AS scope,
  COALESCE(
    (array_agg(e.payload -> 'sample' ORDER BY e.seq) FILTER (WHERE e.kind = 'started'))[1],
    '[]'::jsonb
  )                                                                    AS sample,
  COALESCE(
    (array_agg(e.payload -> 'reportedSample' ORDER BY e.seq DESC)
       FILTER (WHERE e.kind = 'finished'))[1],
    '[]'::jsonb
  )                                                                    AS reported_sample,
  COALESCE(
    (array_agg(e.payload -> 'scopeLimits' ORDER BY e.seq DESC)
       FILTER (WHERE e.kind = 'finished'))[1],
    '[]'::jsonb
  )                                                                    AS scope_limits,
  max(e.payload ->> 'verdict') FILTER (WHERE e.kind = 'finished')      AS verdict,
  max(e.payload ->> 'report')  FILTER (WHERE e.kind = 'finished')      AS report,
  max(e.payload ->> 'problem') FILTER (WHERE e.kind = 'failed')        AS problem,
  COALESCE(
    max(e.payload ->> 'runId') FILTER (WHERE e.kind IN ('finished', 'failed')),
    max(e.payload ->> 'runId') FILTER (WHERE e.kind = 'started')
  )                                                                    AS run_id,
  CASE
    WHEN bool_or(e.kind = 'finished') THEN 'done'
    WHEN bool_or(e.kind = 'failed')   THEN 'failed'
    ELSE 'running'
  END                                                                  AS outcome
FROM audit_events e
GROUP BY e.audit_id;

COMMENT ON VIEW audits IS
  'The §5 audits entity, projected from audit_events: one row per Betriebsprüfung run (§8.2).';

-- --- audit_finding_events ----------------------------------------------------
-- The history §5 asks for. `raised` carries the immutable facts; everything
-- after it is what happened to the finding afterwards.
--
--   raised     the audit reported it
--   applied    a consequence was carried out (the gate un-tick, the fix task)
--   confirmed  the dev chain accepted it as real
--   dismissed  the dev chain rejected it
--   reopened   the next audit re-raised it with the dismissal as evidence (§8.2)
--   resolved   the fix merged
--   waived     the operator decided it stands as it is
--   escalated  a second dismissal — it goes to the operator as a decision, not round again
CREATE TABLE IF NOT EXISTS audit_finding_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  finding_id  uuid NOT NULL,
  seq         integer NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL CHECK (kind IN (
    'raised', 'applied', 'confirmed', 'dismissed', 'reopened',
    'resolved', 'waived', 'escalated'
  )),
  actor       text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (finding_id, seq)
);

CREATE INDEX IF NOT EXISTS audit_finding_events_finding_idx
  ON audit_finding_events (finding_id, seq);

CREATE OR REPLACE TRIGGER audit_finding_events_append_only
  BEFORE UPDATE OR DELETE ON audit_finding_events
  FOR EACH ROW EXECUTE FUNCTION vorschicht_deny_mutation();

CREATE OR REPLACE TRIGGER audit_finding_events_no_truncate
  BEFORE TRUNCATE ON audit_finding_events
  FOR EACH STATEMENT EXECUTE FUNCTION vorschicht_deny_truncate();

-- --- audit_findings (derived) ------------------------------------------------
-- `status` is the most recent status-changing event, and `dismissals` is the
-- count that makes §8.2's "re-opened exactly once" a rule rather than a habit:
-- at one, the next audit re-examines; at two, it becomes the operator's decision.
CREATE OR REPLACE VIEW audit_findings AS
WITH raised AS (
  SELECT finding_id, occurred_at, payload
  FROM audit_finding_events WHERE kind = 'raised'
),
status AS (
  SELECT DISTINCT ON (finding_id) finding_id, kind, occurred_at, payload
  FROM audit_finding_events
  WHERE kind IN ('raised', 'confirmed', 'dismissed', 'reopened', 'resolved', 'waived', 'escalated')
  ORDER BY finding_id, seq DESC
),
counts AS (
  SELECT finding_id,
         count(*) FILTER (WHERE kind = 'dismissed')                        AS dismissals,
         bool_or(kind = 'applied')                                         AS applied,
         max(payload ->> 'fixTaskId') FILTER (WHERE kind = 'applied')      AS fix_task_id,
         max(payload ->> 'problem')   FILTER (WHERE kind = 'applied')      AS apply_problem
  FROM audit_finding_events GROUP BY finding_id
)
SELECT
  r.finding_id                          AS id,
  (r.payload ->> 'auditId')::uuid       AS audit_id,
  r.payload ->> 'domain'                AS domain,
  r.payload ->> 'class'                 AS class,
  r.payload ->> 'summary'               AS summary,
  r.payload ->> 'evidence'              AS evidence,
  r.payload ->> 'gate'                  AS gate,
  r.payload ->> 'guard'                 AS guard,
  r.payload ->> 'reopens'               AS reopens,
  r.occurred_at                         AS raised_at,
  CASE s.kind
    WHEN 'raised'   THEN 'open'
    WHEN 'reopened' THEN 'open'
    ELSE s.kind
  END                                   AS status,
  s.occurred_at                         AS status_at,
  s.payload ->> 'reason'                AS status_reason,
  COALESCE(c.dismissals, 0)             AS dismissals,
  COALESCE(c.applied, false)            AS applied,
  c.fix_task_id,
  c.apply_problem
FROM raised r
JOIN status s USING (finding_id)
LEFT JOIN counts c USING (finding_id);

COMMENT ON VIEW audit_findings IS
  'The §5 audit_findings entity: class, evidence, and the dismissal/confirmation history (§8.2).';

GRANT SELECT, INSERT ON audit_events, audit_finding_events TO vorschicht_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_events, audit_finding_events FROM vorschicht_app;
GRANT SELECT ON audits, audit_findings TO vorschicht_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vorschicht_app;
