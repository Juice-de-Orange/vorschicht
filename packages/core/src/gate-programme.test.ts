import { existsSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SELF_GATE_COMMANDS } from './onboarding/self.js';
import { missingProgramme, ORCHESTRATOR_PROGRAMMES } from './onboarding/verify.js';

/**
 * Every programme a stored gate configuration names must exist in the image
 * that runs it.
 *
 * `verifyCommand` (onboarding/verify.ts) asks whether a gate command names a
 * script the project *declares*. That is one half of the question. The other
 * half is whether the programme in front of the script exists in the container
 * where `GateSuite` will spawn it — and nothing asked it, so the studio shipped
 * for weeks with all four of its own gate commands starting with a `pnpm` the
 * runtime image did not have.
 *
 * What that cost is measured and specific, and it is why this file is not
 * merely tidy. Against the real image, with gate-suite's own `run()` semantics:
 * three commands fail to spawn (ENOENT → `infra`, A25) and the fourth starts —
 * `with-test-db.sh` is bash — and exits 2, which A50 makes a **finding**.
 * `merge-queue.ts` takes the infra branch only when there are no findings, so
 * the single finding outvotes the three infra results and the candidate goes
 * **red** on its first attempt, with a learnings note naming a machine fault.
 * A25's "nothing ran is not a finding" is switched off exactly there.
 *
 * A104 is the same class one tool over (gitleaks, absent from the same image,
 * same verdict: no merge could ever have completed). Its answer was to put the
 * tool in the image; this file is the guard that was missing alongside it.
 *
 * Deliberately a **static** check rather than `docker run`: `gate:test` is
 * docker-free by design (A61 keeps that separation to prove the unit tests need
 * no database), so this reads the Dockerfile — the same bargain
 * `gitleaks-pin.test.ts` and `gate-image-pins.test.ts` already make for their
 * pins. The measured inventory below is what a container answers today; the
 * drift guard is that the Dockerfile is re-read on every run.
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const orchestratorDockerfile = join(repoRoot, 'infra', 'docker', 'Dockerfile.orchestrator');

/**
 * What `node:22-bookworm-slim` brings before a single `RUN` line.
 *
 * Measured, not assumed:
 *   docker run --rm --entrypoint sh node:22-bookworm-slim -c 'command -v …'
 */
const BASE_IMAGE_PROGRAMMES = ['node', 'npm', 'npx', 'corepack', 'sh', 'bash'] as const;

/** A `RUN` line that installs a named programme rather than an apt package. */
const EXPLICIT_INSTALLS: ReadonlyArray<{ readonly programme: string; readonly evidence: RegExp }> =
  [
    { programme: 'gitleaks', evidence: /chmod 0755 \/usr\/local\/bin\/gitleaks/ },
    { programme: 'claude', evidence: /claude\.ai\/install\.sh/ },
    // The one this file exists for. `corepack enable` in the *build* stage does
    // nothing for the runtime, which is precisely how it went missing — and
    // corepack in the runtime is not enough either: `--activate` writes into the
    // building user's cache, so uid 10001 fell back to a different pnpm and
    // downloaded it (measured: 11.25.0 against a pin of 11.1.2). The evidence is
    // therefore a real installation, not an activation.
    { programme: 'pnpm', evidence: /npm install -g "pnpm@\$\{PNPM_VERSION\}"/ },
  ];

