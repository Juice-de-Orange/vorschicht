/**
 * The wire between the dashboard and the API for §13's document vault.
 *
 * Same arrangement as `./inbox.ts`, and it exists for the reason that one does:
 * two independent declarations of one JSON document is the defect (A81). The
 * producer in `apps/server` is type-checked *from* these schemas and the
 * dashboard **parses** rather than casts, so a renamed field breaks the build on
 * one side and renders a German sentence on the other, instead of `undefined`
 * in the DOM.
 *
 * Browser-safe by construction: only `zod` is imported. The barrel re-exports
 * `worktree.js` and `containment.js`, which pull `node:path`, so the dashboard
 * reaches this through the `@vorschicht/shared/dokumente` subpath the way it
 * already reaches `./gates` and `./inbox` (A75.5).
 *
 * **German envelope keys, English fields** — the rule `./inbox.ts` states and
 * `/api/projekte` already followed. A JSON key is read by a program; the text a
 * person reads is German everywhere (§2), and on these payloads it already is:
 * every refusal below, and every label the page puts on them.
 *
 * ---
 *
 * **Why an upload is a raw body and not a multipart form.**
 *
 * The obvious build is `multipart/form-data` and `c.req.parseBody()`. It was not
 * taken, and the reason is the size limit rather than taste. `parseBody()`
 * buffers the **whole** request in memory before any line of ours sees a byte,
 * and it takes no cap — so a limit written after it is a limit that fires after
 * the damage, on a dashboard §2 makes publicly reachable. There is no body-size
 * middleware anywhere in this repository, so this is the precedent rather than a
 * deviation from one.
 *
 * So the file *is* the body: `c.req.raw.body` is a stream, the cap is enforced
 * per chunk, the bytes go to disk as they arrive and the process never holds the
 * document. What that costs is the form — there is no multipart envelope to
 * carry the metadata, so the title, the filename and the tags travel in the
 * query string and the type travels in `content-type`. Stated here rather than
 * in a commit message, because it is what the page has to send:
 *
 *     fetch(uploadUrl(meta), {
 *       method: 'POST',
 *       body: file,
 *       headers: { 'content-type': file.type },
 *     })
 *
 * — a `File`, not a `FormData`.
 *
 * The query keys are built and parsed by two functions in this module rather
 * than by two string literals in two packages. That is the smallest possible
 * version of A81.3: `inboxUrl` built `/inbox/<n>` while the router answered
 * `/posteingang`, and every deep link in every notification landed on the
 * overview because one literal existed twice.
 */
import { z } from 'zod';

// --- limits the page shares with the route -----------------------------------

/**
 * The largest upload, enforced by the route and re-checked by the page.
 *
 * On the wire rather than in the server alone because a page that knows the
 * number can refuse a 60 MB file *before* spending a minute pushing it up a
 * domestic uplink, and say so in German. The route never trusts that: the cap is
 * enforced per chunk against the bytes that actually arrive, because
 * `content-length` is supplied by the caller and a chunked request has none.
 *
 * 25 MiB is sized for §13's corpus — Statuten, AVVs, Verträge, the occasional
 * scanned PDF — and against A30's disk watch, which is what would notice if it
 * were ever wrong.
 */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

/**
 * What may be uploaded (§13's "binary stored on the docs volume").
 *
 * An allowlist, not a blocklist, and deliberately three entries long. Every
 * addition is two decisions rather than one: whether the vault should hold that
 * kind of file, and what `TextExtractor` does with it — because a type that is
 * accepted and never readable is a document that sits in the vault invisible to
 * §13's search forever. Today `application/pdf` is exactly that case, and it is
 * admitted knowingly: a search answer reports how many documents have not been
 * read yet (`nochNichtDurchsuchbar`), so "not readable yet" is a number on the
 * page rather than an empty result set that reads as "not in the vault".
 */
export const VAULT_MIME_TYPES = ['application/pdf', 'text/plain', 'text/markdown'] as const;
export type VaultMimeType = (typeof VAULT_MIME_TYPES)[number];

/** German (§2) — what the page puts in a file picker and in a refusal. */
export const VAULT_MIME_LABELS: Record<VaultMimeType, string> = {
  'application/pdf': 'PDF',
  'text/plain': 'Textdatei',
  'text/markdown': 'Markdown',
};

export const MAX_DOCUMENT_TITLE_LENGTH = 300;
export const MAX_DOCUMENT_FILENAME_LENGTH = 255;
export const MAX_DOCUMENT_TAG_LENGTH = 100;
export const MAX_DOCUMENT_TAGS = 20;

