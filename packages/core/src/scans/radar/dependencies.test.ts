/**
 * A10's collection and A10's policy — and the policy is tested by its absences.
 *
 * "patch/minor → auto-task through gates; major/breaking → MC inbox" is two
 * rules and four claims: a patch produces a task **and no card**, a major
 * produces a card **and no task**. A suite that only asserted the presences
 * would pass against an implementation that did both for everything, which is
 * exactly the implementation nobody wants — an unattended merge of a breaking
 * change, plus an inbox card for every patch.
 *
 * The reader is driven against this repository's **own** `pnpm-lock.yaml` as
 * well as against fixtures. A parser proven only on a fixture is a parser proven
 * against the author's idea of the format (A80's lesson: a checker's first run
 * against input nobody designed it for is worth more than its unit tests).
 */
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  type AdvisoryFinding,
  applyRadarPolicy,
  type DependencyUpdate,
  planUpdates,
  readDependencies,
  separateAdvisories,
} from './dependencies.js';

const repoRoot = join(import.meta.dirname, '../../../../..');

async function project(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'radar-deps-'));
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(root, name), content, 'utf8');
  }
  return root;
}

const LOCKFILE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true

importers:

  .:
    dependencies:
      zod:
        specifier: ^4.1.13
        version: 4.4.3
    devDependencies:
      '@biomejs/biome':
        specifier: ^2.3.14
        version: 2.5.6
      vitest:
        specifier: ^3.2.4
        version: 3.2.7(@types/node@22.20.1)(tsx@4.23.1)

  apps/server:
    dependencies:
      '@vorschicht/core':
        specifier: workspace:*
        version: link:../../packages/core
      hono:
        specifier: ^4.12.32
        version: 4.12.32

packages:

  zod@4.4.3:
    resolution: {integrity: sha512-nichtecht}
`;

describe('readDependencies', () => {
  it('liest die Importer-Abschnitte eines echten Lockfiles', async () => {
    const inventory = await readDependencies(await project({ 'pnpm-lock.yaml': LOCKFILE }));
    expect(inventory.source).toBe('lockfile');
    expect(inventory.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'zod', current: '4.4.3', importer: '.', dev: false }),
        expect.objectContaining({ name: '@biomejs/biome', current: '2.5.6', dev: true }),
        expect.objectContaining({ name: 'hono', current: '4.12.32', importer: 'apps/server' }),
      ]),
    );
  });

  it('streift die Peer-Auflösung von der Version', async () => {
    // `3.2.7(@types/node@22.20.1)` is a resolution, not a version, and a reader
    // that kept it would classify every such package as unknown — that is,
    // would send vitest to the operator as "unreadable" on every single run.
    const inventory = await readDependencies(await project({ 'pnpm-lock.yaml': LOCKFILE }));
    expect(inventory.dependencies.find((entry) => entry.name === 'vitest')?.current).toBe('3.2.7');
  });

  it('überspringt Workspace-Verweise und sagt, dass es sie übersprungen hat', async () => {
    const inventory = await readDependencies(await project({ 'pnpm-lock.yaml': LOCKFILE }));
    expect(inventory.dependencies.map((entry) => entry.name)).not.toContain('@vorschicht/core');
    expect(inventory.skipped).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: '@vorschicht/core' })]),
    );
  });

  it('läuft nicht in die riesigen Abschnitte hinter `importers:`', async () => {
    // Decision 2: a key at column 0 ends the section. `zod@4.4.3:` under
    // `packages:` is indented by two and would otherwise read as an importer.
    const inventory = await readDependencies(await project({ 'pnpm-lock.yaml': LOCKFILE }));
    expect(inventory.dependencies.map((entry) => entry.importer).sort()).toEqual([
      '.',
      '.',
      '.',
      'apps/server',
    ]);
  });

  it('fällt ohne Lockfile auf das Wurzelmanifest zurück und nennt die Quelle', async () => {
    const inventory = await readDependencies(
      await project({
        'package.json': JSON.stringify({
          dependencies: { zod: '^4.1.13', '@vorschicht/db': 'workspace:*' },
          devDependencies: { vitest: '~3.2.4', tsx: 'latest' },
        }),
      }),
    );
    expect(inventory.source).toBe('manifest');
    // Decision 1: a range coerces to its minimum, which is a lower bound on
    // what is installed — it can over-report an update, never miss one.
    expect(inventory.dependencies).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'zod', current: '4.1.13', specifier: '^4.1.13' }),
        expect.objectContaining({ name: 'vitest', current: '3.2.4', dev: true }),
      ]),
    );
    expect(inventory.skipped.map((entry) => entry.name).sort()).toEqual(['@vorschicht/db', 'tsx']);
  });

  it('meldet ein Projekt ohne beide Dateien als «nichts geprüft», nicht als leer', async () => {
    const inventory = await readDependencies(await project({}));
    expect(inventory.source).toBe('none');
    expect(inventory.dependencies).toEqual([]);
  });

  it('liest das echte Lockfile dieses Repositories', async () => {
    // A80: the first run against input nobody wrote for this parser is worth
    // more than the fixture above. If pnpm ever changes the format, this is the
    // assertion that notices — and it notices before a silent empty inventory
    // makes the radar report "nothing to update" forever.
    const inventory = await readDependencies(repoRoot);
    expect(inventory.source).toBe('lockfile');
    expect(inventory.dependencies.length).toBeGreaterThan(20);
    const zod = inventory.dependencies.find(
      (entry) => entry.name === 'zod' && entry.importer === 'packages/core',
    );
    expect(zod?.specifier).toBe('^4.1.13');
    expect(zod?.current).toMatch(/^4\.\d+\.\d+$/);
    // Every workspace link skipped, and none of them mistaken for a version.
    expect(inventory.dependencies.some((entry) => entry.current.startsWith('link:'))).toBe(false);
    expect(inventory.skipped.length).toBeGreaterThan(0);
  });
});

describe('planUpdates', () => {
  const inventory = {
    source: 'lockfile' as const,
    dependencies: [
      { name: 'a', importer: '.', specifier: '^1.0.0', current: '1.0.0', dev: false },
      { name: 'a', importer: 'apps/x', specifier: '^1.2.0', current: '1.2.0', dev: false },
      { name: 'b', importer: '.', specifier: '^2.0.0', current: '2.0.0', dev: true },
    ],
    skipped: [],
    problems: [],
  };

  it('fasst ein Paket über mehrere Importer zu einer Zeile zusammen', () => {
    const updates = planUpdates(inventory, new Map([['a', '1.3.0']]));
    expect(updates).toHaveLength(1);
    expect(updates[0]?.importers).toEqual(['.', 'apps/x']);
  });

  it('nimmt die am weitesten zurückliegende Version — also den größeren Schritt', () => {
    // Decision 4, and the safe direction: `1.0.0 → 1.3.0` is minor, `1.2.0 →
    // 1.3.0` is minor too, but for `2.0.0` the first is major and the second is
    // not. Taking the higher `current` would file a breaking change as routine.
    const updates = planUpdates(inventory, new Map([['a', '2.0.0']]));
    expect(updates[0]?.current).toBe('1.0.0');
    expect(updates[0]?.bump).toBe('major');
  });

  it('lässt ein Paket weg, nach dem niemand gefragt hat', () => {
    // Absent from the feed means "not asked or not answered", which must not
    // read the same as "nothing newer".
    expect(planUpdates(inventory, new Map())).toEqual([]);
  });

  it('lässt Gleichstand und Rückschritt weg', () => {
    expect(planUpdates(inventory, new Map([['b', '2.0.0']]))).toEqual([]);
    expect(planUpdates(inventory, new Map([['b', '1.9.0']]))).toEqual([]);
  });
});

