/**
 * §16s Auslöser für den Wochenbericht: **Montag 07:00 Europe/Vienna** (A13).
 *
 * Das liest sich wie ein Zeitplan und ist eines: eine Frage nach Idempotenz und
 * eine nach Sommerzeit. Beide Hälften haben einen Fehlermodus, der still ist —
 * ein Bericht, der zwanzigmal geschrieben wird, weil der Tick zwanzigmal in
 * dieselbe Sekunde fällt, und ein Bericht, der im Sommer um 08:00 kommt, weil
 * jemand eine Woche als `7 * 24 * 3600 * 1000` gerechnet hat. Der zweite ist
 * der gefährlichere, weil er ein halbes Jahr lang richtig aussieht.
 *
 * Acht Entscheidungen.
 *
 *  1. **Keine Uhr im Modul.** `now` kommt als Argument, so wie `GuardianService`,
 *     `UsageMeter` und `EscalationMailService` es längst tun. Ein Modul mit
 *     eigener Uhr ist von keinem Test auf einen bekannten Zeitpunkt festzunageln
 *     — und genau darum geht es hier: die vier Sommerzeit-Fälle sind exakte
 *     Zeitpunkte, keine Zeitspannen.
 *
 *  2. **Das Gedächtnis ist das Ereignisprotokoll, nicht der Prozess.** Ein
 *     Wochenbericht ist seltener als ein Neustart, und ein Deploy ist ein
 *     Neustart (A57). `lastReportAt` kommt deshalb als Argument herein; wer es
 *     liest, ist der Aufrufer. Dieselbe Aufteilung, die `escalation-mail.ts`
 *     Entscheidung 1 für A13s Erinnerung getroffen hat, aus demselben Grund.
 *
 *  3. **Fällig heisst: der jüngste Termin ist verstrichen und der letzte Bericht
 *     liegt davor.** Nicht „es sind sieben Tage vergangen" — daran scheitert
 *     jede Sommerzeitwoche, siehe Entscheidung 6 — und nicht „es ist gerade
 *     07:00", woran ein Daemon scheitert, der um 07:00 nicht lief. Aus dieser
 *     einen Formulierung folgen beide Anforderungen von selbst: zwanzig Ticks
 *     zwischen 07:00:00 und 07:00:15 finden beim zweiten `lastReportAt >= slot`
 *     vor, und ein Daemon, der von Montag 06:00 bis Dienstag 09:00 aus war,
 *     findet beim Start den Montagstermin verstrichen und holt **einen** nach.
 *
 *  4. **Nachgeholt wird höchstens einer.** Wer drei Wochen aus war, bekommt
 *     einen Bericht und nicht drei. §16s Bericht handelt von *der* Woche; drei
 *     rückwirkende Berichte in derselben Minute sind kein Archiv, sondern drei
 *     Mails, von denen zwei niemand liest. Der Preis ist benannt statt versteckt:
 *     die übersprungenen Wochen bekommen keinen eigenen Bericht, und das
 *     Ereignisprotokoll (§18) bleibt die Stelle, an der ihre Zahlen liegen.
 *
 *  5. **`lastReportAt === null` ist fällig, nicht „warten".** Verlockend wäre,
 *     eine frische Installation bis zum nächsten echten Montag warten zu lassen
 *     — der erste Bericht käme dann zur richtigen Uhrzeit statt mitten am
 *     Mittwoch. Das lässt sich in einer reinen Funktion aber nicht sagen: „warten
 *     bis zum nächsten" braucht die Erinnerung daran, dass einmal bewusst
 *     ausgelassen wurde, und ohne die wird aus der Regel eine, die **nie**
 *     feuert. Also die Richtung, in der ein Fehler sichtbar ist: einmal ein
 *     Bericht über eine Woche, in der das Studio noch nicht existierte, statt
 *     dauerhaft keiner. Wer das nicht will, hat die Naht dafür in der Hand — der
 *     Aufrufer kann `lastReportAt` mit dem Installationszeitpunkt vorbelegen,
 *     und die Entscheidung bleibt dort, wo die Information liegt.
 *
 *  6. **Eine Woche ist sieben Kalendertage, nie 168 Stunden.** Über die
 *     Frühjahrsumstellung liegen zwischen zwei Montagsterminen **167** Stunden,
 *     über die Herbstumstellung **169** (nachgemessen, siehe die Tabelle unten).
 *     Ein fester Versatz liest das erste als „noch keine Woche" und schiebt den
 *     Bericht um eine Stunde nach hinten, und das zweite als „die Woche ist
 *     schon um" und schickt ihn eine Stunde zu früh — im Herbst also potenziell
 *     zweimal, weil der Termin danach immer noch verstreicht. Deshalb wird hier
 *     nirgends mit einem Stundenversatz gerechnet: der Termin ist ein
 *     **Kalendertag plus Ortszeit**, und der Zeitpunkt dazu wird über
 *     `Intl.DateTimeFormat` mit `timeZone: 'Europe/Vienna'` aufgelöst.
 *
 *     | Termin | UTC | Ortszeit | Abstand zum vorigen |
 *     |---|---|---|---|
 *     | Mo 2026-03-23 | 06:00Z | 07:00 CET | 168 h |
 *     | Mo 2026-03-30 | 05:00Z | 07:00 CEST | **167 h** |
 *     | Mo 2026-10-19 | 05:00Z | 07:00 CEST | 168 h |
 *     | Mo 2026-10-26 | 06:00Z | 07:00 CET | **169 h** |
 *
 *  7. **Die Zeitzone ist keine Konfiguration.** §2 führt sie als feste Tatsache
 *     („Timezone for all scheduling and reports: Europe/Vienna"), und
 *     `TIMEZONE` in `@vorschicht/shared` ist die eine Deklaration davon. Sie
 *     wird hier importiert statt wiederholt — zwei Stellen für dieselbe Zeitzone
 *     sind zwei Stellen, an denen sie auseinanderlaufen kann (A81).
 *
 *  8. **Ein unbrauchbarer Zeitpunkt wirft, statt still nie fällig zu werden.**
 *     `NaN < slot` ist `false`, ein `NaN`-Zeitstempel machte den Bericht also
 *     lautlos für immer unfällig — die Klasse Fehler, die dieses Projekt
 *     mehrfach teuer bezahlt hat (A101, A123). Ein Zeitstempel, der keine Zahl
 *     ist, ist ein Defekt des Aufrufers, und der Ablaufplaner quarantäniert
 *     einen solchen laut (A57.4), statt ihn zu verschlucken.
 */
