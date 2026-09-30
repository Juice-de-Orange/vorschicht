/**
 * One gitleaks decides baseline gate 4 — asserted, not intended.
 *
 * §11 locks "secrets scan clean" and this repository now reaches that tool four
 * ways: a pinned binary in the orchestrator image, the same binary in the gate
 * image, a pinned image in `AutoSecretScanner`, and `gate:secrets`, which since
 * A117 prefers a local binary when it *is* the pin and falls back to the image
 * otherwise. Four literals in four files, in three languages, and none of them
 * can import the others — a
 * Dockerfile cannot read TypeScript and `gate-secrets.mjs` runs before anything
 * is built. The repository has settled that shape before (`TASK_TRANSITIONS`
 * against `task_transitions`, A43.1; the checked-in result contracts against
 * zod, A47): write it twice and fail the build on drift, because a guard that
 * exists only in one language is not a guard.
 *
 * What drift would cost is specific rather than tidy: two gitleaks versions
 * deciding one locked gate means a candidate that blocks in `pnpm gate` and
 * merges in the studio, or the reverse, with nothing in either trace naming the
 * reason. The gate would still read green.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  GITLEAKS_IMAGE,
  GITLEAKS_LINUX_X64_SHA256,
  GITLEAKS_VERSION,
  normaliseGitleaksVersion,
} from './secret-scan.js';

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const dockerfilePath = join(repoRoot, 'infra', 'docker', 'Dockerfile.orchestrator');
const gateScriptPath = join(repoRoot, 'infra', 'scripts', 'gate-secrets.mjs');
const gateDockerfilePath = join(repoRoot, 'infra', 'docker', 'Dockerfile.gate');

/** `ARG NAME=value`, the way the two pins are declared. */
function dockerArg(dockerfile: string, name: string): string | null {
  const match = new RegExp(`^ARG\\s+${name}=(\\S+)\\s*$`, 'm').exec(dockerfile);
  return match?.[1] ?? null;
}

describe('gitleaks-Pin — dieselbe Version an allen vier Stellen (§11.4, A27, A34)', () => {
  it('das Orchestrator-Image installiert genau die gepinnte Version', async () => {
    const dockerfile = await readFile(dockerfilePath, 'utf8');
    expect(dockerArg(dockerfile, 'GITLEAKS_VERSION')).toBe(GITLEAKS_VERSION);
  });

  it('und prüft dabei genau die Prüfsumme, die hier steht', async () => {
    // The hash is the whole of the supply-chain claim; a Dockerfile that
    // installed the pinned version from an unverified download would satisfy
    // the case above and none of the reasoning behind it.
    const dockerfile = await readFile(dockerfilePath, 'utf8');
    expect(dockerArg(dockerfile, 'GITLEAKS_SHA256')).toBe(GITLEAKS_LINUX_X64_SHA256);
  });

  it('`pnpm gate:secrets` benutzt dasselbe gepinnte Image wie der Scanner', async () => {
    // The divergence this closes is real and was live until now: the script
    // said `:latest`, so `pnpm gate` and the deployed studio could differ by a
    // gitleaks release without anyone touching either file.
    const script = await readFile(gateScriptPath, 'utf8');
    expect(script).toContain(GITLEAKS_IMAGE);
    expect(script).not.toContain('gitleaks:latest');
  });

  it('das Image ist per Digest festgenagelt und trägt dieselbe Version im Tag', () => {
    // A tag alone is a moving pointer (A34). The tag is still asserted, because
    // a digest nobody can read is a pin nobody can review.
    expect(GITLEAKS_IMAGE).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(GITLEAKS_IMAGE).toContain(`:v${GITLEAKS_VERSION}@`);
  });

  it('erkennt beide Schreibweisen derselben Version als dieselbe', () => {
    // Measured, and the reason a comparison here cannot be a plain string
    // equality: the release tarball's binary answers `8.30.1`, the same version
    // out of the container image answers `v8.30.1`.
    expect(normaliseGitleaksVersion('v8.30.1')).toBe('8.30.1');
    expect(normaliseGitleaksVersion(' 8.30.1\n')).toBe('8.30.1');
    // And the loosening that would have made the assertion blunt instead of
    // wrong: a substring match accepts a version that is not this one.
    expect(normaliseGitleaksVersion('8.30.10')).not.toBe(GITLEAKS_VERSION);
  });

  it('das Gate-Image installiert genau dieselbe Version und Pruefsumme', async () => {
    // The fourth place, and the one that decides this gate on a machine that
    // cannot run the suite natively at all (A117). A gate image scanning with a
    // different gitleaks than the orchestrator would answer a different question
    // than the studio does — quietly, and in the direction nobody checks.
    const dockerfile = await readFile(gateDockerfilePath, 'utf8');
    expect(dockerArg(dockerfile, 'GITLEAKS_VERSION')).toBe(GITLEAKS_VERSION);
    expect(dockerArg(dockerfile, 'GITLEAKS_SHA256')).toBe(GITLEAKS_LINUX_X64_SHA256);
  });

  it('und der Gate-Schritt vergleicht ein lokales Binaer gegen dieselbe Version', async () => {
    // The script cannot import this constant — it runs before anything is built
    // — so it carries its own literal, and drift is caught here rather than by a
    // scan that silently used a different tool.
    const script = await readFile(gateScriptPath, 'utf8');
    const declared = /const GITLEAKS_VERSION = '([^']+)';/.exec(script)?.[1];
    expect(declared).toBe(GITLEAKS_VERSION);
  });
});