describe('applyRadarPolicy', () => {
  const update = (name: string, current: string, latest: string): DependencyUpdate => ({
    name,
    current,
    latest,
    bump:
      planUpdates(
        {
          source: 'lockfile',
          dependencies: [{ name, importer: '.', specifier: current, current, dev: false }],
          skipped: [],
          problems: [],
        },
        new Map([[name, latest]]),
      )[0]?.bump ?? 'unknown',
    importers: ['.'],
  });

  it('schickt Patch und Minor in den Aufgaben-Zweig', () => {
    const plan = applyRadarPolicy([update('a', '1.0.0', '1.0.1'), update('b', '1.0.0', '1.1.0')]);
    expect(plan.routine.map((entry) => entry.name)).toEqual(['a', 'b']);
    expect(plan.breaking).toEqual([]);
  });

  it('schickt eine Hauptversion in den Karten-Zweig', () => {
    const plan = applyRadarPolicy([update('a', '1.0.0', '2.0.0')]);
    expect(plan.breaking.map((entry) => entry.name)).toEqual(['a']);
    expect(plan.routine).toEqual([]);
  });

  it('schickt Unlesbares zum Betreiber, nicht in die Warteschlange', () => {
    // Decision 5. This is the branch that decides whether an unclassified change
    // merges unattended.
    const plan = applyRadarPolicy([
      { name: 'a', current: 'nightly', latest: 'auch-nightly', bump: 'unknown', importers: ['.'] },
    ]);
    expect(plan.breaking).toHaveLength(1);
    expect(plan.routine).toEqual([]);
  });
});

describe('separateAdvisories', () => {
  const advisory: AdvisoryFinding = {
    id: 'GHSA-test',
    name: 'a',
    version: '1.0.0',
    severity: 'high',
    title: 'egal',
    url: null,
  };

  it('nimmt ein Paket mit Hinweis aus dem Versions-Zweig heraus', () => {
    // Decision 7: a patch that also fixes a CVE must not be filed as routine
    // and merged quietly some time in the next few days.
    const updates: DependencyUpdate[] = [
      { name: 'a', current: '1.0.0', latest: '1.0.1', bump: 'patch', importers: ['.'] },
      { name: 'b', current: '1.0.0', latest: '1.0.1', bump: 'patch', importers: ['.'] },
    ];
    expect(separateAdvisories(updates, [advisory]).map((entry) => entry.name)).toEqual(['b']);
  });

  it('lässt alles stehen, wenn es keine Hinweise gibt', () => {
    const updates: DependencyUpdate[] = [
      { name: 'a', current: '1.0.0', latest: '1.0.1', bump: 'patch', importers: ['.'] },
    ];
    expect(separateAdvisories(updates, [])).toEqual(updates);
  });
});
