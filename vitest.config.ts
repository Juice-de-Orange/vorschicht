import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/src/**/*.test.ts',
      'apps/*/src/**/*.test.ts',
      // Integration tests. They skip themselves unless TEST_DATABASE_URL is
      // set, so a bare checkout still passes; `infra/scripts/with-test-db.sh`
      // is what makes them run for real.
      'packages/*/src/**/*.itest.ts',
      'apps/*/src/**/*.itest.ts',
      // The gate runner's own decision logic. `tsconfig.test.json` has matched
      // this glob since A61 while vitest did not, so a test written here would
      // typecheck and never execute — the mildest form of the shape §8.2's
      // sixth domain hunts, and it sat in the instrument that decides whether
      // every other test counts.
      'infra/scripts/**/*.test.ts',
      // Und die Integrationstests daneben. Dieselbe Lücke wie eine Zeile höher,
      // eine Endung weiter: `check-kennzahlen.itest.ts` braucht eine echte
      // Datenbank, hätte typgeprüft und wäre nie gelaufen — und es ist
      // ausgerechnet das Skript, das §16s Zahlen gegenrechnet.
      'infra/scripts/**/*.itest.ts',
    ],
    environment: 'node',
    // Raises the wall clock for `*.itest.ts` only, and explains why there.
    setupFiles: ['vitest.setup.ts'],
    passWithNoTests: false,
    coverage: {
      provider: 'v8',
      reportsDirectory: 'coverage',
      include: ['packages/*/src/**/*.ts', 'apps/*/src/**/*.ts'],
      exclude: ['**/*.test.ts', '**/dist/**'],
    },
  },
});
