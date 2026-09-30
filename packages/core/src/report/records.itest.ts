/**
 * §5s `reports` gegen eine echte Postgres (Migration 0024).
 *
 * Das Prüfbare an dieser Tabelle *ist* die Datenbank. Die drei Zusicherungen,
 * für die sie gebaut wurde — ein Bericht je Fenster, nichts wird
 * überschrieben, das Fenster sind Zeitpunkte und keine sieben Tage — liegen
 * alle drei im Schema. Eine Attrappe würde zurückgeben, was man ihr gesagt hat,
 * und genau das ist hier die Gegenthese: die Behauptung lautet „es gibt keinen
 * Weg, eine Woche zweimal abzulegen oder eine abgelegte zu ändern", und die ist
 * nur wahr, wenn es ihn **auch an der Datenbank vorbei** nicht gibt. Deshalb
 * geht ein Fall ausdrücklich am Dienst vorbei (A77.8).
 *
 * **Ausdrückliche Prüfgrenze:** dass `list()` die Rümpfe gar nicht erst über
 * die Leitung holt, kann diese Suite nicht widerlegen. `SELECT *` gefolgt von
 * `toSummary` liefert dem Aufrufer dieselben Objekte wie `SELECT id, …`; der
 * Unterschied sind übertragene Bytes, und die sieht ein Client nicht. Geprüft
 * ist also die Form des Vertrags, nicht die Sparsamkeit der Abfrage — gesagt,
 * statt es so aussehen zu lassen, als sei beides belegt.
 */
import { createSql, createTestDatabase, migrate, type TestDatabase } from '@vorschicht/db';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isDuplicatePeriod, ReportError, ReportRecords } from './records.js';

const url = process.env.TEST_DATABASE_URL;

/** Die Migration, die diese Suite prüft — und die sie je Fall neu ausführt. */
const MIGRATION = '0024_reports.sql';

/**
 * Die Wanduhr in Europe/Vienna zu einem Zeitpunkt.
 *
 * Über `formatToParts` statt über eine formatierte Zeichenkette, weil
 * `hour12: false` je nach ICU-Fassung „24:00" statt „00:00" liefert und der
 * ganze Sinn dieser Fälle Mitternacht ist. `hourCycle: 'h23'` sagt es
 * ausdrücklich.
 */
const wienerFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Vienna',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

function wienerWanduhr(zeitpunkt: Date): string {
  const teile = Object.fromEntries(
    wienerFormat.formatToParts(zeitpunkt).map((t) => [t.type, t.value]),
  );
  return `${teile.year}-${teile.month}-${teile.day} ${teile.hour}:${teile.minute}`;
}

const STUNDE = 3_600_000;

function stunden(von: Date, bis: Date): number {
  return (bis.getTime() - von.getTime()) / STUNDE;
}

/** Ein vollständiger Bericht, aus dem die Fälle einzelne Felder ersetzen. */
function bericht(periodStart: Date, periodEnd: Date, over: Record<string, unknown> = {}) {
  return {
    periodStart,
    periodEnd,
    subject: 'Vorschicht — Wochenbericht',
    bodyText: 'Kopfzahlen: 3 Aufgaben erledigt.',
    bodyHtml: '<h1>Wochenbericht</h1><p>Kopfzahlen: 3 Aufgaben erledigt.</p>',
    metrics: { tasksDone: 3, merges: 2, rollbacks: 0 },
    ...over,
  } as Parameters<ReportRecords['record']>[0];
}

