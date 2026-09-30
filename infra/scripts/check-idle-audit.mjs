#!/usr/bin/env node
/**
 * §22s Phase-6-Gate G5 gegen ein **echtes, schreibbares** Projekt (A38).
 *
 *   infra/scripts/check-idle-audit.mjs --project <slug> [--keep-tasks]
 *   infra/scripts/check-idle-audit.mjs --path /opt/example-app
 *
 * Der Gate-Satz lautet: *"Idle audit run on a **real project** yields
 * actionable findings filed as P2 tasks with correct traces"*.
 *
 * §21s Mechanik ist bewiesen (`idle-audit.test.ts`, 21 Zusicherungen): A17s drei
 * Bedingungen, die Rotation über (Projekt, Domäne), der Deckel, die
 * Zuordnung Domäne → Abteilung, dass ein schreibendes Profil gar nicht erst
 * zugeordnet werden kann. Was dort fehlt, ist der Satz selbst — ein **echtes
 * Projekt**, auf dem der Ablaufplaner den Leerlauf-Zweig überhaupt erreicht.
 * Heute erreicht er ihn nirgends: `IdleAuditService.nextSlot` schließt
 * `read_only`-Projekte aus (A44.3), und A85 hält Vorschichts eigenes Projekt
 * genau dort. `build-scheduler.itest.ts` setzt jedes Fenster bewusst auf die
 * Decke, damit in **seinen** Fällen nie ein Leerlauf-Audit startet — die
 * Verdrahtung von `idleAudits` in den Ablaufplaner ist also nirgends
 * *verhaltensmäßig* geprüft. Genau das ist die Lücke, die dieses Skript füllt,
 * sobald es ein Projekt gibt.
 *
 * Acht Entscheidungen.
 *
 *  1. **Getrieben wird ein Tick, nicht der Dienst.** `IdleAuditService.runOnce()`
 *     direkt aufzurufen wäre kürzer und würde die eine Aussage verlieren, um die
 *     es geht: dass `Scheduler.tick()` am Ende eines leeren Durchgangs
 *     `report.idle === 'no_work'` feststellt und **deshalb** ein Audit startet.
 *     Diese Bedingung wird in `tick()` aus dem berechnet, was der Durchgang
 *     wirklich getan hat, und ein nachgebauter Aufruf beweist die andere
 *     Richtung (A95).
 *
 *  2. **Die Rotation wird vorher gefragt, nicht hinterher beklagt.**
 *     `nextSlot()` — dieselbe Methode, die der Tick benutzt, und sie schreibt
 *     nichts — sagt, welches (Projekt, Domäne)-Paar als nächstes an der Reihe
 *     ist. Ist das nicht das genannte Projekt, verweigert das Skript mit 2 und
 *     nennt, wem die Rotation zuerst etwas schuldet. Die Alternative wäre, auf
 *     irgendetwas zuzusichern und `--project` zur Dekoration zu machen.
 *
 *  3. **A17 wird vorher gelesen, damit „Budget zu voll" nicht als Rot ankommt.**
 *     `budgetAllows()` ist öffentlich und liefert genau die Begründung, die in
 *     eine 2 gehört. Ein Skript, das rot meldet, weil das Wochenfenster bei 60 %
 *     steht, erzeugt die Fehlklassifikation aus A50.
 *
 *  4. **Ein Lauf ohne Funde ist eine 2, keine 1.** §21 und §8.2 sagen es beide
 *     ausdrücklich: nichts zu finden ist ein gültiges Ergebnis, und es gibt
 *     keine Quote. Es beweist diesen Gate-Satz aber nicht — er verlangt Funde.
 *     Also: nichts geprüft, und der Grund steht da. Das als Fund zu melden wäre
 *     der Druck, unter dem ein Prüfer erfindet.
 *
 *  5. **Die dritte Zusicherung ist die, die man verliert.** „filed as P2 tasks"
 *     ist leicht zu prüfen; „**with correct traces**" ist der Teil, ohne den ein
 *     um vier Uhr früh angelegter P2 ein Satz ohne Urheber ist. Geprüft wird
 *     deshalb einzeln: `event_log.run_id` auf der `task.created`-Zeile zeigt auf
 *     den Audit-Lauf (die **Spalte**, nicht die Nutzlast — sie ist es, auf die
 *     der Trace-Explorer joint), und der Lauf trägt einen Transkriptpfad, der
 *     wirklich existiert.
 *
 *  6. **Jede Aussage kommt aus der Quelle.** `IdleAuditRun` sagt selbst, welche
 *     Aufgaben es angelegt hat; das ist der Rückgabewert dessen, was geprüft
 *     wird. Die Ids werden aus `event_log` (`idle_audit.finished`) geholt, die
 *     Prioritäten aus `tasks`, die Verknüpfung aus `event_log`, der
 *     Transkriptpfad aus `agent_runs` und dann vom Dateisystem (A89.4).
 *
 *  7. **Der Ablaufplaner wird ohne `audits` gebaut.** `buildScheduler`
 *     verdrahtet §8.2, sobald es ein selbstverwaltetes Projekt gibt, und
 *     `dueAudit` liefert `weekly`, sobald die letzte Prüfung sieben Tage her
 *     ist. Das wäre hier doppelt schädlich: eine Sitzung der stärksten Stufe als
 *     Nebenwirkung — und `report.audit !== null` setzt `report.idle` auf null,
 *     womit `maybeIdleAudit` **gar nicht erst** aufgerufen würde. Der Zweig, um
 *     den es geht, wäre unerreichbar. Als Prüfgrenze unten genannt.
 *
 *  8. **Die angelegten Aufgaben werden abgebrochen, wenn nicht `--keep-tasks`.**
 *     Sie sind das Erzeugnis des Gates und zugleich echte Arbeit in der
 *     Warteschlange eines Menschen: der Daemon würde sie aufgreifen und Budget
 *     für Funde ausgeben, die eine Prüfung erzeugt hat. `task_events` ist
 *     append-only, die Spur bleibt also vollständig — abgebrochen wird der
 *     Zustand, nicht der Beleg.
 *
 * Exit: 0 bewiesen · 1 eine Zusicherung hält nicht · 2 nichts geprüft — kein
 * Projekt, schreibgeschützt, keine Datenbank, kein Budget, keine CLI, Arbeit in
 * der Warteschlange, andere Rotation, keine Funde (A25/A50).
 */
