import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type DecisionView,
  decisionLogResponse,
  type EscalationCardView,
  inboxCardResponse,
  inboxListResponse,
} from '@vorschicht/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { createApp, isAppShellPath, isPublicPath } from './app.js';

/** A stand-in for the built PWA, plus a secret next door to aim traversal at. */
const shellRoot = mkdtempSync(join(tmpdir(), 'vorschicht-shell-'));
mkdirSync(join(shellRoot, 'public', 'assets'), { recursive: true });
writeFileSync(join(shellRoot, 'public', 'index.html'), '<!doctype html><title>Vorschicht</title>');
writeFileSync(join(shellRoot, 'public', 'assets', 'index-abc123.js'), 'console.log(1)');
writeFileSync(join(shellRoot, 'geheim.txt'), 'CLAUDE_CODE_OAUTH_TOKEN=echt');
const STATIC_ROOT = join(shellRoot, 'public');

afterAll(() => rmSync(shellRoot, { recursive: true, force: true }));

/** What the projects routes were asked to do, so a test can read it back. */
interface ProjectCalls {
  saved: Array<{ id: string; input: unknown; actor: string }>;
}

/** The same, for the inbox routes (§15). */
interface InboxCalls {
  read: number[];
  answered: Array<{ nummer: number; input: unknown; actor: string }>;
  limits: Array<number | null>;
}

/** A card the stub hands back — only the fields the transport tests look at. */
/**
 * A complete card, not a two-field stub — and that is the point.
 *
 * The transport tests used to assert `toEqual({ posteingang: [CARD] })` against
 * a `{number, question}` stub, which proves the envelope key and nothing about
 * the document inside it. Meanwhile the dashboard was reading `koerper.items`
 * and different field names entirely, and no test on either side could see it.
 * A full fixture lets these routes' bodies be **parsed through the shared
 * schema** below, which is the standing detector for that class of drift.
 */
const CARD: EscalationCardView = {
  id: '9d1c2f5e-0000-4000-8000-000000000012',
  number: 12,
  source: 'agent_question',
  sourceLabel: 'Frage aus einer Sitzung',
  urgency: 'P1',
  projectId: null,
  taskId: null,
  runId: null,
  question: 'Darf Vorschicht auf dev schreiben?',
  context: 'Der Integrationszweig heißt dort dev, nicht main.',
  options: [
    { index: 0, title: 'Ja, nur auf dev', pros: ['klein'], cons: ['eng'], recommended: true },
    { index: 1, title: 'Nein', pros: ['sicher'], cons: ['langsam'], recommended: false },
  ],
  related: [],
  raisedAt: '2026-08-02T09:00:00.000Z',
  raisedBy: 'planner',
  state: 'open',
  answeredAt: null,
  answeredBy: null,
  chosenIndex: null,
  chosenTitle: null,
  freeText: null,
};

const DECISION: DecisionView = {
  escalationId: CARD.id,
  number: 12,
  source: 'agent_question',
  sourceLabel: 'Frage aus einer Sitzung',
  projectId: null,
  taskId: null,
  question: CARD.question,
  summary: 'Entscheidung #12: Ja, nur auf dev',
  options: CARD.options,
  chosenIndex: 0,
  chosenTitle: 'Ja, nur auf dev',
  freeText: null,
  decidedAt: '2026-08-02T10:00:00.000Z',
  decidedBy: 'operator',
};

