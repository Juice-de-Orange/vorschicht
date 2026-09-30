import { describe, expect, it } from 'vitest';
import { label, verdict } from './gate-verdict.mjs';

/**
 * §11's classification, and the distinction the runner did not make.
 *
 * The load-bearing cases are the first two: a step whose process never started
 * must be `infra` **even for the four `any-failure` steps**, because that is the
 * combination that shipped as a §11 blocker. Everything else here is the guard
 * that the fix did not over-correct — A50's rule for a process that really ran
 * has to survive untouched, or a `tsc` type error becomes a retry.
 */

/** @see gate-verdict.mjs — the four A50 steps, by their real ids. */
const anyFailure = ['typecheck', 'lint', 'test', 'build'] as const;

type Step = {
  id: string;
  title: string;
  cmd: string[];
  classify?: 'a25' | 'any-failure';
};

const step = (id: string, classify?: 'a25' | 'any-failure'): Step => ({
  id,
  title: id,
  cmd: ['pnpm', 'run', `gate:${id}`],
  ...(classify ? { classify } : {}),
});

const result = (over: { step: Step; code: number; spawned: boolean; reason?: string }) => ({
  ms: 0,
  ...over,
});

describe('verdict', () => {
  // The defect, as an assertion. On 2026-08-16 a Windows checkout reported four
  // red "code problems" while not one process had started.
  it.each(anyFailure)(
    'nennt einen nie gestarteten any-failure-Schritt infra, nicht finding (%s)',
    (id) => {
      const r = result({
        step: step(id, 'any-failure'),
        code: 2,
        spawned: false,
        reason: 'ENOENT',
      });
      expect(verdict(r)).toBe('infra');
    },
  );

  it('nennt einen nie gestarteten a25-Schritt ebenfalls infra', () => {
    const r = result({ step: step('secrets'), code: 2, spawned: false, reason: 'EFTYPE' });
    expect(verdict(r)).toBe('infra');
  });

  // `spawned` outranks everything, including a code that would otherwise read
  // as success — there was no process, so there is nothing to have succeeded.
  it('lässt sich von einem Code 0 ohne Prozess nicht täuschen', () => {
    const r = result({ step: step('build', 'any-failure'), code: 0, spawned: false });
    expect(verdict(r)).toBe('infra');
  });

  // A50, unchanged: this is the case the fix must not touch. `tsc` exits 2 on a
  // plain type error, and reading that as infrastructure turns a blocker into a
  // retry.
  it.each([1, 2, 127])(
    'liest jeden echten Fehlschlag eines any-failure-Schritts als finding (exit %i)',
    (code) => {
      const r = result({ step: step('typecheck', 'any-failure'), code, spawned: true });
      expect(verdict(r)).toBe('finding');
    },
  );

  it('behält A25s Konvention für unsere eigenen Skripte bei', () => {
    expect(verdict(result({ step: step('secrets'), code: 1, spawned: true }))).toBe('finding');
    expect(verdict(result({ step: step('secrets'), code: 2, spawned: true }))).toBe('infra');
  });

  it('nennt einen sauberen Lauf grün', () => {
    expect(verdict(result({ step: step('lint', 'any-failure'), code: 0, spawned: true }))).toBe(
      'green',
    );
    expect(verdict(result({ step: step('secrets'), code: 0, spawned: true }))).toBe('green');
  });
});

describe('label', () => {
  // The reader's next move after "nothing started" is to fix their machine, and
  // "exit 2" sends them to their code instead. That is the whole reason the
  // label is not just the verdict.
  it('nennt bei einem nie gestarteten Schritt die Ursache statt eines Exit-Codes', () => {
    const text = label(
      result({ step: step('typecheck', 'any-failure'), code: 2, spawned: false, reason: 'EFTYPE' }),
    );
    expect(text).toContain('nicht gestartet');
    expect(text).toContain('EFTYPE');
    expect(text).not.toContain('exit');
    expect(text).not.toContain('FINDING');
  });

  it('kommt auch ohne Ursache aus, ohne einen Exit-Code zu erfinden', () => {
    const text = label(result({ step: step('build', 'any-failure'), code: 2, spawned: false }));
    expect(text).toBe('INFRA (nicht gestartet)');
  });

  it('nennt einen echten Fehlschlag mit seinem Exit-Code', () => {
    expect(label(result({ step: step('typecheck', 'any-failure'), code: 2, spawned: true }))).toBe(
      'FINDING (exit 2)',
    );
    expect(label(result({ step: step('secrets'), code: 2, spawned: true }))).toBe('INFRA (exit 2)');
  });

  it('sagt grün auf Deutsch', () => {
    expect(label(result({ step: step('lint', 'any-failure'), code: 0, spawned: true }))).toBe(
      'grün',
    );
  });
});
