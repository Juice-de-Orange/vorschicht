/**
 * §12's `compose` method against a **real** docker daemon (§22, Phase 5).
 *
 * Everything else about the deploy engine is proven against stand-ins:
 * `service.itest.ts` drives the order and the refusals through
 * `FakeDeployTarget`, and `compose.test.ts` pins the argv against
 * `FakeDockerHost`. Both are the right shape for what they prove — and neither
 * can answer the question three Phase 5 exit gates actually ask, which is not
 * "did we issue the right commands" but **"what is serving now"**. A fake host
 * answers that out of the same model the target was written against, so a
 * shared misunderstanding cancels out; three of §22's gates turn on a rollback,
 * and a rollback nobody verified is a second outage with a reassuring log line.
 *
 * So this file runs the journey: a real image built per release, a real
 * container swapped in, a real HTTP request to a real published port, and a
 * real `docker image rm` when A11's keep-N bites. What it asserts is read off
 * the machine — the running container's image id and the **body** the health
 * URL returns — never off the target, and never off the commands that were
 * issued.
 *
 * Three properties of how it is written:
 *
 *  1. **It skips itself cleanly.** Without `TEST_DATABASE_URL` *or* without a
 *     reachable docker daemon there is nothing to run, and a bare checkout must
 *     still pass `pnpm gate` — the same posture every other `*.itest.ts` takes
 *     for the database. The probe is a real `docker version`, not an env var
 *     somebody has to remember to set: a gate that only runs when asked is a
 *     gate that stops running.
 *  2. **Every release is a different image.** The fixture bakes a release
 *     marker in by `COPY`, so a rebuild of a byte-identical tree does not hand
 *     back the same image under a second tag — without that, three "releases"
 *     share one id, the prune protects all of them because one is serving, and
 *     A11's keep-N could not be demonstrated at all.
 *  3. **Teardown is unconditional and precise.** the operator runs unrelated production
 *     stacks on this host. Every fixture gets its own compose project and its
 *     own image repository, and `afterAll` removes both whatever the tests did
 *     — including when a test threw, which is exactly when a leak would happen.
 */
import { execFile as execFileCallback, spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import { type DeployConfig, validateDeployConfig } from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EscalationService } from '../escalation-service.js';
import { EventLog } from '../event-log.js';
import { parseGateCommand } from '../gate-suite.js';
import { type ProjectRecord, ProjectService } from '../project-service.js';
import {
  createSandboxProject,
  plantSeed,
  type SandboxProject,
  setSandboxRelease,
} from '../sandbox.js';
import { type TaskRecord, TaskService } from '../task-service.js';
import { ComposeDeployTarget } from './compose.js';
import { DeployRecords } from './records.js';
import { DeployService } from './service.js';

const execFile = promisify(execFileCallback);
const url = process.env.TEST_DATABASE_URL;

/**
 * Is there a daemon to talk to?
 *
 * `docker version` rather than `docker info`: it is the cheaper of the two and
 * it still fails when the daemon is unreachable, which is the condition being
 * asked about. Synchronous because `describe.skipIf` is evaluated at collection
 * time, and ~100 ms once per file is cheaper than a suite that decides halfway
 * through that it cannot run.
 */
function dockerReachable(): boolean {
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], {
    stdio: 'ignore',
    timeout: 20_000,
  });
  return probe.status === 0;
}

/** The base image, pulled once so a build cannot blow a per-case wall clock. */
const BASE_IMAGE = 'node:22-alpine';

/**
 * A port nothing is listening on, released again before it is published.
 *
 * The window between "this was free" and "docker bound it" is real and is
 * accepted rather than hidden: it surfaces as docker's own
 * `port is already allocated`, which fails the case loudly instead of producing
 * a wrong verdict. The reason it cannot simply be ephemeral is in `sandbox.ts`
 * at `composeFile` — a `--force-recreate` would move the port that §12's fixed
 * health URL names, precisely between the broken release and the rollback.
 */
async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((ready) => probe.listen(0, '127.0.0.1', ready));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((closed) => probe.close(() => closed()));
  return port;
}

/**
 * One command, as argv, never through a shell — the production half's twin.
 *
 * Deliberately built on `parseGateCommand` rather than on a local `split`,
 * because that is what `runDeployCommand` in `apps/orchestrator` does and a
 * runner here that accepted more than production accepts would let a
 * configuration through that the studio would then refuse. `packages/core`
 * cannot import from `apps/`, so the shared part is the parser rather than the
 * function.
 */
