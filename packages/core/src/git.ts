/**
 * The narrow slice of git the orchestrator needs (§7.3, §10, §12).
 *
 * Deliberately not a library: every call is `execFile` with an argument array,
 * never a shell string. Task titles, branch names and handover notes all end up
 * in these arguments, and all three are ultimately written by a model. A shell
 * in that path is a command-injection hole with extra steps.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** A20/A36: every commit this system makes is authored by the bot, never by the operator. */
export const BOT_IDENTITY = {
  name: 'Vorschicht Bot',
  email: 'vorschicht-bot@example.com',
} as const;

/**
 * Branches a WIP commit must never touch (§7.3 step 2: "never to main, never
 * merged"). The wrap-up refuses rather than guessing — a wrap-up commit on
 * `main` would be an unreviewed, ungated change on the branch everything else
 * is built from.
 */
export const PROTECTED_BRANCHES = ['main', 'master', 'trunk', 'develop', 'dev'] as const;

export class GitError extends Error {
  constructor(
    readonly command: string,
    message: string,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await exec('git', args, {
      cwd,
      timeout: 60_000,
      // Never read the invoking user's identity or hooks — the bot identity is
      // passed explicitly on every commit instead.
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    return stdout.trim();
  } catch (error) {
    const err = error as Error & { stderr?: string };
    throw new GitError(`git ${args.join(' ')}`, (err.stderr || err.message).trim());
  }
}

export async function isGitRepository(cwd: string): Promise<boolean> {
  try {
    return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])) === 'true';
  } catch {
    return false;
  }
}

export async function currentBranch(cwd: string): Promise<string> {
  return git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD']);
}

export async function headSha(cwd: string): Promise<string> {
  return git(cwd, ['rev-parse', 'HEAD']);
}

