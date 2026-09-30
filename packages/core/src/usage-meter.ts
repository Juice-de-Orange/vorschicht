/**
 * Usage meter (§7.1) — the bridge between `get_usage` and the budget guardian.
 *
 * The guardian is a pure function over samples (`evaluateGuardian`). This is
 * where samples come from and where they are kept, and it carries the one rule
 * that decides whether §7.2 is real: **absence of data is never "fine"**.
 *
 * Three ways the meter can be blind, all of which must behave the same:
 *   · the endpoint answered `rate_limits_available: false`
 *   · nobody has sampled recently, because no run has been active
 *   · the reading is implausible (out of range, ambiguous scale)
 *
 * Each produces an explicit `unavailable` sample rather than silence, because
 * `evaluateGuardian` treats silence and `unavailable` identically — as wrap-up —
 * and a meter that simply returned an empty list would be indistinguishable
 * from a healthy 0%.
 */
import {
  DIVERGENCE_THRESHOLD_PERCENT,
  type GetUsageResponse,
  normaliseUtilization,
  parseUsageSnapshot,
  reconcile,
  type UsageSample,
  type UsageWindowKind,
  type UtilizationScale,
} from '@vorschicht/shared';
import type postgres from 'postgres';
import type { EventLog } from './event-log.js';

/**
 * How stale an official reading may be before the meter stops trusting it.
 *
 * Fifteen minutes is comfortably longer than the sampling interval and much
 * shorter than a five-hour window, so a genuinely idle system degrades rather
 * than coasting on an hours-old number that said 40%.
 */
export const MAX_SAMPLE_AGE_MS = 15 * 60_000;

/** ADR 0001 settled this by observation: five_hour 2, seven_day 24. */
export const CONFIGURED_SCALE: UtilizationScale = 'percent';

export interface UsageMeterDeps {
  sql: postgres.Sql;
  eventLog?: EventLog;
  scale?: UtilizationScale;
  now?: () => number;
  onAnomaly?: (sample: UsageSample) => void;
}

