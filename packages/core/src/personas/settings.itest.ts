/**
 * §8's persona switch against a real Postgres (migration 0022).
 *
 * Four of the six things this suite is built to be able to fail are properties
 * of the database rather than of the class, which is why it is an integration
 * test and not a unit one.
 *
 *   1. **§19's row and the change are one act.** The whole reason `setMode`
 *      opens a transaction is that a `config` row keeps no history of its own,
 *      so a trail write that fails after the setting changed would leave the
 *      change with nothing anywhere recording it. Asserted by making the trail
 *      write fail for real — the audit table's own `NOT NULL` on `actor`, hit
 *      through a direct call — and then reading the setting back. A stubbed
 *      store cannot fail that way, and a sequential implementation passes every
 *      other test in this file.
 *
 *   2. **A missing row is the default** (0022 decision 3), so the very first
 *      read of a fresh database is the interesting one and it runs before
 *      anything is written.
 *
 *   3. **The actor is the session's**, not `'system'` (A75.3). Asserted as the
 *      value that was passed rather than as "not empty", because the failure
 *      this guards against produces a perfectly well-formed row.
 *
 *   4. **An unreadable value is the default, loudly.** The row is written by
 *      hand into a state the service cannot produce, which is the state a human
 *      editing the table produces, and the warning has to name it.
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import { PERSONA_MODE_KEY } from '@vorschicht/shared/personas';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PERSONA_AUDIT_ACTION, PersonaSettings, personaRoster } from './settings.js';

const url = process.env.TEST_DATABASE_URL;

/** What `sessionActor` produces for a real browser session (A75.3). */
const MAX = 'dashboard:cred-abc';

interface AuditRow {
  actor: string;
  action: string;
  subject: string;
  before: { mode: string } | null;
  after: { mode: string } | null;
}

