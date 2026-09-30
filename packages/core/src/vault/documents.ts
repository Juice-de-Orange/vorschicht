/**
 * The document vault's data layer (§13, §5, migration 0020).
 *
 * §13 gives this component four jobs and one property. The jobs: hold the
 * metadata and the tags, keep an append-only version per upload, let every
 * department search the whole vault, and rank a department's own documents
 * higher. The property: agents read, and every write is audit-logged, because
 * "writes only through the dashboard or Doris's curation flow with audit log"
 * is the sentence that makes the vault trustworthy as a cross-project
 * knowledge channel rather than a place anything can quietly edit.
 *
 * Five decisions that are this module's rather than the schema's.
 *
 *   1. **The ranking is a boost, not a filter, and the size of the boost had
 *      to be measured rather than chosen** (§13: "ranking *boosts* documents
 *      tagged for the requesting department"; §14 says the same of curated
 *      sources — "weighted reference works, not restrictions"). A search by
 *      the legal department returns every match in the vault and merely puts
 *      its own first.
 *
 *      The first version used a factor of 2, on the reasoning that a document
 *      twice as relevant should still win. That reasoning is wrong about
 *      `ts_rank`, and the test written to prove the boost is not a tier is
 *      what said so: measured on this Postgres, a single-term query ranks a
 *      document with one occurrence at 0.0608 and one with forty at 0.0985 —
 *      the entire span is a factor of **1.62**. Any multiplier at or above
 *      that makes a department tag decisive for every single-term search
 *      whatever the text says, which is a tier wearing a boost's clothes and
 *      is exactly the failure mode §13 avoids: a barely-relevant Recht-tagged
 *      note above the document that answers the question.
 *
 *      The single-term case is the one that constrains the factor because it
 *      is the narrowest: the same measurement puts a two-term AND query's
 *      span at 7.55 and an OR query's at 3.24, so a multiplier that is a
 *      thumb on the scale for one word is a lighter one for two.
 *
 *      So `DEPARTMENT_BOOST` is 1.2 — the tag decides where the texts are
 *      within 20% of each other and loses where they are not. Multiplicative
 *      rather than additive deliberately, for the same reason: with the scale
 *      moving by a factor of five between query shapes, a constant added here
 *      would be decisive for one and invisible for another.
 *
 *   2. **Every hit carries its `rank` and its `score` separately.** The one is
 *      what Postgres thought of the text, the other is what this module did to
 *      it. Returning only the final order would make "did the boost decide
 *      this, or did the text?" unanswerable from outside — including for the
 *      test that has to prove the boost is what orders two equally relevant
 *      documents, which is the assertion the Phase 6 exit gate names.
 *
 *   3. **A search answer says how much of the vault it could not see.**
 *      Extraction is a later block, so a version can exist with no text at all,
 *      and a document whose versions all lack text is invisible to full-text
 *      search. Reporting "0 Treffer" over such a vault is true and misleading;
 *      `pendingDocuments` is the difference between "nothing matches" and
 *      "nothing has been read yet".
 *
 *   4. **`extractedText` is an argument to the write, never a later update.**
 *      `document_versions` is append-only and its guard binds the owner too, so
 *      there is no code path — here or anywhere — that fills text into a row
 *      that already exists. Extraction therefore runs before `create` /
 *      `addVersion` is called and hands the result in. The header of migration
 *      0020 (decision 5) carries the consequence for whoever builds the
 *      extractor, including the shape that fits if it has to be asynchronous.
 *
 *   5. **Nothing here reads a file.** The vault stores a path under the docs
 *      volume and never resolves it; the upload route owns the bytes. That
 *      keeps this module testable against nothing but a database, and it keeps
 *      the one component that could read outside the volume out of the layer
 *      that stores the paths.
 */
import type postgres from 'postgres';

/**
 * How much a department tag is worth (§13, decision 1).
 *
 * Exported so the ranking test and the ordering below quote one number rather
 * than two that can drift. The value is bounded from above by the measurement
 * in decision 1 and the bound is *tested*: the "boost is not a tier" case puts
 * a tagged document with one match against an untagged one with six, which is
 * a ranking gap of 1.49 — so anything at or above that turns it red rather
 * than quietly restoring the tier.
 */
export const DEPARTMENT_BOOST = 1.2;

export interface DocumentRecord {
  id: string;
  title: string;
  /** §8's German department labels — which departments this serves best (§13). */
  departmentTags: string[];
  /** §13's free tags. */
  tags: string[];
  createdAt: Date;
  /** When the *curation* last changed. Adding a version does not touch it. */
  updatedAt: Date;
}