/**
 * A `content-type` reduced to its media type, lower-cased, or null.
 *
 * `text/plain; charset=utf-8` and `TEXT/PLAIN` are the same type and both have
 * to pass the allowlist; a comparison against the raw header would accept the
 * second spelling and refuse the first, which is the wrong way round for a
 * browser that always sends the parameter.
 */
export function mediaType(header: string | null | undefined): string | null {
  if (!header) return null;
  const value = header.split(';', 1)[0]?.trim().toLowerCase();
  return value ? value : null;
}

export function isVaultMimeType(value: string | null): value is VaultMimeType {
  return value !== null && (VAULT_MIME_TYPES as readonly string[]).includes(value);
}

// --- the views ---------------------------------------------------------------

/**
 * One document's identity and curation (§13).
 *
 * One schema, three uses — the upload answer, the detail page and a search hit
 * all carry it. That is why a hit nests it rather than flattening `id`/`title`
 * beside `rank`: a flattened hit would be a second declaration of "what a
 * document is", which is the thing this module exists to prevent.
 */
export const documentView = z.object({
  id: z.string(),
  title: z.string(),
  /** §8's German department labels — which departments this serves best (§13). */
  departmentTags: z.array(z.string()),
  /** §13's free tags. */
  tags: z.array(z.string()),
  /** ISO 8601. */
  createdAt: z.string(),
  /** When the *curation* last changed. Adding a version does not touch it. */
  updatedAt: z.string(),
});
export type DocumentView = z.infer<typeof documentView>;

/**
 * One upload (§13: "versions are append-only").
 *
 * Two things deliberately do **not** travel.
 *
 * `extractedText` itself: it is the whole document, it would be sent on every
 * listing, and §13's corpus is exactly the material a DSGVO review would rather
 * not see copied into more places than it has to be. `DocumentVault`'s
 * `forAudit` made the same call for `audit_log`, one layer down. What travels
 * instead is `extractedChars`, and it keeps the distinction the data layer is
 * careful about: `null` means nobody has read the file yet, `0` means a parser
 * ran and found nothing — a scan with no text layer is a real and different
 * answer.
 *
 * `storagePath`: a path under the docs volume answers no question a page has,
 * and `ProjectSettingsView` already drops `gitAccessRef` for the same reason
 * (§19). A later download route addresses a version by its id.
 */
export const documentVersionView = z.object({
  id: z.string(),
  documentId: z.string(),
  version: z.number().int().positive(),
  /** What the file was called when it arrived. Metadata, never a path. */
  filename: z.string(),
  mimeType: z.string().nullable(),
  byteSize: z.number().int().nullable(),
  /** sha256 of the stored bytes, hex. */
  checksum: z.string().nullable(),
  /** `null` = not read yet; `0` = read and empty. */
  extractedChars: z.number().int().min(0).nullable(),
  /** ISO 8601. */
  uploadedAt: z.string(),
  uploadedBy: z.string(),
});
export type DocumentVersionView = z.infer<typeof documentVersionView>;

/** A document with its whole version history, newest first. */
export const documentDetailView = z.object({
  document: documentView,
  versions: z.array(documentVersionView),
});
export type DocumentDetailView = z.infer<typeof documentDetailView>;

/**
 * One search hit (§13).
 *
 * `rank` and `score` both travel because they answer different questions: the
 * first is what Postgres thought of the text, the second is what the department
 * boost did to it. A page showing only the order could not say whether the tag
 * decided a result or the text did — and neither could anyone reading it over
 * the operator's shoulder asking why a barely relevant note came first.
 */
export const documentHitView = z.object({
  document: documentView,
  /** The version whose text matched — the best one, when several did. */
  versionId: z.string(),
  version: z.number().int().positive(),
  rank: z.number(),
  /** Whether the asking department is among this document's department tags. */
  departmentMatch: z.boolean(),
  score: z.number(),
});
export type DocumentHitView = z.infer<typeof documentHitView>;

// --- envelopes ---------------------------------------------------------------

/**
 * The upload answer and the detail page carry the same document.
 *
 * The envelope types below are exported because the **producer builds them**
 * rather than the route. `/api/posteingang` has its adapter return the payload
 * and `app.ts` write `{ posteingang: … }` around it, which leaves the key in a
 * second place; here the adapter returns the finished body and the route only
 * chooses a status code. Same reasoning as the rest of this module, one level
 * up: an envelope key that exists twice is an envelope key that can differ, and
 * it did (A81.1).
 */
export const documentResponse = z.object({ dokument: documentDetailView });
export type DocumentResponseBody = z.infer<typeof documentResponse>;

