/**
 * The MCP server over the real protocol, against a real Postgres.
 *
 * Not a test of the handler functions: a real `Client` from the SDK is linked
 * to the server through an in-memory transport pair, so `initialize`,
 * `tools/list` and `tools/call` all happen exactly as they do when the CLI is
 * the client. That matters because the protocol layer is where the failures we
 * cannot see live — a tool registered under a name nobody grants, an input
 * schema the client rejects before the handler ever runs, an error thrown as a
 * JSON-RPC fault instead of returned as a tool error.
 *
 * The database is real for the same reason `claim-registry.itest.ts` uses one:
 * the interesting assertions are about what ends up in `task_events`, and §9's
 * guards are enforced there. Not one model token is spent — a "coder" here is a
 * state transition and a tool call.
 */
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  ClaimRegistry,
  DocumentVault,
  EventLog,
  ProjectService,
  TaskService,
} from '@vorschicht/core';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import { MCP_TOOL_NAMES } from '@vorschicht/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_DOCUMENT_TEXT_CHARS } from './server.js';

/** The built entry point. `pnpm gate` typechecks (and thus builds) before it tests. */
const SERVER_ENTRY = 'packages/mcp/dist/main.js';

const url = process.env.TEST_DATABASE_URL;

/** The text content of a tool result, parsed back into an object. */
// biome-ignore lint/suspicious/noExplicitAny: the SDK types call results loosely
function payloadOf(result: any): Record<string, unknown> {
  const first = result.content?.[0];
  expect(first?.type).toBe('text');
  if (result.isError) throw new Error(`Werkzeugfehler: ${String(first.text)}`);
  return JSON.parse(String(first.text));
}