export interface DocumentVersionRecord {
  id: string;
  documentId: string;
  version: number;
  filename: string;
  mimeType: string | null;
  byteSize: number | null;
  checksum: string | null;
  /** Relative to the docs volume (A2) — never an absolute path. */
  storagePath: string;
  /**
   * §13's extracted text, or `null` when nobody has read the file yet.
   *
   * `null` and `''` are different answers: the second means a parser ran and
   * found nothing, which is a real result for a scan with no text layer.
   */
  extractedText: string | null;
  uploadedAt: Date;
  uploadedBy: string;
}

export interface NewVersionSpec {
  filename: string;
  /** Relative to the docs volume (A2). Refused by the schema if absolute. */
  storagePath: string;
  mimeType?: string | null;
  byteSize?: number | null;
  checksum?: string | null;
  /** Decision 4: supplied at write time or never. */
  extractedText?: string | null;
  uploadedBy?: string;
}

export interface CreateDocumentSpec {
  title: string;
  departmentTags?: string[];
  tags?: string[];
  /** §13: a document arrives *with* its first upload. */
  version: NewVersionSpec;
  id?: string;
}

export interface DocumentWithVersion {
  document: DocumentRecord;
  version: DocumentVersionRecord;
}

export interface DocumentDetail {
  document: DocumentRecord;
  /** Newest first. */
  versions: DocumentVersionRecord[];
}

export interface SetTagsSpec {
  departmentTags?: string[];
  tags?: string[];
}

export interface DocumentSearchInput {
  query: string;
  /** The asking department (§8's German label). Absent = no boost, same hits. */
  department?: string | null;
  limit?: number;
}

export interface DocumentSearchHit {
  document: DocumentRecord;
  /** The version whose text matched — the best one, when several did. */
  versionId: string;
  version: number;
  /** What Postgres thought of the text alone. */
  rank: number;
  /** Whether the asking department is among this document's department tags. */
  departmentMatch: boolean;
  /** `rank`, boosted (decision 1). What the ordering is by. */
  score: number;
}

export interface DocumentSearchResult {
  hits: DocumentSearchHit[];
  /**
   * Documents with no extracted version at all — decision 3. They cannot match
   * any query, so a hit count without this number reads as "not in the vault"
   * when it means "not read yet".
   */
  pendingDocuments: number;
}

interface DocumentRow {
  id: string;
  title: string;
  department_tags: string[];
  tags: string[];
  created_at: Date;
  updated_at: Date;
}

interface VersionRow {
  id: string;
  document_id: string;
  version: number;
  filename: string;
  mime_type: string | null;
  byte_size: string | number | null;
  checksum: string | null;
  storage_path: string;
  extracted_text: string | null;
  uploaded_at: Date;
  uploaded_by: string;
}

interface SearchRow extends DocumentRow {
  version_id: string;
  version: number;
  rank: number;
  department_match: boolean;
  score: number;
}

const DEFAULT_SEARCH_LIMIT = 20;

/**
 * Reader and writer for §13's vault.
 *
 * Takes the pool rather than `Queryable`: creating a document is two inserts
 * and an audit row that have to be one act, and `sql.begin()` is only on the
 * pool (see `sql.ts` for why the two types do not unify).
 */
export class DocumentVault {
  constructor(private readonly sql: postgres.Sql) {}

  /** §13's upload: metadata plus the first version, in one transaction. */
  async create(spec: CreateDocumentSpec, actor = 'system'): Promise<DocumentWithVersion> {
    const departmentTags = cleanTags(spec.departmentTags);
    const tags = cleanTags(spec.tags);
    const version = spec.version;

    return this.sql.begin(async (tx) => {
      const [documentRow] = await tx<DocumentRow[]>`
        INSERT INTO documents (
          ${spec.id ? tx`id,` : tx``}
          title, department_tags, tags
        ) VALUES (
          ${spec.id ? tx`${spec.id},` : tx``}
          ${spec.title}, ${departmentTags}::text[], ${tags}::text[]
        )
        RETURNING id, title, department_tags, tags, created_at, updated_at
      `;
      if (!documentRow) throw new Error('Dokument konnte nicht angelegt werden');

      const versionRow = await insertVersion(tx, documentRow.id, version, actor);
      const document = toDocument(documentRow);
      const created = toVersion(versionRow);
      await audit(tx, actor, 'document.created', document.id, null, {
        document,
        version: forAudit(created),
      });
      return { document, version: created };
    });
  }

  /**
   * Append the next version of an existing document (§13).
   *
   * The number is `max(version) + 1` computed in the same statement that
   * inserts, so `UNIQUE (document_id, version)` decides a race rather than two
   * writers both believing they appended — `DeployRecords.append` takes the
   * same bargain one subsystem over, and for the same reason: one writer today
   * is a fact about today.
   */
  async addVersion(
    documentId: string,
    spec: NewVersionSpec,
    actor = 'system',
  ): Promise<DocumentVersionRecord> {
    return this.sql.begin(async (tx) => {
      const document = await loadDocument(tx, documentId);
      if (!document) throw new Error(`Dokument ${documentId} existiert nicht`);

      const row = await insertVersion(tx, documentId, spec, actor);
      const version = toVersion(row);
      await audit(tx, actor, 'document.version_added', documentId, null, {
        version: forAudit(version),
      });
      return version;
    });
  }

