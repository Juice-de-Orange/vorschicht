/**
 * The smallest semver this project needs, written rather than depended upon.
 *
 * A10's whole policy is a comparison — "patch/minor → auto-task, major/breaking
 * → MC inbox" — so the classification is the load-bearing part of the
 * dependency radar and not a detail underneath it. Adding `semver` as a runtime
 * dependency would also be a dependency added by the component whose job is to
 * report dependencies, which is a shape worth avoiding for its own sake; and the
 * three questions asked here (parse, compare, classify the difference) are the
 * part of that package's surface that fits on a page.
 *
 * Four decisions, all of which are about being wrong in the safe direction.
 *
 *  1. **What cannot be parsed is `unknown`, never `patch`.** A version this
 *     parser does not understand — a git URL, a `workspace:*`, a calendar
 *     version, a build tag it has never seen — must not be classified as the
 *     cheap case, because A10 sends the cheap case straight into an auto-task
 *     that merges through the gates unattended. Everything unreadable is treated
 *     as `major` by `classifyBump`, which sends it to the operator instead. The cost of
 *     that direction is a card nobody needed; the cost of the other is an
 *     unattended merge of a change nobody classified.
 *
 *  2. **A prerelease is never an upgrade target.** `1.2.3-rc.1` sorts *below*
 *     `1.2.3` by semver's own rule, and a registry that answers `dist-tags.latest`
 *     with a prerelease is answering a different question than the one A10 asks.
 *     `isUpgrade` refuses a prerelease target outright rather than ranking it, so
 *     a mis-tagged package cannot produce an auto-task onto an rc.
 *
 *  3. **`0.x` is treated as breaking on the minor.** Semver's own text makes
 *     anything below 1.0.0 unstable, and the ecosystem follows it: `0.2.0` after
 *     `0.1.9` routinely breaks. A10's "major/breaking" is the class, not the
 *     position of the digit, so a `0.x` minor bump goes to the operator. Stated because
 *     it is the one place this file deliberately disagrees with a naive reading
 *     of the version string.
 *
 *  4. **A range is coerced to its minimum, and that is what "current" means.**
 *     `^4.1.13` declares that 4.1.13 is what the manifest asks for; it is the
 *     number an update task would edit, and the number a reader compares against
 *     the registry. Where a lockfile is available the resolved version is used
 *     instead (`dependencies.ts`), which is strictly better — this is the
 *     fallback, and it is a lower bound on what is installed, so it can only
 *     over-report an update, never miss one.
 */

/** A parsed `x.y.z` with an optional prerelease. Build metadata is discarded. */
export interface SemverParts {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated identifiers of `-rc.1`, or null for a plain release. */
  prerelease: string[] | null;
}

/** How two versions differ, in A10's vocabulary. */
export type VersionBump = 'none' | 'patch' | 'minor' | 'major' | 'unknown';

/**
 * Leading range operators this parser will strip before reading a version.
 *
 * Deliberately not a range *evaluator*: `>=1.2.0 <2.0.0` and `1.x` are answered
 * with null rather than guessed at, and null becomes `unknown` above. A range
 * language half-understood is worse than one not understood at all, because the
 * half it gets wrong looks like an answer.
 */
const RANGE_PREFIX = /^[\s=v^~]+/;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

/** `null` when this is not a plain version — never a guess (decision 1). */
export function parseSemver(input: string): SemverParts | null {
  const match = SEMVER.exec(input.trim().replace(RANGE_PREFIX, ''));
  if (!match) return null;
  const [, major, minor, patch, prerelease] = match;
  // The regex guarantees all three, but the compiler does not know that and a
  // non-null assertion would be the one place a bad parse could pass silently.
  if (major === undefined || minor === undefined || patch === undefined) return null;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease === undefined ? null : prerelease.split('.'),
  };
}

/**
 * `-1`, `0` or `1`, by semver's precedence rules.
 *
 * Prerelease comparison follows the spec's own ordering: a release outranks any
 * prerelease of the same triple, numeric identifiers compare numerically and
 * rank below alphanumeric ones, and a longer identifier list wins a tie. That is
 * more than `isUpgrade` strictly needs — it refuses prerelease targets anyway
 * (decision 2) — and it is implemented because the alternative is a comparison
 * that is *almost* right, which is the kind that produces one wrong answer a
 * year in a component nobody re-reads.
 */
export function compareSemver(a: SemverParts, b: SemverParts): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  return comparePrerelease(a.prerelease, b.prerelease);
}

function comparePrerelease(a: readonly string[], b: readonly string[]): number {
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const left = a[index];
    const right = b[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNumeric = /^\d+$/.test(left);
    const rightNumeric = /^\d+$/.test(right);
    if (leftNumeric && rightNumeric) {
      if (left !== right) return Number(left) < Number(right) ? -1 : 1;
      continue;
    }
    // Spec: numeric identifiers always have lower precedence than alphanumeric.
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/**
 * A10's class for the step from `current` to `latest`.
 *
 * Returns `unknown` when either side is unreadable; the caller treats that as
 * breaking (decision 1), and it is a separate value rather than simply `major`
 * so the card can say *why* it is asking rather than claiming a major bump that
 * nobody established.
 */
export function classifyBump(current: string, latest: string): VersionBump {
  const from = parseSemver(current);
  const to = parseSemver(latest);
  if (!from || !to) return 'unknown';
  if (compareSemver(from, to) >= 0) return 'none';
  if (from.major !== to.major) return 'major';
  // Decision 3: below 1.0.0 the minor is where the ecosystem puts its breaks.
  if (from.minor !== to.minor) return from.major === 0 ? 'major' : 'minor';
  return from.major === 0 && from.minor === 0 ? 'major' : 'patch';
}

/**
 * Is `latest` a version this radar would ever propose moving to?
 *
 * Both halves matter and they fail differently: an unreadable target is not an
 * upgrade because nothing was established, and a prerelease target is not an
 * upgrade because it is not a release (decision 2).
 */
export function isUpgrade(current: string, latest: string): boolean {
  const from = parseSemver(current);
  const to = parseSemver(latest);
  if (!from || !to) return false;
  if (to.prerelease !== null) return false;
  return compareSemver(from, to) < 0;
}
