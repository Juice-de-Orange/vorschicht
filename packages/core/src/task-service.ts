/**
 * Tasks (§9), the unit of work.
 *
 * The database already refuses illegal moves (migration 0006). This service is
 * not a second opinion on that — it is the layer that makes a legal move
 * *complete*: the lifecycle row, the correlated `event_log` entry the dashboard
 * and the trace view render from, and the German reason text that ends up in
 * the timeline. §9's "no silent transitions" needs both halves; a state that
 * changed without an event is invisible, and an event without a state change is
 * a lie.
 *
 * Concurrency is optimistic and inherited from the schema: every write carries
 * the `version` (the event `seq`) the caller last saw, and a stale one is
 * rejected by the database rather than by a lock this process would have to
 * remember to take. Callers that lose the race retry against fresh state.
 */

import { randomUUID } from 'node:crypto';
import {
  canTransition,
  isSuspendedTaskState,
  type ParkReason,
  type Priority,
  type TaskEventKind,
  type TaskState,
  validateClaimGlobs,
} from '@vorschicht/shared';
import type postgres from 'postgres';
import type { EventLog } from './event-log.js';
import type { Queryable } from './sql.js';

/** A task as the scheduler and the dashboard see it — the `tasks` view. */
export interface TaskRecord {
  id: string;
  projectId: string;
  state: TaskState;
  priority: Priority;
  resumeState: TaskState | null;
  /** The `seq` of the last event; the token for the next write. */
  version: number;
  createdAt: Date;
  updatedAt: Date;
  title: string;
  /**
   * The brief: what is wanted and why, in prose.
   *
   * Fixed at creation together with `acceptanceCriteria` (migration 0010) —
   * a task whose mandate changed is a new plan, and that belongs in the note
   * timeline where it is dated and attributed rather than silently overwritten.
   */
  description: string | null;
  /** What "done" means for this task (§8 row 1). The Planner reads these first. */
  acceptanceCriteria: string[];
  department: string | null;
  type: string | null;
  goalId: string | null;
  parentTaskId: string | null;
  /** Where the coder works. Assigned by the worktree manager (Phase 2 step 4). */
  worktreePath: string | null;
  branch: string | null;
  retryCount: number;
  parkCount: number;
  interruptCount: number;
}

export interface CreateTaskSpec {
  projectId: string;
  title: string;
  description?: string;
  acceptanceCriteria?: readonly string[];
  priority?: Priority;
  department?: string;
  type?: string;
  goalId?: string;
  parentTaskId?: string;
  worktreePath?: string;
  branch?: string;
  /** `draft` when a Planner is still shaping it, `queued` when it is ready. */
  initialState?: Extract<TaskState, 'draft' | 'queued'>;
  actor?: string;
  id?: string;
  /**
   * The agent run that produced this task, where one did (§18).
   *
   * §21's idle audits are the first caller that has one: a P2 task filed at
   * four in the morning by a session nobody watched is a sentence with no
   * author, and the first question anybody asks about an unexplained task is
   * where it came from. With this on the `task.created` row, the answer is one
   * join — to the run, its role, its domain and its transcript. Without it the
   * chain §18 promises ends at the task and the session is unreachable.
   *
   * Absent for a task a human or the Product Lead created, which is the
   * ordinary case and reads as null rather than as a missing link.
   */
  runId?: string;
}

export interface TransitionOptions {
  actor?: string;
  /** Shown in the timeline and the inbox; German (§2). */
  reason?: string;
  payload?: Record<string, unknown>;
  /** Refuse the write unless the task is still at this version. */
  expectedVersion?: number;
  /** Required when moving into a suspended state; ignored otherwise. */
  resumeState?: TaskState;
}

/**
 * Thrown when the write lost a race or the caller's view was stale.
 *
 * Separate from a plain error because the correct response differs: a stale
 * version is retried against fresh state, an illegal transition is a defect.
 */
export class TaskConflictError extends Error {
  constructor(
    readonly taskId: string,
    message: string,
  ) {
    super(message);
    this.name = 'TaskConflictError';
  }
}

export class TaskTransitionError extends Error {
  constructor(
    readonly taskId: string,
    readonly from: TaskState,
    readonly to: TaskState,
    message: string,
  ) {
    super(message);
    this.name = 'TaskTransitionError';
  }
}

