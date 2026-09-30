/**
 * The dev chain end to end (§8.1, §9, §10) — Phase 2 step 7b.
 *
 * Everything here is real except the model: a real Postgres, a real git
 * repository built by `createSandboxProject`, real worktrees, real claims, real
 * task events. The three sessions are scripted (A37), because the property
 * under test is what the *studio* does with three results — and a chain that
 * only works when a real model happens to cooperate is a chain nobody can
 * regression-test.
 *
 * The one thing the fake does that a stand-in usually would not: the Coder's
 * script writes actual files into the worktree. That is what makes the claim
 * check (§10) a check rather than a formality — it reads a real `git diff`.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type { SessionSpec } from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentChannel } from './agent-channel.js';
import { FakeBackend, type FakeEvent, type FakeScript } from './backend/fake.js';
import { ClaimRegistry } from './claim-registry.js';
import { DevChain, DevChainError, type DevChainResult } from './dev-chain.js';
import { EscalationService } from './escalation-service.js';
import { EventLog } from './event-log.js';
import { FindingsService } from './findings.js';
import { BOT_IDENTITY } from './git.js';
import { ProjectService } from './project-service.js';
import { RunRecords } from './run-records.js';
import { AgentRunner, type RunnerPaths } from './runner.js';
import { createSandboxProject, type SandboxProject } from './sandbox.js';
import { TaskService } from './task-service.js';
import { WorktreeManager } from './worktree.js';

const execFile = promisify(execFileCallback);

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

const HOOK_PRETOOL: FakeEvent = {
  type: 'hook_event',
  event: 'PreToolUse',
  hookName: 'PreToolUse:Write',
  phase: 'response',
  outcome: 'success',
  exitCode: 0,
};

const TOOL_USE: FakeEvent = {
  type: 'tool_use',
  tool: 'Write',
  input: { file_path: 'src/greet.js' },
};

function result(raw: unknown): NonNullable<FakeScript['result']> {
  return { raw, tokensIn: 120, tokensOut: 340 };
}

const PLAN = {
  status: 'done',
  summary: 'Plan erstellt.',
  artifacts: [],
  followups: [],
  claimSet: ['src/**', 'greet.test.js'],
  plan: ['Begrüßung um eine Anrede erweitern', 'Test ergänzen'],
  testPlan: ['npm test'],
  risks: [],
};

const CODED = { status: 'done', summary: 'Umgesetzt und getestet.', artifacts: [], followups: [] };

const APPROVED = {
  status: 'done',
  summary: 'Sieht gut aus.',
  artifacts: [],
  followups: [],
  verdict: 'approve',
  findings: [],
  claimsRespected: true,
};

const REJECTED = {
  status: 'done',
  summary: 'Der Test prüft die Änderung nicht.',
  artifacts: [],
  followups: [],
  verdict: 'changes_requested',
  findings: [
    {
      file: 'greet.test.js',
      line: 7,
      severity: 'blocker',
      summary: 'Test würde auch ohne die Änderung bestehen.',
    },
  ],
  claimsRespected: true,
};

/** What one role's session should do this time. */
interface RoleScript {
  script: FakeScript;
  /** Side effect before the session "runs" — the files a Coder would write. */
  work?(cwd: string): Promise<void>;
  /**
   * The same, but handed the whole spec.
   *
   * §6.4's tests need the run id, because that is what an escalation carries and
   * what the continuation is resumed from — and the runner mints it, so the only
   * place to read it is the spec the backend was spawned with.
   */
  onSpawn?(spec: SessionSpec): Promise<void>;
}

interface ChainScriptOptions {
  planner?: RoleScript[];
  coder?: RoleScript[];
  reviewer?: RoleScript[];
  debugger?: RoleScript[];
}

/**
 * A resolver that hands each role its own script, walking the list per role and
 * holding on the last entry — so "reject, then approve" is two entries and
 * "always reject" is one.
 */
function chainScripts(options: ChainScriptOptions) {
  const counts: Record<string, number> = {};
  const seen: SessionSpec[] = [];
  const resolver = async (spec: SessionSpec): Promise<FakeScript> => {
    seen.push(spec);
    const list = options[spec.role as keyof ChainScriptOptions];
    if (!list || list.length === 0) {
      throw new Error(`Kein Skript für Rolle "${spec.role}" hinterlegt`);
    }
    const index = counts[spec.role] ?? 0;
    counts[spec.role] = index + 1;
    const entry = list[Math.min(index, list.length - 1)] as RoleScript;
    await entry.work?.(spec.cwd);
    await entry.onSpawn?.(spec);
    return entry.script;
  };
  return { resolver, seen, counts };
}

function ok(raw: unknown, extra: FakeEvent[] = []): RoleScript {
  return { script: { events: [HOOK_START, ...extra], result: result(raw) } };
}

