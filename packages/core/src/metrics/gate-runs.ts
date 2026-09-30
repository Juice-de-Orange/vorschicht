/**
 * Was sich aus `gate.finished` ablesen lässt: Durchlaufquote, Funde je Gate,
 * Zeit-bis-grün (§16.1 und §16.3).
 *
 * Alles hier ist rein. Die Zeilen kommen aus `event_log` — artengenau, nie über
 * alle Arten (A101 hat gemessen, was das kostet: 18 411 Zeilen aus *einem*
 * Defekt in einer Woche) — und die Entscheidungen darüber stehen in Funktionen,
 * die eine Testdatei ohne Datenbank fahren kann. Fünf davon sind keine
 * Übertragung von §16, sondern Festlegungen.
 *
 *  1. **Das Urteil wird aus den Schritten abgeleitet, nicht aus `ok` gelesen.**
 *     `summarise()` in `merge-queue.ts` schreibt beides in dieselbe Nutzlast,
 *     und `GateSuite` berechnet `ok` als „kein Fund und kein infra" — die
 *     Zusammenfassung ist also aus den Belegen ableitbar, und dann ist der
 *     Beleg die bessere Quelle. Das ist A54.2s Haltung („der Prüfling liefert
 *     die Beobachtung, der Mechanismus die mechanische Hälfte") auf eine
 *     Kennzahl angewandt: eine Nutzlast, deren `ok: true` neben einem
 *     `finding`-Schritt steht, wird als **gescheitert** gezählt, und nichts an
 *     der Zahl hängt an einem Flag, das jemand hätte setzen können. `ok` wird
 *     deshalb nicht einmal abgefragt.
 *
 *  2. **Vier Ausgänge, nicht zwei.** `passed`, `failed`, `inconclusive`
 *     (A25: nur `infra`, also *nichts geprüft*) und `unreadable`. Die dritte
 *     ist die, die man weglässt, und sie ist genau die, die §11 verbietet
 *     durchzuwinken: ein Lauf, der an einer unerreichbaren Registry scheiterte,
 *     ist weder bestanden noch durchgefallen, und ihn in den Nenner zu nehmen
 *     senkt die Quote für einen Maschinenausfall. Ein Lauf mit Fund **und**
 *     infra zählt als `failed` — ein Fund ist entschieden, ein infra nicht.
 *
 *  3. **Nicht lesbar ist nicht bestanden.** Fehlt die Aufgabenkennung oder die
 *     Schrittliste, wird die Zeile gezählt und sonst nichts: sie geht in keinen
 *     Zähler des Nenners ein und in keine Paarung. Fail closed, wie A83.6,
 *     A87.6 und A99.4 dieselbe Naht an drei anderen Stellen bauen. Die
 *     Aufgabenkennung ist Pflicht, weil ein Gate-Lauf ohne sie weder einer
 *     Aufgabe zugerechnet noch mit seinem späteren grünen Lauf gepaart werden
 *     kann — und „diese Aufgabe hat ihr Gate bestanden" wäre dann eine Aussage
 *     über niemanden.
 *
 *  4. **Zeit-bis-grün benutzt dieselbe Auflösungsregel wie die `findings`-Sicht
 *     (Migration 0015).** Ein Fund gilt als behoben durch einen *späteren*
 *     Gate-Lauf **derselben Aufgabe**, in dem **dasselbe** Gate grün meldete —
 *     alle drei Bedingungen, weil 0015 sie einzeln mutiert und je einen Fall
 *     getötet hat. Eine zweite, hier erfundene Auflösungsregel wäre eine zweite
 *     Antwort auf dieselbe Frage, und §16s Bericht und die `findings`-Sicht
 *     würden dann verschiedene Dinge „behoben" nennen.
 *
 *  5. **Die Auflösung darf nach dem Fenster liegen, der Fund nicht.** Ein Fund
 *     vom Sonntag 23:59 wäre sonst für immer „offen", weil das Fenster
 *     zumacht, bevor der nächste Lauf stattfindet. Also: der Fund muss im
 *     Fenster liegen, der grüne Lauf danach irgendwann. Die Regel ist
 *     ausgesprochen, weil ein Prüfer sie sonst raten müsste — und sie ist der
 *     Grund, warum die Abfrage ohne obere Schranke liest und die Fensterprüfung
 *     hier stattfindet statt in SQL.
 */
import { type Quantity, ratio, unknown } from './quantity.js';
import { median, percentile } from './statistics.js';
import { inWindow, type MetricsWindow } from './window.js';

/** Ein Schritt, so wie `summarise()` ihn in die Nutzlast schreibt. */
export interface GateStepSummary {
  id: string;
  verdict: string;
  detail: string | null;
}

/** Eine Zeile aus `event_log`, vor dem Lesen der Nutzlast. */
export interface GateRunRow {
  id: string;
  occurredAt: Date;
  taskId: string | null;
  payload: unknown;
}

