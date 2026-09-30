/**
 * The runner against a real Postgres and the `fake` backend (§6.2, §6.3).
 *
 * The backend is fake and the database is not, and that split is deliberate:
 * every property under test here is about the *record* — what a run leaves
 * behind, in what order, and whether it can be reconstructed afterwards — and
 * none of it can be shown against an in-memory stand-in for `agent_runs`, which
 * is a view over an append-only table with its own constraints.
 *
 * No model tokens are spent. A "session" here is a scripted event stream (A37).
 */
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type { GetUsageResponse, UsageSample } from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActiveRunRegistry } from './active-runs.js';
import { FakeBackend, type FakeEvent, type FakeScript } from './backend/fake.js';
import type { ModelBackend } from './backend/index.js';
import { EventLog } from './event-log.js';
import { AGENT_PROFILES } from './profiles/index.js';
import { ProjectService } from './project-service.js';
import { AgentRunner, type AgentRunRequest, RunnerError, type RunnerPaths } from './runner.js';
import { TaskService } from './task-service.js';

const url = process.env.TEST_DATABASE_URL;

/** A well-formed coder result, so the contract is not what a test trips over. */
const GOOD_RESULT = { status: 'done', summary: 'Erledigt.', artifacts: [], followups: [] };

/** The two hook events a contained session produces before it does anything. */
const HOOK_OK: FakeEvent[] = [
  {
    type: 'hook_event',
    event: 'SessionStart',
    hookName: 'SessionStart:*',
    phase: 'response',
    outcome: 'success',
    exitCode: 0,
  },
];

const HOOK_PRETOOL: FakeEvent = {
  type: 'hook_event',
  event: 'PreToolUse',
  hookName: 'PreToolUse:Edit',
  phase: 'response',
  outcome: 'success',
  exitCode: 0,
};

interface RunRow {
  run_id: string;
  role: string | null;
  model: string | null;
  backend: string | null;
  cwd: string | null;
  session_id: string | null;
  task_id: string | null;
  transcript_path: string | null;
  terminal_reason: string | null;
  tokens_in: string | null;
  tokens_out: string | null;
  result_raw: unknown;
  hook_events: string;
  tool_uses: string;
  is_finished: boolean;
  permission_denials: string;
  repair_of: string | null;
}

