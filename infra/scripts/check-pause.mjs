#!/usr/bin/env node
/**
 * §22s Phase-7-Gate G6 am **laufenden** Studio.
 *
 *   infra/scripts/with-test-db.sh node infra/scripts/check-pause.mjs
 *
 * Der Gate-Satz lautet: *"Pause switch demo: pause parks running work cleanly
 * and blocks new sessions; resume returns to normal — audit-logged"*.
 *
 * Was es schon gibt: `e2e/controlling.spec.ts` belegt den Schalter im Browser,
 * die Zeile in `config` und den Prüfpfad; `guardian-service.itest.ts` belegt,
 * dass `setPause({hard:true})` auf `hard_stop` abbildet. Was **keiner** von
 * beiden belegt, ist der Satz selbst: dass eine harte Pause **laufende Arbeit**
 * parkt, dass **danach** über mehrere Durchgänge nichts Neues startet, und dass
 * Fortsetzen die geparkte Arbeit wirklich weiterlaufen lässt. Dazwischen liegen
 * vier Bauteile, die noch nie in einem Stück gefahren wurden: die Zeile in
 * `config`, der `manualPause`-Haken des Wächters, `WrapUpService.parkAll` und
 * das Wächter-Tor am Kopf von `Scheduler.tick()`.
 *
 * Elf Entscheidungen.
 *
 *  1. **Gefahren wird ein echter `Scheduler`-Tick, nicht ein Dienst.** Die
 *     Aussage „danach startet keine neue Sitzung" ist eine Aussage über
 *     `tick()`, nicht über `GuardianService`: das Tor steht in `tick()`
 *     (`if (decision.state !== 'normal') { report.idle = 'guardian'; return }`),
 *     und ein nachgebauter Aufruf bewiese die andere Richtung (A95, A119.4).
 *
 *  2. **Der Schalter wird über `ControllingSettings` gestellt, nie über
 *     `GuardianService.setPause`.** Das ist der Weg, den die Oberfläche nimmt:
 *     Seite → `config`-Zeile → `manualPause`-Haken → Wächter. `setPause` ist ein
 *     Feld auf einem Objekt im **anderen Prozess** und war genau deshalb bis zu
 *     A26s Haken ein Mechanismus ohne Aufrufer. Ein Prüfskript, das ihn benutzt,
 *     lässt die eine Verdrahtung aus, die sonst niemand prüft.
 *
 *  3. **Das `fake`-Backend (A37), also kein bezahlter Modellauf.** Geprüft wird
 *     der Ablaufplaner und der Wächter; ein echtes Modell kostete Budget und
 *     fügte nichts hinzu. Die Planer-Sitzung antwortet sofort, die
 *     Coder-Sitzung **trödelt** (`stepDelayMs`) und **schreibt eine Datei** —
 *     ohne das eine gibt es im Moment der Pause keine laufende Arbeit, ohne das
 *     andere nichts, was §7.3 Schritt 2 sichern könnte, und der Gate-Satz wäre
 *     über einem leeren Studio bewiesen.
 *
 *  4. **Eigene Wegwerf-Datenbank, und das ist hier richtig, wo A117 es
 *     verbietet.** A117 verweigert einer Betriebsprüfung die Wegwerf-Datenbank,
 *     weil deren *Folgen* — P2-Aufgaben, P1-Karten, die Zählung
 *     bestätigt/verworfen — den Lauf überleben müssen. Eine Pause-Prüfung hat
 *     keine solche Folge: sie prüft einen Mechanismus, legt Aufgaben an, die
 *     niemand haben will, tötet Sitzungen und schaltet zwischendurch das ganze
 *     Studio ab. Gegen die Datenbank der laufenden Installation wäre genau das
 *     der Schaden. Der Preis steht unten unter „Nicht geprüft".
 *
 *  5. **Jede Aussage wird aus der Quelle gelesen.** Zustand und Rückkehrpunkt
 *     aus `task_events`, die Reservierungen aus der `claims`-Sicht, der
 *     WIP-Commit aus `git log`, der Prüfpfad aus `audit_log`, die Sitzungen aus
 *     `agent_runs`. Der Rückgabewert von `parkAll()` oder `tick()` trägt
 *     **keine** Zusicherung allein: wer eine Antwort erzeugen kann, darf nicht
 *     auch gefragt werden, ob sie stimmt (A89.4).
 *
 *  6. **Zusicherung 2 läuft über mehrere Ticks, nicht über einen.** „Blockiert
 *     neue Sitzungen" ist eine Aussage über **Beharrlichkeit**; ein
 *     Einzeltick-Nachweis übersieht genau die Wiederholung, die der
 *     Ablaufplaner alle fünfzehn Sekunden macht. Dieselbe Lehre wie bei A12s
 *     Freigabe, die deshalb über fünf Ticks geprüft wird (A93.5, P5.G7).
 *
 *  7. **„Mit Claims" heißt `parked` — nachgelesen, nicht angenommen, und von
 *     einer Mutation nachgeschärft.** Die `claims`-Sicht (0009) vergibt genau
 *     für eine Aufgabe in `parked`/`needs_decision`/`interrupted` den Status
 *     `parked` und kommentiert ihn mit „held across a pause (§10/§15)". Auf
 *     `active` zu prüfen wäre rot für eine korrekte Umsetzung. Die erste Fassung
 *     prüfte deshalb nur „vorhanden und nicht `released`" — und **überlebte**
 *     Mutation M1, weil eine gar nicht pausierte Aufgabe ihre Reservierungen auf
 *     `active` hält. Eine Zusicherung, die auch ohne Pause hält, sagt über das
 *     Parken nichts; sie liest jetzt `parked`.
 *
 *  8. **Die Integritätsprüfung ist eine eigene Zusicherungsgruppe, und der
 *     Grund ist ein Befund.** A26 sagt „Hard pause = hard_stop semantics **incl.
 *     integrity re-check**". Im Code führt eine harte Pause auf eine sauber
 *     unterbrechbare Sitzung nach `parked`, nicht nach `interrupted`:
 *     `WrapUpService.parkAll` parkt jede aktive Aufgabe, `DevChain.leg` parkt
 *     einen `interrupted`-Ausgang, und die Gnadenfrist tötet nur den Prozess.
 *     `interrupted` schreibt allein `reconcile()`, also der **Start** des
 *     Daemons über einen Lauf ohne terminales Ereignis — und `reconcile()`
 *     fasst nur `IN_FLIGHT_TASK_STATES` an, worin `parked` nicht vorkommt. Die
 *     §7.2-Prüfung gehört also zum Neustartweg, nicht zum Pausenweg. Das ist
 *     kein Mangel — Parken bewahrt die Arbeit, Unterbrechen nicht —, aber A26s
 *     Nebensatz liest sich anders, und das gehört benannt statt zusammengefasst
 *     (A76.4). Geprüft wird beides, getrennt.
 *
 *  9. **Der Neustart wird gefahren, nicht behauptet.** Für die Prüfgruppe 4
 *     läuft eine dritte Aufgabe an, und `reconcile()` wird gerufen, **während**
 *     ihre Sitzung noch streamt — genau der Zustand, den ein getöteter Daemon
 *     in der Datenbank hinterlässt: ein Lauf ohne `terminated`. Danach muss der
 *     nächste Tick §7.2 durchlaufen, bevor die Aufgabe sich wieder bewegen darf;
 *     die Datenbank selbst verweigert alles andere (A43.3).
 *
 * 10. **Aufgeräumt wird nichts, weil nichts zu räumen ist.** Die Datenbank wird
 *     am Ende gelöscht, das Sandkasten-Repository liegt in einem temporären
 *     Verzeichnis. Kein Projekt eines Menschen wird berührt — der Unterschied zu
 *     `check-radar-autotask.mjs`, das in einen echten Integrationszweig merged
 *     und dafür sieben Zeilen Aufräum-Verweigerung braucht.
 *
 * 11. **Jeder Weg, auf dem nichts geprüft wurde, endet mit 2.** Keine
 *     Datenbank, Docker unerreichbar, kein `git`, ein Schema hinter dem Code,
 *     eine Kette, die gar nicht bis zu einer laufenden Sitzung kommt, ein
 *     Wächter, der schon vor dem ersten Schalten nicht auf `normal` steht.
 *     Nichts geprüft ist nach A25/A50 keine Feststellung, und ein Skript, das
 *     daraufhin rot meldet, behauptet einen Befund über ein Gate, das es nie
 *     angefasst hat.
 *
 * Exit: 0 bewiesen · 1 eine Zusicherung hält nicht (der Schalter hat sich falsch
 * verhalten) · 2 nichts geprüft.
 */
