/**
 * §19's trail for a curation act on §14's registry — the seam A112 handed over.
 *
 * `SourceRegistry` deliberately writes no `audit_log` row, and its header says
 * why and then says who has to: "§19 wants an `audit_log` row for every
 * *dashboard action*, and the operator accepting or promoting a source on the Sources
 * page is one. […] Wer die Route baut, muss die Zeile dort erzeugen. Fällt sie
 * aus, fällt sie ausgerechnet in dem Teil des Registers aus, den §14 zur
 * Evidenzgrundlage für Legal-Zitate macht."
 *
 * Four decisions.
 *
 *  1. **One writer, two callers.** A curation act reaches the registry down two
 *     paths — the dashboard route, and the orchestrator carrying out an answered
 *     proposal card (§15) — and both are the operator deciding. A trail that named only
 *     the first would answer "who took this source into the registry" with a
 *     hole shaped exactly like §14's own flow, which is proposal → card →
 *     decision. So this lives in `@vorschicht/core` rather than in the route,
 *     because `apps/orchestrator` cannot import from `apps/server`.
 *
 *  2. **It is not on `SourceRegistry`.** That class's own first decision is that
 *     the append-only log *is* the trace — actor and reason on every row — and
 *     that a second record of the same fact is a second thing that can disagree.
 *     What §19 asks for is a different fact: not *what happened to the source*
 *     but *that this channel did it*, which is why the row carries the act, the
 *     actor and the source's standing before and after rather than the reason.
 *
 *  3. **`before` and `after` are the source's own record**, the shape
 *     `ProjectService.audit` already writes. That makes "which level was granted
 *     and which one it replaced" answerable from the trail alone, without
 *     joining back into a log the reader may not have.
 *
 *  4. **It never throws its own error class.** A failure here is a failure to
 *     write §19's row, and the caller decides what that means: the route reports
 *     it, the orchestrator's pass logs it. Inventing a class would put a
 *     decision in the wrong module.
 */
import type postgres from 'postgres';
import type { Queryable } from '../sql.js';
import type { SourceRecord } from './registry.js';

/**
 * The four acts, as `audit_log.action` spells them.
 *
 * A table rather than a template, so the strings a query filters on are visible
 * in one place. `source.` prefixed, following `project.gate_config_changed` and
 * `document.created`.
 */
export const SOURCE_AUDIT_ACTIONS = {
  accept: 'source.accepted',
  reject: 'source.rejected',
  level: 'source.level_changed',
  retire: 'source.retired',
} as const;

export type SourceAuditAction = keyof typeof SOURCE_AUDIT_ACTIONS;

export interface SourceAuditEntry {
  /** `dashboard:<credentialId>` from a session, or `max` through §15's card. */
  actor: string;
  act: SourceAuditAction;
  /** The source's standing before the act, or null when it was only just proposed. */
  before: SourceRecord | null;
  after: SourceRecord;
  /**
   * §15's item number, when the act came from an answered card.
   *
   * The link that makes the two channels distinguishable in the trail — a row
   * without it was somebody pressing a button, a row with it was an inbox
   * decision being carried out.
   */
  escalationNumber?: number | null;
}

/** Exactly the one call the callers make (`SmokeRunner`'s posture, A57.6). */
export interface SourceAuditTrail {
  record(entry: SourceAuditEntry): Promise<void>;
}

export class SourceAuditLog implements SourceAuditTrail {
  constructor(private readonly sql: Queryable) {}

  async record(entry: SourceAuditEntry): Promise<void> {
    // The source id, not the title: a title can be re-proposed and a subject
    // that two rows share for different sources is a trail nobody can read
    // backwards. `documents` makes the same call one directory over.
    const subject = entry.after.id;
    await this.sql`
      INSERT INTO audit_log (actor, action, subject, before, after)
      VALUES (
        ${entry.actor}, ${SOURCE_AUDIT_ACTIONS[entry.act]}, ${subject},
        ${entry.before === null ? null : this.sql.json(forAudit(entry.before) as postgres.JSONValue)},
        ${this.sql.json({
          ...forAudit(entry.after),
          escalationNumber: entry.escalationNumber ?? null,
        } as postgres.JSONValue)}
      )
    `;
  }
}

/**
 * What a source looks like in `audit_log`.
 *
 * Everything except the timestamps, which are `Date` objects the driver would
 * serialise anyway and which the row's own `occurred_at` already answers better.
 * Nothing here is secret — a source is a public URL or a vault reference — so
 * unlike `DocumentVault.forAudit` there is no text to hold back; the reason it
 * is a projection at all is that a `SourceRecord` grown later must not silently
 * start copying new fields into a table §18 never deletes from.
 */
function forAudit(source: SourceRecord): Record<string, unknown> {
  return {
    id: source.id,
    url: source.url,
    documentId: source.documentId,
    title: source.title,
    proposedLevel: source.proposedLevel,
    level: source.level,
    state: source.state,
    stateReason: source.stateReason,
    levelReason: source.levelReason,
    score: source.score,
  };
}
