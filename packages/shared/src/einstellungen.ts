/**
 * §17.9s Einstellungsseite, ganz — die Leitung zwischen `/api/einstellungen`
 * und der Seite.
 *
 * §17.9 nennt sechs Dinge: „personas, notifications, plan profile, gate catalog
 * defaults, backup status, audit log". Gebaut war der erste. Dieses Modul trägt
 * die vier, die über die Leitung gehen; die Gate-Katalog-Voreinstellungen
 * brauchen sie nicht, weil `GATE_CATALOGUE` browser-seitig importierbar ist
 * (A75.5) und ein Server, der sie schickte, eine zweite Deklaration derselben
 * Tabelle wäre.
 *
 * **Der Persona-Teil wird wiederverwendet, nicht nachgebaut.** `personaSettingsView`
 * liegt in `./personas.js` und wird hier eingebettet: `PUT /api/einstellungen/personas`
 * antwortet weiterhin mit **genau diesem** Ausschnitt, und die Seite fügt ihn in
 * ihren Zustand ein. Zwei Deklarationen eines Dokuments ist der Defekt, gegen den
 * `./inbox.js` gebaut wurde (A81) — hier also die Einbettung statt einer Kopie.
 *
 * Vier Entscheidungen.
 *
 *  1. **Benachrichtigungen sind lesbar und nicht änderbar, und die Seite sagt
 *     warum.** §16s Kanäle kommen aus der Umgebung (`.env` auf dem Host,
 *     root-only nach §19) und werden beim Start gelesen; ein Formular hier wäre
 *     eine zweite Wahrheit über einen Wert, den der Prozess bereits geladen hat.
 *     Der Nutzen ist trotzdem konkret: heute kann niemand nachsehen, an welche
 *     ntfy-Themen ein Alarm eigentlich geht — und A86 hat gezeigt, was ein Kanal
 *     kostet, den niemand prüfen kann.
 *
 *  2. **Kein Geheimnis reist mit, nur ob eines gesetzt ist.** `ntfyToken` und
 *     `smtpPassword` stehen in `SECRET_KEYS`, und §19 hält sie aus jedem
 *     Transport heraus. „Gesetzt: ja/nein" beantwortet die Frage, die ein
 *     Betreiber wirklich hat („warum kommt keine Mail an"), ohne den Wert zu
 *     bewegen. Strukturell statt gefiltert: es gibt kein Feld dafür.
 *
 *  3. **Der Sicherungsstatus trägt dieselbe Kachel wie die Übersicht.**
 *     `healthTileView` wird eingebettet, damit „ist die Sicherung in Ordnung"
 *     auf beiden Seiten **eine** Ableitung ist; die Einstellungsseite legt nur
 *     die Einzelheiten daneben, die auf eine Kachel nicht passen. Zwei
 *     Ableitungen stimmen so lange überein, bis jemand eine ändert (A81).
 *
 *  4. **Das Prüfprotokoll sagt seine Grenze mit.** §19 hebt `audit_log` für
 *     immer auf, die Seite zeigt die jüngsten N — und eine gedeckelte Liste, die
 *     das nicht sagt, liest sich als vollständige Antwort. Dieselbe Regel wie
 *     `spurenListeAntwort.truncated` und `mergeQueueView.total`.
 *
 * Browser-sicher wie die Geschwister und aus demselben Grund: der Barrel
 * re-exportiert `worktree.js` und `containment.js`, die `node:path` laden
 * (A75.5). Nur `zod` und die Blattmodule daneben dürfen hier importiert werden.
 */
import { z } from 'zod';
import { betriebSchema } from './controlling.js';
import { healthTileView } from './inbox.js';
import { personaSettingsView } from './personas.js';

// --- §16s Kanäle -------------------------------------------------------------

/**
 * Wohin ntfy meldet (§16).
 *
 * Die drei Themen einzeln, weil A86 genau hier einen Defekt hatte: der
 * `Notifier` wurde ohne `topics` gebaut, also waren die drei
 * `NTFY_TOPIC_*`-Variablen wirkungslos und §16s „die Themen sind
 * konfigurierbar" war Dokumentation. Eine Seite, die sie zeigt, macht so etwas
 * nachprüfbar, ohne dass jemand den Container betreten muss.
 */
export const ntfyEinstellungView = z.object({
  server: z.string(),
  themen: z.object({ inbox: z.string(), alerts: z.string(), info: z.string() }),
  /** Nur ob — §19 lässt den Wert nicht über diese Leitung (Entscheidung 2). */
  tokenGesetzt: z.boolean(),
});
export type NtfyEinstellungView = z.infer<typeof ntfyEinstellungView>;

/**
 * §16s E-Mail-Weg: A13s Erinnerung, die Tageszusammenfassung, der Wochenbericht.
 *
 * Jedes Feld darf fehlen, und das ist kein Schlamperei-Zugeständnis: `createMailer`
 * baut aus einem unvollständigen Satz bewusst *keinen* Mailer, weil die
 * dringenden Meldungen über ntfy laufen. Die Seite muss deshalb „nicht
 * eingerichtet" zeigen können, ohne dass es wie ein Fehler aussieht.
 */
export const mailEinstellungView = z.object({
  host: z.string().nullable(),
  port: z.number().int().nullable(),
  secure: z.boolean(),
  absender: z.string().nullable(),
  empfaenger: z.string().nullable(),
  /** Nur ob (Entscheidung 2). */
  passwortGesetzt: z.boolean(),
  /** Ob dieser Satz vollständig genug ist, dass überhaupt eine Mail rausgeht. */
  einsatzbereit: z.boolean(),
});
export type MailEinstellungView = z.infer<typeof mailEinstellungView>;