async function runCommand(
  projectRoot: string,
  command: string,
  argv: readonly string[],
): Promise<{ ok: boolean; code: number | null; output: string }> {
  let file: string;
  let args: string[];
  try {
    const [head, ...rest] = parseGateCommand(command);
    if (!head) throw new Error(`Der Befehl „${command}" ist leer.`);
    file = head;
    args = [...rest, ...argv];
  } catch (error) {
    return { ok: false, code: null, output: (error as Error).message };
  }

  try {
    const { stdout, stderr } = await execFile(file, args, {
      cwd: projectRoot,
      timeout: 5 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
    });
    return { ok: true, code: 0, output: `${stdout}${stderr}`.trim() };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    return {
      ok: false,
      code: typeof err.code === 'number' ? err.code : null,
      output: `${err.stdout ?? ''}${err.stderr ?? err.message}`.trim(),
    };
  }
}

/** Ask the machine directly — never the target, and never the recorded argv. */
async function docker(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile('docker', args, { cwd, maxBuffer: 8 * 1024 * 1024 });
  return stdout.trim();
}

interface Journey {
  sandbox: SandboxProject;
  project: ProjectRecord;
  config: DeployConfig;
}

/**
 * A wall clock per case, stated rather than inherited.
 *
 * `vitest.setup.ts` gives an `*.itest.ts` sixty seconds (A68), which is right
 * for a database and a git clone and wrong for three image builds plus three
 * container recreations plus a health poll that is *supposed* to run to its
 * timeout in one of the cases. Four minutes is the honest budget; a journey
 * that genuinely hangs still fails.
 */
const JOURNEY_TIMEOUT_MS = 240_000;

