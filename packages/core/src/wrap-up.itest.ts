/**
 * The wrap-up protocol, end to end (§7.3) — and with it the three Phase 1 exit
 * gates that were deferred to Phase 2 step 1, because their gate texts require
 * tasks and claims that Phase 1's own step list never introduced:
 *
 *   G3 "a long-running dummy task is parked mid-work with WIP commit +
 *       handover note, then resumes and completes"
 *   G4 "killing the orchestrator mid-session → restart → state reconciled,
 *       no orphan sessions, task correctly `interrupted` and recovered"
 *   G5 "invalid/expired token → daemon idles, **zero** tasks marked red"
 *
 * All three run against a real Postgres and a real git repository, and not one
 * of them spends a token: the session is the `fake` backend's, and the model
 * work is a file the test writes itself. A37 exists for exactly this.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { EventLog } from './event-log.js';
import { BOT_IDENTITY, commitWip, currentBranch } from './git.js';
import { reconcile } from './reconcile.js';
import { TaskService } from './task-service.js';
import { type ActiveSession, WrapUpService } from './wrap-up.js';

const url = process.env.TEST_DATABASE_URL;
const PROJECT = 'dddddddd-0000-4000-8000-000000000001';

/** A throwaway repository standing in for a task worktree. */
function makeRepo(branch: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'vorschicht-wrapup-'));
  const git = (...args: string[]) =>
    execFileSync('git', args, {
      cwd: dir,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: BOT_IDENTITY.name,
        GIT_AUTHOR_EMAIL: BOT_IDENTITY.email,
        GIT_COMMITTER_NAME: BOT_IDENTITY.name,
        GIT_COMMITTER_EMAIL: BOT_IDENTITY.email,
      },
    });
  git('init', '--initial-branch=main', '--quiet');
  writeFileSync(join(dir, 'README.md'), '# Sandkasten\n');
  git('add', '.');
  git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'chore: Grundstein');
  if (branch !== 'main') git('checkout', '--quiet', '-b', branch);
  return dir;
}

function log(dir: string): string[] {
  return execFileSync('git', ['log', '--pretty=%s'], { cwd: dir, encoding: 'utf8' })
    .trim()
    .split('\n')
    .filter(Boolean);
}

