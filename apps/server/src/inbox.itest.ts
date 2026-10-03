/**
 * The inbox adapter over the real service and a real database (§15).
 *
 * `inbox.test.ts` drives the adapter against a fake, which proves the branches
 * and cannot prove the two things only real rows can:
 *
 *   * that an answer actually lands in the decision log with its context
 *     linkage — §22's Phase 4 exit gate asks for exactly that, and a fake
 *     returning a `DecisionRecord` proves nothing about the view it comes from;
 *   * that the conflict branch survives the case its pre-check cannot see. The
 *     stale read below is the shape of a second answer arriving between the
 *     check and the write: the adapter's own state check passes, the service
 *     refuses, and the re-read is what turns that into a 409 rather than into
 *     "your option does not exist".
 *
 * The overview counters are asserted here too, because the distinction they
 * carry — inbox items are not the same number as tasks waiting — only shows up
 * against data where the two differ.
 */
import { EscalationService, EventLog } from '@vorschicht/core';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type { RaiseEscalationInput } from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  answerEscalation,
  getInboxCard,
  type InboxDeps,
  listDecisionLog,
  listInbox,
} from './inbox.js';
import { buildOverview } from './overview.js';

const url = process.env.TEST_DATABASE_URL;

const TASK_A = '22222222-2222-4222-8222-222222222222';
const TASK_B = '55555555-5555-4555-8555-555555555555';
const TASK_C = '66666666-6666-4666-8666-666666666666';
const TASK_C_TITLE = 'Merge-Queue härten';

