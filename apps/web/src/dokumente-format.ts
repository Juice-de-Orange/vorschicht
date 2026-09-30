/**
 * §13's document vault in plain functions (§17.6).
 *
 * Same arrangement as `./inbox-format.ts`, and it exists for the reason that
 * one does: `apps/web` has **no DOM test environment** — vitest runs in `node`
 * and the repo carries neither jsdom nor a component-testing library — so a
 * rule living inside a component is a rule only Playwright can reach. Anything
 * about this page that can be wrong without a browser noticing therefore lives
 * here: the route and the way back out of it, the labels, what may be uploaded,
 * how a refusal is read, what "searchable" means for a version, and the filter
 * over the list. The component renders; it decides nothing.
 *
 * **The shapes are not declared here.** They are `@vorschicht/shared/dokumente`'s
 * and they are *parsed*, never cast (A81): `leseSuche` and `leseDokument` are
 * the only two doors a payload comes through, deliberately in this module
 * rather than in the JSX, because a `safeParse` inside a component is a
 * guarantee no unit test can break on purpose.
 *
 * Two things are imported from `./inbox-format.js` rather than re-declared: the
 * parse helper and the timestamp formatter. A second `zeitpunkt` would be a
 * second answer to "how does this dashboard write a date", and the two would
 * drift the first time one of them was improved.
 */
import {
  DOKUMENTE_API,
  type DocumentDetailView,
  type DocumentSearchBody,
  type DocumentVersionView,
  type DocumentView,
  documentResponse,
  documentSearchResponse,
  germanMetaIssues,
  MAX_UPLOAD_BYTES,
  mediaType,
  SEARCH_QUERY,
  uploadMetaSchema,
  uploadUrl,
  VAULT_MIME_LABELS,
  VAULT_MIME_TYPES,
} from '@vorschicht/shared/dokumente';
import { type Gelesen, lies, zeitpunkt } from './inbox-format.js';

export type { DocumentDetailView, DocumentSearchBody, DocumentVersionView, DocumentView };
export { zeitpunkt };

// --- the route ---------------------------------------------------------------

/** Where the vault lives in the dashboard (§17.6). */
export const DOKUMENTE_PFAD = '/dokumente';

/**
 * A document id is a uuid, and a segment that is not one names nothing.
 *
 * Strict for `eskalationsNummer`'s reason, and it matters more here: a loose
 * reading would hand a typo to `GET /api/dokumente/:id`, where Postgres answers
 * `invalid input syntax for type uuid` and a caller's mistake surfaces as a
 * server fault. The server refuses the same strings (`isDocumentId`), so the two
 * layers agree rather than merely both existing.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function dokumentKennung(segment: string | null): string | null {
  return segment !== null && UUID.test(segment) ? segment : null;
}

export function dokumentPfad(id: string): string {
  return `${DOKUMENTE_PFAD}/${encodeURIComponent(id)}`;
}

/**
 * The search URL, built from the contract's own query keys.
 *
 * `SEARCH_QUERY` rather than the literal `q`, for the reason A81.3 records: the
 * one time this project wrote a path in two packages, every deep link in every
 * notification landed on the wrong page and each side's tests were green about
 * its own spelling.
 *
 * No `abteilung` is sent. §13 boosts the *asking department's* documents, and
 * the person at this dashboard is not a department — inventing one here would
 * re-rank his results on a fact nobody stated. Departments reach the same search
 * through `docs.search`, where the role really is known (A110.1). What this page
 * offers instead is a filter over what is shown, which narrows without claiming
 * to know who is asking.
 */
export function sucheUrl(begriff: string): string {
  const params = new URLSearchParams({ [SEARCH_QUERY.query]: begriff.trim() });
  return `${DOKUMENTE_API.search}?${params.toString()}`;
}

export { DOKUMENTE_API, uploadUrl };

// --- reading a payload -------------------------------------------------------

/**
 * A search answer, or a German sentence saying it was not the agreed shape.
 *
 * The parse lives here rather than in the component on purpose: replacing it
 * with a cast is the mutation this module exists to make observable, and inside
 * the JSX no unit test could see it (see the header).
 */
export function leseSuche(koerper: unknown): Gelesen<DocumentSearchBody> {
  return lies(documentSearchResponse, koerper, 'die Dokumentensuche');
}

/** One document with its version history, parsed out of its envelope. */
export function leseDokument(koerper: unknown): Gelesen<DocumentDetailView> {
  const gelesen = lies(documentResponse, koerper, 'dieses Dokument');
  return gelesen.ok ? { ok: true, wert: gelesen.wert.dokument } : gelesen;
}

// --- labels ------------------------------------------------------------------

