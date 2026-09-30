/**
 * The wiring the daemon runs on, executed.
 *
 * Every existing test of the Betriebsprüfung constructs an `AuditService`
 * itself and injects what it needs. The daemon does not: it assembles one from
 * a project row, and that assembly lived as a nested function inside `main()`
 * where no test could reach it. So the arrangement under which a `gate_invalid`
 * edits `CLAUDE.md` on the production host was the one arrangement nothing exercised —
 * which is how it came to run against a path that could not be written and to
 * record `applied = true` about it.
 *
 * Real Postgres, a real `CLAUDE.md` on disk, a real `EscalationService`, and one
 * scripted model (A37). What is asserted is not "the builder returned an
 * object" but the three consequences a wrong wiring produces:
 *
 *   1. the gate opens **in the self-managed project's own file** — so `specPath`
 *      is derived from the row rather than from a default or a config string;
 *   2. The operator gets the P1 item — so `escalations` reached the auditor;
 *   3. a `read_only` project keeps its file and still gets the item — so
 *      `projects` reached the auditor, which is A44.3's second door.
 *
 * The scheduler's other collaborators are stubs because none of them is under
 * examination here; they exist so a tick can complete.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AgentRunner,
  DeployRecords,
  EscalationService,
  EventLog,
  FakeBackend,
  FakeDeployTarget,
  type FakeEvent,
  type FakeScript,
  OnboardingService,
  type ProjectRecord,
  ProjectService,
  parseGateBook,
  type SchedulerDeps,
  TaskService,
  taskDeployHandover,
  WrapUpService,
} from '@vorschicht/core';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type {
  AuditorResult,
  GuardianDecision,
  GuardianState,
  SessionSpec,
} from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildScheduler, type SchedulerAssembly } from './build-scheduler.js';

const url = process.env.TEST_DATABASE_URL;

/** Containment proved live — without it every run is an infra failure (§6.6). */
const HOOK_START: FakeEvent = {
  type: 'hook_event',
  event: 'SessionStart',
  hookName: 'SessionStart:*',
  phase: 'response',
  outcome: 'success',
  exitCode: 0,
};

const SPEC_FIXTURE = [
  '# CLAUDE.md — Testkopie',
  '',
  '### Phase 0 — Foundation',
  '',
  'Exit gates — Phase 0:',
  '- [x] Stack healthy *(verified locally)*',
  '- [x] Docs current *(README, CHANGELOG)*',
  '',
].join('\n');

const GATE_INVALID: AuditorResult = {
  status: 'done',
  summary: 'Ein Beleg trägt nicht.',
  artifacts: [],
  followups: [],
  domain: 'gate_truth',
  sample: ['P0.G1'],
  scopeLimits: [],
  verdict: 'phase_nicht_abschliessbar',
  findings: [
    {
      class: 'gate_invalid',
      summary: 'Der angeführte Beleg prüft eine andere Behauptung.',
      evidence: 'CLAUDE.md:6 gegen infra/scripts/demo-phase0.sh:12',
      gate: 'P0.G1',
    },
  ],
};

