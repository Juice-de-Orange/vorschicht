/**
 * §17.9's settings page in plain functions — today §8's persona switch.
 *
 * Same arrangement as `./quellen-format.ts` and `./dokumente-format.ts`, and it
 * exists for the reason those do: `apps/web` has **no DOM test environment** —
 * vitest runs in `node` and the repo carries neither jsdom nor a
 * component-testing library — so a rule living inside a component is a rule only
 * Playwright can reach. Anything about this page that can be wrong without a
 * browser noticing lives here; the component renders and decides nothing.
 *
 * **The shapes are not declared here.** They are `@vorschicht/shared/personas`'s
 * and they are *parsed*, never cast (A81): `leseEinstellungen` is the only door
 * a payload comes through.
 *
 * **And §8's neutral-label rule is not re-implemented here either.**
 * `personaLabel` and `personaAlternates` are re-exported from the shared module
 * rather than wrapped, because this page and Phase 7's office view (§17.2) must
 * answer "what is this desk called" identically, and a convenience wrapper on
 * one of the two sides is how they start to differ. This module adds the *line*
 * — name, alternates and department composed into what a reader sees — which is
 * a rendering decision and belongs to the page that makes it.
 */

import {
  type BenachrichtigungenView,
  type EinstellungenSeite,
  einstellungenSeiteResponse,
  type PruefprotokollEintragView,
  SICHERUNG_ERGEBNIS_LABELS,
  type SicherungKomponenteView,
  type SicherungStatusView,
} from '@vorschicht/shared/einstellungen';
import { GATE_CATALOGUE, type GateDefinition } from '@vorschicht/shared/gates';
import {
  EINSTELLUNGEN_API,
  EINSTELLUNGEN_PFAD,
  type EinstellungenBody,
  einstellungenResponse,
  PERSONA_MODE_DESCRIPTIONS,
  PERSONA_MODE_LABELS,
  PERSONA_MODES,
  type PersonaMode,
  type PersonaRosterEntry,
  personaAlternates,
  personaLabel,
  personaNamesShown,
} from '@vorschicht/shared/personas';
import { type Gelesen, lies } from './inbox-format.js';

export type {
  BenachrichtigungenView,
  EinstellungenBody,
  EinstellungenSeite,
  PersonaMode,
  PersonaRosterEntry,
  PruefprotokollEintragView,
  SicherungStatusView,
};
export {
  EINSTELLUNGEN_API,
  EINSTELLUNGEN_PFAD,
  PERSONA_MODE_DESCRIPTIONS,
  PERSONA_MODE_LABELS,
  PERSONA_MODES,
  personaAlternates,
  personaLabel,
  personaNamesShown,
  SICHERUNG_ERGEBNIS_LABELS,
};

/** The settings payload, or a German sentence saying it was not the agreed shape. */
export function leseEinstellungen(koerper: unknown): Gelesen<EinstellungenBody> {
  return lies(einstellungenResponse, koerper, 'die Einstellungen');
}

/** §17.9s ganze Seite, oder ein deutscher Satz über ihre Form. */
export function leseEinstellungenSeite(koerper: unknown): Gelesen<{
  einstellungen: EinstellungenSeite;
}> {
  return lies(einstellungenSeiteResponse, koerper, 'die Einstellungen');
}

// --- §16s Kanäle -------------------------------------------------------------

/**
 * Was §16s E-Mail-Weg gerade kann, in einem Satz.
 *
 * `einsatzbereit` kommt vom Server und wird hier **nicht** neu hergeleitet: es
 * ist `missingMailSettings`' Antwort, also dieselbe Regel, nach der
 * `createMailer` entscheidet. Eine zweite Lesart wäre in der beruhigenden
 * Richtung falsch — die Seite meldete einen Kanal als bereit, während
 * `DisabledMailer` jede Erinnerung verschluckt (A13, §16).
 */
export function mailZustand(mail: BenachrichtigungenView['mail']): string {
  if (!mail.einsatzbereit) {
    return (
      'Nicht eingerichtet — es geht keine E-Mail raus. §16s dringende Meldungen laufen ' +
      'über ntfy, A13s Erinnerung und der Wochenbericht nicht.'
    );
  }
  const ziel = mail.empfaenger ?? 'niemand (REPORT_RECIPIENT fehlt)';
  return `Versand über ${mail.host}:${mail.port}${mail.secure ? ' (TLS)' : ' (ohne TLS)'} an ${ziel}.`;
}

/** Deutsch (§2) — ob ein Geheimnis gesetzt ist, ohne es zu zeigen (§19). */
export function gesetztText(gesetzt: boolean): string {
  return gesetzt ? 'gesetzt' : 'nicht gesetzt';
}

// --- §18s Sicherung ----------------------------------------------------------

