import { describe, expect, it } from 'vitest';
import {
  claimAllowsPath,
  claimSetsOverlap,
  globMatchesPath,
  globsIntersect,
  InvalidClaimGlobError,
  MAX_CLAIM_GLOBS,
  normaliseClaimGlob,
  parseClaimGlob,
  validateClaimGlobs,
} from './claims.js';

describe('Claim-Muster: Normalisierung', () => {
  it('macht aus einem Verzeichnis mit Schrägstrich den Teilbaum', () => {
    expect(normaliseClaimGlob('packages/core/')).toBe('packages/core/**');
  });

  it('entfernt Rauschen, aber erweitert nicht ungefragt', () => {
    expect(normaliseClaimGlob('./src//index.ts')).toBe('src/index.ts');
    // Ohne Schrägstrich bleibt ein Verzeichnis wörtlich — wer den Teilbaum
    // meint, schreibt "src/**". Stilles Verbreitern wäre gefährlicher.
    expect(normaliseClaimGlob('src')).toBe('src');
  });

  it('weist alles zurück, was aus dem Projekt hinausführt', () => {
    expect(() => normaliseClaimGlob('/etc/passwd')).toThrow(InvalidClaimGlobError);
    expect(() => normaliseClaimGlob('../andere-projekte/**')).toThrow(InvalidClaimGlobError);
    expect(() => normaliseClaimGlob('src\\index.ts')).toThrow(InvalidClaimGlobError);
    expect(() => normaliseClaimGlob('   ')).toThrow(InvalidClaimGlobError);
  });

  it('weist Muster zurück, über die sich nicht rechnen lässt', () => {
    for (const bad of ['src/[abc].ts', '!src/**', 'src/**.ts', 'src/{a', 'src/a}']) {
      expect(() => parseClaimGlob(bad), bad).toThrow(InvalidClaimGlobError);
    }
  });

  it('schreibt Alternativen aus', () => {
    expect(parseClaimGlob('src/*.{ts,tsx}')).toEqual(['src/*.ts', 'src/*.tsx']);
    expect(parseClaimGlob('{a,b}/{c,d}.ts')).toEqual(['a/c.ts', 'a/d.ts', 'b/c.ts', 'b/d.ts']);
  });

  it('entdoppelt eine Claim-Liste und behält die Reihenfolge des Planners', () => {
    expect(validateClaimGlobs(['src/b.ts', './src/a.ts', 'src/b.ts'])).toEqual([
      'src/b.ts',
      'src/a.ts',
    ]);
  });

  it('hält eine Claim-Liste in einer prüfbaren Größenordnung', () => {
    const many = Array.from({ length: MAX_CLAIM_GLOBS + 1 }, (_, i) => `src/f${i}.ts`);
    expect(() => validateClaimGlobs(many)).toThrow(InvalidClaimGlobError);
  });
});

describe('Claim-Muster: Treffer auf Pfaden', () => {
  const cases: Array<[string, string, boolean]> = [
    ['src/**', 'src/index.ts', true],
    ['src/**', 'src/deep/nested/file.ts', true],
    ['src/**', 'srcx/index.ts', false],
    ['src/*.ts', 'src/index.ts', true],
    ['src/*.ts', 'src/deep/index.ts', false],
    ['**/*.ts', 'a/b/c.ts', true],
    ['**/*.ts', 'c.ts', true],
    ['packages/*/src/**', 'packages/core/src/a/b.ts', true],
    ['packages/*/src/**', 'packages/core/dist/a.js', false],
    ['docs/adr-????.md', 'docs/adr-0001.md', true],
    ['docs/adr-????.md', 'docs/adr-1.md', false],
    ['src/*.{ts,tsx}', 'src/app.tsx', true],
  ];

  for (const [glob, path, expected] of cases) {
    it(`${glob} ${expected ? 'trifft' : 'trifft nicht'} ${path}`, () => {
      expect(globMatchesPath(glob, path)).toBe(expected);
    });
  }

  it('trifft niemals einen Pfad, der aus dem Projekt herausführt', () => {
    expect(globMatchesPath('**', '../geheim.env')).toBe(false);
    expect(globMatchesPath('**', '/etc/passwd')).toBe(false);
  });

  it('erlaubt ohne Claims gar nichts (§6.6, fail-closed)', () => {
    expect(claimAllowsPath([], 'src/index.ts')).toBe(false);
    expect(claimAllowsPath(['src/**'], 'src/index.ts')).toBe(true);
    expect(claimAllowsPath(['src/**'], 'docs/README.md')).toBe(false);
  });
});

