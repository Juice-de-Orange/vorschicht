/**
 * The diff link of §1 principle 4's chain — "agent run → transcript → **diff** →
 * gate results" — for §17.4's task explorer.
 *
 * Four decisions, and the first is the one that makes the other three matter.
 *
 *  1. **A task has three possible bases, and the answer names which one it
 *     used.** The obvious build — diff the task's branch against the project's
 *     default branch — is correct for exactly one phase of a task's life and
 *     silently wrong afterwards. After a fast-forward merge the branch's head
 *     *is* an ancestor of `main`, so `merge-base(main, head)` is the head itself
 *     and the diff comes back **empty**: a merged task would show "nothing
 *     changed", which is the most confident possible way to be wrong. And A44.5
 *     deletes a merged branch, so often there is no branch left to ask about at
 *     all. So the bases are tried most-specific first — the pair of shas the
 *     merge queue recorded, then the tree a gate suite actually checked, then
 *     the live branch — and `basis` travels to the page, because an empty file
 *     list means two different things depending on which one answered.
 *
 *  2. **Shas beat names, wherever a sha was recorded.** `baseShaBefore` and
 *     `baseShaAfter` (merge-queue) and `gate_runs.head_sha` survive a branch
 *     being deleted, a rebase, and the integration branch moving on. A ref name
 *     resolved today answers a question about today.
 *
 *  3. **Fail closed, with a reason.** A repository that cannot be read, a sha
 *     that no longer resolves and a task that has produced nothing are three
 *     different facts and none of them is an empty diff. This is the house form
 *     — A83.6, A87.6, A99.4 — and it is sharper here than usual, because an
 *     empty patch is a *plausible* answer: "this task changed nothing" is a
 *     thing that happens.
 *
 *  4. **Never a shell.** Every invocation is `execFile` with an argument array,
 *     `git.ts`'s rule, and it applies with force here: the refs come from
 *     database rows whose values were written while a model was driving.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  DIFF_PROBLEM_LABELS,
  type DiffBasis,
  type DiffProblem,
  type SpurDiff,
  type SpurDiffDatei,
} from '@vorschicht/shared/spuren';

const exec = promisify(execFile);

/** The whole patch, across all files. Beyond this, files are dropped and said so. */
export const MAX_DIFF_BYTES = 512 * 1024;
/** Per file, so one generated lockfile cannot consume the whole budget. */
export const MAX_FILE_PATCH_BYTES = 64 * 1024;
/** What `git diff` may return before Node refuses to buffer it. */
const MAX_GIT_BUFFER = 32 * 1024 * 1024;

export interface DiffRequest {
  /** The project's own checkout — never a worktree, which is disposable (A44.1). */
  repoPath: string;
  fromRef: string;
  toRef: string;
  basis: DiffBasis;
  /**
   * Compare from the **fork point** (`git diff A...B`) rather than from `A`.
   *
   * The whole of decision 1 lives in this flag. For a merged task the two ends
   * are the shas the merge queue recorded and a plain two-dot comparison is
   * exactly right. For a candidate still in flight the left end is a *branch*
   * that has moved on since the task forked, so a two-dot comparison would
   * additionally report every unrelated commit that landed on `main` in the
   * meantime — inverted, as if this task had deleted them.
   */
  forkPoint: boolean;
}

/**
 * Two commits, as a patch a page can render.
 *
 * Never throws: this is a read path behind a dashboard, and a repository that
 * has moved on must not take the trace view down with it.
 */