import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
// Relativer Specifier, also plattformunabhängig gültig (A130.2) — und ein
// statischer Import, weil diese Datei nichts weiter lädt.
import { posixRootPath } from './audit-project.mjs';

const execFile = promisify(execFileCallback);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/*
 * Der Bauzustand wird geprüft, bevor der erste `import()` ihn voraussetzt.
 *
 * Ohne das endet ein frischer Checkout — und jeder Lauf im Gate-Container, wo
 * `dist/` nach `.gitignore` gar nicht erst ankommt — in einem rohen
 * `ERR_MODULE_NOT_FOUND` mit **Exit 1**, also als Befund über einen Schalter,
 * den niemand angesehen hat (A25/A50). `demo-phase5.sh` baut aus demselben
 * Grund vorweg (A90.7); hier ist es eine Verweigerung mit dem Befehl darin,
 * weil dieses Skript einzeln aufgerufen wird.
 */
const CORE_DIST = join(REPO_ROOT, 'packages/core/dist/index.js');
if (!existsSync(CORE_DIST)) {
  console.error(
    'check-pause — die Pakete sind nicht gebaut (`packages/core/dist/index.js` fehlt).\n' +
      '\n' +
      '  npx tsc --build --force\n' +
      '\n' +
      'Nichts geprüft (A25/A50).',
  );
  exit(2);
}

const {
  ActiveRunRegistry,
  AgentRunner,
  ClaimRegistry,
  ControllingSettings,
  DeployRecords,
  DeployService,
  DevChain,
  EscalationService,
  EventLog,
  FakeBackend,
  FindingsService,
  GuardianService,
  IntegrityCheck,
  ProjectService,
  RunRecords,
  Scheduler,
  TaskService,
  UsageMeter,
  WorktreeManager,
  WrapUpService,
  chainInfraHistory,
  reconcile,
  taskDeployHandover,
} = await import(pathToFileURL(join(REPO_ROOT, 'packages/core/dist/index.js')).href);
// Der Unterpfad, nicht der Sammelexport: `PAUSE_KEY` steht in `controlling.ts`
// und wird von der Sammelstelle nicht weitergereicht (geprüft, nicht vermutet).
const { PAUSE_KEY } = await import(
  pathToFileURL(join(REPO_ROOT, 'packages/shared/dist/controlling.js')).href
);
const { createSql, createTestDatabase } = await import(
  pathToFileURL(join(REPO_ROOT, 'packages/db/dist/index.js')).href
);

// --------------------------------------------------------------- Argumente ---

function arg(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
}

/** Wie viele Durchgänge Zusicherung 2 fährt (Entscheidung 6). */
const TICKS = Number(arg('ticks', '5'));
/** Wie lange die Coder-Sitzung je Schritt trödelt, damit sie beim Schalten läuft. */
const CODER_STEP_MS = Number(arg('coder-step-ms', '500'));

/** Nichts geprüft (A25/A50). Der Unterschied zu 1 ist der ganze Sinn dieser Codes. */
function nichtsGeprueft(satz) {
  console.error(`check-pause — ${satz}`);
  exit(2);
}

if (!Number.isInteger(TICKS) || TICKS < 2) {
  nichtsGeprueft(
    '--ticks muss eine ganze Zahl ≥ 2 sein. Bei einem einzigen Durchgang wäre\n' +
      '„blockiert neue Sitzungen" keine Aussage über Beharrlichkeit (A93.5).',
  );
}
if (!Number.isInteger(CODER_STEP_MS) || CODER_STEP_MS < 1) {
  nichtsGeprueft('--coder-step-ms muss eine ganze Zahl ≥ 1 sein.');
}

