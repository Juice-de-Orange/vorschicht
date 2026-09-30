/**
 * §14's source registry over HTTP (§17.7) — the list, one source with its whole
 * history, and the operator's four curation acts.
 *
 * `SourceRegistry` owns every rule about what a source *is*: the level a
 * curation grants, the reason a promotion must carry, the score. Nothing here
 * re-decides any of them. What this module adds is the translation a transport
 * needs, plus the one thing the registry deliberately does **not** do.
 *
 *  1. **§19's `audit_log` row is written here, and that is a handover rather
 *     than an addition.** `SourceRegistry`'s own header names the seam: the
 *     append-only log carries the actor and the reason per row, so the registry
 *     writes no audit row — and "§19 wants an `audit_log` row for every
 *     *dashboard action*, and the operator accepting or promoting a source on the Sources
 *     page is one. […] Wer die Route baut, muss die Zeile dort erzeugen." It
 *     falls out, and it falls out in the part of the registry §14 makes the
 *     evidence behind a legal citation.
 *
 *  2. **The act and its audit row are one transaction.** `curate` hands both a
 *     registry and a trail bound to the same handle, so a curation with no §19
 *     row is not a state this can reach. A62.2 makes the same point from the
 *     other side — "a refusal that leaves no row is indistinguishable from an
 *     attempt that never happened" — and the inverse is worse: a level granted
 *     with nothing saying who granted it, in the one table a citation rests on.
 *     Two sequential writes would leave that gap open for exactly one hiccup.
 *
 *  3. **A refusal is a value, never an exception** — `dokumente.ts` and
 *     `inbox.ts`'s posture, and load-bearing rather than tidy: there is no
 *     `app.onError` anywhere in this app, so a throw becomes a plain-text 500
 *     with an English stack behind it.
 *
 *  4. **The order of the checks is the design.** Unknown first (there is nothing
 *     to talk about), then whether the act is possible *at all* in this state,
 *     and only then whether the body is well formed. That middle step before the
 *     parse is `answerEscalation`'s reasoning: a caller holding a stale page has
 *     nothing to fix in their submission, and sending them to correct a form
 *     whose submission can never succeed is the least useful answer available.
 *
 *  5. **The actor is the session, never a default.** `SourceRegistry` takes it
 *     as a required argument and `SourceAuditLog` copies it: a trail in which
 *     every curation was made by `system` answers *that* something was curated
 *     and loses the question §19 keeps it for (A75.3).
 *
 * The collaborators are declared structurally (A57.6): a fake then has to match
 * the real signatures, which is the drift a test of this layer exists to catch.
 */
import type {
  SourceAuditTrail,
  SourceDetail,
  SourceListFilter,
  SourceRecord,
} from '@vorschicht/core';
import { SourceRegistryError } from '@vorschicht/core';
import {
  checkCitation,
  isSourceActAllowed,
  parseQuellenListQuery,
  parseSourceAct,
  type QuelleBody,
  type QuellenListBody,
  SOURCE_ACTS_BY_STATE,
  SOURCE_STATE_LABELS,
  type SourceAct,
  type SourceDetailView,
  type SourceEventView,
  type SourceView,
  sourceActFromSegment,
  sourceActRefusal,
  sourceEventLabel,
  type TrustLevel,
} from '@vorschicht/shared/quellen';

/** Exactly the calls this module makes when nothing is written. */
export interface QuellenReader {
  list(filter?: SourceListFilter): Promise<SourceRecord[]>;
  get(sourceId: string): Promise<SourceDetail | null>;
}

/** The four writing calls, taken on a handle bound to one transaction. */
export interface QuellenWriter extends QuellenReader {
  accept(
    sourceId: string,
    input: { level: TrustLevel; note?: string | null },
    actor: string,
  ): Promise<SourceRecord>;
  reject(sourceId: string, input: { reason: string }, actor: string): Promise<SourceRecord>;
  changeLevel(
    sourceId: string,
    input: { level: TrustLevel; reason: string },
    actor: string,
  ): Promise<SourceRecord>;
  retire(sourceId: string, input: { reason: string }, actor: string): Promise<SourceRecord>;
}