function app(
  options: {
    session?: boolean;
    dbHealthy?: boolean;
    serveShell?: boolean;
    projects?: { result: 'ok' | 'invalid' | 'unknown'; calls: ProjectCalls };
    inbox?: { result: 'ok' | 'conflict' | 'invalid' | 'unknown'; calls: InboxCalls };
  } = {},
) {
  const projects = options.projects;
  const inbox = options.inbox;
  return createApp({
    ...(options.serveShell ? { staticRoot: STATIC_ROOT } : {}),
    health: {
      startedAt: Date.now() - 5000,
      pingDatabase: async () => {
        if (options.dbHealthy === false) throw new Error('down');
      },
    },
    getSession: async () => (options.session ? { userId: 'operator' } : null),
    ...(projects
      ? {
          projects: {
            list: async () => [{ slug: 'vorschicht' }],
            saveGates: async (id: string, input: unknown, actor: string) => {
              projects.calls.saved.push({ id, input, actor });
              if (projects.result === 'ok') return { ok: true as const, project: { slug: 'v' } };
              if (projects.result === 'unknown')
                return { ok: false as const, reason: 'unknown' as const };
              return {
                ok: false as const,
                reason: 'invalid' as const,
                errors: ['„Tests" gehört zum gesperrten Grundgerüst', 'Zweiter Grund'],
              };
            },
          },
        }
      : {}),
    ...(inbox
      ? {
          inbox: {
            open: async () => [CARD],
            byNumber: async (nummer: number) => {
              inbox.calls.read.push(nummer);
              return inbox.result === 'unknown'
                ? { ok: false as const, reason: 'unknown' as const }
                : { ok: true as const, escalation: CARD };
            },
            answer: async (nummer: number, input: unknown, actor: string) => {
              inbox.calls.answered.push({ nummer, input, actor });
              if (inbox.result === 'ok') return { ok: true as const, escalation: CARD };
              if (inbox.result === 'unknown')
                return { ok: false as const, reason: 'unknown' as const };
              if (inbox.result === 'conflict')
                return {
                  ok: false as const,
                  reason: 'conflict' as const,
                  errors: ['Entscheidung #12 ist bereits beantwortet'],
                  escalation: CARD,
                };
              return {
                ok: false as const,
                reason: 'invalid' as const,
                errors: [
                  'Eine Entscheidung braucht entweder eine gewählte Option',
                  'Zweiter Grund',
                ],
              };
            },
            decisions: async (limit: number | null) => {
              inbox.calls.limits.push(limit);
              return [DECISION];
            },
          },
        }
      : {}),
  });
}

/**
 * `Response.json()` is `unknown`. The `/healthz` body is a known shape, so it
 * is named here rather than asserted away at every call site.
 */
interface HealthBody {
  status: string;
  checks: Record<string, string>;
  uptimeSeconds: number;
}

async function json(res: Response): Promise<HealthBody> {
  return (await res.json()) as HealthBody;
}

describe('/healthz', () => {
  it('is reachable without a session and reports liveness', async () => {
    const res = await app().request('/healthz');
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.status).toBe('ok');
    expect(body.checks.database).toBe('ok');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(4);
  });

  it('answers 503 when the database is unreachable, so the watchdog notices', async () => {
    const res = await app({ dbHealthy: false }).request('/healthz');
    expect(res.status).toBe(503);
    expect((await json(res)).status).toBe('degraded');
  });

  // The endpoint is polled by anyone who can reach the vhost. It must not leak
  // anything about the operator's projects, queues or tasks.
  it('leaks nothing beyond liveness facts', async () => {
    const body = await json(await app().request('/healthz'));
    expect(Object.keys(body).sort()).toEqual(['checks', 'status', 'uptimeSeconds']);
  });
});

describe('default-deny route policy', () => {
  it('answers 401 on an authenticated route without a session', async () => {
    const res = await app().request('/api/me');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'nicht angemeldet' });
  });

  it('serves the route once a session exists', async () => {
    const res = await app({ session: true }).request('/api/me');
    expect(res.status).toBe(200);
  });

  // The gate says "all non-auth routes 401 without session". A route nobody
  // registered must not be a way to find that out either — but it must also
  // not be a 404 that reveals which paths exist.
  it('answers 401 for unknown paths too, not 404', async () => {
    const res = await app().request('/api/projects/secret-one');
    expect(res.status).toBe(401);
  });

  it.each(['/healthz', '/api/auth/options', '/api/auth/verify'])('%s stays public', (path) => {
    expect(isPublicPath(path)).toBe(true);
  });

  it.each(['/api/me', '/api/tasks', '/', '/api/authorised'])('%s is not public', (path) => {
    expect(isPublicPath(path)).toBe(false);
  });
});

