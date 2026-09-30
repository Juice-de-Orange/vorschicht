/**
 * §13's document vault over HTTP — upload, versions, curation, search.
 *
 * `DocumentVault` owns every rule about what a document *is*: the version
 * numbering, the department boost, the audit row per curation. `DocumentStorage`
 * owns the bytes and `TextExtractor` owns the text. Nothing here re-decides any
 * of them. What this module adds is the translation a transport needs, and that
 * translation is the whole content of the file.
 *
 *  1. **A refusal is a value, never an exception** — `projects.ts` and
 *     `inbox.ts`'s posture, and here it is load-bearing rather than tidy: there
 *     is no `app.onError` anywhere in this app, so a throw becomes a plain-text
 *     500 with an English stack behind it. Five reasons, five status codes, and
 *     each carries `errors: string[]` in German, ready to render.
 *
 *  2. **The order of the checks is the design, because two of them decide
 *     whether a byte is ever read.** The metadata and the media type are
 *     refused from the *headers and the query string*, before the body is
 *     touched; a caller who named no title has not uploaded 25 MB to find that
 *     out. The declared `content-length` is a third early refusal and is
 *     explicitly **not** the limit — it is caller-supplied and a chunked
 *     request has none, so the real cap is counted per chunk inside
 *     `DocumentStorage`.
 *
 *  3. **The bytes are written before the row, and the row is read back before
 *     it is reported.** A row pointing at a file that is not there is a
 *     document that appears to exist; bytes with no row are litter a sweep can
 *     find. So the order is fixed. And the answer is `vault.get()` rather than
 *     the record the write returned: the response then describes what is
 *     *stored*, not what was intended, and one code path produces the shape for
 *     both an upload and a new version.
 *
 *  4. **An unknown document is established by asking, never by matching an
 *     error message.** `addVersion` and `setTags` both raise a plain `Error`
 *     whose text says the document does not exist, and `inbox.ts` already
 *     records why matching on that is a trap — it breaks the first time
 *     somebody improves the wording. One `get()` up front answers it, and for
 *     `addVersion` it earns its query twice over: without it, a version for a
 *     document that does not exist would store its bytes first and orphan them.
 *
 *  5. **The actor is the session, never a default.** `DocumentVault` defaults
 *     to `'system'`, which is right for a daemon and wrong for a route: §13
 *     makes every curation audit-logged, and a trail in which every upload was
 *     made by `system` answers *that* something was uploaded and loses the
 *     question §19 keeps it for.
 *
 * The collaborators are declared structurally (A57.6): a fake then has to match
 * the real signatures, which is the drift a test of this layer exists to catch.
 */
import type {
  ByteSource,
  CreateDocumentSpec,
  DocumentDetail,
  DocumentRecord,
  DocumentSearchInput,
  DocumentSearchResult,
  DocumentVersionRecord,
  NewVersionSpec,
  SetTagsSpec,
  StoredFile,
  TextExtractor,
} from '@vorschicht/core';
import { DocumentStorageError } from '@vorschicht/core';
import {
  type DocumentHitView,
  type DocumentResponseBody,
  type DocumentSearchBody,
  type DocumentVersionView,
  type DocumentView,
  germanMetaIssues,
  isVaultMimeType,
  MAX_UPLOAD_BYTES,
  mediaType,
  parseUploadQuery,
  parseVersionQuery,
  SEARCH_QUERY,
  tagSubmission,
  VAULT_MIME_LABELS,
  VAULT_MIME_TYPES,
} from '@vorschicht/shared/dokumente';

/** Exactly the five calls this module makes — see the note on structural deps. */
export interface VaultDocuments {
  create(spec: CreateDocumentSpec, actor?: string): Promise<{ document: DocumentRecord }>;
  addVersion(
    documentId: string,
    spec: NewVersionSpec,
    actor?: string,
  ): Promise<DocumentVersionRecord>;
  setTags(documentId: string, spec: SetTagsSpec, actor?: string): Promise<DocumentRecord>;
  get(documentId: string): Promise<DocumentDetail | null>;
  search(input: DocumentSearchInput): Promise<DocumentSearchResult>;
}

/** The one call this module makes on the docs volume. */
export interface VaultStorage {
  store(source: ByteSource): Promise<StoredFile>;
}