/** Eine Komponentenzeile, wie ein Mensch sie liest. */
export function komponenteZeile(komponente: SicherungKomponenteView): string {
  return `${komponente.label}: ${SICHERUNG_ERGEBNIS_LABELS[komponente.ergebnis]}`;
}

// --- §11s Katalog ------------------------------------------------------------

/**
 * §17.9s „gate catalog defaults" — rein clientseitig.
 *
 * `GATE_CATALOGUE` ist browser-seitig importierbar (A75.5), und ein Server, der
 * diese Tabelle schickte, wäre eine zweite Deklaration derselben Liste. Was die
 * Seite hinzufügt, ist die Einteilung in die drei Klassen, die §11 macht und die
 * eine Checkbox-Seite pro Projekt nur einzeln zeigt: gesperrt, optional, und
 * die, die es noch gar nicht gibt.
 */
export interface GateKlasse {
  id: 'gesperrt' | 'optional' | 'nicht_verfuegbar';
  titel: string;
  erklaerung: string;
  gates: readonly GateDefinition[];
}

export function gateKlassen(katalog: readonly GateDefinition[] = GATE_CATALOGUE): GateKlasse[] {
  return [
    {
      id: 'gesperrt',
      titel: 'Gesperrt — laufen in jedem Projekt',
      erklaerung:
        '§11s Basis. Diese sechs sind nicht abwählbar: ein Versuch wird abgelehnt und ' +
        'landet trotzdem im Prüfprotokoll (A62.2).',
      gates: katalog.filter((gate) => gate.locked),
    },
    {
      id: 'optional',
      titel: 'Optional — je Projekt anhakbar',
      erklaerung: 'Auf der Projektseite pro Projekt zu setzen; hier steht, was es überhaupt gibt.',
      gates: katalog.filter((gate) => !gate.locked && !gate.availableFrom),
    },
    {
      id: 'nicht_verfuegbar',
      titel: 'Noch nicht verfügbar',
      erklaerung:
        'Katalogisiert und ohne Runner — der Katalog verweigert das Anhaken, statt ein ' +
        'Gate grün melden zu lassen, das nie gelaufen ist (A62.3).',
      gates: katalog.filter((gate) => !gate.locked && Boolean(gate.availableFrom)),
    },
  ];
}

// --- §19s Prüfprotokoll ------------------------------------------------------

/**
 * Eine Protokollzeile in einem Satz.
 *
 * `before`/`after` werden **nicht** hier gerendert: die Komponente gibt sie als
 * Text aus, weil §19s Zeilen aus fremden Diensten stammen und JSON in einer
 * Überschrift nicht lesbar ist. Was hier steht, ist der Kopf.
 */
export function protokollZeile(eintrag: PruefprotokollEintragView): string {
  return eintrag.subject
    ? `${eintrag.action} · ${eintrag.subject} · ${eintrag.actor}`
    : `${eintrag.action} · ${eintrag.actor}`;
}

/**
 * `before`/`after` als Text, oder null wenn es nichts gibt.
 *
 * Gedeckelt, weil eine einzelne Gate-Konfiguration die ganze Seite füllen kann
 * und §19s Protokoll dann unlesbar wird. Die Kürzung wird **gesagt** statt
 * stillschweigend vorgenommen (`docs.get`s Regel, eine Seite weiter).
 */
export const PROTOKOLL_WERT_MAX = 400;

export function protokollWert(wert: unknown): string | null {
  if (wert === null || wert === undefined) return null;
  const text = typeof wert === 'string' ? wert : JSON.stringify(wert);
  if (text === undefined) return null;
  return text.length > PROTOKOLL_WERT_MAX
    ? `${text.slice(0, PROTOKOLL_WERT_MAX)}… (gekürzt)`
    : text;
}

/**
 * One desk as a line on the page.
 *
 * Under `aus` this is the desk on its own — no name, and **no alternates**,
 * because an alternate is a name and §8's third state has none. That is the
 * whole visible substance of "personas can be fully disabled", so it is derived
 * here from the shared rule rather than from a second `mode === 'aus'` test:
 * a component that asked the question itself would be a second implementation,
 * and the one the browser proves would not be the one the office view uses.
 */
export function personaZeile(mode: PersonaMode, persona: PersonaRosterEntry): string {
  const weitere = personaAlternates(mode, persona);
  const kopf = personaLabel(mode, persona);
  return weitere.length > 0 ? `${kopf} (auch ${weitere.join(', ')})` : kopf;
}

/**
 * What the page says the switch currently costs.
 *
 * A sentence rather than a badge, because A9's claim — that personas cost
 * nothing until the last step — is the reason this switch exists at all, and a
 * reader deciding where to put it should see the claim rather than infer it.
 */
export function personaWirkung(mode: PersonaMode): string {
  return mode === 'prompt'
    ? 'Die Prompts tragen zusätzlich einen Satz über den Charakter der Rolle.'
    : 'Die Prompts sind Wort für Wort dieselben wie ohne Personas.';
}
