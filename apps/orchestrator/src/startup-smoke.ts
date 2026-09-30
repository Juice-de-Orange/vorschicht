/**
 * §6.1's startup smoke session — and the only thing that ever seeds the meter.
 *
 * §6.1 states the requirement plainly: "Startup self-check: a 1-turn smoke
 * session must succeed before the daemon accepts work; failure → ntfy alert,
 * daemon idles." It was never built; `runSelfChecks` verified the CLI version
 * and the auth *status*, which are two useful things and neither of them is
 * a session.
 *
 * It stayed harmless while nothing dispatched work. Wiring the scheduler made it
 * a deadlock, and the shape is worth writing down because it is not obvious from
 * any one component:
 *
 *   1. §7.1's official budget reading comes from `control_request { get_usage }`
 *      on a **live session** (ADR 0001). No session, no sample.
 *   2. `evaluateGuardian` with zero samples returns `wrap_up`, reason `no_data`.
 *      That is right, and deliberately so — an unreadable budget is not a safe
 *      budget, and the alternative is starting work at an unknown percentage.
 *   3. The scheduler starts nothing outside `normal`, because §7.2 says
 *      "concurrency for new sessions = 0".
 *
 * So a fresh installation would have sat in `wrap_up` forever, correctly and
 * uselessly, waiting for a sample that only work it refused to start could have
 * produced. Observed on the first run of the wired daemon: `guardian_events` had
 * exactly one row, `wrap_up / no_data`, and no task would ever have started.
 *
 * This session breaks the circle, and that is why it runs *ahead of* the
 * guardian rather than behind it (A58). The exception is narrow and defensible:
 * it is one turn at the cheapest tier with no tools, it is the daemon's own
 * liveness probe rather than task work, and it is the channel through which the
 * budget is read — a meter whose only input is gated on the meter's own verdict
 * can never recover from being empty. At 96 % of a window this is still the
 * session that tells us when the window resets.
 */
import { mkdir } from 'node:fs/promises';
import {
  AGENT_PROFILES,
  type AgentRunOutcome,
  type AgentRunRequest,
  type Notifier,
  type UsageMeter,
} from '@vorschicht/core';
import type { RoleResult } from '@vorschicht/shared';

/**
 * Exactly the call this module makes, and no more.
 *
 * Not `Pick<AgentRunner, 'run'>`: that method is generic over the role, so the
 * pick drags the whole role union into every stub and a test would have to cast
 * its way back out. Naming the one role the probe uses keeps the stub honest —
 * a change to `AgentRunRequest` breaks this file rather than being absorbed.
 */
export interface SmokeRunner {
  run(request: AgentRunRequest<'staff'>): Promise<AgentRunOutcome<RoleResult<'staff'>>>;
}

/** How long a failed probe is left alone before the daemon spends another. */
export const SMOKE_RETRY_MS = 5 * 60_000;

export interface SmokeResult {
  ok: boolean;
  /** German, for the log and the alert. Null when the probe passed. */
  problem: string | null;
  runId: string | null;
  /** Did the probe actually produce a budget reading (§7.1)? */
  sampled: boolean;
}

export interface SmokeDeps {
  runner: SmokeRunner;
  /** Where the probe runs. A scratch directory; it touches nothing. */
  cwd: string;
  /** Consulted afterwards to see whether a sample arrived. */
  meter?: Pick<UsageMeter, 'currentSamples'>;
  notifier?: Pick<Notifier, 'send'>;
  logger?: {
    info(obj: unknown, message?: string): void;
    warn(obj: unknown, message?: string): void;
  };
}

/**
 * Run the probe once and say what it found.
 *
 * Never throws: a probe that blew up is a failed probe, and the caller's
 * response to both is the same — idle, alert, try again later. Throwing would
 * make the daemon's own health check the thing that takes the daemon down.
 */
