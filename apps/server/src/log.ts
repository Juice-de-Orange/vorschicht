/**
 * §18s Log-Explorer über HTTP — „a queryable log explorer in the dashboard
 * (filter by project/task/level/time + full-text)".
 *
 * Der Vertrag liegt in `@vorschicht/shared/log` und entscheidet, was eine Stufe
 * ist, was als Rauschen gilt und wie geblättert wird. Dieses Modul stellt genau
 * die Abfragen, die daraus folgen, und nichts sonst — es ist **schreibfrei** von
 * Konstruktion: es gibt hier keine Methode, die etwas ändert, und §18 macht
 * `event_log` zur Wahrheitsquelle, die niemand rückwirkend bearbeitet.
 *
 * Fünf Dinge, die nur an dieser Grenze entstehen.
 *
 *  1. **Eine Verweigerung ist ein Wert, keine Ausnahme.** `spuren.ts`,
 *     `quellen.ts` und `dokumente.ts` halten es so, und es ist tragend statt
 *     ordentlich: es gibt in dieser App nirgends ein `app.onError`, ein `throw`
 *     würde also zu einem nackten 500 mit englischem Stack auf einer Seite, deren
 *     jeder andere Satz deutsch ist (§2).
 *
 *  2. **Die Stufe wird beim Lesen abgeleitet, nicht in SQL.** `logStufe` ist die
 *     eine Zuordnung; ein zweites `CASE kind WHEN …` in einer Abfrage wäre eine
 *     zweite, die genau so lange übereinstimmt, bis jemand eine ändert (A81).
 *     Der Preis ist genannt: der **Stufenfilter** muss deshalb in SQL über die
 *     Menge der Arten dieser Stufe gehen, und die kommt aus derselben Tabelle.
 *
 *  3. **Der Volltextausdruck steht hier wörtlich so wie in Migration 0023.**
 *     Weicht einer ab, bleibt die Abfrage korrekt und wird still langsam — die
 *     unangenehmere Richtung, weil nichts rot wird. `log.test.ts` hält beide
 *     gegeneinander.
 *
 *  4. **`unterdrueckt` ist eine Zahl über denselben Ausschnitt**, den die Seite
 *     zeigt, und nicht über die ganze Tabelle: sonst stünde neben zwanzig Zeilen
 *     eine Zahl aus einem halben Jahr. Der Ausschnitt ist der `id`-Bereich der
 *     gezeigten Zeilen; ist er leer, ist es alles unterhalb des Cursors, was
 *     dann auch die richtige Antwort ist („hier ist nichts ausser Rauschen").
 *
 *  5. **Die Projektliste kommt mit.** Ein Auswahlfeld, das seine Optionen aus
 *     den gerade sichtbaren Zeilen zöge, könnte nach einem Projekt gar nicht
 *     filtern, dessen Zeilen von der Vorgabe verdeckt sind.
 */

import { EVENT_KINDS } from '@vorschicht/shared/events';
import {
  LOG_RAUSCH_ART,
  LOG_RAUSCH_GRUENDE,
  type LogAntwortResponse,
  type LogFilter,
  type LogZeile,
  logStufe,
  parseLogFilter,
} from '@vorschicht/shared/log';
import type postgres from 'postgres';

/**
 * Zwei Ausgänge, zwei Statuscodes.
 *
 * Kein `unknown` und kein `invalid`: hier wird nichts eingereicht und nichts
 * adressiert — `parseLogFilter` macht aus jeder unbrauchbaren Eingabe „kein
 * Filter" statt einer Ablehnung (`@vorschicht/shared/log`), also gibt es keine
 * Anfrage, die ein Aufrufer falsch stellen könnte.
 */
export type LogRouteResult =
  | { ok: true; value: LogAntwortResponse }
  | { ok: false; reason: 'failed'; errors: string[] };

export const LOG_STATUS = { failed: 500 } as const;

export interface LogDeps {
  sql: postgres.Sql;
}

/**
 * Derselbe Ausdruck wie in Migration 0023 — Entscheidung 3.
 *
 * Als exportierte Konstante, damit ein Test ihn gegen die Migrationsdatei halten
 * kann. Ein Ausdruck, der nur im SQL-Literal steht, driftet lautlos.
 */
export const LOG_VOLLTEXT_AUSDRUCK = `jsonb_to_tsvector('simple', payload, '["all"]')`;

interface LogRow {
  id: string | number;
  occurred_at: Date;
  kind: string;
  actor: string;
  project_id: string | null;
  task_id: string | null;
  run_id: string | null;
  deploy_id: string | null;
  payload: unknown;
}

/**
 * Die Arten, die zu einer Stufe gehören.
 *
 * Aus `EVENT_LEVELS` abgeleitet statt in SQL nachgebaut (Entscheidung 2). Eine
 * Stufe, zu der keine bekannte Art gehört, ergibt eine leere Menge — und die
 * Abfrage muss dann **nichts** zurückgeben statt alles, was der andere Fehler
 * wäre und den Filter stillschweigend abschalten würde.
 */
export function artenDerStufe(level: LogFilter['level']): string[] {
  if (level === null) return [];
  return EVENT_KINDS.filter((kind) => logStufe(kind) === level);
}

