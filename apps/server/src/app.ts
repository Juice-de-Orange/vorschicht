/**
 * Hono application.
 *
 * The route policy comes straight from the Phase 0 exit gate: `/healthz` is
 * reachable without a session, and **everything else answers 401 until a
 * passkey session exists**. That is enforced here by a default-deny middleware
 * with an explicit public allowlist, rather than by remembering to guard each
 * new route — the failure mode of the opposite arrangement is a route that
 * quietly ships unauthenticated.
 */
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { type Context, Hono } from 'hono';
// The one adapter whose result union is imported rather than restated here.
// `VaultRouteResult` and `SourceRouteResult` above are declared locally and
// happen to line up with what their adapters return; that is two declarations of
// one shape, which is the arrangement A81 is about. `spuren.ts` emits no runtime
// import beyond `@vorschicht/shared/spuren`, so this costs nothing at load.
import type { BerichteResult } from './berichte.js';
import { buildHealthReport, type HealthDeps } from './health.js';
import { SPUREN_STATUS, type SpurenRouteResult } from './spuren.js';

/** Paths reachable without a session. Deliberately tiny and explicit. */
export const PUBLIC_PATHS = new Set(['/healthz']);

/** Path prefixes that serve the bootstrap/login ceremony (§19). */
export const PUBLIC_PREFIXES = ['/api/auth/'];

export interface Session {
  userId: string;
}

/** What an upload route hands the vault adapter. */
export interface VaultUpload {
  params: URLSearchParams;
  contentType: string | null;
  contentLength: string | null;
  body: ReadableStream<Uint8Array> | null;
  actor: string;
}

/**
 * The vault's five outcomes (§13).
 *
 * Declared here as data rather than imported, so this layer keeps the one
 * property it must have: it is transport and knows no rule. The mapping to
 * status codes is `VAULT_STATUS` below, and it is a table rather than a chain of
 * `if`s so that a sixth reason is a compile error instead of a silent 500.
 */
export type VaultRefusal = 'invalid' | 'unsupported_media' | 'too_large' | 'unknown' | 'failed';

export type VaultRouteResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: VaultRefusal; errors: string[] };

/**
 * 415 and 413 rather than this house's usual 422, and the house rule is what
 * says so: 422 is for a body that parsed and a rule that then declined it.
 * Neither of these ever parsed a body — one refuses the envelope from a header,
 * the other stops mid-stream — and HTTP names both cases exactly. `failed` is a
 * server fault that still answers in German rather than as a naked stack, which
 * matters because this app has no `app.onError`.
 */
export const VAULT_STATUS: Record<VaultRefusal, 404 | 413 | 415 | 422 | 500> = {
  invalid: 422,
  unsupported_media: 415,
  too_large: 413,
  unknown: 404,
  failed: 500,
};

/**
 * Creating a task (§17.4). Same posture as the vault and the registry: the
 * adapter answers with a result union and the whole body, this layer picks a
 * code. Three refusals and no `failed` — there is nothing here that can half
 * succeed, because the task and §19's row are one transaction.
 *
 * 409 rather than 422 for a read-only project, and the house rule is what says
 * so: 422 is for a body that parsed and a rule that then declined it. A project
 * that takes no work is nothing the caller can fix by editing what they sent.
 */
export type AufgabenRefusalCode = 'invalid' | 'unknown' | 'conflict';

export type AufgabenRouteResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: AufgabenRefusalCode; errors: string[] };

export const AUFGABEN_STATUS: Record<AufgabenRefusalCode, 404 | 409 | 422> = {
  invalid: 422,
  unknown: 404,
  conflict: 409,
};

/**
 * §14's registry (§17.7). Same posture as the vault: the adapter answers with a
 * result union and the whole body, this layer only picks a code.
 */
export type SourceRefusal = 'invalid' | 'unknown' | 'conflict' | 'failed';

export type SourceRouteResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: SourceRefusal; errors: string[] };