describe.skipIf(!url)('AgentRunner (§6.2, §6.3)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let tasks: TaskService;
  let projects: ProjectService;
  let eventLog: EventLog;
  let scratch: string;
  let paths: RunnerPaths;
  let projectId: string;
  let readOnlyProjectId: string;

  beforeAll(async () => {
    database = await createTestDatabase('runner');
    sql = createSql({ url: database.url, max: 3 });
    eventLog = new EventLog(sql);
    tasks = new TaskService({ sql, eventLog });
    projects = new ProjectService(sql);
    scratch = await mkdtemp(join(tmpdir(), 'vs-runner-'));
    // The session's working directory has to exist — the runner refuses ahead
    // of a spawn that would otherwise fail unreadably (A58). Worth noting that
    // this suite ran for two iterations against a directory that was never
    // created: the `fake` backend spawns no process, so nothing noticed, and a
    // real session in the same place would have died at startup every time.
    await mkdir(join(scratch, 'worktree'), { recursive: true });
    paths = {
      roleSettingsDir: join(scratch, 'claude'),
      runsRoot: join(scratch, 'runs'),
      transcriptsRoot: join(scratch, 'transcripts'),
      // Null by default: most tests are not about MCP, and a session without it
      // is a degraded run rather than a failed one.
      mcpServerEntry: null,
    };
    projectId = (
      await projects.create({ slug: 'runner-p', name: 'Runner', rootPath: join(scratch, 'p') })
    ).id;
    readOnlyProjectId = (
      await projects.create({
        slug: 'runner-ro',
        name: 'Nur lesbar',
        rootPath: join(scratch, 'ro'),
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

  async function newTask(project = projectId): Promise<string> {
    seq += 1;
    const task = await tasks.create({
      projectId: project,
      title: `Aufgabe ${seq}`,
      description: 'Etwas tun.',
      acceptanceCriteria: ['Es ist getan.'],
    });
    return task.id;
  }

  function runner(script: FakeScript, overrides: Partial<RunnerPaths> = {}): AgentRunner {
    return new AgentRunner({
      sql,
      eventLog,
      backend: new FakeBackend(script),
      paths: { ...paths, ...overrides },
    });
  }

  function request(taskId: string, overrides: Partial<AgentRunRequest> = {}): AgentRunRequest {
    return {
      taskId,
      projectId,
      profile: AGENT_PROFILES.coder,
      prompt: 'Bau das.',
      cwd: join(scratch, 'worktree'),
      containment: {
        writeRoot: join(scratch, 'worktree'),
        claims: ['src/**'],
        readOnlyProject: false,
      },
      ...overrides,
    } as AgentRunRequest;
  }

  async function runRow(runId: string): Promise<RunRow> {
    const [row] = await sql<RunRow[]>`SELECT * FROM agent_runs WHERE run_id = ${runId}`;
    if (!row) throw new Error(`Lauf ${runId} nicht im Bestand`);
    return row;
  }

  it('führt eine Sitzung aus und legt den ganzen Lauf ab', async () => {
    const taskId = await newTask();
    const outcome = await runner({
      events: [...HOOK_OK, { type: 'assistant_text', text: 'arbeite' }],
      result: { raw: GOOD_RESULT, tokensIn: 120, tokensOut: 40 },
    }).run(request(taskId));

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.result.summary).toBe('Erledigt.');

    const row = await runRow(outcome.run.runId);
    // §6.2's persistence list, read back from the view rather than from what
    // the runner claims it wrote.
    expect(row.role).toBe('coder');
    expect(row.model).toBe('sonnet');
    expect(row.backend).toBe('fake');
    expect(row.task_id).toBe(taskId);
    expect(row.cwd).toBe(join(scratch, 'worktree'));
    expect(row.tokens_in).toBe('120');
    expect(row.tokens_out).toBe('40');
    expect(row.terminal_reason).toBe('completed');
    expect(row.is_finished).toBe(true);
    expect(row.result_raw).toEqual(GOOD_RESULT);
  });

  it('kennt die Sitzungskennung, obwohl der Lauf vor dem Spawn eingetragen wird', async () => {
    // The crash-safety property and the resume requirement pull in opposite
    // directions: `created` is written before the backend is touched, and the
    // backend assigns the session id when it spawns. Migration 0011 reads the
    // id from either event so both hold — §6.2 needs (session_id, cwd) to
    // resume, §7.2 needs the run to exist before the process does.
    const taskId = await newTask();
    const outcome = await runner({
      events: HOOK_OK,
      result: { raw: GOOD_RESULT, tokensIn: 1, tokensOut: 1 },
    }).run(request(taskId));

    const row = await runRow(outcome.run.runId);
    expect(row.session_id).toBe(outcome.run.sessionId);
    expect(row.session_id).toBeTruthy();
  });

  it('schreibt den Lauf, bevor gespawnt wird — und schließt ihn, wenn das misslingt', async () => {
    const taskId = await newTask();
    const outcome = await runner({ failOnSpawn: 'kein Platz auf dem Gerät' }).run(request(taskId));

    // A25: the harness failed, not the work.
    expect(outcome.status).toBe('infra');
    if (outcome.status !== 'infra') return;
    expect(outcome.problem).toMatch(/kein Platz/);

    const row = await runRow(outcome.run.runId);
    expect(row.role).toBe('coder');
    // Closed, not left hanging: a run with no terminal event stays "live" until
    // the next restart, and `reconcile()` would then mark the task
    // `interrupted` on account of a session that never existed.
    expect(row.is_finished).toBe(true);
    expect(row.terminal_reason).toBe('crashed');
  });

  it('legt Hook-Ereignisse, Werkzeugaufrufe und Verweigerungen als Beleg ab', async () => {
    const taskId = await newTask();
    const outcome = await runner({
      events: [
        ...HOOK_OK,
        HOOK_PRETOOL,
        { type: 'tool_use', tool: 'Edit', input: { file_path: 'src/a.ts' } },
        { type: 'permission_denied', tool: 'Write', input: { file_path: '/etc/passwd' } },
      ],
      result: { raw: GOOD_RESULT, tokensIn: 5, tokensOut: 5 },
    }).run(request(taskId));

    expect(outcome.status).toBe('ok');
    const row = await runRow(outcome.run.runId);
    expect(row.hook_events).toBe('2');
    expect(row.tool_uses).toBe('1');
    // §6.6's audit trail: which tool, with which input, without parsing a
    // transcript.
    expect(row.permission_denials).toBe('1');
    expect(outcome.run.denials).toBe(1);

    const [denial] = await sql<Array<{ payload: { tool: string } }>>`
      SELECT payload FROM agent_run_events
      WHERE run_id = ${outcome.run.runId} AND kind = 'permission_denied'
    `;
    expect(denial?.payload.tool).toBe('Write');
  });

  it('erklärt eine Sitzung ohne jedes Hook-Ereignis zum Infrastrukturfehler', async () => {
    // The failure §6.6 exists to catch: a `--settings` document the CLI could
    // not read is discarded silently in -p mode, and the session then runs with
    // no write boundary at all.
    const taskId = await newTask();
    const outcome = await runner({
      events: [{ type: 'assistant_text', text: 'arbeite' }],
      result: { raw: GOOD_RESULT, tokensIn: 1, tokensOut: 1 },
    }).run(request(taskId));

    expect(outcome.status).toBe('infra');
    if (outcome.status !== 'infra') return;
    expect(outcome.problem).toMatch(/Containment-Hooks/);
  });

  it('erklärt Werkzeugaufrufe ohne PreToolUse-Hook zum Infrastrukturfehler', async () => {
    const taskId = await newTask();
    const outcome = await runner({
      events: [...HOOK_OK, { type: 'tool_use', tool: 'Edit', input: {} }],
      result: { raw: GOOD_RESULT, tokensIn: 1, tokensOut: 1 },
    }).run(request(taskId));

    expect(outcome.status).toBe('infra');
    if (outcome.status !== 'infra') return;
    expect(outcome.problem).toMatch(/ungeprüft/);
  });

  it('erklärt eine Sitzung ohne ihre MCP-Werkzeuge zum Infrastrukturfehler', async () => {
    const taskId = await newTask();
    const outcome = await runner(
      {
        // A49: still `pending` at init means a first turn with no tools at all.
        mcpServers: [{ name: 'vorschicht', status: 'pending' }],
        events: HOOK_OK,
        result: { raw: GOOD_RESULT, tokensIn: 1, tokensOut: 1 },
      },
      { mcpServerEntry: join(scratch, 'mcp-server.js') },
    ).run(request(taskId));

    expect(outcome.status).toBe('infra');
    if (outcome.status !== 'infra') return;
    expect(outcome.problem).toMatch(/pending/);
  });

  it('bessert ein vertragswidriges Ergebnis genau einmal nach', async () => {
    const taskId = await newTask();
    const backend = new FakeBackend({
      events: HOOK_OK,
      result: { raw: { status: 'fertig?' }, tokensIn: 10, tokensOut: 2 },
      onResume: {
        events: HOOK_OK,
        result: { raw: GOOD_RESULT, tokensIn: 3, tokensOut: 1 },
      },
    });
    const outcome = await new AgentRunner({ sql, eventLog, backend, paths }).run(request(taskId));

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') return;
    expect(outcome.run.repairRunId).toBeTruthy();
    expect(backend.resumes).toHaveLength(1);

    // The repair restates a result; it must not be handed its tools back, or
    // the second answer could describe work the first run's record does not
    // contain. And it must carry the schema, or it answers in prose and fails
    // the very validation it exists to satisfy (§6.3).
    expect(backend.resumes[0]?.allowedTools).toEqual([]);
    expect(backend.resumes[0]?.resultSchema).toBeTruthy();
    expect(backend.resumes[0]?.settingsPath).toContain('settings.coder.json');

    // Its own run in the record, linked — folding it into the first would make
    // the token figures wrong and hide that a repair happened at all.
    const repair = await runRow(outcome.run.repairRunId ?? '');
    expect(repair.repair_of).toBe(outcome.run.runId);
  });

  it('scheitert, wenn auch die Nachbesserung den Vertrag verfehlt', async () => {
    const taskId = await newTask();
    const backend = new FakeBackend({
      events: HOOK_OK,
      result: { raw: { status: 'fertig?' }, tokensIn: 10, tokensOut: 2 },
      onResume: {
        events: HOOK_OK,
        result: { raw: { immer: 'noch falsch' }, tokensIn: 1, tokensOut: 1 },
      },
    });
    const outcome = await new AgentRunner({ sql, eventLog, backend, paths }).run(request(taskId));

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') return;
    expect(outcome.problem).toMatch(/Nachbesserung/);
    // Exactly one. §6.3 says one repair, and an unattended system that retried
    // a malformed contract until it worked would spend a night doing it.
    expect(backend.resumes).toHaveLength(1);
  });

  it('meldet einen angehaltenen Lauf als unterbrochen, nie als rot', async () => {
    const taskId = await newTask();
    const backend = new FakeBackend({
      stepDelayMs: 10,
      events: Array.from(
        { length: 30 },
        (): FakeEvent => ({ type: 'assistant_text', text: 'arbeite' }),
      ),
    });
    const runnerUnderTest = new AgentRunner({ sql, eventLog, backend, paths });
    const running = runnerUnderTest.run(request(taskId));
    await new Promise((resolve) => setTimeout(resolve, 60));
    await backend.runs[0]?.interrupt('guardian_wrap_up');
    const outcome = await running;

    // §7.3: a parked run is not a failed run. Never red.
    expect(outcome.status).toBe('interrupted');
  });

  it('meldet einen Anmeldefehler als Vorfall, nicht als gescheiterte Aufgabe', async () => {
    const taskId = await newTask();
    const outcome = await runner({ events: HOOK_OK, terminal: 'auth_incident' }).run(
      request(taskId),
    );
    expect(outcome.status).toBe('auth_incident');
  });

  it('archiviert das Sitzungsprotokoll und verweist im Lauf darauf', async () => {
    const taskId = await newTask();
    const source = join(scratch, 'session-fixture.jsonl');
    await writeFile(source, '{"type":"assistant"}\n');

    const outcome = await runner({
      events: HOOK_OK,
      result: { raw: GOOD_RESULT, tokensIn: 1, tokensOut: 1 },
      transcriptPath: source,
    }).run(request(taskId));

    expect(outcome.run.transcriptPath).toBeTruthy();
    const row = await runRow(outcome.run.runId);
    expect(row.transcript_path).toBe(outcome.run.transcriptPath);
    expect((await stat(outcome.run.transcriptPath ?? '')).isFile()).toBe(true);
  });

  it('räumt das Laufverzeichnis auf, auch wenn der Lauf scheitert', async () => {
    const taskId = await newTask();
    const outcome = await runner({ events: [], terminal: 'crashed', exitCode: 1 }).run(
      request(taskId),
    );
    const remaining = await readdir(paths.runsRoot).catch(() => [] as string[]);
    // The scratch directory holds the containment policy and the MCP document;
    // a stale policy beside a fresh config is the shape of a session contained
    // against the wrong claim set.
    expect(remaining).not.toContain(outcome.run.runId);
  });

  it('verweigert einen schreibenden Lauf in einem nur lesbaren Projekt (A41)', async () => {
    const taskId = await newTask(readOnlyProjectId);
    await expect(
      runner({}).run(
        request(taskId, {
          projectId: readOnlyProjectId,
          containment: { writeRoot: join(scratch, 'ro'), claims: ['**'], readOnlyProject: true },
        }),
      ),
    ).rejects.toThrow(RunnerError);
  });

  it('lässt einen nur lesenden Lauf im nur lesbaren Projekt zu', async () => {
    // A41 analyses; it does not forbid looking. The Planner has no editing
    // tools at all, so the refusal above is about writing, not about the
    // project being off limits.
    const taskId = await newTask(readOnlyProjectId);
    const outcome = await runner({
      events: HOOK_OK,
      result: {
        raw: { ...GOOD_RESULT, claimSet: ['src/**'], plan: ['lesen'], testPlan: [], risks: [] },
        tokensIn: 1,
        tokensOut: 1,
      },
    }).run(
      request(taskId, {
        projectId: readOnlyProjectId,
        profile: AGENT_PROFILES.planner,
        containment: { writeRoot: null, claims: null, readOnlyProject: true },
      }),
    );
    expect(outcome.status).toBe('ok');
  });

  it('nimmt die Budgetmessung, wenn es etwas zu messen gibt — vor dem Ende', async () => {
    // §7.1, and the reason there are two sampling points rather than one.
    //
    // `get_usage` answers `rate_limits_available: false, rate_limits: null`
    // until the session has actually called the API — verified against the
    // pinned CLI (A58.3). The sample on `session_ready` is therefore blind, and
    // for a short session it used to be the *only* one: every such run recorded
    // the meter's `unavailable` sentinel, and on a fresh installation the
    // guardian never left `wrap_up`. So the fixture models exactly that — null
    // first, a real reading second — and the assertion is that the reading that
    // exists is the one that lands.
    //
    // The second sample is taken on the `result` event, which is the last
    // instant anyone is listening: the backend closes stdin in
    // `finishAfterResult()`, and that runs when the generator is *resumed*,
    // i.e. after the runner's `case 'result'` returns.
    const taskId = await newTask();
    const ingested: GetUsageResponse[] = [];
    const backend = new FakeBackend({
      events: HOOK_OK,
      result: { raw: GOOD_RESULT, tokensIn: 1, tokensOut: 1 },
      usage: [
        null,
        {
          rate_limits_available: true,
          rate_limits: { limits: [{ kind: 'session', percent: 42 }] },
        },
      ],
    });
    const outcome = await new AgentRunner({
      sql,
      eventLog,
      backend,
      paths,
      usage: {
        async ingestOfficial(payload) {
          ingested.push(payload);
          return [] as UsageSample[];
        },
        async ingestOfficialWindow() {
          throw new Error('kein rate_limit_event in diesem Lauf');
        },
      },
    }).run(request(taskId));

    expect(outcome.status).toBe('ok');
    expect(ingested).toHaveLength(1);
    expect(ingested[0]?.rate_limits?.limits?.[0]?.percent).toBe(42);
  });

  /**
   * A73 — the pushed official reading.
   *
   * Under token auth `get_usage` answers nothing (A64), so this is the only
   * channel through which a real percentage ever reaches the guardian. It opens
   * exactly where §7.2 has to act and is shut everywhere else, which makes both
   * halves worth asserting: a frame with a figure must reach the meter, and a
   * frame without one must not — an invented 0% at the top of a window is the
   * one reading that would keep the studio running straight through its limit.
   */
  it('reicht den offiziellen Prozentwert eines rate_limit_event an den Zähler weiter', async () => {
    const taskId = await newTask();
    const pushed: Array<{ window: string; raw: number; resetsAt: number | null | undefined }> = [];
    const resetsAt = Date.parse('2026-08-01T20:00:00Z');

    const outcome = await new AgentRunner({
      sql,
      eventLog,
      backend: new FakeBackend({
        events: [
          ...HOOK_OK,
          // The shape observed on 2026-08-01 22:00, minus `runId`: a warning
          // frame carries the figure, an ordinary `allowed` frame does not.
          {
            type: 'rate_limit_anchor',
            window: 'five_hour',
            resetsAt,
            status: 'allowed_warning',
            utilization: 0.97,
          },
          {
            type: 'rate_limit_anchor',
            window: 'seven_day',
            resetsAt,
            status: 'allowed',
            utilization: null,
          },
        ],
        result: { raw: GOOD_RESULT, tokensIn: 1, tokensOut: 1 },
      }),
      paths,
      usage: {
        async ingestOfficial() {
          return [] as UsageSample[];
        },
        async ingestOfficialWindow(window, rawUtilization, context) {
          pushed.push({ window, raw: rawUtilization, resetsAt: context.resetsAt });
          return {
            window,
            modelClass: null,
            usedPercent: rawUtilization * 100,
            resetsAt: context.resetsAt ?? null,
            source: 'official',
            anomaly: null,
            observedAt: 0,
          } satisfies UsageSample;
        },
      },
    }).run(request(taskId));

    expect(outcome.status).toBe('ok');
    // Exactly one: the `allowed` frame carried no figure and must be silent.
    expect(pushed).toEqual([{ window: 'five_hour', raw: 0.97, resetsAt }]);

    // Both frames still become anchors on the run record — the estimator needs
    // the boundary regardless of whether a percentage came with it (A60).
    const anchors = await sql<Array<{ payload: { utilization: number | null } }>>`
      SELECT payload FROM agent_run_events
      WHERE run_id = ${outcome.run.runId} AND kind = 'rate_limit_anchor'
      ORDER BY seq
    `;
    expect(anchors.map((a) => a.payload.utilization)).toEqual([0.97, null]);
  });

  it('hält das Ereignisprotokoll für den Zeitstrahl der Aufgabe nach', async () => {
    const taskId = await newTask();
    const outcome = await runner({
      events: HOOK_OK,
      result: { raw: GOOD_RESULT, tokensIn: 7, tokensOut: 2 },
    }).run(request(taskId));

    const rows = await sql<Array<{ kind: string; payload: Record<string, unknown> }>>`
      SELECT kind, payload FROM event_log WHERE run_id = ${outcome.run.runId} ORDER BY id
    `;
    expect(rows.map((r) => r.kind)).toEqual(['run.created', 'run.finished']);
    expect(rows[1]?.payload.outcome).toBe('ok');
  });

  /**
   * §7.2 depends entirely on this: the guardian stops what the registry lists,
   * and before the registry existed the daemon handed it `() => []` — so a
   * `wrap_up` transition recorded that it had interrupted everything while
   * interrupting nothing, and `hard_stop`'s grace killed nothing. The assertions
   * are therefore about *when* an entry exists, not merely that it can.
   */
  describe('Registratur der laufenden Sitzungen (§7.2)', () => {
    it('trägt die Sitzung ein, solange sie läuft, und wieder aus, wenn sie endet', async () => {
      const taskId = await newTask();
      const registry = new ActiveRunRegistry();
      /** Read from inside the stream — the only place "during" is observable. */
      const duringRun: number[] = [];

      const outcome = await new AgentRunner({
        sql,
        eventLog,
        backend: new FakeBackend({
          events: HOOK_OK,
          result: { raw: GOOD_RESULT, tokensIn: 1, tokensOut: 1 },
        }),
        paths,
        activeRuns: registry,
        onEvent: () => duringRun.push(registry.size),
      }).run(request(taskId));

      expect(outcome.status).toBe('ok');
      expect(duringRun.every((size) => size === 1)).toBe(true);
      expect(duringRun.length).toBeGreaterThan(0);
      // And gone afterwards: a stale entry would be interrupted and killed by a
      // later guardian transition, against a process that no longer exists.
      expect(registry.size).toBe(0);
    });

    it('kennt Aufgabe, Rolle und Arbeitsverzeichnis der Sitzung', async () => {
      const taskId = await newTask();
      const registry = new ActiveRunRegistry();
      const seen: Array<{ taskId: string | null; role: string; cwd: string | null }> = [];

      await new AgentRunner({
        sql,
        eventLog,
        backend: new FakeBackend({
          events: HOOK_OK,
          result: { raw: GOOD_RESULT, tokensIn: 1, tokensOut: 1 },
        }),
        paths,
        activeRuns: registry,
        onEvent: () => {
          const [entry] = registry.list();
          // §7.3 step 2 writes the WIP commit into the session's own worktree,
          // so `cwd` is not decoration — `WrapUpService` reads it.
          if (entry) seen.push({ taskId: entry.taskId, role: entry.role, cwd: entry.cwd });
        },
      }).run(request(taskId));

      expect(seen[0]).toEqual({
        taskId,
        role: 'coder',
        cwd: join(scratch, 'worktree'),
      });
    });

    it('trägt auch eine abgerissene Sitzung wieder aus', async () => {
      const taskId = await newTask();
      const registry = new ActiveRunRegistry();
      const inner = new FakeBackend({
        events: HOOK_OK,
        result: { raw: GOOD_RESULT, tokensIn: 1, tokensOut: 1 },
      });

      // A stream that throws mid-run — the case the happy path cannot show,
      // because a clean `terminated` leaves through the same door as a success.
      // The `finally` is what has to hold: an entry left behind by a broken
      // stream is the one a later guardian transition would interrupt and kill,
      // against a process that is already gone.
      const backend: ModelBackend = {
        name: inner.name,
        capabilities: () => inner.capabilities(),
        resume: (spec) => inner.resume(spec),
        spawn: async (spec) => {
          const handle = await inner.spawn(spec);
          return {
            runId: handle.runId,
            sessionId: handle.sessionId,
            cwd: handle.cwd,
            events: async function* () {
              // One event through, then the stream dies — so the entry
              // provably existed before the failure it has to survive.
              for await (const event of handle.events()) {
                yield event;
                throw new Error('Strom abgerissen');
              }
            },
            queryUsage: () => handle.queryUsage(),
            transcriptPath: () => handle.transcriptPath(),
            interrupt: (reason) => handle.interrupt(reason),
            kill: () => handle.kill(),
          };
        },
      };

      const outcome = await new AgentRunner({
        sql,
        eventLog,
        backend,
        paths,
        activeRuns: registry,
      }).run(request(taskId));

      expect(outcome.status).toBe('infra');
      expect(registry.size).toBe(0);
    });
  });
});