const adminUrl = env.TEST_DATABASE_URL;
if (!adminUrl) {
  nichtsGeprueft(
    'TEST_DATABASE_URL fehlt.\n' +
      '\n' +
      '  infra/scripts/with-test-db.sh node infra/scripts/check-pause.mjs\n' +
      '\n' +
      'Dieses Skript legt eine eigene Wegwerf-Datenbank an: es schaltet das Studio ab,\n' +
      'legt Aufgaben an und tötet Sitzungen. Gegen die Datenbank einer laufenden\n' +
      'Installation wäre genau das der Schaden (Entscheidung 4). Ist Docker nicht\n' +
      'erreichbar, endet with-test-db.sh selbst mit 2 — ebenfalls „nichts geprüft".',
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
const abschnitt = (satz) => console.log(`\n\x1b[1m${satz}\x1b[0m`);

async function git(cwd, ...args) {
  const { stdout } = await execFile('git', args, { cwd, timeout: 60_000 });
  return stdout.trim();
}

/**
 * Ein Sandkasten-Repository, erzeugt statt eingecheckt (A54.5).
 *
 * §7.3 Schritt 2 schreibt einen `wip:`-Commit auf den Aufgabenzweig, und ohne
 * echtes git gäbe es davon nichts zu lesen. Der Inhalt ist beliebig; was zählt,
 * ist, dass `git` hier wirklich committet.
 */
async function sandkasten(pfad) {
  await execFile('git', ['init', '--initial-branch=main', pfad], { timeout: 60_000 });
  await git(pfad, 'config', 'user.email', 'vorschicht-bot@example.com');
  await git(pfad, 'config', 'user.name', 'Vorschicht Bot');
  await git(pfad, 'config', 'commit.gpgsign', 'false');
  await writeFile(join(pfad, 'gruss.js'), 'export const gruss = () => "hallo";\n', 'utf8');
  // Zweite Datei, damit zwei Aufgaben nach §10 disjunkte Reservierungen haben
  // können — siehe `planFuer`.
  await writeFile(join(pfad, 'andere.js'), 'export const andere = () => "servus";\n', 'utf8');
  await git(pfad, 'add', '-A');
  await git(pfad, 'commit', '-m', 'chore: Ausgangsstand des Prüf-Sandkastens');
}

/** Warten, bis `bedingung()` hält — oder aufgeben und `false` melden. */
async function warteAuf(bedingung, msMax = 30_000) {
  const frist = Date.now() + msMax;
  while (Date.now() < frist) {
    if (await bedingung()) return true;
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
}

// --------------------------------------------------------- Sitzungsskripte ---

/** §6.6 lebt: ohne diesen Rahmen ist jeder Lauf ein Infrastrukturfehler (A51.1). */
const HOOK_START = {
  type: 'hook_event',
  event: 'SessionStart',
  hookName: 'SessionStart:*',
  phase: 'response',
  outcome: 'success',
  exitCode: 0,
};

/**
 * Der Plan, mit **je Aufgabe eigenem** Claim-Set.
 *
 * Zwei Aufgaben mit demselben Glob kollidieren nach §10, und die zweite bliebe
 * dann für immer blockiert — sichtbar geworden im ersten Lauf dieses Skripts,
 * wo Prüfgruppe 4 nie bis „coding" kam, weil die geparkte Aufgabe der
 * Prüfgruppe 1 ihre Reservierung (zu Recht) behielt. Ein Prüfskript, das an §10
 * scheitert statt an seiner Frage, meldet einen Befund über etwas anderes.
 */
function planFuer(datei) {
  return {
    status: 'done',
    summary: 'Plan erstellt.',
    artifacts: [],
    followups: [],
    claimSet: [datei],
    plan: [`${datei} um eine Anrede erweitern`],
    testPlan: ['node --test'],
    risks: [],
  };
}

const APPROVED = {
  status: 'done',
  summary: 'Sieht gut aus.',
  artifacts: [],
  followups: [],
  verdict: 'approve',
  findings: [],
  claimsRespected: true,
};

const DEBUG_OK = {
  status: 'done',
  summary: 'Der Arbeitsbaum ist unversehrt.',
  artifacts: [],
  followups: [],
  rootCause: 'Die Sitzung wurde beim harten Stopp beendet; der Baum ist konsistent.',
  proposals: ['Weiterarbeiten'],
};

const sql = createSql({ url: adminUrl, max: 1 });
let database = null;
let studio = null;
let scratch = null;

try {
  // --- Umgebung, bevor irgendetwas angelegt wird ---------------------------
  try {
    await sql`SELECT 1`;
  } catch (fehler) {
    nichtsGeprueft(
      `die Postgres unter TEST_DATABASE_URL antwortet nicht (${fehler.message}).\n` +
        'Ohne Datenbank wurde nichts geprüft — das ist keine Aussage über den Schalter.',
    );
  } finally {
    await sql.end().catch(() => undefined);
  }

  try {
    await execFile('git', ['--version'], { timeout: 30_000 });
  } catch (fehler) {
    nichtsGeprueft(
      `git ist nicht aufrufbar (${fehler.message}). §7.3 Schritt 2 schreibt einen ` +
        'WIP-Commit; ohne git gibt es davon nichts zu lesen.',
    );
  }

  database = await createTestDatabase('pause-gate');
  studio = createSql({ url: database.url, max: 8 });

  const [{ da }] = await studio`SELECT to_regclass('public.task_events') IS NOT NULL AS da`;
  if (!da) nichtsGeprueft('das Schema wurde nicht angelegt — `migrate` ist nicht durchgelaufen.');

  scratch = await mkdtemp(join(tmpdir(), 'vorschicht-pause-check-'));
  const repo = join(scratch, 'sandkasten');

  /*
   * A131s Wand, und hier ist sie nicht umgehbar.
   *
   * `0001_foundation.sql:67` verlangt `CHECK (root_path LIKE '/%')`, weil das
   * Studio in Linux-Containern läuft. A131 bildet dafür `C:\x` auf Git Bashs
   * `/c/x` ab — und hält im selben Atemzug fest, dass diese Form **nicht** in
   * Node auf Windows auflöst: speichern, drucken, vergleichen ja, `join()` und
   * an `fs` geben nein. Genau das bräuchte dieser Lauf: `WorktreeManager` legt
   * unter diesem Pfad ein Arbeitsverzeichnis an und `git` bekommt ihn als
   * `cwd`. Eine Abbildung wäre hier also die Sorte Umgehung, die stillschweigend
   * etwas anderes prüft.
   *
   * Also verweigert das Skript und nennt den Ort, an dem es läuft. §22s
   * Nachweis wird dadurch nicht schwächer — er zieht um (A127.8: der Gate wird
   * auf Windows bewusst nicht lauffähig gemacht, sondern überall ehrlich).
   */
  if (posixRootPath(repo) !== repo) {
    nichtsGeprueft(
      `„${repo}" ist kein POSIX-absoluter Pfad.\n` +
        '`projects.root_path` verlangt einen (0001_foundation.sql:67), und die Abbildung\n' +
        'nach `/c/…` (A131) hilft hier nicht: der\n' +
        'Pfad muss zugleich für `fs` und `git` benutzbar sein, und das ist die abgebildete\n' +
        'Form auf Windows nicht.\n' +
        '\n' +
        '  infra/scripts/in-container.sh infra/scripts/with-test-db.sh \\\n' +
        '    node infra/scripts/check-pause.mjs\n' +
        '\n' +
        'Nichts geprüft — das ist keine Aussage über den Schalter (A25/A50).',
    );
  }

  await sandkasten(repo);

  // --- Die Verdrahtung, `main.ts` nachgebaut --------------------------------
  const eventLog = new EventLog(studio);
  const tasks = new TaskService({ sql: studio, eventLog });
  const projects = new ProjectService(studio);
  const escalations = new EscalationService({ sql: studio, eventLog });
  const claims = new ClaimRegistry({ sql: studio, tasks, projects, eventLog });
  const findings = new FindingsService({ sql: studio });
  const runs = new RunRecords(studio);
  const worktrees = new WorktreeManager({
    tasks,
    projects,
    eventLog,
    root: join(scratch, 'worktrees'),
  });
  /*
   * Bewusst **kein** `writeRoleSettings`.
   *
   * Die §6.6-Dokumente sind die Sache des `headless`-Backends: die CLI schickt
   * die Hook-Zeile durch eine Shell, und `buildRoleSettings` verweigert deshalb
   * jeden Pfad mit Shell-Sonderzeichen (A51.2) — auf Windows also jeden. Das
   * `fake`-Backend startet keinen Prozess und keine Shell; es meldet den
   * `SessionStart`-Rahmen selbst, den `ContainmentMonitor` sehen will. Ein
   * Aufruf hier hätte diesen Lauf auf einer Entwicklermaschine mit einer
   * Meldung über Dateipfade abgebrochen, die über den Pause-Schalter nichts
   * aussagt. Als Prüfgrenze unten genannt statt weggelassen.
   */

  /**
   * Der Coder trödelt und schreibt, alle anderen antworten sofort
   * (Entscheidung 3).
   *
   * `stepDelayMs` ist die eine Eigenschaft, in der diese Attrappe von der echten
   * CLI abweichen *muss*: eine Sitzung, die in Mikrosekunden fertig ist, kann
   * nicht „laufende Arbeit" sein, und der Gate-Satz handelt von nichts anderem.
   */
  const gesehen = [];
  /**
   * Welche Datei welche Aufgabe beansprucht.
   *
   * `SessionSpec` trägt keine `taskId` (nachgesehen, nicht angenommen), wohl
   * aber den Arbeitsbaum — und der heißt nach §10 `…/task-<id>`. Das ist die
   * eine Kennung, die eine Sitzung mit ihrer Aufgabe verbindet, ohne dass
   * dieses Skript sich eine zweite Buchführung anlegt, die auseinanderlaufen
   * kann.
   */
  const dateiJeAufgabe = new Map();
  const dateiFuer = (cwd) => {
    for (const [id, datei] of dateiJeAufgabe) if (cwd.includes(id)) return datei;
    return 'gruss.js';
  };

  const backend = new FakeBackend(async (spec) => {
    gesehen.push(spec.role);
    if (spec.role === 'planner') {
      return {
        events: [HOOK_START],
        result: { raw: planFuer(dateiFuer(spec.cwd)), tokensIn: 100, tokensOut: 200 },
      };
    }
    if (spec.role === 'debugger') {
      return { events: [HOOK_START], result: { raw: DEBUG_OK, tokensIn: 100, tokensOut: 200 } };
    }
    if (spec.role === 'reviewer') {
      // Schnell und zustimmend: was hier geprüft wird, endet vor dem Merge, und
      // eine rote Review schickte die Aufgabe über §9s roten Pfad in eine
      // Debugger-Sitzung — Lärm, der über den Schalter nichts sagt.
      return { events: [HOOK_START], result: { raw: APPROVED, tokensIn: 100, tokensOut: 200 } };
    }
    // Der Coder: schreibt wirklich in seinen Arbeitsbaum, damit §7.3 Schritt 2
    // etwas zu sichern hat, und trödelt dann.
    await writeFile(
      join(spec.cwd, dateiFuer(spec.cwd)),
      // Bewusst ohne Template-Literal: `${…}` in einer Zeichenkette ist nach
      // A124 ein Blocker im Lint-Gate, und der Inhalt ist hier beliebig.
      'export const gruss = (name) => "hallo " + name;\n',
      'utf8',
    ).catch(() => undefined);
    return {
      events: [
        HOOK_START,
        { type: 'assistant_text', text: 'arbeite …' },
        { type: 'assistant_text', text: 'arbeite noch …' },
        { type: 'assistant_text', text: 'immer noch …' },
        { type: 'assistant_text', text: 'gleich fertig …' },
      ],
      stepDelayMs: CODER_STEP_MS,
      result: {
        raw: { status: 'done', summary: 'Umgesetzt.', artifacts: [], followups: [] },
        tokensIn: 100,
        tokensOut: 200,
      },
    };
  });

  const activeRuns = new ActiveRunRegistry();
  const runner = new AgentRunner({
    sql: studio,
    eventLog,
    backend,
    activeRuns,
    paths: {
      roleSettingsDir: join(scratch, 'claude'),
      runsRoot: join(scratch, 'runs'),
      transcriptsRoot: join(scratch, 'transcripts'),
      mcpServerEntry: null,
    },
    onWarning: (message) => console.warn(`  ! ${message}`),
  });
  const wrapUp = new WrapUpService({
    tasks,
    eventLog,
    activeSessions: () => activeRuns.list(),
    onWarning: (message) => console.warn(`  ! ${message}`),
  });
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
    gateTools: () => [],
    onWarning: (message) => console.warn(`  ! ${message}`),
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

  const settings = new ControllingSettings(studio, (message) => console.warn(`  ! ${message}`));
  const meter = new UsageMeter({ sql: studio, eventLog });
  /** Das zweite Tor (§7.2). Beobachtet, weil `WorkGate` selbst hier nichts trägt. */
  const tor = { paused: false, calls: [] };
  const guardian = new GuardianService({
    sql: studio,
    meter,
    eventLog,
    queue: {
      pause: async () => {
        tor.paused = true;
        tor.calls.push('pause');
      },
      resume: async () => {
        tor.paused = false;
        tor.calls.push('resume');
      },
      get isPaused() {
        return tor.paused;
      },
    },
    activeRuns: () => activeRuns.list(),
    wrapUp,
    // Entscheidung 2: derselbe Haken, den `main.ts` verdrahtet.
    manualPause: () => settings.manualPause(),
    // Die Gnadenfrist läuft im Lauf ab, statt eine Minute zu kosten.
    graceMs: 200,
  });

  /**
   * Ein Ablaufplaner, so oft gebaut wie der Daemon gestartet wird.
   *
   * Eine Funktion statt einer Konstante, weil Prüfgruppe 4 einen **Neustart**
   * nachstellt und ein Neustart genau das ist: ein neuer `Scheduler`. Die
   * Quarantäne aus A57.4 liegt absichtlich im Prozess — „eine Aussage über
   * *diesen* Dispatcher, und ein Neustart mit korrigiertem Code soll die
   * Aufgabe sofort wieder aufnehmen". Gemessen, nicht hergeleitet: mit einer
   * einzigen Instanz quarantänisierte der Ablaufplaner die unterbrochene
   * Aufgabe (die alte Kette lief noch und stiess auf A78.7s Rollenabgleich),
   * und `recheckInterrupted` übersprang sie danach für immer — die
   * §7.2-Prüfung wäre nie gelaufen, und die Zeile hätte das als Befund über
   * §7.2 gemeldet statt als das, was es ist: der tote Prozess, der weiterläuft.
   */
  const baueScheduler = () =>
    new Scheduler({
      tasks,
      projects,
      claims,
      guardian,
      devChain,
      // Attrappe: was hier geprüft wird, endet vor dem Merge. Eine leere
      // Warteschlange ist der ehrliche Zustand, keine Vereinfachung.
      mergeQueue: {
        list: async () => [],
        runOnce: async () => ({ status: 'idle' }),
        enqueue: async () => undefined,
      },
      integrity,
      deploys: new DeployService({
        sql: studio,
        records: new DeployRecords(studio),
        eventLog,
        tasks,
        escalations,
        targets: new Map(),
        guardianState: async () => (await guardian.evaluate()).state,
        run: async () => ({ ok: false, code: null, output: 'kein Deploy in dieser Prüfung' }),
      }),
      deployHandover: taskDeployHandover(studio),
      escalations,
      eventLog,
      infraHistory: chainInfraHistory(studio),
      concurrency: 1,
      onWarning: (message) => console.warn(`  ! ${message}`),
    });

  let scheduler = baueScheduler();

  // --- Ausgangslage --------------------------------------------------------
  const project = await projects.create({
    slug: 'pause-sandkasten',
    name: 'Pause-Sandkasten',
    rootPath: repo,
    defaultBranch: 'main',
  });

  const laufende = await tasks.create({
    projectId: project.id,
    title: 'Arbeit, die beim Schalten läuft',
    description: 'Von check-pause.mjs angelegt.',
    acceptanceCriteria: ['läuft, wenn die Pause kommt'],
    priority: 'P1',
    actor: 'check-pause',
  });
  /** Existiert nur für Zusicherung 2: sie darf während der Pause nicht starten. */
  const wartende = await tasks.create({
    projectId: project.id,
    title: 'Arbeit, die während der Pause nicht starten darf',
    description: 'Von check-pause.mjs angelegt.',
    acceptanceCriteria: ['bleibt in der Warteschlange'],
    priority: 'P3',
    actor: 'check-pause',
  });
  dateiJeAufgabe.set(laufende.id, 'gruss.js');
  dateiJeAufgabe.set(wartende.id, 'gruss.js');

  // Der Wächter muss vor dem ersten Schalten auf `normal` stehen, sonst wäre
  // alles Folgende eine Beobachtung über das Budget statt über den Schalter.
  await meter.ingestOfficialWindow('five_hour', 0.03, {
    resetsAt: Date.now() + 4 * 60 * 60_000,
  });
  const start = await guardian.evaluate();
  if (start.state !== 'normal') {
    nichtsGeprueft(
      `der Wächter steht schon vor dem ersten Schalten auf „${start.state}" ` +
        `(${JSON.stringify(start.reason)}).`,
    );
  }

  console.log('\x1b[1mPause-Schalter (§22 Phase 7, Gate 6) am laufenden Studio\x1b[0m');
  console.log(`  Sandkasten: ${repo}`);
  console.log(`  Ticks für Zusicherung 2: ${TICKS}\n`);

  // Tick 1 startet die Kette und wartet **nicht** auf sie (A57.2) — genau
  // deshalb kann hier überhaupt etwas „laufen".
  await scheduler.tick();
  const laeuft = await warteAuf(async () => {
    const aktuell = await tasks.get(laufende.id);
    return aktuell?.state === 'coding' && activeRuns.list().length > 0;
  });
  const vorPause = await tasks.get(laufende.id);
  if (!laeuft) {
    nichtsGeprueft(
      `die Kette ist nicht bis zu einer laufenden Coder-Sitzung gekommen ` +
        `(Zustand „${vorPause?.state ?? '—'}", ${activeRuns.list().length} Sitzung(en)).\n` +
        'Ohne laufende Arbeit gibt es nichts zu parken — der Gate-Satz wäre über einem ' +
        'leeren Studio bewiesen.',
    );
  }
  const [{ n: laeufeVorPause }] =
    await studio`SELECT count(*)::int AS n FROM agent_runs WHERE role IS NOT NULL`;

  // === 1 — die harte Pause parkt die laufende Arbeit, sauber ================
  abschnitt('1 · Harte Pause parkt laufende Arbeit (§7.3)');
  const wechsel = await settings.setPause('hart', 'check-pause');
  const entscheidung = await guardian.evaluate();

  const [zeile] = await studio`
    SELECT state, resume_state, payload FROM task_events
    WHERE task_id = ${laufende.id} ORDER BY seq DESC LIMIT 1
  `;
  if (
    entscheidung.state === 'hard_stop' &&
    zeile?.state === 'parked' &&
    zeile?.resume_state === 'coding' &&
    zeile?.payload?.parkReason === 'guardian_hard_stop'
  ) {
    ok(
      'harte Pause → Wächter „hard_stop", die laufende Aufgabe steht auf „parked" ' +
        'mit Rückkehrpunkt „coding" (§7.3 Schritt 4)',
    );
  } else {
    nein(
      'erwartet war hard_stop + parked/coding/guardian_hard_stop; gelesen: Wächter ' +
        `„${entscheidung.state}", Zustand „${zeile?.state ?? '—'}", Rückkehr ` +
        `„${zeile?.resume_state ?? '—'}", Grund „${zeile?.payload?.parkReason ?? '—'}"`,
    );
  }

  /*
   * Entscheidung 7, nachgeschärft durch die Mutation, die sie überlebt hat.
   *
   * Zuerst stand hier „es gibt sie noch und keine ist `released`". Das ist wahr
   * und zu schwach: Mutation M1 (der `manualPause`-Haken entfernt, also keine
   * Pause) liess die Zeile **grün** — die Reservierungen standen dann auf
   * `active`, weil die Aufgabe weiterlief. Eine Zusicherung, die auch dann hält,
   * wenn gar nicht pausiert wurde, sagt über das Parken nichts.
   *
   * `parked` ist der richtige Wert und nicht bloss der strengere: die
   * `claims`-Sicht (0009) vergibt ihn **genau** für eine Aufgabe in
   * `parked`/`needs_decision`/`interrupted` und kommentiert ihn mit „held across
   * a pause (§10/§15)". Auf `active` zu prüfen wäre weiterhin falsch — das wäre
   * rot für eine korrekte Umsetzung.
   */
  const reserviert = await studio`
    SELECT glob, status FROM claims WHERE task_id = ${laufende.id} ORDER BY glob
  `;
  const gehalten = reserviert.filter((r) => r.status === 'parked');
  if (reserviert.length > 0 && gehalten.length === reserviert.length) {
    ok(
      `die Reservierungen bleiben über die Pause bestehen: ${reserviert
        .map((r) => `${r.glob} (${r.status})`)
        .join(', ')} — gehalten, nicht freigegeben (§7.3 Schritt 4, §10)`,
    );
  } else {
    nein(
      `§10s Sperre über die Pause fehlt: ${reserviert.length} Reservierung(en), davon ` +
        `${gehalten.length} „parked" — gelesen: ` +
        `${reserviert.map((r) => `${r.glob}=${r.status}`).join(', ') || '(keine)'}`,
    );
  }

  // §7.3 Schritt 2: `wip:` auf dem Aufgabenzweig, nie auf dem Integrationszweig.
  const zweig = `vorschicht/task-${laufende.id}`;
  let wipZeile = '';
  try {
    wipZeile = await git(repo, 'log', '-1', '--format=%s', zweig);
  } catch (fehler) {
    wipZeile = `(nicht lesbar: ${fehler.message})`;
  }
  const hauptZeile = await git(repo, 'log', '-1', '--format=%s', 'main');
  if (wipZeile.startsWith('wip:') && !hauptZeile.startsWith('wip:')) {
    ok(`Zwischenstand gesichert: „${wipZeile}" auf ${zweig}, „main" unberührt (§7.3 Schritt 2)`);
  } else {
    nein(
      `erwartet war ein „wip:"-Commit auf ${zweig} und keiner auf main; gelesen: ` +
        `Zweig „${wipZeile}", main „${hauptZeile}"`,
    );
  }

  // A26/§19: eine Zeile je Schaltung, mit Vorher und Nachher.
  const [prot] = await studio`
    SELECT actor, action, subject, before, after FROM audit_log
    WHERE action = 'config.pause_changed' ORDER BY occurred_at DESC, id DESC LIMIT 1
  `;
  if (
    prot?.actor === 'check-pause' &&
    prot?.subject === PAUSE_KEY &&
    prot?.before?.modus === wechsel.before &&
    prot?.after?.modus === wechsel.after
  ) {
    ok(
      `Prüfpfad (§19/A26): ${prot.actor} · ${prot.action} · ` +
        `${prot.before.modus} → ${prot.after.modus}`,
    );
  } else {
    nein(
      `die Zeile in audit_log stimmt nicht: ${JSON.stringify(prot ?? null)} ` +
        `(erwartet ${wechsel.before} → ${wechsel.after} durch „check-pause")`,
    );
  }

  // === 2 — danach startet über mehrere Ticks nichts Neues ===================
  abschnitt(`2 · Über ${TICKS} Durchgänge startet keine neue Sitzung (§7.2)`);
  const berichte = [];
  for (let i = 0; i < TICKS; i += 1) {
    berichte.push(await scheduler.tick());
    await new Promise((r) => setTimeout(r, 20));
  }
  const [{ n: laeufeNachher }] =
    await studio`SELECT count(*)::int AS n FROM agent_runs WHERE role IS NOT NULL`;
  const wartendeZeile = await tasks.get(wartende.id);
  const alleGeblockt = berichte.every((b) => b.idle === 'guardian' && b.started.length === 0);

  if (alleGeblockt && laeufeNachher === laeufeVorPause && wartendeZeile?.state === 'queued') {
    ok(
      `jeder der ${TICKS} Durchgänge meldet idle="guardian" und startet nichts; ` +
        `agent_runs bleibt bei ${laeufeNachher}, und die wartende Aufgabe steht ` +
        'unverändert auf „queued"',
    );
  } else {
    nein(
      `in ${TICKS} Durchgängen ist etwas gestartet: idle=` +
        `${berichte.map((b) => b.idle ?? 'null').join(',')}, agent_runs ` +
        `${laeufeVorPause} → ${laeufeNachher}, wartende Aufgabe ` +
        `„${wartendeZeile?.state ?? '—'}"`,
    );
  }
  if (tor.paused) {
    ok('das zweite Tor ist zu: die Warteschlange wurde pausiert (§7.2)');
  } else {
    nein('die Warteschlange wurde nicht pausiert — `queue.pause()` blieb ungerufen');
  }

  /*
   * §7.3 Schritt 5, und er ist hier keine Formalie, sondern die Bedingung, unter
   * der die Prüfgruppe 3 überhaupt etwas aussagt.
   *
   * „Guardian confirms zero active sessions before declaring wrap-up complete."
   * Der erste Lauf dieses Skripts hat gezeigt, warum: die unterbrochene Kette
   * lief noch, während schon zurückgeschaltet wurde — `resumeAll()` setzte die
   * Aufgabe auf „coding", und Sekundenbruchteile später kam die alte Kette an
   * ihrem `park()` an und parkte sie erneut. Die Zeile las sich als „das
   * Fortsetzen funktioniert nicht" und war ein Wettlauf im Prüfskript.
   */
  const ruhig = await warteAuf(async () => activeRuns.list().length === 0, 60_000);
  await scheduler.settle();
  if (ruhig) {
    ok('§7.3 Schritt 5: nach dem Parken läuft keine Sitzung mehr');
  } else {
    nein(`nach dem Parken laufen noch ${activeRuns.list().length} Sitzung(en) (§7.3 Schritt 5)`);
  }

  /*
   * Die wartende Aufgabe wird nach Zusicherung 2 abgebrochen.
   *
   * Ihre Aussage ist damit vollständig gemessen. Liesse man sie stehen, liefe
   * sie nach dem Fortsetzen an, beanspruchte denselben Glob wie die geparkte
   * und bliebe nach §10 blockiert — nachdem sie den einen Sitzungsplatz
   * (Nebenläufigkeit 1) für ihre Planer-Sitzung belegt hat. Der Rest des
   * Laufes wäre dann eine Aussage über die Reihenfolge zweier Aufgaben statt
   * über den Schalter. `task_events` ist append-only: die Spur bleibt
   * vollständig, abgebrochen wird der Zustand (A44.5s Haltung, hier für eine
   * Aufgabe).
   */
  await tasks.transition(wartende.id, 'aborted', {
    actor: 'check-pause',
    reason:
      'Zusicherung 2 ist gemessen — die Aufgabe wird abgebrochen, damit sie den ' +
      'einen Sitzungsplatz der folgenden Prüfgruppen nicht belegt.',
  });

  // === 3 — Fortsetzen führt zurück =========================================
  abschnitt('3 · Fortsetzen führt zurück (A26)');
  await settings.setPause('normal', 'check-pause');
  const zurueck = await guardian.evaluate();
  if (zurueck.state === 'normal' && !tor.paused) {
    ok('Fortsetzen → Wächter „normal", die Warteschlange läuft wieder');
  } else {
    nein(
      `nach dem Zurückschalten steht der Wächter auf „${zurueck.state}" und die ` +
        `Warteschlange ist ${tor.paused ? 'noch pausiert' : 'offen'}`,
    );
  }

  const [prot2] = await studio`
    SELECT actor, before, after FROM audit_log
    WHERE action = 'config.pause_changed' ORDER BY occurred_at DESC, id DESC LIMIT 1
  `;
  if (prot2?.before?.modus === 'hart' && prot2?.after?.modus === 'normal') {
    ok(`auch das Zurückschalten steht im Prüfpfad: hart → normal durch „${prot2.actor}"`);
  } else {
    nein(`das Zurückschalten fehlt im Prüfpfad: ${JSON.stringify(prot2 ?? null)}`);
  }

  /*
   * Die geparkte Aufgabe muss wirklich weiterlaufen — und der Nachweis dafür
   * ist eine **neue Sitzung**, nicht ein Zustandswechsel.
   *
   * `resumeAll()` setzt den Zustand schon beim Zurückschalten auf „coding";
   * eine Wartebedingung auf den Zustand ist also im selben Augenblick erfüllt
   * und misst nichts. Genau daran ist der erste Lauf dieses Skripts gescheitert
   * — die Zeile war rot, obwohl die Sitzung Sekundenbruchteile später anlief.
   * Gewartet wird deshalb auf `agent_runs`, und A57.2 ist der Grund, warum das
   * ein Warten sein muss: der Tick startet und kehrt zurück.
   */
  await scheduler.tick();
  const weiter = await warteAuf(async () => {
    const [{ n }] = await studio`SELECT count(*)::int AS n FROM agent_runs WHERE role IS NOT NULL`;
    return n > laeufeNachher;
  }, 20_000);
  const danach = await tasks.get(laufende.id);
  const [{ n: laeufeNachResume }] =
    await studio`SELECT count(*)::int AS n FROM agent_runs WHERE role IS NOT NULL`;
  if (weiter && !['parked', 'interrupted', 'queued'].includes(danach?.state ?? '')) {
    ok(
      `die geparkte Arbeit läuft weiter: Zustand „${danach?.state}", und ` +
        `agent_runs ist von ${laeufeNachher} auf ${laeufeNachResume} gestiegen — ` +
        'es läuft wieder eine Sitzung',
    );
  } else {
    nein(
      `die Aufgabe steht nach dem Fortsetzen auf „${danach?.state ?? '—'}" und ` +
        `agent_runs bei ${laeufeNachResume} (vorher ${laeufeNachher})`,
    );
  }

  // === 4 — A26s Nebensatz: die §7.2-Integritätsprüfung ======================
  abschnitt('4 · Die §7.2-Integritätsprüfung (A26s Zusatz, Entscheidung 8/9)');
  /*
   * Erst die fortgesetzte Kette zu Ende laufen lassen und die Aufgabe dann
   * abbrechen — aus demselben Grund wie bei der wartenden oben.
   *
   * Ihre Aussage ist gemessen. Stünde sie weiter in der Warteschlange, belegte
   * sie bei Nebenläufigkeit 1 den einen Sitzungsplatz, den die
   * §7.2-Integritätsprüfung braucht (`recheckInterrupted` kehrt sofort um, wenn
   * `inFlight` voll ist) — die Prüfgruppe meldete dann einen Befund über die
   * Terminplanung statt über §7.2.
   */
  await scheduler.settle();
  const restzustand = (await tasks.get(laufende.id))?.state ?? null;
  if (restzustand && !['done', 'aborted'].includes(restzustand)) {
    await tasks
      .transition(laufende.id, 'aborted', {
        actor: 'check-pause',
        reason:
          'Zusicherung 3 ist gemessen — die Aufgabe wird abgebrochen, damit sie den ' +
          'einen Sitzungsplatz der Integritätsprüfung nicht belegt.',
      })
      .catch((e) => console.warn(`  ! Abbruch der ersten Aufgabe: ${e.message}`));
  }

  const dritte = await tasks.create({
    projectId: project.id,
    title: 'Arbeit, die ein Neustart mitten im Lauf erwischt',
    description: 'Von check-pause.mjs angelegt.',
    acceptanceCriteria: ['wird vor dem Weiterlaufen geprüft'],
    priority: 'P0',
    actor: 'check-pause',
  });
  // Eigene Reservierung: die geparkte Aufgabe von oben hält „gruss.js" bis zum
  // Merge (§10), und ein Zusammenstoss wäre hier ein Befund über §10.
  dateiJeAufgabe.set(dritte.id, 'andere.js');
  await scheduler.tick();
  const inArbeit = await warteAuf(async () => {
    const aktuell = await tasks.get(dritte.id);
    return aktuell?.state === 'coding' && activeRuns.list().length > 0;
  });
  if (!inArbeit) {
    grenzen.push(
      'Die vierte Prüfgruppe kam nicht bis zu einer laufenden Sitzung — die ' +
        '§7.2-Prüfung wurde in diesem Lauf nicht erreicht.',
    );
    nein('die dritte Aufgabe ist nicht bis „coding" mit laufender Sitzung gekommen');
  } else {
    // Entscheidung 9: der Neustart, gefahren statt behauptet. Der Lauf hat in
    // diesem Moment kein `terminated` — genau das, was ein getöteter Daemon
    // in der Datenbank hinterlässt.
    //
    // Genannter Preis der Nachstellung: der Prozess lebt hier weiter, während
    // ein echter Neustart ihn beendet hätte. `reconcile()` schreibt das fehlende
    // `terminated` unter der nächsten freien `seq`, und wenn die echte Sitzung
    // danach ihre eigene schreiben will, weist die Datenbank sie ab
    // (`agent_run_events_run_id_seq_key`). Die Warnung darüber steht im Lauf und
    // ist eine Eigenschaft der Nachstellung, kein Befund über das Studio.
    const bilanz = await reconcile({ sql: studio, tasks, eventLog });

    // Der tote Prozess läuft aus, und **danach** startet der Daemon neu: ein
    // neuer `Scheduler`, weil A57.4s Quarantäne im Prozess liegt (siehe
    // `baueScheduler`). Genau das ist ein Neustart.
    await scheduler.settle();
    scheduler = baueScheduler();

    const unterbrochen = await tasks.get(dritte.id);
    if (unterbrochen?.state === 'interrupted') {
      ok(
        `ein Neustart mitten im Lauf markiert die Aufgabe „interrupted" ` +
          `(${bilanz.orphanRuns.length} verwaiste(r) Lauf, ` +
          `${bilanz.interruptedTasks.length} Aufgabe(n))`,
      );
    } else {
      nein(`nach dem Neustart steht die Aufgabe auf „${unterbrochen?.state ?? '—'}"`);
    }

    // A43.3: die Datenbank selbst verweigert jede Bewegung, bis die Prüfung
    // bestanden ist. Das ist die Zusicherung, die nicht von einem Aufrufer
    // abhängt, der daran denkt.
    let verweigert = null;
    try {
      await tasks.resume(dritte.id, { actor: 'check-pause' });
    } catch (fehler) {
      verweigert = fehler.message;
    }
    if (verweigert) {
      ok(`die Datenbank verweigert die Fortsetzung ohne bestandene Prüfung (A43.3)`);
    } else {
      nein('eine unterbrochene Aufgabe liess sich ohne Integritätsprüfung fortsetzen');
    }

    await scheduler.tick();
    await scheduler.settle();
    const [gepruft] = await studio`
      SELECT payload FROM task_events
      WHERE task_id = ${dritte.id} AND kind = 'integrity_check' ORDER BY seq DESC LIMIT 1
    `;
    const wiederAktiv = await tasks.get(dritte.id);
    if (gepruft?.payload?.ok === true && wiederAktiv?.state !== 'interrupted') {
      ok(
        'der nächste Durchgang lässt §7.2 laufen und gibt die Aufgabe erst danach ' +
          `frei — Zustand jetzt „${wiederAktiv?.state}"`,
      );
    } else {
      nein(
        `§7.2s Prüfung ist nicht bestanden durchgelaufen: ` +
          `${JSON.stringify(gepruft?.payload ?? null)}, Zustand ` +
          `„${wiederAktiv?.state ?? '—'}"`,
      );
    }
  }

  grenzen.push(
    `Rollen dieses Laufs: ${[...new Set(gesehen)].join(', ')} — alle über das ` +
      '`fake`-Backend (A37), also ohne bezahlten Modellauf.',
  );
} catch (fehler) {
  console.error(`\ncheck-pause — abgebrochen: ${fehler.stack ?? fehler.message}`);
  rot += 1;
} finally {
  await studio?.end({ timeout: 5 }).catch(() => undefined);
  await database?.drop().catch(() => undefined);
  if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}

console.log('\n\x1b[1mNicht geprüft:\x1b[0m');
console.log(
  '  - Die `config`-Zeile der **laufenden** Installation. Dieser Lauf legt seine eigene\n' +
    '    Datenbank an (Entscheidung 4); bewiesen ist der Mechanismus auf demselben Schema,\n' +
    '    nicht der Schalterstand auf dem Produktionshost.',
);
console.log(
  '  - Die Oberfläche. Dass der Knopf der Controlling-Seite diese Zeile schreibt, belegt\n' +
    '    `e2e/controlling.spec.ts` im Browser; hier beginnt der Weg bei `config`.',
);
console.log(
  '  - Kein echtes Modell und kein echtes Deployment: das Backend ist `fake` (A37), die\n' +
    '    Merge-Queue ist eine Attrappe und es ist kein Deploy-Ziel registriert. Geprüft\n' +
    '    ist der Wächter und der Ablaufplaner, nicht die Kette darunter.',
);
console.log(
  '  - `WorkGate`/`JobQueue` selbst: das zweite Tor wird hier beobachtet, nicht gefahren.\n' +
    '    Heute trägt ohnehin die Wächterabfrage im Tick die Sperre (A106.2).',
);
for (const limit of grenzen) console.log(`  - ${limit}`);

console.log(`\n\x1b[1mErgebnis:\x1b[0m ${gruen} grün · ${rot} rot`);
exit(rot === 0 && gruen > 0 ? 0 : 1);
