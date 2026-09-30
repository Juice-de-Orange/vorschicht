/**
 * §14's five trust levels as data, and the one rule §14 states as prose that
 * has to be code.
 *
 * The arrangement is `./gates.ts`'s: a catalogue in `@vorschicht/shared` rather
 * than beside the component that uses it, because three parties need it and
 * only one of them may touch a database. The Sources page (§17.7) renders the
 * levels, the API validates a curation against them, and the orchestrator ranks
 * with them. A catalogue in `@vorschicht/core` would drag Postgres into the
 * dashboard's import graph for a table of five labels.
 *
 * Browser-safe by construction: this module imports only `zod`. It is
 * reachable through the `@vorschicht/shared/quellen` subpath for the reason
 * `./gates` and `./dokumente` are — the barrel re-exports `worktree.js` and
 * `containment.js`, which pull `node:path` (A75.5).
 *
 * **English identifiers, German values** — the rule `./dokumente.ts` states. §14
 * is written in English because this repository's spec is; every string a
 * person reads is German (§2).
 *
 * Three decisions here are not transcription of §14.
 *
 *   1. **The catalogue is §14's table and nothing else.** Class, examples and
 *      weight are that table's own columns, translated and not extended. The
 *      temptation is a numeric weight per level so that ranking code can
 *      multiply by it; §14's weight column is a *sentence* ("citation-grade,
 *      decisive", "never load-bearing"), and inventing numbers for it here
 *      would put a second, unmeasured ranking scheme beside the one migration
 *      0021 computes — which is what A107.5 refused when it measured
 *      `DEPARTMENT_BOOST` rather than choosing it. The level is the number.
 *
 *   2. **`checkCitation` is pure and lives here, not in the gate that will
 *      apply it.** §14: "Legal/compliance outputs must cite sources with level
 *      ≥ L4; anything lower triggers a corroboration pass." A44.3's sentence is
 *      the reason it is code at all — a rule that only exists in a prompt is not
 *      a rule. It is pure so that the answer can be asserted without a database,
 *      and it is here rather than in `@vorschicht/core` so that the dashboard
 *      can explain a refusal with the same words the gate used.
 *
 *   3. **A citation refused for four different reasons says which.** §14 gives
 *      "below L4" a consequence that is *not* a refusal — a corroboration pass —
 *      so a checker that answered a bare boolean would collapse "cite something
 *      else" and "corroborate this" into one verdict. And a citation naming a
 *      source that does not exist is a different defect again from one naming a
 *      source that exists and is not good enough: the first is a fabricated
 *      reference, which is the failure a legal review has to catch loudest.
 *
 * ---
 *
 * **The wire (§17.7) lives here too, and for `./inbox.ts`'s reason.** Two
 * independent declarations of one JSON document is the defect A81 records: the
 * routes answered `{ posteingang: … }` while the pages read `koerper.items`, and
 * each side stayed green about its own half. So the producer in `apps/server` is
 * type-checked *from* the schemas below and the dashboard **parses** rather than
 * casts. The naming rule is this house's: **German envelope keys, English
 * fields** — a JSON key is read by a program, every string a person reads is
 * German (§2). And every path exists exactly once, because the one time this
 * project wrote one in two packages, every deep link in every notification
 * landed on the wrong page (A81.3).
 */
import { z } from 'zod';

/** §14's levels, strongest first — the order the registry and the UI list them. */
export const TRUST_LEVELS = [5, 4, 3, 2, 1] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

export interface TrustLevelDefinition {
  level: TrustLevel;
  /** How §14 names it: `L5` … `L1`. */
  code: string;
  /** §14's "Class", German (§2). */
  label: string;
  /** §14's "Examples", verbatim where they are proper nouns. */
  examples: readonly string[];
  /** §14's "Weight" — a sentence, deliberately not a number (decision 1). */
  weight: string;
}

/**
 * §14's table.
 *
 * Every row is that table's row: nothing is added, and the only change is the
 * language of the two prose columns.
 */
