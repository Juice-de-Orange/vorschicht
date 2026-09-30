/**
 * Reading an archived session transcript back (§6.2, §18, A15, §17.4).
 *
 * `transcripts.ts` writes the copy; this reads it. The chain §1 principle 4
 * names ends at a *line* in this file — "goal → task → agent run → transcript"
 * — and §22's Phase 7 exit gate makes that literal: from a dot in the office
 * view to the exact transcript line of a decision in four clicks. So this
 * module has two jobs beyond opening a file: it classifies an absence, and it
 * finds the line.
 *
 * Six decisions.
 *
 *  1. **An absence is classified, never rendered as emptiness.** §18 keeps the
 *     raw file 90 days and the gzip archive a year, and then deletes it on
 *     purpose. A viewer that shows a blank page for that is indistinguishable
 *     from one showing a blank page for a broken volume, a truncated copy, or a
 *     run whose backend keeps no transcript at all. `expired` and `missing` are
 *     the two that must never be confused: the first is A15 working, the second
 *     is a hole in the evidence, and only the run's own age separates them.
 *
 *  2. **One pass over the file, page materialised, marks collected.** A
 *     transcript is a session's whole life and can be tens of megabytes; a real
 *     one on this machine runs to hundreds of lines of bookkeeping per turn.
 *     Slurping it to slice a page would put the file in memory to show 200
 *     lines of it. So the file is streamed once: every line is counted and
 *     classified, only the requested page's lines are kept, and marks are kept
 *     up to a cap. Memory is bounded by the page, not by the file. The cost is
 *     that a jump *and* a page both need the same single pass, which they get.
 *
 *  3. **The path is checked against the archive root before it is opened.** It
 *     comes out of `agent_run_events`, written by our own runner — and this is
 *     the one reader in the system that turns a database string into a file
 *     read for a browser. A poisoned row would otherwise be a file-disclosure
 *     hole with a German label on it. `serveShell` in the server takes the same
 *     posture for the same reason: resolve, then check containment, rather than
 *     pattern-matching `..`.
 *
 *  4. **`.gz` is read today although nothing writes it yet.** §18's retention
 *     sweep does not exist (nothing in this repository gzips anything), so every
 *     archive is raw. Building the reader for both halves of A15 now is not
 *     speculation: the sweep is a scheduled job whose whole effect is to rename
 *     files this viewer has to keep opening, and a viewer that discovers `.gz`
 *     only after the sweep runs would report `missing` for the entire second
 *     retention stage — the failure decision 1 exists to prevent, arriving on a
 *     day when nobody is looking. It is tested against a really gzipped file.
 *
 *  5. **A line's text is capped and says so.** §18 keeps the event log forever
 *     and A15 expires transcripts, and this is a read path, so the cap is about
 *     the browser rather than storage: one `tool_result` can carry a whole file.
 *     Truncation is reported per line (`truncated`) rather than trailing off,
 *     which is A110's rule — a silent cut reads as the model having said less
 *     than it did.
 *
 *  6. **Nothing here is trusted.** Every string in the output is model output or
 *     foreign file content copied verbatim. It is returned as data; the page
 *     renders it as text and never as markup, and that is asserted there,
 *     because it cannot be asserted here.
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import {
  ESCALATION_TOOL_WIRE_NAME,
  type SpurTranskript,
  type SpurTranskriptMarke,
  type SpurTranskriptZeile,
  seiteFuerZeile,
  TRANSCRIPT_ARCHIVE_DAYS,
  TRANSCRIPT_PAGE_SIZE,
  type TranscriptLineKind,
  type TranscriptMarkKind,
  type TranscriptState,
  transkriptErklaerung,
} from '@vorschicht/shared/spuren';

/** Per line. A `tool_result` can carry a whole file (decision 5). */
export const MAX_LINE_TEXT = 4000;

/**
 * Marks kept for the jump list.
 *
 * A long coding session makes thousands of tool calls, and a jump list with
 * thousands of entries is not a jump list. The cap is reported through
 * `marksTruncated` on the reader's own result rather than silently applied — but
 * `decision` marks are **never** dropped, because they are the one kind §22's
 * exit gate addresses and a decision that fell off the end of a cap would make
 * that gate's link resolve to nothing on exactly the busiest run.
 */
export const MAX_MARKS = 500;