export async function runStartupSmoke(deps: SmokeDeps): Promise<SmokeResult> {
  try {
    // The probe owns its scratch directory, so it creates it. A missing cwd is
    // a process that never starts (the runner refuses ahead of that now), and
    // on a fresh host `<runsRoot>/smoke` has never existed.
    await mkdir(deps.cwd, { recursive: true });

    const outcome = await deps.runner.run({
      // No task and no project: this session serves neither, which is also why
      // it spawns without MCP (A56.5) — every tool the internal server offers is
      // scoped to a task.
      taskId: null,
      projectId: null,
      profile: AGENT_PROFILES.smoke,
      prompt: 'Confirm in one short sentence that you are running. Nothing else is wanted.',
      cwd: deps.cwd,
      containment: { writeRoot: null, claims: null, readOnlyProject: false },
    });

    if (outcome.status !== 'ok') {
      return {
        ok: false,
        problem: `Startprobe (§6.1) fehlgeschlagen: ${outcome.problem}`,
        runId: outcome.run.runId,
        sampled: false,
      };
    }

    // Whether the budget could be read is reported separately from whether the
    // session worked, because the two failures need different responses and
    // look identical from the outside otherwise: a healthy session that yields
    // no usable sample leaves the guardian fail-closed, which reads as "the
    // studio is idle" rather than as "the studio cannot see its budget".
    //
    // "Usable" is the load-bearing word, and counting rows is not it. The meter
    // never returns an empty list — an unreadable budget is persisted as an
    // explicit `unavailable` sentinel, precisely so that silence and blindness
    // cannot be confused (`projectSamples`). Asking `length > 0` would therefore
    // have answered "budget read" every single time, including the case this
    // whole check exists to surface. Caught by comparing the daemon's cheerful
    // log line against `guardian_events`, which still said `wrap_up / no_data`.
    const samples = (await deps.meter?.currentSamples()) ?? [];
    const usable = samples.filter((sample) => sample.anomaly?.kind !== 'unavailable');
    return {
      ok: true,
      problem: null,
      runId: outcome.run.runId,
      sampled: usable.length > 0,
    };
  } catch (error) {
    return {
      ok: false,
      problem: `Startprobe (§6.1) konnte nicht ausgeführt werden: ${(error as Error).message}`,
      runId: null,
      sampled: false,
    };
  }
}

/**
 * The probe plus the reporting §6.1 asks for.
 *
 * Split from `runStartupSmoke` so the decision can be tested without a notifier
 * and the reporting can be tested without a runner.
 */
export async function smokeAndReport(deps: SmokeDeps): Promise<SmokeResult> {
  const result = await runStartupSmoke(deps);

  if (!result.ok) {
    deps.logger?.warn({ runId: result.runId }, result.problem ?? 'Startprobe fehlgeschlagen');
    await deps.notifier
      ?.send({
        topic: 'alerts',
        title: 'Vorschicht: Startprobe fehlgeschlagen',
        message:
          `${result.problem}\n\nDer Daemon nimmt keine Arbeit an und versucht es in ` +
          `${SMOKE_RETRY_MS / 60_000} Minuten erneut (§6.1).`,
        priority: 'high',
        tags: ['warning'],
      })
      .catch(() => undefined);
    return result;
  }

  if (!result.sampled) {
    // Not an error and not silence either. §7.1's estimating meter (A6) takes
    // over from here — so this says what is *known* (the official source did
    // not answer) and stops short of the consequence it used to assert. The
    // old wording ended "der Wächter bleibt vorsorglich zu", which stopped
    // being true the moment the estimator was wired in: the guardian goes to
    // `normal` seconds later on an estimated sample, and a log line claiming
    // the studio is shut while it works is worse than no line at all.
    deps.logger?.warn(
      { runId: result.runId },
      'Startprobe lief, lieferte aber keinen offiziellen Budgetwert — es gilt die Schätzung (§7.1/A6).',
    );
    await deps.notifier
      ?.send({
        topic: 'info',
        title: 'Vorschicht: Budget nur geschätzt',
        message:
          'Die Startprobe lief durch, hat aber keinen offiziellen Budgetwert geliefert. ' +
          'Es gilt der schätzende Zähler mit der strengeren Schwelle (§7.1/A6); ' +
          'ohne ihn bliebe der Wächter zu.',
      })
      .catch(() => undefined);
    return result;
  }

  deps.logger?.info({ runId: result.runId }, 'Startprobe bestanden — Budget gelesen (§6.1)');
  return result;
}
