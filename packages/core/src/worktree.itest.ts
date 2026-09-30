/**
 * The worktree manager against real git and a real Postgres (§10).
 *
 * These tests are deliberately not mocked. `git worktree` has opinions —
 * about branches that are already checked out, about dirty trees, about
 * administrative entries whose directory has vanished — and every one of those
 * opinions is load-bearing here. A fake would let us assert our idea of git
 * rather than git's.
 *
 * Not one model token is spent: worktrees are files and refs, and the "coder"
 * in these tests is `writeFileSync`.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import { taskBranchName } from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EventLog } from './event-log.js';
import { BOT_IDENTITY, branchExists, worktreeList } from './git.js';
import { ProjectService } from './project-service.js';
import { TaskService } from './task-service.js';
import { ProjectReadOnlyError, WorktreeError, WorktreeManager } from './worktree.js';

const url = process.env.TEST_DATABASE_URL;

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: BOT_IDENTITY.name,
  GIT_AUTHOR_EMAIL: BOT_IDENTITY.email,
  GIT_COMMITTER_NAME: BOT_IDENTITY.name,
  GIT_COMMITTER_EMAIL: BOT_IDENTITY.email,
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
}

/** A throwaway project repository with one commit on `main`. */
function makeProjectRepo(defaultBranch = 'main'): string {
  const dir = mkdtempSync(join(tmpdir(), 'vorschicht-project-'));
  git(dir, 'init', `--initial-branch=${defaultBranch}`, '--quiet');
  writeFileSync(join(dir, 'README.md'), '# Projekt\n');
  git(dir, 'add', '.');
  git(dir, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'chore: Grundstein');
  return dir;
}