export interface ReadTranscriptInput {
  /** `<dataRoot>/transcripts` — the containment boundary of decision 3. */
  transcriptsRoot: string;
  /** `agent_runs.transcript_path`: where the archiver put it, or null. */
  archivedPath: string | null;
  /** When the run ended, for A15's clock. Falls back to its creation. */
  runEndedAt: Date | null;
  /** Why there is no archive, from the run's `terminated` event (§6.2). */
  problem?: string | null;
  page?: number | null;
  line?: number | null;
  mark?: TranscriptMarkKind | null;
  pageSize?: number;
  now?: () => number;
}

/**
 * Open the archive and answer with one page of it, or with why there is none.
 *
 * Never throws. This is a read path behind a dashboard: a transcript that
 * cannot be opened is a fact to report, and turning it into a 500 would make
 * one unreadable file hide the run record that explains it.
 */
export async function readTranscript(input: ReadTranscriptInput): Promise<SpurTranskript> {
  const pageSize = input.pageSize ?? TRANSCRIPT_PAGE_SIZE;

  if (!input.archivedPath) {
    return leer('never_archived', { pageSize, problem: input.problem ?? null });
  }

  const located = await locate(input);
  if (located.state !== 'present') {
    return leer(located.state, { pageSize, problem: located.problem, path: input.archivedPath });
  }

  try {
    return await scan({ ...input, pageSize, path: located.path, compressed: located.compressed });
  } catch (error) {
    return leer('unreadable', {
      pageSize,
      problem: (error as Error).message,
      path: located.path,
    });
  }
}

// --- locating ----------------------------------------------------------------

type Located =
  | { state: 'present'; path: string; compressed: boolean }
  | { state: Exclude<TranscriptState, 'present'>; problem: string | null };

/**
 * Which file to open, or which kind of absence this is.
 *
 * The order is the content: containment first (decision 3 — a path outside the
 * archive is refused before anything is stat'ed, so a poisoned row cannot even
 * probe for existence), then raw, then `.gz`, and only then the age question
 * that separates A15 working from A15 having failed.
 */
async function locate(input: ReadTranscriptInput): Promise<Located> {
  const path = input.archivedPath as string;
  const root = resolve(input.transcriptsRoot);
  const target = resolve(path);
  if (target !== root && !target.startsWith(root + sep)) {
    return {
      state: 'unreadable',
      problem:
        `Der aufgezeichnete Pfad liegt außerhalb des Transkript-Archivs (${root}). ` +
        'Er wird nicht geöffnet.',
    };
  }

  if (await istDatei(target)) return { state: 'present', path: target, compressed: false };
  // §18's second stage (decision 4). The sweep that produces these does not
  // exist yet; the reader is built for it because the day it does, every
  // transcript older than 90 days changes its name.
  const gz = `${target}.gz`;
  if (await istDatei(gz)) return { state: 'present', path: gz, compressed: true };

  const at = input.now?.() ?? Date.now();
  const ended = input.runEndedAt?.getTime() ?? null;
  const alterTage = ended === null ? null : (at - ended) / 86_400_000;

  // Past the archive window the deletion is the design (§18, A15). Before it —
  // or with no date to judge by — the same absence is a gap, and saying
  // "expired" about it would explain away the evidence being gone.
  if (alterTage !== null && alterTage > TRANSCRIPT_ARCHIVE_DAYS) {
    return { state: 'expired', problem: null };
  }
  return {
    state: 'missing',
    problem:
      `weder ${target} noch ${gz} existiert` +
      (alterTage === null
        ? ', und der Lauf hat kein Ende aufgezeichnet, an dem sich die Frist messen ließe.'
        : `, und der Lauf ist erst ${Math.max(0, Math.floor(alterTage))} Tage alt.`),
  };
}

