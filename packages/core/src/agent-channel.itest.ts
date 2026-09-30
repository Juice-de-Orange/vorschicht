/**
 * `escalate.ask` end to end (§6.4, §15) — the two things it can do.
 *
 * §22's Phase 4 exit gate reads: "Policy memory test: identical question the
 * second time is auto-answered from precedent (with reference), no new inbox
 * item." All three clauses are load-bearing and the third is the one an
 * implementation gets wrong quietly — a system that answers from memory *and*
 * files a card has not saved the operator anything, it has taught him to ignore his
 * inbox. So the assertions here are: the answer comes back, the reference comes
 * with it, and the number of open items is unchanged.
 *
 * Against a real Postgres because the precedent lookup *is* a query, and because
 * the fact that no item was created is a fact about a table.
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type { EscalateAskInput } from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AgentChannel } from './agent-channel.js';
import { ClaimRegistry } from './claim-registry.js';
import { EscalationService } from './escalation-service.js';
import { EventLog } from './event-log.js';
import { ProjectService } from './project-service.js';
import { TaskService } from './task-service.js';

const url = process.env.TEST_DATABASE_URL;

const ASK: EscalateAskInput = {
  question: 'Welcher Zweig ist der Integrationszweig?',
  context: 'Der Standardzweig sagt main, gearbeitet wird auf dev. §10 schneidet davon ab.',
  urgency: 'P1',
  options: [
    {
      title: 'main',
      pros: ['So steht es im Repository'],
      cons: ['Dort passiert nichts'],
      recommended: false,
    },
    {
      title: 'dev',
      pros: ['Dort entsteht die Arbeit'],
      cons: ['Weicht vom Standard ab'],
      recommended: true,
    },
  ],
};

describe.skipIf(!url)('escalate.ask (§6.4, §15)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let tasks: TaskService;
  let projects: ProjectService;
  let claims: ClaimRegistry;
  let eventLog: EventLog;
  let escalations: EscalationService;
  let projectA: string;
  let projectB: string;

  beforeAll(async () => {
    database = await createTestDatabase('agentchannel');
    sql = createSql({ url: database.url, max: 3 });
    eventLog = new EventLog(sql);
    tasks = new TaskService({ sql, eventLog });
    projects = new ProjectService(sql);
    claims = new ClaimRegistry({ sql, tasks, projects, eventLog });
    escalations = new EscalationService({ sql, eventLog });
    projectA = (await projects.create({ slug: 'alpha', name: 'Alpha', rootPath: '/tmp/a' })).id;
    projectB = (await projects.create({ slug: 'beta', name: 'Beta', rootPath: '/tmp/b' })).id;
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
  });

  async function channelFor(projectId: string, title: string): Promise<AgentChannel> {
    const task = await tasks.create({ projectId, title });
    return new AgentChannel(
      { sql, tasks, projects, claims, eventLog, escalations },
      task.id,
      'planner',
      crypto.randomUUID(),
    );
  }

  it('legt beim ersten Mal einen Eintrag ins Postfach', async () => {
    const channel = await channelFor(projectA, 'Zweig klären');
    const before = await escalations.countOpen();

    const result = await channel.requestEscalation(ASK);

    expect(result.answeredFromPrecedent).toBe(false);
    expect(result.number).not.toBeNull();
    expect(result.escalationRef).toBe(`#${result.number}`);
    expect(result.decision).toBeNull();
    expect(await escalations.countOpen()).toBe(before + 1);

    // Die Karte trägt §15s Form und hängt an dieser Aufgabe.
    const item = await escalations.byNumber(result.number as number);
    expect(item?.source).toBe('agent_question');
    expect(item?.taskId).toBe(channel.taskId);
    expect(item?.options).toHaveLength(2);
    expect(item?.raisedBy).toBe('planner');

    // Und die Aufgabe ist *nicht* geparkt: die Sitzung läuft noch (A48.2).
    expect((await tasks.get(channel.taskId))?.state).toBe('queued');

    // Der Griff, an dem `task_escalations` die Antwort später findet.
    const [row] = await sql<Array<{ escalation_number: string | null; answered: boolean }>>`
      SELECT escalation_number, answered FROM task_escalations WHERE task_id = ${channel.taskId}`;
    expect(Number(row?.escalation_number)).toBe(result.number);
    expect(row?.answered).toBe(false);
  });

  it('beantwortet dieselbe Frage beim zweiten Mal aus dem Gedächtnis, ohne neuen Eintrag', async () => {
    // Der Exit-Gate-Fall aus §22, Phase 4.
    const first = await channelFor(projectA, 'Zweig klären, erster Anlauf');
    const raised = await first.requestEscalation(ASK);
    await escalations.answer((await escalations.byNumber(raised.number as number))?.id as string, {
      optionIndex: 1,
      actor: 'max',
    });

    const second = await channelFor(projectA, 'Zweig klären, zweiter Anlauf');
    const openBefore = await escalations.countOpen();
    const result = await second.requestEscalation(ASK);

    // 1. beantwortet …
    expect(result.answeredFromPrecedent).toBe(true);
    expect(result.decision?.chosenTitle).toBe('dev');
    // 2. … mit Verweis …
    expect(result.decision?.number).toBe(raised.number);
    expect(result.decision?.summary).toContain(`Entscheidung #${raised.number}`);
    expect(result.decision?.decidedBy).toBe('max');
    // 3. … und ohne neuen Eintrag im Postfach.
    expect(result.number).toBeNull();
    expect(result.escalationRef).toBeNull();
    expect(await escalations.countOpen()).toBe(openBefore);

    // Die Aufgabe hat gar keine eigene Eskalation — sie hat eine Notiz.
    expect(await escalations.forTask(second.taskId)).toEqual([]);
    const notes = await second.notes();
    expect(notes.at(-1)?.text).toContain(`Entscheidung #${raised.number}`);
    expect(notes.at(-1)?.text).toContain('kein neuer');

    // Und beides steht im Ereignisprotokoll: gefragt *und* aus dem Gedächtnis
    // beantwortet. Nur zusammen sagen die beiden, dass das Studio sich das
    // zweite Fragen gespart hat, statt nie gefragt zu haben.
    const kinds = await sql<Array<{ kind: string }>>`
      SELECT kind FROM event_log WHERE task_id = ${second.taskId} ORDER BY id`;
    expect(kinds.map((k) => k.kind)).toContain('escalation.requested');
    expect(kinds.map((k) => k.kind)).toContain('escalation.precedent_applied');
    expect(kinds.map((k) => k.kind)).not.toContain('escalation.raised');
  });

  it('fragt in einem anderen Projekt erneut, statt die fremde Entscheidung anzuwenden', async () => {
    const item = await escalations.raise({
      source: 'agent_question',
      question: 'Läuft der Linter über scripts?',
      context: 'Nur für dieses Projekt entschieden.',
      urgency: 'P2',
      options: ASK.options,
      projectId: projectA,
      taskId: null,
      runId: null,
      raisedBy: 'planner',
    });
    await escalations.answer(item.id, { optionIndex: 1, actor: 'max' });

    const elsewhere = await channelFor(projectB, 'Linterfrage anderswo');
    const result = await elsewhere.requestEscalation({
      ...ASK,
      question: 'Läuft der Linter über scripts?',
    });
    expect(result.answeredFromPrecedent).toBe(false);
    expect(result.number).not.toBeNull();
  });

  it('hängt eine ähnliche frühere Entscheidung als Kontext an, beantwortet aber nichts', async () => {
    const item = await escalations.raise({
      source: 'agent_question',
      question: 'Darf Vorschicht auf dev schreiben?',
      context: 'Frühere, ähnliche Frage.',
      urgency: 'P2',
      options: ASK.options,
      projectId: projectA,
      taskId: null,
      runId: null,
      raisedBy: 'planner',
    });
    await escalations.answer(item.id, { optionIndex: 1, actor: 'max' });

    const channel = await channelFor(projectA, 'Ähnliche Frage');
    const result = await channel.requestEscalation({
      ...ASK,
      question: 'Darf Vorschicht auf dev wirklich schreiben?',
    });

    expect(result.answeredFromPrecedent).toBe(false);
    expect(result.related.map((r) => r.number)).toContain(item.number);
    expect(result.decision).toBeNull();
  });

  it('zeigt einer fortgesetzten Sitzung die Antwort, nicht nur dass es eine gibt', async () => {
    // §6.4 setzt *dieselbe* Sitzung fort. Sie liest ihren Kontext neu, und was
    // sie dann braucht, ist die Entscheidung — „answered: true“ allein sagt ihr,
    // dass sie weitermachen darf, aber nicht wie.
    const channel = await channelFor(projectA, 'Fortsetzung');
    const raised = await channel.requestEscalation({
      ...ASK,
      question: 'Nehmen wir Zeitzonen in den Cache-Schlüssel?',
    });
    const item = await escalations.byNumber(raised.number as number);

    let context = await channel.context();
    expect(context.escalations.at(-1)?.answered).toBe(false);
    expect(context.escalations.at(-1)?.decision).toBeNull();

    await escalations.answer(item?.id as string, {
      optionIndex: 0,
      freeText: 'nur UTC speichern',
      actor: 'max',
    });

    context = await channel.context();
    const latest = context.escalations.at(-1);
    expect(latest?.answered).toBe(true);
    expect(latest?.number).toBe(raised.number);
    expect(latest?.decision).toContain('main');
    expect(latest?.decision).toContain('nur UTC speichern');
  });
});
