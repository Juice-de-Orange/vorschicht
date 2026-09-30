/**
 * Startup reconciliation (§7.2, Phase 1 chaos gate).
 *
 * An orchestrator that is killed mid-session leaves two kinds of debris: runs
 * that never emitted `terminated`, and tasks that still claim to be `coding`
 * while the session that was doing the coding no longer exists. Neither is
 * detectable at runtime — the process that would have noticed is the one that
 * died — so the check belongs at startup, before any work is accepted.
 *
 * The rule this implements is §7.2's: such a task becomes `interrupted`, which
 * is **not** red. It is a re-check state, and the database refuses to let it
 * move again until the integrity check has passed. That refusal is the point:
 * a worktree that was cut off mid-edit must be looked at before anything builds
 * on top of it.
 */
import { IN_FLIGHT_TASK_STATES } from '@vorschicht/shared';
import type postgres from 'postgres';
import type { EventLog } from './event-log.js';
import { TaskConflictError, type TaskService } from './task-service.js';

export interface OrphanRun {
  runId: string;
  taskId: string | null;
  cwd: string | null;
  role: string | null;
}

export interface ReconcileResult {
  orphanRuns: OrphanRun[];
  interruptedTasks: string[];
  /** Tasks that were active with no run at all — a crash before `created`. */
  strandedTasks: string[];
}

export interface ReconcileDeps {
  sql: postgres.Sql;
  tasks: TaskService;
  eventLog: EventLog;
  /** Run ids this process knows are genuinely live. Empty at startup. */
  liveRunIds?: () => Set<string>;
}

/**
 * Runs with no terminal event.
 *
 * `agent_runs` is a view over the run's own events, so "was it killed?" is
 * answerable without having stored a flag that the kill would have prevented
 * anyone from writing.
 */
export async function findOrphanRuns(
  sql: postgres.Sql,
  live: Set<string> = new Set(),
): Promise<OrphanRun[]> {
  const rows = await sql<
    Array<{ run_id: string; task_id: string | null; cwd: string | null; role: string | null }>
  >`
    SELECT run_id::text, task_id, cwd, role FROM agent_runs
    WHERE is_finished = false ORDER BY created_at ASC
  `;
  return rows
    .filter((row) => !live.has(row.run_id))
    .map((row) => ({ runId: row.run_id, taskId: row.task_id, cwd: row.cwd, role: row.role }));
}

/**
 * Close the books on everything the previous process left behind.
 *
 * Idempotent by construction: a run that already has `terminated` is not an
 * orphan, and a task already `interrupted` cannot transition to `interrupted`
 * again — so running this twice changes nothing the second time.
 */
export async function reconcile(deps: ReconcileDeps): Promise<ReconcileResult> {
  const live = deps.liveRunIds?.() ?? new Set<string>();
  const orphanRuns = await findOrphanRuns(deps.sql, live);
  const interruptedTasks: string[] = [];
  const strandedTasks: string[] = [];

  for (const orphan of orphanRuns) {
    // The missing terminal event, written now with the honest reason. Without
    // it the run would look live forever and the next reconcile would find it
    // again — and the token and duration figures would never close.
    const [next] = await deps.sql<Array<{ seq: number }>>`
      SELECT COALESCE(max(seq), -1) + 1 AS seq FROM agent_run_events WHERE run_id = ${orphan.runId}
    `;
    await deps.sql`
      INSERT INTO agent_run_events (run_id, seq, kind, payload)
      VALUES (${orphan.runId}, ${next?.seq ?? 0}, 'terminated',
              ${deps.sql.json({ reason: 'orphaned', exitCode: null, reconciledAt: new Date().toISOString() })})
    `;
    await deps.eventLog.append({
      kind: 'run.interrupted',
      actor: 'system',
      runId: orphan.runId,
      taskId: orphan.taskId,
      payload: { reason: 'orphaned_by_restart', role: orphan.role, cwd: orphan.cwd },
    });
  }

  // Any task in an in-flight state has no process behind it — this one just
  // started and owns none. True whether or not a run was found: a crash between
  // "task moved to coding" and "run created" leaves a task with no run at all,
  // and its worktree needs the same look.
  //
  // Deliberately narrower than the wrap-up's set. A task sitting in `claimed`
  // or `merge_queue` was waiting, not working; nothing touched its worktree, and
  // §7.2's re-check is a model session. Marking those `interrupted` would spend
  // a Debugger run on every restart — and a deploy is a restart.
  const inFlight = await deps.tasks.listByState(IN_FLIGHT_TASK_STATES);
  const orphanTaskIds = new Set(orphanRuns.map((o) => o.taskId).filter((id): id is string => !!id));

  for (const task of inFlight) {
    try {
      await deps.tasks.transition(task.id, 'interrupted', {
        actor: 'system',
        reason: 'Orchestrator wurde neu gestartet — Arbeitskopie muss geprüft werden (§7.2)',
        resumeState: task.state,
        payload: {
          protocol: 'reconcile',
          hadRun: orphanTaskIds.has(task.id),
          worktreePath: task.worktreePath,
        },
      });
      interruptedTasks.push(task.id);
      if (!orphanTaskIds.has(task.id)) strandedTasks.push(task.id);
    } catch (error) {
      if (error instanceof TaskConflictError) continue;
      throw error;
    }
  }

  return { orphanRuns, interruptedTasks, strandedTasks };
}
