/**
 * One pass of the daemon's self-check loop (§6.1).
 *
 * Extracted from `main()` because the first Betriebsprüfung (§8.2) found that
 * nothing tested it. The Phase 1 exit gate claims "invalid/expired token
 * simulation → **daemon idles + ntfy alert**, zero tasks marked red, clean
 * recovery after token replacement"; the evidence it cited proves the second
 * and third clauses by calling `parkAll` and `resumeAll` directly, and says
 * nothing at all about the first. The daemon's own decision — park once, alert,
 * idle rather than exit, resume when the checks pass again — lived inside a
 * `while` loop in an entry point with no test, so the half of the gate that
 * distinguishes "come and fix a token" from a crash loop rested on nobody
 * having read it.
 *
 * The loop body is therefore a function that takes its dependencies and returns
 * what it decided. Four properties are the contract:
 *
 *  1. **It never throws and never exits.** §6.1: an auth incident makes the
 *     daemon idle with an alert. Exiting would hand compose a restart loop, and
 *     a restart loop turns a five-minute token problem into pages of noise.
 *  2. **It parks once, not once per pass.** The retry interval is five minutes;
 *     parking on every pass would write a WIP commit and a handover note every
 *     five minutes for as long as the incident lasted.
 *  3. **It resumes only after having parked.** `resumeAll` on an ordinary
 *     healthy pass would un-park work parked by the budget guardian (§7.3),
 *     which is a different mechanism with a different reason.
 *  4. **Nothing is ever marked red.** Not asserted here — it cannot be, because
 *     this function has no route to a red state at all. That is the point:
 *     `parkAll` and `resumeAll` are the only task-side calls it can make.
 */
import type { CheckResult } from './self-check.js';

/** What one pass decided. Returned rather than logged, so a test can read it. */
export interface CycleOutcome {
  ready: boolean;
  /** A failure that §6.1 classifies as an authentication incident. */
  authIncident: boolean;
  /** How many tasks this pass parked. Zero on every pass after the first. */
  parked: number;
  /** How many it resumed once the incident was over. */
  resumed: number;
  /** How long the caller should wait before the next pass. */
  waitMs: number;
  /** True on the pass that closed an incident and asked §8.2 for a run. */
  auditRequested: boolean;
  /** The failures this pass saw, for the caller's log. */
  failures: Array<{ ok: false; reason: string }>;
}

export interface CycleState {
  /** Set once work has been parked for an incident; cleared when it is over. */
  authIncidentParked: boolean;
}

export interface NotifierLike {
  send(message: {
    topic: string;
    title: string;
    message: string;
    priority?: string;
    tags?: string[];
  }): Promise<unknown>;
}

export interface CycleDeps {
  runChecks(): Promise<CheckResult[]>;
  wrapUp: {
    parkAll(reason: 'auth_incident' | 'manual_pause'): Promise<Array<{ parked: boolean }>>;
    resumeAll(): Promise<unknown[]>;
  };
  notifier: NotifierLike;
  appendEvent(kind: 'auth.incident' | 'system.selfcheck_failed', reasons: string[]): Promise<void>;
  /** Housekeeping that only runs on a healthy pass: token age, worktree GC. */
  onReady?(): Promise<void>;
  /**
   * §8.2's `post_auth_incident` trigger — "after an auth incident".
   *
   * Requested when the incident **ends**, not when it starts, for the reason
   * `Scheduler.observeGuardian` gives for `post_hard_stop`: an audit is a model
   * session, and during an auth incident there is by definition no model. The
   * moment the checks pass again is both the first moment one can run and the
   * moment there is something to examine — the studio has just resumed work it
   * parked, on evidence nobody has looked at.
   *
   * Optional because the daemon is the only caller that has a scheduler; a test
   * of the cycle itself needs no audit cadence to assert the four properties
   * above. `AuditTrigger` is not imported: this module deliberately depends on
   * nothing from `@vorschicht/core`, and widening its import graph for one
   * string literal would be the wrong trade in the file whose whole point is
   * that it can be driven with injected failures.
   */
  requestAudit?(trigger: 'post_auth_incident'): void;
  logger: {
    info(obj: unknown, message?: string): void;
    warn(obj: unknown, message?: string): void;
    error(obj: unknown, message?: string): void;
  };
  /** Idle interval after a failed pass, and after a healthy one. */
  retryMs: number;
  readyMs: number;
}