describe('App-Shell', () => {
  // The chicken-and-egg the deny guard creates: the passkey ceremony happens in
  // a browser, so the page carrying it must load before anyone has a session.
  // Without this the bootstrap is unreachable — which is exactly what shipped.
  it('liefert die Startseite ohne Sitzung aus', async () => {
    const res = await app({ serveShell: true }).request('/');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('Vorschicht');
  });

  it('liefert Client-Routen als Shell aus, damit ein eingefügter Link funktioniert', async () => {
    const res = await app({ serveShell: true }).request('/registrieren');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<!doctype html>');
  });

  it('liefert gehashte Assets mit langer Cache-Dauer', async () => {
    const res = await app({ serveShell: true }).request('/assets/index-abc123.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
  });

  // A deploy must not leave browsers on the previous shell.
  it('lässt die Startseite nicht hart cachen', async () => {
    const res = await app({ serveShell: true }).request('/');
    expect(res.headers.get('cache-control')).toBe('no-cache');
  });

  // This handler is reachable without a session and the caller picks the path.
  it.each([
    '/../geheim.txt',
    '/assets/../../geheim.txt',
    '/%2e%2e/geheim.txt',
    '/....//geheim.txt',
  ])('verweigert Pfad-Traversal: %s', async (path) => {
    const res = await app({ serveShell: true }).request(path);
    const body = await res.text();
    expect(body).not.toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(body).not.toContain('echt');
  });

  // The shell is public; the data behind it is not.
  it('lässt die API weiterhin geschlossen', async () => {
    const served = app({ serveShell: true });
    expect((await served.request('/api/me')).status).toBe(401);
    expect((await served.request('/api/tasks')).status).toBe(401);
  });

  it('antwortet ohne konfigurierte Shell weiterhin mit 401', async () => {
    expect((await app().request('/')).status).toBe(401);
  });
});

/**
 * The transport half of §17.3. What is asserted here is exactly what belongs to
 * this layer — a status code per outcome, and the actor coming from the session
 * rather than from a default. Whether the refusal is *correct* is §11's
 * question and is settled in `packages/shared/src/gates.test.ts`; whether it is
 * recorded is `projects.itest.ts`.
 */
describe('Projekt-Routen (§17.3)', () => {
  const calls = (): ProjectCalls => ({ saved: [] });

  it('bleiben ohne Sitzung geschlossen', async () => {
    const served = app({ projects: { result: 'ok', calls: calls() } });
    expect((await served.request('/api/projekte')).status).toBe(401);
    expect(
      (await served.request('/api/projekte/abc/gates', { method: 'PUT', body: '{}' })).status,
    ).toBe(401);
  });

  it('liefert die Projektliste an eine angemeldete Sitzung', async () => {
    const res = await app({ session: true, projects: { result: 'ok', calls: calls() } }).request(
      '/api/projekte',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ projekte: [{ slug: 'vorschicht' }] });
  });

  // 422 rather than 400: the body parsed, and §11 declined what it said. And
  // *every* reason travels — `validateProjectGateConfig` returns them all on
  // purpose, and a transport that kept the first would undo that.
  it('gibt eine abgelehnte Konfiguration mit 422 und allen Gründen zurück', async () => {
    const res = await app({
      session: true,
      projects: { result: 'invalid', calls: calls() },
    }).request('/api/projekte/p1/gates', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ gates: { test: false } }),
    });
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      errors: ['„Tests" gehört zum gesperrten Grundgerüst', 'Zweiter Grund'],
    });
  });

  it('unterscheidet ein unbekanntes Projekt von einer abgelehnten Konfiguration', async () => {
    const res = await app({
      session: true,
      projects: { result: 'unknown', calls: calls() },
    }).request('/api/projekte/gibtsnicht/gates', { method: 'PUT', body: '{}' });
    expect(res.status).toBe(404);
  });

  // §19: an audit trail in which every change was made by `system` answers that
  // something was tried and loses who tried it.
  it('reicht die Sitzung als Urheber durch, nicht „system"', async () => {
    const recorded = calls();
    await app({ session: true, projects: { result: 'ok', calls: recorded } }).request(
      '/api/projekte/p1/gates',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ gates: { sast: true } }),
      },
    );
    expect(recorded.saved).toHaveLength(1);
    expect(recorded.saved[0]?.actor).toBe('dashboard:operator');
    expect(recorded.saved[0]?.id).toBe('p1');
    expect(recorded.saved[0]?.input).toEqual({ gates: { sast: true } });
  });

  // A body that is not JSON must reach §11 as "nothing", so the validator
  // answers it — rather than throwing out of the route as a 500, which would
  // report a client mistake as a server fault.
  it('behandelt einen unlesbaren Rumpf als leere Konfiguration', async () => {
    const recorded = calls();
    const res = await app({ session: true, projects: { result: 'ok', calls: recorded } }).request(
      '/api/projekte/p1/gates',
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: 'kein json' },
    );
    expect(res.status).toBe(200);
    expect(recorded.saved[0]?.input).toBeNull();
  });
});

