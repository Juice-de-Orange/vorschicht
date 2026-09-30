/**
 * Reading §1 principle 4's chain back out of the six records that hold it.
 *
 * "Every error and every decision must be traceable end-to-end: goal → task →
 * agent run → transcript → diff → gate results → merge → deploy." Every link has
 * been *written* since Phase 1 — `task_events` (0006), `agent_run_events`/
 * `agent_runs` (0003, 0011, 0014, 0017), the archived JSONL (§6.2), `gate_runs`
 * and the `findings` view (0015) — and none of it has ever been readable. This
 * is the query surface §17.4 renders.
 *
 * Read-only by construction: there is no write on this class and no service that
 * could perform one is a dependency. That is not tidiness. A trace explorer is
 * the one surface whose whole value is that it reports what happened rather than
 * what someone decided it should say, and §8.2 rule 1 makes the same argument
 * for the auditor: whoever can make a record disappear must not be the one
 * showing it to you.
 *
 * Five decisions.
 *
 *  1. **The run ids are found first, then the view is joined.** `agent_runs` is
 *     a `GROUP BY run_id` over every event of every run, and `task_id` in it is
 *     an *aggregate-derived* column — filtering the view by it makes Postgres
 *     compute the whole aggregate and then throw almost all of it away. Selecting
 *     the run ids out of `agent_run_events` first (an indexed scan on `kind`
 *     plus a jsonb key) and joining on `run_id`, which **is** the group key, lets
 *     the filter push down. The difference is a table scan per page view.
 *
 *  2. **Two fields are read off the events, and that is a stated compromise.**
 *     A32's `caps` sit on the `created` payload and §6.2's `transcriptProblem`
 *     on `terminated`; the view projects neither. §22's step 3 asks for the caps
 *     by name, and an absent transcript has to say *why*. The right long-term
 *     fix is a migration widening `agent_runs` — deliberately not taken here,
 *     because a migration number is the one thing several parallel strands
 *     collide on, and this is a read path where a correlated subselect over an
 *     indexed `(run_id, seq)` costs nothing. Recorded as owed rather than
 *     silently worked around.
 *
 *  3. **The diff basis is resolved as a consistent *pair*, not two newest
 *     rows.** A rollback marks a merged change red (§12) and the task can merge
 *     again, so a task may carry two `baseShaBefore`s and two `baseShaAfter`s.
 *     Taking the newest of each independently would pair the second merge's end
 *     with the first merge's start and produce a diff that never existed. The
 *     `before` is the newest one *preceding* the chosen `after`.
 *
 *  4. **`baseShaAfter` is looked for on any state, not on `deploying`.** The
 *     merge queue writes it onto `deploying` for a project with a deploy method
 *     and onto `done` for A24's `none`. `taskDeployHandover` asks only about the
 *     first because §12's engine only cares about that one; asking the same way
 *     here would make every `deploy: none` project — which is most of them —
 *     silently fall through to a weaker basis.
 *
 *  5. **A missing project row is not an error.** `tasks` is a view over an
 *     append-only log and `projects` is mutable (§5), so a task can outlive the
 *     project row it names. The join is a LEFT JOIN and the slug travels as
 *     null, because the trace of a project somebody deleted is precisely the
 *     trace nobody else can reconstruct.
 */
import type {
  SpurAufgabeDetail,
  SpurAufgabeZeile,
  SpurBefund,
  SpurenFilter,
  SpurenListeAntwort,
  SpurGateLauf,
  SpurLauf,
} from '@vorschicht/shared/spuren';
import type { Queryable } from '../sql.js';

/** Where a diff comes from, once the log has been asked (decision 3). */
export type DiffBasisResolution =
  | {
      ok: true;
      basis: 'merge' | 'gate' | 'branch';
      fromRef: string;
      toRef: string;
      /** `merge` compares two recorded commits; the other two compare from the fork point. */
      forkPoint: boolean;
      repoPath: string;
    }
  | { ok: false; reason: 'no_task' | 'no_project' | 'no_basis' };

