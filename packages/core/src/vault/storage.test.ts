/**
 * The docs volume, against real files (§13).
 *
 * No database: this module's whole job is bytes and paths, and the point of
 * `DocumentVault`'s decision 5 — "nothing here reads a file" — is that the two
 * halves can be examined apart.
 *
 * The load-bearing assertion in almost every case is **the filesystem
 * afterwards**, not the return value. A store that answered a plausible path
 * without writing, or a refused upload that left a 25 MB fragment behind, would
 * both satisfy a test that only read what `store()` returned.
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  DocumentStorage,
  DocumentStorageError,
  STORAGE_PREFIX,
  STORAGE_TEMP_DIR,
  storagePathFor,
} from './storage.js';

const root = mkdtempSync(join(tmpdir(), 'vorschicht-docs-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function storage(maxBytes = 1024 * 1024): DocumentStorage {
  return new DocumentStorage({ root, maxBytes });
}

const bytes = (text: string) => new TextEncoder().encode(text);
const sha256 = (text: string) => createHash('sha256').update(bytes(text)).digest('hex');

/** Everything under `.tmp`, which must be empty after every outcome. */
async function leftovers(): Promise<string[]> {
  return readdir(join(root, STORAGE_TEMP_DIR)).catch(() => []);
}

describe('DocumentStorage.store', () => {
  it('legt die Bytes ab und beschreibt sie so, wie die Zeile sie braucht', async () => {
    const text = `Statuten ${randomUUID()}`;
    const stored = await storage().store(bytes(text));

    expect(stored.checksum).toBe(sha256(text));
    expect(stored.byteSize).toBe(bytes(text).byteLength);
    expect(stored.storagePath).toBe(storagePathFor(stored.checksum));
    // The path is relative and starts under the algorithm's directory — both are
    // what migration 0020's CHECK constraint requires of the stored column.
    expect(stored.storagePath.startsWith(`${STORAGE_PREFIX}/`)).toBe(true);
    expect(stored.storagePath.startsWith('/')).toBe(false);

    // The assertion that matters: the bytes are really there, and they are the
    // bytes that went in.
    expect(await readFile(join(root, stored.storagePath), 'utf8')).toBe(text);
    expect(await leftovers()).toEqual([]);
  });

  // A `ReadableStream` is what `c.req.raw.body` hands over; the other two are
  // what a test or a future caller holds. All three have to reach disk the same.
  it('nimmt Strom, Iterable und Puffer gleichermaßen an', async () => {
    const text = `Drei Wege ${randomUUID()}`;
    const chunks = [bytes(text.slice(0, 5)), bytes(text.slice(5))];

    const fromStream = await storage().store(
      new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      }),
    );
    const fromIterable = await storage().store(
      (async function* () {
        for (const chunk of chunks) yield chunk;
      })(),
    );
    const fromBuffer = await storage().store(bytes(text));

    expect(fromStream.checksum).toBe(sha256(text));
    expect(fromIterable.checksum).toBe(sha256(text));
    expect(fromBuffer.checksum).toBe(sha256(text));
    expect(await readFile(join(root, fromStream.storagePath), 'utf8')).toBe(text);
  });

  // Content addressing means the second upload of one file writes nothing new.
  // Migration 0020 deliberately does *not* make `checksum` unique — two version
  // rows sharing one path is the intended state — so this is the property that
  // makes that safe rather than a coincidence.
  it('schreibt dieselbe Datei nur einmal und bleibt dabei lesbar', async () => {
    const text = `Doppelt ${randomUUID()}`;
    const first = await storage().store(bytes(text));
    const second = await storage().store(bytes(text));

    expect(second.storagePath).toBe(first.storagePath);
    expect(await readFile(join(root, second.storagePath), 'utf8')).toBe(text);
    const directory = join(root, STORAGE_PREFIX, first.checksum.slice(0, 2));
    expect((await readdir(directory)).filter((name) => name === first.checksum)).toHaveLength(1);
  });

  // §13's corpus is Statuten, AVVs and Verträge. An inherited umask of 022 would
  // make every one of them world-readable on the volume.
  it('legt Datei und Verzeichnis nur für den eigenen Benutzer lesbar an', async () => {
    const stored = await storage().store(bytes(`Vertraulich ${randomUUID()}`));
    const file = await stat(join(root, stored.storagePath));
    const directory = await stat(join(root, STORAGE_PREFIX, stored.checksum.slice(0, 2)));
    expect(file.mode & 0o777).toBe(0o600);
    expect(directory.mode & 0o777).toBe(0o700);
  });

  // The whole reason the route streams instead of buffering: the cap has to act
  // on the bytes that arrive. And the second half is the one a return-value test
  // would miss — a refused upload that left its fragment behind would fill the
  // volume one refusal at a time.
  it('bricht über der Grenze ab und lässt nichts liegen', async () => {
    const small = storage(64);
    const oversized = new Uint8Array(65).fill(65);

    await expect(small.store(oversized)).rejects.toMatchObject({
      name: 'DocumentStorageError',
      kind: 'too_large',
    });

    expect(await leftovers()).toEqual([]);
    const path = join(root, storagePathFor(createHash('sha256').update(oversized).digest('hex')));
    await expect(stat(path)).rejects.toThrow();
  });

  it('lässt eine Datei genau auf der Grenze durch', async () => {
    const exact = new Uint8Array(64).fill(66);
    const stored = await storage(64).store(exact);
    expect(stored.byteSize).toBe(64);
  });

  // A stream that fails mid-flight is the same obligation as a refused one.
  it('räumt auch auf, wenn die Quelle mittendrin abbricht', async () => {
    const boom = (async function* () {
      yield bytes('Anfang');
      throw new Error('Verbindung weg');
    })();

    await expect(storage().store(boom)).rejects.toMatchObject({ kind: 'io' });
    expect(await leftovers()).toEqual([]);
  });
});