export interface DokumenteDeps {
  vault: VaultDocuments;
  storage: VaultStorage;
  /**
   * Required, not optional.
   *
   * An absent extractor and a file type nothing can read would otherwise be the
   * same observable state — a version with `extractedText: null` — and only the
   * second is intended. One of them means "come back when there is a parser";
   * the other means somebody forgot to wire this deployment, and a search that
   * finds nothing would be the only symptom.
   */
  extractor: TextExtractor;
}

/**
 * Five outcomes, five status codes.
 *
 * `too_large` and `unsupported_media` are 413 and 415 rather than this house's
 * usual 422, and the distinction is the house rule's own wording: 422 is for a
 * body that *parsed* and a rule that then declined it. Neither of these ever
 * parsed a body — one refuses the envelope from a header, the other stops
 * mid-stream — and HTTP names both cases exactly. `failed` is a 500 with a
 * German sentence rather than a throw, so an unwritable volume reads as a
 * server fault that says what happened instead of a naked stack.
 */
export type VaultResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'invalid'; errors: string[] }
  | { ok: false; reason: 'unsupported_media'; errors: string[] }
  | { ok: false; reason: 'too_large'; errors: string[] }
  | { ok: false; reason: 'unknown'; errors: string[] }
  | { ok: false; reason: 'failed'; errors: string[] };

export interface UploadRequest {
  /** The upload's metadata (`UPLOAD_QUERY`). */
  params: URLSearchParams;
  contentType: string | null;
  /** A hint, refused early when it is obviously too big. Never the limit. */
  contentLength: string | null;
  body: ByteSource | null;
  actor: string;
}

const UNKNOWN_DOCUMENT = 'Dokument nicht gefunden';

/**
 * A document id, or null.
 *
 * Strict on purpose. `documents.id` is a uuid, and a path segment that is not
 * one names nothing — so answering 404 here keeps a malformed URL from reaching
 * Postgres, where it would raise `invalid input syntax for type uuid` and
 * surface as a 500 for what is a caller's typo. `parseItemNumber` in `app.ts`
 * refuses the inbox's numbers for the same reason.
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isDocumentId(raw: string | undefined): raw is string {
  return typeof raw === 'string' && UUID.test(raw);
}

// --- upload ------------------------------------------------------------------

/** §13's upload: a new document with its first version. */
export async function uploadDocument(
  deps: DokumenteDeps,
  request: UploadRequest,
): Promise<VaultResult<DocumentResponseBody>> {
  const meta = parseUploadQuery(request.params);
  if (!meta.ok) return { ok: false, reason: 'invalid', errors: meta.errors };

  const envelope = checkEnvelope(request);
  if (envelope) return envelope;

  const stored = await store(deps, request.body);
  if (!stored.ok) return stored;

  const version = await describeUpload(deps, stored.value, meta.meta.filename, request.contentType);
  if (!version.ok) return version;

  let documentId: string;
  try {
    const created = await deps.vault.create(
      {
        title: meta.meta.title,
        departmentTags: meta.meta.departmentTags,
        tags: meta.meta.tags,
        version: version.value,
      } satisfies CreateDocumentSpec,
      request.actor,
    );
    documentId = created.document.id;
  } catch {
    return {
      ok: false,
      reason: 'failed',
      errors: [
        'Die Datei liegt im Dokumentenspeicher, aber der Eintrag konnte nicht angelegt werden. ' +
          'Bitte noch einmal versuchen.',
      ],
    };
  }

  return readBack(deps, documentId);
}

/** §13's versions: another upload onto a document that already exists. */
export async function addDocumentVersion(
  deps: DokumenteDeps,
  documentId: string,
  request: UploadRequest,
): Promise<VaultResult<DocumentResponseBody>> {
  if (!isDocumentId(documentId)) {
    return { ok: false, reason: 'unknown', errors: [UNKNOWN_DOCUMENT] };
  }

  const meta = parseVersionQuery(request.params);
  if (!meta.ok) return { ok: false, reason: 'invalid', errors: meta.errors };

  const envelope = checkEnvelope(request);
  if (envelope) return envelope;

  // Decision 4: asked *before* anything is stored, so a version for a document
  // that does not exist cannot leave its bytes behind on the way to a 404.
  if (!(await deps.vault.get(documentId))) {
    return { ok: false, reason: 'unknown', errors: [UNKNOWN_DOCUMENT] };
  }

  const stored = await store(deps, request.body);
  if (!stored.ok) return stored;

  const version = await describeUpload(deps, stored.value, meta.meta.filename, request.contentType);
  if (!version.ok) return version;

  try {
    await deps.vault.addVersion(documentId, version.value, request.actor);
  } catch {
    return {
      ok: false,
      reason: 'failed',
      errors: [
        'Die Datei liegt im Dokumentenspeicher, aber die neue Version konnte nicht ' +
          'eingetragen werden. Bitte noch einmal versuchen.',
      ],
    };
  }

  return readBack(deps, documentId);
}

