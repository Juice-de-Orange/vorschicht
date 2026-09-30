/**
 * §22 Phase 8 Schritt 1: die Kennzahlen-Erhebung über `event_log`.
 *
 * §18 macht das Ereignisprotokoll zur Wahrheitsquelle, §22s Phase-8-Gate
 * verlangt, dass jede Kopfzahl sich **unabhängig nachrechnen** lässt. Beides
 * zusammen legt die Bauart fest: hier wird nichts gezählt, was jemand pflegt.
 * Es gibt keinen Zähler, keine Spalte, die jemand hochsetzt, und keinen
 * Zwischenstand — jede Zahl entsteht bei der Abfrage aus Zeilen, die ein
 * Trigger gegen UPDATE, DELETE und TRUNCATE schützt.
 *
 * Sechs Entscheidungen, die §16 offenlässt.
 *
 *  1. **Jede Abfrage ist artengenau (`WHERE kind = …`).** A101 hat gemessen,
 *     was die Alternative kostet: 18 411 der 18 747 Zeilen einer Woche kamen
 *     aus *einem* Defekt. Eine Kennzahl, die über alle Arten zählt, misst
 *     Rauschen, und der Index `event_log (kind, occurred_at DESC)` ist genau
 *     für die andere Form gebaut.
 *
 *  2. **Die vier Durchsatzzahlen kommen aus *einer* Abfrage.** Nicht aus
 *     Sparsamkeit: §22 lässt einen Prüfer sie gegeneinander halten, und vier
 *     getrennte Abfragen könnten vier verschiedene Momente des Protokolls
 *     sehen. Ein `FILTER` über einen Scan sieht denselben.
 *
 *  3. **Die Gate-Läufe werden **ohne obere Schranke** gelesen.** §16.3s
 *     Zeit-bis-grün paart einen Fund im Fenster mit dem *späteren* grünen
 *     Lauf, und der liegt regelmässig hinter `to` (ein Fund vom Sonntag
 *     23:59). Die Fensterprüfung findet deshalb in `gate-runs.ts` statt, wo
 *     eine Testdatei sie ohne Datenbank fahren kann — und ein Lauf nach `to`
 *     zählt beweisbar **nicht** in die Durchlaufquote.
 *
 *  4. **Die Nutzlast wird gelesen, nicht die Zusammenfassung geglaubt.**
 *     `payload -> 'steps'` wird geholt, `payload ->> 'ok'` nicht. Begründung
 *     in `gate-runs.ts`, Entscheidung 1.
 *
 *  5. **Der Bestand offener Entscheidungen ist ein Zeitpunktwert, kein
 *     Fensterwert.** Gezählt wird jede jemals gestellte Frage, die **bis
 *     `to`** keine Antwort hat — nicht der heutige Zustand der
 *     `escalations`-Sicht. Ein Bericht über die Vorwoche, der den Bestand von
 *     heute nennt, ist am Tag nach dem Versand falsch, und niemand könnte ihn
 *     nachrechnen.
 *
 *  6. **Das Budget kommt aus `usage_samples`.** `usage.sampled` steht in
 *     `EVENT_KINDS` und hat im ganzen Repository keinen Erzeuger; der Messwert
 *     liegt nur dort. `BudgetUtilisation.source` sagt es im Ergebnis, statt
 *     dass ein Leser annimmt, auch diese Zahl käme aus dem Protokoll.
 */
import type { Queryable } from '../sql.js';
import { aggregateBudget, type BudgetGroupRow } from './budget.js';
import { findingsByGate, type GateRunRow, gatePassRate, timeToGreen } from './gate-runs.js';
import {
  type EscalationCounts,
  type HeadlineMetrics,
  type QualityTrend,
  redRate,
  type StudioMetrics,
  type Throughput,
} from './metrics.js';
import { assertWindow, type MetricsWindow, windowLabel } from './window.js';

export interface MetricsServiceDeps {
  sql: Queryable;
}

export class MetricsService {
  constructor(private readonly deps: MetricsServiceDeps) {}

  /**
   * Beide Abschnitte in einem Durchgang.
   *
   * Die Gate-Läufe werden **einmal** geholt und an beide Hälften gereicht:
   * §16.1s Durchlaufquote und §16.3s Zeit-bis-grün stehen auf denselben
   * Zeilen, und zwei Abfragen wären zwei Antworten auf dieselbe Frage — genau
   * die Klasse, die A81 durch den Posteingang gezogen hat.
   */
  async collect(window: MetricsWindow): Promise<StudioMetrics> {
    assertWindow(window);
    const runs = await this.gateRuns(window);
    const [headline, quality] = await Promise.all([
      this.headline(window, runs),
      this.quality(window, runs),
    ]);
    return { headline, quality };
  }