describe.skipIf(!url)('Wochenbericht-Archiv (§5, §16)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let records: ReportRecords;

  beforeAll(async () => {
    database = await createTestDatabase('report-records');
    sql = createSql({ url: database.url, max: 3 });
    records = new ReportRecords(sql);
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
  });

  beforeEach(async () => {
    /*
     * Jeder Fall bekommt ein leeres Archiv.
     *
     * `latest()`, `list()` und „kein Archiv da" sind **globale** Fragen: ein
     * Bericht aus einem Nachbarfall beantwortet sie mit, und der Fall hinge
     * dann an der Reihenfolge statt an seiner eigenen Saat. Aufräumen geht
     * nicht — der Wächter verbietet DELETE und TRUNCATE, was ja der Punkt ist.
     *
     * Also fällt die Tabelle und **die echte Migration legt sie neu an**. Das
     * Schema hier abzuschreiben wäre eine zweite Deklaration derselben Sache
     * (A81), und diese Fälle prüften danach eine Tabelle, die es in Produktion
     * so nicht gibt. `schema.itest.ts` benutzt denselben Griff, um eine
     * Migration erneut laufen zu lassen.
     */
    await sql`DROP TABLE IF EXISTS reports CASCADE`;
    await sql`DELETE FROM _vorschicht_migrations WHERE name = ${MIGRATION}`;
    const lauf = await migrate(sql);
    expect(lauf.applied).toContain(MIGRATION);
  });

  it('legt einen Bericht ab und liest ihn unverändert zurück', async () => {
    const start = new Date('2026-02-02T23:00:00Z');
    const ende = new Date('2026-02-09T23:00:00Z');

    const abgelegt = await records.record(bericht(start, ende));

    expect(abgelegt.periodStart.toISOString()).toBe(start.toISOString());
    expect(abgelegt.periodEnd.toISOString()).toBe(ende.toISOString());
    expect(abgelegt.subject).toBe('Vorschicht — Wochenbericht');
    expect(abgelegt.bodyText).toContain('3 Aufgaben erledigt');
    expect(abgelegt.bodyHtml).toContain('<h1>');

    const gelesen = await records.forPeriod(start);
    expect(gelesen?.id).toBe(abgelegt.id);
    // Die Kennzahlen kommen als Zahlen zurück, nicht als Zeichenketten — sonst
    // rechnet §22s Prüfskript auf Text.
    expect(gelesen?.metrics).toEqual({ tasksDone: 3, merges: 2, rollbacks: 0 });
    const kennzahlen = gelesen?.metrics as { tasksDone?: unknown } | undefined;
    expect(typeof kennzahlen?.tasksDone).toBe('number');
  });

  it('speichert das Fenster als Zeitpunkte — eine Woche hat 167 oder 169 Stunden', async () => {
    /*
     * Die tragende Zusicherung dieser Datei.
     *
     * Europe/Vienna stellt am letzten Sonntag im März auf Sommerzeit um und am
     * letzten Sonntag im Oktober zurück. Die Woche darum hat deshalb 167
     * beziehungsweise 169 Stunden. Wer das Fenster als Datum plus „sieben Tage"
     * ablegt oder beim Zurücklesen normalisiert, bekommt hier 168 — und zählt
     * in genau diesen zwei Wochen des Jahres falsch, in einem Bericht, den
     * niemand nachrechnet.
     *
     * Die Zeitpunkte stehen als UTC-Literale da und prüfen sich selbst: die
     * Wanduhr-Zusicherung darunter fällt, wenn eines der Literale das falsche
     * Fenster meint. Eine Fixture, die von dem abweicht, wofür sie steht, prüft
     * etwas anderes (A37).
     */
    const maerzStart = new Date('2026-03-22T23:00:00Z'); // Mo 23.03. 00:00 MEZ
    const maerzEnde = new Date('2026-03-29T22:00:00Z'); // Mo 30.03. 00:00 MESZ
    const oktoberStart = new Date('2026-10-18T22:00:00Z'); // Mo 19.10. 00:00 MESZ
    const oktoberEnde = new Date('2026-10-25T23:00:00Z'); // Mo 26.10. 00:00 MEZ

    expect(wienerWanduhr(maerzStart)).toBe('2026-03-23 00:00');
    expect(wienerWanduhr(maerzEnde)).toBe('2026-03-30 00:00');
    expect(wienerWanduhr(oktoberStart)).toBe('2026-10-19 00:00');
    expect(wienerWanduhr(oktoberEnde)).toBe('2026-10-26 00:00');
    expect(stunden(maerzStart, maerzEnde)).toBe(167);
    expect(stunden(oktoberStart, oktoberEnde)).toBe(169);

    await records.record(bericht(maerzStart, maerzEnde, { subject: 'Woche im März' }));
    await records.record(bericht(oktoberStart, oktoberEnde, { subject: 'Woche im Oktober' }));

    const maerz = await records.forPeriod(maerzStart);
    const oktober = await records.forPeriod(oktoberStart);

    expect(stunden(maerz?.periodStart as Date, maerz?.periodEnd as Date)).toBe(167);
    expect(stunden(oktober?.periodStart as Date, oktober?.periodEnd as Date)).toBe(169);
    // Und ausdrücklich die Gegenrichtung: nichts hat auf 7 × 24 gerundet.
    expect(stunden(maerz?.periodStart as Date, maerz?.periodEnd as Date)).not.toBe(168);
    expect(stunden(oktober?.periodStart as Date, oktober?.periodEnd as Date)).not.toBe(168);
  });

  it('lehnt einen zweiten Bericht für dasselbe Fenster mit einem deutschen Satz ab', async () => {
    const start = new Date('2026-04-06T22:00:00Z');
    const ende = new Date('2026-04-13T22:00:00Z');
    await records.record(bericht(start, ende));

    const fehler = await records.record(bericht(start, ende, { subject: 'Zweiter Versuch' })).then(
      () => null,
      (e: unknown) => e,
    );

    expect(fehler).toBeInstanceOf(ReportError);
    expect((fehler as ReportError).kind).toBe('duplicate');
    expect((fehler as ReportError).message).toMatch(/bereits/);
    expect((fehler as ReportError).message).not.toMatch(/\b(already|duplicate|exists)\b/i);

    // Woran die Einordnung hängt, an einem **echten** Treiberfehler abgelesen
    // statt angenommen: der Fall darunter befragt `isDuplicatePeriod` mit
    // handgeschriebenen Formen, und diese Zeile ist der Beleg, dass diese
    // Formen die sind, die postgres.js wirklich liefert (A37).
    const ursache = (fehler as ReportError).cause as {
      code?: unknown;
      constraint_name?: unknown;
    };
    expect(ursache.code).toBe('23505');
    expect(ursache.constraint_name).toBe('reports_one_per_period');

    // Und nichts wurde überschrieben: der erste Bericht steht unverändert da.
    const gelesen = await records.forPeriod(start);
    expect(gelesen?.subject).toBe('Vorschicht — Wochenbericht');
    const alle = await records.list();
    expect(alle).toHaveLength(1);
  });

  it('hält eine Eindeutigkeitsverletzung an einer anderen Bedingung nicht für eine Doppelung', () => {
    /*
     * Die Regel, die aus `record()` heraus nicht widerlegbar ist.
     *
     * Erreichbar sind aus dem INSERT zwei Eindeutigkeitsbedingungen: diese und
     * der Primärschlüssel über `gen_random_uuid()`. Die zweite kann kein Test
     * provozieren — also überlebte die Mutation „prüfe nur den Code" (M4)
     * unbemerkt, und die Namensprüfung läse sich wie abgedeckt. Deshalb wird
     * die reine Hälfte direkt befragt; ihre Eingabeformen sind eine Zeile
     * weiter oben an einem echten Treiberfehler verankert.
     *
     * Warum die Prüfung überhaupt bleibt, obwohl der heutige Kollisionsfall
     * astronomisch unwahrscheinlich ist: die Klasse ist es nicht. Eine spätere
     * Migration, die eine zweite Eindeutigkeitsbedingung anlegt, machte aus
     * jeder ihrer Verletzungen die Meldung „diese Woche gibt es schon" — und
     * die schickt den Leser eine Woche lang in die falsche Richtung (A91).
     */
    expect(isDuplicatePeriod({ code: '23505', constraint_name: 'reports_one_per_period' })).toBe(
      true,
    );
    expect(isDuplicatePeriod({ code: '23505', constraint_name: 'reports_pkey' })).toBe(false);
    expect(isDuplicatePeriod({ code: '23514', constraint_name: 'reports_body_present' })).toBe(
      false,
    );
    expect(isDuplicatePeriod(new Error('irgendwas'))).toBe(false);
  });

  it('verweigert die Doppelung auch, wenn jemand am Dienst vorbei schreibt', async () => {
    /*
     * A77.8s Aufteilung, und der Grund, warum dieser Fall neben dem darüber
     * steht: der Dienst ist die freundliche Hälfte, und eine Garantie, die nur
     * aus einer Vorabprüfung besteht, ist die höfliche Fassung einer Garantie.
     * Zwei Ticks, zwei Verbindungen, beide sähen ein leeres Archiv — nur der
     * Index entscheidet das.
     */
    const start = new Date('2026-05-04T22:00:00Z');
    const roh = (betreff: string) => sql`
      INSERT INTO reports (period_start, period_end, subject, body_text, body_html)
      VALUES (${start}, ${new Date(start.getTime() + 168 * STUNDE)},
              ${betreff}, 'roh', '<p>roh</p>')
    `;

    await roh('erster');
    await expect(roh('zweiter')).rejects.toThrow(/reports_one_per_period/);
  });

  it('etikettiert eine andere Verletzung nicht als Doppelung', async () => {
    /*
     * Die Hälfte, die man weglässt. `record()` fängt `23505` nur für die
     * benannte Bedingung ab; jede andere Verletzung muss weiterfliegen, sonst
     * meldet ein leerer Betreff „diese Woche gibt es schon" und schickt den
     * Leser eine Woche lang in die falsche Richtung (A91).
     */
    const start = new Date('2026-06-01T22:00:00Z');
    const fehler = await records
      .record(bericht(start, new Date(start.getTime() + 168 * STUNDE), { subject: '' }))
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(fehler).not.toBeInstanceOf(ReportError);
    expect((fehler as Error).message).toMatch(/reports_body_present/);
  });

  it('weist Kennzahlen zurück, die kein Objekt sind', async () => {
    const start = new Date('2026-06-08T22:00:00Z');
    await expect(
      records.record(
        bericht(start, new Date(start.getTime() + 168 * STUNDE), {
          metrics: [1, 2, 3] as unknown as Record<string, unknown>,
        }),
      ),
    ).rejects.toThrow(/reports_metrics_is_object/);
  });

  it('weist ein Fenster zurück, das nicht nach seinem Anfang endet', async () => {
    const start = new Date('2026-06-15T22:00:00Z');
    const fehler = await records.record(bericht(start, start)).then(
      () => null,
      (e: unknown) => e,
    );

    expect(fehler).toBeInstanceOf(ReportError);
    expect((fehler as ReportError).kind).toBe('invalid_period');
    expect(await records.list()).toHaveLength(0);
  });

  it('lässt sich nicht ändern und nicht löschen — auch nicht vom Eigentümer', async () => {
    /*
     * Die drei Verweigerungen verhaltensmässig statt über die Trigger-Präsenz.
     * `schema.itest.ts` kann das nach A107 nur für zwei der Tabellen des
     * Manifests, weil ein Zeilen-Trigger auf einer leeren Tabelle gar nicht
     * feuert; diese hier hat eine Zeile und ist deshalb vollständig prüfbar.
     */
    const start = new Date('2026-07-06T22:00:00Z');
    await records.record(bericht(start, new Date(start.getTime() + 168 * STUNDE)));

    await expect(sql`UPDATE reports SET subject = 'manipuliert'`).rejects.toThrow(/append-only/i);
    await expect(sql`DELETE FROM reports`).rejects.toThrow(/append-only/i);
    await expect(sql`TRUNCATE reports`).rejects.toThrow(/append-only/i);

    const gelesen = await records.forPeriod(start);
    expect(gelesen?.subject).toBe('Vorschicht — Wochenbericht');
  });

  it('nennt als jüngsten Bericht den mit dem jüngsten Fenster, nicht den zuletzt erzeugten', async () => {
    /*
     * Ein nachgetragener Bericht über eine ältere Woche wird *später* erzeugt.
     * Eine Sortierung nach `generated_at` gäbe hier den Nachtrag zurück, und
     * §17s Übersicht behauptete, die zuletzt berichtete Woche sei die alte.
     * Ohne den Nachtrag wären beide Sortierungen gleich und der Fall bewiese
     * nichts.
     */
    const alteWoche = new Date('2026-01-05T23:00:00Z');
    const neueWoche = new Date('2026-01-12T23:00:00Z');

    await records.record(
      bericht(neueWoche, new Date(neueWoche.getTime() + 168 * STUNDE), {
        subject: 'Neue Woche',
        generatedAt: new Date('2026-01-19T06:00:00Z'),
      }),
    );
    await records.record(
      bericht(alteWoche, new Date(alteWoche.getTime() + 168 * STUNDE), {
        subject: 'Nachtrag für die alte Woche',
        generatedAt: new Date('2026-02-02T06:00:00Z'),
      }),
    );

    const juengster = await records.latest();
    expect(juengster?.subject).toBe('Neue Woche');
    expect(juengster?.periodStart.toISOString()).toBe(neueWoche.toISOString());
  });

  it('liefert das Archiv neueste Woche zuerst, ohne Rümpfe und mit Grenze', async () => {
    const wochen = [0, 1, 2].map((i) => new Date(Date.UTC(2026, 8, 7 + i * 7, 22, 0, 0)));
    for (const [i, start] of wochen.entries()) {
      await records.record(
        bericht(start, new Date(start.getTime() + 168 * STUNDE), {
          subject: `Woche ${i}`,
        }),
      );
    }

    const alle = await records.list();
    expect(alle.map((r) => r.subject)).toEqual(['Woche 2', 'Woche 1', 'Woche 0']);

    // Der Vertrag der Zusammenfassung: keine Rümpfe, keine Kennzahlen. (Was
    // diese Zusicherung nicht belegt, steht im Dateikopf.)
    expect(Object.keys(alle[0] as object).sort()).toEqual([
      'generatedAt',
      'id',
      'periodEnd',
      'periodStart',
      'subject',
    ]);

    expect(await records.list(2)).toHaveLength(2);
  });

  it('kennt kein Archiv, wenn keines da ist', async () => {
    expect(await records.latest()).toBeNull();
    expect(await records.forPeriod(new Date('2026-01-01T00:00:00Z'))).toBeNull();
    expect(await records.list()).toEqual([]);
  });
});
