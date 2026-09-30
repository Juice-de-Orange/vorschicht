/**
 * §17.4's trace explorer over HTTP — the list, one task's whole timeline, one
 * run with its transcript, and a task's diff.
 *
 * `TraceReader` owns every question about what is recorded, `readTranscript`
 * every question about the archive, and `computeDiff` every question about git.
 * Nothing here re-decides any of them. What this module adds is the translation
 * a transport needs, and four things that only exist at this boundary.
 *
 *  1. **A refusal is a value, never an exception.** `dokumente.ts`, `quellen.ts`
 *     and `inbox.ts`'s posture, and load-bearing rather than tidy: there is no
 *     `app.onError` anywhere in this app, so a throw becomes a plain-text 500
 *     with an English stack behind it.
 *
 *  2. **An unusable id is a 404 before it is a query.** `spurKennung` refuses
 *     anything that is not a uuid, so a mistyped permalink answers "not found"
 *     rather than reaching Postgres and coming back as
 *     `invalid input syntax for type uuid` — a caller's typo surfacing as a
 *     server fault. Both ends use the same function, so they cannot drift.
 *
 *  3. **The diff is its own route.** It shells out to git twice, which is the
 *     one part of this surface that touches a filesystem and the one part that
 *     can be slow; folding it into the task payload would make every timeline
 *     view pay for it, including the ones nobody scrolls that far down.
 *
 *  4. **The transcript root is configuration, not a parameter.** It arrives from
 *     `Config.transcriptsRoot` and is the containment boundary the reader checks
 *     the stored path against. A route that took it from the request would be
 *     the file-disclosure hole that check exists to close.
 *
 * The collaborators are declared structurally (A57.6): a fake then has to match
 * the real signatures, which is the drift a test of this layer exists to catch.
 */
import type { DiffBasisResolution } from '@vorschicht/core';
import {
  parseSpurenFilter,
  parseTranskriptAbfrage,
  type SpurAufgabeDetail,
  type SpurAufgabeZeile,
  type SpurDiff,
  type SpurenListeAntwort,
  type SpurLauf,
  type SpurTranskript,
  spurKennung,
  type TranscriptMarkKind,
} from '@vorschicht/shared/spuren';

/** Exactly the reads this module performs — no write exists on it by design. */
export interface SpurenLeser {
  list(filter: ReturnType<typeof parseSpurenFilter>): Promise<SpurenListeAntwort>;
  task(taskId: string): Promise<SpurAufgabeDetail | null>;
  taskRow(taskId: string): Promise<SpurAufgabeZeile | null>;
  run(runId: string): Promise<SpurLauf | null>;
  diffBasis(taskId: string): Promise<DiffBasisResolution>;
}

export interface SpurenDeps {
  reader: SpurenLeser;
  /** `Config.transcriptsRoot` — decision 4. */
  transcriptsRoot: string;
  /**
   * Injected rather than imported, so a test can drive every one of the five
   * availability answers without staging a filesystem for each. The production
   * wiring passes `readTranscript` itself.
   */
  transkript(input: {
    transcriptsRoot: string;
    archivedPath: string | null;
    runEndedAt: Date | null;
    problem: string | null;
    page: number | null;
    line: number | null;
    mark: TranscriptMarkKind | null;
  }): Promise<SpurTranskript>;
  diff(input: {
    repoPath: string;
    fromRef: string;
    toRef: string;
    basis: 'merge' | 'gate' | 'branch';
    forkPoint: boolean;
  }): Promise<SpurDiff>;
}

/**
 * Three outcomes, three status codes.
 *
 * No `conflict` and no `invalid`: this surface writes nothing, so there is no
 * submission a caller could get wrong and no stale page they could be holding.
 * `failed` is a 500 that still answers in German rather than as a naked stack,
 * which matters precisely because this app has no `app.onError`.
 */
export type SpurenRouteResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: 'unknown' | 'failed'; errors: string[] };

export const SPUREN_STATUS: Record<'unknown' | 'failed', 404 | 500> = {
  unknown: 404,
  failed: 500,
};

/** German (§2). One wording each, so a page can recognise the case. */
const TASK_NOT_FOUND = 'Aufgabe nicht gefunden';
const RUN_NOT_FOUND = 'Lauf nicht gefunden';

/**
 * Every read goes through here.
 *
 * A `catch` per route would be four places for the one rule that a trace view
 * must not take the dashboard down with it — and, worse, four places for
 * somebody to later return `{ ok: true, value: [] }` on failure, which is the
 * "could not look" / "there is nothing" collapse this whole feature is built to
 * prevent.
 */
