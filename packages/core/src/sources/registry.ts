/**
 * §14's source registry — the data layer over migration 0021.
 *
 * §14 gives this component one job and one property. The job: hold the curated
 * sources with their trust level, their proposal state and the score that
 * refines the order within a level. The property: **curation only boosts
 * ranking** — "curated sources are weighted reference works, not restrictions"
 * — so nothing here refuses a department a source, and the one place a level
 * actually decides something is `checkCitation` (§14's L≥4 rule), which is pure
 * and lives in `@vorschicht/shared/quellen`.
 *
 * Six decisions that are this module's rather than the schema's.
 *
 *   1. **Nothing here writes `audit_log`, and that is the opposite of
 *      `DocumentVault` one directory over.** The vault writes an audit row per
 *      curation act because `documents` is *mutable*: without it, a re-tagging
 *      would leave no trace at all (0020, decision 1). Here the trace is the
 *      table — `source_events` is append-only, carries the actor and the reason
 *      on every row, and its guard binds the owner. A second record of the same
 *      fact is a second thing that can disagree, and A94 is the entry that
 *      names what a second layer costs when nothing keeps it in step.
 *
 *      **The seam this leaves, named rather than assumed:** §19 wants an
 *      `audit_log` row for every *dashboard action*, and the operator accepting or
 *      promoting a source on the Sources page is one. `ProjectService.setGateConfig`
 *      writes that row inside the service, so a route built against this
 *      registry must not assume the same — the curation act is recorded here
 *      (append-only, with actor and reason), and the §19 row for *the dashboard
 *      having done it* belongs to whoever owns the route. Written down because
 *      an assumption on either side of that line leaves the trail empty in the
 *      one part of the registry §14 makes the evidence behind a legal citation.
 *
 *   2. **Nothing here writes `event_log` either, and that is a deferral rather
 *      than an argument.** §4 fans `event_log` out to the live feed, and the
 *      party with a human waiting on a source is §15's proposal card and
 *      §17.7's page — both other blocks, and the card already emits
 *      `escalation.raised`/`answered` at the moment the operator is looking. `EVENT_KINDS`
 *      is a closed list in `@vorschicht/core/event-log`, so adding
 *      `source.accepted` today would be a kind with no reader, edited into a
 *      file two other streams are editing. When the producer lands it appends
 *      there, where the reader is. Named here rather than left to be noticed,
 *      because a registry that is silent on the feed looks like an omission and
 *      is a choice.
 *
 *   3. **An acceptance states its level; it does not inherit the proposal's.**
 *      §14 sends a proposal to the operator "with the agent's trust assessment" and has
 *      him "decide inclusion" — two acts, and defaulting the second to the first
 *      would make the common case (the operator accepts a source the department called
 *      L5 as an L4) an edit rather than an answer. So `accept` takes a level and
 *      the view keeps `proposedLevel` beside `level` for exactly this: what was
 *      claimed and what was granted are both on the record.
 *
 *   4. **Every refusal is checked here *and* in the database, and neither layer
 *      is redundant.** The service produces the German sentence a person reads;
 *      the CHECKs produce the guarantee a future caller with its own connection
 *      cannot go around. A77.8 struck the same bargain for "answered exactly
 *      once", and 0021's decision 8 is what makes the second layer real: an
 *      event for a source nobody proposed computes `seq = 1` and is refused by
 *      the schema, whatever this class forgets.
 *
 *   5. **Reading never writes.** `list`, `get` and `resolve` compute §14's score
 *      afresh out of the view and append nothing (0021, decision 3). Stated as a
 *      property of *this* module rather than only of the SQL, because it is the
 *      one that a convenience would quietly break — a cached score written back
 *      "so the list is fast" is 0014's eighteen identical rows an hour, and the
 *      test that catches it counts rows across repeated reads.
 *
 *   6. **`resolve` answers in `@vorschicht/shared`'s vocabulary, not its own.**
 *      It returns a `CitationSubject`, which is exactly what `checkCitation`
 *      consumes, so the gate that will apply §14's rule cannot accidentally
 *      re-derive "is this good enough" from a record it happens to hold. A
 *      citation to a source that does not exist and one to a source that is too
 *      weak are different defects, and that distinction survives only if the
 *      caller is handed the discriminated shape rather than a nullable record.
 */
import {
  type CitationSubject,
  isTrustLevel,
  SOURCE_STATE_LABELS,
  type SourceState,
  type TrustLevel,
} from '@vorschicht/shared';
import type { Queryable } from '../sql.js';

/** The acts §14 describes, and the log's five kinds (0021). */
export type SourceEventKind = 'proposed' | 'accepted' | 'rejected' | 'level_changed' | 'retired';

