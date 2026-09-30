/**
 * The tick's decisions, driven by stubs.
 *
 * What is under examination here is the dispatcher's *policy*, not the work it
 * dispatches — the chain, the queue, the re-check and the audit each have their
 * own tests against real Postgres and real git. So the collaborators are stubs,
 * and they are stubs that satisfy the declared structural interfaces rather than
 * casts, which is what makes a drift in `DevChain.run`'s signature break this
 * file instead of being absorbed by an `as unknown as`.
 *
 * The properties that matter, in the order the header of `scheduler.ts` gives
 * them, plus the three failure modes the module exists to prevent: a tick that
 * awaits its own work, a blocked task re-planned every few seconds, and a
 * dispatcher defect retried forever.
 */
import type { GuardianDecision, GuardianState } from '@vorschicht/shared';
import { describe, expect, it, vi } from 'vitest';
import type { AuditRun, AuditTrigger } from './audit/index.js';
import type { ClaimConflict } from './claim-registry.js';
import type { DeployOutcome, DeployResult } from './deploy/service.js';
import { DevChainError, type DevChainResult, type DevChainStatus } from './dev-chain.js';
import type { IdleAuditRun, IdleAuditSkip } from './idle-audit.js';
import type { IntegrityCheckResult, IntegrityStatus } from './integrity-check.js';
import {
  type MergeAttempt,
  MergeQueueError,
  type MergeStatus,
  OPS_ALERT_AFTER_INFRA_ATTEMPTS,
  type OpsAlert,
} from './merge-queue.js';
import type { ProjectRecord } from './project-service.js';
import { DEFAULT_HARNESS_BACKOFF_MS, Scheduler, type SchedulerDeps } from './scheduler.js';
import type { TaskRecord } from './task-service.js';

const PROJECT: ProjectRecord = {
  id: 'p-1',
  slug: 'sandbox',
  name: 'Sandbox',
  rootPath: '/opt/sandbox',
  defaultBranch: 'main',
  readOnly: false,
  active: true,
  gateConfig: {},
  deployConfig: { method: 'none' },
  claimGranularity: 'file',
  createdAt: new Date(0),
  updatedAt: new Date(0),
} as unknown as ProjectRecord;

function task(over: Partial<TaskRecord> & { id: string }): TaskRecord {
  return {
    projectId: PROJECT.id,
    state: 'queued',
    priority: 'P2',
    resumeState: null,
    version: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    title: `Aufgabe ${over.id}`,
    description: null,
    acceptanceCriteria: [],
    department: null,
    type: null,
    goalId: null,
    parentTaskId: null,
    worktreePath: null,
    branch: null,
    retryCount: 0,
    parkCount: 0,
    interruptCount: 0,
    ...over,
  };
}

function chainResult(status: DevChainStatus, taskId: string): DevChainResult {
  return {
    taskId,
    status,
    problem: status === 'approved' ? null : 'Grund',
    legs: [],
    plan: null,
    review: null,
    outOfClaims: [],
    conflicts: [],
    rounds: 1,
    red: null,
    briefedFindings: [],
  };
}

function mergeAttempt(status: MergeStatus, taskId: string | null): MergeAttempt {
  return {
    projectId: PROJECT.id,
    taskId,
    status,
    problem: null,
    baseShaBefore: null,
    baseShaAfter: null,
    commits: [],
    gates: null,
    gateRunId: null,
    findings: [],
    red: null,
    releasedClaims: [],
    worktreeRemoved: false,
    deployMethod: status === 'merged' ? 'none' : null,
  };
}

/** What the merge queue wrote onto the `deploying` transition (`baseShaAfter`). */
const MERGED_SHA = '9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3';

function deployResult(outcome: DeployOutcome): DeployResult {
  return {
    outcome,
    deploymentId: outcome === 'deferred' || outcome === 'unsupported' ? null : 'd-1',
    problem: outcome === 'deployed' ? null : `Grund für ${outcome}`,
  };
}

function integrityResult(status: IntegrityStatus, taskId: string): IntegrityCheckResult {
  return {
    taskId,
    status,
    ok: status === 'resumed',
    resumedTo: status === 'resumed' ? 'coding' : null,
    summary: null,
    problem: null,
    runId: null,
    red: null,
    withoutSession: false,
  };
}

/**
 * The argument shape of `AuditDispatch.run`.
 *
 * Spelled out because a `vi.fn()` declared without one has an empty parameter
 * tuple, and `mock.calls[0]?.[0]` is then typed `never` — an assertion that
 * type-checks and can never fail. The typecheck of the test tree exists to
 * catch exactly that (A50's second finding).
 */
type AuditRequestShape = { trigger: AuditTrigger; scope: string };

const auditRun = (id: string): AuditRun =>
  ({
    id,
    domain: 'gate_truth',
    trigger: 'weekly',
    scope: 'scope',
    outcome: 'done',
    verdict: 'unbedenklich',
    report: 'Bericht',
    problem: null,
    sample: [],
    reportedSample: [],
    scopeLimits: [],
    findings: [],
    unticked: [],
    escalations: [],
    runId: null,
  }) as AuditRun;