describe.skipIf(!url)('Interner MCP-Server (§6.2, §22 Phase 2 Schritt 3)', () => {
  let sql: ReturnType<typeof createSql>;
  let database: TestDatabase;
  let tasks: TaskService;
  let projects: ProjectService;
  let claims: ClaimRegistry;
  let eventLog: EventLog;
  let vault: DocumentVault;

  beforeAll(async () => {
    database = await createTestDatabase('mcp');
    sql = createSql({ url: database.url, max: 4 });
    eventLog = new EventLog(sql);
    tasks = new TaskService({ sql, eventLog });
    projects = new ProjectService(sql);
    claims = new ClaimRegistry({ sql, tasks, projects, eventLog });
    // The real vault seeds the vault cases. It is the service under examination
    // here only in so far as the MCP layer calls it; what is *under* test is
    // the seam — role → department → ranking → response — and hand-written rows
    // could set up a state the real writer cannot produce. `documents.itest.ts`
    // is where the vault itself is proven.
    vault = new DocumentVault(sql);
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
  });

  let seq = 0;

  async function newProject(): Promise<string> {
    seq += 1;
    const project = await projects.create({
      slug: `mcp-p${seq}`,
      name: `Projekt ${seq}`,
      rootPath: `/tmp/mcp-p${seq}`,
      defaultBranch: 'main',
    });
    return project.id;
  }

  /**
   * A task with a brief, its claims held, and a worktree — a Coder's world.
   *
   * The claim prefix varies per task on purpose: two tasks in one project may
   * not hold overlapping globs (§10), so a fixed set would leave the second one
   * refused in `planning` — which is the registry working, and a confusing way
   * for a fixture to fail.
   */
  let taskSeq = 0;
  async function codingTask(projectId: string): Promise<string> {
    taskSeq += 1;
    const area = `src/cache${taskSeq}`;
    const task = await tasks.create({
      projectId,
      title: 'Cache-Invalidierung reparieren',
      description: 'Der Cache wird beim Schreiben nicht verworfen.',
      acceptanceCriteria: ['Ein Test deckt den Schreibpfad ab', 'Kein Verhalten sonst geändert'],
      type: 'fix',
      department: 'Entwicklung',
    });
    await tasks.transition(task.id, 'planning');
    await claims.register(task.id, [`${area}/**`, `test/cache${taskSeq}.test.ts`]);
    const acquired = await claims.acquire(task.id);
    expect(acquired.acquired, JSON.stringify(acquired.conflicts)).toBe(true);
    await tasks.assignWorktree(task.id, {
      path: `/data/worktrees/mcp/task-${task.id}`,
      branch: `vorschicht/task-${task.id}`,
      baseBranch: 'main',
      baseSha: 'a'.repeat(40),
    });
    await tasks.transition(task.id, 'coding');
    return task.id;
  }

  /**
   * The real server process, driven by the vendor's own MCP client.
   *
   * Deliberately a spawned process rather than an in-memory pair: this is the
   * only arrangement that exercises what the CLI actually does — start
   * `main.js`, hand it an environment, and speak JSON-RPC over its stdio. It
   * therefore covers the identity plumbing, the startup checks, the hand-rolled
   * wire and the handlers in one go. And the client is the SDK's, so every
   * response is validated against the vendor's schemas rather than against our
   * own understanding of them.
   */
  async function connect(taskId: string, role = 'coder', runId = randomUUID()) {
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      env: {
        PATH: process.env.PATH ?? '',
        DATABASE_URL: database.url,
        VORSCHICHT_TASK_ID: taskId,
        VORSCHICHT_RUN_ID: runId,
        VORSCHICHT_ROLE: role,
      },
      stderr: 'pipe',
    });
    await client.connect(transport);
    return {
      client,
      async close() {
        await client.close();
      },
    };
  }

  it('bietet über das Protokoll genau die Werkzeuge an, die die Whitelist adressiert', async () => {
    const taskId = await codingTask(await newProject());
    const { client, close } = await connect(taskId);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((t) => t.name).sort()).toEqual([...MCP_TOOL_NAMES].sort());
      // Every tool carries a description; without one the model does not call it.
      for (const tool of listed.tools) {
        expect(tool.description?.length ?? 0).toBeGreaterThan(40);
      }
    } finally {
      await close();
    }
  });

  it('task.get_context liefert Auftrag, Umgebung und Vorgeschichte', async () => {
    const projectId = await newProject();
    const taskId = await codingTask(projectId);
    await tasks.note(taskId, { text: 'Plan: erst den Test, dann den Fix.', actor: 'planner' });

    const { client, close } = await connect(taskId);
    try {
      const payload = payloadOf(await client.callTool({ name: 'task.get_context', arguments: {} }));
      const task = payload.task as Record<string, unknown>;

      expect(task.id).toBe(taskId);
      expect(task.title).toBe('Cache-Invalidierung reparieren');
      // The brief §8 asks for. Without it a title is all an agent has, and a
      // title is not a mandate — the Planner prompt promises these two fields.
      expect(task.description).toBe('Der Cache wird beim Schreiben nicht verworfen.');
      expect(task.acceptanceCriteria).toEqual([
        'Ein Test deckt den Schreibpfad ab',
        'Kein Verhalten sonst geändert',
      ]);
      expect(task.state).toBe('coding');
      expect(task.stateLabel).toBe('In Umsetzung');

      expect((payload.project as Record<string, unknown>).defaultBranch).toBe('main');
      expect((payload.worktree as Record<string, unknown>).branch).toBe(
        `vorschicht/task-${taskId}`,
      );
      expect(payload.claims).toEqual({
        status: 'active',
        globs: (await claims.heldGlobs(taskId)).sort(),
      });
      expect(payload.notes).toEqual([
        expect.objectContaining({ actor: 'planner', text: 'Plan: erst den Test, dann den Fix.' }),
      ]);
      // Oldest first, so a handover reads as a story rather than as a stack.
      const history = payload.history as Array<Record<string, unknown>>;
      expect(history.map((h) => h.to)).toEqual(['planning', 'claimed', 'coding']);
    } finally {
      await close();
    }
  });

  it('bindet die Sitzung an genau eine Aufgabe — ein Aufgabenargument gibt es nicht', async () => {
    const projectId = await newProject();
    const mine = await codingTask(projectId);
    const other = await codingTask(projectId);

    const { client, close } = await connect(mine);
    try {
      // Passing another task's id is not "rejected" — there is nothing to pass
      // it to. The tool takes no arguments at all, and the schema says so.
      const listed = await client.listTools();
      const contextTool = listed.tools.find((t) => t.name === 'task.get_context');
      expect(contextTool?.inputSchema.properties ?? {}).toEqual({});

      const payload = payloadOf(
        await client.callTool({ name: 'task.get_context', arguments: { taskId: other } }),
      );
      expect((payload.task as Record<string, unknown>).id).toBe(mine);
    } finally {
      await close();
    }
  });

  it('task.append_note schreibt in die Zeitleiste, ohne den Zustand zu bewegen', async () => {
    const taskId = await codingTask(await newProject());
    const before = await tasks.get(taskId);

    const { client, close } = await connect(taskId);
    try {
      const payload = payloadOf(
        await client.callTool({
          name: 'task.append_note',
          arguments: { text: 'Ursache gefunden: der Invalidierungs-Hook lief vor dem Schreiben.' },
        }),
      );
      expect(payload.recorded).toBe(true);

      const after = await tasks.get(taskId);
      expect(after?.state).toBe(before?.state);
      expect(after?.version).toBe((before?.version ?? 0) + 1);
    } finally {
      await close();
    }
  });

  it('weist eine leere Notiz ab, mit einem Satz statt einem Protokollfehler', async () => {
    const taskId = await codingTask(await newProject());
    const { client, close } = await connect(taskId);
    try {
      // A JSON-RPC fault reads to the model as "this tool is broken" and it
      // routes around; a tool error with a sentence reads as "fix the call".
      const result = await client.callTool({ name: 'task.append_note', arguments: { text: '' } });
      expect(result.isError).toBe(true);
    } finally {
      await close();
    }
  });

  it('claims.list nennt die Globs und sagt, was ihr Status gerade bedeutet', async () => {
    const taskId = await codingTask(await newProject());
    const { client, close } = await connect(taskId);
    try {
      const payload = payloadOf(await client.callTool({ name: 'claims.list', arguments: {} }));
      expect(payload.status).toBe('active');
      expect(payload.globs).toEqual((await claims.heldGlobs(taskId)).sort());
      expect(String(payload.note)).toMatch(/write inside them and nowhere else/);
    } finally {
      await close();
    }
  });

  it('sagt einer Aufgabe ohne Claims, dass sie nichts schreiben darf', async () => {
    const projectId = await newProject();
    const task = await tasks.create({ projectId, title: 'Ohne Claims' });
    await tasks.transition(task.id, 'planning');

    const { client, close } = await connect(task.id, 'planner');
    try {
      const payload = payloadOf(await client.callTool({ name: 'claims.list', arguments: {} }));
      expect(payload.status).toBe('none');
      expect(payload.globs).toEqual([]);
      expect(String(payload.note)).toMatch(/planning gap/);
    } finally {
      await close();
    }
  });

  it('finding.report legt einen Blocker ab — eine Schwere gibt es nicht (§11)', async () => {
    const taskId = await codingTask(await newProject());
    const { client, close } = await connect(taskId, 'reviewer');
    try {
      const payload = payloadOf(
        await client.callTool({
          name: 'finding.report',
          arguments: {
            file: 'src/cache1/index.ts',
            line: 88,
            summary: 'Der Fix ändert eine Datei außerhalb des Claim-Sets',
            detail: 'src/http/client.ts ist nicht beansprucht.',
          },
        }),
      );
      expect(payload.severity).toBe('blocker');

      const [row] = await sql`SELECT * FROM task_findings WHERE task_id = ${taskId}`;
      expect(row?.file).toMatch(/^src\/cache\d+\/index\.ts$/);
      expect(row?.line).toBe(88);
      expect(row?.severity).toBe('blocker');
      expect(row?.reported_by).toBe('reviewer');
      expect(row?.open).toBe(true);

      // And it is visible to the next session on the same task, which is how a
      // Coder learns what the Reviewer objected to.
      const context = payloadOf(await client.callTool({ name: 'task.get_context', arguments: {} }));
      expect((context.findings as unknown[]).length).toBe(1);
    } finally {
      await close();
    }
  });

  it('weist einen absoluten Pfad im Fund ab, bevor der Handler läuft', async () => {
    const taskId = await codingTask(await newProject());
    const { client, close } = await connect(taskId, 'reviewer');
    try {
      const result = await client.callTool({
        name: 'finding.report',
        arguments: { file: '/etc/passwd', summary: 'x' },
      });
      expect(result.isError).toBe(true);
      const rows = await sql<Array<{ count: string }>>`
        SELECT count(*) FROM task_events WHERE task_id = ${taskId} AND kind = 'finding_reported'
      `;
      expect(Number(rows[0]?.count)).toBe(0);
    } finally {
      await close();
    }
  });

  it('escalate.ask hält die Frage fest und weist die Sitzung an, den Zug zu beenden', async () => {
    const taskId = await codingTask(await newProject());
    const { client, close } = await connect(taskId, 'coder');
    try {
      const payload = payloadOf(
        await client.callTool({
          name: 'escalate.ask',
          arguments: {
            question: 'Soll die Migration die alte Spalte sofort entfernen?',
            context:
              'Die laufende Version liest sie noch. Ein Rollback stellt Code her, keine Daten.',
            urgency: 'P1',
            options: [
              {
                title: 'Spalte erst in einem späteren Task entfernen',
                pros: ['Rollback bleibt gefahrlos'],
                cons: ['Zwei Deploys statt einem'],
                recommended: true,
              },
              {
                title: 'Jetzt entfernen',
                pros: ['Eine Migration weniger'],
                cons: ['Ein Rollback bricht die laufende Version'],
              },
            ],
          },
        }),
      );
      expect(payload.recorded).toBe(true);
      expect(String(payload.next)).toMatch(/needs_decision/);

      const [row] = await sql`SELECT * FROM task_escalations WHERE task_id = ${taskId}`;
      expect(row?.urgency).toBe('P1');
      expect(row?.answered).toBe(false);
      expect((row?.options as unknown[] | undefined)?.length).toBe(2);

      // The task is *not* parked here. §7.3 stops work on an atomic boundary,
      // and the session that called this is still running; the runner parks it
      // when the result comes back as `needs_decision`.
      expect((await tasks.get(taskId))?.state).toBe('coding');
    } finally {
      await close();
    }
  });

  it('weist eine Eskalation ohne markierte Empfehlung ab (§15)', async () => {
    const taskId = await codingTask(await newProject());
    const { client, close } = await connect(taskId);
    try {
      const result = await client.callTool({
        name: 'escalate.ask',
        arguments: {
          question: 'Was tun?',
          context: 'Kontext.',
          options: [
            { title: 'A', pros: ['x'], cons: ['y'] },
            { title: 'B', pros: ['x'], cons: ['y'] },
          ],
        },
      });
      expect(result.isError).toBe(true);
      const rows = await sql<Array<{ count: string }>>`
        SELECT count(*) FROM task_events WHERE task_id = ${taskId} AND kind = 'escalation_requested'
      `;
      expect(Number(rows[0]?.count)).toBe(0);
    } finally {
      await close();
    }
  });

  it('kann die Aufgabe nicht durch den Lebenszyklus bewegen', async () => {
    // The property, stated as a test rather than as a comment: nothing on the
    // MCP surface writes a `state_changed` event. An agent that could would be
    // able to mark its own work reviewed.
    const taskId = await codingTask(await newProject());
    const before = await tasks.get(taskId);
    const { client, close } = await connect(taskId);
    try {
      await client.callTool({ name: 'task.append_note', arguments: { text: 'a' } });
      await client.callTool({
        name: 'finding.report',
        arguments: { file: 'src/cache/a.ts', summary: 'b' },
      });
      const kinds = await sql<Array<{ kind: string }>>`
        SELECT kind FROM task_events WHERE task_id = ${taskId} AND seq > ${before?.version ?? 0}
      `;
      expect(kinds.map((k: { kind: string }) => k.kind).sort()).toEqual([
        'finding_reported',
        'note',
      ]);
      expect((await tasks.get(taskId))?.state).toBe(before?.state);
    } finally {
      await close();
    }
  });

  /**
   * §22's Phase 6 gate: "upload → tag → agent retrieves it via MCP **ranked by
   * department tag**". What has to be proven here is therefore an *order*, and
   * one that arrives over the protocol rather than out of a service call.
   *
   * Two things make that order mean something.
   *
   *   1. **The two documents are equally relevant, and the case checks it.**
   *      Both texts carry the search term exactly once, so `rank` must come
   *      back identical; asserted before the order is, because an order between
   *      two documents is only about the boost when the texts are level. If
   *      Postgres ever ranks them apart this goes red where it stands instead
   *      of passing for a reason nobody looked at.
   *   2. **The untagged document is created second**, and the final tie-break
   *      is `seq DESC` — so with the boost gone, or with both documents tagged,
   *      the expected order inverts. Both mutations were run (see below), and
   *      the second of them is the one worth having: without it this case would
   *      pass on insertion order and prove nothing about ranking at all.
   *
   * The asking department is `Security` rather than §13's own example (`Recht`)
   * for a reason that is the point of the seam: the department is *derived from
   * the session's role*, so it can only be one that some profile actually has,
   * and A108 leaves Lena to a later block. The chain under test is real end to
   * end — `VORSCHICHT_ROLE=security` → the profile table → §8's label → the
   * ranking — and a hand-passed `Recht` would have skipped the half that can be
   * wrong.
   */
  describe('Der Tresor über MCP (§13, §22 Phase 6)', () => {
    /** One occurrence in each document, so the texts rank level. */
    const TERM = 'Zugangsdaten';
    let taggedId = '';
    let untaggedId = '';

    /**
     * Seeded here rather than inside the first case, and that was found by a
     * mutation rather than foreseen: with the upload in the ordering case, the
     * two cases below it depended on a variable that case had set, so running
     * any of them alone (`vitest -t`) failed with a Postgres error about an
     * empty uuid instead of the assertion it was supposed to make. A case that
     * only fails correctly when its neighbours ran first reports the wrong
     * defect on the day it matters.
     */
    beforeAll(async () => {
      const tagged = await vault.create({
        title: 'Sicherheitsrichtlinie',
        departmentTags: ['Security'],
        tags: ['richtlinie'],
        version: {
          filename: 'richtlinie.pdf',
          storagePath: 'vault/richtlinie.pdf',
          mimeType: 'application/pdf',
          extractedText: `${TERM} gehören in den Passwortspeicher und nirgends sonst hin.`,
        },
      });
      // Created *second*, so it wins every tie-break (`seq DESC`): without the
      // boost, or with both documents tagged, the expected order below inverts.
      const untagged = await vault.create({
        title: 'Sitzungsnotiz vom Dienstag',
        version: {
          filename: 'notiz.md',
          storagePath: 'vault/notiz.md',
          extractedText: `Über ${TERM} wurde am Rande kurz gesprochen.`,
        },
      });
      taggedId = tagged.document.id;
      untaggedId = untagged.document.id;
    });

    interface Hit {
      id: string;
      title: string;
      departmentTags: string[];
      version: number;
      rank: number;
      departmentMatch: boolean;
      score: number;
    }

    /** One session, one tool call, closed again — the role is the whole input. */
    async function callAs(role: string, name: string, args: Record<string, unknown>) {
      const taskId = await codingTask(await newProject());
      const { client, close } = await connect(taskId, role);
      try {
        return await client.callTool({ name, arguments: args });
      } finally {
        await close();
      }
    }

    async function searchAs(role: string, query = TERM) {
      const payload = payloadOf(await callAs(role, 'docs.search', { query }));
      return { payload, results: payload.results as Hit[] };
    }

    async function getAs(role: string, id: string) {
      return payloadOf(await callAs(role, 'docs.get', { id }));
    }

    it('liefert der fragenden Abteilung beide Treffer — den getaggten zuerst', async () => {
      const { payload, results } = await searchAs('security');

      // Derived from the role, not handed in: `VORSCHICHT_ROLE=security` is all
      // the session carries.
      expect(payload.department).toBe('Security');

      const ids = results.map((hit) => hit.id);
      expect(ids).toContain(taggedId);
      expect(ids).toContain(untaggedId);

      const first = results.find((hit) => hit.id === taggedId);
      const second = results.find((hit) => hit.id === untaggedId);
      // The checked premise (1).
      expect(first?.rank).toBe(second?.rank);
      expect(first?.departmentMatch).toBe(true);
      expect(second?.departmentMatch).toBe(false);
      expect(first?.score).toBeGreaterThan(second?.score ?? 0);
      expect(first?.departmentTags).toEqual(['Security']);

      // The gate's sentence.
      expect(ids.indexOf(taggedId)).toBeLessThan(ids.indexOf(untaggedId));

      // Nothing unread in the vault yet, so there is nothing to say — and the
      // absence is asserted here because a note that is always present cannot
      // be read as a warning.
      expect(payload.pendingDocuments).toBe(0);
      expect(payload.note).toBeUndefined();
    });

    it('sucht ohne ableitbare Abteilung genauso breit und sagt, dass nichts gewichtet wurde', async () => {
      const { payload, results } = await searchAs('rolle-ohne-profil');

      expect(payload.department).toBeNull();
      expect(results.map((hit) => hit.id).sort()).toEqual([taggedId, untaggedId].sort());
      expect(results.every((hit) => hit.departmentMatch === false)).toBe(true);
      expect(results.every((hit) => hit.score === hit.rank)).toBe(true);

      // And the order really does invert without the boost, which is what makes
      // the case above a statement about ranking rather than about insertion
      // order — the untagged document was created second and wins every tie.
      expect(results[0]?.id).toBe(untaggedId);

      expect(String(payload.note)).toContain('rolle-ohne-profil');
      // §13's boost is not a permission: the hits are complete either way, and
      // the note has to say so rather than reading as a refusal.
      expect(String(payload.note)).toMatch(/hits themselves are complete/i);
    });

    it('sagt, wie viel des Tresors noch gar nicht gelesen wurde', async () => {
      const ungelesen = await vault.create({
        title: 'Eingescannter Vertrag',
        departmentTags: ['Security'],
        version: {
          filename: 'scan.pdf',
          storagePath: 'vault/scan.pdf',
          extractedText: null,
        },
      });

      const { payload, results } = await searchAs('security');
      expect(payload.pendingDocuments).toBe(1);
      expect(results.map((hit) => hit.id)).not.toContain(ungelesen.document.id);
      // The difference between "not in the vault" and "not read yet". A session
      // that cannot tell them apart reports the wrong one of the two.
      expect(String(payload.note)).toMatch(/no extracted text yet/i);

      const detail = await getAs('security', ungelesen.document.id);
      expect(detail.text).toBeNull();
      expect((detail.versions as Array<{ textChars: number | null }>)[0]?.textChars).toBeNull();
      expect(String(detail.note)).toMatch(/has been read yet/i);
    });

    it('docs.get liefert Metadaten, Versionen und den Text der jüngsten gelesenen Fassung', async () => {
      // A fresh upload with no text layer on top of a version that was read.
      // Answering `null` here would repeat the confusion `pendingDocuments`
      // refuses one layer down, so the older readable version is delivered and
      // the response says which one it is.
      await vault.addVersion(taggedId, {
        filename: 'richtlinie-2.pdf',
        storagePath: 'vault/richtlinie-2.pdf',
        extractedText: null,
      });

      const payload = await getAs('security', taggedId);

      const document = payload.document as Record<string, unknown>;
      expect(document.title).toBe('Sicherheitsrichtlinie');
      expect(document.departmentTags).toEqual(['Security']);
      expect(document.tags).toEqual(['richtlinie']);

      const versions = payload.versions as Array<Record<string, unknown>>;
      expect(versions.map((version) => version.version)).toEqual([2, 1]);
      expect(versions[0]?.textChars).toBeNull();
      expect(versions[1]?.textChars).toBeGreaterThan(0);
      // Metadata only: every version's text at once is what the cap prevents.
      expect(versions[1]).not.toHaveProperty('extractedText');

      // Stated before it is read: a `null` here is the defect this case exists
      // for — a document whose readable version is right there, answered with
      // "nothing" because the newest upload happened to have no text layer.
      expect(payload.text).not.toBeNull();
      const text = payload.text as Record<string, unknown>;
      expect(text.version).toBe(1);
      expect(String(text.content)).toContain(TERM);
      expect(text.truncated).toBe(false);
      expect(text.omittedChars).toBe(0);
      expect(String(payload.note)).toMatch(/version 2.*no extracted text/i);
    });

    it('kappt einen langen Text und sagt es, statt ihn stillschweigend zu kürzen', async () => {
      const satz = 'Der Vorstand beschließt die Aufnahme neuer Mitglieder. ';
      const lang = satz.repeat(Math.ceil((MAX_DOCUMENT_TEXT_CHARS + 5_000) / satz.length));
      const { document } = await vault.create({
        title: 'Protokollsammlung',
        version: {
          filename: 'protokolle.txt',
          storagePath: 'vault/protokolle.txt',
          extractedText: lang,
        },
      });

      const payload = await getAs('security', document.id);
      const text = payload.text as Record<string, unknown>;
      expect(String(text.content)).toHaveLength(MAX_DOCUMENT_TEXT_CHARS);
      expect(text.truncated).toBe(true);
      expect(text.omittedChars).toBe(lang.length - MAX_DOCUMENT_TEXT_CHARS);
      // The half that matters: a session that does not know it read part of a
      // document cites that part as though it were the document.
      expect(String(payload.note)).toMatch(/truncated/i);
      expect(String(payload.note)).toContain(String(lang.length));
    });

    it('antwortet auf eine unbekannte Kennung mit null und einem Satz, nicht mit einem Fehler', async () => {
      const payload = await getAs('security', '00000000-0000-4000-8000-000000000000');
      expect(payload.document).toBeNull();
      expect(payload.text).toBeUndefined();
      expect(String(payload.note)).toMatch(/docs\.search/);
    });

    it('weist eine Kennung, die keine UUID ist, vor dem Handler ab', async () => {
      // Without this the string reaches Postgres and the model is handed
      // `invalid input syntax for type uuid` — a database error it cannot act
      // on. The schema answers instead, and says where an id comes from.
      const result = await callAs('security', 'docs.get', { id: 'statuten' });
      expect(result.isError).toBe(true);
      expect(String((result.content as Array<{ text: string }>)[0]?.text)).toMatch(
        /UUID.*docs\.search/i,
      );
    });
  });

  it('meldet eine verschwundene Aufgabe als Werkzeugfehler, nicht als Absturz', async () => {
    const { client, close } = await connect('00000000-0000-4000-8000-000000000000');
    try {
      const result = await client.callTool({ name: 'task.get_context', arguments: {} });
      expect(result.isError).toBe(true);
      expect(String((result.content as Array<{ text: string }>)[0]?.text)).toMatch(
        /existiert nicht/,
      );
    } finally {
      await close();
    }
  });
});