export const TRUST_LEVEL_CATALOGUE: readonly TrustLevelDefinition[] = [
  {
    level: 5,
    code: 'L5',
    label: 'Amtlich/primär — Gesetzgebung und Hersteller',
    examples: [
      'RIS/Gesetzestexte',
      'offizielle Normen',
      'Dokumentation von Anthropic und Werkzeugherstellern',
    ],
    weight: 'zitierfähig, ausschlaggebend',
  },
  {
    level: 4,
    code: 'L4',
    label: 'Herstellerdokumentation und anerkannte Normungsgremien',
    examples: ['Framework-Dokumentation', 'RFCs', 'OWASP'],
    weight: 'stark',
  },
  {
    level: 3,
    code: 'L3',
    label: 'Angesehene Sekundärquelle',
    examples: ['MDN', 'Blogs etablierter Technikorganisationen'],
    weight: 'normal',
  },
  {
    level: 2,
    code: 'L2',
    label: 'Community',
    examples: ['Blogs', 'Stack Overflow', 'Foren'],
    weight: 'nur unterstützend',
  },
  {
    level: 1,
    code: 'L1',
    label: 'Ungeprüft',
    examples: ['beliebige Beiträge', 'unklare Herkunft'],
    weight: 'nie tragend',
  },
];

const BY_LEVEL = new Map<number, TrustLevelDefinition>(
  TRUST_LEVEL_CATALOGUE.map((entry) => [entry.level, entry]),
);

/**
 * The catalogue covers every level and no level twice.
 *
 * Checked at import, `gates.ts`'s `assertInternalRunnersComplete` precedent: a
 * catalogue with a hole is a level nothing can render and a level a lookup
 * answers `null` for, and finding that out at module load costs nothing while
 * finding it out from a blank chip in the dashboard costs a session.
 */
if (BY_LEVEL.size !== TRUST_LEVELS.length) {
  throw new Error('TRUST_LEVEL_CATALOGUE beschreibt nicht genau die fünf Stufen aus §14.');
}

export function isTrustLevel(value: number | null | undefined): value is TrustLevel {
  return value !== null && value !== undefined && BY_LEVEL.has(value);
}

/** The catalogue entry for a level, or `null` for anything §14 does not define. */
export function trustLevel(value: number | null | undefined): TrustLevelDefinition | null {
  if (value === null || value === undefined) return null;
  return BY_LEVEL.get(value) ?? null;
}

/** `L4` for a level, and a German placeholder for a source with none yet. */
export function trustLevelCode(value: number | null | undefined): string {
  return trustLevel(value)?.code ?? 'ohne Stufe';
}

// --- the registry's states (migration 0021) ---------------------------------

/**
 * §5's "proposal state", derived from the log and never stored (0021,
 * decision 2).
 *
 * Order is the lifecycle's: a source is proposed, then accepted or rejected,
 * and an accepted one may later be retired. It is a log rather than a straight
 * line — a rejected source may be proposed again — so this list is a vocabulary
 * and not a state machine.
 */
export const SOURCE_STATES = ['proposed', 'accepted', 'rejected', 'retired'] as const;
export type SourceState = (typeof SOURCE_STATES)[number];

/** German (§2) — what the Sources page and every refusal below call them. */
export const SOURCE_STATE_LABELS: Record<SourceState, string> = {
  proposed: 'vorgeschlagen',
  accepted: 'aufgenommen',
  rejected: 'abgelehnt',
  retired: 'stillgelegt',
};

// --- §14's citation rule -----------------------------------------------------

/**
 * "Legal/compliance outputs must cite sources with level ≥ L4" (§14).
 *
 * The one number in this module that a rule depends on, and it is named rather
 * than written into a comparison, so that moving it is one edit that a test
 * catches rather than a `>= 4` somebody copies.
 */
export const CITATION_MIN_LEVEL: TrustLevel = 4;

/**
 * What a citation names, as much as a checker needs to know about it.
 *
 * `found: false` is a citation to a source id the registry does not have —
 * kept separate from every other failure because it is a different defect: a
 * reference that was invented rather than one that is merely weak.
 */
export type CitationSubject =
  | { found: false }
  | { found: true; state: SourceState; level: TrustLevel | null };

