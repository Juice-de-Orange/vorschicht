/**
 * The worktree manager (§10).
 *
 * §10's rule is one sentence — "Every coding task gets its own `git worktree` +
 * branch `vorschicht/task-<id>` off current `main` of the target project. No
 * two sessions ever share a working directory." — and the whole parallel-coding
 * safety story rests on it. Claims stop two tasks from editing the same *file*;
 * worktrees stop two sessions from editing the same *checkout*, which is the
 * failure claims cannot catch because git itself would be the thing corrupted.
 *
 * Four properties this module is built around, in the order they cost most if
 * they are missing:
 *
 *  1. **A41 is enforced here.** A read-only project gets no worktree, no
 *     branch, no write of any kind. This is the component that would otherwise
 *     be the first to break that boundary, so the check sits at its entrance.
 *
 *  2. **Idempotence.** The orchestrator restarts — on every deploy, and after
 *     every crash the chaos test simulates. `ensure()` therefore reuses an
 *     existing worktree instead of failing, and appends no event when nothing
 *     changed. An existing *branch* is checked out, never reset: after a park,
 *     that branch holds the WIP commit §7.3 wrote precisely so the work would
 *     survive.
 *
 *  3. **The GC never destroys work.** It removes only worktrees whose task is
 *     finished or unknown, refuses dirty ones rather than forcing them, deletes
 *     branches with `--delete` and never `--force`, and leaves anything it did
 *     not create alone. A daily unattended job that deletes directories has to
 *     be boring on purpose; a repeated "could not clean this up" report is a
 *     better outcome than one silent data loss.
 *
 *  4. **Nothing is removed outside the root.** Every path is checked against
 *     the worktrees root before it is passed to git, and removal always goes
 *     through `git worktree remove` rather than a recursive delete of our own.
 */
import { mkdir, readdir, realpath, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  isPathWithin,
  isTerminalTaskState,
  projectWorktreeRoot,
  taskBranchName,
  taskIdFromBranch,
  taskIdFromWorktreeDirName,
  taskWorktreePath,
} from '@vorschicht/shared';
import type { EventLog } from './event-log.js';
import {
  deleteBranch,
  mergeBase,
  resolveCommit,
  type WorktreeEntry,
  worktreeAdd,
  worktreeList,
  worktreePrune,
  worktreeRemove,
} from './git.js';
import type { ProjectRecord, ProjectService } from './project-service.js';
import type { TaskRecord, TaskService } from './task-service.js';

/** A41: the project may be read, never written. */
export class ProjectReadOnlyError extends Error {
  constructor(readonly projectSlug: string) {
    super(
      `Projekt "${projectSlug}" ist als nur-lesend markiert (A41) — ` +
        'kein Worktree, kein Branch, keine Änderung. ' +
        'Schreibzugriff braucht eine ausdrückliche Entscheidung des Betreibers.',
    );
    this.name = 'ProjectReadOnlyError';
  }
}

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorktreeError';
  }
}

export interface WorktreeAssignment {
  taskId: string;
  projectId: string;
  path: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  /** False when an existing worktree was reused — the restart case. */
  created: boolean;
}

export interface WorktreeReleaseResult {
  taskId: string;
  path: string;
  branch: string;
  removed: boolean;
  branchDeleted: boolean;
  /** German, for the timeline: why nothing was removed, when nothing was. */
  problem?: string;
}

/** What one GC pass did, and — more importantly — what it refused to do. */
export interface WorktreeGcReport {
  scanned: number;
  removed: WorktreeReleaseResult[];
  /** Orphans that were found but deliberately left in place, with the reason. */
  kept: Array<{ path: string; branch: string | null; reason: string }>;
  /** Directories under the root that git does not know about. */
  strays: Array<{ path: string; removed: boolean; reason: string }>;
}

export interface WorktreeManagerDeps {
  tasks: TaskService;
  projects: ProjectService;
  eventLog: EventLog;
  /** Every worktree of every project lives below this directory. */
  root: string;
}

export class WorktreeManager {
  constructor(private readonly deps: WorktreeManagerDeps) {}

