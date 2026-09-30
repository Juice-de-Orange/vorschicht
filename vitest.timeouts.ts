/**
 * The wall clock an integration test gets, and how one is recognised.
 *
 * Deliberately side-effect free and deliberately *not* the file that applies
 * it. `vitest.setup.ts` imports this and calls `vi.setConfig`; the tests that
 * check the rule import only this. The split is the whole reason those tests
 * mean anything: the first version put the constants and the `vi.setConfig`
 * call in one module, so a test importing the constants executed the call
 * itself — and the assertion passed with the setup file switched off entirely.
 * Caught by switching it off and looking (§8.2, Domäne 3 und 6).
 */

/** Wall clock for one integration case. */
export const INTEGRATION_TEST_TIMEOUT_MS = 60_000;

/** Wall clock for a `beforeAll` that seeds one — a database plus a clone. */
export const INTEGRATION_HOOK_TIMEOUT_MS = 120_000;

/** True for the files that talk to Postgres, git and docker (`*.itest.ts`). */
export function isIntegrationFile(path: string): boolean {
  return path.endsWith('.itest.ts');
}
