/**
 * The sampling rule (§8.2).
 *
 * The load-bearing test is the one that shrinks the sample to a single item and
 * still requires the regression item to be in it: "every sample must include at
 * least one item a previous audit passed" is a guarantee, and a guarantee that
 * holds only while there is room to spare is a preference.
 */
import { describe, expect, it } from 'vitest';
import { drawSample, seededRng, shuffle } from './sampling.js';

const POOL = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

describe('drawSample', () => {
  it('draws the requested number of distinct items', () => {
    const sample = drawSample({ pool: POOL, size: 4, rng: seededRng('one') });
    expect(sample.items).toHaveLength(4);
    expect(new Set(sample.items).size).toBe(4);
    for (const item of sample.items) expect(POOL).toContain(item);
  });

  it('includes the oldest previously-passed item that is still in the pool', () => {
    const sample = drawSample({
      pool: POOL,
      size: 3,
      passed: ['zz', 'c', 'd'],
      rng: seededRng('two'),
    });
    expect(sample.regression).toEqual(['c']);
    expect(sample.items[0]).toBe('c');
    expect(sample.note).toBeNull();
  });

  it('keeps the regression item even when there is room for exactly one', () => {
    const sample = drawSample({ pool: POOL, size: 1, passed: ['g'], rng: seededRng('three') });
    expect(sample.items).toEqual(['g']);
  });

  it('says so when there is nothing to regress against', () => {
    const sample = drawSample({ pool: POOL, size: 3, passed: [], rng: seededRng('four') });
    expect(sample.regression).toEqual([]);
    expect(sample.note).toContain('Kein Regressionsposten');
  });

  it('ignores previously-passed items that have left the pool', () => {
    const sample = drawSample({ pool: POOL, size: 3, passed: ['gone'], rng: seededRng('five') });
    expect(sample.regression).toEqual([]);
    expect(sample.note).toContain('Kein Regressionsposten');
  });

  it('reports an empty pool rather than returning an empty sample silently', () => {
    const sample = drawSample({ pool: [], size: 4, rng: seededRng('six') });
    expect(sample.items).toEqual([]);
    expect(sample.note).toContain('Kandidatenpool ist leer');
  });

  it('never draws more than the pool holds', () => {
    const sample = drawSample({ pool: ['a', 'b'], size: 9, rng: seededRng('seven') });
    expect(sample.items.sort()).toEqual(['a', 'b']);
  });

  it('de-duplicates a pool that repeats itself', () => {
    const sample = drawSample({ pool: ['a', 'a', 'b'], size: 3, rng: seededRng('eight') });
    expect(sample.items.sort()).toEqual(['a', 'b']);
  });

  it('actually varies with the seed', () => {
    // Otherwise "randomised" is decoration: the studio could learn which items
    // are examined, and be accidentally correct only there.
    const seen = new Set(
      Array.from({ length: 12 }, (_, i) =>
        drawSample({ pool: POOL, size: 3, rng: seededRng(`seed-${i}`) }).items.join(','),
      ),
    );
    expect(seen.size).toBeGreaterThan(1);
  });

  it('is reproducible from its seed, which is what "recorded" needs', () => {
    const a = drawSample({ pool: POOL, size: 4, rng: seededRng('stable') });
    const b = drawSample({ pool: POOL, size: 4, rng: seededRng('stable') });
    expect(a.items).toEqual(b.items);
  });
});

describe('shuffle', () => {
  it('keeps every element exactly once', () => {
    const out = shuffle(POOL, seededRng('nine'));
    expect(out.slice().sort()).toEqual(POOL.slice().sort());
  });
});

describe('seededRng', () => {
  it('stays inside [0,1)', () => {
    const rng = seededRng('bounds');
    for (let i = 0; i < 500; i++) {
      const value = rng();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });
});
