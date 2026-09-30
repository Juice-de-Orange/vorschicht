/**
 * The wire for §17.4's task and trace explorer — the view in which §1 principle
 * 4 is either true or merely written down.
 *
 * That principle names a chain: **goal → task → agent run → transcript → diff →
 * gate results → merge → deploy.** Every link of it has been recorded since
 * Phase 1 and none of it has ever been *readable*: `task_events` since 0006,
 * `agent_runs` since 0003, the archived JSONL since §6.2, `gate_runs` and
 * `findings` since 0015 — six append-only records with no surface. A trace kept
 * for an auditor who cannot open it is a claim about traceability, not
 * traceability, which is exactly the distinction §8.2 exists to make.
 *
 * Contract-first for A81's reason, and A81 is not a style note here: the inbox
 * shipped with the server answering `number`/`question`/`urgency` while the page
 * read `nummer`/`titel`/`dringlichkeit`, nine of nine green, because each half
 * was tested against its own fixture. So the shapes live here once, the producer
 * is type-checked against them, and the page **parses** rather than casting.
 *
 * **English identifiers, German values** — this house's rule. A JSON key is read
 * by a program; every label a person reads is German (§2) and lives in the
 * `*_LABELS` maps below.
 *
 * Browser-safe by construction, and reached through `@vorschicht/shared/spuren`
 * for the reason the other subpaths exist: the barrel re-exports `worktree.js`
 * and `containment.js`, which import `node:path`, and rollup externalises it and
 * then fails on the first named import (A75.5). Only `zod` and leaf sibling
 * modules may be imported here.
 *
 * Five decisions are not transcription of the spec.
 *
 *   1. **A transcript has five availability answers, not two.** §18/A15 keep the
 *      raw file 90 days and a gzip archive for a year, after which it is gone on
 *      purpose. "There is nothing to show" is therefore at least four different
 *      facts — the run kept no transcript, the retention window has passed, the
 *      file should be here and is not, the path is unreadable — and rendering
 *      all of them as an empty page is the failure this project separates
 *      everywhere else. `missing` and `expired` are deliberately distinct: the
 *      second is A15 working, the first is a gap in the record.
 *
 *   2. **The jump target is a *mark*, not a line number.** §22's exit gate wants
 *      "the exact transcript line of a decision in ≤ 4 clicks", so the timeline
 *      has to link into the file. A line number in that link would have to be
 *      resolved when the timeline is built — a filesystem read per escalation,
 *      in a page that otherwise touches only Postgres, producing a number that
 *      goes stale the moment the file is re-archived. `?marke=decision` is
 *      resolved where the file is read, which is the only place that can know.
 *      `?zeile=` stays for a permalink to one specific line.
 *
 *   3. **A diff is named by what it was derived from.** A merged task, a gated
 *      one and one still in flight yield three different comparisons, and the
 *      page says which — `merge` is the pair of shas the merge queue recorded
 *      and survives the branch being deleted, `gate` is the tree a suite
 *      actually checked, `branch` is the live worktree. Presenting them as one
 *      undifferentiated "diff" would let an empty result mean either "nothing
 *      changed" or "we compared the wrong two things".
 *
 *   4. **Every refusal is a value with a reason.** Nothing here reports an empty
 *      list where it means "could not look". A83.6, A87.6 and A99.4 are the same
 *      sentence three times over: "we could not find out" and "there is nothing"
 *      are the same answer only to a system that has decided not to notice.
 *
 *   5. **Transcript text is untrusted.** It is model output and foreign file
 *      content, copied verbatim. It travels as data and is rendered as text —
 *      never as markup — which is a property of the page and is asserted there.
 */
import { z } from 'zod';
import { PRIORITIES } from './constants.js';
import { whitelistName } from './mcp-tools.js';
import { type TASK_EVENT_KINDS, TASK_STATE_LABELS, TASK_STATES } from './task-state.js';

// --- paths -------------------------------------------------------------------

