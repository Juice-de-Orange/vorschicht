/**
 * Where §13's uploaded bytes go ("binary stored on the docs volume").
 *
 * `DocumentVault`'s decision 5 is deliberate and this module is its other half:
 * *"Nothing here reads a file. The vault stores a path under the docs volume and
 * never resolves it; the upload route owns the bytes."* So the one component
 * that may touch the filesystem is this one, and it is the only place that
 * knows what a `storage_path` means.
 *
 * Six decisions.
 *
 *   1. **The bytes are written before the row, always — and that ordering is the
 *      reason `store()` returns rather than writing anything itself.** A
 *      database row pointing at a file that does not exist is a document that
 *      appears to exist: it lists, it opens, it fails, and nothing but a human
 *      can tell that it was never there. Bytes with no row are the other
 *      failure and are strictly cheaper — nobody sees them and a sweep over
 *      `sha256/` minus `document_versions.storage_path` finds them. So the
 *      caller stores, *then* inserts, and an insert that fails leaves litter
 *      rather than a lie.
 *
 *   2. **Content-addressed: `sha256/<aa>/<hash>`, and the original name is
 *      metadata only.** Three things follow, and the third is the one worth
 *      stating. A name a caller supplies can never become a path, so a
 *      traversal has nowhere to enter. The same file uploaded twice is written
 *      once — which is *correct* beside migration 0020's deliberate refusal to
 *      make `checksum` unique ("the same file uploaded twice is two versions"):
 *      two version rows sharing one path is the intended state, and it is safe
 *      only because nothing in §13 ever deletes a stored file. And the
 *      algorithm is in the path rather than implied by it, so replacing it
 *      later is an addition instead of an ambiguity.
 *
 *   3. **The temporary file lives inside the docs root, never in `/tmp`.** Not
 *      taste: `rename(2)` across filesystems fails with `EXDEV`, and in the app
 *      container the two provably *are* different filesystems — the rootfs is
 *      `read_only` with a tmpfs at `/tmp` and the docs volume mounted
 *      separately. A write-then-rename through `/tmp` would fail on every
 *      upload in production and pass every test on a developer's laptop.
 *
 *   4. **The cap is counted, not believed.** `content-length` is supplied by
 *      the caller and a chunked request carries none, so the limit is enforced
 *      per chunk against the bytes that actually arrive; crossing it aborts the
 *      stream and removes the partial file. A limit applied after a body has
 *      been buffered is a limit that fires after the damage — which is why the
 *      route reads a stream at all (`@vorschicht/shared/dokumente`).
 *
 *   5. **Mode 0600, set explicitly rather than left to the umask.** §13's
 *      corpus is Statuten, AVVs and Verträge. A103 is the reason this is worth
 *      a sentence: transcripts written 0600 by uid 10001 were unreadable to a
 *      backup sidecar running as uid 70, and A14's transcript archive was empty
 *      for a week without anything saying so. Here every reader — the app that
 *      writes, the orchestrator that will serve `docs.get`, the backup sidecar
 *      that tars the volume — runs as 10001, so 0600 costs nothing and an
 *      inherited umask of 022 would have made every contract in the vault
 *      world-readable.
 *
 *   6. **Containment is checked on the way in and on the way out.** Writing
 *      cannot escape (the name is a hash), so the check on `resolve()` is what
 *      earns its place: it is the door every future reader goes through, and a
 *      row edited past the column's own CHECK is the case it exists for. The
 *      implementation is `serveShell`'s in `apps/server/src/app.ts` — resolve
 *      and test containment rather than pattern-match `..` — because the two
 *      have to refuse the same strings to be two layers at all (A62.4).
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { isAbsolute, join, normalize, resolve as resolvePath } from 'node:path';

/** The directory a stored file's relative path always starts with. */
export const STORAGE_PREFIX = 'sha256';

/** Where a half-written upload lives until it has a name (decision 3). */
export const STORAGE_TEMP_DIR = '.tmp';

export type StorageProblem = 'too_large' | 'outside_root' | 'io';

export class DocumentStorageError extends Error {
  constructor(
    readonly kind: StorageProblem,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DocumentStorageError';
  }
}

/** What the caller needs in order to write the row (decision 1). */
export interface StoredFile {
  /** Relative to the docs volume — what `document_versions.storage_path` takes. */
  storagePath: string;
  /** sha256 of the stored bytes, hex. */
  checksum: string;
  byteSize: number;
  /** Resolved, for the extractor. Never stored (A2: the mount point moves). */
  absolutePath: string;
}

/** Anything the route can hand over: a web stream, an async iterable, a buffer. */
export type ByteSource = AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Uint8Array;

export interface DocumentStorageDeps {
  /** Absolute path of the docs volume (`config.docsRoot`). */
  root: string;
  /** Refuse anything larger. The route passes `MAX_UPLOAD_BYTES`. */
  maxBytes: number;
}

export class DocumentStorage {
  private readonly root: string;
  private readonly maxBytes: number;

