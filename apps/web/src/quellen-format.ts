/**
 * §14's source registry in plain functions (§17.7).
 *
 * Same arrangement as `./dokumente-format.ts`, and it exists for the reason that
 * one does: `apps/web` has **no DOM test environment** — vitest runs in `node`
 * and the repo carries neither jsdom nor a component-testing library — so a rule
 * living inside a component is a rule only Playwright can reach. Anything about
 * this page that can be wrong without a browser noticing therefore lives here:
 * the route and the way back out of it, the labels, how a refusal is read, what
 * a history line says, and what may be submitted for each of §14's four
 * curation acts. The component renders; it decides nothing.
 *
 * **The shapes are not declared here.** They are `@vorschicht/shared/quellen`'s
 * and they are *parsed*, never cast (A81): `leseQuellen` and `leseQuelle` are
 * the only two doors a payload comes through, deliberately in this module rather
 * than in the JSX, because a `safeParse` inside a component is a guarantee no
 * unit test can break on purpose.
 *
 * The parse helper and the timestamp formatter come from `./inbox-format.js`
 * rather than being re-declared — a second `zeitpunkt` would be a second answer
 * to "how does this dashboard write a date", and the two would drift the first
 * time one of them was improved.
 */
import {
  isSourceActAllowed,
  QUELLEN_API,
  type QuelleBody,
  type QuellenListBody,
  quellenListResponse,
  quellenListUrl,
  quelleResponse,
  SOURCE_ACT_LABELS,
  SOURCE_STATE_LABELS,
  SOURCE_STATES,
  type SourceAct,
  type SourceDetailView,
  type SourceEventView,
  type SourceState,
  type SourceView,
  TRUST_LEVELS,
  type TrustLevel,
  trustLevel,
  trustLevelCode,
} from '@vorschicht/shared/quellen';
import { type Gelesen, lies, zeitpunkt } from './inbox-format.js';

export type { SourceAct, SourceDetailView, SourceEventView, SourceState, SourceView, TrustLevel };
export {
  isSourceActAllowed,
  QUELLEN_API,
  quellenListUrl,
  SOURCE_ACT_LABELS,
  SOURCE_STATE_LABELS,
  SOURCE_STATES,
  TRUST_LEVELS,
  zeitpunkt,
};

// --- the route ---------------------------------------------------------------

/** Where the registry lives in the dashboard (§17.7). */
export const QUELLEN_PFAD = '/quellen';

/**
 * A source id is a uuid, and a segment that is not one names nothing.
 *
 * Strict for `dokumentKennung`'s reason, and it matters equally here: a loose
 * reading would hand a typo to `GET /api/quellen/:id`, where Postgres answers
 * `invalid input syntax for type uuid` and a caller's mistake surfaces as a
 * server fault. The server refuses the same strings (`isSourceId`), so the two
 * layers agree rather than merely both existing.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function quellenKennung(segment: string | null): string | null {
  return segment !== null && UUID.test(segment) ? segment : null;
}

export function quellenPfad(id: string): string {
  return `${QUELLEN_PFAD}/${encodeURIComponent(id)}`;
}

// --- reading a payload -------------------------------------------------------

/** The registry list, or a German sentence saying it was not the agreed shape. */
export function leseQuellen(koerper: unknown): Gelesen<QuellenListBody> {
  return lies(quellenListResponse, koerper, 'das Quellenregister');
}

/** One source with its history, parsed out of its envelope. */
export function leseQuelle(koerper: unknown): Gelesen<SourceDetailView> {
  const gelesen = lies(quelleResponse, koerper, 'diese Quelle');
  return gelesen.ok ? { ok: true, wert: (gelesen.wert as QuelleBody).quelle } : gelesen;
}

/**
 * Why the server refused, in German, and never an empty list.
 *
 * The body's own sentences first: every refusal the route produces already
 * carries German prose written where the rule lives, and re-wording it here
 * would be a second phrasing of the same rule that nothing keeps in step. The
 * fallbacks are for the answers that carry no body at all — a proxy's 502, a
 * gateway timeout — where saying nothing would leave a page that looks like it
 * worked.
 */