/**
 * 409 rather than this house's usual 422 for one of the four, and the house rule
 * is what says so: 422 is for a body that parsed and a rule that then declined
 * it. A curation refused because the source is no longer in the state the page
 * showed is nothing the caller can fix by editing what they sent — the same
 * distinction `/api/posteingang/:nummer/antwort` already draws between "that is
 * not an answer" and "this was already decided".
 */
export const SOURCE_STATUS: Record<SourceRefusal, 404 | 409 | 422 | 500> = {
  invalid: 422,
  unknown: 404,
  conflict: 409,
  failed: 500,
};

/**
 * §17.9's settings. Same posture again, with one refusal fewer.
 *
 * There is no `unknown`: there is exactly one settings document and it always
 * exists, because a missing row is the default rather than an absence (0022
 * decision 3). And no `conflict`: nothing here is decided once, so there is no
 * stale page to protect against — submitting the mode that is already set is a
 * legitimate act and is recorded as one (`PersonaSettings`, decision 3).
 */
/**
 * §18s Log-Explorer kennt genau eine Verweigerung: der Server konnte nicht
 * lesen. Deklariert wie die übrigen als Daten, damit eine zweite Ursache ein
 * Compilerfehler wäre und kein stiller 500.
 */
export type LogRefusal = { ok: false; reason: 'failed'; errors: string[] };

export type SettingsRefusal = 'invalid' | 'failed';

export type SettingsRouteResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: SettingsRefusal; errors: string[] };

export const SETTINGS_STATUS: Record<SettingsRefusal, 422 | 500> = {
  invalid: 422,
  failed: 500,
};

/**
 * §17.8's Controlling page. The same two refusals as the settings page, for the
 * same two reasons: there is exactly one Controlling document and a missing
 * `config` row is a default rather than an absence (0022 decision 3), so no
 * `unknown`; and nothing here is decided once, so no `conflict` — submitting the
 * pause position that is already set is a legitimate act and is recorded as one
 * (`ControllingSettings`, following `PersonaSettings` decision 3).
 */
export type ControllingRefusal = 'invalid' | 'failed';

export type ControllingRouteResult =
  | { ok: true; value: unknown }
  | { ok: false; reason: ControllingRefusal; errors: string[] };

export const CONTROLLING_STATUS: Record<ControllingRefusal, 422 | 500> = {
  invalid: 422,
  failed: 500,
};

