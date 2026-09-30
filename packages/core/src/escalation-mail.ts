/**
 * A13's two e-mail rules: "unanswered > 24h → e-mail reminder; daily pending
 * digest while items are pending."
 *
 * Read as one sentence they sound like a scheduling problem. They are not — they
 * are an *idempotence* problem, and the whole content of this module is where
 * the memory lives. The tick that calls this runs every few seconds (A57), so a
 * reminder that only knew "this item is older than 24 h" would send one mail per
 * tick for as long as the operator took to answer, which is A13 turned into a denial of
 * service against the one channel §15 relies on. Six decisions.
 *
 *  1. **The memory is the event log, not `escalation_events`.** the build log
 *     had planned a third escalation event kind (`reminded`) with a CHECK
 *     constraint, and that turns out to be the wrong table: 0016 hard-codes
 *     `seq = 1` for the raise and the partial unique index makes the answer the
 *     only other row, so an arbitrary number of reminders between them does not
 *     fit the numbering that migration deliberately built. The event log is
 *     append-only (§18), takes new kinds without a migration (`event_log.kind`
 *     is a format check, not an enum), is indexed on `(kind, occurred_at)`, and
 *     is the source of truth the dashboard already renders — which is where "how
 *     often did the studio have to remind the operator" belongs anyway.
 *
 *  2. **A mail that failed to send is not recorded as sent.** The event is
 *     written *after* the transport answers `ok`. The consequence is deliberate
 *     in both directions: a broken mail server means the reminder is retried on
 *     the next tick (correct — nobody has been reminded), and a server that
 *     accepted the mail and then dropped it is indistinguishable from success
 *     (accepted — SMTP has no other definition of delivery).
 *
 *  3. **An unconfigured SMTP does nothing at all, quietly.** No event, no
 *     per-item log line, no work. `DisabledMailer` says so once at start-up
 *     (`createMailer`), and `tick()` returns `enabled: false` so the caller can
 *     say it once more if it wants to. The alternative — logging a skip per
 *     pending item per tick — is the same flood the reminder rule exists to
 *     avoid, arriving through the log instead of the mailbox.
 *
 *  4. **The digest is measured from the last digest, not from a clock hour.**
 *     See `DIGEST_INTERVAL_MS`. An unattended system that is down at 07:00 must
 *     not skip the day, and one that restarts at 07:00 must not send twice.
 *
 *  5. **Reminder and digest are independent.** An item that has just triggered
 *     its own reminder still appears in that day's digest; the digest is "what
 *     is still open", not "what is new". Suppressing it would make the digest's
 *     count disagree with §17.1's counter, which is the one number both are
 *     supposed to be about.
 *
 *  6. **This sends; it does not decide anything about a task.** Same boundary
 *     the rest of Phase 4 keeps (A48.2, A53.1): no state changes, no claims, no
 *     escalation is answered or closed here. §15 holds an unanswered item
 *     indefinitely and a reminder does not shorten that.
 */
import {
  DIGEST_INTERVAL_MS,
  type EscalationMailItem,
  type EscalationSource,
  type Priority,
  REMINDER_AFTER_MS,
  renderDigestMail,
  renderReminderMail,
} from '@vorschicht/shared';
import type { EscalationRecord, EscalationService } from './escalation-service.js';
import type { EventLog } from './event-log.js';
import type { Mailer } from './mail.js';
import type { Queryable } from './sql.js';

export interface EscalationMailDeps {
  sql: Queryable;
  eventLog: EventLog;
  escalations: EscalationService;
  mailer: Mailer;
  /** A1's origin — every mail carries §15's deep link built from it. */
  publicOrigin: string;
  /** The operator. Without one nothing is sent, for the same reason as an absent host. */
  recipient?: string | undefined;
  /** Injected everywhere in this project (GuardianService, UsageMeter, …). */
  now?: (() => number) | undefined;
}

export interface EscalationMailOutcome {
  /** False when SMTP or the recipient is missing: nothing was attempted. */
  enabled: boolean;
  /** Numbers of the items a reminder went out for on this pass. */
  reminded: number[];
  /** Numbers the digest covered, or null when no digest was due. */
  digest: number[] | null;
  /** Sends the transport refused, as `#12: …`. Never thrown, always reported. */
  failures: string[];
}

export class EscalationMailService {
  private readonly now: () => number;

  constructor(private readonly deps: EscalationMailDeps) {
    this.now = deps.now ?? Date.now;
  }

  /**
   * One pass of A13. Safe to call as often as the scheduler ticks.
   *
   * Order matters exactly once: the reminders go first, so that an item which
   * crosses 24 h on the same pass that a digest is due gets both — its own card
   * and its line in the list. The reverse order would produce the same two mails
   * and is only written down because the first reading of A13 ("one or the
   * other") is the wrong one: they answer different questions, and §16 lists
   * them as two things.
   */
  async tick(): Promise<EscalationMailOutcome> {
    const recipient = this.deps.recipient;
    if (!this.deps.mailer.enabled || !recipient) {
      return { enabled: false, reminded: [], digest: null, failures: [] };
    }

    const open = await this.deps.escalations.open();
    const failures: string[] = [];
    const reminded = await this.sendReminders(open, recipient, failures);
    const digest = await this.sendDigest(open, recipient, failures);
    return { enabled: true, reminded, digest, failures };
  }