describe.skipIf(!url)('Die Verdrahtung, die der Daemon benutzt', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let eventLog: EventLog;
  let tasks: TaskService;
  let projects: ProjectService;
  let escalations: EscalationService;
  let runner: AgentRunner;
  /** The self-managed project's checkout — where its `CLAUDE.md` lives. */
  let projectRoot: string;
  let scratch: string;
  let projectId: string;

  beforeAll(async () => {
    database = await createTestDatabase('build-scheduler');
    sql = createSql({ url: database.url, max: 4 });
    eventLog = new EventLog(sql);
    tasks = new TaskService({ sql, eventLog });
    projects = new ProjectService(sql);
    escalations = new EscalationService({ sql, eventLog });
    projectRoot = await mkdtemp(join(tmpdir(), 'vs-self-'));
    scratch = await mkdtemp(join(tmpdir(), 'vs-sched-'));

    const backend = new FakeBackend(
      async (_spec: SessionSpec): Promise<FakeScript> => ({
        events: [HOOK_START],
        result: { raw: GATE_INVALID, tokensIn: 900, tokensOut: 400 },
      }),
    );
    runner = new AgentRunner({
      sql,
      eventLog,
      backend,
      paths: {
        roleSettingsDir: join(scratch, 'claude'),
        runsRoot: join(scratch, 'runs'),
        transcriptsRoot: join(scratch, 'transcripts'),
        mcpServerEntry: null,
      },
    });

    // Pre-created, so `ensureSelfManagedProject` answers `present` and this test
    // is about the *wiring* rather than about onboarding's survey.
    //
    // Created read-only as A85 requires and then **released the way A85 says it
    // is released** — one audit-logged `setReadOnly` call, which is the operator's. The
    // detour matters: `ensureSelfManagedProject` now re-asserts A85 on every
    // start for a row that has no such decision behind it, so a project simply
    // created writable would be tightened here and the un-tick below would be
    // refused. Setting the column directly would be the same thing, since the
    // guard reads the trail rather than the value (§19). What this fixture
    // therefore models is a studio the operator has released — which is the only state in
    // which the un-tick this case asserts can happen at all, and the read-only
    // case has its own test below.
    projectId = (
      await projects.create({
        slug: 'vorschicht',
        name: 'Vorschicht',
        rootPath: projectRoot,
        selfManaged: true,
        readOnly: true,
      })
    ).id;
    await projects.setReadOnly(projectId, false, 'max');
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
    await rm(projectRoot, { recursive: true, force: true });
    await rm(scratch, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await writeFile(join(projectRoot, 'CLAUDE.md'), SPEC_FIXTURE, 'utf8');
    await projects.setReadOnly(projectId, false, 'test');
    await setDeployConfig({ method: 'none' });
  });

  /** §12's configuration. Written to the column directly — there is no setter. */
  async function setDeployConfig(config: Record<string, unknown>) {
    await sql`
      UPDATE projects SET deploy_config = ${sql.json(config as never)} WHERE id = ${projectId}
    `;
  }

  function assembly(): SchedulerAssembly {
    const guardian: SchedulerDeps['guardian'] = {
      evaluate: async () =>
        ({
          state: 'normal',
          reason: { kind: 'below_thresholds' },
          governingWindow: null,
          latches: [],
        }) as unknown as GuardianDecision,
    };

    return {
      sql,
      eventLog,
      tasks,
      projects,
      escalations,
      runner,
      guardian,
      claims: { blockers: async () => [] },
      devChain: {
        run: async () => {
          throw new Error('keine Kette in diesem Test');
        },
        resume: async () => {
          throw new Error('keine Kette in diesem Test');
        },
      },
      mergeQueue: {
        list: async () => [],
        runOnce: async () => {
          throw new Error('keine Warteschlange in diesem Test');
        },
        enqueue: async () => undefined,
      },
      integrity: {
        verify: async () => {
          throw new Error('keine Prüfung in diesem Test');
        },
      },
      onboarding: new OnboardingService({ runner, eventLog, scratchDir: scratch }),
      auditScratchDir: scratch,
      idleAuditScratchDir: scratch,
      // §21/A17: every window at the ceiling, so no idle audit ever starts in
      // this file. These cases are about §8.2's wiring, and an idle audit
      // starting alongside would put a second session on the same fake runner
      // and make every assertion about "the audit" ambiguous. Refusing on
      // budget is also the path that costs nothing.
      usage: async () => [
        {
          window: 'five_hour',
          modelClass: null,
          usedPercent: 99,
          resetsAt: null,
          source: 'estimated',
          anomaly: null,
          observedAt: 0,
        },
      ],
      selfRootPath: projectRoot,
      concurrency: 1,
      onOpsAlert: () => undefined,
      onWarning: () => undefined,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    };
  }

  it('richtet die Betriebsprüfung auf die CLAUDE.md des selbstverwalteten Projekts', async () => {
    const built = await buildScheduler(assembly());
    expect(built.selfProject?.id).toBe(projectId);
    expect(built.specPath).toBe(join(projectRoot, 'CLAUDE.md'));

    // §8.2's phase-close trigger, asked for explicitly: the weekly cadence
    // fires once per interval and these cases each need their own run.
    built.scheduler.requestAudit('phase_close');
    const report = await built.scheduler.tick();
    expect(report.audit?.unticked).toEqual(['P0.G1']);

    // The file the daemon's own wiring wrote — read from disk, not from the run.
    const after = parseGateBook(await readFile(join(projectRoot, 'CLAUDE.md'), 'utf8'));
    expect(after.find((gate) => gate.id === 'P0.G1')?.state).toBe('open');
    expect(after.find((gate) => gate.id === 'P0.G2')?.state).toBe('green');
  });

  it('legt das entwertete Gate als P1-Entscheidung ins Postfach (§8.2)', async () => {
    const built = await buildScheduler(assembly());
    built.scheduler.requestAudit('phase_close');
    const report = await built.scheduler.tick();

    const number = report.audit?.findings[0]?.escalationNumber;
    expect(number).toEqual(expect.any(Number));
    const item = await escalations.byNumber(number as number);
    expect(item?.source).toBe('audit_finding');
    expect(item?.urgency).toBe('P1');
    expect(item?.question).toContain('P0.G1');
  });

  it('lässt die Datei eines Nur-Lese-Projekts in Ruhe und fragt trotzdem den Betreiber (A44.3)', async () => {
    await projects.setReadOnly(projectId, true, 'test');
    const before = await readFile(join(projectRoot, 'CLAUDE.md'), 'utf8');

    const built = await buildScheduler(assembly());
    built.scheduler.requestAudit('phase_close');
    const report = await built.scheduler.tick();

    expect(await readFile(join(projectRoot, 'CLAUDE.md'), 'utf8')).toBe(before);
    expect(report.audit?.unticked).toEqual([]);
    expect(report.audit?.findings[0]?.consequenceApplied).toBe(false);
    // Strictly more than before, which is why this is not a weakening of §8.2:
    // the authority is exercised through the operator instead of through the file.
    expect(report.audit?.findings[0]?.escalationNumber).toEqual(expect.any(Number));
  });

  /**
   * §12's engine, assembled by the daemon and driven through the tick.
   *
   * `FakeDeployTarget` and nothing else: it is what A37 built the fake for, and
   * the two real targets are another stream's. What is under examination is the
   * assembly — that a task in `deploying` reaches an engine at all, that the
   * engine gets the commit the merge queue recorded rather than a branch name,
   * and that a studio with no target says so instead of quietly not deploying.
   */
  describe('§12 — die Deploy-Maschine, wie der Daemon sie zusammensteckt', () => {
    const SHA = 'c0ffee1234567890c0ffee1234567890c0ffee12';
    /**
     * A real health endpoint on loopback, so the real probe runs.
     *
     * `buildScheduler` does not take a `HealthProbe` and deliberately does not
     * grow one for a test: §12's check is "any 2xx is healthy" and pointing it
     * at a server that answers 200 exercises that, where an injected stub would
     * assert that the wiring calls a stub.
     */
    let health: Server;
    let healthUrl: string;

    beforeAll(async () => {
      health = createServer((_request, response) => {
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.end('ok');
      });
      await new Promise<void>((ready) => health.listen(0, '127.0.0.1', ready));
      const address = health.address() as AddressInfo;
      healthUrl = `http://127.0.0.1:${address.port}/healthz`;
    });

    afterAll(async () => {
      await new Promise<void>((closed) => health.close(() => closed()));
    });

    /**
     * Clear what an earlier case left standing in `deploying`.
     *
     * Quarantine and backoff live in the `Scheduler` instance and every case
     * here builds a fresh one, so a leftover is picked up again by the next
     * case's first tick — and `deployOnce` takes at most **one** rollout per
     * project, so the leftover would silently take the slot the case under
     * examination needs. Cleared rather than worked around, because a case that
     * passes only when it runs first is a case that will stop passing.
     */
    beforeEach(async () => {
      for (const stale of await tasks.listByState(['deploying'], { limit: 50 })) {
        await tasks.transition(stale.id, 'aborted', {
          actor: 'test',
          reason: 'Rest aus einem anderen Fall',
        });
      }
    });

    /**
     * A project that is *not* this studio's own.
     *
     * The fixture above is `selfManaged`, and A12 intercepts every rollout there
     * before the guardian gets a word in — so §12's deferral needs an ordinary
     * project to be about. Its own row per case, because one rollout per project
     * per tick means two cases sharing a row would take each other's slot.
     */
    let foreignSeq = 0;
    async function foreignProject(config: Record<string, unknown>): Promise<ProjectRecord> {
      foreignSeq += 1;
      return projects.create({
        slug: `fremd-${foreignSeq}`,
        name: `Fremdprojekt ${foreignSeq}`,
        rootPath: projectRoot,
        deployConfig: config,
      });
    }

    const composeConfig = () => ({
      method: 'compose',
      composeFiles: ['docker-compose.yml'],
      service: 'app',
      healthUrl,
      healthTimeoutMs: 2_000,
      healthIntervalMs: 250,
      keep: 2,
    });

    async function deployingTask(inProject = projectId): Promise<string> {
      const task = await tasks.create({
        projectId: inProject,
        title: 'Rollout',
        description: 'Etwas, das ausgerollt werden soll.',
        acceptanceCriteria: ['läuft'],
      });
      // The §9 route a merge takes, ending on the transition the merge queue
      // writes — including the payload the rollout reads its commit from.
      for (const state of ['planning', 'claimed', 'coding', 'review', 'gates', 'merge_queue']) {
        await tasks.transition(task.id, state as never, { actor: 'orchestrator' });
      }
      await tasks.transition(task.id, 'merging', { actor: 'orchestrator' });
      await tasks.transition(task.id, 'deploying', {
        actor: 'orchestrator',
        reason: 'Zusammengeführt — Rollout folgt',
        payload: { baseShaAfter: SHA, deployMethod: 'compose' },
      });
      return task.id;
    }

    /**
     * A12, end to end through the daemon's own wiring.
     *
     * The fixture project is `selfManaged`, so the first tick must *not* roll
     * out — it must ask. That makes this one case cover the whole round trip:
     * the card is raised (so `escalations` reached the engine), the operator answers, and
     * the second tick deploys. The middle step is where a defect was found while
     * writing this: an approved deploy has no session behind it (`runId: null`),
     * so `resumeDecided` handing it to the dev chain quarantined the task the operator
     * had just approved, and the engine's own "approved → proceed" branch could
     * never be reached.
     */
    it('fragt bei einem Selbst-Deploy erst nach und rollt nach der Freigabe aus (A12)', async () => {
      const target = new FakeDeployTarget();
      await setDeployConfig(composeConfig());
      const taskId = await deployingTask();

      const built = await buildScheduler({ ...assembly(), deployTargets: [target] });
      // The set the merge queue has to be given, out of the same registry —
      // otherwise the component that refuses a merge and the one that performs
      // the rollout are answering out of two different lists.
      expect(built.deployableMethods).toEqual(['compose']);

      const asked = await built.scheduler.tick();
      expect(asked.deploys.map((deploy) => deploy.outcome)).toEqual(['needs_decision']);
      expect(target.swaps).toEqual([]);
      expect((await tasks.get(taskId))?.state).toBe('needs_decision');

      const item = await escalations.latestForTask(taskId);
      expect(item?.source).toBe('self_deploy');
      await escalations.answer(item?.id as string, { optionIndex: 0, actor: 'dashboard:operator' });

      const rolled = await built.scheduler.tick();
      expect(rolled.decided.map((entry) => entry.taskId)).toEqual([taskId]);
      expect(rolled.deploys.map((deploy) => deploy.outcome)).toEqual(['deployed']);
      expect(built.scheduler.quarantinedTasks).toEqual([]);
      expect(target.swaps).toHaveLength(1);
      expect((await tasks.get(taskId))?.state).toBe('done');

      // The commit travels the whole way, and this is the assertion that says
      // so end to end. It was deliberately weaker while the two streams were
      // separate — `DeployService.deploy` still derived the sha itself there,
      // so the artifact read `HEAD` whatever the scheduler passed, and the
      // stream that wrote this said as much rather than asserting something it
      // could not yet mean. Both halves are here now: the scheduler reads the
      // recorded commit and hands it over, and the engine takes it as its third
      // argument instead of guessing from `task.branch` (which is null by now,
      // because the merge queue released the worktree).
      expect(await taskDeployHandover(sql).mergedSha(taskId)).toBe(SHA);
      expect(target.serving?.sha).toBe(SHA);
      expect(target.serving?.id).toContain(SHA);
      expect((await tasks.get(taskId))?.branch).toBeNull();
    });

    /**
     * §22's gate, second half: "…and runs after reset."
     *
     * The refusal itself is `deploy/service.itest.ts`'s subject and is settled
     * there against the engine. What only a journey can say is that the deferred
     * rollout is **still there** when the window reopens — and that nothing in
     * between quietly turned "not now" into a fault. A deferral is not an
     * attempt, so a backoff, a quarantine or a retry count would each push the
     * release past the moment the guardian let it go, and every one of them is
     * invisible from inside the engine, which answered correctly either way.
     *
     * Two layers refuse here and this case exercises the outer one: §7.2 says
     * concurrency for new sessions is zero outside `normal`, so the tick returns
     * before the engine is asked at all. The inner one — the window closing
     * between the tick's reading and the engine's — is the case below.
     */
    it('lässt einen Rollout im wrap_up liegen und rollt ihn beim Reset aus (§7.2, §12)', async () => {
      const target = new FakeDeployTarget();
      const project = await foreignProject(composeConfig());
      const taskId = await deployingTask(project.id);

      // Typed rather than cast: this stub can satisfy `GuardianDecision` in
      // full, and an `as unknown as` would absorb the next field added to it.
      let state: GuardianState = 'wrap_up';
      const built = await buildScheduler({
        ...assembly(),
        guardian: {
          evaluate: async (): Promise<GuardianDecision> => ({
            state,
            reason: { kind: 'below_thresholds' },
            governingWindow: null,
            latches: [],
          }),
        },
        deployTargets: [target],
      });

      // §7.2's one exception, executed rather than quoted: the wrap-up parks
      // every task that is being worked on, and deliberately leaves a task that
      // is already `deploying` alone — the table says in so many words that
      // in-flight deploys finish their health check. Without it the release is
      // swapped, the record says "parked", and §9's map then refuses `done`.
      const parkWarnings: string[] = [];
      const wrapUp = new WrapUpService({
        tasks,
        eventLog,
        activeSessions: () => [],
        onWarning: (message) => parkWarnings.push(message),
      });
      const parked = await wrapUp.parkAll('guardian_wrap_up');
      expect(parked.map((outcome) => outcome.taskId)).not.toContain(taskId);
      expect(parkWarnings.join(' ')).toContain('nicht geparkt');
      expect((await tasks.get(taskId))?.state).toBe('deploying');

      const deferred = await built.scheduler.tick();
      expect(deferred.guardianState).toBe('wrap_up');
      expect(deferred.idle).toBe('guardian');
      expect(deferred.deploys).toEqual([]);
      expect(target.swaps).toEqual([]);
      expect(built.scheduler.quarantinedTasks).toEqual([]);
      const waiting = await tasks.get(taskId);
      expect(waiting?.state).toBe('deploying');
      expect(waiting?.retryCount).toBe(0);
      // Nothing was attempted, so §12 has nothing to record about it.
      expect(await new DeployRecords(sql).forProject(project.id)).toEqual([]);

      // The reset. No clock advance and no second scheduler: the very next pass
      // has to roll out, which is what "runs after the reset" means.
      state = 'normal';
      const rolled = await built.scheduler.tick();
      expect(rolled.deploys.map((deploy) => deploy.outcome)).toEqual(['deployed']);
      expect(target.swaps).toEqual([`image:${SHA}`]);
      const done = await tasks.get(taskId);
      expect(done?.state).toBe('done');
      expect(done?.retryCount).toBe(0);
      expect(built.scheduler.quarantinedTasks).toEqual([]);
    });

    /**
     * The inner layer, and the only arrangement in which the daemon's own wiring
     * produces §12's `deferred` at all.
     *
     * `buildScheduler` asks the guardian a second time inside the engine —
     * deliberately, because a rollout takes minutes and the window the tick read
     * may have closed since. So the sequence here is one guardian answering
     * `normal` to the tick and `wrap_up` to the engine, which is that race
     * written down. What has to hold afterwards is the same thing: nothing built,
     * nothing swapped, nothing recorded, and the next pass rolls out.
     */
    it('nimmt ein `deferred` der Maschine hin und rollt beim nächsten Tick aus (§12)', async () => {
      const target = new FakeDeployTarget();
      const project = await foreignProject(composeConfig());
      const taskId = await deployingTask(project.id);

      // Call 1 is the tick's own reading, call 2 the engine's. Everything after
      // that is the window back open.
      const answers: GuardianState[] = ['normal', 'wrap_up'];
      const built = await buildScheduler({
        ...assembly(),
        guardian: {
          evaluate: async (): Promise<GuardianDecision> => ({
            state: answers.shift() ?? 'normal',
            reason: { kind: 'below_thresholds' },
            governingWindow: null,
            latches: [],
          }),
        },
        deployTargets: [target],
      });

      const deferred = await built.scheduler.tick();
      expect(deferred.deploys.map((deploy) => deploy.outcome)).toEqual(['deferred']);
      expect(deferred.deploys[0]?.deploymentId).toBeNull();
      expect(deferred.deploys[0]?.problem).toContain('wrap_up');
      // A deferral stops before the artifact exists, not after: `prepare` is
      // what would leave a half-built release on the machine.
      expect(target.releasesOnMachine).toEqual([]);
      expect(target.swaps).toEqual([]);
      expect(built.scheduler.quarantinedTasks).toEqual([]);
      const waiting = await tasks.get(taskId);
      expect(waiting?.state).toBe('deploying');
      expect(waiting?.retryCount).toBe(0);
      expect(await new DeployRecords(sql).forProject(project.id)).toEqual([]);

      const rolled = await built.scheduler.tick();
      expect(rolled.deploys.map((deploy) => deploy.outcome)).toEqual(['deployed']);
      expect(target.swaps).toEqual([`image:${SHA}`]);
      expect((await tasks.get(taskId))?.state).toBe('done');
    });

    /**
     * A12's first half, and the part a single tick cannot say.
     *
     * The case above settles "with approval it proceeds" and one pass of the
     * refusal. §22's gate says *refused*, and a refusal that only holds for one
     * tick is not one — the studio runs this loop every fifteen seconds for as
     * long as the card is open, which in §15's inbox is indefinitely.
     */
    it('rollt ohne Freigabe auch über viele Ticks nichts aus — und fragt nur einmal (A12)', async () => {
      const target = new FakeDeployTarget();
      await setDeployConfig(composeConfig());
      const taskId = await deployingTask();

      const built = await buildScheduler({ ...assembly(), deployTargets: [target] });

      const asked = await built.scheduler.tick();
      expect(asked.deploys.map((deploy) => deploy.outcome)).toEqual(['needs_decision']);

      for (let pass = 0; pass < 4; pass += 1) {
        const report = await built.scheduler.tick();
        // The engine is not asked again, and that is the point rather than an
        // omission: raising the card moved the task out of `deploying`, and §15
        // holds it there for as long as the question is open. `decided` staying
        // empty is the assertion that the tick does not resume it by itself.
        expect(report.deploys).toEqual([]);
        expect(report.decided).toEqual([]);
      }

      expect(target.swaps).toEqual([]);
      // A12 refuses *before* an artifact exists — nothing was even built.
      expect(target.releasesOnMachine).toEqual([]);
      expect((await tasks.get(taskId))?.state).toBe('needs_decision');
      expect(built.scheduler.quarantinedTasks).toEqual([]);
      // Scoped to this task: the project is this studio's own and the case above
      // deployed it once already, so its release history is not empty.
      const releases = await new DeployRecords(sql).forProject(projectId);
      expect(releases.filter((release) => release.taskId === taskId)).toEqual([]);

      // One card, not one per pass. An inbox that repeats the same question is
      // an inbox the operator stops reading, and then the next real card is invisible.
      const [row] = await sql<Array<{ n: number }>>`
        SELECT count(*)::int AS n FROM escalations
        WHERE task_id = ${taskId} AND source = 'self_deploy'
      `;
      expect(row?.n).toBe(1);
    });

    it('sagt beim Start, dass kein Deploy-Ziel registriert ist', async () => {
      const warnings: string[] = [];
      const built = await buildScheduler({
        ...assembly(),
        logger: {
          info: () => undefined,
          warn: (_obj: unknown, message?: string) => warnings.push(message ?? ''),
          error: () => undefined,
        },
      });

      // A studio that cannot deploy and a studio with nothing to deploy look
      // identical from outside; this line is the only thing separating them.
      expect(built.deployableMethods).toEqual([]);
      expect(warnings.join(' ')).toContain('Kein Deploy-Ziel');
    });

    it('stellt eine Aufgabe zurück, für deren Methode kein Ziel da ist', async () => {
      await setDeployConfig(composeConfig());
      const taskId = await deployingTask();

      const built = await buildScheduler(assembly());
      const report = await built.scheduler.tick();

      expect(report.deploys.map((deploy) => deploy.outcome)).toEqual(['unsupported']);
      expect(built.scheduler.quarantinedTasks).toEqual([taskId]);
      // Not deployed, not red, not done: a dispatcher defect leaves the task
      // exactly where it was and puts a human in the loop (A57.4).
      expect((await tasks.get(taskId))?.state).toBe('deploying');
    });
  });

  it('sagt es, wenn es kein selbstverwaltetes Projekt gibt — statt still nicht zu prüfen', async () => {
    const warnings: string[] = [];
    const built = await buildScheduler({
      ...assembly(),
      // `Object.create` rather than a spread: a spread of a class instance keeps
      // its fields and drops its prototype, so every method the tick calls —
      // `get` among them, once §12's rollout looks a project up — is gone. The
      // spread version failed exactly there, and silently would have been worse.
      projects: Object.assign(Object.create(projects) as ProjectService, {
        listActive: async () => [],
      }),
      onboarding: {
        propose: async () => {
          throw new Error('kein Repository');
        },
      } as unknown as OnboardingService,
      logger: {
        info: () => undefined,
        warn: (_obj: unknown, message?: string) => warnings.push(message ?? ''),
        error: () => undefined,
      },
    });

    expect(built.selfProject).toBeNull();
    expect(built.specPath).toBeNull();
    expect(warnings.join(' ')).toContain('Betriebsprüfung');
    // No project means no audit at all — the tick must not invent one.
    expect((await built.scheduler.tick()).audit).toBeNull();
  });
});
