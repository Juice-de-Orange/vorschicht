/**
 * §16s Wochenbericht: aus Kennzahlen wird der Bericht, den der Betreiber montags liest.
 *
 * §16 gibt sechs Abschnitte vor, „metric-first, zero filler", eine harte
 * Längengrenze und Deutsch (§2); §22s Phase-8-Gates verlangen dazu, dass die
 * Struktur **exakt** eingehalten wird, dass HTML und Klartext beide taugen,
 * dass jede Kopfzahl sich gegen das Ereignisprotokoll nachrechnen lässt und
 * dass die Grenze mit aufgeblähten Daten **erzwungen** wird. Vier Dinge sind
 * damit nicht entschieden, und sie sind der Inhalt dieser Datei.
 *
 * ---
 *
 * **1. Wo die Längengrenze wirkt: je Abschnitt, nach einer erklärten
 * Rangfolge, und jede Kürzung steht im Text.**
 *
 * Ein Bericht über hundert Projekte darf keine hundert Abschnitte haben, und
 * ein global am Zeichen abgeschnittener Bericht ist die schlechteste
 * Bauart überhaupt: er verliert den letzten Abschnitt zuerst, und der letzte
 * Abschnitt, den §16 vorschreibt, ist ausgerechnet der über die
 * Betriebsprüfung. Also zwei Schichten mit verschiedenen Aufgaben.
 *
 *  - **Schicht 1, redaktionell:** jede Liste hat eine Höchstzahl (`MAX_*`) und
 *    jeder Eintrag eine Zeichengrenze. Das ist die Schicht, die im Betrieb
 *    wirkt. Sie kürzt nach Rang — Projekte nach dem, was sie geliefert haben,
 *    Gate-Funde nach Häufigkeit (`findingsByGate` sortiert bereits), Radar und
 *    Prüffunde nach ihrer eigenen Reihenfolge.
 *  - **Schicht 2, mechanisch:** wenn der Klartext danach immer noch über der
 *    Grenze liegt, werden Einträge in der Reihenfolge aus `SACRIFICE_ORDER`
 *    verworfen. Sie soll im Normalbetrieb **nie** greifen, und genau das
 *    sichert ein Testfall zu (`droppedByCap === 0` über aufgeblähte Daten):
 *    fällt Schicht 1 aus, muss Schicht 2 arbeiten, und das wird rot.
 *
 * **Eine Kürzung, die niemand sieht, ist die gefährliche Variante.** A67.4 sagt
 * es für die Gate-Retry-Schranke, `renderPruefbericht` für den Fließtext des
 * Prüfberichts: eine Abschneidung, die sich nicht selbst nennt, liest sich wie
 * Vollständigkeit. Deshalb schreibt **jede** Kürzung hier einen deutschen Satz
 * mit der Zahl der fehlenden Einträge in den Abschnitt, in dem sie stattfand,
 * und Schicht 2 zusätzlich eine Fußzeile über das ganze Dokument.
 *
 * Die Grenze gilt dem **Klartext**. Der HTML-Teil trägt dieselben Einträge und
 * ist durch sein Markup zwangsläufig länger; ihn nach Zeichen zu deckeln hieße,
 * das Markup zu deckeln statt den Bericht. Beide Darstellungen werden aus
 * **derselben** gekürzten Struktur gebaut, es kann also keine Fassung geben,
 * die mehr weiß als die andere.
 *
 * ---
 *
 * **2. Leere Abschnitte: alle sechs stehen immer, jeder mit genau einem Satz,
 * und der Satz unterscheidet „nichts passiert" von „wir konnten nicht
 * nachsehen".**
 *
 * §16.5 verlangt das ausdrücklich für die Betriebsprüfung („stated even when
 * empty"), und „zero filler" zieht in die andere Richtung. Aufgelöst wird das
 * so: *Füllmaterial ist Prosa, die nichts behauptet; ein Satz über eine
 * Abwesenheit behauptet etwas.* „Kein Radar-Lauf im Zeitfenster" und „Radar
 * lief, ohne Fund" sind verschiedene Wochen, und die erste ist ein Defekt —
 * ein Abschnitt, der in beiden Fällen fehlt, macht sie ununterscheidbar und
 * ist damit §8.2s sechste Domäne in Berichtsform. Ein fehlender Abschnitt wäre
 * außerdem von einem kaputten Renderer nicht zu unterscheiden.
 *
 * Regel, in einem Satz: **ein Abschnitt darf kurz sein, nie abwesend.**
 *
 * ---
 *
 * **3. HTML und Klartext sind zwei Darstellungen einer Sache.**
 *
 * Beide werden aus `ReportSection[]` gebaut, nie unabhängig formuliert — zwei
 * Formulierungen desselben Satzes sind zwei Stellen, an denen er falsch sein
 * kann (A81). Die Maskierung kommt aus `esc()` in `@vorschicht/shared/mail`
 * und wird **nicht** nachgebaut: sie maskiert Text- und Attributkontext
 * gleichermaßen, ist dort begründet und geprüft, und eine zweite Fassung wäre
 * genau die Doppelung, gegen die dieser Absatz steht. A82s Lehre für die
 * Zusicherungen: eine Prüfung, die nur eine Richtung ansieht, liest sich wie
 * eine, die beide ansieht — deshalb prüft `generator.test.ts` jede tragende
 * Tatsache **in beiden** Teilen.
 *
 * ---
 *
 * **4. Eine `Quantity` ohne Wert wird zu ihrem Satz, nie zu „0" und nie zu
 * „—".**
 *
 * `quantity.ts` liefert die deutschen Begründungen mit; sie werden gelesen,
 * nicht neu formuliert. „Null Rollbacks" und „wir wissen es nicht" sind die
 * Sorte Tatsache, die §8.2 prüft, und ein Gedankenstrich sagt keine von
 * beiden.
 *
 * Zwei Prozentskalen, und sie werden nie verwechselt: `ratio()` liefert einen
 * **Anteil** (0…1), `usage_samples.used_percent` liefert **Prozentpunkte**
 * (0…100). Dafür gibt es zwei Formatierer mit zwei Namen — A73.2 hat gemessen,
 * was eine geteilte Skala kostet (0,97 als „0,97 Prozent" gelesen, und §7.2
 * ist still ausser Kraft).
 *
 * Zahlen und Daten werden **von Hand** formatiert statt über
 * `Intl.NumberFormat`: `report-schedule.ts` liest aus demselben Grund
 * `formatToParts` statt einer formatierten Zeichenkette — ein Trennzeichen,
 * das eine ICU-Version anders setzt, darf keine Zusicherung kippen. Für das
 * Datum wird `Intl` benutzt, aber nur über seine Teile.
 *
 * ---
 *
 * **Woher die Abschnitte kommen, und was keinen Erzeuger hat.** §16.1 und
 * §16.3 kommen aus `MetricsService`. Die anderen vier holt `collect()` selbst,
 * und drei Stellen sind Lücken, die der Bericht **benennt** statt sie zu
 * erfinden:
 *
 *  - §16.4 verlangt Vertrauensstufen (§14) an den Radar-Funden. Der Radar
 *    vergibt keine — `RaisedRadarCard` hat kein Feld dafür. Der Bericht sagt
 *    das, und weil er es aus den Daten ableitet (`trustLevel === null` bei
 *    allen Einträgen), verschwindet der Satz von selbst, sobald es einen
 *    Erzeuger gibt.
 *  - §16.4 nennt „legal" als Radar-Klasse. `RadarScan` kennt `billing`,
 *    `dependency_major` und `dependency_advisory`. Was ein Lauf nicht angesehen
 *    hat, steht in seiner eigenen `limits`-Liste, und die wird gerendert.
 *  - §16.6 sagt „top queued **goals**". §5 führt `goals` als Entität; es gibt
 *    dafür **keine Tabelle und keinen Erzeuger** (`tasks.goal_id` liest einen
 *    Schlüssel, den niemand schreibt). Der Abschnitt zeigt deshalb die
 *    wartenden Aufgaben und sagt in seiner Quellenangabe, dass er das tut —
 *    dieselbe Bauart wie `BudgetUtilisation.source`.
 */
