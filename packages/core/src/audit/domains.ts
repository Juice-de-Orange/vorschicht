/**
 * §8.2's audit programme — the eight domains, as data.
 *
 * Not a `switch` in the service, for the same reason §8's profiles are a table:
 * a domain is a *question plus where its evidence comes from*, and the two
 * belong in one place where adding a ninth is one entry rather than three edits
 * scattered through a run loop.
 *
 * Every collector obeys the same three rules.
 *
 * **It gathers, it does not judge.** A collector produces a candidate pool and
 * a brief; whether what is in them is wrong is the auditor's question and
 * nobody else's. The moment a collector starts pre-filtering "the interesting
 * ones", the audit is examining a view the studio built of itself — which is
 * the exact failure §8.2 exists to prevent.
 *
 * **An empty pool is a scope limit, never a clean result.** §8.2: "an
 * unexamined area is not a clean one." A collector that finds no merges in the
 * event log says so and the report carries it; it does not return an empty list
 * that reads downstream as "nothing wrong here".
 *
 * **Domain 5 executes.** "Do the §6.6 hooks actually deny, today, on the pinned
 * CLI? Executed, not read." The auditor cannot run it — its whitelist grants no
 * such shell — so the collector runs it and hands over the exit code and the
 * output it actually produced. That asymmetry is deliberate: the auditor stays
 * read-only (independence rule 1) and still gets executed evidence.
 */
import { execFile } from 'node:child_process';
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { promisify } from 'node:util';
import { EVENT_KINDS } from '../event-log.js';
import type { Queryable } from '../sql.js';
import { gateCounts, parseAssumptions, parseGateBook } from './gate-book.js';

const exec = promisify(execFile);

export const AUDIT_DOMAIN_IDS = [
  'gate_truth',
  'claim_vs_evidence',
  'test_substance',
  'assumption_revision',
  'containment_boundaries',
  'dead_wiring',
  'process_compliance',
  'number_reconciliation',
] as const;
export type AuditDomainId = (typeof AUDIT_DOMAIN_IDS)[number];

/** What one domain's collector produced. */
export interface DomainEvidence {
  /** Stable identifiers the sample is drawn from. */
  pool: string[];
  /**
   * Evidence the prompt carries verbatim.
   *
   * Read *for* the auditor rather than *instead of* it: these are the rows and
   * lines it would otherwise spend turns collecting, and it is told to verify
   * anything load-bearing itself with its own tools.
   */
  brief: string[];
  /** What this domain could not examine, and why (§8.2's `scope_limit`). */
  limits: string[];
}

export interface EvidenceContext {
  /** The repository under examination. Read-only here, always. */
  repoRoot: string;
  sql: Queryable;
  /**
   * Runs one command and returns its exit code and output.
   *
   * Injected so domain 5's real check can be stood in for in tests — the real
   * one drives a model session and costs money. Never a shell.
   */
  exec(file: string, args: string[], opts?: { timeoutMs?: number }): Promise<CommandOutput>;
}

export interface CommandOutput {
  code: number | null;
  stdout: string;
  stderr: string;
  /** The binary could not be started at all — nothing was checked (A50). */
  spawnFailed: boolean;
}

export interface AuditDomain {
  id: AuditDomainId;
  /** §8.2's table, verbatim. English — it goes into the role's prompt. */
  question: string;
  /** German label for the Prüfbericht and the dashboard (§2). */
  label: string;
  /** How many items a run of this domain examines. */
  sampleSize: number;
  collect(context: EvidenceContext): Promise<DomainEvidence>;
  /**
   * Evidence for the items actually drawn, gathered after the sample exists.
   *
   * `collect` runs before the draw and therefore cannot know what will be
   * examined; this hook runs after it and can fetch the one thing the pool
   * could not carry — the diff of a sampled commit, say. It exists because the
   * auditor has no shell git of its own (A56): its session runs in a scratch
   * directory that belongs to no repository, so anything git has to say has to
   * be run here and quoted, with the command named beside its output.
   */
  detail?(context: EvidenceContext, items: readonly string[]): Promise<string[]>;
}

