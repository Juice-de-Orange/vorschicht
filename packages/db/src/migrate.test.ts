import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The migration runner as a command, started the way an image starts it.
 *
 * In the orchestrator image pnpm links the workspace package into
 * `node_modules`, so `node /app/node_modules/@vorschicht/db/dist/migrate.js`
 * names a symlink. Node resolves the symlink for `import.meta.url` but leaves
 * `argv[1]` as typed; the entry-point check compared the two literally, found
 * them different and ran nothing — exit 0, no output, no migration.
 *
 * Without `DATABASE_URL` the command must refuse with exit 2 before touching a
 * database, which makes "did `main()` run at all" observable here.
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const entry = fileURLToPath(new URL('./migrate.ts', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'vorschicht-migrate-'));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

function runMigrate(path: string) {
  const { DATABASE_URL: _unset, ...env } = process.env;
  return spawnSync(process.execPath, ['--import', 'tsx', path], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

describe('migrate.ts als Befehl', () => {
  it('läuft, wenn er unter seinem eigenen Pfad gestartet wird', () => {
    const result = runMigrate(entry);
    expect(result.stderr).toContain('DATABASE_URL ist nicht gesetzt.');
    expect(result.status).toBe(2);
  });

  it('läuft auch über einen Symlink, wie pnpm ihn in node_modules legt', () => {
    const link = join(scratch, 'migrate.ts');
    symlinkSync(entry, link);
    const result = runMigrate(link);
    expect(result.stderr).toContain('DATABASE_URL ist nicht gesetzt.');
    expect(result.status).toBe(2);
  });
});