/** Dieselbe Zeile, nachdem die Nutzlast gehalten hat, was sie verspricht. */
export interface GateRunRecord {
  id: string;
  occurredAt: Date;
  taskId: string;
  steps: GateStepSummary[];
}

export type GateRunOutcome = 'passed' | 'failed' | 'inconclusive';

export interface GatePassRate {
  passed: number;
  failed: number;
  /** A25: der Lauf konnte nicht zu Ende laufen — nichts geprüft, nichts entschieden. */
  inconclusive: number;
  /** Zeilen, deren Nutzlast die zugesagte Form nicht hatte (Entscheidung 3). */
  unreadable: number;
  /** `passed / (passed + failed)`. Ohne entschiedenen Lauf: null mit Grund. */
  rate: Quantity;
}

export interface GateFindingCount {
  gateId: string;
  /** Rote Schritte dieses Gates im Fenster. Mehrere je Aufgabe sind möglich. */
  findings: number;
  /** Wie viele verschiedene Aufgaben es getroffen hat. */
  tasks: number;
}

export interface TimeToGreenSample {
  taskId: string;
  gateId: string;
  /** Der Lauf, in dem das Gate rot war. */
  raisedRunId: string;
  raisedAt: string;
  /** Der spätere Lauf, in dem dasselbe Gate grün meldete. */
  resolvedRunId: string;
  resolvedAt: string;
  durationMs: number;
}

export interface TimeToGreen {
  /** Funde im Fenster, für die ein späterer grüner Lauf existiert. */
  resolved: number;
  /** Funde im Fenster, für die (noch) keiner existiert. */
  stillOpen: number;
  medianMs: Quantity;
  p90Ms: Quantity;
  /** Der langsamste aufgelöste Fund — die Zeile, die im Bericht etwas erklärt. */
  slowest: TimeToGreenSample | null;
}

/**
 * Die Nutzlast lesen, oder `null`.
 *
 * `null` heisst „diese Zeile trägt kein Urteil", nicht „das Gate war grün".
 * Der Aufrufer zählt sie als `unreadable`.
 */
export function parseGateRun(row: GateRunRow): GateRunRecord | null {
  if (!row.taskId) return null;
  const payload = row.payload;
  if (typeof payload !== 'object' || payload === null) return null;
  const raw = (payload as { steps?: unknown }).steps;
  if (!Array.isArray(raw)) return null;

  const steps: GateStepSummary[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const step = entry as { id?: unknown; verdict?: unknown; detail?: unknown };
    if (typeof step.id !== 'string' || typeof step.verdict !== 'string') return null;
    steps.push({
      id: step.id,
      verdict: step.verdict,
      detail: typeof step.detail === 'string' ? step.detail : null,
    });
  }
  // Eine leere Schrittliste ist kein Lauf: §11 sperrt sechs Gates, die kein
  // Projekt abwählen kann, also gibt es keine gültige Suite ohne Schritt. Sie
  // als `passed` zu zählen hiesse, ein Nichts als Bestehen zu buchen.
  if (steps.length === 0) return null;
  return { id: row.id, occurredAt: row.occurredAt, taskId: row.taskId, steps };
}

/** Entscheidung 1 und 2: das Urteil kommt aus den Schritten. */
export function classifyGateRun(run: GateRunRecord): GateRunOutcome {
  if (run.steps.some((step) => step.verdict === 'finding')) return 'failed';
  if (run.steps.some((step) => step.verdict === 'infra')) return 'inconclusive';
  if (run.steps.every((step) => step.verdict === 'green')) return 'passed';
  // Ein Urteilswort, das dieser Katalog nicht kennt: nichts entschieden. Die
  // Alternative wäre, es als grün zu lesen, und das ist die eine Richtung, in
  // die eine Kennzahl über Gates nicht falsch liegen darf.
  return 'inconclusive';
}

/**
 * §16.1s Gate-Durchlaufquote.
 *
 * `rows` darf über das Fenster hinausreichen — die Zeit-bis-grün braucht das
 * (Entscheidung 5), und diese Funktion filtert selbst. Ohne die Filterung
 * zählte ein Lauf von Montag in den Bericht der Vorwoche.
 */
export function gatePassRate(rows: readonly GateRunRow[], window: MetricsWindow): GatePassRate {
  let passed = 0;
  let failed = 0;
  let inconclusive = 0;
  let unreadable = 0;

  for (const row of rows) {
    if (!inWindow(row.occurredAt, window)) continue;
    const run = parseGateRun(row);
    if (!run) {
      unreadable += 1;
      continue;
    }
    const outcome = classifyGateRun(run);
    if (outcome === 'passed') passed += 1;
    else if (outcome === 'failed') failed += 1;
    else inconclusive += 1;
  }

  const decided = passed + failed;
  const rate =
    decided > 0
      ? ratio(passed, decided, 'no_data')
      : // Es gab Läufe, nur keinen, der etwas entschieden hat: das ist
        // `inconclusive`, und es ist etwas anderes als ein ruhiges Fenster.
        unknown(inconclusive + unreadable > 0 ? 'inconclusive' : 'no_data');

  return { passed, failed, inconclusive, unreadable, rate };
}

