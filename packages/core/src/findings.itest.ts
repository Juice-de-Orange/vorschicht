/**
 * §5's `gate_runs` / `findings` against a real Postgres (migration 0015).
 *
 * Everything worth testing here *is* the database. The whole point of the
 * design is that nothing resolves a finding — §11 gives it exactly one way out,
 * a later gate run in which the same gate reported green, and the view derives
 * it. A stubbed store would let a test assert whatever the stub was told to
 * return, which is the opposite of a proof: the claim is "there is no code path
 * that closes a finding without a green run behind it", and that claim is only
 * true if there is no such path *in the view either*.
 *
 * So the suite writes real gate runs, reads the real view, and additionally
 * points the append-only guards at themselves — a finding that could be
 * UPDATEd away would make every other assertion here decorative.
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EventLog } from './event-log.js';
import { FindingsService } from './findings.js';
import type { GateStepResult, GateSuiteResult } from './gate-suite.js';
import { ProjectService } from './project-service.js';
import { TaskService } from './task-service.js';

const url = process.env.TEST_DATABASE_URL;

function step(over: Partial<GateStepResult> & Pick<GateStepResult, 'id' | 'verdict'>) {
  return {
    detail: 'Egal.',
    output: '',
    durationMs: 5,
    command: null,
    exitCode: null,
    attempts: 1,
    retries: [],
    ...over,
  } as GateStepResult;
}

function suite(steps: GateStepResult[]): GateSuiteResult {
  return {
    ok: steps.every((s) => s.verdict === 'green'),
    steps,
    findings: steps.filter((s) => s.verdict === 'finding'),
    infra: steps.filter((s) => s.verdict === 'infra'),
    retried: steps.filter((s) => s.attempts > 1),
    durationMs: 1_234,
  };
}

describe.skipIf(!url)('Befunde und Gate-Läufe (§5, §11)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let tasks: TaskService;
  let projects: ProjectService;
  let findings: FindingsService;
  let projectId: string;

  beforeAll(async () => {
    database = await createTestDatabase('findings');
    sql = createSql({ url: database.url, max: 3 });
    const eventLog = new EventLog(sql);
    tasks = new TaskService({ sql, eventLog });
    projects = new ProjectService(sql);
    findings = new FindingsService({ sql });
    const project = await projects.create({
      slug: 'befunde',
      name: 'Befunde',
      rootPath: '/tmp/befunde',
    });
    projectId = project.id;
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
  });

  /** A task parked at `gates` — where a merge candidate comes from (§8.1). */
  async function candidate(title: string) {
    const task = await tasks.create({ projectId, title, priority: 'P1' });
    for (const state of ['planning', 'claimed', 'coding', 'review', 'gates'] as const) {
      await tasks.transition(task.id, state, { actor: 'orchestrator' });
    }
    return task.id;
  }

  describe('der Gate-Lauf ist das, was aufgeschrieben wird', () => {
    it('speichert jeden Schritt samt Ausgabe — auch die grünen', async () => {
      const taskId = await candidate('Alles grün');
      const recorded = await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        headSha: 'a'.repeat(40),
        baseRef: 'main',
        result: suite([
          step({ id: 'lint', verdict: 'green', detail: 'Sauber.', output: 'checked 12 files' }),
          step({ id: 'test', verdict: 'green', detail: 'Grün.' }),
        ]),
      });

      expect(recorded.findings).toEqual([]);
      expect(recorded.run.ok).toBe(true);
      expect(recorded.run.headSha).toBe('a'.repeat(40));
      // §8.2 domain 7 asks whether a commit reached the branch without a gate
      // run behind it. Only recording the reds would make that unanswerable.
      const [row] = await sql<Array<{ steps: unknown[] }>>`
        SELECT steps FROM gate_runs WHERE id = ${recorded.run.id}`;
      expect(row?.steps).toHaveLength(2);
      expect(JSON.stringify(row?.steps)).toContain('checked 12 files');
    });

    it('leitet started_at aus der gemessenen Dauer ab', async () => {
      const taskId = await candidate('Dauer');
      const recorded = await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        result: { ...suite([step({ id: 'lint', verdict: 'green' })]), durationMs: 60_000 },
      });
      const span = recorded.run.finishedAt.getTime() - recorded.run.startedAt.getTime();
      expect(span).toBeGreaterThanOrEqual(59_000);
      expect(span).toBeLessThanOrEqual(61_000);
    });
  });

  describe('was ein Befund ist und was nicht (§11, A25)', () => {
    it('ein roter Schritt wird zum Befund, mit voller Ausgabe und Blocker-Stufe', async () => {
      const taskId = await candidate('Ein Befund');
      const recorded = await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        headSha: 'b'.repeat(40),
        baseRef: 'main',
        result: suite([
          step({
            id: 'test',
            verdict: 'finding',
            detail: 'Die Testsuite ist rot.',
            output: 'not ok 3 - greets a name',
            exitCode: 1,
            command: ['npm', 'test'],
          }),
        ]),
      });

      expect(recorded.findings).toHaveLength(1);
      const [finding] = recorded.findings;
      expect(finding?.gateId).toBe('test');
      // §11 has one severity, and it is a literal in the view rather than a
      // column — so there is nowhere for an exception to be written.
      expect(finding?.severity).toBe('blocker');
      expect(finding?.status).toBe('open');
      expect(finding?.output).toContain('not ok 3');
      expect(finding?.exitCode).toBe(1);
      expect(finding?.command).toEqual(['npm', 'test']);
      expect(finding?.raisedOnSha).toBe('b'.repeat(40));
      // The linkage §5 asks for: while the task can still be worked on, it is
      // the task carrying the fix (§9 requeues rather than forking).
      expect(finding?.fixTaskId).toBe(taskId);
    });

    it('ein Infrastrukturfehler ist ausdrücklich kein Befund (A25)', async () => {
      const taskId = await candidate('Nur Infrastruktur');
      const recorded = await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        result: suite([
          step({ id: 'secrets', verdict: 'infra', detail: 'Docker nicht erreichbar.' }),
          step({ id: 'lint', verdict: 'green' }),
        ]),
      });

      // Recorded in the run — "what could not be checked" must stay visible —
      // and absent from the findings, because it blocks nothing.
      expect(recorded.findings).toEqual([]);
      const [row] = await sql<Array<{ steps: string }>>`
        SELECT steps::text FROM gate_runs WHERE id = ${recorded.run.id}`;
      expect(row?.steps).toContain('Docker nicht erreichbar');
    });

    it('vergibt eine stabile Kennung aus Lauf und Gate', async () => {
      const taskId = await candidate('Kennung');
      const recorded = await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        result: suite([step({ id: 'lint', verdict: 'finding', detail: 'x' })]),
      });
      const again = await findings.open(taskId);
      expect(again[0]?.id).toBe(recorded.findings[0]?.id);
    });
  });

  describe('geschlossen wird nur durch Belege (§11)', () => {
    it('ein späterer grüner Lauf desselben Gates schließt den Befund', async () => {
      const taskId = await candidate('Behoben');
      const red = await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        headSha: 'c'.repeat(40),
        result: suite([step({ id: 'test', verdict: 'finding', detail: 'rot' })]),
      });
      expect((await findings.open(taskId)).map((f) => f.gateId)).toEqual(['test']);

      const green = await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        headSha: 'd'.repeat(40),
        result: suite([step({ id: 'test', verdict: 'green', detail: 'grün' })]),
      });

      expect(await findings.open(taskId)).toEqual([]);
      const [finding] = await findings.forTask(taskId);
      expect(finding?.status).toBe('resolved');
      expect(finding?.resolvedByGateRunId).toBe(green.run.id);
      // Both shas, because §8.2's seventh domain asks whether a gate flipped
      // red → green with no code change in between. Without the pair that is a
      // question nobody can put to the record.
      expect(finding?.raisedOnSha).toBe('c'.repeat(40));
      expect(finding?.resolvedOnSha).toBe('d'.repeat(40));
      expect(finding?.gateRunId).toBe(red.run.id);
    });

    it('ein grüner Lauf eines *anderen* Gates schließt nichts', async () => {
      const taskId = await candidate('Falsches Gate');
      await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        result: suite([step({ id: 'test', verdict: 'finding', detail: 'rot' })]),
      });
      await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        result: suite([step({ id: 'lint', verdict: 'green' })]),
      });
      expect((await findings.open(taskId)).map((f) => f.gateId)).toEqual(['test']);
    });

    it('ein *früherer* grüner Lauf schließt nichts', async () => {
      // The direction is the whole rule. A gate that was green before the
      // finding says nothing about the tree that produced the finding, and a
      // view comparing without regard to order would close every finding a
      // second attempt ever raised.
      const taskId = await candidate('Reihenfolge');
      await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        result: suite([step({ id: 'test', verdict: 'green' })]),
      });
      await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        result: suite([step({ id: 'test', verdict: 'finding', detail: 'jetzt rot' })]),
      });
      expect((await findings.open(taskId)).map((f) => f.gateId)).toEqual(['test']);
    });

    it('ein grüner Lauf einer *anderen* Aufgabe schließt nichts', async () => {
      const mine = await candidate('Meine');
      const other = await candidate('Fremde');
      await findings.record({
        taskId: mine,
        projectId,
        stage: 'merge_queue',
        result: suite([step({ id: 'build', verdict: 'finding', detail: 'rot' })]),
      });
      await findings.record({
        taskId: other,
        projectId,
        stage: 'merge_queue',
        result: suite([step({ id: 'build', verdict: 'green' })]),
      });
      expect((await findings.open(mine)).map((f) => f.gateId)).toEqual(['build']);
    });

    it('nimmt den ersten grünen Lauf danach, nicht den letzten', async () => {
      const taskId = await candidate('Erster Beleg');
      await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        result: suite([step({ id: 'docs', verdict: 'finding', detail: 'rot' })]),
      });
      const first = await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        result: suite([step({ id: 'docs', verdict: 'green' })]),
      });
      await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        result: suite([step({ id: 'docs', verdict: 'green' })]),
      });
      const [finding] = await findings.forTask(taskId);
      expect(finding?.resolvedByGateRunId).toBe(first.run.id);
    });
  });

  describe('wer den Befund gerade behebt — und wann niemand (§5, §9)', () => {
    it('eine eskalierte Aufgabe hat keine Behebungsaufgabe', async () => {
      const taskId = await candidate('Eskaliert');
      await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        result: suite([step({ id: 'test', verdict: 'finding', detail: 'rot' })]),
      });
      await tasks.transition(taskId, 'red', { actor: 'orchestrator' });
      await tasks.transition(taskId, 'escalated', { actor: 'orchestrator' });

      const [finding] = await findings.forTask(taskId);
      // Still a blocker — §9's escalation does not make a defect go away — but
      // nobody is on it, and a linkage that said otherwise would let the
      // dashboard show work that is not happening.
      expect(finding?.status).toBe('open');
      expect(finding?.fixTaskId).toBeNull();
      expect(finding?.taskState).toBe('escalated');
    });

    it('eine abgebrochene Aufgabe lässt den Befund als aufgegeben zurück', async () => {
      const taskId = await candidate('Abgebrochen');
      await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        result: suite([step({ id: 'lint', verdict: 'finding', detail: 'rot' })]),
      });
      await tasks.transition(taskId, 'aborted', { actor: 'max' });

      const [finding] = await findings.forTask(taskId);
      expect(finding?.status).toBe('abandoned');
      expect(finding?.fixTaskId).toBeNull();
      // And it drops out of what the project owes, because nothing will fix it.
      expect((await findings.openForProject(projectId)).map((f) => f.id)).not.toContain(
        finding?.id,
      );
    });
  });

  /**
   * §8.2's `gate_flip` question, asked of the view 0015 built to answer it.
   *
   * 0015's decision 3 named this in as many words — "both runs carry the sha of
   * the tree they checked, so the answer is a comparison rather than a belief"
   * — and until now nothing asked. The comparison is the whole of it: identical
   * shas means the tree did not change between the two verdicts, whatever
   * happened in between, so no reasoning about "the next run" is needed.
   */
  describe('§8.2 — rot nach grün ohne Änderung am Baum', () => {
    async function flipped(
      title: string,
      redSha: string,
      greenSha: string,
      gate: GateStepResult['id'] = 'test',
    ) {
      const taskId = await candidate(title);
      await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        headSha: redSha,
        result: suite([step({ id: gate, verdict: 'finding', detail: 'rot' })]),
      });
      await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        headSha: greenSha,
        result: suite([step({ id: gate, verdict: 'green', detail: 'grün' })]),
      });
      return taskId;
    }

    it('findet eine Wendung auf demselben Baum', async () => {
      const sha = '1'.repeat(40);
      const taskId = await flipped('Umschwung', sha, sha);

      const flips = await findings.flipsWithoutCodeChange(60 * 60_000, 10);

      expect(flips.map((f) => f.taskId)).toContain(taskId);
      expect(flips.find((f) => f.taskId === taskId)?.gateId).toBe('test');
    });

    it('findet keine Wendung, wenn sich der Baum geändert hat', async () => {
      // The ordinary case, and by far the common one: a finding, a fix, a
      // greener tree. Reporting this would spend a model session per merge.
      const taskId = await flipped('Echte Korrektur', '2'.repeat(40), '3'.repeat(40));

      const flips = await findings.flipsWithoutCodeChange(60 * 60_000, 50);

      expect(flips.map((f) => f.taskId)).not.toContain(taskId);
    });

    it('hält zwei Läufe ohne aufgezeichnete sha nicht für denselben Baum', async () => {
      // Both NULL. SQL would call that neither equal nor unequal, and a naive
      // `IS NOT DISTINCT FROM` would call it a flip — two runs that both failed
      // to record what they checked prove nothing about each other.
      const taskId = await candidate('Ohne sha');
      await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        result: suite([step({ id: 'test', verdict: 'finding', detail: 'rot' })]),
      });
      await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        result: suite([step({ id: 'test', verdict: 'green', detail: 'grün' })]),
      });

      const flips = await findings.flipsWithoutCodeChange(60 * 60_000, 50);
      expect(flips.map((f) => f.taskId)).not.toContain(taskId);
    });

    it('meldet einen offenen Befund nicht als Wendung', async () => {
      const taskId = await candidate('Noch offen');
      await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        headSha: '4'.repeat(40),
        result: suite([step({ id: 'test', verdict: 'finding', detail: 'rot' })]),
      });

      const flips = await findings.flipsWithoutCodeChange(60 * 60_000, 50);
      expect(flips.map((f) => f.taskId)).not.toContain(taskId);
    });

    it('sieht nur so weit zurück, wie das Fenster reicht', async () => {
      const sha = '5'.repeat(40);
      await flipped('Zu alt', sha, sha);

      // A flip nobody noticed within the window is not worth a session, and the
      // bound is what keeps the result set from growing with the table.
      expect(await findings.flipsWithoutCodeChange(0, 50)).toEqual([]);
    });
  });

  describe('der Datensatz lässt sich nicht wegschreiben', () => {
    it('ein Gate-Lauf kann weder geändert noch gelöscht noch geleert werden', async () => {
      const taskId = await candidate('Unveränderlich');
      const recorded = await findings.record({
        taskId,
        projectId,
        stage: 'merge_queue',
        result: suite([step({ id: 'test', verdict: 'finding', detail: 'rot' })]),
      });

      await expect(
        sql`UPDATE gate_runs SET ok = true WHERE id = ${recorded.run.id}`,
      ).rejects.toThrow();
      await expect(sql`DELETE FROM gate_runs WHERE id = ${recorded.run.id}`).rejects.toThrow();
      // TRUNCATE fires no row-level trigger at all — the hole 0004 closes, and
      // the reason the statement-level guard is not redundant.
      await expect(sql`TRUNCATE gate_runs`).rejects.toThrow();

      expect((await findings.open(taskId)).map((f) => f.gateId)).toEqual(['test']);
    });
  });
});
