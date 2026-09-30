/**
 * Die Abfragen der Kennzahlen-Erhebung gegen eine echte Postgres.
 *
 * Was hier geprüft wird und in `aggregate.test.ts` nicht geprüft werden kann,
 * ist genau eine Sache: **dass die Abfragen dieselben Zeilen lesen, die das
 * Studio schreibt.** Die Rechenregeln sind dort abgedeckt; hier geht es um die
 * Naht dazwischen, und die ist die, an der dieses Projekt sich mehrfach die
 * Finger verbrannt hat — A81s Posteingang, in dem beide Hälften für sich
 * richtig waren und keine Zeile ankam.
 *
 * Deshalb werden drei der vier Familien von ihren **echten Erzeugern**
 * geschrieben und nicht von einer Fixture:
 *
 *  - `task.state_changed` von `TaskService.transition` — die Kennzahl liest
 *    `payload ->> 'to'`, und ob dieser Schlüssel so heisst, entscheidet allein
 *    der Erzeuger.
 *  - `escalation.raised` / `escalation.answered` von `EscalationService` — der
 *    Bestand paart über `payload ->> 'escalationId'`.
 *  - `usage_samples` von `UsageMeter` mit injizierter Uhr, **einschliesslich
 *    des `unavailable`-Sentinels**: dass er `used_percent = 0` trägt, ist die
 *    Annahme, an der ein gemittelter Wochenbericht zerbräche, und sie wird
 *    hier vom Erzeuger selbst hergestellt statt von einer Zeile, die ich
 *    hinschreibe.
 *
 * Die vierte Familie — `gate.finished`, `merge.finished`, `deploy.*` — wird
 * über `event_log` gesät, weil ihre Erzeuger ein git-Repository, einen
 * Docker-Daemon und eine Modellsitzung brauchen. Das ist eine benannte Grenze
 * und keine Bequemlichkeit: die Nutzlasten sind aus `merge-queue.ts`
 * (`summarise()`, `merge.finished`) und `deploy/service.ts` abgeschrieben, und
 * ein Erzeuger, der seine Schlüssel umbenennt, fällt hier **nicht** auf. Wo
 * das billig zu schliessen war, ist es geschlossen; wo nicht, steht es hier.
 *
 * Zeitfenster: jeder Block bekommt sein eigenes, disjunktes. Die Abfragen sind
 * global (kein Projektfilter, siehe `metrics.ts`), also wäre ein geteiltes
 * Fenster ein geteilter Zustand — und ein Fall, der nur besteht, wenn seine
 * Nachbarn vorher liefen, meldet am entscheidenden Tag den falschen Defekt
 * (A110s Fund, hier vorweggenommen).
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EscalationService } from '../escalation-service.js';
import { EventLog } from '../event-log.js';
import { ProjectService } from '../project-service.js';
import { TaskService } from '../task-service.js';
import { UsageMeter } from '../usage-meter.js';
import { weeklyUtilisation } from './budget.js';
import { MetricsService } from './service.js';
import type { MetricsWindow } from './window.js';

const url = process.env.TEST_DATABASE_URL;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Ein Fenster von einer Woche ab dem gegebenen ISO-Zeitpunkt. */
function week(fromIso: string): MetricsWindow {
  const from = new Date(fromIso);
  return { from, to: new Date(from.getTime() + 7 * DAY) };
}

const THROUGHPUT = week('2026-01-05T00:00:00.000Z');
const GATES = week('2026-02-02T00:00:00.000Z');
const BUDGET = week('2026-03-02T00:00:00.000Z');

function uuid(n: number): string {
  const tail = String(n).padStart(12, '0');
  return `00000000-0000-4000-8000-${tail}`;
}

