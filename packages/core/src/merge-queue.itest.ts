/**
 * The merge queue against a real Postgres and real git repositories (§10, §11).
 *
 * Four Phase 2 exit gates are worded around this file, and each of them is a
 * statement about something mechanical rather than about a model:
 *
 *   * two parallel tasks with disjoint claims complete and merge cleanly in
 *     sequence through the queue;
 *   * a seeded test failure, a planted secret and a lint error each block the
 *     merge individually, and the merge succeeds once they are fixed;
 *   * every commit that lands on the integration branch is authored as
 *     `Vorschicht Bot`;
 *   * no orphan worktrees or branches survive the suite.
 *
 * So everything here is real except the three model sessions: real worktrees,
 * real rebases, a real `npm test` going red on a real broken assertion, a real
 * gitleaks container finding a real credential-shaped string. The dev chain is
 * driven by the `fake` backend (A37) because what it produces — a task in
 * `gates` with a Reviewer's approval behind it — is an *input* to the queue, and
 * a gate suite that only goes red when a model happens to cooperate is not a
 * gate suite anybody can regression-test.
 *
 * The secrets case deliberately uses the real scanner. It is the one step whose
 * verdict depends on a tool we do not control, and a stub there would prove that
 * our plumbing calls a stub.
 *
 * It is `AutoSecretScanner` rather than the container implementation since
 * 2026-08-16: the deployed orchestrator ships no docker client (A104), so pinning
 * the docker arm here made this evidence unreachable in the one environment the
 * studio actually merges in — and inside the gate image, which is that
 * environment. Same tool, same rules, chosen by what is present.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type { DeployMethod, GuardianDecision, ProjectGateConfig } from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeBackend, type FakeEvent, type FakeScript } from './backend/fake.js';
import { ClaimRegistry } from './claim-registry.js';
import { auditReleaseHistory } from './deploy/audit-history.js';
import { FakeDeployTarget } from './deploy/fake-target.js';
import { DeployRecords } from './deploy/records.js';
import { DeployService } from './deploy/service.js';
import { DevChain } from './dev-chain.js';
import { EscalationService } from './escalation-service.js';
import { EventLog } from './event-log.js';
import { FindingsService } from './findings.js';
import { GateSuite, type SecretScanner } from './gate-suite.js';
import { BOT_IDENTITY, branchExists, currentBranch, worktreeList } from './git.js';
import {
  foreignCommits,
  MERGE_LOCK_NAMESPACE,
  MergeQueue,
  MergeQueueError,
  OPS_ALERT_AFTER_INFRA_ATTEMPTS,
  type OpsAlert,
} from './merge-queue.js';
import { AgentMigrationReviewer, type MigrationReviewer } from './migration-review.js';
import { ProjectService } from './project-service.js';
import { RunRecords } from './run-records.js';
import { AgentRunner, type RunnerPaths } from './runner.js';
import { createSandboxProject, plantSeed, repairSeed, type SandboxProject } from './sandbox.js';
import {
  chainInfraHistory,
  type DeployDispatch,
  Scheduler,
  taskDeployHandover,
} from './scheduler.js';
import { AutoSecretScanner } from './secret-scan.js';
import { TaskService } from './task-service.js';
import { WorktreeManager } from './worktree.js';

const execFile = promisify(execFileCallback);

/**
 * Wie in `deploy/service.itest.ts`: Biome verbietet `!`, und zu Recht — eine
 * Fixture, die still null zurückgibt, meldet sich drei Zeilen später als
 * „Cannot read properties of null" und sagt nichts darüber, welcher
 * Aufbauschritt gescheitert ist.
 */
function muss<T>(wert: T | null | undefined, was: string): T {
  if (wert === null || wert === undefined)
    throw new Error(`${was} fehlt — die Fixture stimmt nicht`);
  return wert;
}

const url = process.env.TEST_DATABASE_URL;

/** Containment proved live — without this every run is an infra failure (§6.6). */
const HOOK_START: FakeEvent = {
  type: 'hook_event',
  event: 'SessionStart',
  hookName: 'SessionStart:*',
  phase: 'response',
  outcome: 'success',
  exitCode: 0,
};

const PLAN = {
  status: 'done',
  summary: 'Plan erstellt.',
  artifacts: [],
  followups: [],
  claimSet: ['src/**', 'greet.test.js'],
  plan: ['Begrüßung anpassen'],
  testPlan: ['npm test'],
  risks: [],
};

const CODED = { status: 'done', summary: 'Umgesetzt.', artifacts: [], followups: [] };

const APPROVED = {
  status: 'done',
  summary: 'Sieht gut aus.',
  artifacts: [],
  followups: [],
  verdict: 'approve',
  findings: [],
  claimsRespected: true,
};

function script(raw: unknown): FakeScript {
  return { events: [HOOK_START], result: { raw, tokensIn: 100, tokensOut: 200 } };
}

