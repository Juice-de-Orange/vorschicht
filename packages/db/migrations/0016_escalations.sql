-- =============================================================================
-- 0016_escalations — §5's `escalations` / `decisions`: the inbox items the operator
-- answers, and the answers that become policy.
--
-- A43's precedent for the fourth time (tasks 0006, worktrees 0008, claims 0009,
-- audits 0013): the append-only log is the table, the entities are views over
-- it. The justification 0015 explicitly declined for `gate_runs` — "a gate run
-- has no history, it happens and nothing revises it" — is present here. An
-- escalation *does* have a history, and it is exactly the one §15 describes: it
-- is raised, it waits (indefinitely — §15 has no timeout), and it is answered
-- once. The answer then outlives its question as policy memory, which is a
-- second entity over the same rows rather than a second write.
--
-- Five decisions in here are not transcription of §15.
--
--   1. **The number is a sequence, not a position.** §15's copy is "blockiert
--      durch Entscheidung #X" and the notification carries a deep link, so X has
--      to be permanent and small. `row_number() OVER (ORDER BY raised_at)` is
--      small and dense and *not permanent*: one row inserted with an earlier
--      timestamp renumbers everything the operator has ever been linked to. A sequence
--      gives up density — a rolled-back transaction burns a number — and keeps
--      the only property that matters.
--
--   2. **`seq = 1` is the raise, and the database says so.** Not a convention:
--      an `answered` row with no `raised` behind it would project as an
--      escalation with no question, and the view would render a decision about
--      nothing. The CHECK makes the ordering unrepresentable rather than
--      unlikely.
--
--   3. **An escalation is answered exactly once**, enforced by a partial unique
--      index rather than by the service that writes it. A changed mind is a new
--      question, and it needs to be: the answer has already been injected into a
--      resumed session (§6.4) by the time anybody could revise it, so a second
--      `answered` row would describe a decision the studio never acted on while
--      reading as the one it did.
--
--   4. **The precedent key is stored, not computed here.** It is the normalised
--      question (`precedentKey` in `@vorschicht/shared`), and the normalisation
--      is meaning-preserving in a way SQL cannot express and TypeScript can
--      test. Storing it makes the lookup an indexed equality instead of a scan
--      with a function on the left-hand side, and — more usefully — makes it
--      *readable*: when two questions match, a human can see the exact string
--      that matched them.
--
--   5. **`decisions` carries no "is this reusable" column.** Which sources
--      become policy memory is `POLICY_MEMORY_SOURCES` in TypeScript, and a
--      second copy in SQL is a second thing to keep in step for a list that
--      grows one producer at a time. The service passes it into the query. A43.1
--      took the opposite bargain for §9's transition map, and for a reason that
--      does not apply here: a check constraint cannot import TypeScript, so that
--      rule *had* to exist twice. This one does not.
-- =============================================================================

-- The human-facing "#12". Monotone, permanent, and deliberately not dense.
CREATE SEQUENCE IF NOT EXISTS escalation_number_seq AS bigint START 1;

-- --- escalation_events -------------------------------------------------------
CREATE TABLE IF NOT EXISTS escalation_events (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  escalation_id uuid NOT NULL,
  seq           integer NOT NULL,
  occurred_at   timestamptz NOT NULL DEFAULT now(),
  kind          text NOT NULL CHECK (kind IN ('raised', 'answered')),
  -- Role id for an agent question, `orchestrator` for §9's second failure, and
  -- `max` or `dashboard:<credentialId>` for the answer.
  actor         text NOT NULL,
  -- Only the raise carries one, and it always does. Both halves matter: a raise
  -- without a number cannot be linked to, and a number on a later event would
  -- be a second identity for the same item.
  number        bigint,
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (escalation_id, seq),
  CONSTRAINT escalation_events_number_on_raise CHECK ((kind = 'raised') = (number IS NOT NULL)),
  -- Decision 2. The raise is the first event or there is no escalation.
  CONSTRAINT escalation_events_raise_is_first CHECK ((kind = 'raised') = (seq = 1))
);

-- Decision 3.
CREATE UNIQUE INDEX IF NOT EXISTS escalation_events_one_answer
  ON escalation_events (escalation_id) WHERE kind = 'answered';

CREATE UNIQUE INDEX IF NOT EXISTS escalation_events_number_idx
  ON escalation_events (number) WHERE number IS NOT NULL;

CREATE INDEX IF NOT EXISTS escalation_events_escalation_idx
  ON escalation_events (escalation_id, seq);

-- Decision 4: the lookup policy memory performs on every `escalate.ask`.
CREATE INDEX IF NOT EXISTS escalation_events_precedent_idx
  ON escalation_events ((payload ->> 'precedentKey')) WHERE kind = 'raised';

CREATE OR REPLACE TRIGGER escalation_events_append_only
  BEFORE UPDATE OR DELETE ON escalation_events
  FOR EACH ROW EXECUTE FUNCTION vorschicht_deny_mutation();

-- TRUNCATE fires no row-level trigger at all — the hole 0004 exists to close.
CREATE OR REPLACE TRIGGER escalation_events_no_truncate
  BEFORE TRUNCATE ON escalation_events
  FOR EACH STATEMENT EXECUTE FUNCTION vorschicht_deny_truncate();

COMMENT ON TABLE escalation_events IS
  'Append-only log behind the §5 escalations/decisions entities: one raise per inbox item (§15), at most one answer.';