import { TIMEZONE } from '@vorschicht/shared';

/** §16/A13: Montag. ISO-Zählung, 1 = Montag … 7 = Sonntag. */
export const REPORT_WEEKDAY = 1;

/** §16/A13: 07:00 Ortszeit. */
export const REPORT_HOUR = 7;

/** Ein Kalendertag in Ortszeit — bewusst ohne Zeitpunkt (Entscheidung 6). */
export interface CalendarDay {
  year: number;
  /** 1–12, nicht Javascripts 0–11. Ein Monat, den man vorlesen kann. */
  month: number;
  day: number;
}

export type ReportScheduleReason =
  /** Noch nie ein Bericht — Entscheidung 5. */
  | 'never_run'
  /** Der jüngste Termin ist verstrichen und liegt nach dem letzten Bericht. */
  | 'slot_passed'
  /** Der letzte Bericht deckt den jüngsten Termin schon ab. */
  | 'already_reported';

export interface ReportScheduleInput {
  /** Jetzt, als Epochen-Millisekunden. Injiziert, nie `Date.now()`. */
  now: number;
  /** Wann der letzte Bericht erzeugt wurde, oder `null` für „noch nie". */
  lastReportAt: number | null;
}

export interface ReportScheduleDecision {
  /** Ob jetzt ein Bericht geschuldet ist. */
  due: boolean;
  /**
   * Der Termin, zu dem der fällige Bericht gehört, oder `null`, wenn keiner
   * fällig ist. Zwei getrennte Felder statt eines mit zwei Bedeutungen: der
   * fällige Termin liegt in der Vergangenheit, `nextSlot` in der Zukunft, und
   * ein Feld, das je nach `due` das eine oder das andere meint, ist die Form,
   * die dieses Haus verbietet (A81.4).
   *
   * Der Berichtszeitraum, den ein Generator daraus bildet, ist
   * `slotAtOrBefore(dueSlot - 1) … dueSlot` — auch das über Kalendertage, also
   * über die Umstellung hinweg richtig.
   */
  dueSlot: number | null;
  /** Der nächste Termin **echt nach** `now`. Immer eine Zahl. */
  nextSlot: number;
  /** Warum, in einem Wort — für eine Protokollzeile und für eine Zusicherung. */
  reason: ReportScheduleReason;
}

