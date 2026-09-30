/**
 * The parts of §11's suite that need no database.
 *
 * How the suite behaves against a real project is in `merge-queue.itest.ts`,
 * where a real `npm test` goes red on a real seeded defect. What is here is
 * three places a gate can be wrong *before* it proves anything: how a command
 * string becomes an argv, how a failure is classified (A25/A50), and which
 * gates the registry resolves to in the first place.
 *
 * The diff-based gates get a real git repository rather than a stub, because
 * what they are is a question put to git — a fake answer would test the
 * question's formatting and nothing else.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  BASELINE_GATE_IDS,
  GATE_SHELL_METACHARACTERS,
  type MigrationReviewResult,
  type ProjectGateConfig,
} from '@vorschicht/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertInternalRunnersComplete,
  GateCommandError,
  type GateRetryPolicy,
  GateSuite,
  type GateSuiteResult,
  gateFailureSummary,
  judgeMigrationReview,
  parseGateCommand,
  type SecretScanner,
  SHELL_METACHARACTERS,
} from './gate-suite.js';
import type {
  MigrationReviewer,
  MigrationReviewInput,
  MigrationReviewReport,
} from './migration-review.js';

const execFileAsync = promisify(execFile);

const greenScanner: SecretScanner = {
  scan: async () => ({ verdict: 'green', detail: 'Keine Fundstellen.', output: '', findings: [] }),
};

/**
 * The narrow slice of `postgres.Sql` the review gate touches: one tagged
 * template that resolves to rows. Cast at the seam rather than stubbed in full,
 * because a complete `postgres.Sql` would be forty methods nothing calls — and
 * the review gate is exercised against a real database in the integration test.
 */
function sqlFor(rows: unknown[]): never {
  return (async () => rows) as never;
}

describe('parseGateCommand', () => {
  it('zerlegt einen gewöhnlichen Befehl in ein Argument-Array', () => {
    expect(parseGateCommand('pnpm run  gate:test')).toEqual(['pnpm', 'run', 'gate:test']);
  });

  it('trimmt Rand-Leerzeichen', () => {
    expect(parseGateCommand('  npm test  ')).toEqual(['npm', 'test']);
  });

  it.each([
    ['npm test && rm -rf /', '&'],
    ['npm test; echo ok', ';'],
    ['npm test | tee log', '|'],
    ['npm test $(whoami)', '$'],
    ['npm test `id`', '`'],
    ['npm test > /dev/null', '>'],
    ['npm run "lint"', '"'],
    ['npm test\nrm -rf /', null],
  ])('verweigert "%s" ohne Shell auszuführen', (spec, character) => {
    expect(() => parseGateCommand(spec)).toThrow(GateCommandError);
    // The message names the character, because "invalid command" in an
    // unattended log costs somebody twenty minutes and a sentence costs nothing.
    if (character) {
      expect(() => parseGateCommand(spec)).toThrow(new RegExp(`\\${character}`));
    }
  });

  it('verweigert einen leeren Befehl', () => {
    expect(() => parseGateCommand('   ')).toThrow(GateCommandError);
  });
});

