/**
 * Die Form, in der §16s Abschnitte 1 und 3 aus dem Ereignisprotokoll
 * herauskommen — und die eine Quote, die noch keine eigene Datei braucht.
 *
 * Was hier **nicht** steht, ist so entschieden wie das, was hier steht:
 *
 *  - **Kein Projektfilter.** §16.1 sind Kopfzahlen des ganzen Studios und
 *    §16.3 ist sein Qualitätstrend; §16.2 („per project: max 3 bullets") ist
 *    eine andere Frage mit einer anderen Abfrage und gehört zu dem, der sie
 *    baut. Ein Parameter, den heute niemand setzt, wäre die tote Verdrahtung
 *    aus §8.2s sechster Domäne — er läse sich wie eine Fähigkeit und wäre von
 *    nichts geprüft.
 *
 *  - **Zählungen sind `number`, abgeleitete Grössen sind `Quantity`.** Die
 *    Begründung steht in `quantity.ts`: eine Zählung über ein leeres Fenster
 *    ist 0 und wahr, eine Quote über ein leeres Fenster ist undefiniert und
 *    `0 %` wäre die freundliche Lüge.
 */

import type { BudgetUtilisation } from './budget.js';
import type { GateFindingCount, GatePassRate, TimeToGreen } from './gate-runs.js';
import { type Quantity, ratio } from './quantity.js';

/**
 * §16.1s Durchsatz.
 *
 * Drei Klassen, und die dritte ist die, die es beim Bau dieses Moduls noch
 * nicht gab: `deploys` sind die **erfolgreichen** Rollouts
 * (`deploy.succeeded`), `rollbacks` die zurückgerollten
 * (`deploy.rolled_back`), `failed` die, die scheiterten und **nicht**
 * zurückgerollt werden konnten (`deploy.failed`).
 *
 * Die dritte war aus dem Ereignisprotokoll nicht zählbar: `DeployService` hatte
 * genau zwei `eventLog.append`, und A93s Fehlerpfad schrieb eine
 * `deployment_events`-Zeile und eine Eskalation, aber keine Protokollzeile.
 * Dieses Modul konnte die Grösse deshalb nicht herleiten und hat es **gesagt,
 * statt sie zu schätzen** — woraufhin die Zeile gebaut wurde. Der Bericht hätte
 * sonst „3 Deploys, 0 Rollbacks" gemeldet, während eine Produktion die kaputte
 * Version bediente: eine Zahl, die stimmt und trotzdem falsch ist.
 *
 * Getrennt gezählt und nicht zu den Rollbacks geschlagen, aus A93.4s Grund:
 * ein Rollout, der nicht zurückgerollt werden konnte, ist kein Rollback, und
 * eine gemeinsame Zahl beantwortete „wie oft haben wir zurückgerollt" mit
 * etwas anderem.
 */
export interface Throughput {
  /** Verschiedene Aufgaben, die im Fenster `done` erreicht haben. */
  tasksDone: number;
  merges: number;
  deploys: number;
  rollbacks: number;
  /** Rollouts, die scheiterten und **nicht** zurückgerollt werden konnten. */
  failedDeploys: number;
}

/**
 * §16.1s letzte Kopfzahl: beantwortete und offene Entscheidungen.
 *
 * `answered` zählt Antworten **im** Fenster, `open` den Bestand **am Ende** des
 * Fensters — zwei verschiedene Fragen, und §16 stellt beide. Ein Bestand ist
 * kein Vorgang: eine Karte vom Vormonat, die der Betreiber nie beantwortet hat, gehört
 * in jeden Wochenbericht, bis sie beantwortet ist. §15 hält die Claims einer
 * offenen Entscheidung unbegrenzt, also ist diese Zahl die einzige, die den
 * Preis dafür sichtbar macht.
 */
export interface EscalationCounts {
  answered: number;
  open: number;
}

export interface HeadlineMetrics {
  window: { from: string; to: string };
  throughput: Throughput;
  gates: GatePassRate;
  budget: BudgetUtilisation;
  escalations: EscalationCounts;
}

/**
 * §16.3s Rot-Quote — je **Aufgabe**, nicht je Durchgang.
 *
 * Zähler: verschiedene Aufgaben, die im Fenster mindestens einmal `red`
 * betreten haben. Nenner: verschiedene Aufgaben, die im Fenster `red` **oder**
 * `done` betreten haben. Drei Festlegungen dazu, weil §16 nur „red-task rate"
 * sagt:
 *
 *  - **Je Aufgabe und nicht je Zustandswechsel**, weil §16 „red-**task** rate"
 *    schreibt. Eine Aufgabe, die zweimal rot wurde und dann fertig, ist eine
 *    schwierige Aufgabe und nicht zwei.
 *  - **`aborted` steht nicht im Nenner.** Ein Abbruch ist eine Rücknahme, kein
 *    Ergebnis der Arbeit — und stünde er drin, liesse sich die Rot-Quote durch
 *    Abbrechen senken. Eine Kennzahl, die man durch Aufgeben verbessert, misst
 *    das Falsche.
 *  - **`escalated` braucht keinen eigenen Term.** §9 erreicht diesen Zustand
 *    nur über `red`, die Aufgabe ist also bereits im Zähler *und* im Nenner.
 *
 * Beide Zahlen reisen mit, damit die Quote nachrechenbar ist, ohne die
 * Definition zu kennen — §22s Phase-8-Gate verlangt genau das.
 */
export interface RedRate {
  tasksRed: number;
  tasksConcluded: number;
  rate: Quantity;
}

export interface QualityTrend {
  window: { from: string; to: string };
  redRate: RedRate;
  findingsByGate: GateFindingCount[];
  timeToGreen: TimeToGreen;
}

export interface StudioMetrics {
  headline: HeadlineMetrics;
  quality: QualityTrend;
}

/**
 * Die Quote aus den beiden gezählten Mengen.
 *
 * Leerer Nenner ist `no_data` und nicht 0: „keine Aufgabe war rot" und „es gab
 * keine Aufgabe" sind verschiedene Wochen, und eine 0 sagt die erste, wo die
 * zweite gilt.
 */
export function redRate(tasksRed: number, tasksConcluded: number): RedRate {
  return {
    tasksRed,
    tasksConcluded,
    rate: ratio(tasksRed, tasksConcluded, 'no_data'),
  };
}
