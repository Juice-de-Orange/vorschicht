#!/usr/bin/env node
/**
 * §22s Phase-6-Gate G2 gegen ein **echtes, schreibbares** Projekt (A38).
 *
 *   infra/scripts/check-radar-autotask.mjs --project <slug> [--package <name>]
 *   infra/scripts/check-radar-autotask.mjs --path /opt/example-app
 *
 * Der Gate-Satz lautet: *"Radar produces a real dependency proposal on a pilot
 * repo: patch update becomes an **auto-task that passes gates**; a major update
 * lands as an MC inbox item with researched options"*.
 *
 * Die Politik selbst ist bewiesen und zwar an ihren **Abwesenheiten**:
 * `scan.itest.ts` prüft für jeden Zweig beide Hälften — ein Patch erzeugt eine
 * Aufgabe *und keine Karte*, eine Hauptversion eine Karte *und keine Aufgabe* —,
 * weil eine Suite, die nur die Anwesenheiten prüft, gegen eine Umsetzung besteht,
 * die beides für alles tut. Was dort fehlt, sind zwei Wörter des Gate-Satzes:
 * **„pilot repo"** und **„passes gates"**. Beide brauchen ein Projekt, in das
 * geschrieben werden darf, und A85 hält Vorschichts eigenes Projekt auf
 * `read_only`. A38 verschiebt so ein Gate, **wenn** die Prüfung mitgeliefert
 * wird, die es später beweist. Das ist sie.
 *
 * Neun Entscheidungen.
 *
 *  1. **Das Paar wird gefunden, nicht ins Repository geschrieben.** Der
 *     naheliegende Bau sät eine veraltete Abhängigkeit in `package.json` und
 *     committet sie — und hinterlässt damit im Repository eines Menschen einen
 *     Commit, den dieses Skript wieder wegräumen müsste. Stattdessen liest es
 *     mit **`readDependencies`** — derselben Funktion, die der Radar benutzt —
 *     was wirklich installiert ist, fragt die **echte** Registry nach der
 *     neuesten Version und nimmt das erste Paar, das nach `classifyBump` ein
 *     `patch` oder `minor` ist. Gesät wird damit nur die *Antwort der Registry*,
 *     und die Zielversion ist eine, die es wirklich gibt — was sie sein muss,
 *     denn der Coder muss sie danach installieren können.
 *
 *  2. **Die Registry wird für genau einen Namen befragt.** Ein Live-Lauf über
 *     die vollständige Abhängigkeitsliste eines echten Projekts findet auch
 *     Hauptversionen, und jede davon wäre nach A10 eine **Karte im Posteingang
 *     eines Menschen** — als Nebenwirkung einer Prüfung. Die Zusicherung „genau
 *     eine Aufgabe und keine Karte" wäre dann außerdem keine Aussage über die
 *     Politik, sondern eine über den Zufall, welche Pakete das Projekt gerade
 *     hinterherhinkt. Der Kanal antwortet deshalb nur für das gewählte Paket;
 *     alles andere ist „nicht gefragt", und `planUpdates` überspringt es.
 *
 *  3. **Abrechnungs- und CLI-Kanal werden nicht abgefragt, und das steht im
 *     Bericht.** Sie gehören zu Gate 3, das eigene Nachweise hat. Der Radar
 *     meldet einen nicht abgefragten Kanal von sich aus als ungeprüfte Fläche
 *     (`scan.ts` Entscheidung 2) — die Zeilen tauchen also im Lauf auf, statt
 *     dass hier jemand behauptet, es sei alles geprüft worden.
 *
 *  4. **Jede Aussage wird von der Quelle gelesen.** Der Zustand der Aufgabe
 *     kommt aus `task_events`, die Karten aus `escalations`, die Prüfungen aus
 *     `gate_runs`, der Merge aus `git`. Der Rückgabewert von `RadarScan.run()`
 *     wird für **keine** Zusicherung benutzt: wer eine Antwort erzeugen kann,
 *     darf nicht auch gefragt werden, ob sie stimmt (A89.4).
 *
 *  5. **„passes gates" heißt: die gesperrten sechs sind einzeln grün.** Ein
 *     `ok = true` auf dem Lauf könnte auch eine Suite bedeuten, die nichts
 *     ausgeführt hat. Geprüft wird deshalb, dass jeder Schritt aus §11s
 *     gesperrter Liste im `steps`-Feld steht und `verdict = 'ok'` trägt.
 *
 *  6. **Der Ablaufplaner wird ohne `audits` gebaut, und das ist eine
 *     Einschränkung, keine Bequemlichkeit.** `buildScheduler` verdrahtet §8.2
 *     immer, wenn es ein selbstverwaltetes Projekt gibt, und `dueAudit` liefert
 *     `weekly`, sobald die letzte Prüfung sieben Tage her ist. Eine
 *     Betriebsprüfung als Nebenwirkung einer Gate-Prüfung würde eine Sitzung der
 *     stärksten Stufe kosten, `audit_events` schreiben, womöglich ein Gate in
 *     `CLAUDE.md` entwerten und eine P1-Karte auslösen. Der Rest der
 *     Verdrahtung ist `main.ts` nachgebaut; dass sie davon abweichen könnte,
 *     steht unten in den Prüfgrenzen.
 *
 *  7. **Das Aufräumen verweigert, statt zu erzwingen** (A44.5). Der Merge
 *     verschiebt den Integrationszweig des Projekts. Zurückgesetzt wird nur,
 *     wenn der Ausgangs-Commit ein Vorfahr des jetzigen ist, der Baum sauber ist
 *     **und jeder Commit dazwischen vom Bot stammt**. Steht ein fremder Commit
 *     im Bereich, bleibt alles stehen und das Skript sagt es. Ein automatisches
 *     `--force` in einem fremden Repository ist die eine Bequemlichkeit, die
 *     Arbeit kostet statt Zeit.
 *
 *  8. **Eine nicht terminale Aufgabe wird abgebrochen, nicht liegengelassen.**
 *     `task_events` ist append-only, eine Aufgabe kann also nicht verschwinden —
 *     wohl aber ihre Claims halten und damit das Projekt serialisieren, bis
 *     jemand nachsieht (§10, §15). Der Abbruch ist der einzige Weg, der beides
 *     ehrlich hinterlässt: die Spur bleibt, die Sperre geht.
 *
 *  9. **Migriert wird nicht.** Ein Prüfskript, das die Produktionsdatenbank
 *     eines Menschen im Vorbeigehen migriert, ändert mehr als es prüft. Fehlt
 *     das Schema, verweigert es mit 2 und nennt den Daemon.
 *
 * Exit: 0 bewiesen · 1 eine Zusicherung hält nicht (das Gate hat sich falsch
 * verhalten) · 2 nichts geprüft — kein Projekt, schreibgeschützt, keine
 * Datenbank, kein Budget, keine CLI, kein passendes Paar (A25/A50).
 */
