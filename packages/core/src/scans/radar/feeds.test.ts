/**
 * The one place the radar touches a network, driven through an injected `fetch`.
 *
 * Stated plainly because it is the honest limit of this file: **no request here
 * has ever been executed against the real registry from this repository** —
 * `pnpm gate` has no network. What is proven is the argument construction and
 * the parsing, which is exactly the half a stand-in can prove. Whether
 * `registry.npmjs.org` answers in the shape the fixtures assume is a claim this
 * suite does not make, and `RadarScan` is built so that a wrong guess there is
 * reported as an unchecked surface rather than as a clean scan.
 *
 * What it does prove and what matters most: a *partial* failure is an answer.
 * One package that 404s must not cost the other eighty their reading, and a
 * reading where nothing answered must not come back looking successful.
 */
import { describe, expect, it } from 'vitest';
import { FixtureRadarFeeds, HttpRadarFeeds, parseBulkAdvisories } from './feeds.js';

type Call = { url: string; init: RequestInit | undefined };

function recorder(handler: (url: string) => { status?: number; body: unknown }): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const { status = 200, body } = handler(url);
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('HttpRadarFeeds.latestVersions', () => {
  it('fragt die abgekürzte Registry-Fassung ab und liest dist-tags.latest', async () => {
    const { fetch, calls } = recorder(() => ({ body: { 'dist-tags': { latest: '5.0.0' } } }));
    const feeds = new HttpRadarFeeds({ billingUrls: [], cliUrl: null, fetch });

    const result = await feeds.latestVersions(['hono']);

    expect(result.live).toBe(true);
    expect(result.value.get('hono')).toBe('5.0.0');
    expect(calls[0]?.url).toBe('https://registry.npmjs.org/hono');
    // The registry's own answer to "I only want dist-tags"; the full packument
    // for a popular package is megabytes.
    expect((calls[0]?.init?.headers as Record<string, string>)?.accept).toBe(
      'application/vnd.npm.install-v1+json',
    );
  });

  it('kodiert einen Namensraum so, wie die Registry ihn erwartet', async () => {
    const { fetch, calls } = recorder(() => ({ body: { 'dist-tags': { latest: '1.0.0' } } }));
    const feeds = new HttpRadarFeeds({ billingUrls: [], cliUrl: null, fetch });

    await feeds.latestVersions(['@hono/node-server']);

    expect(calls[0]?.url).toBe('https://registry.npmjs.org/@hono%2Fnode-server');
  });

  it('behält, was geantwortet hat, wenn ein Paket ausfällt', async () => {
    // Decision 4. The alternative — one 404 discarding the whole reading — would
    // make the dependency radar useless against any real lockfile.
    const { fetch } = recorder((url) =>
      url.endsWith('/kaputt')
        ? { status: 404, body: '' }
        : { body: { 'dist-tags': { latest: '2.0.0' } } },
    );
    const feeds = new HttpRadarFeeds({ billingUrls: [], cliUrl: null, fetch });

    const result = await feeds.latestVersions(['gut', 'kaputt']);

    expect(result.live).toBe(true);
    expect([...result.value.keys()]).toEqual(['gut']);
    expect(result.problems?.[0]).toContain('kaputt');
  });

  it('meldet live: false, wenn überhaupt nichts geantwortet hat', async () => {
    // The distinction the whole scan rests on: a reading nobody answered must
    // not look like "everything is current".
    const { fetch } = recorder(() => ({ status: 503, body: '' }));
    const feeds = new HttpRadarFeeds({ billingUrls: [], cliUrl: null, fetch });

    const result = await feeds.latestVersions(['a', 'b']);

    expect(result.live).toBe(false);
    expect(result.value.size).toBe(0);
    expect(result.problems).toHaveLength(2);
  });

  it('lässt ein Paket weg, dessen Antwort kein latest nennt', async () => {
    const { fetch } = recorder(() => ({ body: { 'dist-tags': {} } }));
    const feeds = new HttpRadarFeeds({ billingUrls: [], cliUrl: null, fetch });
    const result = await feeds.latestVersions(['a']);
    expect(result.live).toBe(true);
    expect(result.value.size).toBe(0);
  });
});

