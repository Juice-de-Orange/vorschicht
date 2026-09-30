/**
 * §18s Log-Explorer in reinen Funktionen.
 *
 * Dieselbe Anordnung wie die übrigen `*-format.ts` und aus demselben Grund:
 * `apps/web` hat **keine DOM-Testumgebung**, also ist eine Regel, die in einer
 * Komponente wohnt, eine Regel, an die nur Playwright herankommt.
 *
 * Die Formen sind `@vorschicht/shared/log`s und werden **geparst**, nie gecastet
 * (A81). Was hier hinzukommt, ist Deutsch — und die eine Sache, die diese Seite
 * von den anderen unterscheidet: sie sagt, **was sie nicht zeigt**.
 */
import {
  LOG_ALLE,
  LOG_LEVEL_LABELS,
  LOG_NOISE_ERKLAERUNG,
  LOG_PFAD,
  LOG_QUERY,
  type LogAntwort,
  type LogFilter,
  type LogLevel,
  type LogZeile,
  logAntwortResponse,
  parseLogFilter,
} from '@vorschicht/shared/log';
import { type Gelesen, lies } from './inbox-format.js';

export type { LogAntwort, LogFilter, LogLevel, LogZeile };
export { LOG_ALLE, LOG_LEVEL_LABELS, LOG_NOISE_ERKLAERUNG, LOG_PFAD, LOG_QUERY };

/**
 * Der Anfangsfilter aus der Adresszeile.
 *
 * **Gefunden am 18.8.2026, von dem einen Browserfall, der rot wurde** — und der
 * Weg dahin gehört dazu, weil er zeigt, warum eine einseitige Zusicherung nichts
 * sagt. Die Seite las ihren Filter aus einer leeren Vorgabe plus der Id aus dem
 * Deep-Link `/log/<id>`; die **Abfragezeichenkette** hat sie nie angesehen.
 * `parseLogFilter` gab es dafür längst, aber sein einziger Aufrufer war der
 * Server.
 *
 * Der Fall prüfte zwei Dinge: dass `?suche=<wort>` die passende Zeile zeigt, und
 * dass `?suche=<unsinn>` den Leerzustand zeigt. **Die erste Hälfte war grün, und
 * zwar aus dem falschen Grund** — wenn der Filter gar nicht ankommt, werden alle
 * Zeilen gezeigt und die gesuchte ist darunter. Erst die zweite Hälfte, die auf
 * eine *Abwesenheit* zielt, hat den Defekt sichtbar gemacht. Ohne sie wäre eine
 * tote Verdrahtung als geprüft durchgegangen (§8.2, Domäne 6).
 *
 * Rein und mit `URLSearchParams` als Argument statt `window.location` von innen
 * gelesen: `apps/web` hat keine DOM-Testumgebung, und eine Funktion, die sich
 * ihre Eingabe selbst holt, ist genau die, an die nur Playwright herankommt.
 *
 * Die Id aus dem Pfad **sticht** ein `vor=` aus der Abfrage: wer einen Deep-Link
 * auf eine Zeile öffnet, will das Protokoll an dieser Zeile, und die beiden
 * gleichzeitig zu meinen ergibt keinen sinnvollen Zustand.
 */
export function logAnfangsfilter(
  params: URLSearchParams,
  angesteuert: number | null,
): Pick<LogFilter, 'from' | 'to' | 'kind' | 'level' | 'projectId' | 'search' | 'noise'> & {
  before: number | null;
} {
  const filter = parseLogFilter(params);
  return {
    from: filter.from,
    to: filter.to,
    kind: filter.kind,
    level: filter.level,
    projectId: filter.projectId,
    search: filter.search,
    noise: filter.noise,
    before: angesteuert === null ? filter.before : angesteuert + 1,
  };
}

/** Die Antwort, oder ein deutscher Satz über ihre Form. */
export function liesLog(koerper: unknown): Gelesen<{ log: LogAntwort }> {
  return lies(logAntwortResponse, koerper, 'das Protokoll');
}

/**
 * Was die Seite gerade abfragt, als Query.
 *
 * Ein Erzeuger für die Abfrage, damit die Seite und ein Deep-Link nicht zwei
 * Schreibweisen derselben Frage bauen — §15s `/inbox` gegen `/posteingang` ist
 * die Klasse, die das kostet (A81.3). Leere Filter werden **weggelassen** statt
 * als `alle` geschrieben: eine Adresse soll sagen, was gefragt wurde.
 */