import { execFile as execFileCallback } from 'node:child_process';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const {
  AgentRunner,
  ClaimRegistry,
  DeployRecords,
  DeployService,
  DevChain,
  EscalationService,
  EventLog,
  FindingsService,
  GuardianService,
  HeadlessBackend,
  IDLE_FINDING_PRIORITY,
  IdleAuditService,
  IntegrityCheck,
  MergeQueue,
  ProjectService,
  RunRecords,
  Scheduler,
  TaskService,
  UsageMeter,
  WorktreeManager,
  chainInfraHistory,
  taskDeployHandover,
  writeRoleSettings,
} = await import(pathToFileURL(join(REPO_ROOT, 'packages/core/dist/index.js')).href);
const { DISPATCHABLE_TASK_STATES, readProjectGateConfig } = await import(
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
const keepTasks = argv.includes('--keep-tasks');

/** Nichts geprüft (A25). Der Unterschied zu 1 ist der ganze Sinn dieser Codes. */
function nichtsGeprueft(satz) {
  console.error(`check-idle-audit — ${satz}`);
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
      '  infra/scripts/check-idle-audit.mjs --project example-app\n' +
      '\n' +
      'Das Projekt muss in der Datenbank stehen und **schreibbar** sein: §21s\n' +
      'Rotation überspringt read_only-Projekte (A44.3), weil deren Funde zu\n' +
      'Aufgaben würden, die der Ablaufplaner nie starten kann.',
  );
}