describe('GateSuite — §11s gesperrte sechs', () => {
  let scratch: string;

  /** Commands as argv-safe scripts: no shell means no `node -e "…"`. */
  const ok = 'node ok.mjs';
  const exit2 = 'node exit2.mjs';

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'vs-gate-suite-'));
    await writeFile(join(scratch, 'ok.mjs'), 'console.log("grün");\n');
    // Exit code 2 — tsc's code for a plain type error, and the one A50 is about.
    await writeFile(join(scratch, 'exit2.mjs'), 'process.exit(2);\n');
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const allGreen = (): ProjectGateConfig => ({
    gates: {},
    commands: { typecheck: ok, lint: ok, test: ok, build: ok },
    tools: [],
    migrationPaths: [],
  });

  const suite = (overrides: {
    rows?: unknown[];
    config?: ProjectGateConfig;
    secrets?: SecretScanner;
    retry?: Partial<GateRetryPolicy>;
    sleep?(ms: number): Promise<void>;
    onWarning?(message: string): void;
  }) =>
    new GateSuite({
      sql: sqlFor(overrides.rows ?? [{ actor: 'reviewer', payload: { rounds: 1 } }]),
      config: overrides.config ?? allGreen(),
      secrets: overrides.secrets ?? greenScanner,
      // A25's attempt count stays at its default everywhere in this file — only
      // the waiting is removed, so an infra case here exercises the same loop
      // production runs rather than a policy invented for the test.
      sleep: overrides.sleep ?? (async () => undefined),
      ...(overrides.retry ? { retry: overrides.retry } : {}),
      ...(overrides.onWarning ? { onWarning: overrides.onWarning } : {}),
    });

  const withCommands = (extra: ProjectGateConfig['commands']): ProjectGateConfig => {
    const config = allGreen();
    return { ...config, commands: { ...config.commands, ...extra } };
  };

  /**
   * §11 locks six gates and this is the list. A seventh appearing here without
   * a decision is exactly the drift the constant exists to prevent.
   */
  it('kennt genau die sechs gesperrten Gates des §11', () => {
    expect([...BASELINE_GATE_IDS]).toEqual([
      'review',
      'typecheck',
      'lint',
      'test',
      'secrets',
      'build',
    ]);
  });

  it('führt jeden Befehl im geprüften Baum aus und meldet grün', async () => {
    const result = await suite({}).run({ cwd: scratch, taskId: 'egal' });
    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.id)).toEqual([...BASELINE_GATE_IDS]);
    expect(result.steps.every((step) => step.verdict === 'green')).toBe(true);
  });

  it('macht aus einem fehlenden Befehl einen Befund, keinen übersprungenen Schritt', async () => {
    const config = allGreen();
    delete config.commands.build;
    const result = await suite({ config }).run({ cwd: scratch, taskId: 'egal' });
    expect(result.ok).toBe(false);
    const build = result.steps.find((step) => step.id === 'build');
    expect(build?.verdict).toBe('finding');
    expect(build?.detail).toContain('kein Befehl hinterlegt');
  });

  it('liest jeden Nicht-Null-Exitcode eines Fremdwerkzeugs als Befund (A50)', async () => {
    const result = await suite({ config: withCommands({ typecheck: exit2 }) }).run({
      cwd: scratch,
      taskId: 'egal',
    });
    const typecheck = result.steps.find((step) => step.id === 'typecheck');
    expect(typecheck?.verdict).toBe('finding');
    expect(typecheck?.exitCode).toBe(2);
    expect(result.infra).toHaveLength(0);
  });

  it('führt alle Schritte aus, auch nachdem einer rot war (§11 kennt keinen Abbruch)', async () => {
    const result = await suite({
      config: withCommands({ typecheck: exit2, lint: exit2 }),
    }).run({ cwd: scratch, taskId: 'egal' });
    expect(result.findings.map((step) => step.id)).toEqual(['typecheck', 'lint']);
    expect(result.steps).toHaveLength(BASELINE_GATE_IDS.length);
  });

  it('meldet ein nicht startbares Werkzeug als Infrastrukturfehler, nicht als Befund', async () => {
    const result = await suite({
      config: withCommands({ typecheck: 'vorschicht-gibt-es-nicht' }),
    }).run({ cwd: scratch, taskId: 'egal' });
    const typecheck = result.steps.find((step) => step.id === 'typecheck');
    expect(typecheck?.verdict).toBe('infra');
    expect(result.findings).toHaveLength(0);
    expect(result.ok).toBe(false);
  });

  it('macht aus einem Befehl mit Shell-Sonderzeichen einen Befund', async () => {
    const result = await suite({ config: withCommands({ test: 'node ok.mjs && true' }) }).run({
      cwd: scratch,
      taskId: 'egal',
    });
    const test = result.steps.find((step) => step.id === 'test');
    expect(test?.verdict).toBe('finding');
    expect(test?.command).toBeNull();
  });

  it('blockiert ohne Review-Nachweis', async () => {
    const result = await suite({ rows: [] }).run({ cwd: scratch, taskId: 'egal' });
    const review = result.steps.find((step) => step.id === 'review');
    expect(review?.verdict).toBe('finding');
    expect(review?.detail).toContain('Kein Review-Nachweis');
  });

  it('blockiert, wenn nicht das Review die Aufgabe auf "gates" gestellt hat', async () => {
    const result = await suite({ rows: [{ actor: 'orchestrator', payload: {} }] }).run({
      cwd: scratch,
      taskId: 'egal',
    });
    const review = result.steps.find((step) => step.id === 'review');
    expect(review?.verdict).toBe('finding');
    expect(review?.detail).toContain('orchestrator');
  });

  it('behandelt einen Fehler beim Lesen des Review-Nachweises als Infrastruktur', async () => {
    const broken = new GateSuite({
      sql: (() => {
        throw new Error('Verbindung weg');
      }) as never,
      config: allGreen(),
      secrets: greenScanner,
      sleep: async () => undefined,
    });
    const result = await broken.run({ cwd: scratch, taskId: 'egal' });
    const review = result.steps.find((step) => step.id === 'review');
    expect(review?.verdict).toBe('infra');
  });

  it('reicht das Urteil des Secrets-Scanners unverändert durch', async () => {
    const result = await suite({
      secrets: {
        scan: async () => ({ verdict: 'infra', detail: 'Docker weg', output: '', findings: [] }),
      },
    }).run({ cwd: scratch, taskId: 'egal' });
    // The distinction the merge queue acts on: unchecked, not wrong.
    expect(result.infra.map((step) => step.id)).toEqual(['secrets']);
    expect(result.findings).toHaveLength(0);
    expect(result.ok).toBe(false);
  });

  it('lässt ein angehaktes optionales Befehls-Gate den Merge blockieren und danach durch', async () => {
    const enabled = (command: string): ProjectGateConfig => ({
      ...allGreen(),
      gates: { e2e: true },
      commands: { ...allGreen().commands, e2e: command },
    });
    const red = await suite({ config: enabled(exit2) }).run({ cwd: scratch, taskId: 'egal' });
    expect(red.ok).toBe(false);
    expect(red.findings.map((step) => step.id)).toEqual(['e2e']);
    // …and green again once the command is: an optional gate blocks exactly the
    // way the locked six do, which is what "no warning mode" (§11) means.
    const green = await suite({ config: enabled(ok) }).run({ cwd: scratch, taskId: 'egal' });
    expect(green.ok).toBe(true);
    expect(green.steps.map((step) => step.id)).toEqual([...BASELINE_GATE_IDS, 'e2e']);
  });

  it('warnt bei jedem Infrastrukturfehler', async () => {
    const warnings: string[] = [];
    await suite({
      secrets: {
        scan: async () => ({ verdict: 'infra', detail: 'Docker weg', output: '', findings: [] }),
      },
      onWarning: (message) => warnings.push(message),
    }).run({ cwd: scratch, taskId: 'egal' });
    // Two retry warnings and the closing one. The retries are worth a line each:
    // a gate that is retried on every merge and recovers is invisible from the
    // verdict, and the warning is the only place it shows before somebody goes
    // looking at `attempts` in the event log.
    expect(warnings).toHaveLength(3);
    expect(warnings.every((message) => message.includes('secrets'))).toBe(true);
    expect(warnings[0]).toContain('Versuch 1/3');
    expect(warnings.at(-1)).toContain('Auch nach 3 Versuchen');
  });
});

