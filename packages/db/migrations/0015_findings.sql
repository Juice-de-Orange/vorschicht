-- =============================================================================
-- 0015_findings — §5's `gate_runs` / `findings`, and the loop §11 closes with.
--
-- §5 asks for "every gate execution with full output and failure class
-- (`finding` vs `infra`); findings always `blocker`, with fix-task linkage".
-- §11 says what a finding *does*: "Finding → fix task → gate re-run → only then
-- merge." Four decisions here are not transcription of either.
--
--   1. **`gate_runs` is a plain append-only table, not an event log with a view
--      over it.** Every other entity in this schema that got the A43 treatment
--      has a *history*: a task moves through §9, an audit finding is confirmed
--      and dismissed and re-opened, a run is created and started and
--      terminated. A gate run has none. It happens, it produces a verdict, and
--      nothing ever revises it — so the event table would carry exactly one
--      kind, and the view would be `SELECT * FROM` it with extra steps. §5's
--      design rule is "append-only wherever state history matters"; the
--      append-only half is honoured by the triggers below, and inventing a
--      history for something that has none would be cargo.
--
--   2. **`findings` is a view over `gate_runs`, not a second table.** A finding
--      is not an independent fact — it *is* a step of a gate run that came out
--      red, and the step is already recorded with its full output. Two tables
--      would be two writes that can disagree, and "every finding is a blocker"
--      (§11) would become a column somebody sets rather than a property of the
--      shape. Here `severity` is a literal, which is the only way to write a
--      rule that has no exceptions.
--
--   3. **A finding stops blocking only by evidence, never by an update.** §11
--      gives it exactly one way out: the work goes back through the gates and
--      comes out green. So `status` is derived from a *later gate run on the
--      same task in which that gate reported green* — not from a status column,
--      not from somebody calling `resolve()`. `resolved_by_gate_run_id` names
--      the run that did it, which is also what §8.2's seventh domain needs to
--      ask its question ("did a gate go red → green with no code change in
--      between?"): both runs carry the sha of the tree they checked, so the
--      answer is a comparison rather than a belief. 0010's `task_findings` set
--      this precedent for the narrower MCP-reported finding; this is the same
--      rule with the gate run behind it.
--
--   4. **`fix_task_id` is the task that is actually carrying the fix, and it is
--      NULL when nothing is.** §5 asks for the linkage; §9 answers what it
--      points at for a gate finding: the *same* task, requeued at a lower
--      priority with the findings attached. That is not a placeholder for a
--      "real" fix task — creating a separate one would deadlock immediately,
--      because the original task still holds the claims the fix must write into
--      (§10), and §9's retry count would never advance. The column earns its
--      name in the case where the answer differs: a task that escalated (§9's
--      second failure) has no fix task at all until the operator decides, and a Phase 6
--      idle-audit or §8.2 `defect` finding will point at a task created for it.
-- =============================================================================

-- --- gate_runs ---------------------------------------------------------------
-- One row per completed suite run (§11), whatever its verdict.
--
-- Written unconditionally, including for the runs that failed: §8.2's seventh
-- domain asks whether any commit reached the integration branch without a gate
-- run behind it, and that question is only answerable if the reds are recorded
-- too. `event_log`'s `gate.finished` row stays where it is — it is the
-- chronological trace the timeline renders — and this is the queryable entity
-- §5 names. The pair is deliberate: one is "what happened, in order", the other
-- is "what does this project currently owe".
--
-- A run that never finished leaves no row here, and that is correct rather than
-- a gap: an orchestrator that died mid-suite leaves its task `merging`,
-- `reconcile()` marks it `interrupted`, and §7.2's re-check is the way back. A
-- half-run gate has no verdict, so it cannot have flipped anything.
CREATE TABLE IF NOT EXISTS gate_runs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Ordering key. `finished_at` is not enough: two runs of a fast suite can
  -- share a timestamp, and "the later run that turned this green" must be a
  -- total order or the resolution below is ambiguous.
  seq          bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  task_id      uuid NOT NULL,
  project_id   uuid NOT NULL,
  -- Where in the pipeline this ran. Only `merge_queue` exists today; Phase 5's
  -- deploy engine is the next producer.
  stage        text NOT NULL,
  started_at   timestamptz NOT NULL,
  finished_at  timestamptz NOT NULL DEFAULT now(),
  duration_ms  integer NOT NULL,
  ok           boolean NOT NULL,
  -- The tree that was actually checked, and what it was compared against. The
  -- sha is what makes §8.2's red → green question answerable: two runs with the
  -- same head and different verdicts is a gate that changed its mind about an
  -- unchanged tree.
  head_sha     text,
  base_ref     text,
  -- Every step of the run, in catalogue order, with its full captured output
  -- (§5). The suite trims each output at 16 KB before it gets here; that cap is
  -- the honest meaning of "full" and is stated where it is applied.
  steps        jsonb NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT gate_runs_steps_is_array CHECK (jsonb_typeof(steps) = 'array')
);

