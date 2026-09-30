/**
 * PDFs built from bytes, for the tests that prove §13's PDF extraction.
 *
 * Nothing binary is checked in — the same rule A54.5 and A89.1 already apply to
 * the sandbox project, and for a sharper reason here: two of the documents this
 * module produces are *deliberately unreadable*, and a damaged PDF committed to
 * a repository is a damaged PDF committed to a repository, whatever the intent.
 *
 * It is exported from the package index rather than kept beside its tests
 * because two suites in two packages need the same fixture — `extraction.test.ts`
 * in core and `dokumente.itest.ts` in the server — and two hand-rolled copies of
 * a PDF writer would drift, which would leave the unit proof and the integration
 * proof quietly talking about different documents. `createTestDatabase` is
 * shipped out of `@vorschicht/db` on exactly this precedent.
 *
 * The generated file is a real one: a catalogue, a page tree, one content stream
 * per page and a **correct** xref table with real byte offsets. Poppler will
 * happily reconstruct a broken xref, so writing one carelessly would mean the
 * tests exercise its recovery path rather than its ordinary one — and the
 * damaged-file case below would stop being distinguishable from the healthy one.
 */

/** Text on a page, or `null` for a page carrying no text layer at all. */
export type TestPdfPage = string | null;

/**
 * Escape one string into a PDF literal in WinAnsiEncoding.
 *
 * `\`, `(` and `)` are the literal's own metacharacters; everything outside
 * printable ASCII travels as an octal escape. A code point past 255 has no
 * WinAnsi byte, and this **throws** rather than substituting one: a fixture that
 * silently mangles its input is a fixture whose failures are about itself.
 */
function pdfLiteral(text: string): string {
  let out = '';
  for (const character of text) {
    const code = character.codePointAt(0) ?? 0;
    if (code > 255) {
      throw new Error(
        `„${character}" lässt sich nicht in WinAnsiEncoding darstellen — ` +
          'diese Fixture erzeugt nur Text aus dem Latin-1-Bereich.',
      );
    }
    if (character === '\\' || character === '(' || character === ')') out += `\\${character}`;
    else if (code < 32 || code > 126) out += `\\${code.toString(8).padStart(3, '0')}`;
    else out += character;
  }
  return out;
}

/**
 * Layout, and the reason this fixture wraps instead of writing one long line.
 *
 * Measured: poppler extracts what is *on the page*. A single 36 000-character
 * `Tj` at one position produced **53 characters** — the rest ran off the right
 * edge and was clipped, exactly as it would be in a viewer. A fixture that
 * wrote one line per page would therefore make a cap test pass or fail for
 * reasons having nothing to do with the cap.
 *
 * 6 pt Helvetica averages well under 3.3 pt per character, so 100 characters
 * occupy ~330 pt of the 540 pt of usable width; 7 pt of leading fits 110 lines
 * between y=780 and y=10.
 */
const CHARS_PER_LINE = 100;
const LINE_LEADING = 7;
const FIRST_BASELINE = 780;
const LAST_BASELINE = 10;
const LINES_PER_PAGE = Math.floor((FIRST_BASELINE - LAST_BASELINE) / LINE_LEADING) + 1;

/** How much text one page of this fixture can actually show. */
export const TEST_PDF_CHARS_PER_PAGE = CHARS_PER_LINE * LINES_PER_PAGE;

/** A content stream that shows `text`, or draws a filled rectangle and no text. */
function contentStream(page: TestPdfPage): string {
  if (page === null) return '0 0 0 rg 100 100 200 200 re f';

  const lines: string[] = [];
  for (let start = 0; start < page.length; start += CHARS_PER_LINE) {
    lines.push(page.slice(start, start + CHARS_PER_LINE));
  }
  if (lines.length > LINES_PER_PAGE) {
    // Refusing beats truncating: a fixture that quietly dropped the overflow
    // would let a test about a character cap be decided by page geometry, and
    // nothing would say so.
    throw new Error(
      `${page.length} Zeichen passen nicht auf eine Seite dieser Fixture ` +
        `(höchstens ${TEST_PDF_CHARS_PER_PAGE}) — auf mehrere Seiten verteilen.`,
    );
  }

  const shown = lines
    .map(
      (line, index) =>
        `1 0 0 1 72 ${FIRST_BASELINE - index * LINE_LEADING} Tm (${pdfLiteral(line)}) Tj`,
    )
    .join('\n');
  return `BT /F1 6 Tf\n${shown}\nET`;
}

/**
 * A valid PDF with one content stream per entry.
 *
 * `buildTestPdf(['Kündigung'])` has a text layer; `buildTestPdf([null])` is the
 * shape of a scan — a real page that renders something and carries no text — and
 * is the document the `''` answer exists for.
 */
export function buildTestPdf(pages: readonly TestPdfPage[]): Uint8Array {
  if (pages.length === 0) throw new Error('Ein PDF braucht mindestens eine Seite.');

  // Object numbering: 1 catalogue, 2 page tree, 3 font, then (page, stream)
  // pairs from 4 onwards.
  const objects: string[] = [];
  const kids = pages.map((_, index) => `${4 + index * 2} 0 R`);
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  objects[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  pages.forEach((page, index) => {
    const body = contentStream(page);
    objects[4 + index * 2] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${5 + index * 2} 0 R ` +
      '/Resources << /Font << /F1 3 0 R >> >> >>';
    objects[5 + index * 2] =
      `<< /Length ${Buffer.byteLength(body, 'latin1')} >>\nstream\n${body}\nendstream`;
  });

  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  for (let index = 1; index < objects.length; index += 1) {
    offsets[index] = Buffer.byteLength(out, 'latin1');
    out += `${index} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let index = 1; index < objects.length; index += 1) {
    out += `${String(offsets[index]).padStart(10, '0')} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, 'latin1'));
}

/**
 * Something that claims to be a PDF and is not.
 *
 * The header is right — so nothing decides this by sniffing the first bytes —
 * and everything after it is missing. Measured: poppler exits 1 and, under `-q`,
 * says nothing on either stream.
 */
export function buildDamagedPdf(): Uint8Array {
  return new Uint8Array(Buffer.from('%PDF-1.7\nhier fehlt der ganze Rest\n', 'latin1'));
}