describe.skipIf(!url)('Merge-Warteschlange (§10)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let tasks: TaskService;
  let projects: ProjectService;
  let claims: ClaimRegistry;
  let worktrees: WorktreeManager;
  let eventLog: EventLog;
  let findings: FindingsService;
  let escalations: EscalationService;
  let scratch: string;
  let paths: RunnerPaths;

  beforeAll(async () => {
    database = await createTestDatabase('mergequeue');
    // Three: `runOnce` reserves one connection for the whole merge, and the
    // serialisation test holds a second from outside while it runs.
    sql = createSql({ url: database.url, max: 4 });
    eventLog = new EventLog(sql);
    tasks = new TaskService({ sql, eventLog });
    projects = new ProjectService(sql);
    claims = new ClaimRegistry({ sql, tasks, projects, eventLog });
    findings = new FindingsService({ sql });
    escalations = new EscalationService({ sql, eventLog });
    scratch = await mkdtemp(join(tmpdir(), 'vs-merge-'));
    worktrees = new WorktreeManager({
      tasks,
      projects,
      eventLog,
      root: join(scratch, 'worktrees'),
    });
    paths = {
      roleSettingsDir: join(scratch, 'claude'),
      runsRoot: join(scratch, 'runs'),
      transcriptsRoot: join(scratch, 'transcripts'),
      mcpServerEntry: null,
    };
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
    await rm(scratch, { recursive: true, force: true });
  });

  let seq = 0;

  /**
   * A fresh repository *and* a fresh project row per case.
   *
   * Both, not just the project row: the merge queue writes to the integration
   * branch, so two cases sharing one repository would see each other's commits —
   * and one of them would then be rebasing onto a `main` another test moved
   * underneath it. `dev-chain.itest.ts` could share a repository because nothing
   * there ever merged.
   */
  async function newSandbox(options: { defaultBranch?: string } = {}) {
    seq += 1;
    const sandbox = await createSandboxProject({
      path: join(scratch, `repo-${seq}`),
      ...(options.defaultBranch ? { defaultBranch: options.defaultBranch } : {}),
    });
    const project = await projects.create({
      slug: `sandkasten-${seq}`,
      name: `Sandkasten ${seq}`,
      rootPath: sandbox.path,
      defaultBranch: sandbox.defaultBranch,
    });
    return { sandbox, project };
  }

  /** §12's configuration, written the way onboarding writes it. */
  async function setDeployConfig(projectId: string, config: Record<string, unknown>) {
    await sql`
      UPDATE projects SET deploy_config = ${sql.json(config as never)} WHERE id = ${projectId}
    `;
  }

  /** §11's commands, in the shape the registry stores them. */
  function configOf(
    sandbox: SandboxProject,
    gates: ProjectGateConfig['gates'] = {},
  ): ProjectGateConfig {
    return {
      gates,
      // Every command the fixture owns, whether or not its gate is ticked. A
      // command for a gate nobody enabled is never executed, and listing them
      // here keeps the one place that knows the fixture's commands in the
      // fixture rather than half here and half there.
      commands: { ...sandbox.commands },
      tools: sandbox.tools,
      // Empty on purpose: `migrationGlobs` then falls back to
      // `DEFAULT_MIGRATION_GLOBS`, which is what an onboarded project that never
      // configured them gets — so the case below tests the defaults rather than
      // a list written to make it pass.
      migrationPaths: [],
    };
  }

  function queue(
    sandbox: SandboxProject,
    options: {
      secrets?: SecretScanner;
      gates?: ProjectGateConfig['gates'];
      migrationReview?: MigrationReviewer;
      /** §12: which methods this studio has a target for. Empty by default. */
      deployableMethods?: DeployMethod[];
      onWarning?(message: string): void;
      onOpsAlert?(alert: OpsAlert): void;
    } = {},
  ) {
    const warnings: string[] = [];
    const opsAlerts: OpsAlert[] = [];
    const scanner =
      options.secrets ??
      ({
        scan: async () => ({
          verdict: 'green',
          detail: 'übersprungen',
          output: '',
          findings: [],
        }),
      } as const);
    return {
      warnings,
      opsAlerts,
      queue: new MergeQueue({
        sql,
        tasks,
        projects,
        claims,
        worktrees,
        eventLog,
        findings,
        escalations,
        ...(options.deployableMethods ? { deployableMethods: options.deployableMethods } : {}),
        gates: () =>
          new GateSuite({
            sql,
            config: configOf(sandbox, options.gates),
            secrets: scanner,
            ...(options.migrationReview ? { migrationReview: options.migrationReview } : {}),
            timeoutMs: 120_000,
            // A25's attempt count is left at its default so the retry really
            // runs; only the waiting is removed. Injecting `attempts: 1`
            // instead would have made every infra case here a statement about
            // a policy the production suite does not use.
            sleep: async () => undefined,
            onWarning: (message) => warnings.push(message),
          }),
        onWarning: (message) => {
          warnings.push(message);
          options.onWarning?.(message);
        },
        onOpsAlert: (alert) => {
          opsAlerts.push(alert);
          options.onOpsAlert?.(alert);
        },
      }),
    };
  }

  /**
   * Drive one task from `queued` to `merge_queue` with a real diff behind it.
   *
   * The chain is the real `DevChain`; only the three sessions are scripted. That
   * matters for the review gate below: the `state_changed → gates` row it reads
   * is written by the chain's Reviewer leg, not by this helper.
   */
  async function candidate(
    projectId: string,
    sandbox: SandboxProject,
    options: {
      title?: string;
      priority?: 'P0' | 'P1' | 'P2' | 'P3';
      claimSet?: string[];
      work: (cwd: string) => Promise<void>;
      /** Every prompt the chain actually built, for the pipeline gate below. */
      capture?: Array<{ role: string; prompt: string }>;
    },
  ) {
    const task = await tasks.create({
      projectId,
      title: options.title ?? `Kandidat ${seq}`,
      description: 'Die Begrüßung soll eine Anrede tragen.',
      acceptanceCriteria: ['greet() liefert die Anrede'],
      priority: options.priority ?? 'P1',
    });

    const scripts: Record<string, FakeScript> = {
      planner: script({ ...PLAN, claimSet: options.claimSet ?? PLAN.claimSet }),
      coder: script(CODED),
      reviewer: script(APPROVED),
    };
    const backend = new FakeBackend(async (spec) => {
      options.capture?.push({ role: spec.role, prompt: spec.prompt });
      if (spec.role === 'coder') await options.work(spec.cwd);
      const found = scripts[spec.role];
      if (!found) throw new Error(`Kein Skript für "${spec.role}"`);
      return found;
    });
    const chain = new DevChain({
      tasks,
      projects,
      claims,
      worktrees,
      runner: new AgentRunner({ sql, eventLog, backend, paths }),
      runs: new RunRecords(sql),
      eventLog,
      findings,
      escalations,
      gateTools: () => sandbox.tools,
      sleep: async () => undefined,
    });

    const outcome = await chain.run(task.id);
    expect(outcome.status).toBe('approved');
    return task.id;
  }

  /**
   * Commit whatever the "coder" wrote, as a coder following its prompt would.
   *
   * A clean tree is a no-op rather than an error. §8.1 sends a diff back to the
   * Coder on `changes_requested`, so this runs again on the next round — and a
   * second round that produced no new change is a reviewer disagreement to
   * resolve, not a git failure to report as an infrastructure problem.
   */
  async function commitIn(cwd: string, message: string) {
    const { stdout } = await execFile('git', ['status', '--porcelain=v1'], { cwd });
    if (stdout.trim() === '') return;
    await execFile('git', ['add', '--all'], { cwd });
    await execFile(
      'git',
      [
        '-c',
        `user.name=${BOT_IDENTITY.name}`,
        '-c',
        `user.email=${BOT_IDENTITY.email}`,
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '--message',
        message,
      ],
      { cwd },
    );
  }

  const writeGreeting = (text: string) => async (cwd: string) => {
    await writeFile(
      join(cwd, 'src', 'greet.js'),
      `export function greet(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('name must be a non-empty string');
  }
  return \`${text}, \${name.trim()}!\`;
}
`,
    );
    await writeFile(
      join(cwd, 'greet.test.js'),
      `import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { greet } from './src/greet.js';

test('greets a name', () => {
  assert.equal(greet('the operator'), '${text}, the operator!');
});
`,
    );
    await commitIn(cwd, `feat: ${text}`);
  };

  // --- the happy path, twice over ---------------------------------------------

  describe('zwei parallele Aufgaben mit getrennten Claims', () => {
    it('führt beide nacheinander sauber zusammen', async () => {
      const { sandbox, project } = await newSandbox();
      const first = await candidate(project.id, sandbox, {
        title: 'Anrede',
        claimSet: ['src/**', 'greet.test.js'],
        work: writeGreeting('Servus'),
      });
      const second = await candidate(project.id, sandbox, {
        title: 'Doku',
        claimSet: ['README.md'],
        work: async (cwd) => {
          await writeFile(join(cwd, 'README.md'), '# Sandkasten\n\nJetzt mit Anrede.\n');
          await commitIn(cwd, 'docs: README ergänzt');
        },
      });

      // Both are legitimately in flight at once — disjoint claims, §10 permits
      // exactly this — and both reach the queue before either merges.
      await new MergeQueue({
        sql,
        tasks,
        projects,
        claims,
        worktrees,
        eventLog,
        findings,
        escalations,
        gates: () => {
          throw new Error('nicht erreicht');
        },
      }).enqueue(first);
      const { queue: mergeQueue } = queue(sandbox);
      await mergeQueue.enqueue(second);

      expect((await mergeQueue.list(project.id)).map((entry) => entry.taskId)).toEqual([
        first,
        second,
      ]);

      const attempts = await mergeQueue.drain(project.id);
      expect(attempts.map((attempt) => attempt.status)).toEqual([
        'merged',
        'merged',
        // The third pass finds an empty queue, which is how `drain` stops.
        'idle',
      ]);

      expect((await tasks.get(first))?.state).toBe('done');
      expect((await tasks.get(second))?.state).toBe('done');

      // The second candidate rebased onto the first: its merge starts where the
      // first one ended. That is the whole point of serialising the queue.
      expect(attempts[1]?.baseShaBefore).toBe(attempts[0]?.baseShaAfter);

      // And the integration branch really carries both changes.
      const greet = await readFile(join(sandbox.path, 'src', 'greet.js'), 'utf8');
      expect(greet).toContain('Servus');
      const readme = await readFile(join(sandbox.path, 'README.md'), 'utf8');
      expect(readme).toContain('Jetzt mit Anrede');
      // Two full chains plus two gate suites, all of it real work on disk.
    }, 60_000);

    it('gibt Claims und Worktree frei und lässt keinen Branch zurück', async () => {
      const { sandbox, project } = await newSandbox();
      const taskId = await candidate(project.id, sandbox, { work: writeGreeting('Servus') });
      const { queue: mergeQueue } = queue(sandbox);
      await mergeQueue.enqueue(taskId);

      const attempt = await mergeQueue.runOnce(project.id);
      expect(attempt.status).toBe('merged');
      expect(attempt.releasedClaims).toEqual(['greet.test.js', 'src/**']);
      expect(attempt.worktreeRemoved).toBe(true);

      expect(await claims.heldGlobs(taskId)).toEqual([]);
      expect((await tasks.get(taskId))?.worktreePath).toBeNull();
      expect(await branchExists(sandbox.path, `vorschicht/task-${taskId}`)).toBe(false);
      // Only the main worktree is left behind.
      expect(await worktreeList(sandbox.path)).toHaveLength(1);
    });

    it('bringt nur Commits der Bot-Identität auf den Integrationsbranch (A20/A36)', async () => {
      const { sandbox, project } = await newSandbox();
      const taskId = await candidate(project.id, sandbox, { work: writeGreeting('Servus') });
      const { queue: mergeQueue } = queue(sandbox);
      await mergeQueue.enqueue(taskId);

      const attempt = await mergeQueue.runOnce(project.id);
      expect(attempt.commits.length).toBeGreaterThan(0);
      expect(foreignCommits(attempt.commits)).toEqual([]);
      // A fast-forward, so the integration branch tip *is* the candidate tip:
      // no merge commit exists to be authored by anybody.
      expect(await currentBranch(sandbox.path)).toBe(sandbox.defaultBranch);
    });

    it('arbeitet auf dem Integrationsbranch des Projekts, nicht auf "main" (A41/A44.2)', async () => {
      const { sandbox, project } = await newSandbox({ defaultBranch: 'dev' });
      const taskId = await candidate(project.id, sandbox, { work: writeGreeting('Servus') });
      const { queue: mergeQueue } = queue(sandbox);
      await mergeQueue.enqueue(taskId);

      expect((await mergeQueue.runOnce(project.id)).status).toBe('merged');
      expect(await currentBranch(sandbox.path)).toBe('dev');
      expect(await branchExists(sandbox.path, 'main')).toBe(false);
    });
  });

  // --- the seeded-failure suite (§22, Phase 2) ----------------------------------

  describe('gesäte Fehler blockieren den Merge einzeln', () => {
    /**
     * The defect arrives *on the candidate branch*, not in the base commit.
     *
     * A seed in the initial commit would already be on the integration branch,
     * which makes "the gate blocked the merge" a statement about the repository
     * rather than about the change under test — and would hide the difference
     * between a scan of the tree and a scan of the diff.
     */
    async function blockedBy(
      seed: 'failing_test' | 'planted_secret' | 'lint_error',
      secrets?: SecretScanner,
    ) {
      const { sandbox, project } = await newSandbox();
      const taskId = await candidate(project.id, sandbox, {
        claimSet: ['src/**', 'greet.test.js'],
        work: async (cwd) => {
          await writeGreeting('Servus')(cwd);
          await plantSeed(cwd, seed);
          await commitIn(cwd, `chore: ${seed}`);
        },
      });
      const built = queue(sandbox, secrets ? { secrets } : {});
      await built.queue.enqueue(taskId);
      const attempt = await built.queue.runOnce(project.id);
      return { attempt, taskId, sandbox, project, warnings: built.warnings };
    }

    it('ein fehlschlagender Test', async () => {
      const { attempt, taskId, sandbox } = await blockedBy('failing_test');
      expect(attempt.status).toBe('red');
      expect(attempt.gates?.findings.map((step) => step.id)).toContain('test');
      // §9: the first failure requeues rather than escalating.
      expect((await tasks.get(taskId))?.state).toBe('queued');
      // And nothing reached the integration branch.
      const greet = await readFile(join(sandbox.path, 'src', 'greet.js'), 'utf8');
      expect(greet).toContain('Hallo');
    });

    it('ein Lint-Verstoß', async () => {
      const { attempt } = await blockedBy('lint_error');
      expect(attempt.status).toBe('red');
      expect(attempt.gates?.findings.map((step) => step.id)).toContain('lint');
    });

    it('ein eingeschmuggeltes Geheimnis — mit echtem gitleaks', async () => {
      const { attempt } = await blockedBy('planted_secret', new AutoSecretScanner());
      // A docker-less machine reports infra, and that must not read as clean.
      if (attempt.gates?.infra.some((step) => step.id === 'secrets')) {
        expect(attempt.status).toBe('infra');
        throw new Error(
          'gitleaks konnte nicht laufen (Docker) — dieser Gate-Nachweis braucht Docker.',
        );
      }
      expect(attempt.status).toBe('red');
      expect(attempt.gates?.findings.map((step) => step.id)).toContain('secrets');
    }, 180_000);

    it('und derselbe Kandidat merged, sobald der Fehler behoben ist', async () => {
      const { sandbox, project } = await newSandbox();
      const taskId = await candidate(project.id, sandbox, {
        work: async (cwd) => {
          await writeGreeting('Servus')(cwd);
          await plantSeed(cwd, 'failing_test');
          await commitIn(cwd, 'chore: kaputter Test');
        },
      });
      const { queue: mergeQueue } = queue(sandbox);
      await mergeQueue.enqueue(taskId);
      expect((await mergeQueue.runOnce(project.id)).status).toBe('red');

      // The fix, on the same branch and through the same chain — §9 sends a red
      // task back to planning, so the second pass is a full chain run.
      const fixed = await candidateContinues(taskId, sandbox);
      expect(fixed).toBe('gates');
      await mergeQueue.enqueue(taskId);
      const attempt = await mergeQueue.runOnce(project.id);
      expect(attempt.status).toBe('merged');
      expect((await tasks.get(taskId))?.state).toBe('done');
    });

    /**
     * An *optional* gate blocking a real merge, end to end (§22, Phase 3).
     *
     * `sandbox-gates.test.ts` proves each of the six optional command gates goes
     * red on a violation of its own class and green again after the fix — but it
     * proves it at the suite, which is one layer below the sentence the exit
     * gate uses ("blocks a seeded violation"). This is that sentence: the seed
     * arrives on the candidate branch, the queue refuses the merge, the
     * integration branch does not move, §9 requeues the task, and the same
     * candidate merges once the violation is gone.
     *
     * One gate rather than six, deliberately: what is being demonstrated here is
     * the *chain* from a gate finding to a refused merge, and that chain does not
     * know which gate produced the finding. The per-gate substance lives where
     * the per-gate checkers do.
     */
    it('ein angehaktes optionales Gate blockiert den Merge und lässt ihn nach der Behebung durch', async () => {
      const { sandbox, project } = await newSandbox();
      const taskId = await candidate(project.id, sandbox, {
        claimSet: ['src/**', 'greet.test.js'],
        work: async (cwd) => {
          await writeGreeting('Servus')(cwd);
          await plantSeed(cwd, 'sast_finding');
          await commitIn(cwd, 'chore: eval eingeschleppt');
        },
      });
      const { queue: mergeQueue } = queue(sandbox, { gates: { sast: true } });
      await mergeQueue.enqueue(taskId);

      const blocked = await mergeQueue.runOnce(project.id);
      expect(blocked.status).toBe('red');
      expect(blocked.gates?.findings.map((step) => step.id)).toEqual(['sast']);
      // Nothing moved: the integration branch is where it was, and §9 requeues
      // rather than escalating on a first failure.
      expect(blocked.baseShaAfter).toBe(blocked.baseShaBefore);
      expect((await tasks.get(taskId))?.state).toBe('queued');

      const fixed = await candidateContinues(taskId, sandbox, async (cwd) => {
        await repairSeed(cwd, 'sast_finding');
        await commitIn(cwd, 'fix: eval entfernt');
      });
      expect(fixed).toBe('gates');
      await mergeQueue.enqueue(taskId);
      expect((await mergeQueue.runOnce(project.id)).status).toBe('merged');
      expect((await tasks.get(taskId))?.state).toBe('done');
    }, 180_000);

    /** Second pass of the chain over a requeued task, with the defect removed. */
    async function candidateContinues(
      taskId: string,
      sandbox: SandboxProject,
      work?: (cwd: string) => Promise<void>,
    ) {
      const backend = new FakeBackend(async (spec) => {
        if (spec.role === 'coder') {
          if (work) await work(spec.cwd);
          else {
            await writeGreeting('Servus')(spec.cwd);
            await commitIn(spec.cwd, 'fix: Test wieder grün');
          }
        }
        const map: Record<string, FakeScript> = {
          planner: script(PLAN),
          coder: script(CODED),
          reviewer: script(APPROVED),
        };
        const found = map[spec.role];
        if (!found) throw new Error(`Kein Skript für "${spec.role}"`);
        return found;
      });
      const chain = new DevChain({
        tasks,
        projects,
        claims,
        worktrees,
        runner: new AgentRunner({ sql, eventLog, backend, paths }),
        runs: new RunRecords(sql),
        eventLog,
        findings,
        escalations,
        gateTools: () => sandbox.tools,
        sleep: async () => undefined,
      });
      await chain.run(taskId);
      return (await tasks.get(taskId))?.state;
    }
  });

  // --- §11's migration gate (A63) ----------------------------------------------

  /**
   * The one gate that spends a model session, end to end through the real
   * `AgentMigrationReviewer` and the real `AgentRunner`.
   *
   * Only Milo's *judgement* is scripted; everything between it and the merge
   * decision is the production path — the profile, the session spec, the
   * contract validation, the event-log row §12/A24 will read. A stub
   * `MigrationReviewer` would have proven that the gate suite calls a stub, and
   * the two cases worth having here are exactly the ones a stub cannot reach:
   * that the result really passes the `migration_review` contract, and that a
   * non-backward-compatible migration merges *and* leaves a trace.
   */
  describe('Migrationsprüfung (§11, §12/A24)', () => {
    function reviewerAnswering(raw: unknown) {
      const specs: string[] = [];
      const backend = new FakeBackend(async (spec) => {
        specs.push(spec.role);
        return script(raw);
      });
      return {
        specs,
        reviewer: new AgentMigrationReviewer({
          runner: new AgentRunner({ sql, eventLog, backend, paths }),
          eventLog,
        }),
      };
    }

    const REVIEW = {
      status: 'done',
      summary: 'Additive Spalte mit Gegenmigration.',
      artifacts: [],
      followups: [],
      verdict: 'approve',
      backwardCompatible: true,
      reversibility: 'reversible',
      migrations: ['migrations/0002_greeting.sql'],
      findings: [],
    };

    /** A candidate whose diff carries the named migration seed. */
    async function migrationCandidate(seed: 'bad_migration' | 'safe_migration') {
      const { sandbox, project } = await newSandbox();
      const taskId = await candidate(project.id, sandbox, {
        claimSet: ['src/**', 'greet.test.js', 'migrations/**'],
        work: async (cwd) => {
          await writeGreeting('Servus')(cwd);
          await plantSeed(cwd, seed);
          await commitIn(cwd, `feat: ${seed}`);
        },
      });
      return { sandbox, project, taskId };
    }

    async function reviewRows(taskId: string) {
      return sql<Array<{ payload: Record<string, unknown> }>>`
        SELECT payload FROM event_log
        WHERE kind = 'gate.migration_review' AND task_id = ${taskId}
        ORDER BY id
      `;
    }

    it('blockiert eine Migration, an der Milo Nachbesserung verlangt', async () => {
      const { sandbox, project, taskId } = await migrationCandidate('bad_migration');
      const { specs, reviewer } = reviewerAnswering({
        ...REVIEW,
        summary: 'DROP COLUMN, die laufende Version liest die Spalte noch.',
        verdict: 'changes_requested',
        backwardCompatible: false,
        findings: [
          {
            file: 'migrations/0002_greeting.sql',
            line: 1,
            severity: 'blocker',
            summary: 'Erst die Leser umstellen, dann die Spalte entfernen.',
          },
        ],
      });
      const built = queue(sandbox, {
        gates: { 'migration-review': true },
        migrationReview: reviewer,
      });
      await built.queue.enqueue(taskId);
      const attempt = await built.queue.runOnce(project.id);

      expect(attempt.status).toBe('red');
      expect(attempt.gates?.findings.map((step) => step.id)).toContain('migration-review');
      // The session that ran was the read-only profile, not the writing one.
      expect(specs).toEqual(['db-review']);
      // Nothing reached the integration branch.
      expect(attempt.baseShaAfter).toBe(attempt.baseShaBefore);
      expect((await tasks.get(taskId))?.state).toBe('queued');
    });

    it('lässt eine geprüfte Migration durch und protokolliert das Urteil', async () => {
      const { sandbox, project, taskId } = await migrationCandidate('safe_migration');
      const { reviewer } = reviewerAnswering(REVIEW);
      const built = queue(sandbox, {
        gates: { 'migration-review': true },
        migrationReview: reviewer,
      });
      await built.queue.enqueue(taskId);
      expect((await built.queue.runOnce(project.id)).status).toBe('merged');

      const [row] = await reviewRows(taskId);
      expect(row?.payload.verdict).toBe('approve');
      expect(row?.payload.backwardCompatible).toBe(true);
      expect(row?.payload.reviewed).toEqual(['migrations/0002_greeting.sql']);
    });

    /**
     * §12/A24, and the reason `backwardCompatible` is an observation rather than
     * a verdict: the change merges, and the *deploy* is what stops. Asserted in
     * both halves, because either one alone would be satisfiable by a mistake —
     * a merge with no record, or a record with no merge.
     */
    it('führt eine nicht rückwärtskompatible Migration zusammen und hinterlässt die Warnung', async () => {
      const { sandbox, project, taskId } = await migrationCandidate('bad_migration');
      const { reviewer } = reviewerAnswering({
        ...REVIEW,
        summary: 'Bewusster Contract-Schritt; die alten Leser sind bereits weg.',
        backwardCompatible: false,
      });
      const built = queue(sandbox, {
        gates: { 'migration-review': true },
        migrationReview: reviewer,
      });
      await built.queue.enqueue(taskId);
      const attempt = await built.queue.runOnce(project.id);

      expect(attempt.status).toBe('merged');
      const step = attempt.gates?.steps.find((entry) => entry.id === 'migration-review');
      expect(step?.verdict).toBe('green');
      expect(step?.detail).toContain('§12/A24');

      const [row] = await reviewRows(taskId);
      expect(row?.payload.backwardCompatible).toBe(false);
    });

    it('gibt für einen Kandidaten ohne Migration kein Budget aus', async () => {
      const { sandbox, project } = await newSandbox();
      const taskId = await candidate(project.id, sandbox, {
        work: async (cwd) => {
          await writeGreeting('Servus')(cwd);
          await commitIn(cwd, 'feat: nur Code');
        },
      });
      const { specs, reviewer } = reviewerAnswering(REVIEW);
      const built = queue(sandbox, {
        gates: { 'migration-review': true },
        migrationReview: reviewer,
      });
      await built.queue.enqueue(taskId);
      expect((await built.queue.runOnce(project.id)).status).toBe('merged');
      expect(specs).toEqual([]);
      expect(await reviewRows(taskId)).toHaveLength(0);
    });
  });

  // --- the checks that are the queue's own -------------------------------------

  describe('§11.6 — kein Merge ohne Peer-Review', () => {
    it('blockiert eine Aufgabe, die den Review-Zustand ohne Review erreicht hat', async () => {
      const { sandbox, project } = await newSandbox();
      // Straight through §9's states with the orchestrator as actor throughout —
      // exactly the route a future scheduler defect would take.
      const task = await tasks.create({ projectId: project.id, title: 'Ohne Review' });
      await worktrees.ensure(task.id);
      await tasks.transition(task.id, 'planning', { actor: 'orchestrator' });
      await claims.register(task.id, ['src/**']);
      await claims.acquire(task.id);
      await tasks.transition(task.id, 'coding', { actor: 'orchestrator' });
      await tasks.transition(task.id, 'review', { actor: 'orchestrator' });
      await tasks.transition(task.id, 'gates', { actor: 'orchestrator' });

      const { queue: mergeQueue } = queue(sandbox);
      await mergeQueue.enqueue(task.id);
      const attempt = await mergeQueue.runOnce(project.id);

      expect(attempt.status).toBe('red');
      expect(attempt.gates?.findings.map((step) => step.id)).toContain('review');
      expect(attempt.gates?.findings.find((step) => step.id === 'review')?.detail).toContain(
        'orchestrator',
      );
    });
  });

  describe('Reihenfolge und Serialisierung (§10)', () => {
    it('nimmt den dringlicheren Kandidaten zuerst, bei gleicher Priorität den älteren', async () => {
      const { sandbox, project } = await newSandbox();
      const late = await candidate(project.id, sandbox, {
        title: 'P1, früh eingereiht',
        priority: 'P1',
        claimSet: ['src/**', 'greet.test.js'],
        work: writeGreeting('Servus'),
      });
      const urgent = await candidate(project.id, sandbox, {
        title: 'P0, später eingereiht',
        priority: 'P0',
        claimSet: ['README.md'],
        work: async (cwd) => {
          await writeFile(join(cwd, 'README.md'), '# Dringend\n');
          await commitIn(cwd, 'docs: dringend');
        },
      });

      const { queue: mergeQueue } = queue(sandbox);
      await mergeQueue.enqueue(late);
      await mergeQueue.enqueue(urgent);
      expect((await mergeQueue.list(project.id)).map((entry) => entry.taskId)).toEqual([
        urgent,
        late,
      ]);
    });

    it('meldet "busy", solange ein anderer Arbeiter das Projekt zusammenführt', async () => {
      const { sandbox, project } = await newSandbox();
      const taskId = await candidate(project.id, sandbox, { work: writeGreeting('Servus') });
      const { queue: mergeQueue } = queue(sandbox);
      await mergeQueue.enqueue(taskId);

      // Held from outside, exactly as the claim registry's lock is proven: two
      // `runOnce` calls under `Promise.all` would pass with the lock removed.
      const holder = await sql.reserve();
      try {
        await holder`SELECT pg_advisory_lock(${MERGE_LOCK_NAMESPACE}, hashtext(${project.id}))`;
        const attempt = await mergeQueue.runOnce(project.id);
        expect(attempt.status).toBe('busy');
        expect((await tasks.get(taskId))?.state).toBe('merge_queue');
      } finally {
        await holder`SELECT pg_advisory_unlock(${MERGE_LOCK_NAMESPACE}, hashtext(${project.id}))`;
        await holder.release();
      }

      // And the lock is genuinely released afterwards, in both directions.
      expect((await mergeQueue.runOnce(project.id)).status).toBe('merged');
    });

    it('meldet "idle" bei leerer Warteschlange', async () => {
      const { sandbox, project } = await newSandbox();
      const { queue: mergeQueue } = queue(sandbox);
      expect((await mergeQueue.runOnce(project.id)).status).toBe('idle');
    });
  });

  describe('Rebase (§10)', () => {
    it('setzt den Kandidaten auf den aktuellen Integrationsbranch auf', async () => {
      const { sandbox, project } = await newSandbox();
      const first = await candidate(project.id, sandbox, {
        claimSet: ['src/**', 'greet.test.js'],
        work: writeGreeting('Servus'),
      });
      const second = await candidate(project.id, sandbox, {
        claimSet: ['CHANGELOG.md'],
        work: async (cwd) => {
          await writeFile(join(cwd, 'CHANGELOG.md'), '# Änderungen\n');
          await commitIn(cwd, 'docs: Changelog');
        },
      });

      const { queue: mergeQueue } = queue(sandbox);
      await mergeQueue.enqueue(first);
      await mergeQueue.enqueue(second);
      await mergeQueue.runOnce(project.id);
      const attempt = await mergeQueue.runOnce(project.id);

      expect(attempt.status).toBe('merged');
      // The second candidate's commit sits on top of the first's, which only
      // holds if the rebase really happened: the branch was cut before it.
      expect(attempt.commits).toHaveLength(1);
      expect(attempt.commits[0]?.subject).toBe('docs: Changelog');
    });

    /**
     * A conflict cannot be produced through the chain, and that is the point.
     *
     * §10's claims make two tasks that touch one file impossible to run
     * concurrently, so the ordinary route never yields a rebase conflict — which
     * is exactly the reason to construct one by hand rather than to conclude the
     * case cannot happen. It can: a task parked across a budget window (§7.3) or
     * requeued by §9's red path keeps its branch while the integration branch
     * moves on for days, and its claim set is only re-checked against the tasks
     * that hold claims *now*, never against what has already merged.
     *
     * So the candidate below is assembled from the same primitives the chain
     * uses — worktree manager, claim registry, `reviewer` as the actor on the
     * `gates` edge — with its branch cut before the first merge and its content
     * colliding with what that merge brought in.
     */
    it('führt einen Konflikt über den roten Pfad und lässt keinen Rebase offen', async () => {
      const { sandbox, project } = await newSandbox();
      const first = await candidate(project.id, sandbox, {
        claimSet: ['src/**', 'greet.test.js'],
        work: writeGreeting('Servus'),
      });

      // Cut from the old base, while the first candidate still holds `src/**`.
      const stale = await tasks.create({ projectId: project.id, title: 'Lange geparkt' });
      const worktree = await worktrees.ensure(stale.id);
      await writeGreeting('Grüß Gott')(worktree.path);

      const { queue: mergeQueue } = queue(sandbox);
      await mergeQueue.enqueue(first);
      await mergeQueue.runOnce(project.id);

      // Only now — with the claims released by the merge — does the stale task
      // take them and reach the queue.
      await tasks.transition(stale.id, 'planning', { actor: 'orchestrator' });
      await claims.register(stale.id, ['src/**', 'greet.test.js']);
      await claims.acquire(stale.id);
      await tasks.transition(stale.id, 'coding', { actor: 'orchestrator' });
      await tasks.transition(stale.id, 'review', { actor: 'orchestrator' });
      await tasks.transition(stale.id, 'gates', { actor: 'reviewer' });

      const clashing = stale.id;
      await mergeQueue.enqueue(clashing);
      const attempt = await mergeQueue.runOnce(project.id);

      expect(attempt.status).toBe('red');
      expect(attempt.problem).toContain('Rebase');
      // The worktree is usable again — a half-finished rebase would strand it.
      const task = await tasks.get(clashing);
      const { stdout } = await execFile('git', ['status', '--porcelain=v1'], {
        cwd: task?.worktreePath as string,
      });
      expect(stdout.trim()).toBe('');
    });
  });

  describe('A25 — was nicht geprüft werden konnte, ist nicht rot', () => {
    it('stellt den Kandidaten zurück und lässt die Aufgabe in der Warteschlange', async () => {
      const { sandbox, project } = await newSandbox();
      const taskId = await candidate(project.id, sandbox, { work: writeGreeting('Servus') });
      const built = queue(sandbox, {
        secrets: {
          scan: async () => ({
            verdict: 'infra',
            detail: 'Docker nicht erreichbar',
            output: '',
            findings: [],
          }),
        },
      });
      await built.queue.enqueue(taskId);
      const attempt = await built.queue.runOnce(project.id);

      expect(attempt.status).toBe('infra');
      expect((await tasks.get(taskId))?.state).toBe('merge_queue');
      // Never coloured, and never merged.
      expect((await tasks.get(taskId))?.retryCount).toBe(0);
      expect(built.warnings.join('\n')).toContain('Docker');

      // The retry ran inside the suite before the candidate was put back: three
      // executions of the secrets gate, one merge attempt. That is the
      // granularity §22's step 3 asks for, seen from the outside.
      const secrets = attempt.gates?.steps.find((step) => step.id === 'secrets');
      expect(secrets?.attempts).toBe(3);
      expect(secrets?.retries).toHaveLength(2);

      // A25's retry: the next attempt succeeds once the machine is back.
      const { queue: recovered } = queue(sandbox);
      expect((await recovered.runOnce(project.id)).status).toBe('merged');
    });

    /**
     * §22's Phase 3 exit gate, both halves in one place: *"a simulated
     * registry/network outage retries with backoff and never marks the task
     * red; a real test failure still does"*.
     *
     * The outage is simulated at the seam the real thing fails at — the secrets
     * scanner reports the same `infra` verdict `GitleaksSecretScanner` returns
     * when `docker info` cannot be reached — and it is made to *persist*, which
     * is the case A25's second half is about: the retry did not help, the task
     * is still not red, and somebody has to be told, because nothing in this
     * project will move again until a machine comes back.
     */
    it('meldet einen anhaltenden Infrastrukturfehler genau einmal an Ops, ohne rot zu werden', async () => {
      const { sandbox, project } = await newSandbox();
      const taskId = await candidate(project.id, sandbox, { work: writeGreeting('Grüß dich') });
      const built = queue(sandbox, {
        secrets: {
          scan: async () => ({
            verdict: 'infra',
            detail: 'Docker nicht erreichbar (simulierter Registry-Ausfall)',
            output: '',
            findings: [],
          }),
        },
      });
      await built.queue.enqueue(taskId);

      for (let attempt = 1; attempt <= OPS_ALERT_AFTER_INFRA_ATTEMPTS + 1; attempt += 1) {
        expect((await built.queue.runOnce(project.id)).status).toBe('infra');
        // The alert crosses the threshold and does not keep crossing it. A
        // channel that pushes on every tick for as long as a machine is down is
        // a channel that gets muted, and then the next real alert is invisible.
        expect(built.opsAlerts).toHaveLength(attempt < OPS_ALERT_AFTER_INFRA_ATTEMPTS ? 0 : 1);
      }

      const [alert] = built.opsAlerts;
      expect(alert?.taskId).toBe(taskId);
      expect(alert?.attempts).toBe(OPS_ALERT_AFTER_INFRA_ATTEMPTS);
      expect(alert?.problem).toContain('Registry-Ausfall');

      // Recorded as well as pushed: a notification is best-effort (`Notifier`
      // never throws into a caller), so the durable half has to be the log.
      const [row] = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM event_log WHERE kind = 'ops.alert' AND task_id = ${taskId}
      `;
      expect(row?.n).toBe(1);

      // The half the exit gate names first: never red, never escalated, never
      // requeued at a lower priority. Read from the whole lifecycle rather than
      // from the current state, because §9's red path passes *through* `red`.
      const coloured = await sql<Array<{ state: string }>>`
        SELECT DISTINCT state FROM task_events
        WHERE task_id = ${taskId} AND state IN ('red', 'escalated')
      `;
      expect(coloured).toEqual([]);
      const task = await tasks.get(taskId);
      expect(task?.state).toBe('merge_queue');
      expect(task?.retryCount).toBe(0);

      // …and the counterweight, on the same candidate, with the machine back:
      // a real failure of the project's own test command still goes red. Same
      // task, same project, same queue — the only thing that changed is what
      // failed. Without this half the assertions above would pass just as
      // happily against a queue that never colours anything at all.
      await plantSeed(task?.worktreePath as string, 'failing_test');
      await commitIn(task?.worktreePath as string, 'chore: ein Test, der nicht hält');
      const real = queue(sandbox);
      const attempt = await real.queue.runOnce(project.id);
      expect(attempt.status).toBe('red');
      expect(attempt.gates?.findings.map((step) => step.id)).toContain('test');
      expect((await tasks.get(taskId))?.retryCount).toBe(1);
      expect(real.opsAlerts).toEqual([]);
      // No explicit timeout, deliberately: five gate suites over a real git
      // repository plus a real `node --test` take ~4.3 s alone, and this test
      // is what first exceeded vitest's 5 s default under a parallel run. It
      // now rides on `vitest.setup.ts`'s file-level rule instead — which means
      // that if the rule ever stops applying, this goes red along with the two
      // tests that assert it directly, rather than only they do.
    });
  });

  describe('Grenzen, die kein Fehlschlag sind', () => {
    it('verweigert ein Projekt mit Deploy-Methode, für die kein Ziel registriert ist (§12)', async () => {
      const { sandbox, project } = await newSandbox();
      await setDeployConfig(project.id, { method: 'compose' });
      // No `deployableMethods`, which is the default and the fail-closed
      // direction: a studio whose wiring never handed the registry over refuses
      // rather than merging code nothing can roll out (A55.6).
      const { queue: mergeQueue } = queue(sandbox);
      await expect(mergeQueue.runOnce(project.id)).rejects.toThrow(MergeQueueError);
      await expect(mergeQueue.runOnce(project.id)).rejects.toThrow(/kein Deploy-Ziel/);
    });

    it('verweigert auch eine Methode, für die ein *anderes* Ziel registriert ist', async () => {
      const { sandbox, project } = await newSandbox();
      await setDeployConfig(project.id, { method: 'static-rsync' });
      // The registry is asked for *this* method, not for whether any target
      // exists at all — otherwise one working target would open the door for
      // every method the configuration can name.
      const { queue: mergeQueue } = queue(sandbox, { deployableMethods: ['compose'] });
      await expect(mergeQueue.runOnce(project.id)).rejects.toThrow(/static-rsync/);
    });
  });

  /**
   * §12's handover: what a green merge does when the project can be rolled out.
   *
   * The engine's own behaviour is `deploy/service.itest.ts`'s subject. What is
   * asserted here is only the seam — the state a merge ends in, and the commit
   * the rollout will be given — because a merge that ended at `done` for a
   * deployable project would leave production behind `main` with a task that
   * reads as finished, and nothing in the engine could notice.
   */
  describe('§12 — der Übergang an die Deploy-Maschine', () => {
    it('endet bei `deploying` statt bei `done`, wenn die Methode ein Ziel hat', async () => {
      const { sandbox, project } = await newSandbox();
      await setDeployConfig(project.id, { method: 'compose' });
      const taskId = await candidate(project.id, sandbox, {
        title: 'Mit Rollout',
        work: writeGreeting('Servus'),
      });

      const { queue: mergeQueue } = queue(sandbox, { deployableMethods: ['compose'] });
      await mergeQueue.enqueue(taskId);
      const attempt = await mergeQueue.runOnce(project.id);

      expect(attempt.status).toBe('merged');
      expect(attempt.deployMethod).toBe('compose');
      expect((await tasks.get(taskId))?.state).toBe('deploying');

      // The commit the rollout will be handed, read the way the scheduler reads
      // it. Without this the merge would have to be trusted to have written it,
      // and the field the engine used to derive instead (`task.branch`) is NULL
      // by now — the worktree was released two lines above this assertion.
      expect(await taskDeployHandover(sql).mergedSha(taskId)).toBe(attempt.baseShaAfter);
      expect((await tasks.get(taskId))?.branch).toBeNull();
    });

    /**
     * §22s Phase-5-Gate G8: *release history complete and consistent with git*.
     *
     * Geprüft wird die Historie, die die Strecke darüber **selbst erzeugt hat**,
     * nicht eine gesäte. Das ist der Unterschied, auf den es hier ankommt: eine
     * Fixture, die shas einträgt, prüft `auditReleaseHistory`; eine Historie
     * aus einem echten Merge prüft die Aussage des Gates — dass das, was §12
     * aufzeichnet, im Repository als Stand existiert.
     *
     * Und die Gegenrichtung im selben Fall, weil eine Prüfung, die nur „grün"
     * sagen kann, nichts sagt: zwei erfundene Datensätze müssen als
     * `unknown_commit` und `not_on_branch` auffallen.
     */
    it('bestätigt die selbst erzeugte Historie gegen git — und findet erfundene (§22 G8)', async () => {
      const { sandbox, project } = await newSandbox();
      await setDeployConfig(project.id, {
        method: 'compose',
        composeFiles: ['docker-compose.yml'],
        service: 'app',
        healthUrl: 'https://example.test/healthz',
        healthTimeoutMs: 1_000,
        healthIntervalMs: 250,
        keep: 2,
      });
      const taskId = await candidate(project.id, sandbox, {
        title: 'Historie',
        work: writeGreeting('Servus'),
      });
      const { queue: mergeQueue } = queue(sandbox, { deployableMethods: ['compose'] });
      await mergeQueue.enqueue(taskId);
      const attempt = await mergeQueue.runOnce(project.id);
      expect(attempt.status).toBe('merged');

      const records = new DeployRecords(sql);
      const engine = new DeployService({
        sql,
        records,
        eventLog,
        tasks,
        escalations,
        targets: new Map([['compose', new FakeDeployTarget()]]),
        guardianState: async () => 'normal',
        health: async () => ({ ok: true, detail: 'HTTP 200' }),
        run: async () => ({ ok: true, code: 0, output: '' }),
      });
      const sha = attempt.baseShaAfter;
      expect(sha).toBeTruthy();
      // Neu gelesen: `newSandbox()` hat den Datensatz **vor** `setDeployConfig`
      // erzeugt, und die Maschine liest ihre Methode aus dem übergebenen
      // Objekt. Die Strecke in G1 liest ihn über den Ablaufplaner ohnehin neu;
      // ein Direktaufruf muss es selbst tun, sonst meldet er `unsupported` und
      // der Test prüft den Zweig daneben.
      const aktuell = muss(await projects.get(project.id), 'das Projekt');
      const rollout = await engine.deploy(
        muss(await tasks.get(taskId), 'die Aufgabe'),
        aktuell,
        muss(sha, 'die sha des Merges'),
      );
      expect(rollout.outcome).toBe('deployed');

      const sauber = await auditReleaseHistory(project.id, {
        repo: sandbox.path,
        branch: sandbox.defaultBranch,
        releases: await records.forProject(project.id),
      });
      expect(sauber.checked).toBe(1);
      expect(sauber.problems).toEqual([]);
      expect(sauber.ok).toBe(true);

      // Die Gegenrichtung, mit **beiden** Befunden und einem echten Commit für
      // den zweiten. Ein Seitenzweig ist genau die Verwechslung, die
      // `not_on_branch` fangen soll: der Commit existiert, git löst ihn auf,
      // und ausgeliefert wäre Code, den nie ein Merge auf den Zielzweig
      // gebracht hat.
      const [echt] = await records.forProject(project.id);
      await execFile('git', ['checkout', '-q', '-b', 'abseits'], { cwd: sandbox.path });
      await writeFile(join(sandbox.path, 'abseits.txt'), 'nie zusammengeführt\n', 'utf8');
      await execFile('git', ['add', 'abseits.txt'], { cwd: sandbox.path });
      await execFile('git', ['commit', '-q', '-m', 'nicht auf dem Zweig'], { cwd: sandbox.path });
      const { stdout: seite } = await execFile('git', ['rev-parse', 'HEAD'], {
        cwd: sandbox.path,
      });
      await execFile('git', ['checkout', '-q', sandbox.defaultBranch], { cwd: sandbox.path });

      const kaputt = await auditReleaseHistory(project.id, {
        repo: sandbox.path,
        branch: sandbox.defaultBranch,
        releases: [
          muss(echt, 'das echte Release'),
          { ...muss(echt, 'das echte Release'), id: 'erfunden', sha: 'a'.repeat(40) },
          { ...muss(echt, 'das echte Release'), id: 'abseitig', sha: seite.trim() },
        ],
      });
      expect(kaputt.ok).toBe(false);
      expect(kaputt.problems.map((problem) => problem.kind)).toEqual([
        'unknown_commit',
        'not_on_branch',
      ]);
      expect(kaputt.problems[0]?.detail).toContain('kennt diesen Commit nicht');
      expect(kaputt.problems[1]?.detail).toContain('nie zusammengeführt wurde');
      // Und der echte Datensatz daneben bleibt unbeanstandet — eine Prüfung,
      // die bei einem Fund alles rot färbt, sagt nichts über den Rest.
      expect(kaputt.checked).toBe(3);
    });

    it('meldet ein Repository, das gar nicht lesbar ist, statt grün zu sagen (§22 G8)', async () => {
      // A83.6s fail-closed: „wir konnten nicht nachsehen" und „es stimmt" sind
      // derselbe Satz nur für ein System, das sich entschieden hat, nicht
      // hinzusehen.
      const ergebnis = await auditReleaseHistory('egal', {
        repo: join(scratch, 'gibt-es-nicht'),
        branch: 'main',
        releases: [],
      });
      expect(ergebnis.ok).toBe(false);
      expect(ergebnis.problems.map((problem) => problem.kind)).toEqual(['unreadable_repo']);
      expect(ergebnis.checked).toBe(0);
      // Auf den **Satz**, nicht nur auf die Art: „kein Repository" und „der
      // Zweig fehlt" sind beide `unreadable_repo`, und die Mutation, die die
      // erste Prüfung entfernt, fällt dann in die zweite und bleibt grün. Genau
      // das ist passiert, als diese Zusicherung nur die Art las. Zwei Schichten
      // sind nur dann zwei, wenn ein Test sie auseinanderhalten kann (A77.4).
      expect(ergebnis.problems[0]?.detail).toContain('kein lesbares git-Repository');
    });

    it('endet bei `done`, wenn kein Deployment konfiguriert ist (A24)', async () => {
      const { sandbox, project } = await newSandbox();
      const taskId = await candidate(project.id, sandbox, {
        title: 'Ohne Rollout',
        work: writeGreeting('Moin'),
      });

      const { queue: mergeQueue } = queue(sandbox, { deployableMethods: ['compose'] });
      await mergeQueue.enqueue(taskId);
      const attempt = await mergeQueue.runOnce(project.id);

      // A registered target changes nothing for a project that has said it
      // deploys nothing: §12 ends that pipeline at the merge, and `deployMethod`
      // says which of the two happened rather than leaving a reader to infer it
      // from a state.
      expect(attempt.deployMethod).toBe('none');
      expect((await tasks.get(taskId))?.state).toBe('done');
      expect(await taskDeployHandover(sql).mergedSha(taskId)).toBeNull();
    });

    it('nimmt eine unlesbare Deploy-Konfiguration nicht als „kein Deployment"', async () => {
      const { sandbox, project } = await newSandbox();
      // A `compose` document with no service and no health URL. `readDeployConfig`
      // answers `none` for it — the safe direction *for the engine* — and taking
      // that answer here would merge it and end at `done`, with production
      // behind `main` and nothing on the timeline saying so.
      await setDeployConfig(project.id, { method: 'compose' });
      const { queue: mergeQueue } = queue(sandbox, { deployableMethods: ['compose'] });
      const taskId = await candidate(project.id, sandbox, {
        title: 'Halb konfiguriert',
        work: writeGreeting('Hallo'),
      });
      await mergeQueue.enqueue(taskId);
      const attempt = await mergeQueue.runOnce(project.id);

      expect(attempt.deployMethod).toBe('compose');
      expect((await tasks.get(taskId))?.state).toBe('deploying');
    });
  });

  /**
   * §22's Phase 5 gate: "a project configured `deploy: none` ends its pipeline
   * at merge with a correct terminal state".
   *
   * The two cases above are statements about the *queue*, and the queue is one
   * component. The gate says **pipeline**, and a pipeline has a driver: the tick
   * is what asks the queue to merge and what asks §12's engine to roll out, so
   * "ends at merge" is only established once the same passes that carried the
   * task to `done` also declined to deploy it.
   *
   * The absence is the load-bearing half, which is why the engine here is the
   * real `DeployService` rather than a stub that counts calls. Handed a `none`
   * project it answers `unsupported`, the tick quarantines the task as a
   * dispatcher defect (A57.4) — and the task would *still* read `done`, so a
   * test that only looked at the end state could not tell the two apart.
   */
  describe('§22 — die Strecken durch den Ablaufplaner, mit und ohne Deployment', () => {
    /**
     * §22s Phase-5-Gate G1, als **Strecke**: grüner Merge → automatischer
     * Rollout → Gesundheit grün → Release aufgezeichnet.
     *
     * Der Fall darüber fährt dieselbe Strecke für A24s `none` und endet am
     * Merge. Dies ist die andere Hälfte, und sie ist die, um die es geht: jedes
     * Glied war einzeln bewiesen — der Merge übergibt (weiter oben), die
     * Maschine rollt aus (`deploy/service.itest.ts`), der Ablaufplaner verteilt
     * (`build-scheduler.itest.ts`) —, und keines dieser Glieder ist der Satz des
     * Gates. Die Übergabe war dort jeweils **nachgebaut**: `deployingTask()`
     * schreibt die Zustandswechsel von Hand, samt `baseShaAfter`. Eine
     * nachgebaute Übergabe beweist, dass die Maschine liest, was der Test
     * schreibt — nicht, dass sie liest, was der Merge schreibt.
     *
     * Hier schreibt der echte `MergeQueue` sie, und der echte `Scheduler` reicht
     * sie an die echte `DeployService` weiter.
     */
    it('fährt einen grünen Merge bis zum aufgezeichneten Release durch (§12)', async () => {
      const { sandbox, project } = await newSandbox();
      // Vollständig, nicht bloß `method`: ein `compose`-Dokument ohne Dienst und
      // ohne Gesundheits-URL liest `readDeployConfig` als `none` (der Fall
      // weiter unten hält genau das fest), und der Rollout hieße dann
      // `unsupported`. Die Fixture muss die Konfiguration sein, die der Merge
      // meint — sonst prüft die Strecke den Zweig daneben.
      await setDeployConfig(project.id, {
        method: 'compose',
        composeFiles: ['docker-compose.yml'],
        service: 'app',
        healthUrl: 'https://example.test/healthz',
        healthTimeoutMs: 1_000,
        healthIntervalMs: 250,
        keep: 2,
      });
      const warnings: string[] = [];
      const taskId = await candidate(project.id, sandbox, {
        title: 'Mit Rollout, durch den Ablaufplaner',
        work: writeGreeting('Grüß dich'),
      });

      const { queue: mergeQueue } = queue(sandbox, { deployableMethods: ['compose'] });
      await mergeQueue.enqueue(taskId);

      const target = new FakeDeployTarget();
      const records = new DeployRecords(sql);
      const engine = new DeployService({
        sql,
        records,
        eventLog,
        tasks,
        escalations,
        targets: new Map([['compose', target]]),
        guardianState: async () => 'normal',
        health: async () => ({ ok: true, detail: 'HTTP 200' }),
        run: async () => ({ ok: true, code: 0, output: '' }),
      });
      const scheduler = new Scheduler({
        // Auf dieses Projekt eingeengt, aus demselben Grund wie im Fall darüber:
        // Datenbank und Arbeitsverzeichnis teilen sich alle Fälle dieser Datei.
        tasks: {
          get: (id) => tasks.get(id),
          resume: (id, options) => tasks.resume(id, options),
          listByState: (states, options = {}) =>
            tasks.listByState(states, { ...options, projectId: project.id }),
        },
        projects: { get: (id) => projects.get(id), listActive: async () => [project] },
        claims,
        guardian: {
          evaluate: async (): Promise<GuardianDecision> => ({
            state: 'normal',
            reason: { kind: 'below_thresholds' },
            governingWindow: null,
            latches: [],
          }),
        },
        devChain: {
          run: async () => {
            throw new Error('keine Kette in diesem Fall — der Kandidat steht schon');
          },
          resume: async () => {
            throw new Error('keine Kette in diesem Fall');
          },
        },
        mergeQueue,
        integrity: {
          verify: async () => {
            throw new Error('keine Integritätsprüfung in diesem Fall');
          },
        },
        deploys: engine,
        deployHandover: taskDeployHandover(sql),
        escalations,
        infraHistory: chainInfraHistory(sql),
        eventLog,
        concurrency: 1,
        onWarning: (message) => warnings.push(message),
      });

      // Durchgang 1 — der Merge. §12s Rollout läuft innerhalb eines Ticks
      // *vor* dem Merge, die Maschine hat also in genau diesem Durchgang schon
      // hingesehen und nichts gefunden.
      const merged = await scheduler.tick();
      expect(merged.merges.map((attempt) => attempt.status)).toEqual(['merged']);
      expect(merged.deploys).toEqual([]);
      expect(target.swaps).toEqual([]);
      expect((await tasks.get(taskId))?.state).toBe('deploying');

      // Durchgang 2 — der Rollout, aus derselben Übergabe, die der Merge
      // geschrieben hat. Kein `baseShaAfter` von Hand.
      const rolled = await scheduler.tick();
      expect(rolled.deploys.map((entry) => entry.outcome)).toEqual(['deployed']);
      expect((await tasks.get(taskId))?.state).toBe('done');
      expect(scheduler.quarantinedTasks).toEqual([]);
      expect(warnings).toEqual([]);

      // Und das, weswegen die Strecke gefahren wird: die sha, die ausgerollt
      // wurde, ist die, die der Merge erzeugt hat — nicht `HEAD`, nicht der
      // Branchname, nicht die des Kandidaten vor dem Rebase. Genau dieser
      // Wert war der Fund, den zwei Stränge unabhängig gemeldet haben.
      const sha = merged.merges[0]?.baseShaAfter;
      expect(sha).toBeTruthy();
      expect(target.swaps).toEqual([`image:${sha}`]);
      expect(target.serving?.sha).toBe(sha);

      const historie = await records.forProject(project.id);
      expect(historie).toHaveLength(1);
      expect(historie[0]?.sha).toBe(sha);
      expect(historie[0]?.outcome).toBe('succeeded');
      expect(historie[0]?.artifact).toBe(`image:${sha}`);
      expect(historie[0]?.healthOk).toBe(true);
      expect(historie[0]?.taskId).toBe(taskId);
      // Die Dauer wird aus zwei Ereignissen berechnet; ohne ein terminales
      // bliebe sie null, und der Datensatz sähe fertig aus, ohne es zu sein.
      expect(historie[0]?.durationMs).not.toBeNull();

      // Durchgang 3 — terminal heißt terminal.
      const afterwards = await scheduler.tick();
      expect(afterwards.idle).toBe('no_work');
      expect(afterwards.deploys).toEqual([]);
      expect(target.swaps).toHaveLength(1);
    });

    it('führt eine Aufgabe vom Tick bis `done` und rollt dabei nichts aus', async () => {
      const { sandbox, project } = await newSandbox();
      const { queue: mergeQueue, warnings } = queue(sandbox);

      const task = await tasks.create({
        projectId: project.id,
        title: 'Ohne Rollout, durch den Ablaufplaner',
        description: 'Die Begrüßung soll eine Anrede tragen.',
        acceptanceCriteria: ['greet() liefert die Anrede'],
        priority: 'P1',
      });

      // The same three scripted sessions `candidate()` uses — but the chain is
      // handed to the tick instead of being called directly, because the
      // transition this case is about (`gates` → `merge_queue`) is the
      // scheduler's and not §8.1's.
      const scripts: Record<string, FakeScript> = {
        planner: script(PLAN),
        coder: script(CODED),
        reviewer: script(APPROVED),
      };
      const backend = new FakeBackend(async (spec) => {
        if (spec.role === 'coder') await writeGreeting('Servus')(spec.cwd);
        const found = scripts[spec.role];
        if (!found) throw new Error(`Kein Skript für "${spec.role}"`);
        return found;
      });
      const devChain = new DevChain({
        tasks,
        projects,
        claims,
        worktrees,
        runner: new AgentRunner({ sql, eventLog, backend, paths }),
        runs: new RunRecords(sql),
        eventLog,
        findings,
        escalations,
        gateTools: () => sandbox.tools,
        sleep: async () => undefined,
      });

      const records = new DeployRecords(sql);
      const engine = new DeployService({
        sql,
        records,
        eventLog,
        tasks,
        escalations,
        // No target at all: A24's `none` needs none, and registering one would
        // let a wrong dispatch come back looking like a successful release.
        targets: new Map(),
        guardianState: async () => 'normal',
        run: async () => {
          throw new Error('kein Deploy-Befehl in diesem Fall');
        },
      });
      const deployCalls: string[] = [];
      const deploys: DeployDispatch = {
        deploy: async (deployed, deployProject, sha) => {
          deployCalls.push(deployed.id);
          return engine.deploy(deployed, deployProject, sha);
        },
      };

      const scheduler = new Scheduler({
        // Scoped to this project, because the database and the scratch
        // directory are shared by every case in this file: an unscoped tick
        // would try to merge another case's sandbox with *this* one's gate
        // commands, and roll out another case's leftover.
        tasks: {
          get: (id) => tasks.get(id),
          resume: (id, options) => tasks.resume(id, options),
          listByState: (states, options = {}) =>
            tasks.listByState(states, { ...options, projectId: project.id }),
        },
        projects: { get: (id) => projects.get(id), listActive: async () => [project] },
        claims,
        guardian: {
          evaluate: async (): Promise<GuardianDecision> => ({
            state: 'normal',
            reason: { kind: 'below_thresholds' },
            governingWindow: null,
            latches: [],
          }),
        },
        devChain,
        mergeQueue,
        integrity: {
          verify: async () => {
            throw new Error('keine Integritätsprüfung in diesem Fall');
          },
        },
        deploys,
        deployHandover: taskDeployHandover(sql),
        escalations,
        infraHistory: chainInfraHistory(sql),
        eventLog,
        concurrency: 1,
        onWarning: (message) => warnings.push(message),
      });

      // Pass 1 — §8.1's chain. The tick starts it and returns; handing the
      // approved task to §10's queue is the *scheduler's* step, not the chain's.
      const started = await scheduler.tick();
      expect(started.started.map((entry) => entry.taskId)).toEqual([task.id]);
      await scheduler.settle();
      expect((await tasks.get(task.id))?.state).toBe('merge_queue');

      // Pass 2 — the merge. §12's rollout runs *ahead* of the merge inside a
      // tick, so the engine has already had its look at this project in this
      // very pass and found nothing to do.
      const merged = await scheduler.tick();
      expect(merged.merges.map((attempt) => attempt.status)).toEqual(['merged']);
      expect(merged.merges[0]?.deployMethod).toBe('none');
      expect((await tasks.get(task.id))?.state).toBe('done');

      // Pass 3 — the terminal state is terminal: nothing picks it up again.
      const afterwards = await scheduler.tick();
      expect(afterwards.idle).toBe('no_work');
      expect(afterwards.deploys).toEqual([]);
      expect((await tasks.get(task.id))?.state).toBe('done');

      // The absence, in the three shapes it can be got wrong. The engine was
      // never asked — a merge that wrote §12's handover would have produced a
      // call; nothing was quarantined — an `unsupported` answer must not be
      // swallowed; and there is no handover on the timeline and no release in
      // the history, which is what "the pipeline ended at the merge" means.
      expect(deployCalls).toEqual([]);
      expect(scheduler.quarantinedTasks).toEqual([]);
      expect(await taskDeployHandover(sql).mergedSha(task.id)).toBeNull();
      expect(await records.forProject(project.id)).toEqual([]);
    });
  });

  /**
   * §22's Phase 2 gate: "no orphan worktrees/branches after the test suite (GC
   * verified)". Last in the file on purpose — it is a statement about what
   * everything above left behind.
   *
   * An orphan is not "a worktree that still exists": a red task keeps its
   * checkout, and §7.3 keeps a parked one, both deliberately (A44.5). An orphan
   * is a worktree whose task is terminal or gone, and the assertion is that the
   * GC finds none of those and refuses nothing.
   */
  describe('Aufräumen nach der ganzen Suite (§10)', () => {
    it('lässt keinen verwaisten Worktree und keinen verwaisten Branch zurück', async () => {
      const report = await worktrees.gc();

      // `removed` is the assertion the gate is actually about, and its absence
      // was the first Betriebsprüfung's second finding (§8.2): the earlier
      // version checked only `kept` and `strays`, so an orphan left behind by
      // the suite would have been quietly cleaned up by this very call and the
      // test would have stayed green. `removed` is the list of orphans the GC
      // *did* remove — an empty one is the claim "there were none".
      expect(report.removed).toEqual([]);
      // Nothing it had to refuse, and no directory git does not know about.
      expect(report.kept).toEqual([]);
      expect(report.strays).toEqual([]);
      expect(report.scanned).toBeGreaterThan(0);

      for (const project of await projects.listActive()) {
        for (const entry of await worktrees.list(project)) {
          const taskId = entry.branch?.replace('vorschicht/task-', '') ?? '';
          const task = await tasks.get(taskId);
          // Every remaining checkout belongs to a task that is still working.
          expect(task).not.toBeNull();
          expect(['done', 'aborted']).not.toContain(task?.state);
        }
      }
    }, 60_000);

    /**
     * The other half the gate names, and the half nothing checked.
     *
     * "no orphan worktrees/**branches** after the test suite" — the GC deletes
     * a task branch only when git agrees it is merged (A44.5), so a leftover
     * `vorschicht/task-<id>` branch whose task is terminal is exactly the
     * residue the gate is about. Reported per branch rather than as a count, so
     * a failure names which task it belongs to.
     */
    it('lässt keinen Task-Branch eines abgeschlossenen Tasks stehen', async () => {
      const stale: string[] = [];
      for (const project of await projects.listActive()) {
        const { stdout } = await execFile(
          'git',
          ['branch', '--list', 'vorschicht/task-*', '--format=%(refname:short)'],
          { cwd: project.rootPath },
        );
        for (const branch of stdout.split('\n').filter((line) => line.trim() !== '')) {
          const taskId = branch.trim().replace('vorschicht/task-', '');
          const task = await tasks.get(taskId);
          if (!task || task.state === 'done' || task.state === 'aborted') {
            stale.push(`${project.slug}:${branch.trim()} → ${task?.state ?? 'unbekannt'}`);
          }
        }
      }
      expect(stale).toEqual([]);
    }, 60_000);
  });

  // --- §11's findings pipeline (§22, Phase 3 step 4) ---------------------------

  /**
   * "Finding → fix task → gate re-run → only then merge", end to end.
   *
   * The Phase 2 suite above already walks a candidate through red → fix →
   * merged, and it does so by handing the second attempt a fix written into the
   * test. That proves §9's requeue and proves nothing about the pipeline: the
   * fix arrived because this file knew what was broken, not because the studio
   * told anybody. So the assertions that carry this gate are the two that
   * version could not make — that the finding exists as a §5 record with the
   * gate's real output in it, and that the **next session was told about it**,
   * read off the prompt the runner actually built. The prompt is captured from
   * the `FakeBackend` rather than reconstructed, because a prompt builder
   * called with the right arguments and a prompt that reaches a session are two
   * different claims and only the second one matters.
   */
  describe('Befundpipeline: Befund → Behebungsanlauf → grün → Merge (§11)', () => {
    it('führt die Schleife bis grün und schreibt jeden Schritt in die Spur', async () => {
      const { sandbox, project } = await newSandbox();
      const taskId = await candidate(project.id, sandbox, {
        claimSet: ['src/**', 'greet.test.js'],
        work: async (cwd) => {
          await writeGreeting('Servus')(cwd);
          await plantSeed(cwd, 'failing_test');
          await commitIn(cwd, 'chore: kaputter Test');
        },
      });
      const { queue: mergeQueue } = queue(sandbox);
      await mergeQueue.enqueue(taskId);

      // --- 1. the gate refuses the merge and records why ----------------------
      const blocked = await mergeQueue.runOnce(project.id);
      expect(blocked.status).toBe('red');
      expect(blocked.gateRunId).not.toBeNull();
      expect(blocked.findings.map((finding) => finding.gateId)).toEqual(['test']);

      const raised = blocked.findings[0];
      expect(raised?.severity).toBe('blocker');
      expect(raised?.status).toBe('open');
      // The evidence, not a paraphrase of it: whatever `node --test` printed.
      expect(raised?.output).toContain('greets a name');
      // §5's linkage — the task carrying the fix is the one §9 just requeued.
      expect(raised?.fixTaskId).toBe(taskId);
      expect((await tasks.get(taskId))?.state).toBe('queued');

      // The timeline carries the handle both ways: the failure names the
      // finding, and the finding names the task.
      const [failed] = await sql<Array<{ payload: { findingIds: string[] } }>>`
        SELECT payload FROM event_log WHERE task_id = ${taskId} AND kind = 'task.failed'`;
      expect(failed?.payload.findingIds).toEqual([raised?.id]);

      const notes = await sql<Array<{ payload: { text: string } }>>`
        SELECT payload FROM task_events
        WHERE task_id = ${taskId} AND kind = 'note' ORDER BY seq DESC`;
      // German, for the reader of the timeline (§2), with the real output in it.
      expect(notes.map((row) => row.payload.text).join('\n')).toContain(
        'jeder Befund ist ein Blocker',
      );

      // --- 2. the next attempt is *told* what to fix --------------------------
      const prompts: Array<{ role: string; prompt: string }> = [];
      const fixed = await fixAttempt(taskId, sandbox, prompts);
      expect(fixed).toBe('gates');

      const briefed = (role: string) => prompts.find((entry) => entry.role === role)?.prompt ?? '';
      for (const role of ['planner', 'coder', 'reviewer']) {
        expect(briefed(role)).toContain('Gates that blocked this change');
        // The gate's own output, verbatim, in the session that has to act on it.
        expect(briefed(role)).toContain('greets a name');
        expect(briefed(role)).toContain(raised?.id.slice(0, 8) as string);
      }
      // And the chain records which findings it was sent to clear, so the trace
      // runs from the finding to the attempt as well as the other way.
      const [chainRow] = await sql<Array<{ payload: { briefedFindingIds: string[] } }>>`
        SELECT payload FROM event_log
        WHERE task_id = ${taskId} AND kind = 'chain.finished' ORDER BY id DESC LIMIT 1`;
      expect(chainRow?.payload.briefedFindingIds).toEqual([raised?.id]);

      // --- 3. green, merged, and the finding closed by evidence ---------------
      await mergeQueue.enqueue(taskId);
      const merged = await mergeQueue.runOnce(project.id);
      expect(merged.status).toBe('merged');
      expect((await tasks.get(taskId))?.state).toBe('done');

      expect(await findings.open(taskId)).toEqual([]);
      const [closed] = await findings.forTask(taskId);
      expect(closed?.id).toBe(raised?.id);
      expect(closed?.status).toBe('resolved');
      // Nothing "resolved" it: a later run reported the same gate green, and
      // that run is named. §8.2's seventh domain can now ask whether the tree
      // changed in between, because both shas are on the record.
      expect(closed?.resolvedByGateRunId).toBe(merged.gateRunId);
      expect(closed?.resolvedOnSha).not.toBe(closed?.raisedOnSha);

      // Two gate runs behind one merge, both persisted (§5, §8.2 domain 7).
      const runs = await findings.runsFor(taskId);
      expect(runs.map((run) => run.ok)).toEqual([true, false]);
    }, 180_000);

    it('brieft einen ersten Anlauf mit nichts — ein leerer Abschnitt wäre eine Falschaussage', async () => {
      const { sandbox, project } = await newSandbox();
      const prompts: Array<{ role: string; prompt: string }> = [];
      const taskId = await candidate(project.id, sandbox, {
        work: writeGreeting('Servus'),
        capture: prompts,
      });
      const { queue: mergeQueue } = queue(sandbox);
      await mergeQueue.enqueue(taskId);
      expect((await mergeQueue.runOnce(project.id)).status).toBe('merged');

      expect(prompts).not.toHaveLength(0);
      for (const entry of prompts) {
        expect(entry.prompt).not.toContain('Gates that blocked this change');
      }
      expect(await findings.forTask(taskId)).toEqual([]);
    });

    /**
     * The fix pass: a real `DevChain` whose Coder repairs the seed.
     *
     * Deliberately *not* handed the diagnosis — the Coder callback removes the
     * planted defect because that is what a coder acting on the briefing would
     * do, and what is asserted is the briefing rather than the model's reading
     * of it. A scripted session cannot demonstrate comprehension, and pretending
     * otherwise would make this gate a statement about the `fake` backend.
     */
    async function fixAttempt(
      taskId: string,
      sandbox: SandboxProject,
      prompts: Array<{ role: string; prompt: string }>,
    ) {
      const backend = new FakeBackend(async (spec) => {
        prompts.push({ role: spec.role, prompt: spec.prompt });
        if (spec.role === 'coder') {
          // The repair for `failing_test` is a consistent pair again — the seed
          // replaced the test file with one asserting the old greeting, so what
          // fixes it is rewriting both halves, exactly as `candidateContinues`
          // does. `repairSeed` covers only the six command-gate seeds (A66).
          await writeGreeting('Servus')(spec.cwd);
          await commitIn(spec.cwd, 'fix: Test wieder grün');
        }
        const map: Record<string, FakeScript> = {
          planner: script(PLAN),
          coder: script(CODED),
          reviewer: script(APPROVED),
        };
        const found = map[spec.role];
        if (!found) throw new Error(`Kein Skript für "${spec.role}"`);
        return found;
      });
      const chain = new DevChain({
        tasks,
        projects,
        claims,
        worktrees,
        runner: new AgentRunner({ sql, eventLog, backend, paths }),
        runs: new RunRecords(sql),
        eventLog,
        findings,
        escalations,
        gateTools: () => sandbox.tools,
        sleep: async () => undefined,
      });
      await chain.run(taskId);
      return (await tasks.get(taskId))?.state;
    }
  });

  describe('Spuren im Ereignisprotokoll (§8.2, Domäne 7)', () => {
    it('hinterlässt zu jedem Merge einen Gate-Lauf', async () => {
      const { sandbox, project } = await newSandbox();
      const taskId = await candidate(project.id, sandbox, { work: writeGreeting('Servus') });
      const { queue: mergeQueue } = queue(sandbox);
      await mergeQueue.enqueue(taskId);
      await mergeQueue.runOnce(project.id);

      const rows = await sql<Array<{ kind: string }>>`
        SELECT kind FROM event_log
        WHERE task_id = ${taskId} AND kind IN ('gate.finished', 'merge.finished')
        ORDER BY id
      `;
      expect(rows.map((row) => row.kind)).toEqual(['gate.finished', 'merge.finished']);
    });

    it('hinterlässt auch dann einen Gate-Lauf, wenn der Kandidat rot wurde', async () => {
      const { sandbox, project } = await newSandbox();
      const taskId = await candidate(project.id, sandbox, {
        work: async (cwd) => {
          await writeGreeting('Servus')(cwd);
          await plantSeed(cwd, 'failing_test');
          await commitIn(cwd, 'chore: kaputter Test');
        },
      });
      const { queue: mergeQueue } = queue(sandbox);
      await mergeQueue.enqueue(taskId);
      await mergeQueue.runOnce(project.id);

      const [row] = await sql<Array<{ payload: { ok: boolean } }>>`
        SELECT payload FROM event_log WHERE task_id = ${taskId} AND kind = 'gate.finished'
      `;
      expect(row?.payload.ok).toBe(false);
      const merges = await sql`
        SELECT 1 FROM event_log WHERE task_id = ${taskId} AND kind = 'merge.finished'
      `;
      expect(merges).toHaveLength(0);
    });
  });
});
