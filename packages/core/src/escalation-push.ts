/**
 * §15's first sentence about notifications: "ntfy push immediately on creation",
 * with "a deep link straight to the item from every notification".
 *
 * The `inbox` topic had no general producer. `NTFY_TOPICS.inbox` was declared,
 * `.env.example` shipped `NTFY_TOPIC_INBOX`, `Notifier.clickUrl` existed and was
 * set by nobody — three pieces of a channel and no sender, which is A71's shape
 * and §8.2's sixth domain: a signal path that cannot carry a signal reads as
 * covered. Exactly one source did push: `budget_anomaly` raised its card and
 * announced it in the same block (A83), **without** a `clickUrl` — so the one
 * notification §15's inbox channel ever carried was also the one place §15's
 * "deep link straight to the item" was provably broken. That block is gone; the
 * card it raises is announced here like every other, with its link.
 *
 * Six decisions.
 *
 *  1. **An observer, not a hook in `EscalationService.raise`.** The obvious
 *     build is to push where the item is written; it is wrong for a structural
 *     reason. `EscalationService` is constructed in three places, and the
 *     primary §15 source — `AgentChannel.requestEscalation`, i.e. what
 *     `escalate.ask` calls — lives in `packages/mcp/src/main.ts`: a short-lived
 *     per-session subprocess that A49 built to win a ~400 ms handshake race,
 *     whose import graph deliberately excludes Drizzle and pg-boss, and in which
 *     a misconfigured push channel would make a **session** fail to start. An
 *     observer costs one indexed query per pass and covers every future producer
 *     for free, including the six §15 sources that have no producer yet.
 *
 *  2. **The event is written after the push succeeds, never before.**
 *     `escalation-mail.ts`'s decision 2, verbatim reasoning: a push that failed
 *     is not a push that happened, so it is retried on the next pass, and a
 *     crash between the send and the write costs one duplicate notification —
 *     which is the direction to fail in for a channel whose whole purpose is
 *     that the operator finds out.
 *
 *  3. **The already-pushed set is read scoped to the ids in hand.** The event
 *     log is kept forever (A15) and this runs on a tick; an unbounded
 *     `SELECT DISTINCT` would get slower every week to answer a question about
 *     at most a handful of open items. Same shape as `remindedIds`.
 *
 *  4. **The link is built by `inboxUrl`, never by hand.** A81.3: `inboxUrl`
 *     once built `/inbox/<n>` while the router answered `/posteingang`, so every
 *     deep link in every notification landed on the overview. `INBOX_PATH` is
 *     shared now and this is its first production caller on the push side.
 *
 *  5. **Urgency maps to ntfy priority; the clock does not enter into it.** §16
 *     forbids quiet hours and "priority gating by time of day" — it says nothing
 *     against the urgency the raising department already assigned, which is the
 *     one thing that legitimately decides whether a phone lights up at 03:00.
 *
 *  6. **Nothing here answers, parks or closes anything.** Same boundary the rest
 *     of Phase 4 keeps (A48.2, A53.1, `escalation-mail.ts` decision 6): §15
 *     holds an unanswered item indefinitely and a notification does not shorten
 *     that.
 *
 * Stated honestly rather than implied: §16 says "everything pushes immediately,
 * 24/7". This pushes within **one pass of the daemon's loop** — a tick, not a
 * scheduling window. There is no quiet hour and no batching, and the delay is
 * whatever `TICK_INTERVAL_MS` is (15 s today). An in-process hook would be
 * faster by that much and would cost decision 1.
 */
import { ESCALATION_SOURCE_LABELS, inboxUrl, type Priority } from '@vorschicht/shared';
import type { EscalationRecord, EscalationService } from './escalation-service.js';
import type { EventLog } from './event-log.js';
import type { Notification, Notifier, NotifyPriority } from './notify.js';
import type { Queryable } from './sql.js';

export interface EscalationPushDeps {
  sql: Queryable;
  eventLog: EventLog;
  /** Only the inbox is read. Nothing here may answer an item. */
  escalations: Pick<EscalationService, 'open'>;
  notifier: Pick<Notifier, 'send'>;
  /** A1's origin — §15's deep link is built from it. */
  publicOrigin: string;
}

export interface EscalationPushOutcome {
  /** Numbers of the items a push went out for on this pass. */
  pushed: number[];
  /** Pushes ntfy refused, as `#12: …`. Never thrown, always reported. */
  failures: string[];
}

/**
 * P0 wakes the operator up; P3 waits until he looks (§9's priorities, §16's channel).
 *
 * P2 and P3 share `default` deliberately: ntfy's `low` suppresses the sound
 * *and* the pop-up on Android, which for an item that is waiting for a decision
 * is indistinguishable from not having been sent.
 */
function pushPriority(urgency: Priority): NotifyPriority {
  if (urgency === 'P0') return 'urgent';
  if (urgency === 'P1') return 'high';
  return 'default';
}

/** German (§2). The number is in the title so the card labels its own link. */
function toNotification(item: EscalationRecord, publicOrigin: string): Notification {
  return {
    topic: 'inbox',
    title: `Vorschicht: Entscheidung #${item.number} wartet`,
    message:
      `${item.question}\n\n` +
      `${ESCALATION_SOURCE_LABELS[item.source]} · ${item.urgency} · ` +
      `${item.options.length} vorbereitete Optionen`,
    priority: pushPriority(item.urgency),
    tags: ['inbox_tray'],
    clickUrl: inboxUrl(publicOrigin, item.number),
  };
}

export class EscalationPushService {
  constructor(private readonly deps: EscalationPushDeps) {}

  /**
   * One pass of §15's push rule. Safe to call as often as the scheduler ticks.
   *
   * Only open items are considered: an item the operator has already answered needs no
   * notification, and the one case where that matters is a restart — the
   * already-pushed set lives in the log, so a daemon that comes back up does not
   * re-announce a week of decided questions.
   */
  async push(): Promise<EscalationPushOutcome> {
    const open = await this.deps.escalations.open();
    if (open.length === 0) return { pushed: [], failures: [] };

    const already = await this.pushedIds(open.map((item) => item.id));
    const pushed: number[] = [];
    const failures: string[] = [];

    for (const item of open) {
      if (already.has(item.id)) continue;
      const notification = toNotification(item, this.deps.publicOrigin);
      const result = await this.deps.notifier.send(notification);
      if (!result.ok) {
        failures.push(`#${item.number}: ${result.error}`);
        continue;
      }
      // Decision 2: only now.
      await this.deps.eventLog.append({
        kind: 'escalation.pushed',
        actor: 'system',
        projectId: item.projectId,
        taskId: item.taskId,
        runId: item.runId,
        payload: {
          escalationId: item.id,
          number: item.number,
          source: item.source,
          urgency: item.urgency,
          channel: 'ntfy',
          topic: notification.topic,
          clickUrl: notification.clickUrl,
        },
      });
      pushed.push(item.number);
    }

    return { pushed, failures };
  }

  /** Which of these items has already been announced (decision 3). */
  private async pushedIds(ids: string[]): Promise<Set<string>> {
    const rows = await this.deps.sql<Array<{ escalation_id: string }>>`
      SELECT DISTINCT payload ->> 'escalationId' AS escalation_id
      FROM event_log
      WHERE kind = 'escalation.pushed'
        AND payload ->> 'escalationId' = ANY(${this.deps.sql.array(ids)})
    `;
    return new Set(rows.map((row) => row.escalation_id));
  }
}
