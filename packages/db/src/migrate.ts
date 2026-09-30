/**
 * Migration runner.
 *
 * Deliberately hand-rolled rather than delegating to drizzle-kit's `migrate`:
 * the foundation migration installs roles, grants and guard triggers, none of
 * which drizzle generates. Owning the runner also lets us enforce two rules
 * that matter for an unattended system:
 *
 *   - **Checksums.** An already-applied migration whose file changed is a hard
 *     error, not a shrug. Silent drift between what the database contains and
 *     what the repo claims would make every later diagnosis unreliable.
 *   - **An advisory lock.** Two orchestrator replicas starting at once must not
 *     race the schema.
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import postgres from 'postgres';

/** Arbitrary but stable key so only migration runners contend for this lock. */
const ADVISORY_LOCK_KEY = 8_420_001;

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

export interface MigrationFile {
  name: string;
  sql: string;
  checksum: string;
}

export function loadMigrations(dir: string = MIGRATIONS_DIR): MigrationFile[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(dir, name), 'utf8');
      return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
    });
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

export async function migrate(sql: postgres.Sql, dir?: string): Promise<MigrateResult> {
  const migrations = loadMigrations(dir);

  // The lock is taken *before* the bookkeeping table is created, not after.
  // `CREATE TABLE IF NOT EXISTS` is not safe against a concurrent identical
  // statement — two callers race and one gets a duplicate-key error on an
  // internal catalogue index. That is precisely the situation the lock exists
  // for (two orchestrator replicas starting together), so it has to cover the
  // very first statement.
  await sql`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`;
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS _vorschicht_migrations (
        name       text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;

    const rows = await sql<{ name: string; checksum: string }[]>`
      SELECT name, checksum FROM _vorschicht_migrations
    `;
    const applied = new Map(rows.map((r) => [r.name, r.checksum]));

    const result: MigrateResult = { applied: [], alreadyApplied: [] };

    for (const migration of migrations) {
      const previous = applied.get(migration.name);
      if (previous !== undefined) {
        if (previous !== migration.checksum) {
          throw new Error(
            `Migration ${migration.name} wurde bereits angewendet, aber die Datei hat sich ` +
              `geändert (Prüfsumme ${previous.slice(0, 12)} → ${migration.checksum.slice(0, 12)}). ` +
              'Angewendete Migrationen sind unveränderlich — lege stattdessen eine neue an.',
          );
        }
        result.alreadyApplied.push(migration.name);
        continue;
      }

      await sql.begin(async (tx) => {
        await tx.unsafe(migration.sql);
        await tx`
          INSERT INTO _vorschicht_migrations (name, checksum)
          VALUES (${migration.name}, ${migration.checksum})
        `;
      });
      result.applied.push(migration.name);
    }

    return result;
  } finally {
    await sql`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
  }
}

/** CLI entry point: `pnpm --filter @vorschicht/db migrate`. */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL ist nicht gesetzt.');
    process.exit(2);
  }

  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const { applied, alreadyApplied } = await migrate(sql);
    for (const name of alreadyApplied) console.log(`  · ${name} (bereits angewendet)`);
    for (const name of applied) console.log(`  ✓ ${name}`);
    console.log(
      applied.length === 0
        ? '  Schema ist aktuell.'
        : `  ${applied.length} Migration(en) angewendet.`,
    );
  } catch (error) {
    console.error(`\nMigration fehlgeschlagen: ${(error as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await sql.end();
  }
}

// Only run when invoked directly, so importing this module in tests is safe.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
