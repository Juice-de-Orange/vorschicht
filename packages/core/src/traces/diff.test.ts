/**
 * `computeDiff`, against a real git repository.
 *
 * A stubbed git would let every assertion here be about the stub. The one thing
 * this module has to get right is *which two commits* are compared, and that is
 * a question only git can answer — the failure it guards against (a merged task
 * showing "nothing changed", or an in-flight one showing every unrelated commit
 * that landed on `main` as if it had deleted them) is invisible to any test that
 * does not build the history that produces it.
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeDiff, parseNumstat, splitPatch } from './diff.js';

const exec = promisify(execFile);

let repo: string;
/** The fork point, the branch tip, and a commit that landed on main afterwards. */
let basis = '';
let zweigTip = '';
let mainTip = '';

async function git(...args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: repo });
  return stdout.trim();
}

async function commit(datei: string, inhalt: string, nachricht: string): Promise<string> {
  await writeFile(join(repo, datei), inhalt, 'utf8');
  await git('add', '-A');
  await git(
    '-c',
    'user.name=Vorschicht Bot',
    '-c',
    'user.email=vorschicht-bot@example.com',
    'commit',
    '-q',
    '-m',
    nachricht,
  );
  return git('rev-parse', 'HEAD');
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), 'vorschicht-diff-'));
  await git('init', '-q', '-b', 'main');

  await commit('a.txt', 'eins\n', 'erster Commit');
  basis = await commit('b.txt', 'zwei\n', 'Abzweigpunkt');

  // The task's branch, forked here.
  await git('checkout', '-q', '-b', 'vorschicht/task-1');
  zweigTip = await commit('c.txt', 'drei\n', 'Arbeit der Aufgabe');

  // And meanwhile `main` moves on, which is the whole trap: a two-dot
  // comparison against the *branch name* would report this file as deleted.
  await git('checkout', '-q', 'main');
  mainTip = await commit('fremd.txt', 'nicht meine Aufgabe\n', 'fremder Commit auf main');
  await git('checkout', '-q', 'vorschicht/task-1');
});