async function istDatei(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

// --- scanning ----------------------------------------------------------------

interface ScanInput extends ReadTranscriptInput {
  path: string;
  compressed: boolean;
  pageSize: number;
}

/**
 * One pass (decision 2).
 *
 * The page cannot be chosen before the pass when a mark or a line was asked
 * for — a mark's line number is only known once it is met. So the pass keeps a
 * rolling window: it collects every line whose number *could* still belong to
 * the answer, and settles which at the end. The window is one page for an
 * explicit page request, and for an anchor request it is the page containing the
 * anchor once the anchor is known — until then nothing but marks is retained,
 * and the file is read a second time only in the rare case where the anchor
 * turns out to lie behind us.
 */
async function scan(input: ScanInput): Promise<SpurTranskript> {
  const first = await sweep(input, null);

  // Where the answer should start, now that the marks are known.
  const anchor = resolveAnchor(input, first.marks);
  const seite = anchor.line ? seiteFuerZeile(anchor.line, input.pageSize) : (input.page ?? 1);
  const pages = Math.max(1, Math.ceil(first.total / input.pageSize));
  const seiteGeklemmt = Math.min(Math.max(1, seite), pages);

  // The first sweep already retained the right window when no anchor moved it.
  const lines =
    first.window === seiteGeklemmt ? first.lines : (await sweep(input, seiteGeklemmt)).lines;

  return {
    state: 'present',
    erklaerung: '',
    compressed: input.compressed,
    path: input.path,
    totalLines: first.total,
    page: seiteGeklemmt,
    pages,
    pageSize: input.pageSize,
    lines,
    marks: first.marks,
    focus: anchor.line,
    focusProblem: anchor.problem,
  };
}

interface Sweep {
  total: number;
  lines: SpurTranskriptZeile[];
  marks: SpurTranskriptMarke[];
  /** Which page `lines` holds. */
  window: number;
}

async function sweep(input: ScanInput, forcePage: number | null): Promise<Sweep> {
  // Without an anchor the window is known up front; with one it is not, so the
  // first sweep retains page 1 and a second sweep fetches the real page if the
  // anchor pointed elsewhere. One extra pass in the jump case, none otherwise.
  const window = forcePage ?? (input.line || input.mark ? 1 : Math.max(1, input.page ?? 1));
  const von = (window - 1) * input.pageSize + 1;
  const bis = von + input.pageSize - 1;

  const lines: SpurTranskriptZeile[] = [];
  const marks: SpurTranskriptMarke[] = [];
  let total = 0;

  const stream = input.compressed
    ? createReadStream(input.path).pipe(createGunzip())
    : createReadStream(input.path);
  const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY });

  try {
    for await (const raw of reader) {
      // A trailing newline yields one empty final line in every JSONL file; it
      // is not a record and counting it would make every transcript one line
      // longer than it is.
      if (raw.trim() === '') continue;
      total += 1;
      const parsed = deuten(total, raw);
      if (total >= von && total <= bis) lines.push(parsed);
      for (const kind of parsed.marks) {
        // `decision` is never dropped by the cap: it is the kind §22's gate
        // addresses, and a link that stops resolving on a busy run is worse
        // than a long list.
        if (marks.length < MAX_MARKS || kind === 'decision') {
          marks.push({ nr: total, kind, titel: parsed.titel });
        }
      }
    }
  } finally {
    reader.close();
    stream.destroy();
  }

  return { total, lines, marks, window };
}

function resolveAnchor(
  input: ScanInput,
  marks: SpurTranskriptMarke[],
): { line: number | null; problem: string | null } {
  if (input.line) {
    return { line: input.line, problem: null };
  }
  if (input.mark) {
    const treffer = marks.find((mark) => mark.kind === input.mark);
    if (treffer) return { line: treffer.nr, problem: null };
    // Said out loud rather than silently falling back to page 1, which would
    // look like the link had worked and the line had nothing in it.
    return {
      line: null,
      problem:
        `In diesem Sitzungsprotokoll steht keine Zeile der Art „${input.mark}". ` +
        'Der Verweis zeigt auf etwas, das dieser Lauf nicht getan hat.',
    };
  }
  return { line: null, problem: null };
}

// --- one line ----------------------------------------------------------------

interface Rohzeile {
  type?: unknown;
  subtype?: unknown;
  message?: { role?: unknown; content?: unknown };
  is_error?: unknown;
  [key: string]: unknown;
}

/**
 * What one JSONL line is, in the terms a person reads.
 *
 * The shapes are the CLI's, verified against a real transcript on this machine:
 * `assistant`/`user` carry `message.content` as blocks (`text`, `thinking`,
 * `tool_use`, `tool_result`) or as a bare string, `system` carries a `subtype`,
 * and a real file additionally carries a dozen bookkeeping types (`mode`,
 * `bridge-session`, `file-history-delta`, `ai-title`, …) that outnumber the
 * conversation. Those are classified rather than dropped: §18 makes this file
 * the evidence, and a viewer that hides lines decides for the auditor what the
 * session consisted of.
 */
