/**
 * The caller for §14's proposal answers — the half that is easy to forget.
 *
 * `SourceProposals.raise` puts a source in front of the operator and
 * `SourceProposals.applyAnswers` carries out what he decided. Without a caller
 * for the second, the first is a card whose answer does nothing, which is a
 * shape this repository has now shipped twice: `EscalationMailService.tick()`
 * with no caller at all (A86), and §6.6's transcript scan with no channel to
 * report through (A105). Both were found by a reader rather than by a test,
 * because a mechanism nothing calls has nothing to be red about.
 *
 * Four decisions.
 *
 *  1. **Its own cadence, not the tick's.** `notifications-pass.ts` splits the
 *     same way and for the same reason: §15's push is "immediately on creation"
 *     and a minute of latency on a P0 card is unacceptable, while A13's 24-hour
 *     rules would cost two queries a pass forever if they ran at tick frequency.
 *     A source acceptance is the second kind. §14 is explicit that curation only
 *     *boosts ranking* — "curated sources are weighted reference works, not
 *     restrictions" — so nothing is blocked while a decision sits for a minute,
 *     and the query it saves is two indexed lookups every fifteen seconds
 *     forever.
 *
 *  2. **It runs on every pass of the daemon's loop, healthy or not.** The two
 *     alternatives are wrong in the same direction `notifications-pass.ts`
 *     names: behind §6.1's smoke gate, or inside `onReady`, a studio whose CLI
 *     probe is stuck or whose token has expired stops acting on decisions the operator
 *     has already made — including, plausibly, the ones he made *because* it is
 *     stuck. This needs Postgres and nothing else.
 *
 *  3. **No `try` around `applyAnswers`.** It cannot throw: it catches the read
 *     and each card separately and reports both as `problems`. A second guard
 *     around something that provably cannot throw is exactly the dead wiring
 *     these passes exist to remove (`notifications-pass.ts`, property 1), and if
 *     that ever stopped being true the right fix is in that method, where the
 *     failure is, rather than a catch here that would hide it.
 *
 *  4. **A problem is logged, never pushed.** A card that could not be carried
 *     out is retried on the next pass, so a push per pass would be A67.6's muted
 *     channel — and unlike a failed backup or an unreachable registry there is
 *     nothing for the operator to do about it that answering the card again would not
 *     already do. It stays in the log and in `event_log`, where §8.2's sixth
 *     domain can find it.
 */
import type { ApplyProposalsResult } from '@vorschicht/core';

/**
 * How often answered proposal cards are carried out.
 *
 * Well below the time anybody notices a ranking change and far above the tick,
 * so the worst case is that a source joins the registry a minute after the operator said
 * yes. `MAIL_PASS_INTERVAL_MS` picks the same number for the same shape.
 */
export const SOURCES_PASS_INTERVAL_MS = 60_000;

/** Exactly the call this module makes (`SmokeRunner`'s posture). */
export interface SourcesPassDeps {
  proposals: { applyAnswers(): Promise<ApplyProposalsResult> };
  logger: {
    info(obj: unknown, message?: string): void;
    warn(obj: unknown, message?: string): void;
  };
  now?: (() => number) | undefined;
  intervalMs?: number | undefined;
}

/** Carried across passes by the daemon, like `NotificationsPassState` beside it. */
export interface SourcesPassState {
  nextRunAt: number;
}

export function newSourcesPassState(): SourcesPassState {
  // Zero rather than "now + interval": a daemon that has just restarted should
  // carry out a decision the operator made while it was down on its first pass, not in a
  // minute. `periodic-pass.ts` reads a missing deadline the same way.
  return { nextRunAt: 0 };
}

export interface SourcesPassResult {
  /** False when the deadline had not passed — the ordinary case, and silent. */
  ran: boolean;
  applied: ApplyProposalsResult['applied'];
  problems: string[];
}

export async function runSourcesPass(
  deps: SourcesPassDeps,
  state: SourcesPassState,
): Promise<SourcesPassResult> {
  const now = deps.now?.() ?? Date.now();
  if (now < state.nextRunAt) return { ran: false, applied: [], problems: [] };
  // Set before the work, so a slow pass does not stack: the next deadline is
  // measured from when this one started rather than from when it ends.
  state.nextRunAt = now + (deps.intervalMs ?? SOURCES_PASS_INTERVAL_MS);

  const result = await deps.proposals.applyAnswers();

  for (const applied of result.applied) {
    // Every outcome is logged, including the two that curated nothing — a
    // free-text answer and a source somebody curated in the dashboard meanwhile
    // are both states the operator would want to see rather than infer from silence.
    deps.logger.info(
      { escalation: applied.escalationNumber, source: applied.sourceId, outcome: applied.outcome },
      applied.detail ??
        `Quellenvorschlag #${applied.escalationNumber} ausgeführt: ${applied.outcome}`,
    );
  }
  for (const problem of result.problems) deps.logger.warn({}, problem);

  return { ran: true, applied: result.applied, problems: result.problems };
}