export interface SourceRecord {
  id: string;
  /** §5's "URL/reference". Null when the source *is* a vault document. */
  url: string | null;
  /** §13's link entries, pointed at from this side (0021, decision 6). */
  documentId: string | null;
  title: string;
  /** §14: the proposing department's trust assessment. */
  assessment: string | null;
  /** What a department claimed. */
  proposedLevel: TrustLevel;
  /** What the registry granted — null while the proposal is undecided. */
  level: TrustLevel | null;
  /** §5's "proposal state", derived (0021, decision 2). */
  state: SourceState;
  /** Why it was rejected or retired. */
  stateReason: string | null;
  /** Why it stands at this level — §14's evidence behind a citation. */
  levelReason: string | null;
  proposedAt: Date;
  proposedBy: string;
  /** §5's "curated-by": who last decided about it, and when. */
  curatedAt: Date | null;
  curatedBy: string | null;
  /**
   * §14's numeric score, or null for anything not in the registry.
   *
   * Recomputed on every read and never stored. Always within `[level,
   * level + 1)`, so it orders within a trust level and never across one.
   */
  score: number | null;
}

/** One line of §14's history: what happened, when, and who did it. */
export interface SourceEventRecord {
  seq: number;
  kind: SourceEventKind;
  occurredAt: Date;
  actor: string;
  /** Present on `proposed`, `accepted` and `level_changed`. */
  level: TrustLevel | null;
  /** Required on `rejected`, `level_changed` and `retired` (0021, decision 7). */
  reason: string | null;
  /** The free note an acceptance may carry. */
  note: string | null;
}

export interface SourceDetail {
  source: SourceRecord;
  /** Oldest first — this is the story, and a story reads forwards. */
  history: SourceEventRecord[];
}

export interface ProposeSourceSpec {
  title: string;
  /** At least one of `url` / `documentId`; the schema refuses neither-nor. */
  url?: string | null;
  documentId?: string | null;
  /** The proposing department's assessment (§14). */
  level: TrustLevel;
  assessment?: string | null;
  /** Supplied for a deterministic id; otherwise the database picks one. */
  id?: string;
}

export interface SourceListFilter {
  state?: SourceState;
  /** §14's ranking, filtered — e.g. "everything Lena may cite". */
  minLevel?: TrustLevel;
  /** The duplicate lookup a proposal producer performs (0021, decision 8). */
  url?: string;
  limit?: number;
}

export type SourceRegistryErrorKind =
  | 'not_found'
  | 'invalid_reference'
  | 'invalid_level'
  | 'missing_reason'
  | 'not_created';

/**
 * One error class per subsystem, carrying which refusal this is.
 *
 * `EscalationError`'s arrangement and its reasoning: five classes would land
 * one by one in the dead-wiring detector, and the situation is data. The kind is
 * required so that a future throw site has to pick one.
 */
export class SourceRegistryError extends Error {
  constructor(
    message: string,
    readonly kind: SourceRegistryErrorKind,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'SourceRegistryError';
  }
}

interface SourceRow {
  id: string;
  url: string | null;
  document_id: string | null;
  title: string;
  assessment: string | null;
  proposed_level: number;
  level: number | null;
  state: SourceState;
  state_reason: string | null;
  level_reason: string | null;
  proposed_at: Date;
  proposed_by: string;
  curated_at: Date | null;
  curated_by: string | null;
  /** `numeric` arrives as a string; `Number` is applied once, in `toRecord`. */
  score: string | null;
}

interface EventRow {
  seq: number;
  kind: SourceEventKind;
  occurred_at: Date;
  actor: string;
  level: number | null;
  reason: string | null;
  note: string | null;
}

const DEFAULT_LIST_LIMIT = 200;

export class SourceRegistry {
  constructor(private readonly sql: Queryable) {}

