/**
 * One pass of §15's and §16's outgoing channels — the caller both of them were
 * missing.
 *
 * `EscalationMailService.tick()` (A13's reminder and daily digest) had **no
 * caller**: its own author reported it, `REPORT_RECIPIENT` was parsed and read
 * by nobody, and `pnpm gate` was green over a mail path that could not run. The
 * ntfy `inbox` topic had no general producer either. Both are A71's shape, and
 * the way not to repeat it is to give the wiring a name and a test rather than
 * three lines in `main()` — which is `incident-cycle.ts`'s reasoning verbatim,
 * after the first Betriebsprüfung found a Phase 1 gate resting on loop-body code
 * nobody had read.
 *
 * Five properties are the contract.
 *
 *  1. **It never throws.** `onReady` is a bare `await deps.onReady?.()` inside
 *     `selfCheckCycle`, and the `while (running)` loop does not wrap it — so a
 *     rejection here reaches `main().catch()`, which calls `process.exit(1)`,
 *     which under compose's restart policy is a crash carousel. `tick()` cannot
 *     throw *by inspection* but it can by execution: `escalations.open()`, two
 *     `eventLog.append()` calls and two raw queries all reach Postgres. The
 *     guard is inside this function rather than at the call site, deliberately,
 *     because that is the only arrangement a test can observe — and a second
 *     `try` around a function that provably cannot throw is the dead wiring this
 *     file exists to remove.
 *
 *  2. **The two halves are guarded separately.** A push that blew up must not
 *     cost the day's digest, and a digest that blew up must not stop the operator being
 *     told about a P0 decision. They share a pass and nothing else.
 *
 *  3. **It runs on every pass of the daemon's loop, healthy or not.** Two
 *     placements were available and both are wrong in the same direction. Behind
 *     §6.1's smoke gate, a studio whose CLI probe is stuck stops telling the operator
 *     about the open decision that may be the one unsticking it. Inside
 *     `onReady`, the same thing happens for a whole auth incident — `onReady` is
 *     called only when the self-check passes (`incident-cycle.ts`), which is
 *     precisely when the studio has parked its work and needs an answer. So the
 *     call sits in the `while` body next to `selfCheckCycle`, which demonstrably
 *     still reaches ntfy in that state: it pushes its own alert from there.
 *     §15 and §16 need Postgres and a socket; they do not need the model. What
 *     this costs is stated rather than implied — a failing pass waits
 *     `AUTH_RETRY_MS` (5 min), so during an incident a new card is announced
 *     within five minutes rather than within a tick.
 *
 *  4. **ntfy on the transition, never per pass.** A67.6's rule, applied to a
 *     second channel: a push per pass for as long as an SMTP server is
 *     unreachable is a channel that gets muted, and then the next real alert is
 *     invisible. One alert on the first failing pass after a clean one, one
 *     recovery on the first clean pass after failures — at most two per outage.
 *     The state flips only when the alert *was actually delivered*, mirroring
 *     `escalation-mail.ts`'s decision 2: an alert ntfy refused is an alert
 *     nobody got.
 *
 *  5. **Its own cadence for the mail.** A13's granularity is 24 hours for both
 *     rules; the tick is 15 seconds. Four passes a minute would buy nothing and
 *     cost two queries a pass forever, so the mail runs on a `nextMailAt`
 *     deadline the way the estimator already does (`ESTIMATE_INTERVAL_MS`). The
 *     push is *not* on that cadence — §15 says "immediately on creation", and a
 *     minute of latency on a P0 card is the one thing this file must not add.
 */
import type { EscalationMailOutcome, EscalationPushOutcome, Notifier } from '@vorschicht/core';
import type { NtfyTopic } from '@vorschicht/shared';

/**
 * How often A13's two rules are evaluated.
 *
 * Well under the 24 hours both of them measure in, and far above the tick, so
 * the worst case is that a reminder goes out a minute late.
 */