/**
 * Which failures §6.1 calls an authentication incident.
 *
 * Exported so the classification is testable on its own: it is the difference
 * between "come and fix a token" and "come and work out which fifteen tasks
 * broke", and it is decided by a regular expression over a German sentence —
 * which is exactly the kind of thing that silently stops matching.
 */
export function isAuthIncident(failures: ReadonlyArray<{ reason: string }>): boolean {
  return failures.some((failure) => /§6\.1|angemeldet|auth status|§2/.test(failure.reason));
}

export async function selfCheckCycle(deps: CycleDeps, state: CycleState): Promise<CycleOutcome> {
  const results = await deps.runChecks();
  const failures = results.filter((r): r is { ok: false; reason: string } => !r.ok);

  if (failures.length === 0) {
    let resumed = 0;
    let auditRequested = false;
    if (state.authIncidentParked) {
      // The incident is over. Parked work comes back first and in priority
      // order (§7.2) — the same path a window reset takes, because from the
      // task's point of view the two are the same event: it was stopped for a
      // reason that has since gone away.
      const back = await deps.wrapUp.resumeAll();
      resumed = back.length;
      state.authIncidentParked = false;
      deps.logger.info({ resumed }, 'Auth-Vorfall behoben — Arbeit fortgesetzt');
      await deps.notifier.send({
        topic: 'info',
        title: 'Vorschicht: Anmeldung wieder in Ordnung',
        message: `${resumed} geparkte Aufgabe(n) werden fortgesetzt.`,
      });

      // §8.2's trigger, on the way back out (see `CycleDeps.requestAudit`).
      // Inside the `authIncidentParked` branch and not beside it: every healthy
      // pass reaches this function, and requesting on all of them would ask for
      // an audit every fifteen seconds forever. Guarded, because a scheduler
      // that threw here would undo the resume that just happened.
      if (deps.requestAudit) {
        try {
          deps.requestAudit('post_auth_incident');
          auditRequested = true;
        } catch (error) {
          deps.logger.error({ err: error }, 'Betriebsprüfung nach Auth-Vorfall nicht vorgemerkt');
        }
      }
    }

    await deps.onReady?.();
    deps.logger.info({}, 'Selbstprüfung bestanden — Daemon ist bereit.');
    return {
      ready: true,
      authIncident: false,
      parked: 0,
      resumed,
      waitMs: deps.readyMs,
      auditRequested,
      failures,
    };
  }

  for (const failure of failures)
    deps.logger.error({ reason: failure.reason }, 'Selbstprüfung rot');

  // §6.1: an authentication failure is an **auth incident**, never a task
  // failure. Nothing is marked red; the daemon idles and says so.
  const authIncident = isAuthIncident(failures);
  await deps.appendEvent(
    authIncident ? 'auth.incident' : 'system.selfcheck_failed',
    failures.map((f) => f.reason),
  );

  let parked = 0;
  if (!state.authIncidentParked) {
    try {
      const outcomes = await deps.wrapUp.parkAll(authIncident ? 'auth_incident' : 'manual_pause');
      state.authIncidentParked = true;
      parked = outcomes.filter((o) => o.parked).length;
      if (outcomes.length > 0) {
        deps.logger.warn({ parked, total: outcomes.length }, 'Laufende Arbeit geparkt');
      }
    } catch (error) {
      // Parking that failed must not stop the alert: the operator still has to
      // hear about the incident, and the tasks are no worse off than before.
      deps.logger.error({ err: error }, 'Parken der laufenden Arbeit fehlgeschlagen');
    }
  }

  await deps.notifier.send({
    topic: 'alerts',
    title: authIncident
      ? 'Vorschicht: Auth-Vorfall — Daemon nimmt keine Arbeit an'
      : 'Vorschicht: Selbstprüfung fehlgeschlagen',
    message: failures.map((f) => `• ${f.reason}`).join('\n'),
    priority: 'high',
    tags: ['warning'],
  });

  // Idle, do not crash: an auth incident parks work, it never fails tasks
  // (§6.1). Exiting here would hand compose a restart loop instead.
  deps.logger.warn(
    { retryInMinutes: deps.retryMs / 60_000 },
    'Daemon nimmt keine Arbeit an und wartet auf Behebung',
  );
  return {
    ready: false,
    authIncident,
    parked,
    resumed: 0,
    waitMs: deps.retryMs,
    // §8.2 is asked on the way *out* of an incident, never on the way in: the
    // audit is a model session and there is no model while this branch runs.
    auditRequested: false,
    failures,
  };
}
