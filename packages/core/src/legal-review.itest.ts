/**
 * §11's legal gate, from the candidate to the verdict — everything but the model.
 *
 * The split is deliberate and it is the same one `migration-review` draws. What
 * is *pure* is in `legal-review.test.ts`: §14's threshold as a function of four
 * resolved citations. What needs a **real model** is in
 * `legal-review.real.itest.ts` and costs subscription budget. What is here is
 * the part in between, and it is the part a fixture would silently get wrong:
 *
 *   - the citation ids the session produced are resolved against a **real**
 *     `SourceRegistry` over a real Postgres, not against a map somebody wrote.
 *     `checkCitation` reads a state that migration 0021 *derives* from a log,
 *     so "accepted" and "proposed" are facts about rows here rather than
 *     strings in a stub — and a registry that stopped deriving them would go
 *     red in this file rather than in production;
 *   - the gate runs inside a **real** `GateSuite` over a **real** git
 *     repository, so "which gate went red" is the suite's own answer;
 *   - and A66.2's assertion is available at last for the tenth optional gate:
 *     red on its seed **and on no other gate**, green again on the same tree
 *     once the citation is fixed. Until Lena existed, `legal` was the one entry
 *     in §11's catalogue that could not be demonstrated that way, and the
 *     inverse demonstration (it cannot be ticked at all) stopped holding the
 *     moment `availableFrom` went to null.
 *
 * The model is doubled, and only the model. That is the line A63.6 draws for
 * the migration gate: a gate suite that only goes red when a model happens to
 * cooperate is not one anybody can regression-test.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type { LegalResult, ProjectGateConfig, RoleName, RoleResult } from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GateSuite, type GateSuiteResult, type SecretScanner } from './gate-suite.js';
import { AgentLegalReviewer } from './legal-review.js';
import type { AgentRunner, AgentRunOutcome, AgentRunRequest, RunSummary } from './runner.js';
import { SourceRegistry } from './sources/registry.js';

const execFile = promisify(execFileCallback);
const enabled = !!process.env.TEST_DATABASE_URL;

/** §11's four command gates, pointed at a script that exits 0 (see `beforeAll`). */
const GREEN_COMMANDS: ProjectGateConfig['commands'] = {
  typecheck: 'node ok.mjs',
  lint: 'node ok.mjs',
  test: 'node ok.mjs',
  build: 'node ok.mjs',
};

const greenScanner: SecretScanner = {
  scan: async () => ({ verdict: 'green', detail: 'Keine Fundstellen.', output: '', findings: [] }),
};

/**
 * The narrow slice of `postgres.Sql` the review gate touches.
 *
 * The same seam `gate-suite.test.ts` uses, and for the same reason: the peer
 * review gate is exercised against a real database elsewhere, and building a
 * task through §9's whole lifecycle here would make this file a test of the
 * task service.
 */
function reviewedTask(): never {
  return (async () => [{ actor: 'reviewer', payload: {} }]) as never;
}