/**
 * §22's Phase 3 step 3: A25's retry, at the layer that makes the classification.
 *
 * "Infra failures (network/registry/runner-environment errors) retry up to 3×
 * with backoff and never count as red." Four properties are asserted, and each
 * of them is a way the loop could be built wrong without any test noticing:
 *
 *  - it retries an infra step *and stops once it is green* (a loop that always
 *    ran three times would waste two of them on every recovery),
 *  - it never retries a finding (that is §11's warning mode by the back door),
 *  - it waits between attempts, doubling (a loop with no wait retries three
 *    times inside a millisecond and learns nothing about a machine),
 *  - and the retry granularity is the **step**, so a broken secrets scan does
 *    not re-run the test suite beside it.
 */
describe('A25 — die Wiederholung sitzt beim Schritt (§22, Phase 3, Schritt 3)', () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'vorschicht-gate-retry-'));
    await writeFile(join(scratch, 'ok.mjs'), 'console.log("grün");\n');
  });

  afterAll(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  const ok = `node ${join('ok.mjs')}`;
  const config = (commands: ProjectGateConfig['commands']): ProjectGateConfig => ({
    gates: {},
    commands: { typecheck: ok, lint: ok, test: ok, build: ok, ...commands },
    tools: [],
    migrationPaths: [],
  });

  /** A scanner that is unreachable for the first `n` calls and then recovers. */
  function flakyScanner(failures: number): { scanner: SecretScanner; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      scanner: {
        scan: async () => {
          calls += 1;
          return calls <= failures
            ? {
                verdict: 'infra' as const,
                detail: 'Docker nicht erreichbar',
                output: '',
                findings: [],
              }
            : {
                verdict: 'green' as const,
                detail: 'Keine Fundstellen.',
                output: '',
                findings: [],
              };
        },
      },
    };
  }

  function suiteWith(overrides: {
    secrets?: SecretScanner;
    commands?: ProjectGateConfig['commands'];
    retry?: Partial<GateRetryPolicy>;
    sleep?(ms: number): Promise<void>;
  }) {
    const waits: number[] = [];
    return {
      waits,
      suite: new GateSuite({
        sql: sqlFor([{ actor: 'reviewer', payload: {} }]),
        config: config(overrides.commands ?? {}),
        secrets: overrides.secrets ?? greenScanner,
        ...(overrides.retry ? { retry: overrides.retry } : {}),
        sleep:
          overrides.sleep ??
          (async (ms: number) => {
            waits.push(ms);
          }),
      }),
    };
  }

  it('wiederholt einen Infrastrukturfehler und hört auf, sobald er grün ist', async () => {
    const { scanner, calls } = flakyScanner(1);
    const { suite, waits } = suiteWith({ secrets: scanner });
    const result = await suite.run({ cwd: scratch, taskId: 'egal' });

    expect(result.ok).toBe(true);
    const secrets = result.steps.find((step) => step.id === 'secrets');
    expect(secrets?.verdict).toBe('green');
    expect(secrets?.attempts).toBe(2);
    // The discarded attempt survives the recovery. §11 has nowhere to put a
    // result it threw away, so it goes next to the one it kept.
    expect(secrets?.retries).toEqual(['Versuch 1/3: Docker nicht erreichbar']);
    expect(secrets?.detail).toContain('erst im 2. Versuch');
    // Stopped at two: a loop that always ran to three would waste an attempt on
    // every single recovery, and `calls` is the only thing that shows it.
    expect(calls()).toBe(2);
    expect(waits).toEqual([5_000]);
    expect(result.retried.map((step) => step.id)).toEqual(['secrets']);
  });

  it('gibt nach genau drei Versuchen auf und bleibt "infra", nicht rot', async () => {
    const { scanner, calls } = flakyScanner(Number.POSITIVE_INFINITY);
    const { suite, waits } = suiteWith({ secrets: scanner });
    const result = await suite.run({ cwd: scratch, taskId: 'egal' });

    expect(calls()).toBe(3);
    // Doubling, as `DevChain.leg` does — a constant wait is a retry that has
    // not understood what it is waiting for.
    expect(waits).toEqual([5_000, 10_000]);
    const secrets = result.steps.find((step) => step.id === 'secrets');
    expect(secrets?.verdict).toBe('infra');
    expect(secrets?.attempts).toBe(3);
    expect(secrets?.retries).toHaveLength(2);
    expect(secrets?.detail).toContain('Auch nach 3 Versuchen');
    // The half of the exit gate that matters: nothing here is a finding, so
    // nothing downstream can turn this into a red task (§11, A25).
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(false);
  });

  /**
   * The one thing this loop must never do. Retrying a red test suite until it
   * passes is §11's warning mode wearing a retry's clothes — and it would be
   * invisible, because the gate would simply be green more often.
   */
  it('wiederholt einen Befund niemals', async () => {
    const { suite, waits } = suiteWith({
      commands: { test: 'node --eval process.exit(1)' },
    });
    const result = await suite.run({ cwd: scratch, taskId: 'egal' });
    const test = result.steps.find((step) => step.id === 'test');
    expect(test?.verdict).toBe('finding');
    expect(test?.attempts).toBe(1);
    expect(test?.retries).toEqual([]);
    expect(waits).toEqual([]);
    expect(result.retried).toEqual([]);
  });

  /**
   * The reason the retry is per step rather than per suite (§22 step 3, and the
   * question the build log left open). Re-running the suite because docker was
   * unreachable for ten seconds would re-run the project's whole test command
   * to find out — three times, at up to fifteen minutes each.
   */
  it('wiederholt nur den kaputten Schritt, nicht die Suite', async () => {
    // Counted on disk rather than through `attempts`: `attempts` is the number
    // this loop reports about itself, and the question here is how often the
    // project's command was actually executed.
    const ledger = join(scratch, 'runs.log');
    await rm(ledger, { force: true });
    const counter = join(scratch, 'count.mjs');
    await writeFile(
      counter,
      `import { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(ledger)}, 'x');\n`,
    );

    const { scanner, calls } = flakyScanner(Number.POSITIVE_INFINITY);
    const { suite } = suiteWith({ secrets: scanner, commands: { test: `node ${counter}` } });
    const result = await suite.run({ cwd: scratch, taskId: 'egal' });

    expect(calls()).toBe(3);
    expect((await readFile(ledger, 'utf8')).length).toBe(1);
    expect(result.steps.find((step) => step.id === 'test')?.attempts).toBe(1);
    expect(result.steps.find((step) => step.id === 'secrets')?.attempts).toBe(3);
  });

  /**
   * The merge queue holds a per-project advisory lock for the whole suite run
   * (A55.2), so retries are borrowed time from every other candidate in that
   * project. The budget is the ceiling, and when it bites it says so in the
   * step's own detail line rather than quietly shortening the loop — a
   * truncation nobody can see reads as "we tried everything".
   */
  it('bricht ab, wenn das Wiederholungsbudget der Suite erschöpft ist, und sagt es', async () => {
    const { scanner, calls } = flakyScanner(Number.POSITIVE_INFINITY);
    const { suite, waits } = suiteWith({
      secrets: scanner,
      // Smaller than the first backoff: the budget is gone before the first
      // retry, which is the boundary worth pinning.
      retry: { budgetMs: 100 },
    });
    const result = await suite.run({ cwd: scratch, taskId: 'egal' });
    expect(calls()).toBe(1);
    expect(waits).toEqual([]);
    const secrets = result.steps.find((step) => step.id === 'secrets');
    expect(secrets?.verdict).toBe('infra');
    expect(secrets?.attempts).toBe(1);
    expect(secrets?.detail).toContain('Wiederholungsbudget');
    expect(secrets?.detail).toContain('wird nicht rot');
  });
});