interface TaskRow {
  id: string;
  project_id: string;
  project_slug: string | null;
  state: string;
  priority: string;
  title: string | null;
  department: string | null;
  type: string | null;
  branch: string | null;
  created_at: Date;
  updated_at: Date;
  retry_count: string | number;
}

interface RunRow {
  run_id: string;
  task_id: string | null;
  role: string | null;
  model: string | null;
  backend: string | null;
  cwd: string | null;
  session_id: string | null;
  created_at: Date;
  started_at: Date | null;
  ended_at: Date | null;
  is_finished: boolean;
  terminal_reason: string | null;
  exit_code: number | null;
  tokens_in: string | number | null;
  tokens_out: string | number | null;
  cost_usd: string | number | null;
  tool_uses: string | number;
  hook_events: string | number;
  permission_denials: string | number;
  repair_of: string | null;
  resumed_of: string | null;
  transcript_path: string | null;
  caps: unknown;
  transcript_problem: string | null;
}

export class TraceReader {
  constructor(private readonly sql: Queryable) {}

  /** §17.4's filtered list. One row over the limit tells the page it was cut. */
  async list(filter: SpurenFilter): Promise<SpurenListeAntwort> {
    const rows = await this.sql<TaskRow[]>`
      SELECT
        t.id, t.project_id, p.slug AS project_slug, t.state, t.priority, t.title,
        t.department, t.type, t.branch, t.created_at, t.updated_at, t.retry_count
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE (${filter.projectId}::uuid IS NULL OR t.project_id = ${filter.projectId}::uuid)
        AND (${filter.state}::text IS NULL OR t.state = ${filter.state}::text)
        AND (${filter.priority}::text IS NULL OR t.priority = ${filter.priority}::text)
        AND (${filter.from}::date IS NULL OR t.updated_at >= ${filter.from}::date)
        -- The "to" day is inclusive, so the bound is the start of the next one.
        -- Comparing "<= to" would silently exclude everything that happened on
        -- that date after midnight, which is all of it.
        AND (${filter.to}::date IS NULL OR t.updated_at < (${filter.to}::date + 1))
      ORDER BY t.updated_at DESC
      LIMIT ${filter.limit + 1}`;

    const projekte = await this.sql<Array<{ id: string; slug: string; name: string }>>`
      SELECT DISTINCT p.id, p.slug, p.name
      FROM projects p JOIN tasks t ON t.project_id = p.id
      ORDER BY p.name`;

    return {
      aufgaben: rows.slice(0, filter.limit).map(toZeile),
      truncated: rows.length > filter.limit,
      projekte: [...projekte],
    };
  }

  async taskRow(taskId: string): Promise<SpurAufgabeZeile | null> {
    const [row] = await this.sql<TaskRow[]>`
      SELECT
        t.id, t.project_id, p.slug AS project_slug, t.state, t.priority, t.title,
        t.department, t.type, t.branch, t.created_at, t.updated_at, t.retry_count
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.id = ${taskId}::uuid`;
    return row ? toZeile(row) : null;
  }

