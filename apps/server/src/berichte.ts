/**
 * §16s Wochenbericht-Archiv über HTTP (§17, §22 Phase 8 Schritt 2).
 *
 * Lesen und sonst nichts. §16 erzeugt den Bericht in `report-pass.ts` — beim
 * Daemon, nach `evaluateReportSchedule`, mit `reports.period_start` als
 * Eindeutigkeitsschlüssel (0024). Eine Route, die einen Bericht **erzeugen**
 * könnte, wäre ein zweiter Erzeuger für dieselbe Zeile: sie müsste denselben
 * Zeitraum ableiten, denselben Duplikatfall behandeln und dieselbe
 * Ereigniszeile schreiben, und die beiden liefen beim ersten Sonderfall
 * auseinander. Der Adapter hat deshalb keine Schreibmethode, und das ist kein
 * fehlendes Stück, sondern die Aussage — dieselbe Trennung, die `A70.3` für den
 * Trockenlauf des Onboardings zieht: was nicht schreiben darf, bekommt keinen
 * Weg dorthin.
 *
 * Zwei Entscheidungen darüber hinaus.
 *
 *   1. **Die Liste ist gedeckelt, und der Deckel ist ein Jahr.** `list(52)` ist
 *      die Voreinstellung von `ReportRecords`; §18 hebt Ereignisse für immer
 *      auf, Berichte also auch, und eine ungedeckelte Liste wächst mit dem
 *      Betrieb, bis eine Seite sie nicht mehr trägt. 52 Wochen sind der
 *      Zeitraum, über den ein Mensch einen Trend liest.
 *
 *   2. **Ein Zeitraum, der kein Datum ist, endet als 404 und nicht als 500.**
 *      Der Pfadabschnitt ist ein ISO-Datum und geht nach Postgres; eine
 *      Zeichenkette, die keines ist, erzeugt dort `invalid input syntax` und
 *      käme als nackter 500 zurück — für einen Tippfehler in einer URL, in
 *      einer Anwendung ohne `app.onError`. `isPeriodStart` fängt das davor,
 *      wie `isSourceId` es für uuids tut.
 */
import type { Bericht, BerichteListe } from '@vorschicht/shared/berichte';

/** Was der Adapter aus `@vorschicht/core` braucht — nur Lesen (siehe oben). */
export interface BerichteReader {
  list(
    limit?: number,
  ): Promise<
    { id: string; periodStart: Date; periodEnd: Date; generatedAt: Date; subject: string }[]
  >;
  forPeriod(periodStart: Date): Promise<{
    id: string;
    periodStart: Date;
    periodEnd: Date;
    generatedAt: Date;
    subject: string;
    bodyText: string;
  } | null>;
}

export interface BerichteDeps {
  reports: BerichteReader;
}

export type BerichteResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'unknown'; errors: string[] }
  | { ok: false; reason: 'failed'; errors: string[] };

const UNKNOWN_REPORT = 'Für diesen Zeitraum gibt es keinen Bericht';

/** 52 Wochen — die Begründung steht oben in Entscheidung 1. */
export const ARCHIV_LIMIT = 52;

/**
 * Ein Zeitraumbeginn, oder nicht.
 *
 * Bewusst streng auf `YYYY-MM-DD`: `new Date('quatsch')` ergibt `Invalid Date`,
 * und das erst in der Abfrage zu bemerken heisst, den Fehler in Postgres zu
 * suchen. Die Länge allein reicht nicht — `2026-13-45` ist formgerecht und kein
 * Datum, also wird zusätzlich zurückgerechnet.
 */
export function isPeriodStart(raw: string | undefined): raw is string {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === raw;
}

/** §16s Archiv, neueste zuerst — die Reihenfolge, in der `ReportRecords.list` antwortet. */
export async function listReports(deps: BerichteDeps): Promise<BerichteResult<BerichteListe>> {
  const rows = await deps.reports.list(ARCHIV_LIMIT);
  return {
    ok: true,
    value: {
      berichte: rows.map((row) => ({
        id: row.id,
        periodStart: row.periodStart.toISOString(),
        periodEnd: row.periodEnd.toISOString(),
        generatedAt: row.generatedAt.toISOString(),
        subject: row.subject,
      })),
    },
  };
}

/** Ein Bericht im Volltext — der Klartext, aus dem Grund in `shared/berichte.ts`. */
export async function getReport(
  deps: BerichteDeps,
  periodStart: string | undefined,
): Promise<BerichteResult<{ bericht: Bericht }>> {
  if (!isPeriodStart(periodStart)) {
    return { ok: false, reason: 'unknown', errors: [UNKNOWN_REPORT] };
  }
  const row = await deps.reports.forPeriod(new Date(`${periodStart}T00:00:00.000Z`));
  if (!row) return { ok: false, reason: 'unknown', errors: [UNKNOWN_REPORT] };
  return {
    ok: true,
    value: {
      bericht: {
        id: row.id,
        periodStart: row.periodStart.toISOString(),
        periodEnd: row.periodEnd.toISOString(),
        generatedAt: row.generatedAt.toISOString(),
        subject: row.subject,
        bodyText: row.bodyText,
      },
    },
  };
}