/** §17.4's task explorer. A task's permalink is `${AUFGABEN_PFAD}/<uuid>`. */
export const AUFGABEN_PFAD = '/aufgaben';

/**
 * One agent run with its transcript.
 *
 * Its own top-level path rather than a child of the task, and that is what makes
 * the office view's job one link: §22's dot has a run behind it and must not
 * have to know which task the run served in order to address it.
 */
export const LAEUFE_PFAD = '/laeufe';

export const AUFGABEN_API = '/api/aufgaben';
export const LAEUFE_API = '/api/laeufe';

/** Query keys, named once so the page and the route cannot spell them apart. */
export const SPUREN_QUERY = {
  project: 'projekt',
  state: 'zustand',
  priority: 'prioritaet',
  from: 'von',
  to: 'bis',
  limit: 'limit',
  page: 'seite',
  line: 'zeile',
  mark: 'marke',
} as const;

/**
 * A task or run id, or null.
 *
 * One declaration for both ends, which is the point: `dokumente` has this regex
 * twice — `isDocumentId` in shared and `UUID` in the page — and its own comment
 * has to argue that "the two layers agree rather than merely both existing".
 * Agreement that has to be argued is agreement that can lapse.
 *
 * Strict, and the reason is concrete: a loose reading hands a typo to a query
 * where Postgres answers `invalid input syntax for type uuid`, so a mistyped
 * link surfaces to the operator as a server fault instead of as a broken link.
 */
const KENNUNG = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function spurKennung(segment: string | null | undefined): string | null {
  return typeof segment === 'string' && KENNUNG.test(segment) ? segment : null;
}

export function aufgabePfad(taskId: string): string {
  return `${AUFGABEN_PFAD}/${encodeURIComponent(taskId)}`;
}

/**
 * A run's permalink, optionally pointing at one line or at the first mark of a
 * kind.
 *
 * The two are mutually exclusive by signature rather than by a runtime check:
 * an anchor that named both would need a precedence rule, and a precedence rule
 * is where a link that looks specific quietly resolves somewhere else.
 */
export function laufPfad(
  runId: string,
  anchor?: { zeile: number } | { marke: TranscriptMarkKind },
): string {
  const base = `${LAEUFE_PFAD}/${runId}`;
  if (!anchor) return base;
  return 'zeile' in anchor
    ? `${base}?${SPUREN_QUERY.line}=${anchor.zeile}`
    : `${base}?${SPUREN_QUERY.mark}=${anchor.marke}`;
}

// --- labels ------------------------------------------------------------------

/**
 * §9's lifecycle in words — the map `./task-state.js` already owns.
 *
 * Deliberately *not* declared again here. A second four-line label map is the
 * cheapest thing in the world to write and it is A81's defect in miniature: the
 * two drift, and the one that is wrong is whichever page nobody opened this
 * week. Wrapped rather than re-exported because the barrel exports both modules
 * with `export *` and two spellings of one name there is a build error — which
 * is the mechanism working, not an obstacle.
 *
 * An unrecognised state is returned as it arrived, `dringlichkeitLabel`'s rule:
 * a state the dashboard does not know is a mismatch between two halves of this
 * system, and printing a friendly default for it would hide exactly that.
 */
export function zustandLabel(state: string): string {
  return (TASK_STATE_LABELS as Record<string, string>)[state] ?? state;
}

/**
 * The `task_events` kinds of 0006 (widened since), as a timeline reader meets
 * them.
 *
 * Keyed over `TASK_EVENT_KINDS` so that a kind added to the log without a label
 * here fails `tsc` rather than reaching the page as a bare identifier. The
 * fallback in `ereignisLabel` is for a *row* written by an older build, not for
 * a kind this build forgot.
 */
