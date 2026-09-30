/**
 * §20's onboarding flow, against a real repository and a real database.
 *
 * Three claims are made here that no unit test can make.
 *
 * **The dry run does not touch the project.** §20 asks for "analysis without any
 * writes" and A41 makes that a hard boundary for the pilot project. The unit tests assert
 * that no code path *creates a project*; this one records the target
 * repository's file list and `git status` before and after, and asserts they are
 * identical. That is the difference between a design intention and a fact about
 * a directory on disk.
 *
 * **The prompt reaches the session.** `prompt.test.ts` asserts that the builder
 * produces the absolute path; this file reads `spec.prompt` off the backend the
 * runner actually spawned. The two come apart the moment somebody adds a
 * parameter and forgets a call site — which is the wiring §8.2's sixth domain
 * hunts, and the same reason `merge-queue.itest.ts` reads the findings briefing
 * off the spawn rather than off the builder (A69).
 *
 * **This repository still declares the scripts its own onboarding names.**
 * `ensureSelfManagedProject` runs against the real checkout, so renaming
 * `gate:lint` in `package.json` fails this test rather than configuring the
 * self-managed project with a gate that reports an infrastructure failure
 * forever (A55.3).
 */
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type { OnboardingResult } from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeBackend, type FakeEvent, type FakeScript } from './../backend/fake.js';
import { EventLog } from './../event-log.js';
import { ProjectService } from './../project-service.js';
import { AgentRunner, type RunnerPaths } from './../runner.js';
import { OnboardingProposals } from './proposals.js';
import { ensureSelfManagedProject, SELF_ACTOR, selfOnboardingResult } from './self.js';
import { OnboardingError, OnboardingService } from './service.js';
import { surveyRepository } from './survey.js';
import { verifyProposal } from './verify.js';

const execFile = promisify(execFileCallback);
const url = process.env.TEST_DATABASE_URL;

/** The two hook events a contained session produces before it does anything. */
const HOOKS: FakeEvent[] = [
  {
    type: 'hook_event',
    event: 'SessionStart',
    hookName: 'SessionStart:*',
    phase: 'response',
    outcome: 'success',
    exitCode: 0,
  },
];

const MANIFEST = JSON.stringify(
  {
    name: 'sample',
    scripts: { test: 'node --test', lint: 'echo lint', build: 'echo build', tc: 'echo tc' },
  },
  null,
  2,
);

function goodProposal(overrides: Partial<OnboardingResult> = {}): OnboardingResult {
  return {
    status: 'done',
    summary: 'Kleines Node-Paket.',
    artifacts: [],
    followups: [],
    stack: 'Node',
    defaultBranch: 'main',
    gates: [
      { id: 'test', enabled: true, command: 'pnpm run test', rationale: 'Manifest sagt `test`.' },
      { id: 'lint', enabled: true, command: 'pnpm run lint', rationale: 'Manifest sagt `lint`.' },
      {
        id: 'build',
        enabled: true,
        command: 'pnpm run build',
        rationale: 'Manifest sagt `build`.',
      },
      { id: 'typecheck', enabled: true, command: 'pnpm run tc', rationale: 'Manifest sagt `tc`.' },
    ],
    claimGranularity: 'file',
    claimRationale: 'Eine Handvoll Dateien.',
    migrationPaths: [],
    tools: ['Bash(pnpm:*)'],
    deploy: { method: 'none', rationale: 'Bibliothek.' },
    personalData: { present: false, evidence: [] },
    departments: ['Entwicklung'],
    risks: [],
    ...overrides,
  };
}

