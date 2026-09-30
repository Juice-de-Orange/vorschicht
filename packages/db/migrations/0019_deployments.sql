-- §5's `deployments` entity and §12's release history (Phase 5, foundation).
--
-- Five decisions, in the order they matter.
--
--   1. **A deployment is its event stream** (A43's pattern, fifth use). It has a
--      genuine history and every step of it is a fact somebody will need after
--      the fact: which sha, whether the migration ran, when the swap happened,
--      what the health check said, whether it was rolled back and to what. §12
--      asks for "release history (deploys, durations, rollbacks) visible per
--      project", and a mutable row would answer only the last question. The
--      rollback in particular is the one thing nobody can reconstruct from a
--      current-state row: it is *two* deployments related to each other.
--
--   2. **`deployments` is a view, `deployment_events` the table.** So the
--      append-only guard applies where writes happen, and the projection can
--      widen later without a data migration — which it will, because §12's
--      dashboard and Phase 8's metrics both want columns nobody has asked for
--      yet.
--
--   3. **`rolled_back_to` points at a deployment, not at a sha.** A rollback is
--      "go back to *that* release", and the release carries the image tag or the
--      directory name that actually exists on the target. Storing the sha again
--      would make the two rows agree until somebody pruned the artefact the
--      older one named, and then the link would still look sound.
--
--   4. **The health result is stored with its evidence.** `health_ok` is the
--      verdict; `health_detail` is the last response or the error. §12's
--      rollback escalates "with full logs", and a P0 card that says only
--      "unhealthy" sends the operator to a terminal at three in the morning.
--
--   5. **§9 gains exactly one edge: `deploying → needs_decision`.** A12 reserves
--      every self-deploy for the operator, and A24 stops a non-backward-compatible
--      migration before it rolls out — both are a task standing still *at the
--      deploy*, waiting for an inbox answer. `task_transitions` is the SQL half
--      of the deliberate duplicate A43.1 describes; `TASK_TRANSITIONS` in
--      `@vorschicht/shared` is the other, and `tasks.itest.ts` fails the build
--      when they drift. The way back needs no row: `deploying` is an active
--      state, so `needs_decision → deploying` is already seeded.

CREATE TABLE IF NOT EXISTS deployment_events (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  deployment_id  uuid        NOT NULL,
  seq            integer     NOT NULL,
  kind           text        NOT NULL,
  actor          text        NOT NULL,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  payload        jsonb       NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT deployment_events_seq_positive CHECK (seq >= 0),
  CONSTRAINT deployment_events_kind CHECK (kind IN (
    -- The deployment exists and names its target. Always `seq` 0.
    'started',
    -- A24's order, each recorded as it happens rather than inferred afterwards.
    'migrated',
    'swapped',
    -- The verdict, with the evidence that produced it.
    'health_checked',
    'smoke_checked',
    -- Terminal, exactly one of the three.
    'succeeded',
    'rolled_back',
    'failed'
  )),
  CONSTRAINT deployment_events_seq_unique UNIQUE (deployment_id, seq)
);

CREATE INDEX IF NOT EXISTS deployment_events_deployment_idx
  ON deployment_events (deployment_id, seq);
CREATE INDEX IF NOT EXISTS deployment_events_time_idx
  ON deployment_events (occurred_at DESC);

GRANT SELECT, INSERT ON deployment_events TO vorschicht_app;

-- Append-only, like every other log in this schema (§18: never delete).
CREATE OR REPLACE FUNCTION deployment_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'deployment_events ist append-only (§18) — % ist nicht erlaubt', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER deployment_events_append_only
  BEFORE UPDATE OR DELETE ON deployment_events
  FOR EACH ROW EXECUTE FUNCTION deployment_events_append_only();

-- A row-level trigger never sees TRUNCATE; this is the statement-level half.
CREATE OR REPLACE TRIGGER deployment_events_no_truncate
  BEFORE TRUNCATE ON deployment_events
  FOR EACH STATEMENT EXECUTE FUNCTION deployment_events_append_only();

CREATE OR REPLACE VIEW deployments AS
WITH origin AS (
  -- `DISTINCT ON` rather than a bare filter: `started` is `seq` 0 by
  -- construction, and a second one would silently double every row of this
  -- view through the joins below. Cheap insurance against a writer that gets
  -- it wrong — which is exactly what happened while this was being built.
  SELECT DISTINCT ON (deployment_id)
         deployment_id, occurred_at AS started_at, actor AS started_by, payload
  FROM deployment_events WHERE kind = 'started' ORDER BY deployment_id, seq
),
-- **The artifact that actually served**, not the one that was prepared.
-- A rollback points at a release that is still on the machine, so the fact
-- worth recording is the swap; a prepare that never got swapped in is a
-- build, not a release.
swapped AS (
  SELECT DISTINCT ON (deployment_id) deployment_id, payload ->> 'artifact' AS artifact
  FROM deployment_events WHERE kind = 'swapped' ORDER BY deployment_id, seq
),
last_event AS (
  SELECT DISTINCT ON (deployment_id) deployment_id, kind, occurred_at
  FROM deployment_events ORDER BY deployment_id, seq DESC
),
health AS (
  SELECT DISTINCT ON (deployment_id) deployment_id,
         (payload ->> 'ok')::boolean AS health_ok,
         payload ->> 'detail'        AS health_detail
  FROM deployment_events WHERE kind = 'health_checked'
  ORDER BY deployment_id, seq DESC
),
finish AS (
  SELECT DISTINCT ON (deployment_id) deployment_id, kind, occurred_at,
         (payload ->> 'rolledBackTo')::uuid AS rolled_back_to,
         payload ->> 'problem'              AS problem
  FROM deployment_events
  WHERE kind IN ('succeeded', 'rolled_back', 'failed')
  ORDER BY deployment_id, seq DESC
)
SELECT
  o.deployment_id                            AS id,
  (o.payload ->> 'projectId')::uuid          AS project_id,
  (o.payload ->> 'taskId')::uuid             AS task_id,
  o.payload ->> 'sha'                        AS sha,
  o.payload ->> 'method'                     AS method,
  -- The image tag or the release directory: what actually exists on the target,
  -- and therefore what a rollback can point back at.
  COALESCE(w.artifact, o.payload ->> 'artifact') AS artifact,
  o.started_at,
  o.started_by,
  l.kind                                     AS last_step,
  h.health_ok,
  h.health_detail,
  f.kind                                     AS outcome,
  f.occurred_at                              AS finished_at,
  f.rolled_back_to,
  f.problem,
  -- Null while it runs. §12 wants durations in the release history, and
  -- computing them here keeps the one definition in one place.
  EXTRACT(EPOCH FROM (f.occurred_at - o.started_at)) * 1000 AS duration_ms
FROM origin o
LEFT JOIN swapped    w USING (deployment_id)
LEFT JOIN last_event l USING (deployment_id)
LEFT JOIN health     h USING (deployment_id)
LEFT JOIN finish     f USING (deployment_id);

COMMENT ON VIEW deployments IS
  '§5 deployments / §12 release history, projected from deployment_events.';

GRANT SELECT ON deployments TO vorschicht_app;

-- §9's map gains exactly one edge — see decision 5 in the header.
INSERT INTO task_transitions (state_from, state_to) VALUES ('deploying', 'needs_decision')
  ON CONFLICT DO NOTHING;