export async function listLog(deps: LogDeps, params: URLSearchParams): Promise<LogRouteResult> {
  const filter = parseLogFilter(params);
  try {
    const sql = deps.sql;
    const rauschGruende = [...LOG_RAUSCH_GRUENDE];

    // **Eine** Deklaration dessen, was Rauschen ist — der Filter unten und die
    // Zahl neben dem Schalter lesen dieselbe. Zwei Fassungen wären zwei
    // Stellen, an denen dieselbe Frage verschieden beantwortet wird, und die
    // Zahl behauptete dann etwas über einen Ausschnitt, den sie nicht meint
    // (A81).
    //
    // A149: nicht die ganze Art, sondern die beiden Vielschreiber **ohne**
    // Übergangsmarke. Alles andere unter `guardian.anomaly` — ein
    // fehlgeschlagenes Aufräumprotokoll, eine unlesbare Pause — bleibt
    // sichtbar, und eine Übergangszeile (`resolved` gesetzt) auch.
    //
    // `IS NOT NULL` ist nicht Zierde, sondern der Defekt, den der
    // Integrationstest gefangen hat: `payload ->> 'reason'` ist bei
    // `pause_unreadable` NULL, und `NULL = ANY(…)` ergibt in SQL **NULL** statt
    // `false`. `NOT (… AND NULL AND …)` ist wieder NULL, und ein `WHERE` wertet
    // NULL wie falsch — die Zeile fiel heraus. Der Filter verbarg damit genau
    // einen der Alarme, für die A149 ihn überhaupt geändert hat.
    const istRauschen = sql`
      kind = ${LOG_RAUSCH_ART}
      AND payload ->> 'reason' IS NOT NULL
      AND payload ->> 'reason' = ANY(${rauschGruende})
      AND payload ->> 'resolved' IS NULL
    `;
    const stufenArten = artenDerStufe(filter.level);

    // Ein `WHERE` aus Bausteinen: `postgres`s Fragment-API setzt jede Bedingung
    // parametrisiert ein, es gibt hier also keine Zeichenkettenverkettung mit
    // Nutzereingaben — und die Bedingungen stehen einmal, damit die Zählung
    // unten dieselben benutzt.
    const bedingungen = (mitRauschfilter: boolean) => sql`
      TRUE
      ${filter.from ? sql`AND occurred_at >= ${`${filter.from}T00:00:00Z`}` : sql``}
      ${filter.to ? sql`AND occurred_at < ${`${filter.to}T00:00:00Z`}::timestamptz + interval '1 day'` : sql``}
      ${filter.kind ? sql`AND kind = ${filter.kind}` : sql``}
      ${filter.level ? sql`AND kind = ANY(${stufenArten})` : sql``}
      ${filter.projectId ? sql`AND project_id = ${filter.projectId}::uuid` : sql``}
      ${filter.taskId ? sql`AND task_id = ${filter.taskId}::uuid` : sql``}
      ${
        filter.search
          ? sql`AND (
              jsonb_to_tsvector('simple', payload, '["all"]')
                @@ websearch_to_tsquery('simple', ${filter.search})
              OR kind ILIKE ${`%${filter.search}%`}
              OR actor ILIKE ${`%${filter.search}%`}
            )`
          : sql``
      }
      ${mitRauschfilter && !filter.noise ? sql`AND NOT (${istRauschen})` : sql``}
    `;

    const rows = await sql<LogRow[]>`
      SELECT id, occurred_at, kind, actor, project_id, task_id, run_id, deploy_id, payload
      FROM event_log
      WHERE ${bedingungen(true)}
        ${filter.before ? sql`AND id < ${filter.before}` : sql``}
      ORDER BY id DESC
      LIMIT ${filter.limit}
    `;

    const eintraege: LogZeile[] = rows.map((row) => ({
      id: Number(row.id),
      occurredAt: row.occurred_at.toISOString(),
      kind: row.kind,
      level: logStufe(row.kind),
      actor: row.actor,
      projectId: row.project_id,
      taskId: row.task_id,
      runId: row.run_id,
      deployId: row.deploy_id,
      payload: row.payload,
    }));

    const aeltesteId = eintraege.at(-1)?.id ?? null;
    const [{ n: unterdrueckt } = { n: '0' }] = filter.noise
      ? [{ n: '0' }]
      : await sql<Array<{ n: string }>>`
          SELECT count(*) AS n FROM event_log
          WHERE ${bedingungen(false)}
            AND ${istRauschen}
            ${filter.before ? sql`AND id < ${filter.before}` : sql``}
            ${aeltesteId === null ? sql`` : sql`AND id >= ${aeltesteId}`}
        `;

    const projekte = await sql<Array<{ id: string; slug: string; name: string }>>`
      SELECT id, slug, name FROM projects ORDER BY slug
    `;

    return {
      ok: true,
      value: {
        log: {
          eintraege,
          // Vom Erzeuger gesetzt: „es gibt noch mehr" ist eine Aussage über die
          // Datenbank, und eine volle Seite ist dafür nur ein Indiz. Eine
          // kürzere Seite kann nichts mehr nachliefern, eine volle vielleicht —
          // und der Cursor ist dann die kleinste gezeigte Id.
          naechsteSeite: eintraege.length < filter.limit ? null : (aeltesteId ?? null),
          unterdrueckt: Number(unterdrueckt),
          projekte,
          limit: filter.limit,
        },
      },
    };
  } catch (error) {
    return {
      ok: false,
      reason: 'failed',
      errors: [`Das Protokoll konnte nicht gelesen werden: ${(error as Error).message}`],
    };
  }
}
