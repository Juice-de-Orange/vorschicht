/**
 * Server entry point.
 *
 * Binds to 127.0.0.1 by default (A1): nginx on the host is the only public
 * entry, and the app must not be reachable on any other interface even if a
 * firewall rule is ever wrong.
 */
import { serve } from '@hono/node-server';
import {
  ClaimRegistry,
  ControllingSettings,
  computeDiff,
  DeployRecords,
  DocumentStorage,
  DocumentVault,
  EscalationService,
  EventLog,
  loadConfig,
  MediaTypeExtractor,
  missingMailSettings,
  PersonaSettings,
  ProjectService,
  ReportRecords,
  readTranscript,
  redact,
  SourceAuditLog,
  SourceRegistry,
  TaskAuditLog,
  TaskService,
  TraceReader,
  UsageMeter,
} from '@vorschicht/core';
import { createSql } from '@vorschicht/db';
import { PLAN_PROFILES } from '@vorschicht/shared';
import { MAX_UPLOAD_BYTES } from '@vorschicht/shared/dokumente';
import pino from 'pino';
import { createApp } from './app.js';
import { type AufgabenDeps, anlegenAufgabe, listProjektwahl } from './aufgaben.js';
import { createAuthRoutes } from './auth/routes.js';
import { AuthStore } from './auth/store.js';
import { readSessionCookie } from './auth/tokens.js';
import { getReport, listReports } from './berichte.js';
import { buildBuero } from './buero.js';
import { latestBuildReport } from './build-report.js';
import { getControlling, setPauseMode, setSparbetrieb } from './controlling.js';
import {
  addDocumentVersion,
  getDocument,
  searchDocuments,
  setDocumentTags,
  uploadDocument,
} from './dokumente.js';
import { getEinstellungenSeite, getPersonaSettings, setPersonaMode } from './einstellungen.js';
import { answerEscalation, getInboxCard, listDecisionLog, listInbox } from './inbox.js';
import { listLog } from './log.js';
import { buildOverview } from './overview.js';
import { listProjectSettings, saveProjectGates } from './projects.js';
import { curateSource, getSource, listSources, type QuellenDeps } from './quellen.js';
import { getRun, getTask, getTaskDiff, listTasks, type SpurenDeps } from './spuren.js';
import { SseHub } from './sse.js';