import { esc } from '@vorschicht/shared';
import {
  type BudgetWindowUtilisation,
  type MetricsService,
  type MetricsWindow,
  type Quantity,
  type StudioMetrics,
  UNKNOWN_REASON_LABELS,
  windowLabel,
} from '../metrics/index.js';
import type { Queryable } from '../sql.js';
import type { WeeklyReportInput } from './records.js';

// --- Grenzen -----------------------------------------------------------------

/**
 * Die harte Längengrenze aus §16, in Zeichen des **Klartexts**.
 *
 * Deutlich kleiner als die 16 000 des Prüfberichts, und das ist Absicht: ein
 * Prüfbericht ist ein Dokument, das jemand einmal durcharbeitet, ein
 * Wochenbericht ist eine Mail, die jemand am Montagmorgen überfliegt. §16 sagt
 * „metric-first, zero filler" — eine Mail, die man scrollen muss, hat das
 * bereits verfehlt, egal was drinsteht.
 */
export const WEEKLY_REPORT_MAX_CHARS = 8_000;

/** §16.2 wörtlich: „max 3 bullets of shipped outcomes". */
export const MAX_SHIPPED_BULLETS = 3;

/**
 * Die Höchstzahlen der redaktionellen Schicht.
 *
 * **Abgeleitet, nicht gewählt:** sie sind so gesetzt, dass der schlimmste Fall
 * — jede Liste voll, jeder Text über der Zeichengrenze — unter
 * `WEEKLY_REPORT_MAX_CHARS` bleibt, und `generator.test.ts` misst genau das
 * (`droppedByCap === 0` über aufgeblähte Daten). Die Grenze ist die
 * redaktionelle Entscheidung; diese Zahlen folgen aus ihr. Wer eine erhöht
 * oder einen Abschnitt hinzufügt, bekommt den Fall rot, statt dass die
 * Notbremse still zu arbeiten beginnt.
 */
const MAX_PROJECTS = 4;
/** §16.3s „findings by gate" — die häufigsten, der Rest als eine Zeile. */
const MAX_GATE_FINDINGS = 4;
/** §7.1 führt drei Fensterarten, die dritte je Modellklasse. */
const MAX_BUDGET_WINDOWS = 4;
const MAX_RADAR_ENTRIES = 4;
const MAX_RADAR_LIMITS = 2;
/**
 * §8.2s Kadenz ist wöchentlich; mehrere Prüfungen in einer Woche gibt es
 * (Phasenabschluss, Rollback, Auth-Vorfall), unbegrenzt viele nicht. Die Zahl
 * stand beim ersten Bau **nicht** hier, und die Messung der aufgeblähten Daten
 * hat die Lücke gefunden: eine unbegrenzte Liste in einem Abschnitt, dessen
 * Einträge Schicht 2 zwar verwerfen darf, dessen Kürzung dann aber nirgends
 * ausgeschrieben stand.
 */
const MAX_AUDIT_VERDICTS = 3;
const MAX_AUDIT_FINDINGS = 4;
const MAX_SCOPE_LIMITS = 2;
const MAX_NEXT_WEEK = 4;

/** Zeichengrenze je Eintragszeile und je Unterpunkt. */
const ITEM_MAX_CHARS = 120;
const DETAIL_MAX_CHARS = 90;

/**
 * In welcher Reihenfolge Schicht 2 opfert — expendabelstes zuerst.
 *
 * Keine Umkehrung der Dokumentreihenfolge, sondern eine eigene Entscheidung:
 * §16.5 verlangt ausdrücklich, dass die Betriebsprüfung auch dann spricht,
 * wenn sie nichts gefunden hat, also geht sie als **letzte** der fünf. Die
 * Kopfzahlen stehen ganz am Ende der Liste, weil §16 „metric-first" sagt — sie
 * sind droppable, aber erst, wenn nichts anderes mehr da ist, und dann sagt
 * die Fußzeile es.
 */
const SACRIFICE_ORDER = [
  'naechste_woche',
  'radar',
  'projekte',
  'qualitaet',
  'betriebspruefung',
  'kopfzahlen',
] as const;

// --- Die Daten, aus denen der Bericht gebaut wird -----------------------------

export type SectionId = (typeof SACRIFICE_ORDER)[number];

/** §16.2: was ein Projekt in der Woche geliefert hat. */
export interface ProjectOutcome {
  /** `null` heißt: die Zeilen trugen keine Projektzuordnung. */
  projectId: string | null;
  name: string;
  tasksDone: number;
  merges: number;
  deploys: number;
  rollbacks: number;
  /**
   * Titel fertiggestellter Aufgaben, neueste zuerst.
   *
   * Die Liste ist knapp gehalten; wie viele es insgesamt waren, sagt
   * `tasksDone` — die Zahl der weggelassenen wird daraus berechnet und nicht
   * aus der Länge dieser Liste, damit eine Abfragegrenze die Kürzungsangabe
   * nicht verfälscht.
   */
  shipped: string[];
}

/** Ein Radar-Fund, so wie ihn `radar.finished` mitschreibt. */
export interface RadarEntry {
  kind: string;
  name: string | null;
  current: string | null;
  latest: string | null;
  /** §15s dauerhafte Nummer der Karte, falls eine erzeugt wurde. */
  escalationNumber: number | null;
  /**
   * §14s Vertrauensstufe — heute an jedem Eintrag `null`.
   *
   * Der Radar vergibt keine (siehe Kopf). Das Feld existiert, damit der
   * Bericht die Lücke **aus den Daten** ableitet statt sie zu behaupten: gäbe
   * es morgen einen Erzeuger, verschwände der Satz von selbst.
   */
  trustLevel: number | null;
}

/** §16.4. */
export interface RadarSummary {
  /** Läufe im Fenster. Null Läufe ist etwas anderes als null Funde. */
  runs: number;
  entries: RadarEntry[];
  /** Aufgaben, die A10s Patch/Minor-Politik automatisch angelegt hat. */
  tasks: number;
  /** Was ein Lauf ausdrücklich **nicht** angesehen hat (A119.3). */
  limits: string[];
  problems: string[];
}

/** Ein Fund einer Betriebsprüfung, so weit ihn §16.5 braucht. */
export interface AuditFindingSummary {
  class: string;
  summary: string;
  gate: string | null;
  status: string;
}

/** §16.5. */
export interface AuditSummary {
  /** Prüfungen, die im Fenster **begonnen** haben — auch abgestürzte. */
  runs: number;
  verdicts: Array<{
    auditId: string;
    domain: string | null;
    verdict: string | null;
    outcome: string;
  }>;
  /**
   * Bestätigte Funde: alles ausser `suspicion`, und nichts, was verworfen
   * wurde.
   *
   * §8.2 lässt `suspicion` ausdrücklich nichts blockieren, und ein verworfener
   * Fund ist keiner, der bestätigt wurde. `dismissed` wird trotzdem gezählt
   * (siehe `dismissed`), weil eine Zahl, die nur die eine Hälfte nennt, sich
   * nicht gegen die Prüfungsdatensätze nachrechnen lässt.
   */
  confirmed: AuditFindingSummary[];
  suspicions: number;
  dismissed: number;
  /** §8.2s „nicht prüfbar" — §16.5 verlangt es auch dann, wenn es leer ist. */
  scopeLimits: string[];
}