  /** The whole timeline: every event, every run, every gate run, every finding. */
  async task(taskId: string): Promise<SpurAufgabeDetail | null> {
    const aufgabe = await this.taskRow(taskId);
    if (!aufgabe) return null;

    const [meta] = await this.sql<
      Array<{
        description: string | null;
        acceptance_criteria: unknown;
        worktree_path: string | null;
      }>
    >`
      SELECT
        payload ->> 'description'        AS description,
        payload -> 'acceptanceCriteria'  AS acceptance_criteria,
        payload ->> 'worktreePath'       AS worktree_path
      FROM task_events WHERE task_id = ${taskId}::uuid AND kind = 'created' LIMIT 1`;

    const ereignisse = await this.sql<
      Array<{
        seq: number;
        kind: string;
        occurred_at: Date;
        state: string;
        priority: string;
        actor: string;
        payload: unknown;
      }>
    >`
      SELECT seq, kind, occurred_at, state, priority, actor, payload
      FROM task_events WHERE task_id = ${taskId}::uuid ORDER BY seq`;

    return {
      aufgabe,
      description: meta?.description ?? null,
      acceptanceCriteria: Array.isArray(meta?.acceptance_criteria)
        ? (meta.acceptance_criteria as string[])
        : [],
      worktreePath: meta?.worktree_path ?? null,
      ereignisse: ereignisse.map((row) => ({
        seq: row.seq,
        kind: row.kind,
        occurredAt: row.occurred_at.toISOString(),
        state: row.state as SpurAufgabeZeile['state'],
        priority: row.priority as SpurAufgabeZeile['priority'],
        actor: row.actor,
        payload: row.payload,
      })),
      laeufe: await this.runsForTask(taskId),
      gateLaeufe: await this.gateRuns(taskId),
      befunde: await this.findings(taskId),
    };
  }

  /** Decision 1: ids out of the events, then the view joined on its group key. */
  async runsForTask(taskId: string): Promise<SpurLauf[]> {
    const rows = await this.sql<RunRow[]>`
      WITH ids AS (
        SELECT DISTINCT run_id FROM agent_run_events
        WHERE kind = 'created' AND payload ->> 'taskId' = ${taskId}
      )
      ${this.runSelect()}
      JOIN ids USING (run_id)
      ORDER BY r.created_at`;
    return rows.map(toLauf);
  }

  async run(runId: string): Promise<SpurLauf | null> {
    const [row] = await this.sql<RunRow[]>`
      ${this.runSelect()}
      WHERE r.run_id = ${runId}::uuid`;
    return row ? toLauf(row) : null;
  }

  /**
   * The projected run, plus decision 2's two fields.
   *
   * Both subselects are keyed on `(run_id, seq)`, which is 0003's index, so each
   * is an index scan of one row rather than a second aggregate.
   */
  private runSelect() {
    return this.sql`
      SELECT
        r.run_id, r.task_id, r.role, r.model, r.backend, r.cwd, r.session_id,
        r.created_at, r.started_at, r.ended_at, r.is_finished, r.terminal_reason,
        r.exit_code, r.tokens_in, r.tokens_out, r.cost_usd, r.tool_uses,
        r.hook_events, r.permission_denials, r.repair_of, r.resumed_of,
        r.transcript_path,
        (SELECT e.payload -> 'caps' FROM agent_run_events e
          WHERE e.run_id = r.run_id AND e.kind = 'created'
          ORDER BY e.seq LIMIT 1) AS caps,
        (SELECT e.payload ->> 'transcriptProblem' FROM agent_run_events e
          WHERE e.run_id = r.run_id AND e.kind = 'terminated'
          ORDER BY e.seq DESC LIMIT 1) AS transcript_problem
      FROM agent_runs r`;
  }

  async gateRuns(taskId: string): Promise<SpurGateLauf[]> {
    const rows = await this.sql<
      Array<{
        id: string;
        stage: string;
        started_at: Date;
        finished_at: Date;
        duration_ms: number;
        ok: boolean;
        head_sha: string | null;
        base_ref: string | null;
        steps: unknown;
      }>
    >`
      SELECT id, stage, started_at, finished_at, duration_ms, ok, head_sha, base_ref, steps
      FROM gate_runs WHERE task_id = ${taskId}::uuid ORDER BY seq DESC`;

    return rows.map((row) => ({
      id: row.id,
      stage: row.stage,
      startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at.toISOString(),
      durationMs: row.duration_ms,
      ok: row.ok,
      headSha: row.head_sha,
      baseRef: row.base_ref,
      steps: (Array.isArray(row.steps) ? row.steps : []).map((step) => {
        const s = step as Record<string, unknown>;
        return {
          id: String(s.id ?? 'unbekannt'),
          verdict: String(s.verdict ?? 'unbekannt'),
          detail: typeof s.detail === 'string' ? s.detail : null,
          output: typeof s.output === 'string' ? s.output : null,
          exitCode: typeof s.exitCode === 'number' ? s.exitCode : null,
          durationMs: typeof s.durationMs === 'number' ? s.durationMs : null,
          attempts: typeof s.attempts === 'number' ? s.attempts : null,
        };
      }),
    }));
  }