export interface TaskServiceDeps {
  /** The pool, or a transaction — claim acquisition needs the latter (§10). */
  sql: Queryable;
  eventLog: EventLog;
}

export class TaskService {
  constructor(private readonly deps: TaskServiceDeps) {}

  async create(spec: CreateTaskSpec): Promise<TaskRecord> {
    // The id is minted here rather than by the database so that the caller —
    // and the correlated event_log row below — can name the task before the
    // insert is even acknowledged.
    const taskId = spec.id ?? randomUUID();
    await this.deps.sql`
      INSERT INTO task_events (task_id, seq, kind, project_id, state, priority, actor, payload)
      VALUES (
        ${taskId}, 0, 'created', ${spec.projectId},
        ${spec.initialState ?? 'queued'}, ${spec.priority ?? 'P2'}, ${spec.actor ?? 'system'},
        ${this.deps.sql.json({
          title: spec.title,
          description: spec.description ?? null,
          acceptanceCriteria: [...(spec.acceptanceCriteria ?? [])],
          department: spec.department ?? null,
          type: spec.type ?? null,
          goalId: spec.goalId ?? null,
          parentTaskId: spec.parentTaskId ?? null,
          worktreePath: spec.worktreePath ?? null,
          branch: spec.branch ?? null,
        } as postgres.JSONValue)}
      )
    `;

    await this.deps.eventLog.append({
      kind: 'task.created',
      actor: spec.actor ?? 'system',
      projectId: spec.projectId,
      taskId,
      // §18: the run that produced this task, on the row that records it
      // existing. `event_log.run_id` is the column the trace explorer joins on,
      // so putting it in the payload instead would be a link nothing follows.
      runId: spec.runId ?? null,
      payload: { title: spec.title, priority: spec.priority ?? 'P2', type: spec.type ?? null },
    });

    return this.require(taskId);
  }

  async get(taskId: string): Promise<TaskRecord | null> {
    const rows = await this.deps.sql`SELECT * FROM tasks WHERE id = ${taskId}`;
    return this.mapRows(rows)[0] ?? null;
  }

  /**
   * Move a task, or explain precisely why not.
   *
   * The pre-check against `canTransition` is not belt-and-braces for the
   * database guard: it is what turns "restrict_violation" into a sentence the
   * timeline can show, and it fails before anything is written. The guard is
   * what holds when a *different* writer tries the same thing at the same time.
   */
  async transition(
    taskId: string,
    to: TaskState,
    options: TransitionOptions = {},
  ): Promise<TaskRecord> {
    const task = await this.require(taskId);
    this.assertVersion(task, options.expectedVersion);

    const verdict = canTransition(
      {
        state: task.state,
        resumeState: task.resumeState,
        integrityChecked: await this.integrityChecked(taskId),
      },
      to,
    );
    if (!verdict.ok) {
      throw new TaskTransitionError(taskId, task.state, to, verdict.reason);
    }

    const resumeState = isSuspendedTaskState(to) ? (options.resumeState ?? task.state) : null;
    if (isSuspendedTaskState(to) && !resumeState) {
      throw new TaskTransitionError(
        taskId,
        task.state,
        to,
        `Zustand ${to} braucht einen Rückkehrpunkt (§7.3)`,
      );
    }

    await this.append(task, {
      kind: 'state_changed',
      state: to,
      resumeState,
      actor: options.actor ?? 'system',
      payload: { from: task.state, reason: options.reason ?? null, ...(options.payload ?? {}) },
    });

    await this.deps.eventLog.append({
      kind: 'task.state_changed',
      actor: options.actor ?? 'system',
      projectId: task.projectId,
      taskId,
      payload: {
        from: task.state,
        to,
        reason: options.reason ?? null,
        ...(options.payload ?? {}),
      },
    });

    return this.require(taskId);
  }

  /**
   * Append a note without moving the task (§7.3 step 3, §9 learnings).
   *
   * The handover note is the whole point of parking cleanly rather than
   * stopping: the next session reads it instead of re-deriving where the last
   * one got to.
   */
  async note(
    taskId: string,
    note: { text: string; actor?: string; payload?: Record<string, unknown> },
  ): Promise<TaskRecord> {
    const task = await this.require(taskId);
    await this.append(task, {
      kind: 'note',
      state: task.state,
      resumeState: task.resumeState,
      actor: note.actor ?? 'system',
      payload: { text: note.text, ...(note.payload ?? {}) },
    });
    return this.require(taskId);
  }