/**
 * §13's search.
 *
 * `nochNichtDurchsuchbar` is not decoration: extraction cannot read every type
 * yet (PDF is a later block), so the vault can hold documents no query can
 * match. Answering "0 Treffer" over such a vault is true and misleading, and
 * this number is the difference between "nothing matches" and "nothing has been
 * read yet".
 */
export const documentSearchResponse = z.object({
  dokumente: z.array(documentHitView),
  nochNichtDurchsuchbar: z.number().int().min(0),
});
export type DocumentSearchBody = z.infer<typeof documentSearchResponse>;

/** Every refusal, German, ready to render. */
export const documentRejectedResponse = z.object({ errors: z.array(z.string()) });

// --- routes ------------------------------------------------------------------

/**
 * One place both the routes and the pages name these (A81.3).
 *
 * `search` is a literal segment under `/api/dokumente`, so it has to be
 * registered before `/:id` — Hono matches in registration order. A document id
 * is a uuid and could never spell `suche`, but that is a property of today's ids
 * rather than of the router, and the ordering is stated where it is done.
 */
export const DOKUMENTE_API = {
  upload: '/api/dokumente',
  search: '/api/dokumente/suche',
  document: (id: string) => `/api/dokumente/${encodeURIComponent(id)}`,
  versions: (id: string) => `/api/dokumente/${encodeURIComponent(id)}/versionen`,
  tags: (id: string) => `/api/dokumente/${encodeURIComponent(id)}/schlagworte`,
} as const;

/** The query keys a search reads. Same reasoning as `UPLOAD_QUERY` below. */
export const SEARCH_QUERY = { query: 'q', department: 'abteilung' } as const;

/**
 * The query keys an upload carries, named once.
 *
 * `department` and `tag` repeat rather than taking a separator: a tag is free
 * text and any separator is a character a curator may not use.
 * `URLSearchParams` appends and reads repeats natively, so neither side needs an
 * escape rule.
 */
export const UPLOAD_QUERY = {
  title: 'title',
  filename: 'filename',
  department: 'department',
  tag: 'tag',
} as const;

// --- the upload's metadata ---------------------------------------------------

/**
 * A path separator or a control character — refused in a filename.
 *
 * Written as a scan rather than a regular expression because the interesting
 * half of it is a range of control characters, and a regex carrying those as
 * literals is a line nobody can review and every editor mangles.
 */
export function hasPathOrControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === '/' || char === '\\' || code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Every constraint below carries its own German message, and that is the
 * mechanism rather than a courtesy.
 *
 * `apps/server/src/inbox.ts` can re-word zod's English because it can tell an
 * authored message from a generated one — its rules arrive as `custom` issues.
 * Here they arrive as `too_small`/`too_big`/`invalid_type`, which a *generated*
 * message uses too, so there is nothing to switch on. The alternative was a
 * heuristic ("does this sentence look German?"), which is exactly the shape that
 * reads as covered and is not. So instead: no reachable issue is allowed to
 * exist without a German message, `germanMetaIssues` quotes them verbatim, and
 * `dokumente.test.ts` drives every reachable issue and asserts that no English
 * comes out. The guarantee is a test over real inputs rather than a regex over
 * the output.
 */
const tagSchema = z
  .string({ error: 'Ein Schlagwort muss Text sein.' })
  .trim()
  .min(1, 'Ein Schlagwort darf nicht leer sein.')
  .max(
    MAX_DOCUMENT_TAG_LENGTH,
    `Ein Schlagwort ist zu lang (höchstens ${MAX_DOCUMENT_TAG_LENGTH} Zeichen).`,
  );

/**
 * The filename, which is metadata and has to stay unable to become a path.
 *
 * The stored file is named after the hash of its contents and this string is
 * only ever displayed — so a separator in it is harmless *today*, and the
 * refusal is what keeps it harmless tomorrow. A87.7 makes the same call one
 * subsystem over: the cheapest place to refuse a traversal is before it is
 * stored, because after that every reader has to remember. Control characters go
 * for a second reason: this text is rendered, and a newline in a filename is a
 * line in a table nobody put there.
 */
const filenameSchema = z
  .string({ error: 'Der Dateiname muss Text sein.' })
  .trim()
  .min(1, 'Der Dateiname fehlt.')
  .max(
    MAX_DOCUMENT_FILENAME_LENGTH,
    `Der Dateiname ist zu lang (höchstens ${MAX_DOCUMENT_FILENAME_LENGTH} Zeichen).`,
  )
  .refine((value) => !hasPathOrControlChar(value), {
    error: 'Der Dateiname darf keine Pfadtrenner oder Steuerzeichen enthalten.',
  });