export type CitationReason =
  | 'citable'
  /** No such source. */
  | 'unknown'
  /** It exists, but it is not in the registry today (proposed, rejected, retired). */
  | 'not_accepted'
  /** Accepted, and §14 wants a corroboration pass rather than this alone. */
  | 'below_threshold'
  /** Accepted with no level recorded — refused, because unknown is not "fine". */
  | 'level_unknown';

export interface CitationCheck {
  /** True only for an accepted source at or above `CITATION_MIN_LEVEL`. */
  ok: boolean;
  reason: CitationReason;
  state: SourceState | null;
  level: TrustLevel | null;
  /**
   * §14's "anything lower triggers a corroboration pass".
   *
   * Only true for `below_threshold`: a source that is registered and merely too
   * weak can be carried by a second source, while a source that does not exist
   * or is not in the registry cannot be corroborated into being one.
   */
  needsCorroboration: boolean;
  /** German (§2) — ready to render in a finding, a card or a Prüfbericht. */
  message: string;
}

/**
 * §14's citation rule, applied.
 *
 * The gate that runs it is Lena's (§11's `legal`, Phase 6) and is deliberately
 * not here: this answers *whether* a citation carries, and what a gate does
 * with the answer — block, or send the output back for corroboration — is that
 * gate's decision.
 *
 * Fails closed on the one case the schema forbids and a future writer could
 * still produce: an accepted source with no recorded level. "We could not find
 * out whether we are allowed" and "we are allowed" are the same sentence only
 * to a system that has decided not to notice (A83.6, A87.6, A99.4).
 */
export function checkCitation(subject: CitationSubject): CitationCheck {
  if (!subject.found) {
    return {
      ok: false,
      reason: 'unknown',
      state: null,
      level: null,
      needsCorroboration: false,
      message:
        'Diese Quelle steht nicht im Quellenregister — die Zitation nennt eine Kennung, ' +
        'die es nicht gibt.',
    };
  }

  const stateLabel = SOURCE_STATE_LABELS[subject.state];

  if (subject.state !== 'accepted') {
    return {
      ok: false,
      reason: 'not_accepted',
      state: subject.state,
      level: subject.level,
      needsCorroboration: false,
      message:
        `Diese Quelle ist ${stateLabel} und damit nicht zitierfähig — zitierfähig ist ` +
        'nur, was im Register aufgenommen ist (§14).',
    };
  }

  if (subject.level === null) {
    return {
      ok: false,
      reason: 'level_unknown',
      state: subject.state,
      level: null,
      needsCorroboration: false,
      message:
        'Diese Quelle ist aufgenommen, trägt aber keine Vertrauensstufe — ohne Stufe ' +
        'ist nicht feststellbar, ob sie §14s Schwelle erreicht, und ungeprüft gilt als ' +
        'nicht erreicht.',
    };
  }

  if (subject.level < CITATION_MIN_LEVEL) {
    return {
      ok: false,
      reason: 'below_threshold',
      state: subject.state,
      level: subject.level,
      needsCorroboration: true,
      message:
        `Diese Quelle steht auf ${trustLevelCode(subject.level)}; für rechtliche Aussagen ` +
        `verlangt §14 mindestens ${trustLevelCode(CITATION_MIN_LEVEL)}. Sie darf mitlaufen, ` +
        'braucht aber eine Bestätigung durch eine stärkere Quelle.',
    };
  }

  return {
    ok: true,
    reason: 'citable',
    state: subject.state,
    level: subject.level,
    needsCorroboration: false,
    message: `Diese Quelle steht auf ${trustLevelCode(subject.level)} und ist zitierfähig (§14).`,
  };
}

// --- §17.7's curation surface ------------------------------------------------

/**
 * What the operator can do to a source from the dashboard (§14's curation).
 *
 * Four acts, one per writing method on `SourceRegistry`. `propose` is
 * deliberately absent: §14 has *departments* propose ("Departments may propose
 * new highly-trusted sources → inbox item … the operator decides inclusion"), so the
 * proposing side is an agent producer and §15's card. A form here would be a
 * second door into the registry, answering a question nobody asked through the
 * inbox.
 */
