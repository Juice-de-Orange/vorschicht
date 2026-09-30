/**
 * The inbox in plain functions (§15, §17.5).
 *
 * Everything about these two pages that can be wrong without a browser
 * noticing lives here rather than inside the JSX: reading a payload, the
 * deep-link path and the way back out of it, §15's two sentences, what may be
 * submitted as an answer, how a rejected answer is read, and the filters over
 * the two lists. The components render; they decide nothing.
 *
 * The reason is not tidiness. `apps/web` has no DOM test environment — vitest
 * runs in `node` and the repo carries neither jsdom nor a component-testing
 * library — so a rule living inside a component is a rule only the Playwright
 * suite can reach. A pure module is the half that can be broken on purpose
 * today and watched go red.
 *
 * **The shapes are not declared here.** They are `@vorschicht/shared/inbox`'s,
 * and they used to be declared twice — once there and once here, differently —
 * which is why this page could not read a single field the API answered. What
 * this module adds is the German: the sentences, the labels, the search, and
 * the refusals. The identifiers stay German too; they are local names rather
 * than the contract.
 */
import {
  type AnswerSubmission,
  answerSubmission,
  type BlockedTaskView,
  DECISIONS_PATH,
  type DecisionView,
  type EscalationCardView,
  INBOX_PATH,
  inboxPath,
} from '@vorschicht/shared/inbox';

export type { BlockedTaskView, DecisionView, EscalationCardView };

export const POSTEINGANG_PFAD = INBOX_PATH;
export const ENTSCHEIDUNGEN_PFAD = DECISIONS_PATH;

/**
 * Where a single card lives.
 *
 * One constant knows the shape — `INBOX_PATH`, which `inboxUrl` also builds the
 * absolute notification link from — and `eskalationsNummer` reads it back, so
 * the link the overview writes, the link a push carries and the route this page
 * parses cannot drift apart. They did: the mail said `/inbox/<n>` and the router
 * answered `/posteingang`, so every notification landed on the overview.
 */
export function eskalationsPfad(nummer: number): string {
  return inboxPath(nummer);
}

/**
 * The number in `/posteingang/42`, or null when the segment is not one.
 *
 * Deliberately strict: `42abc`, `4.2`, `-1`, `0` and a padded ` 42 ` are all
 * refused rather than coerced. `Number('42abc')` is NaN but `parseInt` would
 * answer 42, and a URL somebody mistyped must show "unbekannt" instead of
 * quietly opening a neighbouring decision. Zero is refused because the
 * sequence starts at one, so a zero is always a mistake somewhere.
 */
export function eskalationsNummer(segment: string | null): number | null {
  if (segment === null || !/^\d+$/.test(segment)) return null;
  const nummer = Number(segment);
  return nummer > 0 ? nummer : null;
}

// --- reading a payload -------------------------------------------------------

/**
 * Just enough of a zod schema to parse with, without importing zod here.
 *
 * `apps/web` does not depend on zod directly and should not start to for a type
 * — the schemas arrive through `@vorschicht/shared/inbox`, which is where they
 * belong.
 */
export interface Leser<T> {
  safeParse(wert: unknown): { success: true; data: T } | { success: false };
}

export type Gelesen<T> = { ok: true; wert: T } | { ok: false; fehler: string };

/**
 * Parse a response body, or say in German that it was not the agreed shape.
 *
 * This is the whole reason the contract exists as a schema rather than as an
 * interface. `as` is an assertion nobody checks — it is precisely how
 * `{posteingang:[…]}` became a single card rendering the envelope, and how the
 * decision log spent a day stuck on "Wird geladen…" because `koerper.items` was
 * `undefined` and nothing said so. A parse turns that into a sentence on the
 * page, which is the difference between a bug that is visible and one that is
 * not.
 */
export function lies<T>(leser: Leser<T>, koerper: unknown, was: string): Gelesen<T> {
  const ergebnis = leser.safeParse(koerper);
  if (ergebnis.success) return { ok: true, wert: ergebnis.data };
  return {
    ok: false,
    fehler:
      `Die Antwort des Servers für ${was} hat nicht die vereinbarte Form. ` +
      'Das ist ein Fehler in dieser Anwendung, nicht in deiner Eingabe.',
  };
}

