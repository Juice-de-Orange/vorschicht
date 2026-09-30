/**
 * The radar end to end, against a real Postgres — and A10 is tested by what does
 * **not** happen.
 *
 * §22's Phase 6 exit gates put two sentences on this scan:
 *
 *   * "a seeded 'billing change' fixture produces a P0 inbox item; a seeded CLI
 *     release lands as a normal radar task" — the whole of gate 3;
 *   * "patch update becomes an auto-task …; a major update lands as an MC inbox
 *     item" — half of gate 2, the half that does not need a network.
 *
 * Both sentences are two claims each, and the second claim of each is an
 * absence: a patch must produce a task **and no card**, a major a card **and no
 * task**. A suite asserting only the presences would pass against an
 * implementation that did both for everything — which is an unattended merge of
 * a breaking change plus an inbox card for every patch, i.e. exactly the two
 * failures A10 exists to prevent. So every policy case here asserts both, and
 * the mutations recorded in the commit message flip the absences specifically.
 *
 * Everything below the feeds is real: the escalation service (so §15's option
 * schema really has to accept the card), the task service (so §9's lifecycle
 * really has to accept the row), the project service, the event log. Only the
 * outside world is a fixture, which is what §22 asks for with the word "seeded".
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EscalationService } from '../../escalation-service.js';
import { EventLog } from '../../event-log.js';
import { ProjectService } from '../../project-service.js';
import { TaskService } from '../../task-service.js';
import { RADAR_APPROVE_INDEX } from './cards.js';
import { FixtureRadarFeeds, type RadarFeeds } from './feeds.js';
import { type RadarOutcome, RadarScan } from './scan.js';

const url = process.env.TEST_DATABASE_URL;

/** §6.0's announcement, in the wording that section quotes. */
const BILLING_FIXTURE =
  'Starting 1 September, programmatic usage through claude -p will be billed from a ' +
  'separate usage credit instead of counting against your subscription limits.';

const PINNED_CLI = '2.1.220';