/**
 * A media type in words, or the raw value when the vault has no word for it.
 *
 * Unknown is shown as it arrived rather than mapped to a default, which is
 * `dringlichkeitLabel`'s rule and the same reasoning: a type this dashboard does
 * not know is a disagreement between two halves of this system, and printing
 * "Datei" over it would hide exactly that.
 */
export function dateitypLabel(mime: string | null): string {
  if (!mime) return 'unbekannter Typ';
  const normalisiert = mediaType(mime);
  if (!normalisiert) return mime;
  const label = (VAULT_MIME_LABELS as Record<string, string | undefined>)[normalisiert];
  return label ?? normalisiert;
}

/** Every accepted type in words, for a refusal and for the file picker. */
export const ERLAUBTE_TYPEN = VAULT_MIME_TYPES.map((mime) => VAULT_MIME_LABELS[mime]).join(', ');

/** What the file picker offers — the contract's list, never a second one. */
export const DATEI_FILTER = VAULT_MIME_TYPES.join(',');

export const MAX_UPLOAD_MB = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024));

/**
 * A byte count for a human (§2), or "unbekannt".
 *
 * German decimal comma, and never rounded to "0 kB" for something that is
 * really 400 bytes — `formatDuration` in `Projekte.tsx` makes the same call for
 * the same reason: a size that reads as zero looks like a failed upload.
 */
export function groesse(bytes: number | null): string {
  if (bytes === null || !Number.isFinite(bytes) || bytes < 0) return 'unbekannt';
  if (bytes < 1024) return `${bytes} Byte`;
  const kilo = bytes / 1024;
  if (kilo < 1024) return `${zahl(kilo)} kB`;
  return `${zahl(kilo / 1024)} MB`;
}

function zahl(wert: number): string {
  return wert.toFixed(1).replace('.', ',');
}

// --- what "searchable" means (§13) -------------------------------------------

export type Durchsuchbarkeit =
  | { art: 'lesbar'; zeichen: number; text: string }
  | { art: 'leer'; text: string }
  | { art: 'ausstehend'; text: string };

/**
 * Whether this version's text is in §13's index, and what to say when it is not.
 *
 * The contract keeps a distinction the data layer is careful about and the page
 * has to keep too: `null` means nobody has read the file yet, `0` means a parser
 * ran and there was nothing. Collapsing them would turn "no extractor for this
 * type" and "a scan with no text layer" into one sentence, and only the second
 * is a property of the document.
 *
 * **Every sentence here describes the state, never a plan.** A PDF is stored,
 * listed and counted today and no text was taken out of it; saying so is the
 * difference between a document that is silently unfindable and one that says
 * why. When an extractor for it arrives the value stops being `null` and this
 * wording needs no edit — which is the point of talking about what happened
 * rather than about what will.
 */
export function durchsuchbarkeit(version: {
  extractedChars: number | null;
  mimeType: string | null;
}): Durchsuchbarkeit {
  if (version.extractedChars === null) {
    return {
      art: 'ausstehend',
      text:
        `noch nicht durchsuchbar — aus dieser Datei (${dateitypLabel(version.mimeType)}) ` +
        'wurde kein Text ausgelesen, sie ist abgelegt, aber über die Suche nicht auffindbar',
    };
  }
  if (version.extractedChars === 0) {
    return {
      art: 'leer',
      text: 'gelesen, aber ohne Text — die Datei enthält keine Textschicht',
    };
  }
  return {
    art: 'lesbar',
    zeichen: version.extractedChars,
    text: `durchsuchbar (${version.extractedChars} Zeichen Text)`,
  };
}

/**
 * The same question for a whole document, over its versions.
 *
 * One readable version makes the document findable, so the answer is the best
 * of them rather than the newest: a v2 PDF on top of a v1 text file is still in
 * the index, and reporting it as unsearchable would be false in the direction
 * that hides a working document.
 */
export function dokumentDurchsuchbarkeit(
  versionen: readonly DocumentVersionView[],
): Durchsuchbarkeit {
  const gelesen = versionen.map(durchsuchbarkeit);
  return (
    gelesen.find((eintrag) => eintrag.art === 'lesbar') ??
    gelesen.find((eintrag) => eintrag.art === 'leer') ??
    gelesen[0] ?? { art: 'ausstehend', text: 'noch keine Fassung abgelegt' }
  );
}

/**
 * What a search answer says about the part of the vault it could not see.
 *
 * `nochNichtDurchsuchbar` counts documents from which no text has been taken,
 * so they cannot match any query. "0 Treffer" over such a vault is true and
 * misleading, and this sentence is the difference between "nothing matches" and
 * "nothing has been read yet". Null when there is nothing to say, because a
 * permanent notice is a notice nobody reads.
 */