export const SOURCE_ACTS = ['accept', 'reject', 'level', 'retire'] as const;
export type SourceAct = (typeof SOURCE_ACTS)[number];

/** German (§2) — what the button says and what a refusal names. */
export const SOURCE_ACT_LABELS: Record<SourceAct, string> = {
  accept: 'Aufnehmen',
  reject: 'Ablehnen',
  level: 'Stufe ändern',
  retire: 'Stilllegen',
};

/**
 * The path segment each act travels as. One literal per act, in one place.
 *
 * German, like every other route this app answers (`/api/dokumente/suche`,
 * `/api/posteingang/:nummer/antwort`), and read by both the builder below and
 * the route that resolves it — so a renamed segment cannot leave the page
 * posting somewhere the server does not listen (A81.3).
 */
export const SOURCE_ACT_SEGMENTS: Record<SourceAct, string> = {
  accept: 'aufnehmen',
  reject: 'ablehnen',
  level: 'stufe',
  retire: 'stilllegen',
};

const ACT_BY_SEGMENT = new Map<string, SourceAct>(
  SOURCE_ACTS.map((act) => [SOURCE_ACT_SEGMENTS[act], act]),
);

/** The act a segment names, or null. An unknown segment is a 404, never a guess. */
export function sourceActFromSegment(segment: string | undefined): SourceAct | null {
  return segment === undefined ? null : (ACT_BY_SEGMENT.get(segment) ?? null);
}

/**
 * Which acts a source in this state admits — **this module's rule, not §14's.**
 *
 * 0021's decision 8 is explicit that the registry itself is a log rather than a
 * straight line: a rejected source may be proposed again, a retired one may come
 * back, and no constraint pretends otherwise. Nothing here changes that and
 * nothing here constrains the agent-side producer. What it constrains is the
 * *curation surface*, where the failure mode is different and concrete: a page
 * the operator opened ten minutes ago still offers "Aufnehmen" for a source somebody has
 * since accepted, and pressing it appends a second `accepted` row to the log
 * §14 makes the evidence behind a citation. A duplicate act is not a
 * disagreement the registry can catch — both rows are individually valid — so it
 * has to be caught where the staleness is.
 *
 * Two readers, one declaration, which is the whole reason it is a table:
 *
 *   * the page renders exactly these buttons, so it never offers one the route
 *     refuses;
 *   * the route refuses everything else, because a caller holding a stale page
 *     has nothing to correct in their submission.
 *
 * The four rows, and why each is what it is:
 *
 *   * `proposed` → accept or reject. §14's own sentence: The operator decides inclusion.
 *   * `accepted` → change the level or retire. Accepting twice says nothing;
 *     raising an accepted source from L4 to L5 is `level`, and that is the act
 *     carrying the reason a later citation rests on.
 *   * `rejected` → accept. Better evidence arrives, and refusing that would make
 *     a "nein" permanent in a registry §14 describes as curated rather than
 *     final. Rejecting again is refused: it changes nothing and buries the first
 *     refusal's reason under a second.
 *   * `retired` → accept. Back into service. Retiring twice is likewise a no-op
 *     that costs a row in a table nothing can ever delete from (§18).
 */
export const SOURCE_ACTS_BY_STATE: Record<SourceState, readonly SourceAct[]> = {
  proposed: ['accept', 'reject'],
  accepted: ['level', 'retire'],
  rejected: ['accept'],
  retired: ['accept'],
};

export function isSourceActAllowed(state: SourceState, act: SourceAct): boolean {
  return SOURCE_ACTS_BY_STATE[state].includes(act);
}

/**
 * Why an act is refused, in German, naming what *is* possible.
 *
 * A refusal that only says no leaves the reader of a stale page guessing whether
 * they misread the source or the system; naming the state and the remaining acts
 * turns it into an instruction.
 */