export const benachrichtigungenView = z.object({
  ntfy: ntfyEinstellungView,
  mail: mailEinstellungView,
  /**
   * §16/A13: keine Ruhezeiten, 24/7. Eine **Tatsache** und keine Einstellung —
   * sie reist mit, damit die Seite sie sagen kann, statt dass ein Leser das
   * Fehlen eines Schalters als „noch nicht gebaut" liest.
   */
  ruhezeiten: z.literal(false),
});
export type BenachrichtigungenView = z.infer<typeof benachrichtigungenView>;

// --- §18s Sicherung ----------------------------------------------------------

export const SICHERUNG_ERGEBNISSE = ['ok', 'failed', 'skipped', 'unbekannt'] as const;
export type SicherungErgebnis = (typeof SICHERUNG_ERGEBNISSE)[number];

/** Deutsch (§2) — was in der Zeile einer Komponente steht. */
export const SICHERUNG_ERGEBNIS_LABELS: Record<SicherungErgebnis, string> = {
  ok: 'gelaufen',
  failed: 'fehlgeschlagen',
  // `backup-run.sh` startet jede Komponente auf `skipped`; ein Abbruch lässt
  // die noch nicht erreichten so stehen. Eine echte Antwort, keine fehlende.
  skipped: 'nicht erreicht',
  // Der Erzeuger hat diese Komponente gar nicht genannt — eine Abweichung
  // zwischen den beiden Hälften des Dokuments, und die darf nicht als „in
  // Ordnung" lesbar sein (`backup-pass.ts`, dieselbe Unterscheidung).
  unbekannt: 'nicht gemeldet',
};

export const sicherungKomponenteView = z.object({
  id: z.string(),
  /** Deutsch (§2). */
  label: z.string(),
  ergebnis: z.enum(SICHERUNG_ERGEBNISSE),
});
export type SicherungKomponenteView = z.infer<typeof sicherungKomponenteView>;

/**
 * §18s Sicherungsstand, wie §17.9 ihn verlangt — und warum er dort steht.
 *
 * A103: die Transkript-Sicherung schrieb vier Nächte lang 130 Byte und niemand
 * hat es bemerkt. Die Übersicht bekommt dafür eine Kachel; diese Seite bekommt
 * die Einzelheiten, weil die Frage „welche Komponente genau" auf eine Kachel
 * nicht passt und der Ausfall ein *partieller* war.
 */
export const sicherungStatusView = z.object({
  /** Dieselbe Ableitung wie auf der Übersicht (Entscheidung 3). */
  kachel: healthTileView,
  /** Der Zeitstempel, nach dem die Artefakte der Nacht benannt sind. */
  stand: z.string().nullable(),
  komponenten: z.array(sicherungKomponenteView),
  problem: z.string().nullable(),
  /** ISO 8601 — wann die Meldung ins Protokoll kam. */
  gemeldetAm: z.string().nullable(),
});
export type SicherungStatusView = z.infer<typeof sicherungStatusView>;

// --- §19s Prüfprotokoll ------------------------------------------------------

/**
 * Eine Zeile aus `audit_log` (§19, Migration 0001).
 *
 * `before`/`after` reisen **ganz**, wie `spurEreignis.payload`: §19 macht diese
 * Tabelle zum „wer hat was geändert"-Nachweis, und eine Projektion würde hier
 * entscheiden, welche Tatsachen ein Prüfer sehen darf. Sie werden von unseren
 * eigenen Diensten geschrieben und tragen kein Zugangsdatum (§19 hält
 * Geheimnisse aus Konfiguration und Ereignissen heraus); die Seite rendert
 * jeden Wert als **Text**, nie als Markup.
 */
export const pruefprotokollEintragView = z.object({
  id: z.number().int(),
  occurredAt: z.string(),
  actor: z.string(),
  action: z.string(),
  subject: z.string().nullable(),
  before: z.unknown(),
  after: z.unknown(),
});
export type PruefprotokollEintragView = z.infer<typeof pruefprotokollEintragView>;

export const pruefprotokollView = z.object({
  eintraege: z.array(pruefprotokollEintragView),
  /** Wie viele Zeilen höchstens kommen — die Seite sagt es (Entscheidung 4). */
  limit: z.number().int().positive(),
});
export type PruefprotokollView = z.infer<typeof pruefprotokollView>;

/** Wie viele Zeilen des Prüfprotokolls die Seite zeigt. §19 hebt alle auf. */
export const PRUEFPROTOKOLL_LIMIT = 50;

// --- die ganze Seite ---------------------------------------------------------

export const einstellungenSeite = z.object({
  personas: personaSettingsView,
  /**
   * Was der **Daemon** wirklich fährt (A7), aus derselben Konstante gelesen wie
   * dort. `@vorschicht/shared/controlling` deklariert die Form, weil §17.8 sie
   * ebenfalls zeigt — eine zweite Deklaration wäre eine Zahl, die auf zwei
   * Seiten verschieden sein kann, und der Betreiber hätte keinen Grund, an ihr zu zweifeln.
   */
  betrieb: betriebSchema,
  benachrichtigungen: benachrichtigungenView,
  sicherung: sicherungStatusView,
  pruefprotokoll: pruefprotokollView,
});
export type EinstellungenSeite = z.infer<typeof einstellungenSeite>;

/** Deutscher Umschlagsschlüssel, englische Felder — die Hausregel (A81.2). */
export const einstellungenSeiteResponse = z.object({ einstellungen: einstellungenSeite });
export type EinstellungenSeiteResponse = z.infer<typeof einstellungenSeiteResponse>;
