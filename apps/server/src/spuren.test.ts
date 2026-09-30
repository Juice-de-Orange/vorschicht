/**
 * §17.4's trace explorer as a transport — the half that needs no database.
 *
 * `reader.itest.ts` puts the real reader against a real Postgres and asserts
 * what comes out of the six records. This file asserts the decisions of *this*
 * layer, which a green route hides: that an unusable id is refused before it
 * becomes a query, that a `no_basis` diff is an ordinary answer rather than a
 * 404, that a reader which throws produces a German 500 rather than a naked
 * stack, and — the one with teeth — which date the transcript reader is handed
 * to measure A15's retention against.
 *
 * The fakes are built from the same interfaces the real wiring satisfies
 * (`SpurenLeser`, `SpurenDeps`), so a signature that drifts breaks here rather
 * than being differently correct (A57.6).
 */
import type {
  SpurAufgabeZeile,
  SpurDiff,
  SpurLauf,
  SpurTranskript,
} from '@vorschicht/shared/spuren';
import { describe, expect, it } from 'vitest';
import {
  getRun,
  getTask,
  getTaskDiff,
  listTasks,
  type SpurenDeps,
  type SpurenLeser,
} from './spuren.js';

const TASK = '11111111-2222-4333-8444-555555555555';
const RUN = '99999999-8888-4777-8666-555555555555';

function zeile(over: Partial<SpurAufgabeZeile> = {}): SpurAufgabeZeile {
  return {
    id: TASK,
    title: 'Eine Aufgabe',
    projectId: 'aaaaaaaa-2222-4333-8444-555555555555',
    projectSlug: 'projekt',
    state: 'coding',
    priority: 'P2',
    department: 'Entwicklung',
    type: 'feature',
    branch: 'vorschicht/task-1',
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T10:00:00.000Z',
    retryCount: 0,
    ...over,
  };
}

function lauf(over: Partial<SpurLauf> = {}): SpurLauf {
  return {
    runId: RUN,
    taskId: TASK,
    role: 'coder',
    model: 'sonnet-class',
    backend: 'headless',
    cwd: '/data/worktrees/x',
    sessionId: 'sess-1',
    createdAt: '2026-08-01T09:00:00.000Z',
    startedAt: '2026-08-01T09:00:01.000Z',
    endedAt: '2026-08-01T09:10:00.000Z',
    durationMs: 599_000,
    finished: true,
    terminalReason: 'completed',
    exitCode: 0,
    tokensIn: 10,
    tokensOut: 20,
    costUsd: 1.5,
    toolUses: 3,
    hookEvents: 4,
    permissionDenials: 0,
    caps: { maxTurns: 40, maxBudgetUsd: 16, wallClockMs: 5_400_000 },
    repairOf: null,
    resumedOf: null,
    transcriptPath: '/data/transcripts/2026-08-01/x.jsonl',
    transcriptProblem: null,
    ...over,
  };
}

const LEERES_TRANSKRIPT: SpurTranskript = {
  state: 'present',
  erklaerung: '',
  compressed: false,
  path: null,
  totalLines: 0,
  page: 1,
  pages: 1,
  pageSize: 200,
  lines: [],
  marks: [],
  focus: null,
  focusProblem: null,
};

interface Spuren {
  deps: SpurenDeps;
  gesehen: {
    filter: unknown[];
    transkript: Array<Parameters<SpurenDeps['transkript']>[0]>;
    diff: Array<Parameters<SpurenDeps['diff']>[0]>;
  };
}