const startedAt = Date.now();

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });
  logger.info({ config: redact(config) }, 'Konfiguration geladen');

  const sql = createSql({ url: config.databaseUrl, max: 10 });
  // A second, single connection: LISTEN occupies it for the process's lifetime,
  // so it must not come out of the request pool.
  const listener = createSql({ url: config.databaseUrl, max: 1 });
  const eventLog = new EventLog(sql);
  const meter = new UsageMeter({ sql, eventLog });
  const sse = new SseHub({
    listener,
    eventLog,
    onError: (err) => logger.error({ err }, 'SSE-Hub'),
  });
  await sse.start();

  const store = new AuthStore(sql);
  // Never cached: §5 makes projects the one mutable table, so a gate set the
  // orchestrator changed since this process started is the current truth.
  const projectService = new ProjectService(sql);
  // §12's release history. Optional on the adapter and fail-safe when absent —
  // and it says which of the two it is (`releaseSource: 'unwired'`), because
  // "this project has no releases" and "this server does not read them" must
  // not look alike on the page (§8.2 Domäne 6).
  const deployments = new DeployRecords(sql);
  // §15's inbox and its decision log. Read and written by the dashboard here;
  // the orchestrator holds its own instance, because answering is a record and
  // resuming the parked session is the scheduler's next tick (A78.8).
  const escalations = new EscalationService({ sql, eventLog });
  // §9/§15s zweite Art blockierter Aufgaben: die, die hinter fremden Claims
  // warten. Ohne diese Verdrahtung zeigt die Übersicht nur die fragenden, und
  // genau das hat die Betriebsprüfung 767db82c gefunden.
  const claims = new ClaimRegistry({
    sql,
    eventLog,
    projects: projectService,
    tasks: new TaskService({ sql, eventLog }),
  });
  // §13's vault. The app is the *writing* side of the docs volume, which is new
  // — until now it was mounted by the orchestrator and the backup sidecar only,
  // so both compose files had to grow an `app` mount and they had to name the
  // same filesystem (the the production host overlay replaces the named volume with a host
  // bind). Uploads landing where `docs.search` and A14's archive cannot see them
  // would be the "row without bytes" this subsystem refuses, one layer up.
  const documents = {
    vault: new DocumentVault(sql),
    storage: new DocumentStorage({ root: config.docsRoot, maxBytes: MAX_UPLOAD_BYTES }),
    // Text, Markdown and PDF — the last through `pdftotext` out of process,
    // which `Dockerfile.app` installs and asserts. On a machine without poppler
    // a PDF is stored, listed and counted as "not read yet" rather than
    // silently absent from search; anything else still is.
    extractor: new MediaTypeExtractor(),
  };

  // §14's registry (§17.7). Reading takes the pool; a curation act takes a
  // transaction carrying both the registry and §19's trail, so a level granted
  // with nothing saying who granted it is not a state this can reach — the seam
  // `SourceRegistry` hands to whoever builds the route (`quellen.ts`, 1 and 2).
  // §17.4's create door. The task and §19's audit row go in **one**
  // transaction (`aufgaben.ts`, decision 3): a task with nothing saying who
  // created it is not a state this can reach. Same arrangement as the registry
  // below, and for the sharper reason — the actor is the only evidence that a
  // human, and which human, put this work into the studio.
  const aufgaben: AufgabenDeps = {
    projekte: async () =>
      (await projectService.listActive()).map((projekt) => ({
        id: projekt.id,
        slug: projekt.slug,
        name: projekt.name,
        readOnly: projekt.readOnly,
      })),
    anlegen: (fn) =>
      sql.begin((tx) => {
        const tasks = new TaskService({ sql: tx, eventLog: new EventLog(tx) });
        const trail = new TaskAuditLog(tx);
        return fn({
          create: async (input) => {
            const record = await tasks.create(input);
            return {
              id: record.id,
              title: record.title,
              state: record.state,
              priority: record.priority,
              projectId: record.projectId,
            };
          },
          audit: (entry) => trail.record(entry),
        });
      }) as ReturnType<typeof fn>,
  };

  const quellen: QuellenDeps = {
    registry: new SourceRegistry(sql),
    curate: (fn) =>
      sql.begin((tx) =>
        fn({ registry: new SourceRegistry(tx), audit: new SourceAuditLog(tx) }),
      ) as ReturnType<typeof fn>,
  };

  // §17.4's trace explorer (§1 principle 4). Read-only end to end: `TraceReader`
  // has no write on it, and the two functions below open a file and run `git
  // diff`. `transcriptsRoot` is the containment boundary the reader checks the
  // stored path against — it comes from configuration and never from a request.
  const spuren: SpurenDeps = {
    reader: new TraceReader(sql),
    transcriptsRoot: config.transcriptsRoot,
    transkript: (input) => readTranscript(input),
    diff: (input) => computeDiff(input),
  };

  const personas = new PersonaSettings(sql, (message) => logger.warn(message));
  // §17.8's two switches. The pool, like `PersonaSettings`: reading needs no
  // transaction and each write opens its own, so the change and §19's row
  // cannot come apart (`controlling/settings.ts`, decision 1).
  //
  // This process only *writes* the pause. What obeys it is the guardian in the
  // daemon, which reads the same `config` row on its next evaluation — the two
  // are separate containers, so there is no call from here that could stop a
  // session, and there must not appear to be one.
  const controllingSettings = new ControllingSettings(sql, (message) => logger.warn(message));

  const controllingDeps = {
    sql,
    settings: controllingSettings,
    currentSamples: () => meter.currentSamples(),
    betrieb: {
      planProfile: config.planProfile,
      // A7, read from the constant the daemon reads. The daemon used to carry
      // its own copy of this table, which is A81's defect in miniature: two
      // declarations of one fact that agree until somebody edits one. Showing
      // the operator a concurrency the scheduler does not use would be worse than showing
      // none, because he would have no reason to doubt it.
      concurrency: PLAN_PROFILES[config.planProfile].concurrency,
    },
  };

  const secureCookies = config.publicOrigin.startsWith('https://');

  const app = createApp({
    health: {
      startedAt,
      pingDatabase: async () => {
        await sql`SELECT 1`;
      },
    },
    getSession: async (req) => {
      const token = readSessionCookie(req.headers.get('cookie'));
      if (!token) return null;
      const session = await store.findSession(token);
      return session ? { userId: session.credentialId } : null;
    },
    sse,
    overview: () =>
      buildOverview({
        sql,
        currentSamples: () => meter.currentSamples(),
        openDecisions: () => escalations.open(),
        claimBlocked: async () => {
          const projects = await projectService.listActive();
          const alle = await Promise.all(
            projects.map(async (project) =>
              (await claims.blockedTasks(project.id)).map((blocked) => ({
                taskId: blocked.taskId,
                title: blocked.title,
                blockedByTaskId: blocked.blockedBy.taskId,
                blockedByTitle: blocked.blockedBy.title,
              })),
            ),
          );
          return alle.flat();
        },
      }),
    build: () => latestBuildReport(sql),
    // §18s Log-Explorer. Nur lesend — `listLog` hat keine schreibende Methode,
    // und §18 macht `event_log` zur Wahrheitsquelle, die niemand rückwirkend
    // bearbeitet.
    log: (params) => listLog({ sql }, params),
    // §17.2. The persona switch travels with the room because the office cannot
    // draw a single desk without it (§8's "fully disabled" decides every name on
    // the page), and two round trips for one view is two chances to render a
    // roster in a mode the server never stored — `getPersonaSettings`' reason,
    // one page over.
    buero: () => buildBuero({ sql, personaMode: () => personas.mode() }),
    projects: {
      list: () => listProjectSettings({ projects: projectService, deployments }),
      saveGates: (id, input, actor) =>
        saveProjectGates({ projects: projectService, deployments }, id, input, actor),
    },
    inbox: {
      open: () => listInbox({ escalations }),
      byNumber: (nummer) => getInboxCard({ escalations }, nummer),
      answer: (nummer, input, actor) => answerEscalation({ escalations }, nummer, input, actor),
      decisions: (limit) => listDecisionLog({ escalations }, limit),
    },
    dokumente: {
      upload: (request) => uploadDocument(documents, request),
      addVersion: (id, request) => addDocumentVersion(documents, id, request),
      get: (id) => getDocument(documents, id),
      setTags: (id, input, actor) => setDocumentTags(documents, id, input, actor),
      search: (params) => searchDocuments(documents, params),
    },
    aufgaben: {
      projektwahl: () => listProjektwahl(aufgaben),
      anlegen: (input, actor) => anlegenAufgabe(aufgaben, input, actor),
    },
    quellen: {
      list: (params) => listSources(quellen, params),
      get: (id) => getSource(quellen, id),
      curate: (id, segment, input, actor) => curateSource(quellen, id, segment, input, actor),
    },
    // §17.4's trace explorer. `TraceReader` takes the pool — it writes nothing,
    // by construction, so there is no transaction to hold and no act that could
    // need one. `readTranscript` and `computeDiff` are passed as functions
    // rather than reached for inside the adapter, which is what lets a test
    // drive all five availability answers without staging a filesystem for each.
    // §16s Archiv. `ReportRecords` bekommt den Pool: es schreibt nichts, also
    // gibt es keine Transaktion zu halten — dieselbe Ueberlegung wie bei
    // `TraceReader` eine Zeile weiter unten.
    berichte: {
      list: () => listReports({ reports: new ReportRecords(sql) }),
      get: (periode) => getReport({ reports: new ReportRecords(sql) }, periode),
    },
    spuren: {
      list: (params) => listTasks(spuren, params),
      task: (id) => getTask(spuren, id),
      diff: (id) => getTaskDiff(spuren, id),
      run: (id, params) => getRun(spuren, id, params),
    },
    // §17.9. `PersonaSettings` takes the pool: reading needs no transaction and
    // the write opens its own, so that the change and §19's row cannot come
    // apart (`personas/settings.ts`, decision 1).
    einstellungen: {
      // §17.9s ganze Seite. Die Kanäle werden **hier** aus der geladenen
      // Konfiguration abgeleitet und ohne jedes Geheimnis weitergereicht: §19
      // hält `ntfyToken` und `smtpPassword` aus jedem Transport, und
      // `missingMailSettings` ist dieselbe Regel, nach der `createMailer`
      // entscheidet — eine zweite Lesart wäre eine Seite, die einen Kanal als
      // einsatzbereit meldet, während `DisabledMailer` jede Erinnerung
      // verschluckt.
      getSeite: () =>
        getEinstellungenSeite({
          mode: () => personas.mode(),
          setMode: (mode, actor) => personas.setMode(mode, actor),
          roster: () => personas.roster(),
          sql,
          betrieb: controllingDeps.betrieb,
          benachrichtigungen: {
            ntfy: {
              server: config.ntfyServer,
              themen: {
                inbox: config.ntfyTopicInbox,
                alerts: config.ntfyTopicAlerts,
                info: config.ntfyTopicInfo,
              },
              tokenGesetzt: config.ntfyToken.length > 0,
            },
            mail: {
              host: config.smtpHost ?? null,
              port: config.smtpPort ?? null,
              secure: config.smtpSecure ?? true,
              absender: config.smtpFrom ?? null,
              empfaenger: config.reportRecipient ?? null,
              passwortGesetzt: (config.smtpPassword ?? '').length > 0,
              einsatzbereit: missingMailSettings(config).length === 0,
            },
            ruhezeiten: false,
          },
        }),
      get: () => getPersonaSettings(personas),
      setPersonas: (input, actor) => setPersonaMode(personas, input, actor),
    },
    // §17.8. `betrieb` is what the *daemon* runs with, and it is read from the
    // same configuration the daemon reads rather than recomputed here: a number
    // derived twice agrees until somebody changes one of the two, and the whole
    // point of showing it is that the operator can trust it.
    controlling: {
      get: () => getControlling(controllingDeps),
      setPause: (input, actor) => setPauseMode(controllingDeps, input, actor),
      setSparbetrieb: (input, actor) => setSparbetrieb(controllingDeps, input, actor),
    },
    // The built PWA sits beside the server bundle in the image.
    staticRoot: new URL('../public', import.meta.url).pathname,
    authRoutes: createAuthRoutes({
      store,
      rpId: config.webauthnRpId,
      rpName: config.webauthnRpName,
      origin: config.publicOrigin,
      secureCookies,
    }),
  });

  // Expired challenges and long-dead invites accumulate otherwise; nothing here
  // is load-bearing, so failures are logged and forgotten.
  setInterval(
    () =>
      void store.pruneExpired().catch((err) => logger.warn({ err }, 'Aufräumen fehlgeschlagen')),
    60 * 60_000,
  ).unref();

  const server = serve({ fetch: app.fetch, hostname: config.appBind, port: config.appPort }, (i) =>
    logger.info(`Vorschicht hört auf http://${i.address}:${i.port}`),
  );

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Fahre herunter');
    server.close(() => {
      void sse
        .stop()
        .then(() => Promise.all([sql.end(), listener.end()]))
        .then(() => process.exit(0));
    });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