import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const {
  AgentMigrationReviewer,
  AgentRunner,
  ClaimRegistry,
  DeployRecords,
  DeployService,
  DevChain,
  EscalationService,
  EventLog,
  FindingsService,
  GateSuite,
  GuardianService,
  HeadlessBackend,
  HttpRadarFeeds,
  IntegrityCheck,
  MergeQueue,
  ProjectService,
  RadarScan,
  RunRecords,
  Scheduler,
  TaskService,
  UsageMeter,
  WorktreeManager,
  chainInfraHistory,
  classifyBump,
  readDependencies,
  taskDeployHandover,
  writeRoleSettings,
} = await import(pathToFileURL(join(REPO_ROOT, 'packages/core/dist/index.js')).href);
const { GATE_CATALOGUE, readProjectGateConfig } = await import(
  pathToFileURL(join(REPO_ROOT, 'packages/shared/dist/index.js')).href
);
const { createSql } = await import(
  pathToFileURL(join(REPO_ROOT, 'packages/db/dist/index.js')).href
);

// --------------------------------------------------------------- Argumente ---

function arg(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
}

const slug = arg('project');
const path = arg('path');
const wanted = arg('package');
const timeoutMin = Number(arg('timeout-min', '90'));
const noRestore = argv.includes('--no-restore');

/** Nichts geprüft (A25). Der Unterschied zu 1 ist der ganze Sinn dieser Codes. */
function nichtsGeprueft(satz) {
  console.error(`check-radar-autotask — ${satz}`);
  exit(2);
}

