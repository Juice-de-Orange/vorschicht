/**
 * Reading the text out of an uploaded file, for §13's full-text search.
 *
 * This is a **seam plus one implementation**, deliberately. Migration 0020's
 * decision 5 and `DocumentVault`'s decision 4 say why the seam cannot be
 * skipped and why the implementation cannot be postponed: `document_versions`
 * is append-only and its guard binds the owner too, so there is no code path
 * anywhere that fills text into a row which already exists. "A later job
 * back-fills it" is not a design here — it is impossible. Extraction therefore
 * runs *before* the insert, on the file that has just been stored, and the
 * result is an argument to the write.
 *
 * Five decisions.
 *
 *   1. **`null` and `''` are different answers, and this interface keeps them
 *      apart.** `null` means *this extractor cannot read this kind of file* —
 *      the version is still created, it simply is not searchable, and the
 *      search answer says how many such documents exist
 *      (`nochNichtDurchsuchbar`). `''` means a parser ran and found nothing,
 *      which is the honest result for a scan with no text layer. Collapsing
 *      them would make "we have not read it" and "there is nothing in it" the
 *      same fact, and only the first is a promise to come back.
 *
 *   2. **PDF is read by `pdftotext` in a subprocess, never by a library in
 *      this process.** Every PDF parser is a parsing surface pointed at
 *      attacker-shaped input, and the known failure class for the JavaScript
 *      one is *arbitrary code execution* (CVE-2024-4367, and CVE-2026-16633
 *      published 2026-08-06, fixed only in pdf.js 6.2.108). In-process, a hit
 *      lands in the Node process that holds `SESSION_SECRET`, `DATABASE_URL`
 *      and — measured in `infra/docker-compose.yml`, not assumed —
 *      `CLAUDE_CODE_OAUTH_TOKEN`. In a subprocess with a minimal environment
 *      (`pdftotextEnv`) it lands in a child that holds none of them. Poppler's
 *      failure class is denial of service, not code execution, and the
 *      `timeout` below is what answers that one.
 *
 *      The rejected alternatives, so nobody re-derives them: `unpdf` bundles
 *      pdf.js as a *devDependency*, which makes it invisible to `npm audit`,
 *      to §11's `deps-audit` gate and to the radar — the three channels that
 *      would otherwise tell us about the next such CVE; `mupdf` is
 *      AGPL-3.0-or-later, and the dashboard is publicly reachable (§2);
 *      `pdf-parse` is ~55 MB carrying a frozen pdf.js with no update channel
 *      of its own.
 *
 *   3. **The character cap is measured, not chosen.** `document_versions.fts`
 *      is a `GENERATED ALWAYS … STORED` tsvector, and Postgres refuses a
 *      tsvector over **1 048 575 bytes** — measured, not looked up: 1 042 321
 *      characters of distinct tokens answered
 *      *"string is too long for tsvector (1447802 bytes, max 1048575 bytes)"*.
 *      That error would arrive at INSERT time, i.e. after the bytes were
 *      already on disk, and would surface as a failed upload nobody could
 *      explain. So the cap has to make it unreachable.
 *
 *      The vector grows with the number of *distinct* lexemes, not with length
 *      — 4 MiB of repeating German prose produces 3 686 bytes, because
 *      positions per lexeme are capped. The adversarial shape is therefore "as
 *      many distinct short tokens as fit", and it was measured across token
 *      lengths on PostgreSQL 16:
 *
 *        262 144 chars, 4-char tokens →   612 788 bytes   (2.34 B/char, worst)
 *        524 288 chars, 4-char tokens → 1 239 196 bytes   — over the limit
 *
 *      So 256 KiB of characters is safe by a factor of 1.7 against the worst
 *      shape observed, and 512 KiB is not. `vault-storage.itest.ts` puts a full
 *      cap's worth of exactly that shape through the real vault, so the
 *      constant is guarded mechanically rather than by this paragraph.
 *
 *   4. **Truncation is silent in the text and visible in the number.** A
 *      document over the cap is indexed up to it rather than refused: refusing
 *      would keep a legitimate 400 KB contract out of the vault entirely, and
 *      an unsearchable-past-page-80 contract is worth more than no contract.
 *      What says so is `extractedChars` beside `byteSize` on the version.
 *
 *   5. **NUL bytes are removed, and that is a correctness fix rather than
 *      hygiene.** PostgreSQL `text` cannot hold `U+0000` at all; a single one
 *      in a file a caller labelled `text/plain` would fail the INSERT after the
 *      bytes were stored — decision 3's failure mode by a different route.
 */
