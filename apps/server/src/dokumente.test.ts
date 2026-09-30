/**
 * The transport half of §13.
 *
 * The same division `app.test.ts` keeps for the inbox and the projects routes:
 * what is asserted here is a status code per outcome, the actor coming from the
 * session, the request envelope reaching the adapter intact, and a route that
 * answers before the vault is ever asked. Whether a *refusal* is right is
 * `dokumente.itest.ts`'s question, and whether the bytes land is the
 * filesystem's.
 *
 * The stub is a full `DocumentDetailView` rather than a two-field shape, for the
 * reason `app.test.ts` states about its own card: an envelope assertion over a
 * stub proves the key and nothing about the document inside it. A complete
 * fixture lets these bodies be **parsed through the shared schema**, which is
 * the standing detector for the drift A81 is about.
 */
import {
  type DocumentDetailView,
  documentResponse,
  documentSearchResponse,
} from '@vorschicht/shared/dokumente';
import { describe, expect, it } from 'vitest';
import { createApp, type VaultRouteResult, type VaultUpload } from './app.js';

const DOCUMENT_ID = '0d1c2f5e-0000-4000-8000-000000000012';

const DETAIL: DocumentDetailView = {
  document: {
    id: DOCUMENT_ID,
    title: 'Vereinsstatuten 2026',
    departmentTags: ['Recht'],
    tags: ['Verein'],
    createdAt: '2026-08-09T09:00:00.000Z',
    updatedAt: '2026-08-09T09:00:00.000Z',
  },
  versions: [
    {
      id: '0d1c2f5e-0000-4000-8000-000000000099',
      documentId: DOCUMENT_ID,
      version: 1,
      filename: 'statuten.txt',
      mimeType: 'text/plain',
      byteSize: 42,
      checksum: 'a'.repeat(64),
      extractedChars: 40,
      uploadedAt: '2026-08-09T09:00:00.000Z',
      uploadedBy: 'dashboard:operator',
    },
  ],
};

/** What the routes were asked to do, so a test can read it back. */
interface VaultCalls {
  uploaded: VaultUpload[];
  versioned: Array<{ id: string; request: VaultUpload }>;
  got: string[];
  tagged: Array<{ id: string; input: unknown; actor: string }>;
  searched: string[];
}

type Outcome = 'ok' | 'invalid' | 'unsupported_media' | 'too_large' | 'unknown' | 'failed';

function refusal(outcome: Exclude<Outcome, 'ok'>): VaultRouteResult {
  return { ok: false, reason: outcome, errors: [`Grund: ${outcome}`, 'Zweiter Grund'] };
}

function app(options: { session?: boolean; outcome?: Outcome; calls?: VaultCalls } = {}) {
  const calls = options.calls ?? emptyCalls();
  const outcome = options.outcome ?? 'ok';
  const answer = (value: unknown): VaultRouteResult =>
    outcome === 'ok' ? { ok: true, value } : refusal(outcome);

  return createApp({
    health: { startedAt: Date.now(), pingDatabase: async () => {} },
    getSession: async () => (options.session ? { userId: 'operator' } : null),
    dokumente: {
      upload: async (request) => {
        calls.uploaded.push(request);
        return answer({ dokument: DETAIL });
      },
      addVersion: async (id, request) => {
        calls.versioned.push({ id, request });
        return answer({ dokument: DETAIL });
      },
      get: async (id) => {
        calls.got.push(id);
        return answer({ dokument: DETAIL });
      },
      setTags: async (id, input, actor) => {
        calls.tagged.push({ id, input, actor });
        return answer({ dokument: DETAIL });
      },
      search: async (params) => {
        calls.searched.push(params.toString());
        return answer({ dokumente: [], nochNichtDurchsuchbar: 3 });
      },
    },
  });
}

function emptyCalls(): VaultCalls {
  return { uploaded: [], versioned: [], got: [], tagged: [], searched: [] };
}

const UPLOAD = '/api/dokumente?title=Statuten&filename=statuten.txt&department=Recht&tag=Verein';

function upload(body = 'Der Verein heißt …', type = 'text/plain; charset=utf-8') {
  return { method: 'POST', headers: { 'content-type': type }, body };
}

