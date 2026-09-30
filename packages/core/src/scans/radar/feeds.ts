/**
 * Where the radar's outside knowledge comes from — and where it does not.
 *
 * The seam exists because §22's exit gate for the billing watch says "a
 * **seeded** 'billing change' fixture" and "a **seeded** CLI release": the gate
 * is about what the studio *does* with such a signal, not about whether a page
 * on the internet says something today. So detection is pure (`billing.ts`), the
 * policy is pure (`dependencies.ts`), and everything that touches a network is
 * behind this one interface with a fixture implementation beside the real one.
 *
 * Six decisions.
 *
 *  1. **`live` travels with every answer, and the scan reports it.** The brief
 *     for this change put it plainly and it is the right rule: the sentence "the
 *     real channel was never queried in this run" belongs in the scan's own
 *     output, not only in a test. A radar that cannot say whether it looked is
 *     the shape A83.6, A87.6, A99.4 and A104.4 have each refused in turn — "we
 *     could not look" and "there is nothing" are the same sentence only to a
 *     system that has decided not to notice.
 *
 *  2. **No default URL for the two Anthropic channels.** The CLI is installed
 *     from `claude.ai/install.sh` (`infra/docker/Dockerfile.orchestrator`), not
 *     from a registry whose document shape this project could pin, and §6.0's
 *     billing announcements have lived on help-center pages that move. A URL
 *     invented here would be a claim this session cannot back — it has no
 *     network — and a 404 every night would read as "nothing announced". So both
 *     are configuration (`VORSCHICHT_RADAR_BILLING_URLS`,
 *     `VORSCHICHT_RADAR_CLI_URL`), unset by default, and unset is reported as a
 *     scope limit rather than as a clean scan.
 *
 *  3. **The npm registry *is* defaulted**, because `registry.npmjs.org/<name>`
 *     and its `dist-tags.latest` are a shape this project can name with
 *     confidence. Honest limit in the same breath: neither request in this file
 *     has been executed against the real registry from here — `pnpm gate` has no
 *     network — so what is proven is the argument construction and the parsing
 *     of a response, not that the responses look like the fixtures.
 *
 *  4. **A partial answer is an answer.** One package that 404s must not cost the
 *     other eighty their reading, so `latestVersions` collects problems and
 *     returns what it got. A name absent from the map means "not asked or not
 *     answered", and `planUpdates` skips it rather than inferring anything —
 *     which is why absence and "nothing newer" cannot be confused downstream.
 *
 *  5. **Bounded concurrency and a deadline on every request.** A lockfile with
 *     three hundred dependencies is three hundred requests; unbounded they would
 *     be a small denial of service against a registry the whole ecosystem
 *     shares, and without a deadline one hung socket holds the periodic pass —
 *     which runs in the daemon's own loop — for as long as the kernel allows.
 *
 *  6. **`FixtureRadarFeeds` ships in this package and is never constructed by
 *     the daemon.** A88.7 took the same posture for `FakeDeployTarget` and the
 *     reason is the same: a fixture wired by accident would report a clean
 *     billing channel that nobody queried. It is exported because the seeded
 *     halves of §22's gate — a demo script, an integration test — need exactly
 *     one, and re-implementing it per caller is how two of them drift (A37).
 */
import type { AdvisoryFinding } from './dependencies.js';

/** One reading from outside, with whether it really came from outside. */
export interface FeedResult<T> {
  /** Decision 1. False when nothing was configured, or a fixture stood in. */
  live: boolean;
  /** A URL, or a sentence naming why this is not one. German (§2). */
  origin: string;
  value: T;
  /** Non-fatal trouble, per item. Never thrown for a partial failure. */
  problems?: string[];
}

/** An installed package, as the advisory endpoint wants to be asked. */
export interface InstalledPackage {
  name: string;
  version: string;
}

