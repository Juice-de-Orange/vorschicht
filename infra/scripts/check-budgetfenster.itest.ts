/**
 * §22 Phase 9, Gate 1: die Auswertung selbst, an Daten, die sie etwas fragen.
 *
 * Gegen die Betriebsdaten auf dem Produktionshost lief `check-budgetfenster.mjs` am
 * 25.8.2026 und meldete zwei Befunde — beide richtig, und beide sagen zugleich,
 * was der Lauf **nicht** beweist: die längste Betriebsstrecke ist zwei Tage
 * (§22 verlangt vierzehn), und der geschätzte Wochenzähler steht auf 100 %,
 * was nach A101 ein Verdacht gegen den Zähler ist und keiner gegen das Konto.
 *
 * Das ist dieselbe Aufteilung wie bei `check-kennzahlen`: dort steht die
 * **Datenquelle** zur Prüfung, hier die **Rechnung**. Beide zusammen tragen den
 * Gate-Satz; keiner allein — und die Rechnung ist hier die schwerere Hälfte,
 * weil sie zwei Richtungen hat, die man einzeln vergessen kann.
 *
 * Gesät wird über rohes SQL statt über den Wächter: ein Wächterlauf ist der
 * geprüfte Erzeuger, und eine Fixture, die ihn benutzt, kann einen Fehler in
 * ihm aufsetzen und im selben Zug bestehen lassen (A95).
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const url = process.env.TEST_DATABASE_URL;
const SKRIPT = join(dirname(fileURLToPath(import.meta.url)), 'check-budgetfenster.mjs');

/**
 * **Jeder Fall bekommt seinen eigenen Monat statt eines `TRUNCATE`.**
 *
 * Der erste Entwurf räumte zwischen den Fällen auf — und `usage_samples` ist
 * append-only: der Wächter aus 0004 weist `TRUNCATE` auch dem Eigentümer ab
 * („Tabelle usage_samples ist append-only (§5/§18)"). Acht von neun Fällen
 * fielen daran, und das ist die Zusicherung, die hier arbeitet, nicht ein
 * Hindernis: eine Prüfung des Budgets darf ihre eigene Historie nicht löschen
 * können.
 *
 * Also disjunkte Zeitfenster, eines je Fall. Der Nebeneffekt ist ein besserer
 * Test: die Fälle sind voneinander unabhängig und in beliebiger Reihenfolge
 * lauffähig, was ein gemeinsamer Bestand nie garantiert (A110s Falle, in der
 * ein Fall nur grün war, wenn sein Nachbar vorher lief).
 */
let monat = 0;
const naechsterMonat = () => {
  monat += 1;
  return {
    von: new Date(Date.UTC(2026, monat, 1)).toISOString(),
    bis: new Date(Date.UTC(2026, monat, 20)).toISOString(),
    T: (tag: number, stunde = 12) => new Date(Date.UTC(2026, monat, tag, stunde, 0, 0)),
  };
};