export const TASK_EVENT_LABELS: Record<(typeof TASK_EVENT_KINDS)[number], string> = {
  created: 'angelegt',
  state_changed: 'Zustandswechsel',
  reprioritised: 'Priorität geändert',
  note: 'Notiz',
  claims_registered: 'Pfade angemeldet',
  claims_released: 'Pfade freigegeben',
  integrity_check: 'Integritätsprüfung',
  worktree_assigned: 'Arbeitsverzeichnis zugewiesen',
  worktree_released: 'Arbeitsverzeichnis freigegeben',
  finding_reported: 'Fund gemeldet',
  escalation_requested: 'Entscheidung erbeten',
};

export function ereignisLabel(kind: string): string {
  return (TASK_EVENT_LABELS as Record<string, string>)[kind] ?? kind;
}

/**
 * What the two dropdown filters offer.
 *
 * Aliases of `TASK_STATES` and `PRIORITIES`, not copies — a hand-written list
 * here would be a third place §9's state set is written down and would quietly
 * stop offering a state the day one is added. They are exported under their own
 * names because the barrel re-exports both source modules with `export *`, and
 * a second spelling of `TASK_STATES` there is a build error (which is the
 * mechanism working). The priority *labels* stay where the dashboard already
 * keeps them, so this list carries values only.
 */
export const ZUSTAND_OPTIONEN: ReadonlyArray<{ wert: string; label: string }> = TASK_STATES.map(
  (state) => ({ wert: state, label: TASK_STATE_LABELS[state] }),
);

export const PRIORITAET_OPTIONEN: readonly string[] = PRIORITIES;

// --- the task list -----------------------------------------------------------

export const spurAufgabeZeile = z.object({
  id: z.string(),
  /** Null only for a task created before 0010 gave `created` a title. */
  title: z.string().nullable(),
  projectId: z.string(),
  projectSlug: z.string().nullable(),
  state: z.enum(TASK_STATES),
  priority: z.enum(PRIORITIES),
  department: z.string().nullable(),
  type: z.string().nullable(),
  branch: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** §9's red count — how often this task has been through the red path. */
  retryCount: z.number().int().min(0),
});
export type SpurAufgabeZeile = z.infer<typeof spurAufgabeZeile>;

/**
 * The list, plus what it was *not* able to show.
 *
 * `truncated` says the limit bit, rather than leaving a page to infer it from a
 * row count it would have to compare against a number it chose itself. A list
 * silently cut at its limit reads as a complete answer, which is the one thing
 * a filter surface must never do.
 */
export const spurenListeAntwort = z.object({
  aufgaben: z.array(spurAufgabeZeile),
  truncated: z.boolean(),
  /** Every project with at least one task, for the filter's own options. */
  projekte: z.array(z.object({ id: z.string(), slug: z.string(), name: z.string() })),
});
export type SpurenListeAntwort = z.infer<typeof spurenListeAntwort>;

// --- the timeline ------------------------------------------------------------

export const spurEreignis = z.object({
  seq: z.number().int().min(0),
  kind: z.string(),
  occurredAt: z.string(),
  state: z.enum(TASK_STATES),
  priority: z.enum(PRIORITIES),
  actor: z.string(),
  /**
   * The event's own payload, whole.
   *
   * §18 makes `task_events` the source of truth and this page the place it is
   * read; a projection choosing which keys survive would decide, here, which
   * facts an auditor can see. The payloads are written by our own services and
   * carry no credential — §19 keeps secrets out of prompts and out of events —
   * and the page renders every value as text (decision 5).
   */
  payload: z.unknown(),
});
export type SpurEreignis = z.infer<typeof spurEreignis>;

/** A32's three caps, as the `created` event recorded them for this run. */
export const spurLaufKappen = z.object({
  maxTurns: z.number().nullable(),
  maxBudgetUsd: z.number().nullable(),
  wallClockMs: z.number().nullable(),
});
export type SpurLaufKappen = z.infer<typeof spurLaufKappen>;

