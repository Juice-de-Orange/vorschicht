import { execFile } from 'node:child_process';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

/**
 * `pnpm db:generate` against the checked-in migrations (#35).
 *
 * The script called `drizzle-kit generate` with no config anywhere in the
 * tree, so it failed before reading the schema. It now has one, and a
 * baseline in `migrations/meta/` — the journal entry for the newest
 * hand-written migration and the snapshot of `schema.ts` at that point. Two
 * things keep it honest: the baseline names the newest file (so the next
 * generated one gets the next number), and the generator finds nothing to do
 * on this tree (so the snapshot matches the mirror).
 */

const run = promisify(execFile);
const pkg = fileURLToPath(new URL('..', import.meta.url));
const migrations = join(pkg, 'migrations');

async function newestMigration(): Promise<string> {
  const files = (await readdir(migrations)).filter((name) => name.endsWith('.sql')).sort();
  return (files.at(-1) ?? '').replace(/\.sql$/, '');
}

describe('drizzle-kit-Grundlinie (#35)', () => {
  it('hat eine Konfiguration, die in die Migrationen schreibt, wie der Läufer sie liest', async () => {
    const config = await readFile(join(pkg, 'drizzle.config.ts'), 'utf8');
    expect(config).toMatch(/dialect: 'postgresql'/);
    expect(config).toMatch(/schema: '\.\/src\/schema\.ts'/);
    expect(config).toMatch(/out: '\.\/migrations'/);
    // `src/migrate.ts` runs each file as it stands; drizzle's breakpoint
    // comments would be noise in a hand-maintained layout.
    expect(config).toMatch(/breakpoints: false/);
  });

  it('nennt im Journal die neueste Migration, damit die nächste die nächste Nummer bekommt', async () => {
    const journal = JSON.parse(await readFile(join(migrations, 'meta', '_journal.json'), 'utf8'));
    const last = journal.entries.at(-1);
    const newest = await newestMigration();
    expect(last.tag).toBe(newest);
    expect(last.idx).toBe(Number.parseInt(newest.slice(0, 4), 10));
    const snapshots = await readdir(join(migrations, 'meta'));
    expect(snapshots).toContain(`${newest.slice(0, 4)}_snapshot.json`);
  });

  it('findet auf diesem Stand keine Schemaänderung', { timeout: 120_000 }, async () => {
    // A copy, so a stale snapshot shows up as a failed test rather than as a
    // new migration file in the working tree.
    const scratch = await mkdtemp(join(tmpdir(), 'vorschicht-drizzle-'));
    try {
      await cp(migrations, join(scratch, 'migrations'), { recursive: true });
      // Relative `--out`, run from the copy: drizzle-kit 0.31 prefixes `./` to
      // the snapshot paths it reads back, which breaks an absolute one — and
      // then exits 0 with the error on stderr.
      const { stdout } = await run(
        join(pkg, 'node_modules', '.bin', 'drizzle-kit'),
        [
          'generate',
          '--dialect=postgresql',
          `--schema=${join(pkg, 'src', 'schema.ts')}`,
          '--out=migrations',
          '--breakpoints=false',
        ],
        { cwd: scratch, env: { ...process.env, NO_COLOR: '1' } },
      );
      expect(stdout).toContain('No schema changes');
      expect(
        (await readdir(join(scratch, 'migrations'))).filter((f) => f.endsWith('.sql')),
      ).toEqual((await readdir(migrations)).filter((f) => f.endsWith('.sql')));
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
