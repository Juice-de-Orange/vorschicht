/**
 * Reading text out of a stored file (§13), against real files.
 *
 * Two of these cases are about failures that would otherwise arrive at INSERT
 * time — after the bytes are on disk — and surface as an upload that failed for
 * no reason anybody could name: a NUL byte, which PostgreSQL `text` cannot hold
 * at all, and a text long enough that its generated tsvector exceeds Postgres'
 * 1 048 575-byte ceiling. The second is guarded here by the character cap and
 * again, mechanically and against a real database, in
 * `apps/server/src/dokumente.itest.ts`.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import {
  classifyDocument,
  classifyPdftotextRun,
  clean,
  MAX_EXTRACTED_CHARS,
  MediaTypeExtractor,
  normalisePdfText,
  PdfTextExtractor,
  PlainTextExtractor,
  pdftotextEnv,
} from './extraction.js';
import { buildDamagedPdf, buildTestPdf, TEST_PDF_CHARS_PER_PAGE } from './pdf-fixture.js';

const dir = mkdtempSync(join(tmpdir(), 'vorschicht-extract-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

let seq = 0;
async function file(content: string | Uint8Array): Promise<string> {
  seq += 1;
  const path = join(dir, `datei-${seq}`);
  await writeFile(path, content);
  return path;
}

const extractor = new PlainTextExtractor();

describe('PlainTextExtractor', () => {
  it('liest eine Textdatei', async () => {
    const path = await file('Die Kündigung erfolgt schriftlich.');
    expect(
      await extractor.extract({ absolutePath: path, mimeType: 'text/plain', filename: 'a.txt' }),
    ).toBe('Die Kündigung erfolgt schriftlich.');
  });

  it('liest Markdown', async () => {
    const path = await file('# Statuten\n\nDer Verein heißt …');
    const text = await extractor.extract({
      absolutePath: path,
      mimeType: 'text/markdown',
      filename: 'a.md',
    });
    expect(text).toContain('Statuten');
  });

  // `null` is the answer §13's search reports as "not read yet" — it is not the
  // same as an empty document, and the whole `nochNichtDurchsuchbar` count rests
  // on this distinction.
  it('antwortet für ein PDF mit null statt mit Leerstring', async () => {
    const path = await file('%PDF-1.7 …');
    expect(
      await extractor.extract({
        absolutePath: path,
        mimeType: 'application/pdf',
        filename: 'vertrag.pdf',
      }),
    ).toBeNull();
  });

  // An empty text file *was* read, and found to contain nothing. A parser that
  // answered `null` here would promise to come back to a file it had already
  // finished with.
  it('unterscheidet „gelesen und leer" von „nicht gelesen"', async () => {
    const path = await file('');
    expect(
      await extractor.extract({ absolutePath: path, mimeType: 'text/plain', filename: 'leer.txt' }),
    ).toBe('');
  });

  it('fällt ohne angegebenen Typ auf die Endung zurück', async () => {
    const path = await file('nur Text');
    expect(
      await extractor.extract({ absolutePath: path, mimeType: null, filename: 'notiz.md' }),
    ).toBe('nur Text');
    expect(
      await extractor.extract({ absolutePath: path, mimeType: null, filename: 'scan.pdf' }),
    ).toBeNull();
  });

  // The declared type is the stronger signal: a caller that says `application/pdf`
  // about `vertrag.txt` has said something, and letting the name overrule it
  // would decide what a file is from the less reliable of the two.
  it('lässt den angegebenen Typ über die Endung siegen', async () => {
    const path = await file('trotzdem Text');
    expect(
      await extractor.extract({
        absolutePath: path,
        mimeType: 'application/pdf',
        filename: 'vertrag.txt',
      }),
    ).toBeNull();
  });

  // Postgres `text` cannot hold U+0000. Without this the INSERT fails *after*
  // the bytes are stored, and the upload dies with a message about an encoding.
  it('entfernt NUL-Bytes, die Postgres nicht speichern kann', async () => {
    const nul = String.fromCharCode(0);
    const path = await file(`Anfang${nul}Mitte${nul}Ende`);
    const text = await extractor.extract({
      absolutePath: path,
      mimeType: 'text/plain',
      filename: 'a.txt',
    });
    expect(text).toBe('AnfangMitteEnde');
    expect(text?.includes(nul)).toBe(false);
  });

  // Refusing an oversized document would keep a legitimate 400 KB contract out
  // of the vault entirely; indexing the first 256 KiB keeps it findable.
  it('kürzt auf die gemessene Obergrenze statt abzulehnen', async () => {
    const path = await file('wort '.repeat(MAX_EXTRACTED_CHARS));
    const text = await extractor.extract({
      absolutePath: path,
      mimeType: 'text/plain',
      filename: 'lang.txt',
    });
    expect(text).not.toBeNull();
    expect(text).toHaveLength(MAX_EXTRACTED_CHARS);
  });

  // Half-readable text is still worth indexing, and the alternative answer —
  // `null` — would claim the file is of a kind nobody can read, which is a
  // different and wrong statement.
  it('wirft bei ungültigem UTF-8 nicht, sondern ersetzt', async () => {
    const path = await file(new Uint8Array([0x41, 0xff, 0xfe, 0x42]));
    const text = await extractor.extract({
      absolutePath: path,
      mimeType: 'text/plain',
      filename: 'kaputt.txt',
    });
    expect(text?.startsWith('A')).toBe(true);
    expect(text?.endsWith('B')).toBe(true);
  });
});

describe('clean', () => {
  it('entfernt erst NUL, dann kürzt es', () => {
    const nul = String.fromCharCode(0);
    // Long enough that the cut lands beyond the cap, so the order is observable:
    // capping first and stripping afterwards would return fewer characters.
    const text = `${nul}${'a'.repeat(MAX_EXTRACTED_CHARS + 10)}`;
    expect(clean(text)).toHaveLength(MAX_EXTRACTED_CHARS);
    expect(clean(text).includes(nul)).toBe(false);
  });

  it('lässt kurzen Text unverändert', () => {
    expect(clean('Kündigung')).toBe('Kündigung');
  });
});

// --- the routing rule, once, so both layers cannot mean different things --------

describe('classifyDocument', () => {
  const input = (mimeType: string | null, filename: string) => ({
    absolutePath: '/egal',
    mimeType,
    filename,
  });

  it('erkennt die angemeldeten Typen', () => {
    expect(classifyDocument(input('text/plain', 'a.txt'))).toBe('text');
    expect(classifyDocument(input('text/markdown', 'a.md'))).toBe('text');
    expect(classifyDocument(input('application/pdf', 'a.pdf'))).toBe('pdf');
  });

  it('nennt alles andere „unknown" statt zu raten', () => {
    expect(classifyDocument(input('application/zip', 'a.zip'))).toBe('unknown');
    expect(classifyDocument(input(null, 'a.docx'))).toBe('unknown');
  });

  it('fällt ohne Typ auf die Endung zurück', () => {
    expect(classifyDocument(input(null, 'scan.pdf'))).toBe('pdf');
    expect(classifyDocument(input(null, 'notiz.MD'))).toBe('text');
  });

  // The rule that must not invert: the declared type is the stronger signal.
  it('lässt den angegebenen Typ über die Endung siegen — in beide Richtungen', () => {
    expect(classifyDocument(input('application/pdf', 'vertrag.txt'))).toBe('pdf');
    expect(classifyDocument(input('text/plain', 'vertrag.pdf'))).toBe('text');
  });
});

// --- the two pure halves of the PDF path ---------------------------------------

describe('normalisePdfText', () => {
  const FF = String.fromCharCode(12);

  it('nimmt den Seitenumbruch heraus und trimmt', () => {
    expect(normalisePdfText(`Kündigung erfolgt schriftlich\n\n${FF}`)).toBe(
      'Kündigung erfolgt schriftlich',
    );
  });

  // The measured output of a valid PDF with no text layer. Without this the
  // honest `''` of decision 1 would be unreachable for every scan in the vault.
  it('macht aus der Ausgabe eines Scans ohne Textschicht einen Leerstring', () => {
    expect(normalisePdfText(FF)).toBe('');
    expect(normalisePdfText(`${FF}${FF}${FF}`)).toBe('');
  });

  it('behält den Text mehrerer Seiten', () => {
    const text = normalisePdfText(`Seite1\n\n${FF}Seite2\n\n${FF}`);
    expect(text).toContain('Seite1');
    expect(text).toContain('Seite2');
    expect(text).not.toContain(FF);
  });

  // Trim runs before the cap, so a long document comes back at exactly the cap
  // rather than a few characters under it.
  it('kürzt zuletzt, auf genau die Obergrenze', () => {
    expect(normalisePdfText(`${FF}${'a'.repeat(MAX_EXTRACTED_CHARS + 500)}`)).toHaveLength(
      MAX_EXTRACTED_CHARS,
    );
  });
});

/**
 * The measured table of `classifyPdftotextRun`, asserted without poppler.
 *
 * The row that carries the whole design is `refused` with empty output → `null`
 * and `ok` with empty output → `''`: identical stdout, opposite answers, and the
 * exit code is the only thing that separates them. The two rows below it are the
 * reason the exit code cannot decide *alone* in the other direction.
 */