  /** §16.1. `runs` wird nachgeholt, wenn der Aufrufer keine mitbringt. */
  async headline(window: MetricsWindow, runs?: readonly GateRunRow[]): Promise<HeadlineMetrics> {
    assertWindow(window);
    const gateRows = runs ?? (await this.gateRuns(window));
    const [throughput, escalations, budget] = await Promise.all([
      this.throughput(window),
      this.escalations(window),
      this.budget(window),
    ]);
    return {
      window: windowLabel(window),
      throughput,
      gates: gatePassRate(gateRows, window),
      budget,
      escalations,
    };
  }

  /** §16.3. */
  async quality(window: MetricsWindow, runs?: readonly GateRunRow[]): Promise<QualityTrend> {
    assertWindow(window);
    const gateRows = runs ?? (await this.gateRuns(window));
    const red = await this.redRate(window);
    return {
      window: windowLabel(window),
      redRate: red,
      findingsByGate: findingsByGate(gateRows, window),
      timeToGreen: timeToGreen(gateRows, window),
    };
  }

  /**
   * Entscheidung 2 — vier Zahlen, ein Scan.
   *
   * `count(DISTINCT task_id)` für die erledigten Aufgaben statt `count(*)`:
   * `done` ist heute terminal (`TASK_TRANSITIONS.done = []`), beide Zahlen sind
   * also gleich — aber die Frage lautet „wie viele Aufgaben wurden fertig",
   * und die Antwort darauf darf nicht davon abhängen, dass eine Kante im
   * Zustandsdiagramm fehlt.
   */
  private async throughput(window: MetricsWindow): Promise<Throughput> {
    const [row] = await this.deps.sql<
      Array<{
        tasks_done: string | number;
        merges: string | number;
        deploys: string | number;
        rollbacks: string | number;
        failed_deploys: string | number;
      }>
    >`
      SELECT
        count(DISTINCT task_id) FILTER (
          WHERE kind = 'task.state_changed' AND payload ->> 'to' = 'done'
        )::int                                                        AS tasks_done,
        count(*) FILTER (WHERE kind = 'merge.finished')::int          AS merges,
        count(*) FILTER (WHERE kind = 'deploy.succeeded')::int        AS deploys,
        count(*) FILTER (WHERE kind = 'deploy.rolled_back')::int      AS rollbacks,
        count(*) FILTER (WHERE kind = 'deploy.failed')::int          AS failed_deploys
      FROM event_log
      WHERE kind IN ('task.state_changed', 'merge.finished', 'deploy.succeeded',
                     'deploy.rolled_back', 'deploy.failed')
        AND occurred_at >= ${window.from}
        AND occurred_at <  ${window.to}`;

    return {
      tasksDone: toNumber(row?.tasks_done),
      merges: toNumber(row?.merges),
      deploys: toNumber(row?.deploys),
      rollbacks: toNumber(row?.rollbacks),
      failedDeploys: toNumber(row?.failed_deploys),
    };
  }

  /** §16.3s Rot-Quote. Die Definition steht bei `RedRate` in `metrics.ts`. */
  private async redRate(window: MetricsWindow) {
    const [row] = await this.deps.sql<
      Array<{ tasks_red: string | number; tasks_concluded: string | number }>
    >`
      SELECT
        count(DISTINCT task_id) FILTER (WHERE payload ->> 'to' = 'red')::int AS tasks_red,
        count(DISTINCT task_id) FILTER (
          WHERE payload ->> 'to' IN ('red', 'done')
        )::int                                                               AS tasks_concluded
      FROM event_log
      WHERE kind = 'task.state_changed'
        AND occurred_at >= ${window.from}
        AND occurred_at <  ${window.to}`;

    return redRate(toNumber(row?.tasks_red), toNumber(row?.tasks_concluded));
  }