describe.skipIf(!url)('Onboarding (§20)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let eventLog: EventLog;
  let projects: ProjectService;
  let scratch: string;
  let repo: string;
  let paths: RunnerPaths;

  const git = (...args: string[]) =>
    execFile('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'T',
        GIT_AUTHOR_EMAIL: 't@example.invalid',
        GIT_COMMITTER_NAME: 'T',
        GIT_COMMITTER_EMAIL: 't@example.invalid',
      },
    });

  beforeAll(async () => {
    database = await createTestDatabase('onboarding');
    sql = createSql({ url: database.url, max: 3 });
    eventLog = new EventLog(sql);
    projects = new ProjectService(sql);
    scratch = await mkdtemp(join(tmpdir(), 'vs-onboarding-'));
    await mkdir(join(scratch, 'session'), { recursive: true });
    paths = {
      roleSettingsDir: join(scratch, 'claude'),
      runsRoot: join(scratch, 'runs'),
      transcriptsRoot: join(scratch, 'transcripts'),
      mcpServerEntry: null,
    };

    repo = join(scratch, 'sample');
    await mkdir(join(repo, 'src'), { recursive: true });
    await mkdir(join(repo, 'db', 'migrations'), { recursive: true });
    await writeFile(join(repo, 'package.json'), MANIFEST);
    await writeFile(join(repo, 'src', 'index.js'), 'export const x = 1;\n');
    await writeFile(join(repo, 'db', 'migrations', '0001_init.sql'), 'CREATE TABLE t (id int);\n');
    await writeFile(join(repo, 'docs-datenschutz.md'), '# Datenschutz\n');
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
    // Ignored: it must not show up in the inventory, or every proposal would be
    // reasoning about somebody's dependency tree.
    await mkdir(join(repo, 'node_modules', 'left-pad'), { recursive: true });
    await writeFile(join(repo, 'node_modules', 'left-pad', 'index.js'), '//\n');
    await git('init', '--initial-branch=main');
    await git('add', '-A');
    await git('commit', '-m', 'feat: initial');
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
    await rm(scratch, { recursive: true, force: true });
  });

  function service(script: FakeScript): { onboarding: OnboardingService; backend: FakeBackend } {
    const backend = new FakeBackend(script);
    const onboarding = new OnboardingService({
      runner: new AgentRunner({ sql, eventLog, backend, paths }),
      eventLog,
      scratchDir: join(scratch, 'session'),
    });
    return { onboarding, backend };
  }

  const scriptFor = (raw: unknown): FakeScript => ({
    events: HOOKS,
    result: { raw, tokensIn: 10, tokensOut: 5 },
  });

  /** Everything about the target directory that a write would change. */
  async function fingerprint(): Promise<string> {
    const [files, status, head] = await Promise.all([
      execFile('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd: repo }),
      execFile('git', ['status', '--porcelain=v1', '--untracked-files=all'], { cwd: repo }),
      execFile('git', ['rev-parse', 'HEAD'], { cwd: repo }),
    ]);
    return [files.stdout, status.stdout, head.stdout].join('');
  }

  describe('Die Erhebung', () => {
    it('liest das Repository, ohne ignorierte Pfade mitzuzählen', async () => {
      const survey = await surveyRepository(repo);
      expect(survey.git.isRepository).toBe(true);
      expect(survey.git.commitCount).toBe(1);
      expect(survey.files).toContain('src/index.js');
      // `node_modules` is ignored, so it is neither in the list nor in the
      // extension histogram the proposal reasons about.
      expect(survey.files.some((file) => file.startsWith('node_modules/'))).toBe(false);
      expect(survey.inventory.migrationCandidates).toContain('db/migrations/0001_init.sql');
      expect(survey.inventory.personalDataHints).toContain('docs-datenschutz.md');
      expect(survey.manifests.find((file) => file.path === 'package.json')?.content).toContain(
        '"test"',
      );
    });

    it('sagt, woher der Integrationszweig stammt, statt ihn nur zu nennen', async () => {
      // No `origin/HEAD` in a freshly initialised repository, so the fallback is
      // the checked-out branch — and the *source* is what tells a reader that
      // this is where somebody stood rather than what the project integrates on.
      const survey = await surveyRepository(repo);
      expect(survey.git.defaultBranch).toBe('main');
      expect(survey.git.defaultBranchSource).toContain('rev-parse --abbrev-ref HEAD');
      expect(survey.git.defaultBranchSource).toContain('origin/HEAD ist nicht gesetzt');
    });

    it('liest die Manifeste eines echten Workspace, nicht nur das der Wurzel (A72)', async () => {
      // Against this repository, which is a real pnpm workspace. The unit tests
      // use a fixture; this is the assertion that the *collector* finds members
      // at all — the defect A72 records was a checker reading only the root, and
      // a fixture with a hand-written package list cannot catch that half.
      const survey = await surveyRepository(process.cwd());
      const dirs = survey.packages.map((entry) => entry.dir);
      expect(dirs).toContain('.');
      expect(dirs).toContain('packages/core');
      expect(dirs).toContain('apps/web');
      const core = survey.packages.find((entry) => entry.dir === 'packages/core');
      expect(core?.name).toBe('@vorschicht/core');
      expect(core?.scripts).toContain('build');
      // No vendored manifests: `git ls-files` excludes ignored paths, so a
      // dependency's `package.json` never reaches this list.
      expect(dirs.some((dir) => dir.includes('node_modules'))).toBe(false);
    });

    it('weigert sich, ein Verzeichnis zu erheben, das es nicht gibt', async () => {
      await expect(surveyRepository(join(scratch, 'gibt-es-nicht'))).rejects.toThrow(
        /kein Verzeichnis/,
      );
      await expect(surveyRepository('relativ/pfad')).rejects.toThrow(/nicht absolut/);
    });

    it('meldet ein Verzeichnis ohne git als Lücke, nicht als leeres Projekt', async () => {
      const plain = join(scratch, 'ohne-git');
      await mkdir(plain, { recursive: true });
      await writeFile(join(plain, 'README.md'), '# x\n');
      const survey = await surveyRepository(plain);
      expect(survey.git.isRepository).toBe(false);
      expect(survey.files).toEqual([]);
      expect(survey.gaps.join(' ')).toMatch(/kein git-Repository/);
    });
  });

  describe('Der Trockenlauf', () => {
    it('fasst das Projekt nicht an und legt nichts an', async () => {
      const before = await fingerprint();
      const projectsBefore = await projects.listActive();

      const { onboarding } = service(scriptFor(goodProposal()));
      const proposal = await onboarding.propose({
        rootPath: repo,
        slug: 'sample-dry',
        readOnly: true,
      });

      expect(proposal.status).toBe('proposed');
      // The load-bearing assertion of this file: §20's "analysis without any
      // writes", read off the directory rather than off the design.
      expect(await fingerprint()).toBe(before);
      expect(await projects.listActive()).toHaveLength(projectsBefore.length);
      expect(await projects.getBySlug('sample-dry')).toBeNull();
    });

    it('schickt den absoluten Pfad wirklich in die Sitzung', async () => {
      // Read off the spawn, not off the builder. A prompt builder called
      // correctly and a prompt that reaches a session are two different claims.
      const { onboarding, backend } = service(scriptFor(goodProposal()));
      await onboarding.propose({ rootPath: repo, slug: 'sample-prompt', readOnly: true });

      const spec = backend.spawns.at(-1);
      expect(spec?.prompt).toContain(repo);
      expect(spec?.prompt).toContain('You are not in it');
      // Scratch cwd, not the repository — a session inside it would load the
      // project's own conventions file as system context (A70).
      expect(spec?.cwd).toBe(join(scratch, 'session'));
      expect(spec?.cwd).not.toContain('sample');
      // Read-only by construction: no editing tool in the whitelist at all.
      expect(spec?.allowedTools).toEqual(['Read', 'Grep', 'Glob']);
      // And no MCP, because this run serves no task (A56.5).
      expect(spec?.mcpConfigPath).toBeNull();
    });

    it('hält das Ergebnis samt Prüfurteil im Ereignislog fest', async () => {
      const { onboarding } = service(scriptFor(goodProposal()));
      await onboarding.propose({ rootPath: repo, slug: 'sample-log', readOnly: true });

      const [row] = await sql<Array<{ payload: Record<string, unknown> }>>`
        SELECT payload FROM event_log
        WHERE kind = 'onboarding.proposed' AND payload ->> 'slug' = 'sample-log'
        ORDER BY id DESC LIMIT 1
      `;
      expect(row).toBeDefined();
      const payload = row?.payload ?? {};
      expect(payload.ok).toBe(true);
      expect(payload.defaultBranch).toBe('main');
      // Both halves: what was proposed *and* what the verification made of it.
      expect((payload.result as OnboardingResult).stack).toBe('Node');
      expect((payload.gateConfig as { commands: Record<string, string> }).commands.test).toBe(
        'pnpm run test',
      );
    });

    it('liefert bei einem kaputten Vertrag keinen Vorschlag, sondern eine Diagnose', async () => {
      // A repair attempt (§6.3) runs and also fails, so this ends `failed` —
      // and `failed` is the one outcome that means the work, not the harness.
      const { onboarding } = service(scriptFor({ status: 'done' }));
      const proposal = await onboarding.propose({
        rootPath: repo,
        slug: 'sample-broken',
        readOnly: true,
      });
      expect(proposal.status).toBe('failed');
      const [row] = await sql<Array<{ payload: Record<string, unknown> }>>`
        SELECT payload FROM event_log
        WHERE kind = 'onboarding.failed' AND payload ->> 'slug' = 'sample-broken'
      `;
      expect(row?.payload.status).toBe('failed');
    });

    it('nennt eine kaputte Sitzung Infrastruktur und nicht einen schlechten Vorschlag', async () => {
      const { onboarding } = service({ failOnSpawn: 'kein Prozess' });
      const proposal = await onboarding.propose({
        rootPath: repo,
        slug: 'sample-infra',
        readOnly: true,
      });
      expect(proposal.status).toBe('infra');
    });
  });

  describe('Die Übernahme', () => {
    it('legt das Projekt mit der geprüften Konfiguration an und schreibt, wer es war', async () => {
      const survey = await surveyRepository(repo);
      const verification = verifyProposal(survey, goodProposal());
      const { onboarding } = service(scriptFor(goodProposal()));

      const project = await onboarding.apply(
        projects,
        { slug: 'sample-live', name: 'Sample', rootPath: repo, readOnly: true, verification },
        'max',
      );

      expect(project.readOnly).toBe(true);
      expect(project.defaultBranch).toBe('main');
      expect(project.claimGranularity).toBe('file');
      expect((project.gateConfig as { commands: Record<string, string> }).commands.test).toBe(
        'pnpm run test',
      );
      expect((project.deployConfig as { method: string }).method).toBe('none');

      const audit = await sql<Array<{ actor: string }>>`
        SELECT actor FROM audit_log WHERE action = 'project.created' AND subject = 'sample-live'
      `;
      expect(audit[0]?.actor).toBe('max');
      const applied = await sql<Array<{ payload: Record<string, unknown> }>>`
        SELECT payload FROM event_log
        WHERE kind = 'onboarding.applied' AND payload ->> 'slug' = 'sample-live'
      `;
      expect(applied[0]?.payload.actor).toBe('max');
    });

    it('verweigert einen Vorschlag, den die Prüfung abgelehnt hat', async () => {
      const survey = await surveyRepository(repo);
      const verification = verifyProposal(
        survey,
        goodProposal({
          gates: [{ id: 'test', enabled: true, command: 'pnpm run tests', rationale: 'x' }],
        }),
      );
      const { onboarding } = service(scriptFor(goodProposal()));

      await expect(
        onboarding.apply(
          projects,
          { slug: 'sample-bad', name: 'X', rootPath: repo, readOnly: true, verification },
          'max',
        ),
      ).rejects.toThrow(OnboardingError);
      expect(await projects.getBySlug('sample-bad')).toBeNull();
    });

    it('übernimmt genau den Vorschlag, den der Betreiber gelesen hat — ohne zweite Sitzung', async () => {
      // §20s Entscheidung, und bis heute war sie Dekoration: `apply` nahm die
      // Prüfung nur als Objekt, also fuhr `onboard.mjs` beide Schritte in einem
      // Prozess. Wer den Vorschlag lesen lassen wollte, brauchte einen zweiten
      // Lauf — eine zweite **Modellsitzung**, die einen anderen Vorschlag
      // liefern darf als den, der gelesen wurde.
      const { onboarding } = service(scriptFor(goodProposal()));
      const proposal = await onboarding.propose({
        rootPath: repo,
        slug: 'sample-gelesen',
        readOnly: false,
        name: 'Gelesenes Projekt',
      });
      expect(proposal.status).toBe('proposed');
      if (proposal.status !== 'proposed') return;

      // Der Vorschlag steht im Ereignisprotokoll und wird von dort geholt —
      // kein Modell, keine Argumente ausser dem Lauf und dem Freigebenden.
      const proposals = new OnboardingProposals(sql);
      const project = await onboarding.applyFromRun(projects, proposals, proposal.runId, 'max');

      // Der Name kommt aus dem Vorschlag, nicht aus einer Wiederholung auf der
      // Kommandozeile: das ist die Zusicherung, dass beides dasselbe ist.
      expect(project.name).toBe('Gelesenes Projekt');
      expect(project.slug).toBe('sample-gelesen');
      expect(project.readOnly).toBe(false);
      expect(project.defaultBranch).toBe('main');
      expect((project.deployConfig as { method: string }).method).toBe('none');

      // Und die Spur zeigt auf **die** Sitzung, die den Vorschlag gemacht hat.
      const applied = await sql<Array<{ payload: Record<string, unknown> }>>`
        SELECT payload FROM event_log
        WHERE kind = 'onboarding.applied' AND payload ->> 'slug' = 'sample-gelesen'
      `;
      expect(applied[0]?.payload.runId).toBe(proposal.runId);
      expect(applied[0]?.payload.actor).toBe('max');
    });

    it('übernimmt auch ohne Runner — dieser Weg braucht keinen Modellzugang', async () => {
      const { onboarding } = service(scriptFor(goodProposal()));
      const proposal = await onboarding.propose({
        rootPath: repo,
        slug: 'sample-ohne-runner',
        readOnly: false,
        name: 'Ohne Runner',
      });
      if (proposal.status !== 'proposed') throw new Error('kein Vorschlag');

      // Ein zweiter Dienst, **ohne** Runner: das ist die Form, in der
      // `onboard.mjs --apply-lauf` läuft. Ein erforderlicher Modellzugang wäre
      // hier eine Voraussetzung, die dieser Weg nicht hat.
      const ohneRunner = new OnboardingService({ eventLog: new EventLog(sql) });
      const project = await ohneRunner.applyFromRun(
        projects,
        new OnboardingProposals(sql),
        proposal.runId,
        'max',
      );
      expect(project.slug).toBe('sample-ohne-runner');

      // Und die Gegenrichtung: ohne Runner ist ein Trockenlauf unmöglich, und
      // das sagt der Dienst, statt an einem null zu scheitern.
      await expect(
        ohneRunner.propose({ rootPath: repo, slug: 'x', readOnly: true }),
      ).rejects.toThrow(/Runner/);
    });

    it('verweigert einen Lauf, zu dem es keinen Vorschlag gibt', async () => {
      const { onboarding } = service(scriptFor(goodProposal()));
      const proposals = new OnboardingProposals(sql);

      // Fail closed: „wir konnten nichts finden" und „es ist übernehmbar" sind
      // derselbe Satz nur für ein System, das sich entschieden hat, nicht
      // hinzusehen (A83.6, A99.4).
      await expect(
        onboarding.applyFromRun(projects, proposals, randomUUID(), 'max'),
      ).rejects.toThrow(/keinen übernehmbaren Vorschlag/);
    });

    it('legt kein Projekt an, das niemand freigegeben hat', async () => {
      const survey = await surveyRepository(repo);
      const verification = verifyProposal(survey, goodProposal());
      const { onboarding } = service(scriptFor(goodProposal()));
      await expect(
        onboarding.apply(
          projects,
          { slug: 'sample-anon', name: 'X', rootPath: repo, readOnly: true, verification },
          '  ',
        ),
      ).rejects.toThrow(/Freigebenden/);
      expect(await projects.getBySlug('sample-anon')).toBeNull();
    });
  });

  describe('Vorschicht als eigenes Projekt (§12, A42)', () => {
    /** A fresh database per case: this function is about "is there already one". */
    async function isolated(): Promise<{
      db: TestDatabase;
      sql: postgres.Sql;
      projects: ProjectService;
      onboarding: OnboardingService;
    }> {
      const db = await createTestDatabase('self');
      const isolatedSql = createSql({ url: db.url, max: 2 });
      const log = new EventLog(isolatedSql);
      return {
        db,
        sql: isolatedSql,
        projects: new ProjectService(isolatedSql),
        onboarding: new OnboardingService({
          runner: new AgentRunner({
            sql: isolatedSql,
            eventLog: log,
            backend: new FakeBackend({}),
            paths,
          }),
          eventLog: log,
          scratchDir: join(scratch, 'session'),
        }),
      };
    }

    it('legt sich selbst genau einmal an und rührt sich beim zweiten Mal nicht', async () => {
      const env = await isolated();
      try {
        // Against the *real* checkout, deliberately: this is the assertion that
        // this repository still declares the scripts `self.ts` names. Renaming
        // `gate:lint` breaks this test instead of configuring a gate that
        // reports an infrastructure failure forever.
        const first = await ensureSelfManagedProject({
          onboarding: env.onboarding,
          projects: env.projects,
          rootPath: process.cwd(),
        });
        expect(first.status, JSON.stringify(first)).toBe('created');
        if (first.status !== 'created') return;
        expect(first.project.selfManaged).toBe(true);
        // the operator, 2026-08-02: read-only until the studio is built and audited, then
        // it works on a clone of itself. The flag is not decoration — A44.3
        // refuses every write on it, and since this change that includes the
        // Betriebsprüfung's un-tick, which now reaches der Betreiber as a P1 item instead.
        expect(first.project.readOnly).toBe(true);
        expect(
          (first.project.gateConfig as { commands: Record<string, string> }).commands.test,
        ).toBe('infra/scripts/with-test-db.sh pnpm exec vitest run');
        // §11's migration gate, because this repository has migrations.
        expect(
          (first.project.gateConfig as { gates: Record<string, boolean> }).gates,
        ).toMatchObject({ 'migration-review': true, changelog: true, docs: true });

        const second = await ensureSelfManagedProject({
          onboarding: env.onboarding,
          projects: env.projects,
          rootPath: process.cwd(),
        });
        expect(second.status).toBe('present');
        const count = await env.sql<Array<{ n: string }>>`SELECT count(*) AS n FROM projects`;
        expect(count[0]?.n).toBe('1');

        // And it refuses rather than quietly answering `present` for a different
        // checkout. The argument used to be ignored on every start after the
        // first, which is fine until the two paths differ — and then the
        // Betriebsprüfung un-ticks gates in a file nobody configured (§8.2).
        const elsewhere = await ensureSelfManagedProject({
          onboarding: env.onboarding,
          projects: env.projects,
          rootPath: repo,
        });
        expect(elsewhere.status).toBe('refused');
        if (elsewhere.status !== 'refused') return;
        expect(elsewhere.problem).toContain(repo);
        expect(elsewhere.problem).toContain(process.cwd());
      } finally {
        await env.sql.end();
        await env.db.drop();
      }
    });

    it('zieht A85s Entscheidung auf eine Zeile nach, die älter ist als sie', async () => {
      const env = await isolated();
      try {
        const first = await ensureSelfManagedProject({
          onboarding: env.onboarding,
          projects: env.projects,
          rootPath: process.cwd(),
        });
        expect(first.status).toBe('created');
        if (first.status !== 'created') return;

        // Der vorgefundene Zustand, roh hergestellt: eine Zeile, die vor A85
        // (2.8.2026) angelegt wurde, steht auf beschreibbar, und `setReadOnly`
        // ist nie gelaufen — es gibt also keine `project.read_only_changed`-
        // Zeile im Prüfprotokoll. Genau so sieht der lokale Entwicklungsstapel
        // heute aus. Roh, weil `setReadOnly` selbst die Spur schriebe, die
        // diesen Fall vom nächsten unterscheidet.
        await env.sql`UPDATE projects SET read_only = false WHERE id = ${first.project.id}`;

        const zweiter = await ensureSelfManagedProject({
          onboarding: env.onboarding,
          projects: env.projects,
          rootPath: process.cwd(),
        });
        expect(zweiter.status).toBe('present');
        if (zweiter.status !== 'present') return;

        // Nachgezogen — und zwar wirklich in der Datenbank, nicht nur im
        // zurückgegebenen Datensatz.
        expect(zweiter.project.readOnly).toBe(true);
        const rows = await env.sql<Array<{ read_only: boolean }>>`
          SELECT read_only FROM projects WHERE id = ${first.project.id}
        `;
        expect(rows[0]?.read_only).toBe(true);

        // §19: audit-protokolliert, mit dem Urheber, der es getan hat.
        const trail = await env.sql<Array<{ actor: string }>>`
          SELECT actor FROM audit_log WHERE action = 'project.read_only_changed'
        `;
        expect(trail).toHaveLength(1);
        expect(trail[0]?.actor).toBe(SELF_ACTOR);
      } finally {
        await env.sql.end();
        await env.db.drop();
      }
    });

    it('lässt die Kennzeichnung stehen, wenn der Betreiber sie selbst zurückgenommen hat', async () => {
      const env = await isolated();
      try {
        const first = await ensureSelfManagedProject({
          onboarding: env.onboarding,
          projects: env.projects,
          rootPath: process.cwd(),
        });
        expect(first.status).toBe('created');
        if (first.status !== 'created') return;

        // A85 nennt den Weg hinaus ausdrücklich: ein `setReadOnly`-Aufruf, und
        // der hinterlässt eine Zeile. Genau daran — und nur daran — sind „hat
        // nie jemand entschieden" und „der Betreiber hat entschieden" zu unterscheiden.
        await env.projects.setReadOnly(first.project.id, false, 'max');

        const zweiter = await ensureSelfManagedProject({
          onboarding: env.onboarding,
          projects: env.projects,
          rootPath: process.cwd(),
        });
        expect(zweiter.status).toBe('present');
        if (zweiter.status !== 'present') return;
        // Nicht überschrieben. Ein Wächter, der die Entscheidung des Besitzers
        // beim nächsten Neustart rückgängig macht, ist kein Wächter.
        expect(zweiter.project.readOnly).toBe(false);
        const rows = await env.sql<Array<{ read_only: boolean }>>`
          SELECT read_only FROM projects WHERE id = ${first.project.id}
        `;
        expect(rows[0]?.read_only).toBe(false);
      } finally {
        await env.sql.end();
        await env.db.drop();
      }
    });

    it('startet trotzdem, wenn die Kennzeichnung nicht nachgezogen werden konnte — und sagt es', async () => {
      const env = await isolated();
      try {
        const first = await ensureSelfManagedProject({
          onboarding: env.onboarding,
          projects: env.projects,
          rootPath: process.cwd(),
        });
        if (first.status !== 'created') return;
        await env.sql`UPDATE projects SET read_only = false WHERE id = ${first.project.id}`;

        const warnings: string[] = [];
        const kaputt = Object.create(env.projects) as typeof env.projects;
        kaputt.setReadOnly = async () => {
          throw new Error('Datenbank weg');
        };

        const zweiter = await ensureSelfManagedProject({
          onboarding: env.onboarding,
          projects: kaputt,
          rootPath: process.cwd(),
          onWarning: (message) => warnings.push(message),
        });
        // Der Start läuft weiter — ein Studio, das nicht bootet, weil es eine
        // Kennzeichnung nicht verschärfen konnte, ist schlimmer als eines, das
        // bootet und es sagt. Aber es sagt es.
        expect(zweiter.status).toBe('present');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('Betriebsprüfung');
      } finally {
        await env.sql.end();
        await env.db.drop();
      }
    });

    it('verweigert sich, wenn dieses Repository die genannten Skripte nicht mehr hat', async () => {
      const env = await isolated();
      try {
        // The fixture repository declares `test`/`lint`/`build`/`tc`, not the
        // `gate:*` scripts — so it stands in for a checkout in which somebody
        // renamed them.
        const outcome = await ensureSelfManagedProject({
          onboarding: env.onboarding,
          projects: env.projects,
          rootPath: repo,
        });
        expect(outcome.status).toBe('refused');
        if (outcome.status !== 'refused') return;
        expect(outcome.problem).toContain('gate:typecheck');
        expect(await env.projects.listActive()).toHaveLength(0);
      } finally {
        await env.sql.end();
        await env.db.drop();
      }
    });

    it('nennt die Prüflücke, die §11s Katalog offen lässt', async () => {
      // A71: four of this repository's own gate steps have no catalogue slot, so
      // the merge queue does not run them. Stated in `risks`, where it reaches
      // the report the operator reads, rather than left to be discovered.
      const survey = await surveyRepository(process.cwd());
      const risks = selfOnboardingResult(survey).risks.join(' ');
      expect(risks).toContain('cli-contract');
      expect(risks).toContain('A71');
      expect(SELF_ACTOR).toBe('system:self-onboarding');
    });

    it('behält den Integrationszweig aus dem Repository statt „main" zu raten', async () => {
      const survey = await surveyRepository(process.cwd());
      // Asked of git rather than read out of `.git/HEAD`. In a **linked
      // worktree** `.git` is a *file* holding a `gitdir:` pointer, so the path
      // form raised `ENOTDIR` and this case could not run at all there — which
      // is precisely where an agent's work happens (A44.1). Found by running the
      // suite inside one; the assertion is unchanged, only the way it obtains
      // the branch.
      // **Korrigiert am 16.8.2026.** Bis dahin verglich dieser Fall den
      // *Integrationszweig* mit dem *ausgecheckten* Zweig — zwei verschiedene
      // Dinge, und die Erhebung führt sie mit gutem Grund getrennt (A41 nennt
      // ein Projekt, dessen `origin/HEAD` `main` sagt und dessen Arbeit auf
      // `dev` passiert). Der Fall war damit nur grün, solange jemand zufällig
      // auf dem Standardzweig stand: grün aus dem falschen Grund. Gefunden beim
      // ersten Lauf auf einem Arbeitszweig, nicht von einem Test.
      //
      // Jetzt bekommt jedes Feld seine eigene Quelle, und die dritte Zusicherung
      // ist die, die den Namen dieses Falls einlöst: der Zweig wurde **gelesen**
      // und nicht geraten, und das steht in `defaultBranchSource`.
      const { stdout: ausgecheckt } = await execFile('git', ['symbolic-ref', '--short', 'HEAD'], {
        cwd: process.cwd(),
      });
      const { stdout: integration } = await execFile(
        'git',
        ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
        { cwd: process.cwd() },
      );
      expect(survey.git.defaultBranch).toBe(integration.trim().replace(/^origin\//, ''));
      expect(survey.git.checkedOutBranch).toBe(ausgecheckt.trim());
      expect(survey.git.defaultBranchSource).toContain('refs/remotes/origin/HEAD');
      expect(selfOnboardingResult(survey).defaultBranch).toBe(survey.git.defaultBranch);
    });
  });
});