  get root(): string {
    return this.deps.root;
  }

  /**
   * The worktree for a task — creating it if it does not exist yet.
   *
   * Safe to call repeatedly. The second call returns `created: false` and
   * writes nothing, which is what makes a restart mid-task cheap rather than a
   * source of duplicate events.
   */
  async ensure(taskId: string): Promise<WorktreeAssignment> {
    const task = await this.requireTask(taskId);
    const project = await this.deps.projects.require(task.projectId);
    if (project.readOnly) throw new ProjectReadOnlyError(project.slug);

    const path = taskWorktreePath(this.deps.root, project.slug, task.id);
    const branch = taskBranchName(task.id);
    this.assertInsideRoot(path);

    const existing = await this.findEntry(project, path);
    if (existing) {
      if (existing.branch !== branch) {
        throw new WorktreeError(
          `In ${path} liegt bereits ein Worktree auf Branch "${existing.branch ?? 'detached'}" ` +
            `statt auf "${branch}" — Verzeichnis wird nicht überschrieben.`,
        );
      }
      // The fork point, not the current HEAD. A reused worktree has usually
      // moved on — a WIP commit from a park (§7.3), a second pass after §9's
      // red path — and `baseSha` means "where this work started". Answering
      // HEAD here would silently hand the claim check and the Reviewer an empty
      // diff of a branch that has changed a great deal.
      const assignment: WorktreeAssignment = {
        taskId: task.id,
        projectId: project.id,
        path,
        branch,
        baseBranch: project.defaultBranch,
        baseSha: (await mergeBase(path, project.defaultBranch)) ?? existing.head ?? '',
        created: false,
      };
      await this.recordAssignment(task, assignment, { onlyIfChanged: true });
      return assignment;
    }

    // §10: off the project's current integration branch. Resolved to a sha so
    // the record says which commit this work started from, not just which name.
    const baseSha = await resolveCommit(project.rootPath, project.defaultBranch);
    await mkdir(dirname(path), { recursive: true });
    await worktreeAdd(project.rootPath, path, branch, baseSha);

    const assignment: WorktreeAssignment = {
      taskId: task.id,
      projectId: project.id,
      path,
      branch,
      baseBranch: project.defaultBranch,
      baseSha,
      created: true,
    };
    await this.recordAssignment(task, assignment, { onlyIfChanged: false });
    await this.deps.eventLog.append({
      kind: 'worktree.created',
      actor: 'orchestrator',
      projectId: project.id,
      taskId: task.id,
      payload: { path, branch, baseBranch: project.defaultBranch, baseSha },
    });
    return assignment;
  }

  /**
   * Give the worktree back — after a merge, an abort, or a GC verdict.
   *
   * `force` is never the default. A dirty worktree at release time means
   * something did not go the way the task record claims, and the honest
   * response is to say so and leave the files where they are.
   */
  async release(
    taskId: string,
    reason: string,
    options: { force?: boolean; deleteBranch?: boolean } = {},
  ): Promise<WorktreeReleaseResult> {
    const task = await this.requireTask(taskId);
    const project = await this.deps.projects.require(task.projectId);
    const path = task.worktreePath ?? taskWorktreePath(this.deps.root, project.slug, task.id);
    const branch = task.branch ?? taskBranchName(task.id);
    this.assertInsideRoot(path);

    const result = await this.removeWorktree(project, path, branch, reason, options);
    // Only when the directory is actually gone. A task whose release was
    // refused — a dirty tree, say — must keep pointing at its work: the record
    // is how anyone, including the wrap-up, finds those files again.
    if (result.removed && task.worktreePath) {
      await this.deps.tasks.releaseWorktree(task.id, {
        path,
        branch,
        reason,
        branchDeleted: result.branchDeleted,
      });
    }
    return { ...result, taskId: task.id };
  }

  /** Worktrees of one project that belong to us — the main worktree excluded. */
  async list(project: ProjectRecord): Promise<WorktreeEntry[]> {
    const root = projectWorktreeRoot(this.deps.root, project.slug);
    const entries = await worktreeList(project.rootPath);
    return entries.filter((entry) => !entry.bare && isPathWithin(root, entry.path));
  }

