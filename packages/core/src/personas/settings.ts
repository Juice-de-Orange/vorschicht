/**
 * §8's persona switch, stored in §5's `config` and audited per §19.
 *
 * `@vorschicht/shared/personas` owns every rule about what the three modes
 * *mean* — which of them shows a name, which one reaches a prompt, what the
 * neutral label is. Nothing here re-decides any of them. What this module adds
 * is persistence, §19's trail, and the roster the settings page renders.
 *
 * Five decisions.
 *
 *  1. **The change and its audit row are one transaction.** `ProjectService`
 *     writes the same pair sequentially and this deliberately does not. §19
 *     asks for "audit log for every config change", and unlike a source (whose
 *     append-only log carries actor and reason on every row, A112) a `config`
 *     row keeps no history of its own: if the trail write is the one that
 *     fails, the setting has changed and **nothing anywhere records that it
 *     did**. `SourceAuditLog`'s decision 2 states the rule and this is the case
 *     it was written for — "two sequential writes would leave that gap open for
 *     exactly one hiccup". The cost is that this class needs a pool rather than
 *     a `Queryable`, which is why `mode()` and `setMode()` differ in what they
 *     take: reading never needs one.
 *
 *  2. **`actor` is required and has no default.** `ProjectService.setGateConfig`
 *     defaults to `'system'`, correctly — the daemon changes a project's gates
 *     during onboarding. Nothing but a person changes this setting: there is no
 *     scheduler path, no agent tool, no radar task that flips personas. A
 *     default would therefore only ever be reached by a route that forgot to
 *     pass the session, and A75.3 is precisely that failure — "a trail in which
 *     every attempt was made by `system` answers *that* something was tried and
 *     loses the question §19 keeps it for". Required makes it a compile error
 *     instead of a silent row.
 *
 *  3. **A write that changes nothing still writes a trail row.** Submitting the
 *     mode that is already set is a dashboard action, and §19 does not
 *     distinguish. Suppressing it would make the log answer "the operator never tried"
 *     for an attempt that happened — A62.2's sentence, and the one distinction
 *     an audit trail exists to make. `before` and `after` are equal in that row,
 *     which says exactly what occurred.
 *
 *  4. **A missing row is the default, not an error** (0022 decision 3). And an
 *     *unreadable* row is also the default, loudly: a value someone edited by
 *     hand into something zod refuses would otherwise take the settings page
 *     down, and the safe direction for a display setting is the one A9 already
 *     fixes — personas display-only, prompts untouched. This is the one place
 *     this project does not fail closed on an unreadable value, and it is
 *     because failing closed here means `aus`, which is a *different* setting
 *     rather than a refusal. The warning names the raw value so it can be fixed.
 *
 *  5. **The roster is a list of desks, not of profiles.** Two profiles share
 *     Milo (`db` designs a migration, `db-review` judges one — A63.3) and two
 *     share Petra (`onboarding` reads a repository, `product` reads a goal).
 *     §17.2's office view seats a person once, so the roster de-duplicates by
 *     name and desk together. The surviving entry keeps the first profile's id
 *     purely as a stable key for the page; it is not a claim that the desk *is*
 *     that profile.
 */

import {
  PERSONA_MODE_DEFAULT,
  PERSONA_MODE_KEY,
  type PersonaMode,
  type PersonaRosterEntry,
  personaModeSchema,
} from '@vorschicht/shared/personas';
import type postgres from 'postgres';
import { AGENT_PROFILES } from '../profiles/profiles.js';
import type { Queryable } from '../sql.js';

/** `audit_log.action`, following `project.gate_config_changed`. */
export const PERSONA_AUDIT_ACTION = 'config.personas_changed';

/**
 * `audit_log.subject`.
 *
 * The config key rather than a persona name: the subject of the act is the
 * setting, and a reader filtering the trail for everything that ever touched
 * this switch needs one string to filter on.
 */
export const PERSONA_AUDIT_SUBJECT = PERSONA_MODE_KEY;

export interface PersonaModeChange {
  before: PersonaMode;
  after: PersonaMode;
}

export class PersonaSettings {
  constructor(
    private readonly sql: postgres.Sql,
    private readonly onWarning: (message: string) => void = () => {},
  ) {}

  /** The mode in force, or A9's default when nothing has been set (decision 4). */
  async mode(): Promise<PersonaMode> {
    return await readMode(this.sql, this.onWarning);
  }

  /**
   * Set the mode and record who did it, atomically (decisions 1–3).
   *
   * Returns what it replaced as well as what it set, because that pair is what
   * the trail row carries and what a caller wants to report back.
   */
  async setMode(mode: PersonaMode, actor: string): Promise<PersonaModeChange> {
    if (!actor.trim()) {
      throw new PersonaSettingsError(
        'Persona-Einstellung ohne Aktor: §19 verlangt für jede Konfigurationsänderung ' +
          'eine Zeile im Prüfprotokoll, und eine ohne Urheber beantwortet die Frage ' +
          'nicht, für die das Protokoll geführt wird.',
      );
    }
    return await this.sql.begin(async (tx) => {
      const before = await readMode(tx, this.onWarning);
      await tx`
        INSERT INTO config (key, value, updated_at)
        VALUES (${PERSONA_MODE_KEY}, ${tx.json(mode)}, now())
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
      `;
      await tx`
        INSERT INTO audit_log (actor, action, subject, before, after)
        VALUES (
          ${actor}, ${PERSONA_AUDIT_ACTION}, ${PERSONA_AUDIT_SUBJECT},
          ${tx.json({ mode: before })}, ${tx.json({ mode })}
        )
      `;
      return { before, after: mode };
    });
  }

  /** The desks the office view seats, de-duplicated (decision 5). */
  roster(): PersonaRosterEntry[] {
    return personaRoster();
  }
}

export class PersonaSettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PersonaSettingsError';
  }
}

/**
 * One reader, used by both the pool path and the transaction path.
 *
 * Written once so that "what does a missing or broken row mean" has a single
 * answer — two copies is how a read inside a transaction starts disagreeing
 * with the read that renders the page.
 */
async function readMode(
  sql: Queryable,
  onWarning: (message: string) => void,
): Promise<PersonaMode> {
  const rows = await sql<{ value: unknown }[]>`
    SELECT value FROM config WHERE key = ${PERSONA_MODE_KEY}
  `;
  const row = rows[0];
  if (!row) return PERSONA_MODE_DEFAULT;
  const parsed = personaModeSchema.safeParse(row.value);
  if (parsed.success) return parsed.data;
  onWarning(
    `Persona-Einstellung in config["${PERSONA_MODE_KEY}"] ist unlesbar ` +
      `(${JSON.stringify(row.value)}); es gilt die Voreinstellung "${PERSONA_MODE_DEFAULT}".`,
  );
  return PERSONA_MODE_DEFAULT;
}

/**
 * §8's desks, each appearing once.
 *
 * Pure and exported so the page's roster can be asserted without a database —
 * the de-duplication is the part with a rule in it, and a rule only a database
 * test can reach is a rule nobody checks.
 */
export function personaRoster(): PersonaRosterEntry[] {
  const seen = new Set<string>();
  const roster: PersonaRosterEntry[] = [];
  for (const profile of Object.values(AGENT_PROFILES)) {
    const key = `${profile.persona.name} ${profile.persona.desk}`;
    if (seen.has(key)) continue;
    seen.add(key);
    roster.push({
      id: profile.id,
      department: profile.department,
      name: profile.persona.name,
      desk: profile.persona.desk,
      alternates: [...(profile.persona.alternates ?? [])],
    });
  }
  return roster;
}
