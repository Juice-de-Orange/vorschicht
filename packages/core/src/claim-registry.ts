/**
 * The claim registry (§10) — who may touch which files, and who has to wait.
 *
 * §10 splits the job into three sentences, and this module is each of them:
 *
 *   * "The Planner emits a claim set (path globs) per task; claims are
 *     registered before any coder starts." → `register()`
 *   * "Claim conflict check at scheduling time: overlapping claims → tasks are
 *     serialized (second waits)." → `acquire()`
 *   * "Claims survive parking and are released only on merge or task abort."
 *     → `release()`, plus the `parked` status the view derives.
 *
 * **Registration is not acquisition.** They are separate because §10 makes them
 * separate: the Planner writes a claim set while it is still planning, and the
 * scheduler decides later whether that set may be taken. In between, the claims
 * are `pending` — visible, checkable, and blocking nobody. Collapsing the two
 * would mean a task blocks the project from the moment someone wrote down what
 * it *intends* to touch.
 *
 * **Acquisition is serialised per project by a transaction-scoped advisory
 * lock**, and that is the only interesting piece of concurrency here. Two
 * schedulers that both read "no conflicts" and then both write `claimed` would
 * produce exactly the state §10 forbids, and no amount of optimistic locking on
 * the individual tasks would catch it — each write is perfectly valid on its
 * own, they are only wrong together. The check and the state change therefore
 * happen inside one transaction that holds the project's lock.
 *
 * What this module deliberately does *not* do: write an event when acquisition
 * fails. The scheduler asks on every tick, and a task waiting three days behind
 * an open decision (§15) would otherwise fill the event log with thousands of
 * identical "still blocked" rows. Blocked-ness is a live query — `blockers()` —
 * not history.
 */

import {
  claimAllowsPath,
  claimSetsOverlap,
  isTerminalTaskState,
  type Priority,
  TASK_STATE_LABELS,
  type TaskState,
  validateClaimGlobs,
} from '@vorschicht/shared';
import type postgres from 'postgres';
import { EventLog } from './event-log.js';
import type { ProjectService } from './project-service.js';
import type { Queryable } from './sql.js';
import { type TaskRecord, TaskService } from './task-service.js';

/**
 * §5's `active/parked/released`, plus the one state §5 does not name.
 *
 * `pending` is the gap between the Planner writing the set and the scheduler
 * granting it. See the module header for why that gap has to be visible.
 */
export type ClaimStatus = 'pending' | 'active' | 'parked' | 'released';

/** The two statuses that block somebody else. §10's "active" in the wider sense. */
export const HELD_CLAIM_STATUSES = ['active', 'parked'] as const;
export type HeldClaimStatus = (typeof HELD_CLAIM_STATUSES)[number];

export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  pending: 'Vorgemerkt',
  active: 'Belegt',
  parked: 'Belegt (Aufgabe pausiert)',
  released: 'Freigegeben',
};

/** One row of the `claims` view: the §5 entity "task ↔ path glob". */
export interface ClaimRow {
  taskId: string;
  projectId: string;
  glob: string;
  status: ClaimStatus;
  taskState: TaskState;
  taskPriority: Priority;
  recordedAt: Date;
}

/** A task that currently holds files, as the conflict check sees it. */
export interface ClaimHolder {
  taskId: string;
  title: string;
  state: TaskState;
  priority: Priority;
  status: HeldClaimStatus;
  globs: string[];
}

export interface ClaimConflict extends ClaimHolder {
  /** Which of our globs collide with which of theirs — for the report. */
  overlaps: Array<{ ours: string; theirs: string }>;
  /** German, for the timeline and the "blockiert durch …" line (§9, §15). */
  reason: string;
}

/** Eine Aufgabe, die nach §10 hinter fremden Claims wartet (§9, §15). */
export interface BlockedTask {
  taskId: string;
  title: string;
  state: TaskState;
  /** Wer im Weg steht — inklusive der deutschen Begründung für die Zeitleiste. */
  blockedBy: ClaimConflict;
}

export interface AcquireResult {
  acquired: boolean;
  /** Empty when the task registered none — such a task can never collide. */
  globs: string[];
  /** Non-empty exactly when `acquired` is false. */
  conflicts: ClaimConflict[];
  task: TaskRecord;
}

