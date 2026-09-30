/**
 * The comparison A10's whole policy turns on.
 *
 * Every case here is written from the side that would let something through:
 * an unreadable version must not become `patch`, a prerelease must not become an
 * upgrade target, and `0.x` must not become a routine minor. Those three are the
 * only ways this file can put an unattended merge where an inbox card belongs.
 */
import { describe, expect, it } from 'vitest';
import { classifyBump, compareSemver, isUpgrade, parseSemver } from './semver.js';

describe('parseSemver', () => {
  it('liest eine schlichte Version', () => {
    expect(parseSemver('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: null });
  });

  it('streift Bereichsoperatoren und ein führendes v ab', () => {
    for (const input of ['^1.2.3', '~1.2.3', '=1.2.3', 'v1.2.3', ' 1.2.3 ']) {
      expect(parseSemver(input), input).toMatchObject({ major: 1, minor: 2, patch: 3 });
    }
  });

  it('liest Vorabversionen und verwirft Build-Metadaten', () => {
    expect(parseSemver('1.2.3-rc.1')).toMatchObject({ prerelease: ['rc', '1'] });
    expect(parseSemver('1.2.3+build.7')).toMatchObject({ prerelease: null });
  });

  it('antwortet null statt zu raten', () => {
    // Decision 1. Every one of these has appeared in a real manifest, and every
    // one of them would be a wrong `patch` if this returned a guess.
    for (const input of [
      '1.2',
      '1.x',
      '>=1.2.0 <2.0.0',
      'workspace:*',
      'latest',
      'github:foo/bar#main',
      '',
    ]) {
      expect(parseSemver(input), input).toBeNull();
    }
  });

  it('liest eine Kalenderversion als das, was sie zahlenmäßig ist', () => {
    // Written after the suite refused the opposite expectation, and kept because
    // the behaviour is the useful one: `2026.08.10` parses to 2026.8.10 and
    // orders correctly against `2026.09.01`, so a CalVer package still gets a
    // real comparison instead of a card saying nothing could be read. A year
    // rollover lands on `major`, which is A10's branch that asks the operator — the safe
    // direction for a versioning scheme this project does not model.
    expect(parseSemver('2026.08.10')).toMatchObject({ major: 2026, minor: 8, patch: 10 });
    expect(classifyBump('2026.08.10', '2026.09.01')).toBe('minor');
    expect(classifyBump('2026.12.01', '2027.01.01')).toBe('major');
  });
});

describe('compareSemver', () => {
  const of = (input: string) => {
    const parsed = parseSemver(input);
    if (!parsed) throw new Error(`Fixture ist keine Version: ${input}`);
    return parsed;
  };

  it('ordnet nach Major, Minor, Patch', () => {
    expect(compareSemver(of('1.2.3'), of('2.0.0'))).toBe(-1);
    expect(compareSemver(of('1.3.0'), of('1.2.9'))).toBe(1);
    expect(compareSemver(of('1.2.3'), of('1.2.3'))).toBe(0);
  });

  it('stellt eine Vorabversion unter die gleiche Freigabe', () => {
    // Semver's own rule, and the reason `isUpgrade` can refuse rc targets
    // without also having to rank them.
    expect(compareSemver(of('1.2.3-rc.1'), of('1.2.3'))).toBe(-1);
    expect(compareSemver(of('1.2.3'), of('1.2.3-rc.1'))).toBe(1);
  });

  it('ordnet Vorabversionen nach der Spezifikation', () => {
    expect(compareSemver(of('1.0.0-alpha'), of('1.0.0-alpha.1'))).toBe(-1);
    expect(compareSemver(of('1.0.0-alpha.1'), of('1.0.0-alpha.beta'))).toBe(-1);
    expect(compareSemver(of('1.0.0-rc.2'), of('1.0.0-rc.10'))).toBe(-1);
  });
});

describe('classifyBump', () => {
  it('trennt Patch, Minor und Major oberhalb von 1.0.0', () => {
    expect(classifyBump('1.2.3', '1.2.4')).toBe('patch');
    expect(classifyBump('1.2.3', '1.3.0')).toBe('minor');
    expect(classifyBump('1.2.3', '2.0.0')).toBe('major');
  });

  it('behandelt 0.x als brechend, sobald sich die Minor ändert', () => {
    // Decision 3, and the case A10 would otherwise merge unattended: `0.2.0`
    // after `0.1.9` routinely breaks, and semver's own text says so.
    expect(classifyBump('0.1.9', '0.2.0')).toBe('major');
    expect(classifyBump('0.1.9', '0.1.10')).toBe('patch');
    expect(classifyBump('0.0.1', '0.0.2')).toBe('major');
  });

  it('nennt Unlesbares «unknown» statt «patch»', () => {
    // The one classification that must never be optimistic: `applyRadarPolicy`
    // sends `unknown` to the operator and `patch` into an unattended merge.
    expect(classifyBump('workspace:*', '1.0.0')).toBe('unknown');
    expect(classifyBump('1.2.3', 'latest')).toBe('unknown');
  });

  it('nennt Gleichstand und Rückschritt «none»', () => {
    expect(classifyBump('1.2.3', '1.2.3')).toBe('none');
    expect(classifyBump('2.0.0', '1.9.9')).toBe('none');
  });
});

describe('isUpgrade', () => {
  it('bejaht nur einen echten Schritt nach vorn', () => {
    expect(isUpgrade('1.2.3', '1.2.4')).toBe(true);
    expect(isUpgrade('1.2.3', '1.2.3')).toBe(false);
    expect(isUpgrade('1.2.3', '1.2.2')).toBe(false);
  });

  it('verweigert eine Vorabversion als Ziel', () => {
    // Decision 2. A channel that briefly serves an rc must not produce a task
    // proposing the studio pin one — A27's pin is what keeps the runner
    // deterministic in the first place.
    expect(isUpgrade('1.2.3', '2.0.0-rc.1')).toBe(false);
    expect(isUpgrade('1.2.3-rc.1', '1.2.3')).toBe(true);
  });

  it('verweigert, was es nicht lesen konnte', () => {
    expect(isUpgrade('workspace:*', '1.0.0')).toBe(false);
    expect(isUpgrade('1.0.0', 'nightly')).toBe(false);
  });
});
