import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The host overlay `infra/docker-compose.override.yml` — one path, and ignored.
 *
 * `rollout-remote.sh` refuses to deploy from a working tree that `git status
 * --porcelain` calls dirty, locally and on the host, and that refusal is right.
 * The overlay is the one file every production host *must* have and that never
 * belongs in the repository, so an unignored overlay turned the documented
 * layout into a rollout that could never start.
 *
 * The second half pins the path itself. The scripts (`watchdog.sh`,
 * `rollout-remote.sh`, `report-build.mjs`, `demo-phase0.sh`) all compose with
 * `infra/docker-compose.override.yml`; the operations guide once told the
 * operator to keep the file at the stack root instead, where none of them look.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const OVERLAY = 'infra/docker-compose.override.yml';

/** Every file that tells a person or a script where the overlay lives. */
const MENTIONS = [
  'docs/OPERATIONS.md',
  'README.md',
  'infra/docker-compose.yml',
  'infra/docker-compose.override.example.yml',
  'infra/scripts/rollout-remote.sh',
  'infra/scripts/watchdog.sh',
  'infra/scripts/report-build.mjs',
];

describe('Host-Overlay infra/docker-compose.override.yml', () => {
  it('ist von git ignoriert, damit der Rollout einen sauberen Baum sieht', () => {
    // `check-ignore` exits 0 when the path is ignored and 1 when it is not.
    const ignored = (() => {
      try {
        execFileSync('git', ['check-ignore', '-q', OVERLAY], {
          cwd: repoRoot,
          stdio: 'ignore',
        });
        return true;
      } catch {
        return false;
      }
    })();
    expect(ignored).toBe(true);
  });

  it('wird überall unter demselben Pfad genannt', async () => {
    const strays: string[] = [];
    for (const file of MENTIONS) {
      const text = await readFile(join(repoRoot, file), 'utf8');
      text.split('\n').forEach((line, index) => {
        // A mention of the overlay that is not prefixed by `infra/`.
        if (/(?<!infra\/)(?<![\w.-])docker-compose\.override\.yml/.test(line)) {
          strays.push(`${file}:${index + 1}: ${line.trim()}`);
        }
      });
    }
    expect(strays).toEqual([]);
  });
});
