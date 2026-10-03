/**
 * Orchestrator daemon entry point.
 *
 * Two contracts live here and nowhere else.
 *
 * **§6.1's startup contract:** the daemon does not accept work until the
 * self-checks pass, and a failed auth check makes it *idle with an alert*
 * rather than crash-loop. A crash loop would turn a recoverable auth incident
 * into pages of noise and, under compose's restart policy, into a hot loop.
 *
 * **The loop that actually runs the studio.** Everything Phase 2 built — the
 * dev chain, the merge queue, the claim registry, §7.2's re-check, the
 * Betriebsprüfung — is assembled here and driven by `Scheduler.tick()`, once per
 * healthy pass of the self-check cycle. The tick is deliberately cheap and never
 * awaits the work it starts, which is what lets the same loop re-evaluate the
 * budget guardian every pass while a 90-minute Coder session is running.
 */
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import {
  ActiveRunRegistry,
  AgentMigrationReviewer,
  AgentRunner,
  type AuditService,
  AutoSecretScanner,
  ClaimRegistry,
  ComposeDeployTarget,
  ControllingSettings,
  createMailer,
  type DeployTarget,
  DevChain,
  EscalationMailService,
  EscalationPushService,
  EscalationService,
  EventLog,
  FindingsService,
  GateSuite,
  GuardianService,
  getProfile,
  HeadlessBackend,
  HttpRadarFeeds,
  IntegrityCheck,
  JobQueue,
  loadConfig,
  MergeQueue,
  Notifier,
  OnboardingService,
  PersonaSettings,
  PROFILE_IDS,
  type ProjectRecord,
  ProjectService,
  RADAR_INTERVAL_MS,
  RadarScan,
  RunRecords,
  reconcile,
  redact,
  type Scheduler,
  SourceAuditLog,
  SourceProposals,
  SourceRegistry,
  StaticRsyncDeployTarget,
  TaskService,
  TranscriptLeakScan,
  UsageEstimator,
  UsageMeter,
  verifyRoleSettings,
  WeeklyReportGenerator,
  WorktreeManager,
  WrapUpService,
  writeRoleSettings,
} from '@vorschicht/core';
import { MetricsService } from '@vorschicht/core/metrics';
import { createSql, migrate } from '@vorschicht/db';
import { PLAN_PROFILES, readProjectGateConfig } from '@vorschicht/shared';
import { personaFlavorEnabled } from '@vorschicht/shared/personas';
import pino from 'pino';
import { runAuditFindingsPass } from './audit-findings-pass.js';
import { runBackupPass } from './backup-pass.js';
import { budgetAnomalyCard } from './budget-anomaly.js';
import { buildScheduler } from './build-scheduler.js';
import { DISK_CHECK_INTERVAL_MS, runDiskWatch } from './disk-watch.js';
import { type CycleState, selfCheckCycle } from './incident-cycle.js';
import {
  type NotificationsPassState,
  notifierTopics,
  runNotificationsPass,
} from './notifications-pass.js';
import { type PeriodicJob, runPeriodicPass } from './periodic-pass.js';
import { runReportPass } from './report-pass.js';
import {
  assertPinnedCliVersion,
  assertSimpleModeOff,
  assertSubscriptionAuth,
  type CheckResult,
  parseAuthStatus,
} from './self-check.js';
import { newSourcesPassState, runSourcesPass } from './sources-pass.js';
import { SmokeGate, smokeAndReport } from './startup-smoke.js';
import { assessTokenAge, readTokenInstall } from './token-age.js';
import { WorkGate } from './work-gate.js';
import { checkWritablePaths, repairAdvice } from './writable-paths.js';

const run = promisify(execFile);

/** How long to idle between self-check retries after an auth incident. */
const AUTH_RETRY_MS = 5 * 60_000;

/**
 * §10: "Orphan-worktree GC runs daily."
 *
 * Also runs once at startup, and that is the more useful of the two occasions:
 * a restart is exactly when orphans appear, because whatever the previous
 * process was in the middle of is now nobody's. The pass itself removes only
 * worktrees of finished or unknown tasks, refuses dirty ones, and never forces
 * anything — see `WorktreeManager.gc`.
 */
const WORKTREE_GC_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * Liveness marker read by the container healthcheck and by the host watchdog
 * (§18.1). A file rather than an HTTP endpoint because the watchdog is a
 * systemd timer on the host that already has docker access, and because a
 * daemon that is wedged mid-loop stops touching the file while a socket would
 * still accept connections.
 */
const HEARTBEAT_PATH = '/tmp/vorschicht-heartbeat';
const HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * How often the scheduler looks for something to do.
 *
 * Short, because a tick is cheap by construction: it asks the guardian, reads
 * two indexed queries and returns without waiting for anything it started. It
 * is also the interval at which the budget guardian is re-evaluated, which is
 * the reason it must not become long — §7.2's thresholds are only as timely as
 * the loop that reads them.
 */
const TICK_INTERVAL_MS = 15_000;

/**
 * How often §7.1's estimating meter recomputes (A6).
 *
 * Slower than a tick and much faster than the meter's own staleness limit
 * (`MAX_SAMPLE_AGE_MS`, 15 minutes), which is the constraint that matters: an
 * estimate that ages past it degrades to `unavailable` and closes the gate. A
 * minute keeps the reading fresh while writing ~1400 rows a day into a table
 * that is append-only and kept, rather than one every fifteen seconds.
 *
 * The gap it costs is bounded and small: at most one further session can start
 * on a reading up to a minute old, against 20 percentage points of headroom
 * between the degraded threshold and the hard stop.
 */
const ESTIMATE_INTERVAL_MS = 60_000;

/**
 * §6.6 says "nightly". Once a day, dated from the archive's own last scan
 * rather than from a wall clock: the deadline reads a `scan.finished` row, so a
 * restart at 03:00 does not re-run a sweep that already ran at 02:00 (A105.3).
 * Which hour it lands on is therefore whichever hour the daemon started on —
 * right for a sweep whose only requirement is "once between two days of
 * transcripts", and wrong only for §16's weekly report, which needs a
 * wall-clock time and will need supercronic for it.
 */
const TRANSCRIPT_SCAN_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * A7: parallel agent sessions, by plan profile.
 *
 * `PLAN_PROFILES` rather than a copy of the same two numbers. The copy that
 * used to stand here was A81's defect in miniature — two declarations of one
 * fact, agreeing until somebody edits one — and it became load-bearing the
 * moment §17.8's Controlling page started telling the operator what concurrency the
 * daemon runs with. A number shown on a page and a number used by the scheduler
 * that can silently differ is worse than showing nothing.
 */