// --- §15's sentences ---------------------------------------------------------

/**
 * §15's sentence for a task that is waiting, verbatim.
 *
 * Lower case because it always follows the task's own name in the line, and
 * the spec quotes it that way.
 */
export function blockiertHinweis(nummer: number): string {
  return `blockiert durch Entscheidung #${nummer}`;
}

/**
 * The overview's counter (§15, §17.1), or null when there is nothing to say.
 *
 * Two sentences, and the split is honesty rather than variety. §15's wording is
 * *"N Tasks warten auf deine Entscheidung"* — a count of **tasks**. The badge
 * `open` counts **items**, and the two differ the moment an item belongs to no
 * task (a gate proposal, a budget anomaly). Printing the item count under the
 * task sentence would overstate in the one direction a counter must not.
 *
 * The task count is `blockierteAufgaben.length` and nothing else. It used to be
 * a `Set` built here while the page rendered the raw rows, so one task with two
 * open questions produced "1 Aufgabe wartet" above two `<li>`s. The server now
 * sends one row per task (`blockedTasksFrom`), and the number is the length of
 * the very array the caller maps over — agreement can rot, identity cannot.
 */
export function wartendeText(
  offeneEskalationen: number | undefined,
  blockierteAufgaben?: readonly BlockedTaskView[],
): string | null {
  if (blockierteAufgaben && blockierteAufgaben.length > 0) {
    return blockierteAufgaben.length === 1
      ? '1 Aufgabe wartet auf deine Entscheidung'
      : `${blockierteAufgaben.length} Aufgaben warten auf deine Entscheidung`;
  }
  if (typeof offeneEskalationen !== 'number' || !Number.isFinite(offeneEskalationen)) return null;
  if (offeneEskalationen <= 0) return null;
  return offeneEskalationen === 1
    ? '1 Entscheidung wartet auf dich'
    : `${offeneEskalationen} Entscheidungen warten auf dich`;
}

// --- answering ---------------------------------------------------------------

/** What the answer form holds. `optionIndex` is null until one is picked. */
export interface AntwortEingabe {
  optionIndex: number | null;
  freitext: string;
}

export type AntwortErgebnis =
  | { ok: true; nutzlast: AnswerSubmission }
  | { ok: false; fehler: string[] };

/**
 * What to send, or why nothing is sent.
 *
 * The endpoint takes an option **or** free text, so a form holding both has to
 * be refused here. The alternative — send the option and drop the text — is the
 * one outcome that must not happen: the operator's own words are the part of an answer
 * that no option can reproduce, and losing them silently would undo the rule
 * A78 states for the other end of the round trip, where his sentence travels
 * into the session verbatim.
 *
 * The result is validated through `answerSubmission`, the same schema the
 * service's own input is built from — so this function cannot construct a body
 * the server will reject for a reason this page did not anticipate.
 */
export function antwortNutzlast(eingabe: AntwortEingabe): AntwortErgebnis {
  const freitext = eingabe.freitext.trim();
  const option = eingabe.optionIndex;
  if (option !== null && freitext !== '') {
    return {
      ok: false,
      fehler: [
        'Entweder eine Option oder eine freie Antwort — beides zusammen nimmt der Server ' +
          'nicht an, und deine Worte gingen dabei verloren.',
      ],
    };
  }
  const roh = option !== null ? { optionIndex: option } : { freeText: freitext };
  const geprueft = answerSubmission.safeParse(roh);
  if (!geprueft.success) {
    return {
      ok: false,
      fehler: ['Wähle eine Option oder schreib eine Antwort — leer lässt sich nichts weitergeben.'],
    };
  }
  return { ok: true, nutzlast: geprueft.data };
}

/**
 * Why the server refused, in German, and never an empty list.
 *
 * An empty error list renders as nothing, which on a page whose only other
 * feedback is "Gespeichert" reads as success. So a 422 with an unusable body
 * says that it gave no reason rather than saying nothing at all.
 */