  /**
   * The daily orphan GC (§10).
   *
   * Runs across every active project that is not read-only, and reports rather
   * than forces. Three kinds of leftover, three different answers:
   *
   *   * **prunable** — the directory is gone, only git's bookkeeping remains.
   *     `git worktree prune` clears that and touches no file.
   *   * **orphan** — a registered worktree whose task is finished or unknown.
   *     Removed if clean, reported if not.
   *   * **stray** — a directory under our root that git does not know about.
   *     Removed only if empty. Anything with content in it is reported,
   *     because we cannot tell what it is and guessing wrong deletes work.
   */
  async gc(options: { projects?: ProjectRecord[] } = {}): Promise<WorktreeGcReport> {
    const projects = (options.projects ?? (await this.deps.projects.listActive())).filter(
      (project) => !project.readOnly,
    );
    const report: WorktreeGcReport = { scanned: 0, removed: [], kept: [], strays: [] };

    for (const project of projects) {
      try {
        await worktreePrune(project.rootPath);
      } catch (error) {
        report.kept.push({
          path: project.rootPath,
          branch: null,
          reason: `prune fehlgeschlagen: ${(error as Error).message}`,
        });
        continue;
      }

      const ours = await this.list(project);
      report.scanned += ours.length;
      const known = new Set<string>();

      for (const entry of ours) {
        known.add(await this.canonical(entry.path));
        const taskId = entry.branch ? taskIdFromBranch(entry.branch) : null;
        if (!taskId) {
          report.kept.push({
            path: entry.path,
            branch: entry.branch,
            reason: 'Branch gehört nicht zu einer Vorschicht-Aufgabe — unangetastet gelassen',
          });
          continue;
        }

        const task = await this.deps.tasks.get(taskId);
        const verdict = orphanVerdict(task);
        if (!verdict) continue;

        const result = await this.removeWorktree(project, entry.path, entry.branch ?? '', verdict, {
          deleteBranch: true,
        });
        if (result.removed) {
          if (task) {
            await this.deps.tasks.releaseWorktree(task.id, {
              path: entry.path,
              branch: entry.branch ?? '',
              reason: verdict,
              branchDeleted: result.branchDeleted,
            });
          }
          report.removed.push({ ...result, taskId });
        } else {
          report.kept.push({
            path: entry.path,
            branch: entry.branch,
            reason: result.problem ?? verdict,
          });
        }
      }

      report.strays.push(...(await this.collectStrays(project, known)));
    }

    await this.deps.eventLog.append({
      kind: 'worktree.gc',
      actor: 'ops',
      payload: {
        scanned: report.scanned,
        removed: report.removed.length,
        kept: report.kept,
        strays: report.strays,
      },
    });
    return report;
  }

  // --- internals -------------------------------------------------------------

  private async removeWorktree(
    project: ProjectRecord,
    path: string,
    branch: string,
    reason: string,
    options: { force?: boolean; deleteBranch?: boolean },
  ): Promise<WorktreeReleaseResult> {
    this.assertInsideRoot(path);
    const entry = await this.findEntry(project, path);
    if (!entry) {
      // Already gone. Deleting the branch is still worth attempting, and still
      // refuses when the branch holds unmerged commits.
      const branchDeleted =
        options.deleteBranch && branch ? await deleteBranch(project.rootPath, branch) : false;
      return { taskId: '', path, branch, removed: true, branchDeleted };
    }

    try {
      await worktreeRemove(project.rootPath, path, options.force ? { force: true } : {});
    } catch (error) {
      return {
        taskId: '',
        path,
        branch,
        removed: false,
        branchDeleted: false,
        problem:
          `Worktree ${path} konnte nicht entfernt werden (${reason}): ` +
          `${(error as Error).message}. Nicht erzwungen — dort liegt möglicherweise Arbeit.`,
      };
    }

    const branchDeleted =
      options.deleteBranch && branch ? await deleteBranch(project.rootPath, branch) : false;

    await this.deps.eventLog.append({
      kind: 'worktree.released',
      actor: 'orchestrator',
      projectId: project.id,
      payload: { path, branch, reason, branchDeleted },
    });
    return { taskId: '', path, branch, removed: true, branchDeleted };
  }

