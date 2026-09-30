/**
 * A10's dependency radar: the deterministic half, and the policy.
 *
 * "Radar policy: dependency patch/minor → auto-task through gates;
 * major/breaking → MC inbox; security advisories → P0."
 *
 * The collection is a file read and the policy is a pure function, deliberately
 * and for one reason: A10's rule is about *absences* as much as presences — a
 * patch update must produce a task **and no card**, a major must produce a card
 * **and no task** — and an absence can only be asserted by a test that can
 * produce the presence. A radar whose inventory came out of an agent session
 * would put both halves behind a model turn, where a test either spends
 * subscription budget or asserts against a stub that was told what to say.
 *
 * Seven decisions.
 *
 *  1. **The lockfile first, the manifest as fallback, and the reader says which
 *     it used.** `pnpm-lock.yaml`'s `importers:` section is the only place that
 *     answers *what is installed* rather than *what is asked for*, and it covers
 *     every workspace member without needing to know the workspace globs. Where
 *     there is no lockfile the root manifest's ranges are coerced to their
 *     minimum (`semver.ts` decision 4), which is a lower bound on what is
 *     installed: it can over-report an update, never miss one. `source` travels
 *     out with the inventory so a report never has to imply which happened.
 *
 *  2. **A narrow, indentation-driven parser, not a YAML dependency.** Adding one
 *     to read a lockfile is a dependency added by the component that exists to
 *     report dependencies, and the shape being read is four levels deep and
 *     fixed by pnpm's own writer. What the parser refuses to do is guess: it
 *     reads `importers:` and stops at the next column-0 key, so `packages:` and
 *     `snapshots:` — the two enormous sections — are never walked at all.
 *
 *  3. **Workspace links are skipped, and skipping is recorded.** `workspace:*`
 *     resolves to `link:../../packages/core`, which is not a version and has no
 *     registry entry; proposing an "update" for it would be proposing to change
 *     this repository into a version of itself. They go into `skipped` with the
 *     reason rather than being dropped, because a silently shorter inventory is
 *     indistinguishable from a smaller project (§8.2's sixth domain).
 *
 *  4. **One update per package name, taken at its furthest-behind version.** A
 *     dependency declared by four workspace members is one thing to update; the
 *     lowest installed version decides the class, which is the safe direction —
 *     a lower `current` yields a larger bump, and a larger bump goes to the operator
 *     rather than into an unattended merge.
 *
 *  5. **`unknown` is filed as breaking.** `semver.ts` decision 1 refuses to
 *     classify what it cannot parse; A10's auto-task branch is the one that
 *     merges without the operator, so anything unclassified takes the branch that asks
 *     him. The card then says the version could not be read, which is a
 *     different sentence from "this is a major release" and is the true one.
 *
 *  6. **A single task for all routine updates, never one per package.** A10
 *     says patch/minor becomes "an auto-task"; forty of them would be forty
 *     branches, forty gate suites and forty merges for work that belongs in one
 *     diff — and §10 would serialise them all against each other anyway, since
 *     they all claim the same manifest and lockfile.
 *
 *  7. **An advisory is its own thing and never folded into the version class.**
 *     A10 gives advisories their own line and their own urgency; a `patch` that
 *     also fixes a CVE must not be filed as routine and merged quietly at some
 *     point in the next few days. `separateAdvisories` splits them out first, so
 *     a package appears in at most one of the three outcomes.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { classifyBump, compareSemver, isUpgrade, parseSemver, type VersionBump } from './semver.js';

/** One dependency a project declares, as read from disk. */
export interface DeclaredDependency {
  name: string;
  /** The workspace member that declares it; `.` for the repository root. */
  importer: string;
  /** Verbatim from the manifest — `^4.1.13`, `workspace:*`, a git URL. */
  specifier: string;
  /** Installed (lockfile) or the range's minimum (manifest). See decision 1. */
  current: string;
  dev: boolean;
}

export type DependencyInventorySource = 'lockfile' | 'manifest' | 'none';

export interface DependencyInventory {
  source: DependencyInventorySource;
  dependencies: DeclaredDependency[];
  /** Decision 3: what was deliberately not counted, and why. */
  skipped: Array<{ name: string; reason: string }>;
  /** What could not be read. Never thrown — a radar that dies reports nothing. */
  problems: string[];
}