  /**
   * Entscheidung 5.
   *
   * Der Bestand wird über `payload ->> 'escalationId'` gepaart — dieselbe
   * Kennung, die beide Erzeuger in `escalation-service.ts` schreiben. Kein
   * Index darauf, und das ist vertretbar: §15s Karten sind Einzelstücke, deren
   * Zahl in Monaten dreistellig wird, und der Bericht läuft einmal die Woche.
   * Gepaart wird über die Kennung und nicht über den Fragetext, aus dem Grund,
   * den 0016 für `task_escalations` ausschreibt: eine unscharfe Paarung hier
   * hiesse, eine Antwort auf eine andere Frage zu verbuchen.
   */
  private async escalations(window: MetricsWindow): Promise<EscalationCounts> {
    const [row] = await this.deps.sql<Array<{ answered: string | number; open: string | number }>>`
      SELECT
        (
          SELECT count(*)::int FROM event_log
          WHERE kind = 'escalation.answered'
            AND occurred_at >= ${window.from}
            AND occurred_at <  ${window.to}
        ) AS answered,
        (
          SELECT count(*)::int FROM event_log raised
          WHERE raised.kind = 'escalation.raised'
            AND raised.occurred_at < ${window.to}
            AND NOT EXISTS (
              SELECT 1 FROM event_log answered
              WHERE answered.kind = 'escalation.answered'
                AND answered.occurred_at < ${window.to}
                AND answered.payload ->> 'escalationId' = raised.payload ->> 'escalationId'
            )
        ) AS open`;

    return { answered: toNumber(row?.answered), open: toNumber(row?.open) };
  }

  /**
   * Entscheidungen 3 und 4.
   *
   * `ORDER BY id` und nicht `ORDER BY occurred_at`: zwei Läufe einer schnellen
   * Suite können denselben Zeitstempel tragen, und „der spätere Lauf" wäre
   * dann keine Ordnung mehr. Dieselbe Begründung, aus der 0015 `gate_runs.seq`
   * neben `finished_at` einführt.
   */
  private async gateRuns(window: MetricsWindow): Promise<GateRunRow[]> {
    const rows = await this.deps.sql<
      Array<{ id: string; occurred_at: Date; task_id: string | null; steps: unknown }>
    >`
      SELECT id::text, occurred_at, task_id::text, payload -> 'steps' AS steps
      FROM event_log
      WHERE kind = 'gate.finished'
        AND occurred_at >= ${window.from}
      ORDER BY id`;

    return rows.map((row) => ({
      id: row.id,
      occurredAt: row.occurred_at,
      taskId: row.task_id,
      // `parseGateRun` erwartet die ganze Nutzlast; geholt wird nur der
      // Schritt-Zweig, weil die Ausgaben eines Gate-Laufs bis 16 KB je Schritt
      // gross werden und eine Wochenabfrage sie nicht braucht.
      payload: { steps: row.steps },
    }));
  }

  /** Entscheidung 6. Die Ausschlussregel steht in `budget.ts`, nicht hier. */
  private async budget(window: MetricsWindow) {
    const rows = await this.deps.sql<
      Array<{
        window_kind: string;
        model_class: string | null;
        source: string;
        anomaly_kind: string | null;
        samples: string | number;
        sum_percent: string | number | null;
        max_percent: string | number | null;
      }>
    >`
      SELECT
        window_kind,
        model_class,
        source,
        anomaly ->> 'kind'        AS anomaly_kind,
        count(*)::int             AS samples,
        sum(used_percent)::float8 AS sum_percent,
        max(used_percent)::float8 AS max_percent
      FROM usage_samples
      WHERE observed_at >= ${window.from}
        AND observed_at <  ${window.to}
      GROUP BY window_kind, model_class, source, anomaly ->> 'kind'`;

    const groups: BudgetGroupRow[] = rows.map((row) => ({
      windowKind: row.window_kind,
      modelClass: row.model_class,
      source: row.source,
      anomalyKind: row.anomaly_kind,
      samples: toNumber(row.samples),
      sumPercent: toNumber(row.sum_percent),
      maxPercent: toNumber(row.max_percent),
    }));
    return aggregateBudget(groups);
  }
}

/**
 * postgres.js gibt `int4` als Zahl und `numeric`/`int8` als Zeichenkette
 * zurück, und welcher Typ ankommt, hängt an der Besetzung des Ausdrucks.
 * `traces/reader.ts` deklariert seine Zählspalten aus demselben Grund als
 * `string | number`. Eine `NULL` wird zu 0 — sie entsteht hier nur als
 * Aggregat über null Zeilen, und dort ist 0 die Zählung und keine Schätzung.
 */
function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}