describe.skipIf(!url)('check-budgetfenster', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('budgetfenster');
    sql = createSql({ url: database.url, max: 2 });
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
  });

  const lauf = (von: string, bis: string): { code: number; text: string } => {
    try {
      const text = execFileSync(process.execPath, [SKRIPT, '--von', von, '--bis', bis], {
        encoding: 'utf8',
        env: { ...process.env, DATABASE_URL: database.url, NO_COLOR: '1' },
      });
      return { code: 0, text };
    } catch (fehler) {
      const f = fehler as { status?: number; stdout?: string; stderr?: string };
      return { code: f.status ?? -1, text: `${f.stdout ?? ''}${f.stderr ?? ''}` };
    }
  };

  const probe = (at: Date, quelle: string, fenster: string, pct: number) => sql`
    INSERT INTO usage_samples (observed_at, window_kind, used_percent, source)
    VALUES (${at}, ${fenster}, ${pct}, ${quelle})
  `;
  const zustand = (at: Date, state: string, art = 'threshold') => sql`
    INSERT INTO guardian_events (occurred_at, state, reason, governing_window)
    VALUES (${at}, ${state}, ${sql.json({ kind: art })}, 'seven_day')
  `;

  it('meldet eine Überschreitung ohne Reaktion als Befund', async () => {
    const { von, bis, T } = naechsterMonat();
    await probe(T(2), 'official', 'seven_day', 10);
    await probe(T(3), 'official', 'seven_day', 88); // ≥ 85, und niemand reagiert

    const { code, text } = lauf(von, bis);
    expect(code).toBe(1);
    expect(text).toContain('erwartet wäre wrap_up');
    expect(text).toContain('1 unbehandelt');
  });

  it('nimmt eine Reaktion innerhalb der Toleranz an', async () => {
    const { von, bis, T } = naechsterMonat();
    await probe(T(5), 'official', 'seven_day', 10);
    await probe(T(6), 'official', 'seven_day', 88);
    await zustand(new Date(T(6).getTime() + 5 * 60_000), 'wrap_up');

    const { text } = lauf(von, bis);
    expect(text).toContain('wie §7.2 es vorsieht');
    expect(text).toContain('0 unbehandelt');
  });

  /**
   * Die Regel, ohne die jeder Lauf rot meldet: der Wächter schreibt **nur bei
   * Zustandswechsel**. Gemessen an den Betriebsdaten — am 12.8.2026 kam eine
   * offizielle 85 %, und der Wächter stand seit dem 9.8. auf `hard_stop`.
   */
  it('verlangt keinen Wechsel, wenn der Zustand schon hoch genug steht', async () => {
    const { von, bis, T } = naechsterMonat();
    await zustand(T(4), 'hard_stop');
    await probe(T(5), 'official', 'seven_day', 10);
    await probe(T(6), 'official', 'seven_day', 88);

    const { text } = lauf(von, bis);
    expect(text).toContain('stand bereits auf hard_stop');
    expect(text).toContain('0 unbehandelt');
  });

  /**
   * A101s Phantom-Stopp: sieben Tage `hard_stop` ohne Anlass. Eine Prüfung, die
   * nur „jede Überschreitung hat eine Reaktion" prüft, hätte ihn durchgewunken.
   */
  it('meldet einen Stopp, den keine Messung rechtfertigt', async () => {
    const { von, bis, T } = naechsterMonat();
    await probe(T(7), 'estimated', 'seven_day', 2);
    await zustand(T(8), 'hard_stop');

    const { code, text } = lauf(von, bis);
    expect(code).toBe(1);
    expect(text).toMatch(/Phantom-Stopp|keine Messung/);
  });

  /**
   * Die Trennung, die den ganzen Entwurf trägt: dieselbe Zahl bedeutet je nach
   * Quelle etwas anderes, und die Schwellen sind verschieden (85 gegen 75).
   */
  it('trennt `official` und `estimated` — Schwellen und Bedeutung von 100', async () => {
    const { von, bis, T } = naechsterMonat();
    await probe(T(9), 'estimated', 'seven_day', 2);
    await probe(T(10), 'estimated', 'seven_day', 78); // ≥ 75, aber < 85
    await probe(T(11), 'official', 'five_hour', 78); // < 85, also keine Überschreitung

    const { text } = lauf(von, bis);
    // Die Schätzung überschreitet, die offizielle Messung nicht.
    expect(text).toContain('estimated:seven_day auf 78.00 %');
    expect(text).not.toContain('official:five_hour auf 78.00 %');
  });

  it('nennt 100 % geschätzt einen Verdacht gegen den Zähler, nicht gegen das Konto', async () => {
    const { von, bis, T } = naechsterMonat();
    await probe(T(12), 'estimated', 'seven_day', 100);

    const { code, text } = lauf(von, bis);
    expect(code).toBe(1);
    expect(text).toContain('A101');
    expect(text).not.toContain('Das ist ein Limitereignis');
  });

  it('nennt 100 % offiziell ein Limitereignis', async () => {
    const { von, bis, T } = naechsterMonat();
    await probe(T(12), 'official', 'seven_day', 100);

    const { code, text } = lauf(von, bis);
    expect(code).toBe(1);
    expect(text).toContain('Limitereignis');
  });

  /**
   * A101.1: `<> 'allowed'` machte einmal jeden unbekannten Status zur
   * Ablehnung, einschliesslich des Literals `'unbekannt'`, das `headless.ts`
   * für eine unbekannte Rahmenform schreibt.
   */
  it('klassifiziert einen unbekannten Ankerstatus nicht — weder so noch so', async () => {
    const { von, bis, T } = naechsterMonat();
    await sql`
      INSERT INTO usage_window_anchors (observed_at, window_kind, resets_at, status)
      VALUES (${T(13)}, 'seven_day', ${T(14)}, 'unbekannt')
    `;
    const { code, text } = lauf(von, bis);
    expect(code).toBe(1);
    expect(text).toContain('unbekannter Status');
    expect(text).toContain('nicht beurteilbar');
  });

  it('zählt einen Tag nur als Betriebstag, wenn eine Sitzung ein Ergebnis lieferte', async () => {
    const { von, bis, T } = naechsterMonat();
    // Nur Messungen, keine Läufe: das sieht aus wie Ruhe und ist keine.
    for (let t = 2; t <= 14; t += 1) await probe(T(t), 'estimated', 'seven_day', 5);

    const { code, text } = lauf(von, bis);
    expect(code).toBe(1);
    expect(text).toContain('Längste zusammenhängende Betriebsstrecke: 0');
  });
});
