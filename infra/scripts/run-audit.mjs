#!/usr/bin/env node
/**
 * Run one Betriebsprüfung (§8.2) against the real CLI, and archive its report.
 *
 * This is the entry point §22 asks for at every phase close, and the one the
 * Phase 3 scheduler will call on the cadence §8.2 sets out. Until that
 * scheduler exists it is run by hand, which is why it also writes the
 * Prüfbericht into `docs/pruefberichte/` — the database row is the
 * machine-readable record, and a committed report is the one that survives a
 * throwaway test database and can be read in a diff.
 *
 * Costs subscription budget: one session at the strongest tier, which §8.2
 * makes non-negotiable ("Strongest tier, always — and exempt from the
 * Sparbetrieb downgrade. Cutting the auditor first is how a studio stops
 * noticing"). That is why it is not part of `pnpm gate`.
 *
 *   infra/scripts/run-audit.sh --domain gate_truth \
 *     --trigger phase_close --scope "Phasen 0–2, rückwirkend."
 *
 * Exit codes — chosen so the caller learns the verdict without parsing:
 *   0  unbedenklich
 *   1  funde_zu_beheben
 *   3  phase_nicht_abschliessbar (a gate was un-ticked; a phase reopened)
 *   2  infra failure — the audit could not be carried out (A25)
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { selfProjectSpec } from './audit-project.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const {
  AuditService,
  AGENT_PROFILES,
  AUDIT_DOMAIN_IDS,
  EscalationService,
  EventLog,
  HeadlessBackend,
  AgentRunner,
  ProjectService,
  TaskService,
  getAuditDomain,
  pruefberichtDateiname,
  writeRoleSettings,
} = await import(pathToFileURL(join(REPO_ROOT, 'packages/core/dist/index.js')).href);
const { createSql, migrate } = await import(
  pathToFileURL(join(REPO_ROOT, 'packages/db/dist/index.js')).href
);

function arg(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
}

const domain = arg('domain');
const trigger = arg('trigger', 'manual');
const scope = arg('scope', 'Der gesamte bisherige Bau.');
const dryRun = argv.includes('--dry-run');

if (domain && !AUDIT_DOMAIN_IDS.includes(domain)) {
  console.error(
    `run-audit — unbekannte Domäne "${domain}". Bekannt: ${AUDIT_DOMAIN_IDS.join(', ')}`,
  );
  exit(2);
}

const url = env.DATABASE_URL ?? env.TEST_DATABASE_URL;
if (!url) {
  console.error(
    'run-audit — DATABASE_URL fehlt. Für einen lokalen Lauf: infra/scripts/run-audit.sh',
  );
  exit(2);
}

const sql = createSql({ url, max: 4 });
let scratch = null;

try {
  await migrate(sql, join(REPO_ROOT, 'packages/db/migrations'));

  const eventLog = new EventLog(sql);
  const tasks = new TaskService({ sql, eventLog });
  // **Das Postfach, ohne das §8.2s schärfstes Werkzeug stumm ist.**
  //
  // `AuditService.deps.escalations` ist optional und hat einen sauberen
  // Rückfall: ohne Postfach wird der Fund mit „Kein Postfach angebunden — die
  // Entscheidung wurde nicht zugestellt" vermerkt. Nur baute *dieser* Läufer
  // den Dienst nie mit, und er ist der einzige, der Prüfungen fährt — der
  // Rückfall war also nicht der Ausnahme-, sondern der Normalfall.
  //
  // Gemessen am 18.8.2026: die Prüfung 49c549b4 entwertete P0.G5 und meldete
  // genau diesen Satz. §8.2 macht die P1-Karte zu dem Weg, auf dem der Betreiber von
  // einem entwerteten Gate erfährt — und A83.6 lässt den Un-Tick in `CLAUDE.md`
  // fail-closed scheitern, wenn kein Projektverzeichnis bekannt ist. Beide Wege
  // zum Betreiber waren damit gleichzeitig zu: die Datei wurde nicht geschrieben (zu
  // Recht) und die Karte nicht gestellt (zu Unrecht). Die Entwertung überlebte
  // nur, weil ein Mensch die Ausgabe des Laufs gelesen hat.
  //
  // Das ist A83.5s Mechanismus ohne Aufrufer, also §8.2s sechste Domäne im
  // Departement, das sie sucht.
  const escalations = new EscalationService({ sql, eventLog });
  const projects = new ProjectService(sql);

  // A42 — Vorschicht is its own pilot, so the fix tasks a `defect` produces
  // belong to this repository's own project row. Reused if it already exists.
  //
  // The spec comes from `audit-project.mjs` rather than being written out here,
  // for two reasons that are both defects this line used to have: `REPO_ROOT` is
  // a Windows path on the build machine and `projects.root_path` is declared
  // `CHECK (root_path LIKE '/%')`, so the auditor could not start here at all;
  // and the spec omitted `readOnly`, which the column defaults to false, while
  // the daemon's own path has set it since A85. Both are pinned by
  // `audit-project.test.ts`, including the drift between the two creation paths.
  const existing = await projects.getBySlug('vorschicht').catch(() => null);
  const spec = selfProjectSpec(REPO_ROOT);
  if (!existing && spec === null) {
    console.error(
      `run-audit — der Repository-Pfad „${REPO_ROOT}" lässt sich nicht als ` +
        `projects.root_path darstellen (0001 verlangt einen POSIX-absoluten Pfad).
` +
        `Lege die Projektzeile einmalig von Hand an oder fahre den Lauf von einem ` +
        `Pfad aus, der sich abbilden lässt. Geraten wird hier nichts: diese Zeile ` +
        `hält fest, welches Repository geprüft wurde.`,
    );
    exit(2);
  }
  const project = existing ?? (await projects.create(spec));

  scratch = await mkdtemp(join(tmpdir(), 'vorschicht-audit-'));
  // §8.2 independence rule 2: a scratch cwd, never a worktree — a repository
  // must not be able to instruct its own auditor through a CLAUDE.md that
  // loads as system context.
  const scratchCwd = join(scratch, 'pruefung');
  await mkdir(scratchCwd, { recursive: true });
  await writeRoleSettings(join(scratch, 'claude'), {
    hookEntry: join(REPO_ROOT, 'packages/core/dist/hook-entry.js'),
  });

  const runner = new AgentRunner({
    sql,
    eventLog,
    backend: new HeadlessBackend(),
    paths: {
      roleSettingsDir: join(scratch, 'claude'),
      runsRoot: join(scratch, 'runs'),
      // **Nicht** in den Wegwerf-Ordner (A150). Bis zum 25.8.2026 stand hier
      // `join(scratch, 'transcripts')`, und der `finally`-Block löscht `scratch`
      // — das Transkript jeder Betriebsprüfung war also weg, sobald sie fertig
      // war, während `agent_runs.transcript_path` weiter darauf zeigte.
      //
      // Gefunden hat es `restore-probe.sh` beim ersten Lauf gegen den Produktionshost: zwei
      // von sechzehn Läufen zeigten auf `/tmp/vorschicht-audit-…`, also auf
      // Pfade, die es nicht mehr gibt und die in keiner Sicherung liegen. §6.2
      // verlangt „a **copy** of the session JSONL transcript into the
      // transcripts volume", und A14 sichert genau dieses Volume, damit §1
      // Grundsatz 4 einen Plattenverlust überlebt. Für das eine Departement,
      // dessen Berichte auf ihre Sitzungen verweisen, galt beides nicht.
      //
      // Der **Rest** von `scratch` bleibt, wo er ist: §8.2s Unabhängigkeitsregel
      // 2 verlangt ein Wegwerf-Arbeitsverzeichnis, damit ein Repository seinen
      // eigenen Prüfer nicht über sein `CLAUDE.md` anweisen kann. Das
      // Transkript ist Beweismittel und gehört nicht dazu.
      transcriptsRoot:
        env.VORSCHICHT_TRANSCRIPTS_ROOT ?? `${env.VORSCHICHT_DATA_ROOT ?? '/data'}/transcripts`,
      mcpServerEntry: null,
    },
    onWarning: (message) => console.warn(`  ! ${message}`),
  });

  const service = new AuditService({
    sql,
    eventLog,
    runner,
    tasks,
    escalations,
    projectId: project.id,
    repoRoot: REPO_ROOT,
    scratchDir: scratchCwd,
    specPath: join(REPO_ROOT, 'CLAUDE.md'),
    onWarning: (message) => console.warn(`  ! ${message}`),
  });

  const chosen = domain ?? (await service.selectDomain(trigger));
  console.log(`Betriebsprüfung — Domäne ${chosen} (${getAuditDomain(chosen).label})`);
  console.log(`  Anlass: ${trigger}`);
  console.log(`  Umfang: ${scope}`);
  console.log(`  Modell: ${AGENT_PROFILES.auditor.tier} (§8.2: nie herabgestuft)`);
  if (dryRun) {
    // Everything except the session: the evidence, the sample, the prompt. Used
    // to see what an audit *would* examine without spending budget on it.
    const evidence = await getAuditDomain(chosen).collect({
      repoRoot: REPO_ROOT,
      sql,
      exec: async () => ({ code: null, stdout: '', stderr: '', spawnFailed: true }),
    });
    console.log(`  Kandidatenpool: ${evidence.pool.length}`);
    console.log(`  Einschränkungen: ${evidence.limits.length}`);
    for (const limit of evidence.limits) console.log(`    - ${limit}`);
    exit(0);
  }

  const audit = await service.run({ trigger, scope, domain: chosen });

  if (audit.outcome === 'failed') {
    console.error(`\nDie Prüfung konnte nicht durchgeführt werden: ${audit.problem}`);
    exit(2);
  }

  /*
   * Der Name kommt aus `@vorschicht/core`, weil er dieselbe Kürzung der Id
   * benutzen muss wie die Überschrift des Berichts — und weil die Begründung
   * dort steht, wo ein Test sie halten kann. Kurz: `<datum>-<domäne>.md` war
   * nicht eindeutig, ein Phasenabschluss zieht immer `gate_truth` (A56.1), und
   * am 2.8.2026 hat der Phase-4-Bericht den der Phase 3 überschrieben.
   *
   * `flag: 'wx'`: die Id macht eine Kollision praktisch unmöglich, und wenn
   * doch eine einträte, soll der Lauf **scheitern** statt einen älteren
   * Bericht zu ersetzen. Nach §8.2 ist die eingecheckte Datei der dauerhafte
   * Teil des Nachweises — überschreiben heißt hier löschen.
   */
  const dir = join(REPO_ROOT, 'docs/pruefberichte');
  await mkdir(dir, { recursive: true });
  const path = join(
    dir,
    pruefberichtDateiname({
      auditId: audit.id,
      date: new Date().toISOString().slice(0, 10),
      domain: chosen,
    }),
  );
  await writeFile(path, `${audit.report}\n`, { encoding: 'utf8', flag: 'wx' });

  console.log(`\nUrteil: ${audit.verdict}`);
  console.log(`Funde: ${audit.findings.length} · Nicht prüfbar: ${audit.scopeLimits.length}`);
  for (const finding of audit.findings) {
    console.log(`  [${finding.class}] ${finding.summary}`);
    console.log(`      ${finding.applied}`);
  }
  if (audit.unticked.length > 0) {
    console.log(`\nEntwertete Gates: ${audit.unticked.join(', ')} — die Phase ist wieder offen.`);
  }
  for (const card of audit.escalations)
    console.log(`\nEntscheidung für den Betreiber: ${card.question}`);
  console.log(`\nPrüfbericht: ${path}`);

  exit(audit.verdict === 'unbedenklich' ? 0 : audit.verdict === 'funde_zu_beheben' ? 1 : 3);
} catch (error) {
  console.error(`run-audit — ${error instanceof Error ? error.stack : String(error)}`);
  exit(2);
} finally {
  await sql.end().catch(() => undefined);
  if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