describe('classifyPdftotextRun', () => {
  const FF = String.fromCharCode(12);

  it('liest Text als Text', () => {
    expect(classifyPdftotextRun({ outcome: 'ok', stdout: `Kündigung\n\n${FF}` })).toBe('Kündigung');
  });

  it('liest einen Scan ohne Textschicht als „gelesen und leer"', () => {
    expect(classifyPdftotextRun({ outcome: 'ok', stdout: FF })).toBe('');
  });

  it('liest eine Verweigerung ohne Ausgabe als „nicht gelesen"', () => {
    expect(classifyPdftotextRun({ outcome: 'refused', stdout: '' })).toBeNull();
  });

  // Poppler recovers part of some damaged documents. Indexing what it recovered
  // beats declaring the document unreadable — so the exit code does not decide.
  it('behält Text, den poppler trotz Fehlercode retten konnte', () => {
    expect(classifyPdftotextRun({ outcome: 'refused', stdout: `Halbe Rettung\n${FF}` })).toBe(
      'Halbe Rettung',
    );
  });

  it('antwortet „nicht gelesen", wenn das Binär fehlt oder der Lauf abgebrochen wurde', () => {
    expect(classifyPdftotextRun({ outcome: 'unavailable' })).toBeNull();
    expect(classifyPdftotextRun({ outcome: 'aborted' })).toBeNull();
  });

  it('nimmt eine am Puffer gekürzte Ausgabe als Text', () => {
    expect(classifyPdftotextRun({ outcome: 'truncated', stdout: 'Anfang eines langen' })).toBe(
      'Anfang eines langen',
    );
  });
});