describe('gateFailureSummary', () => {
  it('nennt Befunde und Infrastrukturfehler getrennt', () => {
    const result = {
      ok: false,
      durationMs: 1,
      steps: [],
      findings: [
        {
          id: 'test' as const,
          verdict: 'finding' as const,
          detail: 'rot',
          output: '',
          durationMs: 1,
          command: null,
          exitCode: 1,
          attempts: 1,
          retries: [],
        },
      ],
      infra: [
        {
          id: 'secrets' as const,
          verdict: 'infra' as const,
          detail: 'Docker weg',
          output: '',
          durationMs: 1,
          command: null,
          exitCode: null,
          attempts: 3,
          retries: ['Versuch 1/3: Docker weg', 'Versuch 2/3: Docker weg'],
        },
      ],
      retried: [],
    } satisfies GateSuiteResult;
    const summary = gateFailureSummary(result);
    expect(summary).toContain('Tests: rot');
    expect(summary).toContain('(Infrastruktur)');
  });
});

describe('die Registry treibt den Lauf', () => {
  const base = (config: Partial<ProjectGateConfig>) =>
    new GateSuite({
      sql: sqlFor([{ actor: 'reviewer', payload: {} }]),
      config: { gates: {}, commands: {}, tools: [], migrationPaths: [], ...config },
      secrets: greenScanner,
    });

  it('läuft ohne Konfiguration genau über §11s gesperrte sechs', () => {
    expect(
      base({})
        .gates()
        .map((gate) => gate.id),
    ).toEqual([...BASELINE_GATE_IDS]);
  });

  it('nimmt ein angehaktes optionales Gate in den Lauf auf', () => {
    const ids = base({ gates: { changelog: true } })
      .gates()
      .map((gate) => gate.id);
    expect(ids).toEqual([...BASELINE_GATE_IDS, 'changelog']);
  });

  it('führt ein gesperrtes Gate auch dann aus, wenn die Zeile es abwählt', () => {
    const ids = base({ gates: { secrets: false } })
      .gates()
      .map((gate) => gate.id);
    expect(ids).toContain('secrets');
  });

  /**
   * Decision 7 in the module header, asserted rather than trusted: a catalogue
   * entry whose runner does not exist reads as covered and cannot carry a
   * signal, which is precisely §8.2's sixth domain.
   */
  it('hat für jedes interne Gate des Katalogs einen Prüflauf', () => {
    expect(() => assertInternalRunnersComplete()).not.toThrow();
  });

  /**
   * The registry refuses a shell metacharacter at write time and the runner
   * refuses it again at merge time; two layers are only two layers if they
   * refuse the same characters.
   */
  it('verwendet dieselbe Sonderzeichen-Regel wie die Registry', () => {
    expect(SHELL_METACHARACTERS.source).toBe(GATE_SHELL_METACHARACTERS.source);
  });
});

