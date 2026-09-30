/**
 * The eight collectors (§8.2).
 *
 * What is asserted here is not "the collector found the right things" — that is
 * the auditor's judgement, and a collector that pre-selected the interesting
 * items would be building the studio's own view of itself, which is the failure
 * this department exists to catch. What is asserted is the contract every
 * collector owes: a pool the sample can be drawn from, a brief that carries
 * real rows rather than a summary of them, and — the one that matters — a
 * *scope limit* wherever it came up empty, never an empty pool that reads
 * downstream as "nothing wrong here".
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUDIT_DOMAIN_IDS,
  AUDIT_DOMAINS,
  type CommandOutput,
  type EvidenceContext,
  getAuditDomain,
  runCommand,
} from './domains.js';

const REPO_ROOT = join(import.meta.dirname, '../../../..');

/** A `Queryable` stand-in that answers every query with the same rows. */
function fakeSql(rows: unknown[] = []): EvidenceContext['sql'] {
  const query = () => Promise.resolve(rows) as never;
  return Object.assign(query, { json: (value: unknown) => value }) as never;
}

/** A `Queryable` stand-in whose every query fails, the way a dead pool would. */
function brokenSql(): EvidenceContext['sql'] {
  const query = () => Promise.reject(new Error('Verbindung weg')) as never;
  return Object.assign(query, { json: (value: unknown) => value }) as never;
}

const ok = (stdout = ''): CommandOutput => ({ code: 0, stdout, stderr: '', spawnFailed: false });

let empty: string;

beforeAll(async () => {
  // A directory with nothing in it: no CLAUDE.md, no sources, no git. Every
  // collector has to survive it and say what it could not see.
  empty = await mkdtemp(join(tmpdir(), 'vorschicht-audit-empty-'));
  await mkdir(join(empty, 'packages'), { recursive: true });
});

afterAll(async () => {
  await rm(empty, { recursive: true, force: true });
});

