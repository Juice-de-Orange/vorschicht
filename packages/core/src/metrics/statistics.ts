/**
 * Perzentile für die Zeit-bis-grün (§16.3) — nach Rang, ohne Interpolation.
 *
 * Die Wahl ist keine Geschmacksfrage, sondern folgt aus §22s Phase-8-Gate
 * („every headline number reconciles with the event log via an audit script").
 * Ein interpolierter Median erzeugt bei gerader Anzahl einen Wert, den **kein
 * einziger Lauf hatte** — und ein Prüfer, der die Zahl nachrechnet, muss dann
 * nicht nur die Rohwerte, sondern auch die Interpolationsvorschrift raten. Der
 * Rangwert ist immer eine echte gemessene Dauer und in einer Zeile
 * nachvollziehbar: sortieren, abzählen.
 *
 * Vorschrift: aufsteigend sortieren, Index = ceil(p · n) − 1. Damit ist der
 * Median bei gerader Anzahl der **untere** der beiden mittleren Werte, und p90
 * ist der kleinste Wert, unter oder auf dem 90 % der Messungen liegen.
 * Ausgeschrieben, weil eine Perzentilvorschrift ohne Definition eine Zahl ist,
 * die zwei Leser verschieden nachrechnen.
 */
import { known, type Quantity, unknown } from './quantity.js';

/**
 * Der Rangwert zum Anteil `p` (0 < p ≤ 1).
 *
 * Leere Eingabe → `no_data`. Das ist der einzige Fall, in dem hier nichts
 * herauskommen kann; ein Wert ist ein Wert, auch wenn es nur einer ist.
 */
export function percentile(values: readonly number[], p: number): Quantity {
  if (values.length === 0) return unknown('no_data');
  if (!(p > 0) || p > 1) {
    throw new RangeError(`Perzentil ausserhalb (0, 1]: ${p}`);
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(p * sorted.length) - 1;
  // `ceil` liefert für p = 1 genau `length`, für sehr kleine p mindestens 1 —
  // die Klammer ist trotzdem da, weil eine Indexrechnung, die nur „eigentlich"
  // im Bereich liegt, bei der nächsten Änderung still danebengreift.
  const clamped = Math.min(Math.max(index, 0), sorted.length - 1);
  return known(sorted[clamped] as number);
}

/** Der Median als Rangwert (p = 0,5) — siehe Kopf, keine Interpolation. */
export function median(values: readonly number[]): Quantity {
  return percentile(values, 0.5);
}