  /** §9's red path: requeue with a lower priority and the learnings attached. */
  async reprioritise(taskId: string, priority: Priority, actor = 'system'): Promise<TaskRecord> {
    const task = await this.require(taskId);
    if (task.priority === priority) return task;
    await this.append(task, {
      kind: 'reprioritised',
      state: task.state,
      resumeState: task.resumeState,
      priority,
      actor,
      payload: { from: task.priority, to: priority },
    });
    return this.require(taskId);
  }

  /**
   * The Planner's claim set (§10). Registered before any coder starts.
   *
   * The syntax check happens here rather than only in the registry, because
   * this is the write path: a glob nobody can intersect would land in the log
   * as a claim and behave as no claim at all, and the containment hook of §6.6
   * would then measure writes against a pattern it cannot evaluate.
   */
  async registerClaims(
    taskId: string,
    globs: readonly string[],
    actor = 'planner',
  ): Promise<TaskRecord> {
    const validated = validateClaimGlobs(globs);
    const task = await this.require(taskId);
    await this.append(task, {
      kind: 'claims_registered',
      state: task.state,
      resumeState: task.resumeState,
      actor,
      payload: { globs: validated },
    });
    return this.require(taskId);
  }

  /**
   * Give the claim set back (§10: on merge or task abort).
   *
   * The globs travel with the event so the timeline keeps them; the `claims`
   * view reads its rows out of whichever event came last, and a release that
   * carried nothing would erase the record of what was held.
   */
  async releaseClaims(
    taskId: string,
    release: { globs: readonly string[]; reason: string; actor?: string },
  ): Promise<TaskRecord> {
    const task = await this.require(taskId);
    await this.append(task, {
      kind: 'claims_released',
      state: task.state,
      resumeState: task.resumeState,
      actor: release.actor ?? 'orchestrator',
      payload: { globs: [...release.globs], reason: release.reason },
    });
    return this.require(taskId);
  }

  /**
   * Record the worktree and branch this task works in (§10).
   *
   * The `tasks` view projects the most recent of `worktree_assigned` /
   * `worktree_released`, so this is what makes `task.worktreePath` true — and
   * what the wrap-up reads when it needs somewhere to put the WIP commit.
   */
  async assignWorktree(
    taskId: string,
    worktree: { path: string; branch: string; baseBranch: string; baseSha: string },
    actor = 'orchestrator',
  ): Promise<TaskRecord> {
    const task = await this.require(taskId);
    await this.append(task, {
      kind: 'worktree_assigned',
      state: task.state,
      resumeState: task.resumeState,
      actor,
      payload: { ...worktree },
    });
    return this.require(taskId);
  }

  /** The worktree is gone — merged, aborted, or collected by the orphan GC. */
  async releaseWorktree(
    taskId: string,
    release: { path: string; branch: string; reason: string; branchDeleted: boolean },
    actor = 'orchestrator',
  ): Promise<TaskRecord> {
    const task = await this.require(taskId);
    await this.append(task, {
      kind: 'worktree_released',
      state: task.state,
      resumeState: task.resumeState,
      actor,
      payload: { ...release },
    });
    return this.require(taskId);
  }

  /**
   * Record the §7.2 re-check on a worktree a hard stop cut off.
   *
   * A failed check leaves the task `interrupted`; the database will not let it
   * resume, which is the point. Whoever wants it moving has to decide
   * consciously between another check and the red path.
   */
  async recordIntegrityCheck(
    taskId: string,
    result: { ok: boolean; findings?: string[]; actor?: string },
  ): Promise<TaskRecord> {
    const task = await this.require(taskId);
    if (task.state !== 'interrupted') {
      throw new TaskTransitionError(
        taskId,
        task.state,
        'interrupted',
        'Integritätsprüfung nur für unterbrochene Aufgaben (§7.2)',
      );
    }
    await this.append(task, {
      kind: 'integrity_check',
      state: task.state,
      resumeState: task.resumeState,
      actor: result.actor ?? 'debugger',
      payload: { ok: result.ok, findings: result.findings ?? [] },
    });
    return this.require(taskId);
  }

