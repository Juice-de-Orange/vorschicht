/**
 * Das Zeitfenster, über das gezählt wird — halboffen, `[from, to)`.
 *
 * Halboffen und nicht geschlossen, und das ist keine Formalie: §16s Bericht
 * läuft montags 07:00 und deckt die Vorwoche ab, also grenzen zwei Fenster
 * exakt aneinander. Mit `<= to` läge ein Ereignis, das genau auf der Grenze
 * liegt, in **beiden** Berichten — ein Merge doppelt gezählt, und die
 * Summe der Wochen wäre grösser als das Jahr. Mit `< to` liegt jedes Ereignis
 * in genau einem Fenster, und §22s Phase-8-Gate („jede Kopfzahl rechnet sich
 * unabhängig nach") ist überhaupt erst formulierbar.
 *
 * Eigene Datei, damit `gate-runs.ts` und `budget.ts` denselben Typ benutzen,
 * ohne dass einer den anderen importiert. `MetricsWindow` und nicht `Window`,
 * weil `Window` in jedem Baum mit DOM-Typen ein anderer Typ ist und ein
 * Namensgleichstand mit einem globalen Typ genau die Art Fehler erzeugt, die
 * erst der Testlauf einer fremden Konfiguration zeigt.
 */

export interface MetricsWindow {
  from: Date;
  to: Date;
}

/**
 * Ein Fenster ohne Dauer zählt nichts und sieht dabei aus wie ein ruhiger
 * Zeitraum — also wird es abgelehnt statt beantwortet. Dieselbe Richtung wie
 * überall sonst in diesem Repository: „wir konnten nicht nachsehen" und „es ist
 * nichts passiert" dürfen nicht dieselbe Antwort haben.
 */
export function assertWindow(window: MetricsWindow): void {
  const from = window.from.getTime();
  const to = window.to.getTime();
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    throw new RangeError('Zeitfenster: von und bis müssen gültige Zeitpunkte sein');
  }
  if (from >= to) {
    throw new RangeError(
      `Zeitfenster: von (${window.from.toISOString()}) muss vor bis (${window.to.toISOString()}) liegen`,
    );
  }
}

/** Liegt der Zeitpunkt im halboffenen Fenster? */
export function inWindow(at: Date, window: MetricsWindow): boolean {
  const value = at.getTime();
  return value >= window.from.getTime() && value < window.to.getTime();
}

/** Wie das Fenster im Ergebnis mitreist: ISO, damit es durch JSON überlebt. */
export function windowLabel(window: MetricsWindow): { from: string; to: string } {
  return { from: window.from.toISOString(), to: window.to.toISOString() };
}
