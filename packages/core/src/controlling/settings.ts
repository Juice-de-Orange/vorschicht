/**
 * §17.8's two operator switches, stored in §5's `config` and audited per §19.
 *
 * `@vorschicht/shared/controlling` owns every rule about what the positions
 * *mean* — which of the three pause modes is which pair for the guardian, what
 * an unparsable value falls back to, what A22 claims to do. Nothing here
 * re-decides any of them. What this module adds is persistence, §19's trail,
 * and the read the daemon performs on every tick.
 *
 * `PersonaSettings` is the precedent and this follows it in four ways
 * deliberately — one transaction per change, a required `actor`, a trail row
 * even when nothing moved, and a missing row meaning the default. Two things
 * differ, and both are decisions rather than drift.
 *
 *  1. **The pause fails closed and Sparbetrieb does not.** `PersonaSettings`
 *     decision 4 reads a corrupt value as the default and says why: failing
 *     closed there would mean `aus`, a *different* setting rather than a
 *     refusal. A pause is not a display setting. It is the one value in this
 *     table that a person set in order to stop the studio, and there is no
 *     second device behind it — so an unreadable row reads as `pause`, never as
 *     "carry on" (A83.6, A87.6, A99.4). Sparbetrieb goes the other way because
 *     §7.2 does not depend on it: the guardian still stops at 85 % and 95 %
 *     whatever this says, so a broken value costs quality rather than budget,
 *     and §1 ranks quality first. Both fallbacks live in the shared module and
 *     are read from there, so this class cannot disagree with the page about
 *     what a corrupt row means.
 *
 *  2. **Reading is on the hot path and says so.** `PersonaSettings.mode()` is
 *     called once per settings page. `pause()` is called by the guardian on
 *     every evaluation — which is every scheduler tick — so it is one indexed
 *     primary-key lookup and nothing else, and it deliberately does **not**
 *     write anything. A read that recorded its own occurrence would put a row
 *     in an append-only table every fifteen seconds forever (0014's lesson).
 *
 * A failure to *read* propagates rather than being swallowed. The one caller
 * that must not fall over on it is the guardian, and it is the guardian's own
 * `evaluate()` that decides what a database it cannot reach means — a default
 * invented here would answer "not paused" for a studio whose pause row is
 * simply unreachable, which is the same sentence this module refuses to say
 * about a corrupt one.
 */
import {
  manualPauseFor,
  PAUSE_KEY,
  PAUSE_MODE_DEFAULT,
  PAUSE_MODE_UNREADABLE,
  type PauseMode,
  pauseModeSchema,
  SPARBETRIEB_DEFAULT,
  SPARBETRIEB_KEY,
} from '@vorschicht/shared/controlling';
import type postgres from 'postgres';
import { z } from 'zod';
import type { Queryable } from '../sql.js';

/** `audit_log.action`, following `config.personas_changed`. */
export const PAUSE_AUDIT_ACTION = 'config.pause_changed';
export const SPARBETRIEB_AUDIT_ACTION = 'config.sparbetrieb_changed';

/**
 * A value plus whether it had to be guessed.
 *
 * The flag travels because the page has to be able to say "this row is not
 * readable and I am therefore holding the studio" — a fallback that looked
 * exactly like a deliberate setting would make a corrupt row indistinguishable
 * from the operator's own decision, which is the distinction §19's trail exists to keep
 * one table over.
 */
export interface Gelesen<T> {
  wert: T;
  unlesbar: boolean;
}

export interface PauseChange {
  before: PauseMode;
  after: PauseMode;
}

export interface SparbetriebChange {
  before: boolean;
  after: boolean;
}

const sparbetriebValueSchema = z.boolean();

export class ControllingSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ControllingSettingsError';
  }
}

export class ControllingSettings {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly onWarning: (message: string) => void = () => {},
  ) {}

  /** A26's switch position, or `normal` when nothing has been set. */
  async pause(): Promise<Gelesen<PauseMode>> {
    return await readPause(this.sql, this.onWarning);
  }

  /**
   * The guardian's own shape, for the daemon's `manualPause` hook.
   *
   * Here rather than at the call site so that `manualPauseFor` has exactly one
   * caller in production: a second translation of the three modes would be a
   * second chance for `hart` to arrive as a soft pause, and nothing downstream
   * could notice — the studio would read as paused and would still be killing
   * nothing.
   */
  async manualPause(): Promise<{ active: boolean; hard: boolean }> {
    return manualPauseFor((await this.pause()).wert);
  }

  /** A22's emergency profile, or off when nothing has been set. */
  async sparbetrieb(): Promise<Gelesen<boolean>> {
    return await readSparbetrieb(this.sql, this.onWarning);
  }

  /** Move A26's switch and record who did it (§19), atomically. */
  async setPause(mode: PauseMode, actor: string): Promise<PauseChange> {
    assertActor(actor, 'Pause');
    return await this.sql.begin(async (tx) => {
      const before = await readPause(tx, this.onWarning);
      await write(tx, PAUSE_KEY, mode);
      await trail(
        tx,
        actor,
        PAUSE_AUDIT_ACTION,
        PAUSE_KEY,
        { modus: before.wert },
        { modus: mode },
      );
      return { before: before.wert, after: mode };
    });
  }

  /** Move A22's switch and record who did it (§19), atomically. */
  async setSparbetrieb(aktiv: boolean, actor: string): Promise<SparbetriebChange> {
    assertActor(actor, 'Sparbetrieb');
    return await this.sql.begin(async (tx) => {
      const before = await readSparbetrieb(tx, this.onWarning);
      await write(tx, SPARBETRIEB_KEY, aktiv);
      await trail(
        tx,
        actor,
        SPARBETRIEB_AUDIT_ACTION,
        SPARBETRIEB_KEY,
        { aktiv: before.wert },
        { aktiv },
      );
      return { before: before.wert, after: aktiv };
    });
  }
}