  async findings(taskId: string): Promise<SpurBefund[]> {
    const rows = await this.sql<
      Array<{
        id: string;
        gate_run_id: string;
        gate_id: string;
        raised_at: Date;
        raised_on_sha: string | null;
        detail: string | null;
        output: string | null;
        exit_code: number | null;
        status: string;
        resolved_at: Date | null;
        resolved_on_sha: string | null;
      }>
    >`
      SELECT id, gate_run_id, gate_id, raised_at, raised_on_sha, detail, output,
             exit_code, status, resolved_at, resolved_on_sha
      FROM findings WHERE task_id = ${taskId}::uuid ORDER BY raised_at DESC`;

    return rows.map((row) => ({
      id: row.id,
      gateRunId: row.gate_run_id,
      gateId: row.gate_id,
      raisedAt: row.raised_at.toISOString(),
      raisedOnSha: row.raised_on_sha,
      detail: row.detail,
      output: row.output,
      exitCode: row.exit_code,
      // §11 has one severity, and 0015 writes it as a literal for that reason.
      severity: 'blocker' as const,
      status: row.status as SpurBefund['status'],
      resolvedAt: row.resolved_at?.toISOString() ?? null,
      resolvedOnSha: row.resolved_on_sha,
    }));
  }

  /**
   * Which two commits this task's diff is between (decisions 3 and 4).
   *
   * Most specific first. The merge pair is preferred over everything because it
   * is the only basis that keeps answering after A44.5 deletes the branch, and
   * because it is the change that actually landed rather than the change that
   * was proposed.
   */
  async diffBasis(taskId: string): Promise<DiffBasisResolution> {
    const [task] = await this.sql<Array<{ project_id: string; branch: string | null }>>`
      SELECT project_id, branch FROM tasks WHERE id = ${taskId}::uuid`;
    if (!task) return { ok: false, reason: 'no_task' };

    const [project] = await this.sql<Array<{ root_path: string; default_branch: string }>>`
      SELECT root_path, default_branch FROM projects WHERE id = ${task.project_id}::uuid`;
    if (!project) return { ok: false, reason: 'no_project' };

    // 1. The merge, as a consistent pair (decision 3).
    const [after] = await this.sql<Array<{ seq: number; sha: string }>>`
      SELECT seq, payload ->> 'baseShaAfter' AS sha FROM task_events
      WHERE task_id = ${taskId}::uuid
        AND kind = 'state_changed'
        AND payload ->> 'baseShaAfter' IS NOT NULL
      ORDER BY seq DESC LIMIT 1`;
    if (after) {
      const [before] = await this.sql<Array<{ sha: string }>>`
        SELECT payload ->> 'baseShaBefore' AS sha FROM task_events
        WHERE task_id = ${taskId}::uuid
          AND kind = 'state_changed' AND state = 'merging'
          AND payload ->> 'baseShaBefore' IS NOT NULL
          AND seq < ${after.seq}
        ORDER BY seq DESC LIMIT 1`;
      if (before?.sha) {
        return {
          ok: true,
          basis: 'merge',
          fromRef: before.sha,
          toRef: after.sha,
          // Two recorded commits, so the plain pair. A fork-point comparison
          // here would be actively wrong: after a fast-forward the `before` sha
          // *is* the fork point's ancestor and `A...B` would silently drop
          // whatever else landed between them.
          forkPoint: false,
          repoPath: project.root_path,
        };
      }
    }

    // 2. The tree a gate suite actually checked. `base_ref` is the integration
    //    branch, which has moved on since the candidate forked, so the left end
    //    has to be the fork point — left to git's `A...B` rather than computed
    //    here, because git already answers exactly this question.
    const [gate] = await this.sql<Array<{ head_sha: string; base_ref: string }>>`
      SELECT head_sha, base_ref FROM gate_runs
      WHERE task_id = ${taskId}::uuid AND head_sha IS NOT NULL AND base_ref IS NOT NULL
      ORDER BY seq DESC LIMIT 1`;
    if (gate) {
      return {
        ok: true,
        basis: 'gate',
        fromRef: gate.base_ref,
        toRef: gate.head_sha,
        forkPoint: true,
        repoPath: project.root_path,
      };
    }

    // 3. The live branch. Last, because it is the only basis that can vanish.
    if (task.branch) {
      return {
        ok: true,
        basis: 'branch',
        fromRef: project.default_branch,
        toRef: task.branch,
        forkPoint: true,
        repoPath: project.root_path,
      };
    }

    return { ok: false, reason: 'no_basis' };
  }
}