/** A package this radar would propose moving forward. */
export interface DependencyUpdate {
  name: string;
  current: string;
  latest: string;
  bump: VersionBump;
  /** Every workspace member that declares it, sorted. */
  importers: string[];
}

/** One advisory against an installed version (A10's third branch). */
export interface AdvisoryFinding {
  /** The advisory's own id — the dedup key, so it must be the publisher's. */
  id: string;
  name: string;
  /** The installed version the advisory was matched against. */
  version: string;
  severity: 'low' | 'moderate' | 'high' | 'critical' | 'unknown';
  title: string;
  url: string | null;
}

/** A10's three branches, decided (decisions 5, 6, 7). */
export interface DependencyPlan {
  /** Patch and minor: exactly one task between them, or none at all. */
  routine: DependencyUpdate[];
  /** Major, and anything unclassifiable: one inbox item each. */
  breaking: DependencyUpdate[];
}

const LOCKFILE = 'pnpm-lock.yaml';
const MANIFEST = 'package.json';

/**
 * What a project depends on today (decision 1).
 *
 * Never throws: a project with neither file is `source: 'none'` with an empty
 * list, which is a different answer from "nothing is out of date" and is
 * reported as such by the scan.
 */
export async function readDependencies(rootPath: string): Promise<DependencyInventory> {
  const fromLock = await readLockfile(join(rootPath, LOCKFILE));
  if (fromLock) return fromLock;
  return readRootManifest(join(rootPath, MANIFEST));
}

/**
 * `importers:` only (decision 2).
 *
 * Returns null when the file is absent or carries no importers, so the caller
 * falls through to the manifest rather than reporting an empty project. A file
 * that exists but cannot be read is *not* null — that is a problem to report,
 * and falling through would hide it behind a thinner answer.
 */
async function readLockfile(path: string): Promise<DependencyInventory | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    return {
      source: 'none',
      dependencies: [],
      skipped: [],
      problems: [`${LOCKFILE} nicht lesbar: ${(error as Error).message}`],
    };
  }

  const inventory: DependencyInventory = {
    source: 'lockfile',
    dependencies: [],
    skipped: [],
    problems: [],
  };

  let inImporters = false;
  let importer: string | null = null;
  let dev = false;
  let name: string | null = null;
  let specifier: string | null = null;

  const flush = (version: string | null): void => {
    if (name === null || importer === null) return;
    const spec = specifier ?? '';
    if (version === null) {
      inventory.skipped.push({ name, reason: 'keine aufgelöste Version im Lockfile' });
    } else if (version.startsWith('link:') || spec.startsWith('workspace:')) {
      // Decision 3: a workspace link is this repository, not a dependency.
      inventory.skipped.push({ name, reason: 'Workspace-Verweis, keine Fremdversion' });
    } else {
      inventory.dependencies.push({
        name,
        importer,
        specifier: spec,
        // `3.2.7(@types/node@22.20.1)` — peer resolutions ride along in the
        // same field and are not part of the version.
        current: version.split('(')[0] ?? version,
        dev,
      });
    }
    name = null;
    specifier = null;
  };

  for (const line of text.split('\n')) {
    if (/^\S/.test(line)) {
      // A key at column 0 ends the section, whatever it is. `packages:` and
      // `snapshots:` are never walked (decision 2).
      flush(null);
      inImporters = line.startsWith('importers:');
      importer = null;
      continue;
    }
    if (!inImporters) continue;

    const indent = line.length - line.trimStart().length;
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    if (indent === 2 && trimmed.endsWith(':')) {
      flush(null);
      importer = unquote(trimmed.slice(0, -1));
      dev = false;
      continue;
    }
    if (indent === 4 && trimmed.endsWith(':')) {
      flush(null);
      dev = trimmed.startsWith('devDependencies');
      continue;
    }
    if (indent === 6 && trimmed.endsWith(':')) {
      flush(null);
      name = unquote(trimmed.slice(0, -1));
      continue;
    }
    if (indent === 8 && name !== null) {
      if (trimmed.startsWith('specifier:')) {
        specifier = unquote(trimmed.slice('specifier:'.length).trim());
      } else if (trimmed.startsWith('version:')) {
        flush(unquote(trimmed.slice('version:'.length).trim()));
      }
    }
  }
  flush(null);

  if (inventory.dependencies.length === 0 && inventory.skipped.length === 0) return null;
  return inventory;
}