export const MAIL_PASS_INTERVAL_MS = 60_000;

/** Exactly the calls this module makes, and no more (`SmokeRunner`'s posture). */
export interface NotificationsPassDeps {
  /** §15's push. Every pass. */
  push: { push(): Promise<EscalationPushOutcome> };
  /** A13's reminder and digest. On the slower cadence above. */
  mail: { tick(): Promise<EscalationMailOutcome> };
  /** Only ever used for property 4's transition alert. */
  notifier: Pick<Notifier, 'send'>;
  logger: {
    info(obj: unknown, message?: string): void;
    warn(obj: unknown, message?: string): void;
    error(obj: unknown, message?: string): void;
  };
  now?: (() => number) | undefined;
  mailIntervalMs?: number | undefined;
}

/** Carried across passes by the daemon, like `lastTokenUrgency` beside it. */
export interface NotificationsPassState {
  /** Zero on a fresh process, so the first pass runs the mail immediately. */
  nextMailAt: number;
  /** True while the last mail pass reported refused sends (property 4). */
  mailFailing: boolean;
}

export interface NotificationsPassResult {
  /** Numbers pushed to ntfy on this pass (§15). */
  pushed: number[];
  /** Whether the mail half ran at all, or the cadence held it back. */
  mailRan: boolean;
  /** False when SMTP or the recipient is missing — nothing was attempted. */
  mailEnabled: boolean;
  reminded: number[];
  digest: number[] | null;
  /** Sends either half reported as refused. */
  failures: string[];
  /** The transition alert this pass delivered, if any (property 4). */
  alerted: 'failure' | 'recovery' | null;
  /** Exceptions this pass swallowed (property 1), German, for the caller. */
  problems: string[];
}

export async function runNotificationsPass(
  deps: NotificationsPassDeps,
  state: NotificationsPassState,
): Promise<NotificationsPassResult> {
  const now = deps.now ?? Date.now;
  const interval = deps.mailIntervalMs ?? MAIL_PASS_INTERVAL_MS;
  const result: NotificationsPassResult = {
    pushed: [],
    mailRan: false,
    mailEnabled: false,
    reminded: [],
    digest: null,
    failures: [],
    alerted: null,
    problems: [],
  };

  // --- §15: every new inbox item, on the pass it appears -------------------
  try {
    const outcome = await deps.push.push();
    result.pushed = outcome.pushed;
    result.failures.push(...outcome.failures);
    if (outcome.pushed.length > 0) {
      deps.logger.info(
        { numbers: outcome.pushed },
        `${outcome.pushed.length} neue Entscheidung(en) per ntfy gemeldet (§15)`,
      );
    }
    if (outcome.failures.length > 0) {
      // A summary, never one line per item: the failure mode being avoided is a
      // log that scrolls at tick frequency for as long as ntfy is unreachable.
      deps.logger.warn(
        { count: outcome.failures.length, first: outcome.failures[0] },
        `${outcome.failures.length} Push(es) an ntfy nicht zugestellt — wird beim nächsten Durchlauf erneut versucht (§15)`,
      );
    }
  } catch (error) {
    const problem = `§15s Push konnte nicht laufen: ${(error as Error).message}`;
    result.problems.push(problem);
    deps.logger.error({ err: error }, problem);
  }

  // --- A13: reminder and digest, on their own clock ------------------------
  if (now() < state.nextMailAt) return result;
  state.nextMailAt = now() + interval;

  try {
    const outcome = await deps.mail.tick();
    result.mailRan = true;
    result.mailEnabled = outcome.enabled;
    result.reminded = outcome.reminded;
    result.digest = outcome.digest;
    result.failures.push(...outcome.failures);

    // Decision 3 of `escalation-mail.ts`: an unconfigured SMTP does nothing at
    // all, quietly. `createMailer` says which variable is missing, once, at
    // start-up; repeating it once a minute forever is the same flood one layer
    // up. Returning here also keeps a disabled mailer — whose `failures` is
    // always empty — from reading as a recovery.
    if (!outcome.enabled) return result;

    if (outcome.reminded.length > 0 || outcome.digest !== null) {
      deps.logger.info(
        { reminded: outcome.reminded, digest: outcome.digest?.length ?? 0 },
        'E-Mail-Benachrichtigungen versendet (A13)',
      );
    }

    result.alerted = await reportMailHealth(deps, state, outcome.failures);
  } catch (error) {
    const problem = `A13s E-Mail-Durchlauf konnte nicht laufen: ${(error as Error).message}`;
    result.problems.push(problem);
    deps.logger.error({ err: error }, problem);
  }

  return result;
}

