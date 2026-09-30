/**
 * `TraceReader` against a real Postgres.
 *
 * Everything worth testing here *is* the database. The reader's whole job is to
 * project six append-only records into one readable shape, and a stubbed store
 * would let each assertion be about the stub — including the two that matter
 * most: that a run's caps and its transcript problem, which the `agent_runs`
 * view does not carry, really do come back off the events; and that the diff
 * basis is resolved as a *consistent pair* rather than as two newest rows,
 * which is only a distinction at all once a task has merged twice.
 *
 * Fixtures are written the way the production writers write them — `TaskService`
 * for the lifecycle, raw SQL for `agent_run_events` and `gate_runs`, because
 * those two are exactly what the view and the `findings` projection are being
 * read through and a fixture that used a higher-level writer could seat a defect
 * in it and pass in the same run (A55's lesson, `dokumente.spec.ts`'s rule).
 */

import { randomUUID } from 'node:crypto';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventLog } from '../event-log.js';
import { ProjectService } from '../project-service.js';
import { TaskService } from '../task-service.js';
import { TraceReader } from './reader.js';

const url = process.env.TEST_DATABASE_URL;
const wenn = url ? describe : describe.skip;

let db: TestDatabase;
let sql: postgres.Sql;
let tasks: TaskService;
let projects: ProjectService;
let leser: TraceReader;
let projektId: string;

const FILTER = {
  projectId: null,
  state: null,
  priority: null,
  from: null,
  to: null,
  limit: 50,
} as const;

/** One run, written as `AgentRunner` writes it: `created` first, then the rest. */
async function lauf(over: {
  taskId?: string | null;
  role?: string;
  caps?: Record<string, number>;
  transcriptPath?: string | null;
  transcriptProblem?: string | null;
  terminate?: boolean;
}): Promise<string> {
  const runId = randomUUID();
  await sql`
    INSERT INTO agent_run_events (run_id, seq, kind, payload) VALUES (
      ${runId}, 0, 'created',
      ${sql.json({
        taskId: over.taskId ?? null,
        role: over.role ?? 'coder',
        model: 'sonnet-class',
        backend: 'fake',
        cwd: '/data/worktrees/x',
        caps: over.caps ?? { maxTurns: 40, maxBudgetUsd: 16, wallClockMs: 5_400_000 },
      } as postgres.JSONValue)}
    )`;
  await sql`
    INSERT INTO agent_run_events (run_id, seq, kind, payload) VALUES (
      ${runId}, 1, 'started', ${sql.json({ sessionId: `sess-${runId.slice(0, 8)}` })})`;
  if (over.terminate !== false) {
    await sql`
      INSERT INTO agent_run_events (run_id, seq, kind, payload) VALUES (
        ${runId}, 2, 'terminated',
        ${sql.json({
          reason: 'completed',
          exitCode: 0,
          transcriptPath: over.transcriptPath ?? null,
          transcriptProblem: over.transcriptProblem ?? null,
        } as postgres.JSONValue)}
      )`;
  }
  return runId;
}

async function aufgabe(titel: string, over: Partial<{ priority: string }> = {}): Promise<string> {
  const record = await tasks.create({
    projectId: projektId,
    title: titel,
    description: 'Beschreibung',
    acceptanceCriteria: ['erstes Kriterium'],
    priority: (over.priority ?? 'P2') as 'P2',
  });
  return record.id;
}

