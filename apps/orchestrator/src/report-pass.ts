/**
 * §16s Wochenbericht: der Durchlauf, der ihn fällig macht, erzeugt und archiviert.
 *
 * ## Warum hier und nicht in `periodic-pass.ts`
 *
 * Der Taktgeber dort ist **intervallbasiert** und verlangt von jedem Auftrag,
 * dass er auf *jedem* Lauf eine Ereigniszeile schreibt — sonst hat er keine
 * Frist und feuert für immer (dessen Entscheidung 3). Für „Montag 07:00
 * Europe/Vienna" passt das nicht:
 *
 *  * Mit `intervalMs` von sechs Stunden träfe der Bericht den Termin auf sechs
 *    Stunden genau, also irgendwann zwischen 07:00 und 13:00. §16 nennt eine
 *    Uhrzeit, keine Zeitspanne.
 *  * Mit einer Stunde wären es 24 Merkzeilen am Tag, also ~8 700 im Jahr, in
 *    einem Protokoll, das §18 für immer aufhebt. A101 hat gemessen, was solche
 *    Zeilen kosten: 18 411 von 18 747 Zeilen einer Woche stammten aus *einem*
 *    Defekt, und danach findet niemand mehr die eine, die etwas sagt.
 *
 * Also derselbe Bau wie A86s Benachrichtigungs-Beobachter: eine indizierte
 * Abfrage je Tick, und das Gedächtnis ist der **Bericht selbst** statt einer
 * Merkzeile. `report.generated` ist die einzige Zeile, die dieser Durchlauf
 * schreibt, und `evaluateReportSchedule` beantwortet den Rest aus ihr.
 *
 * ## Drei Entscheidungen
 *
 *  1. **Die Uhr kommt von aussen.** `GuardianService`, `UsageMeter` und
 *     `EscalationMailService` halten es genauso, und `report-schedule.ts` ist
 *     rein gebaut, damit ein Test es auf einen bekannten Zeitpunkt festnageln
 *     kann. Ein Durchlauf mit eigener Uhr nähme das wieder weg.
 *
 *  2. **Das Fenster ist die Woche *vor* dem fälligen Termin**, halboffen. Es
 *     wird aus `dueSlot` abgeleitet und nicht aus `now`: ein Bericht, der
 *     Dienstag nachgeholt wird, beschreibt trotzdem die Woche, für die er
 *     fällig war — sonst enthielte er zwei Tage doppelt und der nächste
 *     verlöre sie. `slotAtOrBefore(dueSlot - 1)` ist der vorige Termin, und
 *     die Rechnung steht in `report-schedule.ts` statt hier ein zweites Mal.
 *
 *  3. **Ein Bericht, der schon existiert, ist kein Fehler.** `ReportRecords`
 *     hält §16s Idempotenz über `UNIQUE (period_start)` (A77.8s Aufteilung:
 *     der Dienst ist die freundliche Hälfte, der Index die, um die niemand
 *     herumkommt). Fährt dieser Durchlauf gegen eine Woche, die bereits
 *     archiviert ist, meldet er das und schreibt nichts — das passiert, wenn
 *     die Zeile in `event_log` fehlt, der Archiveintrag aber da ist.
 *
 * ## Was er ausdrücklich **nicht** tut
 *
 * **Er verschickt nichts.** §16s Zustellung hängt an SMTP, und auf dem Produktionshost
 * steht kein `SMTP_HOST`; ein Durchlauf, der eine Mail baut und stillschweigend
 * verwirft, sähe von aussen aus wie einer, der zugestellt hat. Der Bericht
 * entsteht, wird archiviert und ist über die Oberfläche lesbar; die Zustellung
 * ist eine eigene Naht und ein eigenes Gate.
 */

import type { Mailer } from '@vorschicht/core';
import {
  type EventLog,
  evaluateReportSchedule,
  type Queryable,
  ReportRecords,
  slotAtOrBefore,
  type WeeklyReportGenerator,
} from '@vorschicht/core';
import type { MetricsWindow } from '@vorschicht/core/metrics';