/**
 * Property 4: tell the operator over the channel that still works, once per outage.
 *
 * The failure being reported is a silent one by construction — the mail path
 * cannot report on itself, and nothing else looks at it. It goes to `alerts`
 * because that is the topic the operator reads for "something is broken", and at ordinary
 * priority because nothing is stuck: work continues, only A13's reminders do
 * not. Recovery goes to `info`, following `incident-cycle.ts`, which puts
 * "the incident is over" on the quiet channel.
 */
async function reportMailHealth(
  deps: NotificationsPassDeps,
  state: NotificationsPassState,
  failures: readonly string[],
): Promise<'failure' | 'recovery' | null> {
  if (failures.length > 0) {
    if (state.mailFailing) return null;
    deps.logger.warn(
      { count: failures.length, first: failures[0] },
      `${failures.length} E-Mail(s) nicht zugestellt (§16) — der Weg über SMTP ist zurzeit tot`,
    );
    const sent = await deps.notifier.send({
      topic: 'alerts',
      title: 'Vorschicht: E-Mail-Versand schlägt fehl',
      message:
        `${failures.length} Nachricht(en) konnten nicht zugestellt werden.\n\n` +
        `${failures[0]}\n\n` +
        'Diese Meldung kommt über ntfy — der Weg über E-Mail (§16) ist zurzeit tot. ' +
        'Erinnerungen und Tagesdigest (A13) laufen bis auf Weiteres nicht; ' +
        'offene Entscheidungen bleiben offen (§15).',
      tags: ['warning'],
    });
    // Only now (decision 2's reasoning): an alert ntfy refused is an alert
    // nobody got, and marking it as delivered would silence the retry.
    if (!sent.ok) return null;
    state.mailFailing = true;
    return 'failure';
  }

  if (!state.mailFailing) return null;
  const sent = await deps.notifier.send({
    topic: 'info',
    title: 'Vorschicht: E-Mail-Versand läuft wieder',
    message:
      'Die letzte Zustellung hat funktioniert. Erinnerungen und Digest (A13) gehen wieder raus.',
  });
  if (!sent.ok) return null;
  state.mailFailing = false;
  return 'recovery';
}

/**
 * §16's three topics, from the three env variables that name them.
 *
 * Here rather than inline in `main()` because the `Notifier` was constructed
 * **without** `topics`, so `NTFY_TOPIC_INBOX`, `_ALERTS` and `_INFO` were parsed
 * by `loadConfig`, carried through the config object and read by nobody — the
 * hard-coded defaults always won. §16 says the topics are configurable; until
 * this existed that was documentation. A function rather than an object literal
 * so the mapping itself is assertable: three same-shaped names next to three
 * same-shaped fields is exactly where a copy-and-paste sends every inbox card to
 * the alerts topic, silently and forever.
 */
export function notifierTopics(config: {
  ntfyTopicInbox: string;
  ntfyTopicAlerts: string;
  ntfyTopicInfo: string;
}): Record<NtfyTopic, string> {
  return {
    inbox: config.ntfyTopicInbox,
    alerts: config.ntfyTopicAlerts,
    info: config.ntfyTopicInfo,
  };
}