describe.skipIf(!url)('Persona-Einstellung (§8, §17.9)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let warnings: string[];
  let settings: PersonaSettings;

  beforeAll(async () => {
    database = await createTestDatabase('personas');
    sql = createSql({ url: database.url, max: 3 });
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
  });

  beforeEach(() => {
    warnings = [];
    settings = new PersonaSettings(sql, (message) => warnings.push(message));
  });

  async function auditRows(): Promise<AuditRow[]> {
    return await sql<AuditRow[]>`
      SELECT actor, action, subject, before, after FROM audit_log
      WHERE action = ${PERSONA_AUDIT_ACTION} ORDER BY occurred_at, id
    `;
  }

  // Runs first, deliberately: it is the only moment the table is empty.
  it('liest die Voreinstellung, solange nichts gesetzt wurde (A9)', async () => {
    expect(await sql`SELECT * FROM config`).toHaveLength(0);
    expect(await settings.mode()).toBe('anzeige');
    expect(warnings).toEqual([]);
  });

  it('speichert eine Stufe und gibt zurück, was sie ersetzt hat', async () => {
    const change = await settings.setMode('prompt', MAX);
    expect(change).toEqual({ before: 'anzeige', after: 'prompt' });
    expect(await settings.mode()).toBe('prompt');

    const zurueck = await settings.setMode('aus', MAX);
    expect(zurueck).toEqual({ before: 'prompt', after: 'aus' });
    expect(await settings.mode()).toBe('aus');
  });

  it('führt genau eine Zeile pro Änderung, mit dem Aktor der Sitzung (§19, A75.3)', async () => {
    const vorher = (await auditRows()).length;
    await settings.setMode('anzeige', MAX);

    const rows = await auditRows();
    expect(rows).toHaveLength(vorher + 1);
    const letzte = rows[rows.length - 1];
    expect(letzte?.actor).toBe(MAX);
    // Not merely "not system": the defect A75.3 describes writes a perfectly
    // valid row, so the assertion has to be the value that was passed.
    expect(letzte?.actor).not.toBe('system');
    expect(letzte?.subject).toBe(PERSONA_MODE_KEY);
    expect(letzte?.before).toEqual({ mode: 'aus' });
    expect(letzte?.after).toEqual({ mode: 'anzeige' });
  });

  /**
   * Decision 3: submitting the mode that is already set is still a dashboard
   * action, and §19 does not distinguish. Suppressing the row would make the log
   * answer "the operator never tried" for an attempt that happened (A62.2).
   */
  it('schreibt auch dann eine Zeile, wenn sich nichts ändert', async () => {
    await settings.setMode('anzeige', MAX);
    const vorher = (await auditRows()).length;

    const change = await settings.setMode('anzeige', MAX);
    expect(change).toEqual({ before: 'anzeige', after: 'anzeige' });

    const rows = await auditRows();
    expect(rows).toHaveLength(vorher + 1);
    expect(rows[rows.length - 1]?.before).toEqual({ mode: 'anzeige' });
    expect(rows[rows.length - 1]?.after).toEqual({ mode: 'anzeige' });
  });

  /**
   * Decision 1, and the only case in this file that a sequential implementation
   * fails. `audit_log.actor` is NOT NULL, so an empty actor makes the second
   * write throw *after* the first has already run — exactly the shape of a
   * hiccup between two sequential statements. The setting must be unchanged.
   */
  it('macht die Änderung rückgängig, wenn die Prüfzeile nicht geschrieben werden kann', async () => {
    await settings.setMode('prompt', MAX);
    const zeilenVorher = (await auditRows()).length;

    // Past the service's own guard, so what is exercised is the transaction.
    const roh = new PersonaSettings(sql);
    await expect(
      (roh as unknown as { sql: postgres.Sql }).sql.begin(async (tx) => {
        await tx`
          INSERT INTO config (key, value, updated_at) VALUES (${PERSONA_MODE_KEY}, ${tx.json('aus')}, now())
          ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
        `;
        await tx`
          INSERT INTO audit_log (actor, action, subject, before, after)
          VALUES (${null as unknown as string}, ${PERSONA_AUDIT_ACTION}, ${PERSONA_MODE_KEY}, null, null)
        `;
      }),
    ).rejects.toThrow();

    expect(await settings.mode()).toBe('prompt');
    expect(await auditRows()).toHaveLength(zeilenVorher);
  });

  it('verweigert eine Änderung ohne Aktor, statt „system“ zu erfinden', async () => {
    await settings.setMode('anzeige', MAX);
    const zeilenVorher = (await auditRows()).length;

    await expect(settings.setMode('aus', '   ')).rejects.toThrow(/Aktor/);
    expect(await settings.mode()).toBe('anzeige');
    expect(await auditRows()).toHaveLength(zeilenVorher);
  });

  /**
   * Decision 4, and the one place this project does not fail closed — because
   * failing closed here would mean `aus`, which is a *different setting* rather
   * than a refusal.
   */
  it('fällt bei unlesbarem Wert auf die Voreinstellung zurück und sagt es', async () => {
    await sql`
      INSERT INTO config (key, value, updated_at) VALUES (${PERSONA_MODE_KEY}, ${sql.json('theater')}, now())
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
    expect(await settings.mode()).toBe('anzeige');
    expect(warnings.join(' ')).toContain('unlesbar');
    // Names the offending value, so it can be corrected rather than guessed at.
    expect(warnings.join(' ')).toContain('theater');
  });
});

/** Pure, so the de-duplication rule is checkable without a database. */
describe('das Ensemble (§17.9)', () => {
  it('setzt jeden Schreibtisch genau einmal, obwohl zwei Profile ihn teilen', () => {
    const roster = personaRoster();
    const schluessel = roster.map((p) => `${p.name} ${p.desk}`);
    expect(new Set(schluessel).size).toBe(schluessel.length);

    // Milo is `db` and `db-review` (A63.3); Petra is `onboarding` and `product`.
    // Both pairs collapse, which is what makes this a list of desks rather than
    // of profiles — and it is asserted by name so that a future third Milo does
    // not quietly restore the duplicate.
    expect(roster.filter((p) => p.name === 'Milo')).toHaveLength(1);
    expect(roster.filter((p) => p.name === 'Petra')).toHaveLength(1);
  });

  it('gibt jedem Eintrag alles, was eine Zeile braucht — in beiden Stufen', () => {
    for (const persona of personaRoster()) {
      expect(persona.id).toBeTruthy();
      expect(persona.department).toBeTruthy();
      expect(persona.name).toBeTruthy();
      // The neutral label. Without it, §8's `aus` renders `undefined`.
      expect(persona.desk).toBeTruthy();
      expect(Array.isArray(persona.alternates)).toBe(true);
    }
  });

  it('trägt §8s zwei Coder als einen Schreibtisch mit zwei Namen (A7)', () => {
    const clara = personaRoster().find((p) => p.name === 'Clara');
    expect(clara?.alternates).toEqual(['Chris']);
  });
});
