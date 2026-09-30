import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `Dockerfile.gate`'s pins, against the sources they were copied from.
 *
 * The gate image is the orchestrator image's sibling (A117), and the whole
 * point of that is that the gate decides with the same tools the studio uses.
 * Three of its versions are literals in a Dockerfile, which cannot import
 * anything — so they are written twice and the build fails on drift, the bargain
 * `gitleaks-pin.test.ts` already makes for the fourth.
 *
 * What drift costs here is specific rather than tidy:
 *
 *   * a different **CLI** version means `gate:cli-contract` asserts A32's run
 *     caps against a release the orchestrator does not run, so the gate could
 *     stay green through exactly the removal it exists to catch;
 *   * a different **playwright deps** version installs the shared libraries of
 *     another release, which surfaces as one missing `.so` at the first browser
 *     launch — months later, and nowhere near this file.
 *
 * gitleaks is deliberately *not* re-asserted here: `gitleaks-pin.test.ts` owns
 * that comparison across all four places, and a second opinion in a second file
 * is one more thing that can disagree.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const gateDockerfile = join(repoRoot, 'infra', 'docker', 'Dockerfile.gate');
const orchestratorDockerfile = join(repoRoot, 'infra', 'docker', 'Dockerfile.orchestrator');
const lockfile = join(repoRoot, 'pnpm-lock.yaml');

/** `ARG NAME=value`, the way every pin in these files is declared. */
function dockerArg(dockerfile: string, name: string): string | null {
  const match = new RegExp(`^ARG\\s+${name}=(\\S+)\\s*$`, 'm').exec(dockerfile);
  return match?.[1] ?? null;
}

describe('Dockerfile.gate — die Pins gegen ihre Quellen (A117)', () => {
  it('fährt dieselbe Claude-CLI wie der Orchestrator (A27)', async () => {
    const [gate, orchestrator] = await Promise.all([
      readFile(gateDockerfile, 'utf8'),
      readFile(orchestratorDockerfile, 'utf8'),
    ]);
    const pinned = dockerArg(orchestrator, 'CLAUDE_CLI_VERSION');
    // Guard the guard: a renamed ARG upstream would otherwise make this case
    // compare null against null and pass while asserting nothing.
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dockerArg(gate, 'CLAUDE_CLI_VERSION')).toBe(pinned);
  });

  it('installiert die Systembibliotheken der Playwright-Version aus dem Lockfile', async () => {
    const [gate, lock] = await Promise.all([
      readFile(gateDockerfile, 'utf8'),
      readFile(lockfile, 'utf8'),
    ]);
    // The lockfile's resolved `playwright@<version>` entry, not the range in
    // `package.json`: `^1.57.1` currently resolves to 1.62.1, and installing the
    // deps of 1.57 would be both wrong and plausible-looking.
    const resolved = /^ {2}playwright@(\d+\.\d+\.\d+):/m.exec(lock)?.[1];
    expect(resolved).toMatch(/^\d+\.\d+\.\d+$/);
    expect(dockerArg(gate, 'PLAYWRIGHT_DEPS_VERSION')).toBe(resolved);
  });

  it('nimmt den Browser selbst nicht aus einem Pin, sondern aus dem Projekt', async () => {
    // The binary is installed at run time by the project's own playwright
    // (`in-container.sh`), so it cannot drift from the lockfile by construction.
    // This asserts the *absence* of the second pin, because adding one would
    // look like an improvement and quietly reintroduce the drift.
    const [gate, runner] = await Promise.all([
      readFile(gateDockerfile, 'utf8'),
      readFile(join(repoRoot, 'infra', 'scripts', 'in-container.sh'), 'utf8'),
    ]);
    expect(gate).not.toMatch(/playwright install(?!-deps)/);
    expect(runner).toContain('pnpm exec playwright install chromium');
  });
});