const CONCURRENCY_BY_PLAN = {
  max_20x: PLAN_PROFILES.max_20x.concurrency,
  max_5x: PLAN_PROFILES.max_5x.concurrency,
} as const;

/**
 * Where §21's idle-audit sessions run — the one scratch dir that is not a
 * profile id.
 *
 * The loop below derives every other scratch directory from the profile table,
 * deliberately (A108.8): a hand-kept list forgets the next profile and the
 * symptom is a session dying at spawn months later. This one cannot come from
 * there, because an idle audit is *several* profiles sharing one directory —
 * Sasha, Lena, Otto and Uli each take some of §21's ten domains, and two of
 * them run in their own worktree for their ordinary work. So it is named here
 * and created explicitly beside the loop, where the exception is visible rather
 * than implied.
 */
const IDLE_AUDIT_SCRATCH_DIR_NAME = 'idle-audit';

/**
 * How long a graceful stop may take before the daemon exits anyway.
 *
 * Must stay under the compose `stop_grace_period`, or docker's SIGKILL lands in
 * the middle of the park — which is worse than not trying, because a task
 * half-way through its WIP commit is exactly the mess §7.2's re-check then has
 * to sort out.
 */
const SHUTDOWN_GRACE_MS = 20_000;

function beat(): void {
  try {
    writeFileSync(HEARTBEAT_PATH, `${Date.now()}\n`);
  } catch {
    // A missing heartbeat is itself the signal; failing to write one must not
    // take down the daemon.
  }
}

/**
 * The Bash scopes a Coder in this project may use (A46.4).
 *
 * Deliberately empty when the project has not declared any: a guessed
 * `Bash(pnpm:*)` would be both too wide for a project that uses make and useless
 * to one that uses cargo. Until onboarding proposes them, a Coder can edit and
 * commit and cannot run a build — which is the honest state.
 */
export function gateTools(project: ProjectRecord): readonly string[] {
  return readProjectGateConfig(project.gateConfig).tools;
}

async function claudeVersion(): Promise<string> {
  const { stdout } = await run('claude', ['--version'], { timeout: 30_000 });
  return stdout.trim();
}

async function claudeAuthStatus(): Promise<string> {
  const { stdout } = await run('claude', ['auth', 'status', '--json'], { timeout: 30_000 });
  return stdout.trim();
}