/** §16.6. */
export interface NextWeek {
  /**
   * Woher die Zeilen kommen.
   *
   * §16 sagt „top queued **goals**" und §5 führt `goals` als Entität — es gibt
   * dafür keine Tabelle und keinen Erzeuger. Gezeigt werden deshalb die
   * wartenden Aufgaben, und dieses Feld sagt es im Ergebnis statt nur in der
   * Prosa (dieselbe Bauart wie `BudgetUtilisation.source`).
   */
  source: 'queued_tasks';
  entries: Array<{ taskId: string; title: string; priority: string; project: string | null }>;
  /** Alle wartenden Aufgaben, nicht nur die gezeigten. */
  total: number;
}

export interface WeeklyReportData {
  window: MetricsWindow;
  metrics: StudioMetrics;
  projects: ProjectOutcome[];
  radar: RadarSummary;
  audit: AuditSummary;
  nextWeek: NextWeek;
}

// --- Die Zwischenform, aus der beide Darstellungen entstehen ------------------

/** Ein Eintrag: eine Zeile, dazu höchstens ein paar Unterpunkte. */
export interface ReportEntry {
  text: string;
  details: string[];
}

/**
 * Ein Abschnitt.
 *
 * `notes` überleben jede Kürzung — dort stehen die Sätze, die eine Abwesenheit
 * benennen, und die Kürzungshinweise selbst. Ein Kürzungshinweis, den die
 * Kürzung wegkürzt, wäre die Bauart, gegen die dieser ganze Mechanismus steht.
 */
export interface ReportSection {
  id: SectionId;
  title: string;
  entries: ReportEntry[];
  notes: string[];
}

export interface TruncationReport {
  /** Zeichen des Klartexts. */
  chars: number;
  cap: number;
  /** Einträge, die **Schicht 2** verworfen hat. Im Normalbetrieb 0. */
  droppedByCap: number;
  /** Abschnitte, die Schicht 2 vollständig geleert hat. */
  emptiedByCap: SectionId[];
  /** Ob der Klartext am Ende unter der Grenze liegt. */
  withinCap: boolean;
}

export interface RenderedWeeklyReport {
  subject: string;
  text: string;
  html: string;
  sections: ReportSection[];
  truncation: TruncationReport;
}

export interface RenderOptions {
  /**
   * Die Grenze für diesen Lauf.
   *
   * Als Option und nicht als Konstante, damit Schicht 2 **erreichbar** ist: ein
   * Zweig, den keine Eingabe auslösen kann, liest sich wie abgesichert und ist
   * §8.2s sechste Domäne. Ein Testfall mit einer winzigen Grenze fährt ihn.
   */
  maxChars?: number;
}

// --- Formatierung ------------------------------------------------------------

/**
 * Zahl und Substantiv, mit richtigem Numerus.
 *
 * Klein und trotzdem eine Entscheidung: §2 macht den Bericht zu einem
 * deutschen Text, und „1 Aufgaben, 1 Prüfungen, 1 Merges" ist der Ton, an dem
 * ein Leser merkt, dass eine Maschine geschrieben hat und niemand
 * nachgelesen hat. Aufgefallen beim Lesen eines gerenderten Berichts, nicht in
 * einem Test — für Numerus gibt es keine Zusicherung, die ihn erzwingt, und es
 * soll auch keine geben: eine Regel dafür wäre eine Sprachregel, und die
 * gehört zu den Sätzen selbst.
 */
export function plural(count: number, einzahl: string, mehrzahl: string): string {
  return `${formatInteger(count)} ${count === 1 ? einzahl : mehrzahl}`;
}

/** Tausenderpunkte von Hand — siehe Kopf, Entscheidung 4 (kein ICU). */
export function formatInteger(value: number): string {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  const digits = Math.abs(rounded).toString();
  let out = '';
  for (let index = 0; index < digits.length; index += 1) {
    if (index > 0 && (digits.length - index) % 3 === 0) out += '.';
    out += digits[index];
  }
  return sign + out;
}

/** Eine Dezimalzahl mit deutschem Komma. */
function formatDecimal(value: number, digits: number): string {
  return value.toFixed(digits).replace('.', ',');
}

/**
 * Ein **Anteil** (0…1) als Prozentangabe, oder der Satz, warum es ihn nicht
 * gibt.
 */
export function formatShare(quantity: Quantity): string {
  if (quantity.value === null) return unknownText(quantity);
  return `${formatDecimal(quantity.value * 100, 1)} %`;
}

/** **Prozentpunkte** (0…100), also die Skala aus `usage_samples`. */
export function formatPercentPoints(quantity: Quantity): string {
  if (quantity.value === null) return unknownText(quantity);
  return `${formatDecimal(quantity.value, 1)} %`;
}

/** Eine Dauer in Millisekunden, grob — Sekunden sind hier Rauschen. */
export function formatDuration(quantity: Quantity): string {
  if (quantity.value === null) return unknownText(quantity);
  return formatMillis(quantity.value);
}