  /**
   * A department proposes a source (§14).
   *
   * This is a *record*, not an inbox item: §15's card is another block, and the
   * boundary is A48.2's — the layer that stores a proposal must not also be the
   * layer that decides it has been asked. When the producer lands it raises the
   * card and answers it back into `accept` / `reject` with `actor = 'max'`,
   * which is the whole linkage this layer needs; the shape that fits for the
   * trace is an `escalationNumber` on the proposal's payload, exactly as A83.5
   * put one on an audit finding.
   */
  async propose(spec: ProposeSourceSpec, actor: string): Promise<SourceRecord> {
    const title = spec.title.trim();
    if (title === '') {
      throw new SourceRegistryError('Eine Quelle braucht einen Titel.', 'invalid_reference');
    }
    const url = spec.url?.trim() || null;
    const documentId = spec.documentId ?? null;
    if (url === null && documentId === null) {
      throw new SourceRegistryError(
        'Eine Quelle braucht eine Fundstelle — entweder eine URL oder ein Dokument aus dem Tresor.',
        'invalid_reference',
      );
    }
    if (url !== null && !/^https?:\/\/\S+$/.test(url)) {
      throw new SourceRegistryError(
        `„${url}" ist keine http- oder https-Adresse. Eine Zitation ist ein Verweis, ` +
          'dem jemand folgt.',
        'invalid_reference',
      );
    }
    assertLevel(spec.level);

    const payload = {
      title,
      assessment: spec.assessment?.trim() || null,
    };

    const [row] = await this.sql<Array<{ source_id: string }>>`
      INSERT INTO source_events (source_id, seq, kind, actor, url, document_id, level, payload)
      VALUES (
        ${spec.id ?? this.sql`gen_random_uuid()`}, 1, 'proposed', ${actor},
        ${url}, ${documentId}, ${spec.level}, ${this.sql.json(payload as never)}
      )
      RETURNING source_id
    `;
    /* c8 ignore next 6 */
    if (!row) {
      throw new SourceRegistryError(
        'Quelle konnte nicht angelegt werden — kein Datensatz zurück.',
        'not_created',
      );
    }
    return this.require(row.source_id);
  }

  /**
   * The operator takes the source into the registry, at the level he grants (decision 3).
   *
   * `note` is optional where a rejection's reason is not: an acceptance's
   * reasoning is the proposal's assessment, which is already on the record,
   * while a rejection contradicts it and has to say why.
   */
  async accept(
    sourceId: string,
    input: { level: TrustLevel; note?: string | null },
    actor: string,
  ): Promise<SourceRecord> {
    assertLevel(input.level);
    await this.require(sourceId);
    await this.append(sourceId, 'accepted', actor, input.level, {
      note: input.note?.trim() || null,
    });
    return this.require(sourceId);
  }

  /** The operator declines it. The reason is what makes a later re-proposal answerable. */
  async reject(sourceId: string, input: { reason: string }, actor: string): Promise<SourceRecord> {
    const reason = requireReason(input.reason, 'Eine Ablehnung');
    await this.require(sourceId);
    await this.append(sourceId, 'rejected', actor, null, { reason });
    return this.require(sourceId);
  }

  /**
   * §14's promotion and demotion, with the sentence that justifies it.
   *
   * The reason is required in both layers because a citation at L5 is worth
   * exactly what the sentence granting L5 is worth — that is the evidence §14
   * makes a legal output rest on, and it is the reason this whole table is
   * append-only (0021, decision 1).
   */
  async changeLevel(
    sourceId: string,
    input: { level: TrustLevel; reason: string },
    actor: string,
  ): Promise<SourceRecord> {
    assertLevel(input.level);
    const reason = requireReason(input.reason, 'Eine Stufenänderung');
    await this.require(sourceId);
    await this.append(sourceId, 'level_changed', actor, input.level, { reason });
    return this.require(sourceId);
  }

  /**
   * Take a source out of service (§14's curation, reversed).
   *
   * Retiring does not delete and does not lower the level: the source keeps its
   * history and its last granted level, and stops being citable because its
   * *state* is no longer `accepted`. A demotion to L1 would have been the other
   * way to do it and it says something different — "this is a weak source"
   * rather than "do not use this any more".
   */
  async retire(sourceId: string, input: { reason: string }, actor: string): Promise<SourceRecord> {
    const reason = requireReason(input.reason, 'Eine Stilllegung');
    await this.require(sourceId);
    await this.append(sourceId, 'retired', actor, null, { reason });
    return this.require(sourceId);
  }

  /**
   * §14's registry, best first.
   *
   * Ordered by score with the level as the fallback, because a source that is
   * not accepted has no score at all (0021) and would otherwise sort by
   * whatever the planner produced. `proposed_at DESC` is the deterministic tail,
   * for the reason 0020 gives its `seq DESC`: an order that is knowable from
   * outside is what makes an assertion about ranking able to fail.
   */
  async list(filter: SourceListFilter = {}): Promise<SourceRecord[]> {
    const rows = await this.sql<SourceRow[]>`
      SELECT * FROM sources
      WHERE (${filter.state ?? null}::text IS NULL OR state = ${filter.state ?? null})
        AND (${filter.minLevel ?? null}::int IS NULL OR level >= ${filter.minLevel ?? null})
        AND (${filter.url ?? null}::text IS NULL OR url = ${filter.url ?? null})
      ORDER BY score DESC NULLS LAST, level DESC NULLS LAST, proposed_at DESC
      LIMIT ${filter.limit ?? DEFAULT_LIST_LIMIT}
    `;
    return rows.map(toRecord);
  }