import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/**
 * Decision 3. Characters, not bytes: the tsvector is built from the decoded
 * text, so the character count is what bounds it.
 */
export const MAX_EXTRACTED_CHARS = 256 * 1024;

/**
 * How much of a file is read before decoding.
 *
 * Four bytes is the longest UTF-8 encoding of one character, so reading four
 * times the character cap guarantees the character cap is the one that binds —
 * and bounds the read at 1 MiB whatever the file's size.
 */
export const MAX_EXTRACTED_BYTES = MAX_EXTRACTED_CHARS * 4;

export interface ExtractionInput {
  /** The stored file, already on the docs volume. */
  absolutePath: string;
  /** The media type the upload declared, without parameters. */
  mimeType: string | null;
  /** The original name — the fallback when no media type was declared. */
  filename: string;
}

export interface TextExtractor {
  /** The document's text, `''` when it has none, `null` when it cannot be read. */
  extract(input: ExtractionInput): Promise<string | null>;
}

/** Media types the plain-text extractor reads. */
export const PLAIN_TEXT_MIME_TYPES = ['text/plain', 'text/markdown'] as const;

/** …and the extensions it falls back to when nothing declared a type. */
export const PLAIN_TEXT_EXTENSIONS = ['.txt', '.md', '.markdown', '.text'] as const;

/** Media types the PDF extractor reads. */
export const PDF_MIME_TYPES = ['application/pdf'] as const;

/** …and its extension fallback, on the same terms. */
export const PDF_EXTENSIONS = ['.pdf'] as const;

/** What kind of file this is, as far as extraction is concerned. */
export type DocumentKind = 'text' | 'pdf' | 'unknown';

/**
 * The one place a media type becomes a decision.
 *
 * Both extractors guard themselves with this **and** `MediaTypeExtractor`
 * routes with it, which is two layers only because they are literally the same
 * function — A62.4's rule, that two layers are two layers only when they refuse
 * the same strings. Writing the routing table a second time inside the chooser
 * is exactly where "the declared type wins" would come to mean one thing there
 * and another here.
 *
 * The declared type beats the extension and never the other way round: a caller
 * that says `application/pdf` about `vertrag.txt` has said something, and
 * letting the name win would decide what a file is from the less reliable of
 * the two signals.
 */
export function classifyDocument(input: ExtractionInput): DocumentKind {
  if (input.mimeType) {
    if ((PLAIN_TEXT_MIME_TYPES as readonly string[]).includes(input.mimeType)) return 'text';
    if ((PDF_MIME_TYPES as readonly string[]).includes(input.mimeType)) return 'pdf';
    return 'unknown';
  }
  const name = input.filename.toLowerCase();
  if (PLAIN_TEXT_EXTENSIONS.some((extension) => name.endsWith(extension))) return 'text';
  if (PDF_EXTENSIONS.some((extension) => name.endsWith(extension))) return 'pdf';
  return 'unknown';
}

/**
 * Text and Markdown, read as UTF-8.
 *
 * The extension is consulted **only** when no media type was declared, never to
 * override one — `classifyDocument` is where that rule lives.
 */