afterAll(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('computeDiff — welche zwei Stände verglichen werden', () => {
  it('vergleicht bei einem Merge das aufgezeichnete Sha-Paar', async () => {
    const diff = await computeDiff({
      repoPath: repo,
      fromRef: basis,
      toRef: zweigTip,
      basis: 'merge',
      forkPoint: false,
    });

    expect(diff.ok).toBe(true);
    expect(diff.files.map((d) => d.path)).toEqual(['c.txt']);
    expect(diff.files[0]?.added).toBe(1);
    expect(diff.forkPoint).toBe(false);
  });

  it('vergleicht bei einem Zweig ab dem Abzweigpunkt, nicht ab der Spitze von main', async () => {
    const diff = await computeDiff({
      repoPath: repo,
      fromRef: 'main',
      toRef: 'vorschicht/task-1',
      basis: 'branch',
      forkPoint: true,
    });

    // The load-bearing assertion of this file. `main` has moved on since the
    // fork, so a two-dot comparison would additionally report `fremd.txt` — as a
    // *deletion*, because it exists on the left and not on the right. That reads
    // as this task having deleted somebody else's work.
    expect(diff.ok).toBe(true);
    expect(diff.files.map((d) => d.path)).toEqual(['c.txt']);
    expect(diff.files.map((d) => d.path)).not.toContain('fremd.txt');
  });

  it('zeigt ohne Abzweigpunkt genau den falschen Vergleich — der Beleg für die Zeile darüber', async () => {
    const falsch = await computeDiff({
      repoPath: repo,
      fromRef: 'main',
      toRef: 'vorschicht/task-1',
      basis: 'branch',
      // The same request with the flag off, so the previous test's claim is a
      // demonstrated difference rather than an assertion about a flag nobody
      // varied.
      forkPoint: false,
    });

    expect(falsch.files.map((d) => d.path).sort()).toEqual(['c.txt', 'fremd.txt']);
    expect(falsch.files.find((d) => d.path === 'fremd.txt')?.removed).toBe(1);
  });

  it('meldet einen nicht auflösbaren Commit als Grund, nicht als leeren Vergleich', async () => {
    const diff = await computeDiff({
      repoPath: repo,
      fromRef: '0123456789abcdef0123456789abcdef01234567',
      toRef: zweigTip,
      basis: 'merge',
      forkPoint: false,
    });

    // A44.5 deletes a merged branch, so the left end really does disappear in
    // practice. "No files changed" would be the most confident possible way to
    // be wrong about it.
    expect(diff.ok).toBe(false);
    expect(diff.problem).toBe('unresolvable');
    expect(diff.erklaerung).toContain('nicht auflösbar');
    expect(diff.files).toEqual([]);
  });

  it('meldet ein fehlendes Repository als solches', async () => {
    const diff = await computeDiff({
      repoPath: join(tmpdir(), 'gibt-es-nicht-vorschicht'),
      fromRef: basis,
      toRef: zweigTip,
      basis: 'merge',
      forkPoint: false,
    });

    expect(diff.ok).toBe(false);
    expect(diff.problem).toBe('no_repository');
  });

  it('nennt einen leeren Vergleich als solchen, nicht als Fehler', async () => {
    const diff = await computeDiff({
      repoPath: repo,
      fromRef: mainTip,
      toRef: mainTip,
      basis: 'merge',
      forkPoint: false,
    });

    // "This task changed nothing" is a real and ordinary answer, and it must be
    // distinguishable from all four refusals above.
    expect(diff.ok).toBe(true);
    expect(diff.problem).toBeNull();
    expect(diff.files).toEqual([]);
  });

  it('liefert den Patch-Text zur Datei, der er gehört', async () => {
    const diff = await computeDiff({
      repoPath: repo,
      fromRef: basis,
      toRef: zweigTip,
      basis: 'merge',
      forkPoint: false,
    });

    expect(diff.files[0]?.patch).toContain('+drei');
    expect(diff.files[0]?.patch).toContain('diff --git a/c.txt b/c.txt');
    expect(diff.files[0]?.patchTruncated).toBe(false);
  });
});

describe('parseNumstat / splitPatch', () => {
  it('liest NUL-getrennte Einträge samt Pfad mit Leerzeichen', () => {
    const eintraege = parseNumstat('3\t1\tmein pfad/a.ts\0' + '0\t2\tb.ts\0');

    // NUL-separated rather than line-based precisely so a path with a space, a
    // quote or a newline is not a parsing question.
    expect(eintraege).toEqual([
      { path: 'mein pfad/a.ts', added: 3, removed: 1, binary: false },
      { path: 'b.ts', added: 0, removed: 2, binary: false },
    ]);
  });

  it('erkennt eine Binärdatei an den beiden Strichen', () => {
    expect(parseNumstat('-\t-\tbild.png\0')).toEqual([
      { path: 'bild.png', added: 0, removed: 0, binary: true },
    ]);
  });

  it('nimmt bei einer Umbenennung den neuen Pfad', () => {
    // `--numstat -z` leaves the path field empty and puts old and new in the two
    // following NUL fields. The new one is what the patch header names, so it is
    // the one the patch can be matched to.
    expect(parseNumstat('1\t1\t\0alt.ts\0neu.ts\0')).toEqual([
      { path: 'neu.ts', added: 1, removed: 1, binary: false },
    ]);
  });

  it('ordnet Patch-Blöcke über die +++-Zeile zu, auch bei Leerzeichen im Pfad', () => {
    const roh = [
      'diff --git a/mein pfad/a.ts b/mein pfad/a.ts',
      'index 111..222 100644',
      '--- a/mein pfad/a.ts',
      '+++ b/mein pfad/a.ts',
      '@@ -1 +1 @@',
      '-alt',
      '+neu',
    ].join('\n');

    // The `diff --git a/x y b/x y` header is genuinely ambiguous for a path with
    // a space; the `+++ b/` line is not.
    expect([...splitPatch(roh).keys()]).toEqual(['mein pfad/a.ts']);
  });

  it('ordnet eine gelöschte Datei über die ---a-Zeile zu', () => {
    const roh = [
      'diff --git a/weg.ts b/weg.ts',
      'deleted file mode 100644',
      '--- a/weg.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-weg',
    ].join('\n');

    // A deletion has `+++ /dev/null`, so the left-hand line has to answer.
    expect([...splitPatch(roh).keys()]).toEqual(['weg.ts']);
  });
});
