/**
 * The adapter between §17.3's page and §11's rules, against a real database.
 *
 * `project-service.itest.ts` already proves the rule and its audit row. What is
 * *not* proven there is the translation this file adds: `setGateConfig` reports
 * a refused document by throwing, and a route needs a value. A translation that
 * lost the reasons, or swallowed the refusal into a 500, or let the actor fall
 * back to the service's `'system'` default would leave every one of those tests
 * green while the page reported nothing useful and the trail named nobody.
 *
 * So the assertions are the three things only the round trip can show: the
 * reasons survive, the audit row survives the throw *with the session as its
 * actor*, and a refusal changes nothing on disk.
 */

import { DeployRecords, ProjectService } from '@vorschicht/core';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import { releaseHistoryView } from '@vorschicht/shared/inbox';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listProjectSettings, saveProjectGates } from './projects.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Projekt-Einstellungen (§17.3)', () => {
  let database: TestDatabase;
  let sql: postgres.Sql;
  let projects: ProjectService;
  let seq = 0;

  beforeAll(async () => {
    database = await createTestDatabase('server_projects');
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
      slug: `seite-${seq}`,
      name: `Seite ${seq}`,
      rootPath: `/tmp/seite-${seq}`,
    });
  }

  async function auditActions(slug: string) {
    return sql<Array<{ action: string; actor: string }>>`
      SELECT action, actor FROM audit_log WHERE subject = ${slug} ORDER BY id
    `;
  }

  it('listet ein Projekt mit seiner aufgelösten Gate-Menge', async () => {
    const created = await project();
    await projects.setGateConfig(created.id, {
      gates: { sast: true },
      commands: { sast: 'pnpm sast' },
    });

    const views = await listProjectSettings({ projects });
    const view = views.find((entry) => entry.slug === created.slug);

    expect(view).toBeDefined();
    // The locked six come from the catalogue, not from the document — so the
    // resolved set is longer than what was ticked, which is the difference the
    // page has to be able to show.
    expect(view?.gateConfig.gates).toEqual({ sast: true });
    expect(view?.resolvedGateIds).toEqual([
      'review',
      'typecheck',
      'lint',
      'test',
      'secrets',
      'build',
      'sast',
    ]);
    // §19, A20: a pointer into the secret regime has no business on a page.
    expect(Object.keys(view ?? {})).not.toContain('gitAccessRef');
  });

  it('speichert eine gültige Konfiguration und nennt die Sitzung als Urheber', async () => {
    const created = await project();
    const result = await saveProjectGates(
      { projects },
      created.id,
      { gates: { changelog: true } },
      'dashboard:operator',
    );

    expect(result.ok).toBe(true);
    const stored = await projects.require(created.id);
    expect(projects.gateConfigOf(stored).gates).toEqual({ changelog: true });
    expect(await auditActions(created.slug)).toEqual([
      { action: 'project.created', actor: 'system' },
      { action: 'project.gate_config_changed', actor: 'dashboard:operator' },
    ]);
  });

  // The exit gate, from the API side: the attempt is refused *and* recorded.
  it('lehnt das Abwählen eines gesperrten Gates ab, mit allen Gründen', async () => {
    const created = await project();
    const result = await saveProjectGates(
      { projects },
      created.id,
      { gates: { test: false, build: false } },
      'dashboard:operator',
    );

    expect(result).toMatchObject({ ok: false, reason: 'invalid' });
    const errors = result.ok === false && result.reason === 'invalid' ? result.errors : [];
    // Both, not just the first: the form has to be able to show them together.
    expect(errors).toHaveLength(2);
    expect(errors.join('\n')).toContain('Tests');
    expect(errors.join('\n')).toContain('Build');
    expect(errors.join('\n')).toContain('gesperrten Grundgerüst');
  });

  it('hinterlässt die Ablehnung im Prüfpfad und die Konfiguration unverändert', async () => {
    const created = await project();
    await saveProjectGates(
      { projects },
      created.id,
      { gates: { lint: true } },
      'dashboard:operator',
    );
    await saveProjectGates(
      { projects },
      created.id,
      { gates: { lint: false } },
      'dashboard:operator',
    );

    expect(await auditActions(created.slug)).toEqual([
      { action: 'project.created', actor: 'system' },
      { action: 'project.gate_config_changed', actor: 'dashboard:operator' },
      // A refusal that leaves no row is indistinguishable from no attempt.
      { action: 'project.gate_config_rejected', actor: 'dashboard:operator' },
    ]);
    const stored = await projects.require(created.id);
    expect(projects.gateConfigOf(stored).gates).toEqual({ lint: true });
  });

  /**
   * §12: "Release history … visible per project in the dashboard."
   *
   * Against the real `deployments` view rather than a stand-in, because the
   * mapping is only worth anything if the columns behind it are the ones the
   * engine writes — `duration_ms` arrives as a string from the driver, and
   * `rolled_back_to` is derived in SQL from a payload key. A fixture built from
   * a hand-written record would have proved that the mapper maps.
   */
  describe('§12 — Release-Historie auf der Projektseite', () => {
    async function deploy(
      records: DeployRecords,
      projectId: string,
      input: { id: string; sha: string },
    ) {
      await records.start({
        deploymentId: input.id,
        projectId,
        taskId: null,
        sha: input.sha,
        method: 'compose',
        actor: 'orchestrator',
      });
      return records;
    }

    it('liefert die Releases eines Projekts mit dem Rollback-Ziel benannt', async () => {
      const created = await project();
      const records = new DeployRecords(sql);
      const good = crypto.randomUUID();
      const bad = crypto.randomUUID();

      await deploy(records, created.id, { id: good, sha: 'aaaaaaaaaaaa' });
      await records.append(good, 'swapped', 'orchestrator', { artifact: 'image:alt' });
      await records.append(good, 'succeeded', 'orchestrator', { artifact: 'image:alt' });

      await deploy(records, created.id, { id: bad, sha: 'bbbbbbbbbbbb' });
      await records.append(bad, 'swapped', 'orchestrator', { artifact: 'image:neu' });
      await records.append(bad, 'health_checked', 'orchestrator', {
        ok: false,
        detail: 'HTTP 500',
      });
      await records.append(bad, 'rolled_back', 'orchestrator', {
        rolledBackTo: good,
        artifact: 'image:alt',
        problem: 'HTTP 500',
      });

      const views = await listProjectSettings({ projects, deployments: records });
      const view = views.find((entry) => entry.slug === created.slug);

      expect(view?.releaseSource).toBe('records');
      // Parsed with the same schema the page parses with: a payload the browser
      // would refuse must not pass here either, and the producer being typed
      // from it is not the same as the values matching it (A81).
      const parsed = releaseHistoryView.safeParse(view?.releases);
      expect(parsed.success).toBe(true);

      const [newest, previous] = view?.releases ?? [];
      expect(newest?.id).toBe(bad);
      expect(newest?.outcome).toBe('rolled_back');
      expect(newest?.problem).toBe('HTTP 500');
      // The row somebody actually goes looking for: not the id, the release.
      expect(newest?.rolledBackTo).toEqual({
        deploymentId: good,
        sha: 'aaaaaaaaaaaa',
        artifact: 'image:alt',
      });
      expect(previous?.id).toBe(good);
      expect(previous?.outcome).toBe('succeeded');
      expect(typeof previous?.durationMs).toBe('number');
    });

    it('sagt es, wenn dieser Server gar keine Deployments liest', async () => {
      const created = await project();
      const views = await listProjectSettings({ projects });
      const view = views.find((entry) => entry.slug === created.slug);

      // The whole point of the field: without it this is indistinguishable from
      // a project that has never deployed, and the page would report an
      // all-clear over a table it never queried.
      expect(view?.releases).toEqual([]);
      expect(view?.releaseSource).toBe('unwired');
    });

    it('antwortet nach dem Speichern mit derselben Gestalt wie die Liste', async () => {
      const created = await project();
      const records = new DeployRecords(sql);
      const result = await saveProjectGates(
        { projects, deployments: records },
        created.id,
        { gates: { changelog: true } },
        'dashboard:operator',
      );

      // Two responses of one document that disagree about a field is the defect
      // `@vorschicht/shared/inbox` was written because of — here it would be a
      // save that reported `unwired` on a server that reads deployments.
      expect(result.ok && result.project.releaseSource).toBe('records');
    });
  });

  it('unterscheidet ein unbekanntes Projekt von einer abgelehnten Konfiguration', async () => {
    const result = await saveProjectGates(
      { projects },
      '00000000-0000-0000-0000-000000000000',
      { gates: {} },
      'dashboard:operator',
    );
    expect(result).toEqual({ ok: false, reason: 'unknown' });
  });
});
