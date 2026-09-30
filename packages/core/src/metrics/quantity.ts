/**
 * Eine Zahl, die es geben kann — oder nicht, und dann sagt sie warum.
 *
 * §22s Phase-8-Gate verlangt, dass jede Kopfzahl sich unabhängig nachrechnen
 * lässt. Das ist nur die halbe Anforderung; die andere ist, dass eine Zahl,
 * die es nicht gibt, auch nicht wie eine aussieht. „Null Rollbacks" und „wir
 * wissen es nicht" sind verschiedene Tatsachen, und eine `0` an beiden Stellen
 * ist genau die Verwechslung, die §8.2s sechste Domäne sucht: ein Signal, das
 * nicht unterscheiden kann, trägt keins.
 *
 * Deshalb trägt jede *abgeleitete* Grösse (Quoten, Mittelwerte, Laufzeiten)
 * diesen Typ statt `number`. Die reinen **Zählungen** tun es ausdrücklich
 * nicht: eine Zählung über ein leeres Fenster ist 0 und das ist wahr, keine
 * Schätzung. Eine Quote über ein leeres Fenster ist dagegen undefiniert, und
 * `0 %` dort wäre die freundliche Lüge — sie läse sich wie „keine Aufgabe war
 * rot", wo es „es gab keine Aufgabe" heisst.
 *
 * Die Gründe sind eine **geschlossene** Liste, kein Freitext. Ein Freitext
 * hier hiesse, dass der Wochenbericht (§16) den Satz ein zweites Mal
 * formuliert und die beiden auseinanderlaufen — die Klasse, die A81 einmal
 * quer durch den Posteingang gezogen hat. Die deutschen Sätze stehen deshalb
 * hier, bei der Deklaration, und der Bericht liest sie.
 */

/**
 * Warum eine Grösse fehlt. Zwei Gründe, und die Unterscheidung ist die, die
 * ein Leser wirklich braucht:
 *
 * - `no_data` — im Fenster ist nichts passiert, worüber sich rechnen liesse.
 *   Ein ruhiger Betrieb, kein Defekt.
 * - `inconclusive` — es gab Daten, aber keine, aus der sich die Zahl ergibt.
 *   Jeder Gate-Lauf endete nach A25 auf `infra`; jede Budgetmessung war der
 *   `unavailable`-Sentinel. Das ist **kein** ruhiger Betrieb, sondern ein
 *   Zeitraum, über den das Studio nichts weiss — und der Unterschied gehört
 *   auf des Betreibers Tisch, nicht in eine 0.
 *
 * Welcher der beiden gilt, ist am Zählwerk daneben ablesbar (`inconclusive`,
 * `blindSamples`, `unreadable`); der Code sagt nur, dass die Zahl fehlt.
 */
export const UNKNOWN_REASONS = ['no_data', 'inconclusive'] as const;

export type UnknownReason = (typeof UNKNOWN_REASONS)[number];

/**
 * Die deutschen Sätze (§2), eine Deklaration.
 *
 * Sie stehen hier statt im Berichtsgenerator, weil zwei unabhängige
 * Formulierungen desselben Grundes zwei Stellen wären, an denen er falsch sein
 * kann — und die zweite fällt niemandem auf.
 */
export const UNKNOWN_REASON_LABELS: Record<UnknownReason, string> = {
  no_data: 'keine Daten im Zeitfenster',
  inconclusive: 'Daten vorhanden, aber keine, aus der sich die Zahl ergibt',
};

/**
 * Genau eines von beiden ist gesetzt.
 *
 * Als zwei Felder statt als Union, weil das Ergebnis durch JSON in den Bericht
 * und ins Archiv reist und eine diskriminierte Union dort einen Diskriminator
 * bräuchte, den niemand liest. Die Invariante wird von `known`/`unknown`
 * hergestellt und von einer eigenen Zusicherung gehalten.
 */
export interface Quantity {
  value: number | null;
  unknownReason: UnknownReason | null;
}

export function known(value: number): Quantity {
  return { value, unknownReason: null };
}

export function unknown(reason: UnknownReason): Quantity {
  return { value: null, unknownReason: reason };
}

/**
 * Eine Quote, und der Aufrufer sagt, was ein leerer Nenner bedeutet.
 *
 * Der Grund ist kein Detail: bei der Gate-Durchlaufquote heisst ein leerer
 * Nenner „es lief kein Gate" (`no_data`) *oder* „jeder Lauf endete auf infra"
 * (`inconclusive`), und nur die Aufrufstelle weiss, welcher Fall vorliegt.
 * Eine Voreinstellung hier würde die Unterscheidung genau dort verschlucken,
 * wo dieses Modul sie herstellen soll.
 */
export function ratio(
  numerator: number,
  denominator: number,
  reasonWhenEmpty: UnknownReason,
): Quantity {
  if (denominator <= 0) return unknown(reasonWhenEmpty);
  return known(numerator / denominator);
}