/** A test harness whose knobs are the facts a tick reads. */
function harness(
  over: Partial<SchedulerDeps> & {
    tasksByState?: Record<string, TaskRecord[]>;
    guardianState?: string;
    blockers?: ClaimConflict[];
    /** §6.4: what the inbox says about the task the tick is looking at. */
    latestEscalation?: { state: string; number: number } | null;
    /** A25: how many infra passes in a row the log says this task has had. */
    infraChains?: number;
    /** §12: what the deploy engine answers for the task the tick hands it. */
    deployOutcome?: DeployOutcome;
    /** §12: the engine itself falls over — not an outcome, an exception. */
    deployThrows?: string;
    /** §12: what the `deploying` transition recorded, or nothing at all. */
    mergedSha?: string | null;
    /**
     * What §10's queue reports as waiting, without replacing the whole stub.
     *
     * Overriding `mergeQueue` wholesale would drop the `order` instrumentation
     * with it, and the phase-order case below would then assert an order it had
     * itself removed a phase from — which is how it first failed.
     */
    mergeCandidates?: Array<{ taskId: string }>;
  } = {},
) {
  let clock = Date.parse('2026-08-01T09:00:00Z');
  const tasksByState = over.tasksByState ?? {};
  const events: Array<{ kind: string; taskId?: string | null | undefined }> = [];
  const warnings: string[] = [];
  const opsAlerts: OpsAlert[] = [];
  const deployCalls: Array<{ taskId: string; projectId: string; sha: string }> = [];
  /** Tasks the tick moved back out of `needs_decision` itself (§12, A12). */
  const resumed: string[] = [];

  const chainRuns: string[] = [];
  /**
   * Everything the tick did, in the order it did it.
   *
   * The order of the phases is a decision the header states and nothing else
   * here could catch: asserting that a rollout happened and that a chain started
   * says nothing about which came first, and §12's rollout going after the
   * dispatch would be invisible to every other assertion in this file.
   */
  const order: string[] = [];
  /** §6.4's entry point, recorded separately: `run` and `resume` are not the same act. */
  const chainResumes: string[] = [];
  /** Set by a test to hold a chain open, so "in flight" is observable. */
  let hold: Promise<void> | null = null;
  let releaseHold: (() => void) | null = null;
  /**
   * What a chain returns. Replaceable by a test, but only through `setChain`:
   * assigning `deps.devChain.run` directly would replace the wrapper below and
   * silently stop recording `chainRuns`, so the assertions would then be about
   * an array nobody writes to — which reads as "the scheduler started nothing"
   * whatever the scheduler did.
   */
  let chain: (taskId: string) => Promise<DevChainResult> = async (taskId) =>
    chainResult('approved', taskId);

  const deps: SchedulerDeps = {
    concurrency: 2,
    now: () => clock,
    onWarning: (message) => warnings.push(message),
    tasks: {
      resume: async (id: string) => {
        const found = Object.values(tasksByState)
          .flat()
          .find((candidate) => candidate.id === id);
        if (!found) throw new Error(`Aufgabe ${id} gibt es nicht`);
        resumed.push(id);
        return found;
      },
      get: async (id: string) =>
        Object.values(tasksByState)
          .flat()
          .find((candidate) => candidate.id === id) ?? null,
      listByState: async (states) => {
        const wanted = new Set(states as readonly string[]);
        return Object.entries(tasksByState)
          .filter(([state]) => wanted.has(state))
          .flatMap(([, list]) => list);
      },
    },
    projects: {
      get: async () => PROJECT,
      listActive: async () => [PROJECT],
    },
    claims: {
      blockers: async () => over.blockers ?? [],
    },
    guardian: {
      evaluate: async () =>
        ({
          state: over.guardianState ?? 'normal',
          reason: { kind: 'below_thresholds' },
          governingWindow: null,
          latches: [],
        }) as unknown as GuardianDecision,
    },
    devChain: {
      run: async (taskId: string) => {
        chainRuns.push(taskId);
        order.push(`chain:${taskId}`);
        if (hold) await hold;
        return chain(taskId);
      },
      resume: async (taskId: string) => {
        chainResumes.push(taskId);
        if (hold) await hold;
        return chain(taskId);
      },
    },
    mergeQueue: {
      list: async () => over.mergeCandidates ?? [],
      runOnce: async (projectId: string) => {
        order.push(`merge:${projectId}`);
        return mergeAttempt('idle', null);
      },
      enqueue: async () => undefined,
    },
    integrity: {
      verify: async (taskId: string) => integrityResult('resumed', taskId),
    },
    deploys: {
      deploy: async (deployed, project, sha) => {
        order.push(`deploy:${deployed.id}`);
        deployCalls.push({ taskId: deployed.id, projectId: project.id, sha });
        if (over.deployThrows) throw new Error(over.deployThrows);
        return deployResult(over.deployOutcome ?? 'deployed');
      },
    },
    deployHandover: {
      mergedSha: async () => (over.mergedSha === undefined ? MERGED_SHA : over.mergedSha),
    },
    escalations: {
      latestForTask: async () => over.latestEscalation ?? null,
    },
    infraHistory: {
      consecutiveInfraChains: async () => over.infraChains ?? 0,
    },
    onOpsAlert: (alert) => {
      opsAlerts.push(alert);
    },
    eventLog: {
      append: async (event) => {
        events.push({ kind: event.kind, taskId: event.taskId });
        return 'e-1';
      },
    },
    ...over,
  };

  return {
    deps,
    scheduler: new Scheduler(deps),
    events,
    warnings,
    opsAlerts,
    deployCalls,
    resumed,
    order,
    chainRuns,
    chainResumes,
    setChain: (fn: (taskId: string) => Promise<DevChainResult>) => {
      chain = fn;
    },
    /** Simulate what a real chain does to a task: it leaves the startable set. */
    removeTask: (id: string) => {
      for (const [state, list] of Object.entries(tasksByState)) {
        tasksByState[state] = list.filter((candidate) => candidate.id !== id);
      }
    },
    advance: (ms: number) => {
      clock += ms;
    },
    holdChains: () => {
      hold = new Promise<void>((resolve) => {
        releaseHold = resolve;
      });
    },
    releaseChains: () => {
      releaseHold?.();
      hold = null;
    },
  };
}