export interface AppDeps {
  health: HealthDeps;
  /** Resolves the session for a request, or null. */
  getSession: (req: Request) => Promise<Session | null>;
  /** The WebAuthn routes, mounted under /api/auth. Optional so tests stay small. */
  authRoutes?: Hono;
  /** Live event stream. Registered after the default-deny guard, so it needs a session. */
  sse?: { handle: (lastEventId: string | null) => Response };
  /** Everything the overview page needs, in one request (§17.1). */
  overview?: () => Promise<unknown>;
  /** The build's own progress — what it is working on and what it wants. */
  build?: () => Promise<unknown>;
  /**
   * The office view's snapshot (§17.2).
   *
   * One request for the whole room; the changes then arrive over `/events` and
   * the page patches its own copy. It answers the payload directly rather than a
   * result union because there is nothing here a caller can get wrong: no body,
   * no path parameter, no rule to decline — the same reason `overview` and
   * `build` are shaped this way and `dokumente` is not.
   */
  buero?: () => Promise<unknown>;
  /**
   * The projects page (§17.3) and its gate checkboxes (§11).
   *
   * `saveGates` returns a result rather than throwing on a refused document:
   * §11 rejecting a configuration is an ordinary answer with a status code of
   * its own, not an exception. Modelling it as one here would push the mapping
   * into a `catch` that has to recognise an error class — and this layer is
   * transport, so it must not know what §11 is.
   */
  projects?: {
    list: () => Promise<unknown>;
    saveGates: (
      id: string,
      input: unknown,
      actor: string,
    ) => Promise<
      | { ok: true; project: unknown }
      | { ok: false; reason: 'invalid' | 'unknown'; errors?: string[] }
    >;
  };
  /**
   * The escalation inbox and the decision log (§15, §17.5).
   *
   * Same posture as `projects`: the adapter answers with a result union and this
   * layer maps it to a status code, so the route stays transport and never
   * imports §15's rules. Three outcomes rather than two, because "already
   * decided" and "that is not an answer" are different things — the first is a
   * conflict a caller cannot fix, the second is a form they can.
   */
  inbox?: {
    open: () => Promise<unknown>;
    byNumber: (
      nummer: number,
    ) => Promise<{ ok: true; escalation: unknown } | { ok: false; reason: 'unknown' }>;
    answer: (
      nummer: number,
      input: unknown,
      actor: string,
    ) => Promise<
      | { ok: true; escalation: unknown }
      | { ok: false; reason: 'unknown' }
      | { ok: false; reason: 'conflict'; errors: string[]; escalation: unknown }
      | { ok: false; reason: 'invalid'; errors: string[] }
    >;
    decisions: (limit: number | null) => Promise<unknown>;
  };
  /**
   * §13's document vault (§17.6).
   *
   * Same posture as `projects` and `inbox` — a result union this layer maps to
   * a status code — with one difference that is deliberate rather than
   * inconsistent: the adapter answers with the **whole body**, envelope key
   * included, and the route only picks the code. The inbox routes write
   * `{ posteingang: … }` here while `@vorschicht/shared/inbox` declares the same
   * key, which is one literal in two places; A81 is the entry about what that
   * costs, so the newer surface does not repeat it.
   *
   * `body` is the request's own stream. It is passed through rather than
   * buffered because the size limit has to be enforced against the bytes that
   * arrive, not after they have all arrived — see `@vorschicht/shared/dokumente`
   * for why an upload here is a raw body and not a multipart form.
   */
  dokumente?: {
    upload: (request: VaultUpload) => Promise<VaultRouteResult>;
    addVersion: (id: string, request: VaultUpload) => Promise<VaultRouteResult>;
    get: (id: string) => Promise<VaultRouteResult>;
    setTags: (id: string, input: unknown, actor: string) => Promise<VaultRouteResult>;
    search: (params: URLSearchParams) => Promise<VaultRouteResult>;
  };
  /**
   * §14's source registry (§17.7).
   *
   * `curate` carries the act's own path segment rather than four methods, for
   * the reason `quellen.ts` gives: the four acts differ only in the submission
   * they take, and four route handlers would be four places for §19's audit row
   * to be forgotten in. An unrecognised segment is the adapter's `unknown`,
   * which this layer answers as a 404 — a route that does not exist rather than
   * a body that is wrong.
   */
  /**
   * §17.4's other half: the place a task is **created**.
   *
   * Until this existed a task could only appear as a side effect — an audit
   * finding, an idle audit, a radar scan — so the studio could only ever do
   * work it had assigned itself. §17.1 has the operator entering goals and §8 has the
   * Product Lead decomposing them; neither is built, and `goals` is an entity
   * in §5 with no table. This is the smaller half and the one a pilot needs.
   */
  aufgaben?: {
    projektwahl: () => Promise<AufgabenRouteResult>;
    anlegen: (input: unknown, actor: string) => Promise<AufgabenRouteResult>;
  };
  quellen?: {
    list: (params: URLSearchParams) => Promise<SourceRouteResult>;
    get: (id: string) => Promise<SourceRouteResult>;
    curate: (
      id: string,
      segment: string | undefined,
      input: unknown,
      actor: string,
    ) => Promise<SourceRouteResult>;
  };
  /**
   * §17.4's task and trace explorer — §1 principle 4's chain, made readable.
   *
   * Read-only, so the result union is narrower than every other adapter here:
   * there is no `invalid` and no `conflict`, because nothing is submitted. What
   * it does carry is `unknown` for an id that names nothing, which includes an
   * id that is not a uuid — refused before it reaches a query, so a mistyped
   * permalink is a 404 rather than a Postgres cast error dressed up as a 500.
   */
  /**
   * §16s Archiv (§17). Nur Lesen — der Erzeuger sitzt im Daemon, und ein
   * zweiter waere eine zweite Stelle, an der derselbe Zeitraum abgeleitet wird.
   */
  berichte?: {
    list: () => Promise<BerichteResult<unknown>>;
    get: (periode: string | undefined) => Promise<BerichteResult<unknown>>;
  };
  spuren?: {
    list: (params: URLSearchParams) => Promise<SpurenRouteResult>;
    task: (id: string | undefined) => Promise<SpurenRouteResult>;
    diff: (id: string | undefined) => Promise<SpurenRouteResult>;
    run: (id: string | undefined, params: URLSearchParams) => Promise<SpurenRouteResult>;
  };
  /**
   * §18s Log-Explorer.
   *
   * Read-only and with the narrowest result union on this surface: nothing is
   * submitted and nothing is addressed, because `parseLogFilter` turns every
   * unusable input into "no filter" rather than into a refusal. So there is no
   * `invalid`, no `unknown` and no `conflict` — only the server fault, which
   * still answers in German rather than as a naked stack.
   */
  log?: (params: URLSearchParams) => Promise<{ ok: true; value: unknown } | LogRefusal>;
  /**
   * §17.9's settings — today §8's persona switch, tomorrow the rest of §5's
   * `config` entity (concurrency, model mapping, Sparbetrieb, notifications).
   *
   * Both calls answer the *whole* payload rather than an acknowledgement, for
   * `einstellungen.ts`'s reason: the mode decides how every name on that page is
   * rendered, so a page that redrew from what it hoped it had sent could show a
   * roster in a mode the server never stored.
   */
  einstellungen?: {
    /**
     * §17.9s ganze Seite in einer Antwort: Personas, Tarifprofil, §16s Kanäle,
     * §18s Sicherungsstand, §19s Prüfprotokoll.
     *
     * **Pflicht**, anders als `projects.deployments`, und der Unterschied ist
     * begründet: dort gibt es zwei Prozesse, die getrennt verdrahtet werden, und
     * die Seite sagt deshalb, welchen der beiden Zustände sie zeigt. Hier gibt
     * es genau einen Aufrufer, also wäre ein optionaler Adapter ein Rückfallweg,
     * den nichts je fährt — und ein Zweig, den kein Test erreichen kann, liest
     * sich wie Abdeckung (§8.2 Domäne 6).
     */
    getSeite: () => Promise<SettingsRouteResult>;
    get: () => Promise<SettingsRouteResult>;
    setPersonas: (input: unknown, actor: string) => Promise<SettingsRouteResult>;
  };
  /**
   * §17.8's Controlling page: the budget, and A26's and A22's switches.
   *
   * Both writes answer the *whole* payload rather than an acknowledgement, and
   * here that is not merely the house pattern: the guardian's state is a
   * consequence of the pause, so a page redrawing from what it hoped it had sent
   * could show "Pause" above a guardian line still reading Normalbetrieb, and a
   * reader would not know which of the two to believe.
   */
  controlling?: {
    get: () => Promise<ControllingRouteResult>;
    setPause: (input: unknown, actor: string) => Promise<ControllingRouteResult>;
    setSparbetrieb: (input: unknown, actor: string) => Promise<ControllingRouteResult>;
  };
  /**
   * Directory holding the built PWA.
   *
   * The app *shell* is served publicly; the data behind it is not. That is not
   * a hole in the default-deny policy but the precondition for it: the login
   * and registration ceremony happens in a browser, so the page carrying it has
   * to load before anyone has a session. §19's compensating controls — WebAuthn,
   * rate limiting, the audit log — guard the API, which stays closed.
   *
   * Without this the deny guard answers 401 to every browser request and the
   * passkey bootstrap is unreachable, which is exactly what happened.
   */
  staticRoot?: string;
}