/** A registry and a §19 trail on the same transaction (decision 2). */
export interface QuellenTransaction {
  registry: QuellenWriter;
  audit: SourceAuditTrail;
}

export interface QuellenDeps {
  /** Reading needs no transaction and takes the pool. */
  registry: QuellenReader;
  /** One transaction per curation act. */
  curate<T>(fn: (tx: QuellenTransaction) => Promise<T>): Promise<T>;
}

/**
 * Four outcomes, four status codes.
 *
 * `conflict` is 409 and not 422 for `answerEscalation`'s reason: the caller
 * cannot fix it by editing their submission, because what is wrong is the page
 * they are looking at. `failed` is a 500 that still answers in German rather
 * than as a naked stack, which matters precisely because this app has no
 * `app.onError`.
 */
export type QuellenResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'invalid'; errors: string[] }
  | { ok: false; reason: 'unknown'; errors: string[] }
  | { ok: false; reason: 'conflict'; errors: string[] }
  | { ok: false; reason: 'failed'; errors: string[] };

const UNKNOWN_SOURCE = 'Quelle nicht gefunden';

/**
 * A source id, or null.
 *
 * Strict for `isDocumentId`'s reason: `sources.id` is a uuid, and a path segment
 * that is not one names nothing — so answering 404 here keeps a malformed URL
 * from reaching Postgres, where it would raise `invalid input syntax for type
 * uuid` and surface as a 500 for what is a caller's typo.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isSourceId(raw: string | undefined): raw is string {
  return typeof raw === 'string' && UUID.test(raw);
}

// --- reading -----------------------------------------------------------------

/** §17.7's registry, best first — the order `SourceRegistry.list` answers in. */
export async function listSources(
  deps: QuellenDeps,
  params: URLSearchParams,
): Promise<QuellenResult<QuellenListBody>> {
  const filter = parseQuellenListQuery(params);
  const rows = await deps.registry.list({
    ...(filter.state === null ? {} : { state: filter.state }),
    ...(filter.minLevel === null ? {} : { minLevel: filter.minLevel }),
  });
  return { ok: true, value: { quellen: rows.map(toSourceView) } };
}

/** One source and everything that ever happened to it (§14, 0021). */
export async function getSource(
  deps: QuellenDeps,
  sourceId: string,
): Promise<QuellenResult<QuelleBody>> {
  if (!isSourceId(sourceId)) {
    return { ok: false, reason: 'unknown', errors: [UNKNOWN_SOURCE] };
  }
  const detail = await deps.registry.get(sourceId);
  if (!detail) return { ok: false, reason: 'unknown', errors: [UNKNOWN_SOURCE] };
  return { ok: true, value: { quelle: toDetailView(detail) } };
}

// --- curation ----------------------------------------------------------------

/**
 * §14's curation, from the dashboard (§17.7).
 *
 * One entry point for all four acts, because they differ only in the submission
 * they take and the registry method they call — and both of those are resolved
 * from data (`SOURCE_ACT_SUBMISSIONS`, and the switch below). Four near-identical
 * functions would be four places for the audit row to be forgotten in.
 */
