/**
 * Der Ausgang, den ein Prüfungsfund nicht hatte (§8.2, A149).
 *
 * `AuditService` kennt vier Zustandswechsel für einen Fund — `confirm`,
 * `dismiss`, `resolve`, `waive` —, alle vier sind gebaut und getestet, und
 * **keiner hatte in Produktivcode einen Aufrufer**: keine Route, kein
 * Ablaufplaner, keine Dev-Kette. Am 25.8.2026 standen deshalb 20 Funde auf
 * `open`, darunter drei `defect`, manche seit dem 2. August.
 *
 * Was daran hängt, ist nicht Ordnung, sondern zwei Zusicherungen:
 *
 *   * §8.2s Regel „eine Ablehnung wird **genau einmal** wieder aufgemacht" ist
 *     als `count(*) FILTER (WHERE kind = 'dismissed')` gebaut und konnte nie
 *     feuern, weil ihr die Eingabe fehlte.
 *   * §16.5s Wochenbericht liest `audit.confirmed` und meldete dauerhaft „Kein
 *     bestätigter Fund" über zwanzig offenen — eine Zahl, die stimmt und das
 *     Gegenteil dessen sagt, was sie zu sagen scheint.
 *
 * Und die Abnahmebedingung aus the operator's checklist („je Phase eine
 * Betriebsprüfung ohne offenen `defect`") war damit nicht schwer, sondern
 * **strukturell unerreichbar**.
 *
 * ## Vier Entscheidungen
 *
 *  1. **Abgeleitet aus Belegen, nicht aus einem Beschluss.** A69 hat für §11s
 *     Gate-Funde entschieden, dass nichts einen Fund „auflöst", weil jemand
 *     eine Methode ruft — aufgelöst wird er durch einen *späteren grünen Lauf*.
 *     Dieselbe Haltung hier: ein Fund gilt als behoben, wenn die Aufgabe, die
 *     seine Folge angelegt hat, wirklich `done` ist. `fix_task_id` steht seit
 *     `0018` in der Sicht und wurde von nichts gelesen.
 *
 *  2. **Nur `resolve`, nicht `confirm`.** „Die Dev-Kette hat den Fund
 *     angenommen" ist ein *Urteil* und braucht eine Sitzung, die den Fund gegen
 *     den Code liest; das ist eine eigene Rolle und nicht die Nebenwirkung
 *     eines fertigen Tickets. Was dieser Durchlauf feststellt, ist die
 *     mechanische Hälfte: die Arbeit ist getan. Wer mehr behauptet, behauptet
 *     mehr als der Beleg trägt (A76.4).
 *
 *  3. **Er kann nicht werfen.** Er läuft im selben Tick wie der Ablaufplaner,
 *     und das Aufräumen einer Buchführung ist die unwichtigste Aufgabe des
 *     Studios: eine unbehandelte Ausnahme hier hielte den Merge-Betrieb an.
 *     Dieselbe Begründung wie in `report-pass.ts` und `notifications-pass.ts`.
 *
 *  4. **Er meldet je Fund genau einmal**, weil `resolve` den Zustand ändert und
 *     die Abfrage nur `open` liest. Es braucht also kein Gedächtnis daneben —
 *     der Zustandswechsel *ist* das Gedächtnis (A102s Trennung, hier gratis).
 *
 * ## Die Grenze, und sie ist heute die ganze Wirkung
 *
 * Solange Vorschichts eigenes Projekt nach A85 auf `read_only` steht,
 * überspringt der Ablaufplaner seine Aufgaben — die 13 Fix-Aufgaben der offenen
 * Funde stehen `queued` (9) und `parked` (4), **keine einzige `done`**. Dieser
 * Durchlauf schliesst deshalb heute **nichts**; er ist der Mechanismus, der ab
 * dem Klon greift. Der Rückstand von heute kann nur über `waive` fallen, also
 * durch des Betreibers ausdrückliche Hinnahme — und dafür fehlt noch der Kartenweg.
 * Beides ist im Bauplan benannt statt hier stillschweigend erledigt.
 */
import type { AuditService } from '@vorschicht/core';
import type postgres from 'postgres';

export interface AuditFindingsPassDeps {
  sql: postgres.Sql;
  audits: AuditService;
  logger?: { info: (msg: string) => void; warn: (msg: string) => void };
}

export interface AuditFindingsPassReport {
  /** Funde, deren Fix-Aufgabe fertig ist und die dadurch geschlossen wurden. */
  aufgeloest: string[];
  /** Was schiefging — der Durchlauf läuft weiter, meldet es aber. */
  problem: string | null;
}

export async function runAuditFindingsPass(
  deps: AuditFindingsPassDeps,
): Promise<AuditFindingsPassReport> {
  const aufgeloest: string[] = [];
  try {
    const faellig = await deps.sql<Array<{ id: string; fix_task_id: string }>>`
      SELECT f.id::text, f.fix_task_id
      FROM audit_findings f
      JOIN tasks t ON t.id::text = f.fix_task_id
      WHERE f.status = 'open'
        AND f.fix_task_id IS NOT NULL
        AND t.state = 'done'
    `;

    for (const zeile of faellig) {
      await deps.audits.resolve(zeile.id, 'orchestrator', zeile.fix_task_id);
      aufgeloest.push(zeile.id);
    }

    if (aufgeloest.length > 0) {
      deps.logger?.info(
        `${aufgeloest.length} Prüfungsfund(e) geschlossen — die zugehörige Fix-Aufgabe ist fertig.`,
      );
    }
    return { aufgeloest, problem: null };
  } catch (error) {
    const problem = (error as Error).message;
    deps.logger?.warn(`Prüfungsfunde konnten nicht nachgeführt werden: ${problem}`);
    return { aufgeloest, problem };
  }
}
