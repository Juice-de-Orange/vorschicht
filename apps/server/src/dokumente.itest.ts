/**
 * §13's upload path end to end: a real Postgres, real files on a real docs
 * volume, and the routes driven through `createApp` with a session.
 *
 * `dokumente.test.ts` proves the transport against a stub and
 * `storage.test.ts` proves the bytes against no database. Neither can answer the
 * three questions this file exists for, because each is a statement about the
 * *whole* chain:
 *
 *   * an upload leaves **bytes and a row**, and the row points at the bytes;
 *   * a refused upload leaves **neither** — not a fragment, not an orphan;
 *   * and §19's trail names the **session**, which only survives if the actor
 *     travels from the cookie through the route and the adapter into the vault's
 *     own audit row.
 *
 * The fourth is the one that would otherwise be a paragraph: the extraction cap
 * is a number chosen to keep `document_versions.fts` under Postgres' tsvector
 * ceiling, and the only way to know it does is to put a full cap's worth of the
 * worst-shaped text through the real generated column.
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
  buildTestPdf,
  DocumentStorage,
  DocumentVault,
  MAX_EXTRACTED_CHARS,
  MediaTypeExtractor,
} from '@vorschicht/core';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import {
  documentResponse,
  documentSearchResponse,
  MAX_UPLOAD_BYTES,
  uploadUrl,
} from '@vorschicht/shared/dokumente';
import type { Hono } from 'hono';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import {
  addDocumentVersion,
  getDocument,
  searchDocuments,
  setDocumentTags,
  uploadDocument,
} from './dokumente.js';

const url = process.env.TEST_DATABASE_URL;

/**
 * Whether this machine has the parser `Dockerfile.app` installs.
 *
 * Only the one case that needs a PDF *read* is conditional on it; the case
 * asserting an unreadable PDF stays counted runs everywhere, and the extractor's
 * own guarantees are pinned without poppler in
 * `packages/core/src/vault/extraction.test.ts`.
 */