export function formatMillis(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / 60_000));
  if (minutes < 60) return `${formatInteger(minutes)} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours < 48) return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
  const days = Math.floor(hours / 24);
  return `${days} Tage`;
}

/**
 * Entscheidung 4: der Grund, nie eine 0 und nie ein Gedankenstrich.
 *
 * Der Satz kommt aus `UNKNOWN_REASON_LABELS`, also aus derselben Deklaration,
 * die das Kennzahlenmodul benutzt. Ein hier zweitformulierter Satz wäre die
 * Doppelung, die `quantity.ts` in seinem eigenen Kopf ausschließt.
 */
function unknownText(quantity: Quantity): string {
  const reason = quantity.unknownReason;
  const label = reason ? UNKNOWN_REASON_LABELS[reason] : 'Grund nicht angegeben';
  return `nicht feststellbar (${label})`;
}

const DAY_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Vienna',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * `TT.MM.JJJJ` in Wiener Ortszeit (§2), über `formatToParts`.
 *
 * Nicht über eine formatierte `de-AT`-Zeichenkette: welches Trennzeichen und
 * welche Leerzeichenart ICU dort setzt, ist zwischen Versionen nicht stabil,
 * und eine Zusicherung darauf wäre eine Zusicherung über ICU.
 * `report-schedule.ts` liest aus demselben Grund Teile statt Text.
 */
export function formatDay(at: Date): string {
  const parts = DAY_PARTS.formatToParts(at);
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '??';
  return `${read('day')}.${read('month')}.${read('year')}`;
}

/** Text auf `max` Zeichen bringen und die Kürzung sichtbar machen. */
export function clampText(value: string, max: number): string {
  const text = value.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

// --- Die sechs Abschnitte ----------------------------------------------------

const WINDOW_LABELS: Record<string, string> = {
  five_hour: '5-Stunden-Fenster',
  seven_day: 'Woche',
  seven_day_model: 'Woche je Modellklasse',
};

function budgetLabel(entry: BudgetWindowUtilisation): string {
  const base = WINDOW_LABELS[entry.windowKind] ?? entry.windowKind;
  return entry.modelClass ? `${base} · ${entry.modelClass}` : base;
}

function entry(text: string, details: readonly string[] = []): ReportEntry {
  return {
    text: clampText(text, ITEM_MAX_CHARS),
    details: details.map((detail) => clampText(detail, DETAIL_MAX_CHARS)),
  };
}

/** „und N weitere" — der Satz, den jede Kürzung schreiben muss. */
function omittedNote(omitted: number, einzahl: string, mehrzahl: string): string[] {
  if (omitted <= 0) return [];
  // Die Einzahl kommt ohne „weiterer/weiteres" aus, und das ist kein Geiz: das
  // Adjektiv müsste sich nach dem Geschlecht des Substantivs richten, und ein
  // Aufrufer, der beide Formen liefern muss, liefert irgendwann eine falsche.
  const satz =
    omitted === 1
      ? `1 ${einzahl} steht nicht in diesem Bericht.`
      : `${formatInteger(omitted)} weitere ${mehrzahl} stehen nicht in diesem Bericht.`;
  return [`Gekürzt: ${satz}`];
}

/** §16.1 — Kopfzahlen. */
function headlineSection(data: WeeklyReportData): ReportSection {
  const { throughput, gates, budget, escalations } = data.metrics.headline;
  const entries: ReportEntry[] = [
    entry(`Aufgaben erledigt: ${formatInteger(throughput.tasksDone)}`),
    entry(`Merges: ${formatInteger(throughput.merges)}`),
    entry(
      `Deploys: ${formatInteger(throughput.deploys)} · Rollbacks: ` +
        `${formatInteger(throughput.rollbacks)} · gescheitert ohne Rückweg: ` +
        `${formatInteger(throughput.failedDeploys)}`,
    ),
    entry(
      `Gate-Durchlaufquote: ${formatShare(gates.rate)} (${formatInteger(gates.passed)} bestanden, ` +
        `${formatInteger(gates.failed)} gescheitert, ${formatInteger(gates.inconclusive)} ohne ` +
        `Urteil, ${formatInteger(gates.unreadable)} unlesbar)`,
    ),
  ];

  const windows = budget.windows.slice(0, MAX_BUDGET_WINDOWS);
  for (const window of windows) {
    entries.push(
      entry(
        `Budget ${budgetLabel(window)}: Mittel ${formatPercentPoints(window.average)} · Spitze ` +
          `${formatPercentPoints(window.peak)} (${plural(window.samples, 'Messung', 'Messungen')}, ` +
          `${formatInteger(window.blindSamples)} blind)`,
      ),
    );
  }

  entries.push(
    entry(
      `Entscheidungen: ${formatInteger(escalations.answered)} beantwortet · ` +
        `${formatInteger(escalations.open)} offen`,
    ),
  );

  const notes: string[] = [
    // §16 nennt die Budgetzahlen als Kopfzahl; woher sie kommen, gehört
    // daneben. `usage.sampled` steht in `EVENT_KINDS` und hat keinen Erzeuger
    // (A143), der Messwert liegt nur in `usage_samples` — ein Prüfer, der die
    // Zahl gegen das Ereignisprotokoll hält, sucht sonst an der falschen
    // Stelle.
    `Budgetquelle: ${budget.source} (nicht das Ereignisprotokoll).`,
    ...omittedNote(budget.windows.length - windows.length, 'Budgetfenster', 'Budgetfenster'),
  ];
  if (budget.unknownReason) {
    notes.push(`Budget: ${UNKNOWN_REASON_LABELS[budget.unknownReason]}.`);
  }

  return { id: 'kopfzahlen', title: '1. Kopfzahlen', entries, notes };
}

/** §16.2 — je Projekt höchstens drei Stichpunkte. */
function projectSection(data: WeeklyReportData): ReportSection {
  // Rangfolge: was geliefert wurde. Bei Gleichstand der Name, damit zwei Läufe
  // über dieselben Daten nicht verschieden aussehen.
  const ranked = [...data.projects].sort(
    (a, b) => shippedWeight(b) - shippedWeight(a) || a.name.localeCompare(b.name),
  );
  const shown = ranked.slice(0, MAX_PROJECTS);

  const entries = shown.map((project) => {
    const bullets = project.shipped.slice(0, MAX_SHIPPED_BULLETS);
    const omitted = Math.max(0, project.tasksDone - bullets.length);
    return entry(
      `${project.name} — ${plural(project.tasksDone, 'Aufgabe', 'Aufgaben')}, ` +
        `${plural(project.merges, 'Merge', 'Merges')}, ` +
        `${plural(project.deploys, 'Deploy', 'Deploys')}` +
        (project.rollbacks > 0 ? `, ${plural(project.rollbacks, 'Rollback', 'Rollbacks')}` : ''),
      [
        ...bullets,
        // Der Kürzungshinweis ist bewusst **kein** vierter Stichpunkt im Sinne
        // von §16.2: gezählt werden die gelieferten Ergebnisse, und dies ist
        // die Angabe, wie viele davon fehlen.
        ...(omitted > 0 ? [`… und ${formatInteger(omitted)} weitere`] : []),
      ],
    );
  });

  const notes: string[] = [
    ...omittedNote(ranked.length - shown.length, 'Projekt', 'Projekte'),
    ...(entries.length === 0
      ? [
          'Kein Projekt hat in diesem Zeitfenster etwas geliefert — keine erledigte ' +
            'Aufgabe, kein Merge, kein Deploy.',
        ]
      : []),
  ];

  return { id: 'projekte', title: '2. Je Projekt', entries, notes };
}

function shippedWeight(project: ProjectOutcome): number {
  return project.tasksDone + project.merges + project.deploys;
}

/** §16.3 — Qualitätstrend. */
function qualitySection(data: WeeklyReportData): ReportSection {
  const { redRate, findingsByGate, timeToGreen } = data.metrics.quality;
  const entries: ReportEntry[] = [
    entry(
      `Rot-Quote: ${formatShare(redRate.rate)} (${formatInteger(redRate.tasksRed)} von ` +
        `${formatInteger(redRate.tasksConcluded)} abgeschlossenen Aufgaben)`,
    ),
    entry(
      `Zeit bis grün: Median ${formatDuration(timeToGreen.medianMs)} · p90 ` +
        `${formatDuration(timeToGreen.p90Ms)} (${formatInteger(timeToGreen.resolved)} behoben, ` +
        `${formatInteger(timeToGreen.stillOpen)} noch offen)`,
    ),
  ];

  if (timeToGreen.slowest) {
    const slowest = timeToGreen.slowest;
    entries.push(
      entry(
        `Langsamster Fund: Gate ${slowest.gateId} — ${formatMillis(slowest.durationMs)} ` +
          // Nur der Kopf der Kennung: eine volle uuid ist in einer Mail Rauschen,
          // und der Prüfbericht kürzt aus demselben Grund auf acht Zeichen.
          `(Aufgabe ${slowest.taskId.slice(0, 8)})`,
      ),
    );
  }

  const gates = findingsByGate.slice(0, MAX_GATE_FINDINGS);
  for (const gate of gates) {
    entries.push(
      entry(
        `Gate ${gate.gateId}: ${plural(gate.findings, 'Fund', 'Funde')} in ` +
          `${plural(gate.tasks, 'Aufgabe', 'Aufgaben')}`,
      ),
    );
  }

  const notes: string[] = [
    ...omittedNote(findingsByGate.length - gates.length, 'Gate mit Funden', 'Gates mit Funden'),
    ...(findingsByGate.length === 0 ? ['Kein Gate hat im Zeitfenster einen Fund gemeldet.'] : []),
  ];

  return { id: 'qualitaet', title: '3. Qualitätstrend', entries, notes };
}

/** §16.4 — Radar. */
function radarSection(data: WeeklyReportData): ReportSection {
  const { radar } = data;
  const shown = radar.entries.slice(0, MAX_RADAR_ENTRIES);
  const entries = shown.map((item) =>
    entry(
      [
        radarKindLabel(item.kind),
        item.name ? `: ${item.name}` : '',
        item.current && item.latest ? ` ${item.current} → ${item.latest}` : '',
        item.escalationNumber !== null ? ` (Entscheidung #${item.escalationNumber})` : '',
        ` · Vertrauensstufe ${item.trustLevel === null ? 'nicht vergeben' : `L${item.trustLevel}`}`,
      ].join(''),
    ),
  );

  const limits = radar.limits.slice(0, MAX_RADAR_LIMITS);
  for (const limit of limits) entries.push(entry(`Nicht angesehen: ${limit}`));

  const notes: string[] = [
    ...omittedNote(radar.entries.length - shown.length, 'Radar-Fund', 'Radar-Funde'),
    ...omittedNote(
      radar.limits.length - limits.length,
      'Prüfgrenze des Radars',
      'Prüfgrenzen des Radars',
    ),
  ];

  if (radar.runs === 0) {
    // Der eine Fall, der ein Defekt ist und nicht eine ruhige Woche: §6.0 führt
    // die Abrechnungsänderung als Risiko Nr. 1 des Projekts, und ein Radar, der
    // gar nicht lief, sieht in einer leeren Liste genauso aus wie einer, der
    // nichts fand.
    notes.push('Kein Radar-Lauf im Zeitfenster — das ist keine Entwarnung, sondern eine Lücke.');
  } else {
    notes.push(
      `${plural(radar.runs, 'Radar-Lauf', 'Radar-Läufe')}, ` +
        `${plural(radar.tasks, 'automatisch angelegte Aufgabe', 'automatisch angelegte Aufgaben')} ` +
        '(A10: Patch und Minor).',
    );
    if (radar.entries.length === 0) notes.push('Kein Radar-Fund im Zeitfenster.');
    if (radar.entries.length > 0 && shown.every((item) => item.trustLevel === null)) {
      // §16.4 verlangt Vertrauensstufen; abgeleitet statt behauptet, damit der
      // Satz von selbst verschwindet, sobald es einen Erzeuger gibt.
      notes.push(
        'Vertrauensstufen (§14) fehlen an allen Funden: der Radar vergibt heute keine — ' +
          'für diesen Teil von §16.4 gibt es keinen Erzeuger.',
      );
    }
  }
  for (const problem of radar.problems.slice(0, MAX_RADAR_LIMITS)) {
    notes.push(`Radar-Problem: ${clampText(problem, DETAIL_MAX_CHARS)}`);
  }

  return { id: 'radar', title: '4. Radar', entries, notes };
}