describe('the domain table', () => {
  it('has an entry for every id, and every entry knows its own id', () => {
    expect(Object.keys(AUDIT_DOMAINS).sort()).toEqual([...AUDIT_DOMAIN_IDS].sort());
    for (const id of AUDIT_DOMAIN_IDS) expect(getAuditDomain(id).id).toBe(id);
  });

  it('gives every domain a German label and a sample size above zero', () => {
    for (const id of AUDIT_DOMAIN_IDS) {
      const domain = getAuditDomain(id);
      expect(domain.label.length, id).toBeGreaterThan(0);
      expect(domain.question.length, id).toBeGreaterThan(40);
      expect(domain.sampleSize, id).toBeGreaterThan(0);
    }
  });

  it('reports an empty pool as a scope limit, in every domain', async () => {
    // The rule §8.2 states as "an unexamined area is not a clean one". A
    // collector that returned `{ pool: [], limits: [] }` would make an audit of
    // an unreachable area indistinguishable from a clean one.
    for (const id of AUDIT_DOMAIN_IDS) {
      const evidence = await getAuditDomain(id).collect({
        repoRoot: empty,
        sql: fakeSql(),
        exec: () => Promise.resolve(ok()),
      });
      if (evidence.pool.length === 0) {
        expect(
          evidence.limits.length,
          `${id} meldet leeren Pool ohne Einschränkung`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe('gate_truth', () => {
  it('pools the ticked gates of the real spec and puts their text in the brief', async () => {
    const evidence = await AUDIT_DOMAINS.gate_truth.collect({
      repoRoot: REPO_ROOT,
      sql: fakeSql(),
      exec: () => Promise.resolve(ok()),
    });
    expect(evidence.pool.length).toBeGreaterThan(20);
    expect(evidence.pool).toContain('P0.G1');
    expect(evidence.limits).toEqual([]);
    // The brief has to carry the gate's *cited evidence*, because the question
    // is whether that evidence establishes the claim — a list of ids would ask
    // the auditor to go and find it again.
    expect(evidence.brief.join('\n')).toContain('verified locally and on the production host');
  });

  it('says CLAUDE.md was unreadable rather than reporting no gates', async () => {
    const evidence = await AUDIT_DOMAINS.gate_truth.collect({
      repoRoot: empty,
      sql: fakeSql(),
      exec: () => Promise.resolve(ok()),
    });
    expect(evidence.pool).toEqual([]);
    expect(evidence.limits.join(' ')).toContain('CLAUDE.md');
  });
});

describe('claim_vs_evidence', () => {
  it('pools commit shas and reports a git that would not run', async () => {
    const evidence = await AUDIT_DOMAINS.claim_vs_evidence.collect({
      repoRoot: REPO_ROOT,
      sql: fakeSql(),
      exec: (file, args) =>
        Promise.resolve(
          file === 'git' && args[0] === 'log'
            ? ok('abc1234\tfeat: eins\ndef5678\tfix: zwei\n')
            : ok(),
        ),
    });
    expect(evidence.pool).toEqual(['abc1234', 'def5678']);
    expect(evidence.brief.join('\n')).toContain('feat: eins');
  });

  it('runs git show for the items actually drawn, and quotes the command', async () => {
    // The auditor has no shell of its own (A56), so this is the only way a
    // sampled commit's shape reaches it — and the command has to be quoted
    // beside its output, or the auditor is being asked to trust a summary.
    const detail = await AUDIT_DOMAINS.claim_vs_evidence.detail?.(
      {
        repoRoot: REPO_ROOT,
        sql: fakeSql(),
        exec: (_file, args) => Promise.resolve(ok(`commit ${args.at(-1)}\n 3 files changed\n`)),
      },
      ['abc1234', 'def5678'],
    );
    expect(detail?.join('\n')).toContain('$ git show --stat --no-patch abc1234');
    expect(detail?.join('\n')).toContain('commit def5678');
  });

  it('reports a git show that failed instead of leaving a blank', async () => {
    const detail = await AUDIT_DOMAINS.claim_vs_evidence.detail?.(
      {
        repoRoot: REPO_ROOT,
        sql: fakeSql(),
        exec: () =>
          Promise.resolve({ code: 128, stdout: '', stderr: 'bad object', spawnFailed: false }),
      },
      ['deadbee'],
    );
    expect(detail?.join('\n')).toContain('fehlgeschlagen: bad object');
  });

  it('records a failed git log as a scope limit', async () => {
    const evidence = await AUDIT_DOMAINS.claim_vs_evidence.collect({
      repoRoot: REPO_ROOT,
      sql: fakeSql(),
      exec: () =>
        Promise.resolve({ code: 128, stdout: '', stderr: 'not a repo', spawnFailed: false }),
    });
    expect(evidence.limits.join(' ')).toContain('git log');
  });
});

describe('test_substance', () => {
  it('pools the repository’s own test files', async () => {
    const evidence = await AUDIT_DOMAINS.test_substance.collect({
      repoRoot: REPO_ROOT,
      sql: fakeSql(),
      exec: () => Promise.resolve(ok()),
    });
    expect(evidence.pool).toContain('packages/core/src/audit/sampling.test.ts');
    expect(evidence.pool.some((path) => path.endsWith('.itest.ts'))).toBe(true);
    // It is a read-only judgement and the collector says so, rather than
    // implying the auditor could break something and re-run it.
    expect(evidence.limits.join(' ')).toContain('nichts verändern');
  });
});

describe('assumption_revision', () => {
  it('pools every Appendix A id, including the ones written in the newer shape', async () => {
    const evidence = await AUDIT_DOMAINS.assumption_revision.collect({
      repoRoot: REPO_ROOT,
      sql: fakeSql(),
      exec: () => Promise.resolve(ok()),
    });
    expect(evidence.pool).toContain('A1');
    expect(evidence.pool).toContain('A43');
    expect(evidence.pool).toContain('A134');
  });
});

describe('containment_boundaries', () => {
  it('executes the check rather than reading it, and carries the exit code', async () => {
    const calls: Array<[string, string[]]> = [];
    const evidence = await AUDIT_DOMAINS.containment_boundaries.collect({
      repoRoot: REPO_ROOT,
      sql: fakeSql(),
      exec: (file, args) => {
        calls.push([file, args]);
        return Promise.resolve(ok('3 Verweigerungen, 1 erlaubter Schreibzugriff'));
      },
    });
    expect(calls[0]).toEqual(['pnpm', ['-s', 'check:hook-containment']]);
    expect(evidence.brief.join('\n')).toContain('Exit-Code: 0');
    expect(evidence.brief.join('\n')).toContain('3 Verweigerungen');
    expect(evidence.limits).toEqual([]);
  });

  it('reports that nothing was proven when the check could not start', async () => {
    const evidence = await AUDIT_DOMAINS.containment_boundaries.collect({
      repoRoot: REPO_ROOT,
      sql: fakeSql(),
      exec: () => Promise.resolve({ code: null, stdout: '', stderr: 'ENOENT', spawnFailed: true }),
    });
    // Not "the hooks failed" — nothing ran, so nothing is established either way.
    expect(evidence.limits.join(' ')).toContain('nichts belegt');
  });
});

describe('dead_wiring', () => {
  it('finds an export that nothing references, and not one that is used', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vorschicht-audit-dead-'));
    try {
      await mkdir(join(root, 'packages/x/src'), { recursive: true });
      await writeFile(
        join(root, 'packages/x/src/a.ts'),
        'export function usedHelper() { return 1; }\nexport const neverCalledAnywhere = 2;\n',
      );
      await writeFile(
        join(root, 'packages/x/src/b.ts'),
        'import { usedHelper } from "./a.js";\nusedHelper();\n',
      );

      const evidence = await AUDIT_DOMAINS.dead_wiring.collect({
        repoRoot: root,
        sql: fakeSql(),
        exec: () => Promise.resolve(ok()),
      });
      expect(evidence.pool).toContain('packages/x/src/a.ts:neverCalledAnywhere');
      expect(evidence.pool).not.toContain('packages/x/src/a.ts:usedHelper');
      // The pool is a suspicion list, and the brief has to say so — a barrel
      // export or a dynamic call makes any of these a false positive.
      expect(evidence.brief.join('\n')).toContain('Verdacht, kein Befund');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('meldet einen Export, den nur sein eigener Test benutzt', async () => {
    // The case the collector was blind to until 2026-08-01: test text was
    // counted as usage, so `JobQueue` — 298 lines, tested against a real
    // Postgres, constructed nowhere outside its tests — never appeared. This
    // fixture is that shape in miniature.
    const root = await mkdtemp(join(tmpdir(), 'vorschicht-audit-testonly-'));
    try {
      await mkdir(join(root, 'packages/x/src'), { recursive: true });
      await writeFile(
        join(root, 'packages/x/src/queue.ts'),
        'export class NeverConstructedQueue { start() { return 1; } }\n',
      );
      await writeFile(
        join(root, 'packages/x/src/queue.test.ts'),
        'import { NeverConstructedQueue } from "./queue.js";\n' +
          'it("works", () => { new NeverConstructedQueue().start(); });\n' +
          'it("again", () => { new NeverConstructedQueue(); });\n',
      );

      const evidence = await AUDIT_DOMAINS.dead_wiring.collect({
        repoRoot: root,
        sql: fakeSql(),
        exec: () => Promise.resolve(ok()),
      });

      expect(evidence.pool).toContain('packages/x/src/queue.ts:NeverConstructedQueue');
      // And it is reported as its own class, not folded in with "nothing
      // references this" — a reader has to be able to tell the two apart.
      expect(evidence.brief.join('\n')).toContain('nur von Tests');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('zählt Prosa nicht als Benutzung — Kommentare und Zeichenketten', async () => {
    // Found by running the fix above against this repository: `JobQueue` has
    // six production occurrences and every single one is a comment or an error
    // string, so it stayed invisible even after test text was excluded. The
    // comment *explaining* the case was itself two of the six.
    const root = await mkdtemp(join(tmpdir(), 'vorschicht-audit-prose-'));
    try {
      await mkdir(join(root, 'packages/x/src'), { recursive: true });
      await writeFile(
        join(root, 'packages/x/src/a.ts'),
        'export class OnlyTalkedAbout {}\n' +
          "  throw new Error('OnlyTalkedAbout ist nicht gestartet');\n",
      );
      await writeFile(
        join(root, 'packages/x/src/b.ts'),
        '// OnlyTalkedAbout.pause() already has exactly these semantics\n' +
          '/** An `OnlyTalkedAbout` drops straight in here. */\n' +
          'export const unrelated = 1;\nunrelated;\n',
      );

      const evidence = await AUDIT_DOMAINS.dead_wiring.collect({
        repoRoot: root,
        sql: fakeSql(),
        exec: () => Promise.resolve(ok()),
      });

      // Four mentions across two files, none of them a use.
      expect(evidence.pool).toContain('packages/x/src/a.ts:OnlyTalkedAbout');
      // And the genuinely used one stays out, so this is not simply "reports
      // everything".
      expect(evidence.pool).not.toContain('packages/x/src/b.ts:unrelated');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('names an event kind that nothing can emit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'vorschicht-audit-kinds-'));
    try {
      await mkdir(join(root, 'packages/x/src'), { recursive: true });
      // `deploy.finished` appears nowhere in this fixture tree, so it is exactly
      // the shape A53 found: a signal path that cannot carry a signal.
      await writeFile(join(root, 'packages/x/src/a.ts'), "export const kind = 'run.created';\n");
      const evidence = await AUDIT_DOMAINS.dead_wiring.collect({
        repoRoot: root,
        sql: fakeSql(),
        exec: () => Promise.resolve(ok()),
      });
      expect(evidence.pool).toContain('event_kind:deploy.finished');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('process_compliance', () => {
  it('says plainly that nothing has merged yet rather than reporting compliance', async () => {
    const evidence = await AUDIT_DOMAINS.process_compliance.collect({
      repoRoot: REPO_ROOT,
      sql: fakeSql([]),
      exec: () => Promise.resolve(ok()),
    });
    expect(evidence.pool).toEqual([]);
    expect(evidence.limits.join(' ')).toContain('merge.finished');
  });

  it('reports an unreadable event log as a scope limit', async () => {
    const evidence = await AUDIT_DOMAINS.process_compliance.collect({
      repoRoot: REPO_ROOT,
      sql: brokenSql(),
      exec: () => Promise.resolve(ok()),
    });
    expect(evidence.limits.join(' ')).toContain('Ereignisprotokoll nicht lesbar');
  });
});

describe('number_reconciliation', () => {
  it('puts the reported numbers next to independently recomputed ones', async () => {
    const evidence = await AUDIT_DOMAINS.number_reconciliation.collect({
      repoRoot: REPO_ROOT,
      sql: fakeSql([
        {
          id: '7',
          reported_at: new Date('2026-08-01T10:00:00Z'),
          phase: 'Phase 2',
          gates_green: 22,
          gates_deferred: 0,
          gates_open: 57,
          commits: 40,
        },
      ]),
      exec: () => Promise.resolve(ok('41\n')),
    });
    const brief = evidence.brief.join('\n');
    expect(evidence.pool).toEqual(['report:7']);
    expect(brief).toContain('grün 22');
    // The other side of the comparison, recomputed here rather than believed.
    expect(brief).toContain('CLAUDE.md heute: grün');
    expect(brief).toContain('git rev-list --count HEAD: 41');
    expect(brief).toContain('Zeitrichtung');
  });
});

describe('runCommand', () => {
  it('returns the exit code instead of throwing on it', async () => {
    const result = await runCommand('node', ['-e', 'process.exit(3)'], REPO_ROOT, 30_000);
    expect(result.code).toBe(3);
    expect(result.spawnFailed).toBe(false);
  });

  it('distinguishes a binary that does not exist from one that failed', async () => {
    const result = await runCommand('definitely-not-a-binary-9427', [], REPO_ROOT, 30_000);
    expect(result.spawnFailed).toBe(true);
  });
});