export interface ReportPassDeps {
  sql: Queryable;
  eventLog: EventLog;
  generator: WeeklyReportGenerator;
  /** Injiziert, nie `Date.now()` im Modul — siehe Entscheidung 1. */
  now: () => number;
  logger: {
    info(obj: unknown, message?: string): void;
    warn(obj: unknown, message?: string): void;
  };
  /**
   * §16s Zustellung (A150) — optional, und das ist die Aussage.
   *
   * Ohne Mailer oder ohne Empfänger wird der Bericht **erzeugt und
   * archiviert**, und der Protokolleintrag sagt, dass er nicht zugestellt
   * wurde. Ein Durchlauf, der still eine Mail baut und verwirft, sähe von
   * aussen aus wie einer, der zugestellt hat — das war der Grund, warum diese
   * Naht bis heute offen blieb, und er gilt weiter für den *unkonfigurierten*
   * Fall.
   */
  mailer?: Mailer | undefined;
  /** `REPORT_RECIPIENT`. Ohne ihn gibt es niemanden, an den zuzustellen wäre. */
  recipient?: string | undefined;
}

export interface ReportPassResult {
  /** `null`, solange nichts fällig war — der Normalfall an sechs von sieben Tagen. */
  generated: { id: string; subject: string; periodStart: string; periodEnd: string } | null;
  /** Deutsch, für das Protokoll. */
  note: string | null;
  /**
   * Wurde zugestellt? `null` heisst „gar nicht versucht" — kein Mailer, kein
   * Empfänger, oder nichts war fällig. Drei Zustände statt eines Booleans,
   * weil „nicht versucht" und „versucht und gescheitert" verschiedene Dinge
   * sind (A25s Haltung, eine Naht weiter).
   */
  delivered: boolean | null;
}

/**
 * Der Zeitpunkt des letzten Berichts, aus dem Ereignisprotokoll.
 *
 * Artengenau (`recentOfKind`) und nicht über `recent()`: A118 hat gemessen, was
 * die andere Form kostet — ein Auftrag, der sein Gedächtnis in den letzten N
 * Zeilen *aller* Arten sucht, verliert es genau dann, wenn das Studio
 * beschäftigt ist, und ein verlorenes Gedächtnis liest sich hier als „noch nie
 * gelaufen".
 */
async function lastReportAt(eventLog: EventLog): Promise<number | null> {
  const [zeile] = await eventLog.recentOfKind('report.generated', 1);
  if (!zeile) return null;
  const t = new Date(zeile.occurredAt).getTime();
  return Number.isNaN(t) ? null : t;
}

export async function runReportPass(deps: ReportPassDeps): Promise<ReportPassResult> {
  const leer: ReportPassResult = { generated: null, note: null, delivered: null };

  let entscheidung: ReturnType<typeof evaluateReportSchedule>;
  try {
    entscheidung = evaluateReportSchedule({
      now: deps.now(),
      lastReportAt: await lastReportAt(deps.eventLog),
    });
  } catch (fehler) {
    // Ein unlesbares Protokoll ist kein Grund, den Tick zu beenden — der
    // Wochenbericht ist die unwichtigste Aufgabe des Studios, und dieser
    // Durchlauf hängt im selben Tick wie der Ablaufplaner.
    deps.logger.warn(
      { err: fehler },
      'Wochenbericht: konnte die Fälligkeit nicht bestimmen — übersprungen.',
    );
    return leer;
  }

  if (!entscheidung.due || entscheidung.dueSlot === null) return leer;

  // Entscheidung 2: die Woche *vor* dem fälligen Termin, halboffen.
  const window: MetricsWindow = {
    from: new Date(slotAtOrBefore(entscheidung.dueSlot - 1)),
    to: new Date(entscheidung.dueSlot),
  };

  try {
    const eingabe = await deps.generator.generate(window);
    const records = new ReportRecords(deps.sql);
    const bericht = await records.record(eingabe);

    await deps.eventLog.append({
      kind: 'report.generated',
      actor: 'orchestrator',
      payload: {
        reportId: bericht.id,
        subject: bericht.subject,
        periodStart: window.from.toISOString(),
        periodEnd: window.to.toISOString(),
        chars: eingabe.bodyText.length,
      },
    });

    // §16s Zustellung (A150). **Nach** dem Archivieren und nach
    // `report.generated`, und das ist die Reihenfolge, auf die es ankommt: das
    // Gedächtnis des Zeitplans ist `report.generated`, also darf ein
    // gescheiterter Versand den Bericht nicht ein zweites Mal erzeugen lassen.
    // Er ist dann archiviert, lesbar unter `/berichte`, und nicht zugestellt —
    // was das Protokoll sagt statt es zu verschweigen.
    const zustellung = await deliver(deps, bericht.id, eingabe);

    const note =
      `Wochenbericht für ${window.from.toISOString().slice(0, 10)} ` +
      `bis ${window.to.toISOString().slice(0, 10)} erzeugt und archiviert ` +
      `(${eingabe.bodyText.length} Zeichen). ${zustellung.note}`;
    deps.logger.info({ report: bericht.id }, note);
    return {
      generated: {
        id: bericht.id,
        subject: bericht.subject,
        periodStart: window.from.toISOString(),
        periodEnd: window.to.toISOString(),
      },
      note,
      delivered: zustellung.delivered,
    };
  } catch (fehler) {
    // Entscheidung 3: eine Woche, die schon archiviert ist, ist kein Fehler.
    // Der Fall tritt ein, wenn der Archiveintrag existiert und die Zeile in
    // `event_log` fehlt — dann sagt der Zeitplan „fällig" und der Index sagt
    // „gibt es schon". Beides ist richtig; gemeldet wird es trotzdem, weil ein
    // Studio, in dem die beiden dauerhaft auseinanderlaufen, ein Problem hat,
    // das niemand sieht.
    const meldung = fehler instanceof Error ? fehler.message : String(fehler);
    if (/period|bereits|duplicate|23505/i.test(meldung)) {
      const note = `Wochenbericht für dieses Fenster liegt bereits im Archiv — nichts geschrieben.`;
      deps.logger.warn({ err: fehler }, note);
      return { generated: null, note, delivered: null };
    }
    deps.logger.warn({ err: fehler }, 'Wochenbericht: Erzeugung fehlgeschlagen.');
    return leer;
  }
}