/** Paths that belong to the API rather than the single-page app. */
const API_PREFIXES = ['/api/', '/events', '/healthz'];

export function isAppShellPath(path: string): boolean {
  return !API_PREFIXES.some(
    (prefix) => path === prefix.replace(/\/$/, '') || path.startsWith(prefix),
  );
}

export function isPublicPath(path: string): boolean {
  if (PUBLIC_PATHS.has(path)) return true;
  return PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * Who made this change, for §19's trail.
 *
 * The session, never a constant. `ProjectService.setGateConfig` defaults its
 * actor to `'system'`, which is right for the daemon and wrong here: an audit
 * log in which every attempt to unpick a locked gate was made by `system`
 * answers *that* something was tried and loses *who* tried it, which is the
 * question the trail exists for. The prefix names the channel, because the
 * same project is also configured by onboarding and by the daemon.
 *
 * The route is behind the default-deny guard, so a missing session here would
 * be a bug in that guard rather than an anonymous caller — recorded as such
 * instead of silently becoming `system`.
 */
export function sessionActor(c: { get: (key: never) => unknown }): string {
  const session = c.get('session' as never) as Session | undefined;
  return session?.userId ? `dashboard:${session.userId}` : 'dashboard:unbekannt';
}

/** German (§2). One wording, so a page can recognise the case. */
const INBOX_NOT_FOUND = 'Posteingangs-Eintrag nicht gefunden';

/**
 * The `#X` in a path, or null.
 *
 * Deliberately strict — digits only, no sign, no decimal point, nothing `Number`
 * would helpfully coerce. §15's number comes from a sequence, so anything else
 * names no item, and answering 404 rather than reaching the database keeps a
 * malformed path from becoming a query. `+1`, `1.0` and `1e3` are refused for
 * the same reason: they would address the same row under three spellings, and
 * the deep links in every notification use exactly one.
 */
export function parseItemNumber(raw: string | undefined): number | null {
  if (!raw || !/^\d+$/.test(raw)) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

/**
 * A `?limit=` query, or null when the caller did not usefully say.
 *
 * Null means "use the default" — clamping lives with the adapter that knows what
 * the default is, so this layer never invents a number of its own.
 */
export function parseLimit(raw: string | undefined): number | null {
  if (!raw) return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get('/healthz', async (c) => {
    const report = await buildHealthReport(deps.health);
    return c.json(report, report.status === 'ok' ? 200 : 503);
  });

  // Mounted before the default-deny middleware: the auth ceremony is how a
  // caller *gets* a session, so it cannot require one.
  if (deps.authRoutes) app.route('/api/auth', deps.authRoutes);

  // The app shell, likewise before the guard. Hashed asset filenames are served
  // as-is; every other non-API GET returns index.html so client-side routes
  // like /registrieren survive a reload or a pasted link.
  if (deps.staticRoot) {
    const root = deps.staticRoot;
    app.get('*', async (c, next) => {
      if (c.req.method !== 'GET' || !isAppShellPath(new URL(c.req.url).pathname)) return next();
      const served = await serveShell(root, new URL(c.req.url).pathname);
      return served ?? next();
    });
  }

  // Default deny. Registered after /healthz so the health route is never
  // affected, and before every other route so nothing can slip past it.
  app.use('*', async (c, next) => {
    if (isPublicPath(new URL(c.req.url).pathname)) return next();
    const session = await deps.getSession(c.req.raw);
    if (!session) {
      return c.json({ error: 'nicht angemeldet' }, 401);
    }
    c.set('session' as never, session as never);
    return next();
  });

  app.get('/api/me', (c) => c.json({ session: c.get('session' as never) ?? null }));

  if (deps.overview) {
    const overview = deps.overview;
    app.get('/api/overview', async (c) => c.json((await overview()) as object));
  }

  if (deps.build) {
    const build = deps.build;
    app.get('/api/build', async (c) => c.json((await build()) as object));
  }

  if (deps.buero) {
    const buero = deps.buero;
    app.get('/api/buero', async (c) => c.json({ buero: await buero() }));
  }

  if (deps.projects) {
    const projects = deps.projects;
    app.get('/api/projekte', async (c) => c.json({ projekte: await projects.list() }));

    // PUT rather than PATCH: the body *is* the whole gate document. A partial
    // update would make "the box I did not send" ambiguous between "unchanged"
    // and "unticked", and unticking is precisely the operation §11 refuses —
    // so the one shape that must never be ambiguous is the one this route
    // carries.
    app.put('/api/projekte/:id/gates', async (c) => {
      const body = await c.req.json().catch(() => null);
      const result = await projects.saveGates(c.req.param('id'), body, sessionActor(c));
      if (result.ok) return c.json({ projekt: result.project });
      if (result.reason === 'unknown') return c.json({ error: 'Projekt nicht gefunden' }, 404);
      // 422 and not 400: the document parsed, and §11 declined it. Every reason
      // travels, because `validateProjectGateConfig` deliberately returns them
      // all and a form that reveals one mistake per submission is a form nobody
      // finishes.
      return c.json({ errors: result.errors ?? [] }, 422);
    });
  }

  if (deps.inbox) {
    const inbox = deps.inbox;

    app.get('/api/posteingang', async (c) => c.json({ posteingang: await inbox.open() }));

    app.get('/api/posteingang/:nummer', async (c) => {
      const nummer = parseItemNumber(c.req.param('nummer'));
      if (nummer === null) return c.json({ error: INBOX_NOT_FOUND }, 404);
      const result = await inbox.byNumber(nummer);
      if (!result.ok) return c.json({ error: INBOX_NOT_FOUND }, 404);
      return c.json({ eskalation: result.escalation });
    });

    // POST rather than PUT: an answer is written once and never revised (§15,
    // A77.8). A PUT would promise idempotence over exactly the operation the
    // database refuses to repeat.
    app.post('/api/posteingang/:nummer/antwort', async (c) => {
      const nummer = parseItemNumber(c.req.param('nummer'));
      if (nummer === null) return c.json({ error: INBOX_NOT_FOUND }, 404);
      const body = await c.req.json().catch(() => null);
      const result = await inbox.answer(nummer, body, sessionActor(c));
      if (result.ok) return c.json({ eskalation: result.escalation });
      if (result.reason === 'unknown') return c.json({ error: INBOX_NOT_FOUND }, 404);
      // 409 and not 422: nothing the caller sends will be accepted, because the
      // decision has already been injected into the resumed session (§6.4). The
      // answered card travels with the refusal so the page can show what it was.
      if (result.reason === 'conflict') {
        return c.json({ errors: result.errors, eskalation: result.escalation }, 409);
      }
      // 422 and not 400: the body parsed, and §15 declined what it said.
      return c.json({ errors: result.errors }, 422);
    });

    app.get('/api/entscheidungen', async (c) =>
      c.json({ entscheidungen: await inbox.decisions(parseLimit(c.req.query('limit'))) }),
    );
  }

  if (deps.dokumente) {
    const dokumente = deps.dokumente;

    const answer = (c: Context, result: VaultRouteResult) =>
      result.ok
        ? c.json(result.value as object)
        : c.json({ errors: result.errors }, VAULT_STATUS[result.reason]);

    const upload = (c: Context): VaultUpload => ({
      params: new URL(c.req.url).searchParams,
      contentType: c.req.header('content-type') ?? null,
      contentLength: c.req.header('content-length') ?? null,
      // The stream, never `await c.req.arrayBuffer()`: buffering here would put
      // the whole document in this process's heap before the cap could look at
      // it, which is the failure the cap exists to prevent.
      body: c.req.raw.body,
      actor: sessionActor(c),
    });

    app.post('/api/dokumente', async (c) => answer(c, await dokumente.upload(upload(c))));

    // Registered **before** `/:id`: Hono matches in registration order, and
    // `suche` is a literal segment where a document id would otherwise go.
    app.get('/api/dokumente/suche', async (c) =>
      answer(c, await dokumente.search(new URL(c.req.url).searchParams)),
    );

    app.get('/api/dokumente/:id', async (c) => answer(c, await dokumente.get(c.req.param('id'))));

    app.post('/api/dokumente/:id/versionen', async (c) =>
      answer(c, await dokumente.addVersion(c.req.param('id'), upload(c))),
    );

    // PUT rather than PATCH, for `/api/projekte/:id/gates`' reason: the body is
    // the whole tag set, and "the tag I did not send" must not be ambiguous
    // between "unchanged" and "removed".
    app.put('/api/dokumente/:id/schlagworte', async (c) => {
      const body = await c.req.json().catch(() => null);
      return answer(c, await dokumente.setTags(c.req.param('id'), body, sessionActor(c)));
    });
  }

  if (deps.aufgaben) {
    const aufgaben = deps.aufgaben;

    const answerTask = (c: Context, result: AufgabenRouteResult) =>
      result.ok
        ? c.json(result.value as object)
        : c.json({ errors: result.errors }, AUFGABEN_STATUS[result.reason]);

    // The select on the form. Its own route rather than a field on
    // `/api/projekte`, because that payload is the projects *page* — §17.3's
    // gate checkboxes, claims and releases — and a form that had to load all of
    // it to fill a dropdown would couple two pages that share nothing else.
    app.get('/api/aufgaben/projektwahl', async (c) => answerTask(c, await aufgaben.projektwahl()));

    app.post('/api/aufgaben', async (c) => {
      const body = await c.req.json().catch(() => null);
      return answerTask(c, await aufgaben.anlegen(body, sessionActor(c)));
    });
  }

  if (deps.quellen) {
    const quellen = deps.quellen;

    const answerSource = (c: Context, result: SourceRouteResult) =>
      result.ok
        ? c.json(result.value as object)
        : c.json({ errors: result.errors }, SOURCE_STATUS[result.reason]);

    app.get('/api/quellen', async (c) =>
      answerSource(c, await quellen.list(new URL(c.req.url).searchParams)),
    );

    app.get('/api/quellen/:id', async (c) => answerSource(c, await quellen.get(c.req.param('id'))));

    // POST rather than PUT: a curation act is appended to §14's log, never
    // overwritten (0021), so promising idempotence over it would promise the one
    // thing the append-only table cannot do.
    app.post('/api/quellen/:id/:akt', async (c) => {
      const body = await c.req.json().catch(() => null);
      return answerSource(
        c,
        await quellen.curate(c.req.param('id'), c.req.param('akt'), body, sessionActor(c)),
      );
    });
  }

  if (deps.berichte) {
    const berichte = deps.berichte;

    // Nur GET: §16s Bericht entsteht im Daemon (`report-pass.ts`), und ein
    // zweiter Erzeuger fuer dieselbe Zeile liefe beim ersten Sonderfall
    // auseinander — die Begruendung steht in `berichte.ts`.
    const answerReport = (c: Context, result: BerichteResult<unknown>) =>
      result.ok
        ? c.json(result.value as object)
        : c.json({ errors: result.errors }, result.reason === 'unknown' ? 404 : 500);

    app.get('/api/berichte', async (c) => answerReport(c, await berichte.list()));

    // Der Zeitraumbeginn ist der Schluessel (0024: `UNIQUE (period_start)`) und
    // damit die stabilere Adresse als eine uuid: derselbe Bericht ist unter
    // demselben Pfad erreichbar, auch wenn er neu erzeugt werden musste.
    app.get('/api/berichte/:periode', async (c) =>
      answerReport(c, await berichte.get(c.req.param('periode'))),
    );
  }

  if (deps.spuren) {
    const spuren = deps.spuren;

    const answerTrace = (c: Context, result: SpurenRouteResult) =>
      result.ok
        ? c.json(result.value as object)
        : c.json({ errors: result.errors }, SPUREN_STATUS[result.reason]);

    app.get('/api/aufgaben', async (c) =>
      answerTrace(c, await spuren.list(new URL(c.req.url).searchParams)),
    );

    app.get('/api/aufgaben/:id', async (c) => answerTrace(c, await spuren.task(c.req.param('id'))));

    // Its own route rather than a field on the task payload: it shells out to
    // git, and a timeline nobody scrolls should not pay for a diff nobody asked
    // for (`spuren.ts`, decision 3).
    app.get('/api/aufgaben/:id/diff', async (c) =>
      answerTrace(c, await spuren.diff(c.req.param('id'))),
    );

    // A run is addressed on its own, not below its task: §22's office view links
    // straight to a dot's run, and having to know which task it served in order
    // to name it would put a join in front of every link.
    app.get('/api/laeufe/:id', async (c) =>
      answerTrace(c, await spuren.run(c.req.param('id'), new URL(c.req.url).searchParams)),
    );
  }

  if (deps.log) {
    const log = deps.log;
    app.get('/api/log', async (c) => {
      const result = await log(new URL(c.req.url).searchParams);
      return result.ok ? c.json(result.value as object) : c.json({ errors: result.errors }, 500);
    });
  }

  if (deps.einstellungen) {
    const einstellungen = deps.einstellungen;

    const answerSettings = (c: Context, result: SettingsRouteResult) =>
      result.ok
        ? c.json(result.value as object)
        : c.json({ errors: result.errors }, SETTINGS_STATUS[result.reason]);

    // Die ganze Seite zuerst, ihr Ausschnitt darunter — die Reihenfolge des
    // Dokuments, nicht eine Notwendigkeit: Hono unterscheidet die beiden Pfade
    // eindeutig.
    app.get('/api/einstellungen', async (c) => answerSettings(c, await einstellungen.getSeite()));

    app.get('/api/einstellungen/personas', async (c) =>
      answerSettings(c, await einstellungen.get()),
    );

    // PUT rather than POST: the body is the whole setting and sending it twice
    // must mean what sending it once meant. `config` is mutable by design (0022),
    // so idempotence is a promise this route can actually keep — unlike
    // `/api/quellen/:id/:akt`, which appends to an append-only log.
    app.put('/api/einstellungen/personas', async (c) => {
      const body = await c.req.json().catch(() => null);
      return answerSettings(c, await einstellungen.setPersonas(body, sessionActor(c)));
    });
  }

  if (deps.controlling) {
    const controlling = deps.controlling;

    const answerControlling = (c: Context, result: ControllingRouteResult) =>
      result.ok
        ? c.json(result.value as object)
        : c.json({ errors: result.errors }, CONTROLLING_STATUS[result.reason]);

    app.get('/api/controlling', async (c) => answerControlling(c, await controlling.get()));

    // PUT for `/api/einstellungen/personas`' reason: the body is the whole
    // setting, `config` is mutable by design (0022), and sending the same
    // position twice must mean what sending it once meant. That matters more
    // here than anywhere else on this surface — a pause resubmitted by a
    // double-click must not become two different states of the studio.
    app.put('/api/controlling/pause', async (c) => {
      const body = await c.req.json().catch(() => null);
      return answerControlling(c, await controlling.setPause(body, sessionActor(c)));
    });

    app.put('/api/controlling/sparbetrieb', async (c) => {
      const body = await c.req.json().catch(() => null);
      return answerControlling(c, await controlling.setSparbetrieb(body, sessionActor(c)));
    });
  }

  if (deps.sse) {
    const sse = deps.sse;
    app.get('/events', (c) =>
      // The browser resends Last-Event-ID automatically on reconnect; the query
      // parameter is for callers that cannot set headers.
      sse.handle(c.req.header('last-event-id') ?? c.req.query('lastEventId') ?? null),
    );
  }

  return app;
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Serve a file from the built PWA, falling back to the app shell.
 *
 * Path traversal is refused by resolving and checking containment rather than
 * by pattern-matching `..`: this handler is reachable without a session, so it
 * is the one place in the app where an unauthenticated caller picks the path.
 */
async function serveShell(root: string, pathname: string): Promise<Response | null> {
  const base = resolve(root);
  const candidate = resolve(join(base, normalize(pathname)));

  if (candidate === base || candidate.startsWith(`${base}/`)) {
    try {
      const info = await stat(candidate);
      if (info.isFile()) {
        const body = await readFile(candidate);
        const type = CONTENT_TYPES[extname(candidate)] ?? 'application/octet-stream';
        // Hashed asset names may be cached hard; index.html must not be, or a
        // deploy leaves browsers on the previous shell.
        const cache = candidate.includes('/assets/')
          ? 'public, max-age=31536000, immutable'
          : 'no-cache';
        return new Response(new Uint8Array(body), {
          headers: { 'content-type': type, 'cache-control': cache },
        });
      }
    } catch {
      // Falls through to the shell.
    }
  }

  try {
    const shell = await readFile(join(base, 'index.html'));
    return new Response(new Uint8Array(shell), {
      headers: { 'content-type': CONTENT_TYPES['.html'] as string, 'cache-control': 'no-cache' },
    });
  } catch {
    return null;
  }
}