export class PlainTextExtractor implements TextExtractor {
  async extract(input: ExtractionInput): Promise<string | null> {
    if (classifyDocument(input) !== 'text') return null;

    const handle = await open(input.absolutePath, 'r');
    try {
      const buffer = Buffer.alloc(MAX_EXTRACTED_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, MAX_EXTRACTED_BYTES, 0);
      // `fatal: false` so a file that is not valid UTF-8 yields replacement
      // characters rather than throwing: half-readable text is still worth
      // indexing, and the alternative answer — `null` — would claim the file
      // is of a kind nobody can read, which is a different and wrong statement.
      // A cut in the middle of a multi-byte sequence produces one such
      // character at the very end, which is the price of a bounded read.
      const decoded = new TextDecoder('utf-8', { fatal: false }).decode(
        buffer.subarray(0, bytesRead),
      );
      return clean(decoded);
    } finally {
      await handle.close();
    }
  }
}

/**
 * `U+0000`, built from its code point rather than written as a literal.
 *
 * A NUL in source is invisible in every diff and in every review, and several
 * editors drop it silently — so the one character this module exists to remove
 * would be the one character a reader could not see it removing.
 */
const NUL = String.fromCharCode(0);

/** Decisions 4 and 5, in the order that matters: strip first, then cap. */
export function clean(text: string): string {
  const withoutNul = text.includes(NUL) ? text.replaceAll(NUL, '') : text;
  return withoutNul.length > MAX_EXTRACTED_CHARS
    ? withoutNul.slice(0, MAX_EXTRACTED_CHARS)
    : withoutNul;
}

// --- PDF, through a subprocess ---------------------------------------------------

/**
 * What `Dockerfile.app` installs. A bare name, resolved through the child's own
 * `PATH` (`pdftotextEnv`), so a test can point at a stand-in instead.
 */
export const PDFTOTEXT_BINARY = 'pdftotext';

/**
 * Poppler's failure class is denial of service, and this is the answer to it.
 *
 * Generous on purpose: the cost of cutting a slow but honest parse short is a
 * document that reads as unsearchable, and a minute is far past anything a
 * document a human uploaded should need.
 */
export const PDF_EXTRACT_TIMEOUT_MS = 60_000;

/**
 * `U+000C`, poppler's page separator — built from its code point for the same
 * reason `NUL` is: a literal form feed is invisible in a diff and in a review.
 */
const PAGE_BREAK = String.fromCharCode(12);

/**
 * The child's whole environment, and the reason decision 2's sentence is true.
 *
 * `execFile` inherits all of `process.env` unless it is given one — which is
 * what `secret-scan.ts` does, correctly, because gitleaks is our own pinned
 * binary reading our own tree. This subprocess is the opposite case: it parses
 * a file a caller uploaded. "It lands in a child without access to them" is a
 * claim about this function and about nothing else, so an inherited
 * `SESSION_SECRET`, `DATABASE_URL`, `NTFY_TOKEN` or `CLAUDE_CODE_OAUTH_TOKEN`
 * (all four are on the `app` service, measured in `infra/docker-compose.yml`)
 * would leave the process boundary carrying none of the weight it is here for.
 *
 * `PATH` because the binary is named rather than pathed, and libuv resolves it
 * through the environment it is handed. `LC_ALL=C` so poppler's own output does
 * not depend on a locale that differs between a developer's machine and the
 * image.
 */
export function pdftotextEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { PATH: source.PATH ?? '/usr/local/bin:/usr/bin:/bin', LC_ALL: 'C' };
}

/**
 * Page separators out, then the ordinary cleaning.
 *
 * The form feed is why this function exists at all, and it was measured rather
 * than assumed: a valid PDF with **no text layer** — a scan — produces exactly
 * `"\f"` and exit 0. Left alone, the honest `''` answer of decision 1 would be
 * unreachable for the single most common unreadable document in a vault, and
 * every scan would be indexed as one character of nothing.
 *
 * Trim before `clean`, so the cap is the last thing applied and a document over
 * it comes back at exactly `MAX_EXTRACTED_CHARS`.
 */