-- --- escalations (derived) ---------------------------------------------------
-- The inbox (§15, §17.5). `state` is derived from the presence of an answer,
-- never stored: an item that has been answered and an item somebody marked as
-- answered are different facts, and only one of them can be resumed from (§6.4).
CREATE OR REPLACE VIEW escalations AS
WITH raised AS (
  SELECT escalation_id, number, occurred_at, actor, payload
  FROM escalation_events WHERE kind = 'raised'
),
answered AS (
  SELECT escalation_id, occurred_at, actor, payload
  FROM escalation_events WHERE kind = 'answered'
)
SELECT
  r.escalation_id                                  AS id,
  r.number,
  r.payload ->> 'source'                           AS source,
  r.payload ->> 'urgency'                          AS urgency,
  (r.payload ->> 'projectId')::uuid                AS project_id,
  (r.payload ->> 'taskId')::uuid                   AS task_id,
  -- §6.4 resumes *this* session from *its* cwd; both live on the agent run.
  (r.payload ->> 'runId')::uuid                    AS run_id,
  r.payload ->> 'question'                         AS question,
  r.payload ->> 'context'                          AS context,
  COALESCE(r.payload -> 'options', '[]'::jsonb)    AS options,
  -- Empty means "no precedent is possible for this question" (a normalisation
  -- that survived nothing). NULL rather than '' so it can never match a lookup.
  NULLIF(r.payload ->> 'precedentKey', '')         AS precedent_key,
  -- Earlier decisions that are *similar*, for the card. They never answer
  -- anything; the exact-match path does that before an item is ever raised.
  COALESCE(r.payload -> 'related', '[]'::jsonb)    AS related,
  r.occurred_at                                    AS raised_at,
  r.actor                                          AS raised_by,
  a.occurred_at                                    AS answered_at,
  a.actor                                          AS answered_by,
  (a.payload ->> 'optionIndex')::integer           AS chosen_index,
  a.payload ->> 'chosenTitle'                      AS chosen_title,
  a.payload ->> 'freeText'                         AS free_text,
  CASE WHEN a.escalation_id IS NULL THEN 'open' ELSE 'answered' END AS state
FROM raised r
LEFT JOIN answered a USING (escalation_id);

COMMENT ON VIEW escalations IS
  'The §5 escalations entity: inbox items with §15''s prepared options; `state` is derived from whether an answer exists.';

-- --- decisions (derived) -----------------------------------------------------
-- §5: "the operator''s answers; decisions are reusable policy memory". The same rows seen
-- from the other end — an answered escalation *is* a decision, and giving it its
-- own table would mean writing the same fact twice and then keeping the two in
-- step forever.
--
-- Which of these may be reused is decided by the caller (decision 5), so this
-- view keeps `source` and answers no policy question itself.
CREATE OR REPLACE VIEW decisions AS
SELECT
  e.id                AS escalation_id,
  e.number,
  e.source,
  e.project_id,
  e.task_id,
  e.question,
  e.precedent_key,
  e.options,
  e.chosen_index,
  e.chosen_title,
  e.free_text,
  e.answered_at       AS decided_at,
  e.answered_by       AS decided_by
FROM escalations e
WHERE e.state = 'answered';

COMMENT ON VIEW decisions IS
  'The §5 decisions entity (§15): every answered escalation, and the policy memory an agent searches before asking again.';

-- --- task_escalations, no longer a placeholder ------------------------------
-- 0010 projected `answered` as a literal `false` and said why: "nothing writes a
-- decision yet. It is projected rather than omitted so that the Phase 4 join has
-- somewhere to land." This is that join.
--
-- It lands on the escalation id the channel now records in the task event, not
-- on the question text. Matching two rows by a sentence a language model wrote
-- would be a fuzzy step in the one place a session asks "did my question get an
-- answer" — and the honest failure mode of a fuzzy match here is a resumed
-- session acting on a decision about something else.
--
-- A task event without an id is an escalation the channel answered from policy
-- memory before raising anything, or one written before this migration. Both
-- read as unanswered, which is what they were.
--
-- The column order is 0010's, with the new ones appended: CREATE OR REPLACE
-- VIEW permits no other edit, and renaming an existing position fails with
-- "cannot change name of view column" rather than replacing it. `answered`
-- keeps its name and its type and stops being a literal.
CREATE OR REPLACE VIEW task_escalations AS
SELECT
  e.task_id,
  e.project_id,
  e.seq,
  e.occurred_at                                 AS raised_at,
  e.actor                                       AS raised_by,
  e.payload ->> 'question'                      AS question,
  e.payload ->> 'context'                       AS context,
  e.payload ->> 'urgency'                       AS urgency,
  COALESCE(e.payload -> 'options', '[]'::jsonb) AS options,
  t.state                                       AS task_state,
  COALESCE(x.state, 'open') = 'answered'        AS answered,
  x.number                                      AS escalation_number,
  x.chosen_title,
  x.free_text,
  x.answered_at
FROM task_events e
JOIN tasks t ON t.id = e.task_id
LEFT JOIN escalations x ON x.id = (e.payload ->> 'escalationId')::uuid
WHERE e.kind = 'escalation_requested';

COMMENT ON VIEW task_escalations IS
  'Escalations prepared by agents (§6.4, §15), joined to the inbox item and the operator''s answer by the escalation id the channel records.';

GRANT SELECT ON task_escalations TO vorschicht_app;

GRANT SELECT, INSERT ON escalation_events TO vorschicht_app;
REVOKE UPDATE, DELETE, TRUNCATE ON escalation_events FROM vorschicht_app;
GRANT SELECT ON escalations, decisions TO vorschicht_app;
GRANT USAGE, SELECT ON SEQUENCE escalation_number_seq TO vorschicht_app;