const RADAR_KIND_LABELS: Record<string, string> = {
  billing: 'Abrechnungsänderung',
  dependency_major: 'Hauptversion',
  dependency_advisory: 'Sicherheitshinweis',
};

function radarKindLabel(kind: string): string {
  return RADAR_KIND_LABELS[kind] ?? kind;
}

/** §16.5 — Betriebsprüfung. Spricht auch dann, wenn nichts da ist. */
function auditSection(data: WeeklyReportData): ReportSection {
  const { audit } = data;
  const entries: ReportEntry[] = [];

  const verdicts = audit.verdicts.slice(0, MAX_AUDIT_VERDICTS);
  for (const verdict of verdicts) {
    entries.push(
      entry(
        `Urteil: ${verdict.verdict ?? auditOutcomeLabel(verdict.outcome)}` +
          (verdict.domain ? ` (Domäne ${verdict.domain})` : ''),
      ),
    );
  }

  const confirmed = audit.confirmed.slice(0, MAX_AUDIT_FINDINGS);
  for (const finding of confirmed) {
    entries.push(
      entry(`${finding.class}${finding.gate ? ` (${finding.gate})` : ''}: ${finding.summary}`, [
        `Stand: ${finding.status}`,
      ]),
    );
  }

  const limits = audit.scopeLimits.slice(0, MAX_SCOPE_LIMITS);
  for (const limit of limits) entries.push(entry(`Nicht prüfbar: ${limit}`));

  const notes: string[] = [
    ...omittedNote(audit.verdicts.length - verdicts.length, 'Prüfungsurteil', 'Prüfungsurteile'),
    ...omittedNote(
      audit.confirmed.length - confirmed.length,
      'bestätigter Fund',
      'bestätigte Funde',
    ),
    ...omittedNote(audit.scopeLimits.length - limits.length, 'Prüfgrenze', 'Prüfgrenzen'),
  ];

  if (audit.runs === 0) {
    // §8.2s Kadenz ist „weekly, Sunday", damit der Montagsbericht das Urteil
    // trägt. Fehlt es, ist das der Befund und nicht die Abwesenheit eines
    // Abschnitts.
    notes.push('Keine Betriebsprüfung in diesem Zeitfenster — §8.2s Wochenlauf fehlt.');
  } else {
    notes.push(
      `${plural(audit.runs, 'Prüfung', 'Prüfungen')}, ` +
        `${plural(audit.confirmed.length, 'bestätigter Fund', 'bestätigte Funde')}, ` +
        `${formatInteger(audit.dismissed)} verworfen, ` +
        `${plural(audit.suspicions, 'Verdachtsmoment', 'Verdachtsmomente')}.`,
    );
    if (audit.scopeLimits.length === 0) {
      // §16.5 wörtlich: „stated even when empty". Eine leere Liste ist selbst
      // eine Behauptung, und sie gehört ausgesprochen (§8.2s eigene Formel im
      // Prüfbericht, Abschnitt 4).
      notes.push(
        'Keine Prüfgrenzen gemeldet — die Prüfung behauptet damit, den ganzen Umfang ' +
          'angesehen zu haben.',
      );
    }
    if (audit.confirmed.length === 0) notes.push('Kein bestätigter Fund.');
  }

  return { id: 'betriebspruefung', title: '5. Betriebsprüfung', entries, notes };
}

const AUDIT_OUTCOME_LABELS: Record<string, string> = {
  running: 'noch nicht abgeschlossen',
  failed: 'abgebrochen, ohne Urteil',
  done: 'abgeschlossen, Urteil fehlt im Datensatz',
};

function auditOutcomeLabel(outcome: string): string {
  return AUDIT_OUTCOME_LABELS[outcome] ?? outcome;
}

/** §16.6 — nächste Woche. */
function nextWeekSection(data: WeeklyReportData): ReportSection {
  const { nextWeek } = data;
  const shown = nextWeek.entries.slice(0, MAX_NEXT_WEEK);
  const entries = shown.map((item) =>
    entry(`${item.priority} · ${item.title}${item.project ? ` (${item.project})` : ''}`),
  );

  const notes: string[] = [
    ...omittedNote(nextWeek.total - shown.length, 'wartende Aufgabe', 'wartende Aufgaben'),
    // Der Satz, der die Lücke benennt statt sie zu erfinden (siehe Kopf).
    'Quelle: wartende Aufgaben. §5s Entität `goals` hat weder Tabelle noch Erzeuger, ' +
      'also stehen hier keine Ziele, sondern die Warteschlange.',
  ];
  if (entries.length === 0) notes.push('Keine wartende Aufgabe.');

  return { id: 'naechste_woche', title: '6. Nächste Woche', entries, notes };
}

// --- Zusammenbau -------------------------------------------------------------

/**
 * Der ganze Bericht, aus fertig erhobenen Daten.
 *
 * Rein: keine Uhr, keine Datenbank, kein Zufall. Alles, was der Bericht sagt,
 * steht in `data` — und deshalb ist §22s „every headline number reconciles"
 * eine Aussage über die Erhebung und nicht über den Renderer.
 */
export function renderWeeklyReport(
  data: WeeklyReportData,
  options: RenderOptions = {},
): RenderedWeeklyReport {
  const cap = options.maxChars ?? WEEKLY_REPORT_MAX_CHARS;
  const sections: ReportSection[] = [
    headlineSection(data),
    projectSection(data),
    qualitySection(data),
    radarSection(data),
    auditSection(data),
    nextWeekSection(data),
  ];

  const head = reportHead(data);
  const cut = enforceCap(sections, head, cap);
  const text = renderText(head, sections, cut.footer);

  return {
    subject: reportSubject(data.window),
    text,
    html: renderHtml(head, sections, cut.footer),
    sections,
    truncation: {
      chars: text.length,
      cap,
      droppedByCap: cut.dropped,
      emptiedByCap: cut.emptied,
      withinCap: text.length <= cap,
    },
  };
}

/** Betreff und Kopfzeilen, beide aus dem Fenster. */
export function reportSubject(window: MetricsWindow): string {
  return `Vorschicht — Wochenbericht ${formatDay(window.from)}–${formatDay(lastDay(window))}`;
}

