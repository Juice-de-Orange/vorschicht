/**
 * Per-file test configuration — one rule, and it is about wall clock only.
 *
 * Vitest's 5-second default is a good rule for a unit test: a pure function
 * that takes longer than that is wrong, and the timeout says so. It is a poor
 * rule for an `*.itest.ts`, where a single case creates a database, clones a
 * git repository, runs a real `node --test` and sometimes starts a container.
 * Those tests take seconds *by construction*, and how many depends on how
 * loaded the machine is — so the default turns "this machine is busy" into a
 * red gate, which in an unattended loop (§0) costs an iteration's budget on a
 * failure that says nothing about the code.
 *
 * Observed rather than assumed: the A25 case in `merge-queue.itest.ts` passes
 * in ~4.3 s alone and exceeded 5 s the first time it ran alongside two other
 * files. the original build log carried an older, unexplained instance of the same
 * shape — `gate:test-integration` red once and green on an immediate re-run
 * with nothing changed in between. This is a **plausible** cause of that one,
 * not a proven one; nobody kept the log. What is proven is the mechanism, by
 * `packages/core/src/test-timeout.itest.ts` and its unit-side counterpart.
 *
 * Deliberately not a global raise: the 5-second rule keeps its teeth where it
 * earns them, and an integration test that hangs still fails — a minute later,
 * which is the right trade for a suite that runs unattended.
 *
 * The constants live in `vitest.timeouts.ts` so that a test can read them
 * without executing the `vi.setConfig` below; see the note there.
 */
import { expect, vi } from 'vitest';
import {
  INTEGRATION_HOOK_TIMEOUT_MS,
  INTEGRATION_TEST_TIMEOUT_MS,
  isIntegrationFile,
} from './vitest.timeouts.js';

if (isIntegrationFile(expect.getState().testPath ?? '')) {
  vi.setConfig({
    testTimeout: INTEGRATION_TEST_TIMEOUT_MS,
    hookTimeout: INTEGRATION_HOOK_TIMEOUT_MS,
  });
}