describe('die Diff-Gates (CHANGELOG, Dokumentation)', () => {
  let repo: string;

  const suiteFor = (gates: ProjectGateConfig['gates']) =>
    new GateSuite({
      sql: sqlFor([{ actor: 'reviewer', payload: {} }]),
      config: { gates, commands: {}, tools: [], migrationPaths: [] },
      secrets: greenScanner,
      sleep: async () => undefined,
    });

  const git = (...args: string[]) =>
    execFileAsync('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    });

  /** One commit on a task branch, carrying exactly the named files. */
  async function candidate(files: Record<string, string>): Promise<void> {
    await git('checkout', '--quiet', 'main');
    await git('checkout', '--quiet', '-B', 'kandidat');
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(repo, name)), { recursive: true });
      await writeFile(join(repo, name), content, 'utf8');
    }
    await git('add', '--all');
    await git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'feat: etwas');
  }

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'vs-gate-diff-'));
    await writeFile(join(repo, 'app.js'), 'export const a = 1;\n');
    await writeFile(join(repo, 'CHANGELOG.md'), '# Änderungen\n');
    await writeFile(join(repo, 'README.md'), '# Projekt\n');
    await git('init', '--initial-branch=main', '--quiet');
    await git('add', '--all');
    await git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'chore: Grundstein');
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  async function verdictOf(id: 'changelog' | 'docs') {
    const result = await suiteFor({ [id]: true }).run({
      cwd: repo,
      taskId: 'egal',
      baseRef: 'main',
    });
    return result.steps.find((step) => step.id === id);
  }

  it('blockiert eine Änderung ohne CHANGELOG-Eintrag', async () => {
    await candidate({ 'app.js': 'export const a = 2;\n' });
    const step = await verdictOf('changelog');
    expect(step?.verdict).toBe('finding');
    expect(step?.detail).toContain('CHANGELOG');
  });

  it('lässt dieselbe Änderung mit CHANGELOG-Eintrag durch', async () => {
    await candidate({ 'app.js': 'export const a = 3;\n', 'CHANGELOG.md': '# Änderungen\n\n- a\n' });
    expect((await verdictOf('changelog'))?.verdict).toBe('green');
  });

  it('blockiert Code ohne mitgeführte Dokumentation', async () => {
    await candidate({ 'app.js': 'export const a = 4;\n' });
    const step = await verdictOf('docs');
    expect(step?.verdict).toBe('finding');
    expect(step?.output).toContain('app.js');
  });

  it('lässt Code mit mitgeführter Dokumentation durch', async () => {
    await candidate({ 'app.js': 'export const a = 5;\n', 'docs/entwurf.md': '# Entwurf\n' });
    expect((await verdictOf('docs'))?.verdict).toBe('green');
  });

  it('lässt eine reine Dokumentationsänderung durch', async () => {
    await candidate({ 'README.md': '# Projekt\n\nmehr\n' });
    expect((await verdictOf('docs'))?.verdict).toBe('green');
  });

  /**
   * The reason the two are separate gates: a CHANGELOG entry answers the
   * CHANGELOG question and must not also answer the documentation one, or the
   * second checkbox is decoration.
   */
  it('lässt den CHANGELOG allein das Dokumentations-Gate nicht erfüllen', async () => {
    await candidate({ 'app.js': 'export const a = 6;\n', 'CHANGELOG.md': '# Änderungen\n\n- b\n' });
    expect((await verdictOf('docs'))?.verdict).toBe('finding');
    expect((await verdictOf('changelog'))?.verdict).toBe('green');
  });

  it('meldet einen fehlenden Vergleichsbranch als Infrastrukturfehler, nicht als grün', async () => {
    await candidate({ 'app.js': 'export const a = 7;\n' });
    const result = await suiteFor({ changelog: true, docs: true }).run({
      cwd: repo,
      taskId: 'egal',
    });
    // The locked command gates are red too — this repository has no commands
    // configured — so the assertion is about the two that could not run: they
    // are `infra` (nothing was checked) and never `green`.
    expect(result.infra.map((step) => step.id)).toEqual(['changelog', 'docs']);
    expect(result.findings.map((step) => step.id)).not.toContain('changelog');
    expect(result.ok).toBe(false);
  });

  it('meldet einen unlesbaren Diff als Infrastrukturfehler', async () => {
    const result = await suiteFor({ changelog: true }).run({
      cwd: repo,
      taskId: 'egal',
      baseRef: 'gibt-es-nicht',
    });
    expect(result.infra.map((step) => step.id)).toEqual(['changelog']);
  });
});