/** Das Fenster ist halboffen; der letzte Tag ist eine Millisekunde davor. */
function lastDay(window: MetricsWindow): Date {
  return new Date(window.to.getTime() - 1);
}

function reportHead(data: WeeklyReportData): string[] {
  return [
    'Vorschicht — Wochenbericht',
    `Zeitraum: ${formatDay(data.window.from)} bis ${formatDay(lastDay(data.window))} ` +
      '(Europe/Vienna)',
  ];
}

interface CapResult {
  dropped: number;
  emptied: SectionId[];
  footer: string[];
}

/**
 * Schicht 2: kürzen, bis der Klartext passt — und sagen, dass gekürzt wurde.
 *
 * Wirkt im Normalbetrieb nicht; `generator.test.ts` sichert das über
 * aufgeblähte Daten ausdrücklich zu (`droppedByCap === 0`). Fällt Schicht 1
 * aus, arbeitet diese hier und die Zusicherung wird rot — das ist der Zweck
 * der Zusicherung.
 *
 * Gemessen wird der jeweils **fertige** Text statt einer geschätzten Länge:
 * eine Schätzung, die um ein Zeichen danebenliegt, liefert einen Bericht über
 * der Grenze, und die Grenze wäre dann eine Absichtserklärung. Der Bericht ist
 * wenige Kilobyte gross, die Schleife also billig.
 */
function enforceCap(sections: ReportSection[], head: string[], cap: number): CapResult {
  let dropped = 0;
  const emptied: SectionId[] = [];

  while (renderText(head, sections, capFooter(dropped, emptied, true)).length > cap) {
    const victim = nextVictim(sections);
    if (!victim) {
      // Unter die Grenze kommen wir nicht mehr: nur noch Überschriften und
      // Sätze, die eine Abwesenheit benennen. Das ist ein zu klein gesetzter
      // Deckel und kein Bericht, der zu lang ist — und der Bericht sagt es,
      // statt still über der Grenze zu liegen.
      return { dropped, emptied, footer: capFooter(dropped, emptied, false) };
    }
    victim.entries.pop();
    dropped += 1;
    if (victim.entries.length === 0 && !emptied.includes(victim.id)) {
      emptied.push(victim.id);
      victim.notes.push('Gekürzt: dieser Abschnitt musste der Längengrenze weichen.');
    }
  }

  return { dropped, emptied, footer: capFooter(dropped, emptied, true) };
}

/** Der nächste Eintrag, der weichen darf — nach `SACRIFICE_ORDER`. */
function nextVictim(sections: readonly ReportSection[]): ReportSection | null {
  for (const id of SACRIFICE_ORDER) {
    const section = sections.find((candidate) => candidate.id === id);
    if (section && section.entries.length > 0) return section;
  }
  return null;
}

function capFooter(dropped: number, emptied: readonly SectionId[], withinCap: boolean): string[] {
  const lines: string[] = [];
  if (dropped > 0) {
    lines.push(
      `Längengrenze: ${formatInteger(dropped)} Einträge wurden verworfen, damit dieser ` +
        'Bericht in seine Grenze passt.',
    );
  }
  if (emptied.length > 0) {
    lines.push(`Vollständig gekürzte Abschnitte: ${emptied.join(', ')}.`);
  }
  if (!withinCap) {
    lines.push(
      'Der Bericht liegt trotz aller Kürzungen über der Längengrenze — die Grenze ist ' +
        'kleiner als die sechs Abschnitte selbst.',
    );
  }
  return lines;
}

// --- Die zwei Darstellungen --------------------------------------------------

