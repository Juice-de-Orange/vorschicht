/**
 * §7.1's "large divergence → Controlling anomaly escalation", as a §15 card.
 *
 * `UsageMeter` has raised `guardian.anomaly` since Phase 1 and offered an
 * `onAnomaly` callback that the daemon never passed — so every reading the meter
 * refused to trust landed in the event log and nowhere a human looks. §22's
 * Phase 4 step 5 names `budget_anomaly` as a producer to wire, and this is the
 * half of it that has no I/O: what the card says.
 *
 * **Not every anomaly is a decision.** `unavailable` is the *documented* state of
 * this studio under A64/A73 — the official reading is silent below the vendor's
 * 75% warning threshold — and the guardian already fails closed on it, loudly,
 * on every pass. A card each time the estimate ages out would be an inbox item a
 * minute for a condition nobody can act on, which is how a channel gets muted.
 * The three that *are* decisions have one thing in common: the meter read a
 * number it does not believe, and §7.2 acts on numbers.
 *
 * Nothing here decides anything or touches the guardian. §7.2 keeps its own
 * counsel; this only makes sure the operator hears about a budget he cannot trust before
 * the studio quietly stops.
 */
import type { UsageSample } from '@vorschicht/shared';

export interface AnomalyCard {
  question: string;
  context: string;
  urgency: 'P0' | 'P1' | 'P2' | 'P3';
  options: Array<{ title: string; pros: string[]; cons: string[]; recommended: boolean }>;
}

/** German (§2) — one line per anomaly kind, naming what was observed. */
function observed(sample: UsageSample): string | null {
  const anomaly = sample.anomaly;
  if (!anomaly) return null;
  switch (anomaly.kind) {
    case 'divergence':
      return (
        `Die amtliche Messung sagt ${anomaly.officialPercent.toFixed(1)} %, die eigene ` +
        `Schätzung ${anomaly.estimatedPercent.toFixed(1)} % — im Fenster ` +
        `\`${sample.window}\`. Zwei Zähler über dasselbe Budget, die sich widersprechen.`
      );
    case 'ambiguous_scale':
      return (
        `Die Auslastung kam als \`${anomaly.raw}\` und ließ sich nicht eindeutig als Prozent ` +
        `oder als Anteil lesen (angenommen: ${anomaly.assumed.toFixed(1)} %), Fenster ` +
        `\`${sample.window}\`. Eine um den Faktor 100 falsch gelesene Zahl setzt §7.2 ` +
        'lautlos außer Kraft.'
      );
    case 'out_of_range':
      return (
        `Die Auslastung kam als \`${anomaly.raw}\` und liegt außerhalb jedes gültigen ` +
        `Bereichs, Fenster \`${sample.window}\`.`
      );
    // The documented degraded state, not a decision. See the header.
    case 'unavailable':
      return null;
  }
}

/**
 * The inbox item for a reading the meter would not trust, or null.
 *
 * Null means "this is not something to ask the operator about", and there is exactly one
 * such case; everything else the meter flags is a number §7.2 would otherwise
 * act on.
 */
export function budgetAnomalyCard(sample: UsageSample): AnomalyCard | null {
  const detail = observed(sample);
  if (!detail) return null;

  return {
    question: `Budgetmessung im Fenster ${sample.window} ist nicht belastbar — wie weiter?`,
    context:
      `${detail} ` +
      'Der Wächter (§7.2) entscheidet anhand dieser Zahl, ob überhaupt gearbeitet werden ' +
      'darf. **Er hält deswegen nicht an:** `evaluateGuardian` schließt allein auf eine ' +
      'unlesbare Messung (`anomaly.kind === "unavailable"`), und für die stellt dieses ' +
      'Departement gar keine Frage — sie ist der dokumentierte Dauerzustand unter A64. ' +
      'Der Betrieb läuft also weiter, und was offen ist, ist die Verlässlichkeit der Zahl, ' +
      'auf die er sich stützt: `projectSamples` zieht eine frische offizielle Messung jeder ' +
      'Schätzung vor (A60.7), und ob die stimmt, ist genau die Frage hier.',
    urgency: 'P1',
    options: [
      {
        title: 'So lassen — weiter beobachten, bis die Messung wieder stimmt',
        pros: [
          'Erholt sich die Messung von selbst, ist nichts zu tun.',
          'Keine Änderung an einer Zahl, deren richtiger Wert gerade unklar ist.',
        ],
        cons: [
          'Der Betrieb läuft in der Zwischenzeit auf einer Messung, der wir gerade ' +
            'widersprechen — das ist die Richtung, die ein Limit-Ereignis kostet (§1 Grundsatz 3).',
        ],
        recommended: true,
      },
      {
        title: 'Kalibrierung nachziehen — die konfigurierte Budgetgröße anpassen',
        pros: [
          'Die häufigste echte Ursache einer Abweichung ist ein Nenner, der nicht mehr ' +
            'zur Wirklichkeit passt (A60.4, A73.6).',
        ],
        cons: [
          'Eine zu groß gesetzte Zahl ist genau der Fehler, den der Wächter verhindern soll — ' +
            'die Richtung, die Geld und Konsistenz kostet.',
        ],
        recommended: false,
      },
      {
        title: 'Als Fehlalarm abtun — den Fund verwerfen',
        pros: ['Kein Aufwand, wenn die Abweichung nachweislich ein Messfehler war.'],
        cons: [
          'Wenn sie es nicht war, misst das Studio ab jetzt an einer Zahl, der niemand mehr ' +
            'widerspricht.',
        ],
        recommended: false,
      },
    ],
  };
}
