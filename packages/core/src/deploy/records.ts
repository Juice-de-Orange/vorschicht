/**
 * Reading and writing `deployment_events` (§5, §12, migration 0019).
 *
 * Two rules, and both are the reason this is its own module rather than inline
 * in the service:
 *
 *   1. **`seq` is exactly `max(seq) + 1`**, the same optimistic-concurrency
 *      bargain A43.2 struck for tasks: `UNIQUE (deployment_id, seq)` then means
 *      two writers cannot both believe they appended, and the loser finds out
 *      at the write rather than at the read. A deploy has one writer today, and
 *      writing that down is cheaper than discovering it does not the day a
 *      retry overlaps a rollback.
 *
 *   2. **Nothing here interprets.** `lastGood` answers "which release was last
 *      serving and healthy", and that is a query, not a judgement — the service
 *      decides what to do with the answer. The split is A48.2's, one subsystem
 *      over: the layer that can rewrite history must not also decide.
 */
import type { DeployMethod } from '@vorschicht/shared';
import type { Queryable } from '../sql.js';

export type DeploymentEventKind =
  | 'started'
  | 'migrated'
  | 'swapped'
  | 'health_checked'
  | 'smoke_checked'
  | 'succeeded'
  | 'rolled_back'
  | 'failed';

export interface DeploymentRecord {
  id: string;
  projectId: string;
  taskId: string | null;
  sha: string;
  method: DeployMethod;
  artifact: string | null;
  startedAt: Date;
  lastStep: DeploymentEventKind | null;
  healthOk: boolean | null;
  healthDetail: string | null;
  outcome: 'succeeded' | 'rolled_back' | 'failed' | null;
  finishedAt: Date | null;
  rolledBackTo: string | null;
  problem: string | null;
  durationMs: number | null;
}

interface DeploymentRow {
  id: string;
  project_id: string;
  task_id: string | null;
  sha: string;
  method: DeployMethod;
  artifact: string | null;
  started_at: Date;
  last_step: DeploymentEventKind | null;
  health_ok: boolean | null;
  health_detail: string | null;
  outcome: DeploymentRecord['outcome'];
  finished_at: Date | null;
  rolled_back_to: string | null;
  problem: string | null;
  duration_ms: string | number | null;
}

export class DeployRecords {
  constructor(private readonly sql: Queryable) {}

  /** The first event, which is what brings a deployment into existence. */
  async start(input: {
    deploymentId: string;
    projectId: string;
    taskId: string | null;
    sha: string;
    method: DeployMethod;
    artifact?: string | null;
    actor: string;
  }): Promise<void> {
    await this.sql`
      INSERT INTO deployment_events (deployment_id, seq, kind, actor, payload)
      VALUES (${input.deploymentId}, 0, 'started', ${input.actor}, ${this.sql.json({
        projectId: input.projectId,
        taskId: input.taskId,
        sha: input.sha,
        method: input.method,
        artifact: input.artifact ?? null,
      } as never)})
    `;
  }

  async append(
    deploymentId: string,
    kind: DeploymentEventKind,
    actor: string,
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    await this.sql`
      INSERT INTO deployment_events (deployment_id, seq, kind, actor, payload)
      SELECT ${deploymentId}, COALESCE(MAX(seq), -1) + 1, ${kind}, ${actor},
             ${this.sql.json(payload as never)}
      FROM deployment_events WHERE deployment_id = ${deploymentId}
    `;
  }

  async get(deploymentId: string): Promise<DeploymentRecord | null> {
    const rows = await this.sql<DeploymentRow[]>`
      SELECT * FROM deployments WHERE id = ${deploymentId}
    `;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** §12's release history, newest first. */
  async forProject(projectId: string, limit = 50): Promise<DeploymentRecord[]> {
    const rows = await this.sql<DeploymentRow[]>`
      SELECT * FROM deployments WHERE project_id = ${projectId}
      ORDER BY started_at DESC LIMIT ${limit}
    `;
    return rows.map(toRecord);
  }

  /**
   * The newest release that actually served and was healthy — what a rollback
   * goes back to (§12).
   *
   * `outcome = 'succeeded'` and not merely "was swapped": a release that was
   * swapped in and then failed its health check is exactly the thing being
   * rolled back *from*, and treating it as a destination would make a rollback
   * a no-op at the one moment it has to work. A release that was itself the
   * *result* of a rollback counts — it served and it was healthy, which is the
   * whole question.
   *
   * **There is deliberately no `exclude` parameter.** The first version took the
   * deployment being rolled back from and excluded it by id, and a mutation
   * removing that argument changed no test — because it could not: at the
   * moment of a rollback that deployment has no `outcome` at all, so the filter
   * above already excludes it. A guard nothing can prove reads as covered and
   * is worse than the gap it hides (§8.2's sixth domain), so it is gone and the
   * single condition that does the work is named instead.
   */
  async lastGood(projectId: string): Promise<DeploymentRecord | null> {
    const rows = await this.sql<DeploymentRow[]>`
      SELECT * FROM deployments
      WHERE project_id = ${projectId}
        AND outcome = 'succeeded'
        AND artifact IS NOT NULL
      ORDER BY started_at DESC LIMIT 1
    `;
    return rows[0] ? toRecord(rows[0]) : null;
  }
}

function toRecord(row: DeploymentRow): DeploymentRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    sha: row.sha,
    method: row.method,
    artifact: row.artifact,
    startedAt: row.started_at,
    lastStep: row.last_step,
    healthOk: row.health_ok,
    healthDetail: row.health_detail,
    outcome: row.outcome,
    finishedAt: row.finished_at,
    rolledBackTo: row.rolled_back_to,
    problem: row.problem,
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
  };
}