function renderText(
  head: readonly string[],
  sections: readonly ReportSection[],
  footer: readonly string[],
): string {
  const lines: string[] = [...head];
  for (const section of sections) {
    lines.push('', section.title, '');
    for (const item of section.entries) {
      lines.push(`- ${item.text}`);
      for (const detail of item.details) lines.push(`  · ${detail}`);
    }
    for (const note of section.notes) lines.push(`  ${note}`);
  }
  if (footer.length > 0) {
    lines.push('', '—');
    for (const line of footer) lines.push(line);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * Derselbe Inhalt als HTML — **für Mailprogramme gebaut, nicht für Browser.**
 *
 * Bis A150 stand hier ein `<style>`-Block im `<head>` mit `class`-Attributen
 * darunter, begründet mit „Mail-Programme sind sich über eine Handvoll
 * Elementregeln einig". Das stimmt für die Regeln und nicht für den **Ort**:
 * Gmail entfernt `<head>` samt Inhalt, wenn eine Nachricht über ein
 * Drittanbieter-Konto hereinkommt, und Outlooks Desktop-Fassung rendert mit
 * Words HTML-Maschine, die Klassenselektoren nur teilweise auflöst. Der Bericht
 * wäre also genau dort unformatiert angekommen, wo §22s Gate-Satz ihn sehen
 * will („renders in common mail clients“).
 *
 * Gefunden ist das nicht am Code, sondern an einem **Widerspruch zwischen zwei
 * Dateien**: `packages/shared/src/berichte.ts` beschreibt diese Fassung seit
 * ihrem ersten Tag als „mit Tabellen, Inline-Stilen und einem eigenen
 * `<html>`-Dokument“ — eine Beschreibung, die niemand je gegen den Erzeuger
 * gehalten hat. Zwei von dreien stimmten. Der Betreiber hat am 25.8.2026 entschieden,
 * die Beschreibung wahr zu machen statt sie zu streichen.
 *
 * Drei Regeln, und alle drei sind mechanisch geprüft (`check-mailfassung.mjs`):
 *
 *   1. **Kein `<style>` irgendwo, kein `class`.** Jede Farbe, jeder Abstand und
 *      jede Schrift steht inline am Element. Das ist redundant und hässlich und
 *      es ist die einzige Form, die alle drei verbreiteten Maschinen (Blink,
 *      WebKit, Word) gleich behandeln.
 *   2. **Eine Tabelle trägt das Layout**, kein `<div>` und schon gar kein
 *      Flex/Grid — Word kennt beides nicht und fällt auf Blockfluss zurück.
 *   3. **`role="presentation"`** auf der Layouttabelle, damit ein Screenreader
 *      sie nicht als Datentabelle vorliest. §17s a11y-Haltung endet nicht an
 *      der Mailgrenze.
 *
 * Was **nicht** gedoppelt wird, ist die Maskierung: `esc()` wird importiert.
 */
function renderHtml(
  head: readonly string[],
  sections: readonly ReportSection[],
  footer: readonly string[],
): string {
  // Inline, weil `<style>` im `<head>` genau dort verschwindet, wo dieser
  // Bericht gelesen wird. Als Konstanten, damit sie nicht an zwölf Stellen
  // auseinanderlaufen.
  const SCHRIFT = 'font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif';
  const H1 = `${SCHRIFT};font-size:20px;line-height:1.3;font-weight:700;color:#111111;margin:0 0 12px 0`;
  const H2 = `${SCHRIFT};font-size:15px;line-height:1.4;font-weight:700;color:#555555;margin:20px 0 6px 0`;
  const META = `${SCHRIFT};font-size:14px;line-height:1.5;color:#555555;margin:0 0 4px 0`;
  const NOTE = `${SCHRIFT};font-size:14px;line-height:1.5;color:#555555;margin:4px 0 0 0`;
  const FOOT = `${SCHRIFT};font-size:13px;line-height:1.5;color:#777777;margin:28px 0 0 0`;
  const LIST = `${SCHRIFT};font-size:16px;line-height:1.5;color:#111111;margin:0 0 8px 0;padding-left:20px`;
  const ITEM = 'margin:0 0 4px 0';

  const body: string[] = [
    `<h1 style="${H1}">${esc(head[0] ?? '')}</h1>`,
    ...head.slice(1).map((line) => `<p style="${META}">${esc(line)}</p>`),
  ];

  for (const section of sections) {
    body.push(`<h2 style="${H2}">${esc(section.title)}</h2>`);
    if (section.entries.length > 0) {
      body.push(`<ul style="${LIST}">`);
      for (const item of section.entries) {
        const details =
          item.details.length > 0
            ? `<ul style="${LIST}">${item.details
                .map((detail) => `<li style="${ITEM}">${esc(detail)}</li>`)
                .join('')}</ul>`
            : '';
        body.push(`<li style="${ITEM}">${esc(item.text)}${details}</li>`);
      }
      body.push('</ul>');
    }
    for (const note of section.notes) body.push(`<p style="${NOTE}">${esc(note)}</p>`);
  }

  if (footer.length > 0) {
    for (const line of footer) body.push(`<p style="${FOOT}">${esc(line)}</p>`);
  }

  return [
    '<!doctype html>',
    '<html lang="de"><head><meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width,initial-scale=1">',
    '</head>',
    '<body style="margin:0;padding:0;background-color:#ffffff">',
    // Eine Layouttabelle, `role="presentation"`, damit ein Screenreader sie
    // nicht als Datentabelle vorliest.
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"',
    ' style="border-collapse:collapse;background-color:#ffffff">',
    '<tr><td style="padding:24px">',
    ...body,
    '</td></tr></table>',
    '</body></html>',
  ].join('');
}

// --- Erhebung ----------------------------------------------------------------

export interface WeeklyReportGeneratorDeps {
  sql: Queryable;
  /**
   * Der echte Dienst, strukturell deklariert (A57.6).
   *
   * `Pick<MetricsService, 'collect'>` und nicht ein eigenes Interface: eine
   * abgedriftete Signatur muss den Bau brechen, und ein handgeschriebenes
   * Gegenstück wäre die zweite Deklaration, die genau das verhindert.
   */
  metrics: Pick<MetricsService, 'collect'>;
}

/**
 * Der Erzeuger: erhebt, was §16 braucht, und rendert es.
 *
 * `collect()` und `render` bleiben getrennt, damit die Struktur- und
 * Längenentscheidungen ohne Datenbank prüfbar sind und die Abfragen ohne
 * Rendering. Dieselbe Trennung, die `MetricsService` und `gate-runs.ts` haben.
 */
export class WeeklyReportGenerator {
  constructor(private readonly deps: WeeklyReportGeneratorDeps) {}

  async collect(window: MetricsWindow): Promise<WeeklyReportData> {
    const [metrics, projects, radar, audit, nextWeek] = await Promise.all([
      this.deps.metrics.collect(window),
      this.projects(window),
      this.radar(window),
      this.audit(window),
      this.nextWeek(),
    ]);
    return { window, metrics, projects, radar, audit, nextWeek };
  }

  /**
   * Der fertige Bericht, in der Form, die `ReportRecords.record()` nimmt.
   *
   * Der Rückgabetyp ist **`WeeklyReportInput`** und keine eigene Fassung davon:
   * damit ist die Naht zwischen Erzeuger und Archiv typgeprüft, statt aus zwei
   * unabhängigen Deklarationen zu bestehen, die je für sich richtig sind (A81).
   *
   * `metrics` trägt **alles**, woraus der Bericht gebaut wurde, nicht nur
   * §16.1 — §22s Gate verlangt, dass jede Kopfzahl sich nachrechnen lässt, und
   * ein Archiv, das nur die Prosa und die halben Zahlen hält, zwingt ein
   * Prüfskript, deutschen Text zu parsen.
   */
  async generate(window: MetricsWindow, options: RenderOptions = {}): Promise<WeeklyReportInput> {
    const data = await this.collect(window);
    const rendered = renderWeeklyReport(data, options);
    return {
      periodStart: window.from,
      periodEnd: window.to,
      subject: rendered.subject,
      bodyText: rendered.text,
      bodyHtml: rendered.html,
      metrics: archiveMetrics(data, rendered),
    };
  }

  /**
   * §16.2 — was je Projekt geliefert wurde.
   *
   * Zwei Abfragen und nicht eine: die Zählungen sind ein Aggregat über
   * `event_log`, die Titel brauchen einen Join auf `tasks` und eine Grenze je
   * Projekt. In einer Abfrage wäre die Grenze eine über alle Projekte, und ein
   * geschwätziges Projekt nähme einem stillen die Zeilen weg.
   *
   * Die Zahl der weggelassenen Titel wird im Renderer aus `tasksDone`
   * berechnet, nicht aus der Länge dieser Liste — so verfälscht die Grenze der
   * Abfrage die Kürzungsangabe nicht.
   */
  private async projects(window: MetricsWindow): Promise<ProjectOutcome[]> {
    const rows = await this.deps.sql<
      Array<{
        project_id: string | null;
        name: string | null;
        tasks_done: string | number;
        merges: string | number;
        deploys: string | number;
        rollbacks: string | number;
      }>
    >`
      WITH shipped AS (
        SELECT
          project_id,
          count(DISTINCT task_id) FILTER (
            WHERE kind = 'task.state_changed' AND payload ->> 'to' = 'done'
          )::int                                                    AS tasks_done,
          count(*) FILTER (WHERE kind = 'merge.finished')::int       AS merges,
          count(*) FILTER (WHERE kind = 'deploy.succeeded')::int     AS deploys,
          count(*) FILTER (WHERE kind = 'deploy.rolled_back')::int   AS rollbacks
        FROM event_log
        WHERE kind IN ('task.state_changed', 'merge.finished',
                       'deploy.succeeded', 'deploy.rolled_back')
          AND occurred_at >= ${window.from}
          AND occurred_at <  ${window.to}
        GROUP BY project_id
      )
      SELECT s.project_id::text, p.name, s.tasks_done, s.merges, s.deploys, s.rollbacks
      FROM shipped s
      LEFT JOIN projects p ON p.id = s.project_id
      WHERE s.tasks_done > 0 OR s.merges > 0 OR s.deploys > 0 OR s.rollbacks > 0`;

    const titles = await this.shippedTitles(window);

    return rows.map((row) => ({
      projectId: row.project_id,
      // Ein Projekt, dessen Zeile aus `projects` verschwunden ist, behält seine
      // Zahlen: das Ereignisprotokoll überlebt die Konfiguration (0001 nennt
      // den Grund, aus dem `project_id` kein Fremdschlüssel ist).
      name: row.name ?? (row.project_id ? `Projekt ${row.project_id.slice(0, 8)}` : 'ohne Projekt'),
      tasksDone: toNumber(row.tasks_done),
      merges: toNumber(row.merges),
      deploys: toNumber(row.deploys),
      rollbacks: toNumber(row.rollbacks),
      shipped: titles.get(row.project_id ?? '') ?? [],
    }));
  }

  /** Die jüngsten Titel je Projekt — exakt begrenzt, statt global gekappt. */
  private async shippedTitles(window: MetricsWindow): Promise<Map<string, string[]>> {
    const rows = await this.deps.sql<Array<{ project_id: string | null; title: string | null }>>`
      SELECT project_id, title FROM (
        SELECT
          e.project_id::text AS project_id,
          t.title,
          row_number() OVER (PARTITION BY e.project_id ORDER BY e.occurred_at DESC, e.id DESC)
            AS rang
        FROM event_log e
        JOIN tasks t ON t.id = e.task_id
        WHERE e.kind = 'task.state_changed'
          AND e.payload ->> 'to' = 'done'
          AND e.occurred_at >= ${window.from}
          AND e.occurred_at <  ${window.to}
      ) ranked
      WHERE rang <= ${MAX_SHIPPED_BULLETS}
      ORDER BY project_id, rang`;

    const map = new Map<string, string[]>();
    for (const row of rows) {
      if (!row.title) continue;
      const key = row.project_id ?? '';
      const list = map.get(key) ?? [];
      list.push(row.title);
      map.set(key, list);
    }
    return map;
  }

  /**
   * §16.4 — aus `radar.finished`.
   *
   * Artengenau, wie jede Abfrage dieser Familie (A101). Gelesen wird die
   * Nutzlast, die `RadarScan.record()` schreibt; `cards` trägt je Karte die
   * Fakten, aus denen sie gebaut wurde, sodass der Bericht nicht die Prosa der
   * Karte parsen muss (A112.1s Haltung, hier als Leser).
   */
  private async radar(window: MetricsWindow): Promise<RadarSummary> {
    const rows = await this.deps.sql<Array<{ payload: unknown }>>`
      SELECT payload FROM event_log
      WHERE kind = 'radar.finished'
        AND occurred_at >= ${window.from}
        AND occurred_at <  ${window.to}
      ORDER BY id`;

    const summary: RadarSummary = {
      runs: rows.length,
      entries: [],
      tasks: 0,
      limits: [],
      problems: [],
    };

    for (const row of rows) {
      const payload = asRecord(row.payload);
      for (const card of asArray(payload.cards)) {
        const item = asRecord(card);
        summary.entries.push({
          kind: asString(item.kind) ?? 'unbekannt',
          name: asString(item.name),
          current: asString(item.current),
          latest: asString(item.latest),
          escalationNumber: typeof item.number === 'number' ? item.number : null,
          // Heute immer null; der Radar vergibt keine Stufen (siehe Kopf).
          trustLevel: typeof item.trustLevel === 'number' ? item.trustLevel : null,
        });
      }
      summary.tasks += asArray(payload.tasks).length;
      pushUnique(summary.limits, asArray(payload.limits));
      pushUnique(summary.problems, asArray(payload.problems));
    }

    return summary;
  }

  /**
   * §16.5 — aus den Sichten `audits` und `audit_findings`.
   *
   * Ausgewählt wird über `started_at` und nicht über `finished_at`, und der
   * Fall, der die beiden unterscheidet, ist **enger als er zuerst aussah**:
   * 0013s Sicht setzt `finished_at` aus `kind IN ('finished', 'failed')`,
   * eine sauber gescheiterte Prüfung trägt also sehr wohl einen Endzeitpunkt
   * und wäre auch so sichtbar. Unsichtbar wäre eine Prüfung **ohne terminale
   * Zeile** — eine, die noch läuft, oder eine, deren Prozess starb, bevor er
   * irgendetwas schreiben konnte. Genau für die schreibt A56.6 die
   * `started`-Zeile **vor** dem Spawn, und genau die will §8.2 Regel 5
   * sichtbar haben („a silent auditor and a working one look identical from
   * outside"). Über `finished_at` läse sich so eine Woche wie eine, in der
   * nicht geprüft wurde.
   *
   * *Die erste Fassung dieses Absatzes behauptete den weiteren Fall (jede
   * abgestürzte Prüfung), und die Mutation `started_at → finished_at` hat ihn
   * **überlebt** — der Beleg war schwächer als der Satz. Beide sind
   * nachgezogen; A76.4s Klasse, im eigenen Kommentar gefunden.*
   */
  private async audit(window: MetricsWindow): Promise<AuditSummary> {
    const runs = await this.deps.sql<
      Array<{
        id: string;
        domain: string | null;
        verdict: string | null;
        outcome: string;
        scope_limits: unknown;
      }>
    >`
      SELECT id::text, domain, verdict, outcome, scope_limits
      FROM audits
      WHERE started_at >= ${window.from}
        AND started_at <  ${window.to}
      ORDER BY started_at`;

    const findings = await this.deps.sql<
      Array<{ class: string | null; summary: string | null; gate: string | null; status: string }>
    >`
      SELECT f.class, f.summary, f.gate, f.status
      FROM audit_findings f
      JOIN audits a ON a.id = f.audit_id
      WHERE a.started_at >= ${window.from}
        AND a.started_at <  ${window.to}
      ORDER BY f.raised_at
      LIMIT 200`;

    const scopeLimits: string[] = [];
    for (const run of runs) pushUnique(scopeLimits, asArray(run.scope_limits));

    const confirmed: AuditFindingSummary[] = [];
    let suspicions = 0;
    let dismissed = 0;
    for (const row of findings) {
      const klass = row.class ?? 'unbekannt';
      if (klass === 'suspicion') {
        suspicions += 1;
        continue;
      }
      if (row.status === 'dismissed') {
        dismissed += 1;
        continue;
      }
      confirmed.push({
        class: klass,
        summary: row.summary ?? '(ohne Zusammenfassung)',
        gate: row.gate,
        status: row.status,
      });
    }

    return {
      runs: runs.length,
      verdicts: runs.map((run) => ({
        auditId: run.id,
        domain: run.domain,
        verdict: run.verdict,
        outcome: run.outcome,
      })),
      confirmed,
      suspicions,
      dismissed,
      scopeLimits,
    };
  }

  /**
   * §16.6 — die Warteschlange, kein Zielregister.
   *
   * Ohne Zeitfenster, und das ist der Punkt: „next week" ist eine Aussage über
   * den **Bestand** am Ende der Woche und nicht über Vorgänge in ihr —
   * dieselbe Unterscheidung, die `EscalationCounts` zwischen `answered` und
   * `open` trifft. Eine Aufgabe, die seit einem Monat wartet, gehört in jeden
   * Bericht, bis sie läuft.
   */
  private async nextWeek(): Promise<NextWeek> {
    const rows = await this.deps.sql<
      Array<{
        id: string;
        title: string | null;
        priority: string;
        project: string | null;
        gesamt: string | number;
      }>
    >`
      SELECT t.id::text, t.title, t.priority, p.name AS project,
             count(*) OVER ()::int AS gesamt
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      WHERE t.state = 'queued'
      ORDER BY t.priority ASC, t.created_at ASC
      LIMIT ${MAX_NEXT_WEEK}`;

    return {
      source: 'queued_tasks',
      entries: rows.map((row) => ({
        taskId: row.id,
        title: row.title ?? '(ohne Titel)',
        priority: row.priority,
        project: row.project,
      })),
      total: rows.length > 0 ? toNumber(rows[0]?.gesamt) : 0,
    };
  }
}

/**
 * Was ins Archiv geht.
 *
 * `WeeklyReportInput.metrics` ist absichtlich `Record<string, unknown>`
 * (`records.ts`, Regel 2: die Form gehört dem Erzeuger). Der Cast steht
 * deshalb hier, an genau einer Stelle, statt dass die Form dort ein zweites Mal
 * deklariert wird — eine Schnittstelle hat in TypeScript keine implizite
 * Indexsignatur, und das ist die ganze Ursache des Casts.
 *
 * Mitarchiviert werden **auch** die Kürzungszahlen: ob ein Bericht gekürzt
 * wurde, ist eine Tatsache über das ausgelieferte Dokument, und ein Prüfer, der
 * eine Zahl nicht wiederfindet, soll sie hier erklärt bekommen statt sie für
 * falsch zu halten.
 */
function archiveMetrics(
  data: WeeklyReportData,
  rendered: RenderedWeeklyReport,
): Record<string, unknown> {
  return {
    window: windowLabel(data.window),
    headline: data.metrics.headline,
    quality: data.metrics.quality,
    projects: data.projects,
    radar: data.radar,
    audit: data.audit,
    nextWeek: data.nextWeek,
    truncation: rendered.truncation,
  } as unknown as Record<string, unknown>;
}

// --- Kleinkram ---------------------------------------------------------------

/** Siehe `metrics/service.ts`: `int8`/`numeric` kommen als Zeichenkette an. */
function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Zeichenketten anhängen, ohne Wiederholungen — die Reihenfolge bleibt. */
function pushUnique(target: string[], values: readonly unknown[]): void {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    if (!target.includes(value)) target.push(value);
  }
}