export const versionMetaSchema = z.object({ filename: filenameSchema });
export type VersionMeta = z.infer<typeof versionMetaSchema>;

export const uploadMetaSchema = z.object({
  title: z
    .string({ error: 'Der Titel muss Text sein.' })
    .trim()
    .min(1, 'Ein Dokument braucht einen Titel.')
    .max(
      MAX_DOCUMENT_TITLE_LENGTH,
      `Der Titel ist zu lang (höchstens ${MAX_DOCUMENT_TITLE_LENGTH} Zeichen).`,
    ),
  filename: filenameSchema,
  departmentTags: z
    .array(tagSchema, { error: 'Die Abteilungs-Schlagworte haben nicht die erwartete Form.' })
    .max(MAX_DOCUMENT_TAGS, `Höchstens ${MAX_DOCUMENT_TAGS} Abteilungs-Schlagworte.`),
  tags: z
    .array(tagSchema, { error: 'Die Schlagworte haben nicht die erwartete Form.' })
    .max(MAX_DOCUMENT_TAGS, `Höchstens ${MAX_DOCUMENT_TAGS} Schlagworte.`),
});
export type UploadMeta = z.infer<typeof uploadMetaSchema>;

/** What §13's curation flow submits (`PUT …/schlagworte`), audit-logged. */
export const tagSubmission = z.object({
  departmentTags: z
    .array(tagSchema, { error: 'Die Abteilungs-Schlagworte haben nicht die erwartete Form.' })
    .max(MAX_DOCUMENT_TAGS, `Höchstens ${MAX_DOCUMENT_TAGS} Abteilungs-Schlagworte.`)
    .optional(),
  tags: z
    .array(tagSchema, { error: 'Die Schlagworte haben nicht die erwartete Form.' })
    .max(MAX_DOCUMENT_TAGS, `Höchstens ${MAX_DOCUMENT_TAGS} Schlagworte.`)
    .optional(),
});
export type TagSubmission = z.infer<typeof tagSubmission>;

/**
 * The URL the page POSTs a file to — the build half of the pair below.
 *
 * Exported beside `parseUploadQuery` on purpose: a builder and a parser that
 * live in one module can be round-tripped by one test, which is the assertion
 * that was missing while `/inbox` and `/posteingang` disagreed (A81.3).
 */
export function uploadUrl(meta: UploadMeta): string {
  const params = new URLSearchParams();
  params.set(UPLOAD_QUERY.title, meta.title);
  params.set(UPLOAD_QUERY.filename, meta.filename);
  for (const tag of meta.departmentTags) params.append(UPLOAD_QUERY.department, tag);
  for (const tag of meta.tags) params.append(UPLOAD_QUERY.tag, tag);
  return `${DOKUMENTE_API.upload}?${params.toString()}`;
}

/** The same, for appending a version to a document that already exists. */
export function versionUrl(documentId: string, meta: VersionMeta): string {
  const params = new URLSearchParams({ [UPLOAD_QUERY.filename]: meta.filename });
  return `${DOKUMENTE_API.versions(documentId)}?${params.toString()}`;
}

export type MetaResult<T> = { ok: true; meta: T } | { ok: false; errors: string[] };

export function parseUploadQuery(params: URLSearchParams): MetaResult<UploadMeta> {
  const parsed = uploadMetaSchema.safeParse({
    title: params.get(UPLOAD_QUERY.title) ?? '',
    filename: params.get(UPLOAD_QUERY.filename) ?? '',
    departmentTags: params.getAll(UPLOAD_QUERY.department),
    tags: params.getAll(UPLOAD_QUERY.tag),
  });
  return parsed.success
    ? { ok: true, meta: parsed.data }
    : { ok: false, errors: germanMetaIssues(parsed.error.issues) };
}

export function parseVersionQuery(params: URLSearchParams): MetaResult<VersionMeta> {
  const parsed = versionMetaSchema.safeParse({
    filename: params.get(UPLOAD_QUERY.filename) ?? '',
  });
  return parsed.success
    ? { ok: true, meta: parsed.data }
    : { ok: false, errors: germanMetaIssues(parsed.error.issues) };
}

/**
 * Zod's issues as sentences the operator reads (§2).
 *
 * Quoted verbatim — see the note above `tagSchema` for why there is nothing to
 * translate here and what carries the guarantee instead.
 */
export function germanMetaIssues(issues: ReadonlyArray<{ message: string }>): string[] {
  return issues.map((issue) => issue.message);
}