/**
 * Netz statt Befund: eine Maschine, die nicht da ist, sagt nichts über das Gate.
 *
 * Die Liste ist bewusst eng. Ein Server**fehler** von Postgres — eine fehlende
 * Spalte, eine verletzte Zusicherung — trägt `severity` und ist genau das, was
 * hier ein Fund sein muss; nur die Codes, mit denen eine Verbindung gar nicht
 * erst zustande kommt, sind „nichts geprüft".
 */
const INFRA_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'EPIPE',
  'ETIMEDOUT',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
]);

function istInfra(fehler) {
  for (let e = fehler; e; e = e.cause) {
    if (typeof e.code === 'string' && INFRA_CODES.has(e.code)) return true;
  }
  return false;
}

/** Gesetzt, wenn der Lauf an der Umgebung gescheitert ist. Siehe unten. */
let infra = null;

if (!slug && !path) {
  nichtsGeprueft(
    'es fehlt --project <slug> oder --path <verzeichnis>.\n' +
      '\n' +
      'Beispiel:\n' +
      '  infra/scripts/check-radar-autotask.mjs --project example-app\n' +
      '\n' +
      'Das Projekt muss in der Datenbank stehen, **schreibbar** sein (A85 hält\n' +
      'Vorschichts eigenes Projekt auf read_only) und Gate-Befehle konfiguriert\n' +
      'haben. Dieses Skript merged in seinen Integrationszweig.',
  );
}
if (!Number.isInteger(timeoutMin) || timeoutMin < 1) {
  nichtsGeprueft('--timeout-min muss eine ganze Zahl ≥ 1 sein.');
}

const url = env.DATABASE_URL;
if (!url) {
  nichtsGeprueft(
    'DATABASE_URL fehlt. Dieses Skript prüft gegen die Datenbank des laufenden\n' +
      'Studios — eine Wegwerf-Datenbank hätte weder das Projekt noch seine Historie.',
  );
}

// ------------------------------------------------------------------ Ausgabe ---

let gruen = 0;
let rot = 0;
const ok = (satz) => {
  console.log(`  \x1b[32m[x]\x1b[0m ${satz}`);
  gruen += 1;
};
const nein = (satz) => {
  console.log(`  \x1b[31m[ ]\x1b[0m ${satz}`);
  rot += 1;
};
const grenzen = [];

async function git(cwd, ...args) {
  const { stdout } = await execFile('git', args, { cwd, timeout: 120_000 });
  return stdout.trim();
}

/**
 * Ein Kanal, der nur für ein Paket antwortet (Entscheidung 2).
 *
 * Die Versionsauskunft ist echt — sie kommt aus derselben `HttpRadarFeeds`, die
 * der Daemon benutzt. Alles andere sagt ausdrücklich, dass es nicht abgefragt
 * wurde; der Radar macht daraus von sich aus eine Zeile unter „ungeprüfte
 * Flächen", statt dass hier jemand Entwarnung gibt (Entscheidung 3).
 */
class EinPaketKanal {
  constructor(live, name) {
    this.live = live;
    this.name = name;
  }
  async billingChannels() {
    return [];
  }
  async cliChannel() {
    return {
      live: false,
      origin: 'nicht abgefragt — dieses Skript prüft A10, nicht §6.0/A27',
      value: null,
    };
  }
  async latestVersions(names) {
    if (!names.includes(this.name)) {
      return { live: true, origin: 'auf ein Paket eingeschränkt', value: new Map() };
    }
    return this.live.latestVersions([this.name]);
  }
  async advisories() {
    return {
      live: false,
      origin: 'nicht abgefragt — Advisories sind Gate 3',
      value: [],
    };
  }
}

const sql = createSql({ url, max: 6 });
let scratch = null;
/** Was aufgeräumt werden muss, auch wenn ein Schritt geworfen hat. */
const nachlass = { project: null, preSha: null, taskIds: [] };

