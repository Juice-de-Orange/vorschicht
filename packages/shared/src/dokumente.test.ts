/**
 * The vault's wire contract (§13).
 *
 * Two things are proven here that no test on either side alone can show.
 *
 * The **round trip**: `uploadUrl` builds a URL and `parseUploadQuery` reads one,
 * and they are the pair A81.3 is about — `inboxUrl` built `/inbox/<n>` while the
 * router answered `/posteingang`, one literal in two packages, and every deep
 * link in every notification landed on the wrong page. A builder and a parser in
 * one module can be driven against each other, which is the assertion that was
 * missing.
 *
 * And the **language**: every refusal these schemas can produce is a sentence
 * the operator reads (§2). The module comment above `tagSchema` says why that cannot be
 * enforced by re-wording zod's output the way `apps/server/src/inbox.ts` does,
 * and that this test is the guarantee instead. So it drives every reachable
 * issue rather than a representative one.
 */
import { describe, expect, it } from 'vitest';
import {
  DOKUMENTE_API,
  hasPathOrControlChar,
  isVaultMimeType,
  MAX_DOCUMENT_FILENAME_LENGTH,
  MAX_DOCUMENT_TAG_LENGTH,
  MAX_DOCUMENT_TAGS,
  MAX_DOCUMENT_TITLE_LENGTH,
  mediaType,
  parseUploadQuery,
  parseVersionQuery,
  UPLOAD_QUERY,
  uploadUrl,
  versionUrl,
} from './dokumente.js';

const query = (url: string) => new URLSearchParams(url.slice(url.indexOf('?') + 1));

describe('Upload-URL und ihr Gegenstück', () => {
  it('baut und liest dieselben Angaben zurück', () => {
    const meta = {
      title: 'Vereinsstatuten 2026',
      filename: 'statuten.pdf',
      departmentTags: ['Recht', 'Doku & Archiv'],
      tags: ['Verein', 'Satzung'],
    };
    const parsed = parseUploadQuery(query(uploadUrl(meta)));
    expect(parsed).toEqual({ ok: true, meta });
  });

  // Umlauts, an ampersand and an equals sign are all legal in a free tag and all
  // meaningful in a query string. If either half stopped encoding, the tag would
  // come back cut in two — silently, and only for the tags that contain them.
  it('überlebt Umlaute und Zeichen mit Bedeutung in der Query', () => {
    const meta = {
      title: 'Auftragsverarbeitung & Löschkonzept',
      filename: 'avv.md',
      departmentTags: ['Recht'],
      tags: ['a=b', 'c&d', 'Größe/Umfang'.replace('/', '-')],
    };
    const parsed = parseUploadQuery(query(uploadUrl(meta)));
    expect(parsed).toEqual({ ok: true, meta });
  });

  it('nennt die Route, die der Server registriert', () => {
    expect(uploadUrl({ title: 't', filename: 'f.txt', departmentTags: [], tags: [] })).toMatch(
      new RegExp(`^${DOKUMENTE_API.upload}\\?`),
    );
    const id = '0d1c2f5e-0000-4000-8000-000000000012';
    expect(versionUrl(id, { filename: 'f.txt' })).toMatch(
      new RegExp(`^${DOKUMENTE_API.versions(id)}\\?`),
    );
  });

  it('liest die Version nur über den Dateinamen', () => {
    const parsed = parseVersionQuery(query(versionUrl('x', { filename: 'neu.txt' })));
    expect(parsed).toEqual({ ok: true, meta: { filename: 'neu.txt' } });
  });

  // Absent and empty are the same thing to a query string, and both mean the
  // caller said nothing — never "an empty title".
  it('behandelt eine leere Angabe wie eine fehlende', () => {
    expect(parseUploadQuery(new URLSearchParams()).ok).toBe(false);
    expect(parseUploadQuery(new URLSearchParams('title=&filename=a.txt')).ok).toBe(false);
  });
});

