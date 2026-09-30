import { describe, expect, it } from 'vitest';
import {
  assertSafeSlug,
  isPathWithin,
  projectWorktreeRoot,
  taskBranchName,
  taskIdFromBranch,
  taskIdFromWorktreeDirName,
  taskWorktreePath,
  UnsafeSlugError,
} from './worktree.js';

const TASK = '11111111-2222-4333-8444-555555555555';

describe('Benennung von Worktrees und Branches (§10)', () => {
  it('bildet den Branchnamen aus §10', () => {
    expect(taskBranchName(TASK)).toBe(`vorschicht/task-${TASK}`);
  });

  it('liest die Aufgaben-Id aus einem Branch zurück', () => {
    expect(taskIdFromBranch(taskBranchName(TASK))).toBe(TASK);
    expect(taskIdFromWorktreeDirName(`task-${TASK}`)).toBe(TASK);
  });

  it('erkennt fremde Branches nicht als eigene', () => {
    expect(taskIdFromBranch('main')).toBeNull();
    expect(taskIdFromBranch('feature/vorschicht/task-x')).toBeNull();
  });

  /**
   * The GC deletes on the strength of this answer. A branch that merely looks
   * like ours must not resolve to "an id no task has" — that is the orphan
   * verdict, and it would remove someone's hand-made branch.
   */
  it('verlangt eine echte UUID, nicht nur das Präfix', () => {
    expect(taskIdFromBranch('vorschicht/task-experiment')).toBeNull();
    expect(taskIdFromBranch('vorschicht/task-')).toBeNull();
    expect(taskIdFromWorktreeDirName('task-scratch')).toBeNull();
  });

  it('setzt den kanonischen Pfad zusammen', () => {
    expect(taskWorktreePath('/data/worktrees', 'vorschicht', TASK)).toBe(
      `/data/worktrees/vorschicht/task-${TASK}`,
    );
    expect(projectWorktreeRoot('/data/worktrees', 'vorschicht')).toBe('/data/worktrees/vorschicht');
  });

  /**
   * `projects` is mutable configuration (§5), so a slug is checked where it
   * becomes a path rather than trusted because it was stored once.
   */
  it('weist Slugs zurück, die aus dem Wurzelverzeichnis führen würden', () => {
    for (const slug of ['../etc', 'a/b', '..', '.', '/abs', '']) {
      expect(() => assertSafeSlug(slug)).toThrow(UnsafeSlugError);
    }
    expect(assertSafeSlug('example-app')).toBe('example-app');
    expect(assertSafeSlug('my.project_1-x')).toBe('my.project_1-x');
  });
});

describe('Pfad-Eingrenzung (§6.6)', () => {
  it('erlaubt das Verzeichnis selbst und alles darunter', () => {
    expect(isPathWithin('/w/task', '/w/task')).toBe(true);
    expect(isPathWithin('/w/task', '/w/task/src/a.ts')).toBe(true);
    expect(isPathWithin('/w/task', '/w/task/./src/../src/a.ts')).toBe(true);
  });

  it('weist alles außerhalb zurück, auch über ..', () => {
    expect(isPathWithin('/w/task', '/w')).toBe(false);
    expect(isPathWithin('/w/task', '/w/other')).toBe(false);
    expect(isPathWithin('/w/task', '/w/task/../other/a.ts')).toBe(false);
    expect(isPathWithin('/w/task', '/etc/passwd')).toBe(false);
  });

  /**
   * The prefix trap: `/w/task-2` starts with `/w/task` as a string. A hook that
   * compared prefixes would let a second task write into a neighbour's worktree.
   */
  it('fällt nicht auf gemeinsame Namenspräfixe herein', () => {
    expect(isPathWithin('/w/task', '/w/task-2/src/a.ts')).toBe(false);
    expect(isPathWithin('/w/task', '/w/taskx')).toBe(false);
  });
});