export class ClaimError extends Error {
  constructor(
    readonly taskId: string,
    message: string,
  ) {
    super(message);
    this.name = 'ClaimError';
  }
}

export interface ClaimRegistryDeps {
  /** The pool: `acquire()` opens its own transaction. */
  sql: postgres.Sql;
  tasks: TaskService;
  projects: ProjectService;
  eventLog: EventLog;
}

/**
 * Namespace of the per-project acquisition lock.
 *
 * Two-argument `pg_advisory_xact_lock(int4, int4)` keeps this in its own key
 * space, so it can never collide with the migration runner's lock or with the
 * test harness's — all three are unrelated and all three are advisory, which
 * means nothing but this constant keeps them apart.
 */
export const CLAIM_LOCK_NAMESPACE = 8_420_003;

/** States in which the Planner may still (re)write the claim set. */
const REGISTRABLE_STATES: readonly TaskState[] = ['draft', 'queued', 'planning'];

export class ClaimRegistry {
  constructor(private readonly deps: ClaimRegistryDeps) {}

  /**
   * Record the Planner's claim set (§10, §8.1 step 1).
   *
   * Refused once the set is held, and that refusal is the point: a task in
   * `coding` re-registering its claims would move the §6.6 containment boundary
   * underneath a session that is already writing, and would do so without
   * anyone checking the new globs against the rest of the project. The red path
   * re-plans through `planning`, which is legal, and re-acquisition follows
   * automatically because the view compares against the claim event's `seq`.
   */
  async register(
    taskId: string,
    globs: readonly string[],
    options: { actor?: string } = {},
  ): Promise<string[]> {
    const task = await this.requireTask(taskId);
    if (!REGISTRABLE_STATES.includes(task.state)) {
      throw new ClaimError(
        taskId,
        `Claims können nur vor dem Start festgelegt werden — Aufgabe ist bereits ` +
          `"${TASK_STATE_LABELS[task.state]}" (§10).`,
      );
    }
    const validated = validateClaimGlobs(globs);
    await this.deps.tasks.registerClaims(taskId, validated, options.actor ?? 'planner');
    return validated;
  }

  /**
   * Take the claim set, or report who is in the way (§10, scheduling time).
   *
   * Idempotent in the two ways that matter operationally: a task that already
   * holds its claims answers yes without writing anything (the restart case),
   * and a blocked task can be asked again on every scheduler tick at the cost
   * of one short transaction.
   */
  async acquire(taskId: string, options: { actor?: string } = {}): Promise<AcquireResult> {
    const actor = options.actor ?? 'scheduler';
    return this.deps.sql.begin(async (tx) => {
      const tasks = new TaskService({ sql: tx, eventLog: new EventLog(tx) });

      // Serialised per project: the conflict check and the state change that
      // acts on it have to be one act, or two schedulers both "win". Only the
      // project id is read before the lock — it is the one thing about a task
      // that cannot change (the 0006 guard refuses it), so it is safe to read
      // early. Everything the decision rests on is read afterwards, because
      // under READ COMMITTED a statement issued before the lock can still see
      // the state the loser of the race was about to overwrite.
      const projectId = await this.projectOf(taskId, tx);
      await tx`SELECT pg_advisory_xact_lock(${CLAIM_LOCK_NAMESPACE}, hashtext(${projectId}))`;

      const task = await this.requireTask(taskId, tasks);
      const own = await this.claimsOf(taskId, tx);
      const globs = own.map((claim) => claim.glob);

      if (own.some((claim) => claim.status === 'active' || claim.status === 'parked')) {
        return { acquired: true, globs, conflicts: [], task };
      }
      if (task.state !== 'planning') {
        throw new ClaimError(
          taskId,
          `Claims werden beim Übergang von "In Planung" nach "Dateien reserviert" ` +
            `belegt — Aufgabe ist "${TASK_STATE_LABELS[task.state]}" (§9).`,
        );
      }

      const conflicts = await this.conflictsAgainst(task, globs, tx);
      if (conflicts.length > 0) {
        return { acquired: false, globs, conflicts, task };
      }

      const claimed = await tasks.transition(taskId, 'claimed', {
        actor,
        reason:
          globs.length > 0
            ? `${globs.length} Pfadmuster belegt (§10)`
            : 'Keine Dateien beansprucht — Aufgabe verändert nichts im Repository',
        payload: { globs },
      });
      await new EventLog(tx).append({
        kind: 'claims.acquired',
        actor,
        projectId: task.projectId,
        taskId,
        payload: { globs },
      });
      return { acquired: true, globs, conflicts: [], task: claimed };
    });
  }

