import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// A plain `.mjs` beside this file — `allowJs` in `tsconfig.test.json` is on for
// exactly this, added in A125.5 so a script's pure half can be tested at all.
import { posixRootPath, selfProjectSpec } from './audit-project.mjs';

const REPO_ROOT = join(import.meta.dirname, '../..');

/**
 * `0001_foundation.sql:67` — the shape the database actually enforces. Written
 * out here rather than described, so the assertions below check the real rule
 * and not a paraphrase of it.
 */
const ROOT_PATH_CONSTRAINT = /^\//;

describe('posixRootPath — the form projects.root_path accepts', () => {
  it('lässt einen POSIX-Pfad unverändert, wie ihn der Produktionshost liefert', () => {
    expect(posixRootPath('/opt/vorschicht')).toBe('/opt/vorschicht');
  });

  it('bildet einen Windows-Pfad auf Git Bashs eigene Abbildung ab', () => {
    expect(posixRootPath(String.raw`C:\src\vorschicht`)).toBe('/c/src/vorschicht');
  });

  it('nimmt dieselbe Platte auch mit Schrägstrichen, weil Node beide liefert', () => {
    expect(posixRootPath('C:/src/vorschicht')).toBe('/c/src/vorschicht');
  });

  it('schreibt den Laufwerksbuchstaben klein — /c/, nicht /C/', () => {
    // Git Bash maps `C:\` to `/c/`. A `/C/` would look right and resolve
    // nowhere, which is the worst of the three possible answers.
    expect(posixRootPath(String.raw`C:\x`)).toBe('/c/x');
  });

  it('verweigert einen relativen Pfad, statt ihn zu einem absoluten zu raten', () => {
    expect(posixRootPath('../Vorschicht')).toBeNull();
    expect(posixRootPath('Vorschicht')).toBeNull();
  });

  it('verweigert eine UNC-Freigabe — sie ist keine, die diese Spalte darstellt', () => {
    expect(posixRootPath(String.raw`\\server\share\Vorschicht`)).toBeNull();
  });

  it('verweigert Leeres, statt einen Pfad zu erfinden', () => {
    expect(posixRootPath('')).toBeNull();
    expect(posixRootPath(undefined)).toBeNull();
  });

  /**
   * The load-bearing one: every answer that is not a refusal must satisfy the
   * constraint. A per-case expectation checks the cases somebody thought of;
   * this checks the property, and it is the property the database enforces.
   */
  it('jede nicht verweigerte Antwort erfüllt die Constraint aus 0001', () => {
    const eingaben = [
      '/opt/vorschicht',
      '/srv/projects/x',
      String.raw`C:\src\vorschicht`,
      'c:/tmp/x',
      String.raw`D:\a\b\c`,
      '/',
      'C:\\',
    ];
    const antworten = eingaben.map(posixRootPath).filter((p) => p !== null);
    expect(antworten.length).toBeGreaterThan(5);
    for (const antwort of antworten) expect(antwort).toMatch(ROOT_PATH_CONSTRAINT);
  });
});

describe('selfProjectSpec — die Zeile, die der Prüfer anlegt', () => {
  it('trägt readOnly: true, weil A85 das entscheidet und nicht die Spaltenvorgabe', () => {
    // `0008_worktrees.sql:30` defaults the column to `false`, so leaving the
    // field out is a decision — and it was the wrong one: the daemon's path has
    // set it since A85 and this one did not.
    expect(selfProjectSpec('/opt/vorschicht')?.readOnly).toBe(true);
  });

  it('gibt einen Pfad weiter, den die Datenbank annimmt', () => {
    expect(selfProjectSpec(String.raw`C:\src\vorschicht`)?.rootPath).toMatch(ROOT_PATH_CONSTRAINT);
  });

  it('verweigert die ganze Zeile, wenn der Pfad nicht darstellbar ist', () => {
    // Fail closed rather than store a guess: this row records *which repository
    // was audited*, and a wrong answer there is worse than no row (A83.6, A99.4).
    expect(selfProjectSpec('../Vorschicht')).toBeNull();
  });

  it('bleibt selbstverwaltet und auf main — die beiden Felder, an denen §12 hängt', () => {
    const spec = selfProjectSpec('/opt/vorschicht');
    expect(spec?.selfManaged).toBe(true);
    expect(spec?.defaultBranch).toBe('main');
    expect(spec?.slug).toBe('vorschicht');
  });

  /**
   * The drift guard, and the reason this file is worth more than its four
   * obvious cases: the defect was not a wrong value, it was **two creation
   * paths that disagreed** about A85 — the daemon's and the auditor's. A
   * comment saying "keep these in step" is not a mechanism (A44.3).
   */
  it('stimmt mit dem Weg des Daemons überein — beide Erzeuger, eine Entscheidung', () => {
    const self = readFileSync(join(REPO_ROOT, 'packages/core/src/onboarding/self.ts'), 'utf8');
    expect(self).toContain('readOnly: true');
    expect(selfProjectSpec('/opt/vorschicht')?.readOnly).toBe(true);
  });
});