export function quellenFehler(status: number, body: unknown): string[] {
  const gemeldet = (body as { errors?: unknown } | null)?.errors;
  if (Array.isArray(gemeldet)) {
    const texte = gemeldet.filter((grund): grund is string => typeof grund === 'string');
    if (texte.length > 0) return texte;
  }
  switch (status) {
    case 401:
      return ['Die Sitzung gilt nicht mehr. Melde dich neu an.'];
    case 404:
      return ['Diese Quelle gibt es nicht (mehr).'];
    case 409:
      return [
        'Diese Seite zeigt einen älteren Stand der Quelle — lade sie neu und entscheide dann.',
      ];
    default:
      return [`Der Server hat die Kuratierung abgelehnt (Fehler ${status}), ohne einen Grund.`];
  }
}

// --- labels ------------------------------------------------------------------

/**
 * A trust level in words: the code and §14's class.
 *
 * The class travels because the code alone is a number in a costume — "L4" says
 * nothing to a reader who has not memorised §14's table, and this page is where
 * that table is being applied.
 */
export function stufenText(level: number | null): string {
  const entry = trustLevel(level);
  return entry ? `${entry.code} — ${entry.label}` : 'noch ohne Stufe';
}

export { trustLevelCode };

/**
 * §14's score for a reader (§2), or a sentence saying there is none.
 *
 * German decimal comma, two places: the fractional part is the whole content of
 * the number — the integer part *is* the level and is shown beside it anyway —
 * and rounding it away would make every source at one level look identical.
 */
export function punktzahl(score: number | null): string {
  if (score === null || !Number.isFinite(score)) {
    return 'keine Punktzahl — die Quelle ist nicht im Register';
  }
  return score.toFixed(2).replace('.', ',');
}

/**
 * One line of the history, in German (§2).
 *
 * The label is the contract's (`sourceEventLabel`), because the level belongs
 * inside the verb; what this adds is who and when. The reason is deliberately
 * **not** folded in: it is prose of arbitrary length and it is the evidence §14
 * makes a citation rest on, so the page gives it its own line rather than a
 * clause at the end of one.
 */
export function verlaufszeile(entry: SourceEventView): string {
  return `${entry.label} · ${zeitpunkt(entry.occurredAt)} · ${entry.actor}`;
}

/** The reason or note behind one history line, or null when it carries neither. */
export function verlaufsBegruendung(entry: SourceEventView): string | null {
  const text = entry.reason ?? entry.note;
  return text && text.trim() !== '' ? text : null;
}

/**
 * What §14's citation rule says about this source, in one sentence.
 *
 * Rendered from the `citable` flag the server computed rather than re-derived
 * here: that flag comes from `checkCitation`, the one function that owns §14's
 * threshold, and a second reading of it on this page would be a second answer to
 * the question a Rechtsgutachten rests on.
 */
export function zitierbarkeit(source: SourceView): string {
  return source.citable
    ? `Zitierfähig — steht auf ${trustLevelCode(source.level)} und ist aufgenommen (§14).`
    : `Nicht zitierfähig: ${SOURCE_STATE_LABELS[source.state]}, ${stufenText(source.level)}. ` +
        'Für rechtliche Aussagen verlangt §14 mindestens L4 im Register.';
}

// --- the list ----------------------------------------------------------------

/** The filter's "everything" setting, for both selects. */
export const ALLE = 'alle';

export interface Filter {
  zustand: string;
  abStufe: string;
}

export const LEERER_FILTER: Filter = { zustand: ALLE, abStufe: ALLE };

/**
 * The URL a filter asks for, built through the contract's own builder.
 *
 * `quellenListUrl` rather than a template with `?zustand=`, for the reason
 * A81.3 records: the one time this project wrote a query key in two packages,
 * each side stayed green about its own spelling.
 */
export function filterUrl(filter: Filter): string {
  const zustand = SOURCE_STATES.find((state) => state === filter.zustand) ?? null;
  const stufe = Number(filter.abStufe);
  const minLevel = TRUST_LEVELS.find((level) => level === stufe) ?? null;
  return quellenListUrl({
    ...(zustand === null ? {} : { state: zustand }),
    ...(minLevel === null ? {} : { minLevel }),
  });
}