export function antwortFehler(status: number, body: unknown): string[] {
  if (status === 409) {
    return [
      'Diese Frage ist inzwischen beantwortet — die Karte zeigt jetzt, was entschieden wurde.',
    ];
  }
  if (status === 422) {
    const gruende = (body as { errors?: unknown } | null)?.errors;
    if (Array.isArray(gruende)) {
      const texte = gruende.filter((grund): grund is string => typeof grund === 'string');
      if (texte.length > 0) return texte;
    }
    return ['Die Antwort wurde abgelehnt, ohne einen Grund zu nennen.'];
  }
  return [`Serverfehler ${status}`];
}

/**
 * The answered card a 409 carries, if it carried one.
 *
 * `answerEscalation` sends it deliberately — "so the page can show what the
 * answer *was* instead of asking for it in a second request" — and the page
 * used to throw it away and print a fixed sentence, which is a field with a
 * stated purpose and no reader.
 */
export function konfliktKarte(
  leser: Leser<EscalationCardView>,
  body: unknown,
): EscalationCardView | null {
  const roh = (body as { eskalation?: unknown } | null)?.eskalation;
  if (roh === undefined) return null;
  const gelesen = leser.safeParse(roh);
  return gelesen.success ? gelesen.data : null;
}

// --- filters -----------------------------------------------------------------

/**
 * Does this decision match the search box? (§17.5 — "decision log with search".)
 *
 * Every whitespace-separated term must match, not any of them: a log is
 * searched to *narrow* it, and an OR turns the second word into a widening —
 * type two words and get more rows than with one.
 *
 * The number is searchable both as `42` and as `#42`, because that is how it
 * is written everywhere else in this system.
 */
export function passtZurSuche(eintrag: DecisionView, suche: string): boolean {
  const begriffe = suche.toLowerCase().split(/\s+/).filter(Boolean);
  if (begriffe.length === 0) return true;
  const heuhaufen = [
    `#${eintrag.number}`,
    eintrag.question,
    eintrag.summary,
    eintrag.sourceLabel,
    eintrag.taskId ?? '',
    eintrag.projectId ?? '',
  ]
    .join(' ')
    .toLowerCase();
  return begriffe.every((begriff) => heuhaufen.includes(begriff));
}

/** The urgency filter's "everything" setting (§22 Phase 4 step 2). */
export const ALLE_DRINGLICHKEITEN = 'alle';

/**
 * Does this card pass the urgency filter?
 *
 * A filter and not a re-sort. The server already orders the inbox P0 first and
 * oldest first inside a priority (`EscalationService.open`), and a second
 * ordering rule in the page would be a second answer to "what should the operator look at
 * next" that nothing keeps in step with the first.
 */
export function passtZurDringlichkeit(karte: EscalationCardView, filter: string): boolean {
  return filter === ALLE_DRINGLICHKEITEN || karte.urgency === filter;
}

/**
 * P0–P3 in words (§8, §9).
 *
 * An unknown value is shown as it arrived rather than mapped to a default: a
 * priority the dashboard does not know is a mismatch between two halves of this
 * system, and printing "normal" for it would hide exactly that.
 */
const DRINGLICHKEIT: Record<string, string> = {
  P0: 'P0 — sofort',
  P1: 'P1 — dringend',
  P2: 'P2 — normal',
  P3: 'P3 — wenn Zeit ist',
};

export function dringlichkeitLabel(wert: string): string {
  return DRINGLICHKEIT[wert] ?? wert;
}

/**
 * A timestamp for a human, or the raw value when it cannot be read.
 *
 * `new Date('irgendwas').toLocaleString()` is the string "Invalid Date", which
 * looks like a bug in the clock rather than in the payload. Handing the
 * original back says which of the two it is.
 */
export function zeitpunkt(iso: string): string {
  const zeit = Date.parse(iso);
  return Number.isNaN(zeit) ? iso : new Date(zeit).toLocaleString('de-AT');
}
