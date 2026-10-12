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

/** `<service> → [<source>, <container path>]` for every service's `volumes:` list. */
function serviceVolumes(compose: string): Map<string, [string, string][]> {
  const services = compose.split(/^services:\s*$/m)[1]?.split(/^\S/m)[0] ?? '';
  const result = new Map<string, [string, string][]>();
  for (const block of services.split(/^(?= {2}[a-z][\w-]*:\s*$)/m)) {
    const name = /^ {2}([a-z][\w-]*):/.exec(block)?.[1];
    const list = block.split(/^ {4}volumes:\s*$/m)[1]?.split(/^ {4}\S/m)[0] ?? '';
    if (!name) continue;
    const mounts = [...list.matchAll(/^ {6}- (\S+)\s*$/gm)].map((match) => {
      // `source:target[:mode]` — the source may carry a `${VAR:-default}`.
      const [, source, target] = /^(\$\{[^}]+\}[^:]*|[^:]+):([^:]+)/.exec(match[1] as string) ?? [];
      return [source as string, target as string] as [string, string];
    });
    result.set(name, mounts);
  }
  return result;
}

describe('Host-Overlay und Basis-Datei hängen geteilte Daten gleich ein', () => {
  /**
   * Compose merges `volumes:` per container path. A named volume of the base
   * file that two services share — the backup sidecar *writes* `/backups`,
   * the orchestrator *reads* `.last-result` from it — has to be re-pointed
   * for both in the overlay, or the one left out keeps the named volume and
   * the two sit on different filesystems. For `/backups` that meant the
   * daemon never saw a backup result, neither success nor failure, and took
   * the stack for a fresh one.
   */
  it('gibt allen Diensten eines geteilten Volumes denselben Host-Pfad', async () => {
    const base = serviceVolumes(await readFile(join(repoRoot, 'infra/docker-compose.yml'), 'utf8'));
    const overlay = serviceVolumes(
      await readFile(join(repoRoot, 'infra/docker-compose.override.example.yml'), 'utf8'),
    );

    // Named volume → each base-file user and what the overlay mounts there.
    const users = new Map<string, string[]>();
    for (const [service, mounts] of base) {
      for (const [volume, target] of mounts) {
        if (!/^[a-z][\w-]*$/.test(volume)) continue;
        const own = overlay.get(service)?.find(([, t]) => t === target)?.[0];
        users.set(volume, [
          ...(users.get(volume) ?? []),
          `${service} ${target} → ${own ?? volume}`,
        ]);
      }
    }

    // The parser found the case this test is about, so a green run means something.
    expect(users.get('backups')).toHaveLength(2);

    const mismatches: string[] = [];
    for (const [volume, mounts] of users) {
      const sources = new Set(mounts.map((mount) => mount.split(' → ')[1]));
      if (sources.size > 1) mismatches.push(`${volume}: ${mounts.join(', ')}`);
    }
    expect(mismatches).toEqual([]);
  });
});