function deps(over: Partial<SpurenLeser> = {}): Spuren {
  const gesehen: Spuren['gesehen'] = { filter: [], transkript: [], diff: [] };
  const leser: SpurenLeser = {
    list: async (filter) => {
      gesehen.filter.push(filter);
      return { aufgaben: [zeile()], truncated: false, projekte: [] };
    },
    task: async () => ({
      aufgabe: zeile(),
      description: null,
      acceptanceCriteria: [],
      worktreePath: null,
      ereignisse: [],
      laeufe: [],
      gateLaeufe: [],
      befunde: [],
    }),
    taskRow: async () => zeile(),
    run: async () => lauf(),
    diffBasis: async () => ({
      ok: true,
      basis: 'merge',
      fromRef: 'a'.repeat(40),
      toRef: 'b'.repeat(40),
      forkPoint: false,
      repoPath: '/opt/projekt',
    }),
    ...over,
  };
  return {
    gesehen,
    deps: {
      reader: leser,
      transcriptsRoot: '/data/transcripts',
      transkript: async (input) => {
        gesehen.transkript.push(input);
        return LEERES_TRANSKRIPT;
      },
      diff: async (input) => {
        gesehen.diff.push(input);
        return {
          ok: true,
          problem: null,
          erklaerung: '',
          basis: input.basis,
          fromRef: input.fromRef,
          toRef: input.toRef,
          forkPoint: input.forkPoint,
          files: [],
          truncated: false,
        } satisfies SpurDiff;
      },
    },
  };
}

describe('Eine unbrauchbare Kennung wird abgelehnt, bevor sie eine Abfrage wird', () => {
  it('antwortet 404 auf eine Kennung, die keine uuid ist — ohne den Leser zu fragen', async () => {
    let gefragt = false;
    const { deps: d } = deps({
      task: async () => {
        gefragt = true;
        return null;
      },
    });

    const ergebnis = await getTask(d, 'kaputt');

    // Reaching Postgres with this would come back as
    // `invalid input syntax for type uuid` — a caller's typo surfacing as a
    // server fault. The refusal has to happen before the query, not instead of
    // its error message.
    expect(ergebnis).toEqual({ ok: false, reason: 'unknown', errors: ['Aufgabe nicht gefunden'] });
    expect(gefragt).toBe(false);
  });

  it('antwortet 404 auf eine gültige, aber unbekannte Kennung', async () => {
    const { deps: d } = deps({ task: async () => null });
    expect(await getTask(d, TASK)).toMatchObject({ ok: false, reason: 'unknown' });
  });

  it('antwortet 404 auf einen unbekannten Lauf', async () => {
    const { deps: d } = deps({ run: async () => null });
    const ergebnis = await getRun(d, RUN, new URLSearchParams());
    expect(ergebnis).toEqual({ ok: false, reason: 'unknown', errors: ['Lauf nicht gefunden'] });
  });
});

describe('Was der Transkript-Leser zu sehen bekommt', () => {
  it('misst A15s Frist am Ende des Laufs', async () => {
    const { deps: d, gesehen } = deps();

    await getRun(d, RUN, new URLSearchParams('marke=decision'));

    expect(gesehen.transkript[0]).toMatchObject({
      transcriptsRoot: '/data/transcripts',
      archivedPath: '/data/transcripts/2026-08-01/x.jsonl',
      runEndedAt: new Date('2026-08-01T09:10:00.000Z'),
      mark: 'decision',
      line: null,
    });
  });

  it('fällt für einen nie beendeten Lauf auf dessen Anlage zurück — das ältere Datum', async () => {
    const { deps: d, gesehen } = deps({
      run: async () => lauf({ endedAt: null, finished: false }),
    });

    await getRun(d, RUN, new URLSearchParams());

    // The fallback is deliberately the *older* date, so it can only ever make
    // the reader call an absence `expired` later than the truth. Erring the
    // other way would explain a missing file away as retention.
    expect(gesehen.transkript[0]?.runEndedAt).toEqual(new Date('2026-08-01T09:00:00.000Z'));
  });

  it('reicht den Grund weiter, warum es kein Protokoll gibt', async () => {
    const { deps: d, gesehen } = deps({
      run: async () => lauf({ transcriptPath: null, transcriptProblem: 'kein Protokoll' }),
    });

    await getRun(d, RUN, new URLSearchParams());

    expect(gesehen.transkript[0]).toMatchObject({ archivedPath: null, problem: 'kein Protokoll' });
  });

  it('gibt einer Prüfung ohne Aufgabe keine Aufgabe, statt zu scheitern', async () => {
    const { deps: d } = deps({ run: async () => lauf({ taskId: null }) });

    const ergebnis = await getRun(d, RUN, new URLSearchParams());

    // A56.5: an audit session serves no task by design.
    expect(ergebnis).toMatchObject({ ok: true });
    expect((ergebnis as { value: { lauf: { aufgabe: unknown } } }).value.lauf.aufgabe).toBeNull();
  });
});

