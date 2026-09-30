-- =============================================================================
-- 0001_foundation — projects, event_log, audit_log (Phase 0, step 3)
--
-- Append-only is enforced here, in the database, rather than trusted to
-- application discipline. Two independent layers:
--
--   1. A BEFORE UPDATE OR DELETE trigger that raises. This binds *everyone*,
--      including the table owner and including a migration that forgets.
--   2. REVOKE UPDATE/DELETE/TRUNCATE from the runtime role, so the app cannot
--      even attempt it.
--
-- Layer 1 alone would be enough to stop the write; layer 2 makes the intent
-- visible in the privilege system, where an auditor looks. §18 calls the event
-- log the source of truth and says "never delete" — this is that sentence,
-- expressed in a way that survives a tired evening.
-- =============================================================================

-- --- runtime role ------------------------------------------------------------
-- Created idempotently. The password is set from the environment by the compose
-- entrypoint, never here — a password in a checked-in migration is a leak.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'vorschicht_app') THEN
    CREATE ROLE vorschicht_app LOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO vorschicht_app;

-- --- append-only guard -------------------------------------------------------
CREATE OR REPLACE FUNCTION vorschicht_deny_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'Tabelle % ist append-only (§5/§18): % ist nicht erlaubt',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'restrict_violation';
END
$$;

COMMENT ON FUNCTION vorschicht_deny_mutation() IS
  'Guard for append-only tables. Attached as <table>_append_only. Never drop or disable: gate:migrations fails the build if a migration tries.';

-- --- projects ----------------------------------------------------------------
-- Pure configuration, therefore mutable (§5). Every change is written to
-- audit_log by the application layer, which is append-only.
CREATE TABLE IF NOT EXISTS projects (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug               text NOT NULL UNIQUE,
  name               text NOT NULL,
  -- Absolute path under the projects root (A33: /opt on the production host).
  root_path          text NOT NULL,
  repo_url           text,
  -- Reference into the secret regime, never the token itself (§19, A20).
  git_access_ref     text,
  gate_config        jsonb NOT NULL DEFAULT '{}'::jsonb,
  deploy_config      jsonb NOT NULL DEFAULT '{"method":"none"}'::jsonb,
  claim_granularity  text NOT NULL DEFAULT 'file',
  -- Vorschicht itself is onboarded as a project; deploying it needs the operator's
  -- explicit approval every time (§12, A12).
  self_managed       boolean NOT NULL DEFAULT false,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT projects_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]*$'),
  CONSTRAINT projects_root_path_absolute CHECK (root_path LIKE '/%'),
  CONSTRAINT projects_claim_granularity CHECK (claim_granularity IN ('file', 'directory', 'package'))
);

GRANT SELECT, INSERT, UPDATE, DELETE ON projects TO vorschicht_app;

-- --- event_log ---------------------------------------------------------------
-- The system's source of truth (§18). Everything meaningful lands here; the
-- dashboard renders from it; nothing ever deletes from it.
CREATE TABLE IF NOT EXISTS event_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL,
  -- Correlation ids (§18). Deliberately not foreign keys: an event about a
  -- deleted-from-config project must still be readable years later.
  project_id  uuid,
  task_id     uuid,
  run_id      uuid,
  deploy_id   uuid,
  -- 'system', 'max', or a role name such as 'reviewer'.
  actor       text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT event_log_kind_format CHECK (kind ~ '^[a-z][a-z0-9_.]*$')
);

CREATE INDEX IF NOT EXISTS event_log_occurred_at_idx ON event_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS event_log_kind_idx ON event_log (kind, occurred_at DESC);
CREATE INDEX IF NOT EXISTS event_log_task_idx ON event_log (task_id, occurred_at DESC)
  WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS event_log_project_idx ON event_log (project_id, occurred_at DESC)
  WHERE project_id IS NOT NULL;

-- CREATE OR REPLACE (PG14+) rather than plain CREATE: the whole migration must
-- be safely re-runnable, or a retried apply turns a recoverable hiccup into a
-- half-migrated schema.
CREATE OR REPLACE TRIGGER event_log_append_only
  BEFORE UPDATE OR DELETE ON event_log
  FOR EACH ROW EXECUTE FUNCTION vorschicht_deny_mutation();

GRANT SELECT, INSERT ON event_log TO vorschicht_app;
REVOKE UPDATE, DELETE, TRUNCATE ON event_log FROM vorschicht_app;

-- --- audit_log ---------------------------------------------------------------
-- Every dashboard action and every config change (§19). Separate from
-- event_log because its retention and its audience differ: this is the "who
-- changed what" record, and it must be readable without wading through
-- operational noise.
CREATE TABLE IF NOT EXISTS audit_log (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor       text NOT NULL,
  action      text NOT NULL,
  subject     text,
  before      jsonb,
  after       jsonb,
  ip          inet,
  user_agent  text,
  CONSTRAINT audit_log_action_format CHECK (action ~ '^[a-z][a-z0-9_.]*$')
);

CREATE INDEX IF NOT EXISTS audit_log_occurred_at_idx ON audit_log (occurred_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor, occurred_at DESC);

-- CREATE OR REPLACE (PG14+) rather than plain CREATE: the whole migration must
-- be safely re-runnable, or a retried apply turns a recoverable hiccup into a
-- half-migrated schema.
CREATE OR REPLACE TRIGGER audit_log_append_only
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION vorschicht_deny_mutation();

GRANT SELECT, INSERT ON audit_log TO vorschicht_app;
REVOKE UPDATE, DELETE, TRUNCATE ON audit_log FROM vorschicht_app;

GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vorschicht_app;