describe('Ablehnungen sind deutsch (§2)', () => {
  /** What zod says when nobody gave it a sentence. Its presence is the failure. */
  const ENGLISH = /too (small|big)|invalid|expected|must contain|received|at least/i;

  const cases: Array<[string, URLSearchParams, string]> = [
    ['kein Titel', new URLSearchParams({ filename: 'a.txt' }), 'Ein Dokument braucht einen Titel.'],
    [
      'Titel zu lang',
      new URLSearchParams({ title: 'x'.repeat(MAX_DOCUMENT_TITLE_LENGTH + 1), filename: 'a.txt' }),
      `Der Titel ist zu lang (höchstens ${MAX_DOCUMENT_TITLE_LENGTH} Zeichen).`,
    ],
    ['kein Dateiname', new URLSearchParams({ title: 'T' }), 'Der Dateiname fehlt.'],
    [
      'Dateiname zu lang',
      new URLSearchParams({
        title: 'T',
        filename: `${'x'.repeat(MAX_DOCUMENT_FILENAME_LENGTH + 1)}.txt`,
      }),
      `Der Dateiname ist zu lang (höchstens ${MAX_DOCUMENT_FILENAME_LENGTH} Zeichen).`,
    ],
    [
      'Pfadtrenner im Dateinamen',
      new URLSearchParams({ title: 'T', filename: '../../etc/passwd' }),
      'Der Dateiname darf keine Pfadtrenner oder Steuerzeichen enthalten.',
    ],
    [
      'Steuerzeichen im Dateinamen',
      new URLSearchParams({ title: 'T', filename: `zeile${String.fromCharCode(10)}zwei.txt` }),
      'Der Dateiname darf keine Pfadtrenner oder Steuerzeichen enthalten.',
    ],
    [
      'Schlagwort zu lang',
      (() => {
        const params = new URLSearchParams({ title: 'T', filename: 'a.txt' });
        params.append(UPLOAD_QUERY.tag, 'x'.repeat(MAX_DOCUMENT_TAG_LENGTH + 1));
        return params;
      })(),
      `Ein Schlagwort ist zu lang (höchstens ${MAX_DOCUMENT_TAG_LENGTH} Zeichen).`,
    ],
    [
      'leeres Schlagwort',
      (() => {
        const params = new URLSearchParams({ title: 'T', filename: 'a.txt' });
        params.append(UPLOAD_QUERY.tag, '   ');
        return params;
      })(),
      'Ein Schlagwort darf nicht leer sein.',
    ],
    [
      'zu viele Schlagworte',
      (() => {
        const params = new URLSearchParams({ title: 'T', filename: 'a.txt' });
        for (let i = 0; i <= MAX_DOCUMENT_TAGS; i += 1)
          params.append(UPLOAD_QUERY.department, `a${i}`);
        return params;
      })(),
      `Höchstens ${MAX_DOCUMENT_TAGS} Abteilungs-Schlagworte.`,
    ],
  ];

  it.each(cases)('%s', (_name, params, expected) => {
    const parsed = parseUploadQuery(params);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.errors).toContain(expected);
    // The blanket half: not merely "the sentence I expected is in there", but
    // "nothing zod wrote itself got out".
    for (const message of parsed.errors) expect(message).not.toMatch(ENGLISH);
  });
});

describe('hasPathOrControlChar', () => {
  it.each(['a/b', 'a\\b', `a${String.fromCharCode(0)}b`, `a${String.fromCharCode(9)}b`])(
    'weist %j ab',
    (value) => {
      expect(hasPathOrControlChar(value)).toBe(true);
    },
  );

  // Umlauts, spaces and dots are ordinary in a document's name and must stay so.
  it.each(['Statuten 2026.pdf', 'Größe.md', 'a-b_c.txt', 'Vertrag (final).pdf'])(
    'lässt %j durch',
    (value) => {
      expect(hasPathOrControlChar(value)).toBe(false);
    },
  );
});

describe('mediaType', () => {
  // A browser always sends the parameter, so a comparison against the raw header
  // would refuse exactly the requests that arrive and accept the ones that do not.
  it.each([
    ['text/plain; charset=utf-8', 'text/plain'],
    ['TEXT/PLAIN', 'text/plain'],
    ['  application/pdf  ', 'application/pdf'],
    ['application/pdf;', 'application/pdf'],
  ])('reduziert %j auf %j', (header, expected) => {
    expect(mediaType(header)).toBe(expected);
  });

  it.each([null, undefined, '', '   ', ';charset=utf-8'])('beantwortet %j mit null', (header) => {
    expect(mediaType(header)).toBeNull();
  });

  it('entscheidet die Allowlist über den reduzierten Wert', () => {
    expect(isVaultMimeType(mediaType('text/markdown; charset=utf-8'))).toBe(true);
    expect(isVaultMimeType(mediaType('application/zip'))).toBe(false);
    expect(isVaultMimeType(null)).toBe(false);
  });
});
