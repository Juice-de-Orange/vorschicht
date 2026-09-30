/**
 * §11's migration gate against the **real** CLI. Costs subscription budget.
 *
 * `merge-queue.itest.ts` proves everything mechanical about this gate for free:
 * that a candidate touching no migration spawns nothing, that a requested change
 * blocks the merge, that a non-backward-compatible migration merges and leaves
 * the row §12/A24 will read. All of it with Milo's judgement scripted, because
 * that half is an *input* to the queue and a gate suite that only goes red when
 * a model happens to cooperate is not one anybody can regression-test.
 *
 * What none of that can settle is the question the gate exists to ask: does a
 * real `db-review` session, running the real prompt at its configured tier,
 * actually notice that a migration breaks the release currently running? A
 * scripted reviewer answering `backwardCompatible: false` proves that a fixture
 * returned the string it was handed.
 *
 * Two sessions, deliberately, and that is the whole design of this file. One
 * would be cheaper and would prove nothing: a reviewer that answered "not
 * backward-compatible" to everything — out of caution, or because the prompt
 * leads it — would pass a one-sided check and would then block every schema
 * change this studio ever makes. So the assertion is that the two answers
 * *differ*, over two diffs that differ in exactly the property under test:
 *
 *   1. `DROP COLUMN salutation`, while `src/db.js` on the integration branch
 *      still selects it. The old code runs against the new schema during a
 *      deploy (§12: migrate → swap → health), so this cannot be compatible.
 *   2. `ADD COLUMN mood text` with its reverse migration written down. Nothing
 *      reads it, nothing breaks, and §23's reversibility question is answered.
 *
 * Nothing about the *consequences* is asserted here — `judgeMigrationReview` is
 * pure and tested without a model. What is asserted is the observation it
 * consumes.
 *
 * Skipped unless `VORSCHICHT_REAL_BACKEND=1`; run it with
 * `pnpm check:migration-review`.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HeadlessBackend } from './backend/headless.js';
import { EventLog } from './event-log.js';
import { judgeMigrationReview } from './gate-suite.js';
import { BOT_IDENTITY } from './git.js';
import { AgentMigrationReviewer, type MigrationReviewReport } from './migration-review.js';
import { ProjectService } from './project-service.js';
import { writeRoleSettings } from './role-settings.js';
import { AgentRunner } from './runner.js';
import { createSandboxProject, type SandboxProject } from './sandbox.js';
import { TaskService } from './task-service.js';

const execFile = promisify(execFileCallback);
const enabled = process.env.VORSCHICHT_REAL_BACKEND === '1' && !!process.env.TEST_DATABASE_URL;
const HOOK_ENTRY = join(process.cwd(), 'packages/core/dist/hook-entry.js');

/** The schema the *running release* was built against. */
const INIT_SQL = `CREATE TABLE greetings (
  id serial PRIMARY KEY,
  name text NOT NULL,
  salutation text NOT NULL DEFAULT 'Hallo'
);
`;

/** The code that is still deployed while the migration runs (§12's order). */
const READER = `import { query } from './client.js';

/** Reads the row the greeting is rendered from. */
export async function loadGreeting(id) {
  const [row] = await query('SELECT id, name, salutation FROM greetings WHERE id = $1', [id]);
  return row;
}
`;