/**
 * Die Ortszeit-Felder eines Zeitpunkts in Wien.
 *
 * `en-CA` liefert ISO-artige Zahlen, `hourCycle: 'h23'` macht Mitternacht zu
 * `00` statt zu `24`, und gelesen wird über `formatToParts` statt über die
 * formatierte Zeichenkette: ein Trennzeichen, das eine ICU-Version anders setzt,
 * darf keine Zeitrechnung kippen.
 */
const WALL_CLOCK = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

interface WallClock extends CalendarDay {
  hour: number;
  minute: number;
  second: number;
}

const DAY_MS = 86_400_000;

function wallClock(instant: number): WallClock {
  const parts = WALL_CLOCK.formatToParts(new Date(instant));
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((candidate) => candidate.type === type);
    if (part === undefined) {
      throw new Error(`Intl liefert für ${TIMEZONE} kein Feld "${type}" — Zeitrechnung unmöglich.`);
    }
    return Number(part.value);
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/**
 * Der Versatz der Zone zu UTC an diesem Zeitpunkt, in Millisekunden.
 *
 * Abgelesen statt hinterlegt: die Differenz zwischen „was die Uhr in Wien zeigt,
 * als UTC gelesen" und dem Zeitpunkt selbst *ist* der Versatz. Damit stammt jede
 * Zahl in diesem Modul aus der Zeitzonendatenbank und keine aus einer Annahme.
 */
function offsetAt(instant: number): number {
  const local = wallClock(instant);
  const asUtc = Date.UTC(
    local.year,
    local.month - 1,
    local.day,
    local.hour,
    local.minute,
    local.second,
  );
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** Reine Kalenderarithmetik über nominelle Daten — keine Zeitzone beteiligt. */
export function addDays(day: CalendarDay, delta: number): CalendarDay {
  const shifted = new Date(Date.UTC(day.year, day.month - 1, day.day + delta));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/**
 * ISO-Wochentag eines Kalendertags, 1 = Montag … 7 = Sonntag.
 *
 * Gerechnet statt aus `Intl` gelesen: ein Wochentagsname müsste je nach Sprache
 * zurückübersetzt werden, und der Wochentag eines nominellen Datums ist ohnehin
 * eine Frage des Kalenders und nicht der Zeitzone.
 */
function isoWeekday(day: CalendarDay): number {
  const weekday = new Date(Date.UTC(day.year, day.month - 1, day.day)).getUTCDay();
  return weekday === 0 ? 7 : weekday;
}

function readsAs(instant: number, day: CalendarDay, hour: number): boolean {
  const local = wallClock(instant);
  return (
    local.year === day.year &&
    local.month === day.month &&
    local.day === day.day &&
    local.hour === hour &&
    local.minute === 0 &&
    local.second === 0
  );
}

/**
 * Der Zeitpunkt, zu dem die Uhr in Wien an diesem Kalendertag `hour`:00:00 zeigt.
 *
 * Der Kern des Moduls, und die Stelle, an der ein fester Stundenversatz falsch
 * wäre. Zwei Kandidaten werden gebildet — je einer mit dem Versatz, der einen Tag
 * vorher gilt, und mit dem, der einen Tag später gilt — und dann wird
 * **nachgelesen**, welcher davon wirklich die gesuchte Uhrzeit anzeigt. Bei
 * einem gewöhnlichen Tag sind beide identisch; an einem Umstellungstag trennen
 * sie sich, und dann entscheiden zwei Regeln, die hier ausgeschrieben stehen,
 * weil in Wien keine von beiden je auf 07:00 zutrifft und ein späterer Leser
 * sonst raten müsste:
 *
 *   * **Doppelte Uhrzeit** (Herbst, 02:00–02:59 kommt zweimal): der **frühere**
 *     der beiden Zeitpunkte. Ein Bericht soll nicht später kommen, als die Uhr
 *     ihn ankündigt, und die erste Gelegenheit ist die, die ein Mensch meint.
 *   * **Übersprungene Uhrzeit** (Frühjahr, 02:00–02:59 gibt es nicht): der
 *     **spätere** Kandidat, also der Zeitpunkt, an dem die Uhr die gesuchte
 *     Stunde bereits überschritten hat. Der Termin verschiebt sich damit um die
 *     Umstellung nach vorn, statt in der Lücke zu verschwinden — eine Woche
 *     komplett auszulassen wäre die einzige wirklich falsche Antwort.
 *
 * Beide Regeln entsprechen dem, was `Temporal` als `disambiguation: 'compatible'`
 * führt; das ist kein Zufall, sondern der Grund, sie so zu wählen — die
 * Nachfolge-API dieses Codes soll dasselbe tun wie er.
 *
 * Exportiert, obwohl `evaluateReportSchedule` der einzige Produktivaufrufer ist:
 * die beiden Regeln oben sind über den Wochenplan **nicht erreichbar** (Wien
 * verschiebt nie 07:00), und ein Zweig, den kein Test ansprechen kann, liest sich
 * wie abgedeckt und ist es nicht (§8.2, sechste Domäne).
 */
export function viennaInstant(day: CalendarDay, hour: number): number {
  const naive = Date.UTC(day.year, day.month - 1, day.day, hour, 0, 0, 0);
  const withEarlierOffset = naive - offsetAt(naive - DAY_MS);
  const withLaterOffset = naive - offsetAt(naive + DAY_MS);
  const earlierFits = readsAs(withEarlierOffset, day, hour);
  const laterFits = readsAs(withLaterOffset, day, hour);
  if (earlierFits && laterFits) return Math.min(withEarlierOffset, withLaterOffset);
  if (earlierFits) return withEarlierOffset;
  if (laterFits) return withLaterOffset;
  return Math.max(withEarlierOffset, withLaterOffset);
}

/** Der Kalendertag des jüngsten Termins, der `now` nicht überholt. */
function slotDayAtOrBefore(now: number): CalendarDay {
  const local = wallClock(now);
  const today: CalendarDay = { year: local.year, month: local.month, day: local.day };
  const monday = addDays(today, REPORT_WEEKDAY - isoWeekday(today));
  // Genau ein Schritt zurück reicht: `monday` ist der Montag der laufenden
  // Ortswoche, liegt sein Termin nach `now`, ist es Montag vor 07:00. Weiter
  // zurück kann es nicht gehen — eine Umstellung verschiebt den Zeitpunkt um
  // höchstens eine Stunde. Der Sweep in `report-schedule.test.ts` prüft die
  // Invariante `slot <= now < nextSlot` über ein ganzes Jahr, statt sie hier zu
  // behaupten.
  return viennaInstant(monday, REPORT_HOUR) > now ? addDays(monday, -7) : monday;
}

/** Der jüngste Termin (Montag 07:00 Wien) zum Zeitpunkt `now` oder davor. */
export function slotAtOrBefore(now: number): number {
  assertInstant(now, 'now');
  return viennaInstant(slotDayAtOrBefore(now), REPORT_HOUR);
}

/** Der nächste Termin echt nach `now`. */
export function nextSlotAfter(now: number): number {
  assertInstant(now, 'now');
  return viennaInstant(addDays(slotDayAtOrBefore(now), 7), REPORT_HOUR);
}

function assertInstant(value: number, name: string): void {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${name} ist kein brauchbarer Zeitpunkt: ${String(value)}`);
  }
}

/**
 * §16s Auslöser als eine Antwort: ist jetzt ein Bericht fällig, und wann sonst.
 *
 * Rein, deterministisch, ohne Datenbank und ohne Uhr. Der Aufrufer liest
 * `lastReportAt` aus dem Ereignisprotokoll und schreibt die Zeile danach —
 * dieses Modul entscheidet und tut nichts (A48.2, A53.1).
 */
export function evaluateReportSchedule(input: ReportScheduleInput): ReportScheduleDecision {
  assertInstant(input.now, 'now');
  if (input.lastReportAt !== null) assertInstant(input.lastReportAt, 'lastReportAt');

  const day = slotDayAtOrBefore(input.now);
  const slot = viennaInstant(day, REPORT_HOUR);
  const nextSlot = viennaInstant(addDays(day, 7), REPORT_HOUR);

  if (input.lastReportAt === null) {
    return { due: true, dueSlot: slot, nextSlot, reason: 'never_run' };
  }
  if (input.lastReportAt < slot) {
    return { due: true, dueSlot: slot, nextSlot, reason: 'slot_passed' };
  }
  return { due: false, dueSlot: null, nextSlot, reason: 'already_reported' };
}
