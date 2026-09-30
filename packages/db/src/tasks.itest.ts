/**
 * Integration tests for the task lifecycle (migration 0006).
 *
 * These ask the question application tests structurally cannot: does the
 * *database* refuse an illegal move? §9 says "no silent transitions", and the
 * only way to mean that in a system where several workers write concurrently is
 * to put the rule where none of them can go around it.
 *
 * The first test in this file is the one that keeps the design honest: the §9
 * map exists twice, in SQL and in TypeScript, and this asserts they are the
 * same map.
 */
import { TASK_EVENT_KINDS, TASK_STATES, TASK_TRANSITIONS } from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql } from './client.js';
import { createTestDatabase, type TestDatabase } from './test-database.js';

const url = process.env.TEST_DATABASE_URL;

/** A fresh task id per case, so the append-only log never collides. */
let counter = 0;
function nextTaskId(): string {
  counter += 1;
  return `aaaaaaaa-0000-4000-8000-${String(counter).padStart(12, '0')}`;
}

const PROJECT = 'bbbbbbbb-0000-4000-8000-000000000001';

describe.skipIf(!url)('Aufgaben-Lebenszyklus (0006)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('tasks');
    // Three: the race test below needs two connections held open at once.
    sql = createSql({ url: database.url, max: 3 });
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
  });

  /** Append one event, letting the guard have its say. */
  async function append(
    taskId: string,
    seq: number,
    kind: string,
    state: string,
    extra: {
      priority?: string;
      resumeState?: string | null;
      payload?: Record<string, unknown>;
    } = {},
  ) {
    return sql`
      INSERT INTO task_events (task_id, seq, kind, project_id, state, priority, resume_state, actor, payload)
      VALUES (${taskId}, ${seq}, ${kind}, ${PROJECT}, ${state}, ${extra.priority ?? 'P2'},
              ${extra.resumeState ?? null}, 'system',
              ${sql.json((extra.payload ?? {}) as postgres.JSONValue)})
    `;
  }

  /** A task sitting in `coding` — the usual starting point below. */
  async function taskInCoding(): Promise<string> {
    const id = nextTaskId();
    await append(id, 0, 'created', 'queued', { payload: { title: 'Testaufgabe' } });
    await append(id, 1, 'state_changed', 'planning');
    await append(id, 2, 'state_changed', 'claimed');
    await append(id, 3, 'state_changed', 'coding');
    return id;
  }

  it('hält die SQL-Übergangstabelle deckungsgleich mit der TypeScript-Karte', async () => {
    const rows = await sql<Array<{ state_from: string; state_to: string }>>`
      SELECT state_from, state_to FROM task_transitions
    `;
    const fromSql = rows.map((r) => `${r.state_from}→${r.state_to}`).sort();
    const fromTs = Object.entries(TASK_TRANSITIONS)
      .flatMap(([from, targets]) => targets.map((to) => `${from}→${to}`))
      .sort();
    // Drift here means the database and the application disagree about what a
    // task may do — the application would allow a move Postgres then refuses,
    // at runtime, in production, on a Sunday.
    expect(fromSql).toEqual(fromTs);
  });

  it('kennt in der Prüfbedingung genau die Zustände aus shared', async () => {
    const [row] = await sql<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'task_events_state'
    `;
    for (const state of TASK_STATES) {
      expect(row?.def, `Zustand ${state} fehlt in task_events_state`).toContain(`'${state}'`);
    }
  });

  it('kennt in der Prüfbedingung genau die Ereignisarten aus shared', async () => {
    // The same bargain the transition map makes, in both directions this time.
    // A kind that only TypeScript knows is refused by the database at runtime;
    // a kind only the constraint knows is a row nothing will ever project.
    const [row] = await sql<Array<{ def: string }>>`
      SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname = 'task_events_kind'
    `;
    const inSql = [...String(row?.def ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
    expect(inSql).toEqual([...TASK_EVENT_KINDS].sort());
  });

  describe('Entstehung', () => {
    it('nimmt eine Aufgabe an und projiziert sie in die Sicht', async () => {
      const id = nextTaskId();
      await append(id, 0, 'created', 'queued', {
        priority: 'P1',
        payload: { title: 'Erste Aufgabe', department: 'development', type: 'feature' },
      });

      const [task] = await sql<
        Array<{
          state: string;
          priority: string;
          title: string;
          version: number;
          retry_count: string;
        }>
      >`SELECT * FROM tasks WHERE id = ${id}`;

      expect(task?.state).toBe('queued');
      expect(task?.priority).toBe('P1');
      expect(task?.title).toBe('Erste Aufgabe');
      expect(task?.version).toBe(0);
      expect(Number(task?.retry_count)).toBe(0);
    });

    it('weist ein erstes Ereignis ab, das kein "created" ist', async () => {
      const id = nextTaskId();
      await expect(append(id, 0, 'note', 'queued')).rejects.toThrow(/beginnt mit/);
    });

    it('lässt eine Aufgabe nicht mitten im Ablauf entstehen', async () => {
      const id = nextTaskId();
      await expect(append(id, 0, 'created', 'coding')).rejects.toThrow(/kann nicht im Zustand/);
    });

    it('weist ein zweites "created" ab', async () => {
      const id = await taskInCoding();
      await expect(append(id, 4, 'created', 'coding')).rejects.toThrow(/existiert bereits/);
    });
  });

  describe('Lückenlose Reihenfolge als Nebenläufigkeitsschutz', () => {
    it('weist einen veralteten Stand ab', async () => {
      const id = await taskInCoding();
      // A worker that read version 3 after someone else already wrote 4. The
      // BEFORE INSERT guard sees the gap first — ahead of the unique index —
      // and says so in a sentence, which is the more useful of the two.
      await append(id, 4, 'state_changed', 'review');
      await expect(append(id, 4, 'state_changed', 'red')).rejects.toThrow(
        /ist bei seq 4, das Ereignis trägt 4/,
      );
    });

    it('lässt bei einem echten Rennen genau einen Schreiber durch', async () => {
      // The case the guard alone cannot catch: two transactions in flight at
      // once. Both read seq 3 — neither sees the other's uncommitted row — so
      // both pass the trigger, and the unique index is what decides. Without
      // it, one scheduler could hand this task to two coders and both would
      // look correct.
      const id = await taskInCoding();
      const insert = (tx: postgres.TransactionSql, state: string) => tx`
        INSERT INTO task_events (task_id, seq, kind, project_id, state, priority, actor)
        VALUES (${id}, 4, 'state_changed', ${PROJECT}, ${state}, 'P2', 'coder')
      `;
      const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      const results = await Promise.allSettled([
        sql.begin(async (tx) => {
          await insert(tx, 'review');
          await wait(150);
        }),
        sql.begin(async (tx) => {
          // Starts second and blocks on the unique key until the first commits.
          await wait(30);
          await insert(tx, 'red');
        }),
      ]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const [rejected] = results.filter((r) => r.status === 'rejected');
      expect((rejected as PromiseRejectedResult).reason.message).toMatch(/duplicate key|unique/i);

      const [task] = await sql<Array<{ state: string }>>`SELECT * FROM tasks WHERE id = ${id}`;
      expect(task?.state).toBe('review');
    });

    it('weist eine Lücke ab', async () => {
      const id = await taskInCoding();
      await expect(append(id, 9, 'state_changed', 'review')).rejects.toThrow(
        /veralteter Stand oder Lücke/,
      );
    });

    it('lässt das Projekt nicht wechseln', async () => {
      const id = await taskInCoding();
      await expect(sql`
        INSERT INTO task_events (task_id, seq, kind, project_id, state, priority, actor)
        VALUES (${id}, 4, 'note', ${'bbbbbbbb-0000-4000-8000-000000000099'}, 'coding', 'P2', 'system')
      `).rejects.toThrow(/Projekt nicht wechseln/);
    });
  });

  describe('Die Zustandsmaschine, in der Datenbank', () => {
    it('weist einen Sprung über die Kette hinweg ab', async () => {
      const id = await taskInCoding();
      await expect(append(id, 4, 'state_changed', 'done')).rejects.toThrow(/nicht vorgesehen/);
    });

    it('verlangt für einen Zustandswechsel das passende Ereignis', async () => {
      const id = await taskInCoding();
      await expect(append(id, 4, 'note', 'review')).rejects.toThrow(/state_changed/);
    });

    it('weist ein "state_changed" ohne Wechsel ab', async () => {
      const id = await taskInCoding();
      await expect(append(id, 4, 'state_changed', 'coding')).rejects.toThrow(
        /ohne Zustandswechsel/,
      );
    });

    it('lässt die Priorität nur über "reprioritised" wandern', async () => {
      const id = await taskInCoding();
      await expect(append(id, 4, 'note', 'coding', { priority: 'P3' })).rejects.toThrow(
        /reprioritised/,
      );
      await append(id, 4, 'reprioritised', 'coding', { priority: 'P3' });
      const [task] = await sql<Array<{ priority: string }>>`SELECT * FROM tasks WHERE id = ${id}`;
      expect(task?.priority).toBe('P3');
    });
  });

  describe('Parken und Fortsetzen (§7.3)', () => {
    it('parkt mit Rückkehrpunkt und setzt genau dort fort', async () => {
      const id = await taskInCoding();
      await append(id, 4, 'state_changed', 'parked', {
        resumeState: 'coding',
        payload: { reason: 'guardian_wrap_up' },
      });
      await append(id, 5, 'note', 'parked', {
        resumeState: 'coding',
        payload: { handover: 'Als Nächstes: Tests für den Reducer' },
      });
      await append(id, 6, 'state_changed', 'coding');

      const [task] = await sql<
        Array<{ state: string; resume_state: string | null; park_count: string }>
      >`SELECT * FROM tasks WHERE id = ${id}`;
      expect(task?.state).toBe('coding');
      expect(task?.resume_state).toBeNull();
      expect(Number(task?.park_count)).toBe(1);
    });

    it('verweigert ein Parken ohne Rückkehrpunkt', async () => {
      const id = await taskInCoding();
      await expect(append(id, 4, 'state_changed', 'parked')).rejects.toThrow(
        /task_events_resume_state/,
      );
    });

    it('verweigert eine Fortsetzung an der falschen Stelle', async () => {
      const id = await taskInCoding();
      await append(id, 4, 'state_changed', 'parked', { resumeState: 'coding' });
      // `review` is a legal edge out of `parked` in general — just not for a
      // task that was parked while coding.
      await expect(append(id, 5, 'state_changed', 'review')).rejects.toThrow(
        /muss nach coding zurückkehren/,
      );
    });

    it('lässt den Rückkehrpunkt nicht durch eine Notiz verschieben', async () => {
      const id = await taskInCoding();
      await append(id, 4, 'state_changed', 'parked', { resumeState: 'coding' });
      await expect(append(id, 5, 'note', 'parked', { resumeState: 'review' })).rejects.toThrow(
        /Rückkehrpunkt ändert sich/,
      );
    });

    it('lässt eine geparkte Aufgabe jederzeit abbrechen', async () => {
      const id = await taskInCoding();
      await append(id, 4, 'state_changed', 'parked', { resumeState: 'coding' });
      await append(id, 5, 'state_changed', 'aborted');
      const [task] = await sql<Array<{ state: string }>>`SELECT * FROM tasks WHERE id = ${id}`;
      expect(task?.state).toBe('aborted');
    });
  });

  describe('Unterbrochene Arbeit (§7.2)', () => {
    it('verweigert die Fortsetzung ohne Integritätsprüfung', async () => {
      const id = await taskInCoding();
      await append(id, 4, 'state_changed', 'interrupted', { resumeState: 'coding' });
      await expect(append(id, 5, 'state_changed', 'coding')).rejects.toThrow(/Integritätsprüfung/);
    });

    it('verweigert sie auch bei einer fehlgeschlagenen Prüfung', async () => {
      const id = await taskInCoding();
      await append(id, 4, 'state_changed', 'interrupted', { resumeState: 'coding' });
      await append(id, 5, 'integrity_check', 'interrupted', {
        resumeState: 'coding',
        payload: { ok: false, findings: ['halb angewandtes Patch'] },
      });
      await expect(append(id, 6, 'state_changed', 'coding')).rejects.toThrow(/Integritätsprüfung/);
    });

    it('lässt sie nach bestandener Prüfung weiterlaufen', async () => {
      const id = await taskInCoding();
      await append(id, 4, 'state_changed', 'interrupted', { resumeState: 'coding' });
      await append(id, 5, 'integrity_check', 'interrupted', {
        resumeState: 'coding',
        payload: { ok: true },
      });
      await append(id, 6, 'state_changed', 'coding');
      const [task] = await sql<
        Array<{ state: string; interrupt_count: string }>
      >`SELECT * FROM tasks WHERE id = ${id}`;
      expect(task?.state).toBe('coding');
      expect(Number(task?.interrupt_count)).toBe(1);
    });

    it('lässt eine kaputte Arbeitskopie auch ohne bestandene Prüfung rot werden', async () => {
      const id = await taskInCoding();
      await append(id, 4, 'state_changed', 'interrupted', { resumeState: 'coding' });
      await append(id, 5, 'state_changed', 'red');
      const [task] = await sql<Array<{ state: string }>>`SELECT * FROM tasks WHERE id = ${id}`;
      expect(task?.state).toBe('red');
    });

    it('verlangt die Prüfung nach jedem Abbruch neu', async () => {
      // An old passing check must not authorise a later resume: the second
      // interrupt cut a different edit off in a different place.
      const id = await taskInCoding();
      await append(id, 4, 'state_changed', 'interrupted', { resumeState: 'coding' });
      await append(id, 5, 'integrity_check', 'interrupted', {
        resumeState: 'coding',
        payload: { ok: true },
      });
      await append(id, 6, 'state_changed', 'coding');
      await append(id, 7, 'state_changed', 'interrupted', { resumeState: 'coding' });
      await expect(append(id, 8, 'state_changed', 'coding')).rejects.toThrow(/Integritätsprüfung/);
    });
  });

  describe('Roter Pfad (§9)', () => {
    it('zählt die Fehlschläge mit', async () => {
      const id = await taskInCoding();
      await append(id, 4, 'state_changed', 'red');
      await append(id, 5, 'note', 'red', { payload: { learnings: 'Timeout im Testlauf' } });
      await append(id, 6, 'state_changed', 'queued');
      await append(id, 7, 'reprioritised', 'queued', { priority: 'P3' });
      // Every later event has to carry the new priority forward — the guard
      // refuses a silent revert just as firmly as a silent change.
      await append(id, 8, 'state_changed', 'planning', { priority: 'P3' });
      await append(id, 9, 'state_changed', 'red', { priority: 'P3' });
      await append(id, 10, 'state_changed', 'escalated', { priority: 'P3' });

      const [task] = await sql<
        Array<{ state: string; retry_count: string; priority: string }>
      >`SELECT * FROM tasks WHERE id = ${id}`;
      expect(task?.state).toBe('escalated');
      expect(Number(task?.retry_count)).toBe(2);
      expect(task?.priority).toBe('P3');
    });
  });

  describe('Append-only', () => {
    it('verweigert UPDATE, DELETE und TRUNCATE auch dem Eigentümer', async () => {
      await taskInCoding();
      await expect(sql`UPDATE task_events SET actor = 'max'`).rejects.toThrow(/append-only/i);
      await expect(sql`DELETE FROM task_events`).rejects.toThrow(/append-only/i);
      await expect(sql`TRUNCATE task_events`).rejects.toThrow(/append-only/i);
    });

    it('verweigert dem Laufzeitkonto die Rechte dazu', async () => {
      const rows = await sql<Array<{ privilege_type: string }>>`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'vorschicht_app' AND table_name = 'task_events'
      `;
      const granted = rows.map((r) => r.privilege_type);
      expect(granted).toContain('SELECT');
      expect(granted).toContain('INSERT');
      expect(granted).not.toContain('UPDATE');
      expect(granted).not.toContain('DELETE');
    });
  });
});
