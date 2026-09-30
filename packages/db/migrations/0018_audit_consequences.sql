-- =============================================================================
-- 0018_audit_consequences — `applied` has to mean *carried out*.
--
-- 0013 computed the column as `bool_or(kind = 'applied')` and `AuditService`
-- appended that event unconditionally for every finding, including all three
-- refusals of the un-tick and the catch that wraps the whole consequence. The
-- comment beside the event kind said "a consequence was carried out". So the
-- one column that answers §8.2's sharpest question — did the gate really
-- un-tick — answered "yes" for a finding whose gate is still ticked. Observed
-- on the deployed stack: a `gate_invalid` against P0.G5 with
-- `applied = true`, `apply_problem = NULL`, and the actual reason
-- (`EACCES … CLAUDE.md`) sitting under a key the view never read.
--
-- Three changes, all of them in the projection; `audit_finding_events` is
-- append-only and is not touched.
--
--   1. **`applied` reads an explicit outcome.** The writer now puts
--      `ok: true|false` on every `applied` event and a German `problem` beside
--      it when the answer is false. A claim about what happened has to be
--      recorded by the code that made it happen; deriving it from the presence
--      of a row is deriving it from nothing.
--
--   2. **`apply_problem` reads the key the writer writes.** It read
--      `payload ->> 'problem'` while the service wrote `note`, so the column was
--      structurally NULL — no run of this system could ever have populated it.
--      The German sentence keeps its own column (`apply_note`) rather than being
--      overloaded onto `apply_problem`: one says what happened, the other says
--      why it did not, and a reader that has to tell them apart by reading prose
--      is back where this started.
--
--   3. **`unticked_gate` and `escalation_number` become columns.** The first was
--      already in the payload and projected nowhere, so "which gate did this
--      finding actually open" was unanswerable in SQL. The second is new (§8.2:
--      a `gate_invalid` "always also reaches the operator as a P1 item"), and it is the
--      only queryable evidence that the safeguard fired: a `gate_invalid` with
--      `escalation_number IS NULL` is a phase that reopened — or failed to —
--      with nobody told.
--
-- **Historic rows read `applied = false`, deliberately.** Events written before
-- this migration carry no `ok` key, so nothing in them supports the claim. The
-- alternative — `COALESCE(payload ->> 'ok', 'true')` — would re-assert exactly
-- the lie this migration exists to remove, for precisely the rows where it was
-- told. The errors are not symmetric: an understated success costs a reader one
-- look at `apply_note`, which is projected for that reason, while an overstated
-- one is a gate that everybody believes was opened.
--
-- `CREATE OR REPLACE VIEW` may only append columns and may not rename or retype
-- an existing one, so `applied` keeps its name, its type and its position and
-- the three new columns come after `apply_problem`.
-- =============================================================================

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
         -- The whole point of this migration: an `applied` row is a record that
         -- the consequence was *attempted*, and only `ok` says it happened.
         bool_or(kind = 'applied' AND payload ->> 'ok' = 'true')            AS applied,
         max(payload ->> 'fixTaskId')     FILTER (WHERE kind = 'applied')   AS fix_task_id,
         max(payload ->> 'problem')       FILTER (WHERE kind = 'applied')   AS apply_problem,
         max(payload ->> 'note')          FILTER (WHERE kind = 'applied')   AS apply_note,
         max(payload ->> 'untickedGate')  FILTER (WHERE kind = 'applied')   AS unticked_gate,
         max((payload ->> 'escalationNumber')::bigint)
                                          FILTER (WHERE kind = 'escalated') AS escalation_number
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
  c.apply_problem,
  c.apply_note,
  c.unticked_gate,
  c.escalation_number
FROM raised r
JOIN status s USING (finding_id)
LEFT JOIN counts c USING (finding_id);

COMMENT ON VIEW audit_findings IS
  'The §5 audit_findings entity: class, evidence, the dismissal/confirmation history (§8.2), '
  'and — since 0018 — whether the consequence was actually carried out, why not, and which '
  'inbox item carried it to the operator.';