export function logAbfrage(filter: Partial<LogFilter>): string {
  const params = new URLSearchParams();
  if (filter.from) params.set(LOG_QUERY.from, filter.from);
  if (filter.to) params.set(LOG_QUERY.to, filter.to);
  if (filter.kind) params.set(LOG_QUERY.kind, filter.kind);
  if (filter.level) params.set(LOG_QUERY.level, filter.level);
  if (filter.projectId) params.set(LOG_QUERY.project, filter.projectId);
  if (filter.taskId) params.set(LOG_QUERY.task, filter.taskId);
  if (filter.search) params.set(LOG_QUERY.search, filter.search);
  if (filter.before) params.set(LOG_QUERY.before, String(filter.before));
  if (filter.noise) params.set(LOG_QUERY.noise, '1');
  return params.toString();
}

/**
 * Der Deep-Link auf eine Zeile (§18).
 *
 * Er öffnet das Protokoll **an** dieser Zeile: sie steht oben, darunter die
 * älteren. Das ist eine Entscheidung und keine Notlösung — eine Zeile allein
 * beantwortet keine Frage, und wer einem Link aus einer Karte folgt, will
 * wissen, was um sie herum passiert ist.
 */
export function logZeilenPfad(id: number): string {
  return `${LOG_PFAD}/${id}`;
}

/**
 * Die Id aus `/log/4711`, oder null.
 *
 * Streng: `4711abc`, `-1` und `0` werden abgelehnt statt umgedeutet.
 * `event_log.id` ist eine Identity ab 1, also ist alles andere ein Tippfehler,
 * und eine geratene Zeile ist schlimmer als „unbekannt" (`eskalationsNummer`s
 * Regel, eine Seite weiter).
 */
export function logZeilenId(segment: string | null): number | null {
  if (segment === null || !/^\d+$/.test(segment)) return null;
  const id = Number(segment);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/**
 * §18s Rauschhinweis — der Satz, der diese Seite ehrlich macht.
 *
 * Er steht **immer**, wenn die Vorgabe greift, und nennt zusätzlich die Zahl,
 * wenn im gezeigten Ausschnitt wirklich etwas verborgen ist. Beides zusammen ist
 * der Unterschied zu einem stillen Filter: „ich blende etwas aus" ist eine
 * Aussage über die Seite, „hier sind gerade 812 Zeilen verborgen" eine über den
 * Ausschnitt, und nur die zweite sagt, ob es gerade darauf ankommt.
 *
 * Bei eingeblendetem Rauschen schweigt er — dann ist nichts verborgen, und ein
 * Hinweis über einen Filter, der nicht greift, ist eine Zeile, die man zu
 * übersehen lernt.
 */
export function rauschHinweis(unterdrueckt: number, rauschen: boolean): string | null {
  if (rauschen) return null;
  if (unterdrueckt === 0) return LOG_NOISE_ERKLAERUNG;
  const zeilen =
    unterdrueckt === 1
      ? '1 Zeile ist hier verborgen'
      : `${unterdrueckt} Zeilen sind hier verborgen`;
  return `${zeilen}. ${LOG_NOISE_ERKLAERUNG}`;
}

/** Die Korrelations-Ids einer Zeile, so wie §18 sie führt — nur die gesetzten. */
export function korrelationen(eintrag: LogZeile): Array<[string, string]> {
  const paare: Array<[string, string]> = [];
  if (eintrag.projectId) paare.push(['Projekt', eintrag.projectId]);
  if (eintrag.taskId) paare.push(['Aufgabe', eintrag.taskId]);
  if (eintrag.runId) paare.push(['Lauf', eintrag.runId]);
  if (eintrag.deployId) paare.push(['Rollout', eintrag.deployId]);
  return paare;
}

/**
 * Die Nutzlast als Text, gedeckelt und mit Ansage.
 *
 * Eine `gate.finished`-Nutzlast trägt die vollständige Ausgabe eines
 * Testlaufs; ungekürzt wäre eine Seite von hundert Zeilen unlesbar. Gekürzt
 * wird **gesagt**, weil eine stille Kürzung von einem kurzen Wert nicht zu
 * unterscheiden ist (`docs.get`s Regel).
 */
export const NUTZLAST_MAX = 600;

export function nutzlastText(payload: unknown): string | null {
  if (payload === null || payload === undefined) return null;
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  if (text === undefined || text === '{}' || text === '') return null;
  return text.length > NUTZLAST_MAX ? `${text.slice(0, NUTZLAST_MAX)}… (gekürzt)` : text;
}

/** Ein Zeitpunkt für Menschen, oder der Rohwert, wenn er nicht lesbar ist. */
export function zeitpunkt(iso: string): string {
  const zeit = Date.parse(iso);
  return Number.isNaN(zeit) ? iso : new Date(zeit).toLocaleString('de-AT');
}
