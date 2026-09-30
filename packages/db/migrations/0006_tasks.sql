-- =============================================================================
-- 0006_tasks — the unit of work (§5, §9), as its own event stream.
--
-- Same shape as `agent_runs` in 0003, for the same reason: §9 ends with "Every
-- state change = one `task_events` row. No silent transitions", and a mutable
-- `tasks.state` column is precisely where that sentence would have died. So the
-- table is the log and `tasks` is a view over it — the task *is* its last event.
--
-- Three guarantees are enforced here rather than in application code, because
-- each of them protects against a writer that did not go through the service:
--
--   1. **Append-only** (§5/§18), like every other history table.
--   2. **Gap-free `seq`.** The next event must be exactly `max(seq) + 1`. With
--      the UNIQUE(task_id, seq) constraint that turns into optimistic
--      concurrency for free: two workers that both read state `coding` both try
--      to write seq 7, and exactly one succeeds. Without it, two schedulers
--      could hand the same task to two coders and both would look correct.
--   3. **The transition map of §9.** Seeded into `task_transitions` and checked
--      by trigger, including the two rules that a plain edge list cannot carry:
--      a resume must return to the state it was suspended from, and work that a
--      hard stop interrupted needs the §7.2 integrity re-check before it moves.
--
-- The map is written twice — here and in packages/shared/src/task-state.ts —
-- with `tasks.itest.ts` failing the build if the two drift. That is the same
-- bargain the Drizzle mirror makes, and the reason is the same: a check
-- constraint cannot import TypeScript, and a guard that only exists in the
-- language the application happens to be written in is not a guard.
-- =============================================================================

-- --- transition map ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS task_transitions (
  state_from text NOT NULL,
  state_to   text NOT NULL,
  PRIMARY KEY (state_from, state_to)
);

COMMENT ON TABLE task_transitions IS
  'The §9 lifecycle as data. Mirrored by TASK_TRANSITIONS in @vorschicht/shared; tasks.itest.ts fails on drift.';

-- Re-runnable: the map is structure, not history, so it is replaced wholesale.
DELETE FROM task_transitions;
INSERT INTO task_transitions (state_from, state_to) VALUES
  ('draft', 'queued'), ('draft', 'aborted'),
  ('queued', 'planning'), ('queued', 'aborted'),
  ('planning', 'claimed'), ('planning', 'red'), ('planning', 'needs_decision'),
  ('planning', 'parked'), ('planning', 'interrupted'), ('planning', 'aborted'),
  ('claimed', 'coding'), ('claimed', 'red'), ('claimed', 'needs_decision'),
  ('claimed', 'parked'), ('claimed', 'interrupted'), ('claimed', 'aborted'),
  ('coding', 'review'), ('coding', 'red'), ('coding', 'needs_decision'),
  ('coding', 'parked'), ('coding', 'interrupted'), ('coding', 'aborted'),
  -- §8.1: changes_requested goes back to the coder, and every finding blocks.
  ('review', 'gates'), ('review', 'coding'), ('review', 'red'),
  ('review', 'needs_decision'), ('review', 'parked'), ('review', 'interrupted'),
  ('review', 'aborted'),
  -- §11: finding → fix → re-run, on the same task.
  ('gates', 'merge_queue'), ('gates', 'coding'), ('gates', 'red'),
  ('gates', 'needs_decision'), ('gates', 'parked'), ('gates', 'interrupted'),
  ('gates', 'aborted'),
  ('merge_queue', 'merging'), ('merge_queue', 'red'), ('merge_queue', 'parked'),
  ('merge_queue', 'interrupted'), ('merge_queue', 'aborted'),
  -- A24: `deploy: none` makes a green merge the terminal state.
  ('merging', 'deploying'), ('merging', 'done'), ('merging', 'red'),
  ('merging', 'parked'), ('merging', 'interrupted'), ('merging', 'aborted'),
  -- §12: a rollback marks the merged change red.
  ('deploying', 'done'), ('deploying', 'red'), ('deploying', 'parked'),
  ('deploying', 'interrupted'), ('deploying', 'aborted'),
  -- §9 red policy: first red requeues, second escalates.
  ('red', 'queued'), ('red', 'escalated'), ('red', 'aborted'),
  ('escalated', 'queued'), ('escalated', 'aborted'),
  ('parked', 'planning'), ('parked', 'claimed'), ('parked', 'coding'),
  ('parked', 'review'), ('parked', 'gates'), ('parked', 'merge_queue'),
  ('parked', 'merging'), ('parked', 'deploying'), ('parked', 'aborted'),
  ('needs_decision', 'planning'), ('needs_decision', 'claimed'),
  ('needs_decision', 'coding'), ('needs_decision', 'review'),
  ('needs_decision', 'gates'), ('needs_decision', 'merge_queue'),
  ('needs_decision', 'merging'), ('needs_decision', 'deploying'),
  ('needs_decision', 'aborted'),
  -- §7.2: the integrity re-check may find the worktree unusable.
  ('interrupted', 'planning'), ('interrupted', 'claimed'), ('interrupted', 'coding'),
  ('interrupted', 'review'), ('interrupted', 'gates'), ('interrupted', 'merge_queue'),
  ('interrupted', 'merging'), ('interrupted', 'deploying'), ('interrupted', 'red'),
  ('interrupted', 'aborted');

