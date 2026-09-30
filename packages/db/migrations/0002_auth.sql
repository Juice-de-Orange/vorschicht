-- =============================================================================
-- 0002_auth — WebAuthn credentials, one-time invites, sessions (§19).
--
-- The dashboard is deliberately reachable from the public internet (§2), so
-- this table set is the front door. Three deliberate choices:
--
--   * **Invites are single-use and minted only from a host shell.** There is no
--     open registration endpoint at any point in the lifecycle, not even on an
--     empty database. Someone who can mint an invite already has SSH on
--     the production host, which outranks any passkey.
--   * **Only hashes are stored** for invites and sessions. A database dump —
--     which the backup sidecar produces nightly and ships off-site — must not
--     hand anyone a working session.
--   * **`auth_events` is append-only.** Who logged in, from where, and every
--     refused attempt: exactly the record that has to survive an incident, and
--     therefore exactly the record an attacker would want to edit.
-- =============================================================================

-- --- credentials -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS credentials (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Base64url credential id as sent by the authenticator.
  credential_id  text NOT NULL UNIQUE,
  public_key     bytea NOT NULL,
  -- Signature counter; a decrease indicates a cloned authenticator.
  counter        bigint NOT NULL DEFAULT 0,
  transports     text[] NOT NULL DEFAULT '{}',
  backed_up      boolean NOT NULL DEFAULT false,
  -- Human label, e.g. "Handy" or "Desktop" — shown in settings.
  label          text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  last_used_at   timestamptz,
  CONSTRAINT credentials_label_not_blank CHECK (length(btrim(label)) > 0)
);

-- --- invites -----------------------------------------------------------------
-- Minted by `vorschicht-invite` on the host. Short-lived and single-use: an
-- invite that lingers is a standing registration hole on a public endpoint.
CREATE TABLE IF NOT EXISTS invites (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL UNIQUE,
  purpose     text NOT NULL DEFAULT 'bootstrap',
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  used_by     uuid REFERENCES credentials(id),
  CONSTRAINT invites_purpose CHECK (purpose IN ('bootstrap', 'rescue', 'additional'))
);

CREATE INDEX IF NOT EXISTS invites_open_idx ON invites (expires_at)
  WHERE used_at IS NULL;

-- --- sessions ----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash     text NOT NULL UNIQUE,
  credential_id  uuid NOT NULL REFERENCES credentials(id) ON DELETE CASCADE,
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL,
  last_seen_at   timestamptz NOT NULL DEFAULT now(),
  revoked_at     timestamptz,
  user_agent     text,
  ip             inet
);

CREATE INDEX IF NOT EXISTS sessions_active_idx ON sessions (expires_at)
  WHERE revoked_at IS NULL;

-- --- challenges --------------------------------------------------------------
-- WebAuthn ceremonies are two-legged; the challenge issued in leg one must be
-- verified in leg two. Kept in the database rather than in memory so a restart
-- between the legs fails cleanly instead of mysteriously.
CREATE TABLE IF NOT EXISTS auth_challenges (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  challenge  text NOT NULL UNIQUE,
  kind       text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CONSTRAINT auth_challenges_kind CHECK (kind IN ('registration', 'authentication'))
);

CREATE INDEX IF NOT EXISTS auth_challenges_expiry_idx ON auth_challenges (expires_at);

-- --- auth_events (append-only) -----------------------------------------------
CREATE TABLE IF NOT EXISTS auth_events (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  kind        text NOT NULL,
  outcome     text NOT NULL,
  detail      text,
  ip          inet,
  user_agent  text,
  CONSTRAINT auth_events_outcome CHECK (outcome IN ('ok', 'refused', 'error'))
);

CREATE INDEX IF NOT EXISTS auth_events_occurred_at_idx ON auth_events (occurred_at DESC);

CREATE OR REPLACE TRIGGER auth_events_append_only
  BEFORE UPDATE OR DELETE ON auth_events
  FOR EACH ROW EXECUTE FUNCTION vorschicht_deny_mutation();

-- --- grants ------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON credentials, invites, sessions, auth_challenges
  TO vorschicht_app;
GRANT SELECT, INSERT ON auth_events TO vorschicht_app;
REVOKE UPDATE, DELETE, TRUNCATE ON auth_events FROM vorschicht_app;