try {
  // --- Schema, ohne es anzulegen (Entscheidung 9) ---------------------------
  const [{ da }] = await sql`SELECT to_regclass('public.gate_runs') IS NOT NULL AS da`;
  if (!da) {
    nichtsGeprueft(
      'die Tabelle `gate_runs` fehlt — das Schema ist hinter dem Code. Dieses\n' +
        'Skript migriert nicht; starte den Orchestrator einmal, er tut es beim Start.',
    );
  }

  const projects = new ProjectService(sql);
  const alle = await projects.listActive();
  const project = slug
    ? alle.find((p) => p.slug === slug)
    : alle.find((p) => p.rootPath === path?.replace(/\/$/, ''));
  if (!project) {
    nichtsGeprueft(
      `kein aktives Projekt ${slug ? `mit dem Slug „${slug}"` : `unter „${path}"`}.\n` +
        `Bekannt sind: ${alle.map((p) => `${p.slug} (${p.rootPath})`).join(', ') || '(keine)'}`,
    );
  }
  nachlass.project = project;

  if (project.readOnly) {
    nichtsGeprueft(
      `„${project.slug}" ist schreibgeschützt. Der Ablaufplaner überspringt solche\n` +
        'Projekte (A44.3), es kann also weder eine Kette laufen noch ein Merge\n' +
        'stattfinden. Für Vorschicht selbst ist das A85 und des Betreibers Entscheidung —\n' +
        'dieses Gate braucht ein anderes Projekt.',
    );
  }

  const gateConfig = readProjectGateConfig(project.gateConfig);
  const gesperrte = GATE_CATALOGUE.filter((gate) => gate.locked);
  const ohneBefehl = gesperrte.filter(
    (gate) => gate.kind === 'command' && !gateConfig.commands[gate.id],
  );
  if (ohneBefehl.length > 0) {
    nichtsGeprueft(
      `„${project.slug}" hat für ${ohneBefehl.map((g) => g.id).join(', ')} keinen Befehl.\n` +
        'Die gesperrten sechs sind nach §11 nicht abwählbar — ohne Befehl meldet die\n' +
        'Suite sie als Fund, und „passes gates" wäre nicht prüfbar, sondern unmöglich.',
    );
  }

  // --- git: sauber, und wir merken uns, wo wir angefangen haben -------------
  let preSha;
  try {
    const dirty = await git(project.rootPath, 'status', '--porcelain');
    if (dirty !== '') {
      nichtsGeprueft(
        `der Arbeitsbaum von „${project.rootPath}" ist nicht sauber. Dieses Skript\n` +
          'merged in den Integrationszweig und könnte danach nicht mehr unterscheiden,\n' +
          'was davon vorher schon da war.',
      );
    }
    preSha = await git(project.rootPath, 'rev-parse', project.defaultBranch);
  } catch (fehler) {
    nichtsGeprueft(
      `„${project.rootPath}" ist kein lesbares git-Repository mit dem Zweig ` +
        `„${project.defaultBranch}": ${fehler.message}`,
    );
  }
  nachlass.preSha = preSha;

  // --- Budget, bevor irgendetwas eine Sitzung startet -----------------------
  const eventLog = new EventLog(sql);
  const meter = new UsageMeter({ sql, eventLog });
  const guardian = new GuardianService({
    sql,
    meter,
    eventLog,
    // Kein Notifier: eine Prüfung darf keine ntfy-Karte auslösen. Und eine
    // Warteschlange, die nichts tut — pausiert wird nur bei einem Übergang, und
    // ein Lauf, der nicht `normal` ist, endet drei Zeilen weiter unten mit 2.
    queue: { pause: async () => {}, resume: async () => {}, isPaused: false },
    activeRuns: () => [],
  });
  const entscheidung = await guardian.evaluate();
  if (entscheidung.state !== 'normal') {
    nichtsGeprueft(
      `der Wächter steht auf „${entscheidung.state}" (§7.2). Außerhalb von „normal"\n` +
        'startet der Ablaufplaner nichts — es wäre nichts geprüft, nicht etwas rot.',
    );
  }

  // --- CLI, ebenfalls vorher ------------------------------------------------
  const pin = env.CLAUDE_CLI_VERSION ?? null;
  try {
    const { stdout } = await execFile('claude', ['--version'], { timeout: 30_000 });
    if (pin && !stdout.includes(pin)) {
      nichtsGeprueft(
        `die CLI meldet „${stdout.trim()}", festgenagelt ist ${pin} (A27). Ein Lauf ` +
          'gegen eine andere Version prüft ein anderes Studio.',
      );
    }
  } catch (fehler) {
    nichtsGeprueft(`die Claude-CLI ist nicht aufrufbar: ${fehler.message}`);
  }

  // --- Entscheidung 1: ein echtes Paar finden -------------------------------
  const inventar = await readDependencies(project.rootPath);
  for (const problem of inventar.problems) grenzen.push(`Abhängigkeiten: ${problem}`);
  if (inventar.source === 'none' || inventar.dependencies.length === 0) {
    nichtsGeprueft(
      `unter „${project.rootPath}" ist weder ein lesbares \`package.json\` noch ein\n` +
        '`pnpm-lock.yaml` — es gibt nichts, woraus ein Abhängigkeitspaar entstehen könnte.',
    );
  }

  const live = new HttpRadarFeeds({ billingUrls: [], cliUrl: null });
  const kandidaten = wanted
    ? inventar.dependencies.filter((entry) => entry.name === wanted)
    : inventar.dependencies;
  if (kandidaten.length === 0) {
    nichtsGeprueft(`„${wanted}" steht nicht in den Abhängigkeiten von „${project.slug}".`);
  }

  const namen = [...new Set(kandidaten.map((entry) => entry.name))];
  const antwort = await live.latestVersions(namen);
  for (const problem of antwort.problems ?? []) grenzen.push(`Registry: ${problem}`);
  if (!antwort.live) {
    nichtsGeprueft(
      'die Registry hat in diesem Lauf nicht geantwortet — ohne echte Zielversion\n' +
        'gibt es kein Paar, das der Coder danach wirklich installieren könnte.',
    );
  }

  let paar = null;
  for (const eintrag of kandidaten) {
    const latest = antwort.value.get(eintrag.name);
    if (!latest) continue;
    const bump = classifyBump(eintrag.current, latest);
    if (bump === 'patch' || bump === 'minor') {
      paar = { name: eintrag.name, current: eintrag.current, latest, bump };
      break;
    }
  }
  if (!paar) {
    nichtsGeprueft(
      'kein Paket in diesem Projekt liegt genau eine Patch- oder Minor-Version hinter\n' +
        'der Registry. A10s Routine-Zweig ist damit nicht auslösbar — das ist ein\n' +
        'gepflegtes Projekt, kein Defekt. Nenne mit --package ein anderes Paket.',
    );
  }

  console.log(`\x1b[1mRadar-Autotask gegen „${project.slug}" (${project.rootPath})\x1b[0m`);
  console.log(`  Paar: ${paar.name} ${paar.current} → ${paar.latest} (${paar.bump})`);
  console.log(`  Integrationszweig: ${project.defaultBranch} @ ${preSha.slice(0, 10)}\n`);

  // --- Ausgangsstand, aus der Quelle ----------------------------------------
  const vorherTasks = new Set(
    (await sql`SELECT id::text FROM tasks WHERE project_id = ${project.id}`).map((r) => r.id),
  );
  const [{ karten: kartenVorher }] = await sql`SELECT count(*)::int AS karten FROM escalations`;

  // --- Die Verdrahtung (Entscheidung 6) -------------------------------------
  scratch = await mkdtemp(join(tmpdir(), 'vorschicht-radar-check-'));
  const runsRoot = join(scratch, 'runs');
  await mkdir(runsRoot, { recursive: true });
  await writeRoleSettings(join(scratch, 'claude'), {
    hookEntry: join(REPO_ROOT, 'packages/core/dist/hook-entry.js'),
  });

  const tasks = new TaskService({ sql, eventLog });
  const escalations = new EscalationService({ sql, eventLog });
  const worktrees = new WorktreeManager({
    tasks,
    projects,
    eventLog,
    root: join(scratch, 'worktrees'),
  });
  const runner = new AgentRunner({
    sql,
    eventLog,
    backend: new HeadlessBackend(),
    usage: meter,
    paths: {
      roleSettingsDir: join(scratch, 'claude'),
      runsRoot,
      transcriptsRoot: join(scratch, 'transcripts'),
      mcpServerEntry: env.VORSCHICHT_MCP_SERVER ?? join(REPO_ROOT, 'packages/mcp/dist/main.js'),
    },
    onWarning: (message) => console.warn(`  ! ${message}`),
  });
  const claims = new ClaimRegistry({ sql, tasks, projects, eventLog });
  const findings = new FindingsService({ sql });
  const runs = new RunRecords(sql);
  const devChain = new DevChain({
    tasks,
    projects,
    claims,
    worktrees,
    runner,
    runs,
    eventLog,
    findings,
    escalations,
    gateTools: (p) => readProjectGateConfig(p.gateConfig).tools,
    onWarning: (message) => console.warn(`  ! ${message}`),
  });
  const mergeQueue = new MergeQueue({
    // Leer: dieses Skript registriert kein Deploy-Ziel, also endet ein Projekt
    // mit einer Deploy-Methode vor dem Merge (§12, A55.6) — sichtbar als
    // Verweigerung statt als Merge ohne Rollout.
    deployableMethods: [],
    sql,
    tasks,
    projects,
    claims,
    worktrees,
    eventLog,
    findings,
    escalations,
    gates: (p) =>
      new GateSuite({
        sql,
        config: readProjectGateConfig(p.gateConfig),
        migrationReview: new AgentMigrationReviewer({
          runner,
          eventLog,
          onWarning: (message) => console.warn(`  ! ${message}`),
        }),
        onWarning: (message) => console.warn(`  ! ${message}`),
      }),
    onWarning: (message) => console.warn(`  ! ${message}`),
    onOpsAlert: (alert) => console.warn(`  ! Infrastruktur: ${alert.problem}`),
  });
  const integrity = new IntegrityCheck({
    tasks,
    projects,
    worktrees,
    runner,
    eventLog,
    escalations,
    onWarning: (message) => console.warn(`  ! ${message}`),
  });
  const scheduler = new Scheduler({
    tasks,
    projects,
    claims,
    guardian,
    devChain,
    mergeQueue,
    integrity,
    deploys: new DeployService({
      sql,
      records: new DeployRecords(sql),
      eventLog,
      tasks,
      escalations,
      targets: new Map(),
      guardianState: async () => (await guardian.evaluate()).state,
      run: async () => ({ ok: false, code: null, output: 'kein Deploy in dieser Prüfung' }),
    }),
    deployHandover: taskDeployHandover(sql),
    escalations,
    eventLog,
    infraHistory: chainInfraHistory(sql),
    // Entscheidung 6: kein `audits`.
    concurrency: 1,
    onWarning: (message) => console.warn(`  ! ${message}`),
  });

  // --- Der Radar ------------------------------------------------------------
  const radar = new RadarScan({
    sql,
    eventLog,
    feeds: new EinPaketKanal(live, paar.name),
    escalations,
    tasks,
    projects,
    pinnedCliVersion: pin ?? '0.0.0',
  });
  const lauf = await radar.run();
  for (const limit of lauf.limits) grenzen.push(`Radar: ${limit}`);
  for (const problem of lauf.problems) grenzen.push(`Radar-Problem: ${problem}`);

  // --- Zusicherung 1 und 2: aus der Quelle, nicht aus `lauf` ----------------
  const neue = (
    await sql`SELECT id::text, title, type, priority FROM tasks WHERE project_id = ${project.id}`
  ).filter((row) => !vorherTasks.has(row.id));
  nachlass.taskIds = neue.map((row) => row.id);
  const [{ karten: kartenNachher }] = await sql`SELECT count(*)::int AS karten FROM escalations`;

  if (neue.length === 1 && neue[0].type === 'radar') {
    ok(`A10s Routine-Zweig: genau eine Aufgabe, „${neue[0].title}"`);
  } else {
    nein(
      `erwartet war genau eine Radar-Aufgabe, entstanden sind ${neue.length} ` +
        `(${neue.map((r) => `${r.type}:${r.title}`).join(' | ') || 'keine'})`,
    );
  }
  if (kartenNachher === kartenVorher) {
    ok(
      'und **keine** Karte — ein Patch/Minor ist nach A10 nichts, was der Betreiber entscheiden muss',
    );
  } else {
    nein(`es sind ${kartenNachher - kartenVorher} Karte(n) entstanden; A10 verlangt keine`);
  }

  const task = neue.length === 1 ? neue[0] : null;
  if (!task) {
    // Ohne Aufgabe gibt es nichts zu verfolgen. Die beiden Zusicherungen oben
    // stehen bereits als Befund; der Rest wäre eine Aussage über nichts.
    grenzen.push('Ohne genau eine Aufgabe wurde die Strecke bis zum Merge nicht gefahren.');
    throw new Error('abbruch:keine-aufgabe');
  }

  // --- Zusicherung 3: die Aufgabe erreicht `done` ---------------------------
  const frist = Date.now() + timeoutMin * 60_000;
  let zustand = 'queued';
  console.log(`\n  … verfolge ${task.id} (Frist: ${timeoutMin} min)`);
  while (Date.now() < frist) {
    await scheduler.tick();
    await scheduler.settle();
    const [row] = await sql`
      SELECT state FROM task_events WHERE task_id = ${task.id} ORDER BY seq DESC LIMIT 1
    `;
    zustand = row?.state ?? zustand;
    if (zustand === 'done' || zustand === 'red' || zustand === 'escalated') break;
    if (zustand === 'aborted') break;
  }

  if (zustand === 'done') {
    ok(`die Aufgabe ist durch die Kette und die Warteschlange bis \`done\` gelaufen`);
  } else {
    nein(
      `die Aufgabe steht auf „${zustand}" statt auf „done"` +
        (Date.now() >= frist ? ' (Frist abgelaufen)' : ''),
    );
  }

  // --- Zusicherung 4: „passes gates", aus `gate_runs` (Entscheidung 5) ------
  const [gateRun] = await sql`
    SELECT ok, head_sha, base_ref, steps FROM gate_runs
    WHERE task_id = ${task.id} ORDER BY seq DESC LIMIT 1
  `;
  if (!gateRun) {
    nein('zu dieser Aufgabe steht kein einziger Lauf in `gate_runs` — die Gates liefen nicht');
  } else {
    const schritte = new Map(
      (Array.isArray(gateRun.steps) ? gateRun.steps : []).map((s) => [s.id, s.verdict]),
    );
    const fehlend = gesperrte.filter((gate) => schritte.get(gate.id) !== 'ok');
    if (gateRun.ok && fehlend.length === 0) {
      ok(
        `§11s gesperrte sechs sind einzeln grün auf ${String(gateRun.head_sha).slice(0, 10)} ` +
          `(gegen ${gateRun.base_ref}) — aus \`gate_runs\` gelesen, nicht aus dem Rückgabewert`,
      );
    } else {
      nein(
        `der jüngste Gate-Lauf ist ${gateRun.ok ? 'grün' : 'rot'}; nicht grün: ` +
          `${fehlend.map((g) => `${g.id}=${schritte.get(g.id) ?? 'fehlt'}`).join(', ') || '—'}`,
      );
    }
  }

  // --- Zusicherung 5: der Merge steht wirklich im git ----------------------
  const postSha = await git(project.rootPath, 'rev-parse', project.defaultBranch);
  if (postSha !== preSha && gateRun?.head_sha) {
    const enthalten = await git(
      project.rootPath,
      'merge-base',
      '--is-ancestor',
      String(gateRun.head_sha),
      postSha,
    )
      .then(() => true)
      .catch(() => false);
    if (enthalten) {
      ok(
        `der Integrationszweig trägt den geprüften Baum: ${preSha.slice(0, 10)} → ` +
          `${postSha.slice(0, 10)}, und ${String(gateRun.head_sha).slice(0, 10)} liegt darin`,
      );
    } else {
      nein(
        `„${project.defaultBranch}" hat sich bewegt, aber der geprüfte Baum ` +
          `${String(gateRun.head_sha).slice(0, 10)} liegt nicht darin`,
      );
    }
  } else {
    nein(
      `„${project.defaultBranch}" steht noch auf ${preSha.slice(0, 10)} — es wurde nichts gemerged`,
    );
  }
} catch (fehler) {
  if (istInfra(fehler)) {
    // Gefunden, indem der Verweigerungsweg wirklich gefahren wurde: eine
    // unerreichbare Datenbank landete hier und wurde als **Fund** gemeldet —
    // genau die Fehlklassifikation, die A50 aufschreibt. Der Code wird erst
    // nach dem Aufräumen gesetzt, weil `exit()` kein `finally` mehr ausführt.
    infra = fehler.message;
  } else if (fehler?.message !== 'abbruch:keine-aufgabe') {
    console.error(`\ncheck-radar-autotask — abgebrochen: ${fehler.stack ?? fehler.message}`);
    rot += 1;
  }
} finally {
  // --- Entscheidung 7 und 8 -------------------------------------------------
  const project = nachlass.project;
  try {
    for (const id of nachlass.taskIds) {
      const [row] = await sql`
        SELECT state FROM task_events WHERE task_id = ${id} ORDER BY seq DESC LIMIT 1
      `;
      const zustand = row?.state ?? null;
      if (zustand === null || ['done', 'aborted'].includes(zustand)) continue;
      const tasks = new TaskService({ sql, eventLog: new EventLog(sql) });
      await tasks
        .transition(id, 'aborted', {
          actor: 'check-radar-autotask',
          reason: 'Prüflauf beendet — die Aufgabe wird abgebrochen, damit sie keine Claims hält.',
        })
        .catch((e) => console.warn(`  ! Aufgabe ${id} nicht abbrechbar: ${e.message}`));
      console.log(`  · Aufgabe ${id} abgebrochen (stand auf „${zustand}")`);
    }
  } catch (e) {
    console.warn(`  ! Aufräumen der Aufgaben: ${e.message}`);
  }

  if (project && nachlass.preSha && !noRestore) {
    try {
      const jetzt = await git(project.rootPath, 'rev-parse', project.defaultBranch);
      if (jetzt === nachlass.preSha) {
        // Nichts zu tun.
      } else {
        const dirty = await git(project.rootPath, 'status', '--porcelain');
        const vorfahr = await git(
          project.rootPath,
          'merge-base',
          '--is-ancestor',
          nachlass.preSha,
          jetzt,
        )
          .then(() => true)
          .catch(() => false);
        const autoren = (
          await git(project.rootPath, 'log', '--format=%ae', `${nachlass.preSha}..${jetzt}`)
        )
          .split('\n')
          .filter(Boolean);
        const fremd = autoren.filter((mail) => !mail.includes('vorschicht'));
        if (dirty !== '') {
          console.warn(
            `  ! „${project.defaultBranch}" wird NICHT zurückgesetzt: der Arbeitsbaum ist nicht sauber.`,
          );
        } else if (!vorfahr) {
          console.warn(
            `  ! „${project.defaultBranch}" wird NICHT zurückgesetzt: ${nachlass.preSha.slice(0, 10)} ` +
              'ist kein Vorfahr des jetzigen Standes.',
          );
        } else if (fremd.length > 0) {
          console.warn(
            `  ! „${project.defaultBranch}" wird NICHT zurückgesetzt: im Bereich stehen fremde ` +
              `Commits (${[...new Set(fremd)].join(', ')}). Bitte von Hand ansehen.`,
          );
        } else {
          await git(project.rootPath, 'reset', '--hard', nachlass.preSha);
          console.log(
            `  · „${project.defaultBranch}" auf ${nachlass.preSha.slice(0, 10)} zurückgesetzt ` +
              `(${autoren.length} Bot-Commit(s) entfernt)`,
          );
        }
      }
      // Zweige des Prüflaufs: `--delete`, nie `--force` (A44.5).
      for (const id of nachlass.taskIds) {
        await git(project.rootPath, 'branch', '--delete', `vorschicht/task-${id}`).catch(
          () => undefined,
        );
      }
    } catch (e) {
      console.warn(`  ! git-Aufräumen: ${e.message}`);
    }
  } else if (noRestore) {
    console.log('  · --no-restore: der Integrationszweig bleibt, wie er ist.');
  }

  if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  await sql.end().catch(() => undefined);
}