export interface RadarFeeds {
  /** §6.0's watched channels, as text. Empty when none is configured. */
  billingChannels(): Promise<Array<FeedResult<string>>>;
  /** A27's release channel. `value: null` when unconfigured or unreadable. */
  cliChannel(): Promise<FeedResult<string | null>>;
  /** A10: newest release per name. Absent name = not asked or not answered. */
  latestVersions(names: readonly string[]): Promise<FeedResult<Map<string, string>>>;
  /** A10's third branch. */
  advisories(installed: readonly InstalledPackage[]): Promise<FeedResult<AdvisoryFinding[]>>;
}

/** The one registry shape this project is willing to name (decision 3). */
export const DEFAULT_NPM_REGISTRY = 'https://registry.npmjs.org';

/** Decision 5. Small enough to be a good citizen, large enough to finish. */
const REQUEST_CONCURRENCY = 6;
const REQUEST_TIMEOUT_MS = 15_000;

export interface HttpRadarFeedsConfig {
  /** §6.0's channels. Empty is the default and is reported as a limit. */
  billingUrls: readonly string[];
  /** A27's channel. Null is the default and is reported as a limit. */
  cliUrl: string | null;
  registry?: string;
  /** Injected only by tests; production uses the global. */
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
}

export class HttpRadarFeeds implements RadarFeeds {
  private readonly registry: string;
  private readonly timeoutMs: number;

  constructor(private readonly config: HttpRadarFeedsConfig) {
    this.registry = (config.registry ?? DEFAULT_NPM_REGISTRY).replace(/\/+$/, '');
    this.timeoutMs = config.timeoutMs ?? REQUEST_TIMEOUT_MS;
  }

  private get http(): typeof globalThis.fetch {
    return this.config.fetch ?? globalThis.fetch;
  }