  constructor(deps: DocumentStorageDeps) {
    if (!isAbsolute(deps.root)) {
      throw new DocumentStorageError(
        'outside_root',
        `Der Dokumentenspeicher braucht einen absoluten Pfad, bekam "${deps.root}".`,
      );
    }
    this.root = resolvePath(deps.root);
    this.maxBytes = deps.maxBytes;
  }

  /**
   * Stream bytes onto the docs volume and answer where they landed.
   *
   * Writes to a temporary name, hashes while writing, then renames onto the
   * content-addressed path. `rename(2)` is atomic, so a reader either sees the
   * previous complete file or the new complete one — and since both are the
   * same bytes by construction, a concurrent upload of the same document is not
   * a race but a no-op with extra steps.
   */
  async store(source: ByteSource): Promise<StoredFile> {
    const tempDir = join(this.root, STORAGE_TEMP_DIR);
    await mkdir(tempDir, { recursive: true, mode: 0o700 });
    const tempPath = join(tempDir, `upload-${randomUUID()}`);

    const hash = createHash('sha256');
    let byteSize = 0;

    // `wx` so a colliding name is an error rather than a silent overwrite; the
    // name is a uuid, so reaching that branch means something is very wrong.
    const handle = await open(tempPath, 'wx', 0o600).catch((cause: unknown) => {
      throw new DocumentStorageError('io', 'Der Dokumentenspeicher ist nicht beschreibbar.', {
        cause,
      });
    });

    try {
      for await (const chunk of chunks(source)) {
        byteSize += chunk.byteLength;
        if (byteSize > this.maxBytes) {
          throw new DocumentStorageError(
            'too_large',
            `Die Datei ist größer als ${this.maxBytes} Byte.`,
          );
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
      // The row that will point at this file is written next (decision 1), so
      // the bytes have to have reached the disk before it does. The directory
      // entry itself is not synced — a power loss in that window loses the name
      // and leaves the row pointing at nothing, which is the one case this
      // ordering cannot cover on its own.
      await handle.sync();
    } catch (error) {
      await handle.close().catch(() => {});
      await unlink(tempPath).catch(() => {});
      throw error instanceof DocumentStorageError
        ? error
        : new DocumentStorageError('io', 'Die Datei konnte nicht gespeichert werden.', {
            cause: error,
          });
    }
    await handle.close();

    const checksum = hash.digest('hex');
    const storagePath = storagePathFor(checksum);
    const absolutePath = this.resolve(storagePath);

    try {
      await mkdir(join(absolutePath, '..'), { recursive: true, mode: 0o700 });
      await rename(tempPath, absolutePath);
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      throw new DocumentStorageError('io', 'Die Datei konnte nicht abgelegt werden.', {
        cause: error,
      });
    }

    return { storagePath, checksum, byteSize, absolutePath };
  }

  /**
   * A stored path as an absolute one, refusing anything outside the volume.
   *
   * Two layers, and they refuse the same strings on purpose: migration 0020's
   * `document_versions_storage_path_relative` CHECK rejects an absolute path and
   * anything containing `..` at the column, and this rejects them again at the
   * filesystem. The second is not redundant — it is what still holds for a row
   * that reached the table some other way, and it is the door every future
   * reader (`docs.get`, a download route, the leak scan) goes through.
   */
  resolve(storagePath: string): string {
    if (storagePath.trim() === '' || isAbsolute(storagePath) || storagePath.includes('..')) {
      throw new DocumentStorageError(
        'outside_root',
        `"${storagePath}" ist kein zulässiger Pfad im Dokumentenspeicher.`,
      );
    }
    const candidate = resolvePath(join(this.root, normalize(storagePath)));
    if (candidate !== this.root && !candidate.startsWith(`${this.root}/`)) {
      throw new DocumentStorageError(
        'outside_root',
        `"${storagePath}" zeigt aus dem Dokumentenspeicher heraus.`,
      );
    }
    return candidate;
  }
}

/**
 * `sha256/<first two hex digits>/<full hash>`.
 *
 * The two-character level exists so one directory does not accumulate every
 * document the operator ever uploads; it is the layout git uses, for the same reason.
 */
export function storagePathFor(checksum: string): string {
  return `${STORAGE_PREFIX}/${checksum.slice(0, 2)}/${checksum}`;
}

/**
 * One iteration protocol out of the three a caller may hold.
 *
 * A web `ReadableStream` is async-iterable in Node 22, but `c.req.raw.body`
 * crosses two library boundaries to get here and a version that lost that
 * property would break uploads at runtime and nothing else — so the reader
 * protocol is handled explicitly rather than assumed.
 */
async function* chunks(source: ByteSource): AsyncGenerator<Uint8Array> {
  if (source instanceof Uint8Array) {
    yield source;
    return;
  }
  if (Symbol.asyncIterator in source) {
    yield* source as AsyncIterable<Uint8Array>;
    return;
  }
  const reader = (source as ReadableStream<Uint8Array>).getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