describe.skipIf(!url)('Kennzahlen-Erhebung über das Ereignisprotokoll (§16, §22 Phase 8)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let metrics: MetricsService;
  let tasks: TaskService;
  let escalations: EscalationService;
  let projectId: string;

  beforeAll(async () => {
    database = await createTestDatabase('metrics');
    sql = createSql({ url: database.url, max: 4 });
    const eventLog = new EventLog(sql);
    tasks = new TaskService({ sql, eventLog });
    escalations = new EscalationService({ sql, eventLog });
    metrics = new MetricsService({ sql });
    const projects = new ProjectService(sql);
    projectId = (
      await projects.create({ slug: 'kennzahlen', name: 'Kennzahlen', rootPath: '/tmp/kennzahlen' })
    ).id;
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
  });

  /**
   * Eine Zeile mit gewähltem Zeitpunkt.
   *
   * `EventLog.append` setzt `occurred_at` auf `now()` und bietet keinen Weg,
   * das zu übersteuern — für eine Fensterprüfung ist ein steuerbarer Zeitpunkt
   * aber die halbe Aussage. Geschrieben wird trotzdem in dieselbe Tabelle mit
   * denselben Spalten; was fehlt, ist der Erzeuger, und das steht im Kopf.
   */
  async function logEvent(
    at: Date,
    kind: string,
    payload: Record<string, unknown>,
    taskId: string | null = null,
  ): Promise<void> {
    await sql`
      INSERT INTO event_log (occurred_at, kind, actor, project_id, task_id, payload)
      VALUES (${at}, ${kind}, 'orchestrator', ${projectId}, ${taskId},
              ${sql.json(payload as never)})`;
  }

  /** Ein `gate.finished`, in der Form, die `summarise()` in `merge-queue.ts` schreibt. */
  async function gateRun(
    at: Date,
    taskId: string,
    steps: Array<{ id: string; verdict: string }>,
  ): Promise<void> {
    await logEvent(
      at,
      'gate.finished',
      {
        stage: 'merge_queue',
        // Absichtlich mitgeschrieben und absichtlich nicht gelesen: das Urteil
        // kommt aus den Schritten (`gate-runs.ts`, Entscheidung 1).
        ok: steps.every((step) => step.verdict === 'green'),
        durationMs: 1_000,
        steps: steps.map((step) => ({ ...step, detail: 'egal', exitCode: null, attempts: 1 })),
      },
      taskId,
    );
  }

  describe('Durchsatz (§16.1)', () => {
    it('zählt Aufgaben, Merges, Rollouts und Rollbacks getrennt und nur im Fenster', async () => {
      const inside = new Date(THROUGHPUT.from.getTime() + 2 * DAY);
      const before = new Date(THROUGHPUT.from.getTime() - MINUTE);
      // Genau auf der oberen Grenze: gehört in den nächsten Bericht, sonst
      // stünde ein Merge in zwei Wochen (halboffenes Fenster, `window.ts`).
      const onUpperEdge = THROUGHPUT.to;

      await logEvent(inside, 'task.state_changed', { from: 'deploying', to: 'done' }, uuid(1));
      await logEvent(inside, 'task.state_changed', { from: 'merging', to: 'done' }, uuid(2));
      await logEvent(before, 'task.state_changed', { from: 'merging', to: 'done' }, uuid(3));
      await logEvent(onUpperEdge, 'task.state_changed', { from: 'merging', to: 'done' }, uuid(4));
      // Ein Zustandswechsel, der kein Abschluss ist: darf keine der vier Zahlen
      // bewegen. Ohne diesen Fall bestünde die Abfrage auch dann, wenn sie
      // `payload ->> 'to'` gar nicht läse.
      await logEvent(inside, 'task.state_changed', { from: 'queued', to: 'planning' }, uuid(5));

      await logEvent(inside, 'merge.finished', { branch: 'vorschicht/task-1' }, uuid(1));
      await logEvent(before, 'merge.finished', { branch: 'vorschicht/task-3' }, uuid(3));
      await logEvent(inside, 'deploy.succeeded', { deploymentId: uuid(9), method: 'compose' });
      await logEvent(inside, 'deploy.rolled_back', { deploymentId: uuid(10), problem: 'HTTP 503' });
      await logEvent(inside, 'deploy.rolled_back', { deploymentId: uuid(11), problem: 'HTTP 503' });
      // Die dritte Klasse: gescheitert und **nicht** zurückgerollt. Sie war bis
      // zum 18.8.2026 aus dem Ereignisprotokoll gar nicht zählbar, weil der
      // Fehlerpfad von `DeployService` keine Zeile schrieb. Dieses Modul hat
      // die Lücke benannt statt die Zahl zu schätzen, woraufhin sie geschlossen
      // wurde; hier steht die Gegenprobe.
      await logEvent(inside, 'deploy.failed', {
        deploymentId: uuid(12),
        serving: 'broken',
        problem: 'HTTP 503',
      });
      // Ausserhalb des Fensters, damit die Zahl nicht auch dann stimmt, wenn
      // die Fensterprüfung für diese eine Art fehlt.
      await logEvent(before, 'deploy.failed', {
        deploymentId: uuid(13),
        serving: 'unknown',
        problem: 'abgestürzt',
      });

      const headline = await metrics.headline(THROUGHPUT);
      expect(headline.throughput).toEqual({
        tasksDone: 2,
        merges: 1,
        deploys: 1,
        // §16.1 verlangt „deploys (+rollbacks)" getrennt — eine gemeinsame
        // Zahl beantwortete „wie oft haben wir zurückgerollt" mit etwas
        // anderem (A91s Lehre über ein falsches Etikett). Und aus demselben
        // Grund zählt `failedDeploys` eigenständig: ein Rollout, der nicht
        // zurückgerollt werden konnte, ist kein Rollback.
        rollbacks: 2,
        failedDeploys: 1,
      });
      expect(headline.window).toEqual({
        from: THROUGHPUT.from.toISOString(),
        to: THROUGHPUT.to.toISOString(),
      });
    });
  });

  describe('Gate-Läufe (§16.1 und §16.3)', () => {
    it('liefert Durchlaufquote, Funde je Gate und Zeit-bis-grün aus denselben Zeilen', async () => {
      const t1 = uuid(101);
      const t2 = uuid(102);
      const start = GATES.from.getTime();

      // t1: Fund im Fenster, grün 45 Minuten später.
      await gateRun(new Date(start + HOUR), t1, [
        { id: 'test', verdict: 'finding' },
        { id: 'lint', verdict: 'green' },
      ]);
      await gateRun(new Date(start + HOUR + 45 * MINUTE), t1, [
        { id: 'test', verdict: 'green' },
        { id: 'lint', verdict: 'green' },
      ]);
      // t2: Fund kurz vor Fensterende, grün **nach** dem Fenster. Zählt, weil
      // die Auflösung nach `to` liegen darf und der Fund davor liegt.
      await gateRun(new Date(GATES.to.getTime() - 10 * MINUTE), t2, [
        { id: 'sast', verdict: 'finding' },
      ]);
      await gateRun(new Date(GATES.to.getTime() + 2 * HOUR), t2, [
        { id: 'sast', verdict: 'green' },
      ]);
      // Ein reiner infra-Lauf: nichts geprüft (A25), also weder Zähler noch
      // Nenner der Quote.
      await gateRun(new Date(start + 2 * HOUR), t1, [{ id: 'secrets', verdict: 'infra' }]);

      const { headline, quality } = await metrics.collect(GATES);

      expect(headline.gates).toMatchObject({
        passed: 1,
        failed: 2,
        inconclusive: 1,
        unreadable: 0,
      });
      expect(headline.gates.rate.value).toBeCloseTo(1 / 3, 10);

      expect(quality.findingsByGate).toEqual([
        { gateId: 'sast', findings: 1, tasks: 1 },
        { gateId: 'test', findings: 1, tasks: 1 },
      ]);

      expect(quality.timeToGreen.resolved).toBe(2);
      expect(quality.timeToGreen.stillOpen).toBe(0);
      // Rangwert ohne Interpolation: der untere der beiden Werte.
      expect(quality.timeToGreen.medianMs.value).toBe(45 * MINUTE);
      expect(quality.timeToGreen.slowest?.gateId).toBe('sast');
      expect(quality.timeToGreen.slowest?.durationMs).toBe(2 * HOUR + 10 * MINUTE);
    });
  });

  describe('Budget (§16.1) — aus usage_samples, geschrieben vom echten Zähler', () => {
    it('mittelt die Messungen und lässt den unavailable-Sentinel heraus', async () => {
      const at = BUDGET.from.getTime() + DAY;
      let clock = at;
      const meter = new UsageMeter({ sql, now: () => clock });

      // Zwei echte Ablesungen im Wochenfenster: 0,40 und 0,90 als Anteil
      // (A73s `rate_limit_event`-Form), also 40 % und 90 %.
      await meter.ingestOfficialWindow('seven_day', 0.4);
      clock += MINUTE;
      await meter.ingestOfficialWindow('seven_day', 0.9);
      clock += MINUTE;
      // Eine Schätzung derselben Woche (§7.1s Rückfallzähler).
      await meter.ingestEstimate('seven_day', 20);
      clock += MINUTE;
      // Und der Sentinel — vom Erzeuger, nicht von Hand: `rate_limits` fehlt,
      // also schreibt `ingestOfficial` eine Zeile mit `used_percent = 0`. Sie
      // mitzumitteln machte aus einer blinden Woche die ruhigste des Jahres.
      await meter.ingestOfficial({ rate_limits_available: false, rate_limits: null });
      clock += MINUTE;
      await meter.ingestOfficial({ rate_limits_available: false, rate_limits: null });

      const headline = await metrics.headline(BUDGET);
      const woche = weeklyUtilisation(headline.budget);

      expect(headline.budget.source).toBe('usage_samples');
      expect(woche?.samples).toBe(3);
      expect(woche?.blindSamples).toBe(0);
      // (40 + 90 + 20) / 3 = 50. Mit den beiden Nullen wären es 30.
      expect(woche?.average.value).toBeCloseTo(50, 6);
      expect(woche?.peak.value).toBeCloseTo(90, 6);
      expect(woche?.bySource).toEqual({ official: 2, estimated: 1 });

      // Der Sentinel wird als `five_hour` geschrieben (so tut es der Zähler),
      // taucht also in dessen Zeile auf — gezählt, ohne Mittelwert.
      const fuenfStunden = headline.budget.windows.find(
        (entry) => entry.windowKind === 'five_hour',
      );
      expect(fuenfStunden?.blindSamples).toBe(2);
      expect(fuenfStunden?.samples).toBe(0);
      expect(fuenfStunden?.average).toEqual({ value: null, unknownReason: 'inconclusive' });
    });

    it('meldet ein Fenster ohne jede Messung als no_data statt als 0 %', async () => {
      const leer = week('2026-04-06T00:00:00.000Z');
      const headline = await metrics.headline(leer);
      expect(headline.budget.windows).toEqual([]);
      expect(headline.budget.unknownReason).toBe('no_data');
    });
  });

  describe('Die echten Erzeuger — die Naht, die keine Fixture prüfen kann', () => {
    it('liest die Zustandswechsel, die TaskService wirklich schreibt', async () => {
      const now = Date.now();
      const fenster: MetricsWindow = { from: new Date(now - HOUR), to: new Date(now + HOUR) };

      const fertig = await tasks.create({ projectId, title: 'Wird fertig', priority: 'P2' });
      for (const state of ['planning', 'claimed', 'coding', 'review', 'gates'] as const) {
        await tasks.transition(fertig.id, state, { actor: 'orchestrator' });
      }
      await tasks.transition(fertig.id, 'merge_queue', { actor: 'orchestrator' });
      await tasks.transition(fertig.id, 'merging', { actor: 'orchestrator' });
      await tasks.transition(fertig.id, 'done', { actor: 'orchestrator' });

      const rot = await tasks.create({ projectId, title: 'Wird rot', priority: 'P2' });
      await tasks.transition(rot.id, 'planning', { actor: 'orchestrator' });
      await tasks.transition(rot.id, 'red', { actor: 'orchestrator', reason: 'Gate rot' });

      const { headline, quality } = await metrics.collect(fenster);

      // Wenn `task-service.ts` den Schlüssel `to` je umbenennt, fallen beide
      // Zusicherungen — und zwar hier und nicht erst im Wochenbericht.
      expect(headline.throughput.tasksDone).toBe(1);
      expect(quality.redRate).toMatchObject({ tasksRed: 1, tasksConcluded: 2 });
      expect(quality.redRate.rate.value).toBeCloseTo(0.5, 10);
    });

    it('liest den Bestand offener Entscheidungen so, wie EscalationService ihn schreibt', async () => {
      const options = [
        { title: 'So lassen', pros: ['billig'], cons: ['langsam'], recommended: true },
        { title: 'Umbauen', pros: ['schnell'], cons: ['teuer'], recommended: false },
      ];
      const beantwortet = await escalations.raise({
        source: 'agent_question',
        question: 'Nehmen wir Zweig A oder Zweig B?',
        context: 'Der Integrationszweig des Projekts ist nicht eindeutig.',
        urgency: 'P2',
        options,
        projectId,
        taskId: null,
        runId: null,
        raisedBy: 'planner',
      });
      await escalations.answer(beantwortet.id, {
        actor: 'max',
        optionIndex: 0,
        freeText: null,
      });
      await escalations.raise({
        source: 'agent_question',
        question: 'Soll das Gate für Lizenzen an?',
        context: 'Das Projekt bringt fremde Abhängigkeiten mit.',
        urgency: 'P3',
        options,
        projectId,
        taskId: null,
        runId: null,
        raisedBy: 'planner',
      });

      const now = Date.now();
      const headline = await metrics.headline({
        from: new Date(now - HOUR),
        to: new Date(now + HOUR),
      });
      expect(headline.escalations).toEqual({ answered: 1, open: 1 });
    });

    it('zählt eine Karte am Fensterende noch als offen, wenn die Antwort danach kam', async () => {
      // Der Bestand ist ein Zeitpunktwert (Entscheidung 5 in `service.ts`):
      // ein Bericht über die Vorwoche darf nicht davon abhängen, wann er
      // gelesen wird. Die beiden Zeilen tragen deshalb gewählte Zeitpunkte.
      const fenster = week('2026-05-04T00:00:00.000Z');
      const spaet = uuid(201);
      await logEvent(new Date(fenster.from.getTime() + DAY), 'escalation.raised', {
        escalationId: spaet,
        number: '4711',
        source: 'agent_question',
      });
      await logEvent(new Date(fenster.to.getTime() + DAY), 'escalation.answered', {
        escalationId: spaet,
        number: '4711',
        source: 'agent_question',
      });

      const headline = await metrics.headline(fenster);
      expect(headline.escalations.answered).toBe(0);
      expect(headline.escalations.open).toBe(1);

      // Und eine Woche später ist dieselbe Karte weder offen noch in diesem
      // Fenster beantwortet worden — sie wurde es im nächsten.
      const naechste = week('2026-05-11T00:00:00.000Z');
      const danach = await metrics.headline(naechste);
      expect(danach.escalations.answered).toBe(1);
      expect(danach.escalations.open).toBe(0);
    });
  });

  describe('Fenster', () => {
    it('weist ein Fenster ohne Dauer zurück, statt es als ruhig zu beantworten', async () => {
      const jetzt = new Date();
      await expect(metrics.collect({ from: jetzt, to: jetzt })).rejects.toThrow(RangeError);
      await expect(
        metrics.headline({ from: jetzt, to: new Date(jetzt.getTime() - HOUR) }),
      ).rejects.toThrow(RangeError);
    });
  });
});