describe('HttpRadarFeeds.advisories', () => {
  it('fragt den Bulk-Endpunkt mit den installierten Versionen', async () => {
    const { fetch, calls } = recorder(() => ({ body: {} }));
    const feeds = new HttpRadarFeeds({ billingUrls: [], cliUrl: null, fetch });

    await feeds.advisories([
      { name: 'a', version: '1.0.0' },
      { name: 'a', version: '1.1.0' },
      { name: 'b', version: '2.0.0' },
    ]);

    expect(calls[0]?.url).toBe('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      a: ['1.0.0', '1.1.0'],
      b: ['2.0.0'],
    });
  });

  it('fragt gar nicht erst, wenn nichts installiert ist — und sagt live: false', async () => {
    const { fetch, calls } = recorder(() => ({ body: {} }));
    const feeds = new HttpRadarFeeds({ billingUrls: [], cliUrl: null, fetch });
    const result = await feeds.advisories([]);
    expect(calls).toHaveLength(0);
    expect(result.live).toBe(false);
  });

  it('meldet einen Ausfall als nicht-live statt als leeres Ergebnis', async () => {
    const { fetch } = recorder(() => ({ status: 500, body: '' }));
    const feeds = new HttpRadarFeeds({ billingUrls: [], cliUrl: null, fetch });
    const result = await feeds.advisories([{ name: 'a', version: '1.0.0' }]);
    expect(result.live).toBe(false);
    expect(result.value).toEqual([]);
  });
});

describe('parseBulkAdvisories', () => {
  const installed = [{ name: 'hono', version: '4.12.32' }];

  it('liest die Felder, die eine P0-Karte nennt', () => {
    const findings = parseBulkAdvisories(
      {
        hono: [
          {
            id: 1234,
            title: 'Beispiel',
            severity: 'HIGH',
            url: 'https://example.test/a',
            vulnerable_versions: '<5',
          },
        ],
      },
      installed,
    );
    expect(findings).toEqual([
      {
        id: '1234',
        name: 'hono',
        version: '4.12.32',
        severity: 'high',
        title: 'Beispiel',
        url: 'https://example.test/a',
      },
    ]);
  });

  it('verwirft einen Eintrag ohne Kennung', () => {
    // The id *is* the dedup key, and an advisory that cannot be deduplicated is
    // a P0 every six hours (A105.3's arithmetic).
    expect(parseBulkAdvisories({ hono: [{ title: 'ohne Kennung' }] }, installed)).toEqual([]);
  });

  it('nennt eine unbekannte Einstufung «unknown», statt sie zu erfinden', () => {
    const findings = parseBulkAdvisories({ hono: [{ id: 'X', severity: 'schlimm' }] }, installed);
    expect(findings[0]?.severity).toBe('unknown');
    expect(findings[0]?.title).toBe('ohne Titel');
    expect(findings[0]?.url).toBeNull();
  });

  it('verschluckt sich nicht an einem Dokument in unerwarteter Form', () => {
    expect(parseBulkAdvisories({ hono: 'kein Array' }, installed)).toEqual([]);
    expect(parseBulkAdvisories({ hono: [null, 7, 'x'] }, installed)).toEqual([]);
  });
});

describe('Anthropic-Kanäle ohne Voreinstellung (Entscheidung 2)', () => {
  it('liefert keine Abrechnungskanäle, wenn keiner konfiguriert ist', async () => {
    const feeds = new HttpRadarFeeds({ billingUrls: [], cliUrl: null });
    expect(await feeds.billingChannels()).toEqual([]);
  });

  it('sagt beim CLI-Kanal, dass keiner konfiguriert ist', async () => {
    const feeds = new HttpRadarFeeds({ billingUrls: [], cliUrl: null });
    const result = await feeds.cliChannel();
    expect(result.live).toBe(false);
    expect(result.value).toBeNull();
    expect(result.origin).toMatch(/kein CLI-Release-Kanal konfiguriert/);
  });

  it('meldet einen gescheiterten Abruf als nicht-live und ohne Text', async () => {
    // A channel that did not answer is not a channel that said nothing: with an
    // empty body no signal can be derived, and `live: false` makes the scan say
    // it was not checked.
    const { fetch } = recorder(() => ({ status: 404, body: '' }));
    const feeds = new HttpRadarFeeds({
      billingUrls: ['https://example.test/x'],
      cliUrl: null,
      fetch,
    });
    const [channel] = await feeds.billingChannels();
    expect(channel?.live).toBe(false);
    expect(channel?.value).toBe('');
  });
});

describe('FixtureRadarFeeds', () => {
  it('kann per Bauart nicht behaupten, echt abgefragt zu haben', async () => {
    // Decision 6: this is what makes exporting a fixture safe. Wired by
    // accident, it produces a scan that reports every surface as unchecked.
    const feeds = new FixtureRadarFeeds({ billing: 'irgendwas', cli: '9.9.9' });
    const [channel] = await feeds.billingChannels();
    expect(channel?.live).toBe(false);
    expect((await feeds.cliChannel()).live).toBe(false);
    expect((await feeds.latestVersions(['a'])).live).toBe(false);
    expect((await feeds.advisories([])).live).toBe(false);
  });

  it('gibt nur zurück, was gesät wurde', async () => {
    const feeds = new FixtureRadarFeeds({ latest: { a: '2.0.0' } });
    const result = await feeds.latestVersions(['a', 'b']);
    expect([...result.value.entries()]).toEqual([['a', '2.0.0']]);
    expect(await feeds.billingChannels()).toEqual([]);
  });
});