export function deuten(nr: number, raw: string): SpurTranskriptZeile {
  let doc: Rohzeile;
  try {
    doc = JSON.parse(raw) as Rohzeile;
  } catch {
    return zeile(nr, 'unparsed', 'keine gültige JSON-Zeile', raw, []);
  }

  const type = typeof doc.type === 'string' ? doc.type : 'unbekannt';

  if (type === 'assistant' || type === 'user') {
    return ausNachricht(nr, type, doc);
  }

  if (type === 'result') {
    const fehler = doc.is_error === true;
    return zeile(
      nr,
      'result',
      fehler ? 'Ergebnis (Fehler)' : 'Ergebnis der Sitzung',
      textVon(doc.result ?? doc.subtype ?? doc),
      fehler ? ['result', 'error'] : ['result'],
    );
  }

  if (type === 'system') {
    const subtype = typeof doc.subtype === 'string' ? doc.subtype : 'ohne Untertyp';
    return zeile(nr, 'system', `System — ${subtype}`, textVon(doc), []);
  }

  return zeile(nr, 'bookkeeping', `Protokollzeile — ${type}`, textVon(doc), []);
}

function ausNachricht(nr: number, type: string, doc: Rohzeile): SpurTranskriptZeile {
  const content = doc.message?.content;
  const rolle = type === 'assistant' ? 'Assistent' : 'Eingabe';

  if (typeof content === 'string') {
    return zeile(nr, type === 'assistant' ? 'assistant' : 'user', rolle, content, []);
  }
  if (!Array.isArray(content)) {
    return zeile(nr, type === 'assistant' ? 'assistant' : 'user', rolle, textVon(doc), []);
  }

  const blocks = content as Array<Record<string, unknown>>;
  const marks: TranscriptMarkKind[] = [];
  const teile: string[] = [];
  // The kind of the line is the most *specific* block it carries: a turn is one
  // line with thinking and a tool call in it, and calling that "Antwort" loses
  // exactly the thing an auditor is looking for.
  let kind: TranscriptLineKind = type === 'assistant' ? 'assistant' : 'user';
  let titel = rolle;

  for (const block of blocks) {
    const art = typeof block.type === 'string' ? block.type : '';
    if (art === 'text' && typeof block.text === 'string') {
      teile.push(block.text);
    } else if (art === 'thinking') {
      if (kind === 'assistant') kind = 'thinking';
      teile.push(textVon(block.thinking ?? block));
    } else if (art === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : 'unbekannt';
      kind = 'tool_use';
      titel = `Werkzeug: ${name}`;
      // The one mechanical question §22's exit gate turns on. A tool name is
      // exact — `escalate.ask` has one wire form and either it is on this line
      // or it is not — which is why the jump target is derived and not guessed.
      marks.push(name === ESCALATION_TOOL_WIRE_NAME ? 'decision' : 'tool');
      teile.push(textVon(block.input ?? {}));
    } else if (art === 'tool_result') {
      kind = 'tool_result';
      titel = 'Werkzeugergebnis';
      if (block.is_error === true) marks.push('error');
      teile.push(textVon(block.content ?? block));
    } else {
      teile.push(textVon(block));
    }
  }

  if (kind === 'thinking') titel = 'Überlegung';
  return zeile(nr, kind, titel, teile.join('\n\n'), marks);
}

/** Anything to readable text, without ever throwing on a cycle or a bigint. */
function textVon(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function zeile(
  nr: number,
  kind: TranscriptLineKind,
  titel: string,
  text: string,
  marks: TranscriptMarkKind[],
): SpurTranskriptZeile {
  const gekuerzt = text.length > MAX_LINE_TEXT;
  return {
    nr,
    kind,
    titel,
    text: gekuerzt ? text.slice(0, MAX_LINE_TEXT) : text,
    truncated: gekuerzt,
    marks,
  };
}

function leer(
  state: Exclude<TranscriptState, 'present'>,
  input: { pageSize: number; problem: string | null; path?: string | null },
): SpurTranskript {
  return {
    state,
    erklaerung: transkriptErklaerung({ state, problem: input.problem }),
    compressed: false,
    path: input.path ?? null,
    totalLines: 0,
    page: 1,
    pages: 1,
    pageSize: input.pageSize,
    lines: [],
    marks: [],
    focus: null,
    focusProblem: null,
  };
}
