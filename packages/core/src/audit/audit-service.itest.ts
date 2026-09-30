/**
 * The Betriebsprüfung end to end (§8.2, A52) — Phase 2 step 9.
 *
 * Real Postgres, real `audit_events` and `audit_finding_events`, a real copy of
 * `CLAUDE.md` that really gets edited, real tasks created through `TaskService`.
 * Only the model is scripted (A37) — the property under test is what the
 * *studio* does with a verdict, and an audit that only worked when a real model
 * happened to cooperate could not be regression-tested at all.
 *
 * Three of these tests are the ones worth having:
 *
 *  - a `gate_invalid` genuinely opens a gate in a file on disk, and the phase
 *    reopens. Everything else in §8.2 is advisory if this does not happen.
 *  - a `gate_invalid` naming a gate that does not exist changes **nothing**.
 *    The finding survives; the file does not move.
 *  - a finding dismissed twice stops going round and becomes the operator's decision,
 *    counted from the event log rather than remembered by a process.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type { AuditorResult, SessionSpec } from '@vorschicht/shared';
import { auditFindingClassSchema } from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FakeBackend, type FakeEvent, type FakeScript } from '../backend/fake.js';
import { EscalationService } from '../escalation-service.js';
import { EventLog } from '../event-log.js';
import { ProjectService } from '../project-service.js';
import { AgentRunner, type RunnerPaths } from '../runner.js';
import { TaskService } from '../task-service.js';
import { AuditService } from './audit-service.js';
import type { CommandOutput } from './domains.js';
import { parseGateBook } from './gate-book.js';

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

const SPEC_FIXTURE = [
  '# CLAUDE.md — Testkopie',
  '',
  '### Phase 0 — Foundation',
  '',
  'Exit gates — Phase 0:',
  '- [x] Stack healthy *(verified locally)*',
  '- [x] Docs current *(README, CHANGELOG)*',
  '',
  '### Phase 1 — Spine',
  '',
  'Exit gates — Phase 1:',
  '- [x] The meter reads a percentage *(ADR 0001)*',
  '- [ ] Not done yet',
  '',
  '## Appendix A',
  '',
  '- **A1** Eine Annahme.',
  '- **A2 — Eine neuere Annahme.** Mit Fließtext.',
  '',
].join('\n');

const CLEAN: AuditorResult = {
  status: 'done',
  summary: 'Zwei Gates geprüft, beide Belege tragen.',
  artifacts: [],
  followups: [],
  domain: 'gate_truth',
  sample: ['P0.G1', 'P0.G2'],
  findings: [],
  scopeLimits: [],
  verdict: 'unbedenklich',
};

describe.skipIf(!url)('Betriebsprüfung (§8.2)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let eventLog: EventLog;
  let tasks: TaskService;
  let projects: ProjectService;
  let backend: FakeBackend;
  let runner: AgentRunner;
  let escalations: EscalationService;
  let scratch: string;
  let specPath: string;
  /**
   * A second repository with a byte-identical `CLAUDE.md`.
   *
   * It exists so "which file did the un-tick write" is a question with an
   * observable answer. `AuditServiceDeps.specPath` used to default to
   * `join(repoRoot, 'CLAUDE.md')` and the fixture injected a path that happened
   * to *equal* that default — so the daemon's branch was untested and deleting
   * the injection would have left the suite green. Pointing `repoRoot` here
   * while `specPath` names the real file turns a reintroduced default into a
   * failing assertion instead of a silent one.
   */
  let decoyRoot: string;
  let decoySpec: string;
  let projectId: string;
  let paths: RunnerPaths;
  /** What the next audit session should answer with. */
  let answer: AuditorResult | 'fail';
  let seen: SessionSpec[];

  beforeAll(async () => {
    database = await createTestDatabase('audit');
    sql = createSql({ url: database.url, max: 4 });
    eventLog = new EventLog(sql);
    tasks = new TaskService({ sql, eventLog });
    projects = new ProjectService(sql);
    escalations = new EscalationService({ sql, eventLog });
    scratch = await mkdtemp(join(tmpdir(), 'vs-audit-'));
    specPath = join(scratch, 'CLAUDE.md');
    decoyRoot = await mkdtemp(join(tmpdir(), 'vs-audit-decoy-'));
    decoySpec = join(decoyRoot, 'CLAUDE.md');
    paths = {
      roleSettingsDir: join(scratch, 'claude'),
      runsRoot: join(scratch, 'runs'),
      transcriptsRoot: join(scratch, 'transcripts'),
      mcpServerEntry: null,
    };
    projectId = (
      await projects.create({
        slug: 'vorschicht',
        name: 'Vorschicht',
        rootPath: scratch,
        selfManaged: true,
      })
    ).id;

    backend = new FakeBackend(async (spec: SessionSpec): Promise<FakeScript> => {
      seen.push(spec);
      if (answer === 'fail') return { events: [HOOK_START], terminal: 'crashed', exitCode: 1 };
      return {
        events: [HOOK_START],
        result: { raw: answer, tokensIn: 900, tokensOut: 400 },
      };
    });
    runner = new AgentRunner({ sql, eventLog, backend, paths });
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
    await rm(scratch, { recursive: true, force: true });
    await rm(decoyRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    seen = [];
    answer = CLEAN;
    await writeFile(specPath, SPEC_FIXTURE, 'utf8');
    await writeFile(decoySpec, SPEC_FIXTURE, 'utf8');
    await projects.setReadOnly(projectId, false, 'test');
  });

  const exec = (): Promise<CommandOutput> =>
    Promise.resolve({ code: 0, stdout: '', stderr: '', spawnFailed: false });

  function service(overrides: Partial<ConstructorParameters<typeof AuditService>[0]> = {}) {
    return new AuditService({
      sql,
      eventLog,
      runner,
      repoRoot: scratch,
      scratchDir: scratch,
      specPath,
      tasks,
      // A44.3 reaches the un-tick through this. Wired by default because the
      // service fails closed without it: a `projectId` with no way to look up
      // whether the project may be written to does not write.
      projects,
      // §8.2: every `gate_invalid` also reaches the operator as a P1 item.
      escalations,
      projectId,
      exec,
      now: () => new Date('2026-08-02T09:00:00Z'),
      ...overrides,
    });
  }

  /** What `audit_findings` says about one finding — the row, not the object. */
  async function row(findingId: string) {
    const [found] = await sql<
      Array<{
        applied: boolean;
        apply_problem: string | null;
        apply_note: string | null;
        unticked_gate: string | null;
        escalation_number: string | null;
      }>
    >`
      SELECT applied, apply_problem, apply_note, unticked_gate, escalation_number
      FROM audit_findings WHERE id = ${findingId}
    `;
    return found;
  }

  /** A `gate_invalid` finding against P0.G1, as the auditor would report it. */
  function gateInvalid(gate = 'P0.G1'): AuditorResult {
    return {
      ...CLEAN,
      verdict: 'phase_nicht_abschliessbar',
      summary: 'Ein Beleg trägt nicht.',
      findings: [
        {
          class: 'gate_invalid',
          summary: 'Der angeführte Beleg prüft eine andere Behauptung.',
          evidence: 'CLAUDE.md:6 gegen infra/scripts/demo-phase0.sh:12',
          gate,
        },
      ],
    };
  }

  describe('the run itself', () => {
    it('records the audit, its sample and its verdict, and renders the Prüfbericht', async () => {
      const audit = await service().run({
        trigger: 'phase_close',
        scope: 'Phasen 0–1, rückwirkend.',
      });

      expect(audit.outcome).toBe('done');
      expect(audit.domain).toBe('gate_truth');
      expect(audit.verdict).toBe('unbedenklich');
      expect(audit.sample.length).toBeGreaterThan(0);
      expect(audit.report).toContain('## 6. Urteil');
      expect(audit.report).toContain('Prüfbericht');

      const stored = await service().get(audit.id);
      expect(stored?.outcome).toBe('done');
      expect(stored?.verdict).toBe('unbedenklich');
      expect(stored?.sample).toEqual(audit.sample);
      expect(stored?.reportedSample).toEqual(['P0.G1', 'P0.G2']);
      expect(stored?.runId).toBe(audit.runId);
    });

    it('runs in a scratch directory and without MCP (§8.2 independence rule 2)', async () => {
      await service().run({ trigger: 'phase_close', scope: 'x' });
      const spec = seen[0];
      expect(spec?.role).toBe('auditor');
      expect(spec?.cwd).toBe(scratch);
      // No task means no MCP, by construction: every registered tool is
      // task-scoped or a Phase 6 stub, and a session cannot be bound to a task
      // that does not exist.
      expect(spec?.mcpConfigPath).toBeNull();
      expect(spec?.allowedTools).not.toContain('Write');
      expect(spec?.allowedTools).not.toContain('Edit');
    });

    it('leaves a row behind when the session fails — silence and health differ', async () => {
      answer = 'fail';
      const audit = await service().run({ trigger: 'weekly', scope: 'x' });

      expect(audit.outcome).toBe('failed');
      expect(audit.verdict).toBeNull();
      expect(audit.problem).toContain('infra');

      const stored = await service().get(audit.id);
      expect(stored?.outcome).toBe('failed');
      expect(stored?.startedAt).toBeInstanceOf(Date);
    });

    it('puts the evidence brief and the sample into the prompt', async () => {
      await service().run({ trigger: 'phase_close', scope: 'Phasen 0–1.' });
      const prompt = seen[0]?.prompt ?? '';
      expect(prompt).toContain('gate_truth');
      expect(prompt).toContain('Phasen 0–1.');
      expect(prompt).toContain('P0.G1');
      // Read *for* the auditor, not instead of it.
      expect(prompt).toContain('verified locally');
      expect(prompt).toContain('Your sample');
    });

    it('gathers evidence for the drawn items and quotes the commands (A56)', async () => {
      const commands: string[][] = [];
      await service({
        exec: (file, args) => {
          commands.push([file, ...args]);
          return Promise.resolve({
            code: 0,
            stdout:
              file === 'git' && args[0] === 'log' ? 'aaa1111\tfeat: eins\n' : 'commit aaa1111',
            stderr: '',
            spawnFailed: false,
          });
        },
      }).run({ trigger: 'weekly', scope: 'x', domain: 'claim_vs_evidence' });

      expect(commands.some(([file, sub]) => file === 'git' && sub === 'show')).toBe(true);
      const prompt = seen[0]?.prompt ?? '';
      expect(prompt).toContain('On the items you drew');
      expect(prompt).toContain('$ git show --stat --no-patch aaa1111');
      // And the session is told it has nothing else, so a gap is reported
      // rather than worked around.
      expect(prompt).toContain('No shell, no git');
    });

    it('turns a detail collector that throws into a scope limit, not a failed audit', async () => {
      let first = true;
      const audit = await service({
        exec: (file, args) => {
          if (file === 'git' && args[0] === 'show') return Promise.reject(new Error('kaputt'));
          const stdout = first ? 'aaa1111\tfeat: eins\n' : '';
          first = false;
          return Promise.resolve({ code: 0, stdout, stderr: '', spawnFailed: false });
        },
      }).run({ trigger: 'weekly', scope: 'x', domain: 'claim_vs_evidence' });

      expect(audit.outcome).toBe('done');
      expect(seen[0]?.prompt).toContain('Zusatzbelege zur Stichprobe nicht ermittelbar');
    });

    it('takes gate_truth on a phase close and rotates otherwise', async () => {
      expect(await service().selectDomain('phase_close')).toBe('gate_truth');
      // Nothing has run yet in this describe beyond gate_truth audits, so the
      // rotation must move on rather than repeat the domain it just did.
      const next = await service().selectDomain('weekly');
      expect(next).not.toBe('gate_truth');
    });
  });

  describe('the taxonomy (§8.2)', () => {
    it('un-ticks the named gate in CLAUDE.md and reopens the phase', async () => {
      answer = {
        ...CLEAN,
        verdict: 'phase_nicht_abschliessbar',
        summary: 'Ein Beleg trägt nicht.',
        findings: [
          {
            class: 'gate_invalid',
            summary: 'Der angeführte Beleg prüft eine andere Behauptung.',
            evidence: 'CLAUDE.md:6 gegen infra/scripts/demo-phase0.sh:12',
            gate: 'P0.G1',
          },
        ],
      };

      const audit = await service().run({ trigger: 'phase_close', scope: 'Phase 0.' });

      expect(audit.unticked).toEqual(['P0.G1']);
      const after = parseGateBook(await readFile(specPath, 'utf8'));
      expect(after.find((gate) => gate.id === 'P0.G1')?.state).toBe('open');
      expect(after.find((gate) => gate.id === 'P0.G2')?.state).toBe('green');

      const line = (await readFile(specPath, 'utf8')).split('\n')[5] ?? '';
      expect(line).toContain('Betriebsprüfung 2026-08-02');
      expect(line).toContain('Der angeführte Beleg prüft eine andere Behauptung.');

      // And it reaches the operator, so a phase never reopens silently overnight.
      const card = audit.escalations[0];
      expect(card?.urgency).toBe('P1');
      expect(card?.options.filter((option) => option.recommended)).toHaveLength(1);
      expect(card?.question).toContain('P0.G1');
    });

    it('changes nothing when the finding names a gate that does not exist', async () => {
      const before = await readFile(specPath, 'utf8');
      answer = {
        ...CLEAN,
        verdict: 'phase_nicht_abschliessbar',
        findings: [
          {
            class: 'gate_invalid',
            summary: 'Beleg trägt nicht.',
            evidence: 'irgendwo',
            gate: 'P7.G12',
          },
        ],
      };

      const audit = await service().run({ trigger: 'phase_close', scope: 'x' });

      expect(await readFile(specPath, 'utf8')).toBe(before);
      expect(audit.unticked).toEqual([]);
      // The finding is not lost — only its consequence could not be carried out.
      expect(audit.findings).toHaveLength(1);
      expect(audit.findings[0]?.consequence).toContain('P7.G12');
      expect(audit.findings[0]?.consequence).toContain('nicht gibt');
    });

    it('refuses to guess when a gate_invalid names no gate at all', async () => {
      const before = await readFile(specPath, 'utf8');
      answer = {
        ...CLEAN,
        verdict: 'phase_nicht_abschliessbar',
        findings: [{ class: 'gate_invalid', summary: 'Irgendein Gate ist falsch.', evidence: 'x' }],
      };
      const audit = await service().run({ trigger: 'phase_close', scope: 'x' });
      expect(await readFile(specPath, 'utf8')).toBe(before);
      expect(audit.findings[0]?.consequence).toContain('keine Gate-Id');
    });

    it('files a P1 fix task for a defect, through the normal chain', async () => {
      answer = {
        ...CLEAN,
        verdict: 'funde_zu_beheben',
        findings: [
          {
            class: 'defect',
            summary: 'Der Zähler zählt Nachrichten statt Züge.',
            evidence: 'packages/core/src/backend/headless.ts:210',
          },
        ],
      };

      const audit = await service().run({ trigger: 'weekly', scope: 'x' });
      const taskId = audit.findings[0]?.taskId;
      expect(taskId).toBeTruthy();

      const task = await tasks.get(taskId as string);
      expect(task?.priority).toBe('P1');
      expect(task?.state).toBe('queued');
      expect(task?.title).toContain('Prüfungsfund beheben');
      expect(task?.description).toContain('headless.ts:210');
      expect(task?.acceptanceCriteria.length).toBeGreaterThan(0);
      // The report points at the task, which is §8.2's "je mit Task-Verweis".
      expect(audit.report).toContain(taskId as string);
    });

    it('builds a guard task for a process finding only when the auditor proposed one', async () => {
      answer = {
        ...CLEAN,
        verdict: 'funde_zu_beheben',
        findings: [
          {
            class: 'process',
            summary: 'Eine Regel wurde nicht befolgt.',
            evidence: 'event_log:99',
            guard: 'Gate-Schritt, der einen Merge ohne Gate-Lauf ablehnt.',
          },
          {
            class: 'process',
            summary: 'Eine Regel, die sich nicht mechanisch fassen lässt.',
            evidence: 'event_log:100',
          },
        ],
      };

      const audit = await service().run({ trigger: 'weekly', scope: 'x' });
      const withGuard = audit.findings[0];
      const without = audit.findings[1];

      expect(withGuard?.taskId).toBeTruthy();
      const task = await tasks.get(withGuard?.taskId as string);
      expect(task?.priority).toBe('P2');
      expect(task?.title).toContain('Mechanische Absicherung');
      expect(task?.description).toContain('Gate-Schritt');

      // No task is invented where the auditor did not name a guard.
      expect(without?.taskId).toBeNull();
      expect(without?.consequence).toContain('keine mechanische Absicherung');
    });

    it('files work for a coverage gap whether or not a guard was named (A65)', async () => {
      // The difference to `process` above is the point. There a guard is a
      // proposal and inventing one is worse than recording the breach. Here the
      // work *is* the finding — a proof the project should have and does not —
      // and a read-only auditor is the wrong party to have to know how to build
      // it. Requiring `guard` would return this class to being a footnote,
      // which is exactly where it came from.
      answer = {
        ...CLEAN,
        verdict: 'funde_zu_beheben',
        findings: [
          {
            class: 'coverage_gap',
            summary: 'Ob die Integrationstests je gegen eine echte Datenbank liefen, ist offen.',
            evidence:
              'vitest.config.ts:8-11 überspringt ohne TEST_DATABASE_URL; gate.mjs setzt sie nicht.',
          },
          {
            class: 'coverage_gap',
            summary: 'Der Rollback-Pfad wird von keinem Test durchlaufen.',
            evidence: 'deploy.ts:210 — kein Aufrufer in *.test.ts',
            guard: 'Ein Test, der einen fehlschlagenden Health-Check einspeist.',
          },
        ],
      };

      const audit = await service().run({ trigger: 'weekly', scope: 'x' });
      for (const finding of audit.findings) {
        expect(finding.taskId, finding.summary).toBeTruthy();
        const task = await tasks.get(finding.taskId as string);
        expect(task?.priority).toBe('P2');
        expect(task?.title).toContain('Fehlenden Nachweis');
      }
      // The named guard still reaches the task; it is help, not a precondition.
      const second = await tasks.get(audit.findings[1]?.taskId as string);
      expect(second?.description).toContain('Health-Check');
    });

    it('leaves no finding class without a consequence', async () => {
      // The defect this guards against is the one that created `coverage_gap`:
      // a class that is accepted, recorded, reported — and quietly produces
      // nothing, so it only works when a human reads the report. A class added
      // to the contract without a branch here falls into `default`, and that is
      // indistinguishable from a deliberate decision unless something asserts
      // the difference.
      const silent = new Set(['suspicion', 'assumption_expired']);
      const classes = auditFindingClassSchema.options.filter((c) => !silent.has(c));

      answer = {
        ...CLEAN,
        verdict: 'funde_zu_beheben',
        findings: classes.map((cls, index) => ({
          class: cls,
          summary: `Fund der Klasse ${cls}.`,
          evidence: `datei.ts:${index + 1}`,
          ...(cls === 'gate_invalid' ? { gate: 'P1.G1' } : {}),
        })),
      };

      const audit = await service().run({ trigger: 'weekly', scope: 'x' });
      for (const finding of audit.findings) {
        expect(finding.consequence, finding.summary).not.toContain('Keine Folge vorgesehen');
      }
    });

    it('prepares a decision for an expired assumption and creates no task', async () => {
      answer = {
        ...CLEAN,
        verdict: 'funde_zu_beheben',
        findings: [
          {
            class: 'assumption_expired',
            summary: 'A1 nennt Bedingungen, die nicht mehr gelten.',
            evidence: 'CLAUDE.md Anhang A',
          },
        ],
      };
      const audit = await service().run({ trigger: 'weekly', scope: 'x' });
      expect(audit.findings[0]?.taskId).toBeNull();
      expect(audit.escalations).toHaveLength(1);
      expect(audit.escalations[0]?.options.map((option) => option.title).join(' ')).toMatch(
        /revidieren.*bestätigen.*zurückziehen/is,
      );
    });

    it('lets a suspicion block nothing and become no task', async () => {
      answer = {
        ...CLEAN,
        verdict: 'unbedenklich',
        findings: [
          { class: 'suspicion', summary: 'Der Timeout wirkt knapp.', evidence: 'runner.ts:67' },
        ],
      };
      const audit = await service().run({ trigger: 'weekly', scope: 'x' });
      expect(audit.findings[0]?.taskId).toBeNull();
      expect(audit.escalations).toEqual([]);
      expect(audit.unticked).toEqual([]);
      expect(audit.report).toContain('Der Timeout wirkt knapp.');
    });

    it('keeps the report when a consequence cannot be carried out', async () => {
      // No tasks service and no project: the finding still stands and the
      // report says the follow-up could not be filed, rather than the audit
      // being lost because the follow-up machinery was not configured.
      answer = {
        ...CLEAN,
        verdict: 'funde_zu_beheben',
        findings: [{ class: 'defect', summary: 'Ein Defekt.', evidence: 'x.ts:1' }],
      };
      const audit = await new AuditService({
        sql,
        eventLog,
        runner,
        repoRoot: scratch,
        scratchDir: scratch,
        specPath,
        exec,
        now: () => new Date('2026-08-02T09:00:00Z'),
      }).run({ trigger: 'weekly', scope: 'x' });
      expect(audit.outcome).toBe('done');
      expect(audit.findings[0]?.taskId).toBeNull();
      expect(audit.findings[0]?.consequence).toContain('kein Projekt zugeordnet');
      expect(audit.report).toContain('Ein Defekt.');
    });
  });

  /**
   * What the un-tick actually did, asserted from the file *and* from the row.
   *
   * The defect these exist for was shipped and observed: on the deployed stack a
   * `gate_invalid` against P0.G5 sat in `audit_findings` with `applied = true`
   * and `apply_problem = NULL` while the gate was still ticked, because the
   * un-tick had failed with `EACCES` and the reason had been written under a key
   * the view did not read. Every case below therefore checks both halves — the
   * bytes on disk and the columns — since either alone is what let that through.
   */
  describe('die Folge sagt, ob sie stattgefunden hat (§8.2)', () => {
    it('entfernt den Haken und schreibt „ja" in den Datensatz', async () => {
      answer = gateInvalid();
      const audit = await service().run({ trigger: 'phase_close', scope: 'Phase 0.' });

      // The file.
      const after = parseGateBook(await readFile(specPath, 'utf8'));
      expect(after.find((gate) => gate.id === 'P0.G1')?.state).toBe('open');
      expect((await readFile(specPath, 'utf8')).split('\n')[5]).toContain('Betriebsprüfung');

      // The row. `applied` is the claim, and until 0018 it could not be false.
      const stored = await row(audit.findings[0]?.id as string);
      expect(stored?.applied).toBe(true);
      expect(stored?.apply_problem).toBeNull();
      expect(stored?.unticked_gate).toBe('P0.G1');
      expect(stored?.apply_note).toContain('P0.G1');

      // And the object the caller reads says the same thing.
      expect(audit.findings[0]?.consequenceApplied).toBe(true);
      expect(audit.findings[0]?.consequenceProblem).toBeNull();
    });

    it('lässt die Datei unverändert und schreibt „nein" mit Grund, wenn das Schreiben scheitert', async () => {
      // The deployed shape, reproduced through the seam rather than through a
      // permission bit: `EACCES` on the write, the file untouched, and — the
      // part that was missing — the reason in a column somebody can query.
      answer = gateInvalid();
      const before = await readFile(specPath, 'utf8');
      const audit = await service({
        spec: {
          read: (path) => readFile(path, 'utf8'),
          write: () => Promise.reject(new Error("EACCES: permission denied, open 'CLAUDE.md'")),
        },
      }).run({ trigger: 'phase_close', scope: 'Phase 0.' });

      expect(await readFile(specPath, 'utf8')).toBe(before);
      expect(audit.unticked).toEqual([]);

      const stored = await row(audit.findings[0]?.id as string);
      expect(stored?.applied).toBe(false);
      expect(stored?.apply_problem).toContain('EACCES');
      expect(stored?.unticked_gate).toBeNull();
      // The finding is not lost — that is the other half of §8.2's bargain.
      expect(audit.findings).toHaveLength(1);
    });

    it('glaubt dem Schreiben nicht, sondern liest die Datei zurück', async () => {
      // A writer that reports success and changes nothing. Without the read-back
      // this passes as an un-tick: `writeFile` resolved, so the old code
      // returned "Gate geöffnet" and the row said `applied`. This is the exact
      // class of claim the whole repair is about, one layer lower.
      answer = gateInvalid();
      const before = await readFile(specPath, 'utf8');
      const audit = await service({
        spec: {
          read: (path) => readFile(path, 'utf8'),
          write: () => Promise.resolve(),
        },
      }).run({ trigger: 'phase_close', scope: 'Phase 0.' });

      expect(await readFile(specPath, 'utf8')).toBe(before);
      expect(audit.unticked).toEqual([]);
      const stored = await row(audit.findings[0]?.id as string);
      expect(stored?.applied).toBe(false);
      expect(stored?.apply_problem).toContain('weiterhin auf');
    });

    it('schreibt in die Datei, die `specPath` nennt — nicht in die neben `repoRoot`', async () => {
      // The mutation this is built against: reintroducing the old default
      // (`join(repoRoot, 'CLAUDE.md')`). The fixture used to set `specPath` to a
      // value equal to that default, so the injection proved nothing.
      answer = gateInvalid();
      const decoyBefore = await readFile(decoySpec, 'utf8');
      await service({ repoRoot: decoyRoot }).run({ trigger: 'phase_close', scope: 'Phase 0.' });

      expect(
        parseGateBook(await readFile(specPath, 'utf8')).find((g) => g.id === 'P0.G1')?.state,
      ).toBe('open');
      expect(await readFile(decoySpec, 'utf8')).toBe(decoyBefore);
    });

    it('verweigert den Haken in einem Nur-Lese-Projekt und legt die Entscheidung der Betreiber vor (A44.3)', async () => {
      // A44.3 says `read_only` refuses "worktree, branch and any write at the
      // manager's entrance" — and `WorktreeManager` does. The auditor reached
      // the filesystem through its own `writeFile` and never asked, so the flag
      // stopped the dev chain and not the one component that edits the spec.
      // The authority §8.2 grants is not weakened by refusing here: it is
      // exercised through the operator instead of through a file nobody merges.
      await projects.setReadOnly(projectId, true, 'test');
      answer = gateInvalid();
      const before = await readFile(specPath, 'utf8');
      const audit = await service().run({ trigger: 'phase_close', scope: 'Phase 0.' });

      expect(await readFile(specPath, 'utf8')).toBe(before);
      const stored = await row(audit.findings[0]?.id as string);
      expect(stored?.applied).toBe(false);
      expect(stored?.apply_problem).toContain('Nur-Lesen');
      // Strictly more than before: the finding now reaches the operator.
      expect(stored?.escalation_number).not.toBeNull();
    });

    it('schreibt nicht, wenn es nicht feststellen kann, ob es darf', async () => {
      // Fail-closed. "We could not find out whether we are allowed" and "we are
      // allowed" are the same sentence only to a system that has decided not to
      // notice.
      answer = gateInvalid();
      const before = await readFile(specPath, 'utf8');
      const audit = await new AuditService({
        sql,
        eventLog,
        runner,
        repoRoot: scratch,
        scratchDir: scratch,
        specPath,
        tasks,
        escalations,
        projectId,
        exec,
        now: () => new Date('2026-08-02T09:00:00Z'),
      }).run({ trigger: 'phase_close', scope: 'Phase 0.' });

      expect(await readFile(specPath, 'utf8')).toBe(before);
      expect((await row(audit.findings[0]?.id as string))?.applied).toBe(false);
    });
  });

  /**
   * §8.2's P1 inbox item, which had no producer at all.
   *
   * `AuditService.escalate` built the card and pushed it into a returned array
   * plus an `event_log` row carrying `source: 'audit'` — a value that is not a
   * member of `ESCALATION_SOURCES`, so nothing in the inbox could ever have
   * found it. The stated safeguard ("a phase never reopens silently") was a
   * comment.
   */
  describe('der P1-Posteingang zur Betriebsprüfung (§8.2, §15)', () => {
    it('legt ein entwertetes Gate als Entscheidung ins Postfach', async () => {
      answer = gateInvalid();
      const audit = await service().run({ trigger: 'phase_close', scope: 'Phase 0.' });

      const number = audit.findings[0]?.escalationNumber;
      expect(number).toEqual(expect.any(Number));
      const item = await escalations.byNumber(number as number);
      expect(item?.source).toBe('audit_finding');
      expect(item?.urgency).toBe('P1');
      expect(item?.state).toBe('open');
      expect(item?.question).toContain('P0.G1');
      // The trail runs finding → card, never task → card: `Scheduler.resumeDecided`
      // reads the latest escalation *of a task* to continue a parked session,
      // and an audit card sitting in that slot would answer for a session that
      // never asked anything.
      expect(item?.taskId).toBeNull();
      expect(item?.context).toContain(audit.findings[0]?.id.slice(0, 8) as string);

      // And the row knows which item it became.
      expect((await row(audit.findings[0]?.id as string))?.escalation_number).toBe(String(number));
    });

    it('verliert den Fund nicht, wenn das Postfach nicht erreichbar ist', async () => {
      answer = gateInvalid();
      const audit = await service({
        escalations: {
          raise: () => Promise.reject(new Error('Datenbank weg')),
        },
      }).run({ trigger: 'phase_close', scope: 'Phase 0.' });

      expect(audit.findings).toHaveLength(1);
      expect(audit.unticked).toEqual(['P0.G1']);
      // The queryable form of "a phase reopened and nobody was told".
      expect((await row(audit.findings[0]?.id as string))?.escalation_number).toBeNull();
    });

    it('fragt beim zweiten Mal wieder, statt aus dem Gedächtnis zu antworten', async () => {
      // The behavioural half of `POLICY_MEMORY_SOURCES`. A reusable answer to
      // "Gate P1.G1 wurde entwertet — wie weiter?" would let the option "Fund
      // verwerfen — Haken wieder setzen" re-tick a *later* gate from memory,
      // with nobody asked. A list comparison cannot see that; this can.
      answer = gateInvalid('P1.G1');
      const first = await service().run({ trigger: 'phase_close', scope: 'Phase 1.' });
      const firstNumber = first.findings[0]?.escalationNumber as number;
      const item = await escalations.byNumber(firstNumber);
      await escalations.answer(item?.id as string, { optionIndex: 0, actor: 'max' });

      await writeFile(specPath, SPEC_FIXTURE, 'utf8');
      answer = gateInvalid('P1.G1');
      const second = await service().run({ trigger: 'phase_close', scope: 'Phase 1, erneut.' });

      const secondNumber = second.findings[0]?.escalationNumber as number;
      expect(secondNumber).toEqual(expect.any(Number));
      expect(secondNumber).not.toBe(firstNumber);
      expect((await escalations.byNumber(secondNumber))?.state).toBe('open');
    });
  });

  describe('the dismissal rule (§8.2)', () => {
    async function raise(): Promise<string> {
      answer = {
        ...CLEAN,
        verdict: 'funde_zu_beheben',
        findings: [
          { class: 'defect', summary: 'Strittiger Fund.', evidence: 'packages/core/src/x.ts:4' },
        ],
      };
      const audit = await service().run({ trigger: 'weekly', scope: 'x' });
      return audit.findings[0]?.id as string;
    }

    it('counts the first dismissal and offers the finding to the next audit', async () => {
      const id = await raise();
      const first = await service().dismiss(id, 'coder', 'Der Zeiger ist nie null.');
      expect(first).toEqual({ dismissals: 1, escalated: false });

      const record = await service().finding(id);
      expect(record?.status).toBe('dismissed');
      expect(record?.dismissals).toBe(1);
      expect(record?.statusReason).toBe('Der Zeiger ist nie null.');

      // The next audit is handed the dismissal as evidence — that is the whole
      // mechanism behind "re-opened exactly once".
      answer = CLEAN;
      await service().run({ trigger: 'weekly', scope: 'x' });
      const prompt = seen.at(-1) ?? seen[0];
      expect(prompt?.prompt).toContain('Findings the dev chain rejected');
      expect(prompt?.prompt).toContain(id);
      expect(prompt?.prompt).toContain('Der Zeiger ist nie null.');
    });

    it('sends the second dismissal to the operator instead of round again', async () => {
      const id = await raise();
      await service().dismiss(id, 'coder', 'Erste Begründung.');
      const second = await service().dismiss(id, 'coder', 'Zweite Begründung.');

      expect(second).toEqual({ dismissals: 2, escalated: true });
      const record = await service().finding(id);
      expect(record?.status).toBe('escalated');
      expect(record?.dismissals).toBe(2);

      const rows = await sql<Array<{ payload: Record<string, unknown> }>>`
        SELECT payload FROM event_log
        WHERE kind = 'escalation.requested' AND payload ->> 'findingId' = ${id}
      `;
      expect(rows).toHaveLength(1);
      expect(String(rows[0]?.payload.question)).toContain('zweimal uneinig');
    });

    it('suppresses the consequence when a twice-dismissed finding is re-raised', async () => {
      const id = await raise();
      await service().dismiss(id, 'coder', 'Erste.');
      await service().dismiss(id, 'coder', 'Zweite.');

      answer = {
        ...CLEAN,
        verdict: 'funde_zu_beheben',
        findings: [
          {
            class: 'defect',
            summary: 'Strittiger Fund, erneut.',
            evidence: 'packages/core/src/x.ts:4',
            reopens: id,
          },
        ],
      };
      const audit = await service().run({ trigger: 'weekly', scope: 'x' });

      expect(audit.findings[0]?.blocked).toBe(true);
      // No third fix task: two agents disagreeing twice is a decision, not a
      // loop to keep running.
      expect(audit.findings[0]?.taskId).toBeNull();
      expect(audit.escalations).toHaveLength(1);
    });

    it('reopens a once-dismissed finding and lets the consequence run', async () => {
      const id = await raise();
      await service().dismiss(id, 'coder', 'Einmal zurückgewiesen.');

      answer = {
        ...CLEAN,
        verdict: 'funde_zu_beheben',
        findings: [
          {
            class: 'defect',
            summary: 'Ich halte den Fund aufrecht.',
            evidence: 'packages/core/src/x.ts:4',
            reopens: id,
          },
        ],
      };
      const audit = await service().run({ trigger: 'weekly', scope: 'x' });

      expect(audit.findings[0]?.blocked).toBe(false);
      expect(audit.findings[0]?.taskId).toBeTruthy();
      expect(audit.findings[0]?.consequence).toContain('Wiederaufnahme');
      expect((await service().finding(id))?.status).toBe('open');
    });

    it('answers null for a reference that is not an id, rather than throwing', async () => {
      // The first real audit set `reopens` to "Phase 1". Postgres refused the
      // uuid cast and a complete audit was lost on the way to being recorded.
      // The contract refuses that shape now (`agent-result.test.ts`); this is
      // the second layer, because the one outcome §8.2 cannot afford is an
      // audit that produced a verdict and never got to record it.
      await expect(service().finding('Phase 1')).resolves.toBeNull();
      await expect(service().finding('')).resolves.toBeNull();
      await expect(service().finding('not-a-uuid-at-all')).resolves.toBeNull();
    });

    it('treats a dangling `reopens` as a new finding rather than dropping it', async () => {
      answer = {
        ...CLEAN,
        verdict: 'funde_zu_beheben',
        findings: [
          {
            class: 'defect',
            summary: 'Verweist ins Leere.',
            evidence: 'x.ts:1',
            reopens: '11111111-2222-3333-4444-555555555555',
          },
        ],
      };
      const audit = await service().run({ trigger: 'weekly', scope: 'x' });
      expect(audit.findings[0]?.taskId).toBeTruthy();
      expect(audit.findings[0]?.consequence).toContain('nicht gibt');
    });
  });

  describe('the record', () => {
    it('refuses UPDATE, DELETE and TRUNCATE even for the table owner', async () => {
      await service().run({ trigger: 'weekly', scope: 'x' });
      await expect(sql`UPDATE audit_events SET kind = 'finished'`).rejects.toThrow(/append-only/i);
      await expect(sql`DELETE FROM audit_events`).rejects.toThrow(/append-only/i);
      await expect(sql`TRUNCATE audit_events`).rejects.toThrow(/append-only/i);
      await expect(sql`TRUNCATE audit_finding_events`).rejects.toThrow(/append-only/i);
    });

    it('carries the finding history in the projection', async () => {
      answer = {
        ...CLEAN,
        verdict: 'funde_zu_beheben',
        findings: [{ class: 'defect', summary: 'Historie.', evidence: 'y.ts:2' }],
      };
      const audit = await service().run({ trigger: 'weekly', scope: 'x' });
      const id = audit.findings[0]?.id as string;

      expect((await service().finding(id))?.status).toBe('open');
      await service().confirm(id, 'coder', 'Stimmt.');
      expect((await service().finding(id))?.status).toBe('confirmed');
      await service().resolve(id, 'orchestrator', audit.findings[0]?.taskId ?? undefined);
      expect((await service().finding(id))?.status).toBe('resolved');

      const listed = await service().findingsOf(audit.id);
      expect(listed.map((finding) => finding.id)).toContain(id);
      expect(listed[0]?.applied).toBe(true);
    });

    it('scores the auditor itself, in both failure directions', async () => {
      const card = await service().scorecard(new Date(0));
      expect(card.audits).toBeGreaterThan(0);
      expect(card.findings).toBeGreaterThan(0);
      // §8.2 rule 5: a silent auditor and a working one look identical from
      // outside, and this ratio is the only thing that separates them.
      expect(card.confirmed + card.dismissed + card.open).toBeGreaterThan(0);
      expect(card.auditsFailed).toBeGreaterThanOrEqual(1);
    });

    it('writes the audit to the event log so the dashboard can see it', async () => {
      const audit = await service().run({ trigger: 'weekly', scope: 'x' });
      const rows = await sql<Array<{ kind: string }>>`
        SELECT kind FROM event_log
        WHERE payload ->> 'auditId' = ${audit.id} ORDER BY id
      `;
      expect(rows.map((row) => row.kind)).toEqual(['audit.started', 'audit.finished']);
    });
  });

  describe('the sample', () => {
    it('is recorded, so a later audit can re-check exactly it', async () => {
      const first = await service().run({
        trigger: 'phase_close',
        scope: 'x',
        auditId: '00000000-0000-4000-8000-00000000aaaa',
      });
      const stored = await service().get(first.id);
      expect(stored?.sample).toEqual(first.sample);
      expect(stored?.sample.length).toBeGreaterThan(0);
    });

    it('carries an item a previous clean audit passed into the next sample', async () => {
      // Two gate_truth audits over the same pool. The second must re-check
      // something the first passed — regression testing applied to the auditor.
      const first = await service().run({ trigger: 'phase_close', scope: 'erste' });
      expect(first.verdict).toBe('unbedenklich');

      const second = await service().run({ trigger: 'phase_close', scope: 'zweite' });
      const carried = second.sample.filter((item) => first.sample.includes(item));
      expect(carried.length).toBeGreaterThan(0);
      expect(seen.at(-1)?.prompt).toContain('a previous audit examined it and found nothing');
    });
  });
});