export async function computeDiff(request: DiffRequest): Promise<SpurDiff> {
  const leer = (problem: DiffProblem, detail?: string): SpurDiff => ({
    ok: false,
    problem,
    erklaerung: detail
      ? `${DIFF_PROBLEM_LABELS[problem]} — ${detail}`
      : DIFF_PROBLEM_LABELS[problem],
    basis: request.basis,
    fromRef: request.fromRef,
    toRef: request.toRef,
    forkPoint: request.forkPoint,
    files: [],
    truncated: false,
  });

  // Both ends before either is used, and each on its own: a ref that no longer
  // resolves is decision 3's `unresolvable`, and it is a different sentence from
  // git failing. Verifying the combined `A...B` form instead would collapse the
  // two, and it is the *left* end that disappears in practice — A44.5 deletes a
  // merged branch.
  for (const ref of [request.fromRef, request.toRef]) {
    const resolved = await git(request.repoPath, ['rev-parse', '--verify', `${ref}^{commit}`]);
    if (!resolved.ok) {
      return resolved.missingRepo
        ? leer('no_repository', resolved.problem)
        : leer('unresolvable', `„${ref}" ist hier nicht auflösbar`);
    }
  }

  // `A...B` is git's own fork-point comparison and needs no `merge-base` call of
  // ours; `A B` is the plain pair. One `range` built once, so the file list and
  // the patch can never be computed over two different comparisons.
  const range = request.forkPoint
    ? [`${request.fromRef}...${request.toRef}`]
    : [request.fromRef, request.toRef];

  const numstat = await git(request.repoPath, ['diff', '--numstat', '-z', ...range]);
  if (!numstat.ok) return leer('failed', numstat.problem);

  const patch = await git(
    request.repoPath,
    // `core.quotePath=false` so a non-ASCII path arrives as itself rather than
    // as octal escapes — the page shows this path to a person.
    ['-c', 'core.quotePath=false', 'diff', '--no-color', '--unified=3', ...range],
  );

  const patches = patch.ok ? splitPatch(patch.stdout) : new Map<string, string>();
  const files: SpurDiffDatei[] = [];
  let used = 0;
  let truncated = false;

  for (const entry of parseNumstat(numstat.stdout)) {
    if (used >= MAX_DIFF_BYTES) {
      truncated = true;
      break;
    }
    const roh = patches.get(entry.path) ?? '';
    const budget = Math.min(MAX_FILE_PATCH_BYTES, MAX_DIFF_BYTES - used);
    const geschnitten = roh.length > budget;
    const text = geschnitten ? roh.slice(0, budget) : roh;
    used += text.length;
    if (geschnitten) truncated = true;
    files.push({
      path: entry.path,
      added: entry.added,
      removed: entry.removed,
      binary: entry.binary,
      patch: text,
      patchTruncated: geschnitten,
    });
  }

  return {
    ok: true,
    problem: null,
    // Empty on the happy path: the page composes the sentence from `basis`,
    // `fromRef` and `toRef`, and a second wording assembled here would be a
    // second place the same fact is phrased (A69.5's split, one layer down).
    erklaerung: '',
    basis: request.basis,
    fromRef: request.fromRef,
    toRef: request.toRef,
    forkPoint: request.forkPoint,
    files,
    truncated,
  };
}

type GitResult =
  | { ok: true; stdout: string }
  | { ok: false; problem: string; missingRepo: boolean };

async function git(cwd: string, args: string[]): Promise<GitResult> {
  try {
    const { stdout } = await exec('git', args, {
      cwd,
      timeout: 30_000,
      maxBuffer: MAX_GIT_BUFFER,
      // `git.ts`'s rule: never the invoking user's identity, config or hooks.
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true, stdout };
  } catch (error) {
    const err = error as Error & { stderr?: string; code?: string };
    const text = (err.stderr || err.message || '').trim();
    return {
      ok: false,
      problem: text,
      // The two ways "there is no repository here" arrives: the directory is
      // gone (spawn fails with ENOENT on the cwd) or git says so itself.
      missingRepo: err.code === 'ENOENT' || /not a git repository|does not exist/i.test(text),
    };
  }
}

interface NumstatEintrag {
  path: string;
  added: number;
  removed: number;
  binary: boolean;
}

/**
 * `--numstat -z`: `added\tremoved\tpath\0`, and for a rename two extra NUL
 * fields carrying the old and new path. Binary files report `-` for both counts.
 *
 * NUL-separated rather than line-based precisely so a path with a newline or a
 * quote in it is not a parsing question.
 */
export function parseNumstat(raw: string): NumstatEintrag[] {
  const felder = raw.split('\0');
  const eintraege: NumstatEintrag[] = [];

  for (let i = 0; i < felder.length; i += 1) {
    const feld = felder[i];
    if (!feld) continue;
    const tab = feld.split('\t');
    if (tab.length < 3) continue;
    const [added, removed, pfad] = tab;
    // A rename leaves the path field empty and puts old and new in the two
    // following NUL fields. The new path is the one the patch header names.
    let path = pfad ?? '';
    if (path === '') {
      i += 2;
      path = felder[i] ?? '';
    }
    if (!path) continue;
    eintraege.push({
      path,
      added: Number(added) || 0,
      removed: Number(removed) || 0,
      binary: added === '-' && removed === '-',
    });
  }
  return eintraege;
}

/**
 * The patch text, per file.
 *
 * Keyed off the `+++ b/<path>` line rather than off `diff --git a/x b/x`,
 * because the latter is genuinely ambiguous for a path containing a space and
 * the former is not — it runs to the end of the line or to a tab. A deletion
 * has `+++ /dev/null`, so the `--- a/<path>` line answers for those.
 */
export function splitPatch(raw: string): Map<string, string> {
  const chunks = new Map<string, string>();
  if (!raw) return chunks;

  for (const chunk of raw.split(/^(?=diff --git )/m)) {
    if (!chunk.startsWith('diff --git ')) continue;
    const plus = /^\+\+\+ b\/(.*)$/m.exec(chunk);
    const minus = /^--- a\/(.*)$/m.exec(chunk);
    const pfad = (plus?.[1] === undefined || plus[1] === '' ? minus?.[1] : plus[1])?.split('\t')[0];
    if (pfad) chunks.set(pfad, chunk);
  }
  return chunks;
}
