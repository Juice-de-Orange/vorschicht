/**
 * A private database per test file.
 *
 * Some of this system's state is global by design — there is one budget, so
 * there is one guardian, and `guardian_events` is append-only precisely so that
 * history cannot be rewritten. Both properties are correct and both make two
 * test files sharing a database interfere: vitest runs files in parallel, and
 * one file's 96%-sample becomes another file's freshest reading.
 *
 * Rather than weakening either property for the tests' convenience, each file
 * gets its own database. That is cheap (a `CREATE DATABASE` against an already
 * running container) and it removes a whole class of order-dependent flakiness
 * without pretending the production state is less global than it is.
 */
import postgres from 'postgres';
import { migrate } from './migrate.js';

/** Arbitrary but stable; only test-database creation contends for it. */
const CLUSTER_MIGRATION_LOCK = 8_420_002;

export interface TestDatabase {
  url: string;
  drop(): Promise<void>;
}

/**
 * Create and migrate a fresh database derived from `TEST_DATABASE_URL`.
 *
 * @param label short identifier, used in the database name so a leftover from a
 *              crashed run is recognisable rather than anonymous.
 */
export async function createTestDatabase(label: string): Promise<TestDatabase> {
  const adminUrl = process.env.TEST_DATABASE_URL;
  if (!adminUrl)
    throw new Error('TEST_DATABASE_URL fehlt — infra/scripts/with-test-db.sh benutzen.');

  const safe = label
    .replace(/[^a-z0-9]/gi, '_')
    .toLowerCase()
    .slice(0, 24);
  const name = `vs_test_${safe}_${process.pid}_${Math.abs(hash(label))}`;

  const url = replaceDatabase(adminUrl, name);
  const admin = postgres(adminUrl, { max: 1, onnotice: () => {} });
  try {
    // Serialised across the whole cluster, and held across the migration.
    //
    // The foundation migration creates the `vorschicht_app` role, and roles are
    // **cluster-wide** while `pg_advisory_lock` is database-scoped — so the
    // lock the migration runner takes cannot protect it. Two databases being
    // migrated in parallel race on the role and one loses with a duplicate-key
    // error on pg_authid. Holding a lock on the shared admin database is the
    // only scope that covers a cluster-wide object.
    //
    // The same latent race exists in production if two Vorschicht instances
    // ever migrate against one cluster; today each stack has its own.
    await admin`SELECT pg_advisory_lock(${CLUSTER_MIGRATION_LOCK})`;
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name}`);
    await admin.unsafe(`CREATE DATABASE ${name}`);

    const sql = postgres(url, { max: 1, onnotice: () => {} });
    try {
      await migrate(sql);
    } finally {
      await sql.end();
    }
  } finally {
    await admin`SELECT pg_advisory_unlock(${CLUSTER_MIGRATION_LOCK})`.catch(() => {});
    await admin.end();
  }

  return {
    url,
    async drop() {
      const cleanup = postgres(adminUrl, { max: 1, onnotice: () => {} });
      try {
        // Terminate stragglers first: a pooled connection that outlived its
        // test would otherwise block the drop and leave the database behind.
        await cleanup.unsafe(
          `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '${name}'`,
        );
        await cleanup.unsafe(`DROP DATABASE IF EXISTS ${name}`);
      } finally {
        await cleanup.end();
      }
    },
  };
}

function replaceDatabase(url: string, database: string): string {
  const parsed = new URL(url);
  parsed.pathname = `/${database}`;
  return parsed.toString();
}

/** Small stable hash so parallel workers with the same label do not collide. */
function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) | 0;
  }
  return result;
}