export function suchhinweis(nochNichtDurchsuchbar: number): string | null {
  if (!Number.isFinite(nochNichtDurchsuchbar) || nochNichtDurchsuchbar <= 0) return null;
  return nochNichtDurchsuchbar === 1
    ? 'Aus 1 Dokument im Tresor wurde kein Text ausgelesen — es kann auf keine Suche passen.'
    : `Aus ${nochNichtDurchsuchbar} Dokumenten im Tresor wurde kein Text ausgelesen — sie können auf keine Suche passen.`;
}

// --- the list ----------------------------------------------------------------

/**
 * A row in the list, and where it came from.
 *
 * Two kinds rather than one flattened shape, because the two carry different
 * evidence: an upload answer brings the whole version history, a search hit
 * brings the version whose text matched and whether the department boost
 * applied. Squashing them would make the list unable to say which of the two it
 * is showing.
 */
export type Eintrag =
  | { art: 'hochgeladen'; dokument: DocumentView; versionen: DocumentVersionView[] }
  | { art: 'treffer'; dokument: DocumentView; version: number; departmentMatch: boolean };

export function eintragAusDetail(detail: DocumentDetailView): Eintrag {
  return { art: 'hochgeladen', dokument: detail.document, versionen: detail.versions };
}

export function eintraegeAusSuche(body: DocumentSearchBody): Eintrag[] {
  return body.dokumente.map((treffer) => ({
    art: 'treffer',
    dokument: treffer.document,
    version: treffer.version,
    departmentMatch: treffer.departmentMatch,
  }));
}

/**
 * A fresh entry on top of what is already shown, without doubling it.
 *
 * Used for an upload only. A **search replaces** the list rather than merging
 * into it, and that is deliberate: rows left over from before would make "the
 * search found it" true whether or not the search found anything, which is
 * exactly the assertion §8.2's third domain asks about.
 */
export function zusammenfuehren(neu: readonly Eintrag[], vorher: readonly Eintrag[]): Eintrag[] {
  const kennungen = new Set(neu.map((eintrag) => eintrag.dokument.id));
  return [...neu, ...vorher.filter((eintrag) => !kennungen.has(eintrag.dokument.id))];
}

/** The filter's "everything" setting. */
export const ALLE_ABTEILUNGEN = 'alle';

/**
 * Does this row pass the department filter? (§13: department tags.)
 *
 * A filter and not a re-ranking, for the reason `passtZurDringlichkeit` gives:
 * the server already ordered the hits, and a second ordering rule here would be
 * a second answer to "what is most relevant" that nothing keeps in step.
 */
export function passtZurAbteilung(eintrag: Eintrag, filter: string): boolean {
  return filter === ALLE_ABTEILUNGEN || eintrag.dokument.departmentTags.includes(filter);
}

/** Every department tag present in the list, once each, in a stable order. */
export function abteilungenIn(eintraege: readonly Eintrag[]): string[] {
  const alle = new Set<string>();
  for (const eintrag of eintraege) for (const tag of eintrag.dokument.departmentTags) alle.add(tag);
  return [...alle].sort((links, rechts) => links.localeCompare(rechts, 'de'));
}

/**
 * What the filter offers — the departments in the list, plus the one being
 * filtered on even when the list no longer holds it.
 *
 * The second half is what makes `dokumente-gefiltert-leer` reachable at all: a
 * search **replaces** the rows and the filter survives it, so a filter set to
 * "Recht" over a result set of Ops documents is the ordinary way to hide
 * everything. Without the extra option the `<select>` would show a value it has
 * no option for, and the branch that says "your filter is hiding all of it"
 * could never render — a state that reads as covered and is not (§8.2 Domäne 6).
 *
 * It lives here rather than in the component for this module's whole reason:
 * inside the JSX it would be reachable by Playwright alone, and the assertion
 * that it stays reachable is exactly the one worth being able to break.
 */
export function abteilungsoptionen(eintraege: readonly Eintrag[], gewaehlt: string): string[] {
  const vorhanden = abteilungenIn(eintraege);
  return gewaehlt !== ALLE_ABTEILUNGEN && !vorhanden.includes(gewaehlt)
    ? [...vorhanden, gewaehlt]
    : vorhanden;
}

// --- uploading ---------------------------------------------------------------

/** As much of a `File` as this module has any business knowing. */
export interface Dateiangabe {
  name: string;
  size: number;
  type: string;
}

export interface UploadEingabe {
  titel: string;
  datei: Dateiangabe | null;
  /** Free text, comma- or newline-separated. */
  abteilungen: string;
  schlagworte: string;
}

export type UploadPlan =
  | { ok: true; url: string; contentType: string }
  | { ok: false; fehler: string[] };

/**
 * Tags out of a text field: split, trimmed, emptied, de-duplicated.
 *
 * Comma **and** newline, because a curator typing a list does one or the other
 * and neither is wrong. De-duplication is meaning-preserving — a tag written
 * twice is not two tags — and nothing else is normalised: case and spelling are
 * the curator's, and folding them would merge two tags §13 lets him keep apart.
 */