describe('Scheduler', () => {
  describe('§7.2 — der Wächter entscheidet zuerst', () => {
    it('startet außerhalb von `normal` gar nichts', async () => {
      for (const state of ['wrap_up', 'hard_stop']) {
        const h = harness({
          guardianState: state,
          tasksByState: {
            queued: [task({ id: 't-1' })],
            interrupted: [task({ id: 't-2' })],
            deploying: [task({ id: 't-3', state: 'deploying' })],
          },
        });
        const report = await h.scheduler.tick();

        expect(report.idle).toBe('guardian');
        expect(report.started).toEqual([]);
        // Not merely "no chain": nothing at all. Every item below the guardian
        // can spawn a session — a red merge starts a Debugger, an audit is a
        // session — and §7.2 says concurrency for new sessions is zero.
        expect(report.integrity).toEqual([]);
        expect(report.merges).toEqual([]);
        // §12 says it in its own words: no new deploys in wrap-up or hard-stop.
        // The engine refuses one too (`deferred`), but a tick that called it
        // anyway would have started a rollout in the window the guardian just
        // closed, and only this assertion is above that second layer.
        expect(report.deploys).toEqual([]);
        expect(h.deployCalls).toEqual([]);
        expect(report.audit).toBeNull();
        expect(h.chainRuns).toEqual([]);
      }
    });

    it('nimmt die Arbeit wieder auf, sobald der Wächter `normal` meldet', async () => {
      const h = harness({ tasksByState: { queued: [task({ id: 't-1' })] } });
      const report = await h.scheduler.tick();
      expect(report.idle).toBeNull();
      expect(report.started.map((s) => s.taskId)).toEqual(['t-1']);
      await h.scheduler.settle();
    });
  });

  describe('§7.2 — Unterbrochenes vor Neuem', () => {
    it('prüft eine unterbrochene Aufgabe, bevor eine neue startet', async () => {
      const order: string[] = [];
      const h = harness({
        concurrency: 1,
        tasksByState: {
          queued: [task({ id: 'neu' })],
          interrupted: [task({ id: 'alt', state: 'interrupted', resumeState: 'coding' })],
        },
        integrity: {
          verify: async (taskId) => {
            order.push(`integrity:${taskId}`);
            return integrityResult('resumed', taskId);
          },
        },
      });
      h.setChain(async (taskId) => {
        order.push(`chain:${taskId}`);
        return chainResult('approved', taskId);
      });

      await h.scheduler.tick();
      await h.scheduler.settle();

      // The re-check happens first, and with concurrency 1 the new task does
      // not start in the same tick at all — §7.2's "parked/interrupted tasks
      // resume first" is an ordering, not a preference.
      expect(order[0]).toBe('integrity:alt');
    });

    it('prüft höchstens eine je Tick — ein Neustart erzeugt viele auf einmal', async () => {
      const verified: string[] = [];
      const h = harness({
        tasksByState: {
          interrupted: ['a', 'b', 'c'].map((id) =>
            task({ id, state: 'interrupted', resumeState: 'coding' }),
          ),
        },
        integrity: {
          verify: async (taskId) => {
            verified.push(taskId);
            return integrityResult('resumed', taskId);
          },
        },
      });

      await h.scheduler.tick();
      expect(verified).toEqual(['a']);
    });

    it('wartet nach einer Prüfung ohne Ergebnis, statt sie sofort zu wiederholen', async () => {
      const verified: string[] = [];
      const h = harness({
        infraBackoffMs: 60_000,
        tasksByState: {
          interrupted: [task({ id: 'a', state: 'interrupted', resumeState: 'coding' })],
        },
        integrity: {
          verify: async (taskId) => {
            verified.push(taskId);
            return integrityResult('infra', taskId);
          },
        },
      });

      await h.scheduler.tick();
      await h.scheduler.tick();
      expect(verified).toEqual(['a']);

      h.advance(60_001);
      await h.scheduler.tick();
      expect(verified).toEqual(['a', 'a']);
    });
  });

  describe('§6.4 — die Runde schließt sich, wenn der Betreiber geantwortet hat', () => {
    const waiting = (id = 'wartend') =>
      task({ id, state: 'needs_decision', resumeState: 'coding' });

    it('setzt die geparkte Sitzung fort, sobald die Entscheidung beantwortet ist', async () => {
      const h = harness({
        tasksByState: { needs_decision: [waiting()] },
        latestEscalation: { state: 'answered', number: 12 },
      });

      const report = await h.scheduler.tick();
      await h.scheduler.settle();

      expect(h.chainResumes).toEqual(['wartend']);
      // `run` wäre die falsche Tür: sie beginnt bei der Planung und würde die
      // Sitzung wegwerfen, die auf die Antwort gewartet hat.
      expect(h.chainRuns).toEqual([]);
      expect(report.decided).toEqual([{ taskId: 'wartend', escalationNumber: 12 }]);
      expect(report.idle).toBeNull();
    });

    it('lässt eine offene Frage in Ruhe — und meldet dazu gar nichts', async () => {
      const h = harness({
        tasksByState: { needs_decision: [waiting()] },
        latestEscalation: { state: 'open', number: 12 },
      });

      const report = await h.scheduler.tick();

      expect(h.chainResumes).toEqual([]);
      expect(report.decided).toEqual([]);
      // §15 hält die Claims unbefristet: eine unbeantwortete Frage ist der
      // Normalzustand einer blockierten Aufgabe. Eine Warnung alle fünfzehn
      // Sekunden wäre ein Kanal, den danach niemand mehr liest.
      expect(h.warnings).toEqual([]);
      expect(h.events).toEqual([]);
      expect(report.idle).toBe('no_work');
    });

    it('rührt eine wartende Aufgabe nicht an, zu der gar keine Frage im Postfach steht', async () => {
      const h = harness({
        tasksByState: { needs_decision: [waiting()] },
        latestEscalation: null,
      });

      await h.scheduler.tick();
      expect(h.chainResumes).toEqual([]);
      expect(h.chainRuns).toEqual([]);
    });

    it('setzt fort, bevor neue Arbeit beginnt', async () => {
      const h = harness({
        concurrency: 1,
        tasksByState: {
          queued: [task({ id: 'neu' })],
          needs_decision: [waiting('beantwortet')],
        },
        latestEscalation: { state: 'answered', number: 3 },
      });

      // Die fortgesetzte Kette wird offengehalten, damit der Platz auch wirklich
      // belegt ist. Vorher hing die zweite Zusicherung an der Mikrotask-Folge:
      // die gestubbte Kette war sofort fertig, gab ihren Platz noch im selben
      // Tick frei, und dass danach nichts Neues startete, lag nur daran, dass
      // zwischen Fortsetzen und Verteilen kein `await` stand. §12s Rollout hat
      // eines eingefügt — und damit sichtbar gemacht, dass hier eine Zusicherung
      // über die Terminplanung stand statt über die Regel.
      h.holdChains();
      await h.scheduler.tick();

      // Eine Aufgabe, deren Frage beantwortet ist, ist die am weitesten
      // fortgeschrittene Arbeit im Studio — und ihre Claims blockieren das,
      // was dahinter wartet. Beides wird an dem abgelesen, was *gestartet*
      // wurde, nicht an dem, was fertig wurde.
      expect(h.chainResumes).toEqual(['beantwortet']);
      expect(h.chainRuns).toEqual([]);

      h.releaseChains();
      await h.scheduler.settle();
    });

    it('setzt gar nichts fort, solange der Wächter nicht "normal" sagt', async () => {
      const h = harness({
        guardianState: 'wrap_up',
        tasksByState: { needs_decision: [waiting()] },
        latestEscalation: { state: 'answered', number: 12 },
      });

      const report = await h.scheduler.tick();

      // §7.2: eine Fortsetzung ist eine Sitzung, und außerhalb von `normal`
      // startet keine.
      expect(h.chainResumes).toEqual([]);
      expect(report.decided).toEqual([]);
      expect(report.idle).toBe('guardian');
    });

    it('bleibt an A7s Grenze — eine Fortsetzung belegt einen Platz wie jede Kette', async () => {
      const h = harness({
        concurrency: 1,
        tasksByState: { needs_decision: [waiting('a'), waiting('b')] },
        latestEscalation: { state: 'answered', number: 1 },
      });
      h.holdChains();

      const report = await h.scheduler.tick();
      expect(report.decided.map((d) => d.taskId)).toEqual(['a']);

      h.releaseChains();
      await h.scheduler.settle();
    });

    it('wartet, wenn das Postfach nicht lesbar ist, statt die Aufgabe zu beschuldigen', async () => {
      let broken = true;
      const h = harness({
        infraBackoffMs: 60_000,
        tasksByState: { needs_decision: [waiting()] },
        escalations: {
          latestForTask: async () => {
            if (broken) throw new Error('Datenbank weg');
            return { state: 'answered', number: 9 };
          },
        },
      });

      await h.scheduler.tick();
      expect(h.chainResumes).toEqual([]);
      expect(h.warnings.join(' ')).toContain('Postfach');

      broken = false;
      // Noch im Backoff: das Postfach wird nicht einmal gefragt.
      await h.scheduler.tick();
      expect(h.chainResumes).toEqual([]);

      h.advance(60_001);
      await h.scheduler.tick();
      await h.scheduler.settle();
      expect(h.chainResumes).toEqual(['wartend']);
    });
  });

  /**
   * §12's five answers, each with exactly one response.
   *
   * The engine decides what a rollout *means* and has its own tests for that
   * (`deploy/service.itest.ts`, against a real Postgres). What is examined here
   * is the half only the dispatcher owns: which of the five outcomes changes
   * what the tick does next. Collapsing any two of them is invisible from the
   * engine's side, because the engine answered correctly in both cases.
   */
  describe('§12 — was der Tick mit den fünf Antworten der Deploy-Maschine macht', () => {
    const deploying = (id = 'roll-1') => ({ deploying: [task({ id, state: 'deploying' })] });

    it('rollt aus, was die Merge-Warteschlange übergeben hat — mit dem Commit von dort', async () => {
      const h = harness({ tasksByState: deploying() });
      const report = await h.scheduler.tick();

      expect(report.deploys).toEqual([
        {
          taskId: 'roll-1',
          projectId: PROJECT.id,
          outcome: 'deployed',
          deploymentId: 'd-1',
          problem: null,
        },
      ]);
      // The sha is the assertion, not a detail: it is the one value the engine
      // may not derive for itself (`task.branch` is a branch name and is NULL
      // after the merge released the worktree), so a dispatcher that stopped
      // passing it would produce releases named `HEAD` with no test objecting.
      expect(h.deployCalls).toEqual([{ taskId: 'roll-1', projectId: PROJECT.id, sha: MERGED_SHA }]);
      // The engine already moved the task; the tick must not have decided
      // anything on top of that.
      expect(h.scheduler.quarantinedTasks).toEqual([]);
      expect(h.events.map((event) => event.kind)).not.toContain('scheduler.defect');
      expect(report.idle).toBeNull();
    });

    it('behandelt einen Rollback und einen misslungenen Rollback wie einen Erfolg — die Maschine hat schon entschieden', async () => {
      for (const outcome of ['rolled_back', 'rollback_failed'] as const) {
        const h = harness({ tasksByState: deploying(), deployOutcome: outcome });
        const report = await h.scheduler.tick();

        expect(report.deploys[0]?.outcome).toBe(outcome);
        // §12 raised the P0 card and §9's red path moved the task, both inside
        // the engine. A tick that quarantined here would put a task nobody can
        // requeue on top of a red path that is already running.
        expect(h.scheduler.quarantinedTasks).toEqual([]);
        expect(h.warnings).toEqual([]);
      }
    });

    it('nimmt ein `deferred` ohne Rückstellung hin — der nächste Tick fragt wieder', async () => {
      const h = harness({ tasksByState: deploying(), deployOutcome: 'deferred' });

      const first = await h.scheduler.tick();
      expect(first.deploys[0]?.outcome).toBe('deferred');
      // Nothing failed, so nothing is recorded as a failure: no backoff, no
      // counter, no alert, nobody warned. A tick that treated this as an error
      // would push the rollout minutes past the moment the window reopened.
      expect(h.warnings).toEqual([]);
      expect(h.opsAlerts).toEqual([]);
      expect(h.scheduler.quarantinedTasks).toEqual([]);
      expect(h.events.map((event) => event.kind)).not.toContain('scheduler.defect');

      // The proof that there is no backoff: the very next pass asks again,
      // without any clock advance at all.
      const second = await h.scheduler.tick();
      expect(second.deploys[0]?.outcome).toBe('deferred');
      expect(h.deployCalls).toHaveLength(2);
    });

    it('meldet ein `deferred` nicht als Arbeit — sonst wäre der Leerlauf nicht mehr erkennbar', async () => {
      const h = harness({ tasksByState: deploying(), deployOutcome: 'deferred' });
      const report = await h.scheduler.tick();
      // A tick whose only event was a rollout that did not happen has done
      // nothing, and `no_work` is what says so.
      expect(report.idle).toBe('no_work');
    });

    it('holt einen im wrap_up übersprungenen Rollout beim nächsten `normal` sofort nach', async () => {
      // Typed rather than cast: `GuardianDecision` is satisfiable in full here,
      // and an `as unknown as` would absorb the next field added to it — which
      // is exactly what the header of this file refuses for the other stubs.
      let state: GuardianState = 'wrap_up';
      const h = harness({
        guardian: {
          evaluate: async (): Promise<GuardianDecision> => ({
            state,
            reason: { kind: 'below_thresholds' },
            governingWindow: null,
            latches: [],
          }),
        },
        tasksByState: deploying(),
      });

      const deferred = await h.scheduler.tick();
      expect(deferred.idle).toBe('guardian');
      expect(h.deployCalls).toEqual([]);

      // §7.2's reset, and the assertion is that the clock is *not* advanced. A
      // rollout the guardian skipped was never attempted, so anything that
      // treated the skip as a failure — a backoff most plausibly — would hold
      // the release back past the moment the window reopened. Nothing above
      // could see that: the first tick touched neither the task nor the engine.
      state = 'normal';
      const rolled = await h.scheduler.tick();
      expect(rolled.deploys.map((deploy) => deploy.outcome)).toEqual(['deployed']);
      expect(h.deployCalls).toEqual([{ taskId: 'roll-1', projectId: PROJECT.id, sha: MERGED_SHA }]);
      expect(h.scheduler.quarantinedTasks).toEqual([]);
    });

    it('lässt eine auf Entscheidung geparkte Aufgabe in Ruhe (A12, A24)', async () => {
      const h = harness({ tasksByState: deploying(), deployOutcome: 'needs_decision' });
      const report = await h.scheduler.tick();

      expect(report.deploys[0]?.outcome).toBe('needs_decision');
      // The engine parked it and raised the card. §15 holds it as long as it
      // takes, and §6.4's round trip is what brings it back.
      expect(h.scheduler.quarantinedTasks).toEqual([]);
      expect(h.warnings).toEqual([]);
    });

    it('stellt ein `unsupported` genau einmal zurück und protokolliert es (A57.4)', async () => {
      const h = harness({ tasksByState: deploying(), deployOutcome: 'unsupported' });

      await h.scheduler.tick();
      expect(h.scheduler.quarantinedTasks).toEqual(['roll-1']);
      expect(h.events.filter((event) => event.kind === 'scheduler.defect')).toHaveLength(1);
      expect(h.warnings.join('\n')).toContain('roll-1');

      // Once, not once per tick: the answer will be the same every fifteen
      // seconds, and a defect reported at tick frequency is a defect nobody
      // reads.
      await h.scheduler.tick();
      expect(h.events.filter((event) => event.kind === 'scheduler.defect')).toHaveLength(1);
      expect(h.deployCalls).toHaveLength(1);
    });

    it('rollt nichts aus, wenn kein Zustandswechsel den Commit nennt', async () => {
      const h = harness({ tasksByState: deploying(), mergedSha: null });
      const report = await h.scheduler.tick();

      // Nothing was attempted, so there is nothing to report as an attempt —
      // and the task is put aside rather than rolled out from a guessed commit.
      expect(h.deployCalls).toEqual([]);
      expect(report.deploys).toEqual([]);
      expect(h.scheduler.quarantinedTasks).toEqual(['roll-1']);
      expect(h.events.filter((event) => event.kind === 'scheduler.defect')).toHaveLength(1);
      expect(h.warnings.join('\n')).toContain('baseShaAfter');
    });

    it('überlebt eine Maschine, die selbst zusammenbricht, und kommt später wieder', async () => {
      const h = harness({ tasksByState: deploying(), deployThrows: 'Datenbank weg' });

      // The tick resolves rather than rejecting: `deployOnce` is awaited inside
      // `tick()`, so an exception here would take the whole pass with it —
      // including the merges and the dispatch below.
      const report = await h.scheduler.tick();
      expect(report.deploys).toEqual([]);
      expect(h.warnings.join('\n')).toContain('Datenbank weg');
      // Not a defect: the failure was outside the engine, so the task keeps its
      // state and is looked at again after the backoff.
      expect(h.scheduler.quarantinedTasks).toEqual([]);

      await h.scheduler.tick();
      expect(h.deployCalls).toHaveLength(1);
      h.advance(DEFAULT_HARNESS_BACKOFF_MS + 1);
      await h.scheduler.tick();
      expect(h.deployCalls).toHaveLength(2);
    });

    it('setzt einen freigegebenen Selbst-Deploy fort, ohne die Entwicklungskette zu fragen (A12)', async () => {
      const h = harness({
        tasksByState: {
          needs_decision: [
            task({ id: 'freigegeben', state: 'needs_decision', resumeState: 'deploying' }),
          ],
        },
        latestEscalation: { state: 'answered', number: 7 },
      });

      const report = await h.scheduler.tick();

      // §12's two cards have no session behind them: `DeployService` raises
      // them with `runId: null`, and `DevChain.resume` throws on exactly that —
      // so handing this to the chain would quarantine the task the operator has just
      // approved, which is the round trip failing at the moment it worked.
      expect(h.chainResumes).toEqual([]);
      expect(h.scheduler.quarantinedTasks).toEqual([]);
      expect(h.resumed).toEqual(['freigegeben']);
      expect(report.decided).toEqual([{ taskId: 'freigegeben', escalationNumber: 7 }]);
    });

    it('lässt eine auf eine Sitzung geparkte Aufgabe weiter über die Kette laufen (§6.4)', async () => {
      const h = harness({
        tasksByState: {
          needs_decision: [task({ id: 'sitzung', state: 'needs_decision', resumeState: 'coding' })],
        },
        latestEscalation: { state: 'answered', number: 8 },
      });

      await h.scheduler.tick();
      await h.scheduler.settle();

      // The other half of the branch above. Without this case, routing
      // *everything* through `tasks.resume` would pass — and §6.4's whole
      // round trip would silently stop resuming sessions.
      expect(h.chainResumes).toEqual(['sitzung']);
      expect(h.resumed).toEqual([]);
    });

    it('rollt höchstens ein Release je Projekt und Tick aus', async () => {
      const h = harness({
        tasksByState: {
          deploying: [
            task({ id: 'roll-1', state: 'deploying' }),
            task({ id: 'roll-2', state: 'deploying' }),
          ],
        },
      });
      await h.scheduler.tick();
      // Two rollouts of one project would race on the same machine, and the
      // second would swap over a release the first had not finished checking.
      expect(h.deployCalls.map((call) => call.taskId)).toEqual(['roll-1']);
    });

    it('rollt vor dem Merge und beides vor dem Start neuer Arbeit', async () => {
      const h = harness({
        tasksByState: {
          deploying: [task({ id: 'roll-1', state: 'deploying' })],
          queued: [task({ id: 'neu' })],
        },
        mergeCandidates: [{ taskId: 'kandidat' }],
      });
      await h.scheduler.tick();
      await h.scheduler.settle();

      // The order is a decision the header states, and nothing else in this
      // file could catch it: every assertion above passes whatever order the
      // three phases run in.
      expect(h.order).toEqual(['deploy:roll-1', `merge:${PROJECT.id}`, 'chain:neu']);
    });
  });

  describe('§10 — geblockte Aufgaben werden nicht neu geplant', () => {
    it('startet keine Sitzung für eine Aufgabe, deren Claims kollidieren', async () => {
      const h = harness({
        tasksByState: { planning: [task({ id: 't-1', state: 'planning' })] },
        blockers: [
          {
            taskId: 'other',
            taskTitle: 'Andere Aufgabe',
            state: 'coding',
            globs: ['src/**'],
          } as unknown as ClaimConflict,
        ],
      });

      const report = await h.scheduler.tick();

      // The whole point: no session was spawned to discover this. A Planner
      // costs a session, `blockers()` costs one query, and the collision may
      // last for as long as the other task does.
      expect(h.chainRuns).toEqual([]);
      expect(report.blocked).toEqual(['t-1']);
      expect(report.started).toEqual([]);
    });

    it('lässt sie nach dem Backoff wieder zu, wenn die Kollision weg ist', async () => {
      let blocked = true;
      const h = harness({
        blockedBackoffMs: 30_000,
        tasksByState: { planning: [task({ id: 't-1', state: 'planning' })] },
        claims: { blockers: async () => (blocked ? ([{}] as unknown as ClaimConflict[]) : []) },
      });

      await h.scheduler.tick();
      expect(h.chainRuns).toEqual([]);

      blocked = false;
      // Still inside the backoff: the claim registry is not even asked.
      await h.scheduler.tick();
      expect(h.chainRuns).toEqual([]);

      h.advance(30_001);
      await h.scheduler.tick();
      expect(h.chainRuns).toEqual(['t-1']);
      await h.scheduler.settle();
    });
  });

  describe('A7 — Nebenläufigkeit', () => {
    it('startet nie mehr als die konfigurierte Zahl gleichzeitig', async () => {
      const h = harness({
        concurrency: 2,
        tasksByState: { queued: ['a', 'b', 'c', 'd'].map((id) => task({ id })) },
      });
      h.holdChains();

      const first = await h.scheduler.tick();
      expect(first.started.map((s) => s.taskId)).toEqual(['a', 'b']);
      expect(h.scheduler.running).toHaveLength(2);

      // A second tick while both slots are busy starts nothing and says why.
      const second = await h.scheduler.tick();
      expect(second.started).toEqual([]);
      expect(second.idle).toBe('concurrency');

      h.releaseChains();
      await h.scheduler.settle();
      // A real chain leaves the task in `gates`, `red` or a suspended state —
      // never back in `queued` unchanged. The stub has to say so, or the next
      // tick would legitimately pick `a` and `b` up again.
      h.removeTask('a');
      h.removeTask('b');

      const third = await h.scheduler.tick();
      expect(third.started.map((s) => s.taskId)).toEqual(['c', 'd']);
      h.releaseChains();
      await h.scheduler.settle();
    });

    it('kehrt zurück, ohne auf die gestartete Arbeit zu warten', async () => {
      const h = harness({ tasksByState: { queued: [task({ id: 'a' })] } });
      h.holdChains();

      // If `tick()` awaited the chain this would hang: the chain is held open
      // and only released afterwards. A Coder has a 90-minute wall clock, and a
      // tick that waited it out would leave the guardian unasked for 90 minutes.
      const report = await h.scheduler.tick();
      expect(report.started).toHaveLength(1);
      expect(h.scheduler.running).toEqual(['a']);

      h.releaseChains();
      await h.scheduler.settle();
      expect(h.scheduler.running).toEqual([]);
    });

    it('nimmt eine laufende Aufgabe nicht ein zweites Mal', async () => {
      const h = harness({ tasksByState: { queued: [task({ id: 'a' })] } });
      h.holdChains();

      await h.scheduler.tick();
      await h.scheduler.tick();
      expect(h.chainRuns).toEqual(['a']);

      h.releaseChains();
      await h.scheduler.settle();
    });
  });

  describe('Reihenfolge und Priorität', () => {
    it('nimmt die dringendste Aufgabe zuerst', async () => {
      const h = harness({
        concurrency: 1,
        // `listByState` sorts by priority in the real service; the stub returns
        // what it is given, so this asserts the tick preserves that order
        // rather than re-sorting it into something else.
        tasksByState: {
          queued: [task({ id: 'p0', priority: 'P0' }), task({ id: 'p3', priority: 'P3' })],
        },
      });
      const report = await h.scheduler.tick();
      expect(report.started.map((s) => s.taskId)).toEqual(['p0']);
      await h.scheduler.settle();
    });

    it('mergt vor dem Starten, damit Claims im selben Tick frei werden', async () => {
      const order: string[] = [];
      const h = harness({
        tasksByState: { queued: [task({ id: 'neu' })] },
        mergeQueue: {
          list: async () => [{ taskId: 'fertig' }],
          runOnce: async () => {
            order.push('merge');
            return mergeAttempt('merged', 'fertig');
          },
          enqueue: async () => undefined,
        },
      });
      h.setChain(async (taskId) => {
        order.push('chain');
        return chainResult('approved', taskId);
      });

      await h.scheduler.tick();
      await h.scheduler.settle();
      expect(order).toEqual(['merge', 'chain']);
    });

    it('lässt ein Projekt mit leerer Warteschlange in Ruhe', async () => {
      const runOnce = vi.fn(async () => mergeAttempt('idle', null));
      const h = harness({
        mergeQueue: { list: async () => [], runOnce, enqueue: async () => undefined },
      });
      await h.scheduler.tick();
      expect(runOnce).not.toHaveBeenCalled();
    });

    it('überspringt nur lesbare Projekte vollständig (A41)', async () => {
      const runOnce = vi.fn(async () => mergeAttempt('idle', null));
      const h = harness({
        tasksByState: { queued: [task({ id: 'a' })] },
        projects: {
          get: async () => ({ ...PROJECT, readOnly: true }),
          listActive: async () => [{ ...PROJECT, readOnly: true }],
        },
        mergeQueue: {
          list: async () => [{ taskId: 'x' }],
          runOnce,
          enqueue: async () => undefined,
        },
      });

      const report = await h.scheduler.tick();
      expect(runOnce).not.toHaveBeenCalled();
      expect(report.started).toEqual([]);
      // Skipped, not quarantined: a project can be switched to read-only while
      // tasks exist, and that is not the task's defect.
      expect(h.scheduler.quarantinedTasks).toEqual([]);
    });
  });

  describe('Was mit einer beendeten Kette geschieht', () => {
    it('reicht eine freigegebene Aufgabe an die Merge-Warteschlange weiter', async () => {
      const enqueue = vi.fn(async () => undefined);
      const h = harness({
        tasksByState: { queued: [task({ id: 'a' })] },
        mergeQueue: {
          list: async () => [],
          runOnce: async () => mergeAttempt('idle', null),
          enqueue,
        },
      });

      await h.scheduler.tick();
      await h.scheduler.settle();
      expect(enqueue).toHaveBeenCalledWith('a', { actor: 'orchestrator' });
    });

    it('wartet nach einem Harness-Fehler, statt sofort erneut zu starten', async () => {
      const h = harness({
        infraBackoffMs: 120_000,
        tasksByState: { queued: [task({ id: 'a' })] },
      });
      h.setChain(async (taskId) => chainResult('infra', taskId));

      await h.scheduler.tick();
      await h.scheduler.settle();
      await h.scheduler.tick();
      expect(h.chainRuns).toEqual(['a']);

      h.advance(120_001);
      await h.scheduler.tick();
      await h.scheduler.settle();
      expect(h.chainRuns).toEqual(['a', 'a']);
    });

    it('setzt nach §9 rot keinen eigenen Backoff — die Priorität ist die Bremse', async () => {
      const h = harness({ tasksByState: { queued: [task({ id: 'a' })] } });
      h.setChain(async (taskId) => chainResult('red', taskId));

      await h.scheduler.tick();
      await h.scheduler.settle();
      await h.scheduler.tick();
      await h.scheduler.settle();
      // §9 requeued it at a lower priority; a backoff here would be a second,
      // undeclared throttle on top of the one §9 already applied.
      expect(h.chainRuns).toEqual(['a', 'a']);
    });
  });

  /**
   * A25's second half, for the dev chain.
   *
   * The observed failure is the whole reason these exist: four tasks failing
   * every fifteen seconds for two hours with `status: infra`, and no `ops.alert`
   * anywhere in this module. The retry was built; the "and then say so" was not.
   */
  describe('A25 — ein anhaltender Umgebungsfehler wird gemeldet, genau einmal', () => {
    /** Run one pass of a task whose chain reports `infra`, and let it settle. */
    async function failOnce(h: ReturnType<typeof harness>): Promise<void> {
      h.setChain(async (taskId) => chainResult('infra', taskId));
      await h.scheduler.tick();
      await h.scheduler.settle();
    }

    it('schweigt, solange die Schwelle nicht erreicht ist', async () => {
      const h = harness({
        tasksByState: { queued: [task({ id: 'a' })] },
        infraChains: OPS_ALERT_AFTER_INFRA_ATTEMPTS - 1,
      });
      await failOnce(h);

      expect(h.opsAlerts).toEqual([]);
      expect(h.events.filter((event) => event.kind === 'ops.alert')).toEqual([]);
    });

    it('meldet, sobald die Schwelle überschritten wird — und lässt die Aufgabe in Ruhe', async () => {
      const h = harness({
        tasksByState: { queued: [task({ id: 'a' })] },
        infraChains: OPS_ALERT_AFTER_INFRA_ATTEMPTS,
      });
      await failOnce(h);

      expect(h.opsAlerts).toHaveLength(1);
      expect(h.opsAlerts[0]?.taskId).toBe('a');
      expect(h.opsAlerts[0]?.attempts).toBe(OPS_ALERT_AFTER_INFRA_ATTEMPTS);
      expect(h.opsAlerts[0]?.problem).toBe('Grund');
      expect(h.events.filter((event) => event.kind === 'ops.alert')).toHaveLength(1);
      // A25: the task is not red and not moved. Nothing here transitions it.
      expect(h.events.some((event) => event.kind === 'scheduler.defect')).toBe(false);
    });

    it('meldet nicht noch einmal, wenn der Fehler anhält (A67.6)', async () => {
      // The property that separates a usable channel from a muted one. `>=`
      // instead of `!==` would push a notification on every pass for as long as
      // the machine stays broken, and then the next real alert is invisible.
      const h = harness({
        tasksByState: { queued: [task({ id: 'a' })] },
        infraChains: OPS_ALERT_AFTER_INFRA_ATTEMPTS + 4,
      });
      await failOnce(h);

      expect(h.opsAlerts).toEqual([]);
    });

    it('meldet nichts, wenn die Kette aus einem anderen Grund endet', async () => {
      // The alert is about the environment. A task that fails, parks or is
      // approved has said something about itself, and A25 does not apply.
      for (const status of ['approved', 'red', 'parked', 'blocked'] as const) {
        const h = harness({
          tasksByState: { queued: [task({ id: 'a' })] },
          infraChains: OPS_ALERT_AFTER_INFRA_ATTEMPTS,
        });
        h.setChain(async (taskId) => chainResult(status, taskId));
        await h.scheduler.tick();
        await h.scheduler.settle();
        expect(h.opsAlerts, status).toEqual([]);
      }
    });

    it('verschluckt einen Fehler beim Zählen, statt den Tick abstürzen zu lassen', async () => {
      // `finished` runs inside `start().then(…)` and nobody catches a rejection
      // from it, so an unreachable database at this exact moment would turn a
      // reported infrastructure fault into an unhandled rejection — a fault
      // report that takes the reporter down with it.
      const h = harness({
        tasksByState: { queued: [task({ id: 'a' })] },
        infraHistory: {
          consecutiveInfraChains: async () => {
            throw new Error('Datenbank weg');
          },
        },
      });
      await expect(failOnce(h)).resolves.toBeUndefined();
      expect(h.warnings.some((line) => line.includes('nicht meldbar'))).toBe(true);
    });
  });

  describe('A57 — ein Fehler im Ablauf ist keine gescheiterte Aufgabe', () => {
    it('stellt eine Aufgabe zurück, die die Kette gar nicht annehmen kann', async () => {
      const h = harness({ tasksByState: { queued: [task({ id: 'a' })] } });
      h.setChain(async () => {
        throw new DevChainError('a', 'Projekt ist nur lesbar (A41)');
      });

      await h.scheduler.tick();
      await h.scheduler.settle();

      expect(h.scheduler.quarantinedTasks).toEqual(['a']);
      expect(h.events.filter((e) => e.kind === 'scheduler.defect')).toHaveLength(1);

      // The failure mode this exists for: the same error at tick frequency,
      // forever. A second tick must not produce a second attempt.
      await h.scheduler.tick();
      await h.scheduler.settle();
      expect(h.chainRuns).toEqual(['a']);
      expect(h.events.filter((e) => e.kind === 'scheduler.defect')).toHaveLength(1);
    });

    it('markiert einen unerwarteten Fehler nicht als Defekt, sondern wartet', async () => {
      const h = harness({
        infraBackoffMs: 60_000,
        tasksByState: { queued: [task({ id: 'a' })] },
      });
      h.setChain(async () => {
        throw new Error('Datenbank weg');
      });

      await h.scheduler.tick();
      await h.scheduler.settle();
      expect(h.scheduler.quarantinedTasks).toEqual([]);
      expect(h.warnings.some((w) => w.includes('Datenbank weg'))).toBe(true);

      h.advance(60_001);
      await h.scheduler.tick();
      await h.scheduler.settle();
      expect(h.chainRuns).toEqual(['a', 'a']);
    });

    it('legt ein Projekt still, dessen Warteschlange gar nicht laufen kann', async () => {
      const runOnce = vi.fn(async () => {
        throw new MergeQueueError(
          PROJECT.id,
          'Deploy-Methode "compose" gibt es noch nicht (A55.6)',
        );
      });
      const h = harness({
        infraBackoffMs: 60_000,
        mergeQueue: {
          list: async () => [{ taskId: 'x' }],
          runOnce,
          enqueue: async () => undefined,
        },
      });

      await h.scheduler.tick();
      await h.scheduler.tick();
      expect(runOnce).toHaveBeenCalledTimes(1);
      expect(h.events.filter((e) => e.kind === 'scheduler.defect')).toHaveLength(1);

      h.advance(60_001);
      await h.scheduler.tick();
      expect(runOnce).toHaveBeenCalledTimes(2);
    });
  });

  describe('§8.2 — die Kadenz der Betriebsprüfung', () => {
    it('läuft, wenn seit der letzten Prüfung eine Woche vergangen ist', async () => {
      const run = vi.fn(async (_request: AuditRequestShape) => auditRun('a-1'));
      const h = harness({
        weeklyAuditIntervalMs: 7 * 24 * 3_600_000,
        audits: {
          run,
          recent: async () => [{ startedAt: new Date(Date.parse('2026-07-24T09:00:00Z')) }],
        },
      });

      const report = await h.scheduler.tick();
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0]).toMatchObject({ trigger: 'weekly' });
      expect(report.audit?.id).toBe('a-1');
    });

    it('läuft nicht, solange die Woche nicht um ist', async () => {
      const run = vi.fn(async () => auditRun('a-1'));
      const h = harness({
        weeklyAuditIntervalMs: 7 * 24 * 3_600_000,
        audits: {
          run,
          recent: async () => [{ startedAt: new Date(Date.parse('2026-07-30T09:00:00Z')) }],
        },
      });
      await h.scheduler.tick();
      expect(run).not.toHaveBeenCalled();
    });

    it('prüft sofort, wenn es noch nie eine Prüfung gab', async () => {
      const run = vi.fn(async () => auditRun('a-1'));
      const h = harness({ audits: { run, recent: async () => [] } });
      await h.scheduler.tick();
      expect(run).toHaveBeenCalledTimes(1);
    });

    it('merkt sich einen Hard-Stop und prüft erst, wenn wieder Budget da ist', async () => {
      const run = vi.fn(async (_request: AuditRequestShape) => auditRun('a-1'));
      let state = 'normal';
      const h = harness({
        weeklyAuditIntervalMs: 7 * 24 * 3_600_000,
        audits: {
          run,
          recent: async () => [{ startedAt: new Date(Date.parse('2026-08-01T08:00:00Z')) }],
        },
        guardian: {
          evaluate: async () => ({ state }) as unknown as GuardianDecision,
        },
      });

      state = 'hard_stop';
      await h.scheduler.tick();
      // §8.2 lists `post_hard_stop` as a trigger; §7.2 forbids a session while
      // the state that triggered it persists. So it is remembered, not run.
      expect(run).not.toHaveBeenCalled();

      state = 'normal';
      await h.scheduler.tick();
      expect(run).toHaveBeenCalledTimes(1);
      expect(run.mock.calls[0]?.[0]).toMatchObject({ trigger: 'post_hard_stop' });

      // And it does not fire a second time for the same stop.
      await h.scheduler.tick();
      expect(run).toHaveBeenCalledTimes(1);
    });

    /**
     * §8.2's `gate_flip`, which until now was a value in `AUDIT_TRIGGERS` with
     * no producer: `requestAudit` had no caller outside a test, and nothing in
     * this system ever asked whether a gate had changed its mind about an
     * unchanged tree.
     *
     * The watermark is the load-bearing half and it is asserted twice, from
     * both sides. Held in memory it would re-fire after every restart — a model
     * session per deploy for a flip already examined — and read from the record
     * it must still fire for a flip *newer* than the last examination.
     */
    describe('§8.2 — gate_flip', () => {
      const FLIP = {
        gateId: 'test',
        taskId: 't-flip',
        projectId: 'p-1',
        resolvedAt: new Date(Date.parse('2026-08-01T08:50:00Z')),
      };

      it('merkt eine Rot-nach-Grün-Wendung auf unverändertem Baum vor', async () => {
        const run = vi.fn(async (_request: AuditRequestShape) => auditRun('a-flip'));
        const h = harness({
          weeklyAuditIntervalMs: 7 * 24 * 3_600_000,
          audits: {
            run,
            // Recent enough that the weekly cadence is not what fires here —
            // without this the case would pass on `weekly` and prove nothing.
            recent: async () => [{ startedAt: new Date(Date.parse('2026-08-01T08:00:00Z')) }],
          },
          gateFlips: { flipsWithoutCodeChange: async () => [FLIP] },
        });

        const report = await h.scheduler.tick();
        expect(run).toHaveBeenCalledTimes(1);
        expect(run.mock.calls[0]?.[0]).toMatchObject({ trigger: 'gate_flip' });
        expect(report.audit?.id).toBe('a-flip');
        expect(h.warnings.join('\n')).toContain('test');
      });

      it('prüft dieselbe Wendung nicht zweimal — auch nach einem Neustart nicht', async () => {
        const run = vi.fn(async (_request: AuditRequestShape) => auditRun('a-flip'));
        // The record a restarted process would read: an audit of this very
        // flip, started after it was resolved. A watermark held in memory
        // cannot see this, which is the whole point of reading it back.
        const h = harness({
          weeklyAuditIntervalMs: 7 * 24 * 3_600_000,
          audits: {
            run,
            recent: async () => [
              { startedAt: new Date(Date.parse('2026-08-01T08:55:00Z')), trigger: 'gate_flip' },
            ],
          },
          gateFlips: { flipsWithoutCodeChange: async () => [FLIP] },
        });

        await h.scheduler.tick();
        expect(run).not.toHaveBeenCalled();
      });

      it('prüft eine Wendung, die nach der letzten Prüfung dieser Art aufgetreten ist', async () => {
        const run = vi.fn(async (_request: AuditRequestShape) => auditRun('a-flip'));
        const h = harness({
          weeklyAuditIntervalMs: 7 * 24 * 3_600_000,
          audits: {
            run,
            recent: async () => [
              // Older than the flip: this examination cannot have covered it.
              { startedAt: new Date(Date.parse('2026-08-01T08:40:00Z')), trigger: 'gate_flip' },
            ],
          },
          gateFlips: { flipsWithoutCodeChange: async () => [FLIP] },
        });

        await h.scheduler.tick();
        expect(run.mock.calls[0]?.[0]).toMatchObject({ trigger: 'gate_flip' });
      });

      it('lässt eine Prüfung anderer Art die Wendung nicht abdecken', async () => {
        const run = vi.fn(async (_request: AuditRequestShape) => auditRun('a-flip'));
        const h = harness({
          weeklyAuditIntervalMs: 7 * 24 * 3_600_000,
          audits: {
            run,
            // A weekly audit newer than the flip. It examined one domain of the
            // studio's claims; it did not examine this gate, and treating any
            // recent audit as the watermark would silently retire the trigger.
            recent: async () => [
              { startedAt: new Date(Date.parse('2026-08-01T08:55:00Z')), trigger: 'weekly' },
            ],
          },
          gateFlips: { flipsWithoutCodeChange: async () => [FLIP] },
        });

        await h.scheduler.tick();
        expect(run.mock.calls[0]?.[0]).toMatchObject({ trigger: 'gate_flip' });
      });

      it('nimmt der Prüfung nicht den Tick, wenn die Abfrage scheitert', async () => {
        const run = vi.fn(async (_request: AuditRequestShape) => auditRun('a-1'));
        const h = harness({
          audits: { run, recent: async () => [] },
          gateFlips: {
            flipsWithoutCodeChange: async () => {
              throw new Error('gate_runs nicht lesbar');
            },
          },
        });

        // The weekly cadence still fires: failing to *notice* a flip must not
        // cost the pass the audit it was already owed.
        const report = await h.scheduler.tick();
        expect(report.audit?.id).toBe('a-1');
        expect(h.warnings.join('\n')).toContain('gate_runs nicht lesbar');
      });
    });

    it('behält den Auslöser, wenn die Prüfung selbst fehlschlägt', async () => {
      let attempts = 0;
      const run = vi.fn(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('Sitzung abgebrochen');
        return auditRun('a-2');
      });
      const h = harness({ audits: { run, recent: async () => [] } });

      const first = await h.scheduler.tick();
      // §8.2 measures the auditor on finding nothing; an audit that could not
      // run must never be indistinguishable from one that found nothing.
      expect(first.audit).toBeNull();

      const second = await h.scheduler.tick();
      expect(second.audit?.id).toBe('a-2');
    });
  });

  describe('Leerlauf', () => {
    it('sagt `no_work`, wenn es nichts zu tun gab', async () => {
      const h = harness();
      const report = await h.scheduler.tick();
      expect(report.idle).toBe('no_work');
    });

    it('sagt nicht `no_work`, wenn ein Merge stattgefunden hat', async () => {
      const h = harness({
        mergeQueue: {
          list: async () => [{ taskId: 'x' }],
          runOnce: async () => mergeAttempt('merged', 'x'),
          enqueue: async () => undefined,
        },
      });
      const report = await h.scheduler.tick();
      expect(report.idle).toBeNull();
    });

    it('zählt einen belegten Merge-Slot nicht als Arbeit', async () => {
      const h = harness({
        mergeQueue: {
          list: async () => [{ taskId: 'x' }],
          runOnce: async () => mergeAttempt('busy', null),
          enqueue: async () => undefined,
        },
      });
      const report = await h.scheduler.tick();
      expect(report.idle).toBe('no_work');
    });
  });

  describe('A44.3 — eine Aufgabe auf einem nur lesbaren Projekt verschwindet nicht mehr', () => {
    /** Derselbe Aufbau wie sonst, nur steht das Projekt auf Nur-Lesen. */
    const readOnlyHarness = (tasks: TaskRecord[]) =>
      harness({
        tasksByState: { queued: tasks },
        projects: {
          get: async () => ({ ...PROJECT, readOnly: true }) as ProjectRecord,
          listActive: async () => [{ ...PROJECT, readOnly: true } as ProjectRecord],
        },
      });

    it('nennt sie im Tick-Bericht, statt sie stillschweigend zu überspringen', async () => {
      // Der gefundene Zustand: das `continue` stand vor jedem Sammler, also
      // erschien die Aufgabe in `started` nicht, in `blocked` nicht und damit
      // in der ganzen Rechenschaft des Ticks nicht.
      const h = readOnlyHarness([task({ id: 't-ro' })]);
      const report = await h.scheduler.tick();

      expect(report.readOnly).toEqual(['t-ro']);
      expect(report.started).toEqual([]);
      expect(h.chainRuns).toEqual([]);
    });

    it('hält sie von `blocked` getrennt — zwei Ursachen mit zwei Auswegen', async () => {
      // Eine Claim-Kollision löst sich, wenn der Halter merged; diese löst sich
      // nur, wenn der Betreiber die Kennzeichnung zurücknimmt (A85). Ein gemeinsames Feld
      // würde die beiden Sätze auf der Übersicht ununterscheidbar machen.
      const h = readOnlyHarness([task({ id: 't-ro' })]);
      const report = await h.scheduler.tick();
      expect(report.blocked).toEqual([]);
      expect(report.readOnly).toEqual(['t-ro']);
    });

    it('stellt sie nicht zurück — ein nur lesbares Projekt ist kein Fehler im Ablauf', async () => {
      // A57.4s Quarantäne ist für „der Ablaufplaner wurde um etwas Unmögliches
      // gebeten". Ein Projekt darf auf Nur-Lesen gestellt werden, während
      // Aufgaben darauf existieren; die kommen wieder, sobald es zurückgestellt
      // wird, und eine Quarantäne im Speicher würde genau das verhindern.
      const h = readOnlyHarness([task({ id: 't-ro' })]);
      await h.scheduler.tick();
      await h.scheduler.tick();

      expect(h.scheduler.quarantinedTasks).toEqual([]);
      expect(h.events.filter((event) => event.kind === 'scheduler.defect')).toEqual([]);
      // Und beim zweiten Tick steht sie wieder da: nichts hat sie verbraucht.
      expect((await h.scheduler.tick()).readOnly).toEqual(['t-ro']);
    });
  });

  describe('§21 — Leerlauf-Audits, der sechste Schritt', () => {
    const idleRun = (over: Partial<IdleAuditRun> = {}): IdleAuditRun => ({
      projectId: 'p-1',
      projectSlug: 'sandbox',
      domain: 'security',
      runId: 'run-1',
      taskIds: ['t-neu'],
      summary: 'Eine Stelle ohne Timeout.',
      ...over,
    });

    /** Ein Dienst, der mitschreibt, ob und wie oft er gefragt wurde. */
    const idleAudits = (
      answer: () => Promise<{ run: IdleAuditRun | null; skip: IdleAuditSkip | null }>,
    ) => {
      const calls: number[] = [];
      return {
        calls,
        dispatch: {
          runOnce: async () => {
            calls.push(1);
            return answer();
          },
        },
      };
    };

    it('läuft, wenn der Tick nichts zu tun hatte', async () => {
      const idle = idleAudits(async () => ({ run: idleRun(), skip: null }));
      const h = harness({ idleAudits: idle.dispatch });
      const report = await h.scheduler.tick();

      expect(report.idle).toBe('no_work');
      expect(idle.calls).toHaveLength(1);
      expect(report.idleAudit?.taskIds).toEqual(['t-neu']);
      expect(report.idleAuditSkip).toBeNull();
    });

    it('läuft nicht, wenn der Tick Arbeit gestartet hat — A17s leere Warteschlange', async () => {
      const idle = idleAudits(async () => ({ run: idleRun(), skip: null }));
      const h = harness({
        idleAudits: idle.dispatch,
        tasksByState: { queued: [task({ id: 'a' })] },
      });
      const report = await h.scheduler.tick();

      expect(report.started).toHaveLength(1);
      expect(report.idle).toBeNull();
      expect(idle.calls).toEqual([]);
      expect(report.idleAudit).toBeNull();
    });

    it('läuft nicht, wenn der Wächter nicht `normal` sagt — A17s zweite Bedingung', async () => {
      const idle = idleAudits(async () => ({ run: idleRun(), skip: null }));
      const h = harness({ idleAudits: idle.dispatch, guardianState: 'wrap_up' });
      const report = await h.scheduler.tick();

      expect(report.idle).toBe('guardian');
      expect(idle.calls).toEqual([]);
    });

    it('läuft nicht, wenn alle Plätze belegt sind — `concurrency` ist kein Leerlauf', async () => {
      // Das Studio ist beschäftigt, seine Plätze sind voll, und eine elfte
      // Sitzung dort ist das Gegenteil davon, eine Lücke zu füllen.
      const idle = idleAudits(async () => ({ run: idleRun(), skip: null }));
      const h = harness({
        idleAudits: idle.dispatch,
        concurrency: 1,
        tasksByState: { queued: [task({ id: 'a' })] },
      });
      h.holdChains();
      await h.scheduler.tick();
      h.removeTask('a');

      const report = await h.scheduler.tick();
      expect(report.idle).toBe('concurrency');
      expect(idle.calls).toEqual([]);
      h.releaseChains();
      await h.scheduler.settle();
    });

    it('gibt den Grund weiter, wenn der Dienst ablehnt', async () => {
      const skip: IdleAuditSkip = { reason: 'budget', window: 'seven_day', usedPercent: 61 };
      const idle = idleAudits(async () => ({ run: null, skip }));
      const h = harness({ idleAudits: idle.dispatch });
      const report = await h.scheduler.tick();

      expect(report.idleAudit).toBeNull();
      expect(report.idleAuditSkip).toEqual(skip);
    });

    it('tritt hinter eine fällige Betriebsprüfung zurück und kommt im nächsten Tick', async () => {
      // §8.2s Kadenz wird zuerst entschieden, und eine gelaufene Prüfung *ist*
      // Arbeit — der Tick ist dann nicht leer, also füllt §21 nichts. Das ist
      // die richtige Richtung und nicht nur die vorgefundene: beide sind
      // Modellsitzungen, und zwei in einem Tick wären zwei Sitzungen für
      // Arbeit, auf die niemand wartet. Fünfzehn Sekunden später ist die
      // Prüfung nicht mehr fällig und das Leerlauf-Audit läuft.
      const order: string[] = [];
      const idle = idleAudits(async () => {
        order.push('idle');
        return { run: idleRun(), skip: null };
      });
      let letzte: Date | null = null;
      const h = harness({
        idleAudits: idle.dispatch,
        audits: {
          run: async () => {
            order.push('audit');
            letzte = new Date(Date.parse('2026-08-01T09:00:00Z'));
            return auditRun('a-idle');
          },
          recent: async () => (letzte ? [{ startedAt: letzte, trigger: 'weekly' }] : []),
        },
      });

      const erster = await h.scheduler.tick();
      expect(erster.audit).not.toBeNull();
      expect(erster.idle).toBeNull();
      expect(idle.calls).toEqual([]);

      const zweiter = await h.scheduler.tick();
      expect(zweiter.audit).toBeNull();
      expect(zweiter.idleAudit).not.toBeNull();
      expect(order).toEqual(['audit', 'idle']);
    });

    it('lässt §8.2 auch auf einem beschäftigten Tick laufen — nie als Leerlauf-Füller', async () => {
      // Die andere Richtung derselben Trennung, und die, die §8.2 wörtlich
      // verlangt: „an audit that runs only when nothing else is queued is not
      // scheduled". Idle-Sein ist für §21 die Bedingung und für §8.2 belanglos.
      const idle = idleAudits(async () => ({ run: idleRun(), skip: null }));
      const h = harness({
        idleAudits: idle.dispatch,
        tasksByState: { queued: [task({ id: 'a' })] },
        audits: { run: async () => auditRun('a-busy'), recent: async () => [] },
      });
      const report = await h.scheduler.tick();

      expect(report.started).toHaveLength(1);
      expect(report.audit).not.toBeNull();
      expect(idle.calls).toEqual([]);
    });

    it('lässt einen Fehler im Leerlauf-Audit den Tick-Bericht nicht kosten', async () => {
      // Dieser Schritt läuft ganz am Ende. Eine Ausnahme hier würde einen
      // Bericht verwerfen, der echte Merges und echte Starts beschreibt, um
      // sich über freiwillige Füllarbeit zu beschweren.
      const h = harness({
        idleAudits: {
          runOnce: async () => {
            throw new Error('Datenbank weg');
          },
        },
      });
      const report = await h.scheduler.tick();

      expect(report.guardianState).toBe('normal');
      expect(report.idleAudit).toBeNull();
      expect(h.warnings.some((line) => line.includes('Leerlauf-Audit'))).toBe(true);
    });

    it('tut ohne Dienst gar nichts, und das ist sichtbar', async () => {
      const report = await harness().scheduler.tick();
      expect(report.idle).toBe('no_work');
      expect(report.idleAudit).toBeNull();
      expect(report.idleAuditSkip).toBeNull();
    });
  });
});