// --- curation and reading ----------------------------------------------------

/** §13's curation flow. Every change is audit-logged by the vault. */
export async function setDocumentTags(
  deps: DokumenteDeps,
  documentId: string,
  input: unknown,
  actor: string,
): Promise<VaultResult<DocumentResponseBody>> {
  if (!isDocumentId(documentId)) {
    return { ok: false, reason: 'unknown', errors: [UNKNOWN_DOCUMENT] };
  }

  const parsed = tagSubmission.safeParse(isPlainObject(input) ? input : {});
  if (!parsed.success) {
    return { ok: false, reason: 'invalid', errors: germanMetaIssues(parsed.error.issues) };
  }
  if (parsed.data.departmentTags === undefined && parsed.data.tags === undefined) {
    return {
      ok: false,
      reason: 'invalid',
      errors: ['Es wurde nichts geändert — gib Abteilungs-Schlagworte oder Schlagworte an.'],
    };
  }

  if (!(await deps.vault.get(documentId))) {
    return { ok: false, reason: 'unknown', errors: [UNKNOWN_DOCUMENT] };
  }

  // Built key by key rather than spread: `setTags` reads an **absent** key as
  // "leave this tag kind alone", so a present key holding `undefined` would be
  // a third state the vault does not have a meaning for. `exactOptionalPropertyTypes`
  // is what makes that a compile error rather than a subtlety.
  const spec: SetTagsSpec = {
    ...(parsed.data.departmentTags === undefined
      ? {}
      : { departmentTags: parsed.data.departmentTags }),
    ...(parsed.data.tags === undefined ? {} : { tags: parsed.data.tags }),
  };
  await deps.vault.setTags(documentId, spec, actor);
  return readBack(deps, documentId);
}

/** One document with its whole version history, newest first. */
export async function getDocument(
  deps: DokumenteDeps,
  documentId: string,
): Promise<VaultResult<DocumentResponseBody>> {
  if (!isDocumentId(documentId)) {
    return { ok: false, reason: 'unknown', errors: [UNKNOWN_DOCUMENT] };
  }
  return readBack(deps, documentId);
}

/**
 * §13's search, with the asking department's own documents boosted.
 *
 * An empty query is refused rather than answered with an empty list. The vault
 * would happily return zero hits — `websearch_to_tsquery('german', '')` matches
 * nothing — and "0 Treffer" over a full vault is the least useful true sentence
 * available.
 */
export async function searchDocuments(
  deps: DokumenteDeps,
  params: URLSearchParams,
): Promise<VaultResult<DocumentSearchBody>> {
  const query = (params.get(SEARCH_QUERY.query) ?? '').trim();
  if (query === '') {
    return { ok: false, reason: 'invalid', errors: ['Die Suche braucht einen Suchbegriff.'] };
  }
  const department = (params.get(SEARCH_QUERY.department) ?? '').trim() || null;

  const result = await deps.vault.search({ query, department });
  return {
    ok: true,
    value: {
      dokumente: result.hits.map(
        (hit): DocumentHitView => ({
          document: toDocumentView(hit.document),
          versionId: hit.versionId,
          version: hit.version,
          rank: hit.rank,
          departmentMatch: hit.departmentMatch,
          score: hit.score,
        }),
      ),
      nochNichtDurchsuchbar: result.pendingDocuments,
    },
  };
}

// --- the steps the two upload paths share ------------------------------------

/**
 * Everything that can be refused without reading a byte.
 *
 * Returns the refusal or nothing, so both callers run the same three checks in
 * the same order rather than each remembering to.
 */
function checkEnvelope(request: UploadRequest): VaultResult<never> | null {
  const type = mediaType(request.contentType);
  if (!isVaultMimeType(type)) {
    return {
      ok: false,
      reason: 'unsupported_media',
      errors: [
        `Dieser Dateityp wird nicht angenommen${type ? ` (${type})` : ''}. ` +
          `Erlaubt sind: ${VAULT_MIME_TYPES.map((mime) => VAULT_MIME_LABELS[mime]).join(', ')}.`,
      ],
    };
  }

  const declared = Number(request.contentLength);
  if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
    return { ok: false, reason: 'too_large', errors: [tooLarge()] };
  }

  if (!request.body) {
    return { ok: false, reason: 'invalid', errors: ['Es wurden keine Daten übertragen.'] };
  }
  return null;
}