/**
 * The environment boundary, which is what makes decision 2's sentence true.
 *
 * `execFile` inherits all of `process.env` unless handed one, so "it lands in a
 * child without access to them" is a claim about this function alone. Asserted
 * twice: here over the value it builds, and below over what a real child
 * actually saw.
 */
describe('pdftotextEnv', () => {
  it('reicht keines der Geheimnisse des app-Dienstes weiter', () => {
    const env = pdftotextEnv({
      PATH: '/usr/bin',
      SESSION_SECRET: 'streng-geheim',
      DATABASE_URL: 'postgres://user:pw@db/vorschicht',
      NTFY_TOKEN: 'tk_geheim',
      CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-geheim',
    });
    expect(Object.keys(env).sort()).toEqual(['LC_ALL', 'PATH']);
    expect(JSON.stringify(env)).not.toContain('geheim');
  });

  it('gibt dem Kind einen PATH, damit der Programmname auflösbar bleibt', () => {
    expect(pdftotextEnv({ PATH: '/usr/bin' }).PATH).toBe('/usr/bin');
    expect(pdftotextEnv({}).PATH).toBeTruthy();
  });
});

// --- the extractor itself ---------------------------------------------------------

const pdftotextAvailable = (() => {
  try {
    execFileSync('pdftotext', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

/**
 * Everything here needs no poppler — these are the answers about *not* having
 * it, and they run everywhere.
 *
 * The split is deliberate and it is the answer to A61/A79.4: a suite that can
 * skip itself silently is not a suite anything may trust. So the three
 * assertions that carry this subsystem's *justification* — the environment
 * boundary, "a filesystem fault throws rather than answering `null`", and
 * "a missing binary is `null` and never `''`" — are in this block and cannot
 * skip, as are all of `classifyPdftotextRun`'s measured rows. What the block
 * below adds is that real poppler behaves the way those rows say, and its
 * presence is separately guaranteed where it matters: `Dockerfile.app` fails
 * the build if `pdftotext` is not there and not the expected version.
 */
describe('PdfTextExtractor ohne poppler', () => {
  const missing = new PdfTextExtractor({ binary: 'pdftotext-gibt-es-hier-nicht' });

  // Mutation (a): answering `''` here would say "a parser ran and found
  // nothing" about a machine that has no parser at all — the document would be
  // recorded as finished and never revisited.
  it('antwortet „nicht gelesen" (null), wenn das Binär fehlt — niemals mit Leerstring', async () => {
    const path = await file(buildTestPdf(['Kündigung']));
    const text = await missing.extract({
      absolutePath: path,
      mimeType: 'application/pdf',
      filename: 'a.pdf',
    });
    expect(text).toBeNull();
    expect(text).not.toBe('');
  });

  it('fasst ein Nicht-PDF nicht an', async () => {
    const path = await file('nur Text');
    expect(
      await missing.extract({ absolutePath: path, mimeType: 'text/plain', filename: 'a.txt' }),
    ).toBeNull();
  });

  /**
   * A filesystem fault has to travel as a throw, and this is the case that says
   * so. `describeUpload` turns a throw into a named 4xx and requires that `null`
   * keep meaning "no parser reads this kind of file"; with `-q` poppler reports a
   * missing file and a damaged one identically, so without the `open()` ahead of
   * the subprocess this would silently file "the bytes are gone" as "unreadable
   * type" — the regression a mutation found once already.
   */
  it('wirft, wenn die Datei gar nicht da ist — statt sie „nicht lesbar" zu nennen', async () => {
    await expect(
      missing.extract({
        absolutePath: join(dir, 'gibt-es-nicht.pdf'),
        mimeType: 'application/pdf',
        filename: 'weg.pdf',
      }),
    ).rejects.toThrow();
  });

  /**
   * The environment boundary, end to end through the real spawn path.
   *
   * The stand-in prints what it was given, so what is asserted is what a child
   * actually saw rather than what we meant to hand it. Measured against the
   * unfixed shape: with an inherited environment the same child prints
   * `[streng-geheim]`.
   */
  it('startet das Kind ohne die Geheimnisse des Elternprozesses', async () => {
    const stub = join(dir, 'env-petze.sh');
    // `printenv` asks the child's own environment and fails exactly when the
    // variable is unset, which is the state under test. Deliberately not shell
    // parameter expansion: `${…}` in a JS string needs a lint suppression, and a
    // rule one does not trigger needs no exception.
    await writeFile(stub, '#!/bin/sh\nprintenv SESSION_SECRET || echo nichts\n');
    chmodSync(stub, 0o755);
    const path = await file(buildTestPdf(['egal']));

    const before = process.env.SESSION_SECRET;
    process.env.SESSION_SECRET = 'streng-geheim';
    try {
      const seen = await new PdfTextExtractor({ binary: stub }).extract({
        absolutePath: path,
        mimeType: 'application/pdf',
        filename: 'a.pdf',
      });
      expect(seen).toBe('nichts');
      expect(seen).not.toContain('streng-geheim');
    } finally {
      if (before === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = before;
    }
  });
});

describe.skipIf(!pdftotextAvailable)('PdfTextExtractor gegen echtes pdftotext', () => {
  const extractor = new PdfTextExtractor();
  const asPdf = (path: string) => ({
    absolutePath: path,
    mimeType: 'application/pdf',
    filename: 'dokument.pdf',
  });

  it('liest die Textschicht, Umlaute eingeschlossen', async () => {
    const path = await file(buildTestPdf(['Die Kündigung erfolgt schriftlich']));
    expect(await extractor.extract(asPdf(path))).toBe('Die Kündigung erfolgt schriftlich');
  });

  it('liest mehrere Seiten', async () => {
    const path = await file(buildTestPdf(['Erste Seite', 'Zweite Seite']));
    const text = await extractor.extract(asPdf(path));
    expect(text).toContain('Erste Seite');
    expect(text).toContain('Zweite Seite');
  });

  // The scan: a real page that renders something and carries no text. `''` says
  // a parser ran and found nothing — which stays distinguishable from `null`,
  // and is what a page shows as "durchsucht, kein Text". No OCR, deliberately.
  it('antwortet für ein PDF ohne Textschicht mit Leerstring, nicht mit null', async () => {
    const path = await file(buildTestPdf([null]));
    const text = await extractor.extract(asPdf(path));
    expect(text).toBe('');
    expect(text).not.toBeNull();
  });

  it('antwortet für eine kaputte Datei mit null', async () => {
    const path = await file(buildDamagedPdf());
    expect(await extractor.extract(asPdf(path))).toBeNull();
  });

  // The cap has to bind on this path too: `document_versions.fts` is a generated
  // tsvector and Postgres refuses one past its ceiling, at INSERT time — after
  // the bytes are already on the volume.
  it('kürzt auf MAX_EXTRACTED_CHARS', async () => {
    const page = 'wortwort '.repeat(TEST_PDF_CHARS_PER_PAGE / 9);
    const pages = Math.ceil((MAX_EXTRACTED_CHARS * 1.2) / page.length);
    const path = await file(buildTestPdf(Array.from({ length: pages }, () => page)));
    const text = await extractor.extract(asPdf(path));
    expect(text).toHaveLength(MAX_EXTRACTED_CHARS);
  });
});

// --- the chooser -------------------------------------------------------------------

describe('MediaTypeExtractor', () => {
  /** Records what it was asked, so routing is observable rather than inferred. */
  const spy = (answer: string | null) => {
    const seen: string[] = [];
    return {
      seen,
      extract: async (input: { filename: string }) => {
        seen.push(input.filename);
        return answer;
      },
    };
  };

  it('gibt Text an den Text-Extraktor und PDF an den PDF-Extraktor', async () => {
    const text = spy('aus Text');
    const pdf = spy('aus PDF');
    const chooser = new MediaTypeExtractor({ text, pdf });

    expect(
      await chooser.extract({ absolutePath: '/a', mimeType: 'text/plain', filename: 'a.txt' }),
    ).toBe('aus Text');
    expect(
      await chooser.extract({ absolutePath: '/b', mimeType: 'application/pdf', filename: 'b.pdf' }),
    ).toBe('aus PDF');

    // Mutation (c) — a chooser that hands everything to the PDF extractor —
    // is only visible as *which* extractor was asked; both answers alone would
    // still differ, so the record of the calls is what pins it.
    expect(text.seen).toEqual(['a.txt']);
    expect(pdf.seen).toEqual(['b.pdf']);
  });

  it('antwortet für einen unbekannten Typ mit null und fragt niemanden', async () => {
    const text = spy('aus Text');
    const pdf = spy('aus PDF');
    const chooser = new MediaTypeExtractor({ text, pdf });

    expect(
      await chooser.extract({ absolutePath: '/c', mimeType: 'application/zip', filename: 'c.zip' }),
    ).toBeNull();
    expect(text.seen).toEqual([]);
    expect(pdf.seen).toEqual([]);
  });

  it('ist voreingestellt die Verdrahtung des Servers', async () => {
    const chooser = new MediaTypeExtractor();
    const path = await file('Die Kündigung erfolgt schriftlich.');
    expect(
      await chooser.extract({ absolutePath: path, mimeType: 'text/plain', filename: 'a.txt' }),
    ).toBe('Die Kündigung erfolgt schriftlich.');
  });
});
