/**
 * §16.1s Budget-Auslastung: Mittel und Spitze je Fenster, dazu die Woche.
 *
 * Vier Festlegungen, und die erste ist die, ohne die diese Zahl gefährlich
 * wäre.
 *
 *  1. **Der `unavailable`-Sentinel ist keine Messung und wird nicht gemittelt.**
 *     `usage-meter.ts` schreibt ihn mit `usedPercent: 0`, und der Kommentar
 *     dort sagt warum: „Not 100: that would read as 'budget exhausted' in the
 *     dashboard." Für den Wächter ist das richtig — die Anomalie schliesst das
 *     Tor, nicht die Zahl. Für einen **Mittelwert** ist es der schlimmste
 *     denkbare Wert: eine Woche, in der das Budget gar nicht lesbar war, käme
 *     als „0 % ausgelastet" in des Betreibers Bericht, also als ruhigste Woche des
 *     Jahres. Blinde Zeilen werden deshalb gezählt und ausgeschlossen, und wenn
 *     es *nur* blinde gab, ist der Mittelwert `null` mit `inconclusive`.
 *     Andere Anomalien (`out_of_range`, `ambiguous_scale`, `divergence`) sind
 *     echte Messungen mit einem Vorbehalt und zählen mit — sie tragen einen
 *     Wert, der aus einer Antwort des Anbieters stammt.
 *
 *  2. **Die Quelle ist `usage_samples`, nicht `event_log`, und das steht im
 *     Ergebnis.** Die Ereignisart `usage.sampled` existiert in `EVENT_KINDS`
 *     und hat im ganzen Repository **keinen Erzeuger**; der Messwert liegt
 *     ausschliesslich in `usage_samples` (§5s eigene Entität, append-only,
 *     §7.1s Zähler). Das Feld `source` sagt es, statt dass ein späterer Leser
 *     annimmt, auch diese Zahl käme aus dem Ereignisprotokoll.
 *
 *  3. **Zusammengefasst wird nach Fensterart *und* Modellklasse.** §7.1 führt
 *     `five_hour`, `seven_day` und `seven_day_model`, und die letzte hat je
 *     Modellklasse eine eigene Decke. Eine Mittelung über die Klassen hinweg
 *     wäre der Durchschnitt zweier Prozentzahlen mit verschiedenen Nennern,
 *     also eine Zahl ohne Einheit.
 *
 *  4. **Der Mittelwert wird aus Summe und Anzahl gebildet, nicht aus
 *     Gruppen-Mittelwerten.** Die Abfrage gruppiert feiner (nach Quelle und
 *     Anomalie), damit die Ausschlussregel aus Punkt 1 **hier** steht und
 *     prüfbar ist statt in SQL. Ein Mittel aus Mitteln wäre ungewichtet und
 *     damit falsch, sobald eine Gruppe mehr Zeilen hat als die andere — was
 *     der Normalfall ist, weil die Schätzung häufiger misst als die offizielle
 *     Ablesung antwortet (A73: die kommt erst oberhalb von 75 %).
 */
import { known, type Quantity, type UnknownReason, unknown } from './quantity.js';

/** Der Sentinel aus `usage-meter.ts`. Eine Zeile, die keine Messung ist. */
export const BLIND_ANOMALY_KIND = 'unavailable';

/** §7.1s Wochenfenster. `weeklyUtilisation` liest es; sonst niemand. */
export const WEEKLY_WINDOW_KIND = 'seven_day';

/**
 * Eine Gruppe, so wie die Abfrage sie liefert: eine Zeile je
 * (Fensterart, Modellklasse, Quelle, Anomalieart).
 */
export interface BudgetGroupRow {
  windowKind: string;
  modelClass: string | null;
  source: string;
  anomalyKind: string | null;
  samples: number;
  sumPercent: number;
  maxPercent: number;
}

export interface BudgetWindowUtilisation {
  windowKind: string;
  modelClass: string | null;
  /** Gewertete Messungen (ohne Sentinel). */
  samples: number;
  /** Zeilen, die den Sentinel trugen — gezählt, nie gemittelt (Punkt 1). */
  blindSamples: number;
  average: Quantity;
  peak: Quantity;
  /** §7.1s Herkunft, weil sie die Belastbarkeit der Zahl bestimmt (A73). */
  bySource: { official: number; estimated: number };
}

