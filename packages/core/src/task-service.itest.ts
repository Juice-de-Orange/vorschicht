/**
 * Integration tests for the task service (§9).
 *
 * The database already refuses illegal moves; these tests are about the layer
 * above it — that a legal move is *complete*: lifecycle row, correlated
 * `event_log` entry, German reason in the timeline, and a version token that
 * makes a lost race detectable rather than silent.
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventLog } from './event-log.js';
import { TaskConflictError, TaskService, TaskTransitionError } from './task-service.js';

const url = process.env.TEST_DATABASE_URL;
const PROJECT = 'cccccccc-0000-4000-8000-000000000001';

describe.skipIf(!url)('TaskService', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let tasks: TaskService;

  beforeAll(async () => {
    database = await createTestDatabase('taskservice');
    sql = createSql({ url: database.url, max: 3 });
    tasks = new TaskService({ sql, eventLog: new EventLog(sql) });
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
  });

  /** Walk a fresh task up to `coding`, the state most cases start from. */
  async function coding(title = 'Testaufgabe') {
    const task = await tasks.create({ projectId: PROJECT, title, priority: 'P1' });
    await tasks.transition(task.id, 'planning');
    await tasks.transition(task.id, 'claimed');
    return tasks.transition(task.id, 'coding');
  }

  describe('Anlegen', () => {
    it('legt eine Aufgabe an und schreibt sie ins Ereignisprotokoll', async () => {
      const task = await tasks.create({
        projectId: PROJECT,
        title: 'Erste Aufgabe',
        priority: 'P0',
        department: 'development',
        type: 'feature',
      });

      expect(task.state).toBe('queued');
      expect(task.priority).toBe('P0');
      expect(task.version).toBe(0);
      expect(task.retryCount).toBe(0);

      const [event] = await sql<Array<{ task_id: string; payload: { title: string } }>>`
        SELECT task_id, payload FROM event_log WHERE kind = 'task.created' AND task_id = ${task.id}
      `;
      // §1 principle 4: goal → task → run → … has to be followable, and that
      // starts with the task being visible in the log the dashboard renders.
      expect(event?.payload.title).toBe('Erste Aufgabe');
    });

    it('kann als Entwurf entstehen, den die Produktleitung noch formt', async () => {
      const task = await tasks.create({
        projectId: PROJECT,
        title: 'Entwurf',
        initialState: 'draft',
      });
      expect(task.state).toBe('draft');
    });
  });

  describe('Übergänge', () => {
    it('führt eine Aufgabe durch die Kette und protokolliert jeden Schritt', async () => {
      const task = await coding('Kette');
      expect(task.state).toBe('coding');
      expect(task.version).toBe(3);

      const rows = await sql<Array<{ payload: { from: string; to: string } }>>`
        SELECT payload FROM event_log
        WHERE kind = 'task.state_changed' AND task_id = ${task.id} ORDER BY id ASC
      `;
      expect(rows.map((r) => `${r.payload.from}→${r.payload.to}`)).toEqual([
        'queued→planning',
        'planning→claimed',
        'claimed→coding',
      ]);
    });

    it('erklärt einen unmöglichen Übergang auf Deutsch, statt ihn zu versuchen', async () => {
      const task = await coding('Sprung');
      await expect(tasks.transition(task.id, 'done')).rejects.toBeInstanceOf(TaskTransitionError);
      await expect(tasks.transition(task.id, 'done')).rejects.toThrow(/nicht vorgesehen/);

      // Nothing was written: a refused transition leaves no trace of an attempt
      // in the lifecycle, only the state it never left.
      const after = await tasks.get(task.id);
      expect(after?.version).toBe(task.version);
    });

    it('weist einen veralteten Stand ab', async () => {
      const task = await coding('Version');
      await tasks.transition(task.id, 'review');
      await expect(
        tasks.transition(task.id, 'red', { expectedVersion: task.version }),
      ).rejects.toBeInstanceOf(TaskConflictError);
    });

    it('erkennt ein verlorenes Rennen zweier Schreiber', async () => {
      const task = await coding('Rennen');
      // Both callers hold the same view — version 3 — and both say so. One of
      // them must lose, and it must lose loudly: a scheduler that handed this
      // task to two coders would produce exactly the interference §10 exists
      // to prevent. Stating the expected version is what makes the loss
      // detectable rather than a matter of who read the row a millisecond
      // later; without it the second caller would simply see fresh state and
      // append a perfectly legal next step nobody asked for.
      const results = await Promise.allSettled([
        tasks.transition(task.id, 'review', { actor: 'coder', expectedVersion: task.version }),
        tasks.transition(task.id, 'red', { actor: 'coder', expectedVersion: task.version }),
      ]);
      const rejected = results.filter((r) => r.status === 'rejected');
      expect(rejected).toHaveLength(1);
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(TaskConflictError);
      expect((await tasks.get(task.id))?.version).toBe(task.version + 1);
    });
  });

  describe('Notizen, Priorität und Reservierungen', () => {
    it('hängt eine Notiz an, ohne den Zustand zu bewegen', async () => {
      const task = await coding('Notiz');
      const after = await tasks.note(task.id, { text: 'Nächster Schritt: Reducer testen' });
      expect(after.state).toBe('coding');
      expect(after.version).toBe(task.version + 1);
    });

    it('senkt die Priorität für den roten Pfad', async () => {
      const task = await coding('Priorität');
      await tasks.transition(task.id, 'red', { reason: 'Testlauf fehlgeschlagen' });
      await tasks.note(task.id, { text: 'Vermutung: Zeitüberschreitung im Testlauf' });
      await tasks.transition(task.id, 'queued');
      const after = await tasks.reprioritise(task.id, 'P2');
      expect(after.priority).toBe('P2');
      expect(after.retryCount).toBe(1);
    });

    it('merkt sich die Dateireservierungen des Planers', async () => {
      const task = await coding('Reservierung');
      await tasks.registerClaims(task.id, ['apps/server/src/**', 'packages/shared/src/auth*']);
      const [row] = await sql<Array<{ payload: { globs: string[] } }>>`
        SELECT payload FROM task_events
        WHERE task_id = ${task.id} AND kind = 'claims_registered'
      `;
      expect(row?.payload.globs).toHaveLength(2);
    });
  });

  describe('Parken und Fortsetzen', () => {
    it('kehrt genau dorthin zurück, wo es unterbrochen wurde', async () => {
      const task = await coding('Parken');
      await tasks.transition(task.id, 'parked', { reason: 'Budget' });
      const parked = await tasks.get(task.id);
      expect(parked?.resumeState).toBe('coding');

      const resumed = await tasks.resume(task.id);
      expect(resumed.state).toBe('coding');
      expect(resumed.resumeState).toBeNull();
      expect(resumed.parkCount).toBe(1);
    });

    it('lässt den Aufrufer den Rückkehrpunkt nicht selbst wählen', async () => {
      const task = await coding('Rückkehr');
      await tasks.transition(task.id, 'review');
      await tasks.transition(task.id, 'parked');
      // `resume` takes no target on purpose. Asking for `coding` here is only
      // possible by going around it — and the database refuses that too.
      await expect(tasks.transition(task.id, 'coding')).rejects.toThrow(/muss nach review/);
    });

    it('reiht geparkte Arbeit nach Priorität zur Fortsetzung', async () => {
      const low = await tasks.create({ projectId: PROJECT, title: 'Niedrig', priority: 'P3' });
      const high = await tasks.create({ projectId: PROJECT, title: 'Hoch', priority: 'P0' });
      for (const id of [low.id, high.id]) {
        await tasks.transition(id, 'planning');
        await tasks.transition(id, 'parked');
      }
      const resumable = (await tasks.listResumable()).filter((t) =>
        [low.id, high.id].includes(t.id),
      );
      expect(resumable[0]?.id).toBe(high.id);
    });
  });

  describe('Unterbrochene Arbeit (§7.2)', () => {
    it('bleibt stehen, bis die Integritätsprüfung bestanden ist', async () => {
      const task = await coding('Unterbrochen');
      await tasks.transition(task.id, 'interrupted', { reason: 'Notstopp' });

      await expect(tasks.resume(task.id)).rejects.toThrow(/Integritätsprüfung/);

      await tasks.recordIntegrityCheck(task.id, {
        ok: false,
        findings: ['halb angewandtes Patch'],
      });
      await expect(tasks.resume(task.id)).rejects.toThrow(/Integritätsprüfung/);

      await tasks.recordIntegrityCheck(task.id, { ok: true });
      const resumed = await tasks.resume(task.id);
      expect(resumed.state).toBe('coding');
      expect(resumed.interruptCount).toBe(1);
    });

    it('nimmt eine Prüfung nur für unterbrochene Aufgaben an', async () => {
      const task = await coding('Keine Prüfung');
      await expect(tasks.recordIntegrityCheck(task.id, { ok: true })).rejects.toThrow(
        /nur für unterbrochene/,
      );
    });
  });

  describe('Listen für den Planer', () => {
    it('nennt die aktiven Aufgaben, aber keine wartenden', async () => {
      const active = await coding('Aktiv');
      const waiting = await tasks.create({ projectId: PROJECT, title: 'Wartet' });
      const list = await tasks.listActive(PROJECT);
      const ids = list.map((t) => t.id);
      expect(ids).toContain(active.id);
      expect(ids).not.toContain(waiting.id);
    });
  });
});
