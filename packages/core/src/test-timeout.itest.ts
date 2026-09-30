/**
 * The integration-test wall clock is really raised (`vitest.setup.ts`).
 *
 * A setup file that silently fails to apply looks exactly like one that
 * applies — the suite stays green either way, and the only symptom is a red
 * gate weeks later on a busy machine. That is §8.2's sixth domain: wiring that
 * reads as covered and cannot carry a signal. So the effective timeout is read
 * off the running task rather than trusted.
 *
 * Asserted from *both* sides, in two files: 60 s here, 5 s in
 * `test-timeout.test.ts`. One side alone would pass just as happily against a
 * setup file that raised the timeout for everything, which would quietly cost
 * the unit suite the rule that makes its default worth having.
 *
 * No `describe.skipIf(!TEST_DATABASE_URL)` here, unlike every other `*.itest.ts`
 * in this repository: this one asserts a property of the *harness*, needs no
 * database, and would otherwise skip in precisely the runs that do not set one.
 */
import { expect, it } from 'vitest';
import { INTEGRATION_TEST_TIMEOUT_MS, isIntegrationFile } from '../../../vitest.timeouts.js';

it('gibt einem Integrationstest die längere Zeitgrenze', ({ task }) => {
  expect(task.timeout).toBe(INTEGRATION_TEST_TIMEOUT_MS);
});

it('erkennt die eigene Datei als Integrationstest', () => {
  expect(isIntegrationFile('packages/core/src/merge-queue.itest.ts')).toBe(true);
  expect(isIntegrationFile('packages/core/src/merge-queue.test.ts')).toBe(false);
});

it('lässt eine ausdrückliche Zeitgrenze am Test gewinnen', ({ task }) => {
  expect(task.timeout).toBe(90_000);
}, 90_000);