if (infra && rot === 0) {
  // Ein bereits roter Befund schlägt das hier: „wir konnten nicht zu Ende
  // prüfen" darf eine Feststellung, die schon steht, nicht überschreiben.
  console.error(`\ncheck-radar-autotask — an der Umgebung gescheitert: ${infra}`);
  console.error('Nichts geprüft (A25) — das ist keine Feststellung über das Gate.');
  exit(2);
}

console.log('\n\x1b[1mNicht geprüft:\x1b[0m');
console.log(
  '  - Die Registry wurde für **ein** Paket befragt. Ein Lauf über alle Abhängigkeiten\n' +
    '    würde echte Hauptversionen finden und dafür echte Karten in des Betreibers Posteingang legen.',
);
console.log('  - §6.0s Abrechnungs- und A27s CLI-Kanal wurden nicht abgefragt; das ist Gate 3.');
console.log(
  '  - Der Ablaufplaner läuft ohne §8.2 (Entscheidung 6). Die Verdrahtung ist `main.ts`\n' +
    '    nachgebaut — weicht sie ab, prüft dieses Skript ein anderes Studio als der Daemon.',
);
console.log('  - Kein Deploy-Ziel registriert: die Strecke endet am Merge, nicht am Rollout.');
for (const limit of grenzen) console.log(`  - ${limit}`);

console.log(`\n\x1b[1mErgebnis:\x1b[0m ${gruen} grün · ${rot} rot`);
exit(rot === 0 && gruen > 0 ? 0 : 1);