/**
 * §16.3s „findings by gate".
 *
 * Gezählt werden **rote Schritte**, nicht Läufe: ein Lauf mit zwei roten Gates
 * hat zwei Funde, und die Frage lautet „welches Gate hält uns auf", nicht „wie
 * oft war irgendetwas rot". Absteigend sortiert, damit der Bericht oben
 * abschneiden kann, ohne selbst zu sortieren; bei Gleichstand alphabetisch,
 * weil eine Reihenfolge, die von der Einfügereihenfolge abhängt, zwei Läufe
 * über dieselben Daten verschieden aussehen lässt.
 */
export function findingsByGate(
  rows: readonly GateRunRow[],
  window: MetricsWindow,
): GateFindingCount[] {
  const findings = new Map<string, number>();
  const tasks = new Map<string, Set<string>>();

  for (const row of rows) {
    if (!inWindow(row.occurredAt, window)) continue;
    const run = parseGateRun(row);
    if (!run) continue;
    for (const step of run.steps) {
      if (step.verdict !== 'finding') continue;
      findings.set(step.id, (findings.get(step.id) ?? 0) + 1);
      const seen = tasks.get(step.id) ?? new Set<string>();
      seen.add(run.taskId);
      tasks.set(step.id, seen);
    }
  }

  return [...findings.entries()]
    .map(([gateId, count]) => ({
      gateId,
      findings: count,
      tasks: tasks.get(gateId)?.size ?? 0,
    }))
    .sort((a, b) => b.findings - a.findings || a.gateId.localeCompare(b.gateId));
}

/**
 * §16.3s Zeit-bis-grün, Paar für Paar (Entscheidungen 4 und 5).
 *
 * `rows` muss nach Auftreten aufsteigend sortiert sein — die Abfrage sortiert
 * nach `event_log.id`, weil zwei Läufe einer schnellen Suite denselben
 * Zeitstempel tragen können und „der spätere Lauf" dann keine Ordnung mehr
 * wäre (dieselbe Begründung, aus der 0015 `gate_runs.seq` einführt).
 */
export function timeToGreen(rows: readonly GateRunRow[], window: MetricsWindow): TimeToGreen {
  const runs: GateRunRecord[] = [];
  for (const row of rows) {
    const run = parseGateRun(row);
    if (run) runs.push(run);
  }

  const samples: TimeToGreenSample[] = [];
  let stillOpen = 0;

  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index] as GateRunRecord;
    if (!inWindow(run.occurredAt, window)) continue;
    for (const step of run.steps) {
      if (step.verdict !== 'finding') continue;
      const resolution = findResolution(runs, index + 1, run.taskId, step.id);
      if (!resolution) {
        stillOpen += 1;
        continue;
      }
      samples.push({
        taskId: run.taskId,
        gateId: step.id,
        raisedRunId: run.id,
        raisedAt: run.occurredAt.toISOString(),
        resolvedRunId: resolution.id,
        resolvedAt: resolution.occurredAt.toISOString(),
        durationMs: resolution.occurredAt.getTime() - run.occurredAt.getTime(),
      });
    }
  }

  const durations = samples.map((sample) => sample.durationMs);
  let slowest: TimeToGreenSample | null = null;
  for (const sample of samples) {
    if (!slowest || sample.durationMs > slowest.durationMs) slowest = sample;
  }
  const missing = missingReason(stillOpen);

  return {
    resolved: samples.length,
    stillOpen,
    medianMs: durations.length > 0 ? median(durations) : unknown(missing),
    p90Ms: durations.length > 0 ? percentile(durations, 0.9) : unknown(missing),
    slowest,
  };
}

/**
 * Kein aufgelöster Fund: lag es daran, dass es keinen Fund gab, oder daran,
 * dass keiner grün geworden ist? Das ist derselbe Unterschied wie bei der
 * Durchlaufquote, und er ist hier der wichtigere von beiden — offene Funde
 * ohne Median heisst, dass die Gates rot stehen, nicht dass alles ruhig war.
 */
function missingReason(stillOpen: number): 'no_data' | 'inconclusive' {
  return stillOpen > 0 ? 'inconclusive' : 'no_data';
}

/** Der erste spätere Lauf derselben Aufgabe, in dem dieses Gate grün war. */
function findResolution(
  runs: readonly GateRunRecord[],
  fromIndex: number,
  taskId: string,
  gateId: string,
): GateRunRecord | null {
  for (let index = fromIndex; index < runs.length; index += 1) {
    const candidate = runs[index] as GateRunRecord;
    if (candidate.taskId !== taskId) continue;
    if (candidate.steps.some((step) => step.id === gateId && step.verdict === 'green')) {
      return candidate;
    }
  }
  return null;
}