-- --- task_events -------------------------------------------------------------
-- `state` and `priority` are carried on **every** row, not only on the ones
-- that change them. That makes the projection a single "last row per task"
-- rather than a fold, and it makes the guard below a comparison against one
-- previous row rather than a scan. The trigger enforces that a note cannot
-- quietly move either of them.
CREATE TABLE IF NOT EXISTS task_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  task_id       uuid NOT NULL,
  seq           integer NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  kind          text NOT NULL,
  -- The project never changes; carried per row so the view can index on it.
  project_id    uuid NOT NULL,
  state         text NOT NULL,
  priority      text NOT NULL,
  -- Where a suspended task returns to. NULL in every other state.
  resume_state  text,
  actor         text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT task_events_kind CHECK (kind IN (
    'created', 'state_changed', 'reprioritised', 'note',
    'claims_registered', 'integrity_check'
  )),
  CONSTRAINT task_events_state CHECK (state IN (
    'draft', 'queued', 'planning', 'claimed', 'coding', 'review', 'gates',
    'merge_queue', 'merging', 'deploying', 'done', 'red', 'escalated',
    'parked', 'needs_decision', 'interrupted', 'aborted'
  )),
  CONSTRAINT task_events_priority CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  CONSTRAINT task_events_seq_positive CHECK (seq >= 0),
  -- A suspended task without a return point could never be resumed; §7.3 keeps
  -- claims across the pause precisely so the work survives, and losing the
  -- return point would waste that.
  CONSTRAINT task_events_resume_state CHECK (
    (state IN ('parked', 'needs_decision', 'interrupted')) = (resume_state IS NOT NULL)
  ),
  UNIQUE (task_id, seq)
);

CREATE INDEX IF NOT EXISTS task_events_task_idx ON task_events (task_id, seq);
CREATE INDEX IF NOT EXISTS task_events_occurred_at_idx ON task_events (occurred_at DESC);
CREATE INDEX IF NOT EXISTS task_events_project_idx ON task_events (project_id, occurred_at DESC);

CREATE OR REPLACE TRIGGER task_events_append_only
  BEFORE UPDATE OR DELETE ON task_events
  FOR EACH ROW EXECUTE FUNCTION vorschicht_deny_mutation();

CREATE OR REPLACE TRIGGER task_events_no_truncate
  BEFORE TRUNCATE ON task_events
  FOR EACH STATEMENT EXECUTE FUNCTION vorschicht_deny_truncate();

-- --- the lifecycle guard -----------------------------------------------------
CREATE OR REPLACE FUNCTION vorschicht_task_event_guard() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  prev          task_events%ROWTYPE;
  interrupt_seq integer;
