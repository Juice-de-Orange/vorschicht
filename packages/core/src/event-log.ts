/**
 * Writing to and reading from the event log (§18).
 *
 * The event log is the source of truth: the dashboard renders from it, traces
 * are reconstructed from it, and nothing ever deletes from it. This module is
 * the only sanctioned way to append — everything else goes through it so that
 * correlation ids and actor are never "forgotten just this once".
 */
import type postgres from 'postgres';
import type { Queryable } from './sql.js';

/**
 * Event kinds, as a closed list.
 *
 * Deliberately not free-form strings: the dashboard filters on these, the
 * weekly report counts them, and a typo in an event kind is the kind of defect
 * that shows up months later as a metric that was quietly always zero.
 */
// Eine Deklaration, browser-sicher (A123). Der SSE-Client braucht dieselbe Liste.
export { EVENT_KINDS } from '@vorschicht/shared/events';

import type { EVENT_KINDS } from '@vorschicht/shared/events';
export type EventKind = (typeof EVENT_KINDS)[number];

export interface NewEvent {
  kind: EventKind;
  /** 'system', 'max', or a role name such as 'reviewer'. */
  actor: string;
  projectId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  deployId?: string | null;
  payload?: Record<string, unknown>;
}

export interface EventRow {
  id: string;
  occurredAt: Date;
  kind: string;
  actor: string;
  projectId: string | null;
  taskId: string | null;
  runId: string | null;
  deployId: string | null;
  payload: Record<string, unknown>;
}

/** Notification body sent by the `event_log_notify` trigger (identifiers only). */
export interface EventNotification {
  id: string;
  kind: string;
  projectId: string | null;
  taskId: string | null;
  runId: string | null;
}

export class EventLog {
  constructor(private readonly sql: Queryable) {}

  async append(event: NewEvent): Promise<string> {
    const [row] = await this.sql<Array<{ id: string }>>`
      INSERT INTO event_log (kind, actor, project_id, task_id, run_id, deploy_id, payload)
      VALUES (${event.kind}, ${event.actor}, ${event.projectId ?? null},
              ${event.taskId ?? null}, ${event.runId ?? null}, ${event.deployId ?? null},
              ${this.sql.json((event.payload ?? {}) as postgres.JSONValue)})
      RETURNING id::text
    `;
    if (!row) throw new Error('Ereignis konnte nicht geschrieben werden');
    return row.id;
  }

  /**
   * Most recent events, newest first.
   *
   * Used for the SSE snapshot a client receives on connect, so that a freshly
   * opened dashboard shows history rather than an empty box waiting for
   * something to happen.
   */
  /**
   * Most recent events **of one kind**, newest first.
   *
   * `recent()` above is the right shape for the SSE snapshot, where "the last
   * hundred things that happened" is exactly the question. It is the wrong
   * shape for a job looking up its own memory, and A118 records what that cost:
   * a scan asking `recent(500)` for its own last run finds nothing at all once
   * five hundred *other* events have happened since — which in this system is
   * not an edge case but the observed norm (A101 counted 18 411 rows from a
   * single defect in one week, A102 another 5 525).
   *
   * The failure is silent and points the wrong way: no marker reads as "never
   * scanned", so the job re-reports what the operator has already been told.
   */
  async recentOfKind(kind: EventKind, limit = 50): Promise<EventRow[]> {
    return this.mapRows(
      await this.sql`
        SELECT id::text, occurred_at, kind, actor, project_id, task_id, run_id, deploy_id, payload
        FROM event_log WHERE kind = ${kind} ORDER BY id DESC LIMIT ${limit}
      `,
    );
  }

  async recent(limit = 100): Promise<EventRow[]> {
    return this.mapRows(
      await this.sql`
        SELECT id::text, occurred_at, kind, actor, project_id, task_id, run_id, deploy_id, payload
        FROM event_log ORDER BY id DESC LIMIT ${limit}
      `,
    );
  }

  /**
   * Events after a given id, oldest first.
   *
   * This is the reconnect path: an SSE client sends `Last-Event-ID`, and gets
   * exactly what it missed. §17 asks for "reconnect + snapshot re-sync", and
   * catching up by id rather than by timestamp is what makes it exact — two
   * events can share a millisecond, an id is unique and ordered.
   */
  async since(afterId: string, limit = 500): Promise<EventRow[]> {
    return this.mapRows(
      await this.sql`
        SELECT id::text, occurred_at, kind, actor, project_id, task_id, run_id, deploy_id, payload
        FROM event_log WHERE id > ${afterId}::bigint ORDER BY id ASC LIMIT ${limit}
      `,
    );
  }

  async byId(id: string): Promise<EventRow | null> {
    const rows = await this.sql`
      SELECT id::text, occurred_at, kind, actor, project_id, task_id, run_id, deploy_id, payload
      FROM event_log WHERE id = ${id}::bigint
    `;
    return this.mapRows(rows)[0] ?? null;
  }

  // biome-ignore lint/suspicious/noExplicitAny: postgres.js row shape is dynamic
  private mapRows(rows: any[]): EventRow[] {
    return rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      kind: row.kind,
      actor: row.actor,
      projectId: row.project_id,
      taskId: row.task_id,
      runId: row.run_id,
      deployId: row.deploy_id,
      payload: row.payload,
    }));
  }
}

export const EVENT_CHANNEL = 'vorschicht_events';

export function parseEventNotification(raw: string): EventNotification | null {
  try {
    const parsed = JSON.parse(raw) as Partial<EventNotification>;
    if (typeof parsed.id !== 'string' && typeof parsed.id !== 'number') return null;
    return {
      id: String(parsed.id),
      kind: String(parsed.kind ?? ''),
      projectId: parsed.projectId ?? null,
      taskId: parsed.taskId ?? null,
      runId: parsed.runId ?? null,
    };
  } catch {
    return null;
  }
}