export function normalisePdfText(stdout: string): string {
  return clean(stdout.replaceAll(PAGE_BREAK, '\n').trim());
}

/** How one `pdftotext` invocation ended. */
export type PdftotextRun =
  | { outcome: 'ok'; stdout: string }
  | { outcome: 'truncated'; stdout: string }
  | { outcome: 'refused'; stdout: string }
  | { outcome: 'unavailable' }
  | { outcome: 'aborted' };

/**
 * One finished invocation, turned into decision 1's three answers.
 *
 * Pure and exported so the measured table below is asserted directly, rather
 * than only through a binary that has to be installed to ask —
 * `classifyGitleaksRun` is the same arrangement for the same reason.
 *
 * Measured against poppler 24.02.0, `-q -enc UTF-8 <file> -`, each case
 * captured with no pipe in between:
 *
 * | case | exit | stdout | answer |
 * |---|---|---|---|
 * | text layer | 0 | `"…schriftlich\n\n\f"` | the text |
 * | **no** text layer (a scan) | 0 | `"\f"` | `''` |
 * | not a PDF / damaged | 1 | *empty* | `null` |
 * | binary not installed | — (`ENOENT`) | — | `null` |
 *
 * The exit code decides nothing on its own, and the fourth row is why: `-q`
 * silences stderr, so a damaged file, an empty file and a file that is not
 * there are **all** exit 1 with nothing on either stream (measured, all three).
 * What separates a refusal from a success is the output. A non-zero exit that
 * still produced text is a PDF poppler partially recovered, and indexing what
 * it recovered is strictly better than declaring the document unreadable.
 *
 * A run that was killed answers `null` even when partial output survived: a
 * parse that hung is not a statement about the document, and half of one is
 * worse than saying so. `truncated` is the exception and is not a kill in that
 * sense — the cap was always going to bind (decision 4), the buffer merely
 * reached it first.
 */
export function classifyPdftotextRun(run: PdftotextRun): string | null {
  if (run.outcome === 'unavailable' || run.outcome === 'aborted') return null;
  const text = normalisePdfText(run.stdout);
  if (run.outcome === 'refused') return text === '' ? null : text;
  return text;
}

/**
 * PDF, read by `pdftotext` out of process.
 *
 * **No OCR, deliberately.** A scanned page with no text layer is read
 * successfully and found to contain nothing, so it answers `''` — decision 1's
 * "a parser ran and found nothing", which is the honest result and stays
 * distinguishable from `null`. What a page shows for it is "durchsucht, kein
 * Text" rather than "noch nicht gelesen", and adding OCR later changes that
 * answer for exactly those documents without changing anything else here.
 *
 * **No version gate, and that is a departure from A104 worth naming.**
 * `AutoSecretScanner` refuses a gitleaks that is not the pin, because that
 * binary decides a *locked gate* and a second rule engine would mean a merge
 * blocked on one machine and passed on another. This one decides whether a
 * document is searchable. Debian bookworm ships poppler 22.12.0 and a
 * developer's Ubuntu 24.04 ships 24.02.0 (both measured), so a version gate
 * here would answer `null` for every PDF on every developer machine — turning
 * a pin into a feature that only works in production. The pin such as it is
 * lives in the image: `Dockerfile.app` asserts the version it installed, and
 * the digest-pinned base is what makes that assertion mean something (A34).
 */
export class PdfTextExtractor implements TextExtractor {
  constructor(private readonly options: { binary?: string; timeoutMs?: number } = {}) {}

  private get binary(): string {
    return this.options.binary ?? PDFTOTEXT_BINARY;
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? PDF_EXTRACT_TIMEOUT_MS;
  }

