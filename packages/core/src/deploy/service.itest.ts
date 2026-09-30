/**
 * §12's engine against a real Postgres and a fake target (A37).
 *
 * What is asserted here is the **order and the refusals**, because that is what
 * §12 actually specifies and what every Phase 5 exit gate turns on. The two real
 * targets — docker and rsync — are held to the same contract elsewhere; putting
 * them here would replace a proof about the engine with a proof about docker.
 *
 * The rollback cases matter more than the happy one and are written first in
 * that spirit: a deploy engine whose success path works is ordinary, and one
 * whose rollback works is the reason §12 permits any of this to be automatic.
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import { validateDeployConfig } from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EscalationService } from '../escalation-service.js';
import { EventLog } from '../event-log.js';
import { ProjectService } from '../project-service.js';
import { TaskService } from '../task-service.js';
import { FakeDeployTarget } from './fake-target.js';
import { DeployRecords } from './records.js';
import { APPROVE_INDEX, DeployService, MIGRATION_APPROVE_INDEX } from './service.js';

const url = process.env.TEST_DATABASE_URL;

/**
 * A value the fixture guarantees, with a sentence when it does not.
 *
 * Biome forbids `!` and it is right to: a fixture that silently returned null
 * would surface as "Cannot read properties of null" three lines later, which
 * says nothing about which step of the setup failed.
 */
function muss<T>(wert: T | null | undefined, was: string): T {
  if (wert === null || wert === undefined)
    throw new Error(`${was} fehlt — die Fixture stimmt nicht`);
  return wert;
}

const COMPOSE = {
  method: 'compose' as const,
  composeFiles: ['docker-compose.yml'],
  service: 'app',
  healthUrl: 'https://example.test/healthz',
  // Am unteren Rand des Erlaubten, nicht darunter: der erste Anlauf setzte
  // 10 ms und lief damit unter den eigenen Boden von 250 — `readDeployConfig`
  // gab dann still `none` zurück und *jeder* Fall meldete `unsupported`. Die
  // sichere Richtung des Lesers hat hier gegen mich gearbeitet, und genau
  // deshalb steht unten eine Zusicherung, dass die Fixture gültig ist.
  healthTimeoutMs: 1_000,
  healthIntervalMs: 250,
  keep: 2,
};