export function sourceActRefusal(state: SourceState, act: SourceAct): string {
  const list = SOURCE_ACTS_BY_STATE[state]
    .map((entry) => `„${SOURCE_ACT_LABELS[entry]}"`)
    .join(' oder ');
  return (
    `„${SOURCE_ACT_LABELS[act]}" geht bei einer Quelle nicht, die ` +
    `${SOURCE_STATE_LABELS[state]} ist. Möglich ist hier ${list}. ` +
    'Wahrscheinlich zeigt diese Seite einen älteren Stand — lade sie neu.'
  );
}

// --- the views ---------------------------------------------------------------

/**
 * A trust level on the wire.
 *
 * Built from `isTrustLevel` rather than `z.number().min(1).max(5)`, so §14's
 * five are declared exactly once: a sixth level would rank above L5 and be
 * citable by every rule written against `>= 4`, and the catalogue above is where
 * that gets decided.
 */
export const trustLevelSchema = z
  .number({ error: 'Die Vertrauensstufe muss eine Zahl sein.' })
  .int('Die Vertrauensstufe muss eine ganze Zahl sein.')
  .refine((value): value is TrustLevel => isTrustLevel(value), {
    error: 'Das ist keine Vertrauensstufe — §14 kennt genau L1 bis L5.',
  });

/**
 * One source as §5 names it: "URL/reference, trust level 1–5, score,
 * curated-by, proposal state".
 *
 * `proposedLevel` and `level` both travel and neither is redundant (0021's
 * second decision): the first is what a department assessed, the second what the
 * registry granted. A page showing only one could not tell a pending proposal
 * from an accepted source at the same level, which is precisely the distinction
 * §14's citation rule turns on.
 *
 * `levelReason` is the sentence behind the current level, on the source rather
 * than only in the history, because it is the one line a reader needs when
 * asking why a citation may rest on this.
 */
export const sourceView = z.object({
  id: z.string(),
  /** §5's "URL/reference". Null when the source *is* a vault document. */
  url: z.string().nullable(),
  /** §13's link entries, pointed at from this side (0021, decision 6). */
  documentId: z.string().nullable(),
  title: z.string(),
  /** The proposing department's trust assessment (§14). */
  assessment: z.string().nullable(),
  proposedLevel: z.number().int(),
  /** Null while nobody has granted one. */
  level: z.number().int().nullable(),
  state: z.enum(SOURCE_STATES),
  /** German (§2), ready to render. */
  stateLabel: z.string(),
  /** Why it was rejected or retired. */
  stateReason: z.string().nullable(),
  /** Why it stands at this level — §14's evidence behind a citation. */
  levelReason: z.string().nullable(),
  /** ISO 8601. */
  proposedAt: z.string(),
  proposedBy: z.string(),
  curatedAt: z.string().nullable(),
  curatedBy: z.string().nullable(),
  /** §14's score, recomputed on every read. Null for anything not accepted. */
  score: z.number().nullable(),
  /** What may be done to it from here (`SOURCE_ACTS_BY_STATE`). */
  acts: z.array(z.enum(SOURCE_ACTS)),
  /** §14's L≥4 rule applied, so the page shows it rather than re-deriving it. */
  citable: z.boolean(),
});
export type SourceView = z.infer<typeof sourceView>;

/**
 * One line of §14's history — who did what, when, and on what grounds.
 *
 * This is the half that a page showing only the current standing throws away,
 * and it is the half 0021 chose an append-only log *for*: §14 makes level ≥ L4
 * the condition for citing anything, so "who raised this to L5, when, and why"
 * is the evidence a Rechtsgutachten actually rests on. A registry that can only
 * say "L5 today" cannot answer the one question anybody asks of it a year later.
 */
export const sourceEventView = z.object({
  seq: z.number().int().positive(),
  kind: z.enum(['proposed', 'accepted', 'rejected', 'level_changed', 'retired']),
  /** German (§2) — "aufgenommen auf L4", "auf L5 gesetzt", … */
  label: z.string(),
  /** ISO 8601. */
  occurredAt: z.string(),
  actor: z.string(),
  /** Present on `proposed`, `accepted` and `level_changed`. */
  level: z.number().int().nullable(),
  /** Required on `rejected`, `level_changed` and `retired` (0021, decision 7). */
  reason: z.string().nullable(),
  /** The free note an acceptance may carry. */
  note: z.string().nullable(),
});
export type SourceEventView = z.infer<typeof sourceEventView>;

