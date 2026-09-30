/**
 * §22's Phase 3 exit gate: *"Every optional gate demonstrably blocks a seeded
 * violation in the sandbox project and passes after fix."*
 *
 * This file settles the six optional gates that are project commands —
 * licenses, deps-audit, sast, a11y, e2e, lighthouse. The other four are settled
 * elsewhere and deliberately not repeated here: `changelog` and `docs` in
 * `gate-suite.test.ts` over a real git repository, `migration-review` in
 * `merge-queue.itest.ts` and against the real CLI (`pnpm check:migration-review`),
 * and `legal` cannot be settled at all until Phase 6 — the registry refuses to
 * enable it, which is asserted below rather than assumed.
 *
 * Three assertions per gate, and the second and third are the ones that make
 * the first mean anything:
 *
 *  1. **The seeded tree is red on that gate.** What the exit gate asks for.
 *  2. **It is red on that gate and no other.** Six gates that share one code
 *     path in `GateSuite.command` cannot be demonstrated by six tests that
 *     differ in a string; what differs is the *check*, so the check has to be
 *     the thing that fires. A seed that also tripped `lint` would make its
 *     gate's demonstration a statement about `lint` — and this is the assertion
 *     that catches it.
 *  3. **The same tree is green once the violation is removed.** A checker that
 *     always exited 1 satisfies (1) and (2) and would fail the project on every
 *     merge afterwards. That is exactly the shape A55 found in the planted
 *     secret, from the other direction.
 *
 * The whole suite runs with all six enabled at once — not one gate per run —
 * because (2) is unaskable otherwise.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  GATE_CATALOGUE,
  type GateId,
  type ProjectGateConfig,
  resolveGates,
  validateProjectGateConfig,
} from '@vorschicht/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GateSuite, type GateSuiteResult, type SecretScanner } from './gate-suite.js';
import {
  COMMAND_GATE_SEEDS,
  createSandboxProject,
  plantSeed,
  repairSeed,
  type SandboxProject,
} from './sandbox.js';

/** Proven with the real scanner in `merge-queue.itest.ts`; not the subject here. */
const greenScanner: SecretScanner = {
  scan: async () => ({ verdict: 'green', detail: 'Keine Fundstellen.', output: '', findings: [] }),
};

/** The review gate's one query, as `gate-suite.test.ts` fakes it. */
function approvedReview(): never {
  return (async () => [{ actor: 'reviewer', payload: { rounds: 1 } }]) as never;
}

/** §11's optional gates that are a project command — read from the catalogue. */
const OPTIONAL_COMMAND_GATES = GATE_CATALOGUE.filter(
  (gate) => !gate.locked && gate.kind === 'command' && !gate.availableFrom,
).map((gate) => gate.id);