  /**
   * Give the claim set back (§10: on merge or task abort).
   *
   * Releasing a set that was never held is not an error — the abort path calls
   * this for every task it stops, and a task that failed during planning has
   * nothing to give back. Saying so quietly beats making every caller check.
   */
  async release(
    taskId: string,
    reason: string,
    options: { actor?: string } = {},
  ): Promise<string[]> {
    const task = await this.requireTask(taskId);
    const own = await this.claimsOf(taskId);
    if (own.length === 0 || own.every((claim) => claim.status === 'released')) return [];

    const globs = own.map((claim) => claim.glob);
    await this.deps.tasks.releaseClaims(taskId, {
      globs,
      reason,
      actor: options.actor ?? 'orchestrator',
    });
    await this.deps.eventLog.append({
      kind: 'claims.released',
      actor: options.actor ?? 'orchestrator',
      projectId: task.projectId,
      taskId,
      payload: { globs, reason },
    });
    return globs;
  }

  /** Every claim of one task, whatever its status. */
  async claimsOf(taskId: string, sql: Queryable = this.deps.sql): Promise<ClaimRow[]> {
    return this.map(await sql`SELECT * FROM claims WHERE task_id = ${taskId} ORDER BY glob`);
  }

  /** The claims of one project, optionally filtered by status. */
  async claimsOfProject(
    projectId: string,
    options: { statuses?: readonly ClaimStatus[] } = {},
  ): Promise<ClaimRow[]> {
    const statuses = options.statuses ?? (['pending', 'active', 'parked'] as const);
    return this.map(
      await this.deps.sql`
        SELECT * FROM claims
        WHERE project_id = ${projectId} AND status = ANY(${[...statuses] as string[]})
        ORDER BY task_id, glob
      `,
    );
  }

  /** Tasks currently holding files in this project (`active` or `parked`). */
  async holders(projectId: string, options: { exclude?: string } = {}): Promise<ClaimHolder[]> {
    return this.holdersVia(projectId, options.exclude, this.deps.sql);
  }

  /**
   * Who is standing in this task's way — without trying to acquire.
   *
   * This is what the dashboard renders as "blockiert durch …" (§9) and what the
   * overview's decision-wait counter is built from (§15). No lock is taken: the
   * answer is a snapshot for a human, not the basis of a write.
   */
  async blockers(taskId: string): Promise<ClaimConflict[]> {
    const task = await this.requireTask(taskId);
    const own = await this.claimsOf(taskId);
    if (own.some((claim) => claim.status === 'active' || claim.status === 'parked')) return [];
    return this.conflictsAgainst(
      task,
      own.map((claim) => claim.glob),
      this.deps.sql,
    );
  }