describe('Der Vergleich', () => {
  it('reicht die aufgelöste Grundlage unverändert an git weiter', async () => {
    const { deps: d, gesehen } = deps();

    await getTaskDiff(d, TASK);

    expect(gesehen.diff[0]).toEqual({
      repoPath: '/opt/projekt',
      fromRef: 'a'.repeat(40),
      toRef: 'b'.repeat(40),
      basis: 'merge',
      forkPoint: false,
    });
  });

  it('ist „keine Grundlage" eine gewöhnliche Antwort, kein 404', async () => {
    const { deps: d, gesehen } = deps({
      diffBasis: async () => ({ ok: false, reason: 'no_basis' }),
    });

    const ergebnis = await getTaskDiff(d, TASK);

    // The task exists and the page asking is already showing it. A 404 here
    // would say the task was gone.
    expect(ergebnis).toMatchObject({ ok: true });
    const diff = (ergebnis as { value: { diff: SpurDiff } }).value.diff;
    expect(diff.ok).toBe(false);
    expect(diff.problem).toBe('no_basis');
    expect(diff.erklaerung).toContain('kein Merge');
    // And git is never invoked for a comparison that has no ends.
    expect(gesehen.diff).toEqual([]);
  });

  it('meldet ein fehlendes Projekt als fehlendes Repository', async () => {
    const { deps: d } = deps({ diffBasis: async () => ({ ok: false, reason: 'no_project' }) });

    const ergebnis = await getTaskDiff(d, TASK);
    const diff = (ergebnis as { value: { diff: SpurDiff } }).value.diff;

    expect(diff.problem).toBe('no_repository');
    expect(diff.erklaerung).toContain('nicht mehr eingetragen');
  });

  it('antwortet 404, wenn die Aufgabe selbst unbekannt ist', async () => {
    const { deps: d } = deps({ diffBasis: async () => ({ ok: false, reason: 'no_task' }) });
    expect(await getTaskDiff(d, TASK)).toMatchObject({ ok: false, reason: 'unknown' });
  });
});

describe('Ein Leser, der wirft', () => {
  it('wird zu einer deutschen 500 statt zu einem nackten Stack', async () => {
    const { deps: d } = deps({
      task: async () => {
        throw new Error('connection terminated');
      },
    });

    const ergebnis = await getTask(d, TASK);

    // There is no `app.onError` anywhere in this app, so a throw that escaped
    // would reach the browser as plain-text English.
    expect(ergebnis).toMatchObject({ ok: false, reason: 'failed' });
    expect((ergebnis as { errors: string[] }).errors[0]).toContain(
      'Die Spur konnte nicht gelesen werden',
    );
    expect((ergebnis as { errors: string[] }).errors[0]).toContain('connection terminated');
  });
});

describe('Die Liste', () => {
  it('übersetzt die Abfrage in einen Filter und lässt „alle" weg', async () => {
    const { deps: d, gesehen } = deps();

    await listTasks(
      d,
      new URLSearchParams('zustand=coding&prioritaet=alle&limit=5&bis=2026-08-01'),
    );

    expect(gesehen.filter[0]).toEqual({
      projectId: null,
      state: 'coding',
      // `alle` is absence, and absence must not narrow anything.
      priority: null,
      from: null,
      to: '2026-08-01',
      limit: 5,
    });
  });

  it('verwirft einen unbekannten Zustand, statt die Liste abzulehnen', async () => {
    const { deps: d, gesehen } = deps();

    const ergebnis = await listTasks(d, new URLSearchParams('zustand=gibtsnicht'));

    // A bookmark from an older build has to keep working; what it must not do is
    // silently *widen* into something that looks like a filtered answer.
    expect(ergebnis).toMatchObject({ ok: true });
    expect(gesehen.filter[0]).toMatchObject({ state: null });
  });
});