export const spurLauf = z.object({
  runId: z.string(),
  taskId: z.string().nullable(),
  role: z.string().nullable(),
  model: z.string().nullable(),
  backend: z.string().nullable(),
  cwd: z.string().nullable(),
  sessionId: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
  /** Null while the run is live, and for a run a crash left open (§7.2). */
  durationMs: z.number().int().nullable(),
  finished: z.boolean(),
  terminalReason: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  tokensIn: z.number().nullable(),
  tokensOut: z.number().nullable(),
  /**
   * A60.1's unit: the vendor's own weighting of four token counts, in
   * cost-*equivalent*. Nothing is billed under §2's subscription rule, and the
   * label on the page says so — a number called "Kosten" reads as money spent.
   */
  costUsd: z.number().nullable(),
  toolUses: z.number().int().min(0),
  hookEvents: z.number().int().min(0),
  permissionDenials: z.number().int().min(0),
  caps: spurLaufKappen.nullable(),
  /** §6.3's repair leg and §6.4's continuation — the same session, twice over. */
  repairOf: z.string().nullable(),
  resumedOf: z.string().nullable(),
  transcriptPath: z.string().nullable(),
  /** Why there is no archived transcript, from the run's `terminated` event. */
  transcriptProblem: z.string().nullable(),
});
export type SpurLauf = z.infer<typeof spurLauf>;

/** One red step of one gate run — 0015's `findings` view, as a page reads it. */
export const spurBefund = z.object({
  id: z.string(),
  gateRunId: z.string(),
  gateId: z.string(),
  raisedAt: z.string(),
  raisedOnSha: z.string().nullable(),
  detail: z.string().nullable(),
  output: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  /** §11 has exactly one severity, and 0015 makes it a literal for that reason. */
  severity: z.literal('blocker'),
  status: z.enum(['open', 'resolved', 'abandoned']),
  resolvedAt: z.string().nullable(),
  resolvedOnSha: z.string().nullable(),
});
export type SpurBefund = z.infer<typeof spurBefund>;

export const spurGateSchritt = z.object({
  id: z.string(),
  verdict: z.string(),
  detail: z.string().nullable(),
  output: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  durationMs: z.number().int().nullable(),
  attempts: z.number().int().nullable(),
});
export type SpurGateSchritt = z.infer<typeof spurGateSchritt>;