export interface BudgetUtilisation {
  /** Punkt 2: nicht aus dem Ereignisprotokoll, und das gehört ins Ergebnis. */
  source: 'usage_samples';
  windows: BudgetWindowUtilisation[];
  /** Gesetzt, wenn gar keine gewertete Messung im Fenster lag. */
  unknownReason: UnknownReason | null;
}

interface Bucket {
  windowKind: string;
  modelClass: string | null;
  samples: number;
  blindSamples: number;
  sum: number;
  peak: number | null;
  official: number;
  estimated: number;
}

export function aggregateBudget(rows: readonly BudgetGroupRow[]): BudgetUtilisation {
  const buckets = new Map<string, Bucket>();

  for (const row of rows) {
    // `JSON.stringify` statt einer zusammengeklebten Zeichenkette: eine
    // Modellklasse, die ein Trennzeichen oder das Wort "null" enthält, würde
    // sonst mit einer anderen Gruppe verschmelzen — und zwei zu einer
    // verschmolzene Fensterarten ergäben ein Mittel über zwei Nenner.
    const key = JSON.stringify([row.windowKind, row.modelClass]);
    const bucket: Bucket = buckets.get(key) ?? {
      windowKind: row.windowKind,
      modelClass: row.modelClass,
      samples: 0,
      blindSamples: 0,
      sum: 0,
      peak: null,
      official: 0,
      estimated: 0,
    };

    if (row.anomalyKind === BLIND_ANOMALY_KIND) {
      bucket.blindSamples += row.samples;
    } else {
      bucket.samples += row.samples;
      bucket.sum += row.sumPercent;
      bucket.peak = bucket.peak === null ? row.maxPercent : Math.max(bucket.peak, row.maxPercent);
      if (row.source === 'official') bucket.official += row.samples;
      else if (row.source === 'estimated') bucket.estimated += row.samples;
    }

    buckets.set(key, bucket);
  }

  const windows: BudgetWindowUtilisation[] = [...buckets.values()]
    .map((bucket) => ({
      windowKind: bucket.windowKind,
      modelClass: bucket.modelClass,
      samples: bucket.samples,
      blindSamples: bucket.blindSamples,
      average:
        bucket.samples > 0
          ? known(bucket.sum / bucket.samples)
          : unknown(bucket.blindSamples > 0 ? 'inconclusive' : 'no_data'),
      peak:
        bucket.peak === null
          ? unknown(bucket.blindSamples > 0 ? 'inconclusive' : 'no_data')
          : known(bucket.peak),
      bySource: { official: bucket.official, estimated: bucket.estimated },
    }))
    .sort(
      (a, b) =>
        a.windowKind.localeCompare(b.windowKind) ||
        (a.modelClass ?? '').localeCompare(b.modelClass ?? ''),
    );

  const counted = windows.reduce((total, entry) => total + entry.samples, 0);
  const blind = windows.reduce((total, entry) => total + entry.blindSamples, 0);

  return {
    source: 'usage_samples',
    windows,
    unknownReason: counted > 0 ? null : blind > 0 ? 'inconclusive' : 'no_data',
  };
}

/**
 * „dazu die Woche" (§16.1) — die klassenlose `seven_day`-Zeile.
 *
 * Ein benannter Leser statt eines zweiten Feldes im Ergebnis: dieselben Zahlen
 * an zwei Stellen sind zwei Stellen, an denen sie auseinanderlaufen können
 * (A81). `modelClass === null`, weil die per-Modell-Decken nach A60 eine eigene
 * Zeile je Klasse haben und keine davon „die Woche" ist.
 */
export function weeklyUtilisation(budget: BudgetUtilisation): BudgetWindowUtilisation | null {
  return (
    budget.windows.find(
      (entry) => entry.windowKind === WEEKLY_WINDOW_KIND && entry.modelClass === null,
    ) ?? null
  );
}
