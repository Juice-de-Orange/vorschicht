/**
 * Lesen und Schreiben von `reports` — §5s Archiv für §16s Wochenbericht
 * (Migration 0024).
 *
 * Vier Regeln, und jede ist der Grund, warum das ein eigenes Modul ist und
 * nicht drei Abfragen im Generator:
 *
 *   1. **Hier wird nichts gerechnet und nichts gedeutet.** Die Kennzahlen
 *      kommen fertig herein, der Text kommt fertig herein. Dieses Modul legt
 *      ab und liest zurück. Dieselbe Trennung wie `DeployRecords` (A48.2): die
 *      Schicht, die schreibt, entscheidet nicht.
 *
 *   2. **`metrics` bleibt undurchsichtig.** Die Form der Kopfzahlen gehört dem
 *      Modul, das sie erhebt. Sie hier ein zweites Mal zu deklarieren wäre
 *      genau A81s Defekt — zwei unabhängige Deklarationen eines JSON-Dokuments,
 *      beide für sich getestet, und nichts, das die eine gegen die andere
 *      hält. Wer eine typisierte Sicht braucht, parst sie mit dem Schema seines
 *      Erzeugers; hier reist sie durch.
 *
 *   3. **Die Doppelung fängt der Index, nicht eine Vorabprüfung.** `record()`
 *      liest nicht erst nach, ob die Woche schon da ist — das wäre ein
 *      Lesen-dann-Schreiben, und zwei Ticks kämen beide durch. Geschrieben
 *      wird, und ein `23505` auf `reports_one_per_period` wird in einen
 *      deutschen Satz übersetzt. Jede andere Verletzung fliegt weiter: eine
 *      falsch etikettierte Ausnahme ist schlimmer als eine unetikettierte
 *      (A91).
 *
 *   4. **`list()` lädt keine Rümpfe.** §17s Archivseite zeigt eine Liste von
 *      Zeiträumen; jede Zeile mit zwei vollständigen Dokumenten zu füllen ist
 *      die Art Langsamkeit, die niemand bemerkt, bis das Archiv ein Jahr alt
 *      ist. Deshalb zwei Rückgabetypen und nicht einer mit optionalen Feldern.
 */
import type postgres from 'postgres';
import type { Queryable } from '../sql.js';

/** Postgres' Code für eine Verletzung einer Eindeutigkeitsbedingung. */
const UNIQUE_VIOLATION = '23505';

/**
 * Der Name aus 0024, ausdrücklich vergeben statt von Postgres abgeleitet,
 * damit diese Prüfung ihn zitieren kann statt ihn zu raten.
 *
 * Warum überhaupt auf den Namen geprüft wird und nicht bloss auf den Code: aus
 * diesem INSERT sind **zwei** Eindeutigkeitsbedingungen erreichbar — der
 * Primärschlüssel und diese hier —, und sie bedeuten Verschiedenes. Eine
 * uuid-Kollision ist praktisch unmöglich und deshalb erst recht kein Fall, den
 * man als „diese Woche gibt es schon" melden darf: die Meldung schickte den
 * Leser eine Woche lang in die falsche Richtung. A81 hat den bloßen Code dort
 * benutzt, wo **beide** erreichbaren Bedingungen dasselbe bedeuten, und das
 * ausdrücklich nachgeprüft; hier gilt das Gegenteil.
 */
const PERIOD_CONSTRAINT = 'reports_one_per_period';

export type ReportErrorKind = 'duplicate' | 'invalid_period';

export class ReportError extends Error {
  constructor(
    message: string,
    readonly kind: ReportErrorKind,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ReportError';
  }
}

export interface WeeklyReportInput {
  /** Anfang des Berichtsfensters, einschliessend. */
  periodStart: Date;
  /** Ende des Berichtsfensters, **ausschliessend** (0024, Entscheidung 3). */
  periodEnd: Date;
  /** Die Betreffzeile der Mail — Teil dessen, was ausgeliefert wurde. */
  subject: string;
  bodyText: string;
  bodyHtml: string;
  /** §16s Kopfzahlen, in der Form ihres Erzeugers (Regel 2). */
  metrics: Record<string, unknown>;
  /** Nur für Tests und Nachträge; sonst die Uhr der Datenbank. */
  generatedAt?: Date;
}

export interface ReportSummary {
  id: string;
  periodStart: Date;
  periodEnd: Date;
  generatedAt: Date;
  subject: string;
}

export interface ReportRecord extends ReportSummary {
  bodyText: string;
  bodyHtml: string;
  metrics: Record<string, unknown>;
}

interface ReportRow {
  id: string;
  period_start: Date;
  period_end: Date;
  generated_at: Date;
  subject: string;
  body_text: string;
  body_html: string;
  metrics: Record<string, unknown>;
}

type ReportSummaryRow = Omit<ReportRow, 'body_text' | 'body_html' | 'metrics'>;

export class ReportRecords {
  constructor(private readonly sql: Queryable) {}

