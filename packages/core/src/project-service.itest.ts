/**
 * The API half of §11's "baseline gates are not un-checkable".
 *
 * The Phase 3 exit gate reads: *baseline gates verified non-removable via UI and
 * API (attempt is refused + audit-logged)*. Both halves are asserted here, and
 * the second is the one that needs a real database: a refusal that leaves no
 * row behind is indistinguishable from an attempt that never happened, which is
 * exactly the distinction §19's audit trail exists to make and §8.2's seventh
 * domain later asks about.
 *
 * Against a real Postgres rather than a stub because the guarantee is only worth
 * anything if it survives the round trip — the column is `jsonb`, and a document
 * that validates in memory and comes back a different shape would pass a stubbed
 * test and fail in production.
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import { GateConfigError, resolveGates } from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProjectService } from './project-service.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('ProjectService — Gate-Konfiguration (§11)', () => {
  let database: TestDatabase;
  let sql: postgres.Sql;
  let projects: ProjectService;
  let seq = 0;

  beforeAll(async () => {
    database = await createTestDatabase('project_service');
    sql = createSql({ url: database.url, max: 4 });
    projects = new ProjectService(sql);
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await database?.drop();
  });

  async function project() {
    seq += 1;
    return projects.create({
      slug: `gates-${seq}`,
      name: `Gates ${seq}`,
      rootPath: `/tmp/gates-${seq}`,
    });
  }

  async function auditRows(slug: string) {
    return sql<Array<{ action: string; after: Record<string, unknown> }>>`
      SELECT action, after FROM audit_log WHERE subject = ${slug} ORDER BY id
    `;
  }

  it('nimmt eine gültige Konfiguration an und schreibt sie in den Prüfpfad', async () => {
    const created = await project();
    const updated = await projects.setGateConfig(
      created.id,
      {
        gates: { changelog: true },
        commands: { test: 'pnpm test', build: 'pnpm build' },
        tools: ['Bash(pnpm test:*)'],
      },
      'max',
    );

    expect(updated.gateConfig).toEqual({
      gates: { changelog: true },
      commands: { test: 'pnpm test', build: 'pnpm build' },
      tools: ['Bash(pnpm test:*)'],
      // Normalised in, even when the submission left it out: an absent list
      // means `migrationGlobs` falls back to the broad defaults (A63), and the
      // stored document should say what it means rather than what was typed.
      migrationPaths: [],
    });
    // Survives the round trip through jsonb, which a stub would not prove.
    const reread = await projects.require(created.id);
    expect(projects.gateConfigOf(reread).gates.changelog).toBe(true);
    expect(resolveGates(projects.gateConfigOf(reread)).map((gate) => gate.id)).toContain(
      'changelog',
    );

    const rows = await auditRows(created.slug);
    expect(rows.map((row) => row.action)).toEqual([
      'project.created',
      'project.gate_config_changed',
    ]);
  });

  it('weist das Abwählen eines gesperrten Gates zurück — und hält den Versuch fest', async () => {
    const created = await project();
    await expect(
      projects.setGateConfig(created.id, { gates: { test: false } }, 'max'),
    ).rejects.toBeInstanceOf(GateConfigError);

    // Nothing changed …
    const reread = await projects.require(created.id);
    expect(reread.gateConfig).toEqual({});
    expect(resolveGates(projects.gateConfigOf(reread)).map((gate) => gate.id)).toContain('test');

    // … and the attempt is on the record, with its reason and its actor.
    const rows = await auditRows(created.slug);
    expect(rows.map((row) => row.action)).toEqual([
      'project.created',
      'project.gate_config_rejected',
    ]);
    const rejected = rows[1]?.after as { gateConfig: { errors: string[]; attempted: unknown } };
    expect(rejected.gateConfig.errors.join(' ')).toContain('§11');
    expect(rejected.gateConfig.attempted).toEqual({ gates: { test: false } });
  });

  it('nennt in einer Ablehnung jeden Grund, nicht nur den ersten', async () => {
    const created = await project();
    try {
      // Drei Gründe aus zwei Klassen: zwei abgehakte gesperrte Gates und ein
      // angehaktes optionales ohne Befehl. Bis A115 war der dritte Grund
      // `legal: true` — „noch nicht verfügbar" —, und mit Lena ist diese Klasse
      // weg; der Fall prüft aber die Vollzähligkeit der Begründung, nicht eine
      // bestimmte Klasse, also wird der dritte Grund ersetzt statt gestrichen.
      await projects.setGateConfig(created.id, {
        gates: { test: false, build: false, e2e: true },
      });
      expect.unreachable('die Konfiguration hätte abgelehnt werden müssen');
    } catch (error) {
      expect((error as GateConfigError).errors).toHaveLength(3);
    }
  });

  it('weist ein angehaktes Gate ohne Befehl zurück', async () => {
    const created = await project();
    await expect(projects.setGateConfig(created.id, { gates: { e2e: true } })).rejects.toThrow(
      /kein Befehl hinterlegt/,
    );
  });

  it('weist einen Befehl mit Shell-Sonderzeichen zurück, bevor er je läuft', async () => {
    const created = await project();
    await expect(
      projects.setGateConfig(created.id, { commands: { test: 'pnpm test && rm -rf /' } }),
    ).rejects.toThrow(/§19/);
  });

  it('liest eine von Hand verbogene Zeile nachsichtig und lässt die sechs trotzdem laufen', async () => {
    const created = await project();
    // Past the service, the way a migration or a hand-edited row would arrive.
    await sql`
      UPDATE projects
      SET gate_config = ${sql.json({ gates: { test: false, erfunden: true }, commands: 'nein' })}
      WHERE id = ${created.id}
    `;
    const reread = await projects.require(created.id);
    const config = projects.gateConfigOf(reread);
    expect(resolveGates(config).map((gate) => gate.id)).toContain('test');
    expect(config.commands).toEqual({});
  });
});