export function schlagworteAus(text: string): string[] {
  const gesehen = new Set<string>();
  for (const roh of text.split(/[,\n]/)) {
    const wort = roh.trim();
    if (wort !== '') gesehen.add(wort);
  }
  return [...gesehen];
}

/**
 * What to POST, or every reason nothing is sent — checked in the order that
 * costs least.
 *
 * The size and the type are checked **here as well as** in the route, and the
 * route is the boundary that counts: `content-length` is caller-supplied and the
 * real cap is counted per chunk (A111.1). What this adds is that a 60 MB file is
 * refused before it is pushed up a domestic uplink, with a German sentence
 * instead of a minute of waiting — so removing this check must cost throughput
 * and never safety, which is what the mutation of it demonstrates.
 *
 * The metadata goes through `uploadMetaSchema`, the same schema
 * `parseUploadQuery` builds the route's answer from, so this page cannot
 * construct a URL the server rejects for a reason it did not anticipate — the
 * rule `antwortNutzlast` already follows one page over.
 */
export function uploadPlan(eingabe: UploadEingabe): UploadPlan {
  const fehler: string[] = [];
  const datei = eingabe.datei;

  if (!datei) {
    fehler.push(
      'Wähle eine Datei aus oder zieh sie in das Feld — ohne Datei gibt es nichts abzulegen.',
    );
  } else {
    if (datei.size > MAX_UPLOAD_BYTES) {
      fehler.push(
        `„${datei.name}" ist ${groesse(datei.size)} groß — hier gehen höchstens ${MAX_UPLOAD_MB} MB.`,
      );
    }
    if (datei.size === 0) {
      fehler.push(`„${datei.name}" ist leer — es gibt nichts abzulegen.`);
    }
    const typ = mediaType(datei.type);
    if (typ === null) {
      fehler.push(
        `Der Browser nennt für „${datei.name}" keinen Dateityp. Erlaubt sind: ${ERLAUBTE_TYPEN}.`,
      );
    } else if (!(VAULT_MIME_TYPES as readonly string[]).includes(typ)) {
      fehler.push(
        `Dieser Dateityp wird nicht angenommen (${typ}). Erlaubt sind: ${ERLAUBTE_TYPEN}.`,
      );
    }
  }

  const geprueft = uploadMetaSchema.safeParse({
    title: eingabe.titel,
    filename: datei?.name ?? '',
    departmentTags: schlagworteAus(eingabe.abteilungen),
    tags: schlagworteAus(eingabe.schlagworte),
  });
  if (!geprueft.success) {
    // The filename's own complaints are dropped when there is no file: "Der
    // Dateiname fehlt." beside "Wähle eine Datei aus" is the same fact twice,
    // and a form that lists one mistake as two teaches its reader to skim.
    for (const grund of germanMetaIssues(geprueft.error.issues)) {
      if (datei || !grund.includes('Dateiname')) fehler.push(grund);
    }
  }

  if (fehler.length > 0 || !geprueft.success || !datei) {
    return {
      ok: false,
      // Never empty: an empty list renders as nothing, and on a form whose only
      // other feedback is "Abgelegt" that reads as success.
      fehler:
        fehler.length > 0 ? fehler : ['Der Upload wurde abgelehnt, ohne einen Grund zu nennen.'],
    };
  }

  return { ok: true, url: uploadUrl(geprueft.data), contentType: datei.type };
}

/**
 * Why the server refused, in German, and never an empty list.
 *
 * The body's own sentences first: every refusal the route produces already
 * carries German prose written where the rule lives, and re-wording it here
 * would be a second phrasing of the same rule that nothing keeps in step. The
 * fallbacks are for the answers that carry no body at all — a proxy's 413, a
 * gateway's 502 — where saying nothing would leave a page that looks like it
 * worked.
 */
export function uploadFehler(status: number, body: unknown): string[] {
  const gemeldet = (body as { errors?: unknown } | null)?.errors;
  if (Array.isArray(gemeldet)) {
    const texte = gemeldet.filter((grund): grund is string => typeof grund === 'string');
    if (texte.length > 0) return texte;
  }
  switch (status) {
    case 401:
      return ['Die Sitzung gilt nicht mehr. Melde dich neu an und leg die Datei noch einmal ab.'];
    case 404:
      return ['Dieses Dokument gibt es nicht (mehr).'];
    case 413:
      return [`Die Datei ist zu groß — höchstens ${MAX_UPLOAD_MB} MB.`];
    case 415:
      return [`Dieser Dateityp wird nicht angenommen. Erlaubt sind: ${ERLAUBTE_TYPEN}.`];
    default:
      return [`Der Server hat die Datei abgelehnt (Fehler ${status}), ohne einen Grund zu nennen.`];
  }
}
