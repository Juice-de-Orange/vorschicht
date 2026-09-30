/**
 * Worktree and branch naming, plus the path-containment predicate (§10, §6.6).
 *
 * This lives in `shared` rather than in `core` because three very different
 * consumers need the *same* answer and must never disagree about it:
 *
 *   * the worktree manager, which creates the directory and the branch;
 *   * the containment hooks of §6.6, which allow a write only "inside the
 *     session's worktree ∧ its claim globs" — and a hook that computed
 *     "inside" differently from the manager would either block legitimate work
 *     or wave through the exact escape it exists to stop;
 *   * the dashboard, which reads a branch name back and wants the task id.
 *
 * Everything here is pure and lexical. In particular `isPathWithin` does not
 * touch the filesystem: it cannot see through a symlink, and a caller that
 * cares about symlink escapes has to `realpath` first. Saying so is better than
 * a function that is *sometimes* symlink-aware depending on whether the path
 * happens to exist.
 */
import { isAbsolute, relative, resolve, sep } from 'node:path';

/** §10: `vorschicht/task-<id>`. The prefix is what makes a branch ours. */
export const WORKTREE_BRANCH_PREFIX = 'vorschicht/task-';

/** Directory name of a task worktree, below `<root>/<project-slug>/`. */
export const WORKTREE_DIR_PREFIX = 'task-';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Project slugs end up in a filesystem path, and `projects` is mutable
 * configuration (§5) — so the slug is validated where it is used, not where it
 * was written. A slug of `../../etc` would otherwise place a worktree outside
 * the root that every containment decision is measured against.
 */
const SAFE_SLUG = /^[a-z0-9][a-z0-9._-]*$/i;

export class UnsafeSlugError extends Error {
  constructor(readonly slug: string) {
    super(
      `Projekt-Slug "${slug}" ist als Pfadbestandteil nicht zulässig — ` +
        'erlaubt sind Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich.',
    );
    this.name = 'UnsafeSlugError';
  }
}

export function assertSafeSlug(slug: string): string {
  if (!SAFE_SLUG.test(slug) || slug === '.' || slug === '..') throw new UnsafeSlugError(slug);
  return slug;
}

export function taskBranchName(taskId: string): string {
  return `${WORKTREE_BRANCH_PREFIX}${taskId}`;
}

/**
 * The task id a branch belongs to, or null when the branch is not ours.
 *
 * The uuid shape is checked rather than assumed: the GC deletes things based on
 * this answer, and `vorschicht/task-experiment` must not resolve to "a task
 * whose id happens not to exist" — which is precisely the orphan verdict.
 */
export function taskIdFromBranch(branch: string): string | null {
  if (!branch.startsWith(WORKTREE_BRANCH_PREFIX)) return null;
  const id = branch.slice(WORKTREE_BRANCH_PREFIX.length);
  return UUID.test(id) ? id.toLowerCase() : null;
}

export function taskWorktreeDirName(taskId: string): string {
  return `${WORKTREE_DIR_PREFIX}${taskId}`;
}

/** `<root>/<project-slug>/task-<id>` — the canonical location, always. */
export function taskWorktreePath(root: string, projectSlug: string, taskId: string): string {
  return resolve(root, assertSafeSlug(projectSlug), taskWorktreeDirName(taskId));
}

/** Where all of a project's worktrees live. */
export function projectWorktreeRoot(root: string, projectSlug: string): string {
  return resolve(root, assertSafeSlug(projectSlug));
}

/** The task id a worktree directory belongs to, or null. */
export function taskIdFromWorktreeDirName(name: string): string | null {
  if (!name.startsWith(WORKTREE_DIR_PREFIX)) return null;
  const id = name.slice(WORKTREE_DIR_PREFIX.length);
  return UUID.test(id) ? id.toLowerCase() : null;
}

/**
 * Is `child` `parent` itself, or below it?
 *
 * Lexical only (see the file header). Equality counts as "within" so that the
 * predicate reads as containment rather than as strict descent — a claim glob
 * anchored at the worktree root is legitimate, and a caller asking "may I touch
 * this path" about the worktree itself deserves a yes rather than a subtle no.
 */
export function isPathWithin(parent: string, child: string): boolean {
  const from = resolve(parent);
  const to = resolve(child);
  if (from === to) return true;
  const rel = relative(from, to);
  if (rel === '' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) return false;
  return true;
}