BEGIN
  SELECT * INTO prev FROM task_events
    WHERE task_id = NEW.task_id ORDER BY seq DESC LIMIT 1;

  -- --- the first event -------------------------------------------------------
  IF prev.task_id IS NULL THEN
    IF NEW.kind <> 'created' THEN
      RAISE EXCEPTION 'Aufgabe % beginnt mit "%" statt mit "created" (§9)',
        NEW.task_id, NEW.kind USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.seq <> 0 THEN
      RAISE EXCEPTION 'Erstes Ereignis einer Aufgabe muss seq 0 haben, nicht %', NEW.seq
        USING ERRCODE = 'restrict_violation';
    END IF;
    IF NEW.state NOT IN ('draft', 'queued') THEN
      RAISE EXCEPTION 'Aufgabe % kann nicht im Zustand "%" entstehen (§9)',
        NEW.task_id, NEW.state USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.kind = 'created' THEN
    RAISE EXCEPTION 'Aufgabe % existiert bereits', NEW.task_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- --- gap-free ordering, which is also the concurrency token ---------------
  IF NEW.seq <> prev.seq + 1 THEN
    RAISE EXCEPTION
      'Aufgabe % ist bei seq %, das Ereignis trägt % — veralteter Stand oder Lücke',
      NEW.task_id, prev.seq, NEW.seq USING ERRCODE = 'restrict_violation';
  END IF;

  IF NEW.project_id <> prev.project_id THEN
    RAISE EXCEPTION 'Aufgabe % kann das Projekt nicht wechseln', NEW.task_id
      USING ERRCODE = 'restrict_violation';
  END IF;

  -- --- priority moves only when it says so ----------------------------------
  IF NEW.priority IS DISTINCT FROM prev.priority AND NEW.kind <> 'reprioritised' THEN
    RAISE EXCEPTION
      'Priorität ändert sich von % auf %, aber das Ereignis ist "%" statt "reprioritised"',
      prev.priority, NEW.priority, NEW.kind USING ERRCODE = 'restrict_violation';
  END IF;

  -- --- the state machine ----------------------------------------------------
  IF NEW.state IS DISTINCT FROM prev.state THEN
    IF NEW.kind <> 'state_changed' THEN
      RAISE EXCEPTION
        'Zustandswechsel % → % als "%" geschrieben — §9 verlangt "state_changed"',
        prev.state, NEW.state, NEW.kind USING ERRCODE = 'restrict_violation';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM task_transitions
      WHERE state_from = prev.state AND state_to = NEW.state
    ) THEN
      RAISE EXCEPTION 'Übergang % → % ist nicht vorgesehen (§9)', prev.state, NEW.state
        USING ERRCODE = 'restrict_violation';
    END IF;

    -- A resume returns exactly where it left off. `aborted` and `red` are the
    -- two honest exits that do not.
    IF prev.state IN ('parked', 'needs_decision', 'interrupted')
       AND NEW.state NOT IN ('aborted', 'red')
       AND NEW.state IS DISTINCT FROM prev.resume_state THEN
      RAISE EXCEPTION
        'Fortsetzung muss nach % zurückkehren, nicht nach % (§7.3)',
        prev.resume_state, NEW.state USING ERRCODE = 'restrict_violation';
    END IF;

    -- §7.2: work a hard stop cut off is verified before it moves again.
    IF prev.state = 'interrupted' AND NEW.state NOT IN ('aborted', 'red') THEN
      SELECT max(seq) INTO interrupt_seq FROM task_events
        WHERE task_id = NEW.task_id AND kind = 'state_changed' AND state = 'interrupted';
      IF NOT EXISTS (
        SELECT 1 FROM task_events
        WHERE task_id = NEW.task_id AND kind = 'integrity_check'
          AND seq > interrupt_seq AND payload ->> 'ok' = 'true'
      ) THEN
        RAISE EXCEPTION
          'Aufgabe % war unterbrochen und braucht erst die Integritätsprüfung (§7.2)',
          NEW.task_id USING ERRCODE = 'restrict_violation';
      END IF;
    END IF;
  ELSIF NEW.kind = 'state_changed' THEN
    RAISE EXCEPTION 'Ereignis "state_changed" ohne Zustandswechsel (Zustand bleibt %)', NEW.state
      USING ERRCODE = 'restrict_violation';
  ELSIF NEW.resume_state IS DISTINCT FROM prev.resume_state THEN
    -- A note that moves the return point would relocate the work silently —
    -- the same class of defect the state guard above exists to prevent.
    RAISE EXCEPTION
      'Rückkehrpunkt ändert sich von % auf %, ohne dass der Zustand wechselt',
      prev.resume_state, NEW.resume_state USING ERRCODE = 'restrict_violation';
  END IF;

  RETURN NEW;