/** Paths with uncommitted changes, staged or not, including untracked files. */
export async function dirtyPaths(cwd: string): Promise<string[]> {
  const output = await git(cwd, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (!output) return [];
  return output
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

/**
 * Every path this working copy has touched since `sinceSha` (§10's claim check).
 *
 * Deliberately wider than `git diff --name-only <sha>..HEAD`: that compares two
 * commits and would miss everything a session changed but did not commit, which
 * is precisely the state a coder can be left in. So the comparison is against
 * the *working tree*, and untracked files are added separately — git's diff does
 * not know about a file it has never seen, and a brand-new file outside the
 * claim set is the violation that matters most.
 *
 * Renames are reported as two paths (`--no-renames`) rather than one arrow:
 * moving a claimed file to an unclaimed location is a write outside the claim
 * set, and rename detection would hide the destination.
 */
export async function changedPaths(cwd: string, sinceSha: string): Promise<string[]> {
  const tracked = await git(cwd, ['diff', '--name-only', '--no-renames', sinceSha, '--']);
  const untracked = await git(cwd, ['ls-files', '--others', '--exclude-standard']);
  const paths = new Set(
    [...tracked.split('\n'), ...untracked.split('\n')].map((line) => line.trim()).filter(Boolean),
  );
  return [...paths].sort();
}

// --- worktrees (§10) ---------------------------------------------------------

/** One entry of `git worktree list --porcelain`. */
export interface WorktreeEntry {
  path: string;
  head: string | null;
  /** Short branch name, or null when detached or bare. */
  branch: string | null;
  bare: boolean;
  detached: boolean;
  locked: boolean;
  /** Set when git considers the entry removable — usually the directory is gone. */
  prunable: string | null;
}

/**
 * Every worktree git knows about for this repository, main worktree included.
 *
 * Parsed from `--porcelain` rather than the human format on purpose: the human
 * format aligns columns and abbreviates, and a path with a space in it would
 * turn into two fields.
 */
export async function worktreeList(repo: string): Promise<WorktreeEntry[]> {
  const output = await git(repo, ['worktree', 'list', '--porcelain']);
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;

  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (current) entries.push(current);
      current = {
        path: line.slice('worktree '.length),
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        prunable: null,
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('HEAD ')) current.head = line.slice('HEAD '.length);
    else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '');
    } else if (line === 'bare') current.bare = true;
    else if (line === 'detached') current.detached = true;
    else if (line === 'locked' || line.startsWith('locked ')) current.locked = true;
    else if (line === 'prunable') current.prunable = 'prunable';
    else if (line.startsWith('prunable ')) current.prunable = line.slice('prunable '.length);
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * Create a worktree.
 *
 * `startPoint` is only consulted when the branch has to be created. A branch
 * that already exists is *checked out*, never reset — after a restart or a GC
 * pass the branch is where the work is, and re-pointing it at `main` would
 * discard exactly the WIP commit §7.3 wrote to survive the pause.
 */
export async function worktreeAdd(
  repo: string,
  path: string,
  branch: string,
  startPoint: string,
): Promise<void> {
  const exists = await branchExists(repo, branch);
  const args = exists
    ? ['worktree', 'add', '--quiet', path, branch]
    : ['worktree', 'add', '--quiet', '-b', branch, path, startPoint];
  await git(repo, args);
}

/**
 * Remove a worktree.
 *
 * Without `force`, git refuses when the tree is dirty or has untracked files —
 * and that refusal is kept rather than worked around. The orphan GC runs
 * unattended; "the directory looked disposable" is not a good enough reason to
 * delete work nobody has seen.
 */
export async function worktreeRemove(
  repo: string,
  path: string,
  options: { force?: boolean } = {},
): Promise<void> {
  const args = ['worktree', 'remove'];
  if (options.force) args.push('--force');
  args.push(path);
  await git(repo, args);
}

/** Drop admin entries whose directory has vanished. Never touches a directory. */
export async function worktreePrune(repo: string): Promise<void> {
  await git(repo, ['worktree', 'prune']);
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete a branch, refusing when it holds commits the base does not have.
 *
 * `--delete` rather than `--delete --force`, always. The GC deletes branches of
 * finished tasks; an unmerged branch there means something did not finish the
 * way the record claims, and losing it would erase the evidence.
 */
export async function deleteBranch(repo: string, branch: string): Promise<boolean> {
  try {
    await git(repo, ['branch', '--delete', branch]);
    return true;
  } catch {
    return false;
  }
}

export async function resolveCommit(repo: string, revision: string): Promise<string> {
  return git(repo, ['rev-parse', '--verify', `${revision}^{commit}`]);
}

// --- merge queue (§10) -------------------------------------------------------

/** Is `ancestor` contained in `descendant`'s history? The ff-merge precondition. */
export async function isAncestor(
  repo: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  try {
    await git(repo, ['merge-base', '--is-ancestor', ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

export interface RebaseResult {
  ok: boolean;
  /** Where the branch tip ended up. Unchanged from before on a failure. */
  head: string;
  /** German, for the timeline. Null when the rebase succeeded. */
  problem: string | null;
  /** Paths git reported as conflicting, when it named any. */
  conflicts: string[];
}

/**
 * Replay this worktree's branch onto `onto` (§10, step 2 of a merge candidate).
 *
 * A failed rebase is **always** aborted before this function returns. Leaving a
 * worktree mid-rebase would strand it in a state where neither the next merge
 * attempt nor §7.3's WIP commit can do anything useful, and an unattended studio
 * has nobody to run `git rebase --continue`. The abort is best-effort and its
 * own failure is folded into the reported problem rather than thrown: the caller
 * needs to hear "this candidate did not rebase", and a second exception on the
 * way out would replace that message with a less useful one.
 *
 * `--no-verify` because a project's own hooks are not this system's to run
 * inside an orchestrator, and `--empty=drop` because a commit whose changes are
 * already on the integration branch is not a conflict — it is a candidate that
 * someone else merged first, which §10's serialisation makes an ordinary event.
 */
export async function rebaseOnto(cwd: string, onto: string): Promise<RebaseResult> {
  try {
    await git(cwd, ['rebase', '--no-verify', '--empty=drop', onto]);
    return { ok: true, head: await headSha(cwd), problem: null, conflicts: [] };
  } catch (error) {
    const message = (error as Error).message;
    const conflicts = await conflictedPaths(cwd);
    let aborted = true;
    try {
      await git(cwd, ['rebase', '--abort']);
    } catch {
      aborted = false;
    }
    const problem =
      `Rebase auf "${onto}" fehlgeschlagen: ${message}` +
      (conflicts.length > 0 ? ` — Konflikte in: ${conflicts.join(', ')}` : '') +
      (aborted ? '' : ' — der Rebase konnte zudem nicht abgebrochen werden, Worktree prüfen');
    return { ok: false, head: await headSha(cwd).catch(() => ''), problem, conflicts };
  }
}

/** Paths git currently reports as unmerged. Empty when nothing is conflicted. */
export async function conflictedPaths(cwd: string): Promise<string[]> {
  try {
    const output = await git(cwd, ['diff', '--name-only', '--diff-filter=U']);
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

export interface FastForwardResult {
  merged: boolean;
  /** The integration branch tip afterwards — the new `main`. */
  head: string;
  /** German. Null when the merge happened. */
  problem: string | null;
}

/**
 * Fast-forward the integration branch onto a merge candidate (§10, step 4).
 *
 * Three preconditions, all checked rather than assumed, because each of them
 * fails in a way that is silent or destructive:
 *
 *  - the repository's own checkout must be **on** the integration branch, since
 *    `git merge` moves the branch that is checked out and merging into the wrong
 *    one is not recoverable by reading the record afterwards;
 *  - that checkout must be **clean**, because a fast-forward rewrites its
 *    working tree and would take somebody's uncommitted work with it;
 *  - the candidate must be a **descendant** of the branch tip, which is what
 *    `--ff-only` enforces — but checking first turns "git said no" into a
 *    sentence naming the actual reason.
 *
 * No merge commit is created, deliberately: §10 says fast-forward, and the
 * commits that land are the Coder's, already authored as the bot (A20/A36). The
 * identity is passed anyway so that a repository whose history requires a merge
 * commit fails loudly here rather than picking up whatever `git config` on the
 * host happens to say.
 */
export async function fastForwardMerge(
  repo: string,
  branch: string,
  integrationBranch: string,
): Promise<FastForwardResult> {
  const fail = async (problem: string): Promise<FastForwardResult> => ({
    merged: false,
    head: await headSha(repo).catch(() => ''),
    problem,
  });

  const checkedOut = await currentBranch(repo);
  if (checkedOut !== integrationBranch) {
    return fail(
      `Das Repository steht auf "${checkedOut}", nicht auf "${integrationBranch}" — ` +
        'ein Fast-Forward würde den falschen Branch bewegen und wird nicht ausgeführt (§10).',
    );
  }
  const dirty = await dirtyPaths(repo);
  if (dirty.length > 0) {
    return fail(
      `Das Repository hat unbestätigte Änderungen (${dirty.slice(0, 5).join(', ')}` +
        `${dirty.length > 5 ? ', …' : ''}) — ein Fast-Forward würde sie überschreiben.`,
    );
  }
  if (!(await isAncestor(repo, integrationBranch, branch))) {
    return fail(
      `"${branch}" enthält "${integrationBranch}" nicht — der Kandidat ist nicht ` +
        'aktuell rebased und kann nicht vorgespult werden (§10).',
    );
  }

  try {
    await git(repo, [
      '-c',
      `user.name=${BOT_IDENTITY.name}`,
      '-c',
      `user.email=${BOT_IDENTITY.email}`,
      '-c',
      'commit.gpgsign=false',
      'merge',
      '--ff-only',
      '--no-verify',
      branch,
    ]);
  } catch (error) {
    return fail(`Fast-Forward-Merge fehlgeschlagen: ${(error as Error).message}`);
  }
  return { merged: true, head: await headSha(repo), problem: null };
}

/** One commit, as the merge record and the bot-identity assertion need it. */
export interface CommitInfo {
  sha: string;
  authorName: string;
  authorEmail: string;
  subject: string;
}

/**
 * ASCII 0x1f, between the fields of one `git log` line.
 *
 * A tab or a pipe would do until the first commit subject that contains one —
 * and commit subjects here are written by a model, so "until" is a matter of
 * time rather than of taste.
 */
const UNIT_SEPARATOR = '\x1f';

/**
 * The commits `head` adds on top of `base`, oldest first.
 *
 * Used twice: to record what a merge actually brought in, and to check that
 * every one of them is authored by the bot (§22's Phase 2 gate).
 */
export async function commitsBetween(
  cwd: string,
  base: string,
  head = 'HEAD',
): Promise<CommitInfo[]> {
  const output = await git(cwd, [
    'log',
    '--reverse',
    '--no-merges',
    '--format=%H%x1f%an%x1f%ae%x1f%s',
    `${base}..${head}`,
  ]);
  if (!output) return [];
  return output.split('\n').flatMap((line) => {
    const [sha, authorName, authorEmail, ...rest] = line.split(UNIT_SEPARATOR);
    if (!sha) return [];
    return [
      {
        sha,
        authorName: authorName ?? '',
        authorEmail: authorEmail ?? '',
        subject: rest.join(UNIT_SEPARATOR),
      },
    ];
  });
}

/** Files git would put into a commit — tracked plus untracked-but-not-ignored. */
export async function gitVisibleFiles(cwd: string): Promise<string[]> {
  const output = await git(cwd, ['ls-files', '--cached', '--others', '--exclude-standard']);
  return output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Where this branch left the integration branch — the commit a diff starts at.
 *
 * The alternative, remembering the sha a worktree was created from, is right
 * only until something happens to it: a WIP commit from a park (§7.3), a second
 * pass after §9's red path, a rebase in the merge queue (§10). The fork point is
 * derivable from the repository at any moment and means the same thing every
 * time, which is the property a claim check and a reviewer both depend on.
 *
 * Null when there is no common ancestor — unrelated histories, or a branch that
 * does not exist. Callers fall back rather than treat that as an error, because
 * a missing base makes a diff impossible and not a task wrong.
 */
export async function mergeBase(cwd: string, ref: string): Promise<string | null> {
  try {
    return await git(cwd, ['merge-base', ref, 'HEAD']);
  } catch {
    return null;
  }
}

export interface WipCommitResult {
  committed: boolean;
  sha: string | null;
  branch: string;
  files: string[];
  /** Why nothing was committed, when nothing was. German, for the timeline. */
  skipped?: string;
}

/**
 * Commit everything in the worktree as WIP (§7.3 step 2).
 *
 * Three refusals, all of them deliberate:
 *
 *  - not a git repository → nothing to commit, say so rather than throw;
 *  - a protected branch → refuse, because an unreviewed commit on `main` is the
 *    one outcome the wrap-up protocol must never produce;
 *  - a clean tree → skip, because an empty commit is noise in a history that
 *    §1 principle 4 wants readable.
 *
 * The `wip:` prefix is not decoration: it is how the merge queue and a human
 * reader tell "the budget ran out here" from "this is finished work".
 */
export async function commitWip(
  cwd: string,
  message: string,
  options: { allowedBranches?: readonly string[] } = {},
): Promise<WipCommitResult> {
  if (!(await isGitRepository(cwd))) {
    return { committed: false, sha: null, branch: '', files: [], skipped: 'kein Git-Repository' };
  }

  const branch = await currentBranch(cwd);
  const protectedBranch = (PROTECTED_BRANCHES as readonly string[]).includes(branch);
  const allowed = options.allowedBranches
    ? options.allowedBranches.includes(branch)
    : !protectedBranch;
  if (!allowed) {
    return {
      committed: false,
      sha: null,
      branch,
      files: [],
      skipped: `Branch "${branch}" ist geschützt — §7.3 verbietet einen WIP-Commit dort`,
    };
  }

  const files = await dirtyPaths(cwd);
  if (files.length === 0) {
    return { committed: false, sha: null, branch, files: [], skipped: 'nichts zu sichern' };
  }

  await git(cwd, ['add', '--all']);
  await git(cwd, [
    '-c',
    `user.name=${BOT_IDENTITY.name}`,
    '-c',
    `user.email=${BOT_IDENTITY.email}`,
    // A globally configured signing key would make this commit prompt for a
    // passphrase — in an unattended daemon that is a hang, not an error.
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--no-verify',
    '--message',
    message.startsWith('wip:') ? message : `wip: ${message}`,
  ]);

  return { committed: true, sha: await headSha(cwd), branch, files };
}