wenn('TraceReader', () => {
  beforeAll(async () => {
    db = await createTestDatabase('spuren-reader');
    sql = createSql({ url: db.url, max: 4 });
    const eventLog = new EventLog(sql);
    tasks = new TaskService({ sql, eventLog });
    projects = new ProjectService(sql);
    leser = new TraceReader(sql);
    const projekt = await projects.create({
      slug: 'spuren-projekt',
      name: 'Spuren-Projekt',
      rootPath: '/opt/spuren',
      defaultBranch: 'main',
    });
    projektId = projekt.id;
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await db?.drop();
  });

  describe('list', () => {
    it('filtert nach Zustand und Priorität und sagt, wenn die Grenze gebissen hat', async () => {
      const eins = await aufgabe('Filterfall eins', { priority: 'P0' });
      await aufgabe('Filterfall zwei', { priority: 'P3' });
      await tasks.transition(eins, 'planning', { actor: 'orchestrator' });

      const nurPlanning = await leser.list({ ...FILTER, state: 'planning' });
      expect(nurPlanning.aufgaben.map((a) => a.id)).toContain(eins);
      expect(nurPlanning.aufgaben.every((a) => a.state === 'planning')).toBe(true);

      const nurP3 = await leser.list({ ...FILTER, priority: 'P3' });
      expect(nurP3.aufgaben.every((a) => a.priority === 'P3')).toBe(true);
      expect(nurP3.aufgaben.map((a) => a.title)).toContain('Filterfall zwei');

      // A list silently cut at its limit reads as a complete answer, which is
      // the one thing a filter surface must not do — so the bit travels.
      const gekuerzt = await leser.list({ ...FILTER, limit: 1 });
      expect(gekuerzt.aufgaben).toHaveLength(1);
      expect(gekuerzt.truncated).toBe(true);

      const ganz = await leser.list({ ...FILTER, limit: 50 });
      expect(ganz.truncated).toBe(false);
    });

    it('schließt den Bis-Tag ein, statt alles nach Mitternacht zu verlieren', async () => {
      const id = await aufgabe('Zeitraumfall');
      const [row] = await sql<Array<{ tag: string }>>`
        SELECT to_char(updated_at, 'YYYY-MM-DD') AS tag FROM tasks WHERE id = ${id}::uuid`;
      const heute = row?.tag as string;

      // `updated_at <= to` would exclude everything that happened on that date
      // after midnight, which is all of it.
      const treffer = await leser.list({ ...FILTER, from: heute, to: heute });
      expect(treffer.aufgaben.map((a) => a.id)).toContain(id);
    });

    it('nennt die Projekte, die die Liste filtern kann', async () => {
      const antwort = await leser.list({ ...FILTER });
      expect(antwort.projekte).toContainEqual(
        expect.objectContaining({ id: projektId, slug: 'spuren-projekt' }),
      );
    });
  });

  describe('task', () => {
    it('liefert Zeitstrahl, Läufe, Gate-Läufe und Befunde einer Aufgabe', async () => {
      const id = await aufgabe('Volle Spur');
      await tasks.transition(id, 'planning', { actor: 'orchestrator', reason: 'Planung beginnt' });
      await tasks.note(id, { text: 'eine Notiz', actor: 'planner' });
      const runId = await lauf({ taskId: id, role: 'planner' });

      const gateRunId = randomUUID();
      await sql`
        INSERT INTO gate_runs (id, task_id, project_id, stage, started_at, finished_at,
                               duration_ms, ok, head_sha, base_ref, steps)
        VALUES (${gateRunId}, ${id}::uuid, ${projektId}::uuid, 'merge_queue', now(), now(), 1200,
                false, ${'a'.repeat(40)}, 'main',
                ${sql.json([
                  { id: 'test', verdict: 'finding', detail: 'ein Test ist rot', output: 'FAIL' },
                  { id: 'lint', verdict: 'green', detail: 'sauber' },
                ] as postgres.JSONValue)})`;

      const detail = await leser.task(id);

      expect(detail?.aufgabe.title).toBe('Volle Spur');
      expect(detail?.description).toBe('Beschreibung');
      expect(detail?.acceptanceCriteria).toEqual(['erstes Kriterium']);
      // created, state_changed, note — in `seq` order, which is the only order
      // that is a total one (two events can share a timestamp).
      expect(detail?.ereignisse.map((e) => e.kind)).toEqual(['created', 'state_changed', 'note']);
      expect(detail?.ereignisse[1]?.payload).toMatchObject({ reason: 'Planung beginnt' });
      expect(detail?.laeufe.map((l) => l.runId)).toEqual([runId]);
      expect(detail?.gateLaeufe[0]?.steps.map((s) => s.id)).toEqual(['test', 'lint']);
      // A25's split at the one place it decides consequences: only the red step
      // is a finding, and §11 gives it exactly one severity.
      expect(detail?.befunde.map((b) => b.gateId)).toEqual(['test']);
      expect(detail?.befunde[0]?.severity).toBe('blocker');
      expect(detail?.befunde[0]?.status).toBe('open');
    });

    it('holt Kappen und Transkript-Problem aus den Ereignissen, die die View nicht führt', async () => {
      const id = await aufgabe('Kappenfall');
      await lauf({
        taskId: id,
        caps: { maxTurns: 7, maxBudgetUsd: 3, wallClockMs: 60_000 },
        transcriptProblem: 'Das Backend führt kein Sitzungsprotokoll.',
      });

      const detail = await leser.task(id);

      // Both fields are the stated compromise of decision 2: §22 asks for the
      // caps by name and an absent transcript has to say why, and `agent_runs`
      // projects neither. If the correlated subselects were wrong, both would
      // come back null and the page would silently show "nicht aufgezeichnet".
      expect(detail?.laeufe[0]?.caps).toEqual({
        maxTurns: 7,
        maxBudgetUsd: 3,
        wallClockMs: 60_000,
      });
      expect(detail?.laeufe[0]?.transcriptProblem).toBe(
        'Das Backend führt kein Sitzungsprotokoll.',
      );
    });

    it('lässt die Dauer eines noch laufenden Laufs offen, statt gegen jetzt zu messen', async () => {
      const id = await aufgabe('Laufender Fall');
      await lauf({ taskId: id, terminate: false });

      const detail = await leser.task(id);

      // A duration measured against `now` would make a run a crash left open in
      // March read as having worked for months.
      expect(detail?.laeufe[0]?.durationMs).toBeNull();
      expect(detail?.laeufe[0]?.finished).toBe(false);
    });

    it('antwortet null auf eine unbekannte Aufgabe', async () => {
      expect(await leser.task(randomUUID())).toBeNull();
    });
  });

  describe('diffBasis', () => {
    it('paart bei zwei Merges den zweiten Anfang mit dem zweiten Ende', async () => {
      const id = await aufgabe('Zweimal zusammengeführt');
      // §12 marks a rolled-back change red, and §9 lets it come back — so a task
      // really can carry two of each. Taking the newest of each independently
      // would pair the second merge's end with the *first* merge's start and
      // produce a comparison that never existed.
      const bis = async (state: string, payload: Record<string, unknown>) =>
        tasks.transition(id, state as 'planning', { actor: 'orchestrator', payload });

      await bis('planning', {});
      await bis('claimed', {});
      await bis('coding', {});
      await bis('review', {});
      await bis('gates', {});
      await bis('merge_queue', {});
      await bis('merging', { baseShaBefore: 'aaa1111111111111111111111111111111111111' });
      // The merge queue writes `baseShaAfter` onto `deploying` for a project
      // with a deploy method — this is the round that then gets rolled back.
      await bis('deploying', { baseShaAfter: 'bbb1111111111111111111111111111111111111' });

      const erste = await leser.diffBasis(id);
      expect(erste).toMatchObject({
        ok: true,
        basis: 'merge',
        fromRef: 'aaa1111111111111111111111111111111111111',
        toRef: 'bbb1111111111111111111111111111111111111',
        forkPoint: false,
        repoPath: '/opt/spuren',
      });

      // §12's rollback marks the merged change red, and §9 routes that from
      // `deploying` — not from `done`, which is terminal. The first draft of
      // this fixture went `done → red` and the lifecycle guard refused it, which
      // is the guard doing its job on a test that had the story wrong.
      await tasks.transition(id, 'red', { actor: 'orchestrator' });
      await bis('queued', {});
      await bis('planning', {});
      await bis('claimed', {});
      await bis('coding', {});
      await bis('review', {});
      await bis('gates', {});
      await bis('merge_queue', {});
      await bis('merging', { baseShaBefore: 'ccc1111111111111111111111111111111111111' });
      // And this time it lands on `done`, which is where A24's `deploy: none`
      // puts `baseShaAfter` — decision 4's case, and the reason the query asks
      // for the key rather than for the state.
      await bis('done', { baseShaAfter: 'ddd1111111111111111111111111111111111111' });

      expect(await leser.diffBasis(id)).toMatchObject({
        basis: 'merge',
        fromRef: 'ccc1111111111111111111111111111111111111',
        toRef: 'ddd1111111111111111111111111111111111111',
      });
    });

    it('fällt ohne Merge auf den Baum zurück, den der letzte Gate-Lauf geprüft hat', async () => {
      const id = await aufgabe('Nur begatet');
      await sql`
        INSERT INTO gate_runs (id, task_id, project_id, stage, started_at, finished_at,
                               duration_ms, ok, head_sha, base_ref, steps)
        VALUES (${randomUUID()}, ${id}::uuid, ${projektId}::uuid, 'merge_queue', now(), now(),
                10, true, ${'e'.repeat(40)}, 'main', '[]'::jsonb)`;

      // The integration branch has moved on since the candidate forked, so this
      // one is a fork-point comparison where the merge pair is not.
      expect(await leser.diffBasis(id)).toMatchObject({
        basis: 'gate',
        fromRef: 'main',
        toRef: 'e'.repeat(40),
        forkPoint: true,
      });
    });

    it('fällt zuletzt auf den Zweig zurück und sonst auf einen benannten Grund', async () => {
      const ohne = await aufgabe('Ohne alles');
      // No merge, no gate run, and `branch` is null on a task whose worktree was
      // never assigned. That is an ordinary state, and it must not read as a
      // broken repository.
      expect(await leser.diffBasis(ohne)).toEqual({ ok: false, reason: 'no_basis' });
      expect(await leser.diffBasis(randomUUID())).toEqual({ ok: false, reason: 'no_task' });
    });
  });

  describe('run', () => {
    it('liefert einen Lauf ohne Aufgabe — eine Prüfung dient keiner (A56.5)', async () => {
      const runId = await lauf({ taskId: null, role: 'auditor' });

      const record = await leser.run(runId);

      expect(record?.taskId).toBeNull();
      expect(record?.role).toBe('auditor');
      expect(record?.sessionId).toBe(`sess-${runId.slice(0, 8)}`);
    });

    it('antwortet null auf einen unbekannten Lauf', async () => {
      expect(await leser.run(randomUUID())).toBeNull();
    });
  });
});
