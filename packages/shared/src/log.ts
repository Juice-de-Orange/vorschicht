/**
 * §18s Log-Explorer — die Leitung zwischen `/api/log` und der Seite.
 *
 * §18 verlangt „a queryable log explorer in the dashboard (filter by
 * project/task/level/time + full-text)". Es gab ihn **gar nicht**: keine Datei,
 * keine Route, keinen Reiter, keine Konstante. Das ist das Werkzeug, mit dem der Betreiber
 * nachsieht, warum etwas schiefging, statt zu fragen — und ohne es ist §1s
 * Prinzip 4 („every error … traceable end to end") an genau der Stelle
 * unterbrochen, an der jemand ohne Vorwissen anfängt.
 *
 * Vier Entscheidungen, und die erste ist die, die §18s Wortlaut nicht erfüllen
 * kann, ohne etwas zu erfinden.
 *
 *  1. **§18 nennt „level", und `event_log` hat keine Stufenspalte.** Stufen
 *     leben in den pino-Logs der Dienste, nicht im Ereignisprotokoll. Eine
 *     `level`-Spalte hier zu erfinden hiesse, eine Zahl zu erzeugen, die
 *     **aussieht wie eine Messung** und in Wahrheit eine Zuordnung ist, die
 *     jemand einmal getroffen hat. Also wird sie aus der **Ereignisart
 *     abgeleitet**, die Zuordnung steht ausgeschrieben in `EVENT_LEVELS`, und
 *     die Oberfläche sagt, dass sie abgeleitet ist. `EVENT_LEVELS` ist ein
 *     `Record<EventKind, …>`, also bricht eine neue Ereignisart ohne Stufe den
 *     Build — Mechanismus statt Vorsatz (A44.3), und daneben ein Drift-Test, der
 *     auch einen *überzähligen* Schlüssel findet, den der Typ durchlässt.
 *
 *  2. **`guardian.anomaly` wird ausgeblendet und das wird gesagt.** A64 macht
 *     den Zustand `rate_limits_unavailable` zum **Dauerzustand** unter
 *     Token-Auth, nicht zu einem Ausfall, und A101 hat gemessen, was das im
 *     Protokoll anrichtet: 18 411 von 18 747 Zeilen einer Woche waren die
 *     Divergenzmeldung *eines* Defekts. Ein Explorer, der sie zeigt, ist
 *     unbenutzbar; einer, der sie **stillschweigend** wegfiltert, ist genau die
 *     Klasse, die dieses Projekt sonst als Fund führt. Also: Vorgabe aus,
 *     Schalter da, und die Antwort trägt die **Zahl** der unterdrückten Zeilen —
 *     eine Aussage über das, was fehlt, statt einer Abwesenheit.
 *
 *  3. **Blättern über `id`, nicht über einen Offset.** Dieselbe Wahl wie beim
 *     SSE-Nachholpfad und aus demselben Grund: ein Offset über eine wachsende
 *     Tabelle überspringt Zeilen, während man blättert. `id` ist streng monoton
 *     und eindeutig, also kann ein Cursor darauf nichts auslassen und nichts
 *     doppelt zeigen.
 *
 *  4. **`kind` reist als Zeichenkette, nicht als Enum.** Eine Zeile, die ein
 *     älterer oder neuerer Build geschrieben hat, muss lesbar bleiben — §18 hebt
 *     diese Tabelle für immer auf, und ein `z.enum` machte aus einer alten Zeile
 *     einen Parse-Fehler für die **ganze Seite**. Die Stufe fällt dann auf
 *     `warnung` zurück (siehe `logStufe`), weil eine Art, die das Dashboard
 *     nicht kennt, eine Abweichung zwischen zwei Hälften dieses Systems ist und
 *     auffindbar sein soll.
 *
 * Browser-sicher wie die Geschwister: nur `zod` und Blattmodule (A75.5).
 */
import { z } from 'zod';
import { EVENT_KINDS, type EventKind } from './events.js';

// --- Pfade und Abfrage -------------------------------------------------------

/** §18s Log-Explorer im Dashboard. */
export const LOG_PFAD = '/log';
export const LOG_API = '/api/log';

/** Die Abfrageschlüssel, einmal benannt, damit Seite und Route sie nicht anders schreiben. */
export const LOG_QUERY = {
  from: 'von',
  to: 'bis',
  kind: 'art',
  level: 'stufe',
  project: 'projekt',
  task: 'aufgabe',
  search: 'suche',
  /** Cursor: nur Zeilen mit kleinerer `id` (Entscheidung 3). */
  before: 'vor',
  limit: 'limit',
  /** `1` blendet §18s Rauschen ein (Entscheidung 2). */
  noise: 'rauschen',
} as const;