/**
 * §11's migration gate (A63) — the only gate that may spend a model session.
 *
 * Two questions are asked separately here, because they fail differently. The
 * *decision* — what a delivered review means for the merge — is a pure function
 * and gets its own block; the *dispatch* is about whether a session is spawned
 * at all, and the assertion that matters there is negative: a candidate with no
 * migration in it must not reach the reviewer.
 */
describe('judgeMigrationReview — §11, §12/A24 und §23 in einem Urteil', () => {
  const review = (partial: Partial<MigrationReviewResult> = {}): MigrationReviewResult => ({
    status: 'done',
    summary: 'Additive Spalte, nichts wird gelesen was verschwindet.',
    artifacts: [],
    followups: [],
    verdict: 'approve',
    backwardCompatible: true,
    reversibility: 'reversible',
    migrations: ['migrations/0002.sql'],
    findings: [],
    ...partial,
  });

  it('lässt eine saubere Migration durch', () => {
    expect(judgeMigrationReview(review()).verdict).toBe('green');
  });

  it('blockiert bei „changes_requested" und führt die Befunde mit', () => {
    const outcome = judgeMigrationReview(
      review({
        verdict: 'changes_requested',
        findings: [
          {
            file: 'migrations/0002.sql',
            line: 1,
            severity: 'blocker',
            summary: 'DROP COLUMN ohne vorherige Entkopplung der Leser',
          },
        ],
      }),
    );
    expect(outcome.verdict).toBe('finding');
    expect(outcome.output).toContain('DROP COLUMN');
    expect(outcome.output).toContain('migrations/0002.sql:1');
  });

  /**
   * §23 makes "reversible or explicitly documented" a definition-of-done item,
   * so the observation is the reviewer's and the consequence is ours (A54.2).
   * The interesting case is precisely the one where the two disagree.
   */
  it('blockiert eine unbegründet nicht umkehrbare Migration trotz Freigabe', () => {
    const outcome = judgeMigrationReview(review({ reversibility: 'undocumented' }));
    expect(outcome.verdict).toBe('finding');
    expect(outcome.detail).toContain('§23');
    // The divergence is named rather than resolved in the model's favour.
    expect(outcome.detail).toContain('freigegeben');
  });

  it('lässt eine begründet nicht umkehrbare Migration durch', () => {
    expect(judgeMigrationReview(review({ reversibility: 'documented_irreversible' })).verdict).toBe(
      'green',
    );
  });

  /**
   * The load-bearing one. §12 is explicit that a non-backward-compatible
   * migration stops the *deploy* and escalates — not the merge. Blocking here
   * would be stricter than the spec in a way that forbids every contract step,
   * and §0.3's "never weaken a gate" does not license inventing a stronger one.
   */
  it('hält eine nicht rückwärtskompatible Migration nicht auf, sagt es aber', () => {
    const outcome = judgeMigrationReview(review({ backwardCompatible: false }));
    expect(outcome.verdict).toBe('green');
    expect(outcome.detail).toContain('nicht** rückwärtskompatibel');
    expect(outcome.detail).toContain('§12/A24');
  });

  it('nennt die Deploy-Folge auch dann, wenn ohnehin blockiert wird', () => {
    const outcome = judgeMigrationReview(
      review({ verdict: 'changes_requested', backwardCompatible: false }),
    );
    expect(outcome.verdict).toBe('finding');
    expect(outcome.detail).toContain('§12/A24');
  });
});