  async extract(input: ExtractionInput): Promise<string | null> {
    if (classifyDocument(input) !== 'pdf') return null;

    // Establish that the file is there and readable **here**, before the
    // subprocess — and let the failure travel as a throw, exactly as
    // `PlainTextExtractor` gets for free from its own `open()`.
    //
    // This is load-bearing rather than tidy. `describeUpload` in
    // `apps/server/src/dokumente.ts` requires a filesystem fault to throw and
    // says why: degrading it to `null` would file "the bytes are missing" as
    // "no parser can read this kind of file" and put a permanently unsearchable
    // document in the vault with nothing anywhere saying why. That regression
    // was found once by mutation (removing `DocumentStorage`'s rename), and
    // without these two lines the PDF path would quietly restore it — because
    // with `-q` a missing file is indistinguishable from a damaged one.
    const handle = await open(input.absolutePath, 'r');
    await handle.close();

    return classifyPdftotextRun(await this.run(input.absolutePath));
  }

  private async run(path: string): Promise<PdftotextRun> {
    try {
      const { stdout } = await exec(
        this.binary,
        // `-q` because the alternative is reading poppler's warning prose off
        // stderr, and that is a vocabulary the vendor owns and reworded between
        // the two versions this project runs (A73.4, A104.4 refused the same
        // thing). `-enc UTF-8` because the column is `text` and the default
        // encoding is not. `-` writes to stdout: a report path would need a
        // writable location, and the app container's rootfs is read-only.
        ['-q', '-enc', 'UTF-8', path, '-'],
        {
          timeout: this.timeoutMs,
          // Four bytes per character is the longest UTF-8 encoding, so a full
          // buffer always carries more characters than the cap — the cap binds,
          // and this only decides how much work is done before it does.
          maxBuffer: MAX_EXTRACTED_BYTES,
          env: pdftotextEnv(),
        },
      );
      return { outcome: 'ok', stdout };
    } catch (error) {
      const err = error as Error & {
        stdout?: string;
        code?: number | string;
        killed?: boolean;
        signal?: string | null;
      };
      // Measured: node kills the child on `maxBuffer` and still hands back what
      // it had collected, so this is truncation and not a failure.
      if (err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        return { outcome: 'truncated', stdout: err.stdout ?? '' };
      }
      if (err.killed === true || (err.signal ?? null) !== null) return { outcome: 'aborted' };
      // A string code is libuv's — `ENOENT` when poppler is not installed at
      // all, which is the ordinary state of a machine that never built the
      // image. A number is poppler's own exit status.
      if (typeof err.code === 'string') return { outcome: 'unavailable' };
      return { outcome: 'refused', stdout: err.stdout ?? '' };
    }
  }
}

// --- choosing between them ---------------------------------------------------------

/**
 * The extractor the vault is wired with: one per kind, chosen by media type.
 *
 * `AutoSecretScanner` is the shape this follows, with one difference that
 * matters. That one picks *an implementation of the same question* by asking
 * what the machine can run; this picks *a different question* by asking what
 * the file is. So the choice is per call rather than cached, and there is no
 * probe: a missing `pdftotext` is discovered by the invocation that needed it
 * and answers `null`, which is the same answer as "nothing here reads this
 * kind of file" and is the right one — the document is in the vault, listed,
 * and counted as `nochNichtDurchsuchbar` rather than silently absent.
 *
 * `null` and never `''` for an unknown kind, and that is the load-bearing line
 * of this class. `''` means a parser ran and found nothing, which is a real
 * answer for a scan; using it for "we have no parser" would merge a promise to
 * come back with a document that is finished.
 */
export class MediaTypeExtractor implements TextExtractor {
  private readonly byKind: Record<DocumentKind, TextExtractor | null>;

  constructor(deps: { text?: TextExtractor; pdf?: TextExtractor } = {}) {
    this.byKind = {
      text: deps.text ?? new PlainTextExtractor(),
      pdf: deps.pdf ?? new PdfTextExtractor(),
      unknown: null,
    };
  }

  async extract(input: ExtractionInput): Promise<string | null> {
    const chosen = this.byKind[classifyDocument(input)];
    return chosen === null ? null : chosen.extract(input);
  }
}
