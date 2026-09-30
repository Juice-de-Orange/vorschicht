/**
 * Die Erhebung des Wochenberichts gegen eine echte Postgres.
 *
 * `generator.test.ts` prüft die Struktur, die Längengrenze und die Sätze; hier
 * geht es um die eine Frage, die ohne Datenbank nicht zu beantworten ist:
 * **lesen die vier eigenen Abfragen dieselben Zeilen, die das Studio
 * schreibt?** Das ist die Naht, an der A81 einmal einen ganzen Posteingang
 * verloren hat — beide Hälften für sich richtig, und keine Zeile kam an.
 *
 * Was von **echten Erzeugern** kommt und was gesät wird, und warum:
 *
 *  - `TaskService.create` schreibt die Aufgaben. §16.2 liest den Titel über
 *    `JOIN tasks t ON t.id = e.task_id`, und ob dieser Titel dort überhaupt
 *    ankommt, entscheidet allein der Erzeuger (er liegt in der Nutzlast des
 *    `created`-Ereignisses, nicht in einer Spalte). §16.6 liest dieselbe Sicht.
 *  - `MetricsService` ist der echte Dienst, nicht eine Attrappe — `collect()`
 *    ist die Abhängigkeit, die der Generator strukturell deklariert.
 *  - `ReportRecords.record()` nimmt am Ende, was `generate()` liefert. Das ist
 *    die einzige Prüfung, die belegt, dass Erzeuger und Archiv **wirklich**
 *    zusammenpassen und nicht nur beide für sich richtig sind.
 *  - `event_log`, `audit_events` und `audit_finding_events` werden roh gesät.
 *    Benannte Grenze, keine Bequemlichkeit: die Erzeuger brauchen ein
 *    git-Repository, einen Docker-Daemon und eine Modellsitzung. Die
 *    Nutzlasten sind aus `RadarScan.record()`, `merge-queue.ts` und
 *    `deploy/service.ts` abgeschrieben — benennt einer seine Schlüssel um,
 *    fällt es hier **nicht** auf.
 *
 * Zeitfenster: jeder Block bekommt sein eigenes, disjunktes. §16.6 hat als
 * einziger Abschnitt **kein** Fenster (er fragt nach dem Bestand), also legt
 * der Projektblock seine Aufgaben ausdrücklich als `draft` an — sonst stünden
 * sie in der Warteschlange des sechsten Abschnitts und ein Fall bestünde nur,
 * solange seine Nachbarn in der richtigen Reihenfolge liefen (A110s Fund).
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventLog } from '../event-log.js';
import { MetricsService, type MetricsWindow } from '../metrics/index.js';
import { ProjectService } from '../project-service.js';
import { TaskService } from '../task-service.js';
import { WeeklyReportGenerator } from './generator.js';
import { ReportRecords } from './records.js';

const url = process.env.TEST_DATABASE_URL;

const DAY = 24 * 60 * 60_000;

function week(fromIso: string): MetricsWindow {
  const from = new Date(fromIso);
  return { from, to: new Date(from.getTime() + 7 * DAY) };
}

const PROJEKTE = week('2026-04-06T00:00:00.000Z');
const RADAR = week('2026-05-04T00:00:00.000Z');
const PRUEFUNG = week('2026-06-01T00:00:00.000Z');
const GANZ = week('2026-07-06T00:00:00.000Z');

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
}

describe.skipIf(!url)('Erhebung des Wochenberichts (§16, §22 Phase 8)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let generator: WeeklyReportGenerator;
  let tasks: TaskService;
  let reports: ReportRecords;
  let erstesProjekt: string;
  let zweitesProjekt: string;

  beforeAll(async () => {
    database = await createTestDatabase('wochenbericht');
    sql = createSql({ url: database.url, max: 4 });
    const eventLog = new EventLog(sql);
    tasks = new TaskService({ sql, eventLog });
    reports = new ReportRecords(sql);
    generator = new WeeklyReportGenerator({ sql, metrics: new MetricsService({ sql }) });
    const projects = new ProjectService(sql);
    erstesProjekt = (
      await projects.create({ slug: 'alpha', name: 'Alpha', rootPath: '/tmp/alpha' })
    ).id;
    zweitesProjekt = (await projects.create({ slug: 'beta', name: 'Beta', rootPath: '/tmp/beta' }))
      .id;
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
  });

  /** Eine Protokollzeile mit gewähltem Zeitpunkt (`EventLog.append` kann das nicht). */
  async function logEvent(
    at: Date,
    kind: string,
    payload: Record<string, unknown>,
    options: { projectId?: string | null; taskId?: string | null } = {},
  ): Promise<void> {
    await sql`
      INSERT INTO event_log (occurred_at, kind, actor, project_id, task_id, payload)
      VALUES (${at}, ${kind}, 'orchestrator',
              ${options.projectId ?? erstesProjekt}, ${options.taskId ?? null},
              ${sql.json(payload as never)})`;
  }

  /**
   * Eine Aufgabe über den echten Erzeuger, absichtlich als `draft`.
   *
   * `draft` und nicht `queued`, damit sie nicht in §16.6s Warteschlange landet
   * — der Abschnitt fragt nach einem Bestand und kennt kein Zeitfenster, also
   * wäre jede hier angelegte Aufgabe dort für immer sichtbar.
   */
  async function entwurf(projectId: string, title: string): Promise<string> {
    const record = await tasks.create({ projectId, title, initialState: 'draft' });
    return record.id;
  }

  describe('§16.2 — je Projekt', () => {
    beforeAll(async () => {
      const t = PROJEKTE.from.getTime();
      // Alpha: drei fertige Aufgaben, zwei Merges, ein Rollout, ein Rollback.
      for (let index = 0; index < 3; index += 1) {
        const taskId = await entwurf(erstesProjekt, `Alpha-Ergebnis ${index}`);
        await logEvent(new Date(t + index * DAY), 'task.state_changed', { to: 'done' }, { taskId });
      }
      await logEvent(new Date(t + DAY), 'merge.finished', { ok: true });
      await logEvent(new Date(t + DAY), 'merge.finished', { ok: true });
      await logEvent(new Date(t + 2 * DAY), 'deploy.succeeded', { sha: 'abc' });
      await logEvent(new Date(t + 3 * DAY), 'deploy.rolled_back', { sha: 'abc' });

      // Beta: eine fertige Aufgabe, nichts sonst.
      const beta = await entwurf(zweitesProjekt, 'Beta-Ergebnis');
      await logEvent(
        new Date(t + DAY),
        'task.state_changed',
        { to: 'done' },
        { projectId: zweitesProjekt, taskId: beta },
      );

      // Ausserhalb des Fensters, eine Millisekunde davor und genau am Ende:
      // beide dürfen nicht mitzählen (das Fenster ist halboffen).
      const davor = await entwurf(erstesProjekt, 'zu früh');
      await logEvent(new Date(t - 1), 'task.state_changed', { to: 'done' }, { taskId: davor });
      const danach = await entwurf(erstesProjekt, 'zu spät');
      await logEvent(PROJEKTE.to, 'task.state_changed', { to: 'done' }, { taskId: danach });
    });

    it('zählt je Projekt getrennt und nur im Fenster', async () => {
      const daten = await generator.collect(PROJEKTE);
      const alpha = daten.projects.find((project) => project.name === 'Alpha');
      const beta = daten.projects.find((project) => project.name === 'Beta');

      expect(alpha).toMatchObject({ tasksDone: 3, merges: 2, deploys: 1, rollbacks: 1 });
      expect(beta).toMatchObject({ tasksDone: 1, merges: 0, deploys: 0, rollbacks: 0 });
      expect(daten.projects).toHaveLength(2);
    });

    it('holt die Titel über die Aufgabensicht, neueste zuerst und je Projekt begrenzt', async () => {
      const daten = await generator.collect(PROJEKTE);
      const alpha = daten.projects.find((project) => project.name === 'Alpha');
      // Neueste zuerst, und höchstens die drei, die §16.2 zulässt — die Grenze
      // gilt **je Projekt**, sonst nähme ein geschwätziges Projekt einem
      // stillen die Zeilen weg.
      expect(alpha?.shipped).toEqual(['Alpha-Ergebnis 2', 'Alpha-Ergebnis 1', 'Alpha-Ergebnis 0']);
      const beta = daten.projects.find((project) => project.name === 'Beta');
      expect(beta?.shipped).toEqual(['Beta-Ergebnis']);
      // Und nichts von ausserhalb des Fensters.
      expect(alpha?.shipped).not.toContain('zu früh');
      expect(alpha?.shipped).not.toContain('zu spät');
    });

    it('nennt im gerenderten Bericht beide Projekte mit ihren Ergebnissen', async () => {
      const bericht = await generator.generate(PROJEKTE);
      expect(bericht.bodyText).toContain('Alpha — 3 Aufgaben, 2 Merges, 1 Deploy, 1 Rollback');
      expect(bericht.bodyText).toContain('Alpha-Ergebnis 2');
      expect(bericht.bodyText).toContain('Beta — 1 Aufgabe, 0 Merges, 0 Deploys');
    });
  });

  describe('§16.4 — Radar', () => {
    beforeAll(async () => {
      const t = RADAR.from.getTime();
      // Die Nutzlast, wie `RadarScan.record()` sie schreibt.
      await logEvent(new Date(t + DAY), 'radar.finished', {
        at: t + DAY,
        reported: ['a'],
        cards: [
          {
            escalationId: uuid(90),
            number: 12,
            key: 'hono@5',
            kind: 'dependency_major',
            projectId: erstesProjekt,
            projectName: 'Alpha',
            name: 'hono',
            current: '4.13.2',
            latest: '5.0.0',
          },
        ],
        tasks: [uuid(91), uuid(92)],
        limits: ['Anthropics Help Center — kein Kanal konfiguriert'],
        problems: [],
        applied: 0,
      });
      await logEvent(new Date(t + 2 * DAY), 'radar.finished', {
        at: t + 2 * DAY,
        reported: [],
        cards: [],
        tasks: [uuid(93)],
        // Dieselbe Grenze ein zweites Mal: sie darf im Bericht nur einmal
        // stehen, sonst füllt eine ruhige Woche mit 28 Läufen den Abschnitt
        // mit 28 gleichen Zeilen.
        limits: ['Anthropics Help Center — kein Kanal konfiguriert'],
        problems: ['Lockfile nicht lesbar'],
        applied: 0,
      });
      // Ausserhalb des Fensters.
      await logEvent(new Date(RADAR.to.getTime() + DAY), 'radar.finished', {
        cards: [{ kind: 'billing', name: 'darf nicht auftauchen', number: 99 }],
        tasks: [],
        limits: [],
        problems: [],
      });
    });

    it('flacht die Karten über die Läufe des Fensters ab und entdoppelt die Grenzen', async () => {
      const daten = await generator.collect(RADAR);
      expect(daten.radar.runs).toBe(2);
      expect(daten.radar.tasks).toBe(3);
      expect(daten.radar.entries).toHaveLength(1);
      expect(daten.radar.entries[0]).toMatchObject({
        kind: 'dependency_major',
        name: 'hono',
        current: '4.13.2',
        latest: '5.0.0',
        escalationNumber: 12,
        // §14s Vertrauensstufe: der Radar vergibt keine, und der Bericht sagt
        // es. Abgeleitet statt behauptet — deshalb ist das Feld da.
        trustLevel: null,
      });
      expect(daten.radar.limits).toEqual(['Anthropics Help Center — kein Kanal konfiguriert']);
      expect(daten.radar.problems).toEqual(['Lockfile nicht lesbar']);
      expect(JSON.stringify(daten.radar)).not.toContain('darf nicht auftauchen');
    });

    it('unterscheidet im Bericht „kein Lauf" von „kein Fund"', async () => {
      const mitLauf = await generator.generate(RADAR);
      expect(mitLauf.bodyText).toContain('2 Radar-Läufe');
      expect(mitLauf.bodyText).not.toContain('Kein Radar-Lauf im Zeitfenster');

      // Ein Fenster, in dem der Radar nie lief: derselbe Abschnitt, anderer
      // Satz — und dieser hier ist ein Befund, kein ruhiger Betrieb.
      const ohneLauf = await generator.generate(week('2026-09-07T00:00:00.000Z'));
      expect(ohneLauf.bodyText).toContain('Kein Radar-Lauf im Zeitfenster');
    });
  });

  describe('§16.5 — Betriebsprüfung', () => {
    const abgeschlossen = uuid(200);
    const abgestuerzt = uuid(201);
    /**
     * Eine Prüfung mit `started` und **ohne** terminale Zeile.
     *
     * Der einzige Fall, in dem `started_at` und `finished_at` als Auswahl
     * wirklich auseinandergehen: 0013s Sicht setzt `finished_at` auch für
     * `failed`, eine sauber gescheiterte Prüfung wäre also über beide Wege
     * sichtbar. Diese hier ist es nur über `started_at` — und sie ist der
     * Fall, für den A56.6 die `started`-Zeile vor dem Spawn schreibt.
     */
    const ohneEnde = uuid(202);

    beforeAll(async () => {
      const t = PRUEFUNG.from.getTime();
      await sql`
        INSERT INTO audit_events (audit_id, seq, occurred_at, kind, payload) VALUES
        (${abgeschlossen}, 0, ${new Date(t + DAY)}, 'started',
         ${sql.json({ domain: 'gate_truth', trigger: 'phase_close', scope: 'Phase 8', sample: [] } as never)}),
        (${abgeschlossen}, 1, ${new Date(t + DAY + 3_600_000)}, 'finished',
         ${sql.json({
           verdict: 'funde_zu_beheben',
           report: '# Prüfbericht',
           reportedSample: [],
           scopeLimits: ['Der Prüfer führt nichts aus.', 'Kein Browser.'],
         } as never)}),
        (${abgestuerzt}, 0, ${new Date(t + 2 * DAY)}, 'started',
         ${sql.json({ domain: 'dead_wiring', trigger: 'weekly', scope: 'Woche', sample: [] } as never)}),
        (${abgestuerzt}, 1, ${new Date(t + 2 * DAY + 60_000)}, 'failed',
         ${sql.json({ problem: 'Sitzung abgebrochen' } as never)}),
        (${ohneEnde}, 0, ${new Date(t + 3 * DAY)}, 'started',
         ${sql.json({ domain: 'test_substance', trigger: 'weekly', scope: 'Woche', sample: [] } as never)})`;

      const funde: Array<[number, string, string, string | null, string | null]> = [
        [300, 'defect', 'Ein echter Defekt.', null, null],
        [301, 'gate_invalid', 'Ein Haken ohne Beleg.', 'P8.G2', null],
        [302, 'suspicion', 'Ein Verdacht.', null, null],
        [303, 'process', 'Eine falsche Belegzeile.', null, 'dismissed'],
      ];
      for (const [n, klasse, summary, gate, status] of funde) {
        await sql`
          INSERT INTO audit_finding_events (finding_id, seq, occurred_at, kind, actor, payload)
          VALUES (${uuid(n)}, 0, ${new Date(t + DAY + 7_200_000)}, 'raised', 'auditor',
                  ${sql.json({
                    auditId: abgeschlossen,
                    domain: 'gate_truth',
                    class: klasse,
                    summary,
                    evidence: 'CLAUDE.md:1',
                    gate,
                  } as never)})`;
        if (status === 'dismissed') {
          await sql`
            INSERT INTO audit_finding_events (finding_id, seq, occurred_at, kind, actor, payload)
            VALUES (${uuid(n)}, 1, ${new Date(t + DAY + 7_300_000)}, 'dismissed', 'orchestrator',
                    ${sql.json({ reason: 'Die Kette widerspricht.' } as never)})`;
        }
      }
    });

    it('liest Urteile, Funde und Prüfgrenzen aus den Sichten', async () => {
      const daten = await generator.collect(PRUEFUNG);
      expect(daten.audit.runs).toBe(3);
      expect(daten.audit.confirmed.map((fund) => fund.class).sort()).toEqual([
        'defect',
        'gate_invalid',
      ]);
      // §8.2 lässt einen Verdacht nichts blockieren, und ein verworfener Fund
      // ist keiner, der bestätigt wurde — beide werden gezählt und keiner steht
      // unter den bestätigten, sonst liesse sich die Zahl nicht nachrechnen.
      expect(daten.audit.suspicions).toBe(1);
      expect(daten.audit.dismissed).toBe(1);
      expect(daten.audit.scopeLimits).toEqual(['Der Prüfer führt nichts aus.', 'Kein Browser.']);
    });

    it('macht auch die Prüfung ohne Ende sichtbar, statt sie wie eine ausgebliebene aussehen zu lassen', async () => {
      // §8.2 Regel 5: „a silent auditor and a working one look identical from
      // outside". **Die tragende Zeile ist die dritte**, nicht die zweite: eine
      // sauber gescheiterte Prüfung trägt in 0013s Sicht einen `finished_at`
      // (die filtert auf `kind IN ('finished','failed')`) und wäre auch über
      // `finished_at` sichtbar. Nur eine Prüfung ohne terminale Zeile fällt
      // dort heraus — und die ist der Fall, für den A56.6 die `started`-Zeile
      // vor dem Spawn schreibt.
      const daten = await generator.collect(PRUEFUNG);
      const gescheitert = daten.audit.verdicts.find((run) => run.auditId === abgestuerzt);
      expect(gescheitert).toMatchObject({ outcome: 'failed', verdict: null });
      const laeuftNoch = daten.audit.verdicts.find((run) => run.auditId === ohneEnde);
      expect(laeuftNoch).toMatchObject({ outcome: 'running', verdict: null });

      const bericht = await generator.generate(PRUEFUNG);
      expect(bericht.bodyText).toContain('abgebrochen, ohne Urteil');
      expect(bericht.bodyText).toContain('noch nicht abgeschlossen');
      expect(bericht.bodyText).toContain('funde_zu_beheben');
      expect(bericht.bodyText).toContain('Nicht prüfbar: Der Prüfer führt nichts aus.');
    });
  });

  describe('§16.6 — Warteschlange statt Zielregister', () => {
    beforeAll(async () => {
      await tasks.create({ projectId: erstesProjekt, title: 'Zweitrangig', priority: 'P2' });
      await tasks.create({ projectId: erstesProjekt, title: 'Dringend', priority: 'P0' });
      await tasks.create({ projectId: zweitesProjekt, title: 'Mittel', priority: 'P1' });
    });

    it('nimmt den Bestand, nicht das Fenster, und sortiert nach Dringlichkeit', async () => {
      // Kein Zeitfenster: eine Aufgabe, die seit einem Monat wartet, gehört in
      // jeden Bericht, bis sie läuft. Deshalb liefert **jedes** Fenster
      // dieselbe Liste.
      const frueh = await generator.collect(PROJEKTE);
      const spaet = await generator.collect(GANZ);
      expect(frueh.nextWeek).toEqual(spaet.nextWeek);

      expect(frueh.nextWeek.source).toBe('queued_tasks');
      expect(frueh.nextWeek.entries.map((item) => item.title)).toEqual([
        'Dringend',
        'Mittel',
        'Zweitrangig',
      ]);
      // Die Aufgaben des Projektblocks stehen absichtlich auf `draft` und
      // dürfen hier nicht auftauchen.
      expect(frueh.nextWeek.total).toBe(3);
      expect(frueh.nextWeek.entries.map((item) => item.project)).toEqual([
        'Alpha',
        'Beta',
        'Alpha',
      ]);
    });

    it('sagt im Bericht, dass §5s `goals` keinen Erzeuger hat', async () => {
      const bericht = await generator.generate(GANZ);
      expect(bericht.bodyText).toContain('weder Tabelle noch Erzeuger');
      expect(bericht.bodyText).toContain('P0 · Dringend (Alpha)');
    });
  });

  describe('Der ganze Bericht, und was das Archiv daraus macht', () => {
    it('liefert genau die Form, die `ReportRecords.record()` nimmt — und legt sie ab', async () => {
      const bericht = await generator.generate(GANZ);

      expect(bericht.periodStart).toEqual(GANZ.from);
      expect(bericht.periodEnd).toEqual(GANZ.to);
      expect(bericht.subject).toContain('Wochenbericht');
      expect(bericht.bodyText).toContain('1. Kopfzahlen');
      expect(bericht.bodyHtml.startsWith('<!doctype html>')).toBe(true);

      // Die Naht, die kein Typ allein beweist: der Erzeuger schreibt, das
      // Archiv liest, und beide reden über dasselbe Dokument (A81).
      const abgelegt = await reports.record(bericht);
      const zurueck = await reports.forPeriod(GANZ.from);
      // Geworfen statt über `?.` weitergereicht: ohne Zeile ist jede folgende
      // Zusicherung eine über `undefined`, und der Fall meldete dann etwas
      // anderes, als er heißt (A109.2s Klasse).
      if (!zurueck) throw new Error('Der abgelegte Bericht kam nicht zurück.');
      expect(zurueck.id).toBe(abgelegt.id);
      expect(zurueck.subject).toBe(bericht.subject);
      expect(zurueck.bodyText).toBe(bericht.bodyText);
      expect(zurueck.bodyHtml).toBe(bericht.bodyHtml);

      // §22s Gate verlangt, dass jede Kopfzahl nachrechenbar ist. Das Archiv
      // trägt deshalb die Zahlen selbst und nicht nur die Prosa — ein
      // Prüfskript soll keinen deutschen Text parsen müssen.
      const zahlen = zurueck.metrics;
      expect(Object.keys(zahlen).sort()).toEqual([
        'audit',
        'headline',
        'nextWeek',
        'projects',
        'quality',
        'radar',
        'truncation',
        'window',
      ]);
      expect((zahlen.window as { from: string }).from).toBe(GANZ.from.toISOString());
      expect((zahlen.truncation as { droppedByCap: number }).droppedByCap).toBe(0);
    });

    it('weist eine zweite Ablage derselben Woche zurück, statt das Archiv zu überschreiben', async () => {
      const bericht = await generator.generate(GANZ);
      await expect(reports.record(bericht)).rejects.toMatchObject({ kind: 'duplicate' });
    });
  });
});
