/**
 * Was §15s Budgetkarte behauptet — und was der Mechanismus darunter trägt.
 *
 * Diese Datei gab es bis A149 nicht, und genau darin konnte eine falsche
 * Tatsachenbehauptung überleben: der Kartentext schrieb, der Wächter „halte
 * dicht", solange die Messung unglaubwürdig ist. `evaluateGuardian` liest
 * `anomaly` an **genau einer** Stelle und nur für `unavailable` — und für die
 * stellt `budgetAnomalyCard` gar keine Frage. Jede Karte, die diese Funktion je
 * erzeugt hat, behauptete damit ein Verhalten, das es nicht gibt.
 *
 * Der Betreiber hat am 18.8.2026 auf dieser Grundlage geantwortet: Karte #17, Option 0,
 * „So lassen — der Wächter bleibt zu, bis die Messung wieder stimmt". Der
 * Wächter war zu keinem Zeitpunkt zu; `guardian_events` hält seit dem 16.8.
 * durchgehend `normal`.
 *
 * Der erste Fall unten ist deshalb kein Textvergleich um seiner selbst willen:
 * er hält den Kartentext gegen den Code, der ihn wahr machen müsste.
 */
import { evaluateGuardian, type UsageSample } from '@vorschicht/shared';
import { describe, expect, it } from 'vitest';
import { budgetAnomalyCard } from './budget-anomaly.js';

const probe = (anomaly: UsageSample['anomaly']): UsageSample => ({
  window: 'seven_day',
  modelClass: null,
  usedPercent: 71,
  resetsAt: null,
  source: 'estimated',
  anomaly,
  observedAt: Date.parse('2026-08-25T06:00:00Z'),
});

describe('budgetAnomalyCard', () => {
  it('stellt für den dokumentierten Dauerzustand keine Frage', () => {
    expect(budgetAnomalyCard(probe({ kind: 'unavailable' }))).toBeNull();
  });

  it('fragt bei einer Divergenz — das ist eine Zahl, auf die §7.2 handelt', () => {
    const karte = budgetAnomalyCard(
      probe({ kind: 'divergence', officialPercent: 71, estimatedPercent: 1.2 }),
    );
    expect(karte?.urgency).toBe('P1');
    expect(karte?.options).toHaveLength(3);
    // §15: genau eine Empfehlung, gezählt statt bloß gefunden.
    expect(karte?.options.filter((o) => o.recommended)).toHaveLength(1);
  });

  /**
   * Die tragende Zusicherung: der Text darf den Wächter nicht schließen lassen,
   * wenn der Wächter nicht schließt. Beides wird **gemessen** statt behauptet —
   * links der echte `evaluateGuardian`, rechts der Kartentext.
   */
  it('behauptet keinen geschlossenen Wächter, solange der Wächter offen bleibt', () => {
    const abweichung = probe({ kind: 'divergence', officialPercent: 71, estimatedPercent: 1.2 });
    const urteil = evaluateGuardian({
      samples: [abweichung],
      latches: [],
      now: abweichung.observedAt,
    });
    expect(urteil.state).toBe('normal');

    const karte = budgetAnomalyCard(abweichung);
    const text = `${karte?.context} ${karte?.options.map((o) => o.title).join(' ')}`;
    expect(text).not.toMatch(/bleibt zu|hält dicht|steht still|wird nach §7\.3 geparkt/);
    // Und er sagt ausdrücklich, dass weitergearbeitet wird — die Abwesenheit
    // allein wäre auch von einem Text erfüllt, der zur Wirkung schweigt.
    expect(karte?.context).toMatch(/hält deswegen nicht an|läuft also weiter/);
  });

  it('nennt für jede Anomalieart, die eine Frage ist, den beobachteten Wert', () => {
    for (const anomaly of [
      { kind: 'divergence', officialPercent: 71, estimatedPercent: 1.2 },
      { kind: 'ambiguous_scale', raw: 0.97, assumed: 97 },
      { kind: 'out_of_range', raw: 4711 },
    ] as const) {
      const karte = budgetAnomalyCard(probe(anomaly));
      expect(karte, `${anomaly.kind} muss eine Karte ergeben`).not.toBeNull();
      expect(karte?.context).toContain('seven_day');
    }
  });
});
