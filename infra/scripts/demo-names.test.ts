import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every test a demo script names by string still exists.
 *
 * The demo scripts are the phase balances (§22: "demo" means a scripted,
 * repeatable check, not a manual anecdote), and they decide a gate by looking up
 * a test **title** in a log:
 *
 *     ran_green 'zählt ein nicht lesbares Dokument als vorhanden, …' || tresor=1
 *
 * A title is not a symbol. Nothing renames it for you, nothing warns when it
 * moves, and the failure is silent in the worst direction: the lookup misses,
 * the gate reports red, and the reason it gives is about the *subject* — "der
 * Tresor hält seine Zusicherungen nicht" — while all sixty assertions are green.
 *
 * **This happened, and the shape is the one this repository keeps re-learning.**
 * On 2026-08-10 two implementers worked in parallel worktrees: one wrote G6's
 * check naming `'zählt ein noch nicht lesbares Dokument …'`, the other renamed
 * that very test in `44cb39c` and dropped the word `noch`. Different files, no
 * merge conflict, `pnpm gate` green — and `demo-phase6.sh` reported G6 red from
 * that moment on, while `CHANGELOG.md` and the build log both recorded the
 * balance as "2 grün". A81 records the same shape one layer up, and A76.4 the
 * lesson: an over-claiming evidence line is invisible to every test in the
 * repository, and the only things that read it are a human and the auditor.
 *
 * So it is read here. A rename now fails the build in the commit that makes it,
 * which is the mechanical guard §8.2 asks for whenever a violated rule admits
 * one.
 *
 * Deliberately a **substring** match: the scripts quote a prefix on purpose,
 * because a title that ends in an explanatory clause ("… — sonst wäre es ein P0
 * pro Nacht") should be free to have that clause reworded. What may not change
 * unnoticed is the part a gate points at.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** `ran_green '<title>'` — the first argument, which is what gets looked up. */
const RAN_GREEN = /ran_green\s+'([^']+)'/g;

/**
 * `it('…')`, `it("…")`, and the `it.each(...)('…')` form the suites also use.
 *
 * Two patterns rather than one with a backreferenced delimiter, and the reason
 * is the first thing this guard found — its own bug. A single class [^'"]+
 * stops at the first double quote *inside* a single-quoted title, and this
 * repository is full of them: '… bleibt "infra", nicht rot'. The guard duly
 * reported seven missing tests that all existed, which is a perfect way to
 * teach everyone to ignore it. Each alternative now excludes only its own
 * delimiter and tolerates an escaped one.
 */
const TEST_TITLE = [
  /\bit(?:\.each\([\s\S]*?\))?\(\s*'((?:[^'\\]|\\.)*)'/g,
  /\bit(?:\.each\([\s\S]*?\))?\(\s*"((?:[^"\\]|\\.)*)"/g,
];

async function walk(dir: string, hit: (path: string) => void): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full, hit);
    else hit(full);
  }
}

async function testTitles(): Promise<string[]> {
  const files: string[] = [];
  for (const root of ['packages', 'apps', 'e2e', 'infra']) {
    await walk(join(repoRoot, root), (p) => {
      if (/\.(i?test|spec)\.ts$/.test(p)) files.push(p);
    });
  }
  const titles: string[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const pattern of TEST_TITLE) {
      for (const match of source.matchAll(pattern)) {
        if (match[1]) titles.push(match[1]);
      }
    }
  }
  return titles;
}

async function demoScripts(): Promise<Array<{ name: string; source: string }>> {
  const dir = join(repoRoot, 'infra', 'scripts');
  const names = (await readdir(dir)).filter((n) => /^demo-.*\.sh$/.test(n)).sort();
  return Promise.all(
    names.map(async (name) => ({ name, source: await readFile(join(dir, name), 'utf8') })),
  );
}

describe('Demo-Skripte — jeder benannte Test existiert noch (§22, A118)', () => {
  it('findet überhaupt Skripte, Namen und Titel — sonst prüft der Fall nichts', async () => {
    // The guard on the guard: an empty corpus on either side makes every
    // assertion below vacuously true, which is the way a check like this dies.
    const scripts = await demoScripts();
    const titles = await testTitles();
    expect(scripts.length).toBeGreaterThanOrEqual(5);
    expect(titles.length).toBeGreaterThan(500);
    const named = scripts.flatMap((s) => [...s.source.matchAll(RAN_GREEN)]);
    expect(named.length).toBeGreaterThan(100);
  });

  it('jeder `ran_green`-Name ist Teil eines echten Testtitels', async () => {
    const [scripts, titles] = await Promise.all([demoScripts(), testTitles()]);
    const missing: string[] = [];
    for (const { name, source } of scripts) {
      for (const match of source.matchAll(RAN_GREEN)) {
        const wanted = match[1];
        if (wanted && !titles.some((title) => title.includes(wanted))) {
          missing.push(`${name}: ${wanted}`);
        }
      }
    }
    // Named rather than counted: the point of failing is that somebody can fix
    // it in the same commit, and for that they need the string.
    expect(missing).toEqual([]);
  });
});