describe('die optionalen Befehls-Gates des §11 am Sandkasten', () => {
  let scratch: string;
  let sandbox: SandboxProject;
  let seq = 0;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'vs-sandbox-gates-'));
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  /**
   * Every gate the fixture can run, ticked on at once.
   *
   * `migration-review` stays off: it is an agent session (A63), it is settled
   * in `merge-queue.itest.ts`, and a suite built without a reviewer reports it
   * as an infra failure — which would drown the one signal this file is after.
   */
  function configOf(project: SandboxProject): ProjectGateConfig {
    const gates: ProjectGateConfig['gates'] = {};
    for (const id of OPTIONAL_COMMAND_GATES) gates[id] = true;
    return {
      gates,
      commands: {
        test: project.commands.test,
        lint: project.commands.lint,
        build: project.commands.build,
        typecheck: project.commands.typecheck,
        licenses: project.commands.licenses,
        'deps-audit': project.commands['deps-audit'],
        sast: project.commands.sast,
        a11y: project.commands.a11y,
        e2e: project.commands.e2e,
        lighthouse: project.commands.lighthouse,
      },
      tools: project.tools,
      migrationPaths: [],
    };
  }

  async function freshSandbox(): Promise<SandboxProject> {
    seq += 1;
    return createSandboxProject({ path: join(scratch, `repo-${seq}`) });
  }

  async function runSuite(project: SandboxProject): Promise<GateSuiteResult> {
    return new GateSuite({
      sql: approvedReview(),
      config: configOf(project),
      secrets: greenScanner,
      timeoutMs: 120_000,
      sleep: async () => undefined,
    }).run({ cwd: project.path, taskId: 'egal' });
  }

  const redIds = (result: GateSuiteResult): GateId[] =>
    result.findings.map((step) => step.id).sort();

  /** An infra failure is not a pass — it means nothing was checked (A25). */
  function expectNothingBroken(result: GateSuiteResult): void {
    expect(result.infra.map((step) => `${step.id}: ${step.detail}`)).toEqual([]);
  }

  beforeAll(async () => {
    sandbox = await freshSandbox();
  }, 120_000);

  it('deckt genau die optionalen Befehls-Gates des Katalogs mit einer Saat ab', () => {
    // The drift guard. A seventh optional command gate in §11's catalogue
    // without a fixture seed silently shrinks what the Phase 3 exit gate covers;
    // here it is a failing test instead.
    expect(Object.keys(COMMAND_GATE_SEEDS).sort()).toEqual([...OPTIONAL_COMMAND_GATES].sort());
  });

  it('ist auf dem ungesäten Baum vollständig grün', async () => {
    const result = await runSuite(sandbox);
    expectNothingBroken(result);
    expect(redIds(result)).toEqual([]);
    // And every enabled gate really ran — a resolved set that quietly lost a
    // gate would also be "green".
    expect(result.steps.map((step) => step.id)).toEqual(
      resolveGates(configOf(sandbox)).map((gate) => gate.id),
    );
  }, 120_000);

  /**
   * One case per gate: red on its own seed, red on nothing else, green after
   * the fix. Table-driven off the same map the drift guard checks, so a gate
   * cannot be demonstrated by a test that quietly stopped referring to it.
   */
  for (const [gate, seed] of Object.entries(COMMAND_GATE_SEEDS) as Array<
    [GateId, (typeof COMMAND_GATE_SEEDS)[keyof typeof COMMAND_GATE_SEEDS]]
  >) {
    it(`„${gate}" blockiert die Saat „${seed}" — und nur dieses Gate`, async () => {
      const project = await freshSandbox();
      try {
        // The tree is green before the seed, so the red below is the seed's
        // doing and not the fixture's.
        expect(redIds(await runSuite(project))).toEqual([]);

        await plantSeed(project.path, seed);
        const seeded = await runSuite(project);
        expectNothingBroken(seeded);
        expect(redIds(seeded)).toEqual([gate]);

        // The checker looked at the tree rather than exiting 1: its output
        // names the artefact it objected to.
        const step = seeded.findings[0];
        expect(step?.exitCode).toBe(1);
        expect(step?.output.length).toBeGreaterThan(0);

        await repairSeed(project.path, seed);
        const fixed = await runSuite(project);
        expectNothingBroken(fixed);
        expect(redIds(fixed)).toEqual([]);
      } finally {
        await project.cleanup();
      }
    }, 180_000);
  }

  /**
   * The tenth optional gate — and the entry that documents its own expiry.
   *
   * **Revidiert nach des Betreibers Entscheidung vom 18.8.2026 (Karte #14, A149).** Hier
   * stand bis dahin A66s Schlussabsatz im Präsens: „§22 builds Lena in Phase 6,
   * so there is **no configuration today** in which that gate runs". Das galt,
   * als es geschrieben wurde, und seit A115 nicht mehr — Lena ist gebaut,
   * `availableFrom` steht für `legal` auf `null`, und der **Testkörper direkt
   * darunter sichert das Gegenteil zu**. Ein Kommentar, der dem Test unter ihm
   * widerspricht, ist die vierte Domäne von §8.2 in ihrer unangenehmsten Form:
   * er liest sich wie die Begründung des Falls, den er beschreibt.
   *
   * Was von A66 bleibt, ist die *Regel* und nicht ihr damaliger Anlass: ein
   * Gate, das angehakt werden kann und nicht läuft, liest sich wie abgedeckt.
   * Der Umkehrbeweis dafür ist aufgebraucht; der echte Nachweis steht in
   * `legal-review.itest.ts`, und die Wache `availableFrom` wird seit A115 in
   * `gates.test.ts` gegen eine synthetische Definition geprüft — weil eine
   * Wache, die nur so lange getestet ist, wie sie zufällig gebraucht wird, beim
   * nächsten Mal keine ist.
   */
  it('lässt das Rechts-Gate jetzt anhaken — A66s Umkehrbeweis ist aufgebraucht', () => {
    // Bis A115 war `legal` das eine Gate, das der Katalog **verweigerte**, und
    // A66 hat daraus den einzigen ehrlichen Nachweis gemacht, den es vor Lena
    // geben konnte: ein Gate, das nicht angehakt werden kann, kann nicht
    // versäumen zu blockieren. Lena existiert, also ist dieser Beleg
    // verbraucht — und der echte steht in `legal-review.itest.ts`: eine
    // Prüfung auf einer L2-Quelle blockiert (und färbt **kein** anderes Gate),
    // und derselbe Baum wird grün, sobald die starke Quelle dazukommt.
    //
    // Der Mechanismus dahinter — `availableFrom` — ist damit von keinem
    // Katalogeintrag mehr belegt und wird in `gates.test.ts` gegen eine
    // synthetische Definition geprüft. Eine Wache, die nur so lange getestet
    // ist, wie sie zufällig gebraucht wird, ist beim nächsten Mal keine.
    const attempt = validateProjectGateConfig({
      gates: { legal: true },
      commands: {},
      tools: [],
      migrationPaths: [],
    });
    expect(attempt.ok, attempt.errors.join('\n')).toBe(true);
    expect(resolveGates(attempt.config as ProjectGateConfig).map((gate) => gate.id)).toContain(
      'legal',
    );
  });
});