describe('Claim-Muster: Überschneidung zweier Muster', () => {
  const overlapping: Array<[string, string]> = [
    ['src/**', '**/*.ts'],
    ['src/**', 'src/index.ts'],
    ['packages/*/src/**', 'packages/core/**'],
    ['**', 'irgendwas/tief/drin.ts'],
    ['src/*.ts', 'src/i*.ts'],
    ['docs/adr-????.md', 'docs/*.md'],
    ['a/**/b.ts', 'a/x/y/b.ts'],
    ['src/{a,b}.ts', 'src/b.ts'],
    // Beide Seiten Muster, gemeinsamer Zeuge nur konstruierbar: src/x/y.ts
    ['src/**/y.ts', 'src/x/**'],
  ];

  const disjoint: Array<[string, string]> = [
    ['src/**', 'docs/**'],
    ['packages/core/**', 'packages/web/**'],
    ['src/*.ts', 'src/*.md'],
    ['src/*.ts', 'src/deep/*.ts'],
    ['docs/adr-????.md', 'docs/adr-?.md'],
    ['a/b/c.ts', 'a/b/d.ts'],
    ['src/{a,b}.ts', 'src/c.ts'],
    ['**/*.ts', '**/*.tsx'],
  ];

  for (const [a, b] of overlapping) {
    it(`${a} überschneidet ${b}`, () => {
      expect(globsIntersect(a, b)).toBe(true);
      expect(globsIntersect(b, a)).toBe(true);
    });
  }

  for (const [a, b] of disjoint) {
    it(`${a} überschneidet ${b} nicht`, () => {
      expect(globsIntersect(a, b)).toBe(false);
      expect(globsIntersect(b, a)).toBe(false);
    });
  }

  it('meldet, welche Muster genau kollidieren', () => {
    const overlaps = claimSetsOverlap(['src/**', 'docs/**'], ['**/*.ts', 'README.md']);
    expect(overlaps).toEqual([
      { ours: 'src/**', theirs: '**/*.ts' },
      { ours: 'docs/**', theirs: '**/*.ts' },
    ]);
  });

  it('lässt zwei saubere Schnitte nebeneinander laufen', () => {
    expect(claimSetsOverlap(['apps/web/**'], ['apps/server/**', 'docs/*.md'])).toEqual([]);
  });
});

/**
 * Die Richtung, die wirklich zählt.
 *
 * Ein falsches "überschneidet sich" kostet Durchsatz; ein falsches "ist
 * disjunkt" setzt zwei Coder in dieselbe Datei. Dieser Test erschöpft einen
 * kleinen Pfadraum und prüft ausschließlich die gefährliche Richtung: wenn
 * `globsIntersect` nein sagt, darf kein Pfad beide Muster treffen.
 */
describe('Claim-Muster: Disjunktheit ist niemals gelogen', () => {
  const SEGMENTS = ['a', 'b', 'ab', '*', '?', 'a*', '*b', '**'];
  const NAMES = ['a', 'b', 'ab', 'ba', 'aa'];

  /** Alle Pfade mit bis zu drei Segmenten aus einem winzigen Alphabet. */
  function everyPath(): string[] {
    const paths: string[] = [];
    for (const first of NAMES) {
      paths.push(first);
      for (const second of NAMES) {
        paths.push(`${first}/${second}`);
        for (const third of NAMES) paths.push(`${first}/${second}/${third}`);
      }
    }
    return paths;
  }

  /** Alle Muster mit bis zu drei Segmenten aus dem Muster-Alphabet. */
  function everyGlob(): string[] {
    const globs: string[] = [];
    for (const first of SEGMENTS) {
      globs.push(first);
      for (const second of SEGMENTS) {
        globs.push(`${first}/${second}`);
      }
    }
    return globs;
  }

  it('findet keinen gemeinsamen Pfad, wo Disjunktheit behauptet wird', () => {
    const globs = everyGlob();
    const paths = everyPath();
    const matches = new Map<string, Set<string>>();
    for (const glob of globs) {
      matches.set(glob, new Set(paths.filter((path) => globMatchesPath(glob, path))));
    }

    let checked = 0;
    let disjointPairs = 0;
    for (const a of globs) {
      for (const b of globs) {
        checked += 1;
        if (globsIntersect(a, b)) continue;
        disjointPairs += 1;
        const left = matches.get(a) as Set<string>;
        const right = matches.get(b) as Set<string>;
        for (const path of left) {
          if (right.has(path)) {
            throw new Error(`"${a}" und "${b}" gelten als disjunkt, aber "${path}" trifft beide`);
          }
        }
      }
    }

    // Ohne diese Schwelle könnte der Test grün sein, weil nie etwas geprüft wurde.
    expect(checked).toBeGreaterThan(5_000);
    expect(disjointPairs).toBeGreaterThan(1_000);
  });

  it('behauptet keine Überschneidung, wo im Suchraum ein Zeuge fehlen müsste', () => {
    // Die Gegenrichtung ist nur stichprobenhaft prüfbar — ein Zeuge kann außerhalb
    // des Suchraums liegen. Für Muster ohne "**" und ohne "?" ist er es aber nicht,
    // also ist dieser Ausschnitt exakt.
    const simple = ['a', 'b', 'ab', 'a*', '*b', '*'];
    for (const a of simple) {
      for (const b of simple) {
        if (!globsIntersect(a, b)) continue;
        const witness = ['a', 'b', 'ab', 'ba', 'aa', 'abb', 'aab'].some(
          (path) => globMatchesPath(a, path) && globMatchesPath(b, path),
        );
        expect(witness, `${a} ∩ ${b} behauptet, ohne Zeugen`).toBe(true);
      }
    }
  });
});
