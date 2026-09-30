/**
 * Integration tests against a real Postgres.
 *
 * These prove the claims that unit tests structurally cannot: that append-only
 * is enforced *by the database*, and that the hand-written SQL and the Drizzle
 * mirror have not drifted apart. §18 calls the event log the source of truth
 * and says never delete — a test that only checks application code would leave
 * that sentence unverified.
 *
 * Run via `infra/scripts/with-test-db.sh pnpm vitest run`, which starts a
 * throwaway container and exports TEST_DATABASE_URL. Without that variable the
 * suite skips, so a bare checkout still passes `pnpm gate`.
 */

import { readFileSync } from 'node:fs';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql } from './client.js';
import { migrate } from './migrate.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Schema und Append-only-Durchsetzung', () => {
  let sql: postgres.Sql;

  beforeAll(async () => {
    sql = createSql({ url: url as string, max: 1 });
    await migrate(sql);
  });

  afterAll(async () => {
    await sql?.end();
  });

  it('applies migrations idempotently', async () => {
    const second = await migrate(sql);
    expect(second.applied).toHaveLength(0);
    expect(second.alreadyApplied).toContain('0001_foundation.sql');
  });

  it('refuses to re-apply a migration whose file changed', async () => {
    // Simulate drift by corrupting the recorded checksum, which is what a
    // silently edited migration file would look like from here.
    await sql`UPDATE _vorschicht_migrations SET checksum = 'tampered' WHERE name = '0001_foundation.sql'`;
    await expect(migrate(sql)).rejects.toThrow(/Prüfsumme/);
    // Restore so later tests see a consistent database.
    const [row] = await sql<
      { name: string }[]
    >`SELECT name FROM _vorschicht_migrations ORDER BY name LIMIT 1`;
    expect(row?.name).toBe('0001_foundation.sql');
    await sql`DELETE FROM _vorschicht_migrations WHERE name = '0001_foundation.sql'`;
    await migrate(sql);
  });

  describe.each(['event_log', 'audit_log'])('%s', (table) => {
    it('accepts inserts', async () => {
      const insert =
        table === 'event_log'
          ? sql`INSERT INTO event_log (kind, actor) VALUES ('test.inserted', 'system') RETURNING id`
          : sql`INSERT INTO audit_log (actor, action) VALUES ('system', 'test.inserted') RETURNING id`;
      const rows = await insert;
      expect(rows).toHaveLength(1);
    });

    it('rejects UPDATE even for the table owner', async () => {
      await expect(sql.unsafe(`UPDATE ${table} SET actor = 'tampered'`)).rejects.toThrow(
        /append-only/i,
      );
    });

    it('rejects DELETE even for the table owner', async () => {
      await expect(sql.unsafe(`DELETE FROM ${table}`)).rejects.toThrow(/append-only/i);
    });
  });

  /*
   * Every table the manifest declares, and all three refusals.
   *
   * This block used to be two hard-coded tables (`event_log`, `audit_log`) and
   * one trigger (`_append_only`). Twelve of the fourteen were therefore
   * unasserted, and the TRUNCATE guard was unasserted everywhere — which is the
   * `coverage_gap` the Phase-5 Betriebsprüfung filed (A100.7), naming
   * `deployment_events` as the table for which *no* test checked the promise at
   * all.
   *
   * Why the assertion moved here rather than into `gate:migrations`: that gate
   * matches regular expressions against SQL text, and `0004_truncate_guards.sql`
   * installs the TRUNCATE guards in a `DO $$ … FOREACH` loop that no pattern for
   * `CREATE TRIGGER <table>_no_truncate` can see. A text lint would have to be
   * taught every spelling anyone might use; a live database simply knows. The
   * gate keeps the checks it is good at (no `GRANT UPDATE`, no `DROP TRIGGER`,
   * no `DISABLE TRIGGER`) and this carries the one it cannot.
   *
   * The manifest is read at run time on purpose: adding a table to
   * `append-only.json` is then automatically a promise this suite enforces,
   * rather than one somebody has to remember to come here and copy.
   */
  const manifest = JSON.parse(
    readFileSync(new URL('../append-only.json', import.meta.url), 'utf8'),
  ) as { tables: string[]; guardSuffix: string };

  describe.each(manifest.tables)('%s (append-only, §5/§18)', (table) => {
    it('trägt beide Wächter — Zeilen- und Anweisungsebene', async () => {
      const rows = await sql<{ tgname: string }[]>`
        SELECT tgname FROM pg_trigger
        WHERE tgrelid = ${table}::regclass AND NOT tgisinternal
      `;
      const names = rows.map((r) => r.tgname);
      expect(names).toContain(`${table}${manifest.guardSuffix}`);
      // TRUNCATE fires no row-level trigger, so the row guard cannot see it.
      // Two triggers, because one of them is structurally blind to the other's
      // case — 0004 exists for exactly that reason.
      expect(names).toContain(`${table}_no_truncate`);
    });

    it('weist TRUNCATE ab — auch dem Eigentümer, auch auf einer leeren Tabelle', async () => {
      // TRUNCATE is the one of the three that can be asserted for every table
      // here, and that is not a convenience — it is the reason this case
      // exists. A `BEFORE TRUNCATE` trigger is statement-level, so it fires
      // whether or not the table holds rows, while a row-level `BEFORE UPDATE`
      // guard on an empty table fires *not at all* and the statement succeeds
      // silently. That is why the two behavioural cases above cover only the
      // tables an earlier case inserts into, and why twelve of these fourteen
      // are asserted by trigger presence rather than by behaviour: seeding all
      // fourteen with valid rows means teaching this suite fourteen schemas
      // and their state machines, which is a second copy of them and a second
      // thing to keep in step. Stated rather than left to be discovered.
      //
      // Asserted on the *reason*: a TRUNCATE refused by a foreign key would
      // look identical from the caller's side and would prove nothing about
      // the guard.
      await expect(sql.unsafe(`TRUNCATE ${table}`)).rejects.toThrow(/append-only/i);
    });

    it('gewährt der Laufzeitrolle weder UPDATE noch DELETE noch TRUNCATE', async () => {
      const rows = await sql<{ privilege_type: string }[]>`
        SELECT privilege_type FROM information_schema.role_table_grants
        WHERE grantee = 'vorschicht_app' AND table_name = ${table}
      `;
      const granted = rows.map((r) => r.privilege_type);
      expect(granted).toContain('SELECT');
      expect(granted).toContain('INSERT');
      expect(granted).not.toContain('UPDATE');
      expect(granted).not.toContain('DELETE');
      expect(granted).not.toContain('TRUNCATE');
    });
  });

  it('keeps the Drizzle mirror in sync with the SQL migrations', async () => {
    const expected: Record<string, string[]> = {
      projects: [
        'id',
        'slug',
        'name',
        'root_path',
        'repo_url',
        'git_access_ref',
        'gate_config',
        'deploy_config',
        'claim_granularity',
        'self_managed',
        'active',
        'created_at',
        'updated_at',
        // Appended by 0008, hence last in ordinal order — ALTER TABLE adds at
        // the end, while the Drizzle mirror groups them where they read best.
        'read_only',
        'default_branch',
      ],
      event_log: [
        'id',
        'occurred_at',
        'kind',
        'project_id',
        'task_id',
        'run_id',
        'deploy_id',
        'actor',
        'payload',
      ],
      audit_log: [
        'id',
        'occurred_at',
        'actor',
        'action',
        'subject',
        'before',
        'after',
        'ip',
        'user_agent',
      ],
    };

    for (const [table, columns] of Object.entries(expected)) {
      const rows = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ${table}
        ORDER BY ordinal_position
      `;
      expect(
        rows.map((r) => r.column_name),
        `Spalten von ${table}`,
      ).toEqual(columns);
    }
  });

  it('enforces the projects check constraints', async () => {
    await expect(
      sql`INSERT INTO projects (slug, name, root_path) VALUES ('Bad Slug', 'x', '/opt/x')`,
    ).rejects.toThrow(/projects_slug_format/);
    await expect(
      sql`INSERT INTO projects (slug, name, root_path) VALUES ('ok', 'x', 'relative/path')`,
    ).rejects.toThrow(/projects_root_path_absolute/);
  });
});