async function bewacht(fn: () => Promise<unknown>): Promise<SpurenRouteResult> {
  try {
    return { ok: true, value: await fn() };
  } catch (error) {
    // By class, never by message text: matching prose is how a 404 quietly
    // becomes a 500 the day somebody rewords a sentence, and the reword is
    // invisible to every test that only checks the status of the happy path.
    if (error instanceof NichtGefunden) {
      return { ok: false, reason: 'unknown', errors: [error.message] };
    }
    return {
      ok: false,
      reason: 'failed',
      errors: [`Die Spur konnte nicht gelesen werden: ${(error as Error).message}`],
    };
  }
}

/**
 * "Not found", raised from inside the guarded body.
 *
 * Thrown rather than returned because in two of these routes it is decided two
 * calls deep, and threading a union back up would put the 404 decision in three
 * places instead of one.
 */
class NichtGefunden extends Error {}

export async function listTasks(
  deps: SpurenDeps,
  params: URLSearchParams,
): Promise<SpurenRouteResult> {
  return bewacht(async () => await deps.reader.list(parseSpurenFilter(params)));
}

export async function getTask(
  deps: SpurenDeps,
  id: string | undefined,
): Promise<SpurenRouteResult> {
  const taskId = spurKennung(id);
  if (!taskId) return { ok: false, reason: 'unknown', errors: [TASK_NOT_FOUND] };

  return bewacht(async () => {
    const aufgabe = await deps.reader.task(taskId);
    if (!aufgabe) throw new NichtGefunden(TASK_NOT_FOUND);
    return { aufgabe };
  });
}

/**
 * One run, its task, and the page of its transcript the caller asked for.
 *
 * The task row travels with it so the page has a way *back* without a second
 * request — the office view links straight to a run (§22's dot), and a trace
 * view you cannot climb out of is half a trace. It is null for an audit run,
 * which serves no task by design (A56.5), and that is rendered as such rather
 * than as a broken link.
 */
export async function getRun(
  deps: SpurenDeps,
  id: string | undefined,
  params: URLSearchParams,
): Promise<SpurenRouteResult> {
  const runId = spurKennung(id);
  if (!runId) return { ok: false, reason: 'unknown', errors: [RUN_NOT_FOUND] };

  return bewacht(async () => {
    const lauf = await deps.reader.run(runId);
    if (!lauf) throw new NichtGefunden(RUN_NOT_FOUND);

    const abfrage = parseTranskriptAbfrage(params);
    const transkript = await deps.transkript({
      transcriptsRoot: deps.transcriptsRoot,
      archivedPath: lauf.transcriptPath,
      // A15's clock. The run's end, falling back to its creation for a run that
      // never terminated — an older date, so the fallback can only ever make the
      // reader call an absence `expired` *later* than the truth, never earlier.
      // Erring the other way would explain away a missing file as retention.
      runEndedAt: lauf.endedAt ? new Date(lauf.endedAt) : new Date(lauf.createdAt),
      problem: lauf.transcriptProblem,
      page: abfrage.page,
      line: abfrage.line,
      mark: abfrage.mark,
    });

    return {
      lauf: {
        lauf,
        aufgabe: lauf.taskId ? await deps.reader.taskRow(lauf.taskId) : null,
        transkript,
      },
    };
  });
}

/**
 * The diff, or the named reason there is none.
 *
 * Both halves of the resolution answer in the same shape, because "this task
 * has no comparable state yet" is an ordinary answer about a task that has not
 * written anything and must not arrive as a 404 — the task exists, and the page
 * that asked is already showing it.
 */
export async function getTaskDiff(
  deps: SpurenDeps,
  id: string | undefined,
): Promise<SpurenRouteResult> {
  const taskId = spurKennung(id);
  if (!taskId) return { ok: false, reason: 'unknown', errors: [TASK_NOT_FOUND] };

  return bewacht(async () => {
    const basis = await deps.reader.diffBasis(taskId);
    if (!basis.ok) {
      if (basis.reason === 'no_task') throw new NichtGefunden(TASK_NOT_FOUND);
      return {
        diff: {
          ok: false,
          problem: basis.reason === 'no_project' ? 'no_repository' : 'no_basis',
          erklaerung:
            basis.reason === 'no_project'
              ? 'Das Projekt dieser Aufgabe ist nicht mehr eingetragen, also gibt es kein ' +
                'Repository, in dem verglichen werden könnte.'
              : 'Diese Aufgabe hat noch keinen vergleichbaren Stand — kein Merge, kein ' +
                'Gate-Lauf, kein Zweig.',
          basis: null,
          fromRef: null,
          toRef: null,
          forkPoint: false,
          files: [],
          truncated: false,
        } satisfies SpurDiff,
      };
    }

    return {
      diff: await deps.diff({
        repoPath: basis.repoPath,
        fromRef: basis.fromRef,
        toRef: basis.toRef,
        basis: basis.basis,
        forkPoint: basis.forkPoint,
      }),
    };
  });
}