/** The `apt-get install` list of the runtime stage, which is the part that moves. */
function aptPackages(dockerfile: string): string[] {
  const runtime = runtimeStage(dockerfile);
  const match = /apt-get install -y --no-install-recommends\s*\\\s*\n\s*([^\n]+)/.exec(runtime);
  const liste = match?.[1];
  if (liste === undefined) return [];
  return liste
    .replace(/\\$/, '')
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/**
 * Programmes available to a gate command inside the orchestrator container.
 *
 * Every piece of evidence is read from the **runtime stage only**, and that is
 * the whole correctness of this file rather than a detail. Written against the
 * full text first, the pnpm rule matched `corepack prepare` in the *build*
 * stage — so removing pnpm from the runtime left the load-bearing case green.
 * The mistake this file exists to catch, made inside the file itself.
 */
function orchestratorProgrammes(dockerfile: string): Set<string> {
  const runtime = runtimeStage(dockerfile);
  const available = new Set<string>(BASE_IMAGE_PROGRAMMES);
  for (const pkg of aptPackages(dockerfile)) available.add(pkg);
  for (const { programme, evidence } of EXPLICIT_INSTALLS) {
    if (evidence.test(runtime)) available.add(programme);
  }
  return available;
}

/** Everything after `FROM … AS runtime` — what the deployed container is. */
function runtimeStage(dockerfile: string): string {
  const at = dockerfile.indexOf('AS runtime');
  return at === -1 ? '' : dockerfile.slice(at);
}

/**
 * The first token of a gate command — what `execFile` will try to spawn.
 *
 * `parseGateCommand` splits on whitespace and refuses metacharacters (A55.3),
 * so the first token is the whole question. A token containing a slash is a
 * path into the repository rather than a programme on PATH.
 */
function programmeOf(command: string): string {
  return command.trim().split(/\s+/)[0] ?? '';
}

describe('Gate-Befehle gegen das Orchestrator-Image (A104s Klasse)', () => {
  it('kennt die Programme, die das Laufzeit-Image mitbringt', async () => {
    const dockerfile = await readFile(orchestratorDockerfile, 'utf8');
    const available = orchestratorProgrammes(dockerfile);

    // Guard the guard: if the apt line is ever reformatted past this parser, the
    // set collapses to the base image and every assertion below would pass by
    // asserting nothing about what the Dockerfile installs.
    expect(aptPackages(dockerfile)).toContain('git');
    expect(available.has('gitleaks')).toBe(true);
    expect(available.has('claude')).toBe(true);
  });

  it('hat pnpm im Laufzeit-Image, nicht nur in der Bau-Stufe', async () => {
    const dockerfile = await readFile(orchestratorDockerfile, 'utf8');
    const runtime = runtimeStage(dockerfile);

    // The narrow assertion, and the one a mutation must kill: the *runtime*
    // stage installs pnpm. `corepack enable` in the build stage satisfies a
    // whole-file search and is exactly the state this file was written for.
    expect(runtime).toMatch(/npm install -g "pnpm@\$\{PNPM_VERSION\}"/);
    expect(orchestratorProgrammes(dockerfile).has('pnpm')).toBe(true);
    // And it is asserted for the user that will spawn the gate commands, not
    // only for root — the distinction that made the first attempt ship a pnpm
    // nobody pinned.
    const nachUserWechsel = runtime.slice(runtime.indexOf('USER 10001:10001'));
    expect(nachUserWechsel).toMatch(/pnpm-Pin verletzt fuer uid 10001/);
  });

  it('fährt in beiden Stufen dieselbe pnpm-Version', async () => {
    const dockerfile = await readFile(orchestratorDockerfile, 'utf8');
    const pinned = /^ARG PNPM_VERSION=(\S+)$/m.exec(dockerfile)?.[1];
    expect(pinned).toMatch(/^\d+\.\d+\.\d+$/);
    // Two literals would be one edit away from two pnpm versions deciding the
    // same gates on the same host (A104.6). There is one declaration; the build
    // stage prepares it through corepack, the runtime installs it through npm,
    // and both reference the same ARG.
    expect(dockerfile).toMatch(/corepack prepare pnpm@\$\{PNPM_VERSION\}/);
    expect(dockerfile).toMatch(/npm install -g "pnpm@\$\{PNPM_VERSION\}"/);
    expect(dockerfile).not.toMatch(/pnpm@\d+\.\d+\.\d+/);
  });

  it('hält die Programmliste des Onboardings gegen das Dockerfile', async () => {
    const dockerfile = await readFile(orchestratorDockerfile, 'utf8');
    const ausDatei = orchestratorProgrammes(dockerfile);

    // `ORCHESTRATOR_PROGRAMMES` is what `verifyProposal` warns against; this
    // file derives the same set from the runtime stage. Two sources compared,
    // the bargain `gitleaks-pin.test.ts` makes — a list that drifts from the
    // image would warn about a programme that is there, or stay silent about
    // one that is not, and the second is the direction that ships.
    expect([...ORCHESTRATOR_PROGRAMMES].sort()).toEqual([...ausDatei].sort());
  });

  it('warnt vor einem Programm, das es im Image nicht gibt — und nur davor', () => {
    // The case this exists for: a stack whose gate command cannot spawn here.
    expect(missingProgramme('cargo test --all')).toBe('cargo');
    expect(missingProgramme('python3 -m pytest')).toBe('python3');
    // And the three that must stay silent, because a false warning is the
    // expensive direction (A72/A80): a programme that is there, a path into the
    // repository, and an empty command.
    expect(missingProgramme('pnpm run gate:lint')).toBeNull();
    expect(missingProgramme('infra/scripts/with-test-db.sh pnpm exec vitest run')).toBeNull();
    expect(missingProgramme('   ')).toBeNull();
  });

  it('nennt in Vorschichts eigener Gate-Konfiguration nur Programme, die es dort gibt', async () => {
    const dockerfile = await readFile(orchestratorDockerfile, 'utf8');
    const available = orchestratorProgrammes(dockerfile);

    const commands = Object.entries(SELF_GATE_COMMANDS);
    // Asserting over an empty set would read as covered (§8.2, domain 6).
    expect(commands.length).toBeGreaterThanOrEqual(4);

    for (const [gate, command] of commands) {
      const programme = programmeOf(command);
      if (programme.includes('/')) {
        // A path into the repository: it has to exist and be executable, or the
        // gate reports a machine fault for a file nobody moved.
        const target = join(repoRoot, programme);
        expect(existsSync(target), `${gate}: ${programme} fehlt im Repository`).toBe(true);
        expect(
          statSync(target).mode & 0o111,
          `${gate}: ${programme} ist nicht ausführbar`,
        ).toBeGreaterThan(0);
        continue;
      }
      expect(
        available.has(programme),
        `${gate}: „${programme}" liegt nicht im Orchestrator-Image — der Gate-Lauf ` +
          'kann dort nicht starten (A25/A50: das wird ein Befund, kein Infrastrukturfehler)',
      ).toBe(true);
    }
  });
});
