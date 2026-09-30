/**
 * Integration tests for the usage meter (§7.1).
 *
 * These run against a real Postgres because the property under test is what
 * the *database* hands back to the guardian, not what a mock would. The
 * fail-closed rule in particular is only meaningful end to end: it is about
 * what happens when the table is empty or stale, and both of those are states
 * of a database rather than of an object.
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import { evaluateGuardian } from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventLog } from './event-log.js';
import { MAX_SAMPLE_AGE_MS, UsageMeter } from './usage-meter.js';

const url = process.env.TEST_DATABASE_URL;

/** Die gestellte Uhr — auf Modulebene, weil `payload` sie liest. */
let clock = Date.parse('2026-08-01T06:00:00Z');

/**
 * Verbatim shape from a real get_usage response (ADR 0001) — mit einem
 * Zurücksetzzeitpunkt **relativ zur gestellten Uhr**, wie ihn eine echte
 * Antwort trägt.
 *
 * Die erste Fassung fror `2026-08-01T09:59:59Z` ein. Solange nichts das Alter
 * einer offiziellen Messung ansah, war das folgenlos; mit A98 ist es der
 * Unterschied zwischen einer Attrappe und dem, wofür sie steht (A37): eine
 * echte Messung nennt immer ein Fenster, das *noch läuft*, und die eingefrorene
 * lag nach ein paar Uhrsprüngen im Test in der Vergangenheit. Der Fall
 * „meldet grobe Abweichung" wurde dadurch rot, und er hatte recht — die
 * Fixture beschrieb ein Fenster, das es nicht mehr gab.
 */
function payload(fiveHour: number, weekly: number, model = 11, at = clock) {
  const inStunden = (h: number) => new Date(at + h * 60 * 60_000).toISOString();
  return {
    subscription_type: 'max',
    rate_limits_available: true,
    rate_limits: {
      limits: [
        { kind: 'session', percent: fiveHour, resets_at: inStunden(4), scope: null },
        { kind: 'weekly_all', percent: weekly, resets_at: inStunden(20), scope: null },
        {
          kind: 'weekly_scoped',
          percent: model,
          resets_at: inStunden(20),
          scope: { model: { display_name: 'Opus' } },
        },
      ],
      iguana_necktie: null,
    },
  };
}