  /**
   * Einen erzeugten Wochenbericht ablegen.
   *
   * Wird aufgerufen, sobald der Bericht **existiert** — nicht erst, wenn die
   * Mail draussen ist. Ob sie es wurde, steht im Ereignisprotokoll (0024,
   * Entscheidung 5); auf einem Host ohne SMTP entstehen sonst Wochen ohne
   * Archiveintrag, und §16s zweite Hälfte („archived in the dashboard") wäre
   * von der ersten abhängig, obwohl sie es nicht ist.
   */
  async record(input: WeeklyReportInput): Promise<ReportRecord> {
    // Die freundliche Hälfte von `reports_period_ordered`. Der CHECK bleibt die
    // tragende: er gilt auch für einen Schreiber, der hier vorbeikommt.
    if (input.periodEnd.getTime() <= input.periodStart.getTime()) {
      throw new ReportError(
        `Das Berichtsfenster endet nicht nach seinem Anfang ` +
          `(${input.periodStart.toISOString()} bis ${input.periodEnd.toISOString()}).`,
        'invalid_period',
      );
    }

    // Der Cast auf `timestamptz` unten ist nötig und nicht kosmetisch: ohne ihn
    // hat der NULL-Zweig keinen Typ und Postgres kann `COALESCE` nicht
    // auflösen. Die Vorgabe kommt aus der Uhr der Datenbank, damit ein Bericht
    // nicht die Uhr des Rechners trägt, der ihn gerade erzeugt hat.
    try {
      const rows = await this.sql<ReportRow[]>`
        INSERT INTO reports (
          period_start, period_end, generated_at,
          subject, body_text, body_html, metrics
        )
        VALUES (
          ${input.periodStart}, ${input.periodEnd},
          COALESCE(${input.generatedAt ?? null}::timestamptz, now()),
          ${input.subject}, ${input.bodyText}, ${input.bodyHtml},
          ${this.sql.json(input.metrics as postgres.JSONValue)}
        )
        RETURNING *
      `;
      // `RETURNING` liefert genau eine Zeile oder der INSERT hat geworfen.
      return toRecord(rows[0] as ReportRow);
    } catch (error) {
      if (!isDuplicatePeriod(error)) throw error;
      throw new ReportError(
        `Für das Fenster ab ${input.periodStart.toISOString()} gibt es bereits ` +
          'einen Wochenbericht. Das Archiv wird nicht überschrieben (§16, ' +
          'Migration 0024) — eine korrigierte Fassung ist eine eigene ' +
          'Entscheidung und kein zweiter Lauf.',
        'duplicate',
        { cause: error },
      );
    }
  }

  /** Der Bericht zu genau diesem Fensteranfang, oder nichts. */
  async forPeriod(periodStart: Date): Promise<ReportRecord | null> {
    const rows = await this.sql<ReportRow[]>`
      SELECT * FROM reports WHERE period_start = ${periodStart}
    `;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * Der jüngste Bericht — nach **Berichtsfenster**, nicht nach Erzeugungszeit.
   *
   * Der Unterschied ist keine Feinheit: ein nachgetragener Bericht für eine
   * ältere Woche wird *später* erzeugt, und „der jüngste Bericht" nach
   * `generated_at` wäre dann der über die ältere Woche. §17s Übersicht meint
   * die zuletzt berichtete Woche.
   */
  async latest(): Promise<ReportRecord | null> {
    const rows = await this.sql<ReportRow[]>`
      SELECT * FROM reports ORDER BY period_start DESC LIMIT 1
    `;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /**
   * §17s Archivliste, neueste Woche zuerst — ohne Rümpfe (Regel 4).
   *
   * Vorgabe 52: ein Jahr Wochen. Eine Zahl, die die Seite überschreiben darf,
   * aber keine, bei der eine vergessene Grenze das ganze Archiv über die
   * Leitung schickt.
   */
  async list(limit = 52): Promise<ReportSummary[]> {
    const rows = await this.sql<ReportSummaryRow[]>`
      SELECT id, period_start, period_end, generated_at, subject
      FROM reports
      ORDER BY period_start DESC
      LIMIT ${limit}
    `;
    return rows.map(toSummary);
  }
}

/**
 * Ist das die eine Verletzung, die „diese Woche gibt es schon" bedeutet?
 *
 * Duck-typed statt `instanceof sql.PostgresError`, aus dem Grund, den
 * `escalation-service.ts` nennt: `Queryable` ist `postgres.ISql`, damit eine
 * Transaktion übergeben werden kann, und `PostgresError` gehört zu `Sql`, nicht
 * zu `ISql`. Eine Einschränkung, keine Vorliebe.
 *
 * **Exportiert, damit die Regel widerlegbar ist**, und das ist der einzige
 * Grund. Aus `record()` heraus ist die zweite erreichbare
 * Eindeutigkeitsbedingung der Primärschlüssel über `gen_random_uuid()` — die
 * kann kein Test provozieren, also überlebte die Mutation „prüfe nur den Code"
 * unbemerkt, und die Namensprüfung läse sich wie abgedeckt, ohne es zu sein
 * (§8.2s sechste Domäne). Die reine Hälfte lässt sich direkt befragen; A125.3
 * hat denselben Schnitt für die Gate-Entscheidung gemacht.
 */
export function isDuplicatePeriod(error: unknown): boolean {
  const candidate = error as { code?: unknown; constraint_name?: unknown };
  return candidate.code === UNIQUE_VIOLATION && candidate.constraint_name === PERIOD_CONSTRAINT;
}

function toSummary(row: ReportSummaryRow): ReportSummary {
  return {
    id: row.id,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    generatedAt: row.generated_at,
    subject: row.subject,
  };
}

function toRecord(row: ReportRow): ReportRecord {
  return {
    ...toSummary(row),
    bodyText: row.body_text,
    bodyHtml: row.body_html,
    metrics: row.metrics,
  };
}