/**
 * §19 wants an actor and this refuses to write a row without one.
 *
 * A default would only ever be reached by a route that forgot to pass the
 * session, and A75.3 is precisely that failure: a trail in which every pause
 * was ordered by `system` answers *that* the studio was stopped and loses the
 * question the trail is kept for. Required makes it a compile error; this makes
 * an empty string one too, which the type system cannot.
 */
function assertActor(actor: string, was: string): void {
  if (actor.trim()) return;
  throw new ControllingSettingsError(
    `${was} ohne Aktor: §19 verlangt für jede Konfigurationsänderung eine Zeile im ` +
      'Prüfprotokoll, und eine ohne Urheber beantwortet die Frage nicht, für die das ' +
      'Protokoll geführt wird.',
  );
}

async function write(tx: Queryable, key: string, value: unknown): Promise<void> {
  await tx`
    INSERT INTO config (key, value, updated_at)
    VALUES (${key}, ${tx.json(value as never)}, now())
    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
  `;
}

/**
 * §19's row, written in the same transaction as the change.
 *
 * Written even when `before` and `after` are equal: submitting the position
 * that is already set is a dashboard action and §19 does not distinguish.
 * Suppressing it would make the log answer "the operator never tried" for an attempt
 * that happened (`PersonaSettings` decision 3, A62.2's sentence).
 */
async function trail(
  tx: Queryable,
  actor: string,
  action: string,
  subject: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await tx`
    INSERT INTO audit_log (actor, action, subject, before, after)
    VALUES (${actor}, ${action}, ${subject}, ${tx.json(before as never)}, ${tx.json(after as never)})
  `;
}

/**
 * One reader per key, used by both the pool path and the transaction path.
 *
 * Written once so that "what does a missing or broken row mean" has a single
 * answer — two copies is how a read inside a transaction starts disagreeing
 * with the read that renders the page.
 */
async function readPause(
  sql: Queryable,
  onWarning: (message: string) => void,
): Promise<Gelesen<PauseMode>> {
  const rows = await sql<{ value: unknown }[]>`SELECT value FROM config WHERE key = ${PAUSE_KEY}`;
  const row = rows[0];
  if (!row) return { wert: PAUSE_MODE_DEFAULT, unlesbar: false };
  const parsed = pauseModeSchema.safeParse(row.value);
  if (parsed.success) return { wert: parsed.data, unlesbar: false };
  onWarning(
    `Pause-Einstellung in config["${PAUSE_KEY}"] ist unlesbar (${JSON.stringify(row.value)}); ` +
      `das Studio bleibt vorsichtshalber auf "${PAUSE_MODE_UNREADABLE}" stehen, bis der Wert ` +
      'korrigiert ist. Eine unlesbare Anweisung ist keine Erlaubnis weiterzuarbeiten.',
  );
  return { wert: PAUSE_MODE_UNREADABLE, unlesbar: true };
}

async function readSparbetrieb(
  sql: Queryable,
  onWarning: (message: string) => void,
): Promise<Gelesen<boolean>> {
  const rows = await sql<{ value: unknown }[]>`
    SELECT value FROM config WHERE key = ${SPARBETRIEB_KEY}
  `;
  const row = rows[0];
  if (!row) return { wert: SPARBETRIEB_DEFAULT, unlesbar: false };
  const parsed = sparbetriebValueSchema.safeParse(row.value);
  if (parsed.success) return { wert: parsed.data, unlesbar: false };
  onWarning(
    `Sparbetrieb-Einstellung in config["${SPARBETRIEB_KEY}"] ist unlesbar ` +
      `(${JSON.stringify(row.value)}); es gilt die Voreinstellung "aus". Der Wächter (§7.2) ` +
      'begrenzt das Budget unabhängig von diesem Schalter.',
  );
  return { wert: SPARBETRIEB_DEFAULT, unlesbar: true };
}