  /**
   * Directories under a project's worktree root that git has no entry for.
   *
   * Only empty ones are removed. A stray with content could be a half-finished
   * `worktree add`, or it could be something a human put there; the GC has no
   * way to tell, so it says what it found and moves on.
   */
  private async collectStrays(
    project: ProjectRecord,
    known: Set<string>,
  ): Promise<WorktreeGcReport['strays']> {
    const root = projectWorktreeRoot(this.deps.root, project.slug);
    let names: string[];
    try {
      names = await readdir(root);
    } catch {
      return [];
    }

    const strays: WorktreeGcReport['strays'] = [];
    for (const name of names) {
      const path = join(root, name);
      if (known.has(await this.canonical(path))) continue;
      if (!taskIdFromWorktreeDirName(name)) {
        strays.push({ path, removed: false, reason: 'Kein Worktree-Verzeichnis von Vorschicht' });
        continue;
      }
      try {
        await rmdir(path);
        strays.push({ path, removed: true, reason: 'Leeres Verzeichnis ohne Git-Eintrag' });
      } catch {
        strays.push({
          path,
          removed: false,
          reason: 'Verzeichnis ohne Git-Eintrag, aber nicht leer — nicht angetastet',
        });
      }
    }
    return strays;
  }

  private async findEntry(project: ProjectRecord, path: string): Promise<WorktreeEntry | null> {
    const wanted = await this.canonical(path);
    const entries = await worktreeList(project.rootPath);
    for (const entry of entries) {
      if ((await this.canonical(entry.path)) === wanted) return entry;
    }
    return null;
  }

  /**
   * `git worktree list` prints resolved paths, so a root reached through a
   * symlink (`/tmp` on some systems, a bind mount on others) would never match
   * a lexical comparison. Falls back to the raw path when it does not exist —
   * the "does this entry exist yet" question has to work for absent paths too.
   */
  private async canonical(path: string): Promise<string> {
    try {
      return await realpath(path);
    } catch {
      return path;
    }
  }

  private assertInsideRoot(path: string): void {
    if (path === this.deps.root || !isPathWithin(this.deps.root, path)) {
      throw new WorktreeError(
        `Pfad ${path} liegt nicht unterhalb des Worktree-Wurzelverzeichnisses ` +
          `${this.deps.root} — Vorschicht entfernt nichts außerhalb davon.`,
      );
    }
  }

  private async recordAssignment(
    task: TaskRecord,
    assignment: WorktreeAssignment,
    options: { onlyIfChanged: boolean },
  ): Promise<void> {
    if (
      options.onlyIfChanged &&
      task.worktreePath === assignment.path &&
      task.branch === assignment.branch
    ) {
      return;
    }
    await this.deps.tasks.assignWorktree(task.id, {
      path: assignment.path,
      branch: assignment.branch,
      baseBranch: assignment.baseBranch,
      baseSha: assignment.baseSha,
    });
  }

  private async requireTask(taskId: string): Promise<TaskRecord> {
    const task = await this.deps.tasks.get(taskId);
    if (!task) throw new WorktreeError(`Aufgabe ${taskId} existiert nicht`);
    return task;
  }
}

/**
 * Is this worktree an orphan, and why?
 *
 * Null means keep. Note what is *not* an orphan: `parked`, `needs_decision` and
 * `interrupted` all hold their worktree — §7.3 keeps claims across a pause
 * precisely so the work survives it, and removing the checkout underneath a
 * parked task would throw away everything the handover note promises is there.
 */
export function orphanVerdict(task: TaskRecord | null): string | null {
  if (!task) return 'Keine zugehörige Aufgabe mehr vorhanden';
  if (!isTerminalTaskState(task.state)) return null;
  return task.state === 'done' ? 'Aufgabe abgeschlossen' : 'Aufgabe abgebrochen';
}