/**
 * Zustellen, und zwar so, dass jeder Ausgang unterscheidbar bleibt.
 *
 * Vier Fälle, und keiner davon darf wie ein anderer aussehen:
 *
 *   * **nicht konfiguriert** — kein Mailer, kein Empfänger, oder der Mailer
 *     sagt selbst `enabled === false`. Das ist der Normalzustand einer frischen
 *     Anlage und **kein Defekt**; das Protokoll sagt es trotzdem, weil „es kommt
 *     keine Mail" sonst von einer Störung nicht zu unterscheiden wäre.
 *   * **zugestellt** — eine `report.sent`-Zeile, und nur dann.
 *   * **abgewiesen** — der Server hat nein gesagt. Gemeldet, nicht geworfen.
 *   * **geworfen** — Netz weg, Socket tot. Ebenfalls gefangen: der Bericht ist
 *     archiviert, und ein Tick, der daran stirbt, kostet den Merge-Betrieb.
 *
 * Es gibt bewusst **keinen Retry**. Der nächste Termin ist eine Woche später,
 * und ein Bericht, der eine Woche zu spät ankommt, ist kein Bericht mehr — was
 * fehlt, ist die Konfiguration, und die kommt des Betreibers. Statt zu wiederholen
 * sagt der Durchlauf beim nächsten Mal wieder, was ihm fehlt.
 */
async function deliver(
  deps: ReportPassDeps,
  reportId: string,
  inhalt: { subject: string; bodyText: string; bodyHtml: string },
): Promise<{ delivered: boolean | null; note: string }> {
  const { mailer, recipient } = deps;
  if (!mailer?.enabled || !recipient) {
    return {
      delivered: null,
      note: 'Nicht zugestellt — SMTP ist nicht vollständig konfiguriert (SMTP_HOST/SMTP_FROM/REPORT_RECIPIENT).',
    };
  }

  try {
    const ergebnis = await mailer.send({
      to: recipient,
      subject: inhalt.subject,
      text: inhalt.bodyText,
      html: inhalt.bodyHtml,
    });
    if (!ergebnis.ok) {
      return { delivered: false, note: `Zustellung fehlgeschlagen: ${ergebnis.error}` };
    }
    await deps.eventLog.append({
      kind: 'report.sent',
      actor: 'orchestrator',
      payload: { reportId, to: recipient },
    });
    return { delivered: true, note: `Zugestellt an ${recipient}.` };
  } catch (fehler) {
    const meldung = fehler instanceof Error ? fehler.message : String(fehler);
    deps.logger.warn({ err: fehler }, 'Wochenbericht: Zustellung ist gescheitert.');
    return { delivered: false, note: `Zustellung fehlgeschlagen: ${meldung}` };
  }
}