describe.skipIf(!url)('Aufräumprotokoll (§7.3)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let tasks: TaskService;
  let eventLog: EventLog;
  const repos: string[] = [];

  beforeAll(async () => {
    database = await createTestDatabase('wrapup');
    sql = createSql({ url: database.url, max: 3 });
    eventLog = new EventLog(sql);
    tasks = new TaskService({ sql, eventLog });
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
    for (const dir of repos) rmSync(dir, { recursive: true, force: true });
  });

  // The services under test are global by design — there is one budget, one
  // auth incident, one orchestrator restart — so they act on every task in the
  // database. Append-only history cannot be deleted between tests, but a task
  // *can* be brought to a terminal state, and `aborted` is reachable from every
  // other one. That is the cleanup, and it exercises a real path while at it.
  afterEach(async () => {
    const open = await sql<Array<{ id: string }>>`
      SELECT id FROM tasks WHERE state NOT IN ('done', 'aborted')
    `;
    for (const row of open) {
      await tasks.transition(row.id, 'aborted', { actor: 'system', reason: 'Testende' });
    }
  });

  function repo(branch = 'vorschicht/task-1'): string {
    const dir = makeRepo(branch);
    repos.push(dir);
    return dir;
  }

  /** A session that records what happened to it instead of spawning anything. */
  function session(taskId: string, cwd: string | null) {
    const calls: string[] = [];
    const handle: ActiveSession = {
      runId: `run-${taskId.slice(0, 8)}`,
      taskId,
      cwd,
      interrupt: async (reason) => {
        calls.push(`interrupt:${reason}`);
      },
    };
    return { handle, calls };
  }

  async function taskInCoding(title: string, worktreePath: string, branch: string) {
    const task = await tasks.create({
      projectId: PROJECT,
      title,
      priority: 'P1',
      worktreePath,
      branch,
    });
    await tasks.transition(task.id, 'planning');
    await tasks.registerClaims(task.id, ['src/**']);
    await tasks.transition(task.id, 'claimed');
    return tasks.transition(task.id, 'coding');
  }

  // ---------------------------------------------------------------- Gate G3 --
  describe('G3 — mitten in der Arbeit parken und später zu Ende bringen', () => {
    it('sichert den Zwischenstand, hinterlässt eine Übergabe und läuft danach durch', async () => {
      const dir = repo('vorschicht/task-g3');
      const task = await taskInCoding('Langläufer', dir, 'vorschicht/task-g3');

      // The "long-running work": a half-finished edit, exactly what a session
      // interrupted mid-step leaves behind.
      writeFileSync(join(dir, 'src.ts'), 'export const halbfertig = true;\n');

      const live = session(task.id, dir);
      const wrapUp = new WrapUpService({
        tasks,
        eventLog,
        activeSessions: () => [live.handle],
      });

      const outcomes = await wrapUp.parkAll('guardian_wrap_up');
      const outcome = outcomes.find((o) => o.taskId === task.id);
      expect(outcome).toBeDefined();

      // Step 1: interrupted, never killed.
      expect(live.calls).toEqual(['interrupt:guardian_wrap_up']);
      // Step 2: WIP commit, on the task branch, with the `wip:` prefix.
      expect(outcome?.commit?.committed).toBe(true);
      expect(await currentBranch(dir)).toBe('vorschicht/task-g3');
      expect(log(dir)[0]).toMatch(/^wip: Langläufer \(coding\)$/);
      // Step 3: a handover note that says something.
      expect(outcome?.handover).toContain('Geparkt im Zustand "coding"');
      expect(outcome?.handover).toContain(outcome?.commit?.sha?.slice(0, 12) as string);
      // Step 4: parked, claims kept.
      const parked = await tasks.get(task.id);
      expect(parked?.state).toBe('parked');
      expect(parked?.resumeState).toBe('coding');

      const noteRows = await sql<Array<{ payload: { text: string; protocol: string } }>>`
        SELECT payload FROM task_events WHERE task_id = ${task.id} AND kind = 'note'
      `;
      expect(noteRows[0]?.payload.protocol).toBe('wrap_up');

      // Step 5: the guardian's confirmation.
      const idle = new WrapUpService({ tasks, eventLog, activeSessions: () => [] });
      expect(idle.isComplete(outcomes).complete).toBe(true);

      // …and after the window resets, it resumes and completes.
      const resumed = await idle.resumeAll();
      expect(resumed.find((t) => t.id === task.id)?.state).toBe('coding');

      await tasks.transition(task.id, 'review');
      await tasks.transition(task.id, 'gates');
      await tasks.transition(task.id, 'merge_queue');
      await tasks.transition(task.id, 'merging');
      const done = await tasks.transition(task.id, 'done');
      expect(done.state).toBe('done');
      expect(done.parkCount).toBe(1);
      // Nothing about a budget pause made this task red.
      expect(done.retryCount).toBe(0);
    });

    it('verweigert den WIP-Commit auf einem geschützten Branch', async () => {
      // §7.3 step 2 says "never to main". A wrap-up that quietly committed
      // there would put unreviewed, ungated work on the branch everything else
      // is built from — the one outcome this protocol must never produce.
      const dir = repo('main');
      writeFileSync(join(dir, 'src.ts'), 'export const gefaehrlich = true;\n');
      const result = await commitWip(dir, 'wip: darf nicht');
      expect(result.committed).toBe(false);
      expect(result.skipped).toMatch(/geschützt/);
      expect(log(dir)).toEqual(['chore: Grundstein']);
    });

    it('parkt auch dann sauber, wenn es nichts zu sichern gibt', async () => {
      const dir = repo('vorschicht/task-sauber');
      const task = await taskInCoding('Nichts geändert', dir, 'vorschicht/task-sauber');
      const wrapUp = new WrapUpService({ tasks, eventLog, activeSessions: () => [] });
      const outcome = (await wrapUp.parkAll('manual_pause')).find((o) => o.taskId === task.id);
      expect(outcome?.commit?.committed).toBe(false);
      expect(outcome?.parked).toBe(true);
      expect((await tasks.get(task.id))?.state).toBe('parked');
    });
  });

  // ---------------------------------------------------------------- Gate G4 --
  describe('G4 — Absturz mitten in der Sitzung, Neustart, Abgleich', () => {
    it('erkennt verwaiste Läufe, unterbricht die Aufgabe und erholt sich', async () => {
      const dir = repo('vorschicht/task-g4');
      const task = await taskInCoding('Absturzkandidat', dir, 'vorschicht/task-g4');

      // A run that emitted `created` and `started` and then died with the
      // process — precisely what a SIGKILL leaves in an append-only log.
      const runId = 'eeeeeeee-0000-4000-8000-000000000001';
      await sql`
        INSERT INTO agent_run_events (run_id, seq, kind, payload)
        VALUES (${runId}, 0, 'created', ${sql.json({ role: 'coder', cwd: dir, taskId: task.id })}),
               (${runId}, 1, 'started', ${sql.json({ pid: 4711 })})
      `;

      const result = await reconcile({ sql, tasks, eventLog });

      expect(result.orphanRuns.map((r) => r.runId)).toContain(runId);
      expect(result.interruptedTasks).toContain(task.id);

      // The run is closed, so a second reconcile finds nothing — no undead
      // session, and the token and duration figures finally settle.
      const [run] = await sql<Array<{ is_finished: boolean; terminal_reason: string }>>`
        SELECT is_finished, terminal_reason FROM agent_runs WHERE run_id = ${runId}
      `;
      expect(run?.is_finished).toBe(true);
      expect(run?.terminal_reason).toBe('orphaned');

      const second = await reconcile({ sql, tasks, eventLog });
      expect(second.orphanRuns).toHaveLength(0);

      // §7.2: interrupted, not red — and it stays put until it has been checked.
      const interrupted = await tasks.get(task.id);
      expect(interrupted?.state).toBe('interrupted');
      expect(interrupted?.resumeState).toBe('coding');
      await expect(tasks.resume(task.id)).rejects.toThrow(/Integritätsprüfung/);

      await tasks.recordIntegrityCheck(task.id, { ok: true, actor: 'debugger' });
      const recovered = await tasks.resume(task.id);
      expect(recovered.state).toBe('coding');
      expect(recovered.retryCount).toBe(0);
    });

    it('lässt wartende Aufgaben in Ruhe', async () => {
      // `merge_queue` is active but idle: the task holds its claims and waits
      // for its turn, and nothing touched its worktree. Marking it interrupted
      // would buy a Debugger session — a model session — on every restart, and
      // a deploy is a restart.
      const dir = repo('vorschicht/task-wartend');
      const task = await taskInCoding('Wartet auf den Merge', dir, 'vorschicht/task-wartend');
      await tasks.transition(task.id, 'review');
      await tasks.transition(task.id, 'gates');
      await tasks.transition(task.id, 'merge_queue');

      const result = await reconcile({ sql, tasks, eventLog });

      expect(result.interruptedTasks).not.toContain(task.id);
      expect((await tasks.get(task.id))?.state).toBe('merge_queue');
    });

    it('fängt auch eine Aufgabe ohne jeden Lauf ab', async () => {
      // The crash landed between "task moved to coding" and "run created".
      // Nothing points at it, and it still needs the same re-check.
      const dir = repo('vorschicht/task-g4b');
      const task = await taskInCoding('Ohne Lauf', dir, 'vorschicht/task-g4b');
      const result = await reconcile({ sql, tasks, eventLog });
      expect(result.strandedTasks).toContain(task.id);
      expect((await tasks.get(task.id))?.state).toBe('interrupted');
    });
  });

  // ---------------------------------------------------------------- Gate G5 --
  describe('G5 — Auth-Vorfall parkt, statt rot zu färben', () => {
    it('parkt laufende Arbeit und markiert nichts als Fehlschlag', async () => {
      const dir = repo('vorschicht/task-g5');
      const task = await taskInCoding('Läuft beim Vorfall', dir, 'vorschicht/task-g5');
      writeFileSync(join(dir, 'src.ts'), 'export const angefangen = true;\n');

      const live = session(task.id, dir);
      const wrapUp = new WrapUpService({ tasks, eventLog, activeSessions: () => [live.handle] });

      // §6.1: an authentication failure is an incident, never a task failure.
      await wrapUp.parkAll('auth_incident');
      await eventLog.append({
        kind: 'auth.incident',
        actor: 'system',
        payload: { reasons: ['claude auth status: nicht angemeldet'] },
      });

      const after = await tasks.get(task.id);
      expect(after?.state).toBe('parked');
      expect(after?.retryCount).toBe(0);

      // The assertion the gate is actually about: nothing anywhere went red.
      const [red] = await sql<Array<{ count: string }>>`
        SELECT count(*)::text FROM tasks WHERE state IN ('red', 'escalated')
      `;
      expect(Number(red?.count)).toBe(0);

      // And the handover says *why*, so the morning does not begin with a
      // diagnosis: "which fifteen tasks broke".
      expect(after?.resumeState).toBe('coding');
      const [note] = await sql<Array<{ payload: { text: string } }>>`
        SELECT payload FROM task_events
        WHERE task_id = ${task.id} AND kind = 'note' ORDER BY seq DESC LIMIT 1
      `;
      expect(note?.payload.text).toContain('Anmeldung am Claude-Konto gestört');

      // Clean recovery once the token is replaced.
      const idle = new WrapUpService({ tasks, eventLog, activeSessions: () => [] });
      const resumed = await idle.resumeAll();
      expect(resumed.find((t) => t.id === task.id)?.state).toBe('coding');
    });
  });

  describe('Unvollständiges Aufräumen wird als solches gemeldet', () => {
    it('erklärt sich nicht für fertig, solange eine Sitzung läuft', async () => {
      const stillRunning = session('ffffffff-0000-4000-8000-000000000001', null);
      const wrapUp = new WrapUpService({
        tasks,
        eventLog,
        activeSessions: () => [stillRunning.handle],
      });
      expect(wrapUp.isComplete([]).complete).toBe(false);
      expect(wrapUp.isComplete([]).reason).toMatch(/laufen noch/);
    });
  });
  // ---------------------------------------------------------------- §7.2 ----
  describe('§7.2s Ausnahme — ein laufendes Deployment wird nicht geparkt', () => {
    /**
     * §7.2s Tabelle sagt es wörtlich: *„No new deploys; **in-flight deploys
     * finish their health check**."* Ohne diese Ausnahme entsteht der
     * schlimmste Zustand, den dieses System erzeugen kann.
     *
     * Der Weg dorthin ist kurz: der Wächter überschreitet die Schwelle zwischen
     * dem Tausch und der Gesundheitsprüfung, der Wrap-up parkt die Aufgabe, die
     * Deploy-Maschine wird fertig und will nach `done` — und §9s Karte
     * verweigert es, weil `parked` in die aktiven Zustände zurückführt und
     * `done` keiner davon ist. Ergebnis: **die Produktion ist getauscht, der
     * Datensatz sagt „geparkt", und niemand sagt, ob es geklappt hat.**
     *
     * Gemeldet vom Strang, der die Maschine angeschlossen hat, und durch Lesen
     * der Übergangskarte bestätigt statt durch Hineinlaufen.
     */
    it('lässt sie im Deployment stehen und parkt alles andere', async () => {
      const dir = repo('vorschicht/task-deploy');
      const rollout = await taskInCoding('Rollt aus', dir, 'vorschicht/task-deploy');
      for (const state of ['review', 'gates', 'merge_queue', 'merging', 'deploying'] as const) {
        await tasks.transition(rollout.id, state);
      }

      const andere = await taskInCoding(
        'Arbeitet noch',
        repo('vorschicht/task-daneben'),
        'vorschicht/task-daneben',
      );

      const warnungen: string[] = [];
      const wrapUp = new WrapUpService({
        tasks,
        eventLog,
        activeSessions: () => [],
        onWarning: (message) => warnungen.push(message),
      });
      await wrapUp.parkAll('guardian_wrap_up');

      // Das Deployment läuft weiter …
      expect((await tasks.get(rollout.id))?.state).toBe('deploying');
      // … und genau deshalb kann es danach noch abschließen, was der Kern ist:
      // aus `parked` heraus verweigert §9 diesen Übergang.
      await tasks.transition(rollout.id, 'done', {
        actor: 'orchestrator',
        reason: 'Gesundheitsprüfung grün',
      });
      expect((await tasks.get(rollout.id))?.state).toBe('done');

      // Alles andere ist geparkt — die Ausnahme ist eine Ausnahme.
      expect((await tasks.get(andere.id))?.state).toBe('parked');

      // Und sie wird gesagt: ein Wrap-up, der weniger parkt als aktiv war, ist
      // sonst nicht von einem zu unterscheiden, der etwas übersehen hat.
      expect(warnungen.join(' ')).toMatch(/Deployment/);
    });
  });
});