describe.skipIf(!url)('Entwicklungskette (§8.1)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let tasks: TaskService;
  let projects: ProjectService;
  let claims: ClaimRegistry;
  let worktrees: WorktreeManager;
  let eventLog: EventLog;
  let scratch: string;
  let paths: RunnerPaths;
  let sandbox: SandboxProject;
  let readOnlyProjectId: string;

  beforeAll(async () => {
    database = await createTestDatabase('devchain');
    sql = createSql({ url: database.url, max: 4 });
    eventLog = new EventLog(sql);
    tasks = new TaskService({ sql, eventLog });
    projects = new ProjectService(sql);
    claims = new ClaimRegistry({ sql, tasks, projects, eventLog });
    scratch = await mkdtemp(join(tmpdir(), 'vs-chain-'));
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

    sandbox = await createSandboxProject({ path: join(scratch, 'sandkasten') });
    readOnlyProjectId = (
      await projects.create({
        slug: 'nur-lesbar',
        name: 'Nur lesbar',
        rootPath: sandbox.path,
        readOnly: true,
      })
    ).id;
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
    await rm(scratch, { recursive: true, force: true });
  });

  let seq = 0;

  /**
   * A project of its own for each test, over the same repository.
   *
   * Cheaper and more honest than aborting every task after each test: claims
   * are scoped to a project (§10), so distinct project rows make the tests
   * independent without anyone having to move a task to a terminal state it
   * never reached. The one test that is *about* two tasks colliding creates
   * them in one project deliberately.
   */
  async function newProject(): Promise<string> {
    seq += 1;
    const project = await projects.create({
      slug: `sandkasten-${seq}`,
      name: `Sandkasten ${seq}`,
      rootPath: sandbox.path,
      defaultBranch: sandbox.defaultBranch,
    });
    return project.id;
  }

  async function newTask(project?: string, priority: 'P0' | 'P1' | 'P2' | 'P3' = 'P1') {
    const projectRef = project ?? (await newProject());
    return tasks.create({
      projectId: projectRef,
      title: `Begrüßung erweitern ${seq}`,
      description: 'Die Begrüßung soll eine Anrede tragen.',
      acceptanceCriteria: ['greet() liefert die Anrede', 'Ein Test deckt sie ab'],
      priority,
    });
  }

  function chain(
    options: ChainScriptOptions,
    overrides: Partial<ConstructorParameters<typeof DevChain>[0]> = {},
  ) {
    const scripts = chainScripts(options);
    const backend = new FakeBackend(scripts.resolver);
    const runner = new AgentRunner({ sql, eventLog, backend, paths });
    const devChain = new DevChain({
      tasks,
      projects,
      claims,
      worktrees,
      runner,
      runs: new RunRecords(sql),
      eventLog,
      findings: new FindingsService({ sql }),
      escalations: new EscalationService({ sql, eventLog }),
      gateTools: () => sandbox.tools,
      // Backoff is exercised by counting attempts, not by waiting for them.
      sleep: async () => undefined,
      ...overrides,
    });
    return { chain: devChain, backend, scripts };
  }

  /** The Coder's work: a change inside the claim set. */
  const writeClaimed = async (cwd: string) => {
    await writeFile(join(cwd, 'src', 'greet.js'), 'export const greet = (n) => "Hallo, " + n;\n');
  };

  /** The Coder's work: a change the claim set does not cover. */
  const writeUnclaimed = async (cwd: string) => {
    await writeClaimed(cwd);
    await writeFile(join(cwd, 'README.md'), '# Verändert\n');
  };

  /**
   * The same, but committed — which the prompts tell a Coder to do.
   *
   * Worth its own case: a check that only reads the working tree would report a
   * clean diff for exactly the Coder that followed instructions.
   */
  const commitUnclaimed = async (cwd: string) => {
    await writeUnclaimed(cwd);
    const git = (...args: string[]) =>
      execFile('git', args, {
        cwd,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: BOT_IDENTITY.name,
          GIT_AUTHOR_EMAIL: BOT_IDENTITY.email,
          GIT_COMMITTER_NAME: BOT_IDENTITY.name,
          GIT_COMMITTER_EMAIL: BOT_IDENTITY.email,
        },
      });
    await git('add', '--all');
    await git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'feat: Anrede');
  };

  describe('der glückliche Pfad', () => {
    let outcome: DevChainResult;
    let taskId: string;
    let seen: SessionSpec[];

    beforeAll(async () => {
      const task = await newTask();
      taskId = task.id;
      const built = chain({
        planner: [ok(PLAN)],
        coder: [{ script: ok(CODED, [TOOL_USE, HOOK_PRETOOL]).script, work: writeClaimed }],
        reviewer: [ok(APPROVED)],
      });
      seen = built.scripts.seen;
      outcome = await built.chain.run(taskId);
    });

    it('führt genau drei Sitzungen in der Reihenfolge des §8.1 aus', () => {
      expect(seen.map((spec) => spec.role)).toEqual(['planner', 'coder', 'reviewer']);
    });

    it('erteilt das Review und stellt die Aufgabe auf "gates"', async () => {
      expect(outcome.status).toBe('approved');
      expect(outcome.problem).toBeNull();
      expect(outcome.rounds).toBe(1);
      expect((await tasks.get(taskId))?.state).toBe('gates');
    });

    it('durchläuft die Zustände des §9 lückenlos', async () => {
      const rows = await sql<Array<{ state: string }>>`
        SELECT state FROM task_events
        WHERE task_id = ${taskId} AND kind = 'state_changed' ORDER BY seq
      `;
      expect(rows.map((r) => r.state)).toEqual([
        'planning',
        'claimed',
        'coding',
        'review',
        'gates',
      ]);
    });

    it('belegt die vom Planer genannten Pfade (§10)', async () => {
      const held = await claims.heldGlobs(taskId);
      expect(held.sort()).toEqual(['greet.test.js', 'src/**']);
    });

    it('gibt dem Coder einen eigenen Worktree und dem Review denselben', () => {
      const [planner, coder, reviewer] = seen;
      expect(coder?.cwd).toContain('worktrees');
      expect(reviewer?.cwd).toBe(coder?.cwd);
      expect(planner?.cwd).toBe(coder?.cwd);
    });

    it('lässt nur den Coder schreiben — Planer und Review laufen ohne Schreibwurzel', async () => {
      const rows = await sql<Array<{ role: string; writes: boolean }>>`
        SELECT payload ->> 'role' AS role, (payload ->> 'writes')::boolean AS writes
        FROM agent_run_events WHERE kind = 'created' AND payload ->> 'taskId' = ${taskId}
        ORDER BY id
      `;
      expect(rows).toEqual([
        { role: 'planner', writes: false },
        { role: 'coder', writes: true },
        { role: 'reviewer', writes: false },
      ]);
    });

    it('reicht dem Coder die Bau-Kommandos des Projekts als Bash-Scopes (A46.4)', () => {
      const coder = seen.find((spec) => spec.role === 'coder');
      for (const tool of sandbox.tools) expect(coder?.allowedTools).toContain(tool);
      // Und dem Review nicht: es liest nur.
      const reviewer = seen.find((spec) => spec.role === 'reviewer');
      expect(reviewer?.allowedTools).not.toContain(sandbox.tools[0]);
    });

    it('trägt Plan und Claim-Set in den Auftrag des Coders (nicht nur in MCP)', () => {
      const coder = seen.find((spec) => spec.role === 'coder');
      expect(coder?.prompt).toContain('Begrüßung um eine Anrede erweitern');
      expect(coder?.prompt).toContain('src/**');
      expect(coder?.prompt).toContain('greet() liefert die Anrede');
    });

    it('zeigt dem Review den Basis-Commit und die Behauptung des Coders', () => {
      const reviewer = seen.find((spec) => spec.role === 'reviewer');
      expect(reviewer?.prompt).toContain('Umgesetzt und getestet.');
      expect(reviewer?.prompt).toContain('git diff');
    });

    it('schreibt genau ein chain.finished-Ereignis mit den drei Läufen', async () => {
      const rows = await sql<Array<{ payload: { status: string; legs: unknown[] } }>>`
        SELECT payload FROM event_log WHERE kind = 'chain.finished' AND task_id = ${taskId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.payload.status).toBe('approved');
      expect(rows[0]?.payload.legs).toHaveLength(3);
    });
  });

  describe('Review verlangt Änderungen (§8.1 Schritt 3)', () => {
    it('schickt den Diff zurück und reicht die Befunde mit', async () => {
      const task = await newTask();
      const built = chain({
        planner: [ok(PLAN)],
        coder: [{ script: ok(CODED, [TOOL_USE, HOOK_PRETOOL]).script, work: writeClaimed }],
        reviewer: [ok(REJECTED), ok(APPROVED)],
      });
      const outcome = await built.chain.run(task.id);

      expect(outcome.status).toBe('approved');
      expect(outcome.rounds).toBe(2);
      expect(built.scripts.counts.coder).toBe(2);

      const secondCoder = built.scripts.seen.filter((s) => s.role === 'coder')[1];
      expect(secondCoder?.prompt).toContain('Review round 1');
      expect(secondCoder?.prompt).toContain('Test würde auch ohne die Änderung bestehen.');

      const secondReview = built.scripts.seen.filter((s) => s.role === 'reviewer')[1];
      expect(secondReview?.prompt).toContain('This is review round 2');
    });

    it('hält die Befunde als Notiz in der Zeitleiste fest', async () => {
      const task = await newTask();
      const built = chain({
        planner: [ok(PLAN)],
        coder: [{ script: ok(CODED, [TOOL_USE, HOOK_PRETOOL]).script, work: writeClaimed }],
        reviewer: [ok(REJECTED), ok(APPROVED)],
      });
      await built.chain.run(task.id);

      const notes = await sql<Array<{ text: string; actor: string }>>`
        SELECT payload ->> 'text' AS text, actor FROM task_events
        WHERE task_id = ${task.id} AND kind = 'note' ORDER BY seq
      `;
      expect(notes.some((n) => n.actor === 'reviewer' && n.text.includes('1 Blocker'))).toBe(true);
    });
  });

  describe('die Claim-Prüfung glaubt dem Review nicht (§10)', () => {
    it('blockiert einen Diff außerhalb der Reservierung, auch bei "approve"', async () => {
      const task = await newTask();
      const built = chain(
        {
          planner: [ok(PLAN)],
          // Schreibt README.md — außerhalb von `src/**` und `greet.test.js`.
          coder: [{ script: ok(CODED, [TOOL_USE, HOOK_PRETOOL]).script, work: writeUnclaimed }],
          // Und das Review behauptet, alles sei innerhalb geblieben.
          reviewer: [ok(APPROVED)],
        },
        { maxReviewRounds: 1 },
      );
      const outcome = await built.chain.run(task.id);

      expect(outcome.status).toBe('red');
      expect(outcome.outOfClaims).toEqual(['README.md']);

      const notes = await sql<Array<{ text: string }>>`
        SELECT payload ->> 'text' AS text FROM task_events
        WHERE task_id = ${task.id} AND kind = 'note' ORDER BY seq
      `;
      const said = notes.map((n) => n.text).join('\n');
      expect(said).toContain('README.md');
      // Die eigentliche Aussage: die Behauptung des Reviews ist widerlegt.
      expect(said).toContain('durch den Diff widerlegt');
    });

    it('sieht auch bereits committete Änderungen, nicht nur den Arbeitsstand', async () => {
      const task = await newTask();
      const built = chain(
        {
          planner: [ok(PLAN)],
          coder: [{ script: ok(CODED, [TOOL_USE, HOOK_PRETOOL]).script, work: commitUnclaimed }],
          reviewer: [ok(APPROVED)],
        },
        { maxReviewRounds: 1 },
      );
      const outcome = await built.chain.run(task.id);

      expect(outcome.status).toBe('red');
      expect(outcome.outOfClaims).toEqual(['README.md']);
    });

    it('lässt einen sauberen Diff durch', async () => {
      const task = await newTask();
      const built = chain({
        planner: [ok(PLAN)],
        coder: [{ script: ok(CODED, [TOOL_USE, HOOK_PRETOOL]).script, work: writeClaimed }],
        reviewer: [ok(APPROVED)],
      });
      const outcome = await built.chain.run(task.id);
      expect(outcome.status).toBe('approved');
      expect(outcome.outOfClaims).toEqual([]);
    });
  });

  describe('§10: überlappende Claims werden serialisiert', () => {
    it('lässt die zweite Aufgabe in "planning" warten statt sie scheitern zu lassen', async () => {
      // Beide Aufgaben im selben Projekt — sonst gäbe es nichts zu kollidieren.
      const project = await newProject();
      const first = await newTask(project);
      const built = chain({
        planner: [ok(PLAN)],
        coder: [{ script: ok(CODED, [TOOL_USE, HOOK_PRETOOL]).script, work: writeClaimed }],
        reviewer: [ok(APPROVED)],
      });
      expect((await built.chain.run(first.id)).status).toBe('approved');

      const second = await newTask(project);
      const blocked = chain({ planner: [ok(PLAN)] });
      const outcome = await blocked.chain.run(second.id);

      expect(outcome.status).toBe('blocked');
      expect(outcome.conflicts).toHaveLength(1);
      expect(outcome.conflicts[0]?.taskId).toBe(first.id);
      expect(outcome.problem).toContain('Blockiert durch Aufgabe');
      expect((await tasks.get(second.id))?.state).toBe('planning');
      // Kein Coder ist gestartet — genau das ist der Zweck.
      expect(blocked.scripts.counts.coder).toBeUndefined();
    });
  });

  describe('die fünf Ausgänge eines Laufs (A53.2)', () => {
    it('wiederholt einen Infrastrukturfehler mit Backoff und färbt nichts rot (§11, A25)', async () => {
      const task = await newTask();
      const built = chain(
        {
          // Kein SessionStart-Hook ⇒ Containment nicht nachweisbar ⇒ infra.
          planner: [{ script: { result: result(PLAN) } }],
        },
        { infra: { attempts: 3, backoffMs: 1 } },
      );
      const outcome = await built.chain.run(task.id);

      expect(outcome.status).toBe('infra');
      expect(built.scripts.counts.planner).toBe(3);
      expect(outcome.legs.at(-1)?.attempts).toBe(3);
      // Die Aufgabe bleibt stehen, wo der nächste Versuch sie aufnimmt.
      expect((await tasks.get(task.id))?.state).toBe('planning');
      const red = await sql<Array<{ n: string }>>`
        SELECT count(*) AS n FROM tasks WHERE state IN ('red', 'escalated')
      `;
      expect(Number(red[0]?.n)).toBe(0);
    });

    it('parkt bei einem Auth-Vorfall und markiert nichts rot (§6.1)', async () => {
      const task = await newTask();
      const built = chain({
        planner: [{ script: { events: [HOOK_START], terminal: 'auth_incident' } }],
      });
      const outcome = await built.chain.run(task.id);

      expect(outcome.status).toBe('parked');
      const parked = await tasks.get(task.id);
      expect(parked?.state).toBe('parked');
      expect(parked?.resumeState).toBe('planning');
      const red = await sql<Array<{ n: string }>>`
        SELECT count(*) AS n FROM tasks WHERE state IN ('red', 'escalated')
      `;
      expect(Number(red[0]?.n)).toBe(0);
    });

    it('parkt eine unterbrochene Sitzung, statt sie als Fehlschlag zu werten (§7.3)', async () => {
      const task = await newTask();
      const built = chain({
        planner: [{ script: { events: [HOOK_START], terminal: 'interrupted' } }],
      });
      const outcome = await built.chain.run(task.id);
      expect(outcome.status).toBe('parked');
      expect((await tasks.get(task.id))?.state).toBe('parked');
    });

    it('parkt auf "needs_decision", wenn ein Agent eine Entscheidung vorbereitet (§6.4)', async () => {
      const task = await newTask();
      const built = chain({
        planner: [
          ok({ ...PLAN, status: 'needs_decision', summary: 'Zwei Wege, beide vertretbar.' }),
        ],
      });
      const outcome = await built.chain.run(task.id);

      expect(outcome.status).toBe('needs_decision');
      const parked = await tasks.get(task.id);
      expect(parked?.state).toBe('needs_decision');
      expect(parked?.resumeState).toBe('planning');
    });

    it('parkt nicht doppelt, wenn das Aufräumprotokoll schon geparkt hat', async () => {
      const task = await newTask();
      const built = chain({
        planner: [ok(PLAN)],
        coder: [
          {
            script: { events: [HOOK_START], terminal: 'interrupted' },
            // Das Aufräumprotokoll war schneller: die Aufgabe ist bereits geparkt,
            // mit dem Rückkehrpunkt, den sie zum Zeitpunkt der Unterbrechung hatte.
            work: async () => {
              await tasks.transition(task.id, 'parked', {
                actor: 'controlling',
                reason: 'Budgetfenster fast erschöpft',
                resumeState: 'coding',
              });
            },
          },
        ],
      });
      const outcome = await built.chain.run(task.id);

      expect(outcome.status).toBe('parked');
      const parked = await tasks.get(task.id);
      expect(parked?.state).toBe('parked');
      // Der Rückkehrpunkt des Aufräumprotokolls bleibt stehen.
      expect(parked?.resumeState).toBe('coding');
    });
  });

  describe('§9: der rote Pfad', () => {
    it('stellt den ersten Fehlschlag mit gesenkter Priorität und Lehren zurück', async () => {
      const task = await newTask(undefined, 'P1');
      const built = chain({
        planner: [
          ok({ ...PLAN, status: 'failed', summary: 'Die Akzeptanzkriterien widersprechen sich.' }),
        ],
      });
      const outcome = await built.chain.run(task.id);

      expect(outcome.status).toBe('red');
      expect(outcome.red?.status).toBe('requeued');
      const requeued = await tasks.get(task.id);
      expect(requeued?.state).toBe('queued');
      expect(requeued?.priority).toBe('P2');
      expect(requeued?.retryCount).toBe(1);

      const notes = await sql<Array<{ text: string }>>`
        SELECT payload ->> 'text' AS text FROM task_events
        WHERE task_id = ${task.id} AND kind = 'note' ORDER BY seq
      `;
      expect(notes.at(-1)?.text).toContain('Die Akzeptanzkriterien widersprechen sich.');
      expect(notes.at(-1)?.text).toContain('gesenkter Priorität');
    });

    it('eskaliert den zweiten Fehlschlag mit der Diagnose der Fehlersuche', async () => {
      const task = await newTask(undefined, 'P1');
      const failing = () =>
        chain({
          planner: [ok(PLAN)],
          coder: [
            {
              script: ok({ ...CODED, status: 'failed', summary: 'Der Bau schlägt fehl.' }, [
                TOOL_USE,
                HOOK_PRETOOL,
              ]).script,
              work: writeClaimed,
            },
          ],
          debugger: [
            ok({
              status: 'done',
              summary: 'Ursache: eine fehlende Abhängigkeit im Sandkasten.',
              artifacts: [],
              followups: ['Abhängigkeit ergänzen', 'Aufgabe kleiner schneiden'],
            }),
          ],
        });

      const first = await failing().chain.run(task.id);
      expect(first.red?.status).toBe('requeued');
      expect((await tasks.get(task.id))?.state).toBe('queued');

      const second = await failing().chain.run(task.id);
      expect(second.status).toBe('escalated');
      expect(second.red?.status).toBe('escalated');
      expect(second.red?.diagnosis).toContain('fehlende Abhängigkeit');
      expect(second.red?.followups).toEqual(['Abhängigkeit ergänzen', 'Aufgabe kleiner schneiden']);
      expect((await tasks.get(task.id))?.state).toBe('escalated');

      const events = await sql<
        Array<{ payload: { diagnosis: string | null; escalationNumber: number | null } }>
      >`
        SELECT payload FROM event_log WHERE kind = 'task.escalated' AND task_id = ${task.id}
      `;
      expect(events).toHaveLength(1);
      expect(events[0]?.payload.diagnosis).toContain('fehlende Abhängigkeit');

      // §9 hands the task to the operator, and §15 is the shape it arrives in. Before
      // Phase 4 this ended at `escalated` with a note nobody was pushed: the
      // state was right and the postbox was empty. The card is now the thing
      // that makes "hands it to the operator" a fact rather than a state name.
      const escalations = new EscalationService({ sql, eventLog });
      const card = await escalations.openForTask(task.id);
      expect(card?.source).toBe('task_red');
      expect(card?.urgency).toBe('P1');
      expect(card?.state).toBe('open');
      expect(card?.number).toBe(events[0]?.payload.escalationNumber);
      // The Debugger's findings travel into the card the operator reads, and its options
      // are §15's — 2 to 4, each with a trade-off, exactly one recommended.
      expect(card?.context).toContain('fehlende Abhängigkeit');
      expect(card?.context).toContain('Abhängigkeit ergänzen');
      expect(card?.options.length).toBeGreaterThanOrEqual(2);
      expect(card?.options.filter((o) => o.recommended)).toHaveLength(1);
      // And it is not reusable as policy: §9's question names *this* task, and
      // an answer of "abbrechen" must never apply itself to another one.
      await escalations.answer(card?.id as string, { optionIndex: 2, actor: 'max' });
      expect(
        await escalations.precedentFor({
          question: card?.question ?? '',
          projectId: task.projectId,
        }),
      ).toBeNull();
    });

    it('eskaliert auch dann, wenn die Fehlersuche selbst scheitert', async () => {
      const task = await newTask();
      const failing = () =>
        chain({
          planner: [ok({ ...PLAN, status: 'failed', summary: 'Nicht planbar.' })],
          // Kein SessionStart-Hook: die Diagnosesitzung ist ein Infrastrukturfehler.
          debugger: [{ script: { result: result({}) } }],
        });
      await failing().chain.run(task.id);
      const second = await failing().chain.run(task.id);

      expect(second.status).toBe('escalated');
      expect(second.red?.diagnosis).toBeNull();
      expect(second.red?.diagnosisProblem).toBeTruthy();
      expect((await tasks.get(task.id))?.state).toBe('escalated');
    });

    it('geht nach erschöpften Review-Runden den roten Pfad', async () => {
      const task = await newTask();
      const built = chain(
        {
          planner: [ok(PLAN)],
          coder: [{ script: ok(CODED, [TOOL_USE, HOOK_PRETOOL]).script, work: writeClaimed }],
          reviewer: [ok(REJECTED)],
          debugger: [ok({ status: 'done', summary: 'Diagnose.', artifacts: [], followups: [] })],
        },
        { maxReviewRounds: 2 },
      );
      const outcome = await built.chain.run(task.id);

      expect(outcome.status).toBe('red');
      expect(outcome.rounds).toBe(2);
      expect(built.scripts.counts.coder).toBe(2);
      expect(built.scripts.counts.reviewer).toBe(2);
      expect(outcome.problem).toContain('2 Review-Runden');
    });
  });

  /**
   * §6.4 — "resumes the exact session from the same cwd with the decision
   * injected as the next message. No context is lost."
   *
   * Every case here drives the *real* producer: the escalation is raised through
   * `AgentChannel.requestEscalation`, which is what the `escalate.ask` MCP tool
   * calls in production, from inside the session that is about to park. A
   * fixture that inserted the row directly would prove the resumption reads a
   * shape the test wrote, and nothing about the shape the studio writes.
   */
  describe('§6.4 — die Runde: parken, entscheiden, dieselbe Sitzung fortsetzen', () => {
    const ASK = {
      question: 'Soll die Anrede aus der Konfiguration kommen?',
      context:
        'Der Plan nennt eine feste Anrede. Die Konfiguration hätte eine, die aber ' +
        'bisher nirgends gelesen wird. Ohne Entscheidung ist beides vertretbar.',
      urgency: 'P2' as const,
      options: [
        {
          title: 'Feste Anrede',
          pros: ['weniger Code'],
          cons: ['nicht änderbar'],
          recommended: true,
        },
        {
          title: 'Aus der Konfiguration',
          pros: ['änderbar'],
          cons: ['mehr Code'],
          recommended: false,
        },
      ],
    };

    function channel(taskId: string, role: string, runId: string): AgentChannel {
      return new AgentChannel(
        {
          sql,
          tasks,
          projects,
          claims,
          eventLog,
          escalations: new EscalationService({ sql, eventLog }),
        },
        taskId,
        role,
        runId,
      );
    }

    /**
     * A session that asks the operator, ends the turn, and finishes when it is resumed.
     *
     * `onResume` is what makes this a round trip rather than a loop: the
     * continuation is the *same session* and therefore replays this script
     * unless the script says otherwise — a fake that answered `needs_decision`
     * again would park the task forever, and the test would read as "resumption
     * does not work" for a reason that is entirely the fixture's.
     */
    function asks(
      taskId: () => string,
      raw: unknown,
      resumed: unknown,
      options: { runId?: () => string; role?: string } = {},
    ): RoleScript {
      return {
        script: {
          events: [HOOK_START],
          result: result(raw),
          onResume: { events: [HOOK_START], result: result(resumed) },
        },
        onSpawn: async (spec) => {
          await channel(
            taskId(),
            options.role ?? spec.role,
            options.runId?.() ?? spec.runId,
          ).requestEscalation(ASK);
        },
      };
    }

    const PARKED_CODER = {
      status: 'needs_decision',
      summary: 'Warte auf die Entscheidung zur Anrede.',
      artifacts: [],
      followups: [],
    };

    const PARKED_PLAN = { ...PLAN, status: 'needs_decision', summary: 'Warte auf die Anrede.' };
    const PARKED_REVIEW = {
      ...APPROVED,
      status: 'needs_decision',
      summary: 'Warte auf die Entscheidung zur Anrede.',
    };

    /** Answer the one open item of a task, the way the dashboard will. */
    async function answer(
      taskId: string,
      input: { optionIndex?: number | null; freeText?: string | null },
    ) {
      const service = new EscalationService({ sql, eventLog });
      const open = await service.openForTask(taskId);
      if (!open) throw new Error('Keine offene Eskalation zu dieser Aufgabe');
      await service.answer(open.id, { ...input, actor: 'max' });
      return open;
    }

    it('parkt beim Coder, setzt dieselbe Sitzung fort und läuft bis zur Freigabe durch', async () => {
      const task = await newTask();
      const built = chain({
        planner: [ok(PLAN)],
        coder: [{ ...asks(() => task.id, PARKED_CODER, CODED), work: writeClaimed }],
        reviewer: [ok(APPROVED)],
      });

      // --- 1. Die Kette parkt auf die Frage hin -------------------------------
      const parked = await built.chain.run(task.id);
      expect(parked.status).toBe('needs_decision');
      const waiting = await tasks.get(task.id);
      expect(waiting?.state).toBe('needs_decision');
      // §10: die Claims überleben das Warten — sonst könnte eine andere Aufgabe
      // dieselben Dateien belegen, während diese auf den Betreiber wartet.
      expect([...(await claims.heldGlobs(task.id))].sort()).toEqual([...PLAN.claimSet].sort());

      const parkedRun = built.scripts.seen.find((spec) => spec.role === 'coder');
      expect(parkedRun).toBeDefined();

      // --- 2. The operator entscheidet -------------------------------------------------
      const item = await answer(task.id, {
        optionIndex: 1,
        freeText: 'Aus der Konfiguration, aber mit einem Vorgabewert.',
      });

      // --- 3. Dieselbe Sitzung läuft weiter -----------------------------------
      const resumed = await built.chain.resume(task.id);
      expect(resumed.status).toBe('approved');

      // Das eigentliche Versprechen aus §6.4: fortgesetzt wurde die Sitzung, die
      // gefragt hat — nicht irgendeine neue.
      expect(built.backend.resumes).toHaveLength(1);
      const continuation = built.backend.resumes[0];
      expect(continuation?.sessionId).toBe(`fake-session-${parkedRun?.runId}`);
      expect(continuation?.cwd).toBe(parkedRun?.cwd);
      // Die Entscheidung ist die nächste Nachricht, mit des Betreibers eigenen Worten.
      expect(continuation?.message).toContain(`#${item.number}`);
      expect(continuation?.message).toContain('Aus der Konfiguration');
      expect(continuation?.message).toContain('mit einem Vorgabewert');
      // A51.4: eine Fortsetzung ohne Rollen-Settings liefe ohne die Hooks aus
      // §6.6 — und zwar genau dann, wenn die Aufgabe wieder zu schreiben beginnt.
      expect(continuation?.settingsPath).toContain('coder');
      expect(continuation?.env.VORSCHICHT_RUN_POLICY).toBeTruthy();
      // Anders als §6.3s Nachbesserung bekommt diese Sitzung ihre Werkzeuge
      // zurück: sie soll weiterarbeiten, nicht ein Ergebnis wiederholen.
      expect(continuation?.allowedTools?.length ?? 0).toBeGreaterThan(0);

      // Der Planer lief genau einmal: ein zweiter Plan wäre ein anderer als der,
      // aus dem der halbfertige Worktree entstanden ist.
      expect(built.scripts.counts.planner).toBe(1);
      expect((await tasks.get(task.id))?.state).toBe('gates');
    });

    it('macht die Fortsetzung zu einem eigenen Lauf, der auf den geparkten zeigt', async () => {
      const task = await newTask();
      const built = chain({
        planner: [ok(PLAN)],
        coder: [{ ...asks(() => task.id, PARKED_CODER, CODED), work: writeClaimed }],
        reviewer: [ok(APPROVED)],
      });

      await built.chain.run(task.id);
      const item = await answer(task.id, { optionIndex: 0 });
      await built.chain.resume(task.id);

      const rows = await sql<Array<{ run_id: string; session_id: string | null }>>`
        SELECT run_id::text, session_id FROM agent_runs WHERE resumed_of = ${item.runId}
      `;
      // §6.3s Nachbesserung ist aus demselben Grund ein eigener Lauf (A53.5):
      // eigene Token, eigenes Transkript, und die Verknüpfung ist der einzige
      // dauerhafte Beleg, dass eine Antwort im Postfach Arbeit ausgelöst hat.
      expect(rows).toHaveLength(1);
      expect(rows[0]?.session_id).toBe(`fake-session-${item.runId}`);

      const events = await sql<Array<{ kind: string }>>`
        SELECT kind FROM event_log WHERE task_id = ${task.id} AND kind LIKE 'escalation.%'
        ORDER BY id
      `;
      // `raise()` writes its own event before the channel writes the agent's
      // half — the pair is what §15 counts, not the order.
      expect(events.map((e) => e.kind)).toEqual([
        'escalation.raised',
        'escalation.requested',
        'escalation.answered',
        'escalation.resumed',
      ]);
    });

    it('nimmt eine reine Freitextantwort genauso an', async () => {
      const task = await newTask();
      const built = chain({
        planner: [ok(PLAN)],
        coder: [{ ...asks(() => task.id, PARKED_CODER, CODED), work: writeClaimed }],
        reviewer: [ok(APPROVED)],
      });

      await built.chain.run(task.id);
      await answer(task.id, { freeText: 'Nimm die Konfiguration, aber lies sie nur einmal.' });
      const resumed = await built.chain.resume(task.id);

      expect(resumed.status).toBe('approved');
      const message = built.backend.resumes[0]?.message ?? '';
      expect(message).toContain('Nimm die Konfiguration, aber lies sie nur einmal.');
      expect(message).toContain('did not pick one of your options');
    });

    it('setzt den Planer fort und plant nicht neu', async () => {
      const task = await newTask();
      const built = chain({
        planner: [asks(() => task.id, PARKED_PLAN, PLAN)],
        coder: [{ ...ok(CODED), work: writeClaimed }],
        reviewer: [ok(APPROVED)],
      });

      expect((await built.chain.run(task.id)).status).toBe('needs_decision');
      expect((await tasks.get(task.id))?.resumeState).toBe('planning');
      await answer(task.id, { optionIndex: 0 });

      const resumed = await built.chain.resume(task.id);
      expect(resumed.status).toBe('approved');
      // Zwei Planer-Sitzungen, aber die zweite ist die *fortgesetzte* erste —
      // ein frischer Planer wäre eine dritte Sitzung mit einem anderen Plan.
      expect(built.backend.resumes).toHaveLength(1);
      expect(built.backend.spawns.filter((s) => s.role === 'planner')).toHaveLength(1);
      expect([...(await claims.heldGlobs(task.id))].sort()).toEqual([...PLAN.claimSet].sort());
    });

    it('setzt den Reviewer fort, ohne den Coder noch einmal laufen zu lassen', async () => {
      const task = await newTask();
      const built = chain({
        planner: [ok(PLAN)],
        coder: [{ ...ok(CODED), work: writeClaimed }],
        reviewer: [asks(() => task.id, PARKED_REVIEW, APPROVED)],
      });

      expect((await built.chain.run(task.id)).status).toBe('needs_decision');
      expect((await tasks.get(task.id))?.resumeState).toBe('review');
      await answer(task.id, { optionIndex: 0 });

      const resumed = await built.chain.resume(task.id);
      expect(resumed.status).toBe('approved');
      // Der Diff, der geprüft wird, ist der des ersten Coders. Ihn noch einmal
      // laufen zu lassen hieße, genau die Arbeit wegzuwerfen, die zur Review lag.
      expect(built.scripts.counts.coder).toBe(1);
      expect(built.scripts.counts.planner).toBe(1);
      expect(resumed.rounds).toBe(1);
    });

    it('schreibt die Entscheidung in die Zeitleiste, bevor die Aufgabe sich bewegt', async () => {
      const task = await newTask();
      const built = chain({
        planner: [ok(PLAN)],
        coder: [{ ...asks(() => task.id, PARKED_CODER, CODED), work: writeClaimed }],
        reviewer: [ok(APPROVED)],
      });
      await built.chain.run(task.id);
      const item = await answer(task.id, { optionIndex: 1, freeText: 'mit Vorgabewert' });
      await built.chain.resume(task.id);

      const [note] = await sql<Array<{ seq: number; text: string }>>`
        SELECT seq, payload ->> 'text' AS text FROM task_events
        WHERE task_id = ${task.id} AND kind = 'note'
          AND payload ->> 'escalationNumber' = ${String(item.number)}
      `;
      expect(note?.text).toContain(`Entscheidung #${item.number}`);
      expect(note?.text).toContain('mit Vorgabewert');

      // Vor der Rückkehr in den Arbeitszustand: scheitert die Fortsetzung, findet
      // die nächste Sitzung die Antwort trotzdem über `task.get_context` — statt
      // dieselbe Frage ein zweites Mal zu stellen.
      const [back] = await sql<Array<{ seq: number }>>`
        SELECT seq FROM task_events
        WHERE task_id = ${task.id} AND kind = 'state_changed' AND state = 'coding'
        ORDER BY seq DESC LIMIT 1
      `;
      expect(note?.seq).toBeLessThan(back?.seq ?? -1);
    });

    it('setzt nichts fort, solange die Frage offen ist', async () => {
      const task = await newTask();
      const built = chain({
        planner: [ok(PLAN)],
        coder: [{ ...asks(() => task.id, PARKED_CODER, CODED), work: writeClaimed }],
        reviewer: [ok(APPROVED)],
      });
      await built.chain.run(task.id);

      const outcome = await built.chain.resume(task.id);
      // Kein Fehler: eine unbeantwortete Frage ist der Normalzustand einer
      // wartenden Aufgabe (§15 kennt keine Frist).
      expect(outcome.status).toBe('needs_decision');
      expect(outcome.problem).toContain('noch offen');
      expect(built.backend.resumes).toHaveLength(0);
      expect((await tasks.get(task.id))?.state).toBe('needs_decision');
    });

    it('weist eine Aufgabe zurück, die gar nicht auf eine Entscheidung wartet', async () => {
      const task = await newTask();
      const built = chain({ planner: [ok(PLAN)] });
      await expect(built.chain.resume(task.id)).rejects.toBeInstanceOf(DevChainError);
    });

    it('verweigert die Fortsetzung, wenn die geparkte Rolle nicht zur Etappe passt', async () => {
      const task = await newTask();
      let plannerRunId = '';
      const built = chain({
        planner: [
          {
            ...ok(PLAN),
            onSpawn: async (spec) => {
              plannerRunId = spec.runId;
            },
          },
        ],
        coder: [
          {
            ...asks(() => task.id, PARKED_CODER, CODED, { runId: () => plannerRunId }),
            work: writeClaimed,
          },
        ],
        reviewer: [ok(APPROVED)],
      });
      // Die Eskalation zeigt auf den Lauf des *Planers*, die Aufgabe kehrt aber
      // nach `coding` zurück. Die Entscheidung würde in die falsche Etappe
      // eingespielt — ein Defekt im Datensatz, kein Fehlschlag der Aufgabe (A54.6).
      await built.chain.run(task.id);
      await answer(task.id, { optionIndex: 0 });
      await expect(built.chain.resume(task.id)).rejects.toThrow(/falsche Etappe/);
      expect(built.backend.resumes).toHaveLength(0);
    });

    it('zählt die Review-Runden über die Unterbrechung hinweg weiter', async () => {
      const task = await newTask();
      const built = chain({
        planner: [ok(PLAN)],
        coder: [
          { ...ok(CODED), work: writeClaimed },
          { ...asks(() => task.id, PARKED_CODER, CODED), work: writeClaimed },
        ],
        reviewer: [ok(REJECTED), ok(APPROVED)],
      });

      // Runde 1 wird abgelehnt, Runde 2 fragt den Betreiber.
      expect((await built.chain.run(task.id)).status).toBe('needs_decision');
      await answer(task.id, { optionIndex: 0 });

      const resumed = await built.chain.resume(task.id);
      expect(resumed.status).toBe('approved');
      // Runde 2, nicht Runde 1: ein Neustart der Zählung schenkte §8.1s Schranke
      // drei frische Runden bei jeder Eskalation.
      expect(resumed.rounds).toBe(2);
    });
  });

  /**
   * The hole §6.4's machinery closed on the way past (header 6).
   *
   * Every suspension returns a task to the state it was suspended from (A43.4),
   * so §7.3's park and §7.2's re-check both hand back a task at `coding` — and
   * the chain used to refuse to start from there. The resume path ended at a
   * state nothing would run.
   */
  describe('Wiedereinstieg mitten in der Kette (§7.3, §7.2)', () => {
    it('nimmt eine geparkte Umsetzung bei "coding" wieder auf, ohne neu zu planen', async () => {
      const task = await newTask();
      const first = chain({
        planner: [ok(PLAN)],
        coder: [{ script: { events: [HOOK_START], terminal: 'interrupted' }, work: writeClaimed }],
        reviewer: [ok(APPROVED)],
      });
      const parked = await first.chain.run(task.id);
      expect(parked.status).toBe('parked');
      expect((await tasks.get(task.id))?.resumeState).toBe('coding');

      await tasks.resume(task.id, { actor: 'controlling', reason: 'Fenster zurückgesetzt' });
      expect((await tasks.get(task.id))?.state).toBe('coding');

      const second = chain({
        planner: [ok(PLAN)],
        coder: [{ ...ok(CODED), work: writeClaimed }],
        reviewer: [ok(APPROVED)],
      });
      const outcome = await second.chain.run(task.id);

      expect(outcome.status).toBe('approved');
      // Der Plan kommt aus dem Lauf, der ihn erzeugt hat — die zweite Kette hat
      // keinen Planer gestartet.
      expect(second.scripts.counts.planner).toBeUndefined();
      expect(outcome.plan?.plan).toEqual(PLAN.plan);
      expect(outcome.rounds).toBe(1);
    });

    it('meldet einen Defekt, wenn zu einer laufenden Aufgabe kein Plan aufgezeichnet ist', async () => {
      const task = await newTask();
      await tasks.transition(task.id, 'planning', { actor: 'test' });
      await claims.register(task.id, ['src/**'], { actor: 'test' });
      await claims.acquire(task.id, { actor: 'test' });
      await tasks.transition(task.id, 'coding', { actor: 'test' });

      const built = chain({ planner: [ok(PLAN)], coder: [ok(CODED)] });
      // Kein Planer-Lauf, also kein Plan: ein neuer wäre ein anderer als der, aus
      // dem der vorhandene Diff entstanden ist. Das ist ein Defekt im Datensatz.
      await expect(built.chain.run(task.id)).rejects.toThrow(/Planer-Lauf/);
      expect(built.scripts.counts.coder).toBeUndefined();
    });
  });

  describe('Grenzen', () => {
    it('startet nicht in einem nur lesbaren Projekt (A41)', async () => {
      const task = await newTask(readOnlyProjectId);
      const built = chain({ planner: [ok(PLAN)] });
      await expect(built.chain.run(task.id)).rejects.toBeInstanceOf(DevChainError);
      expect(built.scripts.counts.planner).toBeUndefined();
    });

    it('beginnt nur in einer Etappe der Entwicklungskette', async () => {
      const task = await newTask();
      await tasks.transition(task.id, 'planning', { actor: 'test' });
      await tasks.transition(task.id, 'aborted', { actor: 'test' });
      const built = chain({ planner: [ok(PLAN)] });
      await expect(built.chain.run(task.id)).rejects.toThrow(/aborted/);
      expect(built.scripts.counts.planner).toBeUndefined();
    });

    it('weist einen Plan mit unbrauchbarem Claim-Muster zurück, statt ihn zu belegen', async () => {
      const task = await newTask();
      const built = chain({ planner: [ok({ ...PLAN, claimSet: ['/etc/passwd'] })] });
      // Der Registry-Fehler ist kein Aufgabenfehler: die Kette meldet infra und
      // lässt die Aufgabe stehen, statt sie rot zu färben.
      const outcome = await built.chain.run(task.id);
      expect(outcome.status).toBe('infra');
      expect(outcome.problem).toContain('/etc/passwd');
      expect(outcome.problem).toContain('relativ zum Projektwurzelverzeichnis');
      expect((await tasks.get(task.id))?.state).toBe('planning');
    });
  });
});
