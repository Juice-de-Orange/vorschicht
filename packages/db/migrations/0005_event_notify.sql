-- =============================================================================
-- 0005_event_notify — fan out new events to the SSE hub (§4, §17).
--
-- The trigger sends only the id and a few routing fields, never the payload.
-- Postgres caps a NOTIFY message at 8000 bytes, and an event payload can carry
-- a diff, a gate output or a result object — so a payload-carrying notification
-- would work in testing and then fail, at runtime, on exactly the interesting
-- events. The hub reads the row by id instead, which also means a client that
-- reconnects mid-stream fetches the same way it catches up.
-- =============================================================================

CREATE OR REPLACE FUNCTION vorschicht_notify_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'vorschicht_events',
    json_build_object(
      'id', NEW.id,
      'kind', NEW.kind,
      'projectId', NEW.project_id,
      'taskId', NEW.task_id,
      'runId', NEW.run_id
    )::text
  );
  RETURN NULL;  -- AFTER trigger; the return value is ignored.
END
$$;

COMMENT ON FUNCTION vorschicht_notify_event() IS
  'Announces a new event_log row to listeners. Carries identifiers only — NOTIFY is capped at 8000 bytes and event payloads are not.';

CREATE OR REPLACE TRIGGER event_log_notify
  AFTER INSERT ON event_log
  FOR EACH ROW EXECUTE FUNCTION vorschicht_notify_event();