const url = env.DATABASE_URL;
if (!url) {
  nichtsGeprueft(
    'DATABASE_URL fehlt. Dieses Skript prüft gegen die Datenbank des laufenden\n' +
      'Studios — §21s Rotation liest ihre gesamte Eingabe aus `event_log`.',
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

const sql = createSql({ url, max: 6 });
let scratch = null;
const nachlass = { taskIds: [] };

try {
  const [{ da }] = await sql`SELECT to_regclass('public.event_log') IS NOT NULL AS da`;
  if (!da) {
    nichtsGeprueft(
      'die Tabelle `event_log` fehlt — das Schema ist hinter dem Code. Dieses Skript\n' +
        'migriert nicht; starte den Orchestrator einmal, er tut es beim Start.',
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
  if (project.readOnly) {
    nichtsGeprueft(
      `„${project.slug}" ist schreibgeschützt. §21s Rotation überspringt solche\n` +
        'Projekte (A44.3): ihre Funde würden P2-Aufgaben, die der Ablaufplaner nie\n' +
        'startet. Für Vorschicht selbst ist das A85 und des Betreibers Entscheidung — dieses\n' +
        'Gate braucht ein anderes Projekt.',
    );
  }

  // --- Entscheidung 1 setzt voraus, dass der Tick leer laufen *kann* --------
  const wartend = await sql`
    SELECT count(*)::int AS n FROM tasks
    WHERE state = ANY(${sql.array([...DISPATCHABLE_TASK_STATES])})
  `;
  if (wartend[0].n > 0) {
    nichtsGeprueft(
      `es stehen ${wartend[0].n} Aufgabe(n) in einem startbaren Zustand. Der Tick würde\n` +
        'sie starten statt leer zu laufen — §21 füllt Lücken, es überholt nichts (A17).\n' +
        'Warte, bis die Warteschlange leer ist, oder brich die Aufgaben ab.',
    );
  }

  // --- Budget: erst der Wächter (§7.2), dann A17 ---------------------------
  const eventLog = new EventLog(sql);
  const meter = new UsageMeter({ sql, eventLog });
  const guardian = new GuardianService({
    sql,
    meter,
    eventLog,
    // Kein Notifier: eine Prüfung darf keine ntfy-Karte auslösen. Die
    // Warteschlange tut nichts — pausiert wird nur bei einem Übergang, und ein
    // Lauf außerhalb von „normal" endet zwei Zeilen weiter mit 2.
    queue: { pause: async () => {}, resume: async () => {}, isPaused: false },
    activeRuns: () => [],
  });
  const entscheidung = await guardian.evaluate();
  if (entscheidung.state !== 'normal') {
    nichtsGeprueft(
      `der Wächter steht auf „${entscheidung.state}" (§7.2). Außerhalb von „normal"\n` +
        'kehrt `tick()` sofort zurück und erreicht den Leerlauf-Zweig gar nicht.',
    );
  }

  // --- CLI, bevor eine Sitzung versucht wird -------------------------------
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

  // --- Die Verdrahtung (Entscheidung 7) ------------------------------------
  scratch = await mkdtemp(join(tmpdir(), 'vorschicht-idle-check-'));
  const runsRoot = join(scratch, 'runs');
  // A58.1: eine Sitzung mit nicht existierendem cwd startet gar nicht erst, und
  // der Daemon meldet dann den falschen Grund.
  const idleScratch = join(runsRoot, 'idle-audit');
  await mkdir(idleScratch, { recursive: true });
  await writeRoleSettings(join(scratch, 'claude'), {
    hookEntry: join(REPO_ROOT, 'packages/core/dist/hook-entry.js'),
  });

  /*
   * Das Transkript ist Teil der Zusicherung (Entscheidung 5) und wird nach §18
   * ein Jahr aufgehoben. Läge es unter `scratch`, würde das Aufräumen dieses
   * Skripts genau den Beleg löschen, auf den `agent_runs.transcript_path` dann
   * dauerhaft zeigt. Also: das echte Verzeichnis, wenn eines konfiguriert ist —
   * und sonst das temporäre, mit der Folge unten unter „Nicht geprüft".
   */
  const transcriptsRoot = env.VORSCHICHT_TRANSCRIPTS_ROOT ?? join(scratch, 'transcripts');

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
      transcriptsRoot,
      // §21s Sitzung dient keiner Aufgabe und läuft deshalb ohne MCP (A56.5).
      mcpServerEntry: null,
    },
    onWarning: (message) => console.warn(`  ! ${message}`),
  });
  const claims = new ClaimRegistry({ sql, tasks, projects, eventLog });
  const findings = new FindingsService({ sql });

  const idleAudits = new IdleAuditService({
    sql,
    eventLog,
    runner,
    tasks,
    projects,
    usage: () => meter.currentSamples(),
    scratchDir: idleScratch,
    onWarning: (message) => console.warn(`  ! ${message}`),
  });

  // --- Entscheidung 3: A17, bevor irgendetwas startet ----------------------
  const budget = await idleAudits.budgetAllows();
  if (budget) {
    nichtsGeprueft(
      budget.reason === 'budget'
        ? `A17s Decke: das Fenster „${budget.window}" steht bei ${budget.usedPercent} % ` +
            `(erlaubt sind < 50 %). §21 füllt Lücken und konkurriert nicht um Budget.`
        : `A17 fällt geschlossen aus: ${budget.problem ?? budget.reason}. Ein Fenster, ` +
            'das nicht lesbar ist, ist kein Fenster unter 50 %.',
    );
  }

  // --- Entscheidung 2: fragt die Rotation, bevor sie etwas kostet ----------
  const slot = await idleAudits.nextSlot();
  if (!slot) {
    nichtsGeprueft(
      'die Rotation hat kein Paar: es gibt kein aktives, schreibbares Projekt oder\n' +
        'keine Domäne mit einem nur lesenden Profil (§21, `runnableIdleDomains`).',
    );
  }
  if (slot.project.id !== project.id) {
    nichtsGeprueft(
      `die Rotation schuldet zuerst „${slot.project.slug}" einen Blick ` +
        `(Domäne ${slot.domain.id}), nicht „${project.slug}". §21 rotiert nach zuletzt\n` +
        'geprüft; das ist die Reihenfolge, nicht eine Auswahl dieses Skripts.',
    );
  }

  console.log(`\x1b[1mLeerlauf-Audit gegen „${project.slug}" (${project.rootPath})\x1b[0m`);
  console.log(`  Domäne: ${slot.domain.id} (${slot.domain.label}), Profil ${slot.domain.profile}`);
  console.log(`  Zuletzt geprüft: ${slot.lastAt ? slot.lastAt.toISOString() : 'nie'}\n`);

  const scheduler = new Scheduler({
    tasks,
    projects,
    claims,
    guardian,
    devChain: new DevChain({
      tasks,
      projects,
      claims,
      worktrees,
      runner,
      runs: new RunRecords(sql),
      eventLog,
      findings,
      escalations,
      gateTools: (p) => readProjectGateConfig(p.gateConfig).tools,
      onWarning: (message) => console.warn(`  ! ${message}`),
    }),
    mergeQueue: new MergeQueue({
      deployableMethods: [],
      sql,
      tasks,
      projects,
      claims,
      worktrees,
      eventLog,
      findings,
      escalations,
      // Nie aufgerufen: dieser Lauf verlangt eine leere Warteschlange, es kann
      // also kein Kandidat da sein. Ein Wurf hier wäre trotzdem besser als eine
      // stille Attrappe, die einen Merge meldet, den es nicht gab.
      gates: () => {
        throw new Error('In diesem Prüflauf darf kein Merge-Kandidat auftauchen.');
      },
      onWarning: (message) => console.warn(`  ! ${message}`),
      onOpsAlert: (alert) => console.warn(`  ! Infrastruktur: ${alert.problem}`),
    }),
    integrity: new IntegrityCheck({
      tasks,
      projects,
      worktrees,
      runner,
      eventLog,
      escalations,
      onWarning: (message) => console.warn(`  ! ${message}`),
    }),
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
    idleAudits,
    // Entscheidung 7: kein `audits`.
    concurrency: 1,
    onWarning: (message) => console.warn(`  ! ${message}`),
  });

  // --- Der Tick (Entscheidung 1) -------------------------------------------
  console.log('  … ein Tick, der leer laufen und deshalb prüfen soll');
  const report = await scheduler.tick();
  await scheduler.settle();

  if (report.idle === 'no_work') {
    ok('`tick()` hat den Durchgang als leer festgestellt — A17s „empty queue", mechanisch');
  } else {
    nein(
      `\`report.idle\` ist „${report.idle ?? 'null (der Tick hat etwas getan)'}" statt „no_work"; ` +
        'der Leerlauf-Zweig wurde gar nicht erreicht',
    );
  }

  if (report.idleAudit === null) {
    const grund = report.idleAuditSkip;
    if (grund) {
      nichtsGeprueft(
        `der Tick hat kein Audit gefahren: ${grund.reason}` +
          (grund.problem ? ` — ${grund.problem}` : '') +
          (grund.status ? ` (Sitzung: ${grund.status})` : ''),
      );
    }
    nein('der Tick hat weder ein Audit gefahren noch einen Grund genannt');
    throw new Error('abbruch:kein-audit');
  }

  const runId = report.idleAudit.runId;
  console.log(`  Lauf ${runId}\n`);

  // --- Entscheidung 6: alles Weitere aus der Quelle ------------------------
  const [zeile] = await sql`
    SELECT run_id::text, payload FROM event_log
    WHERE kind = 'idle_audit.finished' AND run_id = ${runId} LIMIT 1
  `;
  if (!zeile) {
    nein('`event_log` trägt keine `idle_audit.finished`-Zeile für diesen Lauf');
    throw new Error('abbruch:keine-zeile');
  }
  const gemeldet = Array.isArray(zeile.payload?.taskIds) ? zeile.payload.taskIds : [];
  nachlass.taskIds = gemeldet;

  // --- Entscheidung 4 ------------------------------------------------------
  if (gemeldet.length === 0) {
    nichtsGeprueft(
      `die Sitzung (${slot.domain.id}, ${project.slug}) hat nichts gefunden. Nach §21 und\n` +
        '§8.2 ist das ein gültiges Ergebnis und keine Quote — dieser Gate-Satz verlangt\n' +
        'aber Funde („yields actionable findings"). Also nichts geprüft, nicht rot.\n' +
        `Zusammenfassung des Laufs: ${zeile.payload?.summary ?? '(keine)'}`,
    );
  }
  ok(`${gemeldet.length} Fund(e), je eine Aufgabe — aus \`event_log\` gelesen`);

  // --- „filed as P2 tasks" -------------------------------------------------
  const rows = await sql`
    SELECT id::text, title, priority, project_id::text, type FROM tasks
    WHERE id = ANY(${sql.array(gemeldet)}::uuid[])
  `;
  const falsch = rows.filter(
    (row) => row.priority !== IDLE_FINDING_PRIORITY || row.project_id !== project.id,
  );
  if (rows.length === gemeldet.length && falsch.length === 0) {
    ok(
      `alle ${rows.length} stehen als ${IDLE_FINDING_PRIORITY} im Projekt „${project.slug}" ` +
        '(§21, A17 — nie ein Blocker nach §11)',
    );
  } else {
    nein(
      `${gemeldet.length - rows.length} Aufgabe(n) fehlen ganz; falsch eingeordnet: ` +
        `${falsch.map((r) => `${r.id}=${r.priority}`).join(', ') || '—'}`,
    );
  }

  // --- „with correct traces" — Entscheidung 5, Teil 1 ----------------------
  const spuren = await sql`
    SELECT task_id::text, run_id::text FROM event_log
    WHERE kind = 'task.created' AND task_id = ANY(${sql.array(gemeldet)}::uuid[])
  `;
  const ohneSpur = gemeldet.filter(
    (id) => !spuren.some((row) => row.task_id === id && row.run_id === runId),
  );
  if (ohneSpur.length === 0) {
    ok(
      'jede `task.created`-Zeile trägt den Audit-Lauf in der **Spalte** `run_id` — ' +
        'das ist die, auf die der Trace-Explorer joint',
    );
  } else {
    nein(
      `${ohneSpur.length} Aufgabe(n) sind ohne Verweis auf den Lauf angelegt worden ` +
        `(${ohneSpur.join(', ')}) — ein P2 ohne Urheber`,
    );
  }

  // --- „with correct traces" — Entscheidung 5, Teil 2 ----------------------
  const [lauf] = await sql`
    SELECT transcript_path, role FROM agent_runs WHERE run_id = ${runId}
  `;
  const pfad = lauf?.transcript_path ?? null;
  let vorhanden = false;
  if (pfad)
    vorhanden = await access(pfad)
      .then(() => true)
      .catch(() => false);
  if (pfad && vorhanden) {
    ok(`der Lauf (${lauf.role}) trägt sein Transkript, und die Datei ist da: ${pfad}`);
  } else if (pfad) {
    nein(`\`agent_runs\` nennt „${pfad}" — die Datei gibt es dort nicht`);
  } else {
    nein('`agent_runs.transcript_path` ist leer — die Sitzung ist nicht nachlesbar (§18)');
  }
} catch (fehler) {
  if (istInfra(fehler)) {
    // Gefunden, indem der Verweigerungsweg wirklich gefahren wurde: eine
    // unerreichbare Datenbank landete hier und wurde als **Fund** gemeldet —
    // genau die Fehlklassifikation, die A50 aufschreibt. Der Code wird erst
    // nach dem Aufräumen gesetzt, weil `exit()` kein `finally` mehr ausführt.
    infra = fehler.message;
  } else if (!String(fehler?.message).startsWith('abbruch:')) {
    console.error(`\ncheck-idle-audit — abgebrochen: ${fehler.stack ?? fehler.message}`);
    rot += 1;
  }
} finally {
  // --- Entscheidung 8 -------------------------------------------------------
  if (keepTasks) {
    if (nachlass.taskIds.length > 0) {
      console.log(`  · --keep-tasks: ${nachlass.taskIds.length} P2-Aufgabe(n) bleiben stehen.`);
    }
  } else {
    const tasks = new TaskService({ sql, eventLog: new EventLog(sql) });
    for (const id of nachlass.taskIds) {
      await tasks
        .transition(id, 'aborted', {
          actor: 'check-idle-audit',
          reason:
            'Prüflauf beendet — der Fund bleibt im Ereignisprotokoll, die Aufgabe wird ' +
            'abgebrochen, damit sie kein Budget bindet. Mit --keep-tasks bleibt sie stehen.',
        })
        .catch((e) => console.warn(`  ! Aufgabe ${id} nicht abbrechbar: ${e.message}`));
    }
    if (nachlass.taskIds.length > 0) {
      console.log(`  · ${nachlass.taskIds.length} P2-Aufgabe(n) abgebrochen (Spur bleibt).`);
    }
  }

  if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  await sql.end().catch(() => undefined);
}

if (infra && rot === 0) {
  // Ein bereits roter Befund schlägt das hier: „wir konnten nicht zu Ende
  // prüfen" darf eine Feststellung, die schon steht, nicht überschreiben.
  console.error(`\ncheck-idle-audit — an der Umgebung gescheitert: ${infra}`);
  console.error('Nichts geprüft (A25) — das ist keine Feststellung über das Gate.');
  exit(2);
}

console.log('\n\x1b[1mNicht geprüft:\x1b[0m');
console.log(
  '  - Ob die Funde **stichhaltig** sind. Dieses Skript prüft §21s Mechanik gegen ein\n' +
    '    echtes Projekt; ob eine Aussage über fremden Code zutrifft, sagt nur ein Mensch.',
);
console.log(
  `  - Neun der zehn Domänen. Ein Lauf ist eine Domäne (§21), hier war es die, die die\n` +
    '    Rotation schuldete — erzwingen lässt sich das durch den Tick nicht.',
);
console.log(
  '  - Der Ablaufplaner läuft ohne §8.2 (Entscheidung 7); mit `audits` wäre der\n' +
    '    Leerlauf-Zweig in genau dem Tick unerreichbar, in dem eine Prüfung fällig ist.',
);
if (!env.VORSCHICHT_TRANSCRIPTS_ROOT) {
  console.log(
    '  - VORSCHICHT_TRANSCRIPTS_ROOT war nicht gesetzt: das Transkript lag im Temp-\n' +
      '    Verzeichnis und ist mit dem Aufräumen weg. `agent_runs` zeigt dauerhaft darauf.',
  );
}
console.log(
  '  - Läuft der Daemon gleichzeitig, kann er dieselbe Rotation bedienen; dann prüft\n' +
    '    dieses Skript einen Lauf, den es nicht ausgelöst hat.',
);
for (const limit of grenzen) console.log(`  - ${limit}`);

console.log(`\n\x1b[1mErgebnis:\x1b[0m ${gruen} grün · ${rot} rot`);
exit(rot === 0 && gruen > 0 ? 0 : 1);