export const spurGateLauf = z.object({
  id: z.string(),
  stage: z.string(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().int(),
  ok: z.boolean(),
  headSha: z.string().nullable(),
  baseRef: z.string().nullable(),
  steps: z.array(spurGateSchritt),
});
export type SpurGateLauf = z.infer<typeof spurGateLauf>;

export const spurAufgabeDetail = z.object({
  aufgabe: spurAufgabeZeile,
  description: z.string().nullable(),
  acceptanceCriteria: z.array(z.string()),
  worktreePath: z.string().nullable(),
  ereignisse: z.array(spurEreignis),
  laeufe: z.array(spurLauf),
  gateLaeufe: z.array(spurGateLauf),
  befunde: z.array(spurBefund),
});
export type SpurAufgabeDetail = z.infer<typeof spurAufgabeDetail>;

export const spurAufgabeAntwort = z.object({ aufgabe: spurAufgabeDetail });

// --- the transcript ----------------------------------------------------------

/**
 * §18/A15's retention, as the two numbers the reader compares a run's age to.
 *
 * They are here rather than beside the archiver because this is the module that
 * has to *explain* an absence, and the explanation is the only place the numbers
 * are load-bearing: past `TRANSCRIPT_ARCHIVE_DAYS` a missing file is A15 working
 * as designed, before it the same absence is a gap in the record.
 */
export const TRANSCRIPT_RAW_DAYS = 90;
export const TRANSCRIPT_ARCHIVE_DAYS = 365;

/** How many lines one page of the transcript viewer carries. */
export const TRANSCRIPT_PAGE_SIZE = 200;

/**
 * The five answers of decision 1.
 *
 * `present` may still carry zero lines — an archived file that is empty is a
 * fact, and it is not the same fact as any of the other four.
 */
export const TRANSCRIPT_STATES = [
  'present',
  'never_archived',
  'expired',
  'missing',
  'unreadable',
] as const;
export type TranscriptState = (typeof TRANSCRIPT_STATES)[number];

export const TRANSCRIPT_STATE_LABELS: Record<TranscriptState, string> = {
  present: 'vorhanden',
  never_archived: 'nie archiviert',
  expired: 'abgelaufen',
  missing: 'fehlt',
  unreadable: 'nicht lesbar',
};

/**
 * The sentence shown in place of the lines, per state.
 *
 * Written out rather than assembled from fragments, because these four are the
 * whole point of decision 1 and each has to say something a person can act on:
 * one of them means "ask nobody, this is by design", one means "something is
 * wrong with the archive", and reading either as the other wastes a morning.
 */
export function transkriptErklaerung(input: {
  state: TranscriptState;
  problem?: string | null;
}): string {
  switch (input.state) {
    case 'present':
      return '';
    case 'never_archived':
      return input.problem
        ? `Für diesen Lauf wurde kein Sitzungsprotokoll archiviert: ${input.problem}`
        : 'Für diesen Lauf wurde kein Sitzungsprotokoll archiviert — das Backend führt ' +
            'keins, oder das Kopieren ist fehlgeschlagen (§6.2).';
    case 'expired':
      return (
        `Das Sitzungsprotokoll ist abgelaufen: Rohdaten bleiben ${TRANSCRIPT_RAW_DAYS} Tage, ` +
        `das gepackte Archiv ${TRANSCRIPT_ARCHIVE_DAYS} Tage (§18, A15). Danach wird es ` +
        'planmäßig entfernt. Das Ereignisprotokoll dieses Laufs bleibt vollständig erhalten.'
      );
    case 'missing':
      return (
        'Das Sitzungsprotokoll ist innerhalb der Aufbewahrungsfrist und trotzdem nicht ' +
        'auffindbar. Das ist keine Ablaufmeldung, sondern eine Lücke im Nachweis — ' +
        (input.problem ?? 'die aufgezeichnete Datei existiert nicht mehr.')
      );
    case 'unreadable':
      return `Das Sitzungsprotokoll ist nicht lesbar: ${input.problem ?? 'unbekannter Fehler'}`;
  }
}

/** What a line of the JSONL is, once it has been parsed. */
export const TRANSCRIPT_LINE_KINDS = [
  'assistant',
  'thinking',
  'tool_use',
  'tool_result',
  'user',
  'system',
  'result',
  /** `mode`, `bridge-session`, `file-history-delta` … — real lines, not content. */
  'bookkeeping',
  /** A line that is not JSON at all. Shown raw rather than dropped. */
  'unparsed',
] as const;
export type TranscriptLineKind = (typeof TRANSCRIPT_LINE_KINDS)[number];

export const TRANSCRIPT_LINE_LABELS: Record<TranscriptLineKind, string> = {
  assistant: 'Antwort',
  thinking: 'Überlegung',
  tool_use: 'Werkzeugaufruf',
  tool_result: 'Werkzeugergebnis',
  user: 'Eingabe',
  system: 'System',
  result: 'Ergebnis',
  bookkeeping: 'Protokollzeile',
  unparsed: 'unlesbare Zeile',
};

/** The line kinds that carry the conversation, as opposed to the CLI's own bookkeeping. */
export const TRANSCRIPT_CONVERSATION_KINDS: readonly TranscriptLineKind[] = [
  'assistant',
  'thinking',
  'tool_use',
  'tool_result',
  'user',
  'result',
  'unparsed',
];

/**
 * What a jump can address (decision 2).
 *
 * `decision` is the one §22's exit gate names, and it is mechanical rather than
 * a guess: the escalation tool has one wire name (`mcpToolName('escalate.ask')`)
 * and a line either contains a `tool_use` block carrying it or does not.
 */
export const TRANSCRIPT_MARK_KINDS = ['decision', 'tool', 'result', 'error'] as const;
export type TranscriptMarkKind = (typeof TRANSCRIPT_MARK_KINDS)[number];

export const TRANSCRIPT_MARK_LABELS: Record<TranscriptMarkKind, string> = {
  decision: 'Entscheidung erbeten',
  tool: 'Werkzeugaufruf',
  result: 'Ergebnis',
  error: 'Fehler',
};

/**
 * The wire name of §6.4's escalation tool.
 *
 * Derived from `whitelistName` rather than written out, because the two would
 * otherwise be two spellings of one fact — and the one that is wrong is the one
 * nothing executes, so it would be the jump target that silently stops
 * resolving. A48 registers the tool as `escalate.ask`; the CLI sees
 * `mcp__vorschicht__escalate_ask`.
 */
export const ESCALATION_TOOL_WIRE_NAME = whitelistName('escalate.ask');

export const spurTranskriptZeile = z.object({
  /** 1-based, and the number the page shows and a permalink names. */
  nr: z.number().int().positive(),
  kind: z.enum(TRANSCRIPT_LINE_KINDS),
  /** One line of German summary — the tool's name, the subtype, the role. */
  titel: z.string(),
  /** The readable body, capped. Untrusted (decision 5). */
  text: z.string(),
  /** True when `text` was cut; the page says so rather than trailing off. */
  truncated: z.boolean(),
  marks: z.array(z.enum(TRANSCRIPT_MARK_KINDS)),
});
export type SpurTranskriptZeile = z.infer<typeof spurTranskriptZeile>;

export const spurTranskriptMarke = z.object({
  nr: z.number().int().positive(),
  kind: z.enum(TRANSCRIPT_MARK_KINDS),
  titel: z.string(),
});
export type SpurTranskriptMarke = z.infer<typeof spurTranskriptMarke>;

export const spurTranskript = z.object({
  state: z.enum(TRANSCRIPT_STATES),
  /** German, and empty exactly when `state` is `present`. */
  erklaerung: z.string(),
  /** True when the bytes came out of a `.gz` archive (§18's second stage). */
  compressed: z.boolean(),
  path: z.string().nullable(),
  totalLines: z.number().int().min(0),
  page: z.number().int().positive(),
  pages: z.number().int().min(1),
  pageSize: z.number().int().positive(),
  lines: z.array(spurTranskriptZeile),
  marks: z.array(spurTranskriptMarke),
  /** The line a `?zeile=`/`?marke=` request resolved to, if it resolved. */
  focus: z.number().int().positive().nullable(),
  /** Said out loud when a requested anchor names nothing in this file. */
  focusProblem: z.string().nullable(),
});
export type SpurTranskript = z.infer<typeof spurTranskript>;

export const spurLaufDetail = z.object({
  lauf: spurLauf,
  /** The task this run served, for the way back. Null for an audit run (A56.5). */
  aufgabe: spurAufgabeZeile.nullable(),
  transkript: spurTranskript,
});
export type SpurLaufDetail = z.infer<typeof spurLaufDetail>;

export const spurLaufAntwort = z.object({ lauf: spurLaufDetail });

// --- the diff ----------------------------------------------------------------

/** Decision 3: which pair of commits this comparison is, and where it came from. */
export const DIFF_BASES = ['merge', 'gate', 'branch'] as const;
export type DiffBasis = (typeof DIFF_BASES)[number];

export const DIFF_BASIS_LABELS: Record<DiffBasis, string> = {
  merge: 'die Shas, die die Merge-Warteschlange aufgezeichnet hat',
  gate: 'der Baum, den der letzte Gate-Lauf geprüft hat',
  branch: 'der Aufgabenzweig gegen seinen Abzweigpunkt',
};

/**
 * Why there is no diff. Four reasons, never an empty patch.
 *
 * A task that merged and whose branch was then deleted (A44.5) is a different
 * fact from a project whose repository is unreadable, and both are different
 * from a task that has not written anything yet. Collapsing them would make the
 * most common honest answer — "this task has not produced a diff yet" — look
 * exactly like a broken checkout.
 */
export const DIFF_PROBLEMS = ['no_basis', 'no_repository', 'unresolvable', 'failed'] as const;
export type DiffProblem = (typeof DIFF_PROBLEMS)[number];

export const DIFF_PROBLEM_LABELS: Record<DiffProblem, string> = {
  no_basis:
    'Diese Aufgabe hat noch keinen vergleichbaren Stand — kein Merge, kein Gate-Lauf, ' +
    'kein Zweig.',
  no_repository: 'Das Projektverzeichnis ist kein lesbares git-Repository.',
  unresolvable:
    'Die aufgezeichneten Commits sind in diesem Repository nicht mehr auflösbar. ' +
    'Der Zweig ist vermutlich gelöscht und die Objekte sind weggeräumt.',
  failed: 'git hat den Vergleich nicht ausführen können.',
};

export const spurDiffDatei = z.object({
  path: z.string(),
  added: z.number().int().min(0),
  removed: z.number().int().min(0),
  /** True for a file git reported as binary — no patch text exists for it. */
  binary: z.boolean(),
  /** The patch for this file. Untrusted (decision 5), and capped. */
  patch: z.string(),
  patchTruncated: z.boolean(),
});
export type SpurDiffDatei = z.infer<typeof spurDiffDatei>;

export const spurDiff = z.object({
  ok: z.boolean(),
  problem: z.enum(DIFF_PROBLEMS).nullable(),
  /** German — `DIFF_PROBLEM_LABELS`, plus git's own words where it spoke. */
  erklaerung: z.string(),
  basis: z.enum(DIFF_BASES).nullable(),
  /**
   * The two ends, as they were addressed.
   *
   * Refs rather than shas, and named that way because for two of the three bases
   * they genuinely are not shas: `merge` compares the pair the merge queue
   * recorded, while `gate` and `branch` compare a branch name against a tree and
   * the left end is the *fork point*, not the branch tip. Calling a branch name
   * `fromSha` on the page would be a label that is wrong exactly when somebody
   * copies it into a terminal.
   */
  fromRef: z.string().nullable(),
  toRef: z.string().nullable(),
  /** True when the left end is a fork point (`A...B`) rather than a commit. */
  forkPoint: z.boolean(),
  files: z.array(spurDiffDatei),
  /** True when whole files were dropped to stay inside the size cap. */
  truncated: z.boolean(),
});
export type SpurDiff = z.infer<typeof spurDiff>;

export const spurDiffAntwort = z.object({ diff: spurDiff });

// --- filters -----------------------------------------------------------------

export const SPUREN_ALLE = 'alle';
export const SPUREN_DEFAULT_LIMIT = 50;
export const SPUREN_MAX_LIMIT = 200;

export const spurenFilter = z.object({
  projectId: z.string().nullable(),
  state: z.enum(TASK_STATES).nullable(),
  priority: z.enum(PRIORITIES).nullable(),
  /** ISO dates, inclusive, against the task's last movement. */
  from: z.string().nullable(),
  to: z.string().nullable(),
  limit: z.number().int().positive().max(SPUREN_MAX_LIMIT),
});
export type SpurenFilter = z.infer<typeof spurenFilter>;

/**
 * A query string as a filter — permissive on absence, strict on content.
 *
 * An unrecognised state or priority is dropped rather than refused: this is a
 * read-only list, a bookmark from an older build must keep working, and the one
 * thing a filter surface must not do is answer "invalid" to a URL a person
 * pasted. What it must also not do is silently *widen* — a value that means
 * nothing is removed from the filter and the page shows the whole list, which is
 * visibly not what was asked for.
 */
export function parseSpurenFilter(params: URLSearchParams): SpurenFilter {
  const value = (key: string): string | null => {
    const raw = params.get(key);
    if (raw === null) return null;
    const trimmed = raw.trim();
    return trimmed === '' || trimmed === SPUREN_ALLE ? null : trimmed;
  };

  const state = value(SPUREN_QUERY.state);
  const priority = value(SPUREN_QUERY.priority);
  const rawLimit = Number(params.get(SPUREN_QUERY.limit));

  return {
    projectId: value(SPUREN_QUERY.project),
    state: (TASK_STATES as readonly string[]).includes(state ?? '')
      ? (state as SpurenFilter['state'])
      : null,
    priority: (PRIORITIES as readonly string[]).includes(priority ?? '')
      ? (priority as SpurenFilter['priority'])
      : null,
    from: isoDate(value(SPUREN_QUERY.from)),
    to: isoDate(value(SPUREN_QUERY.to)),
    limit:
      Number.isFinite(rawLimit) && rawLimit > 0
        ? Math.min(Math.floor(rawLimit), SPUREN_MAX_LIMIT)
        : SPUREN_DEFAULT_LIMIT,
  };
}

/** `YYYY-MM-DD`, or null. Deliberately not `new Date(x)`, which accepts prose. */
function isoDate(raw: string | null): string | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return Number.isNaN(Date.parse(`${raw}T00:00:00Z`)) ? null : raw;
}