CREATE INDEX IF NOT EXISTS gate_runs_task_idx    ON gate_runs (task_id, seq DESC);
CREATE INDEX IF NOT EXISTS gate_runs_project_idx ON gate_runs (project_id, finished_at DESC);

CREATE OR REPLACE TRIGGER gate_runs_append_only
  BEFORE UPDATE OR DELETE ON gate_runs
  FOR EACH ROW EXECUTE FUNCTION vorschicht_deny_mutation();

-- TRUNCATE fires no row-level trigger at all — the hole 0004 exists to close.
CREATE OR REPLACE TRIGGER gate_runs_no_truncate
  BEFORE TRUNCATE ON gate_runs
  FOR EACH STATEMENT EXECUTE FUNCTION vorschicht_deny_truncate();

COMMENT ON TABLE gate_runs IS
  'The §5 gate_runs entity: one append-only row per completed gate suite run, with every step and its full output.';

-- --- findings (derived) ------------------------------------------------------
-- Every red step of every gate run, with the evidence that closed it or the
-- fact that nothing has.
--
-- `id` is derived from the pair that identifies a finding — this run, this gate
-- — rather than generated, so it is stable across queries and can be quoted in
-- a task note, a prompt and an audit without anybody storing it anywhere.
CREATE OR REPLACE VIEW findings AS
WITH red AS (
  SELECT
    r.id                     AS gate_run_id,
    r.seq                    AS gate_run_seq,
    r.task_id,
    r.project_id,
    r.stage,
    r.finished_at,
    r.head_sha,
    s.value ->> 'id'         AS gate_id,
    s.value ->> 'detail'     AS detail,
    s.value ->> 'output'     AS output,
    (s.value ->> 'exitCode')::integer AS exit_code,
    s.value -> 'command'     AS command
  FROM gate_runs r
  CROSS JOIN LATERAL jsonb_array_elements(r.steps) AS s(value)
  -- A25's classification, at the one place it decides consequences: `finding`
  -- blocks, `infra` proves nothing and is not a finding. Recording infra steps
  -- in `gate_runs` and excluding them here is what keeps "what could not be
  -- checked" visible without letting it block a merge.
  WHERE s.value ->> 'verdict' = 'finding'
)
SELECT
  md5(f.gate_run_id::text || ':' || f.gate_id)::uuid AS id,
  f.gate_run_id,
  f.task_id,
  f.project_id,
  f.gate_id,
  f.stage,
  f.finished_at                      AS raised_at,
  f.head_sha                         AS raised_on_sha,
  f.detail,
  f.output,
  f.exit_code,
  f.command,
  -- §11 has one severity and no warning mode. A literal, because a column is
  -- where the exception would eventually be written.
  'blocker'::text                    AS severity,
  t.state                            AS task_state,
  resolution.id                      AS resolved_by_gate_run_id,
  resolution.finished_at             AS resolved_at,
  resolution.head_sha                AS resolved_on_sha,
  CASE
    WHEN resolution.id IS NOT NULL          THEN 'resolved'
    -- A terminal task that never produced a green run for this gate: nothing
    -- is going to. Ordinary after an abort; on a `done` task it means the gate
    -- stopped running between the finding and the merge — worth an audit's
    -- attention, which is why it is a distinct value and not folded into
    -- `resolved`.
    WHEN t.state IN ('done', 'aborted')     THEN 'abandoned'
    ELSE 'open'
  END                                AS status,
  -- Decision 4. NULL while the task waits on the operator or has stopped moving: a
  -- finding nobody is fixing must not read as one somebody is.
  CASE
    WHEN resolution.id IS NULL
     AND t.state NOT IN ('done', 'aborted', 'escalated', 'needs_decision')
    THEN f.task_id
  END                                AS fix_task_id
FROM red f
JOIN tasks t ON t.id = f.task_id
LEFT JOIN LATERAL (
  SELECT g.id, g.finished_at, g.head_sha
  FROM gate_runs g
  WHERE g.task_id = f.task_id
    AND g.seq > f.gate_run_seq
    AND EXISTS (
      SELECT 1 FROM jsonb_array_elements(g.steps) AS e(value)
      WHERE e.value ->> 'id' = f.gate_id AND e.value ->> 'verdict' = 'green'
    )
  ORDER BY g.seq
  LIMIT 1
) AS resolution ON true;

COMMENT ON VIEW findings IS
  'The §5 findings entity: every red gate step, always a blocker (§11), resolved only by a later gate run that reported the same gate green.';

GRANT SELECT, INSERT ON gate_runs TO vorschicht_app;
REVOKE UPDATE, DELETE, TRUNCATE ON gate_runs FROM vorschicht_app;
GRANT SELECT ON findings TO vorschicht_app;