describe.skipIf(!url)('Deploy-Maschine (§12)', () => {
  it('hat eine gültige Fixture — sonst prüft jeder Fall darunter nichts', () => {
    // `readDeployConfig` fällt bei einem unlesbaren Dokument bewusst auf `none`
    // zurück (§12: „konnten wir nicht lesen" muss „nichts ausrollen" heißen).
    // Für eine *Fixture* heißt dasselbe: jeder Fall meldet `unsupported` und
    // sieht aus wie ein Defekt der Maschine. Diese Zeile sagt, dass es keiner ist.
    expect(validateDeployConfig(COMPOSE)).toEqual({ ok: true, errors: [] });
  });

  let database: TestDatabase;
  let sql: postgres.Sql;
  let tasks: TaskService;
  let projects: ProjectService;
  let escalations: EscalationService;
  let records: DeployRecords;
  let eventLog: EventLog;
  let seq = 0;

  beforeAll(async () => {
    database = await createTestDatabase('deploy_service');
    sql = createSql({ url: database.url, max: 4 });
    eventLog = new EventLog(sql);
    tasks = new TaskService({ sql, eventLog });
    projects = new ProjectService(sql);
    escalations = new EscalationService({ sql, eventLog });
    records = new DeployRecords(sql);
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await database?.drop();
  });

  async function fixture(options: { selfManaged?: boolean } = {}) {
    seq += 1;
    const project = await projects.create({
      slug: `deploy-${seq}`,
      name: `Deploy ${seq}`,
      rootPath: `/tmp/deploy-${seq}`,
      deployConfig: COMPOSE,
      ...(options.selfManaged ? { selfManaged: true } : {}),
    });
    const task = await tasks.create({ projectId: project.id, title: `Rollout ${seq}` });
    // Straight to `deploying`: §9's path to here is the merge queue's and is
    // settled in its own file; what this one is about starts at the deploy.
    for (const state of [
      'planning',
      'claimed',
      'coding',
      'review',
      'gates',
      'merge_queue',
      'merging',
      'deploying',
    ] as const) {
      await tasks.transition(task.id, state, { actor: 'orchestrator', reason: 'Fixture' });
    }
    return { project, task: await tasks.get(task.id) };
  }

  /**
   * `healthy` is a **predicate**, deliberately, and the first version was a
   * queue of answers — which is wrong for a reason worth keeping: the poll
   * *retries* until the timeout, so a single `false` at the head of a list is
   * consumed by the first attempt and the second attempt reports green. The
   * deploy then succeeded and the rollback case proved nothing.
   *
   * `swapsSoFar` is what distinguishes the two phases honestly: after the
   * rollback has swapped the previous release back in, there have been two
   * swaps. "Healthy only once the old release is serving again" is exactly the
   * situation §12's rollback is for, expressed rather than counted.
   */
  function service(options: {
    target: FakeDeployTarget;
    healthy: boolean | ((swapsSoFar: number) => boolean);
    guardian?: 'normal' | 'wrap_up' | 'hard_stop';
    run?: DeployService['deps']['run'];
  }) {
    return new DeployService({
      sql,
      records,
      eventLog,
      tasks,
      escalations,
      targets: new Map([['compose', options.target]]),
      guardianState: async () => options.guardian ?? 'normal',
      health: async () => {
        const ok =
          typeof options.healthy === 'function'
            ? options.healthy(options.target.swaps.length)
            : options.healthy;
        return { ok, detail: ok ? 'HTTP 200' : 'HTTP 503' };
      },
      run: options.run ?? (async () => ({ ok: true, code: 0, output: '' })),
    });
  }

  it('rollt aus, prüft die Gesundheit und schließt die Aufgabe ab', async () => {
    const { project, task } = await fixture();
    const target = new FakeDeployTarget();
    const result = await service({ target, healthy: true }).deploy(
      muss(task, 'die Aufgabe'),
      project,
      `sha-${seq}-a`,
    );

    expect(result.outcome).toBe('deployed');
    expect(target.serving?.id).toContain('image:');
    expect((await tasks.get(muss(task, 'die Aufgabe').id))?.state).toBe('done');

    const record = await records.get(muss(result.deploymentId, 'die Deployment-Kennung'));
    expect(record?.outcome).toBe('succeeded');
    expect(record?.healthOk).toBe(true);
    // §12 wants durations in the release history, and they come from the record
    // rather than from a stopwatch somebody has to remember to start.
    expect(record?.durationMs).not.toBeNull();
  });

  it('hält A24s Reihenfolge ein: erst migrieren, dann tauschen, dann prüfen', async () => {
    const { project, task } = await fixture();
    const target = new FakeDeployTarget();
    const reihenfolge: string[] = [];

    const svc = service({
      target,
      healthy: true,
      run: async () => {
        reihenfolge.push('migrate');
        return { ok: true, code: 0, output: '' };
      },
    });
    // The target records its own swap; interleaving the two is what shows the
    // order rather than asserting each half separately.
    const originalSwap = target.swap.bind(target);
    target.swap = async (ctx, artifact) => {
      reihenfolge.push('swap');
      return originalSwap(ctx, artifact);
    };

    const project2 = muss(await projects.get(project.id), 'das Projekt');
    await svc.deploy(
      muss(task, 'die Aufgabe'),
      {
        ...project2,
        deployConfig: { ...COMPOSE, migrateCommand: 'pnpm db:migrate' },
      },
      `sha-${seq}-a`,
    );

    // The asymmetry A24 names: a rollback restores *code*, so a failed
    // migration must happen while nothing has been swapped yet.
    expect(reihenfolge).toEqual(['migrate', 'swap']);
  });

  it('bricht ab, bevor etwas getauscht wird, wenn die Migration scheitert', async () => {
    const { project, task } = await fixture();
    const target = new FakeDeployTarget();
    const svc = service({
      target,
      healthy: true,
      run: async () => ({ ok: false, code: 1, output: 'relation "x" does not exist' }),
    });

    const result = await svc.deploy(
      muss(task, 'die Aufgabe'),
      {
        ...project,
        deployConfig: { ...COMPOSE, migrateCommand: 'pnpm db:migrate' },
      },
      `sha-${seq}-a`,
    );

    // A93: war `rolled_back`, obwohl nichts getauscht und also nichts
    // zurückgerollt wurde — A24s Ordnung sorgt genau dafür.
    expect(result.outcome).toBe('failed');
    // Nothing served the new code — which is the whole point of the order.
    expect(target.swaps).toEqual([]);
    expect(target.serving).toBeNull();
    expect((await tasks.get(muss(task, 'die Aufgabe').id))?.state).toBe('red');

    // Und der milde der drei Fälle: die bisherige Version läuft unverändert,
    // also P1 statt P0. Ohne die Unterscheidung wäre jeder Fehlschlag ein
    // Notfall, und dann ist keiner mehr einer.
    const karte = (await escalations.open()).find(
      (eintrag) => eintrag.source === 'deploy_failed' && eintrag.projectId === project.id,
    );
    expect(karte?.urgency).toBe('P1');
    expect(karte?.context).toContain('Getauscht wurde');
  });

  it('rollt auf das letzte gesunde Release zurück und prüft es erneut', async () => {
    const { project, task } = await fixture();
    const target = new FakeDeployTarget();

    // Ein erstes, gesundes Release — sonst gibt es nichts, wohin zurück.
    const first = await service({ target, healthy: true }).deploy(
      muss(task, 'die Aufgabe'),
      project,
      `sha-${seq}-a`,
    );
    expect(first.outcome).toBe('deployed');
    const gutesArtefakt = target.serving?.id;

    const zweite = await tasks.create({ projectId: project.id, title: 'Kaputtes Release' });
    for (const state of [
      'planning',
      'claimed',
      'coding',
      'review',
      'gates',
      'merge_queue',
      'merging',
      'deploying',
    ] as const) {
      await tasks.transition(zweite.id, state, { actor: 'orchestrator', reason: 'Fixture' });
    }

    // Ungesund, solange das neue Release läuft; gesund, sobald das alte wieder
    // getauscht ist. Gezählt **ab diesem Rollout**, nicht ab Lebensbeginn des
    // Ziels — der erste Rollout hat schon einmal getauscht, und ohne die
    // Grundlinie wäre die Bedingung von Anfang an erfüllt.
    const vorher = target.swaps.length;
    const result = await service({ target, healthy: (swaps) => swaps >= vorher + 2 }).deploy(
      muss(await tasks.get(zweite.id), 'die zweite Aufgabe'),
      project,
      `sha-${seq}-b`,
    );

    expect(result.outcome).toBe('rolled_back');
    expect(target.serving?.id).toBe(gutesArtefakt);

    const record = await records.get(muss(result.deploymentId, 'die Deployment-Kennung'));
    expect(record?.outcome).toBe('rolled_back');
    expect(record?.rolledBackTo).toBe(first.deploymentId);
    // §12 eskaliert „mit vollen Logs" — die Ursache steht am Datensatz.
    expect(record?.problem).toContain('HTTP 503');

    // §12: der Rollback färbt die zusammengeführte Änderung rot, §9 übernimmt.
    expect((await tasks.get(zweite.id))?.state).toBe('red');

    // Auf das Projekt eingeengt: `open()` ist global und alle Fälle dieser
    // Datei teilen sich eine Datenbank, also fand ein bloßes `source ===
    // 'rollback'` die Karte irgendeines anderen Falls. Vor A96 fiel das nicht
    // auf, weil die Zusicherung eine Dringlichkeit prüfte, die auch die fremde
    // Karte trug — genau die Art Zusicherung, die etwas anderes prüft als das,
    // was ihr Testname sagt.
    const karten = await escalations.open();
    const rollback = karten.find(
      (karte) => karte.source === 'rollback' && karte.projectId === project.id,
    );
    expect(rollback).toBeDefined();
    // Diese Zeile hat zweimal die Richtung gewechselt, und beide Male aus einem
    // guten Grund — deshalb steht die Geschichte hier statt nur der Wert.
    // Zuerst P1 („zurückgerollt und wieder gesund ist dringend, aber nicht
    // brennend"), dann P0, weil §12 den Satz ohne Fallunterscheidung schrieb und
    // ein Gate-Satz, der wörtlich P0 verlangt, mit einer P1-Karte nicht erfüllt
    // ist (A96, §0.3) — das Urteil war vertretbar und stand mir nicht zu.
    // Am 17.8.2026 hat der Betreiber §12 geändert und die Unterscheidung angeordnet
    // (A133). Damit ist P1 hier keine Abschwächung mehr, sondern der Wortlaut.
    expect(rollback?.urgency).toBe('P1');
    expect(rollback?.context).toContain('läuft wieder und ist gesund');
  });

  it('meldet P0, wenn auch das Zurückrollen nicht gesund wird', async () => {
    const { project, task } = await fixture();
    const target = new FakeDeployTarget();
    await service({ target, healthy: true }).deploy(
      muss(task, 'die Aufgabe'),
      project,
      `sha-${seq}-a`,
    );

    const zweite = await tasks.create({ projectId: project.id, title: 'Doppelt kaputt' });
    for (const state of [
      'planning',
      'claimed',
      'coding',
      'review',
      'gates',
      'merge_queue',
      'merging',
      'deploying',
    ] as const) {
      await tasks.transition(zweite.id, state, { actor: 'orchestrator', reason: 'Fixture' });
    }

    const result = await service({ target, healthy: false }).deploy(
      muss(await tasks.get(zweite.id), 'die zweite Aufgabe'),
      project,
      `sha-${seq}-b`,
    );

    // Der Zustand der Produktion ist ungeklärt — und seit A133 ist die
    // Dringlichkeit wieder das Unterscheidende: der gesunde Rollback trägt P1,
    // dieser hier P0. Der Text bleibt trotzdem mitgeprüft, aus dem Grund, den
    // A96 zwischenzeitlich zum einzigen gemacht hatte: er ist das, was ein
    // Mensch um drei Uhr nachts liest, und eine Zusicherung, die nur die
    // Dringlichkeit liest, ginge bei einer umformulierten Karte durch.
    expect(result.outcome).toBe('rollback_failed');
    const karten = await escalations.open();
    const karte = karten.find(
      (eintrag) => eintrag.source === 'rollback' && eintrag.projectId === project.id,
    );
    expect(karte?.urgency).toBe('P0');
    expect(karte?.context).toContain('Auch das Zurückrollen ist nicht gesund geworden');
    expect(karte?.context).not.toContain('läuft wieder und ist gesund');
    // §12 eskaliert „mit vollen Logs": die Antwort der zweiten Prüfung steht drin.
    expect(karte?.context).toContain('HTTP 503');
    // Und die Empfehlung kippt: bei ungeklärtem Zustand ist Selbst-Nachsehen
    // die empfohlene Option, nicht „so lassen".
    expect(karte?.options.findIndex((option) => option.recommended)).toBe(1);
  });

  it('scheitert ehrlich, wenn es kein früheres gesundes Release gibt', async () => {
    const { project, task } = await fixture();
    const target = new FakeDeployTarget();

    const result = await service({ target, healthy: false }).deploy(
      muss(task, 'die Aufgabe'),
      project,
      `sha-${seq}-a`,
    );

    // Kein Rollback auf etwas, das es nicht gibt — der erste Rollout eines
    // Projekts ist genau dieser Fall.
    expect(result.problem).toContain('kein früheres gesundes Release');
    expect((await tasks.get(muss(task, 'die Aufgabe').id))?.state).toBe('red');

    // A93: dieser Test hieß „scheitert ehrlich" und prüfte jede Aussage außer
    // der unehrlichen. `outcome` war `rolled_back` — für den Zweig, in dem
    // nichts zurückgerollt wurde und das kaputte Release die Produktion
    // bedient. Eine Zusicherung entfernt vom Fund, ein Jahr lang grün.
    expect(result.outcome).toBe('failed');
    const karte = (await escalations.open()).find(
      (eintrag) => eintrag.source === 'deploy_failed' && eintrag.projectId === project.id,
    );
    // Und bis A93 kam hier gar keine Karte: Aufgabe rot, Ablaufplaner
    // „zurückgerollt", niemand benachrichtigt — obwohl §12 für einen echten
    // Rollback eine P0-Karte verlangt und dies der schlimmere Fall ist.
    expect(karte?.urgency).toBe('P0');
    expect(karte?.context).toContain('kaputte Version');

    // **Und die Zeile im Ereignisprotokoll, die dieser Pfad bis zum 18.8.2026
    // nicht schrieb.** Der Dienst hatte genau zwei `eventLog.append`
    // (`deploy.succeeded`, `deploy.rolled_back`); der schwerwiegendste Fall,
    // den §12 kennt, hinterliess dort nichts. §18 macht `event_log` zur
    // Wahrheitsquelle und §16 rechnet seine Kopfzahlen daraus — der
    // Wochenbericht hätte „0 Rollbacks" gemeldet, während die Produktion die
    // kaputte Version bedient. Gefunden vom Strang, der §16s Kennzahlen baute:
    // er konnte die Grösse nicht herleiten und hat gesagt warum.
    //
    // Geprüft wird `serving`, nicht nur die Art: **welche** Version bedient,
    // ist die eine Angabe, die einen Menschen um drei Uhr nachts interessiert,
    // und eine Zeile ohne sie wäre die Meldung ohne ihren Inhalt.
    const zeilen = await eventLog.recentOfKind('deploy.failed', 20);
    const zeile = zeilen.find((e) => e.projectId === project.id);
    expect(zeile, 'deploy.failed fehlt im Ereignisprotokoll').toBeDefined();
    expect(zeile?.payload).toMatchObject({ serving: 'broken' });
  });

  it('rollt außerhalb von „normal" gar nicht erst aus (§12)', async () => {
    for (const guardian of ['wrap_up', 'hard_stop'] as const) {
      const { project, task } = await fixture();
      const target = new FakeDeployTarget();
      const result = await service({ target, healthy: true, guardian }).deploy(
        muss(task, 'die Aufgabe'),
        project,
        `sha-${seq}-a`,
      );

      expect(result.outcome).toBe('deferred');
      // Nichts angefasst, und die Aufgabe steht noch da, wo sie stand: ein
      // Aufschub ist kein Urteil über die Änderung.
      expect(target.swaps).toEqual([]);
      expect((await tasks.get(muss(task, 'die Aufgabe').id))?.state).toBe('deploying');
      expect(result.deploymentId).toBeNull();
    }
  });

  it('fragt bei einem Selbst-Deploy nach Freigabe und rollt nicht aus (A12)', async () => {
    const { project, task } = await fixture({ selfManaged: true });
    const target = new FakeDeployTarget();

    const result = await service({ target, healthy: true }).deploy(
      muss(task, 'die Aufgabe'),
      project,
      `sha-${seq}-a`,
    );

    expect(result.outcome).toBe('needs_decision');
    expect(target.swaps).toEqual([]);
    expect((await tasks.get(muss(task, 'die Aufgabe').id))?.state).toBe('needs_decision');

    const karte = await escalations.latestForTask(muss(task, 'die Aufgabe').id);
    expect(karte?.source).toBe('self_deploy');
    expect(karte?.options).toHaveLength(2);
  });

  it('fragt nicht zweimal, solange die Frage offen ist', async () => {
    const { project, task } = await fixture({ selfManaged: true });
    const target = new FakeDeployTarget();
    const svc = service({ target, healthy: true });

    await svc.deploy(muss(task, 'die Aufgabe'), project, `sha-${seq}-a`);
    const nachEins = (await escalations.forTask(muss(task, 'die Aufgabe').id)).length;
    // Der Tick kommt alle fünfzehn Sekunden wieder. Ohne die Prüfung auf eine
    // offene Karte füllte sich §15s Postfach mit derselben Frage.
    await svc.deploy(
      muss(await tasks.get(muss(task, 'die Aufgabe').id), 'die Aufgabe'),
      project,
      `sha-${seq}-a`,
    );
    expect((await escalations.forTask(muss(task, 'die Aufgabe').id)).length).toBe(nachEins);
  });

  /**
   * A93 — die Lücke, die diese Datei bis zum 3.8.2026 offen gelassen hat.
   *
   * Der Test darüber beantwortete die Karte mit `optionIndex: 0` und rollte
   * danach aus, also war „beantwortet" und „freigegeben" in jedem Fall
   * dasselbe — und der Dienst las genau das: `state === 'answered'`. Die
   * Option „Noch nicht — später von Hand" existierte, war die einzige, für die
   * sie geschrieben ist, und gab den Selbst-Deploy frei.
   */
  it('rollt NICHT aus, wenn der Betreiber „Noch nicht" gewählt hat (A12, A93)', async () => {
    const { project, task } = await fixture({ selfManaged: true });
    const target = new FakeDeployTarget();
    const svc = service({ target, healthy: true });
    const taskId = muss(task, 'die Aufgabe').id;

    await svc.deploy(muss(task, 'die Aufgabe'), project, `sha-${seq}-a`);
    const karte = await escalations.latestForTask(taskId);
    await escalations.answer(muss(karte, 'die Karte').id, { optionIndex: 1, actor: 'max' });
    await tasks.resume(taskId, { actor: 'orchestrator', reason: 'Antwort da' });

    const result = await svc.deploy(
      muss(await tasks.get(taskId), 'die Aufgabe'),
      project,
      `sha-${seq}-a`,
    );

    expect(result.outcome).toBe('needs_decision');
    // Die tragende Zusicherung ist die Maschine, nicht der Rückgabewert.
    expect(target.swaps).toEqual([]);
    expect(result.problem).toContain('nicht mit');
    // Und keine zweite Karte: er hat entschieden. Alle fünfzehn Sekunden
    // nachzufragen wäre genau das Postfach-Zumüllen, das die Prüfung auf eine
    // offene Karte verhindert.
    expect((await escalations.forTask(taskId)).length).toBe(1);
  });

  it('rollt NICHT auf eine reine Freitextantwort aus (A93)', async () => {
    const { project, task } = await fixture({ selfManaged: true });
    const target = new FakeDeployTarget();
    const svc = service({ target, healthy: true });
    const taskId = muss(task, 'die Aufgabe').id;

    await svc.deploy(muss(task, 'die Aufgabe'), project, `sha-${seq}-a`);
    const karte = await escalations.latestForTask(taskId);
    // §15 lässt Freitext immer zu — und „mach mal" von „auf keinen Fall" zu
    // unterscheiden hieße, bei der folgenreichsten unbeaufsichtigten Handlung
    // dieses Systems aus Prosa zu raten.
    await escalations.answer(muss(karte, 'die Karte').id, {
      freeText: 'ja mach, aber erst nach dem Backup',
      actor: 'max',
    });
    await tasks.resume(taskId, { actor: 'orchestrator', reason: 'Antwort da' });

    const result = await svc.deploy(
      muss(await tasks.get(taskId), 'die Aufgabe'),
      project,
      `sha-${seq}-a`,
    );

    expect(result.outcome).toBe('needs_decision');
    expect(target.swaps).toEqual([]);
    expect(result.problem).toContain('Freitextantwort');
  });

  it('die freigebende Option ist die, die „Ausrollen" heißt (A93)', async () => {
    // Der Dienst vergleicht einen Index. Ohne diese Zusicherung wäre eine
    // umsortierte Optionsliste eine Freigabe für „Noch nicht" — dieselbe Falle
    // eine Ebene tiefer, und die Richtung, in der niemand nachsieht.
    const { project, task } = await fixture({ selfManaged: true });
    await service({ target: new FakeDeployTarget(), healthy: true }).deploy(
      muss(task, 'die Aufgabe'),
      project,
      `sha-${seq}-a`,
    );
    const karte = await escalations.latestForTask(muss(task, 'die Aufgabe').id);
    expect(karte?.options[APPROVE_INDEX]?.title).toBe('Ausrollen');
  });

  it('rollt nach der Freigabe aus, ohne erneut zu fragen', async () => {
    const { project, task } = await fixture({ selfManaged: true });
    const target = new FakeDeployTarget();
    const svc = service({ target, healthy: true });

    await svc.deploy(muss(task, 'die Aufgabe'), project, `sha-${seq}-a`);
    const karte = await escalations.latestForTask(muss(task, 'die Aufgabe').id);
    await escalations.answer(muss(karte, 'die Karte').id, { optionIndex: 0, actor: 'max' });
    await tasks.resume(muss(task, 'die Aufgabe').id, {
      actor: 'orchestrator',
      reason: 'Freigabe erteilt',
    });

    const result = await svc.deploy(
      muss(await tasks.get(muss(task, 'die Aufgabe').id), 'die Aufgabe'),
      project,
      `sha-${seq}-a`,
    );
    expect(result.outcome).toBe('deployed');
    expect((await escalations.forTask(muss(task, 'die Aufgabe').id)).length).toBe(1);
  });

  /**
   * A93 — §12s drittes Ende: gescheitert, und **nichts** zurückgerollt.
   *
   * Bis zum 3.8.2026 gaben alle drei Zweige `rolled_back` zurück und erzeugten
   * gar keine Karte. Der Datensatz war richtig (`kind: 'failed'`), gelogen hat
   * nur der Wert, den der Ablaufplaner protokolliert — „wir haben es
   * zurückgesetzt" für drei Fälle, in denen nichts zurückgesetzt wurde.
   */
  describe('gescheitert ohne Rückweg (A93)', () => {
    it('Absturz mitten im Rollout: P0, und der Zustand heißt ungeklärt', async () => {
      const { project, task } = await fixture();
      const target = new FakeDeployTarget({ failSwap: 'docker daemon weg' });
      const taskId = muss(task, 'die Aufgabe').id;

      const result = await service({ target, healthy: true }).deploy(
        muss(task, 'die Aufgabe'),
        project,
        `sha-${seq}-a`,
      );

      expect(result.outcome).toBe('failed');
      expect((await tasks.get(taskId))?.state).toBe('red');
      const karte = (await escalations.open()).find(
        (eintrag) => eintrag.source === 'deploy_failed' && eintrag.projectId === project.id,
      );
      expect(karte?.source).toBe('deploy_failed');
      expect(karte?.urgency).toBe('P0');
      expect(karte?.context).toContain('ungeklärt');
    });
  });

  it('räumt alte Releases nach A11 weg und sagt, welche', async () => {
    const { project, task } = await fixture();
    const target = new FakeDeployTarget({
      existing: [
        { id: 'image:alt-1', sha: 'alt-1' },
        { id: 'image:alt-2', sha: 'alt-2' },
        { id: 'image:alt-3', sha: 'alt-3' },
      ],
    });

    const result = await service({ target, healthy: true }).deploy(
      muss(task, 'die Aufgabe'),
      project,
      `sha-${seq}-a`,
    );
    expect(result.outcome).toBe('deployed');
    // `keep: 2` — das neue plus eins, was das Minimum für einen Rollback ist.
    expect(target.releasesOnMachine).toHaveLength(2);
    expect(target.pruned.length).toBeGreaterThan(0);

    // Und es steht im Datensatz: ein Aufräumen, das stillschweigend das Release
    // entfernt, das ein Rollback gleich gebraucht hätte, wäre erst beim
    // Rollback sichtbar.
    const rows = await sql<Array<{ payload: { pruned?: string[] } }>>`
      SELECT payload FROM deployment_events
      WHERE deployment_id = ${result.deploymentId} AND kind = 'succeeded'
    `;
    expect(rows[0]?.payload.pruned).toEqual(target.pruned);
  });
  describe('A24s Stopp — eine nicht rückwärtskompatible Migration hält den Rollout an', () => {
    /**
     * §12: *"if the migration review (Milo) flags a non-backward-compatible
     * migration, the deploy **stops and escalates** instead of auto-deploying —
     * safety over automation."*
     *
     * Der Grund ist dieselbe Asymmetrie, auf der schon die Reihenfolge beruht,
     * eine Stufe weiter draußen: ein Rollback stellt den **Code** der vorherigen
     * Version wieder her, und eine Migration, die der alte Code nicht mehr lesen
     * kann, macht den Rollback selbst zum Ausfall. Automatik ist genau bis zu
     * dem Punkt in Ordnung, an dem ihr Rückweg nicht mehr funktioniert.
     *
     * Der Produzent (`gate.migration_review`) schreibt seit Phase 3 und trägt
     * den Kommentar „§12/A24 reads this one" — gelesen hat ihn bis hierher
     * nichts. A63.7 hatte genau das als Risiko vermerkt.
     */
    async function reviewSchreiben(taskId: string, projectId: string, backwardCompatible: boolean) {
      await eventLog.append({
        kind: 'gate.migration_review',
        actor: 'db-review',
        taskId,
        projectId,
        payload: { verdict: 'approve', backwardCompatible, reversibility: 'documented' },
      });
    }

    it('hält an, fragt den Betreiber und fasst nichts an', async () => {
      const { project, task } = await fixture();
      const target = new FakeDeployTarget();
      await reviewSchreiben(muss(task, 'die Aufgabe').id, project.id, false);

      const result = await service({ target, healthy: true }).deploy(
        muss(task, 'die Aufgabe'),
        project,
        `sha-${seq}-a`,
      );

      expect(result.outcome).toBe('needs_decision');
      // Nichts gebaut, nichts getauscht: der Stopp kommt vor dem ersten Artefakt.
      expect(target.swaps).toEqual([]);
      expect(target.releasesOnMachine).toEqual([]);
      expect((await tasks.get(muss(task, 'die Aufgabe').id))?.state).toBe('needs_decision');

      const karte = await escalations.latestForTask(muss(task, 'die Aufgabe').id);
      expect(karte?.source).toBe('migration_stop');
      // Nichts brennt — die Produktion bedient weiter die alte Version.
      expect(karte?.urgency).toBe('P1');
      expect(karte?.options).toHaveLength(2);
    });

    it('lässt eine rückwärtskompatible Migration durch', async () => {
      const { project, task } = await fixture();
      const target = new FakeDeployTarget();
      await reviewSchreiben(muss(task, 'die Aufgabe').id, project.id, true);

      const result = await service({ target, healthy: true }).deploy(
        muss(task, 'die Aufgabe'),
        project,
        `sha-${seq}-a`,
      );
      expect(result.outcome).toBe('deployed');
    });

    it('behandelt einen fehlenden Review nicht als Stopp', async () => {
      // Die meisten Projekte haben gar kein Migrations-Gate. Schweigen als
      // „nicht rückwärtskompatibel" zu lesen, parkte jeden Rollout jedes
      // Projekts, das es nie eingeschaltet hat — der Stopp wäre dann kein
      // Sicherheitsnetz, sondern ein Stillstand.
      const { project, task } = await fixture();
      const target = new FakeDeployTarget();

      const result = await service({ target, healthy: true }).deploy(
        muss(task, 'die Aufgabe'),
        project,
        `sha-${seq}-a`,
      );
      expect(result.outcome).toBe('deployed');
    });

    /**
     * A97 — dieselbe Lücke wie bei A12, und hier über den *empfohlenen* Weg.
     *
     * Der Fall unten beantwortete die Karte immer mit `optionIndex: 1`, also
     * mit der Freigabe, und traf damit den einen Index, der richtig war. Die
     * empfohlene Option dieser Karte ist die **erste** („Warten — ich mache
     * die Migration erst rückwärtskompatibel"), und sie gab den Rollout frei:
     * das Studio empfahl warten, der Betreiber wählte warten, und die Migration ohne
     * Rückweg ging raus.
     */
    it('rollt NICHT aus, wenn der Betreiber „Warten" gewählt hat — die empfohlene Option (A97)', async () => {
      const { project, task } = await fixture();
      const target = new FakeDeployTarget();
      const taskId = muss(task, 'die Aufgabe').id;
      await reviewSchreiben(taskId, project.id, false);
      const svc = service({ target, healthy: true });

      await svc.deploy(muss(task, 'die Aufgabe'), project, `sha-${seq}-a`);
      const karte = await escalations.latestForTask(taskId);
      // Ausdrücklich über die *Empfehlung* gewählt, nicht über den Index: die
      // Zusicherung soll den Weg abbilden, den der Betreiber tatsächlich nimmt.
      const empfohlen = muss(karte, 'die Karte').options.findIndex((option) => option.recommended);
      expect(empfohlen).toBe(0);
      await escalations.answer(muss(karte, 'die Karte').id, {
        optionIndex: empfohlen,
        actor: 'max',
      });
      await tasks.resume(taskId, { actor: 'orchestrator', reason: 'Antwort da' });

      const result = await svc.deploy(
        muss(await tasks.get(taskId), 'die Aufgabe'),
        project,
        `sha-${seq}-a`,
      );

      expect(result.outcome).toBe('needs_decision');
      // Die tragende Zusicherung ist die Maschine: nichts gebaut, nichts getauscht.
      expect(target.swaps).toEqual([]);
      expect(target.releasesOnMachine).toEqual([]);
      expect(result.problem).toContain('hält den Rollout an');
      // Und keine zweite Karte — er hat entschieden.
      expect((await escalations.forTask(taskId)).length).toBe(1);
    });

    it('rollt NICHT auf eine reine Freitextantwort aus (A97)', async () => {
      const { project, task } = await fixture();
      const target = new FakeDeployTarget();
      const taskId = muss(task, 'die Aufgabe').id;
      await reviewSchreiben(taskId, project.id, false);
      const svc = service({ target, healthy: true });

      await svc.deploy(muss(task, 'die Aufgabe'), project, `sha-${seq}-a`);
      const karte = await escalations.latestForTask(taskId);
      await escalations.answer(muss(karte, 'die Karte').id, {
        freeText: 'schau ich mir morgen an',
        actor: 'max',
      });
      await tasks.resume(taskId, { actor: 'orchestrator', reason: 'Antwort da' });

      const result = await svc.deploy(
        muss(await tasks.get(taskId), 'die Aufgabe'),
        project,
        `sha-${seq}-a`,
      );

      expect(result.outcome).toBe('needs_decision');
      expect(target.swaps).toEqual([]);
      expect(result.problem).toContain('Freitextantwort');
    });

    it('die freigebende Option ist die, die „Trotzdem ausrollen" heißt (A97)', async () => {
      // Zwei Karten, zwei verschiedene Indizes — bei A12 ist die Freigabe die
      // erste Option, hier die zweite. Ohne diese Zusicherung gäbe eine
      // umsortierte Liste „Warten" frei, und das ist die Richtung, in der
      // niemand nachsieht.
      const { project, task } = await fixture();
      await reviewSchreiben(muss(task, 'die Aufgabe').id, project.id, false);
      await service({ target: new FakeDeployTarget(), healthy: true }).deploy(
        muss(task, 'die Aufgabe'),
        project,
        `sha-${seq}-a`,
      );
      const karte = await escalations.latestForTask(muss(task, 'die Aufgabe').id);
      expect(karte?.options[MIGRATION_APPROVE_INDEX]?.title).toContain('Trotzdem ausrollen');
      expect(karte?.options[MIGRATION_APPROVE_INDEX]?.recommended).toBe(false);
    });

    it('fragt nicht zweimal und rollt nach der Freigabe aus', async () => {
      const { project, task } = await fixture();
      const target = new FakeDeployTarget();
      const taskId = muss(task, 'die Aufgabe').id;
      await reviewSchreiben(taskId, project.id, false);
      const svc = service({ target, healthy: true });

      await svc.deploy(muss(task, 'die Aufgabe'), project, `sha-${seq}-a`);
      const nachEins = (await escalations.forTask(taskId)).length;
      // Der Tick kommt alle fünfzehn Sekunden wieder.
      await svc.deploy(muss(await tasks.get(taskId), 'die Aufgabe'), project, `sha-${seq}-a`);
      expect((await escalations.forTask(taskId)).length).toBe(nachEins);

      const karte = await escalations.latestForTask(taskId);
      await escalations.answer(muss(karte, 'die Karte').id, { optionIndex: 1, actor: 'max' });
      await tasks.resume(taskId, { actor: 'orchestrator', reason: 'Freigabe erteilt' });

      const result = await svc.deploy(
        muss(await tasks.get(taskId), 'die Aufgabe'),
        project,
        `sha-${seq}-a`,
      );
      expect(result.outcome).toBe('deployed');
    });
  });
});