describe('Dokumenten-Routen (§13)', () => {
  it('bleiben ohne Sitzung geschlossen', async () => {
    const calls = emptyCalls();
    const served = app({ calls });
    expect((await served.request(UPLOAD, upload())).status).toBe(401);
    expect((await served.request(`/api/dokumente/${DOCUMENT_ID}`)).status).toBe(401);
    expect((await served.request('/api/dokumente/suche?q=x')).status).toBe(401);
    expect((await served.request(`/api/dokumente/${DOCUMENT_ID}/versionen`, upload())).status).toBe(
      401,
    );
    expect(
      (
        await served.request(`/api/dokumente/${DOCUMENT_ID}/schlagworte`, {
          method: 'PUT',
          body: '{}',
        })
      ).status,
    ).toBe(401);
    // The half that shows the guard ran *before* the handler, not after it.
    expect(calls).toEqual(emptyCalls());
  });

  it('nimmt einen Upload an und antwortet in der Form, die die Oberfläche liest', async () => {
    const res = await app({ session: true }).request(UPLOAD, upload());
    expect(res.status).toBe(200);
    // Parsed through the very schema the dashboard parses it with — rename an
    // envelope key or a field and this stops working before a page does.
    expect(documentResponse.safeParse(await res.json()).success).toBe(true);
  });

  it('reicht Metadaten, Typ, Länge und den Strom unverändert weiter', async () => {
    const calls = emptyCalls();
    const body = 'Der Verein heißt …';
    // `content-length` is set by hand because this harness does not add one —
    // a real browser upload does, which is what makes the adapter's early
    // refusal reachable at all. Asserting the exact value rather than its
    // presence is what shows the header is passed through rather than recomputed.
    await app({ session: true, calls }).request(UPLOAD, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-length': String(new TextEncoder().encode(body).byteLength),
      },
      body,
    });

    const request = calls.uploaded[0];
    expect(request).toBeDefined();
    expect(request?.params.get('title')).toBe('Statuten');
    expect(request?.params.getAll('department')).toEqual(['Recht']);
    expect(request?.params.getAll('tag')).toEqual(['Verein']);
    // The raw header, parameters and all: reducing it to a media type is the
    // adapter's job, and doing it here as well would be a second place that can
    // disagree about what a content type is.
    expect(request?.contentType).toBe('text/plain; charset=utf-8');
    expect(request?.contentLength).toBe(String(new TextEncoder().encode(body).byteLength));
    // A stream, not a buffered body: the cap has to act on arriving bytes.
    expect(request?.body).not.toBeNull();
  });

  // §19: an upload and a re-tagging are both curation, and §13 makes every one
  // of them audit-logged. A trail naming `system` answers *that* something
  // happened and loses the question it is kept for.
  it('reicht die Sitzung als Urheber durch, nicht „system"', async () => {
    const calls = emptyCalls();
    const served = app({ session: true, calls });
    await served.request(UPLOAD, upload());
    await served.request(`/api/dokumente/${DOCUMENT_ID}/versionen?filename=neu.txt`, upload());
    await served.request(`/api/dokumente/${DOCUMENT_ID}/schlagworte`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tags: ['neu'] }),
    });

    expect(calls.uploaded[0]?.actor).toBe('dashboard:operator');
    expect(calls.versioned[0]?.request.actor).toBe('dashboard:operator');
    expect(calls.tagged[0]?.actor).toBe('dashboard:operator');
  });

  // 415 and 413 rather than 422, because neither ever parsed a body. 500 stays a
  // JSON document with a German sentence, since this app has no `app.onError`
  // and a throw would answer with a naked stack.
  it.each([
    ['invalid', 422],
    ['unsupported_media', 415],
    ['too_large', 413],
    ['unknown', 404],
    ['failed', 500],
  ] as const)('bildet %s auf %i ab und trägt alle Gründe', async (outcome, status) => {
    const res = await app({ session: true, outcome }).request(UPLOAD, upload());
    expect(res.status).toBe(status);
    expect(await res.json()).toEqual({ errors: [`Grund: ${outcome}`, 'Zweiter Grund'] });
  });

  it('liefert eine Suchantwort mit der Zahl der ungelesenen Dokumente', async () => {
    const calls = emptyCalls();
    const res = await app({ session: true, calls }).request(
      '/api/dokumente/suche?q=K%C3%BCndigung&abteilung=Recht',
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(documentSearchResponse.safeParse(body).success).toBe(true);
    expect(body).toEqual({ dokumente: [], nochNichtDurchsuchbar: 3 });
    expect(calls.searched).toEqual(['q=K%C3%BCndigung&abteilung=Recht']);
  });

  // Hono matches in registration order, so `/suche` has to be registered ahead
  // of `/:id`. The assertion is that `get` was never called: a route order that
  // regressed would answer 200 from the wrong handler and look identical from
  // outside.
  it('behandelt „suche" als Route und nicht als Dokument-Id', async () => {
    const calls = emptyCalls();
    await app({ session: true, calls }).request('/api/dokumente/suche?q=x');
    expect(calls.got).toEqual([]);
    expect(calls.searched).toHaveLength(1);
  });

  it('liefert ein einzelnes Dokument unter seiner Id', async () => {
    const calls = emptyCalls();
    const res = await app({ session: true, calls }).request(`/api/dokumente/${DOCUMENT_ID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dokument: DETAIL });
    expect(calls.got).toEqual([DOCUMENT_ID]);
  });

  // A body that is not JSON must reach the adapter as "nothing", so §13's rule
  // answers it — rather than throwing out of the route as a 500, which would
  // report a caller's mistake as a server fault.
  it('behandelt einen unlesbaren Rumpf als leere Angabe', async () => {
    const calls = emptyCalls();
    const res = await app({ session: true, outcome: 'invalid', calls }).request(
      `/api/dokumente/${DOCUMENT_ID}/schlagworte`,
      { method: 'PUT', headers: { 'content-type': 'application/json' }, body: 'kein json' },
    );
    expect(res.status).toBe(422);
    expect(calls.tagged[0]?.input).toBeNull();
  });

  it('reicht die Dokument-Id der Version durch', async () => {
    const calls = emptyCalls();
    await app({ session: true, calls }).request(
      `/api/dokumente/${DOCUMENT_ID}/versionen?filename=neu.txt`,
      upload(),
    );
    expect(calls.versioned[0]?.id).toBe(DOCUMENT_ID);
    expect(calls.versioned[0]?.request.params.get('filename')).toBe('neu.txt');
  });
});