describe.skipIf(!enabled)('Die Migrationsprüfung erkennt, was die laufende Version bricht', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let scratch: string;
  let sandbox: SandboxProject;
  let tasks: TaskService;
  let projects: ProjectService;
  let eventLog: EventLog;
  let projectId: string;
  let reviewer: AgentMigrationReviewer;

  const git = (...args: string[]) =>
    execFile(
      'git',
      [
        '-c',
        `user.name=${BOT_IDENTITY.name}`,
        '-c',
        `user.email=${BOT_IDENTITY.email}`,
        '-c',
        'commit.gpgsign=false',
        ...args,
      ],
      { cwd: sandbox.path },
    );

  beforeAll(async () => {
    database = await createTestDatabase('migration_review');
    sql = createSql({ url: database.url, max: 2 });
    eventLog = new EventLog(sql);
    tasks = new TaskService({ sql, eventLog });
    projects = new ProjectService(sql);
    scratch = await mkdtemp(join(tmpdir(), 'vs-milo-'));
    await writeRoleSettings(join(scratch, 'claude'), { hookEntry: HOOK_ENTRY });

    sandbox = await createSandboxProject({ path: join(scratch, 'sandkasten') });
    projectId = (
      await projects.create({
        slug: 'migration-review',
        name: 'Sandkasten',
        rootPath: sandbox.path,
        defaultBranch: sandbox.defaultBranch,
      })
    ).id;

    // The integration branch: the schema as it is, and the code that reads it.
    // Both on `main`, because "backward-compatible" is a question about what is
    // *already deployed* — a reviewer that only sees the candidate has no way to
    // answer it and would be right to say so.
    await mkdir(join(sandbox.path, 'migrations'), { recursive: true });
    await writeFile(join(sandbox.path, 'migrations', '0001_init.sql'), INIT_SQL, 'utf8');
    await writeFile(join(sandbox.path, 'src', 'db.js'), READER, 'utf8');
    await git('add', '--all');
    await git('commit', '--quiet', '--message', 'feat: Begrüßungstabelle');

    reviewer = new AgentMigrationReviewer({
      runner: new AgentRunner({
        sql,
        eventLog,
        backend: new HeadlessBackend(),
        paths: {
          roleSettingsDir: join(scratch, 'claude'),
          runsRoot: join(scratch, 'runs'),
          transcriptsRoot: join(scratch, 'transcripts'),
          mcpServerEntry: null,
        },
      }),
      eventLog,
    });
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
    await rm(scratch, { recursive: true, force: true });
  });

  /** One candidate branch carrying one migration, reviewed by a real session. */
  async function reviewCandidate(
    branch: string,
    file: string,
    body: string,
  ): Promise<MigrationReviewReport> {
    await git('checkout', '--quiet', sandbox.defaultBranch);
    await git('checkout', '--quiet', '-B', branch);
    await writeFile(join(sandbox.path, 'migrations', file), body, 'utf8');
    await git('add', '--all');
    await git('commit', '--quiet', '--message', `feat: ${file}`);

    const task = await tasks.create({
      projectId,
      title: `Migration ${file}`,
      description: 'Eine Schemaänderung, die vor dem Merge geprüft wird.',
      acceptanceCriteria: ['Die Migration ist geprüft'],
    });

    return reviewer.review({
      cwd: sandbox.path,
      taskId: task.id,
      projectId,
      baseRef: sandbox.defaultBranch,
      migrations: [`migrations/${file}`],
      changedFiles: [`migrations/${file}`],
      readOnlyProject: false,
    });
  }

  let breaking: MigrationReviewReport;
  let additive: MigrationReviewReport;

  it(
    'hält ein DROP COLUMN für nicht rückwärtskompatibel, das die laufende Version noch liest',
    async () => {
      breaking = await reviewCandidate(
        'kandidat-drop',
        '0002_drop_salutation.sql',
        'ALTER TABLE greetings DROP COLUMN salutation;\n',
      );
      expect(breaking.status, JSON.stringify(breaking)).toBe('reviewed');
      if (breaking.status !== 'reviewed') return;
      // The one mechanical fact §12/A24 turns on. Everything else in the result
      // is a judgement and is deliberately not asserted.
      expect(breaking.result.backwardCompatible).toBe(false);
      expect(breaking.result.migrations.join(' ')).toContain('0002_drop_salutation.sql');
    },
    25 * 60_000,
  );

  it(
    'hält eine additive Spalte mit Gegenmigration für rückwärtskompatibel',
    async () => {
      additive = await reviewCandidate(
        'kandidat-add',
        '0003_add_mood.sql',
        'ALTER TABLE greetings ADD COLUMN mood text;\n' +
          '-- down: ALTER TABLE greetings DROP COLUMN mood;\n',
      );
      expect(additive.status, JSON.stringify(additive)).toBe('reviewed');
      if (additive.status !== 'reviewed') return;
      expect(additive.result.backwardCompatible).toBe(true);
      // §23 is answered in the file itself, so the honest answer is not
      // `undocumented` — which is the one value that would block this merge.
      expect(additive.result.reversibility).not.toBe('undocumented');
      expect(judgeMigrationReview(additive.result).verdict).toBe('green');
    },
    25 * 60_000,
  );

  /**
   * The assertion the two sessions exist for.
   *
   * A reviewer that answered "not backward-compatible" to everything would pass
   * the first case, fail nothing visible, and then block every schema change
   * this studio ever makes. Only the comparison distinguishes a working gate
   * from a stuck one — the same reason §8.2 measures its auditor on
   * confirmed-versus-dismissed rather than on findings produced.
   */
  it('unterscheidet die beiden Fälle, statt immer dasselbe zu antworten', () => {
    expect(breaking?.status).toBe('reviewed');
    expect(additive?.status).toBe('reviewed');
    if (breaking?.status !== 'reviewed' || additive?.status !== 'reviewed') return;
    expect(breaking.result.backwardCompatible).not.toBe(additive.result.backwardCompatible);
  });

  it('protokolliert jedes Urteil dort, wo die Deploy-Engine es findet (§12/A24)', async () => {
    const rows = await sql<Array<{ payload: { backwardCompatible: boolean } }>>`
      SELECT payload FROM event_log WHERE kind = 'gate.migration_review' ORDER BY id
    `;
    expect(rows.map((row) => row.payload.backwardCompatible)).toEqual([false, true]);
  });
});