/** Was ein Auswahlfeld „alle" nennt — kein Filter, nicht ein Wert namens „alle". */
export const LOG_ALLE = 'alle';

// --- Stufen ------------------------------------------------------------------

export const LOG_LEVELS = ['alarm', 'warnung', 'info'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Deutsch (§2) — wie die Stufen auf der Seite heissen. */
export const LOG_LEVEL_LABELS: Record<LogLevel, string> = {
  alarm: 'Alarm',
  warnung: 'Warnung',
  info: 'Information',
};

/**
 * Die Zuordnung Ereignisart → Stufe, ausgeschrieben (Entscheidung 1).
 *
 * Die Regel, nach der sie getroffen ist, damit die nächste Ereignisart nicht
 * geraten wird:
 *
 *   * **alarm** — etwas ist kaputt und jemand muss handeln. Ausfälle, Vorfälle,
 *     Rollbacks, der Ops-Alarm, ein Dispatcher-Defekt, eine gescheiterte
 *     Sicherung.
 *   * **warnung** — etwas ist nicht wie beabsichtigt, und das Studio kommt damit
 *     zurecht. Ein Fund, ein Wächterwechsel, ein Abbruch nach §7.3, eine
 *     Divergenz der beiden Budgetzähler.
 *   * **info** — der gewöhnliche Verlauf.
 *
 * `guardian.state_changed` steht bewusst auf `warnung`, obwohl §7.2 die
 * *Benachrichtigung* dazu `vorschicht-info` zuweist. Das sind zwei Fragen: dort
 * geht es darum, wie laut ein Telefon wird, hier darum, ob eine Zeile beim
 * Durchsehen auffallen soll — und ein Wechsel nach `wrap_up` oder `hard_stop`
 * soll das immer.
 */
export const EVENT_LEVELS: Record<EventKind, LogLevel> = {
  'system.started': 'info',
  'system.stopped': 'info',
  'system.selfcheck_failed': 'alarm',
  'auth.incident': 'alarm',
  'guardian.state_changed': 'warnung',
  'guardian.anomaly': 'warnung',
  'usage.sampled': 'info',
  'run.created': 'info',
  'run.started': 'info',
  'run.finished': 'info',
  // §7.3s Abbruch: gewollt, aber die Aufgabe braucht danach §7.2s Nachprüfung.
  'run.interrupted': 'warnung',
  'task.created': 'info',
  'task.state_changed': 'info',
  'task.failed': 'alarm',
  'task.escalated': 'alarm',
  'chain.finished': 'info',
  'task.integrity_checked': 'info',
  'scheduler.defect': 'alarm',
  'worktree.created': 'info',
  'worktree.released': 'info',
  'worktree.gc': 'info',
  'claims.acquired': 'info',
  'claims.released': 'info',
  // §11: jeder Fund ist ein Blocker — aber der Merge hält ihn auf, also handelt
  // das Studio bereits. Alarm ist die Stufe für das, was liegen bleibt.
  'finding.reported': 'warnung',
  'escalation.requested': 'info',
  'escalation.raised': 'info',
  'escalation.answered': 'info',
  'escalation.precedent_applied': 'info',
  'escalation.resumed': 'info',
  'escalation.pushed': 'info',
  'escalation.reminded': 'info',
  'escalation.digest_sent': 'info',
  'gate.finished': 'info',
  'gate.migration_review': 'info',
  'merge.finished': 'info',
  'ops.alert': 'alarm',
  'scan.finished': 'info',
  'radar.finished': 'info',
  'radar.applied': 'info',
  'backup.succeeded': 'info',
  'backup.failed': 'alarm',
  'disk.checked': 'info',
  'deploy.finished': 'info',
  'deploy.failed': 'alarm',
  'report.generated': 'info',
  'report.sent': 'info',
  'deploy.succeeded': 'info',
  'deploy.rolled_back': 'alarm',
  'onboarding.proposed': 'info',
  'onboarding.failed': 'warnung',
  'onboarding.applied': 'info',
  'source.proposed': 'info',
  'source.curated': 'info',
  'audit.started': 'info',
  'audit.finished': 'info',
  // §8.2s Fund: er blockiert nichts von selbst, aber er ist der Grund, warum
  // diese Abteilung existiert.
  'audit.finding': 'warnung',
  'idle_audit.started': 'info',
  'idle_audit.finished': 'info',
};

/**
 * Die Stufe einer Zeile.
 *
 * Eine unbekannte Art ist `warnung` und nicht `info`: sie bedeutet, dass eine
 * Zeile von einem Build stammt, den dieses Dashboard nicht kennt, und das soll
 * beim Durchsehen auffallen statt im gewöhnlichen Verlauf unterzugehen. Der
 * Fall ist selten — `EVENT_LEVELS` ist typvollständig, also fällt eine *neue*
 * Art beim Bauen auf —, aber §18 hebt alte Zeilen für immer auf.
 */
export function logStufe(kind: string): LogLevel {
  return (EVENT_LEVELS as Record<string, LogLevel | undefined>)[kind] ?? 'warnung';
}

// --- §18s Rauschen -----------------------------------------------------------

/**
 * Was die Vorgabe ausblendet (Entscheidung 2) — **grund-bewusst seit A149**.
 *
 * Vorher war es die ganze Art `guardian.anomaly`, und das war A67.6
 * eingetreten: unter derselben Art melden auch `pause_unreadable`,
 * `wrap_up_incomplete`, `wrap_up_failed`, `scale_mismatch` und
 * `unknown_window_kinds`. „Das Aufräumprotokoll ist fehlgeschlagen — Aufgaben
 * prüfen" stand damit hinter einem Schalter, den man erst umlegen muss. Der
 * Kanal war stummgeschaltet, und die nächste echte Meldung wäre unsichtbar
 * gewesen.
 *
 * Verborgen wird deshalb **nur die gemessene Flut**, und auch die nur in ihrer
 * alten Form:
 *
 *   - `reason` ist einer der beiden Vielschreiber, **und**
 *   - die Zeile trägt **kein** `resolved`.
 *
 * Die zweite Bedingung ist die interessante. Seit A149 meldet der Zähler beim
 * **Übergang** und schreibt `resolved: false` beim Eintritt und `true` beim
 * Ende. Solche Zeilen sind selten und tragen Information — sie bleiben
 * sichtbar. Ohne `resolved` ist eine Zeile aus der Flutzeit: am 25.8.2026 lagen
 * davon **31.138 von 32.034** Zeilen im Protokoll, also 97,2 %. Sie bleiben
 * nach §18 stehen und werden nur nicht mehr vorgelegt.
 */
export const LOG_RAUSCH_ART: EventKind = 'guardian.anomaly';

/** Die beiden Gründe, die die Flut erzeugt haben (A149). */
export const LOG_RAUSCH_GRUENDE: readonly string[] = [
  'rate_limits_unavailable',
  'meter_divergence',
];

/**
 * Bleibt als Art-Liste bestehen, weil mehrere Stellen sie so lesen — sie nennt
 * jetzt die Art, deren *Teilmenge* gefiltert wird, nicht mehr die ganze Art.
 */
export const LOG_NOISY_KINDS: readonly EventKind[] = [LOG_RAUSCH_ART];

/** Deutsch (§2) — was ausgeblendet wird und warum. Steht auf der Seite. */
export const LOG_NOISE_ERKLAERUNG =
  'Voreingestellt ausgeblendet: die Dauermeldungen der Budget-Gegenprobe ' +
  '(guardian.anomaly mit rate_limits_unavailable oder meter_divergence, ohne Übergangsmarke). ' +
  'Am 25.8.2026 waren das 31 138 von 32 034 Zeilen (A149). Alarme derselben Art — etwa ein ' +
  'fehlgeschlagenes Aufräumprotokoll — bleiben sichtbar, ebenso jede Übergangsmeldung. ' +
  'Der Schalter zeigt auch den Rest, und die Zahl daneben sagt, wie viele in diesem ' +
  'Ausschnitt gerade verborgen sind.';

// --- der Filter --------------------------------------------------------------

export interface LogFilter {
  from: string | null;
  to: string | null;
  kind: string | null;
  level: LogLevel | null;
  projectId: string | null;
  taskId: string | null;
  search: string | null;
  before: number | null;
  limit: number;
  /** True zeigt auch `LOG_NOISY_KINDS`. Vorgabe: false. */
  noise: boolean;
}

export const LOG_DEFAULT_LIMIT = 100;
export const LOG_MAX_LIMIT = 500;

/**
 * Die Abfrage lesen, ohne je zu raten.
 *
 * Alles, was nicht eindeutig ist, wird zu „kein Filter" — und **niemals** zu
 * einem geratenen: ein `stufe=dringend` filtert nichts, statt auf `alarm` zu
 * fallen. Eine Seite, die eine unbekannte Eingabe als eine bekannte behandelt,
 * zeigt eine Liste, die etwas anderes ist als die Frage, die gestellt wurde.
 */
export function parseLogFilter(params: URLSearchParams): LogFilter {
  const wert = (key: string): string | null => {
    const roh = params.get(key);
    if (roh === null) return null;
    const getrimmt = roh.trim();
    return getrimmt === '' || getrimmt === LOG_ALLE ? null : getrimmt;
  };

  const level = wert(LOG_QUERY.level);
  const before = Number(params.get(LOG_QUERY.before));
  const limit = Number(params.get(LOG_QUERY.limit));

  return {
    from: isoDatum(wert(LOG_QUERY.from)),
    to: isoDatum(wert(LOG_QUERY.to)),
    kind: kennungOderNull(wert(LOG_QUERY.kind)),
    level: (LOG_LEVELS as readonly string[]).includes(level ?? '') ? (level as LogLevel) : null,
    projectId: uuidOderNull(wert(LOG_QUERY.project)),
    taskId: uuidOderNull(wert(LOG_QUERY.task)),
    search: wert(LOG_QUERY.search),
    before: Number.isSafeInteger(before) && before > 0 ? before : null,
    limit:
      Number.isFinite(limit) && limit > 0
        ? Math.min(Math.floor(limit), LOG_MAX_LIMIT)
        : LOG_DEFAULT_LIMIT,
    noise: params.get(LOG_QUERY.noise) === '1',
  };
}

/** `YYYY-MM-DD`, oder null. Bewusst nicht `new Date(x)`, das Prosa annimmt. */
function isoDatum(roh: string | null): string | null {
  if (!roh || !/^\d{4}-\d{2}-\d{2}$/.test(roh)) return null;
  return Number.isNaN(Date.parse(`${roh}T00:00:00Z`)) ? null : roh;
}

/**
 * Eine Ereignisart, oder null.
 *
 * Geprüft gegen `event_log_kind_format` aus 0001 statt gegen `EVENT_KINDS`: nach
 * Entscheidung 4 muss eine Zeile aus einem anderen Build filterbar bleiben, und
 * die Prüfung dient hier nur dazu, dass nichts Unerwartetes in eine Abfrage
 * gerät.
 */
function kennungOderNull(roh: string | null): string | null {
  return roh && /^[a-z][a-z0-9_.]*$/.test(roh) ? roh : null;
}

/** Strikt, damit ein Tippfehler kein `invalid input syntax for type uuid` wird. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuidOderNull(roh: string | null): string | null {
  return roh && UUID.test(roh) ? roh : null;
}

// --- die Antwort -------------------------------------------------------------

export const logZeile = z.object({
  id: z.number().int(),
  occurredAt: z.string(),
  /** Entscheidung 4: eine Zeichenkette, damit eine alte Zeile lesbar bleibt. */
  kind: z.string(),
  level: z.enum(LOG_LEVELS),
  actor: z.string(),
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  runId: z.string().nullable(),
  deployId: z.string().nullable(),
  /**
   * Die Nutzlast, ganz.
   *
   * `spurEreignis.payload`s Begründung, eine Seite weiter: §18 macht diese
   * Tabelle zur Wahrheitsquelle und diese Seite zu dem Ort, an dem sie gelesen
   * wird — eine Projektion entschiede hier, welche Tatsachen ein Prüfer sehen
   * darf. Die Seite rendert jeden Wert als **Text**, nie als Markup.
   */
  payload: z.unknown(),
});
export type LogZeile = z.infer<typeof logZeile>;