describe.skipIf(!url)('Radar (§6.0, A27, A10)', () => {
  let caseNumber = 0;
  let database: TestDatabase;
  let sql: postgres.Sql;
  let eventLog: EventLog;
  let escalations: EscalationService;
  let tasks: TaskService;
  let projects: ProjectService;
  let projectId: string;
  let projectRoot: string;

  /**
   * A fresh database per **case**, not per file — `escalation-mail.itest.ts`'s
   * arrangement, adopted here for the same reason and after the same failure.
   *
   * Two of this radar's four dedup namespaces are global: a billing signature is
   * a hash of a sentence and a CLI key is a version, neither of which belongs to
   * a project. So one case's `reported` decides the next one's, and a suite
   * written that way passes or fails by declaration order. Clearing between
   * cases is not available: `event_log` is append-only and its guard refuses
   * DELETE and TRUNCATE — which is how this arrangement was found, since the
   * first draft did try — and disabling the trigger would be a harness reaching
   * around the guarantee it is supposed to run under.
   */
  beforeEach(async () => {
    caseNumber += 1;
    database = await createTestDatabase(`radar_${caseNumber}`);
    sql = createSql({ url: database.url, max: 3 });
    eventLog = new EventLog(sql);
    escalations = new EscalationService({ sql, eventLog });
    tasks = new TaskService({ sql, eventLog });
    projects = new ProjectService(sql);
    projectRoot = await mkdtemp(join(tmpdir(), 'radar-project-'));
    projectId = (
      await projects.create({ slug: 'sandkasten', name: 'Sandkasten', rootPath: projectRoot })
    ).id;
  });

  afterEach(async () => {
    await sql?.end();
    await database?.drop();
  });

  /**
   * A second project carrying §12's `selfManaged` flag — where A27's CLI task
   * belongs, since the pin lives in this repository's own `infra/`.
   *
   * Created rather than flipped after the fact: `ProjectService` has a setter
   * for `read_only` (A85 needed one) and none for `selfManaged`, and adding one
   * for a test would be a production surface nothing else asks for.
   */
  async function selfManagedProject(readOnly = false): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'radar-self-'));
    return (
      await projects.create({
        slug: 'vorschicht',
        name: 'Vorschicht',
        rootPath: root,
        selfManaged: true,
        readOnly,
      })
    ).id;
  }

  async function manifest(dependencies: Record<string, string>): Promise<void> {
    await writeFile(
      join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'sandkasten', dependencies }),
      'utf8',
    );
  }

  function scan(feeds: RadarFeeds): RadarScan {
    return new RadarScan({
      sql,
      eventLog,
      feeds,
      escalations,
      tasks,
      projects,
      pinnedCliVersion: PINNED_CLI,
    });
  }

  async function cards(): Promise<Array<{ source: string; urgency: string; question: string }>> {
    return sql`SELECT source, urgency, question FROM escalations ORDER BY number ASC`;
  }

  async function createdTasks(): Promise<Array<{ title: string; priority: string }>> {
    return sql`SELECT title, priority FROM tasks ORDER BY created_at ASC`;
  }

  // ------------------------------------------------------------- gate 3 -----

  describe('§6.0s Abrechnungs-Radar', () => {
    it('macht aus einer gesäten Abrechnungsänderung eine P0-Karte', async () => {
      const outcome = await scan(new FixtureRadarFeeds({ billing: BILLING_FIXTURE })).run();

      expect(outcome.cards).toHaveLength(1);
      const [card] = await cards();
      expect(card?.source).toBe('billing_change');
      expect(card?.urgency).toBe('P0');
      // And no task: §6.0's answer to a billing change is the operator's decision, not
      // work the studio schedules for itself.
      expect(await createdTasks()).toEqual([]);
    });

    it('meldet dieselbe Fundstelle beim zweiten Lauf nicht noch einmal', async () => {
      // Decision 4's arithmetic: without the memory this is one P0 every six
      // hours, forever, for one page that has not changed.
      const feeds = new FixtureRadarFeeds({ billing: BILLING_FIXTURE });
      await scan(feeds).run();
      const second = await scan(feeds).run();

      expect(second.cards).toEqual([]);
      expect(await cards()).toHaveLength(1);
    });

    it('sagt ausdrücklich, dass der Kanal nur eine Fixture war', async () => {
      // The sentence the brief for this change insisted belongs in the scan's
      // own output rather than only in a test: a scan that cannot say whether it
      // really looked is a scan whose silence means nothing.
      const outcome = await scan(new FixtureRadarFeeds({ billing: BILLING_FIXTURE })).run();
      expect(outcome.limits.join('\n')).toMatch(/nicht wirklich abgefragt/);
    });

    it('meldet einen gar nicht konfigurierten Kanal als ungeprüft, nicht als sauber', async () => {
      // A104.4's measured lesson, one subsystem over: "we could not look" and
      // "there is nothing" must not be the same answer. This is the *ordinary*
      // state of a fresh installation, since neither Anthropic channel has a
      // default URL.
      const outcome = await scan(new FixtureRadarFeeds({})).run();
      expect(outcome.cards).toEqual([]);
      expect(outcome.limits.join('\n')).toMatch(/kein Kanal konfiguriert/);
      expect(outcome.limits.join('\n')).toMatch(/keine Entwarnung/);
    });

    it('schweigt zu einer Dokumentationsseite', async () => {
      const outcome = await scan(
        new FixtureRadarFeeds({ billing: 'Claude Code supports headless mode via claude -p.' }),
      ).run();
      expect(outcome.cards).toEqual([]);
      expect(await cards()).toEqual([]);
    });
  });

  describe('A27s CLI-Radar', () => {
    it('macht aus einem gesäten Release eine gewöhnliche Aufgabe — und keine Karte', async () => {
      // The second half of gate 3's sentence, and the absence is the half that
      // matters: A27 says CLI updates arrive "as radar tasks through the normal
      // gates", so a card here would be the wrong mechanism entirely.
      await selfManagedProject();
      const outcome = await scan(new FixtureRadarFeeds({ cli: '{"latest":"2.1.230"}' })).run();

      expect(outcome.tasks).toHaveLength(1);
      expect(outcome.cards).toEqual([]);
      const [task] = await createdTasks();
      expect(task?.title).toContain('2.1.220 → 2.1.230');
      expect(task?.priority).toBe('P2');
      expect(await cards()).toEqual([]);
    });

    it('legt dieselbe Aufgabe kein zweites Mal an', async () => {
      await selfManagedProject();
      const feeds = new FixtureRadarFeeds({ cli: '2.1.230' });
      await scan(feeds).run();
      await scan(feeds).run();
      expect(await createdTasks()).toHaveLength(1);
    });

    it('schweigt, wenn der Kanal die festgenagelte Version nennt', async () => {
      await selfManagedProject();
      const outcome = await scan(new FixtureRadarFeeds({ cli: PINNED_CLI })).run();
      expect(outcome.tasks).toEqual([]);
    });

    it('meldet es als Prüfgrenze, wenn es kein selbstverwaltetes Projekt gibt', async () => {
      // Silence here would look exactly like "no new version", which is the one
      // thing it must not look like.
      const outcome = await scan(new FixtureRadarFeeds({ cli: '2.1.230' })).run();
      expect(outcome.tasks).toEqual([]);
      expect(outcome.limits.join('\n')).toMatch(/kein selbstverwaltetes Projekt/);
    });

    it('legt die Aufgabe auch in einem schreibgeschützten Projekt an und sagt, dass sie wartet', async () => {
      // Decision 6: A85 has Vorschicht's own project read-only, and the
      // scheduler skips such projects. Suppressing the task instead would mean
      // the studio notices a CLI release and records nothing actionable.
      await selfManagedProject(true);
      const outcome = await scan(new FixtureRadarFeeds({ cli: '2.1.230' })).run();

      expect(outcome.tasks).toHaveLength(1);
      expect(outcome.limits.join('\n')).toMatch(/A85 schreibgeschützt/);
    });
  });

  // ------------------------------------------------------- gate 2, halb -----

  describe('A10s Abhängigkeits-Politik', () => {
    it('Patch: genau eine Aufgabe und keine Karte', async () => {
      await manifest({ links: '1.0.0', rechts: '2.3.0' });
      const outcome = await scan(
        new FixtureRadarFeeds({ latest: { links: '1.0.1', rechts: '2.4.0' } }),
      ).run();

      // One task for both — A10 says "an auto-task", and forty packages would
      // otherwise be forty branches claiming the same manifest (§10).
      expect(outcome.tasks).toHaveLength(1);
      const [task] = await createdTasks();
      expect(task?.title).toContain('2 Paket(e)');
      expect(task?.priority).toBe('P3');
      // The absence. This is the assertion mutation (i) has to turn red.
      expect(outcome.cards).toEqual([]);
      expect(await cards()).toEqual([]);
    });

    it('Hauptversion: genau eine Karte und keine Aufgabe', async () => {
      await manifest({ links: '1.0.0' });
      const outcome = await scan(new FixtureRadarFeeds({ latest: { links: '2.0.0' } })).run();

      expect(outcome.cards).toHaveLength(1);
      const [card] = await cards();
      expect(card?.source).toBe('dependency_major');
      expect(card?.urgency).toBe('P2');
      expect(card?.question).toContain('1.0.0 → 2.0.0');
      // The absence. This is the assertion mutation (ii) has to turn red.
      expect(outcome.tasks).toEqual([]);
      expect(await createdTasks()).toEqual([]);
    });

    it('Sicherheitshinweis: P0, eigene Quelle, und das Paket verlässt den Versions-Zweig', async () => {
      // A10 makes an advisory P0 whatever the version step is, and A91's rule
      // gives it its own source: §16 counts by source, so a CVE filed under
      // "major update" is a metric that quietly means something else.
      await manifest({ links: '1.0.0' });
      const outcome = await scan(
        new FixtureRadarFeeds({
          latest: { links: '1.0.1' },
          advisories: [
            {
              id: 'GHSA-1',
              name: 'links',
              version: '1.0.0',
              severity: 'critical',
              title: 'Beispiel',
              url: null,
            },
          ],
        }),
      ).run();

      const raised = await cards();
      expect(raised).toHaveLength(1);
      expect(raised[0]?.source).toBe('dependency_advisory');
      expect(raised[0]?.urgency).toBe('P0');
      // A patch that also fixes a CVE must not be filed as routine work and
      // merged quietly at some point in the next few days.
      expect(outcome.tasks).toEqual([]);
    });

    it('deckelt die nicht-dringenden Karten und verschiebt den Rest sichtbar', async () => {
      // Decision 5: twenty cards at once is an inbox nobody reads. The deferred
      // ones are not marked reported, so the next run raises them.
      await manifest(Object.fromEntries('abcde'.split('').map((name) => [name, '1.0.0'])));
      const feeds = new FixtureRadarFeeds({
        latest: Object.fromEntries('abcde'.split('').map((name) => [name, '2.0.0'])),
      });

      const first = await scan(feeds).run();
      expect(first.cards).toHaveLength(3);
      expect(first.limits.join('\n')).toMatch(/2 weitere Hauptversion/);

      const second = await scan(feeds).run();
      expect(second.cards).toHaveLength(2);
      expect(await cards()).toHaveLength(5);
    });

    it('deckelt eine dringende Karte nicht', async () => {
      // The other half of decision 5, and the one worth proving: an advisory is
      // never traded away to keep an inbox tidy.
      await manifest(Object.fromEntries('abcde'.split('').map((name) => [name, '1.0.0'])));
      const outcome = await scan(
        new FixtureRadarFeeds({
          advisories: 'abcde'.split('').map((name) => ({
            id: `GHSA-${name}`,
            name,
            version: '1.0.0',
            severity: 'high' as const,
            title: 'Beispiel',
            url: null,
          })),
        }),
      ).run();

      expect(outcome.cards).toHaveLength(5);
      expect((await cards()).every((card) => card.urgency === 'P0')).toBe(true);
    });

    it('meldet ein Projekt ohne Manifest als ungeprüft', async () => {
      const outcome = await scan(new FixtureRadarFeeds({ latest: { links: '9.9.9' } })).run();
      expect(outcome.limits.join('\n')).toMatch(/weder ein.*package\.json/s);
    });

    it('meldet einen stummen Kanal als ungeprüft, nicht als «alles aktuell»', async () => {
      await manifest({ links: '1.0.0' });
      const outcome = await scan(new FixtureRadarFeeds({})).run();
      expect(outcome.cards).toEqual([]);
      expect(outcome.tasks).toEqual([]);
      expect(outcome.limits.join('\n')).toMatch(/nicht geantwortet|nicht wirklich abgefragt/);
    });
  });

  // --------------------------------------------------- Antworten (A93.5) ----

  describe('was mit einer beantworteten Karte geschieht', () => {
    async function raiseMajorCard(): Promise<number> {
      await manifest({ links: '1.0.0' });
      const outcome = await scan(new FixtureRadarFeeds({ latest: { links: '2.0.0' } })).run();
      const number = outcome.cards[0]?.number;
      if (number === undefined) throw new Error('Die Karte fehlt — Fixture kaputt.');
      return number;
    }

    async function answer(number: number, optionIndex: number | null, freeText?: string) {
      const record = await escalations.byNumber(number);
      if (!record) throw new Error(`Entscheidung #${number} fehlt`);
      await escalations.answer(record.id, {
        optionIndex,
        freeText: freeText ?? null,
        actor: 'max',
      });
    }

    it('legt die Aufgabe an, wenn der Betreiber die handelnde Option wählt', async () => {
      const number = await raiseMajorCard();
      await answer(number, RADAR_APPROVE_INDEX);

      const outcome = await scan(new FixtureRadarFeeds({})).run();

      expect(outcome.applied).toEqual([
        expect.objectContaining({ escalationNumber: number, outcome: 'aufgabe_angelegt' }),
      ]);
      const created = await createdTasks();
      expect(created).toHaveLength(1);
      expect(created[0]?.title).toBe('links 1.0.0 → 2.0.0 aktualisieren');
    });

    it('legt nichts an, wenn der Betreiber die ablehnende Option wählt', async () => {
      // A93.5 and A97 are this defect found twice, both times in a deploy path:
      // the code read *that* the card was answered rather than *what* was
      // chosen, so the option written to say no released the act.
      const number = await raiseMajorCard();
      await answer(number, 1);

      const outcome = await scan(new FixtureRadarFeeds({})).run();

      expect(outcome.applied).toEqual([
        expect.objectContaining({ escalationNumber: number, outcome: 'abgelehnt' }),
      ]);
      expect(await createdTasks()).toEqual([]);
    });

    it('legt nichts an, wenn die Antwort reiner Freitext ist', async () => {
      // "ja mach" and "auf keinen Fall" are both free text; inferring consent
      // from prose is guessing (§1 principle 6).
      const number = await raiseMajorCard();
      await answer(number, null, 'Ich schaue mir das selbst an.');

      const outcome = await scan(new FixtureRadarFeeds({})).run();

      expect(outcome.applied).toEqual([
        expect.objectContaining({ escalationNumber: number, outcome: 'unentschieden' }),
      ]);
      expect(await createdTasks()).toEqual([]);
    });

    it('führt dieselbe Antwort über mehrere Läufe nur einmal aus', async () => {
      const number = await raiseMajorCard();
      await answer(number, RADAR_APPROVE_INDEX);

      await scan(new FixtureRadarFeeds({})).run();
      const second = await scan(new FixtureRadarFeeds({})).run();

      expect(second.applied).toEqual([]);
      expect(await createdTasks()).toHaveLength(1);
    });

    it('führt eine offene Karte nicht aus', async () => {
      await raiseMajorCard();
      const outcome = await scan(new FixtureRadarFeeds({})).run();
      expect(outcome.applied).toEqual([]);
      expect(await createdTasks()).toEqual([]);
    });
  });

  // ------------------------------------------------------------ Ablage ------

  describe('was ein Lauf hinterlässt', () => {
    async function lastRow(): Promise<Record<string, unknown>> {
      const [row] = await sql<Array<{ payload: Record<string, unknown> }>>`
        SELECT payload FROM event_log WHERE kind = 'radar.finished' ORDER BY id DESC LIMIT 1
      `;
      if (!row) throw new Error('Kein radar.finished — der Auftrag hätte keine Frist.');
      return row.payload;
    }

    it('schreibt auch im stillen Lauf eine Zeile — sie ist die Frist', async () => {
      // `periodic-pass.ts` decision 3: a job that writes only on a transition
      // has no deadline and runs on every tick forever.
      const outcome = await scan(new FixtureRadarFeeds({})).run();
      expect(outcome.report).not.toBeNull();
      expect(await lastRow()).toMatchObject({ reported: [], cards: [], tasks: [] });
    });

    it('nennt die ungeprüften Flächen auch in der Zeile, nicht nur im Rückgabewert', async () => {
      await scan(new FixtureRadarFeeds({})).run();
      expect(JSON.stringify((await lastRow()).limits)).toMatch(/kein Kanal konfiguriert/);
    });

    it('legt die Tatsachen einer Karte ab, statt sie später aus der Prosa zu lesen', async () => {
      // A112.1: this repository does not parse its own sentences for facts it
      // could store. That rule is what makes the answer path above possible.
      await manifest({ links: '1.0.0' });
      await scan(new FixtureRadarFeeds({ latest: { links: '2.0.0' } })).run();
      expect((await lastRow()).cards).toEqual([
        expect.objectContaining({
          kind: 'dependency_major',
          name: 'links',
          current: '1.0.0',
          latest: '2.0.0',
          projectId,
        }),
      ]);
    });

    it('überlebt einen Kanal, der wirft, und prüft die anderen trotzdem', async () => {
      // Decision 9: this runs from the daemon's loop, where a rejection becomes
      // `process.exit(1)` — and a broken billing channel must not cost the
      // dependency scan its run.
      await manifest({ links: '1.0.0' });
      const broken: RadarFeeds = {
        billingChannels: () => Promise.reject(new Error('Kanal kaputt')),
        cliChannel: () => Promise.reject(new Error('auch kaputt')),
        latestVersions: async (names) => ({
          live: true,
          origin: 'test',
          value: new Map(names.map((name) => [name, '2.0.0'])),
        }),
        advisories: async () => ({ live: true, origin: 'test', value: [] }),
      };

      const outcome = await scan(broken).run();

      expect(outcome.problems.join('\n')).toMatch(/Kanal kaputt/);
      expect(outcome.problems.join('\n')).toMatch(/auch kaputt/);
      // And the third scan still ran.
      expect(outcome.cards).toHaveLength(1);
    });
  });

  describe('mehrere Projekte', () => {
    it('hält die Gedächtnisschlüssel je Projekt auseinander', async () => {
      // Two projects with the same outdated package are two findings; a key
      // without the project id would silence the second one forever.
      await manifest({ links: '1.0.0' });
      const other = await mkdtemp(join(tmpdir(), 'radar-project-'));
      await writeFile(
        join(other, 'package.json'),
        JSON.stringify({ dependencies: { links: '1.0.0' } }),
        'utf8',
      );
      await projects.create({ slug: 'zweitprojekt', name: 'Zweitprojekt', rootPath: other });

      const outcome: RadarOutcome = await scan(
        new FixtureRadarFeeds({ latest: { links: '2.0.0' } }),
      ).run();

      expect(outcome.cards).toHaveLength(2);
      expect(new Set(outcome.cards.map((card) => card.projectId)).size).toBe(2);
    });
  });
});