export async function runSelfChecks(pinnedVersion: string): Promise<CheckResult[]> {
  const results: CheckResult[] = [assertSimpleModeOff(process.env)];

  try {
    results.push(assertPinnedCliVersion(await claudeVersion(), pinnedVersion));
  } catch (error) {
    results.push({
      ok: false,
      reason: `claude --version schlug fehl: ${(error as Error).message}`,
    });
  }

  try {
    results.push(assertSubscriptionAuth(parseAuthStatus(await claudeAuthStatus())));
  } catch (error) {
    results.push({
      ok: false,
      reason: `claude auth status schlug fehl: ${(error as Error).message}`,
    });
  }

  return results;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });
  logger.info({ config: redact(config) }, 'Orchestrator startet');

  // §16's topics are configurable, and until `topics` was passed here they were
  // not: `NTFY_TOPIC_INBOX`, `_ALERTS` and `_INFO` were parsed by `loadConfig`,
  // carried through the config object and read by nobody, so the hard-coded
  // defaults always won on every installation.
  const notifier = new Notifier({
    server: config.ntfyServer,
    token: config.ntfyToken,
    topics: notifierTopics(config),
  });
  const sql = createSql({ url: config.databaseUrl, max: 8 });
  const eventLog = new EventLog(sql);
  // §16s Wochenbericht. `MetricsService` kommt über den Unterpfad
  // `@vorschicht/core/metrics` und nicht über das Barrel: dort kollidiert
  // `GateRunRecord` mit `findings.js` (A143.5), und einen Namen umzubenennen,
  // um einen Export zu ermöglichen, wäre die falsche Richtung.
  const weeklyReportGenerator = new WeeklyReportGenerator({
    sql,
    metrics: new MetricsService({ sql }),
  });
  const tasks = new TaskService({ sql, eventLog });
  const projects = new ProjectService(sql);
  const worktrees = new WorktreeManager({
    tasks,
    projects,
    eventLog,
    root: config.worktreesRoot,
  });

  // Every live model session announces itself here, and both halves of §7.2/§7.3
  // read it: the guardian to stop sessions, the wrap-up to preserve their work.
  // Until this existed the daemon passed `() => []` to both, so a guardian
  // transition recorded that it had stopped everything while stopping nothing.
  const activeRuns = new ActiveRunRegistry();
  const wrapUp = new WrapUpService({
    tasks,
    eventLog,
    activeSessions: () => activeRuns.list(),
  });

  // §15's inbox. One instance, shared: the dev chain, the merge queue and the
  // integrity check all reach §9's second failure through their own `RedPath`,
  // the meter reaches §7.1's anomaly through it, and the Betriebsprüfung reaches
  // §8.2's P1 item through it. Every one of those has to land in the same
  // postbox. Constructed first because the meter below now writes into it.
  const escalations = new EscalationService({ sql, eventLog });

  /**
   * §15's and §16's outgoing side (§22 Phase 4 step 4).
   *
   * `EscalationMailService.tick()` had no caller at all — A13's reminder and
   * digest were built, tested against a real Postgres, and unreachable in
   * operation, with `REPORT_RECIPIENT` parsed and read by nobody. The push
   * observer is new. Both are driven from `runNotificationsPass`, which is where
   * the reporting decisions and their tests live; here there is only wiring.
   */
  /**
   * §14's proposal flow (§22 Phase 6 step 3).
   *
   * `source_proposal` has stood in `ESCALATION_SOURCES` since Phase 4 with no
   * producer; this is both halves of it — the card, and the reader that carries
   * out what the operator answered. The write path goes through `curate` so that a
   * curation and §19's `audit_log` row are one transaction, which is the seam
   * `SourceRegistry` hands over and `apps/server` closes on the other channel.
   */
  const sourceProposals = new SourceProposals({
    sql,
    registry: new SourceRegistry(sql),
    curate: (fn) =>
      sql.begin((tx) =>
        fn({ registry: new SourceRegistry(tx), audit: new SourceAuditLog(tx) }),
      ) as ReturnType<typeof fn>,
    escalations,
    eventLog,
  });

  const mailer = createMailer(config);
  const notifications = {
    push: new EscalationPushService({
      sql,
      eventLog,
      escalations,
      notifier,
      publicOrigin: config.publicOrigin,
    }),
    mail: new EscalationMailService({
      sql,
      eventLog,
      escalations,
      mailer,
      publicOrigin: config.publicOrigin,
      recipient: config.reportRecipient,
    }),
  };
  // Said once, at start-up, and never again per pass: an installation without
  // mail is a supported installation (`createMailer`), and a line a minute
  // saying so is the flood A13's own rules exist to avoid.
  if (!mailer.enabled || !config.reportRecipient) {
    logger.info(
      { smtp: mailer.enabled, recipient: Boolean(config.reportRecipient) },
      'E-Mail ist nicht vollständig konfiguriert (SMTP_HOST/SMTP_FROM/REPORT_RECIPIENT) — ' +
        'A13s Erinnerungen und der Tagesdigest laufen nicht; §15 pusht weiterhin über ntfy.',
    );
  }

  /**
   * §7.1's anomaly, as an inbox item rather than only a log row (§22 Phase 4.5).
   *
   * `onAnomaly` has existed since Phase 1 and the daemon passed nothing, so a
   * reading the meter refused to trust reached `event_log` and no human. What is
   * suppressed here is the repetition, not the alarm: the meter samples every
   * minute and a fresh card per minute is a muted inbox. The check is against
   * the open items rather than a variable, because the process that would hold
   * the variable is restarted more often than a budget fault is fixed.
   *
   * **A149: das ist seit dem 25.8.2026 die zweite Schicht, nicht die erste.**
   * Diese Prüfung fragt die **offenen** Eskalationen, und die geht auf, sobald
   * der Betreiber antwortet — in Produktion beobachtet als Kette #17 (beantwortet 11:57)
   * → #18 (gestellt 11:58), mit derselben Frage. Der Riegel sitzt jetzt eine
   * Ebene tiefer: `UsageMeter` ruft `onAnomaly` einmal je **Episode** statt je
   * Probe (`reportAnomaly`), belegt in `usage-meter.itest.ts`. Was hier steht,
   * fängt nur noch den Fall, dass zwei Zähler-Episoden dieselbe Frage stellen,
   * während die erste Karte noch offen ist.
   */
  const reportBudgetAnomaly = async (sample: Parameters<typeof budgetAnomalyCard>[0]) => {
    const card = budgetAnomalyCard(sample);
    if (!card) return;
    try {
      const open = await escalations.open();
      if (
        open.some((item) => item.source === 'budget_anomaly' && item.question === card.question)
      ) {
        return;
      }
      const raised = await escalations.raise({
        source: 'budget_anomaly',
        question: card.question,
        context: card.context,
        urgency: card.urgency,
        options: card.options,
        projectId: null,
        taskId: null,
        runId: null,
        raisedBy: 'controlling',
      });
      logger.warn(
        { escalation: raised.number, window: sample.window, anomaly: sample.anomaly?.kind },
        'Budget-Auffälligkeit als Entscheidung vorgelegt (§7.1)',
      );
      // The ntfy push that used to stand here is gone, and its removal is the
      // point rather than a tidy-up. It was the only producer the `inbox` topic
      // ever had, it carried **no `clickUrl`** — so §15's "deep link straight to
      // the item" was broken in the one place the channel was used — and with
      // `EscalationPushService` now watching the inbox it would have announced
      // every budget card twice. One producer, with the link (§22 Phase 4.4).
    } catch (error) {
      // The meter's own path must not fail because the inbox did: an unrecorded
      // card costs a notification, a thrown one costs the sample.
      logger.error({ err: error }, 'Budget-Auffälligkeit konnte nicht vorgelegt werden');
    }
  };

  const meter = new UsageMeter({
    sql,
    eventLog,
    onAnomaly: (sample) => void reportBudgetAnomaly(sample),
  });

  /**
   * §7.1's fallback meter (A6), and as of A59 the only one that answers.
   *
   * The official source stopped reporting on 2026-08-01, the guardian
   * correctly fails closed on an unreadable budget, and the scheduler starts
   * nothing outside `normal` — so without this the studio idles indefinitely.
   * Nothing in §7.2 is relaxed to change that: the estimate is thresholded
   * against `DEGRADED_WRAP_UP_PERCENT`, ten points tighter than the official
   * 85%, and an official reading still outranks it the moment one returns.
   */
  const estimator = new UsageEstimator({
    sql,
    meter,
    planProfile: config.planProfile,
    onWarning: (message) => logger.warn({}, message),
  });

  // §8's persona switch (§17.9). A function, not a value: read once here it
  // would go stale the moment the operator moved the switch and would take effect on the
  // next restart — a setting recorded in §19's trail as changed that quietly
  // does nothing until a deploy. Read per run, and `false` if it cannot be read
  // at all, which is A9's guarantee rather than an arbitrary fallback.
  const personas = new PersonaSettings(sql, (message) => logger.warn({}, message));

  const runner = new AgentRunner({
    sql,
    eventLog,
    backend: new HeadlessBackend(),
    activeRuns,
    usage: meter,
    paths: {
      roleSettingsDir: config.roleSettingsDir,
      runsRoot: config.runsRoot,
      transcriptsRoot: config.transcriptsRoot,
      mcpServerEntry: config.mcpServerEntry ?? null,
    },
    personaFlavor: async () => personaFlavorEnabled(await personas.mode()),
    onWarning: (message) => logger.warn({}, message),
  });

  /**
   * The guardian's "stop accepting work" handle (§7.2), now a real queue.
   *
   * This was an object literal with a boolean in it, under a comment saying "a
   * `JobQueue` drops straight in here" — while `JobQueue` itself, 298 lines and
   * tested against a real Postgres since Phase 1, was constructed nowhere in
   * production. `WorkGate` is the adapter between the two, and it exists for
   * one reason: `GuardianService.applyTransition` awaits `queue.pause()` with
   * no guard, so a queue that can throw could take a §7.2 transition with it.
   *
   * `start()` happens after `migrate()` — pg-boss builds its own schema and
   * needs a reachable database — so this is constructed here and started below.
   */
  const jobQueue = new JobQueue({
    connectionString: config.databaseUrl,
    onError: (error, context) => logger.error({ err: error, ...context }, 'Job-Warteschlange'),
  });
  const workGate = new WorkGate({ queue: jobQueue, logger, notifier });

  /**
   * §17.8's two switches, read here and written by the dashboard (A26, A22).
   *
   * The dashboard runs in `apps/server` and this runs in the orchestrator, so
   * `GuardianService.setPause` — a field on an object in *that other process* —
   * could never be reached by the operator clicking a button. What he reaches is a
   * `config` row, and this is the reader. Until this line existed A26 was a
   * mechanism with no caller, the sixth this repository has found (A71, A74.2,
   * A86, A105, A108).
   */
  const controllingSettings = new ControllingSettings(sql, (message) => logger.warn({}, message));

  const guardian = new GuardianService({
    sql,
    meter,
    eventLog,
    notifier,
    queue: workGate,
    activeRuns: () => activeRuns.list(),
    wrapUp,
    // Read on **every** evaluation rather than once at start-up: a pause that
    // only took effect after a restart is not a pause. `evaluate()` runs at the
    // head of every tick (A57.5), so the switch takes hold within one.
    manualPause: () => controllingSettings.manualPause(),
  });

  const claims = new ClaimRegistry({ sql, tasks, projects, eventLog });
  // §5's `gate_runs` / `findings`, shared between the two ends of §11's
  // pipeline: the merge queue writes what a refused merge found, the dev chain
  // reads it back into the next attempt's prompt.
  const findings = new FindingsService({ sql });
  // §6.4 reads a session back: the parked one, and the Planner's result for a
  // pass re-entered past it.
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
    gateTools: (project) => gateTools(project),
    onWarning: (message) => logger.warn({}, message),
  });
  /**
   * §12's registry, built once and read by both consumers.
   *
   * The merge queue needs the method *names* — a project it cannot deploy must
   * not be merged, because that leaves production silently behind `main`
   * (A55.6) — and the engine needs the targets themselves. Building them here
   * rather than inside `buildScheduler` is what makes "one source" true: the
   * queue is constructed well before the scheduler, and two lists derived
   * separately would agree until the day somebody registers a third method.
   */
  const deployTargets: DeployTarget[] = [new ComposeDeployTarget(), new StaticRsyncDeployTarget()];
  const deployableMethods = deployTargets.map((target) => target.method);

  const mergeQueue = new MergeQueue({
    deployableMethods,
    sql,
    tasks,
    projects,
    claims,
    worktrees,
    eventLog,
    findings,
    escalations,
    gates: (project) =>
      new GateSuite({
        sql,
        // Read per candidate rather than cached: the merge queue may hold one
        // for minutes, and a gate set edited in the meantime is the current
        // truth (§11, `ProjectService`).
        config: readProjectGateConfig(project.gateConfig),
        // §11's migration gate (A63). Wired unconditionally, because the
        // alternative — passing it only for projects that ticked the box —
        // would put the same decision in two places, and the suite already
        // starts no session for a candidate that touches no migration.
        migrationReview: new AgentMigrationReviewer({
          runner,
          eventLog,
          onWarning: (message) => logger.warn({}, message),
        }),
        onWarning: (message) => logger.warn({}, message),
      }),
    onWarning: (message) => logger.warn({}, message),
    // A25's second half. Ops owns machine failures (§8 row 8), and the `alerts`
    // topic is where §16 puts the things that mean the studio has stopped —
    // rollbacks, hard stops, auth incidents. A queue that cannot check a tree
    // belongs in that company: the tasks are safe and nothing is red, and
    // nothing will move again until somebody looks at the machine.
    onOpsAlert: async (alert) => {
      logger.error({ ...alert }, 'Anhaltender Infrastrukturfehler in der Merge-Warteschlange');
      await notifier.send({
        topic: 'alerts',
        title: 'Vorschicht: Prüfungen laufen nicht mehr',
        message:
          `Ein Merge-Kandidat steht seit ${alert.attempts} Anläufen in der Warteschlange, ohne ` +
          `dass die Prüfungen laufen konnten.\n\n${alert.problem}\n\n` +
          'Die Aufgabe ist nicht rot und wartet weiter (A25) — es fehlt eine Maschine, nicht ' +
          'eine Korrektur am Code.',
        priority: 'high',
        tags: ['warning'],
      });
    },
  });
  const integrity = new IntegrityCheck({
    tasks,
    projects,
    worktrees,
    runner,
    eventLog,
    escalations,
    onWarning: (message) => logger.warn({}, message),
  });

  /**
   * The scheduler, assembled after the schema exists.
   *
   * Deferred to a call because it reads the database: a query before `migrate()`
   * would fail on a fresh database and take the daemon down at the one moment
   * nothing is wrong with it. The assembly itself lives in `build-scheduler.ts`
   * — it used to be a nested function here, which meant the wiring the studio
   * actually runs on could not be imported by a test at all.
   */
  /**
   * §8.2s Prüfungsdienst, aus `buildScheduler` herausgereicht (A149).
   *
   * `runAuditFindingsPass` braucht denselben Dienst, den der Ablaufplaner
   * fährt. Ihn hier ein zweites Mal zu bauen hiesse, `specPath` ein zweites Mal
   * zu beantworten — die eine Frage, die A83.3 ausdrücklich ohne Vorgabe
   * gelassen hat, damit sie der Aufrufer beantwortet, der das Repository kennt.
   */
  let auditService: AuditService | null = null;

  async function makeScheduler(): Promise<Scheduler> {
    const built = await buildScheduler({
      sql,
      eventLog,
      tasks,
      projects,
      claims,
      guardian,
      devChain,
      mergeQueue,
      deployTargets,
      integrity,
      escalations,
      runner,
      onboarding: new OnboardingService({
        runner,
        eventLog,
        scratchDir: `${config.runsRoot}/onboarding`,
        onWarning: (message) => logger.warn({}, message),
      }),
      // `auditor`, not `audit`: the directory is created by the loop below from
      // the profile table, so its name has to be the profile's id or the one
      // session that runs here would find no cwd (A58). The old name survives on
      // existing installations as an empty directory nothing reads.
      auditScratchDir: `${config.runsRoot}/auditor`,
      // §21's sessions run in their own scratch dir, not the auditor's. The
      // name is not a profile id, so it needs the loop below to know about it —
      // see `SCRATCH_DIRS`.
      idleAuditScratchDir: `${config.runsRoot}/${IDLE_AUDIT_SCRATCH_DIR_NAME}`,
      // A17's third condition, from the meter §7.1 already keeps.
      usage: () => meter.currentSamples(),
      // A22 (§17.8), read on every idle slot rather than at start-up — the
      // switch has to take hold without a restart, or it is not a switch.
      sparbetrieb: async () => (await controllingSettings.sparbetrieb()).wert,
      selfRootPath: `${config.projectsRoot}/vorschicht`,
      concurrency: CONCURRENCY_BY_PLAN[config.planProfile],
      // A25's second half, for the dev chain rather than the merge queue. Same
      // number, different subsystem, and the message has to say which one — a
      // studio that has stopped is not usefully described by the wrong sentence.
      onOpsAlert: async (alert) => {
        logger.error({ ...alert }, 'Anhaltender Infrastrukturfehler in der Entwicklungskette');
        await notifier.send({
          topic: 'alerts',
          title: 'Vorschicht: Aufgaben kommen nicht voran',
          message:
            `Aufgabe ${alert.taskId} ist ${alert.attempts} Anläufe hintereinander an der ` +
            `Umgebung gescheitert, ohne dass die Entwicklungskette vorangekommen ist.\n\n` +
            `${alert.problem}\n\n` +
            'Die Aufgabe ist nicht rot und wartet weiter (A25) — es fehlt eine Maschine, nicht ' +
            'eine Korrektur am Code.',
          priority: 'high',
          tags: ['warning'],
        });
      },
      onWarning: (message) => logger.warn({}, message),
      logger,
    });

    if (built.onboarding.status === 'created') {
      logger.info(
        { projectId: built.onboarding.project.id },
        'Vorschicht ist als selbstverwaltetes Projekt angelegt (§12, A42).',
      );
    }
    if (built.selfProject) {
      logger.info(
        { projectId: built.selfProject.id, specPath: built.specPath },
        'Die Betriebsprüfung (§8.2) prüft dieses Repository.',
      );
    }
    auditService = built.audits;
    return built.scheduler;
  }

  const tokenStampPath = `${config.dataRoot}/claude/token-installed.json`;
  let lastTokenUrgency: string | null = null;
  let authIncidentParked = false;
  let lastWorktreeGc = 0;
  /** §6.1: no work is accepted until one session has demonstrably run. The
   * backoff after a failed probe lives in the gate. */
  const smokeGate = new SmokeGate(() =>
    smokeAndReport({ runner, cwd: `${config.runsRoot}/smoke`, meter, notifier, logger }),
  );
  /** §7.1's estimate runs on its own, slower cadence than the tick. */
  let nextEstimateAt = 0;
  /** Logged only when it changes — an unchanged number every minute is noise. */
  let lastEstimateText: string | null = null;
  /** §15's push runs every pass; A13's mail keeps its own deadline in here. */
  const notificationsState: NotificationsPassState = { nextMailAt: 0, mailFailing: false };
  /** §14's answered proposal cards, on their own slower cadence. */
  const sourcesState = newSourcesPassState();

  /**
   * §18's scheduled work (A30 today; §6.0's radar and §16's report next).
   *
   * The deadline lives in `event_log` rather than beside this list, so it
   * survives the restart a deploy is (`periodic-pass.ts` decision 1).
   *
   * The mounts A30 calls "relevant" are the four the daemon writes to plus the
   * projects root and the backups mount it only reads. The backups volume is
   * mounted read-only and is measured anyway, deliberately: it is the one whose
   * filling silently costs A14's nightly archive, which is precisely the class
   * of failure that went unnoticed for a week (A103).
   */
  const periodicJobs: PeriodicJob[] = [
    /**
     * §6.6's nightly transcript scan (A105), and the second consumer this
     * cadence has. It is registered *here* rather than as a queue job for the
     * reason A106.3 gives for the disk watch: a guardian-paused queue would
     * silence it for the length of a `wrap_up`, and under a weekly limit that
     * is days — for the one channel whose whole point is that a leaked
     * credential reaches the operator quickly.
     */
    {
      name: 'transcript-leak',
      intervalMs: TRANSCRIPT_SCAN_INTERVAL_MS,
      lastRunKind: 'scan.finished',
      run: async () => {
        const outcome = await new TranscriptLeakScan({
          transcriptsRoot: config.transcriptsRoot,
          gitleaksConfigPath: config.gitleaksConfigPath,
          scanner: new AutoSecretScanner(),
          eventLog,
          escalations,
        }).run();
        switch (outcome.kind) {
          case 'clean':
            return outcome.daysScanned === 0
              ? null
              : `Transkript-Scan: ${outcome.daysScanned} Tag(e) geprüft, nichts gefunden.`;
          case 'already_reported':
            return `Transkript-Scan: ${outcome.findings.length} bekannte Fundstelle(n), keine neue Karte.`;
          case 'leak':
            return (
              `Transkript-Scan: ${outcome.findings.length} neue Fundstelle(n) — ` +
              `Postfach #${outcome.escalation} (P0).`
            );
          case 'infra':
            return `Transkript-Scan konnte nicht laufen: ${outcome.problem}`;
        }
      },
    },
    {
      name: 'disk',
      intervalMs: DISK_CHECK_INTERVAL_MS,
      lastRunKind: 'disk.checked',
      run: async () => {
        const report = await runDiskWatch({
          paths: [
            config.transcriptsRoot,
            config.worktreesRoot,
            config.runsRoot,
            `${config.dataRoot}/docs`,
            config.projectsRoot,
            config.backupResultPath.replace(/\/[^/]*$/, '') || '/backups',
          ],
          transcriptsRoot: config.transcriptsRoot,
          eventLog,
          sql,
          notifier,
          logger,
        });
        if (report.level === 'ok' && !report.announced) return null;
        const worst = report.worst;
        return (
          `Plattenbelegung: ${report.level}` +
          (worst ? ` — ${worst.path} bei ${worst.displayPercent} %` : ' — nichts messbar') +
          (report.pruned ? ` · ${report.pruned.compressed} Rohtranskript(e) komprimiert` : '')
        );
      },
    },
    /**
     * §8's Rado: §6.0's billing watch, A27's CLI watch and A10's dependency and
     * advisory policy (§22 Phase 6 step 4).
     *
     * Registered on this cadence rather than as a queue job, for A106.3's
     * reason and with more force than the disk watch had: a guardian-paused
     * queue would silence it for the length of a `wrap_up`, which under a weekly
     * limit is days — for the channel that watches this project's own #1
     * external risk. §6.0 is explicit that the operator must never be surprised by a
     * billing change, and "surprised" includes "the watch was paused".
     *
     * `HttpRadarFeeds` and never `FixtureRadarFeeds`: A88.7's posture, and here
     * the fixture would report a *clean* billing channel that nobody queried.
     * With no URL configured — the state of a fresh installation — the scan says
     * so as an unchecked surface on every run instead.
     */
    {
      name: 'radar',
      intervalMs: RADAR_INTERVAL_MS,
      lastRunKind: 'radar.finished',
      run: async () => {
        const outcome = await new RadarScan({
          sql,
          eventLog,
          feeds: new HttpRadarFeeds({
            billingUrls: config.radarBillingUrls,
            cliUrl: config.radarCliUrl,
            registry: config.radarRegistry,
          }),
          escalations,
          tasks,
          projects,
          pinnedCliVersion: config.claudeCliVersion,
        }).run();
        for (const problem of outcome.problems) logger.warn({ job: 'radar' }, problem);
        // The limits are logged separately and always, because the run they
        // matter most in is the one that found nothing: without them a scan
        // that queried no channel at all reads exactly like a clean one.
        for (const limit of outcome.limits) logger.info({ job: 'radar' }, limit);
        return outcome.report;
      },
    },
  ];

  async function maybeCollectWorktrees(): Promise<void> {
    if (Date.now() - lastWorktreeGc < WORKTREE_GC_INTERVAL_MS) return;
    lastWorktreeGc = Date.now();
    try {
      const report = await worktrees.gc();
      const logged = { ...report, removed: report.removed.length };
      if (report.removed.length > 0 || report.kept.length > 0 || report.strays.length > 0) {
        logger.info(logged, 'Verwaiste Worktrees aufgeräumt');
      } else {
        logger.debug(logged, 'Worktree-Aufräumlauf ohne Fund');
      }
    } catch (error) {
      // A failed GC is untidiness, never a reason to stop accepting work.
      logger.error({ err: error }, 'Worktree-Aufräumlauf fehlgeschlagen');
    }
  }

  beat();
  const heartbeat = setInterval(beat, HEARTBEAT_INTERVAL_MS);

  let running = true;
  let stopping = false;
  // Assigned once the schema exists (see `makeScheduler`). Null until then, so
  // a signal arriving during migration finds nothing to settle rather than a
  // temporal-dead-zone error inside the shutdown path.
  let scheduler: Scheduler | null = null;

  /**
   * Stop the way §7.3 asks for, within the grace docker gives us.
   *
   * Before the scheduler existed this was `sql.end()` and `exit(0)`, which was
   * accurate: the daemon held nothing. It holds live sessions now, and a
   * container stop that simply kills them leaves every in-flight task
   * `interrupted` — recoverable since §7.2's re-check is wired, but at the cost
   * of one Debugger session per task **on every deploy**. Asking the sessions to
   * stop and parking their work turns a routine rollout back into something
   * that costs nothing.
   *
   * Bounded, because docker's grace is finite (`stop_grace_period` in the
   * compose file) and the fallback is sound: whatever does not park in time is
   * reconciled to `interrupted` at the next start and re-checked before it
   * resumes. Erring towards a fast exit is therefore safe; erring towards a
   * slow one gets us SIGKILL in the middle of the park.
   */
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    running = false;
    clearInterval(heartbeat);
    logger.info({ signal, live: activeRuns.size }, 'Fahre herunter');

    const deadline = new Promise((resolve) => setTimeout(resolve, SHUTDOWN_GRACE_MS).unref?.());
    try {
      await Promise.race([
        (async () => {
          for (const run of activeRuns.list()) await run.interrupt('guardian_wrap_up');
          await scheduler?.settle();
          const parked = await wrapUp.parkAll('manual_pause', { interruptSessions: false });
          logger.info({ parked: parked.filter((o) => o.parked).length }, 'Arbeit geparkt (§7.3)');
          // After the park, not before: pg-boss's own graceful stop waits for
          // in-flight jobs, and putting it ahead of the sessions would spend
          // part of the grace docker gives us on the component that carries the
          // least. `WorkGate.stop()` swallows, so it cannot skip the park.
          await workGate.stop();
        })(),
        deadline,
      ]);
    } catch (error) {
      logger.error({ err: error }, 'Sauberes Herunterfahren fehlgeschlagen');
    }
    await sql.end().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  // The orchestrator owns the schema: it is the only service that writes, and
  // running migrations here avoids a separate one-shot service that someone
  // would eventually forget to run.
  try {
    const { applied } = await migrate(sql);
    logger.info({ applied }, applied.length > 0 ? 'Migrationen angewendet' : 'Schema ist aktuell');
  } catch (error) {
    logger.error({ err: error }, 'Migration fehlgeschlagen — Daemon nimmt keine Arbeit an');
    await notifier.send({
      topic: 'alerts',
      title: 'Vorschicht: Migration fehlgeschlagen',
      message: (error as Error).message,
      priority: 'urgent',
      tags: ['rotating_light'],
    });
    throw error;
  }

  // Can we write where we are about to write? A hard failure for the same
  // reason containment below is: every one of these paths fails *silently* in
  // production — a transcript copy that warns and moves on, a worktree creation
  // that surfaces as a git error three frames away — and both were true of
  // every installation until the Dockerfile learned to seed the volumes (A58).
  const writable = await checkWritablePaths([
    config.runsRoot,
    config.transcriptsRoot,
    config.worktreesRoot,
    `${config.dataRoot}/docs`,
  ]);
  const unwritable = writable.filter((check) => !check.ok);
  if (unwritable.length > 0) {
    const advice = repairAdvice(unwritable);
    logger.error(
      { paths: unwritable.map((c) => c.path) },
      `Verzeichnisse nicht beschreibbar\n${advice}`,
    );
    await notifier.send({
      topic: 'alerts',
      title: 'Vorschicht: Verzeichnisse nicht beschreibbar',
      message: advice,
      priority: 'urgent',
      tags: ['rotating_light'],
    });
    throw new Error(`Verzeichnisse nicht beschreibbar:\n${advice}`);
  }

  // The scratch directories of every role that runs outside a worktree (§6.2).
  // The runner refuses a `cwd` that does not exist and says so by name (A58) —
  // which is the right behaviour and would still mean that the first
  // Betriebsprüfung on a fresh installation died on a missing directory rather
  // than on anything about the studio.
  //
  // Derived from the profile table rather than listed here, and that is the
  // whole point: a hand-kept list is a list that forgets the next profile, and
  // the symptom would be a session dying at spawn on a directory nobody thought
  // about — in a role that runs rarely, so months later. The `scratch` flag
  // already carries this fact, so nothing else has to.
  //
  // The invariant this establishes, and the reason the two call sites above and
  // the probe below spell it the same way: **a scratch cwd is
  // `<runsRoot>/<profile id>`.** `smoke` creates its own as well, which is
  // deliberate there (it runs before much else) and harmless here.
  for (const id of PROFILE_IDS) {
    if (getProfile(id).workspace !== 'scratch') continue;
    await mkdir(`${config.runsRoot}/${id}`, { recursive: true });
  }
  // §21's exception to that invariant, created explicitly rather than derived:
  // an idle audit is several profiles sharing one read-only directory, so it
  // has no profile id to be named after. Missing it would mean the first idle
  // slot on a fresh installation died on a missing `cwd` (A58.1) — in a session
  // that runs only when nothing else is queued, so nobody would be watching.
  await mkdir(`${config.runsRoot}/${IDLE_AUDIT_SCRATCH_DIR_NAME}`, { recursive: true });

  // §6.6: arm containment before anything can spawn a session.
  //
  // A hard failure, unlike the GC or the reconcile below. Every other startup
  // step can fail and leave a daemon that merely does less; this one failing
  // leaves a daemon that would run agent sessions with no write boundary — and
  // it would do so silently, because a `--settings` document the CLI cannot
  // read is discarded without a word in `-p` mode.
  try {
    await writeRoleSettings(config.roleSettingsDir, { hookEntry: config.hookEntry });
    await verifyRoleSettings(config.roleSettingsDir, { hookEntry: config.hookEntry });
    logger.info(
      { dir: config.roleSettingsDir, hook: config.hookEntry },
      'Containment-Hooks (§6.6) geschrieben und geprüft',
    );
  } catch (error) {
    logger.error({ err: error }, 'Containment konnte nicht scharfgeschaltet werden');
    await notifier.send({
      topic: 'alerts',
      title: 'Vorschicht: Containment nicht scharf',
      message:
        `${(error as Error).message}\n\nDer Daemon nimmt keine Arbeit an — Sitzungen ohne ` +
        'Schreibgrenze (§6.6) wären schlimmer als gar keine Sitzungen.',
      priority: 'urgent',
      tags: ['rotating_light'],
    });
    throw error;
  }

  // §7.2: whatever the previous process was doing when it died, nothing is
  // doing it now. Runs with no terminal event are closed and their tasks marked
  // `interrupted` — a re-check state, not a failure — before any work is
  // accepted. Doing this later would mean accepting work alongside a worktree
  // nobody has looked at.
  try {
    const state = await reconcile({ sql, tasks, eventLog });
    if (state.orphanRuns.length > 0 || state.interruptedTasks.length > 0) {
      logger.warn(
        {
          orphanRuns: state.orphanRuns.length,
          interrupted: state.interruptedTasks.length,
          stranded: state.strandedTasks.length,
        },
        'Zustand nach Neustart abgeglichen',
      );
      await notifier.send({
        topic: 'info',
        title: 'Vorschicht: Neustart abgeglichen',
        message:
          `${state.interruptedTasks.length} Aufgabe(n) als unterbrochen markiert, ` +
          `${state.orphanRuns.length} verwaiste Sitzung(en) geschlossen. ` +
          'Vor der Fortsetzung prüft der Debugger die Arbeitskopien.',
      });
    } else {
      logger.info('Kein Nachlass eines früheren Laufs gefunden');
    }
  } catch (error) {
    logger.error({ err: error }, 'Abgleich nach Neustart fehlgeschlagen');
  }

  // §4's queue, after the schema it does not share. pg-boss creates and migrates
  // its own `pgboss` schema in here, which is why this cannot sit beside the
  // constructor: on a fresh database it is the first thing that needs one.
  //
  // Reports rather than throws (`work-gate.ts` decision 3). The queue carries
  // no work yet — the dev chain is dispatched in-process (A57.1) and the first
  // `work()` arrives with Phase 6 — so refusing to boot over it would trade a
  // working studio for an idle component. What it buys today is that §7.2's
  // pause reaches something real and that Phase 6 does not discover a broken
  // queue.
  const queueState = await workGate.start();

  scheduler = await makeScheduler();

  // The loop body lives in `incident-cycle.ts` so that it can be tested with
  // injected failures — the first Betriebsprüfung (§8.2) found that the half of
  // the Phase 1 gate reading "daemon idles + ntfy alert" rested on nobody
  // having read this code. What is tested is now what runs.
  const cycleState: CycleState = { authIncidentParked };

  while (running) {
    // §15's push and A13's mail — in the loop body, not in `onReady`.
    //
    // `onReady` runs only on a *healthy* pass (`incident-cycle.ts`), and the
    // state where §15's channel matters most is the unhealthy one: during an
    // auth incident (§6.1, A28's expired token) work is parked and the open
    // decision may be the one that unsticks it. Putting the call there would
    // have silenced every push and every reminder for the whole incident, while
    // the same loop demonstrably still reaches ntfy — `selfCheckCycle` pushes
    // its own alert from it. It is also ahead of §6.1's smoke gate for the same
    // reason: these two need Postgres and a socket, not the model.
    //
    // No `try` around it: it never throws (`notifications-pass.ts`, property 1),
    // and a second guard around something that cannot throw is the dead wiring
    // this pass exists to remove. A rejection here would reach `main().catch()`
    // and exit the process, which under compose is a restart carousel.
    await runNotificationsPass({ ...notifications, notifier, logger }, notificationsState);

    // §14's other half: an answered proposal card has to *do* something, and a
    // card whose answer does nothing is the shape A86 and A105 both shipped.
    // Same placement and the same three reasons as the pass above — it needs
    // Postgres rather than the model, a decision the operator already made is worth
    // carrying out during an auth incident too, and `runSourcesPass` cannot
    // throw (`sources-pass.ts`, decision 3).
    //
    // Same weak point as its neighbours, stated where the change is: `main.ts`
    // has no test, so deleting this line kills nothing in `sources-pass.test.ts`.
    // The net is the grep in that file over this one — it proves the call site
    // exists, never that it is reached.
    await runSourcesPass({ proposals: sourceProposals, logger }, sourcesState);

    // §18's backup events, in the same place and for the same three reasons:
    // it needs Postgres and a socket rather than the model, a broken backup is
    // exactly as worth reporting during an auth incident as outside one, and
    // `runBackupPass` cannot throw (`backup-pass.ts`, decision 2).
    //
    // Weakest point of this whole change, stated where the change is: `main.ts`
    // has no test, which is precisely how `EscalationMailService.tick()` came
    // to have no caller at all (A86). Deleting this line kills nothing in the
    // pass's own suite. The net is a grep over this file in
    // `backup-pass.test.ts` — it proves the call site exists, never that it is
    // reached, and it is the only mechanical guard available without
    // restructuring an entry point that is outside this change.
    await runBackupPass({
      resultPath: config.backupResultPath,
      eventLog,
      sql,
      notifier,
      logger,
    });

    // §16's weekly report, in the same place and for the same reasons as its
    // three neighbours: it needs Postgres rather than the model, and it cannot
    // throw (`report-pass.ts` catches both its failure paths, because this runs
    // in the same tick as the scheduler and an unhandled rejection here would
    // stop the merge traffic).
    //
    // Deliberately **not** on `periodic-pass.ts`: that clock is interval-based
    // and requires a memory row on every run, which for "Monday 07:00" is
    // either imprecise (a six-hour interval hits the deadline to within six
    // hours) or noise (an hourly one writes ~8 700 rows a year into a log §18
    // keeps forever — A101 measured what those cost). Here the memory is the
    // report itself and the cost is one indexed query per tick, which is the
    // price A86.1 already pays for the notification observer.
    //
    // Same weak point as its neighbours, stated where the change is: `main.ts`
    // has no test, so deleting this line kills nothing in
    // `report-pass.test.ts`. Until today this was the *third* module in a row
    // with no caller at all (metrics, records, schedule — A71's shape, three
    // times); this line is what makes them production code.
    await runReportPass({
      sql,
      eventLog,
      generator: weeklyReportGenerator,
      now: () => Date.now(),
      logger,
      // A150: §16s Zustellung. Beide optional — ohne sie wird der Bericht
      // erzeugt, archiviert und **als nicht zugestellt protokolliert**, statt
      // still eine Mail zu bauen und zu verwerfen.
      mailer,
      ...(config.reportRecipient ? { recipient: config.reportRecipient } : {}),
    });

    // §8.2s Buchführung nachziehen (A149): ein Fund, dessen Fix-Aufgabe fertig
    // ist, wird geschlossen. Bis heute hatte **keiner** der vier
    // Zustandswechsel eines Prüfungsfundes einen Aufrufer in Produktivcode, und
    // damit konnte ein Fund `open` nie verlassen — 20 standen so offen, drei
    // davon `defect`. In derselben Schleife wie die Nachbarn und aus demselben
    // Grund: es braucht Postgres, nicht das Modell.
    if (auditService) {
      await runAuditFindingsPass({ sql, audits: auditService, logger });
    }

    // §18's scheduled Ops work (A30's disk watch today), in the same place and
    // for the same reason as the two passes above: a filling disk is exactly as
    // worth reporting during an auth incident as outside one, and the check
    // needs a filesystem and Postgres rather than the model. Deliberately not
    // on the job queue either — a queue the guardian pauses would silence the
    // disk alert for the length of a `wrap_up`, which under a weekly cap is
    // days (`queue.ts`, and A86.3's reasoning one channel over).
    //
    // Same weak point as the two lines above, and the same net: `main.ts` has
    // no test, so deleting this call kills nothing in `periodic-pass.test.ts`.
    // The grep in that file proves the call site exists, never that it runs.
    await runPeriodicPass({ jobs: periodicJobs, sql, logger });

    const outcome = await selfCheckCycle(
      {
        runChecks: async () => {
          const checks = await runSelfChecks(config.claudeCliVersion);
          if (checks.some((check) => !check.ok)) return checks;
          // §6.1: "a 1-turn smoke session must succeed before the daemon accepts
          // work". It also seeds §7.1's meter, which is the reason it has to run
          // *before* the guardian is consulted rather than behind it — see
          // `startup-smoke.ts` for the circle it breaks (A58).
          //
          // Among the checks rather than in `onReady`, because it is the only
          // one of them that notices a rejected token: `claude auth status`
          // answers `loggedIn` for any token that is set. A probe that fails on
          // authentication is therefore a failed self-check — an auth incident
          // — and not a daemon that is "bereit" (`SmokeGate`).
          return [...checks, await smokeGate.check()];
        },
        wrapUp,
        notifier,
        appendEvent: async (kind, reasons) => {
          await eventLog.append({ kind, actor: 'system', payload: { reasons } });
        },
        // §8.2's `post_auth_incident`. The trigger had no producer at all —
        // `requestAudit` was called by nothing outside a test, so two of the
        // eight values in `AUDIT_TRIGGERS` were unreachable. Fired on the way
        // out of the incident, which is the first moment a model session can
        // run at all (`incident-cycle.ts`).
        requestAudit: (trigger) => scheduler?.requestAudit(trigger),
        onReady: async () => {
          // A28: the expiry cannot be read from the CLI, only remembered.
          // Notify once per urgency level rather than on every pass — a daily
          // reminder that nothing changed is how alerts stop being read.
          const age = assessTokenAge(readTokenInstall(tokenStampPath));
          if (age.message && age.urgency !== lastTokenUrgency) {
            lastTokenUrgency = age.urgency;
            logger.warn({ urgency: age.urgency, daysRemaining: age.daysRemaining }, 'Token-Alter');
            await notifier.send({
              topic: age.urgency === 'critical' ? 'alerts' : 'info',
              title: 'Vorschicht: Claude-Token',
              message: age.message,
              priority: age.urgency === 'critical' ? 'urgent' : 'default',
            });
          }
          await maybeCollectWorktrees();

          // A probe that failed for any other reason than authentication: no
          // work, and the next attempt after its backoff (`runChecks` above).
          if (!smokeGate.passed) return;

          // §7.1's estimate, refreshed before the guardian is asked anything.
          //
          // Order matters and is the same order §6.1's probe follows, for the
          // same reason: the scheduler's first act is to consult the guardian,
          // and the guardian reads whatever the meter last wrote. Estimating
          // afterwards would leave every tick deciding on the previous tick's
          // number — which on a fresh start is no number at all.
          if (Date.now() >= nextEstimateAt) {
            nextEstimateAt = Date.now() + ESTIMATE_INTERVAL_MS;
            try {
              const report = await estimator.sample();
              if (report.text !== lastEstimateText) {
                lastEstimateText = report.text;
                logger.info(
                  { windows: report.windows.map((w) => [w.window, w.usedPercent]) },
                  `Budgetschätzung: ${report.text}`,
                );
              }
            } catch (error) {
              // A failed estimate is not a reason to stop: the meter's own
              // staleness rule turns a missing reading into `unavailable`
              // within fifteen minutes, and the guardian closes the gate on
              // it. Failing loudly here and carrying on is the honest response.
              logger.error({ err: error }, 'Budgetschätzung fehlgeschlagen');
            }
          }

          // One pass of the studio. It asks the guardian first, starts what may
          // start, and returns without waiting for it — which is what keeps this
          // loop, and therefore the budget evaluation, running at tick frequency
          // while a Coder session takes its ninety minutes.
          //
          // A tick that throws must not stop the daemon: everything the studio
          // has a response to is *returned* by the scheduler, so an exception
          // here is the database or the process itself, and idling on it would
          // trade a transient fault for a stopped studio.
          try {
            const report = await scheduler.tick();
            if (report.started.length > 0 || report.merges.length > 0 || report.audit) {
              logger.info(
                {
                  guardian: report.guardianState,
                  // Carried on every reported tick so that a studio whose queue
                  // never came up says so in the line a human reads when asking
                  // why, rather than only in one start-up error an hour of logs
                  // ago (`work-gate.ts` decision 2).
                  queue: queueState.started ? 'bereit' : 'gestört',
                  started: report.started.length,
                  merges: report.merges.filter((m) => m.status !== 'idle').length,
                  blocked: report.blocked.length,
                  inFlight: report.inFlight,
                  audit: report.audit?.verdict ?? null,
                },
                'Tick',
              );
            }
          } catch (error) {
            logger.error({ err: error }, 'Tick fehlgeschlagen — der Daemon läuft weiter');
          }
        },
        logger,
        retryMs: AUTH_RETRY_MS,
        readyMs: TICK_INTERVAL_MS,
      },
      cycleState,
    );
    authIncidentParked = cycleState.authIncidentParked;
    await new Promise((resolve) => setTimeout(resolve, outcome.waitMs));
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