describe.skipIf(!url || !dockerReachable())('§12 gegen einen echten Docker-Daemon', () => {
  let database: TestDatabase;
  let sql: postgres.Sql;
  let tasks: TaskService;
  let projects: ProjectService;
  let escalations: EscalationService;
  let records: DeployRecords;
  let eventLog: EventLog;
  let scratch: string;
  let seq = 0;
  const built: Journey[] = [];

  beforeAll(async () => {
    database = await createTestDatabase('deploy_compose');
    sql = createSql({ url: database.url, max: 4 });
    eventLog = new EventLog(sql);
    tasks = new TaskService({ sql, eventLog });
    projects = new ProjectService(sql);
    escalations = new EscalationService({ sql, eventLog });
    records = new DeployRecords(sql);
    scratch = await mkdtemp(join(tmpdir(), 'vorschicht-compose-'));

    // Pulled here rather than left to the first build: a cold pull inside a
    // case would charge one journey for the network and could exhaust its wall
    // clock for a reason that says nothing about §12.
    try {
      await execFile('docker', ['image', 'inspect', BASE_IMAGE], { timeout: 30_000 });
    } catch {
      await execFile('docker', ['pull', BASE_IMAGE], { timeout: 300_000 });
    }
  });

  afterAll(async () => {
    // Unconditional, and one failure must not skip the rest — a leaked
    // container on this host outlives the test run and the operator runs unrelated
    // production stacks here.
    for (const journey of built) {
      try {
        await docker(journey.sandbox.path, [
          'compose',
          '-f',
          journey.sandbox.deploy.composeFile,
          'down',
          '--volumes',
          '--remove-orphans',
          '--timeout',
          '3',
        ]);
      } catch {
        // Reported by the image sweep below if anything survived.
      }
      try {
        const refs = (
          await docker(journey.sandbox.path, [
            'image',
            'ls',
            '--format',
            '{{.Repository}}:{{.Tag}}',
            journey.sandbox.deploy.image,
          ])
        )
          .split('\n')
          .filter(Boolean);
        if (refs.length > 0) await docker(journey.sandbox.path, ['image', 'rm', '-f', ...refs]);
      } catch {
        // Same.
      }
    }
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
    await sql?.end({ timeout: 5 });
    await database?.drop();
  });

  /**
   * A fixture with a machine behind it: a git repository, a compose project of
   * its own, and a free port the health URL names.
   */
  async function journey(name: string, overrides: Partial<DeployConfig> = {}): Promise<Journey> {
    seq += 1;
    const port = await freePort();
    // Lowercase directory name: `docker compose` derives its project name from
    // the directory holding the compose file, and a capital there is a name it
    // has to normalise before it can use it.
    //
    // …and it derives it from the **basename**, which is why the random tail of
    // the scratch directory has to be carried into it. `${name}-${seq}` is
    // unique inside one process and identical across two: `mkdtemp` gives this
    // run its own path, but two runs both end up with a compose project called
    // `gruen-1`, and then one of them recreates the other's container. Observed
    // on 2026-08-10 while two agents ran the gate at once — first as
    // `No such container: 098f6f…` and then, from the other side, as
    // `Error when allocating new name: Conflict. The container name
    // "/gruen-1-app-1" is already in use`. Both are the same collision seen
    // from the two ends.
    //
    // This is deliberately *not* the port race A89.3 records and accepts: that
    // one is a window of milliseconds between probing a free port and binding
    // it, and it fails loudly with docker's own `port is already allocated`.
    // This one is a name that was never unique to begin with, and it fails as
    // a deploy that reports `failed` for a reason that has nothing to do with
    // §12 — which is worse, because it reads as a defect in the thing under
    // test.
    const sandbox = await createSandboxProject({
      path: join(scratch, `${name}-${seq}-${basename(scratch).slice(-6)}`),
      deployPort: port,
    });

    const config = {
      method: 'compose',
      composeFiles: [sandbox.deploy.composeFile],
      service: sandbox.deploy.service,
      healthUrl: sandbox.deploy.healthUrl,
      healthTimeoutMs: 30_000,
      healthIntervalMs: 500,
      keep: 2,
      ...overrides,
    } as DeployConfig;
    // The fixture has to be valid or every case below reports `unsupported`
    // and looks like a defect in the engine — `readDeployConfig` falls back to
    // `none` on an unreadable document, deliberately (§12), and that safe
    // direction works against a test.
    expect(validateDeployConfig(config)).toEqual({ ok: true, errors: [] });

    const project = await projects.create({
      slug: `${name}-${seq}`,
      name: `Deploy ${name} ${seq}`,
      rootPath: sandbox.path,
      deployConfig: config,
    });

    const record = { sandbox, project, config };
    built.push(record);
    return record;
  }

  /** A task standing where the merge queue hands one over (§9). */
  async function deployingTask(projectId: string, title: string): Promise<TaskRecord> {
    const task = await tasks.create({ projectId, title });
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
    const current = await tasks.get(task.id);
    if (!current) throw new Error('Die Aufgabe fehlt — die Fixture stimmt nicht');
    return current;
  }

  /**
   * The engine, wired to the real target, the real health probe and real argv.
   *
   * `health` is deliberately **not** injected: the whole point of this file is
   * that §12's verdict comes from an HTTP request to a port a container is
   * actually listening on.
   */
  function service(): DeployService {
    return new DeployService({
      sql,
      records,
      eventLog,
      tasks,
      escalations,
      targets: new Map([['compose', new ComposeDeployTarget()]]),
      guardianState: async () => 'normal',
      run: runCommand,
    });
  }

  /** What the health URL answers, as a status and a body. */
  async function ask(healthUrl: string): Promise<{ status: number; body: string }> {
    const response = await fetch(healthUrl, { redirect: 'manual' });
    return { status: response.status, body: (await response.text()).trim() };
  }

  /** The image id the service's container is running — read from docker. */
  async function servingImageId(journeyRecord: Journey): Promise<string | null> {
    const raw = await docker(journeyRecord.sandbox.path, [
      'compose',
      '-f',
      journeyRecord.sandbox.deploy.composeFile,
      'images',
      '--format',
      'json',
      journeyRecord.sandbox.deploy.service,
    ]);
    if (raw === '') return null;
    const parsed: unknown = JSON.parse(raw);
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const first = rows[0] as { ID?: unknown } | undefined;
    return typeof first?.ID === 'string' ? first.ID : null;
  }

  /** The id a tag resolves to, or null when the tag is gone. */
  async function imageId(journeyRecord: Journey, tag: string): Promise<string | null> {
    try {
      return await docker(journeyRecord.sandbox.path, [
        'image',
        'inspect',
        '--format',
        '{{.Id}}',
        `${journeyRecord.sandbox.deploy.image}:${tag}`,
      ]);
    } catch {
      return null;
    }
  }

  /** Every tag under this fixture's repository, as the machine lists them. */
  async function tags(journeyRecord: Journey): Promise<string[]> {
    const raw = await docker(journeyRecord.sandbox.path, [
      'image',
      'ls',
      '--format',
      '{{.Tag}}',
      journeyRecord.sandbox.deploy.image,
    ]);
    return raw === '' ? [] : raw.split('\n').filter(Boolean).sort();
  }

  it(
    'rollt einen echten Container aus, prüft die echte Gesundheits-URL und räumt nach A11 auf',
    async () => {
      const run = await journey('gruen');
      const healthUrl = run.sandbox.deploy.healthUrl as string;

      // Drei echte Releases, weil A11s keep-N sonst nichts zu entfernen hat.
      // Der Marker macht sie zu drei *verschiedenen* Images; ohne ihn wäre es
      // ein Image unter drei Namen, und ein Prune schützt sie dann alle.
      const shas = ['gruen-eins', 'gruen-zwei', 'gruen-drei'];
      for (const sha of shas) {
        await setSandboxRelease(run.sandbox.path, sha);
        const task = await deployingTask(run.project.id, `Rollout ${sha}`);
        const result = await service().deploy(task, run.project, sha);

        expect(result.outcome).toBe('deployed');
        expect((await tasks.get(task.id))?.state).toBe('done');
      }

      // Die tragende Zusicherung: nicht „welche Befehle sind abgesetzt worden",
      // sondern was gerade antwortet — und zwar mit Namen.
      const antwort = await ask(healthUrl);
      expect(antwort.status).toBe(200);
      expect(antwort.body).toBe('ok gruen-drei');

      // Und dieselbe Frage an den Daemon: der laufende Container führt genau
      // das Image, das `prepare` für diesen Stand gebaut hat.
      expect(await servingImageId(run)).toBe(await imageId(run, 'gruen-drei'));

      // A11: keep 2, also überleben die beiden jüngsten Releases plus der
      // Zeiger — und das älteste ist wirklich von der Maschine verschwunden.
      expect(await tags(run)).toEqual(['current', 'gruen-drei', 'gruen-zwei']);
      expect(await imageId(run, 'gruen-eins')).toBeNull();

      // Es steht auch im Datensatz, statt nur passiert zu sein (§12).
      const letzte = (await records.forProject(run.project.id))[0];
      expect(letzte?.outcome).toBe('succeeded');
      expect(letzte?.healthOk).toBe(true);
      const geraeumt = await sql<Array<{ payload: { pruned?: string[] } }>>`
        SELECT payload FROM deployment_events
        WHERE deployment_id = ${letzte?.id ?? null} AND kind = 'succeeded'
      `;
      expect(geraeumt[0]?.payload.pruned).toEqual([`${run.sandbox.deploy.image}:gruen-eins`]);
    },
    JOURNEY_TIMEOUT_MS,
  );

  it(
    'rollt ein erzwungen kaputtes Release zurück — und die Gesundheits-URL liefert wieder das gute',
    async () => {
      // Kürzere Zeitgrenze als beim grünen Lauf, aber nicht knapp: der kaputte
      // Container muss wirklich hochkommen und wirklich 503 antworten, sonst
      // beweist der Rollback nur, dass eine URL nicht erreichbar war. Der
      // Datensatz unten sagt, welcher der beiden Fälle eingetreten ist.
      const run = await journey('rollback', { healthTimeoutMs: 15_000 });
      const healthUrl = run.sandbox.deploy.healthUrl as string;

      await setSandboxRelease(run.sandbox.path, 'gut');
      const ersteAufgabe = await deployingTask(run.project.id, 'Gutes Release');
      const erste = await service().deploy(ersteAufgabe, run.project, 'gut');
      expect(erste.outcome).toBe('deployed');
      expect(await ask(healthUrl)).toEqual({ status: 200, body: 'ok gut' });
      const gutesImage = await imageId(run, 'gut');

      // Das erzwungen kaputte Release: derselbe Dienst, derselbe Port, nur
      // nicht gesund. Der Marker bleibt unterscheidbar, damit ein Rollback auf
      // das falsche Release nicht wie der richtige aussieht.
      await plantSeed(run.sandbox.path, 'broken_health');
      await setSandboxRelease(run.sandbox.path, 'kaputt');
      const zweiteAufgabe = await deployingTask(run.project.id, 'Kaputtes Release');
      const zweite = await service().deploy(zweiteAufgabe, run.project, 'kaputt');

      expect(zweite.outcome).toBe('rolled_back');
      const datensatz = await records.get(zweite.deploymentId as string);
      // Der Beweis, dass das kaputte Release wirklich bedient *hat*: eine 503
      // kann nur von ihm gekommen sein, das gute antwortet 200.
      expect(datensatz?.problem).toContain('HTTP 503');
      expect(datensatz?.rolledBackTo).toBe(erste.deploymentId);

      // Das ganze Gate in einer Zeile: nicht „ein Rollback ist protokolliert
      // worden", sondern die Produktion antwortet wieder — und zwar das gute
      // Release, mit Namen.
      expect(await ask(healthUrl)).toEqual({ status: 200, body: 'ok gut' });
      expect(await servingImageId(run)).toBe(gutesImage);

      // §12: der Rollback färbt die Änderung rot und meldet sich beim Betreiber. Die
      // Dringlichkeit ist **P1**, und das ist eine Revision der Spezifikation
      // durch den Betreiber selbst (17.8.2026, A133): P0 bleibt dem Fall vorbehalten, in
      // dem auch der Rollback nicht gesund zurückkam — dort brennt etwas. Hier
      // bedient die Produktion nachweislich wieder das gute Release (die beiden
      // Zusicherungen darüber), also ist nichts offen, was der Betreiber nachts wecken
      // müsste. A96 hatte zuvor P0 ohne Fallunterscheidung gefordert und ist
      // damit überholt; diese Zusicherung stand bis zum 24.8. noch auf jenem
      // Stand und war die einzige rote Stelle im Gate. Die Belege sind
      // mitgeprüft, weil „mit vollen Logs" der Teil des Satzes ist, den eine
      // Karte ohne Inhalt auch erfüllen würde.
      expect((await tasks.get(zweiteAufgabe.id))?.state).toBe('red');
      const karte = (await escalations.open()).find(
        (offen) => offen.source === 'rollback' && offen.projectId === run.project.id,
      );
      expect(karte?.urgency).toBe('P1');
      expect(karte?.context).toContain('HTTP 503');
      expect(karte?.context).toContain('läuft wieder und ist gesund');
    },
    JOURNEY_TIMEOUT_MS,
  );

  it(
    'hält A24s Reihenfolge gegen eine echte Migration: scheitert sie, bedient der alte Container weiter',
    async () => {
      const run = await journey('migration');
      const healthUrl = run.sandbox.deploy.healthUrl as string;

      await setSandboxRelease(run.sandbox.path, 'eins');
      const ersteAufgabe = await deployingTask(run.project.id, 'Erstes Release');
      expect((await service().deploy(ersteAufgabe, run.project, 'eins')).outcome).toBe('deployed');
      const ersteImage = await imageId(run, 'eins');
      expect(await ask(healthUrl)).toEqual({ status: 200, body: 'ok eins' });

      // Eine Migration, die wirklich läuft und wirklich scheitert — kein
      // eingespritztes `run`, weil die Frage hier ist, was die Maschine danach
      // bedient, nicht welche Reihenfolge eine Attrappe protokolliert hat.
      await writeFile(
        join(run.sandbox.path, 'migrate.mjs'),
        'console.error(\'relation "greetings" does not exist\');\nprocess.exit(1);\n',
        'utf8',
      );
      await setSandboxRelease(run.sandbox.path, 'zwei');
      const zweiteAufgabe = await deployingTask(run.project.id, 'Zweites Release');
      const zweite = await service().deploy(
        zweiteAufgabe,
        { ...run.project, deployConfig: { ...run.config, migrateCommand: 'node migrate.mjs' } },
        'zwei',
      );

      expect(zweite.problem).toContain('Migration ist fehlgeschlagen');
      // A24s Asymmetrie, an der Gesundheits-URL abgelesen: ein Rollback stellt
      // *Code* wieder her und kann nichts rückgängig machen, was eine Migration
      // mit den Daten getan hat — also darf nichts getauscht worden sein.
      expect(await ask(healthUrl)).toEqual({ status: 200, body: 'ok eins' });
      expect(await servingImageId(run)).toBe(ersteImage);
      expect((await tasks.get(zweiteAufgabe.id))?.state).toBe('red');

      // Und der Beleg, dass die Migration *nach* dem Bauen lief und nicht
      // davor: das Image für „zwei" existiert, der Zeiger steht schon darauf —
      // nur der Container tut es nicht. Das ist zugleich der Grund, warum
      // „was läuft" am Container abgelesen wird und nie am Zeiger (A87.2).
      const zweiteImage = await imageId(run, 'zwei');
      expect(zweiteImage).not.toBeNull();
      expect(zweiteImage).not.toBe(ersteImage);
      expect(await imageId(run, 'current')).toBe(zweiteImage);
    },
    JOURNEY_TIMEOUT_MS,
  );
});