  /**
   * Welche Aufgaben stehen hinter fremden Claims — projektweit, in einem Zug.
   *
   * §9 und §15 verlangen, dass eine Aufgabe, die **hinter** den Claims einer
   * geparkten Aufgabe wartet, auf der Übersicht als „blockiert durch
   * Entscheidung #X" erscheint. Bis die Betriebsprüfung 767db82c das am
   * 3.8.2026 aufdeckte, gab es dafür keinen Leser: `blockers()` beantwortet die
   * Frage für **eine** Aufgabe und wird nur vom Ablaufplaner gerufen, und die
   * Übersicht baute ihre Liste aus den offenen Eskalationen — also aus den
   * Aufgaben, die *gefragt haben*, nicht aus denen, die warten. Eine nach §10
   * serialisierte Aufgabe erschien damit überhaupt nicht, und das ist genau die
   * Sichtbarkeit, die §15 anstelle einer Frist für Entscheidungen wählt.
   *
   * Warum eine eigene Methode und nicht `blockers()` in einer Schleife: das
   * wären zwei Abfragen je nicht-terminaler Aufgabe auf jedem Aufruf der
   * Startseite. Hier sind es zwei für das ganze Projekt, und die Überlappung
   * wird in TypeScript entschieden — `claimSetsOverlap` ist Glob gegen Glob und
   * hat in SQL kein Gegenstück (A45.4).
   *
   * **Wer keine eigenen Claims registriert hat, kann auch nicht blockiert
   * sein.** Das ist keine Bequemlichkeit, sondern §10s Reihenfolge: der Planer
   * meldet das Claim-Set an, *bevor* ein Coder startet, und erst die Erwerbung
   * macht daraus einen Halter (A45.1/.2). Eine Aufgabe ohne angemeldete Claims
   * steht noch vor dieser Stelle und wartet nicht auf fremde Dateien.
   */
  async blockedTasks(projectId: string): Promise<BlockedTask[]> {
    const holders = await this.holdersVia(projectId, undefined, this.deps.sql);
    if (holders.length === 0) return [];

    const wartende = await this.claimsOfProject(projectId, { statuses: ['pending'] });
    const proAufgabe = new Map<string, { globs: string[]; state: TaskState }>();
    for (const claim of wartende) {
      if (isTerminalTaskState(claim.taskState)) continue;
      const eintrag = proAufgabe.get(claim.taskId);
      if (eintrag) eintrag.globs.push(claim.glob);
      else proAufgabe.set(claim.taskId, { globs: [claim.glob], state: claim.taskState });
    }
    if (proAufgabe.size === 0) return [];

    const titel = await this.titlesOf([...proAufgabe.keys()]);
    const blockiert: BlockedTask[] = [];
    for (const [taskId, eintrag] of proAufgabe) {
      for (const holder of holders) {
        if (holder.taskId === taskId) continue;
        const overlaps = claimSetsOverlap(eintrag.globs, holder.globs);
        if (overlaps.length === 0) continue;
        blockiert.push({
          taskId,
          title: titel.get(taskId) ?? '(ohne Titel)',
          state: eintrag.state,
          blockedBy: { ...holder, overlaps, reason: blockedReason(holder) },
        });
        // Eine Zeile je wartender Aufgabe: sie steht hinter dem *ersten*
        // Halter, und mehr als einen zu nennen macht die Übersicht länger,
        // ohne sie richtiger zu machen — gelöst ist die Blockade erst, wenn
        // alle weg sind, und dann verschwindet die Zeile ohnehin.
        break;
      }
    }
    return blockiert;
  }

  private async titlesOf(ids: readonly string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.deps.sql<Array<{ id: string; title: string | null }>>`
      SELECT id, title FROM tasks WHERE id = ANY(${[...ids] as string[]})
    `;
    return new Map(rows.map((row) => [row.id, row.title ?? '(ohne Titel)']));
  }

  /** The globs a task may write inside right now — §6.6's second condition. */
  async heldGlobs(taskId: string): Promise<string[]> {
    const own = await this.claimsOf(taskId);
    return own
      .filter((claim) => claim.status === 'active' || claim.status === 'parked')
      .map((claim) => claim.glob);
  }

  /**
   * May this task write this repository-relative path?
   *
   * Fail-closed by construction: a task that holds no claims gets `false` for
   * every path, so a Planner that forgot the claim set produces a coder that
   * can read and cannot write, rather than one that can do anything.
   */
  async allowsPath(taskId: string, relativePath: string): Promise<boolean> {
    return claimAllowsPath(await this.heldGlobs(taskId), relativePath);
  }

  /**
   * §10's invariant, checked rather than assumed.
   *
   * "Two active tasks never hold overlapping claims in the same project" is the
   * property the advisory lock is supposed to guarantee. This asks the database
   * whether it actually holds — cheap enough for the daily GC pass to run it,
   * and the one thing that would catch a future scheduler that writes `claimed`
   * without coming through `acquire()`.
   */
  async audit(projectId: string): Promise<
    Array<{
      left: ClaimHolder;
      right: ClaimHolder;
      overlaps: Array<{ ours: string; theirs: string }>;
    }>
  > {
    const holders = await this.holders(projectId);
    const violations: Array<{
      left: ClaimHolder;
      right: ClaimHolder;
      overlaps: Array<{ ours: string; theirs: string }>;
    }> = [];
    for (let i = 0; i < holders.length; i += 1) {
      for (let j = i + 1; j < holders.length; j += 1) {
        const left = holders[i] as ClaimHolder;
        const right = holders[j] as ClaimHolder;
        const overlaps = claimSetsOverlap(left.globs, right.globs);
        if (overlaps.length > 0) violations.push({ left, right, overlaps });
      }
    }
    return violations;
  }