export const logProjekt = z.object({ id: z.string(), slug: z.string(), name: z.string() });

export const logAntwort = z.object({
  eintraege: z.array(logZeile),
  /**
   * Der Cursor für die nächste Seite: die kleinste gezeigte `id`, oder null,
   * wenn dieser Ausschnitt der letzte war.
   *
   * Vom Erzeuger gesetzt statt von der Seite aus der Liste gezogen: „es gibt
   * noch mehr" ist eine Aussage über die Datenbank, und eine volle Seite ist
   * dafür nur ein Indiz (die letzte Seite kann genau `limit` Zeilen haben).
   */
  naechsteSeite: z.number().int().nullable(),
  /**
   * Wie viele Zeilen die Rauschvorgabe **in diesem Ausschnitt** verbirgt.
   *
   * Der Ausschnitt ist der `id`-Bereich, den die gezeigten Zeilen aufspannen;
   * ist er leer, sind es alle passenden Zeilen unterhalb des Cursors. Eine Zahl
   * statt einer Abwesenheit — das ist der Unterschied zwischen einem ehrlichen
   * Filter und einem stillen (Entscheidung 2).
   */
  unterdrueckt: z.number().int().min(0),
  /** Die Projekte, aus denen das Auswahlfeld seine Optionen baut. */
  projekte: z.array(logProjekt),
  /** Die Seitengrösse, mit der geantwortet wurde. */
  limit: z.number().int().positive(),
});
export type LogAntwort = z.infer<typeof logAntwort>;

/** Deutscher Umschlagsschlüssel, englische Felder (A81.2). */
export const logAntwortResponse = z.object({ log: logAntwort });
export type LogAntwortResponse = z.infer<typeof logAntwortResponse>;

/** Alle Arten, für das Auswahlfeld — sortiert, weil eine Liste von 55 sonst rät. */
export const LOG_KIND_OPTIONEN: readonly string[] = [...EVENT_KINDS].sort();