const pdftotextAvailable = (() => {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!url)('Dokumenten-Tresor über HTTP (§13)', () => {
  let database: TestDatabase;
  let sql: postgres.Sql;
  let docsRoot: string;
  let app: Hono;

  const SESSION = 'kredential-7';

  beforeAll(async () => {
    database = await createTestDatabase('server_dokumente');
    sql = createSql({ url: database.url, max: 4 });
    docsRoot = mkdtempSync(join(tmpdir(), 'vorschicht-docs-itest-'));

    const documents = {
      vault: new DocumentVault(sql),
      storage: new DocumentStorage({ root: docsRoot, maxBytes: MAX_UPLOAD_BYTES }),
      // The wiring `apps/server/src/main.ts` uses, rather than a narrower one:
      // routing by media type is part of the chain these cases are about, and a
      // suite that wired only the text extractor could not tell a PDF that was
      // read from a PDF nothing ever tried to read.
      extractor: new MediaTypeExtractor(),
    };

    app = createApp({
      health: { startedAt: Date.now(), pingDatabase: async () => {} },
      getSession: async () => ({ userId: SESSION }),
      dokumente: {
        upload: (request) => uploadDocument(documents, request),
        addVersion: (id, request) => addDocumentVersion(documents, id, request),
        get: (id) => getDocument(documents, id),
        setTags: (id, input, actor) => setDocumentTags(documents, id, input, actor),
        search: (params) => searchDocuments(documents, params),
      },
    });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await database?.drop();
    if (docsRoot) rmSync(docsRoot, { recursive: true, force: true });
  });

  /** Every file on the volume, relative — the before/after of "left nothing". */
  async function storedFiles(): Promise<string[]> {
    const found: string[] = [];
    async function walk(dir: string): Promise<void> {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) await walk(path);
        else found.push(relative(docsRoot, path));
      }
    }
    await walk(docsRoot);
    return found.sort();
  }

  async function post(url: string, body: string | Uint8Array, type = 'text/plain; charset=utf-8') {
    return app.request(url, { method: 'POST', headers: { 'content-type': type }, body });
  }

  async function auditFor(subject: string) {
    return sql<Array<{ action: string; actor: string }>>`
      SELECT action, actor FROM audit_log WHERE subject = ${subject} ORDER BY id
    `;
  }

  it('legt beim Upload die Bytes und die Zeile an — und die Zeile zeigt auf die Bytes', async () => {
    const text = `Der Verein führt den Namen ${randomUUID()}.`;
    const res = await post(
      uploadUrl({
        title: 'Vereinsstatuten',
        filename: 'statuten.txt',
        departmentTags: ['Recht'],
        tags: ['Verein'],
      }),
      text,
    );

    expect(res.status).toBe(200);
    const body = documentResponse.parse(await res.json());
    const version = body.dokument.versions[0];
    expect(body.dokument.document.title).toBe('Vereinsstatuten');
    expect(body.dokument.document.departmentTags).toEqual(['Recht']);
    expect(version?.version).toBe(1);
    expect(version?.mimeType).toBe('text/plain');
    expect(version?.byteSize).toBe(new TextEncoder().encode(text).byteLength);
    // Read and non-empty: `extractedChars` is what tells a page whether this
    // document can be found at all.
    expect(version?.extractedChars).toBe(text.length);

    // The claim the response cannot make on its own: the row's path names a file
    // that exists and holds the uploaded bytes. `storage_path` never travels to
    // a page (§19), so it is read from the column here.
    const [row] = await sql<Array<{ storage_path: string; checksum: string }>>`
      SELECT storage_path, checksum FROM document_versions WHERE id = ${version?.id ?? ''}
    `;
    expect(row?.storage_path.startsWith('sha256/')).toBe(true);
    expect(await readFile(join(docsRoot, row?.storage_path ?? ''), 'utf8')).toBe(text);
    expect(version?.checksum).toBe(row?.checksum);
  });

  // §19, and the reason `sessionActor` exists: a trail in which every upload was
  // made by `system` answers *that* something was uploaded and loses who did it.
  // `DocumentVault` defaults its actor to `'system'`, so this is a live default
  // that has to be overridden all the way from the cookie.
  it('schreibt die Sitzung als Urheber in den Prüfpfad, nicht „system"', async () => {
    const res = await post(
      uploadUrl({
        title: `Auftragsverarbeitung ${randomUUID()}`,
        filename: 'avv.md',
        departmentTags: ['Recht'],
        tags: [],
      }),
      '# AVV\n\nDer Auftragsverarbeiter …',
      'text/markdown',
    );
    const body = documentResponse.parse(await res.json());
    const documentId = body.dokument.document.id;

    const created = await auditFor(documentId);
    expect(created.map((entry) => entry.action)).toEqual(['document.created']);
    expect(created[0]?.actor).toBe(`dashboard:${SESSION}`);
    expect(created[0]?.actor).not.toBe('system');

    // §13's curation flow is audit-logged too, and by the same session.
    const tagged = await app.request(`/api/dokumente/${documentId}/schlagworte`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: ['DSGVO', 'Vertrag'] }),
    });
    expect(tagged.status).toBe(200);
    expect(documentResponse.parse(await tagged.json()).dokument.document.tags).toEqual([
      'DSGVO',
      'Vertrag',
    ]);

    const after = await auditFor(documentId);
    expect(after.map((entry) => entry.action)).toEqual([
      'document.created',
      'document.tags_changed',
    ]);
    expect(after[1]?.actor).toBe(`dashboard:${SESSION}`);
  });

  it('hängt eine zweite Version an dasselbe Dokument', async () => {
    const first = documentResponse.parse(
      await (
        await post(
          uploadUrl({
            title: `Satzung ${randomUUID()}`,
            filename: 'v1.txt',
            departmentTags: [],
            tags: [],
          }),
          'Fassung eins',
        )
      ).json(),
    );
    const documentId = first.dokument.document.id;

    const res = await post(
      `/api/dokumente/${documentId}/versionen?filename=v2.txt`,
      'Fassung zwei',
    );
    expect(res.status).toBe(200);
    const body = documentResponse.parse(await res.json());
    // Newest first, and the numbering comes from the database rather than from
    // anything this layer counted.
    expect(body.dokument.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(body.dokument.versions[0]?.filename).toBe('v2.txt');
  });

  // The ordering rule, stated from the failing side: bytes are written before
  // the row, so a 404 that arrives *after* a store would leave an orphan on the
  // volume forever. Asking first is what prevents it.
  it('lehnt eine Version für ein unbekanntes Dokument ab, ohne Bytes zu hinterlassen', async () => {
    const before = await storedFiles();
    const res = await post(
      `/api/dokumente/${randomUUID()}/versionen?filename=x.txt`,
      'Inhalt, der nirgends hingehört',
    );
    // The filesystem first: this case is named for the litter, so the litter is
    // what its failure should say. A version stored before the existence check
    // would orphan bytes no row ever names.
    expect(await storedFiles()).toEqual(before);
    expect(res.status).toBe(404);
  });

  it('lehnt einen nicht erlaubten Dateityp ab, ohne Bytes zu hinterlassen', async () => {
    const before = await storedFiles();
    const res = await post(
      uploadUrl({ title: 'Archiv', filename: 'daten.zip', departmentTags: [], tags: [] }),
      'PK irgendwas',
      'application/zip',
    );

    expect(res.status).toBe(415);
    const body = (await res.json()) as { errors: string[] };
    expect(body.errors[0]).toContain('application/zip');
    expect(body.errors[0]).toContain('PDF');
    expect(await storedFiles()).toEqual(before);
    // …and no row either: the refusal happens before the vault is asked.
    const counted = await sql<Array<{ count: string }>>`
      SELECT count(*) AS count FROM documents WHERE title = 'Archiv'
    `;
    expect(Number(counted[0]?.count ?? -1)).toBe(0);
  });

  // The cap on real arriving bytes, not on a declared `content-length`. The body
  // is generated as a stream so the test costs one megabyte of memory rather
  // than twenty-six, and what it proves is the production constant.
  it('bricht über der Größengrenze ab, ohne ein Bruchstück zu hinterlassen', async () => {
    const before = await storedFiles();
    const chunk = new Uint8Array(1024 * 1024).fill(90);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_UPLOAD_BYTES) return controller.close();
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });

    const res = await app.request(
      uploadUrl({ title: 'Zu groß', filename: 'gross.txt', departmentTags: [], tags: [] }),
      {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body,
        // Node requires this for a streamed request body.
        duplex: 'half',
      } as RequestInit,
    );

    expect(res.status).toBe(413);
    expect((await res.json()) as { errors: string[] }).toEqual({
      errors: ['Die Datei ist zu groß — höchstens 25 MB.'],
    });
    // Both halves: no finished file, and no half-written temporary one either.
    expect(await storedFiles()).toEqual(before);
    await expect(stat(join(docsRoot, '.tmp'))).resolves.toBeDefined();
    expect(await readdir(join(docsRoot, '.tmp'))).toEqual([]);
  });

  /**
   * §13's boost, from the side it can actually decide.
   *
   * The tagged document is uploaded **first** on purpose. `DocumentVault`'s
   * final tie-break is insertion order, newest first, so uploading it second
   * would put it on top whether or not the boost existed — and the assertion
   * would pass over a boost that did nothing. Uploading it first points the
   * tie-break the other way, so only the boost can reverse the order.
   */
  it('hebt bei gleich starkem Text die eigene Abteilung nach oben', async () => {
    const wort = `Zeichen${randomUUID().replace(/-/g, '')}`;
    await post(
      uploadUrl({ title: 'Mit Abteilung', filename: 'a.txt', departmentTags: ['Recht'], tags: [] }),
      `${wort} kommt hier vor.`,
    );
    await post(
      uploadUrl({ title: 'Ohne Abteilung', filename: 'b.txt', departmentTags: [], tags: [] }),
      `${wort} kommt hier vor.`,
    );

    const found = documentSearchResponse.parse(
      await (await app.request(`/api/dokumente/suche?q=${wort}&abteilung=Recht`)).json(),
    );

    expect(found.dokumente).toHaveLength(2);
    const [first, second] = found.dokumente;
    expect(first?.document.title).toBe('Mit Abteilung');
    expect(first?.departmentMatch).toBe(true);
    // `rank` and `score` travelling separately is what makes this legible: the
    // texts rank the same and the score is what differs, so the tag decided it
    // and the text did not.
    expect(first?.rank).toBeCloseTo(second?.rank ?? 0, 6);
    expect(first?.score).toBeGreaterThan(first?.rank ?? 0);
    expect(second?.score).toBeCloseTo(second?.rank ?? 0, 6);
  });

  /**
   * …and the other direction, which is the one §13 and §14 actually promise:
   * "ranking **boosts** documents tagged for the requesting department", and
   * curated things are "weighted reference works, **not restrictions**".
   *
   * A107.5 measured what that costs — `ts_rank` saturates, so the whole span
   * between one occurrence and forty is a factor of 1.62, and any multiplier at
   * or above it makes a department tag decisive for every single-word search
   * whatever the text says. `DEPARTMENT_BOOST` is 1.2 precisely so this case
   * comes out the way it does, and the tagged document here is uploaded second
   * so the tie-break favours it and only the *text* can push it down.
   */
  it('lässt den deutlich besseren Text gewinnen — der Zuschlag ist keine Stufe', async () => {
    const wort = `Zeichen${randomUUID().replace(/-/g, '')}`;
    await post(
      uploadUrl({
        title: 'Stark, ohne Abteilung',
        filename: 'c.txt',
        departmentTags: [],
        tags: [],
      }),
      `${wort} ${wort} ${wort} ${wort} ${wort} ${wort} ${wort} ${wort}`,
    );
    await post(
      uploadUrl({
        title: 'Schwach, mit Abteilung',
        filename: 'd.txt',
        departmentTags: ['Recht'],
        tags: [],
      }),
      `${wort} steht hier ein einziges Mal in einem sonst unbeteiligten Satz.`,
    );

    const found = documentSearchResponse.parse(
      await (await app.request(`/api/dokumente/suche?q=${wort}&abteilung=Recht`)).json(),
    );

    expect(found.dokumente[0]?.document.title).toBe('Stark, ohne Abteilung');
    expect(found.dokumente[0]?.departmentMatch).toBe(false);
    // The boosted document is still *in* the answer — a filter would have
    // dropped the other one, and that is the failure mode being excluded.
    expect(found.dokumente.map((hit) => hit.document.title)).toContain('Schwach, mit Abteilung');
  });

  /**
   * A document that could **not** be read is stored, listed and counted apart.
   *
   * The bytes below claim to be a PDF and are not, so no parser can produce
   * text from them — which is a different fact from "there is no text in it",
   * and `extractedChars: null` is where that difference lives. Reporting
   * "0 Treffer" over such a vault would be true and misleading.
   *
   * On a machine without poppler every PDF takes this same path, which is the
   * degradation being asserted rather than a hole: the document is in the vault
   * and countable, never silently absent from search.
   */
  it('zählt ein nicht lesbares Dokument als vorhanden, aber nicht durchsuchbar', async () => {
    const res = await post(
      uploadUrl({
        title: 'Gescannter Vertrag',
        filename: 'scan.pdf',
        departmentTags: [],
        tags: [],
      }),
      '%PDF-1.7 binäres Zeug',
      'application/pdf',
    );
    expect(res.status).toBe(200);
    const uploaded = documentResponse.parse(await res.json());
    // Stored and listed — it simply has no text yet, which `null` says and `0`
    // would not.
    expect(uploaded.dokument.versions[0]?.extractedChars).toBeNull();
    expect(uploaded.dokument.versions[0]?.byteSize).toBeGreaterThan(0);

    const found = documentSearchResponse.parse(
      await (await app.request('/api/dokumente/suche?q=Vertrag')).json(),
    );
    expect(found.nochNichtDurchsuchbar).toBeGreaterThanOrEqual(1);
  });

  /**
   * The sentence this whole subsystem exists for: a PDF that goes in comes back
   * out of §13's full-text search.
   *
   * Every link of it is real — the route, `DocumentStorage`, `pdftotext` in a
   * subprocess, the extraction cap, the generated `fts` column and
   * `websearch_to_tsquery` — because each one alone is provable elsewhere and
   * none of them is this claim. The PDF is generated from bytes rather than
   * checked in, and it is the *same* generator the unit tests use, so the two
   * proofs cannot end up talking about different documents.
   *
   * Two assertions carry it and they are not the same. `extractedChars > 0`
   * says a parser ran and produced text; the search hit says that text reached
   * the index and is reachable by a word a human would type. A stemmed word is
   * used on purpose — the document says "Kündigungen", the query asks
   * "Kündigung" — so this also fails if the German text-search configuration
   * ever stops being applied to the column.
   */
  it.skipIf(!pdftotextAvailable)(
    'macht ein hochgeladenes PDF über die Volltextsuche auffindbar',
    async () => {
      const kennung = randomUUID().replaceAll('-', '');
      const pdf = buildTestPdf([
        `Kuendigungen sind schriftlich einzureichen. Aktenzeichen ${kennung}.`,
      ]);

      const res = await post(
        uploadUrl({
          title: 'Vertrag als PDF',
          filename: 'vertrag.pdf',
          departmentTags: ['Recht'],
          tags: ['Vertrag'],
        }),
        pdf,
        'application/pdf',
      );
      expect(res.status).toBe(200);

      const uploaded = documentResponse.parse(await res.json());
      const version = uploaded.dokument.versions[0];
      expect(version?.mimeType).toBe('application/pdf');
      // Read, and non-empty — the two states `null` and `0` both mean the
      // document could never be a hit, so neither would do here.
      expect(version?.extractedChars).toBeGreaterThan(0);

      // The word is unique to this document, so a hit is this document and not
      // a coincidence in a database three suites share.
      const found = documentSearchResponse.parse(
        await (await app.request(`/api/dokumente/suche?q=${kennung}`)).json(),
      );
      expect(found.dokumente.map((hit) => hit.document.id)).toContain(
        uploaded.dokument.document.id,
      );
      expect(found.dokumente[0]?.document.title).toBe('Vertrag als PDF');

      // And German stemming really is in play on the extracted text.
      const gestemmt = documentSearchResponse.parse(
        await (await app.request(`/api/dokumente/suche?q=Kuendigung ${kennung}`)).json(),
      );
      expect(gestemmt.dokumente.map((hit) => hit.document.id)).toContain(
        uploaded.dokument.document.id,
      );
    },
  );

  /**
   * The guard on `MAX_EXTRACTED_CHARS`, from both sides.
   *
   * `document_versions.fts` is a generated tsvector and Postgres refuses to
   * build one past an internal ceiling — an error that arrives at INSERT time,
   * after the bytes are already on the volume. The cap exists to keep that
   * unreachable, and one green case cannot show that it does: a check that can
   * only say yes says nothing. So the case below it puts the *measured first
   * failure* through the same column and requires it to be refused.
   *
   * Together they pin the cap **and** its headroom. If a later Postgres raises
   * the ceiling, the second goes red — which is the right moment for somebody to
   * re-read the measurement, rather than the number quietly ceasing to mean what
   * its comment says.
   */
  const distinctTokens = (chars: number, tokenLength: number): string => {
    const tokens: string[] = [];
    for (let i = 0; tokens.length * (tokenLength + 1) < chars + tokenLength; i += 1) {
      tokens.push(i.toString(36).padStart(tokenLength, 'a').slice(-tokenLength));
    }
    return tokens.join(' ');
  };

  it('verkraftet einen Text in voller Länge der Obergrenze', async () => {
    const text = distinctTokens(MAX_EXTRACTED_CHARS, 4);
    expect(text.length).toBeGreaterThan(MAX_EXTRACTED_CHARS);

    const res = await post(
      uploadUrl({
        title: 'Sehr langes Dokument',
        filename: 'lang.txt',
        departmentTags: [],
        tags: [],
      }),
      text,
    );

    expect(res.status).toBe(200);
    const body = documentResponse.parse(await res.json());
    // Truncated to the cap rather than refused: an unsearchable-past-page-80
    // contract is worth more than no contract.
    expect(body.dokument.versions[0]?.extractedChars).toBe(MAX_EXTRACTED_CHARS);
  });

  it('bestätigt die gemessene Grenze, gegen die die Obergrenze Luft lässt', async () => {
    // 640 KiB of five-character distinct tokens: the smallest refusal found
    // across token lengths 2, 3, 4, 5, 6 and 8 (`extraction.ts`, decision 3).
    const overflowing = distinctTokens(640 * 1024, 5).slice(0, 640 * 1024);
    expect(overflowing.length).toBeGreaterThan(MAX_EXTRACTED_CHARS * 2);

    // Straight at the vault, deliberately: the route cannot reach this case,
    // because the extractor's cap is exactly what stands in the way — which is
    // the property being demonstrated.
    await expect(
      new DocumentVault(sql).create({
        title: 'Über der Grenze',
        version: {
          filename: 'zuviel.txt',
          storagePath: 'sha256/00/nur-fuer-diesen-fall',
          extractedText: overflowing,
        },
      }),
    ).rejects.toThrow(/too long for tsvector/);
  });

  it('meldet eine unbekannte oder unsinnige Dokument-Id als 404, ohne die Datenbank zu fragen', async () => {
    expect((await app.request(`/api/dokumente/${randomUUID()}`)).status).toBe(404);
    // A path segment that is not a uuid would raise `invalid input syntax for
    // type uuid` in Postgres and surface as a 500 for what is a caller's typo.
    expect((await app.request('/api/dokumente/keine-id')).status).toBe(404);
  });

  /**
   * Found by mutation rather than foreseen.
   *
   * With `DocumentStorage`'s rename removed, `PlainTextExtractor` opened a file
   * that was not there, the `ENOENT` travelled out of the route, and Hono
   * answered `Internal Server Error` as plain text — the naked 500 this module
   * exists to avoid, in the one path that runs after the bytes are already on
   * the volume. The extractor is driven directly here because the fault being
   * reproduced is the extractor's, and a real vault and a real docs volume are
   * what make the *rest* of the path genuine.
   */
  it('meldet einen Lesefehler nach dem Ablegen als Ergebnis statt als nackten 500', async () => {
    const deps = {
      vault: new DocumentVault(sql),
      storage: new DocumentStorage({ root: docsRoot, maxBytes: MAX_UPLOAD_BYTES }),
      extractor: {
        extract: async () => {
          throw new Error('ENOENT: no such file or directory');
        },
      },
    };

    const result = await uploadDocument(deps, {
      params: new URLSearchParams({ title: 'Kaputt', filename: 'a.txt' }),
      contentType: 'text/plain',
      contentLength: null,
      body: new TextEncoder().encode('Inhalt'),
      actor: `dashboard:${SESSION}`,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('failed');
    expect(result.errors).toEqual(['Die Datei konnte nach dem Ablegen nicht gelesen werden.']);
    // No row: the failure is reported instead of a document that exists with no
    // text and no explanation. The bytes stay, which is decision 1's cheaper
    // half — litter a sweep can find, rather than a lie.
    const counted = await sql<Array<{ count: string }>>`
      SELECT count(*) AS count FROM documents WHERE title = 'Kaputt'
    `;
    expect(Number(counted[0]?.count ?? -1)).toBe(0);
  });

  it('verlangt einen Suchbegriff, statt eine leere Trefferliste zu behaupten', async () => {
    const res = await app.request('/api/dokumente/suche?q=%20%20');
    expect(res.status).toBe(422);
    expect((await res.json()) as { errors: string[] }).toEqual({
      errors: ['Die Suche braucht einen Suchbegriff.'],
    });
  });
});
