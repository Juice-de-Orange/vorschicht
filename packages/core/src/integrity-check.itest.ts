/**
 * §7.2's mandatory re-check, against the guard it exists to satisfy.
 *
 * The point of doing this against a real Postgres rather than a stub is that
 * the rule being tested *is* a database rule (A43.3): an `interrupted` task
 * cannot leave that state — other than to `red` or `aborted` — until an
 * `integrity_check` with `ok: true` exists after the most recent interrupt. A
 * stubbed task service would happily accept a resume the real one refuses, and
 * the test would prove the opposite of what it claims.
 *
 * So every assertion here is about a task that really did move, or really was
 * refused, in Postgres. Real git worktrees, too, because the check's
 * no-worktree branch and its `ensure()` call are the two places it touches the
 * filesystem. Only the model is scripted (A37).
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type { SessionSpec } from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeBackend, type FakeEvent, type FakeScript } from './backend/fake.js';
import { EscalationService } from './escalation-service.js';
import { EventLog } from './event-log.js';
import { IntegrityCheck, IntegrityCheckError } from './integrity-check.js';
import { ProjectService } from './project-service.js';
import { AgentRunner, type RunnerPaths } from './runner.js';
import { createSandboxProject, type SandboxProject } from './sandbox.js';
import { TaskService } from './task-service.js';
import { ProjectReadOnlyError, WorktreeManager } from './worktree.js';

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

const SOUND = {
  status: 'done',
  summary: 'Arbeitskopie sauber, HEAD auf dem Task-Branch, keine halbe Datei.',
  artifacts: [],
  followups: [],
};

const BROKEN = {
  status: 'failed',
  summary: 'Ein Rebase steckt fest und src/greet.js endet mitten in einer Zeichenkette.',
  artifacts: [],
  followups: ['Rebase abbrechen', 'Von der Planung neu beginnen'],
};

function script(raw: unknown): FakeScript {
  return { events: [HOOK_START], result: { raw, tokensIn: 90, tokensOut: 120 } };
}

describe.skipIf(!url)('Integritätsprüfung (§7.2)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let tasks: TaskService;
  let projects: ProjectService;
  let worktrees: WorktreeManager;
  let eventLog: EventLog;
  let scratch: string;
  let paths: RunnerPaths;
  let sandbox: SandboxProject;
  let seq = 0;

  beforeAll(async () => {
    database = await createTestDatabase('integrity');
    sql = createSql({ url: database.url, max: 4 });
    eventLog = new EventLog(sql);
    tasks = new TaskService({ sql, eventLog });
    projects = new ProjectService(sql);
    scratch = await mkdtemp(join(tmpdir(), 'vs-integrity-'));
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
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
    await rm(scratch, { recursive: true, force: true });
  });

  async function newProject(over: { readOnly?: boolean } = {}) {
    seq += 1;
    return projects.create({
      slug: `integritaet-${seq}`,
      name: `Integrität ${seq}`,
      rootPath: sandbox.path,
      defaultBranch: sandbox.defaultBranch,
      ...over,
    });
  }

  function service(raw: unknown, seenSpecs: SessionSpec[] = []) {
    const backend = new FakeBackend(async (spec) => {
      seenSpecs.push(spec);
      return script(raw);
    });
    const runner = new AgentRunner({ sql, eventLog, backend, paths });
    return new IntegrityCheck({
      tasks,
      projects,
      worktrees,
      runner,
      eventLog,
      escalations: new EscalationService({ sql, eventLog }),
    });
  }

  /**
   * A task carried to `coding`, given a worktree, then interrupted — which is
   * exactly the state `reconcile()` leaves after a crash and the guardian
   * leaves after a hard stop.
   */
  async function interruptedTask(options: { worktree?: boolean; projectId?: string } = {}) {
    const projectId = options.projectId ?? (await newProject()).id;
    const task = await tasks.create({
      projectId,
      title: 'Begrüßung erweitern',
      description: 'Die Begrüßung soll eine Anrede tragen.',
      acceptanceCriteria: ['greet() liefert die Anrede'],
    });
    await tasks.transition(task.id, 'planning', { actor: 'orchestrator' });
    if (options.worktree !== false) await worktrees.ensure(task.id);
    await tasks.transition(task.id, 'claimed', { actor: 'orchestrator' });
    await tasks.transition(task.id, 'coding', { actor: 'orchestrator' });
    return tasks.transition(task.id, 'interrupted', {
      actor: 'controlling',
      reason: 'Harter Stopp bei 96 % des 5h-Fensters (§7.2)',
      resumeState: 'coding',
    });
  }

  it('die Datenbank lässt eine unterbrochene Aufgabe ohne Prüfung nicht weiter', async () => {
    const task = await interruptedTask();
    // The premise of everything below. If this ever stops throwing, every other
    // assertion in this file becomes a statement about nothing.
    await expect(tasks.transition(task.id, 'coding', { actor: 'orchestrator' })).rejects.toThrow();
    expect((await tasks.get(task.id))?.state).toBe('interrupted');
  });

  it('setzt nach bestandener Prüfung genau dort fort, wo gestoppt wurde', async () => {
    const task = await interruptedTask();
    const result = await service(SOUND).verify(task.id);

    expect(result.status).toBe('resumed');
    expect(result.ok).toBe(true);
    // Not "somewhere sensible": the state the interrupt recorded as its return
    // point. A resume that could land anywhere else is the defect A43.4 refuses.
    expect(result.resumedTo).toBe('coding');
    expect((await tasks.get(task.id))?.state).toBe('coding');

    const [row] = await sql<Array<{ payload: { ok: boolean } }>>`
      SELECT payload FROM task_events
      WHERE task_id = ${task.id} AND kind = 'integrity_check'
      ORDER BY seq DESC LIMIT 1
    `;
    expect(row?.payload.ok).toBe(true);
  });

  it('schreibt den Befund in das globale Ereignisprotokoll', async () => {
    const task = await interruptedTask();
    await service(SOUND).verify(task.id);

    const [event] = await sql<Array<{ payload: { ok: boolean; summary: string } }>>`
      SELECT payload FROM event_log
      WHERE kind = 'task.integrity_checked' AND task_id = ${task.id}
    `;
    expect(event?.payload.ok).toBe(true);
    expect(event?.payload.summary).toContain('Arbeitskopie');
  });

  it('schickt eine kaputte Arbeitskopie auf §9s roten Pfad statt sie fortzusetzen', async () => {
    const task = await interruptedTask();
    const result = await service(BROKEN).verify(task.id);

    expect(result.status).toBe('red');
    expect(result.ok).toBe(false);
    // §9 requeued it at a lower priority with the learnings attached — the same
    // treatment any other failed attempt gets, because that is what it is.
    const after = await tasks.get(task.id);
    expect(after?.state).toBe('queued');
    expect(after?.priority).toBe('P3');
    expect(result.red?.status).toBe('requeued');

    const [check] = await sql<Array<{ payload: { ok: boolean; findings: string[] } }>>`
      SELECT payload FROM task_events
      WHERE task_id = ${task.id} AND kind = 'integrity_check'
      ORDER BY seq DESC LIMIT 1
    `;
    expect(check?.payload.ok).toBe(false);
    expect(check?.payload.findings).toContain('Rebase abbrechen');
  });

  it('prüft ohne Sitzung, wenn es gar kein Arbeitsverzeichnis gibt', async () => {
    const projectId = (await newProject()).id;
    const task = await tasks.create({ projectId, title: 'Noch nichts angefangen' });
    await tasks.transition(task.id, 'planning', { actor: 'orchestrator' });
    await tasks.transition(task.id, 'interrupted', {
      actor: 'controlling',
      reason: 'Neustart des Orchestrators',
      resumeState: 'planning',
    });

    const specs: SessionSpec[] = [];
    const result = await service(SOUND, specs).verify(task.id);

    expect(result.status).toBe('resumed');
    expect(result.withoutSession).toBe(true);
    // The assertion that matters: no model session was spent to learn that a
    // directory which does not exist has nothing wrong with it.
    expect(specs).toEqual([]);
    expect((await tasks.get(task.id))?.state).toBe('planning');
  });

  it('gibt dem Debugger den Grund der Unterbrechung mit', async () => {
    const task = await interruptedTask();
    const specs: SessionSpec[] = [];
    await service(SOUND, specs).verify(task.id);

    expect(specs).toHaveLength(1);
    expect(specs[0]?.prompt).toContain('Harter Stopp bei 96 %');
    expect(specs[0]?.role).toBe('debugger');
  });

  it('lässt die Prüfsitzung nichts schreiben', async () => {
    const task = await interruptedTask();
    const specs: SessionSpec[] = [];
    await service(SOUND, specs).verify(task.id);

    // Read-only twice over, as §9's diagnosis is: the profile grants no editing
    // tool and the policy grants no write root. This session runs over a tree
    // whose state is already not what anyone expected.
    const spec = specs[0];
    expect(spec?.allowedTools).not.toContain('Write');
    expect(spec?.allowedTools).not.toContain('Edit');
  });

  it('lässt die Aufgabe unangetastet, wenn die Prüfung selbst nicht durchkam', async () => {
    const task = await interruptedTask();
    // A session that produces no result at all: the harness failed, and nothing
    // about the worktree has been established in either direction.
    const backend = new FakeBackend(async () => ({ events: [HOOK_START] }));
    const runner = new AgentRunner({ sql, eventLog, backend, paths });
    const check = new IntegrityCheck({
      tasks,
      projects,
      worktrees,
      runner,
      eventLog,
      escalations: new EscalationService({ sql, eventLog }),
    });

    const result = await check.verify(task.id);
    expect(result.status).toBe('infra');
    expect(result.ok).toBeNull();
    expect((await tasks.get(task.id))?.state).toBe('interrupted');

    // And nothing was recorded that would let it resume later on this evidence.
    const [row] = await sql<Array<{ n: string }>>`
      SELECT count(*)::text AS n FROM task_events
      WHERE task_id = ${task.id} AND kind = 'integrity_check'
    `;
    expect(row?.n).toBe('0');
  });

  it('eine ältere bestandene Prüfung berechtigt keine spätere Fortsetzung', async () => {
    const task = await interruptedTask();
    await service(SOUND).verify(task.id);
    expect((await tasks.get(task.id))?.state).toBe('coding');

    // A second stop. The check from a minute ago says nothing about this one.
    await tasks.transition(task.id, 'interrupted', {
      actor: 'controlling',
      reason: 'Zweiter harter Stopp',
      resumeState: 'coding',
    });
    await expect(tasks.transition(task.id, 'coding', { actor: 'orchestrator' })).rejects.toThrow();

    await service(SOUND).verify(task.id);
    expect((await tasks.get(task.id))?.state).toBe('coding');
  });

  it('weist eine Aufgabe zurück, die gar nicht unterbrochen ist', async () => {
    const projectId = (await newProject()).id;
    const task = await tasks.create({ projectId, title: 'Wartet in der Schlange' });
    await expect(service(SOUND).verify(task.id)).rejects.toBeInstanceOf(IntegrityCheckError);
  });

  it('weist ein nur lesbares Projekt zurück (A41)', async () => {
    const project = await newProject();
    const task = await interruptedTask({ projectId: project.id });
    await projects.setReadOnly(project.id, true);
    // The error type rather than its wording: a German sentence is the one
    // part of this that a later session may legitimately rephrase.
    await expect(service(SOUND).verify(task.id)).rejects.toBeInstanceOf(ProjectReadOnlyError);
  });
});
