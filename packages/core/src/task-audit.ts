import type postgres from 'postgres';
import type { Queryable } from './sql.js';

/**
 * §19's trail for a task a person created, and the reason it is separate from
 * §18's event log.
 *
 * `TaskService.create` already appends `task.created` to `event_log` with an
 * actor, and that is §18's chain: goal → task → run → transcript. It answers
 * *what happened in the studio*. §19 asks a different question — "audit log for
 * every config change **and dashboard action**" — and its answer has to survive
 * the case where the two disagree: an actor in the event log is whoever the
 * caller passed, while a row here exists only because a request came through a
 * session. A trail that is a projection of the thing it audits is not a trail.
 *
 * Written in the **same transaction** as the task itself (`aufgaben.ts` wires
 * it), so a task created with nothing saying who created it is not a state this
 * can reach. That is `SourceAuditLog`'s arrangement one entity over, and A62.2
 * makes the point from the other side: "a refusal that leaves no row is
 * indistinguishable from an attempt that never happened".
 *
 * The subject is the task id rather than its title: a title can repeat, and a
 * subject two rows share for different tasks is a trail nobody can read
 * backwards (`sources/audit.ts` made the same call).
 */
export interface TaskAuditEntry {
  actor: string;
  taskId: string;
  projectId: string;
  title: string;
  priority: string;
  initialState: string;
  acceptanceCriteria: readonly string[];
}

export interface TaskAuditTrail {
  record(entry: TaskAuditEntry): Promise<void>;
}

export class TaskAuditLog implements TaskAuditTrail {
  constructor(private readonly sql: Queryable) {}

  async record(entry: TaskAuditEntry): Promise<void> {
    await this.sql`
      INSERT INTO audit_log (actor, action, subject, before, after)
      VALUES (
        ${entry.actor}, 'task.created', ${entry.taskId},
        NULL,
        ${this.sql.json({
          projectId: entry.projectId,
          title: entry.title,
          priority: entry.priority,
          initialState: entry.initialState,
          // The count, not the text: §19's trail says a mandate existed, and
          // the criteria themselves are already in `task_events` where the
          // Planner reads them. Copying them here would be a second place the
          // same sentence lives, and they can be long.
          acceptanceCriteria: entry.acceptanceCriteria.length,
        } as postgres.JSONValue)}
      )
    `;
  }
}
