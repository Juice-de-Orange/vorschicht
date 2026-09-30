/**
 * `CLAUDE.md` read as data: the exit gates of §22 and the assumptions of
 * Appendix A.
 *
 * This module exists because of one sentence in §8.2: a `gate_invalid` finding
 * "un-ticks itself in `CLAUDE.md` with the reason recorded, the phase reopens".
 * That is the only authority in this system that runs backwards through §0's
 * phase discipline, and it edits the file that governs every session. So the
 * step in front of it has to be exact.
 *
 * **Gates are addressed by id, never by their text.** `P2.G4` is derived from
 * position — the fourth gate of Phase 2 — and the prompt hands the auditor the
 * ids alongside the lines. The alternative, matching a model's quotation of a
 * gate against the file, is a fuzzy step immediately before an irreversible
 * edit, and it fails in the worst direction: a near-match un-ticks the wrong
 * gate and nobody reads the diff until the next phase will not close.
 *
 * **Nothing here decides anything.** The parser reports what it found, the
 * un-tick refuses when the gate does not exist or is already open, and both
 * hand the reason back to the caller. A parser that "helpfully" resolved an
 * ambiguity would be doing the auditor's job with none of its evidence.
 */

/** §22's three gate states, as A38 defines them. */
export type GateState =
  /** `[x]` — green. */
  | 'green'
  /** `[~]` — deferred to the target host with a scripted verification (A38). */
  | 'deferred'
  /** `[ ]` — open. */
  | 'open';

export interface GateEntry {
  /** `P<phase>.G<index>`, stable for as long as the gate keeps its position. */
  id: string;
  phase: number;
  /** 1-based, in the order §22 lists them. */
  index: number;
  state: GateState;
  /** The gate text with the checkbox marker removed. */
  text: string;
  /** 0-based index into the file's lines. */
  line: number;
}

export interface AssumptionEntry {
  /** `A34`. */
  id: string;
  /** The first sentence or so — enough to recognise, not the whole item. */
  headline: string;
  line: number;
}

const PHASE_HEADING = /^###\s+Phase\s+(\d+)\b/;
const EXIT_GATES = /^Exit gates\s+—\s+Phase\s+(\d+)/;
const CHECKBOX = /^-\s+\[([ x~])\]\s+(.*)$/;
/**
 * Appendix A comes in two shapes and both are in the file.
 *
 * The early items are `- **A1** text…`; from A43 on the title moved inside the
 * bold run — `- **A43 — A task is its event stream.** text…`. A regex that only
 * knew the first form read 40 of 55 assumptions and reported no error, which
 * would have made domain 4 quietly blind to every assumption written since the
 * task model. Non-greedy, so it stops at the closing `**` rather than at some
 * later emphasis in the body.
 */
const ASSUMPTION = /^-\s+\*\*(A\d+)\b\s*(?:—\s*)?(.*?)\*\*\s*(.*)$/;

const STATE_BY_MARKER: Record<string, GateState> = { x: 'green', '~': 'deferred', ' ': 'open' };

/**
 * Every exit-gate checkbox in the spec, with an id.
 *
 * Scoped to the `Exit gates — Phase N:` blocks rather than to every checkbox in
 * the file, and the scope is load-bearing: §22 is not the only place a `- [ ]`
 * can appear, and a parser that collected all of them would hand out ids that
 * move whenever an unrelated list gains an entry.
 */
export function parseGateBook(source: string): GateEntry[] {
  const lines = source.split('\n');
  const gates: GateEntry[] = [];

  let phase: number | null = null;
  let index = 0;
  let inGates = false;

  for (const [line, raw] of lines.entries()) {
    const heading = PHASE_HEADING.exec(raw);
    if (heading?.[1]) {
      phase = Number(heading[1]);
      inGates = false;
      continue;
    }
    const gatesHeading = EXIT_GATES.exec(raw);
    if (gatesHeading?.[1]) {
      // The heading names its own phase, so a gate block that has drifted away
      // from its `### Phase N` heading still gets the right number.
      phase = Number(gatesHeading[1]);
      inGates = true;
      index = 0;
      continue;
    }
    if (!inGates || phase === null) continue;

    const checkbox = CHECKBOX.exec(raw);
    if (!checkbox) {
      // A gate block ends at the first line that is not a checkbox and not
      // blank — continuation lines of a wrapped gate are indented, and this
      // parser deliberately does not join them: an id points at a line.
      if (raw.trim() !== '') inGates = false;
      continue;
    }
    index += 1;
    const marker = checkbox[1] ?? ' ';
    gates.push({
      id: `P${phase}.G${index}`,
      phase,
      index,
      state: STATE_BY_MARKER[marker] ?? 'open',
      text: (checkbox[2] ?? '').trim(),
      line,
    });
  }

  return gates;
}