/** One source and everything that ever happened to it, oldest first. */
export const sourceDetailView = z.object({
  source: sourceView,
  history: z.array(sourceEventView),
});
export type SourceDetailView = z.infer<typeof sourceDetailView>;

// --- envelopes ---------------------------------------------------------------

/**
 * The producer builds these, not the route — `./dokumente.ts`'s arrangement.
 *
 * `/api/posteingang` has its adapter return the payload and `app.ts` write
 * `{ posteingang: … }` around it, which leaves that key in a second place. Here
 * the adapter returns the finished body and the route only picks a status code.
 */
export const quellenListResponse = z.object({ quellen: z.array(sourceView) });
export type QuellenListBody = z.infer<typeof quellenListResponse>;

export const quelleResponse = z.object({ quelle: sourceDetailView });
export type QuelleBody = z.infer<typeof quelleResponse>;

/** Every refusal, German, ready to render. */
export const quelleRejectedResponse = z.object({ errors: z.array(z.string()) });

// --- routes ------------------------------------------------------------------

/** One place both the routes and the pages name these (A81.3). */
export const QUELLEN_API = {
  list: '/api/quellen',
  source: (id: string) => `/api/quellen/${encodeURIComponent(id)}`,
  act: (id: string, act: SourceAct) =>
    `/api/quellen/${encodeURIComponent(id)}/${SOURCE_ACT_SEGMENTS[act]}`,
} as const;

/**
 * The query keys the list reads, named once for the same reason.
 *
 * German keys, unlike the field names above, and the difference is real: a query
 * string is something the operator can see and type in an address bar, which makes it a
 * surface a person reads (§2). `SEARCH_QUERY` in `./dokumente.ts` draws the line
 * in the same place (`q`, `abteilung`).
 */
export const QUELLEN_QUERY = { state: 'zustand', minLevel: 'abstufe' } as const;

export interface QuellenListFilter {
  state: SourceState | null;
  minLevel: TrustLevel | null;
}

/** The list URL — the builder half of the pair below. */
export function quellenListUrl(filter: Partial<QuellenListFilter> = {}): string {
  const params = new URLSearchParams();
  if (filter.state) params.set(QUELLEN_QUERY.state, filter.state);
  if (filter.minLevel) params.set(QUELLEN_QUERY.minLevel, String(filter.minLevel));
  const query = params.toString();
  return query ? `${QUELLEN_API.list}?${query}` : QUELLEN_API.list;
}

/**
 * The same, parsed — and an unreadable filter is dropped rather than refused.
 *
 * A list is a *view*, so a query key somebody mistyped costs a narrower answer
 * at worst, and refusing the whole page over it would turn a stale bookmark into
 * an error screen. That is the opposite call from the submissions below, where
 * an unreadable value would decide something and therefore has to stop.
 */
export function parseQuellenListQuery(params: URLSearchParams): QuellenListFilter {
  const state = params.get(QUELLEN_QUERY.state) ?? '';
  const level = Number(params.get(QUELLEN_QUERY.minLevel));
  return {
    state: (SOURCE_STATES as readonly string[]).includes(state) ? (state as SourceState) : null,
    minLevel: isTrustLevel(level) ? level : null,
  };
}

// --- submissions -------------------------------------------------------------

/**
 * A reason or a note, capped.
 *
 * Every constraint carries its own German message, which is the mechanism rather
 * than a courtesy — `./dokumente.ts` states it in full. These arrive as
 * `too_small`/`invalid_type` rather than as `custom` issues, so there is nothing
 * for a re-wording layer to switch on; `germanQuellenIssues` quotes verbatim and
 * what carries the guarantee is a test driving every reachable issue and
 * asserting that no English comes out.
 */
export const MAX_SOURCE_REASON_LENGTH = 1_000;