describe.skipIf(!enabled)('§11s legal-Gate — Zitationen gegen ein echtes Register', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let scratch: string;
  let repo: string;
  let sources: SourceRegistry;

  /** The three registry states a citation can name. */
  let ris = '';
  let blog = '';
  let vorgeschlagen = '';

  const git = (...args: string[]) =>
    execFile('git', args, {
      cwd: repo,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    });

  async function candidate(files: Record<string, string>): Promise<void> {
    await git('checkout', '--quiet', 'main');
    await git('checkout', '--quiet', '-B', 'kandidat');
    for (const [name, content] of Object.entries(files)) {
      await mkdir(dirname(join(repo, name)), { recursive: true });
      await writeFile(join(repo, name), content, 'utf8');
    }
    await git('add', '--all');
    await git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'feat: Anmeldung');
  }

  beforeAll(async () => {
    database = await createTestDatabase('legal_review');
    sql = createSql({ url: database.url, max: 2 });
    sources = new SourceRegistry(sql);
    scratch = await mkdtemp(join(tmpdir(), 'vs-lena-'));
    repo = await mkdtemp(join(tmpdir(), 'vs-legal-repo-'));

    await writeFile(join(repo, 'README.md'), '# Verein\n');
    // §11's locked six run in every suite, so four of them need a command that
    // passes — otherwise every case below is red for a reason that has nothing
    // to do with a citation, and A66.2's "and on no other gate" would be
    // unassertable. Argv, never a shell line: `parseGateCommand` refuses one.
    await writeFile(join(repo, 'ok.mjs'), 'console.log("grün");\n');
    await git('init', '--initial-branch=main', '--quiet');
    await git('add', '--all');
    await git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'chore: Grundstein');

    // The registry as §14 describes it: a department proposes, the operator grants a
    // level. Both acts go through the real service, so the states below are
    // derived from a log rather than asserted into a column.
    ris = (
      await sources.propose(
        {
          title: 'Vereinsgesetz 2002 (RIS, geltende Fassung)',
          url: 'https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=20001917',
          level: 5,
          assessment: 'Primärquelle: der Gesetzestext beim Rechtsinformationssystem des Bundes.',
        },
        'research',
      )
    ).id;
    await sources.accept(ris, { level: 5 }, 'max');

    blog = (
      await sources.propose(
        {
          title: 'Vereinsblog: Statuten in fünf Minuten',
          url: 'https://example.org/blog',
          level: 2,
        },
        'research',
      )
    ).id;
    await sources.accept(blog, { level: 2 }, 'max');

    // Proposed and never decided — §14's third answer, and the one a stub would
    // most likely get wrong, since nothing about the row says "not citable"
    // except the absence of an acceptance.
    vorgeschlagen = (
      await sources.propose(
        {
          title: 'Kommentar zum VerG (Verlagsseite)',
          url: 'https://example.org/kommentar',
          level: 4,
        },
        'research',
      )
    ).id;
  }, 120_000);

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
    await rm(scratch, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  });

  function legalResult(partial: Partial<LegalResult> = {}): LegalResult {
    return {
      status: 'done',
      summary: 'Die Anmeldung erhebt Namen und E-Mail-Adresse; die Rechtsgrundlage ist benannt.',
      artifacts: [],
      followups: [],
      verdict: 'approve',
      citations: [],
      documents: [],
      findings: [],
      ...partial,
    };
  }

  /**
   * A runner that returns one prepared outcome and records what it was asked.
   *
   * The cast is at the seam and nowhere else: `AgentRunner.run` is generic over
   * the role, and this double always serves `legal`. Recording the request is
   * what makes "was a session started at all" an assertion rather than an
   * assumption — the negative case below depends on it.
   */
  function runnerReturning(outcome: AgentRunOutcome<LegalResult>) {
    const calls: AgentRunRequest[] = [];
    const runner: Pick<AgentRunner, 'run'> = {
      run: (async <R extends RoleName>(request: AgentRunRequest<R>) => {
        calls.push(request as AgentRunRequest);
        return outcome as unknown as AgentRunOutcome<RoleResult<R>>;
      }) as AgentRunner['run'],
    };
    return { calls, runner };
  }

  function ok(result: LegalResult): AgentRunOutcome<LegalResult> {
    return { status: 'ok', run: { runId: 'lauf-1' } as RunSummary, result };
  }

  /**
   * The suite the merge queue would build, with `legal` ticked beside gates
   * that are green — which is what makes A66.2's "and on no other gate"
   * assertion mean something.
   */
  async function runSuite(options: {
    runner?: Pick<AgentRunner, 'run'>;
    config?: Partial<ProjectGateConfig>;
  }): Promise<GateSuiteResult> {
    const suite = new GateSuite({
      sql: reviewedTask(),
      config: {
        gates: { legal: true, changelog: true, docs: true },
        commands: GREEN_COMMANDS,
        tools: [],
        migrationPaths: [],
        ...options.config,
      },
      secrets: greenScanner,
      sleep: async () => undefined,
      ...(options.runner
        ? {
            legalReview: new AgentLegalReviewer({
              runner: options.runner,
              sources,
              scratchDir: scratch,
            }),
          }
        : {}),
    });
    return suite.run({ cwd: repo, taskId: 'aufgabe-1', baseRef: 'main', projectId: null });
  }

  const legalStep = (result: GateSuiteResult) => result.steps.find((step) => step.id === 'legal');
  const redIds = (result: GateSuiteResult) => result.findings.map((step) => step.id).sort();

  /** A candidate that satisfies the two mechanical gates, so only `legal` can be red. */
  async function cleanCandidate(): Promise<void> {
    await candidate({
      'src/anmeldung.ts': 'export const felder = ["name", "email"];\n',
      'CHANGELOG.md': '## Unveröffentlicht\n- Anmeldeformular\n',
      'docs/datenschutz.md': '# Datenschutz\n\nName und E-Mail-Adresse.\n',
    });
  }

  it('lässt eine Prüfung durch, die auf der RIS-Fundstelle ruht — und färbt kein anderes Gate', async () => {
    await cleanCandidate();
    const { runner, calls } = runnerReturning(
      ok(
        legalResult({
          citations: [
            {
              sourceId: ris,
              claimedLevel: 5,
              statement: 'Für die Mitgliederliste gilt das Vereinsgesetz 2002.',
              locator: '§ 21',
            },
          ],
        }),
      ),
    );
    const result = await runSuite({ runner });
    expect(legalStep(result)?.verdict).toBe('green');
    expect(redIds(result)).toEqual([]);
    expect(result.ok).toBe(true);
    // The prompt really carried the citable ids — the session had no other way
    // to learn one, because there is no MCP surface on the registry.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.prompt).toContain(ris);
    expect(calls[0]?.profile.id).toBe('legal');
    // §6.2/A70.1: it reads the candidate, it does not sit in it.
    expect(calls[0]?.cwd).toBe(scratch);
    expect(calls[0]?.prompt).toContain(repo);
  });

  /**
   * A66.2's assertion, for the tenth gate. Red on its seed **and on no other**:
   * six gates share one code path and three are enabled here, so what has to
   * fire is this check rather than the loop around it.
   */
  it('blockiert eine Prüfung, die nur auf einer L2-Quelle ruht — und nur dieses Gate', async () => {
    await cleanCandidate();
    const { runner } = runnerReturning(
      ok(
        legalResult({
          citations: [{ sourceId: blog, claimedLevel: 2, statement: 'Ein Blog schreibt es so.' }],
        }),
      ),
    );
    const result = await runSuite({ runner });
    expect(legalStep(result)?.verdict).toBe('finding');
    expect(legalStep(result)?.detail).toContain('unter L4');
    expect(legalStep(result)?.detail).toContain('§14');
    expect(redIds(result)).toEqual(['legal']);
  });

  it('wird auf demselben Baum wieder grün, sobald die starke Quelle dazukommt', async () => {
    // The second half of the gate sentence §11 asks of every optional gate:
    // "and passes after fix". Same tree, same suite — only the citation is
    // repaired, so nothing else can be what turned it green.
    const { runner } = runnerReturning(
      ok(
        legalResult({
          citations: [
            { sourceId: blog, claimedLevel: 2, statement: 'Ein Blog schreibt es so.' },
            { sourceId: ris, claimedLevel: 5, statement: 'VerG 2002 § 21.', locator: '§ 21' },
          ],
        }),
      ),
    );
    const result = await runSuite({ runner });
    expect(legalStep(result)?.verdict).toBe('green');
    // §14's corroboration pass: the weak source is not forbidden, it is not
    // load-bearing.
    expect(legalStep(result)?.detail).toContain('Bestätigungsdurchgang');
    expect(redIds(result)).toEqual([]);
  });

  it('blockiert eine erfundene Quellenkennung, unterscheidbar von der zu schwachen', async () => {
    await cleanCandidate();
    // A well-formed uuid that no row carries — which is what a hallucinated id
    // looks like, and the reason the contract asks for a uuid at all: anything
    // else would arrive at `resolve` as a Postgres syntax error rather than as
    // an answer (A110.4).
    const erfunden = '00000000-0000-4000-8000-000000000999';
    const { runner } = runnerReturning(
      ok(
        legalResult({
          citations: [
            { sourceId: ris, claimedLevel: 5, statement: 'VerG 2002 § 21.' },
            { sourceId: erfunden, claimedLevel: 5, statement: 'Ein Erlass, den es nicht gibt.' },
          ],
        }),
      ),
    );
    const result = await runSuite({ runner });
    expect(legalStep(result)?.verdict).toBe('finding');
    expect(legalStep(result)?.detail).toContain('erfundene Fundstelle');
    expect(legalStep(result)?.detail).toContain(erfunden);
    // The distinction the three answers exist for: an L5 citation stands beside
    // it and the review is still red, where a weak one beside it was green.
    expect(legalStep(result)?.detail).not.toContain('gar keine Quelle');
    expect(redIds(result)).toEqual(['legal']);
  });

  it('trägt eine vorgeschlagene, nicht aufgenommene Quelle nicht', async () => {
    await cleanCandidate();
    // The state that only a real registry can produce: proposed at L4 and never
    // accepted. Its `proposedLevel` is high enough and it still does not carry,
    // because §14 makes acceptance the condition of citability.
    const { runner } = runnerReturning(
      ok(
        legalResult({
          citations: [
            { sourceId: vorgeschlagen, claimedLevel: 4, statement: 'Ein Kommentar meint dies.' },
          ],
        }),
      ),
    );
    const result = await runSuite({ runner });
    expect(legalStep(result)?.verdict).toBe('finding');
    expect(legalStep(result)?.detail).not.toContain('erfundene Fundstelle');
    expect(legalStep(result)?.output).toContain('vorgeschlagen');
  });

  it('schreibt Zitationen und beide Stufen in die Spur (§22s Gate-Satz)', async () => {
    await cleanCandidate();
    const { runner } = runnerReturning(
      ok(
        legalResult({
          documents: ['00000000-0000-4000-8000-000000000070'],
          citations: [
            { sourceId: ris, claimedLevel: 5, statement: 'VerG 2002 § 21.', locator: '§ 21 Abs 1' },
          ],
        }),
      ),
    );
    const step = legalStep(await runSuite({ runner }));
    expect(step?.output).toContain(ris);
    expect(step?.output).toContain('behauptet L5, Register: L5');
    expect(step?.output).toContain('§ 21 Abs 1');
    expect(step?.output).toContain('00000000-0000-4000-8000-000000000070');
  });

  /**
   * A63.5, for this gate: a suite built without model access has examined
   * nothing, and §11's answer for "not examined" is not green. A25 turns this
   * into a retry rather than into a red task.
   */
  it('meldet eine Suite ohne Rechtsprüfung als Infrastrukturfehler, niemals als grün', async () => {
    await cleanCandidate();
    const result = await runSuite({});
    expect(legalStep(result)?.verdict).toBe('infra');
    expect(result.findings).toHaveLength(0);
    expect(result.ok).toBe(false);
  });

  it('meldet eine Sitzung, die nicht laufen konnte, als Infrastrukturfehler', async () => {
    await cleanCandidate();
    const { runner } = runnerReturning({
      status: 'infra',
      run: { runId: 'lauf-2' } as RunSummary,
      problem: 'CLI nicht erreichbar',
    });
    const result = await runSuite({ runner });
    expect(legalStep(result)?.verdict).toBe('infra');
    expect(legalStep(result)?.detail).toContain('CLI nicht erreichbar');
  });

  it('meldet eine Sitzung ohne verwertbares Urteil als Befund', async () => {
    await cleanCandidate();
    const { runner } = runnerReturning({
      status: 'failed',
      run: { runId: 'lauf-3' } as RunSummary,
      problem: 'Zuglimit erreicht',
    });
    const result = await runSuite({ runner });
    // Not infra: the session ran and delivered nothing usable, and §11's answer
    // for "not established" is never green either.
    expect(legalStep(result)?.verdict).toBe('finding');
    expect(legalStep(result)?.detail).toContain('Zuglimit');
  });

  /**
   * Fail closed on the reading that the whole gate rests on (A83.6, A87.6,
   * A99.4). Without the registry there is nothing to compare a citation with,
   * and "we could not find out" and "it is fine" are the same sentence only to
   * a system that has decided not to notice.
   */
  it('meldet ein unlesbares Quellenregister als Infrastrukturfehler und startet keine Sitzung', async () => {
    await cleanCandidate();
    const { runner, calls } = runnerReturning(ok(legalResult()));
    const suite = new GateSuite({
      sql: reviewedTask(),
      config: {
        gates: { legal: true },
        commands: GREEN_COMMANDS,
        tools: [],
        migrationPaths: [],
      },
      secrets: greenScanner,
      sleep: async () => undefined,
      legalReview: new AgentLegalReviewer({
        runner,
        sources: {
          list: async () => {
            throw new Error('Verbindung weg');
          },
          resolve: sources.resolve.bind(sources),
        },
        scratchDir: scratch,
      }),
    });
    const result = await suite.run({ cwd: repo, taskId: 'aufgabe-1', baseRef: 'main' });
    expect(legalStep(result)?.verdict).toBe('infra');
    expect(legalStep(result)?.detail).toContain('Quellenregister');
    // And no budget was spent finding that out.
    expect(calls).toHaveLength(0);
  });

  it('startet keine Sitzung für einen Kandidaten, der nichts ändert', async () => {
    await git('checkout', '--quiet', 'main');
    await git('checkout', '--quiet', '-B', 'leer');
    const { runner, calls } = runnerReturning(ok(legalResult()));
    const result = await runSuite({ runner });
    expect(legalStep(result)?.verdict).toBe('green');
    expect(calls).toHaveLength(0);
  });
});