export class UsageMeter {
  constructor(private readonly deps: UsageMeterDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  /**
   * Turn a `get_usage` response into samples and persist them.
   *
   * Only `rate_limits` is stored, never the whole response: the payload also
   * carries `behaviors`, which is telemetry about the account's overall usage
   * patterns and unrelated to this project's budget. §18 keeps the event log
   * forever, and keeping unrelated data forever by accident is not a decision
   * anyone made.
   */
  async ingestOfficial(
    payload: GetUsageResponse,
    context: { runId?: string | null } = {},
  ): Promise<UsageSample[]> {
    const observedAt = this.now();
    const { samples, unknownKinds, rateLimitsAvailable, scaleMismatch } = parseUsageSnapshot(
      payload,
      { scale: this.deps.scale ?? CONFIGURED_SCALE, observedAt },
    );

    // A snapshot whose every window reads ≤ 1 looks like the source switched to
    // fractions. Rescaling on that suspicion would be a guess; so would taking
    // it at face value. The honest answer is that the reading cannot be
    // trusted, which is a case the guardian already handles.
    if (scaleMismatch) {
      const blind = unavailableSample('five_hour', observedAt);
      await this.persist([blind], context.runId ?? null, payload.rate_limits ?? null);
      if (
        await this.announceAnomaly('scale_mismatch', null, {
          readings: samples.map((s) => ({ window: s.window, percent: s.usedPercent })),
        })
      ) {
        this.deps.onAnomaly?.(blind);
      }
      return [blind];
    }

    if (!rateLimitsAvailable) {
      const blind = unavailableSample('five_hour', observedAt);
      await this.persist([blind], context.runId ?? null, payload.rate_limits ?? null);
      if (await this.announceAnomaly('rate_limits_unavailable', null)) {
        this.deps.onAnomaly?.(blind);
      }
      return [blind];
    }

    await this.persist(samples, context.runId ?? null, payload.rate_limits ?? null);

    for (const sample of samples) {
      // `anomaly.kind` ist hier zugleich der Protokollgrund — anders als bei
      // der Divergenz, wo die 31.138 Altzeilen `meter_divergence` tragen und
      // der Rauschfilter daran hängt.
      if (sample.anomaly) await this.reportAnomaly(sample, sample.anomaly.kind);
      else {
        await this.resolveAnomaly('ambiguous_scale', sample.window);
        await this.resolveAnomaly('out_of_range', sample.window);
      }
    }

    // Die Gegenrichtung: hier ist die Ablesung gelungen, also sind die beiden
    // Zustaende darueber vorbei, falls sie offen standen.
    await this.resolveAnomaly('rate_limits_unavailable', null);
    await this.resolveAnomaly('scale_mismatch', null);

    if (unknownKinds.length > 0) {
      // An unrecognised window is information about the vendor changing
      // something, not noise to swallow.
      await this.announceAnomaly('unknown_window_kinds', null, { kinds: unknownKinds });
    } else {
      await this.resolveAnomaly('unknown_window_kinds', null);
    }

    return samples;
  }

  /**
   * Record one window's official reading, pushed at us by `rate_limit_event`.
   *
   * Deliberately *not* a parameter on `ingestOfficial`, for three reasons that
   * each on their own would be enough (A73):
   *
   * 1. **The scale differs.** `get_usage` reports 0–100, this frame reports
   *    0–1. The scale is passed explicitly and never inferred — this file's own
   *    header says what inferring costs: a 0.97 read as "0.97 percent" retires
   *    §7.2 without anything going red.
   * 2. **Absence means different things.** A `get_usage` response with no
   *    figure means the budget could not be read, and the honest answer is the
   *    `unavailable` sentinel. A `rate_limit_event` with no figure means the
   *    account is simply below the vendor's warning threshold — which is
   *    information, but not blindness, and must never write a blind sample.
   *    One method cannot hold both meanings.
   * 3. **It is one window, not a snapshot.** There is no model-scoped cap in
   *    this frame and no set of readings to cross-check for a scale switch, so
   *    `detectScaleMismatch` has nothing to work with here.
   *
   * The sample lands as `official`, which is what makes it *win*: `projectSamples`
   * ranks a fresh official reading above a fresh estimate, so above 75% the
   * guardian stops depending on `PLAN_BUDGETS` — a configured number nobody can
   * derive — and starts acting on the vendor's own figure.
   */
  async ingestOfficialWindow(
    window: UsageWindowKind,
    rawUtilization: number,
    context: { runId?: string | null; resetsAt?: number | null; raw?: unknown } = {},
  ): Promise<UsageSample> {
    const observedAt = this.now();
    // Hard-coded, not `this.deps.scale`: that option configures the *get_usage*
    // path (CONFIGURED_SCALE = 'percent'). A single knob for both would be one
    // edit away from silently rescaling this one.
    const { usedPercent, anomaly } = normaliseUtilization(rawUtilization, 'fraction');

    const sample: UsageSample = {
      window,
      // The frame names only `five_hour` and `seven_day`; §7.1's per-model
      // weekly cap remains reachable through get_usage alone (A60).
      modelClass: null,
      usedPercent,
      resetsAt: context.resetsAt ?? null,
      source: 'official',
      anomaly,
      observedAt,
    };

    await this.persist([sample], context.runId ?? null, context.raw ?? null);
    if (sample.anomaly) await this.reportAnomaly(sample, sample.anomaly.kind);
    return sample;
  }

  /**
   * Record a token-accounting estimate (A6, demoted to fallback in v1.1).
   *
   * Kept as a cross-check even when official data flows: §7.1 wants large
   * divergence to surface as a Controlling anomaly rather than being resolved
   * silently in either direction.
   */
  async ingestEstimate(
    window: UsageWindowKind,
    usedPercent: number,
    context: {
      runId?: string | null;
      modelClass?: string | null;
      /**
       * When this window will next be below the wrap-up threshold, if known.
       *
       * The guardian's latch clears at `resetsAt`, or — absent one — a full
       * nominal window after latching (§7.2, `WINDOW_NOMINAL_MS`). For a
       * *rolling* estimate that fallback is far too pessimistic: spend recorded
       * four hours ago leaves the five-hour window in one, and resting five
       * hours over it would idle the studio for nothing while §7.2's weekly
       * policy is explicitly greedy. The estimator computes the real relief
       * time from the spend timeline and passes it here.
       */
      resetsAt?: number | null;
    } = {},
  ): Promise<UsageSample> {
    const observedAt = this.now();
    const sample: UsageSample = {
      window,
      modelClass: context.modelClass ?? null,
      usedPercent: Math.min(100, Math.max(0, usedPercent)),
      resetsAt: context.resetsAt ?? null,
      source: 'estimated',
      anomaly: null,
      observedAt,
    };

    const official = await this.latestOfficial(window, sample.modelClass);
    if (official) {
      const { anomaly } = reconcile(official.usedPercent, sample.usedPercent);
      if (anomaly) {
        sample.anomaly = anomaly;
        await this.reportAnomaly(sample, 'meter_divergence', {
          officialPercent: official.usedPercent,
          estimatedPercent: sample.usedPercent,
          thresholdPercent: DIVERGENCE_THRESHOLD_PERCENT,
        });
      } else {
        await this.resolveAnomaly('meter_divergence', window);
      }
    } else {
      // Es gibt nichts mehr zu vergleichen — also wird die gemeldete Divergenz
      // auch nicht mehr beobachtet. Sie offen stehen zu lassen hiesse, einen
      // Zustand zu behaupten, den niemand mehr prueft.
      await this.resolveAnomaly('meter_divergence', window);
    }

    await this.persist([sample], context.runId ?? null, null);
    return sample;
  }

  /**
   * The freshest sample per tracked window — what the guardian evaluates.
   *
   * A window whose newest reading is older than `maxAgeMs` is returned as
   * `unavailable` rather than omitted or passed through. This is the
   * fail-closed rule: an autonomous system that cannot currently see its budget
   * must not start new work, and it must not be able to reach that state by
   * simply having nothing to report.
   */
  async currentSamples(maxAgeMs = MAX_SAMPLE_AGE_MS): Promise<UsageSample[]> {
    // The newest of each *kind* per window, not simply the newest row.
    //
    // §7.1 is official-first with the estimate as fallback, and a plain "newest
    // wins" would invert that the moment the estimator runs on a timer: it
    // writes every tick, so it would always be newest and would always mask a
    // genuine official reading. Worse, an `unavailable` sentinel is stored as
    // `source = 'estimated'` — so a run that failed to read the budget would
    // have masked a perfectly good estimate written seconds earlier, and the
    // studio would have stayed shut on the strength of the very blindness the
    // estimator exists to cover.
    //
    // Three kinds are therefore kept apart and ranked in `projectSamples`.
    const rows = await this.deps.sql<
      Array<{
        window_kind: UsageWindowKind;
        model_class: string | null;
        used_percent: string;
        resets_at: Date | null;
        source: 'official' | 'estimated';
        anomaly: UsageSample['anomaly'];
        observed_at: Date;
      }>
    >`
      SELECT DISTINCT ON (window_kind, model_class, sample_kind)
             window_kind, model_class, used_percent, resets_at, source, anomaly, observed_at
      FROM (
        SELECT window_kind, model_class, used_percent, resets_at, source, anomaly, observed_at,
               CASE WHEN anomaly ->> 'kind' = 'unavailable' THEN 'blind' ELSE source END
                 AS sample_kind
        FROM usage_samples
      ) s
      ORDER BY window_kind, model_class, sample_kind, observed_at DESC
    `;

    return projectSamples(
      rows.map((row) => ({
        window: row.window_kind,
        modelClass: row.model_class,
        usedPercent: Number(row.used_percent),
        resetsAt: row.resets_at?.getTime() ?? null,
        source: row.source,
        anomaly: row.anomaly,
        observedAt: row.observed_at.getTime(),
      })),
      this.now(),
      maxAgeMs,
    );
  }

  /**
   * Die jüngste offizielle Messung dieses Fensters — **wenn sie dasselbe
   * Fenster meint** (A98).
   *
   * Die erste Fassung nahm die neueste offizielle Zeile ohne jede Alters- oder
   * Fenstergrenze. Seit A73 kommen offizielle Messungen nur oberhalb von 75 %,
   * also steht nach jedem Fensterwechsel eine hohe alte Zahl in der Tabelle,
   * die mit jeder frischen Schätzung verglichen wurde. Auf dem Produktionshost hat das
   * **1892 Anomalie-Zeilen in 23 Stunden** erzeugt — eine alle 44 Sekunden,
   * mit Nutzlasten wie `official 95 / estimated 0`, was schlicht heißt: das
   * Fenster ist zwischendurch zurückgesetzt worden. Ein Kanal, der im
   * Sekundentakt meldet, wird stummgeschaltet, und dann ist die nächste echte
   * Divergenz unsichtbar (A67.6). Dazu wächst ein Protokoll, das nach §18 für
   * immer bleibt, um zweitausend Zeilen am Tag.
   *
   * **A149: A98s Grenzen haben die Flut nicht gestoppt, und gemessen ist auch,
   * warum.** Vom 18. bis zum 23.8.2026 schrieb diese Stelle rund 1.330 Zeilen
   * am Tag; sie endete von selbst, als der `resets_at` der einen offiziellen
   * Wochenmessung ablief. A98 hatte den Vergleich mit einem **abgelaufenen**
   * Fenster beseitigt — geblieben war der Vergleich mit einer **veralteten
   * Messung im laufenden** Fenster, und der ist unter A73 der Regelfall: eine
   * offizielle Zahl kommt nur oberhalb der Anbieterwarnung und nur während
   * einer Sitzung, und bleibt danach tagelang die neueste ihrer Art.
   *
   * Die Ursache waren zwei Frischebegriffe in einer Datei, Faktor 672
   * auseinander: hier bis zu sieben Tage, in `projectSamples` fünfzehn Minuten.
   * Der lockerere entschied über den Lärm, der strengere über die Sicherheit.
   *
   * Jetzt eine Konstante, eine Bedeutung: **`MAX_SAMPLE_AGE_MS` regiert beide
   * Fragen.** Der Satz, der das trägt — *der Wächter handelt auf eine so alte
   * Messung nicht mehr, also darf der Zähler über sie auch keinen Alarm
   * schreiben.*
   *
   * Die Fenstergrenze bleibt daneben stehen und ist **nicht** von der
   * Altersgrenze gedeckt: eine Messung fünf Minuten vor einem Reset ist
   * vierzehn Minuten später jung genug und beschreibt trotzdem eine
   * Fensterinstanz, die es nicht mehr gibt.
   *
   * **Entfernt statt stillschweigend stehen gelassen:** A98s zweite Regel
   * („ohne `resets_at` gilt die nominelle Fensterlänge") ist von der
   * Altersgrenze vollständig verdeckt — 15 Minuten gegen 5 Stunden bzw. 7 Tage.
   * Sie war ohnehin unerreichbar, weil `headless.ts` einen Rahmen ohne
   * `resetsAt` gar nicht erst durchlässt. Ein Zweig, der nicht erreichbar ist
   * und wie Abdeckung liest, ist §8.2s sechste Domäne.
   *
   * Beide Grenzen fallen in dieselbe Richtung: im Zweifel **kein** Vergleich.
   * Eine ausgelassene Gegenprüfung kostet eine Warnung, die niemand hätte
   * deuten können; eine falsche kostet die Brauchbarkeit des Kanals.
   */
  /**
   * Melden beim **Übergang**, nie je Durchgang (A149).
   *
   * Dieselbe Regel steht in diesem Projekt viermal aufgeschrieben — A67.6 für
   * den Ops-Alarm, A86.5 für den Benachrichtigungsdurchlauf, A102 für den
   * Watchdog, A105.2 für den Transkript-Scan — und war an genau dieser Stelle
   * nicht befolgt. A83.5 hat sie für den **Karten**pfad umgesetzt
   * (`budget-anomaly.ts` gibt für `unavailable` `null` zurück); der
   * `eventLog.append`-Pfad daneben kannte sie nicht. Eine Regel, die im selben
   * `if`-Block einmal gilt und einmal nicht, ist keine.
   *
   * **Warum der Zustand aus dem Ereignisprotokoll kommt und nicht aus
   * `usage_samples`:** der naheliegende Weg wäre, die letzte Probe desselben
   * Fensters zu lesen. Er trägt nicht. `UsageEstimator.sample()` schreibt alle
   * 60 s eine gewöhnliche `five_hour`-Probe mit `modelClass: null` und
   * `source: 'estimated'` — also **dasselbe Tupel**, auf das
   * `unavailableSample` die blinde Probe legt. Die beiden wechseln sich ab, ein
   * daraus gelesener Zustand kippte im Sekundentakt hin und her, und die
   * Übergangsmeldung feuerte wieder bei jedem Durchgang. Das Protokoll ist die
   * Akte dessen, was *gemeldet* wurde, und beantwortet damit genau die Frage,
   * die hier gestellt wird.
   *
   * **Altzeilen zählen nicht als Zustandsmarke.** Am 25.8.2026 lagen 31.138
   * `guardian.anomaly`-Zeilen ohne `resolved` im Protokoll; würden sie als
   * „steht schon offen" gelesen, bliebe die erste echte Meldung nach dem
   * Rollout stumm. Nur ein ausdrückliches `resolved: false` ist eine Marke.
   */
  private async anomalyOpen(reason: string, scope: string | null): Promise<boolean> {
    const [row] = await this.deps.sql<Array<{ resolved: boolean | null }>>`
      SELECT (payload ->> 'resolved')::boolean AS resolved
      FROM event_log
      WHERE kind = 'guardian.anomaly'
        AND payload ->> 'reason' = ${reason}
        AND payload ->> 'scope' IS NOT DISTINCT FROM ${scope}
      ORDER BY occurred_at DESC
      LIMIT 1
    `;
    return row?.resolved === false;
  }

  /**
   * Der Eintritt in einen Anomaliezustand — höchstens eine Zeile je Zustand.
   */
  private async announceAnomaly(
    reason: string,
    scope: string | null,
    extra: Record<string, unknown> = {},
  ): Promise<boolean> {
    if (await this.anomalyOpen(reason, scope)) return false;
    await this.deps.eventLog?.append({
      kind: 'guardian.anomaly',
      actor: 'controlling',
      payload: { reason, scope, resolved: false, ...extra },
    });
    return true;
  }

  /**
   * Eine Probe mit Anomalie melden — an das Protokoll **und** an `onAnomaly`,
   * beide beim Übergang und beide genau einmal (A149).
   *
   * `onAnomaly` hat genau einen Verbraucher: `reportBudgetAnomaly` im Daemon,
   * der daraus §15s Karte baut. Vorher feuerte der Rückruf je Probe, also alle
   * 60 Sekunden — die Karte hing dann allein an einer Entdopplung gegen die
   * **offenen** Eskalationen, und die geht auf, sobald der Betreiber antwortet. Genau so
   * ist aus Karte #17 die #18 geworden, und aus #18 wäre #19 geworden.
   *
   * Beide Kanäle an derselben Übergangsprüfung ist die Reparatur an der
   * Wurzel: eine Episode, eine Protokollzeile, eine Karte.
   */
  private async reportAnomaly(
    sample: UsageSample,
    reason: string,
    extra: Record<string, unknown> = {},
  ) {
    if (!sample.anomaly) return;
    const neu = await this.announceAnomaly(reason, sample.window, extra);
    if (neu) this.deps.onAnomaly?.(sample);
  }

  /**
   * Das Verlassen des Zustands — ohne die Gegenrichtung ist eine
   * Übergangsmeldung eine halbe Meldung, und „Störung vorbei" wäre von „Kanal
   * stumm" nicht zu unterscheiden (A102.2).
   */
  private async resolveAnomaly(reason: string, scope: string | null): Promise<void> {
    if (!(await this.anomalyOpen(reason, scope))) return;
    await this.deps.eventLog?.append({
      kind: 'guardian.anomaly',
      actor: 'controlling',
      payload: { reason, scope, resolved: true },
    });
  }

  private async latestOfficial(
    window: UsageWindowKind,
    modelClass: string | null,
  ): Promise<UsageSample | null> {
    const [row] = await this.deps.sql<
      Array<{ used_percent: string; observed_at: Date; resets_at: Date | null }>
    >`
      SELECT used_percent, observed_at, resets_at FROM usage_samples
      WHERE window_kind = ${window}
        AND model_class IS NOT DISTINCT FROM ${modelClass}
        AND source = 'official'
      ORDER BY observed_at DESC LIMIT 1
    `;
    if (!row) return null;

    const now = this.now();
    const resetsAt = row.resets_at?.getTime() ?? null;

    // Grenze 1: zu alt zum Vergleichen — dieselbe Zahl, mit der `projectSamples`
    // eine offizielle Messung fuer den *Waechter* entwertet.
    if (now - row.observed_at.getTime() > MAX_SAMPLE_AGE_MS) return null;

    // Grenze 2: das Fenster gibt es nicht mehr. Nicht von Grenze 1 gedeckt —
    // eine Messung fuenf Minuten vor einem Reset ist vierzehn Minuten spaeter
    // jung genug und beschreibt trotzdem eine Fensterinstanz, die vorbei ist.
    if (resetsAt !== null && resetsAt <= now) return null;

    return {
      window,
      modelClass,
      usedPercent: Number(row.used_percent),
      resetsAt,
      source: 'official',
      anomaly: null,
      observedAt: row.observed_at.getTime(),
    };
  }

  private async persist(
    samples: readonly UsageSample[],
    runId: string | null,
    raw: unknown,
  ): Promise<void> {
    for (const sample of samples) {
      await this.deps.sql`
        INSERT INTO usage_samples
          (observed_at, window_kind, model_class, used_percent, resets_at, source, anomaly, run_id, raw)
        VALUES (
          ${new Date(sample.observedAt)}, ${sample.window}, ${sample.modelClass},
          ${sample.usedPercent}, ${sample.resetsAt ? new Date(sample.resetsAt) : null},
          ${sample.source},
          ${sample.anomaly ? this.deps.sql.json(sample.anomaly as postgres.JSONValue) : null},
          ${runId}, ${raw ? this.deps.sql.json(raw as postgres.JSONValue) : null}
        )
      `;
    }
  }
}

/**
 * The fail-closed projection, as a pure function.
 *
 * Separated from the query so the rule that decides whether §7.2 can ever fire
 * is exhaustively testable without a database — including the two cases that
 * are states of a table rather than of a value: nothing stored at all, and
 * something stored too long ago.
 */
export function projectSamples(
  stored: readonly UsageSample[],
  now: number,
  maxAgeMs = MAX_SAMPLE_AGE_MS,
): UsageSample[] {
  // Never an empty list. An empty list reads as "nothing to worry about",
  // which is the one thing missing budget data must never look like.
  if (stored.length === 0) return [unavailableSample('five_hour', now)];

  // One answer per window (and per model class), chosen by §7.1's order:
  // a fresh official reading, else a fresh estimate, else blind. Grouping
  // happens here rather than in SQL because the ranking *is* the policy, and
  // policy that decides whether §7.2 can fire belongs where it can be tested
  // without a database.
  const groups = new Map<string, UsageSample[]>();
  for (const sample of stored) {
    const key = `${sample.window}::${sample.modelClass ?? ''}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(sample);
    else groups.set(key, [sample]);
  }

  return [...groups.values()].map((candidates) => {
    const fresh = candidates.filter(
      (sample) => now - sample.observedAt <= maxAgeMs && sample.anomaly?.kind !== 'unavailable',
    );
    const chosen =
      pickNewest(fresh.filter((sample) => sample.source === 'official')) ??
      pickNewest(fresh.filter((sample) => sample.source === 'estimated'));
    if (chosen) return chosen;

    // Nothing usable. Report the window as blind rather than dropping it — a
    // window that vanishes from the list is a window the guardian stops
    // considering, which is exactly how a fail-closed rule turns into an open
    // gate without anyone changing it.
    const newest = pickNewest(candidates);
    const first = candidates[0];
    if (!newest || !first) return unavailableSample('five_hour', now);
    return {
      ...unavailableSample(first.window, newest.observedAt),
      modelClass: first.modelClass,
    };
  });
}

function pickNewest(samples: readonly UsageSample[]): UsageSample | null {
  let best: UsageSample | null = null;
  for (const sample of samples) {
    if (!best || sample.observedAt > best.observedAt) best = sample;
  }
  return best;
}

function unavailableSample(window: UsageWindowKind, observedAt: number): UsageSample {
  return {
    window,
    modelClass: null,
    // Not 100: that would read as "budget exhausted" in the dashboard. The
    // anomaly is what makes the guardian close the gate, and it says why.
    usedPercent: 0,
    resetsAt: null,
    source: 'estimated',
    anomaly: { kind: 'unavailable' },
    observedAt,
  };
}