  /**
   * Re-tag a document (§13's curation), audit-logged.
   *
   * A call that changes nothing writes nothing — `ProjectService.setReadOnly`'s
   * precedent. An audit row per no-op would be noise in the one trail §19 keeps
   * so that a real change is findable.
   */
  async setTags(documentId: string, spec: SetTagsSpec, actor = 'system'): Promise<DocumentRecord> {
    return this.sql.begin(async (tx) => {
      const before = await loadDocument(tx, documentId);
      if (!before) throw new Error(`Dokument ${documentId} existiert nicht`);

      const departmentTags =
        spec.departmentTags === undefined ? before.departmentTags : cleanTags(spec.departmentTags);
      const tags = spec.tags === undefined ? before.tags : cleanTags(spec.tags);
      if (same(before.departmentTags, departmentTags) && same(before.tags, tags)) return before;

      const [row] = await tx<DocumentRow[]>`
        UPDATE documents
        SET department_tags = ${departmentTags}::text[],
            tags = ${tags}::text[],
            updated_at = now()
        WHERE id = ${documentId}
        RETURNING id, title, department_tags, tags, created_at, updated_at
      `;
      if (!row) throw new Error(`Dokument ${documentId} existiert nicht`);

      const after = toDocument(row);
      await audit(tx, actor, 'document.tags_changed', documentId, before, after);
      return after;
    });
  }

  /** One document with its whole version history, newest first. */
  async get(documentId: string): Promise<DocumentDetail | null> {
    const document = await loadDocument(this.sql, documentId);
    if (!document) return null;
    const rows = await this.sql<VersionRow[]>`
      SELECT ${versionColumns(this.sql)}
      FROM document_versions WHERE document_id = ${documentId}
      ORDER BY version DESC
    `;
    return { document, versions: rows.map(toVersion) };
  }

  /**
   * §13's search: full text over every version, documents ranked with the
   * asking department's own boosted (decision 1).
   *
   * `websearch_to_tsquery` rather than `to_tsquery`: it takes what a person
   * types — quoted phrases, `or`, a leading `-` — and never raises on syntax,
   * which `to_tsquery` does on so ordinary an input as a bare hyphen. A search
   * box that can throw is a search box that throws.
   *
   * `DISTINCT ON` collapses a document that matched in several versions to its
   * best one, so the answer is a list of documents rather than a list of
   * uploads; `version` says which one carried the hit.
   *
   * The final tie-break is the document's insertion order, newest first. It is
   * deliberately total and knowable from outside: without it two equally
   * relevant documents come back in whatever order the planner produced, and
   * an assertion that the tagged one comes first would pass without the boost
   * having done anything.
   */
  async search(input: DocumentSearchInput): Promise<DocumentSearchResult> {
    const department = input.department?.trim() || null;
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;

    const rows = await this.sql<SearchRow[]>`
      WITH ask AS (
        SELECT websearch_to_tsquery('german', ${input.query}) AS query
      ),
      best AS (
        SELECT DISTINCT ON (v.document_id)
               v.document_id,
               v.id                      AS version_id,
               v.version,
               ts_rank(v.fts, ask.query) AS rank
        FROM document_versions v, ask
        WHERE v.fts @@ ask.query
        ORDER BY v.document_id, ts_rank(v.fts, ask.query) DESC, v.version DESC
      )
      SELECT d.id, d.title, d.department_tags, d.tags, d.created_at, d.updated_at,
             b.version_id, b.version, b.rank,
             m.department_match,
             b.rank * CASE WHEN m.department_match
                           THEN ${DEPARTMENT_BOOST}::real
                           ELSE 1::real END AS score
      FROM best b
      JOIN documents d ON d.id = b.document_id
      CROSS JOIN LATERAL (
        SELECT (
          ${department}::text IS NOT NULL
          AND d.department_tags @> ARRAY[${department}]::text[]
        ) AS department_match
      ) m
      ORDER BY score DESC, d.seq DESC
      LIMIT ${limit}
    `;

    // Decision 3. Counted over the whole vault rather than over the hits,
    // because the documents it is about are precisely the ones that could not
    // become hits.
    const [pending] = await this.sql<{ pending: number }[]>`
      SELECT count(*)::int AS pending
      FROM documents d
      WHERE NOT EXISTS (
        SELECT 1 FROM document_versions v
        WHERE v.document_id = d.id AND v.extracted_text IS NOT NULL
      )
    `;

    return {
      hits: rows.map((row) => ({
        document: toDocument(row),
        versionId: row.version_id,
        version: row.version,
        rank: row.rank,
        departmentMatch: row.department_match,
        score: row.score,
      })),
      pendingDocuments: pending?.pending ?? 0,
    };
  }
}

