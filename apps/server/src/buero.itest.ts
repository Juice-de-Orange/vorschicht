/**
 * §17.2's room, assembled from real rows.
 *
 * The reducer's properties are pinned without a database (`buero-format.test.ts`)
 * and the bubble rule without either (`buero.test.ts`). What only a real schema
 * can answer is the question this file exists for: **which chairs are occupied**
 * — because that answer is a join across `agent_runs`, `tasks` and `projects`,
 * three views whose shapes this module reads and does not own.
 *
 * Two assertions are load-bearing and the rest keep them honest:
 *
 *   1. A finished run whose task is still in flight **keeps** its desk. That is
 *      what makes the office a room rather than a process list, and it is the
 *      one property a query written the obvious way (`WHERE NOT is_finished`)
 *      gets wrong while looking right.
 *   2. A desk carries the **inputs**, never the bubble. The payload is parsed
 *      through the shared schema, so a field renamed on either side fails here
 *      rather than in a browser.
 */
import { randomUUID } from 'node:crypto';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import { bueroPayload, deskState } from '@vorschicht/shared/buero';
import type { Hono } from 'hono';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { buildBuero } from './buero.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Büro-Schnappschuss (§17.2)', () => {
  let database: TestDatabase;
  let sql: postgres.Sql;
  let app: Hono;
  let projectId: string;
  let readOnlyProjectId: string;

  const SESSION = 'kredential-buero-2';

  /**
   * A task, seeded straight into §9's log — `TaskService` is not what is proven
   * here, and its own suite already is.
   *
   * Raw, but not lawless: 0006's trigger refuses a task born anywhere but
   * `draft`/`queued` and refuses every transition §9 does not draw, so a fixture
   * that wanted a coding task has to *walk* one there. That is the fixture being
   * held to the same rule as the studio, which is the only reason a room
   * assembled from these rows says anything about the real one.
   */
  const seqOf = new Map<string, number>();

  async function task(options: {
    title: string;
    through?: readonly string[];
    project?: string;
  }): Promise<string> {
    const id = randomUUID();
    await sql`
      INSERT INTO task_events (task_id, project_id, seq, kind, actor, state, priority, payload)
      VALUES (${id}, ${options.project ?? projectId}, 0, 'created', 'orchestrator',
              'queued', 'P2',
              ${sql.json({ title: options.title, department: 'entwicklung', type: 'feature' } as never)})
    `;
    seqOf.set(id, 0);
    await advance(id, options.through ?? [], options.project ?? projectId);
    return id;
  }

  /** Walk a task along §9's edges, one row per step (§9: no silent transitions). */
  async function advance(
    id: string,
    states: readonly string[],
    project = projectId,
  ): Promise<void> {
    for (const state of states) {
      const seq = (seqOf.get(id) ?? 0) + 1;
      await sql`
        INSERT INTO task_events (task_id, project_id, seq, kind, actor, state, priority, payload)
        VALUES (${id}, ${project}, ${seq}, 'state_changed', 'orchestrator', ${state}, 'P2', '{}'::jsonb)
      `;
      seqOf.set(id, seq);
    }
  }

  /** §9's route from `queued` to a task somebody is writing code for. */
  const BIS_CODING = ['planning', 'claimed', 'coding'] as const;
  /** And from there to the terminus, which §9 does not reach in one step either. */
  const BIS_DONE = ['review', 'gates', 'merge_queue', 'merging', 'done'] as const;

  /** A run, likewise raw: `agent_runs` is a view and this is what fills it. */
  async function run(options: {
    role: string;
    taskId: string | null;
    finished: boolean;
    minutesAgo: number;
  }): Promise<string> {
    const id = randomUUID();
    const at = new Date(Date.now() - options.minutesAgo * 60_000);
    await sql`
      INSERT INTO agent_run_events (run_id, seq, kind, occurred_at, payload)
      VALUES (${id}, 0, 'created', ${at},
              ${sql.json({ role: options.role, taskId: options.taskId, model: 'test' } as never)})
    `;
    await sql`
      INSERT INTO agent_run_events (run_id, seq, kind, occurred_at, payload)
      VALUES (${id}, 1, 'started', ${at}, ${sql.json({ sessionId: id } as never)})
    `;
    if (options.finished) {
      await sql`
        INSERT INTO agent_run_events (run_id, seq, kind, occurred_at, payload)
        VALUES (${id}, 2, 'terminated', ${at}, ${sql.json({ reason: 'completed' } as never)})
      `;
    }
    return id;
  }

  async function room() {
    return buildBuero({ sql, personaMode: async () => 'anzeige' });
  }

  beforeAll(async () => {
    database = await createTestDatabase('server_buero');
    sql = createSql({ url: database.url, max: 4 });

    const [offen] = await sql<Array<{ id: string }>>`
      INSERT INTO projects (slug, name, root_path) VALUES ('buero', 'Büro', '/tmp/buero')
      RETURNING id
    `;
    projectId = offen?.id ?? '';
    const [gesperrt] = await sql<Array<{ id: string }>>`
      INSERT INTO projects (slug, name, root_path, read_only)
      VALUES ('buero-gesperrt', 'Büro (nur lesbar)', '/tmp/buero-ro', true)
      RETURNING id
    `;
    readOnlyProjectId = gesperrt?.id ?? '';

    app = createApp({
      health: { startedAt: Date.now(), pingDatabase: async () => {} },
      getSession: async () => ({ userId: SESSION }),
      buero: () => room(),
    });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await database?.drop();
  });

  it('setzt einen laufenden Lauf an einen Schreibtisch, mit Aufgabe und Projekt', async () => {
    const t = await task({ title: 'Erste Aufgabe', through: BIS_CODING });
    const r = await run({ role: 'coder', taskId: t, finished: false, minutesAgo: 1 });

    const platz = (await room()).desks.find((desk) => desk.runId === r);
    expect(platz).toBeDefined();
    expect(platz?.profileId).toBe('coder');
    expect(platz?.department).toBe('Entwicklung');
    expect(platz?.name).toBe('Clara');
    expect(platz?.desk).toBe('Entwicklung');
    expect(platz?.taskTitle).toBe('Erste Aufgabe');
    expect(platz?.taskState).toBe('coding');
    expect(platz?.projectSlug).toBe('buero');
    expect(platz?.runLive).toBe(true);
    expect(deskState(platz as never)).toBe('arbeitet');
  });

  /**
   * Die tragende Zusicherung. Eine Abfrage nach `WHERE NOT is_finished` bestände
   * jeden anderen Fall dieser Datei und macht aus dem Büro eine Prozessliste:
   * Paul verschwindet in der Sekunde, in der er übergibt.
   */
  it('lässt einen fertigen Lauf am Platz, solange seine Aufgabe läuft — und räumt ihn ab, wenn sie fertig ist', async () => {
    const t = await task({ title: 'Übergebene Aufgabe', through: BIS_CODING });
    const r = await run({ role: 'planner', taskId: t, finished: true, minutesAgo: 2 });

    const platz = (await room()).desks.find((desk) => desk.runId === r);
    expect(platz?.runLive).toBe(false);
    expect(platz?.taskState).toBe('coding');
    // Der Platz bleibt, die Kugel sagt aber, dass dieser Tisch nichts in der
    // Hand hat — die Aufgabe läuft woanders weiter.
    expect(deskState(platz as never)).toBe('ruht');

    await advance(t, BIS_DONE);
    expect((await room()).desks.find((desk) => desk.runId === r)).toBeUndefined();
  });

  it('behält eine Sitzung ohne Aufgabe nur, solange sie läuft (A56.5)', async () => {
    const lebt = await run({ role: 'auditor', taskId: null, finished: false, minutesAgo: 1 });
    const vorbei = await run({ role: 'smoke', taskId: null, finished: true, minutesAgo: 3 });

    const desks = (await room()).desks;
    const bruno = desks.find((desk) => desk.runId === lebt);
    expect(bruno?.taskId).toBeNull();
    expect(bruno?.taskTitle).toBeNull();
    expect(bruno?.taskState).toBeNull();
    expect(deskState(bruno as never)).toBe('arbeitet');
    expect(desks.find((desk) => desk.runId === vorbei)).toBeUndefined();
  });

  /**
   * §8.1 lässt den Coder je Review-Runde erneut laufen. Ein Platz, der auf der
   * Lauf-Kennung beruhte, würde dazwischen leer und danach neu besetzt.
   */
  it('hält einen Platz über mehrere Läufe derselben Aufgabe, und zeigt den neuesten', async () => {
    const t = await task({ title: 'Zwei Runden', through: BIS_CODING });
    await run({ role: 'reviewer', taskId: t, finished: true, minutesAgo: 9 });
    const zweiter = await run({ role: 'reviewer', taskId: t, finished: false, minutesAgo: 1 });

    const plaetze = (await room()).desks.filter(
      (desk) => desk.profileId === 'reviewer' && desk.taskId === t,
    );
    expect(plaetze).toHaveLength(1);
    expect(plaetze[0]?.runId).toBe(zweiter);
    expect(plaetze[0]?.runLive).toBe(true);
  });

  /** A46.5: ein Profil an zwei Aufgaben ist Clara und Chris, nicht zweimal Clara. */
  it('setzt zwei gleichzeitige Coder an zwei Tische mit zwei Namen', async () => {
    const a = await task({ title: 'Clara-Aufgabe', through: BIS_CODING });
    const b = await task({ title: 'Chris-Aufgabe', through: BIS_CODING });
    await run({ role: 'coder', taskId: a, finished: false, minutesAgo: 40 });
    await run({ role: 'coder', taskId: b, finished: false, minutesAgo: 39 });

    const coder = (await room()).desks.filter((desk) => desk.profileId === 'coder');
    const namen = coder.map((desk) => desk.name);
    expect(new Set(namen).size).toBe(namen.length);
    expect(namen).toContain('Clara');
    expect(namen).toContain('Chris');
    // Der ältere Stuhl behält seinen Namen — sonst tauschen zwei Menschen bei
    // jedem Neuzeichnen die Plätze.
    const claraSitz = coder.find((desk) => desk.name === 'Clara');
    expect(claraSitz?.taskTitle).toBe('Clara-Aufgabe');
  });

  /** A119.6s dritte Blockade-Art, aus einem freien Join. */
  it('meldet ein nur lesbares Projekt am Platz, damit die Kugel es sagen kann', async () => {
    const t = await task({
      title: 'Auf gesperrtem Projekt',
      project: readOnlyProjectId,
    });
    const r = await run({ role: 'planner', taskId: t, finished: true, minutesAgo: 5 });

    const platz = (await room()).desks.find((desk) => desk.runId === r);
    expect(platz?.projectReadOnly).toBe(true);
    expect(deskState(platz as never)).toBe('blockiert');
  });

  it('antwortet über die Route in der vereinbarten Form, mit Personamodus', async () => {
    const antwort = await app.request('/api/buero');
    expect(antwort.status).toBe(200);
    const koerper = (await antwort.json()) as { buero: unknown };
    const gelesen = bueroPayload.safeParse(koerper.buero);
    expect(gelesen.success, JSON.stringify(gelesen.error?.issues ?? [])).toBe(true);
    expect(gelesen.data?.personaMode).toBe('anzeige');
    expect(gelesen.data?.omitted).toBe(0);
    expect(Date.parse(gelesen.data?.generatedAt ?? '')).not.toBeNaN();
    // Die Nutzlast trägt Eingaben, kein Urteil: keine einzige Kugel steht drin.
    expect(JSON.stringify(koerper.buero)).not.toMatch(/"(state|bubble|kugel)":/);
  });

  /**
   * Der Deckel und der Satz, der ihn zugibt — als Paar geprüft.
   *
   * Eine gekürzte Liste ohne diese Zahl liest sich wie „das sind alle", und das
   * ist die eine Auskunft, die ein Raum nicht geben darf. Der echte Deckel liegt
   * bei 24; ihn aus einer Fixture zu erreichen hieße, fünfundzwanzig Aufgaben
   * durch §9 zu laufen, um eine Subtraktion zu belegen — deshalb nimmt dieser
   * Fall den Deckel als Zahl entgegen.
   */
  it('kürzt auf den Deckel und sagt genau, wie viele Plätze fehlen', async () => {
    const ganz = await room();
    expect(ganz.desks.length).toBeGreaterThan(2);
    expect(ganz.omitted).toBe(0);

    const eng = await buildBuero({ sql, personaMode: async () => 'anzeige', maxDesks: 2 });
    expect(eng.desks).toHaveLength(2);
    // Die Zahl ergänzt die Liste, statt sie zu beschreiben: beides zusammen ist
    // wieder der ganze Raum.
    expect(eng.desks.length + eng.omitted).toBe(ganz.desks.length);
    // Und gekürzt wird die stillste Ecke, nicht die lauteste: was bleibt, ist
    // das Neueste.
    expect(eng.desks.map((desk) => desk.seatId)).toEqual(
      ganz.desks.slice(0, 2).map((desk) => desk.seatId),
    );
  });
});