async function store(
  deps: DokumenteDeps,
  body: ByteSource | null,
): Promise<VaultResult<StoredFile>> {
  if (!body) {
    return { ok: false, reason: 'invalid', errors: ['Es wurden keine Daten übertragen.'] };
  }
  try {
    return { ok: true, value: await deps.storage.store(body) };
  } catch (error) {
    if (error instanceof DocumentStorageError && error.kind === 'too_large') {
      return { ok: false, reason: 'too_large', errors: [tooLarge()] };
    }
    return {
      ok: false,
      reason: 'failed',
      errors: ['Die Datei konnte nicht im Dokumentenspeicher abgelegt werden.'],
    };
  }
}

/**
 * The version spec, text and all.
 *
 * Extraction runs here — after the bytes are on disk and before the row exists
 * — because `document_versions` is append-only and the guard binds the owner
 * too, so there is no later moment at which text could be added (migration
 * 0020, decision 5).
 *
 * A failing extractor is a **result, not a throw**, and that is not
 * theoretical: it was found by mutation. With `DocumentStorage`'s rename
 * removed, `PlainTextExtractor` opened a file that was not there, the `ENOENT`
 * travelled out of the route, and Hono answered `Internal Server Error` as
 * plain text — the naked 500 this module's header promises never happens.
 *
 * Deliberately *not* degraded into `extractedText: null`: that value means "no
 * parser can read this kind of file", and reporting a filesystem fault as a PDF
 * would put a permanently unsearchable document in the vault with nothing
 * anywhere saying why.
 */
async function describeUpload(
  deps: DokumenteDeps,
  stored: StoredFile,
  filename: string,
  contentType: string | null,
): Promise<VaultResult<NewVersionSpec>> {
  const mimeType = mediaType(contentType);
  let extractedText: string | null;
  try {
    extractedText = await deps.extractor.extract({
      absolutePath: stored.absolutePath,
      mimeType,
      filename,
    });
  } catch {
    return {
      ok: false,
      reason: 'failed',
      errors: ['Die Datei konnte nach dem Ablegen nicht gelesen werden.'],
    };
  }
  return {
    ok: true,
    value: {
      filename,
      storagePath: stored.storagePath,
      mimeType,
      byteSize: stored.byteSize,
      checksum: stored.checksum,
      extractedText,
    },
  };
}

/**
 * The answer, read back from the database rather than assembled from the write.
 *
 * One code path for the upload, the new version, the re-tagging and the detail
 * page — so the four cannot describe one document four ways — and the response
 * is a statement about what is *stored*.
 */
async function readBack(
  deps: DokumenteDeps,
  documentId: string,
): Promise<VaultResult<DocumentResponseBody>> {
  const detail = await deps.vault.get(documentId);
  if (!detail) return { ok: false, reason: 'unknown', errors: [UNKNOWN_DOCUMENT] };
  return {
    ok: true,
    value: {
      dokument: {
        document: toDocumentView(detail.document),
        versions: detail.versions.map(toVersionView),
      },
    },
  };
}

function tooLarge(): string {
  const megabytes = Math.floor(MAX_UPLOAD_BYTES / (1024 * 1024));
  return `Die Datei ist zu groß — höchstens ${megabytes} MB.`;
}

// --- views -------------------------------------------------------------------

function toDocumentView(record: DocumentRecord): DocumentView {
  return {
    id: record.id,
    title: record.title,
    departmentTags: record.departmentTags,
    tags: record.tags,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

function toVersionView(record: DocumentVersionRecord): DocumentVersionView {
  return {
    id: record.id,
    documentId: record.documentId,
    version: record.version,
    filename: record.filename,
    mimeType: record.mimeType,
    byteSize: record.byteSize,
    checksum: record.checksum,
    // The text itself never travels; its length does, and it keeps the
    // distinction the data layer is careful about — `null` is "not read yet",
    // `0` is "read, and there was nothing".
    extractedChars: record.extractedText === null ? null : record.extractedText.length,
    uploadedAt: record.uploadedAt.toISOString(),
    uploadedBy: record.uploadedBy,
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