  /** One source and everything that ever happened to it (§14, 0021). */
  async get(sourceId: string): Promise<SourceDetail | null> {
    const source = await this.find(sourceId);
    if (!source) return null;
    const rows = await this.sql<EventRow[]>`
      SELECT seq, kind, occurred_at, actor, level,
             payload ->> 'reason' AS reason,
             payload ->> 'note'   AS note
      FROM source_events WHERE source_id = ${sourceId}
      ORDER BY seq ASC
    `;
    return {
      source,
      history: rows.map((row) => ({
        seq: row.seq,
        kind: row.kind,
        occurredAt: row.occurred_at,
        actor: row.actor,
        level: row.level === null ? null : asLevel(row.level),
        reason: row.reason,
        note: row.note,
      })),
    };
  }

  /**
   * "Does this source id exist, and what level does it carry today" — the
   * question §11's `legal` gate asks of every citation (decision 6).
   *
   * Deliberately not a nullable record: `checkCitation` has to be able to tell
   * a fabricated reference from a weak one, and a caller handed `null` for both
   * cannot.
   */
  async resolve(sourceId: string): Promise<CitationSubject> {
    const source = await this.find(sourceId);
    if (!source) return { found: false };
    return { found: true, state: source.state, level: source.level };
  }

  private async find(sourceId: string): Promise<SourceRecord | null> {
    const rows = await this.sql<SourceRow[]>`SELECT * FROM sources WHERE id = ${sourceId}`;
    return rows[0] ? toRecord(rows[0]) : null;
  }

  /** The friendly half of decision 4; the schema is the half nothing evades. */
  private async require(sourceId: string): Promise<SourceRecord> {
    const source = await this.find(sourceId);
    if (!source) {
      throw new SourceRegistryError(`Die Quelle ${sourceId} steht nicht im Register.`, 'not_found');
    }
    return source;
  }

  /**
   * `COALESCE(MAX(seq), 0) + 1` inside the insert, so `UNIQUE (source_id, seq)`
   * decides a race rather than two writers both believing they appended —
   * `DeployRecords.append` and `DocumentVault` take the same bargain.
   *
   * With no rows at all this computes 1, which `source_events_proposal_is_first`
   * refuses for every kind but `proposed`: the registry cannot curate something
   * nobody proposed, whatever a caller skipped.
   */
  private async append(
    sourceId: string,
    kind: Exclude<SourceEventKind, 'proposed'>,
    actor: string,
    level: TrustLevel | null,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.sql`
      INSERT INTO source_events (source_id, seq, kind, actor, level, payload)
      SELECT ${sourceId}, COALESCE(MAX(seq), 0) + 1, ${kind}, ${actor}, ${level},
             ${this.sql.json(payload as never)}
      FROM source_events WHERE source_id = ${sourceId}
    `;
  }
}

function assertLevel(level: number): asserts level is TrustLevel {
  if (!isTrustLevel(level)) {
    throw new SourceRegistryError(
      `${level} ist keine Vertrauensstufe — §14 kennt genau L1 bis L5.`,
      'invalid_level',
    );
  }
}

/**
 * A level that came out of the database.
 *
 * The CHECK constraint keeps it in range, so this is a narrowing rather than a
 * validation — and it still throws rather than casting, because a row outside
 * §14's five would otherwise travel as a `TrustLevel` that no catalogue entry
 * matches and render as a blank chip nobody can explain.
 */
function asLevel(value: number): TrustLevel {
  if (!isTrustLevel(value)) {
    throw new SourceRegistryError(
      `Das Register enthält die Stufe ${value}, die es nach §14 nicht gibt.`,
      'invalid_level',
    );
  }
  return value;
}

function requireReason(reason: string | null | undefined, what: string): string {
  const trimmed = reason?.trim() ?? '';
  if (trimmed === '') {
    throw new SourceRegistryError(
      `${what} braucht eine Begründung — sie ist der Beleg, auf dem eine spätere ` +
        'Zitation ruht (§14).',
      'missing_reason',
    );
  }
  return trimmed;
}

function toRecord(row: SourceRow): SourceRecord {
  const state = row.state;
  /* c8 ignore next 5 */
  if (!(state in SOURCE_STATE_LABELS)) {
    throw new SourceRegistryError(
      `Das Register enthält den Zustand „${state}", den §14 nicht kennt.`,
      'not_found',
    );
  }
  return {
    id: row.id,
    url: row.url,
    documentId: row.document_id,
    title: row.title,
    assessment: row.assessment,
    proposedLevel: asLevel(row.proposed_level),
    level: row.level === null ? null : asLevel(row.level),
    state,
    stateReason: row.state_reason,
    levelReason: row.level_reason,
    proposedAt: row.proposed_at,
    proposedBy: row.proposed_by,
    curatedAt: row.curated_at,
    curatedBy: row.curated_by,
    score: row.score === null ? null : Number(row.score),
  };
}