function toZeile(row: TaskRow): SpurAufgabeZeile {
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    projectSlug: row.project_slug,
    state: row.state as SpurAufgabeZeile['state'],
    priority: row.priority as SpurAufgabeZeile['priority'],
    department: row.department,
    type: row.type,
    branch: row.branch,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    retryCount: Number(row.retry_count ?? 0),
  };
}

function toLauf(row: RunRow): SpurLauf {
  const started = row.started_at ?? row.created_at;
  return {
    runId: row.run_id,
    taskId: row.task_id,
    role: row.role,
    model: row.model,
    backend: row.backend,
    cwd: row.cwd,
    sessionId: row.session_id,
    createdAt: row.created_at.toISOString(),
    startedAt: row.started_at?.toISOString() ?? null,
    endedAt: row.ended_at?.toISOString() ?? null,
    // Null while the run is live: a duration measured against `now` would make
    // a crashed run from March look like it had been working for months.
    durationMs: row.ended_at ? row.ended_at.getTime() - started.getTime() : null,
    finished: row.is_finished,
    terminalReason: row.terminal_reason,
    exitCode: row.exit_code,
    tokensIn: zahl(row.tokens_in),
    tokensOut: zahl(row.tokens_out),
    costUsd: zahl(row.cost_usd),
    toolUses: Number(row.tool_uses ?? 0),
    hookEvents: Number(row.hook_events ?? 0),
    permissionDenials: Number(row.permission_denials ?? 0),
    caps: toKappen(row.caps),
    repairOf: row.repair_of,
    resumedOf: row.resumed_of,
    transcriptPath: row.transcript_path,
    transcriptProblem: row.transcript_problem,
  };
}

/**
 * `bigint` and `numeric` arrive as strings from the driver.
 *
 * Kept explicit rather than left to `Number(x)` on the field, because `Number(null)`
 * is 0 and a run with no recorded spend would then read as a run that spent
 * nothing — two different facts, and the second is the one this project has
 * already been burned by (A60.2's column that was read for months and written by
 * nobody).
 */
function zahl(value: string | number | null): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function toKappen(raw: unknown): SpurLauf['caps'] {
  if (!raw || typeof raw !== 'object') return null;
  const caps = raw as Record<string, unknown>;
  const feld = (key: string): number | null =>
    typeof caps[key] === 'number' && Number.isFinite(caps[key]) ? (caps[key] as number) : null;
  return {
    maxTurns: feld('maxTurns'),
    maxBudgetUsd: feld('maxBudgetUsd'),
    wallClockMs: feld('wallClockMs'),
  };
}