describe('DocumentStorage.resolve', () => {
  it('löst einen gespeicherten Pfad in den Speicher hinein auf', async () => {
    const stored = await storage().store(bytes(`Auflösen ${randomUUID()}`));
    expect(storage().resolve(stored.storagePath)).toBe(join(root, stored.storagePath));
  });

  // Two layers refusing the same strings: migration 0020's CHECK rejects an
  // absolute path and anything containing `..` at the column, and this rejects
  // them again at the filesystem. The second is what still holds for a row that
  // reached the table some other way — which is the case it exists for, since
  // writing cannot escape (the name is a hash).
  it.each([
    '/etc/passwd',
    '../geheim',
    'sha256/../../geheim',
    'sha256/ab/../../../etc/shadow',
    '',
    '   ',
  ])('verweigert %j', (path) => {
    expect(() => storage().resolve(path)).toThrow(DocumentStorageError);
    try {
      storage().resolve(path);
    } catch (error) {
      expect((error as DocumentStorageError).kind).toBe('outside_root');
    }
  });

  // The check is containment of the *resolved* path, so a symlink-free escape
  // through a legal-looking prefix has to fail too.
  it('lässt sich von einem Präfix nicht täuschen', async () => {
    const sibling = mkdtempSync(join(tmpdir(), 'vorschicht-docs-'));
    try {
      await writeFile(join(sibling, 'geheim.txt'), 'CLAUDE_CODE_OAUTH_TOKEN=echt');
      expect(() => storage().resolve(`../${join(sibling, 'geheim.txt').split('/').pop()}`)).toThrow(
        DocumentStorageError,
      );
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });

  it('verlangt einen absoluten Wurzelpfad', () => {
    expect(() => new DocumentStorage({ root: 'relativ/docs', maxBytes: 1 })).toThrow(
      DocumentStorageError,
    );
  });
});
