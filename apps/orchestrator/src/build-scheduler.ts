/**
 * The wiring the daemon actually uses — assembled here so it can be examined.
 *
 * This was a nested function inside `main()`. Nothing exported it and nothing
 * could import it, so the arrangement the studio runs on was not merely
 * untested: it was **unreachable from the test tree**. That is §8.2's sixth
 * domain in the one place it costs most, and it is how the `AuditService` in
 * production came to run against a `specPath` no test had ever produced.
 *
 * What this module decides, and why each decision is here rather than inline:
 *
 *   * **Which repository the Betriebsprüfung examines.** §8.2 audits *this*
 *     studio's claims about its own work, so the auditor's repository is the
 *     self-managed project (§12, A42) — read from `projects` rather than assumed
 *     from a path, because that is where onboarding puts it.
 *   * **Which file a `gate_invalid` may edit.** Stated explicitly (§8.2's
 *     un-tick is the only irreversible edit in the system) rather than left to a
 *     default, which is why `AuditServiceDeps.specPath` no longer has one.
 *   * **That the auditor can reach the inbox.** §8.2 requires a `gate_invalid`
 *     to reach the operator as a P1 item every time; without `escalations` wired the
 *     safeguard is a sentence in a comment.
 *   * **That A44.3's `read_only` reaches the auditor's write.** `projects` is
 *     passed so the un-tick asks before it writes.
 *   * **Which deploy methods this studio can actually execute (§12).** The
 *     target registry is assembled here and read twice from one place: the
 *     engine gets the targets, the merge queue gets their method names, so the
 *     component that refuses a merge and the component that performs the rollout
 *     cannot disagree about what is deployable.
 *
 * No project means no audits, and the caller is told so rather than left to
 * infer it from silence — a silent auditor and a working one look identical from
 * outside (§8.2, independence rule 5).
 */
import { execFile as execFileCallback } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  type AgentRunner,
  AuditService,
  type ChainDispatch,
  chainInfraHistory,
  DeployRecords,
  DeployService,
  type DeployTarget,
  type EscalationService,
  type EventLog,
  ensureSelfManagedProject,
  FindingsService,
  GateCommandError,
  IdleAuditService,
  type IntegrityDispatch,
  type OnboardingService,
  type ProjectRecord,
  type ProjectService,
  parseGateCommand,
  type QueueDispatch,
  Scheduler,
  type SchedulerDeps,
  type SelfOnboardingOutcome,
  type TaskService,
  taskDeployHandover,
} from '@vorschicht/core';
import type { DeployMethod, UsageSample } from '@vorschicht/shared';
import type postgres from 'postgres';

const execFile = promisify(execFileCallback);

/** How long a configured deploy command may run before it is killed (§12). */
export const DEPLOY_COMMAND_TIMEOUT_MS = 15 * 60_000;

/** What travels into a record and an escalation — §12 wants logs, not a core dump. */
const DEPLOY_OUTPUT_CAP = 8_000;

/**
 * Run one configured deploy command, as argv, never through a shell (§19).
 *
 * This is the production half of `DeployServiceDeps.run`, which exists as an
 * injection point so that §12's *order* can be proven without a machine. Three
 * things it does not do, each on purpose:
 *
 *   * **It does not throw on a non-zero exit.** The exit code is the answer —
 *     A24's migration step reads it to decide whether anything may be swapped —
 *     and an exception there would turn a migration that reported a conflict
 *     into a crash in the engine.
 *   * **It does not interpret.** `ok` is `code === 0` and nothing else; whether
 *     that means "roll back" is §12's question.
 *   * **It does not see a shell.** `deployCommand` already refuses metacharacters
 *     when the configuration is written; `parseGateCommand` refuses them again
 *     here, because two layers are only two layers if the second one is real.
 */
