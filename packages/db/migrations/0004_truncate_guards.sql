-- =============================================================================
-- 0004_truncate_guards — close the TRUNCATE hole in the append-only guarantee.
--
-- The row-level BEFORE UPDATE OR DELETE triggers from 0001–0003 do exactly what
-- they promise, and nothing more: **TRUNCATE does not fire row-level triggers
-- at all**. So `TRUNCATE event_log` would have emptied the source of truth in
-- silence, without touching a single guard.
--
-- The privilege system already refuses this for the runtime role (TRUNCATE is
-- revoked), but §18 says the event log is never deleted — not "never deleted by
-- the app role". A statement-level trigger binds the owner too, which is the
-- account a tired operator or a careless migration actually uses.
--
-- Found by a test that expected DELETE to be refused on an empty table and
-- discovered that a row trigger has nothing to fire on.
-- =============================================================================

CREATE OR REPLACE FUNCTION vorschicht_deny_truncate() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'Tabelle % ist append-only (§5/§18): TRUNCATE ist nicht erlaubt',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END
$$;

COMMENT ON FUNCTION vorschicht_deny_truncate() IS
  'Statement-level guard for append-only tables. TRUNCATE bypasses row-level triggers entirely, so this is not redundant with vorschicht_deny_mutation().';

DO $$
DECLARE
  target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'event_log', 'audit_log', 'auth_events',
    'agent_run_events', 'usage_samples', 'guardian_events'
  ] LOOP
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER %I BEFORE TRUNCATE ON %I '
      'FOR EACH STATEMENT EXECUTE FUNCTION vorschicht_deny_truncate()',
      target || '_no_truncate', target
    );
  END LOOP;
END
$$;