  private async get(url: string, init?: RequestInit): Promise<Response> {
    const response = await this.http(url, {
      ...init,
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { 'user-agent': 'vorschicht-radar', ...(init?.headers ?? {}) },
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} für ${url}`);
    return response;
  }

  async billingChannels(): Promise<Array<FeedResult<string>>> {
    const results: Array<FeedResult<string>> = [];
    for (const url of this.config.billingUrls) {
      try {
        results.push({ live: true, origin: url, value: await (await this.get(url)).text() });
      } catch (error) {
        // A channel that did not answer is *not* a channel that said nothing.
        // It comes back with `live: false` and no text, so no signal can be
        // derived from it and the scan reports it as unchecked (decision 1).
        results.push({
          live: false,
          origin: url,
          value: '',
          problems: [`${url}: ${(error as Error).message}`],
        });
      }
    }
    return results;
  }

  async cliChannel(): Promise<FeedResult<string | null>> {
    const url = this.config.cliUrl;
    if (url === null) {
      return { live: false, origin: 'kein CLI-Release-Kanal konfiguriert', value: null };
    }
    try {
      return { live: true, origin: url, value: await (await this.get(url)).text() };
    } catch (error) {
      return {
        live: false,
        origin: url,
        value: null,
        problems: [`${url}: ${(error as Error).message}`],
      };
    }
  }

  async latestVersions(names: readonly string[]): Promise<FeedResult<Map<string, string>>> {
    const value = new Map<string, string>();
    const problems: string[] = [];
    let answered = false;

    await inBatches(names, REQUEST_CONCURRENCY, async (name) => {
      const url = `${this.registry}/${encodeURIComponent(name).replace('%40', '@')}`;
      try {
        // The abbreviated document is the registry's own answer to "I only want
        // dist-tags" and is a fraction of the full packument.
        const response = await this.get(url, {
          headers: { accept: 'application/vnd.npm.install-v1+json' },
        });
        const document = (await response.json()) as { 'dist-tags'?: Record<string, string> };
        answered = true;
        const latest = document['dist-tags']?.latest;
        if (typeof latest === 'string' && latest.length > 0) value.set(name, latest);
      } catch (error) {
        // Decision 4: one package's silence is not the whole reading's.
        problems.push(`${name}: ${(error as Error).message}`);
      }
    });

    return { live: answered, origin: this.registry, value, problems };
  }

  async advisories(installed: readonly InstalledPackage[]): Promise<FeedResult<AdvisoryFinding[]>> {
    if (installed.length === 0) {
      return { live: false, origin: this.registry, value: [] };
    }
    const body: Record<string, string[]> = {};
    for (const entry of installed) {
      const versions = body[entry.name];
      if (versions) versions.push(entry.version);
      else body[entry.name] = [entry.version];
    }

    const url = `${this.registry}/-/npm/v1/security/advisories/bulk`;
    try {
      const response = await this.get(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const document = (await response.json()) as Record<string, unknown>;
      return { live: true, origin: url, value: parseBulkAdvisories(document, installed) };
    } catch (error) {
      return {
        live: false,
        origin: url,
        value: [],
        problems: [`${url}: ${(error as Error).message}`],
      };
    }
  }
}

/**
 * The bulk endpoint's shape, read defensively.
 *
 * `{ "<name>": [ { id, title, severity, url, vulnerable_versions } ] }`. Every
 * field is checked rather than cast, because this is the one document in the
 * radar whose absence of a field would otherwise become `undefined` inside a P0
 * card's text. An entry with no usable id is dropped: the id *is* the dedup key
 * (A105.3's rule), and an advisory that cannot be deduplicated is a P0 a night.
 */
export function parseBulkAdvisories(
  document: Record<string, unknown>,
  installed: readonly InstalledPackage[],
): AdvisoryFinding[] {
  const versions = new Map<string, string>();
  for (const entry of installed)
    if (!versions.has(entry.name)) versions.set(entry.name, entry.version);

  const findings: AdvisoryFinding[] = [];
  for (const [name, raw] of Object.entries(document)) {
    if (!Array.isArray(raw)) continue;
    for (const item of raw) {
      if (!item || typeof item !== 'object') continue;
      const entry = item as Record<string, unknown>;
      const id = stringOf(entry.id) ?? stringOf(entry.ghsa_id) ?? stringOf(entry.cve_id);
      if (id === null) continue;
      const severity = stringOf(entry.severity)?.toLowerCase();
      findings.push({
        id,
        name,
        version: versions.get(name) ?? 'unbekannt',
        severity:
          severity === 'low' ||
          severity === 'moderate' ||
          severity === 'high' ||
          severity === 'critical'
            ? severity
            : 'unknown',
        title: stringOf(entry.title) ?? 'ohne Titel',
        url: stringOf(entry.url),
      });
    }
  }
  return findings.sort((a, b) => a.id.localeCompare(b.id));
}

function stringOf(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Decision 5, without a dependency: a fixed-width worker pool over a list. */
async function inBatches<T>(
  items: readonly T[],
  width: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      await work(item);
    }
  });
  await Promise.all(workers);
}

/**
 * The seeded half of §22's gate, and nothing the daemon ever constructs
 * (decision 6).
 *
 * Every reading it hands back is `live: false` with an origin that says so in
 * German, so a scan driven by it *cannot* report that the real channel was
 * queried — which is the property that makes it safe to export.
 */
export class FixtureRadarFeeds implements RadarFeeds {
  constructor(
    private readonly fixture: {
      billing?: string;
      cli?: string;
      latest?: Record<string, string>;
      advisories?: AdvisoryFinding[];
    },
  ) {}

  async billingChannels(): Promise<Array<FeedResult<string>>> {
    if (this.fixture.billing === undefined) return [];
    return [{ live: false, origin: 'Fixture (kein echter Abruf)', value: this.fixture.billing }];
  }

  async cliChannel(): Promise<FeedResult<string | null>> {
    return {
      live: false,
      origin: 'Fixture (kein echter Abruf)',
      value: this.fixture.cli ?? null,
    };
  }

  async latestVersions(names: readonly string[]): Promise<FeedResult<Map<string, string>>> {
    const value = new Map<string, string>();
    for (const name of names) {
      const latest = this.fixture.latest?.[name];
      if (latest !== undefined) value.set(name, latest);
    }
    return { live: false, origin: 'Fixture (kein echter Abruf)', value };
  }

  async advisories(
    _installed: readonly InstalledPackage[],
  ): Promise<FeedResult<AdvisoryFinding[]>> {
    return {
      live: false,
      origin: 'Fixture (kein echter Abruf)',
      value: this.fixture.advisories ?? [],
    };
  }
}