/** The transcript request: which page, and what to jump to. */
export interface TranskriptAbfrage {
  page: number | null;
  line: number | null;
  mark: TranscriptMarkKind | null;
}

export function parseTranskriptAbfrage(params: URLSearchParams): TranskriptAbfrage {
  const page = Number(params.get(SPUREN_QUERY.page));
  const line = Number(params.get(SPUREN_QUERY.line));
  const mark = params.get(SPUREN_QUERY.mark);
  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : null,
    line: Number.isSafeInteger(line) && line > 0 ? line : null,
    mark: (TRANSCRIPT_MARK_KINDS as readonly string[]).includes(mark ?? '')
      ? (mark as TranscriptMarkKind)
      : null,
  };
}

/** Which page a line falls on, 1-based both ways. */
export function seiteFuerZeile(nr: number, pageSize: number): number {
  return Math.floor((nr - 1) / pageSize) + 1;
}

// --- formatting --------------------------------------------------------------

/** `1 234 ms` / `2,4 s` / `3 min 07 s` — a duration a person reads at a glance. */
export function dauer(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes} min ${String(seconds).padStart(2, '0')} s`;
}

/**
 * A run's outcome in one German word, from what the record actually says.
 *
 * Deliberately derived rather than stored: `classifyRun`'s five outcomes live in
 * the runner and are not projected onto `agent_runs`, so inventing a column here
 * would be a second classification that can disagree with the one the scheduler
 * acted on. What the view *does* carry is the terminal reason and the exit code,
 * and this says exactly that much — an unfinished run is "läuft", never "ok".
 */
export function laufAusgang(run: {
  finished: boolean;
  terminalReason: string | null;
  exitCode: number | null;
}): string {
  if (!run.finished) return 'läuft';
  switch (run.terminalReason) {
    case 'completed':
      return run.exitCode === 0 || run.exitCode === null ? 'abgeschlossen' : 'beendet mit Fehler';
    case 'timeout':
      return 'Zeitgrenze erreicht';
    case 'max_turns':
      return 'Zugkappe erreicht';
    case 'interrupted':
      return 'unterbrochen';
    case 'crashed':
      return 'abgestürzt';
    case null:
      return 'beendet, Grund nicht aufgezeichnet';
    default:
      return run.terminalReason;
  }
}

/**
 * A32's caps in one line.
 *
 * Every cap that was recorded is named, and a cap that was not is named as
 * missing rather than omitted: A32 makes all three independent and a run showing
 * two of them looks capped in a way it may not have been.
 */
export function kappen(caps: SpurLaufKappen | null): string {
  if (!caps) return 'nicht aufgezeichnet';
  const teile = [
    `${caps.maxTurns ?? '—'} Züge`,
    `${caps.maxBudgetUsd ?? '—'} USD-Äquivalent`,
    `Wanduhr ${dauer(caps.wallClockMs)}`,
  ];
  return teile.join(' · ');
}