describe.skipIf(!url)('Posteingang gegen echte Daten (§15)', () => {
  let database: TestDatabase;
  let sql: postgres.Sql;
  let service: EscalationService;
  let deps: InboxDeps;
  let seq = 0;

  beforeAll(async () => {
    database = await createTestDatabase('server_inbox');
    sql = createSql({ url: database.url, max: 4 });
    service = new EscalationService({ sql, eventLog: new EventLog(sql) });
    deps = { escalations: service };

    // A real project and a real `created` row, because the blocked-task list
    // reads the title from the `tasks` view. Written directly rather than
    // through `TaskService`: the §9 lifecycle is settled elsewhere, and what
    // this file needs is one task that exists and has a name the operator would
    // recognise on the overview.
    const [projekt] = await sql<Array<{ id: string }>>`
      INSERT INTO projects (slug, name, root_path)
      VALUES ('posteingang-test', 'Posteingang-Test', '/tmp/posteingang-test')
      RETURNING id
    `;
    await sql`
      INSERT INTO task_events (task_id, project_id, seq, kind, actor, state, priority, payload)
      VALUES (
        ${TASK_C}, ${projekt?.id ?? null}, 0, 'created', 'orchestrator', 'queued', 'P2',
        ${sql.json({ title: TASK_C_TITLE, department: 'entwicklung', type: 'feature' })}
      )
    `;
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await database?.drop();
  });

  async function raise(overrides: Partial<RaiseEscalationInput> = {}) {
    seq += 1;
    return service.raise({
      source: 'agent_question',
      // Distinct per item: an identical question is a *precedent*, and this file
      // is not the place that behaviour is settled.
      question: `Darf Vorschicht Zweig ${seq} anlegen?`,
      context: 'Der Coder braucht einen Zweig, main ist geschützt.',
      urgency: 'P1',
      options: [
        { title: 'Ja', pros: ['Schnell'], cons: ['Riskant'], recommended: true },
        { title: 'Nein', pros: ['Sicher'], cons: ['Blockiert'], recommended: false },
      ],
      taskId: TASK_A,
      raisedBy: 'coder',
      ...overrides,
    });
  }

  it('zeigt eine gestellte Frage als vollständige Karte im Posteingang', async () => {
    const raised = await raise();

    const list = await listInbox(deps);
    expect(list.map((card) => card.number)).toContain(raised.number);

    const card = await getInboxCard(deps, raised.number);
    if (!card.ok) throw new Error('Karte erwartet');
    expect(card.escalation.state).toBe('open');
    expect(card.escalation.sourceLabel).toBe('Frage aus einer Sitzung');
    expect(card.escalation.options).toHaveLength(2);
    expect(card.escalation.options[0]?.recommended).toBe(true);
    expect(card.escalation.taskId).toBe(TASK_A);
    expect(Date.parse(card.escalation.raisedAt)).not.toBeNaN();
  });

  it('trägt eine Antwort ins Entscheidungslog mit allen Kontextverweisen ein', async () => {
    const raised = await raise({ taskId: TASK_B });

    const answered = await answerEscalation(
      deps,
      raised.number,
      { optionIndex: 0, freeText: 'Aber nur auf einem Aufgabenzweig.' },
      'dashboard:cred-1',
    );
    if (!answered.ok) throw new Error('Antwort erwartet');
    expect(answered.escalation.state).toBe('answered');
    expect(answered.escalation.answeredBy).toBe('dashboard:cred-1');
    expect(answered.escalation.chosenTitle).toBe('Ja');

    const log = await listDecisionLog(deps, null);
    const entry = log.find((row) => row.number === raised.number);
    expect(entry).toBeDefined();
    expect(entry?.escalationId).toBe(raised.id);
    expect(entry?.taskId).toBe(TASK_B);
    expect(entry?.question).toBe(raised.question);
    expect(entry?.decidedBy).toBe('dashboard:cred-1');
    expect(entry?.summary).toBe(
      `Entscheidung #${raised.number}: Ja — „Aber nur auf einem Aufgabenzweig.“`,
    );

    // Answered items leave the inbox; §15's badge counts what is waiting.
    const open = await listInbox(deps);
    expect(open.map((card) => card.number)).not.toContain(raised.number);
  });

  it('lehnt eine zweite Antwort ab, auch wenn die Zustandsprüfung sie nicht sieht', async () => {
    const raised = await raise();
    const stale = await service.byNumber(raised.number);
    if (!stale) throw new Error('Eskalation erwartet');

    await answerEscalation(deps, raised.number, { optionIndex: 1 }, 'dashboard:cred-1');

    // What a second browser tab holds: a record read before the answer landed.
    // The pre-check therefore passes and the write is the thing that refuses.
    const staleDeps: InboxDeps = {
      escalations: {
        open: () => service.open(),
        byNumber: (() => {
          let first = true;
          return async (number: number) => {
            if (first) {
              first = false;
              return stale;
            }
            return service.byNumber(number);
          };
        })(),
        answer: (id, input) => service.answer(id, input),
        decisions: (limit) => service.decisions(limit),
      },
    };

    const second = await answerEscalation(
      staleDeps,
      raised.number,
      { optionIndex: 0 },
      'dashboard:cred-2',
    );
    expect(second.ok).toBe(false);
    expect(second.ok === false && second.reason).toBe('conflict');

    // And the first answer is untouched — a conflict is not a partial write.
    const card = await getInboxCard(deps, raised.number);
    expect(card.ok && card.escalation.chosenTitle).toBe('Nein');
    expect(card.ok && card.escalation.answeredBy).toBe('dashboard:cred-1');
  });

  it('meldet eine nicht vorhandene Option als Eingabefehler, nicht als Konflikt', async () => {
    const raised = await raise();
    const result = await answerEscalation(deps, raised.number, { optionIndex: 9 }, 'dashboard:x');
    if (result.ok || result.reason !== 'invalid') throw new Error('Eingabefehler erwartet');
    // The service's own German sentence, quoted rather than re-worded here.
    expect(result.errors[0]).toContain('zur Auswahl');
    expect((await getInboxCard(deps, raised.number)).ok).toBe(true);
    expect((await listInbox(deps)).map((c) => c.number)).toContain(raised.number);
  });

  /**
   * Der echte Wettlauf, eine Schicht höher — und **nichts wird injiziert**.
   *
   * Der Fall darüber baut einen veralteten Lesevorgang nach, was die Vorprüfung
   * dieses Adapters passieren lässt; die des *Dienstes* greift danach trotzdem,
   * also erreicht der INSERT den Index nie. Hier laufen zwei echte Antworten
   * gleichzeitig los. Was zählt, ist die Aussage des Gates: die Oberfläche
   * bekommt einen Konflikt, **nie** einen Serverfehler — und `answerEscalation`
   * darf dafür nicht werfen, denn es gibt kein `app.onError`, das einen Wurf in
   * eine Antwort verwandeln würde.
   */
  it('beantwortet einen echten Wettlauf mit Konflikt, nie mit einem Serverfehler', async () => {
    for (let runde = 0; runde < 10; runde += 1) {
      const raised = await raise();

      const [a, b] = await Promise.all([
        answerEscalation(deps, raised.number, { optionIndex: 0 }, 'dashboard:cred-1'),
        answerEscalation(deps, raised.number, { optionIndex: 1 }, 'dashboard:cred-2'),
      ]);

      const gelungen = [a, b].filter((r) => r.ok);
      const abgelehnt = [a, b].filter((r) => !r.ok);
      expect(gelungen).toHaveLength(1);
      expect(abgelehnt).toHaveLength(1);

      const refusal = abgelehnt[0];
      expect(refusal?.ok === false && refusal.reason).toBe('conflict');
      // Und die abgelehnte Antwort trägt die Karte mit, damit die Seite zeigen
      // kann, *was* entschieden wurde, statt nur „nein" zu sagen.
      expect(
        refusal?.ok === false && refusal.reason === 'conflict' && refusal.escalation.state,
      ).toBe('answered');
    }
  });

  /**
   * §17.1's counter says *Tasks* and §17.5's badge counts *items*. Two open
   * escalations on one task plus one with no task is the smallest arrangement
   * where the two numbers differ, which is the only arrangement that can show a
   * page rendering one under the other's label.
   */
  it('zählt offene Eskalationen und wartende Aufgaben getrennt (§17.1)', async () => {
    // Deltas rather than absolutes: `escalation_events` is append-only, so this
    // file cannot clear what the cases above left open — and asserting a delta
    // is the stronger statement anyway, since it holds whatever else is waiting.
    const counts = async () =>
      (
        await buildOverview({
          sql,
          currentSamples: async () => [],
          openDecisions: () => service.open(),
        })
      ).decisions;

    const before = await counts();
    await raise({ taskId: TASK_C });
    const zweite = await raise({ taskId: TASK_C });
    const untied = await raise({ taskId: null });

    // Three items, one task: exactly the arrangement in which a page rendering
    // one number under the other's label is wrong.
    const mitDrei = await counts();
    expect(mitDrei.open).toBe(before.open + 3);
    expect(mitDrei.tasksWaiting).toBe(before.tasksWaiting + 1);

    // The list is the other half of the same fact, and the half that shipped
    // broken: the counter de-duplicated by task while the page rendered every
    // raw row. `tasksWaiting` is now `blockedTasks.length` by construction, so
    // the assertion that matters is that the two cannot come apart.
    expect(mitDrei.blockedTasks).toHaveLength(mitDrei.tasksWaiting);
    const zeile = mitDrei.blockedTasks.find((eintrag) => eintrag.taskId === TASK_C);
    expect(zeile).toBeDefined();
    // The newest of the task's two questions — the one actually in front of the operator.
    expect(zeile?.number).toBe(zweite.number);
    // And the title comes from the task, not from a placeholder: a blocked task
    // the operator cannot recognise is a row he cannot act on.
    expect(zeile?.title).toBe(TASK_C_TITLE);

    await answerEscalation(deps, untied.number, { optionIndex: 0 }, 'dashboard:cred-1');
    const danach = await counts();
    expect(danach.open).toBe(before.open + 2);
    expect(danach.tasksWaiting).toBe(before.tasksWaiting + 1);
    expect(danach.blockedTasks).toHaveLength(danach.tasksWaiting);
  });

  /**
   * §6.1 auf der Übersicht, gegen echte Zeilen: die Form, in der der Daemon den
   * Vorfall schreibt (`main.ts`: `reasons`, `announced`, `alertError`), und die
   * Uhr, die entscheidet, ob er noch läuft.
   */
  it('nennt einen laufenden Auth-Vorfall und lässt einen verstummten weg (§6.1)', async () => {
    const übersicht = (jetzt?: number) =>
      buildOverview({
        sql,
        currentSamples: async () => [],
        openDecisions: async () => [],
        ...(jetzt === undefined ? {} : { now: () => jetzt }),
      });

    expect((await übersicht()).authIncident).toBeNull();

    await sql`
      INSERT INTO event_log (kind, actor, payload)
      VALUES ('auth.incident', 'system', ${sql.json({
        reasons: ['Die Sitzung konnte sich nicht anmelden (§6.1).'],
        announced: false,
        alertError: 'fetch failed',
      })})
    `;

    const vorfall = (await übersicht()).authIncident;
    expect(vorfall?.text).toContain('Die Anmeldung bei Claude schlägt fehl');
    expect(vorfall?.text).toContain('Die Sitzung konnte sich nicht anmelden');
    expect(vorfall?.text).toContain('Der Alarm über ntfy kam nicht an');

    // Eine Stunde später, ohne neue Meldung: der Daemon meldet ihn nicht mehr.
    expect((await übersicht(Date.now() + 60 * 60_000)).authIncident).toBeNull();
  });

  /**
   * A44.3s dritte Art Stillstand, gegen echte Zeilen.
   *
   * Die Zusicherung, auf die es ankommt, ist die **Trennung**: eine Aufgabe auf
   * einem nur lesbaren Projekt darf `tasksWaiting` nicht erhöhen. §17.1s Zähler
   * heißt „warten auf deine Entscheidung", und diese Aufgabe wartet auf eine
   * Kennzeichnung — sie mitzuzählen wäre dieselbe Klasse Fehler wie die, die
   * A81.4 aus dem Zähler entfernt hat, nur andersherum.
   */
  it('führt Aufgaben eines nur lesbaren Projekts getrennt vom Entscheidungszähler (A44.3)', async () => {
    const übersicht = () =>
      buildOverview({
        sql,
        currentSamples: async () => [],
        openDecisions: () => service.open(),
      });

    const vorher = await übersicht();

    const [gesperrt] = await sql<Array<{ id: string }>>`
      INSERT INTO projects (slug, name, root_path, read_only)
      VALUES ('nur-lesbar', 'Nur lesbar', '/tmp/nur-lesbar', true)
      RETURNING id
    `;
    const liegt = '77777777-7777-4777-8777-777777777777';
    const fertig = '88888888-8888-4888-8888-888888888888';
    await sql`
      INSERT INTO task_events (task_id, project_id, seq, kind, actor, state, priority, payload)
      VALUES
        (${liegt}, ${gesperrt?.id ?? null}, 0, 'created', 'orchestrator', 'queued', 'P2',
         ${sql.json({ title: 'Prüfungsfund beheben', department: 'entwicklung', type: 'x' })}),
        (${fertig}, ${gesperrt?.id ?? null}, 0, 'created', 'orchestrator', 'queued', 'P2',
         ${sql.json({ title: 'Längst erledigt', department: 'entwicklung', type: 'x' })})
    `;
    // Eine terminale Aufgabe desselben Projekts: sie wird vom Ablaufplaner
    // nicht wegen der Kennzeichnung übersprungen, sondern weil sie fertig ist,
    // und darf deshalb nicht unter diesem Satz erscheinen.
    for (const [seqNr, state] of [
      [1, 'planning'],
      [2, 'claimed'],
      [3, 'coding'],
      [4, 'review'],
      [5, 'gates'],
      [6, 'merge_queue'],
      [7, 'merging'],
      [8, 'done'],
    ] as const) {
      await sql`
        INSERT INTO task_events (task_id, project_id, seq, kind, actor, state, priority, payload)
        VALUES (${fertig}, ${gesperrt?.id ?? null}, ${seqNr}, 'state_changed', 'orchestrator',
                ${state}, 'P2', '{}'::jsonb)
      `;
    }

    const nachher = await übersicht();

    const zeile = nachher.stalledTasks.find((eintrag) => eintrag.taskId === liegt);
    expect(zeile).toEqual({
      taskId: liegt,
      title: 'Prüfungsfund beheben',
      projectSlug: 'nur-lesbar',
      reason: 'read_only',
    });
    // Die terminale Aufgabe steht nicht darunter: ihre Ursache ist eine andere.
    expect(nachher.stalledTasks.map((eintrag) => eintrag.taskId)).not.toContain(fertig);
    // Und der Entscheidungszähler hat sich nicht bewegt.
    expect(nachher.decisions.tasksWaiting).toBe(vorher.decisions.tasksWaiting);
    expect(nachher.decisions.open).toBe(vorher.decisions.open);
    expect(nachher.decisions.blockedTasks.map((eintrag) => eintrag.taskId)).not.toContain(liegt);
  });

  it('nennt eine Aufgabe nicht mehr, sobald das Projekt freigegeben ist', async () => {
    const [frei] = await sql<Array<{ id: string }>>`
      INSERT INTO projects (slug, name, root_path, read_only)
      VALUES ('wird-frei', 'Wird frei', '/tmp/wird-frei', true)
      RETURNING id
    `;
    const aufgabe = '99999999-9999-4999-8999-999999999999';
    await sql`
      INSERT INTO task_events (task_id, project_id, seq, kind, actor, state, priority, payload)
      VALUES (${aufgabe}, ${frei?.id ?? null}, 0, 'created', 'orchestrator', 'queued', 'P2',
              ${sql.json({ title: 'Wartet auf Freigabe', department: 'entwicklung', type: 'x' })})
    `;
    const ids = async () =>
      (
        await buildOverview({ sql, currentSamples: async () => [], openDecisions: async () => [] })
      ).stalledTasks.map((eintrag) => eintrag.taskId);

    expect(await ids()).toContain(aufgabe);
    await sql`UPDATE projects SET read_only = false WHERE id = ${frei?.id ?? null}`;
    // Die Zeile verschwindet von selbst — es gibt nichts zu quittieren.
    expect(await ids()).not.toContain(aufgabe);
  });
});