/** The fallback: declared ranges from the root manifest (decision 1). */
async function readRootManifest(path: string): Promise<DependencyInventory> {
  const inventory: DependencyInventory = {
    source: 'manifest',
    dependencies: [],
    skipped: [],
    problems: [],
  };

  let document: Record<string, unknown>;
  try {
    document = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { ...inventory, source: 'none' };
    return {
      ...inventory,
      source: 'none',
      problems: [`${MANIFEST} nicht lesbar: ${(error as Error).message}`],
    };
  }

  for (const [field, dev] of [
    ['dependencies', false],
    ['devDependencies', true],
  ] as const) {
    const block = document[field];
    if (!block || typeof block !== 'object') continue;
    for (const [name, raw] of Object.entries(block as Record<string, unknown>)) {
      if (typeof raw !== 'string') continue;
      if (raw.startsWith('workspace:') || raw.startsWith('link:') || raw.startsWith('file:')) {
        inventory.skipped.push({ name, reason: 'Workspace-Verweis, keine Fremdversion' });
        continue;
      }
      const minimum = parseSemver(raw);
      if (!minimum) {
        inventory.skipped.push({ name, reason: `Bereich «${raw}» ist keine lesbare Version` });
        continue;
      }
      inventory.dependencies.push({
        name,
        importer: '.',
        specifier: raw,
        current: `${minimum.major}.${minimum.minor}.${minimum.patch}`,
        dev,
      });
    }
  }

  return inventory;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed.startsWith("'") || trimmed.startsWith('"'))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/**
 * Every package the channel has moved past, one row per name (decision 4).
 *
 * `latest` is whatever the feed answered; a name the feed did not answer for is
 * simply absent from the result, because "we did not ask" and "there is nothing
 * newer" must not produce the same row.
 */
export function planUpdates(
  inventory: DependencyInventory,
  latest: ReadonlyMap<string, string>,
): DependencyUpdate[] {
  const byName = new Map<string, DependencyUpdate>();

  for (const declared of inventory.dependencies) {
    const target = latest.get(declared.name);
    if (target === undefined) continue;
    if (!isUpgrade(declared.current, target)) continue;

    const seen = byName.get(declared.name);
    if (!seen) {
      byName.set(declared.name, {
        name: declared.name,
        current: declared.current,
        latest: target,
        bump: classifyBump(declared.current, target),
        importers: [declared.importer],
      });
      continue;
    }
    if (!seen.importers.includes(declared.importer)) seen.importers.push(declared.importer);
    // Decision 4: the furthest-behind version decides, which is the larger bump.
    if (behind(declared.current, seen.current)) {
      seen.current = declared.current;
      seen.bump = classifyBump(declared.current, target);
    }
  }

  for (const update of byName.values()) update.importers.sort();
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function behind(candidate: string, incumbent: string): boolean {
  const a = parseSemver(candidate);
  const b = parseSemver(incumbent);
  if (!a || !b) return false;
  return compareSemver(a, b) < 0;
}

/**
 * Decision 7: advisories claim their packages before the version class runs.
 *
 * Returns the updates that are *not* covered by an advisory, so a caller cannot
 * file the same package twice. The advisories themselves are returned unchanged
 * — they are already the finding, whether or not a newer version exists.
 */
export function separateAdvisories(
  updates: readonly DependencyUpdate[],
  advisories: readonly AdvisoryFinding[],
): DependencyUpdate[] {
  const claimed = new Set(advisories.map((advisory) => advisory.name));
  return updates.filter((update) => !claimed.has(update.name));
}

/** A10's split, with `unknown` on the side that asks the operator (decision 5). */
export function applyRadarPolicy(updates: readonly DependencyUpdate[]): DependencyPlan {
  const routine: DependencyUpdate[] = [];
  const breaking: DependencyUpdate[] = [];
  for (const update of updates) {
    if (update.bump === 'patch' || update.bump === 'minor') routine.push(update);
    else if (update.bump === 'major' || update.bump === 'unknown') breaking.push(update);
    // `none` cannot reach here — `planUpdates` filters it — and is skipped
    // rather than thrown on, because a policy function is not the place to
    // discover that an upstream filter changed.
  }
  return { routine, breaking };
}