describe.skipIf(!url)('UsageMeter', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('usagemeter');
    sql = createSql({ url: database.url, max: 2 });
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
  });

  beforeEach(async () => {
    // usage_samples is append-only, so tests cannot clean up after themselves.
    // Each one advances the clock instead and reads only the freshest rows —
    // which is exactly how the meter behaves in production.
    clock += 60 * 60_000;
  });

  const meter = () => new UsageMeter({ sql, now: () => clock });

  /** Wie `meter()`, nur mit angeschlossenem Ereignisprotokoll (A149). */
  const lautesMeter = () => new UsageMeter({ sql, now: () => clock, eventLog: new EventLog(sql) });

  /** Zählt die Meldungen eines Anomaliegrunds ab einem Zeitpunkt. */
  const meldungen = async (reason: string, seit: number) => {
    const rows = await sql<Array<{ resolved: boolean | null }>>`
      SELECT (payload ->> 'resolved')::boolean AS resolved
      FROM event_log
      WHERE kind = 'guardian.anomaly'
        AND payload ->> 'reason' = ${reason}
        AND occurred_at >= ${new Date(seit)}
      ORDER BY occurred_at
    `;
    return {
      gesamt: rows.length,
      eintritte: rows.filter((r) => r.resolved === false).length,
      aufloesungen: rows.filter((r) => r.resolved === true).length,
    };
  };

  it('speichert eine Probe je Fenster und hängt das rohe Payload daneben', async () => {
    const samples = await meter().ingestOfficial(payload(2, 24));
    expect(samples.map((s) => [s.window, s.usedPercent])).toEqual([
      ['five_hour', 2],
      ['seven_day', 24],
      ['seven_day_model', 11],
    ]);

    const [row] = await sql<Array<{ raw: Record<string, unknown> }>>`
      SELECT raw FROM usage_samples ORDER BY id DESC LIMIT 1
    `;
    // ADR 0001: verbatim, so a wrongly guessed scale stays recoverable.
    expect(row?.raw).toHaveProperty('iguana_necktie');
    // …but only rate_limits. `behaviors` is account telemetry and §18 keeps
    // this table forever.
    expect(row?.raw).not.toHaveProperty('behaviors');
  });

  it('gibt je Fenster die frischeste Probe zurück', async () => {
    await meter().ingestOfficial(payload(2, 24));
    clock += 60_000;
    await meter().ingestOfficial(payload(41, 55));

    const current = await meter().currentSamples();
    expect(current.find((s) => s.window === 'five_hour')?.usedPercent).toBe(41);
    expect(current.find((s) => s.window === 'seven_day')?.usedPercent).toBe(55);
  });

  describe('fail-closed', () => {
    // The whole point: silence and "everything fine" must not look alike.
    it('meldet unavailable, wenn rate_limits_available false ist', async () => {
      const samples = await meter().ingestOfficial({ rate_limits_available: false });
      expect(samples).toHaveLength(1);
      expect(samples[0]?.anomaly).toEqual({ kind: 'unavailable' });
      // And the guardian closes the gate on it.
      expect(evaluateGuardian({ samples, latches: [], now: clock }).state).toBe('wrap_up');
    });

    it('behandelt eine veraltete Probe als unavailable, nicht als gültig', async () => {
      await meter().ingestOfficial(payload(3, 9));
      clock += MAX_SAMPLE_AGE_MS + 60_000;

      const current = await meter().currentSamples();
      expect(current.every((s) => s.anomaly?.kind === 'unavailable')).toBe(true);
      // A number that said 3% an hour ago is not evidence about now.
      expect(evaluateGuardian({ samples: current, latches: [], now: clock }).state).toBe('wrap_up');
    });

    // The empty-table case is a pure decision and lives in projectSamples;
    // see usage-meter.test.ts.
  });

  /**
   * A73 — the pushed official reading from `rate_limit_event`.
   *
   * Under token auth this is the only official figure the system can obtain
   * (A64), and it appears only above the vendor's 75% warning threshold. So
   * these tests cover the band in which §7.2 actually has to act, and the first
   * of them is the one this file's header was written for.
   */
  describe('offizieller Wert aus dem rate_limit_event (A73)', () => {
    it('liest 0,97 als 97 Prozent und nicht als 0,97', async () => {
      const sample = await meter().ingestOfficialWindow('five_hour', 0.97);

      // The whole reason `ingestOfficialWindow` exists as its own method. Read
      // on the get_usage scale, 0.97 would mean "0.97 percent used" and the
      // guardian would never fire again — silently, with every test still green.
      expect(sample.usedPercent).toBe(97);
      expect(sample.source).toBe('official');
      expect(sample.anomaly).toBeNull();

      expect(evaluateGuardian({ samples: [sample], latches: [], now: clock }).state).toBe(
        'hard_stop',
      );
    });

    it('schlägt eine frischere Schätzung — sonst wäre der Nenner die Obergrenze', async () => {
      // The case the operator's decision of 2026-08-01 turns on. `PLAN_BUDGETS` is a
      // configured number nobody can derive, so a generous one makes the
      // estimate read comfortably low exactly when the account is nearly spent.
      // The official reading has to win even though it is older.
      await meter().ingestOfficialWindow('five_hour', 0.96, { resetsAt: clock + 600_000 });
      clock += 60_000;
      await meter().ingestEstimate('five_hour', 41);

      const current = await meter().currentSamples();
      const fiveHour = current.find((s) => s.window === 'five_hour');
      expect(fiveHour?.source).toBe('official');
      expect(fiveHour?.usedPercent).toBe(96);
      expect(evaluateGuardian({ samples: current, latches: [], now: clock }).state).toBe(
        'hard_stop',
      );
    });

    it('misstraut einem Wert über 1, statt ihn stillschweigend zu übernehmen', async () => {
      // If the vendor ever switches this frame to 0–100, the fraction reading
      // would divide the danger by a hundred. `normaliseUtilization` takes the
      // larger meaning and says that it did — a recorded anomaly, not a guess.
      const sample = await meter().ingestOfficialWindow('seven_day', 88);
      expect(sample.usedPercent).toBe(88);
      expect(sample.anomaly).toEqual({ kind: 'ambiguous_scale', raw: 88, assumed: 88 });
    });

    it('merkt sich die Fenstergrenze, damit der Riegel wieder aufgeht', async () => {
      // §7.2's latch clears at `resetsAt`; without one it falls back to a full
      // nominal window. The frame carries the real boundary, so it is kept.
      const resetsAt = clock + 3_600_000;
      const sample = await meter().ingestOfficialWindow('five_hour', 0.91, { resetsAt });
      expect(sample.resetsAt).toBe(resetsAt);

      const [row] = await sql<Array<{ resets_at: Date | null; source: string }>>`
        SELECT resets_at, source FROM usage_samples ORDER BY id DESC LIMIT 1
      `;
      expect(row?.resets_at?.getTime()).toBe(resetsAt);
      expect(row?.source).toBe('official');
    });
  });

  describe('Kreuzprobe gegen den Token-Meter', () => {
    it('meldet grobe Abweichung als Anomalie', async () => {
      await meter().ingestOfficial(payload(10, 10));
      clock += 1000;
      const estimate = await meter().ingestEstimate('five_hour', 55);
      expect(estimate.anomaly).toEqual({
        kind: 'divergence',
        officialPercent: 10,
        estimatedPercent: 55,
      });
    });

    /**
     * A98 — die Gegenprobe braucht **dieselbe** Fensterinstanz.
     *
     * Auf dem Produktionshost standen am 3.8.2026 **1892 Anomalie-Zeilen aus 23 Stunden**,
     * eine alle 44 Sekunden, mit Nutzlasten wie `official 95 / estimated 0`.
     * Das ist keine Divergenz zweier Messungen, sondern der Vergleich einer
     * frischen Schätzung mit einer offiziellen Zahl aus einem Fenster, das
     * längst zurückgesetzt war — und seit A73 kommen offizielle Zahlen nur
     * oberhalb von 75 %, es steht also nach jedem Wechsel garantiert eine hohe
     * alte in der Tabelle.
     */
    it('vergleicht nicht mit einem Fenster, das schon zurückgesetzt ist (A98)', async () => {
      const resetsAt = clock + 60_000;
      await meter().ingestOfficialWindow('five_hour', 0.95, { resetsAt });
      // Über den Zurücksetzzeitpunkt hinweg: das Fenster von eben gibt es nicht
      // mehr, und die neue Schätzung beschreibt das nächste.
      clock = resetsAt + 1000;
      const estimate = await meter().ingestEstimate('five_hour', 0);
      expect(estimate.anomaly).toBeNull();
    });

    it('vergleicht sehr wohl, solange dasselbe Fenster noch läuft (A98)', async () => {
      // Die Gegenrichtung, ohne die der Fall darüber auch grün wäre, wenn die
      // Gegenprobe ganz abgeschaltet würde.
      //
      // A149: die Zahlen sind gedreht. Bis dahin stand hier `offiziell 95 /
      // geschätzt 0` — genau die Richtung, die seit A149 **erwartet** ist und
      // deshalb schweigt (die Schätzung ist konstruktionsbedingt eine
      // Untergrenze der Kontoauslastung). Der Fall prüft die **Frischegrenze**,
      // nicht die Richtung; er behält seinen Zweck und wechselt die Fixture.
      const resetsAt = clock + 4 * 60 * 60_000;
      await meter().ingestOfficialWindow('five_hour', 0.1, { resetsAt });
      clock += 60_000;
      const estimate = await meter().ingestEstimate('five_hour', 95);
      expect(estimate.anomaly).toEqual({
        kind: 'divergence',
        officialPercent: 10,
        estimatedPercent: 95,
      });
    });

    /**
     * A149 — die Grenze, die A98 gefehlt hat, und der Produktionsfall dazu.
     *
     * A98 hat den Vergleich mit einem **abgelaufenen** Fenster beseitigt.
     * Geblieben war der Vergleich mit einer **veralteten Messung im laufenden**
     * Fenster, und der ist unter A73 der Regelfall. Gemessen auf dem Produktionshost:
     * 18.–23.8.2026, rund **1.330 Zeilen am Tag**, beendet nicht durch eine
     * Reparatur, sondern dadurch, dass der `resets_at` der einen offiziellen
     * Wochenmessung ablief.
     *
     * Die Ursache waren zwei Frischebegriffe in einer Datei: hier bis zu sieben
     * Tage, in `projectSamples` fünfzehn Minuten. Faktor 672, und der lockerere
     * entschied über den Lärm.
     *
     * Dieser Fall ist die Produktionszeile, Zahl für Zahl.
     */
    it('vergleicht nicht mit einer Messung, die für den Wächter längst zu alt ist (A149)', async () => {
      // **Die Richtung ist mit Absicht die meldende.** Die erste Fassung nahm
      // die Produktionszahlen (offiziell 71 / geschätzt 1,2) — und überlebte
      // die Mutation, die die Altersgrenze entfernt, weil dann Eingriff 3 die
      // Einseitigkeit greift und sie ebenfalls schweigen lässt. Zwei Schichten,
      // und der Fall konnte sie nicht auseinanderhalten (A77.4). Hier steht
      // deshalb `geschätzt oben`: dann kann **nur** das Alter sie stilllegen.
      const resetsAt = clock + 5 * 24 * 60 * 60_000; // Fenster läuft noch Tage
      await meter().ingestOfficialWindow('seven_day', 0.1, { resetsAt });
      clock += MAX_SAMPLE_AGE_MS + 60_000;
      const estimate = await meter().ingestEstimate('seven_day', 95);
      expect(estimate.anomaly).toBeNull();
    });

    it('schweigt zur Produktionszeile vom 18.–23.8.2026 — aus zwei Gründen (A149)', async () => {
      // Zahl für Zahl der Fall, der 1.330 Zeilen am Tag erzeugt hat. Er ist
      // **doppelt** gedeckt: die Messung ist zu alt (Eingriff 1) *und* die
      // Richtung ist die erwartete (Eingriff 3). Das wird hier ausgeschrieben,
      // statt den Fall so klingen zu lassen, als belege er eine der beiden.
      const resetsAt = clock + 5 * 24 * 60 * 60_000;
      await meter().ingestOfficialWindow('seven_day', 0.71, { resetsAt });
      clock += MAX_SAMPLE_AGE_MS + 60_000;
      expect((await meter().ingestEstimate('seven_day', 1.2279)).anomaly).toBeNull();

      // Und auch frisch bliebe sie still — die zweite Schicht, isoliert.
      clock += 60_000;
      await meter().ingestOfficialWindow('seven_day', 0.71, { resetsAt });
      clock += 60_000;
      expect((await meter().ingestEstimate('seven_day', 1.2279)).anomaly).toBeNull();
    });

    it('vergleicht noch, solange die Messung jung genug ist (A149)', async () => {
      // Die Gegenrichtung zur Altersgrenze: eine Minute davor gilt sie noch.
      const resetsAt = clock + 5 * 24 * 60 * 60_000;
      await meter().ingestOfficialWindow('seven_day', 0.1, { resetsAt });
      clock += MAX_SAMPLE_AGE_MS - 60_000;
      const estimate = await meter().ingestEstimate('seven_day', 95);
      expect(estimate.anomaly).not.toBeNull();
    });

    it('schweigt, wenn beide Quellen sich einig sind', async () => {
      await meter().ingestOfficial(payload(30, 30));
      clock += 1000;
      const estimate = await meter().ingestEstimate('five_hour', 34);
      expect(estimate.anomaly).toBeNull();
    });

    /**
     * A149 — melden beim **Übergang**, nie je Durchgang.
     *
     * Die Regel steht in diesem Projekt viermal (A67.6, A86.5, A102, A105.2)
     * und war hier nicht befolgt. `UsageEstimator` ruft alle 60 Sekunden, also
     * schrieb ein anhaltender Zustand rund 1.330 Zeilen am Tag in ein
     * Protokoll, das §18 für immer aufhebt.
     *
     * Zwei Zusicherungen in einem Fall, weil eine allein die Hälfte beweist:
     * dreimal ingestieren gibt **eine** Zeile, und die Auflösung gibt **eine
     * zweite**. Ohne die zweite wäre die Regel mit einem `if (false)` zu
     * bestehen.
     */
    it('meldet eine anhaltende Divergenz genau einmal — und ihr Ende auch (A149)', async () => {
      const seit = clock;
      const resetsAt = clock + 5 * 24 * 60 * 60_000;
      await lautesMeter().ingestOfficialWindow('seven_day', 0.1, { resetsAt });

      for (let i = 0; i < 3; i += 1) {
        clock += 60_000;
        await lautesMeter().ingestEstimate('seven_day', 95);
      }
      expect(await meldungen('meter_divergence', seit)).toEqual({
        gesamt: 1,
        eintritte: 1,
        aufloesungen: 0,
      });

      // Der Zustand endet: die Schätzung nähert sich der offiziellen Zahl.
      clock += 60_000;
      await lautesMeter().ingestEstimate('seven_day', 11);
      expect(await meldungen('meter_divergence', seit)).toEqual({
        gesamt: 2,
        eintritte: 1,
        aufloesungen: 1,
      });
    });

    /**
     * A149 — dieselbe Regel für die zweite Nutzlastform, und beide Hälften in
     * einem Fall.
     *
     * `rate_limits_unavailable` ist unter A64 der **Dauerzustand** und feuerte
     * alle 120 Sekunden je lebender Sitzung. A83.5 hat für den Kartenpfad
     * genau das schon entschieden („eine Karte pro Minute für einen Zustand,
     * gegen den niemand etwas tun kann, ist der Weg, auf dem ein Kanal
     * stummgeschaltet wird") — der Protokollpfad daneben kannte die Regel
     * nicht.
     *
     * Die zweite Hälfte ist die, die man weglässt: die **Proben** bleiben
     * vollzählig. Es entfällt die Ansage, nicht die Messung — §16 liest die
     * Häufigkeit aus `usage_samples` und nicht aus dem Ereignisprotokoll.
     */
    it('meldet einen blinden Zähler einmal, misst ihn aber weiter (A149)', async () => {
      const seit = clock;
      const blind = { subscription_type: null, rate_limits_available: false, rate_limits: null };

      for (let i = 0; i < 3; i += 1) {
        clock += 120_000;
        await lautesMeter().ingestOfficial(blind);
      }

      expect(await meldungen('rate_limits_unavailable', seit)).toEqual({
        gesamt: 1,
        eintritte: 1,
        aufloesungen: 0,
      });

      const zeilen = await sql<Array<{ count: string }>>`
        SELECT count(*)::text FROM usage_samples
        WHERE observed_at >= ${new Date(seit)} AND anomaly ->> 'kind' = 'unavailable'
      `;
      expect(Number(zeilen[0]?.count)).toBe(3);

      // Und die Gegenrichtung: sobald wieder abgelesen werden kann, ist der
      // Zustand vorbei und das steht auch da.
      clock += 120_000;
      await lautesMeter().ingestOfficial(payload(5, 5));
      expect(await meldungen('rate_limits_unavailable', seit)).toEqual({
        gesamt: 2,
        eintritte: 1,
        aufloesungen: 1,
      });
    });

    /**
     * A149 — die Kette #17 → #18, an ihrer Wurzel.
     *
     * `onAnomaly` hat genau einen Verbraucher: `reportBudgetAnomaly` im Daemon,
     * der daraus §15s Karte baut. Er feuerte je Probe, also alle 60 Sekunden,
     * und die Karte hing allein an einer Entdopplung gegen die **offenen**
     * Eskalationen — die geht auf, sobald der Betreiber antwortet. In Produktion sah man
     * genau das: Karte #17 beantwortet um 11:57, Karte #18 mit derselben Frage
     * um 11:58.
     *
     * Beide Kanäle hängen jetzt an derselben Übergangsprüfung: eine Episode,
     * eine Protokollzeile, eine Karte.
     */
    it('ruft onAnomaly einmal je Episode, nicht je Probe (A149)', async () => {
      const gerufen: string[] = [];
      const lauter = () =>
        new UsageMeter({
          sql,
          now: () => clock,
          eventLog: new EventLog(sql),
          onAnomaly: (probe) => gerufen.push(`${probe.window}:${probe.anomaly?.kind}`),
        });

      const blind = { subscription_type: null, rate_limits_available: false, rate_limits: null };
      for (let i = 0; i < 4; i += 1) {
        clock += 120_000;
        await lauter().ingestOfficial(blind);
      }
      expect(gerufen).toEqual(['five_hour:unavailable']);

      // Nach dem Ende der Episode zählt eine neue wieder als neu — sonst wäre
      // die Entdopplung ein Riegel statt einer Übergangsmeldung.
      clock += 120_000;
      await lauter().ingestOfficial(payload(4, 4));
      clock += 120_000;
      await lauter().ingestOfficial(blind);
      expect(gerufen).toEqual(['five_hour:unavailable', 'five_hour:unavailable']);
    });

    it('markiert Schätzungen als solche, damit früher gestoppt wird', async () => {
      const estimate = await meter().ingestEstimate('seven_day', 78);
      expect(estimate.source).toBe('estimated');
      // §7.1 fail-closed: an estimated 78% already means wrap-up, while the
      // same number from the official source would not.
      expect(evaluateGuardian({ samples: [estimate], latches: [], now: clock }).state).toBe(
        'wrap_up',
      );
    });
  });

  it('nimmt einen einzelnen kleinen Wert beim Wort', async () => {
    // A single 0.9 is just 0.9%. Resolving it upward was an earlier mistake
    // that turned 1% into 100% and would have halted the studio at one percent
    // of budget.
    const samples = await meter().ingestOfficial(payload(0.9, 30));
    expect(samples.find((s) => s.window === 'five_hour')?.usedPercent).toBe(0.9);
    expect(samples.every((s) => s.anomaly === null)).toBe(true);
  });

  it('misstraut einem Schnappschuss, dessen Fenster alle unter 1 liegen', async () => {
    // That is the signature of a source that switched to fractions. Rescaling
    // would be a guess and so would face value; the honest answer is that the
    // reading cannot be trusted — which the guardian already handles.
    const samples = await meter().ingestOfficial(payload(0.02, 0.24, 0.11));
    expect(samples).toHaveLength(1);
    expect(samples[0]?.anomaly).toEqual({ kind: 'unavailable' });
  });
});