describe.skipIf(!url)('Worktree-Verwaltung (§10)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let tasks: TaskService;
  let projects: ProjectService;
  let eventLog: EventLog;
  const junk: string[] = [];

  beforeAll(async () => {
    database = await createTestDatabase('worktree');
    sql = createSql({ url: database.url, max: 4 });
    eventLog = new EventLog(sql);
    tasks = new TaskService({ sql, eventLog });
    projects = new ProjectService(sql);
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
    for (const dir of junk) rmSync(dir, { recursive: true, force: true });
  });

  let seq = 0;
  let repo: string;
  let root: string;
  let manager: WorktreeManager;
  let projectId: string;
  let slug: string;

  /** A fresh project + repository + worktree root per test. */
  async function scenario(options: { readOnly?: boolean; defaultBranch?: string } = {}) {
    seq += 1;
    slug = `p${seq}`;
    repo = makeProjectRepo(options.defaultBranch ?? 'main');
    root = mkdtempSync(join(tmpdir(), 'vorschicht-worktrees-'));
    junk.push(repo, root);
    const project = await projects.create({
      slug,
      name: `Projekt ${seq}`,
      rootPath: repo,
      readOnly: options.readOnly ?? false,
      defaultBranch: options.defaultBranch ?? 'main',
    });
    projectId = project.id;
    manager = new WorktreeManager({ tasks, projects, eventLog, root });
    return project;
  }

  async function codingTask(title = 'Aufgabe') {
    const task = await tasks.create({ projectId, title, priority: 'P1' });
    await tasks.transition(task.id, 'planning');
    return tasks.transition(task.id, 'claimed');
  }

  beforeEach(async () => {
    await scenario();
  });

  describe('Anlegen', () => {
    it('legt Worktree und Branch nach §10 an und hält sie auf der Aufgabe fest', async () => {
      const task = await codingTask();
      const assignment = await manager.ensure(task.id);

      expect(assignment.created).toBe(true);
      expect(assignment.branch).toBe(taskBranchName(task.id));
      expect(assignment.path).toBe(join(root, slug, `task-${task.id}`));
      expect(existsSync(join(assignment.path, 'README.md'))).toBe(true);
      expect(git(assignment.path, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe(assignment.branch);

      // The projection of A43: the worktree is a fact in the task's own log.
      const after = await tasks.get(task.id);
      expect(after?.worktreePath).toBe(assignment.path);
      expect(after?.branch).toBe(assignment.branch);

      const [event] = await sql<Array<{ payload: { path: string; baseSha: string } }>>`
        SELECT payload FROM event_log WHERE kind = 'worktree.created' AND task_id = ${task.id}
      `;
      expect(event?.payload.path).toBe(assignment.path);
      expect(event?.payload.baseSha).toBe(git(repo, 'rev-parse', 'HEAD'));
    });

    it('zweigt vom konfigurierten Integrationsbranch ab, nicht blind von main', async () => {
      await scenario({ defaultBranch: 'dev' });
      const task = await codingTask();
      const assignment = await manager.ensure(task.id);

      expect(assignment.baseBranch).toBe('dev');
      expect(assignment.baseSha).toBe(git(repo, 'rev-parse', 'dev'));
    });

    /**
     * The restart case. The orchestrator restarts on every deploy, and the
     * chaos test of Phase 1 kills it deliberately; a second `ensure()` must
     * neither fail nor write a second assignment event.
     */
    it('benutzt einen vorhandenen Worktree wieder und schreibt nichts doppelt', async () => {
      const task = await codingTask();
      const first = await manager.ensure(task.id);
      writeFileSync(join(first.path, 'arbeit.txt'), 'halbfertig\n');

      const second = await manager.ensure(task.id);
      expect(second.created).toBe(false);
      expect(second.path).toBe(first.path);
      expect(existsSync(join(first.path, 'arbeit.txt'))).toBe(true);

      const [row] = await sql<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM task_events
        WHERE task_id = ${task.id} AND kind = 'worktree_assigned'
      `;
      expect(row?.n).toBe('1');
    });

    /**
     * `baseSha` means "where this work started", and a reused worktree has
     * usually moved on — §7.3's WIP commit, or a second pass after §9's red
     * path. Reporting HEAD instead would hand the claim check and the Reviewer
     * an empty diff of a branch that has changed a great deal, and both would
     * pass on the strength of it.
     */
    it('meldet beim Wiederverwenden den Abzweigpunkt, nicht den aktuellen Stand', async () => {
      const task = await codingTask();
      const first = await manager.ensure(task.id);
      const fork = first.baseSha;

      writeFileSync(join(first.path, 'arbeit.txt'), 'zwischenstand\n');
      git(first.path, 'add', '.');
      git(first.path, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'wip: Stand');
      const head = git(first.path, 'rev-parse', 'HEAD');
      expect(head).not.toBe(fork);

      const second = await manager.ensure(task.id);
      expect(second.created).toBe(false);
      expect(second.baseSha).toBe(fork);
    });

    /**
     * §7.3 writes a WIP commit to the task branch so the work survives a pause.
     * Re-creating the worktree afterwards must check that branch out, never
     * reset it to the base — that would discard exactly what was saved.
     */
    it('setzt einen vorhandenen Branch nicht auf den Basisstand zurück', async () => {
      const task = await codingTask();
      const first = await manager.ensure(task.id);
      writeFileSync(join(first.path, 'arbeit.txt'), 'zwischenstand\n');
      git(first.path, 'add', '.');
      git(
        first.path,
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '-m',
        'wip: Zwischenstand',
      );
      const wip = git(first.path, 'rev-parse', 'HEAD');

      await manager.release(task.id, 'Test');
      expect(existsSync(first.path)).toBe(false);
      expect(await branchExists(repo, first.branch)).toBe(true);

      const again = await manager.ensure(task.id);
      expect(again.created).toBe(true);
      expect(git(again.path, 'rev-parse', 'HEAD')).toBe(wip);
      expect(existsSync(join(again.path, 'arbeit.txt'))).toBe(true);
    });

    /** A41 — the boundary that must not depend on anyone remembering it. */
    it('verweigert jeden Worktree in einem nur-lesenden Projekt (A41)', async () => {
      await scenario({ readOnly: true });
      const task = await codingTask();

      await expect(manager.ensure(task.id)).rejects.toThrow(ProjectReadOnlyError);
      expect(await worktreeList(repo)).toHaveLength(1); // only the main worktree
      expect(await branchExists(repo, taskBranchName(task.id))).toBe(false);
    });

    it('überschreibt kein fremdes Verzeichnis am erwarteten Pfad', async () => {
      const task = await codingTask();
      const path = join(root, slug, `task-${task.id}`);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, 'fremd.txt'), 'nicht von uns\n');

      await expect(manager.ensure(task.id)).rejects.toThrow();
      expect(existsSync(join(path, 'fremd.txt'))).toBe(true);
    });
  });

  describe('Freigeben', () => {
    it('entfernt den Worktree und meldet ihn auf der Aufgabe ab', async () => {
      const task = await codingTask();
      const assignment = await manager.ensure(task.id);

      const result = await manager.release(task.id, 'Zusammengeführt', { deleteBranch: true });
      expect(result.removed).toBe(true);
      expect(existsSync(assignment.path)).toBe(false);

      const after = await tasks.get(task.id);
      expect(after?.worktreePath).toBeNull();
      expect(after?.branch).toBeNull();
    });

    /**
     * The one refusal that matters: unattended cleanup must not be the thing
     * that loses a change nobody has looked at yet.
     */
    it('verweigert die Freigabe eines schmutzigen Worktrees statt zu erzwingen', async () => {
      const task = await codingTask();
      const assignment = await manager.ensure(task.id);
      writeFileSync(join(assignment.path, 'ungesichert.txt'), 'noch nicht committet\n');

      const result = await manager.release(task.id, 'Test');
      expect(result.removed).toBe(false);
      expect(result.problem).toMatch(/nicht erzwungen/i);
      expect(existsSync(join(assignment.path, 'ungesichert.txt'))).toBe(true);

      // The task still knows where its work is.
      expect((await tasks.get(task.id))?.worktreePath).toBe(assignment.path);
    });

    it('löscht einen unzusammengeführten Branch nicht mit', async () => {
      const task = await codingTask();
      const assignment = await manager.ensure(task.id);
      writeFileSync(join(assignment.path, 'arbeit.txt'), 'x\n');
      git(assignment.path, 'add', '.');
      git(assignment.path, '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'feat: Arbeit');

      const result = await manager.release(task.id, 'Abgebrochen', { deleteBranch: true });
      expect(result.removed).toBe(true);
      expect(result.branchDeleted).toBe(false);
      expect(await branchExists(repo, assignment.branch)).toBe(true);
    });

    it('lässt sich außerhalb des Wurzelverzeichnisses nicht anwenden', async () => {
      const outside = new WorktreeManager({
        tasks,
        projects,
        eventLog,
        root: join(root, 'anderswo'),
      });
      const task = await codingTask();
      await manager.ensure(task.id);
      await expect(outside.release(task.id, 'Test')).rejects.toThrow(WorktreeError);
    });
  });

  describe('Aufräumen verwaister Worktrees', () => {
    it('entfernt Worktrees erledigter Aufgaben und lässt laufende in Ruhe', async () => {
      const finished = await codingTask('Fertig');
      const running = await codingTask('Läuft noch');
      const done = await manager.ensure(finished.id);
      const alive = await manager.ensure(running.id);

      await tasks.transition(finished.id, 'coding');
      await tasks.transition(finished.id, 'review');
      await tasks.transition(finished.id, 'gates');
      await tasks.transition(finished.id, 'merge_queue');
      await tasks.transition(finished.id, 'merging');
      await tasks.transition(finished.id, 'done');

      const report = await manager.gc({ projects: [await projects.require(projectId)] });

      expect(report.removed.map((r) => r.path)).toEqual([done.path]);
      expect(existsSync(done.path)).toBe(false);
      expect(existsSync(alive.path)).toBe(true);
      expect((await tasks.get(finished.id))?.worktreePath).toBeNull();
      expect((await tasks.get(running.id))?.worktreePath).toBe(alive.path);
    });

    /**
     * §7.3 keeps claims across a pause so the work survives it. Removing the
     * checkout underneath a parked task would throw away everything the
     * handover note promises is still there.
     */
    it('rührt den Worktree einer geparkten Aufgabe nicht an', async () => {
      const task = await codingTask('Geparkt');
      const assignment = await manager.ensure(task.id);
      await tasks.transition(task.id, 'coding');
      await tasks.transition(task.id, 'parked', { resumeState: 'coding' });

      const report = await manager.gc({ projects: [await projects.require(projectId)] });
      expect(report.removed).toHaveLength(0);
      expect(existsSync(assignment.path)).toBe(true);
    });

    it('meldet einen schmutzigen verwaisten Worktree, statt ihn zu löschen', async () => {
      const task = await codingTask('Abgebrochen');
      const assignment = await manager.ensure(task.id);
      writeFileSync(join(assignment.path, 'ungesichert.txt'), 'daten\n');
      await tasks.transition(task.id, 'aborted');

      const report = await manager.gc({ projects: [await projects.require(projectId)] });
      expect(report.removed).toHaveLength(0);
      expect(report.kept).toHaveLength(1);
      expect(report.kept[0]?.path).toBe(assignment.path);
      expect(existsSync(join(assignment.path, 'ungesichert.txt'))).toBe(true);
    });

    /** A directory that vanished leaves git bookkeeping behind; prune clears it. */
    it('räumt Verwaltungseinträge verschwundener Verzeichnisse auf', async () => {
      const task = await codingTask('Verschwunden');
      const assignment = await manager.ensure(task.id);
      rmSync(assignment.path, { recursive: true, force: true });

      expect((await worktreeList(repo)).some((e) => e.path === assignment.path)).toBe(true);
      await manager.gc({ projects: [await projects.require(projectId)] });
      expect((await worktreeList(repo)).some((e) => e.path === assignment.path)).toBe(false);
    });

    it('entfernt leere Streuverzeichnisse, aber keine mit Inhalt', async () => {
      const empty = join(root, slug, 'task-99999999-9999-4999-8999-999999999999');
      const full = join(root, slug, 'task-88888888-8888-4888-8888-888888888888');
      const foreign = join(root, slug, 'irgendwas');
      for (const dir of [empty, full, foreign]) mkdirSync(dir, { recursive: true });
      writeFileSync(join(full, 'inhalt.txt'), 'x\n');

      const report = await manager.gc({ projects: [await projects.require(projectId)] });
      const byPath = new Map(report.strays.map((s) => [s.path, s]));

      expect(byPath.get(empty)?.removed).toBe(true);
      expect(byPath.get(full)?.removed).toBe(false);
      expect(byPath.get(foreign)?.removed).toBe(false);
      expect(existsSync(empty)).toBe(false);
      expect(existsSync(full)).toBe(true);
      expect(existsSync(foreign)).toBe(true);
    });

    it('überspringt nur-lesende Projekte vollständig (A41)', async () => {
      const readOnly = await projects.create({
        slug: `${slug}-ro`,
        name: 'Nur lesen',
        rootPath: repo,
        readOnly: true,
      });
      const report = await manager.gc({ projects: [readOnly] });
      expect(report.scanned).toBe(0);
      expect(report.removed).toHaveLength(0);
    });

    it('hinterlässt einen Protokolleintrag über jeden Durchlauf', async () => {
      await manager.gc({ projects: [await projects.require(projectId)] });
      const [row] = await sql<Array<{ n: string }>>`
        SELECT count(*)::text AS n FROM event_log WHERE kind = 'worktree.gc'
      `;
      expect(Number(row?.n)).toBeGreaterThan(0);
    });
  });
});