  /**
   * Resume a suspended task to exactly where it left off (§7.3, §15).
   *
   * There is no target parameter on purpose. The return point was decided when
   * the task was suspended; letting a caller pick one here would be the same
   * defect the database guard refuses, only phrased more politely.
   */
  async resume(taskId: string, options: TransitionOptions = {}): Promise<TaskRecord> {
    const task = await this.require(taskId);
    if (!isSuspendedTaskState(task.state)) return task;
    if (!task.resumeState) {
      throw new TaskTransitionError(
        taskId,
        task.state,
        task.state,
        'Kein gemerkter Rückkehrpunkt — Fortsetzung nicht möglich',
      );
    }
    return this.transition(taskId, task.resumeState, {
      ...options,
      reason: options.reason ?? 'Fortsetzung nach Unterbrechung',
    });
  }

  /** Tasks in the given states, tightest priority first, then oldest first. */
  async listByState(
    states: readonly TaskState[],
    options: { projectId?: string; limit?: number } = {},
  ): Promise<TaskRecord[]> {
    const rows = await this.deps.sql`
      SELECT * FROM tasks
      WHERE state = ANY(${[...states] as string[]})
        ${options.projectId ? this.deps.sql`AND project_id = ${options.projectId}` : this.deps.sql``}
      ORDER BY priority ASC, created_at ASC
      LIMIT ${options.limit ?? 200}
    `;
    return this.mapRows(rows);
  }

  /**
   * Everything the wrap-up protocol has to deal with (§7.3).
   *
   * Exactly the states that own a worktree and may own a live session. A task
   * sitting in `queued` needs no wrap-up — a paused queue already means it does
   * not start.
   */
  async listActive(projectId?: string): Promise<TaskRecord[]> {
    return this.listByState(
      ['planning', 'claimed', 'coding', 'review', 'gates', 'merge_queue', 'merging', 'deploying'],
      projectId ? { projectId } : {},
    );
  }

  /**
   * What resumes first after a window reset (§7.2).
   *
   * Parked work outranks anything queued, and within that the usual priority
   * order applies — a P0 that was parked mid-review comes back before a P3 that
   * never started.
   */
  async listResumable(): Promise<TaskRecord[]> {
    const rows = await this.deps.sql`
      SELECT * FROM tasks WHERE state = 'parked'
      ORDER BY priority ASC, updated_at ASC
    `;
    return this.mapRows(rows);
  }

  /**
   * The `reason` recorded on the most recent transition into a given state.
   *
   * Narrow on purpose. The §7.2 re-check has to tell the Debugger what kind of
   * stop it is looking at — a hard-stop kill mid-edit leaves a different mess
   * from an orchestrator that died between two commits — and that fact is in
   * the log rather than on the task. Returns null when the state was never
   * entered or the transition carried no reason, so the caller can say "none
   * recorded" rather than quoting an empty string.
   */
  async lastTransitionReason(taskId: string, state: TaskState): Promise<string | null> {
    const [row] = await this.deps.sql<Array<{ reason: string | null }>>`
      SELECT payload ->> 'reason' AS reason FROM task_events
      WHERE task_id = ${taskId} AND kind = 'state_changed' AND state = ${state}
      ORDER BY seq DESC LIMIT 1
    `;
    return row?.reason ?? null;
  }

