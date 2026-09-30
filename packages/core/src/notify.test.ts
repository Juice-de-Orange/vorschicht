import { describe, expect, it, vi } from 'vitest';
import { Notifier } from './notify.js';

const config = { server: 'https://ntfy.example/', token: 'tk_test' };

function fakeFetch(response: Partial<Response> = {}) {
  // The signature is spelled out so that `mock.calls` is typed as the argument
  // list rather than as `[]` — without it every assertion below reads an
  // element of an empty tuple, which typechecks as `never` and asserts nothing.
  return vi.fn(
    async (_input: string | URL | Request, _init?: RequestInit) =>
      ({ ok: true, status: 200, ...response }) as Response,
  );
}

/** The nth recorded call, failing loudly if that call never happened. */
function callOf(fetchImpl: ReturnType<typeof fakeFetch>, call = 0): [string, RequestInit] {
  const recorded = fetchImpl.mock.calls[call];
  if (!recorded?.[1]) throw new Error(`fetch wurde kein ${call + 1}. Mal aufgerufen`);
  return [String(recorded[0]), recorded[1]];
}

function headersOf(fetchImpl: ReturnType<typeof fakeFetch>, call = 0): Record<string, string> {
  return callOf(fetchImpl, call)[1].headers as Record<string, string>;
}

describe('Notifier', () => {
  it('posts to the topic with auth, title and priority', async () => {
    const fetchImpl = fakeFetch();
    const result = await new Notifier(config, fetchImpl).send({
      topic: 'alerts',
      title: 'Rollback',
      message: 'Deploy zurückgerollt',
      priority: 'urgent',
      tags: ['rotating_light'],
      clickUrl: 'https://vorschicht.example/inbox/7',
    });

    expect(result).toEqual({ ok: true, status: 200 });
    const [url, init] = callOf(fetchImpl);
    expect(url).toBe('https://ntfy.example/vorschicht-alerts');
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer tk_test');
    expect(headers.Priority).toBe('urgent');
    expect(headers.Tags).toBe('rotating_light');
    expect(headers.Click).toBe('https://vorschicht.example/inbox/7');
    expect(init.body).toBe('Deploy zurückgerollt');
  });

  // German titles are the norm here (§2) and HTTP/1.1 headers are latin-1, so
  // an unencoded umlaut either throws or arrives as mojibake on the operator's phone.
  it('RFC 2047-encodes a title containing umlauts', async () => {
    const fetchImpl = fakeFetch();
    await new Notifier(config, fetchImpl).send({
      topic: 'info',
      title: 'Wochenbudget erschöpft',
      message: 'Betrieb ruht bis Montag',
    });
    const headers = headersOf(fetchImpl);
    const title = headers.Title ?? '';
    expect(title).toMatch(/^=\?UTF-8\?B\?/);
    expect(Buffer.from(title.slice(10, -2), 'base64').toString('utf8')).toBe(
      'Wochenbudget erschöpft',
    );
  });

  it('leaves a plain ASCII title untouched', async () => {
    const fetchImpl = fakeFetch();
    await new Notifier(config, fetchImpl).send({ topic: 'info', title: 'Build ok', message: 'x' });
    const headers = headersOf(fetchImpl);
    expect(headers.Title).toBe('Build ok');
  });

  // A failed push must never turn a healthy task red — the caller gets a result
  // to log, not an exception to handle.
  it('reports a rejected push without throwing', async () => {
    const fetchImpl = fakeFetch({ ok: false, status: 403 });
    const result = await new Notifier(config, fetchImpl).send({
      topic: 'inbox',
      title: 'x',
      message: 'y',
    });
    expect(result).toEqual({ ok: false, status: 403, error: 'ntfy antwortete 403' });
  });

  it('reports a network failure without throwing', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    const result = await new Notifier(config, fetchImpl as unknown as typeof fetch).send({
      topic: 'alerts',
      title: 'x',
      message: 'y',
    });
    expect(result).toEqual({ ok: false, status: null, error: 'ECONNREFUSED' });
  });

  it('allows per-deployment topic overrides', async () => {
    const fetchImpl = fakeFetch();
    await new Notifier({ ...config, topics: { info: 'custom-info' } }, fetchImpl).send({
      topic: 'info',
      title: 'x',
      message: 'y',
    });
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://ntfy.example/custom-info');
  });
});