END
$$;

COMMENT ON FUNCTION vorschicht_task_event_guard() IS
  'Enforces §9: gap-free seq (= optimistic concurrency), legal transitions, exact resume points, and the §7.2 integrity re-check after an interrupt.';

CREATE OR REPLACE TRIGGER task_events_lifecycle
  BEFORE INSERT ON task_events
  FOR EACH ROW EXECUTE FUNCTION vorschicht_task_event_guard();

-- --- tasks (derived) ---------------------------------------------------------
-- The §5 entity. `version` is the seq of the last event: a caller that has read
-- a task holds the token it needs to write the next one, and a stale token is
-- refused by the guard above rather than overwriting someone else's decision.
CREATE OR REPLACE VIEW tasks AS
WITH latest AS (
  SELECT DISTINCT ON (task_id)
    task_id, project_id, state, priority, resume_state, seq, occurred_at
  FROM task_events ORDER BY task_id, seq DESC
),
origin AS (
  SELECT task_id, occurred_at AS created_at, payload
  FROM task_events WHERE kind = 'created'
),
tallies AS (
  SELECT
    task_id,
    count(*) FILTER (WHERE kind = 'state_changed' AND state = 'red')   AS red_count,
    count(*) FILTER (WHERE kind = 'state_changed' AND state = 'parked') AS park_count,
    count(*) FILTER (WHERE kind = 'state_changed' AND state = 'interrupted') AS interrupt_count
  FROM task_events GROUP BY task_id
)
SELECT
  l.task_id                              AS id,
  l.project_id,
  l.state,
  l.priority,
  l.resume_state,
  l.seq                                  AS version,
  l.occurred_at                          AS updated_at,
  o.created_at,
  o.payload ->> 'title'                  AS title,
  o.payload ->> 'department'             AS department,
  o.payload ->> 'type'                   AS type,
  o.payload ->> 'goalId'                 AS goal_id,
  (o.payload ->> 'parentTaskId')::uuid   AS parent_task_id,
  o.payload ->> 'worktreePath'           AS worktree_path,
  o.payload ->> 'branch'                 AS branch,
  -- §9's retry count: how often this task has been through the red path.
  t.red_count                            AS retry_count,
  t.park_count,
  t.interrupt_count
FROM latest l
JOIN origin o USING (task_id)
JOIN tallies t USING (task_id);

COMMENT ON VIEW tasks IS
  'The §5 task entity, projected from task_events. `version` is the optimistic-concurrency token.';

-- --- notify ------------------------------------------------------------------
-- Task movement is what the office view and the overview render; without this
-- the dashboard would only learn about it on the next poll.
CREATE OR REPLACE FUNCTION vorschicht_notify_task_event() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify(
    'vorschicht_tasks',
    json_build_object(
      'taskId', NEW.task_id,
      'seq', NEW.seq,
      'kind', NEW.kind,
      'state', NEW.state,
      'projectId', NEW.project_id
    )::text
  );
  RETURN NULL;
END
$$;

CREATE OR REPLACE TRIGGER task_events_notify
  AFTER INSERT ON task_events
  FOR EACH ROW EXECUTE FUNCTION vorschicht_notify_task_event();

-- --- grants ------------------------------------------------------------------
GRANT SELECT, INSERT ON task_events TO vorschicht_app;
REVOKE UPDATE, DELETE, TRUNCATE ON task_events FROM vorschicht_app;
GRANT SELECT ON tasks, task_transitions TO vorschicht_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO vorschicht_app;