export async function curateSource(
  deps: QuellenDeps,
  sourceId: string,
  segment: string | undefined,
  body: unknown,
  actor: string,
): Promise<QuellenResult<QuelleBody>> {
  const act = sourceActFromSegment(segment);
  // An unknown segment is a route that does not exist, not a body that is wrong.
  if (act === null || !isSourceId(sourceId)) {
    return { ok: false, reason: 'unknown', errors: [UNKNOWN_SOURCE] };
  }

  const before = await deps.registry.get(sourceId);
  if (!before) return { ok: false, reason: 'unknown', errors: [UNKNOWN_SOURCE] };

  // Decision 4: possible-at-all before well-formed.
  if (!isSourceActAllowed(before.source.state, act)) {
    return {
      ok: false,
      reason: 'conflict',
      errors: [sourceActRefusal(before.source.state, act)],
    };
  }

  const parsed = parseSourceAct(act, body);
  if (!parsed.ok) return { ok: false, reason: 'invalid', errors: parsed.errors };

  try {
    await deps.curate(async (tx) => {
      // Re-read inside the transaction, so the standing that lands in §19's
      // `before` column is the one the act was applied to rather than the one
      // this route saw a moment ago.
      const current = await tx.registry.get(sourceId);
      if (!current) throw new SourceRegistryError(UNKNOWN_SOURCE, 'not_found');
      if (!isSourceActAllowed(current.source.state, act)) {
        throw new SourceRegistryError(
          sourceActRefusal(current.source.state, act),
          'invalid_reference',
        );
      }

      const submission = parsed.submission;
      let after: SourceRecord;
      switch (submission.act) {
        case 'accept':
          // `note` is normalised to null rather than passed through: the schema
          // makes an absent key `undefined` and an emptied field `null`, and the
          // registry has one meaning for both. Under `exactOptionalPropertyTypes`
          // that is a compile error rather than a subtlety, which is the point.
          after = await tx.registry.accept(
            sourceId,
            { level: submission.input.level, note: submission.input.note ?? null },
            actor,
          );
          break;
        case 'reject':
          after = await tx.registry.reject(sourceId, submission.input, actor);
          break;
        case 'level':
          after = await tx.registry.changeLevel(sourceId, submission.input, actor);
          break;
        default:
          after = await tx.registry.retire(sourceId, submission.input, actor);
      }

      await tx.audit.record({ actor, act: submission.act, before: current.source, after });
    });
  } catch (error) {
    if (error instanceof SourceRegistryError) {
      if (error.kind === 'not_found') {
        return { ok: false, reason: 'unknown', errors: [UNKNOWN_SOURCE] };
      }
      // Everything else the registry refuses is a statement about the
      // submission — a level outside §14's five, a reason that is only
      // whitespace — and it already carries a German sentence written where the
      // rule lives. Re-wording it here would be a second phrasing of one rule
      // that nothing keeps in step.
      return { ok: false, reason: 'invalid', errors: [error.message] };
    }
    return {
      ok: false,
      reason: 'failed',
      errors: [
        'Die Kuratierung konnte nicht gespeichert werden. Es ist nichts geändert worden — ' +
          'bitte noch einmal versuchen.',
      ],
    };
  }

  // Read back rather than assemble from the write: the answer then describes
  // what is *stored*, and one code path produces the shape for all four acts and
  // for the detail page (`dokumente.ts`, decision 3).
  return getSource(deps, sourceId);
}

// --- views -------------------------------------------------------------------

function toSourceView(record: SourceRecord): SourceView {
  return {
    id: record.id,
    url: record.url,
    documentId: record.documentId,
    title: record.title,
    assessment: record.assessment,
    proposedLevel: record.proposedLevel,
    level: record.level,
    state: record.state,
    stateLabel: SOURCE_STATE_LABELS[record.state],
    stateReason: record.stateReason,
    levelReason: record.levelReason,
    proposedAt: record.proposedAt.toISOString(),
    proposedBy: record.proposedBy,
    curatedAt: record.curatedAt?.toISOString() ?? null,
    curatedBy: record.curatedBy,
    score: record.score,
    acts: [...SOURCE_ACTS_BY_STATE[record.state]] as SourceAct[],
    // §14's rule, answered by the one function that owns it. Computed here
    // rather than in the page so that the dashboard and the `legal` gate cannot
    // disagree about which sources are citable — that would be two readings of
    // the sentence a Rechtsgutachten rests on.
    citable: checkCitation({ found: true, state: record.state, level: record.level }).ok,
  };
}

function toDetailView(detail: SourceDetail): SourceDetailView {
  return {
    source: toSourceView(detail.source),
    history: detail.history.map(
      (entry): SourceEventView => ({
        seq: entry.seq,
        kind: entry.kind,
        label: sourceEventLabel(entry.kind, entry.level),
        occurredAt: entry.occurredAt.toISOString(),
        actor: entry.actor,
        level: entry.level,
        reason: entry.reason,
        note: entry.note,
      }),
    ),
  };
}