  private async sendReminders(
    open: EscalationRecord[],
    recipient: string,
    failures: string[],
  ): Promise<number[]> {
    const now = this.now();
    // `raisedAt` is the database's `now()` at the moment the item was raised,
    // which is the right thing for it to be — that is when it happened. The two
    // clocks are one host in production; a suite that wants a 25-hour-old item
    // sets the timestamp on the row rather than asking this service to believe
    // an age it was told.
    const due = open.filter((item) => now - item.raisedAt.getTime() >= REMINDER_AFTER_MS);
    if (due.length === 0) return [];

    const alreadySent = await this.remindedIds(due.map((item) => item.id));
    const sent: number[] = [];

    for (const item of due) {
      if (alreadySent.has(item.id)) continue;
      const content = renderReminderMail(toMailItem(item), {
        publicOrigin: this.deps.publicOrigin,
        now,
      });
      const result = await this.deps.mailer.send({ to: recipient, ...content });
      if (!result.ok) {
        failures.push(`#${item.number}: ${result.error}`);
        continue;
      }
      // Decision 2: only now. A crash between the send and this write costs one
      // duplicate reminder, which is the direction to fail in.
      await this.deps.eventLog.append({
        kind: 'escalation.reminded',
        actor: 'system',
        projectId: item.projectId,
        taskId: item.taskId,
        payload: {
          escalationId: item.id,
          number: item.number,
          urgency: item.urgency,
          waitingMs: now - item.raisedAt.getTime(),
          channel: 'email',
        },
      });
      sent.push(item.number);
    }
    return sent;
  }

  private async sendDigest(
    open: EscalationRecord[],
    recipient: string,
    failures: string[],
  ): Promise<number[] | null> {
    if (open.length === 0) return null;
    const now = this.now();
    const last = await this.lastDigestAt();
    if (last !== null && now - last < DIGEST_INTERVAL_MS) return null;

    const content = renderDigestMail(open.map(toMailItem), {
      publicOrigin: this.deps.publicOrigin,
      now,
    });
    const result = await this.deps.mailer.send({ to: recipient, ...content });
    if (!result.ok) {
      failures.push(`Digest: ${result.error}`);
      return null;
    }

    const numbers = open.map((item) => item.number);
    await this.deps.eventLog.append({
      kind: 'escalation.digest_sent',
      actor: 'system',
      // `sentAt` is written even though `event_log.occurred_at` exists, and the
      // reason is the one below: the cadence has to be measured on the clock
      // this service was given, not on the database's.
      payload: { count: numbers.length, numbers, channel: 'email', sentAt: now },
    });
    return numbers;
  }

  /**
   * Which of these items has already had its reminder.
   *
   * Scoped to the ids being asked about rather than "every reminder ever": the
   * event log is kept forever (A15) and this runs on a tick, so an unbounded
   * `SELECT DISTINCT` over a growing table would get slower every week for an
   * answer about at most a handful of open items.
   */
  private async remindedIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await this.deps.sql<Array<{ escalation_id: string }>>`
      SELECT DISTINCT payload ->> 'escalationId' AS escalation_id
      FROM event_log
      WHERE kind = 'escalation.reminded'
        AND payload ->> 'escalationId' = ANY(${this.deps.sql.array(ids)})
    `;
    return new Set(rows.map((row) => row.escalation_id));
  }

  /**
   * When the last digest actually went out, or null if none ever has.
   *
   * Read from the payload rather than from `occurred_at`, which is the
   * database's `now()`. In production the two are the same host and agree to
   * within a millisecond, so this looks like a distinction without a difference
   * — until the clock is injected, which it is everywhere in this project. A
   * comparison that took one side from `now()` and the other from Postgres would
   * be a policy nobody can move the clock on, and therefore a policy nobody can
   * test in either direction.
   */
  private async lastDigestAt(): Promise<number | null> {
    const [row] = await this.deps.sql<Array<{ last: string | null }>>`
      SELECT max((payload ->> 'sentAt')::bigint)::text AS last
      FROM event_log WHERE kind = 'escalation.digest_sent'
    `;
    return row?.last ? Number(row.last) : null;
  }
}

/**
 * `EscalationRecord` → what the renderer is allowed to see.
 *
 * The narrowing is the point (see `EscalationMailItem`): the mail cannot print a
 * field it was not handed, and the renderer stays testable without a database.
 */
function toMailItem(record: EscalationRecord): EscalationMailItem {
  return {
    number: record.number,
    urgency: record.urgency as Priority,
    source: record.source as EscalationSource,
    question: record.question,
    context: record.context,
    raisedAt: record.raisedAt,
    options: record.options.map((option) => ({
      title: option.title,
      recommended: option.recommended === true,
    })),
  };
}