/**
 * The sentence an empty list gets, and it names *which* emptiness.
 *
 * An unfiltered empty registry and a filter that hides everything are different
 * facts, and one wording for both is how "nothing has been proposed yet" comes
 * to read as "your filter is wrong" — the distinction `dokumente-leer` and
 * `dokumente-gefiltert-leer` already draw one page over.
 */
export function leerText(filter: Filter): string {
  return filter.zustand === ALLE && filter.abStufe === ALLE
    ? 'Im Register steht noch keine Quelle. Abteilungen schlagen Quellen vor (§14); ' +
        'der Vorschlag kommt als Entscheidung in den Posteingang.'
    : 'Keine Quelle passt zu diesem Filter. Setz ihn auf „alle", um das ganze Register zu sehen.';
}

// --- curating ----------------------------------------------------------------

export interface KuratierEingabe {
  /** The chosen level, as the `<select>` holds it. Empty when the act needs none. */
  stufe: string;
  grund: string;
}

export type KuratierPlan =
  | { ok: true; url: string; koerper: Record<string, unknown> }
  | { ok: false; fehler: string[] };

/** Does this act need a level, a reason, or both? One table, two readers. */
export const AKT_FELDER: Record<SourceAct, { stufe: boolean; grund: boolean }> = {
  accept: { stufe: true, grund: false },
  reject: { stufe: false, grund: true },
  level: { stufe: true, grund: true },
  retire: { stufe: false, grund: true },
};

/**
 * What to POST for one act, or every reason nothing is sent.
 *
 * Checked here **as well as** in the route, and the route is the boundary that
 * counts. What this adds is that a missing reason is named before a round trip,
 * in the same German the server would have answered with — and, more usefully,
 * that a form for an act which is no longer possible cannot be submitted at all:
 * `isSourceActAllowed` is the contract's table, so the page offers exactly the
 * buttons the route accepts (`quellen.ts`, decision 4).
 *
 * The reason's *content* is deliberately not judged. §14 makes it the evidence a
 * citation rests on, and a length rule beyond "not empty" would be this page
 * inventing a standard for somebody else's argument.
 */
export function kuratierPlan(
  source: SourceView,
  act: SourceAct,
  eingabe: KuratierEingabe,
): KuratierPlan {
  if (!isSourceActAllowed(source.state, act)) {
    return {
      ok: false,
      fehler: [
        `„${SOURCE_ACT_LABELS[act]}" geht bei einer Quelle nicht, die ` +
          `${SOURCE_STATE_LABELS[source.state]} ist.`,
      ],
    };
  }

  const felder = AKT_FELDER[act];
  const fehler: string[] = [];
  const koerper: Record<string, unknown> = {};

  if (felder.stufe) {
    const stufe = Number(eingabe.stufe);
    const level = TRUST_LEVELS.find((entry) => entry === stufe);
    if (level === undefined) {
      fehler.push('Wähle eine Vertrauensstufe — §14 kennt genau L1 bis L5.');
    } else {
      koerper.level = level;
    }
  }

  if (felder.grund) {
    const grund = eingabe.grund.trim();
    if (grund === '') {
      fehler.push(
        'Ohne Begründung geht das nicht — sie ist der Beleg, auf dem eine spätere ' +
          'Zitation ruht (§14).',
      );
    } else {
      koerper.reason = grund;
    }
  } else if (act === 'accept') {
    // An acceptance's reasoning is the department's assessment, which is already
    // on the record — so a note here is optional, and an empty one is left out
    // rather than sent as `""`.
    const notiz = eingabe.grund.trim();
    if (notiz !== '') koerper.note = notiz;
  }

  if (fehler.length > 0) return { ok: false, fehler };
  return { ok: true, url: QUELLEN_API.act(source.id, act), koerper };
}

/** A fresh source on top of the list, replacing the row it supersedes. */
export function ersetze(neu: SourceView, vorher: readonly SourceView[]): SourceView[] {
  return vorher.map((eintrag) => (eintrag.id === neu.id ? neu : eintrag));
}