export async function runDeployCommand(
  projectRoot: string,
  command: string,
  argv: readonly string[],
): Promise<{ ok: boolean; code: number | null; output: string }> {
  let file: string;
  let args: string[];
  try {
    const parsed = parseGateCommand(command);
    const [head, ...rest] = parsed;
    if (!head) throw new GateCommandError(command, `Der Befehl „${command}" ist leer.`);
    file = head;
    args = [...rest, ...argv];
  } catch (error) {
    // A refused command never ran, so it cannot be a statement about the
    // release. It comes back as a failure with the reason in it, and §12 stops
    // before anything is swapped.
    return { ok: false, code: null, output: (error as Error).message };
  }

  try {
    const { stdout, stderr } = await execFile(file, args, {
      cwd: projectRoot,
      timeout: DEPLOY_COMMAND_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CI: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true, code: 0, output: cap(`${stdout}${stderr}`) };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    return {
      ok: false,
      code: typeof err.code === 'number' ? err.code : null,
      output: cap(`${err.stdout ?? ''}${err.stderr ?? err.message}`),
    };
  }
}

function cap(output: string): string {
  const trimmed = output.trim();
  return trimmed.length <= DEPLOY_OUTPUT_CAP
    ? trimmed
    : `${trimmed.slice(0, DEPLOY_OUTPUT_CAP)}\n… (gekürzt)`;
}

export interface SchedulerAssembly {
  sql: postgres.Sql;
  eventLog: EventLog;
  /** The class, not a slice: `AuditService` files fix tasks through it (§8.2). */
  tasks: TaskService;
  /** The class: `ensureSelfManagedProject` creates, `AuditService` reads A44.3. */
  projects: ProjectService;
  /**
   * The four collaborators the scheduler only ever calls through an interface.
   *
   * Declared structurally for A57.6's reason, one layer up: this module's job is
   * to decide *what the daemon wires*, and a test of that decision should not
   * have to construct a merge queue to ask it. Taking the concrete classes here
   * would make the wiring untestable for exactly the same reason it was
   * untestable before — not too complicated, simply out of reach.
   */
  claims: SchedulerDeps['claims'];
  guardian: SchedulerDeps['guardian'];
  devChain: ChainDispatch;
  mergeQueue: QueueDispatch;
  integrity: IntegrityDispatch;
  /** Both ends: §6.4's lookup for the tick, §8.2's `raise` for the auditor. */
  escalations: EscalationService;
  onboarding: OnboardingService;
  /**
   * §12's deploy targets — one per method this studio can execute (A11).
   *
   * **Empty by default, and that is the honest state today**, not a placeholder:
   * `compose` and `static-rsync` are being built, and until one of them is
   * imported here this studio has no way to roll anything out. The consequence
   * is deliberate and fail-closed at both ends — the merge queue refuses a
   * `compose` project before it merges (§12, A55.6) and the engine answers
   * `unsupported` for anything that reached `deploying` anyway.
   *
   * Deliberately **not** filled with `FakeDeployTarget`. A fake registered under
   * `compose` would report a rollout that did not happen: the task would go
   * `done`, `deployments` would carry a succeeded release, and `lastGood` would
   * offer a rollback destination that exists nowhere. A studio that cannot
   * deploy must say so; the fake belongs in the tests, where it is what proves
   * this wiring (A37).
   */
  deployTargets?: Iterable<DeployTarget>;
  /** The auditor's session runs here — a scratch dir, never a worktree (§8.2). */
  auditScratchDir: string;
  /**
   * §21's idle audits run here — a *different* scratch dir from the auditor's.
   *
   * Different because they are different sessions with different objects (§8.2:
   * "different object, different trigger"), and a shared directory is the kind
   * of accidental coupling that makes one run's leftover file another run's
   * evidence. Both are read-only sessions whose cwd belongs to no repository.
   */
  idleAuditScratchDir: string;
  /** §7.1's current per-window reading. A17's third condition is read from it. */
  usage: () => Promise<UsageSample[]>;
  /**
   * A22's emergency profile, from where the operator set it (§17.8).
   *
   * Optional, and absent means "not in Sparbetrieb" — the same reading
   * `IdleAuditDeps` gives it, so a caller that does not wire it gets today's
   * behaviour rather than a studio that quietly stops auditing.
   */
  sparbetrieb?: () => Promise<boolean>;
  /** Where this repository is mounted, as the container sees it. */
  selfRootPath: string;
  /** A7: parallel agent sessions, by plan profile. */
  concurrency: number;
  runner: AgentRunner;
  onWarning(message: string): void;
  /** A25's second half for the dev chain — see `Scheduler.onOpsAlert`. */
  onOpsAlert: NonNullable<ConstructorParameters<typeof Scheduler>[0]['onOpsAlert']>;
  logger: NonNullable<ConstructorParameters<typeof Scheduler>[0]['logger']> & {
    warn(obj: unknown, message?: string): void;
  };
}

export interface BuiltScheduler {
  scheduler: Scheduler;
  /** Null when this studio has no self-managed project — then §8.2 never runs. */
  selfProject: ProjectRecord | null;
  onboarding: SelfOnboardingOutcome;
  /** The file a `gate_invalid` may edit, or null when there is no project. */
  specPath: string | null;
  /**
   * §8.2s Prüfungsdienst — null, wenn es kein selbstverwaltetes Projekt gibt.
   *
   * Mitgegeben statt zweimal gebaut: `runAuditFindingsPass` führt die Funde
   * derselben Prüfungen nach, die der Ablaufplaner fährt (A149). Zwei
   * Konstruktionen wären zwei Dienste auf derselben Tabelle, und der zweite
   * müsste `specPath` erneut beantworten — eine Frage, die A83.3 ausdrücklich
   * ohne Vorgabe gelassen hat, damit sie der Aufrufer beantwortet, der weiss,
   * welches Repository geprüft wird.
   */
  audits: AuditService | null;
  /**
   * Which methods have a target — the merge queue's `deployableMethods` (§12).
   *
   * Returned rather than reached for, because `MergeQueue` is constructed by the
   * caller and the two must be answering out of the same registry. The queue's
   * own default is the empty set, so forgetting to pass this refuses merges
   * rather than merging code nothing can roll out — wrong in the safe direction,
   * and loud (`MergeQueueError`, quarantined by the tick) rather than silent.
   */
  deployableMethods: DeployMethod[];
}

export async function buildScheduler(deps: SchedulerAssembly): Promise<BuiltScheduler> {
  // §12/A42: this repository is a project of this studio, and it is the one the
  // Betriebsprüfung examines. Ensured here rather than left to a human, because
  // until it exists §8.2's cadence never fires.
  //
  // The configuration is not proposed by a model (A70): it is this repository's
  // own scripts, checked against its own `package.json`, so a renamed script
  // refuses the onboarding by name instead of configuring a gate that reports an
  // infrastructure failure forever.
  const outcome = await ensureSelfManagedProject({
    onboarding: deps.onboarding,
    projects: deps.projects,
    rootPath: deps.selfRootPath,
    // A85 is re-asserted here on every start, so a row created before that
    // decision does not keep `read_only = false` forever. If it cannot be, the
    // studio has to hear about it — see `enforceSelfReadOnly`.
    onWarning: deps.onWarning,
  }).catch((error): SelfOnboardingOutcome => {
    // Never fatal: a studio that will not boot because it could not onboard
    // itself is worse than one that boots and says so.
    return { status: 'refused', problem: (error as Error).message, verification: null };
  });

  const selfProject = outcome.status === 'refused' ? null : outcome.project;
  if (!selfProject) {
    // Said out loud rather than defaulted to something plausible: an audit that
    // silently never ran is exactly the blind spot §8.2 exists to close.
    deps.logger.warn(
      { problem: outcome.status === 'refused' ? outcome.problem : null },
      'Kein selbstverwaltetes Projekt — die Betriebsprüfung (§8.2) läuft nicht (A42).',
    );
  }
  const specPath = selfProject ? join(selfProject.rootPath, 'CLAUDE.md') : null;

  // Einmal gebaut und **zweimal gereicht**: der Ablaufplaner fährt die Prüfungen
  // (§8.2), und `runAuditFindingsPass` führt deren Funde nach (A149). Zwei
  // Konstruktionen wären zwei Dienste auf derselben Tabelle — und der zweite
  // hätte, weil `AuditServiceDeps.specPath` keine Vorgabe mehr hat (A83.3), eine
  // eigene Antwort auf die Frage, welches `CLAUDE.md` gemeint ist.
  const audits =
    selfProject && specPath
      ? new AuditService({
          sql: deps.sql,
          eventLog: deps.eventLog,
          runner: deps.runner,
          repoRoot: selfProject.rootPath,
          specPath,
          scratchDir: deps.auditScratchDir,
          tasks: deps.tasks,
          // A44.3 reaches the un-tick through this: a read-only project keeps
          // its `CLAUDE.md`, and the finding goes to the operator instead.
          projects: deps.projects,
          // §8.2: the P1 inbox item, every time.
          escalations: deps.escalations,
          projectId: selfProject.id,
          onWarning: deps.onWarning,
        })
      : null;

  // §12's registry, assembled once and read twice (see the header): the engine
  // takes the targets, the caller takes their method names for the merge queue.
  const targets = new Map<string, DeployTarget>();
  for (const target of deps.deployTargets ?? []) targets.set(target.method, target);
  if (targets.size === 0) {
    // Said out loud on every start, for §8.2's fifth independence rule applied
    // one subsystem over: a studio that cannot deploy and a studio with nothing
    // to deploy look identical from outside, and only this line separates them.
    deps.logger.warn(
      {},
      'Kein Deploy-Ziel registriert — Projekte mit Deploy-Methode werden nicht zusammengeführt (§12).',
    );
  }

  const deploys = new DeployService({
    sql: deps.sql,
    records: new DeployRecords(deps.sql),
    eventLog: deps.eventLog,
    tasks: deps.tasks,
    // Both ends: A12's approval card and the answered-already check that keeps
    // every tick from raising a second one.
    escalations: deps.escalations,
    targets,
    // §12: no new deploys outside `normal`. Asked again here rather than
    // inherited from the tick, because a rollout takes minutes and the window
    // the tick read may have closed since.
    guardianState: async () => (await deps.guardian.evaluate()).state,
    run: runDeployCommand,
  });

  const scheduler = new Scheduler({
    tasks: deps.tasks,
    projects: deps.projects,
    claims: deps.claims,
    guardian: deps.guardian,
    devChain: deps.devChain,
    mergeQueue: deps.mergeQueue,
    integrity: deps.integrity,
    deploys,
    // The commit the merge queue put on the `deploying` transition — never
    // re-derived, never guessed from a branch name.
    deployHandover: taskDeployHandover(deps.sql),
    escalations: deps.escalations,
    eventLog: deps.eventLog,
    infraHistory: chainInfraHistory(deps.sql),
    // §8.2's `gate_flip` trigger. Wired unconditionally, unlike `audits`: the
    // scheduler asks it only when an audit dispatch exists, so one condition
    // decides both and the second would only be a way for them to disagree.
    gateFlips: new FindingsService({ sql: deps.sql }),
    // §21. Wired unconditionally and independently of `audits`, because they
    // are independent: the idle rotation examines projects and needs no
    // self-managed project at all, so gating it on `selfProject` would switch
    // §21 off on a studio that has onboarded nothing but foreign repositories.
    idleAudits: new IdleAuditService({
      sql: deps.sql,
      eventLog: deps.eventLog,
      runner: deps.runner,
      tasks: deps.tasks,
      projects: deps.projects,
      // A17's third condition. Its first reader — the constant has existed
      // since Phase 1 with nothing referencing it.
      usage: deps.usage,
      // A22's one effect that had a hook waiting for a producer. `IdleAuditDeps`
      // declared this in Phase 6 and said so in as many words — "it has **no
      // producer** today — the switch itself is §22's Phase 6 step 6 and is not
      // built" — so §21 kept filling idle capacity with sessions however tight
      // the budget was. This is that producer. The other three effects A22 names
      // still have none, and `SPARBETRIEB_WIRKUNGEN` says which, on the page,
      // rather than letting the switch overstate itself.
      //
      // Spread rather than an explicit `undefined`: with
      // exactOptionalPropertyTypes an absent option and one set to undefined
      // are different things, and only the former means "not in Sparbetrieb".
      ...(deps.sparbetrieb ? { sparbetrieb: deps.sparbetrieb } : {}),
      scratchDir: deps.idleAuditScratchDir,
      onWarning: deps.onWarning,
    }),
    ...(audits ? { audits } : {}),
    concurrency: deps.concurrency,
    onOpsAlert: deps.onOpsAlert,
    onWarning: deps.onWarning,
    logger: deps.logger,
  });

  return {
    scheduler,
    selfProject,
    onboarding: outcome,
    specPath,
    audits,
    deployableMethods: [...targets.keys()] as DeployMethod[],
  };
}