describe('das Migrations-Gate entscheidet erst, dann gibt es Geld aus', () => {
  let repo: string;

  const git = (...args: string[]) =>
    execFileAsync('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    });

  async function candidate(files: Record<string, string>): Promise<void> {
    await git('checkout', '--quiet', 'main');
    await git('checkout', '--quiet', '-B', 'kandidat');
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(repo, name)), { recursive: true });
      await writeFile(join(repo, name), content, 'utf8');
    }
    await git('add', '--all');
    await git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'feat: etwas');
  }

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), 'vs-gate-migration-'));
    await writeFile(join(repo, 'app.js'), 'export const a = 1;\n');
    await git('init', '--initial-branch=main', '--quiet');
    await git('add', '--all');
    await git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'chore: Grundstein');
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  /** Records every call, so "was a session spawned" is an assertion. */
  function reviewerReturning(report: MigrationReviewReport) {
    const calls: MigrationReviewInput[] = [];
    return {
      calls,
      reviewer: {
        review: async (input: MigrationReviewInput) => {
          calls.push(input);
          return report;
        },
      } satisfies MigrationReviewer,
    };
  }

  const APPROVED: MigrationReviewReport = {
    status: 'reviewed',
    runId: 'run-1',
    result: {
      status: 'done',
      summary: 'Sieht gut aus.',
      artifacts: [],
      followups: [],
      verdict: 'approve',
      backwardCompatible: true,
      reversibility: 'reversible',
      migrations: ['migrations/0002.sql'],
      findings: [],
    },
  };

  async function runGate(options: {
    migrationReview?: MigrationReviewer;
    config?: Partial<ProjectGateConfig>;
  }) {
    const suite = new GateSuite({
      sql: sqlFor([{ actor: 'reviewer', payload: {} }]),
      config: {
        gates: { 'migration-review': true },
        commands: {},
        tools: [],
        migrationPaths: [],
        ...options.config,
      },
      secrets: greenScanner,
      sleep: async () => undefined,
      ...(options.migrationReview ? { migrationReview: options.migrationReview } : {}),
    });
    const result = await suite.run({ cwd: repo, taskId: 'aufgabe-1', baseRef: 'main' });
    return result.steps.find((step) => step.id === 'migration-review');
  }

  /**
   * The economy rule, and the reason it is a *negative* assertion: the cheap
   * version of this gate would call the reviewer and let it answer "nothing to
   * review", which costs a strong-tier session on every merge of every project
   * with the box ticked.
   */
  it('startet keine Sitzung, wenn der Kandidat keine Migration berührt', async () => {
    await candidate({ 'app.js': 'export const a = 2;\n' });
    const { calls, reviewer } = reviewerReturning(APPROVED);
    const step = await runGate({ migrationReview: reviewer });
    expect(step?.verdict).toBe('green');
    expect(step?.detail).toContain('keine Migration');
    expect(calls).toHaveLength(0);
  });

  it('übergibt bei einer Migration den Diff und die Migrationsdateien getrennt', async () => {
    await candidate({
      'migrations/0002.sql': 'ALTER TABLE t ADD COLUMN c text;\n',
      'app.js': 'export const a = 3;\n',
    });
    const { calls, reviewer } = reviewerReturning(APPROVED);
    expect((await runGate({ migrationReview: reviewer }))?.verdict).toBe('green');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.migrations).toEqual(['migrations/0002.sql']);
    expect(calls[0]?.changedFiles).toContain('app.js');
    expect(calls[0]?.baseRef).toBe('main');
    expect(calls[0]?.cwd).toBe(repo);
  });

  /**
   * §8.2's sixth domain, applied to this file. A gate with no runner behind it
   * that reported green would read as covered and carry no signal — so the
   * suite says "nothing ran" instead, which A25 turns into a retry.
   */
  it('meldet eine Suite ohne Prüfer als Infrastrukturfehler, niemals als grün', async () => {
    await candidate({ 'migrations/0003.sql': 'ALTER TABLE t DROP COLUMN c;\n' });
    const step = await runGate({});
    expect(step?.verdict).toBe('infra');
    expect(step?.output).toContain('migrations/0003.sql');
  });

  it('meldet eine Sitzung, die nicht laufen konnte, als Infrastrukturfehler', async () => {
    await candidate({ 'migrations/0004.sql': 'ALTER TABLE t ADD COLUMN d text;\n' });
    const { reviewer } = reviewerReturning({ status: 'infra', problem: 'CLI nicht erreichbar' });
    const step = await runGate({ migrationReview: reviewer });
    expect(step?.verdict).toBe('infra');
    expect(step?.detail).toContain('CLI nicht erreichbar');
  });

  it('meldet eine Sitzung ohne verwertbares Urteil als Befund', async () => {
    await candidate({ 'migrations/0005.sql': 'ALTER TABLE t ADD COLUMN e text;\n' });
    const { reviewer } = reviewerReturning({ status: 'failed', problem: 'Zuglimit erreicht' });
    const step = await runGate({ migrationReview: reviewer });
    // Not infra: the session ran and produced nothing usable, and §11's answer
    // for "not established" is never green.
    expect(step?.verdict).toBe('finding');
    expect(step?.detail).toContain('Zuglimit');
  });

  it('folgt der Projektkonfiguration statt der Voreinstellung, wenn es eine gibt', async () => {
    await candidate({ 'sql/report.sql': 'SELECT 1;\n' });
    const { calls, reviewer } = reviewerReturning(APPROVED);
    const step = await runGate({
      migrationReview: reviewer,
      config: { migrationPaths: ['db/schema/**'] },
    });
    expect(step?.verdict).toBe('green');
    expect(calls).toHaveLength(0);
  });

  it('meldet ohne Vergleichsbranch einen Infrastrukturfehler und startet nichts', async () => {
    const { calls, reviewer } = reviewerReturning(APPROVED);
    const suite = new GateSuite({
      sql: sqlFor([{ actor: 'reviewer', payload: {} }]),
      config: {
        gates: { 'migration-review': true },
        commands: {},
        tools: [],
        migrationPaths: [],
      },
      secrets: greenScanner,
      sleep: async () => undefined,
      migrationReview: reviewer,
    });
    const result = await suite.run({ cwd: repo, taskId: 'aufgabe-1' });
    expect(result.steps.find((step) => step.id === 'migration-review')?.verdict).toBe('infra');
    expect(calls).toHaveLength(0);
  });
});

describe('das Metazeichen-Muster gibt es nur einmal', () => {
  it('ist dasselbe Objekt wie das geteilte, nicht bloß dasselbe Muster', () => {
    // Identität, nicht Gleichheit: zwei byte-identische Literale bestünden
    // `toEqual` und wären trotzdem genau die Doppelung, vor der beide Dateien
    // im Kommentar warnen. Sie waren es, über Monate, in zwei Paketen — und
    // nichts hätte es gesagt, wenn sie auseinandergelaufen wären.
    expect(SHELL_METACHARACTERS).toBe(GATE_SHELL_METACHARACTERS);
  });
});
