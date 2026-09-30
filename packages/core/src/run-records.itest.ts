/**
 * Reading a session back (§6.4) — against a real `agent_runs`.
 *
 * The rows are written by hand rather than by running the runner, deliberately:
 * what is under test is the *query*, and the cases that matter are ones a happy
 * chain never produces — a role that ran three times, a run that crashed before
 * it answered, §6.3's repair leg and §6.4's continuation sitting side by side
 * under the same role. Driving those through `AgentRunner` would take three
 * scripted backends to reach one `ORDER BY`.
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RunRecords } from './run-records.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('RunRecords (§6.4)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let runs: RunRecords;

  beforeAll(async () => {
    database = await createTestDatabase('runrecords');
    sql = createSql({ url: database.url, max: 2 });
    runs = new RunRecords(sql);
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
  });

  let seq = 0;

  /**
   * One run, as the runner would have recorded it.
   *
   * `occurred_at` is set explicitly and increasing, because the ordering under
   * test is by the run's *first* event and two rows written in the same
   * millisecond would make the assertion a coin toss.
   */
  async function record(options: {
    taskId: string;
    role: string;
    sessionId?: string;
    cwd?: string;
    result?: unknown;
    resumeOf?: string;
    repairOf?: string;
    terminated?: boolean;
  }): Promise<string> {
    const [row] = await sql<Array<{ id: string }>>`SELECT gen_random_uuid()::text AS id`;
    const runId = row?.id as string;
    seq += 1;
    const at = new Date(Date.parse('2026-08-02T10:00:00Z') + seq * 60_000);

    await sql`
      INSERT INTO agent_run_events (run_id, seq, kind, occurred_at, payload)
      VALUES (${runId}, 0, 'created', ${at}, ${sql.json({
        taskId: options.taskId,
        role: options.role,
        cwd: options.cwd ?? '/data/worktrees/x',
        ...(options.sessionId ? { sessionId: options.sessionId } : {}),
        ...(options.resumeOf ? { resumeOf: options.resumeOf } : {}),
        ...(options.repairOf ? { repairOf: options.repairOf } : {}),
      } as postgres.JSONValue)})
    `;
    if (options.result !== undefined) {
      await sql`
        INSERT INTO agent_run_events (run_id, seq, kind, occurred_at, payload)
        VALUES (${runId}, 1, 'result', ${at}, ${sql.json({ raw: options.result } as postgres.JSONValue)})
      `;
    }
    if (options.terminated ?? true) {
      await sql`
        INSERT INTO agent_run_events (run_id, seq, kind, occurred_at, payload)
        VALUES (${runId}, 2, 'terminated', ${at}, ${sql.json({ reason: 'completed' } as postgres.JSONValue)})
      `;
    }
    return runId;
  }

  const task = () => `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;

  it('gibt Sitzung, Verzeichnis und Rolle eines Laufs zurück', async () => {
    const taskId = task();
    const runId = await record({
      taskId,
      role: 'coder',
      sessionId: 's-1',
      cwd: '/data/worktrees/p/task-1',
      result: { status: 'done' },
    });

    const found = await runs.get(runId);
    expect(found?.sessionId).toBe('s-1');
    expect(found?.cwd).toBe('/data/worktrees/p/task-1');
    expect(found?.role).toBe('coder');
    expect(found?.taskId).toBe(taskId);
    expect(found?.isFinished).toBe(true);
    // §6.4 resumes from these three; a run missing any of them is not resumable,
    // and `DevChain.resume` refuses rather than guessing.
    expect(found?.resumedOf).toBeNull();
  });

  it('kennt einen Lauf nicht, den es nicht gibt', async () => {
    expect(await runs.get('00000000-0000-4000-8000-000000000000')).toBeNull();
  });

  it('nennt den Lauf, den eine Fortsetzung fortsetzt — und unterscheidet ihn von einer Nachbesserung', async () => {
    const taskId = task();
    const parked = await record({ taskId, role: 'coder', sessionId: 's-2', result: { a: 1 } });
    const continued = await record({
      taskId,
      role: 'coder',
      sessionId: 's-2',
      result: { a: 2 },
      resumeOf: parked,
    });
    const repaired = await record({
      taskId,
      role: 'coder',
      sessionId: 's-2',
      result: { a: 3 },
      repairOf: parked,
    });

    // Beide tragen dieselbe Sitzungskennung; erst das Paar der beiden Spalten
    // sagt, welcher der beiden Fälle eingetreten ist (§6.3 gegen §6.4).
    expect((await runs.get(continued))?.resumedOf).toBe(parked);
    expect((await runs.get(repaired))?.resumedOf).toBeNull();
  });

  it('gibt das jüngste Ergebnis einer Rolle zurück — die Fortsetzung, nicht die Frage', async () => {
    const taskId = task();
    const parked = await record({
      taskId,
      role: 'planner',
      sessionId: 's-3',
      result: { plan: ['fragt nach'] },
    });
    const continued = await record({
      taskId,
      role: 'planner',
      sessionId: 's-3',
      result: { plan: ['mit des Betreibers Antwort'] },
      resumeOf: parked,
    });

    const found = await runs.lastResultFor(taskId, 'planner');
    // Der Plan, der *mit* der Entscheidung entstand — der erste hat angehalten,
    // um zu fragen, und ist damit kein Plan, aus dem jemand arbeiten kann.
    expect(found?.runId).toBe(continued);
    expect(found?.resultRaw).toEqual({ plan: ['mit des Betreibers Antwort'] });
  });

  it('übergeht einen Lauf ohne Ergebnis, statt ihn als jüngsten zu nehmen', async () => {
    const taskId = task();
    const good = await record({ taskId, role: 'planner', result: { plan: ['brauchbar'] } });
    // Ein Lauf, der startete und abstürzte: neuer, und ohne Ergebnis. Ihn zu
    // nehmen hieße, mit `null` weiterzuarbeiten, wo ein Plan vorliegt.
    await record({ taskId, role: 'planner', terminated: false });

    expect((await runs.lastResultFor(taskId, 'planner'))?.runId).toBe(good);
  });

  it('hält die Rollen auseinander', async () => {
    const taskId = task();
    await record({ taskId, role: 'planner', result: { plan: ['p'] } });
    const coder = await record({ taskId, role: 'coder', result: { summary: 'c' } });

    expect((await runs.lastResultFor(taskId, 'coder'))?.runId).toBe(coder);
    expect(await runs.lastResultFor(taskId, 'reviewer')).toBeNull();
  });

  it('hält die Aufgaben auseinander', async () => {
    const mine = task();
    const other = `00000000-0000-4000-8000-${String(seq + 500).padStart(12, '0')}`;
    await record({ taskId: other, role: 'planner', result: { plan: ['fremd'] } });
    const own = await record({ taskId: mine, role: 'planner', result: { plan: ['eigen'] } });
    await record({ taskId: other, role: 'planner', result: { plan: ['fremd, neuer'] } });

    // Der jüngste Planer-Lauf überhaupt gehört einer anderen Aufgabe. Ohne die
    // Einschränkung käme deren Plan zurück — und ein Coder arbeitete nach einem
    // Plan, der für ein anderes Stück Arbeit geschrieben wurde.
    expect((await runs.lastResultFor(mine, 'planner'))?.runId).toBe(own);
  });
});
