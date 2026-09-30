/**
 * The other half of `test-timeout.itest.ts`: a unit test keeps vitest's default.
 *
 * The rule the default encodes is worth keeping — a pure function that needs
 * more than five seconds is wrong, and the timeout is what says so. A setup
 * file that raised the wall clock everywhere would pass the integration-side
 * assertion and quietly retire that rule, and nothing would notice. This is the
 * assertion that notices.
 */
import { expect, it } from 'vitest';
import { isIntegrationFile } from '../../../vitest.timeouts.js';

const VITEST_DEFAULT_TEST_TIMEOUT_MS = 5_000;

it('behält für einen Unittest die Voreinstellung', ({ task }) => {
  expect(task.timeout).toBe(VITEST_DEFAULT_TEST_TIMEOUT_MS);
});

it('zählt diese Datei nicht zu den Integrationstests', () => {
  expect(isIntegrationFile('vitest.setup.ts')).toBe(false);
  expect(isIntegrationFile('packages/core/src/test-timeout.test.ts')).toBe(false);
});