/**
 * The transport half of §15. Same division as the projects routes above: what is
 * asserted here is a status code per outcome, the actor coming from the session,
 * and a malformed path never reaching the service. Whether the *refusal* is
 * right is `inbox.test.ts`'s question, and whether it is stored once is the
 * database's.
 */
describe('Posteingang-Routen (§15)', () => {
  const calls = (): InboxCalls => ({ read: [], answered: [], limits: [] });

  it('bleiben ohne Sitzung geschlossen', async () => {
    const served = app({ inbox: { result: 'ok', calls: calls() } });
    for (const path of ['/api/posteingang', '/api/posteingang/12', '/api/entscheidungen']) {
      expect((await served.request(path)).status).toBe(401);
    }
    const posted = await served.request('/api/posteingang/12/antwort', {
      method: 'POST',
      body: '{}',
    });
    expect(posted.status).toBe(401);
  });

  it('liefert die offenen Eskalationen an eine angemeldete Sitzung', async () => {
    const res = await app({ session: true, inbox: { result: 'ok', calls: calls() } }).request(
      '/api/posteingang',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ posteingang: [CARD] });
  });

  /**
   * The standing detector for the defect this whole change exists for.
   *
   * The three route bodies are parsed through the very schemas the dashboard
   * parses them with. `toEqual` above pins what this fixture is; this pins that
   * the shape is the *agreed* one — rename an envelope key or a field and the
   * page stops working, so a test here has to stop working first.
   */
  it('antwortet in genau der Form, die die Oberfläche liest', async () => {
    const served = app({ session: true, inbox: { result: 'ok', calls: calls() } });

    expect(
      inboxListResponse.safeParse(await (await served.request('/api/posteingang')).json()).success,
    ).toBe(true);
    expect(
      inboxCardResponse.safeParse(await (await served.request('/api/posteingang/12')).json())
        .success,
    ).toBe(true);
    expect(
      decisionLogResponse.safeParse(await (await served.request('/api/entscheidungen')).json())
        .success,
    ).toBe(true);
  });

  it('liefert eine einzelne Karte unter ihrer Nummer', async () => {
    const recorded = calls();
    const res = await app({ session: true, inbox: { result: 'ok', calls: recorded } }).request(
      '/api/posteingang/12',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eskalation: CARD });
    expect(recorded.read).toEqual([12]);
  });

  it('meldet eine unbekannte Nummer mit 404', async () => {
    const res = await app({ session: true, inbox: { result: 'unknown', calls: calls() } }).request(
      '/api/posteingang/999',
    );
    expect(res.status).toBe(404);
  });

  // A path segment that is not a number names no item, so it must not become a
  // query. Asserting on `read` is the half that shows it never got that far.
  it.each(['abc', '-1', '1.5', '1e3', '+7', '0'])(
    'weist die Pfadangabe %s ab, ohne den Dienst zu fragen',
    async (nummer) => {
      const recorded = calls();
      const served = app({ session: true, inbox: { result: 'ok', calls: recorded } });
      expect((await served.request(`/api/posteingang/${nummer}`)).status).toBe(404);
      const posted = await served.request(`/api/posteingang/${nummer}/antwort`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ optionIndex: 0 }),
      });
      expect(posted.status).toBe(404);
      expect(recorded.read).toEqual([]);
      expect(recorded.answered).toEqual([]);
    },
  );

  it('nimmt eine Antwort an und gibt die beantwortete Karte zurück', async () => {
    const res = await app({ session: true, inbox: { result: 'ok', calls: calls() } }).request(
      '/api/posteingang/12/antwort',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ optionIndex: 1 }),
      },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ eskalation: CARD });
  });

  // 409 rather than 422: nothing the caller sends will be accepted, because the
  // decision has already been injected into the resumed session (§6.4).
  it('beantwortet eine bereits entschiedene Eskalation mit 409 samt Karte', async () => {
    const res = await app({ session: true, inbox: { result: 'conflict', calls: calls() } }).request(
      '/api/posteingang/12/antwort',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ optionIndex: 0 }),
      },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      errors: ['Entscheidung #12 ist bereits beantwortet'],
      eskalation: CARD,
    });
  });

  // 422 and not 400: the body parsed, and §15 declined what it said. Every
  // reason travels — a form that reveals one mistake per submission is a form
  // nobody finishes.
  it('gibt eine unbrauchbare Antwort mit 422 und allen Gründen zurück', async () => {
    const res = await app({ session: true, inbox: { result: 'invalid', calls: calls() } }).request(
      '/api/posteingang/12/antwort',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}) },
    );
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({
      errors: ['Eine Entscheidung braucht entweder eine gewählte Option', 'Zweiter Grund'],
    });
  });

  it('unterscheidet eine unbekannte Eskalation von einer abgelehnten Antwort', async () => {
    const res = await app({ session: true, inbox: { result: 'unknown', calls: calls() } }).request(
      '/api/posteingang/12/antwort',
      { method: 'POST', body: '{}' },
    );
    expect(res.status).toBe(404);
  });

  // §19: a decision resumes a parked session on the operator's authority (§6.4), so the
  // trail has to name the session rather than a default.
  it('reicht die Sitzung als Urheber durch, nicht „system"', async () => {
    const recorded = calls();
    await app({ session: true, inbox: { result: 'ok', calls: recorded } }).request(
      '/api/posteingang/12/antwort',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ optionIndex: 0, freeText: 'Ja, aber nur auf dev.' }),
      },
    );
    expect(recorded.answered).toEqual([
      {
        nummer: 12,
        input: { optionIndex: 0, freeText: 'Ja, aber nur auf dev.' },
        actor: 'dashboard:operator',
      },
    ]);
  });

  // Unreadable JSON reaches §15 as "nothing" and comes back as a 422, rather
  // than throwing out of the route as a 500 — a client mistake is not a fault.
  it('behandelt einen unlesbaren Rumpf als leere Antwort', async () => {
    const recorded = calls();
    const res = await app({ session: true, inbox: { result: 'invalid', calls: recorded } }).request(
      '/api/posteingang/12/antwort',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'kein json' },
    );
    expect(res.status).toBe(422);
    expect(recorded.answered[0]?.input).toBeNull();
  });

  it('liefert das Entscheidungslog', async () => {
    const recorded = calls();
    const res = await app({ session: true, inbox: { result: 'ok', calls: recorded } }).request(
      '/api/entscheidungen',
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ entscheidungen: [DECISION] });
    // No `?limit=` means "the adapter decides", never a number invented here.
    expect(recorded.limits).toEqual([null]);
  });

  it.each([
    ['?limit=5', 5],
    ['?limit=abc', null],
    ['?limit=', null],
  ])('reicht %s als %s weiter', async (query, expected) => {
    const recorded = calls();
    await app({ session: true, inbox: { result: 'ok', calls: recorded } }).request(
      `/api/entscheidungen${query}`,
    );
    expect(recorded.limits).toEqual([expected]);
  });
});

describe('isAppShellPath', () => {
  it.each(['/', '/registrieren', '/posteingang/7', '/assets/x.js'])(
    '%s gehört zur Oberfläche',
    (p) => {
      expect(isAppShellPath(p)).toBe(true);
    },
  );

  it.each(['/api/me', '/api/auth/state', '/events', '/healthz'])('%s gehört zur API', (p) => {
    expect(isAppShellPath(p)).toBe(false);
  });
});