/**
 * `fts` is deliberately absent from every read.
 *
 * It is a lexeme vector of the whole document — for a contract that is tens of
 * kilobytes nobody downstream can use, on every row of every listing. It exists
 * to be indexed, not to be selected.
 */
function versionColumns(sql: postgres.Sql | postgres.TransactionSql) {
  return sql`
    id, document_id, version, filename, mime_type, byte_size, checksum,
    storage_path, extracted_text, uploaded_at, uploaded_by
  `;
}

/**
 * One insert path for the first version and for every later one.
 *
 * The number is always `COALESCE(MAX(version), 0) + 1` computed inside the
 * statement — which is 1 for a document that has none, so the first version
 * needs no special case and there is no second place the numbering could be
 * decided differently.
 */
async function insertVersion(
  tx: postgres.TransactionSql,
  documentId: string,
  spec: NewVersionSpec,
  actor: string,
): Promise<VersionRow> {
  const [row] = await tx<VersionRow[]>`
    INSERT INTO document_versions (
      document_id, version, filename, mime_type, byte_size, checksum,
      storage_path, extracted_text, uploaded_by
    )
    SELECT ${documentId}, COALESCE(MAX(version), 0) + 1, ${spec.filename},
           ${spec.mimeType ?? null}, ${spec.byteSize ?? null}, ${spec.checksum ?? null},
           ${spec.storagePath}, ${spec.extractedText ?? null}, ${spec.uploadedBy ?? actor}
    FROM document_versions WHERE document_id = ${documentId}
    RETURNING ${versionColumns(tx)}
  `;
  if (!row) throw new Error('Dokumentversion konnte nicht angelegt werden');
  return row;
}

async function loadDocument(
  sql: postgres.Sql | postgres.TransactionSql,
  documentId: string,
): Promise<DocumentRecord | null> {
  const rows = await sql<DocumentRow[]>`
    SELECT id, title, department_tags, tags, created_at, updated_at
    FROM documents WHERE id = ${documentId}
  `;
  return rows[0] ? toDocument(rows[0]) : null;
}

async function audit(
  tx: postgres.TransactionSql,
  actor: string,
  action: string,
  subject: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await tx`
    INSERT INTO audit_log (actor, action, subject, before, after)
    VALUES (
      ${actor}, ${action}, ${subject},
      ${before == null ? null : tx.json(before as postgres.JSONValue)},
      ${after == null ? null : tx.json(after as postgres.JSONValue)}
    )
  `;
}

/**
 * What a version looks like in `audit_log` — everything except its text.
 *
 * A53.6 capped assistant prose at 8 KB per message for a reason that applies
 * here with more force: the audit log is append-only, its guard binds the owner
 * too, and §18 says never delete — so a contract copied into it is in this
 * database for as long as the database exists, and no later decision can take
 * it back out. §13's corpus is Statuten, AVVs and Verträge, which is exactly
 * the material a DSGVO review (§11, Lena) would rather not find duplicated into
 * an undeletable table.
 *
 * Nothing is lost by leaving it out: `document_versions` is itself append-only,
 * so the text is already recorded immutably, and what §13's "with audit log"
 * needs from this row is *who did what to which version*. The length is kept
 * because "a version arrived with 40 000 characters of text" and "a version
 * arrived with none" are different events, and that difference is the one thing
 * the identifiers alone cannot say.
 */
function forAudit(version: DocumentVersionRecord) {
  const { extractedText, ...rest } = version;
  return { ...rest, extractedTextChars: extractedText === null ? null : extractedText.length };
}

/**
 * Trim, drop the empties, keep the first of each duplicate.
 *
 * Order is preserved rather than sorted: a curator who lists the department a
 * document serves best first has said something, and sorting would throw it
 * away. The schema refuses NULL and empty elements as a second layer, so this
 * is convenience rather than the guarantee.
 */
function cleanTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const tag = (raw ?? '').trim();
    if (tag === '' || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

function same(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function toDocument(row: DocumentRow): DocumentRecord {
  return {
    id: row.id,
    title: row.title,
    departmentTags: row.department_tags ?? [],
    tags: row.tags ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toVersion(row: VersionRow): DocumentVersionRecord {
  return {
    id: row.id,
    documentId: row.document_id,
    version: row.version,
    filename: row.filename,
    mimeType: row.mime_type,
    byteSize: row.byte_size === null ? null : Number(row.byte_size),
    checksum: row.checksum,
    storagePath: row.storage_path,
    extractedText: row.extracted_text,
    uploadedAt: row.uploaded_at,
    uploadedBy: row.uploaded_by,
  };
}