/** Default: 15 minutes. Domain 5 drives a real session and needs the room. */
const CHECK_TIMEOUT_MS = 15 * 60_000;

/** `execFile` with no shell, no throw on non-zero, and the code as the answer. */
export async function runCommand(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs = CHECK_TIMEOUT_MS,
): Promise<CommandOutput> {
  try {
    const { stdout, stderr } = await exec(file, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CI: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    return { code: 0, stdout, stderr, spawnFailed: false };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    return {
      code: typeof err.code === 'number' ? err.code : null,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message,
      spawnFailed: typeof err.code === 'string',
    };
  }
}

// --- shared readers ---------------------------------------------------------

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

/** How often `needle` appears in `haystack`. Plain text, no regex escaping. */
function occurrences(haystack: string, needle: string): number {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/** The last `count` lines of an output, for a brief that must stay readable. */
function tail(text: string, count: number): string[] {
  return text
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-count);
}

/**
 * Source files of this repository, excluding tests and build output.
 *
 * `dist` matters more than it looks: every workspace package ships a compiled
 * copy of its own source, so a corpus that included it would find every export
 * referenced at least twice and domain 6 would report nothing, forever.
 */
const SOURCE_ROOTS = ['packages', 'apps', 'infra'];
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', '.turbo', 'test-results']);
const SOURCE_EXT = /\.(ts|tsx|mjs|js)$/;
const TEST_FILE = /\.(test|itest|spec)\.[cm]?tsx?$/;

/**
 * Remove comments and string literals, so that identifier counting sees code.
 *
 * Patterns rather than a parser, deliberately: this runs over ~2 MB before
 * every audit of the dead-wiring domain, and the consequence of a mistake is
 * one entry in a suspicion pool. Where the two directions conflict it strips
 * *more* — a template literal goes whole, interpolations included — because a
 * false suspicion costs a slot in an eight-item sample while a missed dead path
 * costs the domain its purpose.
 *
 * Block comments go first: a comment may contain a quote. `://` is spared so
 * that a URL inside surviving code does not swallow the rest of its line.
 */
export function stripCodeNoise(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/`(?:[^`\\]|\\[\s\S])*`/g, ' ')
    .replace(/'(?:[^'\\\n]|\\.)*'/g, ' ')
    .replace(/"(?:[^"\\\n]|\\.)*"/g, ' ');
}

async function walk(root: string, out: string[] = []): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.claude') continue;
    if (SKIP_DIRS.has(entry.name)) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) await walk(path, out);
    else if (SOURCE_EXT.test(entry.name)) out.push(path);
  }
  return out;
}

async function sourceFiles(repoRoot: string): Promise<string[]> {
  const files: string[] = [];
  for (const root of SOURCE_ROOTS) files.push(...(await walk(join(repoRoot, root))));
  return files.sort();
}

// --- the eight --------------------------------------------------------------

const gateTruth: AuditDomain = {
  id: 'gate_truth',
  label: 'Gate-Wahrheit',
  question:
    "Does a ticked exit gate's cited evidence actually establish what the tick claims? " +
    'Does the named test exist and assert that? Does the demo script assert, or does it ' +
    'print and exit 0?',
  sampleSize: 6,
  async collect({ repoRoot }) {
    const spec = await readOptional(join(repoRoot, 'CLAUDE.md'));
    if (!spec) {
      return {
        pool: [],
        brief: [],
        limits: ['CLAUDE.md war nicht lesbar — es konnte kein einziges Gate geprüft werden.'],
      };
    }
    const gates = parseGateBook(spec).filter((gate) => gate.state !== 'open');
    const counts = gateCounts(parseGateBook(spec));
    return {
      pool: gates.map((gate) => gate.id),
      brief: [
        `Gates insgesamt: ${counts.green} grün, ${counts.deferred} verschoben, ${counts.open} offen.`,
        '',
        'Angehakte Gates (Id · Zustand · Text mit dem angeführten Beleg):',
        ...gates.map((gate) => `${gate.id} [${gate.state}] ${gate.text}`),
      ],
      limits:
        gates.length === 0 ? ['Kein angehaktes Gate vorhanden — es gab nichts zu prüfen.'] : [],
    };
  },
};

const claimVsEvidence: AuditDomain = {
  id: 'claim_vs_evidence',
  label: 'Behauptung gegen Beleg',
  question:
    'Sampled claims from README.md, CHANGELOG.md, commit messages and agent-run summaries, ' +
    'checked against the repository and the event log. "Verified on the production host" must point at a run.',
  sampleSize: 8,
  async collect({ repoRoot, exec: run, sql }) {
    const limits: string[] = [];
    const log = await run('git', ['log', '-n', '80', '--format=%h\t%s', '--no-merges']);
    const commits = log.code === 0 ? tail(log.stdout, 80) : [];
    if (log.code !== 0) limits.push(`git log war nicht ausführbar: ${log.stderr.trim()}`);

    const state = await readOptional(join(repoRoot, 'README.md'));
    const changelog = await readOptional(join(repoRoot, 'CHANGELOG.md'));
    if (!state) limits.push('README.md war nicht lesbar.');
    if (!changelog) limits.push('CHANGELOG.md war nicht lesbar.');

    // The event log is the counter-evidence: a claim of "verified on the production host"
    // has to correspond to a run somebody can point at (§8.2 domain 2).
    const runs = await sql<Array<{ role: string; n: string; last: Date | null }>>`
      SELECT role, count(*)::text AS n, max(created_at) AS last
      FROM agent_runs GROUP BY role ORDER BY role
    `.catch(() => []);

    return {
      pool: commits.map((line) => line.split('\t')[0] ?? '').filter(Boolean),
      brief: [
        'Commits (Kurz-SHA und Betreff), neueste zuerst:',
        ...commits,
        '',
        'Agentenläufe im Ereignisprotokoll, nach Rolle:',
        ...(runs.length > 0
          ? runs.map(
              (row) => `${row.role}: ${row.n} Läufe, zuletzt ${row.last?.toISOString() ?? '—'}`,
            )
          : ['(keine)']),
        '',
        'README.md und CHANGELOG.md liegen im Repository und sind zu lesen.',
      ],
      limits,
    };
  },
  async detail({ exec: run }, items) {
    const out: string[] = [];
    for (const sha of items) {
      const show = await run('git', [
        'show',
        '--stat',
        '--format=%H%n%an <%ae>%n%ad%n%n%B',
        '--no-patch',
        sha,
      ]);
      out.push(
        `$ git show --stat --no-patch ${sha}`,
        show.code === 0 ? show.stdout.trim() : `(fehlgeschlagen: ${show.stderr.trim()})`,
        '',
      );
    }
    return out;
  },
};

const testSubstance: AuditDomain = {
  id: 'test_substance',
  label: 'Substanz der Tests',
  question:
    'Could this test ever fail? Break what it covers — does it go red? A test that passes ' +
    'against a broken implementation is a liability, not coverage.',
  sampleSize: 5,
  async collect({ repoRoot }) {
    const files = (await sourceFiles(repoRoot))
      .filter((path) => TEST_FILE.test(path))
      .map((path) => relative(repoRoot, path));
    const sizes = await Promise.all(
      files.map(async (path) => {
        const info = await stat(join(repoRoot, path)).catch(() => null);
        return { path, bytes: info?.size ?? 0 };
      }),
    );
    return {
      pool: files,
      brief: [
        `Testdateien: ${files.length}.`,
        '',
        'Pfad · Größe in Bytes:',
        ...sizes.map((entry) => `${entry.path} · ${entry.bytes}`),
      ],
      limits:
        files.length === 0
          ? ['Keine Testdateien gefunden — die Domäne konnte nichts prüfen.']
          : [
              'Ob ein Test rot wird, wenn man das Geprüfte kaputt macht, lässt sich nur ' +
                'durch Lesen beurteilen: der Prüfer darf nichts verändern und nichts ausführen.',
            ],
    };
  },
};

const assumptionRevision: AuditDomain = {
  id: 'assumption_revision',
  label: 'Annahmen',
  question:
    'Appendix A items were decided under conditions that may have expired. Is that ' +
    'assumption still true today? An assumption nobody revisits is a decision that quietly ' +
    'stopped being true.',
  sampleSize: 6,
  async collect({ repoRoot }) {
    const spec = await readOptional(join(repoRoot, 'CLAUDE.md'));
    if (!spec) {
      return { pool: [], brief: [], limits: ['CLAUDE.md war nicht lesbar.'] };
    }
    const assumptions = parseAssumptions(spec);
    return {
      pool: assumptions.map((entry) => entry.id),
      brief: [
        `Annahmen in Anhang A: ${assumptions.length}.`,
        '',
        ...assumptions.map((entry) => `${entry.id} — ${entry.headline}`),
        '',
        'Der volle Wortlaut steht in CLAUDE.md, Anhang A. Für jede geprüfte Annahme gilt: ' +
          'Gelten ihre Voraussetzungen heute noch, und lässt sich das belegen?',
      ],
      limits: [],
    };
  },
};

const containmentBoundaries: AuditDomain = {
  id: 'containment_boundaries',
  label: 'Containment-Grenzen',
  question:
    'Do the §6.6 hooks actually deny, today, on the pinned CLI? Executed, not read. ' +
    'This is the class `--setting-sources project` lived in.',
  sampleSize: 3,
  async collect({ repoRoot, exec: run }) {
    // Executed on the auditor's behalf: it has no shell that could do this, and
    // §8.2 requires the answer to come from a run rather than from a reading.
    const result = await run('pnpm', ['-s', 'check:hook-containment'], {
      timeoutMs: CHECK_TIMEOUT_MS,
    });
    const limits: string[] = [];
    if (result.spawnFailed) {
      limits.push(
        'Die Containment-Prüfung konnte nicht gestartet werden (pnpm nicht vorhanden). ' +
          'Damit ist über die Hooks heute nichts belegt — weder gut noch schlecht.',
      );
    }
    const settings = await readOptional(join(repoRoot, 'packages/core/src/role-settings.ts'));
    return {
      pool: ['write_outside_worktree', 'write_outside_claims', 'read_credentials'],
      brief: [
        `Kommando: pnpm check:hook-containment (in ${repoRoot})`,
        `Exit-Code: ${result.code ?? 'kein Code — Prozess nicht gestartet'}`,
        '',
        'Letzte Ausgabezeilen:',
        ...tail(`${result.stdout}\n${result.stderr}`, 40),
        '',
        settings
          ? 'Die Hook-Definitionen stehen in packages/core/src/role-settings.ts und die ' +
            'Entscheidungslogik in packages/shared/src/containment.ts.'
          : 'packages/core/src/role-settings.ts war nicht lesbar.',
      ],
      limits,
    };
  },
};

const deadWiring: AuditDomain = {
  id: 'dead_wiring',
  label: 'Tote Verdrahtung',
  question:
    'Handlers with no producer, events never emitted, config never read, branches that ' +
    'cannot be reached. A signal path that cannot carry a signal is worse than a missing ' +
    'one, because it reads as covered.',
  sampleSize: 8,
  async collect({ repoRoot }) {
    const files = await sourceFiles(repoRoot);
    if (files.length === 0) {
      return { pool: [], brief: [], limits: ['Keine Quelldateien gefunden.'] };
    }

    // Production and test text are counted **separately**, and that separation
    // is the whole substance of this collector.
    //
    // It used to be one corpus that test files were pushed into before being
    // skipped for *declaration* capture — so a name referenced only from its
    // own test read as used. The largest instance of exactly the defect this
    // domain exists to find was therefore invisible to it: `JobQueue` was 298
    // lines with unit and integration tests against a real Postgres, wired into
    // nothing (`new JobQueue` appeared nowhere outside tests), while three
    // comments still said pg-boss carried the studio's work. Nine occurrences,
    // never reported. A detector blind to its own headline case is the thing it
    // is looking for.
    //
    // That case is closed: the daemon constructs a `JobQueue` and hands it to
    // the guardian through `WorkGate` (§7.2, §4), and the three comments were
    // corrected rather than deleted. Kept here in the past tense because it is
    // the example that shaped this collector, and a detector whose reasoning
    // cites a defect nobody can look up any more is harder to trust than one
    // that says which finding it was built from.
    // Second correction, found by running the first against this repository:
    // the tokeniser counted **prose**. Every one of `JobQueue`'s six production
    // occurrences is a comment or an error string — including, at the time,
    // this very comment, which pushed its count up and made it *less*
    // detectable. So identifiers are counted over code with comments and string
    // literals removed. `unusedKinds` below deliberately keeps the raw text: it
    // searches for literals, which is the one thing stripping destroys.
    const prodCorpus: string[] = [];
    const prodCode: string[] = [];
    const testCode: string[] = [];
    const declarations = new Map<string, string>();
    for (const path of files) {
      const raw = await readOptional(path);
      if (raw === null) continue;
      const text = stripCodeNoise(raw);
      if (TEST_FILE.test(path)) {
        testCode.push(text);
        continue;
      }
      prodCorpus.push(raw);
      prodCode.push(text);
      for (const match of text.matchAll(
        /export\s+(?:declare\s+)?(?:async\s+)?(?:function|class|const|let|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g,
      )) {
        const name = match[1];
        if (name && !declarations.has(name)) declarations.set(name, relative(repoRoot, path));
      }
    }

    // One tokenising pass rather than one regex per name: ~600 exported names
    // against ~2 MB of source is the difference between a second and a minute,
    // and this collector runs before every audit of this domain.
    const tally = (corpus: readonly string[]): Map<string, number> => {
      const counts = new Map<string, number>();
      for (const text of corpus) {
        for (const match of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
          const token = match[0];
          counts.set(token, (counts.get(token) ?? 0) + 1);
        }
      }
      return counts;
    };
    const prodCounts = tally(prodCode);
    const testCounts = tally(testCode);

    // Two classes, because they mean different things to whoever reads the
    // report. Unreferenced is "nothing uses this at all". Test-only is worse in
    // the way that matters here: it is covered, it is green, and it is not
    // connected — which is precisely how it reads as done.
    const unreferenced: string[] = [];
    const testOnly: string[] = [];
    for (const [name, file] of [...declarations.entries()].sort()) {
      if ((prodCounts.get(name) ?? 0) > 1) continue;
      // The pool entry keeps its `file:name` shape whichever class it is in:
      // §8.2 records the sample so a later audit can re-check the same items,
      // and a changed identifier would silently break that continuity.
      ((testCounts.get(name) ?? 0) > 0 ? testOnly : unreferenced).push(`${file}:${name}`);
    }

    // Event kinds are string literals, which the identifier tokeniser never
    // sees whole — so these are searched as text. Two occurrences is the
    // baseline: the declaration in `EVENT_KINDS` plus one writer. One means the
    // kind exists and nothing can ever emit it (the `tool_use` class, A53).
    // Counted over production text alone for the same reason as above: a kind
    // only ever emitted from a test cannot be emitted in operation.
    const unusedKinds = EVENT_KINDS.filter(
      (kind) => prodCorpus.reduce((n, text) => n + occurrences(text, `'${kind}'`), 0) < 2,
    );

    return {
      pool: [...unreferenced, ...testOnly, ...unusedKinds.map((kind) => `event_kind:${kind}`)],
      brief: [
        `Quelldateien durchsucht: ${files.length} (davon ${testCode.length} Testdateien). ` +
          `Exportierte Namen: ${declarations.size}. Kommentare und Zeichenketten sind vor ` +
          'dem Zählen entfernt worden — Prosa über einen Namen ist keine Benutzung.',
        '',
        'Exportierte Namen, die im Produktivcode genau einmal vorkommen — also nur dort, ' +
          'wo sie definiert werden — und auch in keinem Test. Das ist ein Verdacht, kein ' +
          'Befund: ein Name kann über einen Barrel-Export, dynamisch oder von außerhalb ' +
          'dieses Baumes benutzt werden.',
        ...(unreferenced.length > 0 ? unreferenced : ['(keine)']),
        '',
        'Exportierte Namen, die **nur von Tests** referenziert werden. Im Produktivcode ' +
          'steht jeder von ihnen genau einmal: an seiner Definition. Sie sind getestet und ' +
          'grün und an nichts angeschlossen — die Form, die sich als erledigt liest. ' +
          'Gegenprobe für jeden: gibt es einen Aufruf außerhalb von *.test.ts / *.itest.ts?',
        ...(testOnly.length > 0 ? testOnly : ['(keine)']),
        '',
        'Ereignisarten aus EVENT_KINDS, die im Produktivcode nirgends als Literal ' +
          'auftauchen — also im Betrieb nie geschrieben werden können:',
        ...(unusedKinds.length > 0 ? unusedKinds : ['(keine)']),
      ],
      limits: [
        'Statische Suche über Bezeichner: dynamische Aufrufe, Reflexion und Konfiguration ' +
          'aus der Datenbank sind darin nicht sichtbar.',
        'Ein Name, der über einen Barrel-Export namentlich weitergereicht wird ' +
          '(export { X } from …), zählt dort als zweites Vorkommen und fällt aus beiden ' +
          'Listen heraus. Ein `export *` nennt ihn nicht und stört deshalb nicht.',
        'Kommentare und Zeichenketten werden mit Mustern entfernt, nicht mit einem Parser. ' +
          'Im Zweifel wird zu viel entfernt: ein Name, der nur in einer interpolierten ' +
          'Zeichenkette steht, erscheint dann als Verdacht. Das ist die gewollte Richtung — ' +
          'ein Verdacht zu viel kostet einen Platz in der Stichprobe, ein übersehener ' +
          'toter Pfad kostet den Zweck dieser Domäne.',
      ],
    };
  },
};

const processCompliance: AuditDomain = {
  id: 'process_compliance',
  label: 'Verfahrenstreue',
  question:
    'Did every merge really pass its gates? Is there a commit with no gate run in the ' +
    'event log? Was anything pushed red? Did a gate go red → green with no code change ' +
    'in between?',
  sampleSize: 6,
  async collect({ sql }) {
    const limits: string[] = [];
    const merges = await sql<
      Array<{
        id: string;
        task_id: string | null;
        occurred_at: Date;
        payload: Record<string, unknown>;
      }>
    >`
      SELECT id::text, task_id::text, occurred_at, payload
      FROM event_log WHERE kind = 'merge.finished'
      ORDER BY id DESC LIMIT 50
    `.catch((error: Error) => {
      limits.push(`Ereignisprotokoll nicht lesbar: ${error.message}`);
      return [];
    });

    const gateRuns = await sql<
      Array<{ task_id: string | null; verdict: string | null; n: string }>
    >`
      SELECT task_id::text, payload ->> 'verdict' AS verdict, count(*)::text AS n
      FROM event_log WHERE kind = 'gate.finished'
      GROUP BY task_id, payload ->> 'verdict'
    `.catch(() => []);

    const byTask = new Map<string, string[]>();
    for (const row of gateRuns) {
      const key = row.task_id ?? '—';
      byTask.set(key, [...(byTask.get(key) ?? []), `${row.verdict ?? '?'}×${row.n}`]);
    }

    if (merges.length === 0) {
      limits.push(
        'Es gibt noch keinen einzigen `merge.finished`-Eintrag: die Merge-Queue ist gebaut ' +
          'und getestet, aber im Betrieb noch nie gelaufen. Über die Verfahrenstreue im ' +
          'Betrieb sagt diese Prüfung deshalb nichts.',
      );
    }

    return {
      pool: merges.map((row) => `merge:${row.id}`),
      brief: [
        `merge.finished-Einträge: ${merges.length}.`,
        ...merges.map(
          (row) =>
            `merge:${row.id} · Task ${row.task_id ?? '—'} · ${row.occurred_at.toISOString()} · ` +
            `${JSON.stringify(row.payload).slice(0, 240)}`,
        ),
        '',
        'gate.finished je Task (Urteil × Anzahl):',
        ...(byTask.size > 0
          ? [...byTask.entries()].map(([task, verdicts]) => `${task}: ${verdicts.join(', ')}`)
          : ['(keine)']),
        '',
        'Die Frage lautet: gibt es einen Merge ohne vorangehenden grünen Gate-Lauf für ' +
          'denselben Task?',
      ],
      limits,
    };
  },
};

const numberReconciliation: AuditDomain = {
  id: 'number_reconciliation',
  label: 'Zahlenabgleich',
  question:
    "Do the weekly report's headline numbers reconcile with the event log, recomputed " +
    'independently? Do the usage windows reconcile with the token cross-check?',
  sampleSize: 4,
  async collect({ repoRoot, sql, exec: run }) {
    const limits: string[] = [];
    const reports = await sql<
      Array<{
        id: string;
        reported_at: Date;
        phase: string;
        gates_green: number;
        gates_deferred: number;
        gates_open: number;
        commits: number;
      }>
    >`
      SELECT id::text, reported_at, phase, gates_green, gates_deferred, gates_open, commits
      FROM build_reports ORDER BY id DESC LIMIT 10
    `.catch((error: Error) => {
      limits.push(`build_reports nicht lesbar: ${error.message}`);
      return [];
    });

    const spec = await readOptional(join(repoRoot, 'CLAUDE.md'));
    const counts = spec ? gateCounts(parseGateBook(spec)) : null;
    if (!counts)
      limits.push('CLAUDE.md war nicht lesbar — Gates konnten nicht nachgezählt werden.');

    const commitCount = await run('git', ['rev-list', '--count', 'HEAD']);
    const windows = await sql<Array<{ window: string; used_percent: string; source: string }>>`
      SELECT DISTINCT ON (window) window, used_percent::text, source
      FROM usage_samples ORDER BY window, sampled_at DESC
    `.catch(() => []);

    if (reports.length === 0) {
      limits.push(
        'Es liegt noch kein build_reports-Eintrag vor, gegen den gerechnet werden könnte.',
      );
    }

    return {
      pool: reports.map((row) => `report:${row.id}`),
      brief: [
        'Gemeldete Zahlen (build_reports), neueste zuerst:',
        ...(reports.length > 0
          ? reports.map(
              (row) =>
                `report:${row.id} · ${row.reported_at.toISOString()} · ${row.phase} · ` +
                `grün ${row.gates_green} / verschoben ${row.gates_deferred} / offen ${row.gates_open} · ` +
                `Commits ${row.commits}`,
            )
          : ['(keine)']),
        '',
        'Unabhängig nachgerechnet:',
        counts
          ? `CLAUDE.md heute: grün ${counts.green} / verschoben ${counts.deferred} / offen ${counts.open}`
          : 'Gates: nicht nachzählbar',
        `git rev-list --count HEAD: ${commitCount.code === 0 ? commitCount.stdout.trim() : 'nicht ermittelbar'}`,
        '',
        'Letzte Fenster-Messwerte (§7.1):',
        ...(windows.length > 0
          ? windows.map((row) => `${row.window}: ${row.used_percent}% (Quelle: ${row.source})`)
          : ['(keine)']),
        '',
        'Achtung auf die Zeitrichtung: eine ältere Meldung darf von der heutigen Zählung ' +
          'abweichen, wenn seither Gates dazugekommen sind. Abweichen darf sie nur so.',
      ],
      limits,
    };
  },
};

export const AUDIT_DOMAINS: Record<AuditDomainId, AuditDomain> = {
  gate_truth: gateTruth,
  claim_vs_evidence: claimVsEvidence,
  test_substance: testSubstance,
  assumption_revision: assumptionRevision,
  containment_boundaries: containmentBoundaries,
  dead_wiring: deadWiring,
  process_compliance: processCompliance,
  number_reconciliation: numberReconciliation,
};

export function getAuditDomain(id: AuditDomainId): AuditDomain {
  const domain = AUDIT_DOMAINS[id];
  if (!domain) throw new Error(`Unbekannte Prüfdomäne "${id}".`);
  return domain;
}