/** Appendix A, so domain 4 can sample assumptions by id (§8.2). */
export function parseAssumptions(source: string): AssumptionEntry[] {
  const out: AssumptionEntry[] = [];
  for (const [line, raw] of source.split('\n').entries()) {
    const match = ASSUMPTION.exec(raw);
    if (!match?.[1]) continue;
    out.push({ id: match[1], headline: headline(`${match[2] ?? ''} ${match[3] ?? ''}`), line });
  }
  return out;
}

/** Enough of an item to recognise it. Markdown emphasis stripped, one line. */
function headline(text: string, max = 200): string {
  const flat = text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function findGate(gates: readonly GateEntry[], id: string): GateEntry | null {
  return gates.find((gate) => gate.id === id.trim()) ?? null;
}

export interface UntickInput {
  source: string;
  gateId: string;
  /** German — it is written into the file the operator reads. */
  reason: string;
  /** The finding this came from, so the line points back at the evidence. */
  findingId: string;
  /** ISO date, for the note. Injected so the test is not a clock. */
  date: string;
}

export type UntickResult =
  | { ok: true; source: string; gate: GateEntry; note: string }
  | { ok: false; problem: string; gate: GateEntry | null };

/**
 * Un-tick one gate and record why, in the file itself (§8.2).
 *
 * Refuses in both directions that matter. An unknown id changes nothing — the
 * auditor named a gate that does not exist, which is a defect in the *finding*
 * and must not silently edit some other line. An already-open gate changes
 * nothing either, and says so: re-running an audit over a phase that a previous
 * audit reopened is normal, and a second note appended each time would grow the
 * spec by one line per run for a fact already recorded.
 */
export function untickGate(input: UntickInput): UntickResult {
  const gates = parseGateBook(input.source);
  const gate = findGate(gates, input.gateId);
  if (!gate) {
    return {
      ok: false,
      gate: null,
      problem:
        `Der Fund nennt das Gate "${input.gateId}", das es in CLAUDE.md nicht gibt. ` +
        'Es wurde nichts geändert — ein ungefährer Treffer würde das falsche Gate öffnen.',
    };
  }
  if (gate.state === 'open') {
    return {
      ok: false,
      gate,
      problem:
        `Gate ${gate.id} ist bereits offen; der Haken wurde nicht erneut entfernt. ` +
        'Der Fund bleibt bestehen und ist unverändert gültig.',
    };
  }

  const lines = input.source.split('\n');
  const raw = lines[gate.line];
  if (raw === undefined) {
    return { ok: false, gate, problem: `Zeile ${gate.line} von CLAUDE.md nicht lesbar.` };
  }
  const note = untickNote({ ...input, previous: gate.state });
  // Only the leading checkbox, and only once: a gate text may itself contain
  // `[x]` (a citation of another gate, a shell snippet), and a global replace
  // would rewrite the quotation instead of the marker.
  lines[gate.line] = `${raw.replace(CHECKBOX, '- [ ] $2')} ${note}`;

  return { ok: true, source: lines.join('\n'), gate, note };
}

/** The sentence appended to an un-ticked gate. German — the operator reads this file. */
export function untickNote(input: {
  reason: string;
  findingId: string;
  date: string;
  previous: GateState;
}): string {
  const was = input.previous === 'deferred' ? 'verschoben' : 'grün';
  return (
    `*(Betriebsprüfung ${input.date}: Haken entfernt — war ${was}. ` +
    `${input.reason.replace(/\s+/g, ' ').trim()} [Fund ${input.findingId.slice(0, 8)}])*`
  );
}

/** Counts for the report and for `build_reports` (§8.2 domain 8 reconciles these). */
export function gateCounts(gates: readonly GateEntry[]): Record<GateState, number> {
  const counts: Record<GateState, number> = { green: 0, deferred: 0, open: 0 };
  for (const gate of gates) counts[gate.state] += 1;
  return counts;
}