  /**
   * How often this task has entered a state — §8.1's review round, counted.
   *
   * The dev chain used to hold the round in a local variable, which was enough
   * while the only way into the loop was from the top. It is not enough for a
   * chain re-entered in the middle (§6.4, §7.3): a task that comes back at
   * `coding` after the operator answered is in round *two*, and a chain that restarted the
   * count would give itself three fresh rounds every time somebody escalated —
   * quietly retiring the bound §8.1 puts on the Coder⇄Reviewer loop.
   *
   * Counted from the log rather than stored on the task, for A43's reason: the
   * log is the record and a column beside it is a second one to keep in step.
   *
   * `since` bounds the count to the current attempt, and it is not optional in
   * any useful sense: §9's red path requeues a task through `queued` and a new
   * pass re-enters at `planning`, so an unbounded count of `coding` entries would
   * still carry the three rounds of the *previous* attempt — and a task that
   * escalated in its second attempt would come back believing it had already
   * used up §8.1's budget.
   *
   * `notFrom` excludes the transitions that are *returns* rather than starts,
   * and it is the half that only shows up once something resumes: coming back
   * from `parked` or `needs_decision` writes a `state_changed` into `coding`
   * exactly like beginning a new round does. Counting those would make every
   * park cost a round, so a task suspended twice would exhaust §8.1's loop
   * without a Coder having produced anything a second time.
   */
  async countEntries(
    taskId: string,
    state: TaskState,
    options: { since?: TaskState; notFrom?: readonly TaskState[] } = {},
  ): Promise<number> {
    const since = options.since;
    const notFrom = options.notFrom;
    const [row] = await this.deps.sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM task_events
      WHERE task_id = ${taskId} AND kind = 'state_changed' AND state = ${state}
        ${
          since
            ? this.deps.sql`AND seq > COALESCE((
                SELECT max(s.seq) FROM task_events s
                WHERE s.task_id = ${taskId} AND s.kind = 'state_changed' AND s.state = ${since}
              ), -1)`
            : this.deps.sql``
        }
        ${
          notFrom && notFrom.length > 0
            ? this.deps.sql`AND COALESCE(payload ->> 'from', '') <> ALL(${this.deps.sql.array([
                ...notFrom,
              ] as string[])})`
            : this.deps.sql``
        }
    `;
    return Number(row?.count ?? 0);
  }

  /** Has the §7.2 re-check passed since the most recent interrupt? */
  private async integrityChecked(taskId: string): Promise<boolean> {
    const [row] = await this.deps.sql<Array<{ ok: boolean }>>`
      SELECT EXISTS (
        SELECT 1 FROM task_events c
        WHERE c.task_id = ${taskId} AND c.kind = 'integrity_check'
          AND c.payload ->> 'ok' = 'true'
          AND c.seq > COALESCE((
            SELECT max(i.seq) FROM task_events i
            WHERE i.task_id = ${taskId} AND i.kind = 'state_changed' AND i.state = 'interrupted'
          ), -1)
      ) AS ok
    `;
    return row?.ok ?? false;
  }

  private assertVersion(task: TaskRecord, expected?: number): void {
    if (expected !== undefined && expected !== task.version) {
      throw new TaskConflictError(
        task.id,
        `Aufgabe ist bei Version ${task.version}, der Aufrufer kennt ${expected} — ` +
          'zwischenzeitlich hat jemand anderes geschrieben',
      );
    }
  }

  private async require(taskId: string): Promise<TaskRecord> {
    const task = await this.get(taskId);
    if (!task) throw new Error(`Aufgabe ${taskId} existiert nicht`);
    return task;
  }

  /** The single write path. Version conflicts surface as `TaskConflictError`. */
  private async append(
    task: TaskRecord,
    event: {
      kind: TaskEventKind;
      state: TaskState;
      resumeState: TaskState | null;
      priority?: Priority;
      actor: string;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    try {
      await this.deps.sql`
        INSERT INTO task_events
          (task_id, seq, kind, project_id, state, priority, resume_state, actor, payload)
        VALUES (
          ${task.id}, ${task.version + 1}, ${event.kind}, ${task.projectId}, ${event.state},
          ${event.priority ?? task.priority}, ${event.resumeState}, ${event.actor},
          ${this.deps.sql.json(event.payload as postgres.JSONValue)}
        )
      `;
    } catch (error) {
      const message = (error as Error).message;
      // Both spellings of "you were too slow": the unique index when another
      // writer got there first, the guard when the caller's view was older.
      if (/duplicate key|unique|veralteter Stand oder Lücke/i.test(message)) {
        throw new TaskConflictError(
          task.id,
          `Aufgabe ${task.id} wurde zwischenzeitlich verändert (Version ${task.version})`,
        );
      }
      throw error;
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: postgres.js row shape is dynamic
  private mapRows(rows: any[]): TaskRecord[] {
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      state: row.state as TaskState,
      priority: row.priority as Priority,
      resumeState: (row.resume_state ?? null) as TaskState | null,
      version: Number(row.version),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      title: row.title,
      description: row.description ?? null,
      acceptanceCriteria: Array.isArray(row.acceptance_criteria) ? row.acceptance_criteria : [],
      department: row.department,
      type: row.type,
      goalId: row.goal_id,
      parentTaskId: row.parent_task_id,
      worktreePath: row.worktree_path,
      branch: row.branch,
      retryCount: Number(row.retry_count),
      parkCount: Number(row.park_count),
      interruptCount: Number(row.interrupt_count),
    }));
  }
}

export type { ParkReason };
