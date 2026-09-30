/**
 * §16s Wochenbericht-Archiv als Vertrag (§17, §22 Phase 8 Schritt 2).
 *
 * Die Anordnung ist die von `./quellen.ts` und `./inbox.ts`: **eine** Zusage
 * über das JSON, aus der die Route ihren Typ zieht und die die Seite **parst**
 * statt sie zu behaupten. A81 hat aufgeschrieben, was zwei unabhängige
 * Deklarationen desselben Dokuments kosten — der Server antwortete
 * `{ posteingang: … }`, die Seite las `koerper.items`, `pnpm gate` war neun von
 * neun grün, und der Posteingang zeigte eine Karte, die aus ihrem eigenen
 * Umschlag gebaut war. Ein `as` ist eine Behauptung, die niemand prüft; ein
 * `parse` macht aus einem Vertragsbruch einen deutschen Satz auf der Seite.
 *
 * Browser-sicher gebaut: dieses Modul importiert nur `zod`, und es ist über den
 * Unterpfad `@vorschicht/shared/berichte` erreichbar — der Sammelexport zieht
 * `worktree.js` und `containment.js` nach, die `node:path` brauchen (A75.5).
 *
 * **Englische Bezeichner, deutsche Werte**, die Regel aus `./dokumente.ts`.
 *
 * -----------------------------------------------------------------------------
 * DREI ENTSCHEIDUNGEN, DIE §16 UND §17 NICHT AUSSPRECHEN
 * -----------------------------------------------------------------------------
 *
 *   1. **Das Archiv zeigt den Klartext, nicht das Mail-HTML.** §16 verlangt
 *      beide Fassungen und sagt nicht, welche im Dashboard steht. Der Klartext
 *      ist dort die richtige: er ist nach §16 eine vollwertige Fassung, er
 *      trägt dieselben sechs Abschnitte, und er ist die **einzige** der beiden,
 *      die ohne `dangerouslySetInnerHTML` auf eine Seite kommt. Das HTML ist für
 *      Mailprogramme gebaut — mit Tabellen, Inline-Stilen und einem eigenen
 *      `<html>`-Dokument —, und es in die Anwendung einzuhängen hiesse, die
 *      einzige XSS-Fläche dieses Dashboards für eine Darstellung zu öffnen, die
 *      dort schlechter aussieht als der Text. `bodyHtml` bleibt deshalb
 *      serverseitig; wer die Mailfassung sehen will, sieht sie in der Mail.
 *
 *   2. **Die Liste trägt keine Kennzahlen.** `reports.metrics` liegt in der
 *      Datenbank und wäre leicht mitzuschicken, aber der Bericht *ist* die
 *      Darstellung seiner Zahlen (§16 nennt sie „headline numbers" **im**
 *      Bericht). Eine zweite Darstellung derselben Zahlen auf derselben Seite
 *      ist eine zweite Stelle, an der sie von der ersten abweichen kann — und
 *      §22s Gate G2 lässt sie ohnehin gegen das Ereignisprotokoll nachrechnen,
 *      wo eine gerenderte Zahl nichts beweist.
 *
 *   3. **Zeitpunkte reisen als ISO-Zeichenketten, und die Zeitzone bleibt eine
 *      Frage der Darstellung.** `Date` überlebt JSON nicht; ein Zeitstempel als
 *      Zahl wäre kompakter und liest sich in einem Protokoll wie eine ID. §2
 *      legt Europe/Vienna für Zeitplanung und Berichte fest — die Umrechnung
 *      gehört an die Stelle, die einem Menschen etwas hinschreibt, nicht in den
 *      Vertrag, sonst trägt jede Antwort eine Zeitzone, die der Empfänger nicht
 *      wählen kann.
 */
import { z } from 'zod';

/** Der Pfad, unter dem die Seite liegt — eine Deklaration für Verweise und Router (A81.3). */
export const BERICHTE_PATH = '/berichte';

export const BerichtUebersichtSchema = z.object({
  id: z.string(),
  /** Beginn der beschriebenen Woche, halboffen: `[periodStart, periodEnd)`. */
  periodStart: z.string(),
  periodEnd: z.string(),
  generatedAt: z.string(),
  /** Die Betreffzeile der Mail — auf Deutsch (§2), und die Überschrift der Liste. */
  subject: z.string(),
});

export const BerichteListeSchema = z.object({
  berichte: z.array(BerichtUebersichtSchema),
});

export const BerichtSchema = BerichtUebersichtSchema.extend({
  /** Entscheidung 1: der Klartext, nicht `bodyHtml`. */
  bodyText: z.string(),
});

export type BerichtUebersicht = z.infer<typeof BerichtUebersichtSchema>;
export type BerichteListe = z.infer<typeof BerichteListeSchema>;
export type Bericht = z.infer<typeof BerichtSchema>;

/**
 * Der Zeitraum eines Berichts, deutsch und ohne Uhrzeit.
 *
 * Das Ende ist **exklusiv** (0024), also nennt die Anzeige den letzten Tag, der
 * wirklich dazugehört — „1.–7. September" und nicht „1.–8.". Ein Bericht, dessen
 * Zeitraum einen Tag zu weit reicht, liest sich wie ein Fehler in den Zahlen,
 * und die Zahlen sind das einzige, wofür dieser Bericht existiert.
 */
export function zeitraumText(periodStart: string, periodEnd: string): string {
  const von = new Date(periodStart);
  const bisExklusiv = new Date(periodEnd);
  if (Number.isNaN(von.getTime()) || Number.isNaN(bisExklusiv.getTime())) {
    // Fail closed: lieber die Rohwerte zeigen als ein erfundenes Datum.
    return `${periodStart} – ${periodEnd}`;
  }
  const bis = new Date(bisExklusiv.getTime() - 24 * 60 * 60 * 1000);
  const format = new Intl.DateTimeFormat('de-AT', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Europe/Vienna',
  });
  return `${format.format(von)} – ${format.format(bis)}`;
}