  // --- internals -------------------------------------------------------------

  private async conflictsAgainst(
    task: TaskRecord,
    globs: readonly string[],
    sql: Queryable,
  ): Promise<ClaimConflict[]> {
    if (globs.length === 0) return [];
    const holders = await this.holdersVia(task.projectId, task.id, sql);
    const conflicts: ClaimConflict[] = [];
    for (const holder of holders) {
      const overlaps = claimSetsOverlap(globs, holder.globs);
      if (overlaps.length === 0) continue;
      conflicts.push({ ...holder, overlaps, reason: blockedReason(holder) });
    }
    return conflicts;
  }

  private async holdersVia(
    projectId: string,
    exclude: string | undefined,
    sql: Queryable,
  ): Promise<ClaimHolder[]> {
    const rows = await sql<
      Array<{
        task_id: string;
        title: string | null;
        state: string;
        priority: string;
        status: string;
        globs: string[];
      }>
    >`
      SELECT c.task_id, t.title, c.task_state AS state, c.task_priority AS priority,
             c.status, array_agg(c.glob ORDER BY c.glob) AS globs
      FROM claims c
      JOIN tasks t ON t.id = c.task_id
      WHERE c.project_id = ${projectId}
        AND c.status IN ('active', 'parked')
        ${exclude ? sql`AND c.task_id <> ${exclude}` : sql``}
      GROUP BY c.task_id, t.title, c.task_state, c.task_priority, c.status
    `;
    return rows.map((row) => ({
      taskId: row.task_id,
      title: row.title ?? '(ohne Titel)',
      state: row.state as TaskState,
      priority: row.priority as Priority,
      status: row.status as HeldClaimStatus,
      globs: row.globs,
    }));
  }

  /** The one attribute of a task that can never change (the 0006 guard). */
  private async projectOf(taskId: string, sql: Queryable): Promise<string> {
    const [row] = await sql<Array<{ project_id: string }>>`
      SELECT project_id FROM tasks WHERE id = ${taskId}
    `;
    if (!row) throw new ClaimError(taskId, `Aufgabe ${taskId} existiert nicht`);
    return row.project_id;
  }

  private async requireTask(taskId: string, tasks = this.deps.tasks): Promise<TaskRecord> {
    const task = await tasks.get(taskId);
    if (!task) throw new ClaimError(taskId, `Aufgabe ${taskId} existiert nicht`);
    if (isTerminalTaskState(task.state)) {
      throw new ClaimError(
        taskId,
        `Aufgabe ist "${TASK_STATE_LABELS[task.state]}" — Claims sind damit freigegeben (§10).`,
      );
    }
    return task;
  }

  // biome-ignore lint/suspicious/noExplicitAny: postgres.js row shape is dynamic
  private map(rows: any[]): ClaimRow[] {
    return rows.map((row) => ({
      taskId: row.task_id,
      projectId: row.project_id,
      glob: row.glob,
      status: row.status as ClaimStatus,
      taskState: row.task_state as TaskState,
      taskPriority: row.task_priority as Priority,
      recordedAt: row.recorded_at,
    }));
  }
}

/**
 * Why the waiting task is waiting, in German (§2).
 *
 * §15 asks for "blockiert durch Entscheidung #X" when the blocker is parked on
 * an open decision — the escalation number arrives in Phase 4, so the sentence
 * names the task now and gains the deep link then. The distinction is worth
 * making already: "waiting for a coder" and "waiting because the operator has not
 * answered" look identical in the queue and mean entirely different things to
 * the person reading the dashboard.
 */
export function blockedReason(holder: ClaimHolder): string {
  const suffix =
    holder.state === 'needs_decision'
      ? ' — dort wartet eine Entscheidung'
      : holder.state === 'parked'
        ? ' — diese Aufgabe ist pausiert'
        : holder.state === 'interrupted'
          ? ' — diese Aufgabe wurde unterbrochen und wird geprüft'
          : '';
  return `Blockiert durch Aufgabe "${holder.title}" (${TASK_STATE_LABELS[holder.state]})${suffix}`;
}
