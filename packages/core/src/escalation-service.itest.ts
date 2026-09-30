/**
 * §5's `escalations` / `decisions` against a real Postgres (migration 0016).
 *
 * The claims this suite has to establish are claims about the *database*, so
 * nothing here is stubbed. Three of them cannot be proved any other way:
 *
 *   * **An escalation is answered exactly once.** The guarantee is a partial
 *     unique index, and a test against a mock would only prove that the service
 *     checks first — which is the layer that a future caller with its own
 *     transaction would go around.
 *   * **`state` is derived.** There is no column to set, so "answered" is not a
 *     thing anybody can write; a stub would let a test assert whatever it was
 *     told.
 *   * **The append-only guards hold.** A decision that could be UPDATEd would
 *     make policy memory a suggestion, since the record of what the operator said is the
 *     only thing the next agent reads.
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import { POLICY_MEMORY_SOURCES } from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EscalationError, EscalationService } from './escalation-service.js';
import { EventLog } from './event-log.js';
import { ProjectService } from './project-service.js';
import { TaskService } from './task-service.js';

const url = process.env.TEST_DATABASE_URL;

const OPTIONS = [
  { title: 'So lassen', pros: ['billig'], cons: ['langsam'], recommended: true },
  { title: 'Umbauen', pros: ['schnell'], cons: ['teuer'], recommended: false },
];

describe.skipIf(!url)('Eskalationen und Entscheidungen (§15)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let escalations: EscalationService;
  let tasks: TaskService;
  let projectA: string;
  let projectB: string;

  beforeAll(async () => {
    database = await createTestDatabase('escalations');
    sql = createSql({ url: database.url, max: 3 });
    const eventLog = new EventLog(sql);
    escalations = new EscalationService({ sql, eventLog });
    tasks = new TaskService({ sql, eventLog });
    const projects = new ProjectService(sql);
    projectA = (await projects.create({ slug: 'alpha', name: 'Alpha', rootPath: '/tmp/a' })).id;
    projectB = (await projects.create({ slug: 'beta', name: 'Beta', rootPath: '/tmp/b' })).id;
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
  });

  // No cleanup between cases, and that is not an oversight: `escalation_events`
  // is append-only and the guard refuses DELETE, which is exactly the property
  // the last describe block proves. So every case here asks about *its own*
  // escalations — by number — rather than about the state of the whole table.

  function raise(over: Partial<Parameters<EscalationService['raise']>[0]> = {}) {
    return escalations.raise({
      source: 'agent_question',
      question: 'Welchen Zweig nehmen wir?',
      context: 'Es geht um den Integrationszweig des Projekts.',
      urgency: 'P2',
      options: OPTIONS,
      projectId: projectA,
      taskId: null,
      runId: null,
      raisedBy: 'planner',
      ...over,
    });
  }

  describe('Anlegen', () => {
    it('legt einen Eintrag mit §15s Form an und gibt ihm eine dauerhafte Nummer', async () => {
      const item = await raise();
      expect(item.state).toBe('open');
      expect(item.number).toBeGreaterThan(0);
      expect(item.options).toHaveLength(2);
      expect(item.options.filter((o) => o.recommended)).toHaveLength(1);
      expect(item.precedentKey).toBe('welchen zweig nehmen wir');
      expect(item.answeredAt).toBeNull();

      // Über die Nummer auffindbar — das ist das Ziel jedes Deep-Links (§15).
      expect((await escalations.byNumber(item.number))?.id).toBe(item.id);
    });

    it('vergibt Nummern streng aufsteigend', async () => {
      const first = await raise();
      const second = await raise({ question: 'Und was ist mit den Tests?' });
      expect(second.number).toBeGreaterThan(first.number);
    });

    it('verweigert eine Eskalation ohne genau eine Empfehlung (§15)', async () => {
      await expect(
        raise({ options: OPTIONS.map((o) => ({ ...o, recommended: false })) }),
      ).rejects.toThrow();
    });

    it('schreibt genau ein Ereignis ins Protokoll, mit Nummer und Quelle', async () => {
      const item = await raise();
      const rows = await sql<Array<{ payload: Record<string, unknown> }>>`
        SELECT payload FROM event_log
        WHERE kind = 'escalation.raised' AND payload ->> 'escalationId' = ${item.id}`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload.number).toBe(item.number);
      expect(rows[0]?.payload.source).toBe('agent_question');
    });
  });

  describe('Beantworten', () => {
    it('nimmt eine gewählte Option und macht daraus eine Entscheidung', async () => {
      const item = await raise();
      const answered = await escalations.answer(item.id, { optionIndex: 1, actor: 'max' });

      expect(answered.state).toBe('answered');
      expect(answered.chosenIndex).toBe(1);
      expect(answered.chosenTitle).toBe('Umbauen');
      expect(answered.answeredBy).toBe('max');
      expect(answered.answeredAt).not.toBeNull();

      const log = await escalations.decisions();
      expect(log.map((d) => d.number)).toContain(item.number);
    });

    it('nimmt reinen Freitext (§15: immer möglich)', async () => {
      const item = await raise({ question: 'Wie weiter mit dem Zweig?' });
      const answered = await escalations.answer(item.id, {
        freeText: 'nimm dev',
        actor: 'dashboard:cred-1',
      });
      expect(answered.chosenIndex).toBeNull();
      expect(answered.chosenTitle).toBeNull();
      expect(answered.freeText).toBe('nimm dev');
      expect(answered.answeredBy).toBe('dashboard:cred-1');
    });

    it('verweigert eine zweite Antwort', async () => {
      const item = await raise({ question: 'Einmal und nicht mehr?' });
      await escalations.answer(item.id, { optionIndex: 0, actor: 'max' });
      await expect(escalations.answer(item.id, { optionIndex: 1, actor: 'max' })).rejects.toThrow(
        /bereits beantwortet/,
      );
    });

    it('verweigert eine zweite Antwort auch an der Datenbank vorbei am Dienst', async () => {
      // Die Prüfung im Dienst ist die freundliche Hälfte; die tragende ist der
      // partielle Unique-Index. Ein späterer Aufrufer mit eigener Transaktion
      // ginge an der ersten vorbei und muss an der zweiten scheitern.
      const item = await raise({ question: 'Und wer hält das wirklich?' });
      await escalations.answer(item.id, { optionIndex: 0, actor: 'max' });
      await expect(sql`
        INSERT INTO escalation_events (escalation_id, seq, kind, actor, payload)
        VALUES (${item.id}, 3, 'answered', 'max', '{"optionIndex": 1}'::jsonb)
      `).rejects.toThrow();
    });

    it('verweigert eine Option, die es nicht gibt', async () => {
      const item = await raise({ question: 'Gibt es Option sieben?' });
      await expect(escalations.answer(item.id, { optionIndex: 7, actor: 'max' })).rejects.toThrow(
        /Option 7/,
      );
      expect((await escalations.get(item.id))?.state).toBe('open');
    });

    it('verweigert eine Antwort auf eine Eskalation, die es nicht gibt', async () => {
      await expect(
        escalations.answer('00000000-0000-0000-0000-000000000000', {
          optionIndex: 0,
          actor: 'max',
        }),
      ).rejects.toThrow(/existiert nicht/);
    });
  });

  describe('Postfach', () => {
    it('zeigt Offenes nach Dringlichkeit, bei Gleichstand das Ältere zuerst', async () => {
      const before = await escalations.countOpen();
      const alt = await raise({ urgency: 'P2', question: 'Ältere Frage mittlerer Dringlichkeit?' });
      const neu = await raise({ urgency: 'P2', question: 'Neuere Frage mittlerer Dringlichkeit?' });
      const dringend = await raise({ urgency: 'P0', question: 'Brennt es hier?' });

      const mine = new Set([alt.number, neu.number, dringend.number]);
      const numbers = (await escalations.open())
        .filter((e) => mine.has(e.number))
        .map((e) => e.number);
      // P0 vor P2, und innerhalb von P2 das Ältere zuerst — ein Eintrag, der
      // seit drei Tagen wartet, darf nicht unter einem von heute Früh versinken.
      expect(numbers).toEqual([dringend.number, alt.number, neu.number]);
      expect(await escalations.countOpen()).toBe(before + 3);

      await escalations.answer(dringend.id, { optionIndex: 0, actor: 'max' });
      expect(await escalations.countOpen()).toBe(before + 2);
      expect((await escalations.open()).map((e) => e.number)).not.toContain(dringend.number);
    });

    it('nennt zu einer Aufgabe die offene Frage, auf der sie steht', async () => {
      const taskId = await taskRow();
      expect(await escalations.openForTask(taskId)).toBeNull();

      const item = await raise({ taskId, question: 'Woran hängt diese Aufgabe?' });
      expect((await escalations.openForTask(taskId))?.number).toBe(item.number);
      expect((await escalations.forTask(taskId)).map((e) => e.number)).toEqual([item.number]);

      await escalations.answer(item.id, { optionIndex: 0, actor: 'max' });
      expect(await escalations.openForTask(taskId)).toBeNull();
      // Beantwortet heißt nicht verschwunden: die Spur bleibt.
      expect(await escalations.forTask(taskId)).toHaveLength(1);
    });
  });

  describe('Policy-Memory (§15)', () => {
    it('findet dieselbe Frage wieder, in anderer Schreibweise gestellt', async () => {
      const item = await raise({ question: 'Dürfen wir `zod` einsetzen?' });
      expect(
        await escalations.precedentFor({
          question: 'dürfen wir zod einsetzen',
          projectId: projectA,
        }),
      ).toBeNull();

      await escalations.answer(item.id, { optionIndex: 0, actor: 'max' });
      const precedent = await escalations.precedentFor({
        question: '  Dürfen wir zod einsetzen  ',
        projectId: projectA,
      });
      expect(precedent?.number).toBe(item.number);
      expect(precedent?.chosenTitle).toBe('So lassen');
    });

    it('findet eine *andere* Frage nicht', async () => {
      const item = await raise({ question: 'Dürfen wir eine Bibliothek einsetzen?' });
      await escalations.answer(item.id, { optionIndex: 0, actor: 'max' });
      expect(
        await escalations.precedentFor({
          question: 'Dürfen wir keine Bibliothek einsetzen?',
          projectId: projectA,
        }),
      ).toBeNull();
    });

    it('trägt eine Projektentscheidung nicht in ein anderes Projekt', async () => {
      const item = await raise({ question: 'Welcher Zweig ist der Integrationszweig?' });
      await escalations.answer(item.id, { optionIndex: 0, actor: 'max' });

      expect(
        (await escalations.precedentFor({ question: item.question, projectId: projectA }))?.number,
      ).toBe(item.number);
      expect(
        await escalations.precedentFor({ question: item.question, projectId: projectB }),
      ).toBeNull();
      expect(
        await escalations.precedentFor({ question: item.question, projectId: null }),
      ).toBeNull();
    });

    it('trägt eine projektlose Entscheidung überallhin — sie ist global', async () => {
      const item = await raise({ projectId: null, question: 'Gilt das überall?' });
      await escalations.answer(item.id, { optionIndex: 0, actor: 'max' });

      for (const scope of [projectA, projectB, null]) {
        expect(
          (await escalations.precedentFor({ question: item.question, projectId: scope }))?.number,
        ).toBe(item.number);
      }
    });

    it('macht aus dem roten Pfad keinen Präzedenzfall', async () => {
      // §9s Frage nennt eine Aufgabe beim Namen. Wäre sie wiederverwendbar,
      // bräche eine später gleich betitelte Aufgabe *automatisch* ab, weil der Betreiber
      // einmal "abbrechen" gesagt hat. `POLICY_MEMORY_SOURCES` schließt das aus.
      const item = await raise({
        source: 'task_red',
        question: 'Aufgabe „Cache reparieren“ ist zweimal gescheitert — wie weiter?',
        raisedBy: 'orchestrator',
      });
      await escalations.answer(item.id, { optionIndex: 1, actor: 'max' });

      // Als Entscheidung ist sie da …
      expect((await escalations.decisions()).map((d) => d.number)).toContain(item.number);
      // … als Präzedenzfall nicht.
      expect(
        await escalations.precedentFor({ question: item.question, projectId: projectA }),
      ).toBeNull();
      expect(POLICY_MEMORY_SOURCES).not.toContain('task_red');
    });

    it('nimmt die jüngste Entscheidung, wenn der Betreiber seine Meinung geändert hat', async () => {
      const question = 'Läuft der Linter über scripts?';
      const first = await raise({ question });
      await escalations.answer(first.id, { optionIndex: 0, actor: 'max' });
      const second = await raise({ question });
      await escalations.answer(second.id, { optionIndex: 1, actor: 'max' });

      const precedent = await escalations.precedentFor({ question, projectId: projectA });
      expect(precedent?.number).toBe(second.number);
      expect(precedent?.chosenTitle).toBe('Umbauen');
    });

    it('legt für eine Frage ohne Schlüssel gar keinen Schlüssel ab', async () => {
      // Der gefährlichste Wert im ganzen Modul. Zwei Fragen, aus denen bei der
      // Normalisierung nichts übrig bleibt, hätten beide den Schlüssel '' — und
      // eine Suche danach träfe sie gegenseitig. Die Karte trägt deshalb NULL,
      // und NULL trifft in SQL nichts, auch sich selbst nicht.
      const stumm = await raise({ question: '???' });
      expect(stumm.precedentKey).toBeNull();
      await escalations.answer(stumm.id, { optionIndex: 0, actor: 'max' });

      // Dieselbe leere Normalisierung, andere Frage: darf nicht treffen.
      expect(await escalations.precedentFor({ question: '***', projectId: projectA })).toBeNull();
      expect(await escalations.precedentFor({ question: '???', projectId: projectA })).toBeNull();
      expect(await escalations.relatedTo({ question: '   ', projectId: projectA })).toEqual([]);
    });

    it('hängt ähnliche frühere Entscheidungen an die Karte, ohne sie zu beantworten', async () => {
      const earlier = await raise({ question: 'Darf Vorschicht auf dev schreiben?' });
      await escalations.answer(earlier.id, { optionIndex: 0, actor: 'max' });

      const item = await raise({ question: 'Darf Vorschicht auf dev wirklich schreiben?' });
      expect(item.state).toBe('open');
      expect(item.related.map((r) => r.number)).toContain(earlier.number);
      expect(item.related[0]?.summary).toContain(`Entscheidung #${earlier.number}`);
    });

    it('nennt eine unähnliche Entscheidung nicht als verwandt', async () => {
      const earlier = await raise({ question: 'Wann läuft die nächtliche Sicherung?' });
      await escalations.answer(earlier.id, { optionIndex: 0, actor: 'max' });
      const item = await raise({ question: 'Welche Modellstufe bekommt der Reviewer?' });
      expect(item.related).toEqual([]);
    });
  });

  /**
   * The two source-filtered queries, as the very first statement a pool ever
   * runs.
   *
   * Every case above warms the connection long before it gets here — `beforeAll`
   * creates two projects — and that is exactly what hid the defect this guards:
   * `sql.array()` without an explicit element type only serialises correctly
   * once the driver has learned that type from the server, so cold it sent a
   * scalar and Postgres answered `op ANY/ALL (array) requires array on right
   * side`. Green in every suite, red on a daemon's first escalation.
   *
   * So the pool has to be genuinely cold, which is why this opens its own —
   * against the same database, so the rows the cases above left behind are
   * still there and `relatedTo` has something to scan.
   */
  describe('Kalte Verbindung', () => {
    it('beantwortet Präzedenz- und Ähnlichkeitssuche als allererste Anweisung', async () => {
      const cold = createSql({ url: database.url, max: 1 });
      try {
        const service = new EscalationService({ sql: cold, eventLog: new EventLog(cold) });
        // First statement on this pool, deliberately. Anything before it — even
        // a `SELECT 1` — would make the case prove nothing.
        await expect(
          service.relatedTo({ question: 'Welchen Zweig nehmen wir?', projectId: projectA }),
        ).resolves.toBeInstanceOf(Array);
        await expect(
          service.precedentFor({ question: 'Welchen Zweig nehmen wir?', projectId: projectA }),
        ).resolves.not.toBeUndefined();
      } finally {
        await cold.end({ timeout: 5 });
      }
    });
  });

  describe('Append-only (§5, §18)', () => {
    it('lässt weder UPDATE noch DELETE noch TRUNCATE zu', async () => {
      const item = await raise({ question: 'Bleibt das stehen?' });
      await escalations.answer(item.id, { optionIndex: 0, actor: 'max' });

      await expect(sql`UPDATE escalation_events SET actor = 'jemand anders'`).rejects.toThrow(
        /append-only/i,
      );
      await expect(sql`DELETE FROM escalation_events`).rejects.toThrow(/append-only/i);
      await expect(sql`TRUNCATE escalation_events`).rejects.toThrow();

      expect((await escalations.get(item.id))?.answeredBy).toBe('max');
    });

    it('lässt keine Antwort ohne Frage zu', async () => {
      // Sonst projizierte die Sicht eine Entscheidung über nichts.
      await expect(sql`
        INSERT INTO escalation_events (escalation_id, seq, kind, actor, payload)
        VALUES (gen_random_uuid(), 1, 'answered', 'max', '{}'::jsonb)
      `).rejects.toThrow();
    });

    it('lässt keine zweite Frage in derselben Eskalation zu', async () => {
      const item = await raise({ question: 'Nur eine Frage je Karte?' });
      await expect(sql`
        INSERT INTO escalation_events (escalation_id, seq, kind, actor, number, payload)
        VALUES (${item.id}, 2, 'raised', 'planner', nextval('escalation_number_seq'), '{}'::jsonb)
      `).rejects.toThrow();
    });
  });

  describe('zwei gleichzeitige Antworten (§15, A77.8)', () => {
    /**
     * Der echte Wettlauf — **nichts wird injiziert**.
     *
     * Der Dienst prüft vor dem Schreiben, ob schon geantwortet wurde, und diese
     * Prüfung liegt außerhalb jeder Transaktion. Zwei Aufrufer kommen also beide
     * durch, und was den zweiten aufhält, ist der partielle Unique-Index — nicht
     * der Dienst. Der Unterschied war lange folgenlos, weil ein Test den
     * `EscalationError` selbst hineingab; ein echter Verstoß kommt aber als
     * `PostgresError` mit `code === '23505'` und wäre bis in die HTTP-Schicht
     * durchgeschlagen (dort: Klartext-500 statt 409, weil es kein `onError` gibt).
     *
     * Zwanzig Runden, weil ein Wettlauf nicht jedes Mal stattfindet. Die letzte
     * Zusicherung ist die, die den Test ehrlich macht: **mindestens einmal** muss
     * die Ablehnung wirklich von der Datenbank gekommen sein. Ohne sie bestünde
     * er auch dann, wenn ausschließlich die Vorprüfung gefeuert hätte — und dann
     * prüfte er die Zeile nicht, um die es geht.
     */
    it('übersetzt ihn in einen Konflikt statt in einen Datenbankfehler', async () => {
      let ausDerDatenbank = 0;

      for (let runde = 0; runde < 20; runde += 1) {
        const item = await raise({ question: `Wer gewinnt Runde ${runde}?` });

        const [a, b] = await Promise.allSettled([
          escalations.answer(item.id, { optionIndex: 0, actor: 'max' }),
          escalations.answer(item.id, { optionIndex: 1, actor: 'dashboard:zweiter-tab' }),
        ]);

        const erfuellt = [a, b].filter((e) => e.status === 'fulfilled');
        const abgelehnt = [a, b].filter((e) => e.status === 'rejected');
        expect(erfuellt).toHaveLength(1);
        expect(abgelehnt).toHaveLength(1);

        const grund = (abgelehnt[0] as PromiseRejectedResult).reason;
        expect(grund).toBeInstanceOf(EscalationError);
        expect((grund as EscalationError).kind).toBe('conflict');

        if ((grund as { cause?: { code?: string } }).cause?.code === '23505') {
          ausDerDatenbank += 1;
        }

        // Und die Karte trägt genau eine Antwort — ein Konflikt ist kein
        // halber Schreibvorgang.
        const danach = await escalations.get(item.id);
        expect(danach?.state).toBe('answered');
      }

      // Der Beleg, dass die Schleife die Datenbank erreicht hat und nicht bloß
      // die freundliche Hälfte. Bei Flackern gehören hier mehr Runden hin, nicht
      // eine schwächere Zusicherung.
      expect(ausDerDatenbank).toBeGreaterThan(0);
    });
  });

  /**
   * A task to hang an escalation on.
   *
   * Through the real service rather than a hand-written INSERT: the task log
   * has rules of its own (A43 — the first event is `seq` 0, and the trigger
   * says so), and a fixture that encodes them here would be a second copy of
   * somebody else's schema that breaks the day it changes.
   */
  async function taskRow(): Promise<string> {
    const task = await tasks.create({ projectId: projectA, title: 'Irgendeine Aufgabe' });
    return task.id;
  }
});
