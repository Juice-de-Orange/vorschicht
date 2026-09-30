/**
 * §8.2's sampling rule, which is two rules wearing one sentence.
 *
 * > "Sampling is randomised but **recorded**, so a later audit can re-check the
 * > same sample, and every sample must include at least one item a previous
 * > audit passed — regression testing applied to the auditor."
 *
 * **Randomised** so the studio cannot learn which items are examined and be
 * accidentally correct only there. **Recorded** so the sample is evidence
 * rather than an anecdote — that is a column in `audits`, not a convention.
 * And the last clause is the sharp one: an auditor that only ever looks at new
 * things can never discover that it was wrong about an old one. Carrying a
 * previously-passed item forward turns each run into a partial re-test of every
 * run before it.
 *
 * The randomness is injected. A sampler that called `Math.random()` would make
 * every test either flaky or a tautology, and the sample has to be reproducible
 * from the record anyway.
 */

export interface SampleInput {
  /** Everything this domain could examine, as stable identifiers. */
  pool: readonly string[];
  /** How many items to draw, including the regression item. */
  size: number;
  /**
   * Items previous audits examined and did not fault.
   *
   * Order matters: the caller passes them oldest-first, and the oldest is the
   * one taken. An item that passed six audits ago has had six audits' worth of
   * changes land on top of it, which is where a quiet regression lives.
   */
  passed?: readonly string[];
  /** `() => number` in [0,1). Injected — see the header. */
  rng: () => number;
}

export interface Sample {
  /** What to examine, regression item first. */
  items: string[];
  /** Which of `items` is there because a previous audit passed it (§8.2). */
  regression: string[];
  /**
   * Why the regression rule could not be satisfied, if it could not.
   *
   * Reported rather than silently skipped: the first audit in a domain has
   * nothing to regress against, and that is a fact about the audit's coverage,
   * which §8.2 wants stated as prominently as a finding.
   */
  note: string | null;
}

/**
 * Draw one sample.
 *
 * The regression item is chosen first and the remainder filled at random from
 * what is left, so a small pool cannot crowd it out — the one guarantee §8.2
 * asks for is the one that survives every edge case here.
 */
export function drawSample(input: SampleInput): Sample {
  const pool = [...new Set(input.pool)];
  const size = Math.max(0, Math.min(Math.trunc(input.size), pool.length));

  const candidates = (input.passed ?? []).filter((item) => pool.includes(item));
  const regression = size > 0 && candidates[0] !== undefined ? [candidates[0]] : [];
  const note =
    size === 0
      ? 'Keine Stichprobe möglich: der Kandidatenpool ist leer.'
      : candidates.length === 0
        ? 'Kein Regressionsposten: keine der zuvor geprüften Positionen liegt noch im ' +
          'Kandidatenpool (bei der ersten Prüfung einer Domäne der Normalfall).'
        : null;

  const rest = shuffle(
    pool.filter((item) => !regression.includes(item)),
    input.rng,
  ).slice(0, size - regression.length);

  return { items: [...regression, ...rest], regression, note };
}

/** Fisher–Yates, so every ordering is equally likely and nothing is dropped. */
export function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const a = out[i];
    const b = out[j];
    if (a === undefined || b === undefined) continue;
    out[i] = b;
    out[j] = a;
  }
  return out;
}

/**
 * A deterministic generator, seeded from a string.
 *
 * mulberry32 over a cheap string hash. Used so an audit's sample is
 * reproducible from its own id: the record says what was examined, and the
 * record can be re-derived rather than merely believed.
 */
export function seededRng(seed: string): () => number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
