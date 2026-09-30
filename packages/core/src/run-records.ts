/**
 * Reading back what a session was and what it produced (§6.4, §6.2).
 *
 * Everything in this repository that *writes* an agent run goes through
 * `AgentRunner`; until now nothing read one back except `reconcile()` and the
 * usage estimator, each with its own inline query. §6.4's round trip is the
 * first caller that needs a run as a *record* — the session id and the working
 * directory it began in, because resume is scoped to that directory, and the
 * structured result of an earlier leg, because a chain re-entered in the middle
 * must not re-run the Planner to learn what the plan was.
 *
 * Two properties are the design.
 *
 *  1. **It reads the view, never the events.** `agent_runs` (0003, widened by
 *     0011/0014) already resolves the awkward parts — the session id lives on
 *     `created` or on `started` depending on the backend, and the result payload
 *     is the *last* one so that §6.3's repair leg wins over the malformed answer
 *     it replaced. A second projection here would be a second set of those rules
 *     to keep in step.
 *
 *  2. **A result is returned raw and parsed by the caller.** The role's contract
 *     is `parseAgentResult`'s (§6.3) and there is exactly one of it. Parsing here
 *     would put a second validation between the record and the chain, and the two
 *     would disagree the first time a role schema changed — with this one silently
 *     handing back a plan that no longer satisfies the contract the session was
 *     held to.
 */
import type { Queryable } from './sql.js';

/** One agent run, as much of it as a later reader needs. */
export interface RunRecord {
  runId: string;
  /** Null when the run died before the backend reported a session (§6.2). */
  sessionId: string | null;
  /** Resume is scoped to this directory — CLI behaviour, not our choice. */
  cwd: string | null;
  /** The profile id the session ran as (`planner`, `coder`, …). */
  role: string | null;
  taskId: string | null;
  /** The structured result as the model produced it, before validation. */
  resultRaw: unknown;
  /** False while the run is live, and for a run a crash left open (§7.2). */
  isFinished: boolean;
  /** §6.4: the run this one continues, or null. Distinct from a repair leg. */
  resumedOf: string | null;
}

interface RunRow {
  run_id: string;
  session_id: string | null;
  cwd: string | null;
  role: string | null;
  task_id: string | null;
  result_raw: unknown;
  is_finished: boolean;
  resumed_of: string | null;
}

export class RunRecords {
  constructor(private readonly sql: Queryable) {}

  async get(runId: string): Promise<RunRecord | null> {
    const [row] = await this.sql<RunRow[]>`
      SELECT run_id, session_id, cwd, role, task_id, result_raw, is_finished, resumed_of
      FROM agent_runs WHERE run_id = ${runId}`;
    return row ? toRecord(row) : null;
  }

  /**
   * The newest run of one role on one task that actually produced a result.
   *
   * `result_raw IS NOT NULL` rather than `is_finished`, and the difference
   * matters in exactly the case this exists for: a session that answered and was
   * then interrupted while its record was being closed has a result worth
   * reading, and a session that started and crashed has none.
   *
   * Newest wins, and both ways a role can produce more than one run make that
   * the right answer rather than merely the obvious one. §6.3's repair leg is a
   * separate run created later, and its result is the one that satisfied the
   * contract — the earlier one is what the repair existed to replace. §6.4's
   * continuation is likewise a later run of the same role, and its result is the
   * plan made *with* the operator's decision rather than the one that stopped to ask.
   */
  async lastResultFor(taskId: string, role: string): Promise<RunRecord | null> {
    const [row] = await this.sql<RunRow[]>`
      SELECT run_id, session_id, cwd, role, task_id, result_raw, is_finished, resumed_of
      FROM agent_runs
      WHERE task_id = ${taskId} AND role = ${role} AND result_raw IS NOT NULL
      ORDER BY created_at DESC LIMIT 1`;
    return row ? toRecord(row) : null;
  }
}

function toRecord(row: RunRow): RunRecord {
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    cwd: row.cwd,
    role: row.role,
    taskId: row.task_id,
    resultRaw: row.result_raw,
    isFinished: row.is_finished,
    resumedOf: row.resumed_of,
  };
}