const reasonSchema = z
  .string({ error: 'Die Begründung muss Text sein.' })
  .trim()
  .min(
    1,
    'Ohne Begründung geht das nicht — sie ist der Beleg, auf dem eine spätere Zitation ruht (§14).',
  )
  .max(
    MAX_SOURCE_REASON_LENGTH,
    `Die Begründung ist zu lang (höchstens ${MAX_SOURCE_REASON_LENGTH} Zeichen).`,
  );

const noteSchema = z
  .string({ error: 'Die Notiz muss Text sein.' })
  .trim()
  .max(
    MAX_SOURCE_REASON_LENGTH,
    `Die Notiz ist zu lang (höchstens ${MAX_SOURCE_REASON_LENGTH} Zeichen).`,
  )
  .nullish();

/**
 * Taking a source in states its level (§14; `SourceRegistry`'s decision 3).
 *
 * The level is **required and never defaulted to the proposal's**. §14 sends the operator
 * a proposal "with the agent's trust assessment" and has him "decide inclusion" —
 * two acts — so inheriting the first would make the common case (accepting an L5
 * proposal as an L4) an edit rather than an answer.
 */
export const acceptSubmission = z.object({ level: trustLevelSchema, note: noteSchema });
export type AcceptSubmission = z.infer<typeof acceptSubmission>;

/** A rejection and a retirement: the reason is the whole content of the act. */
export const reasonSubmission = z.object({ reason: reasonSchema });
export type ReasonSubmission = z.infer<typeof reasonSubmission>;

/** §14's promotion and demotion. Both halves required — see `changeLevel`. */
export const levelSubmission = z.object({ level: trustLevelSchema, reason: reasonSchema });
export type LevelSubmission = z.infer<typeof levelSubmission>;

/** One schema per act, so a route resolves it from the segment rather than a switch. */
export const SOURCE_ACT_SUBMISSIONS = {
  accept: acceptSubmission,
  reject: reasonSubmission,
  level: levelSubmission,
  retire: reasonSubmission,
} as const;

export type SourceActSubmission =
  | { act: 'accept'; input: AcceptSubmission }
  | { act: 'reject'; input: ReasonSubmission }
  | { act: 'level'; input: LevelSubmission }
  | { act: 'retire'; input: ReasonSubmission };

export type SourceActResult =
  | { ok: true; submission: SourceActSubmission }
  | { ok: false; errors: string[] };

/**
 * Read a submission for one act, or say in German why it is not one.
 *
 * The discriminated result is what keeps the adapter from re-deciding anything:
 * it receives the act *and* the value already narrowed, so there is no branch in
 * which a level reaches `reject` or a bare reason reaches `accept`.
 */
export function parseSourceAct(act: SourceAct, body: unknown): SourceActResult {
  const input = typeof body === 'object' && body !== null && !Array.isArray(body) ? body : {};
  const parsed = SOURCE_ACT_SUBMISSIONS[act].safeParse(input);
  if (!parsed.success) return { ok: false, errors: germanQuellenIssues(parsed.error.issues) };
  return { ok: true, submission: { act, input: parsed.data } as SourceActSubmission };
}

/** Zod's issues as sentences the operator reads (§2) — quoted, never re-worded. */
export function germanQuellenIssues(issues: ReadonlyArray<{ message: string }>): string[] {
  return issues.map((issue) => issue.message);
}

// --- rendering ---------------------------------------------------------------

/**
 * What one line of the history says, in German (§2).
 *
 * Assembled here rather than in the page because the level belongs *inside* the
 * sentence: "auf L4 gesetzt" and "aufgenommen auf L4" are different events, and
 * a template appending the level to a fixed verb would write "abgelehnt · L4"
 * about a rejection, which carries no level at all.
 */
export function sourceEventLabel(kind: SourceEventView['kind'], level: number | null): string {
  switch (kind) {
    case 'proposed':
      return `vorgeschlagen mit ${trustLevelCode(level)}`;
    case 'accepted':
      return `aufgenommen auf ${trustLevelCode(level)}`;
    case 'level_changed':
      return `auf ${trustLevelCode(level)} gesetzt`;
    case 'rejected':
      return 'abgelehnt';
    default:
      return 'stillgelegt';
  }
}
