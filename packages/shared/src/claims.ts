/**
 * File claims (§10): the glob grammar, and whether two claim sets can collide.
 *
 * §10 gives claims one job — "Two active tasks never hold overlapping claims in
 * the same project" — and that sentence only means something if "overlapping"
 * is decidable. It is not the same question as matching: two globs overlap when
 * *some* path would match both, and neither glob has to be a path. A claim on
 * `src/**` and a claim on every TypeScript file in the tree share not one
 * character, and collide on every TypeScript file under `src`.
 *
 * Three properties this module is built around:
 *
 *  1. **The dangerous answer is "disjoint".** A false "they overlap" costs
 *     throughput — the second task waits when it need not have. A false "they
 *     are disjoint" puts two coders in the same file, which is the failure the
 *     whole of §10 exists to prevent. So every approximation here leans towards
 *     overlap, and the fuzz test in `claims.test.ts` asserts exactly that
 *     direction: whenever `globsIntersect` says no, no path matches both.
 *
 *  2. **The grammar is deliberately small, and unparseable input is refused
 *     rather than guessed at.** Character classes, negation and backslash
 *     escapes are rejected at registration with a German sentence the Planner
 *     can act on. A claim nobody can reason about is worse than no claim: it
 *     reads as a safeguard and behaves like a blank cheque.
 *
 *  3. **Pure and lexical.** Nothing here touches the filesystem, because the
 *     three consumers ask at different times: the registry before any file
 *     exists, the §6.6 containment hook while the write is being attempted, and
 *     the Reviewer afterwards against a diff. They must all get one answer.
 *
 * Paths are repository-relative and POSIX. That is the form a diff, a hook
 * payload and a claim set all already have; anchoring at the worktree root
 * would tie a claim to a directory name that changes with the task id.
 */

/** The four tokens the grammar knows. Both renderings below derive from this. */
export const CLAIM_GLOB_TOKENS = ['*', '?', '**', '{a,b}'] as const;

/**
 * What the Planner may write, in German. Anything else is refused (see header).
 *
 * German because this string is only ever read in a rejection — and a rejection
 * lands in the task timeline, which the operator reads (§2's user-facing rule).
 */
export const CLAIM_GLOB_SYNTAX = [
  '`*` — beliebig viele Zeichen innerhalb eines Pfadsegments',
  '`?` — genau ein Zeichen innerhalb eines Pfadsegments',
  '`**` — null oder mehr vollständige Pfadsegmente (allein im Segment)',
  '`{a,b}` — Alternativen, werden vor der Prüfung ausgeschrieben',
] as const;

/**
 * The same grammar in English, for the Planner's role prompt (§2: agents work
 * internally in English).
 *
 * Two renderings of one grammar is a drift risk, so `claims.test.ts` asserts
 * they describe the same four tokens in the same order. The alternative —
 * teaching the Planner the grammar in German inside an English system prompt —
 * costs comprehension at exactly the point where a mistake means a rejected
 * plan, and a Planner should learn the grammar from its prompt rather than from
 * an error message.
 */
export const CLAIM_GLOB_SYNTAX_EN = [
  '`*` — any number of characters within one path segment',
  '`?` — exactly one character within one path segment',
  '`**` — zero or more complete path segments (must stand alone in its segment)',
  '`{a,b}` — alternatives, expanded before any check',
] as const;

/** Brace alternation is expanded eagerly; this bounds the blast radius. */
const MAX_BRACE_EXPANSION = 64;

/** A claim set larger than this is a planning defect, not a claim set. */
export const MAX_CLAIM_GLOBS = 200;

export class InvalidClaimGlobError extends Error {
  constructor(
    readonly glob: string,
    readonly problem: string,
  ) {
    super(
      `Claim-Muster "${glob}" ist nicht zulässig: ${problem}. ` +
        `Erlaubt sind: ${CLAIM_GLOB_SYNTAX.join(' · ')}.`,
    );
    this.name = 'InvalidClaimGlobError';
  }
}

/**
 * Bring a glob into the one shape everything else here assumes.
 *
 * Two conveniences are deliberate rather than magic: a trailing slash means the
 * subtree (`src/` → `src/**`), because that is what someone writing it means;
 * and `./` prefixes and doubled slashes are dropped rather than refused,
 * because they are noise, not intent. A bare `src` stays literal — claiming a
 * subtree is spelled `src/**`, and guessing otherwise would silently widen a
 * claim set on the Planner's behalf.
 */
export function normaliseClaimGlob(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') throw new InvalidClaimGlobError(raw, 'leer');
  if (trimmed.includes('\\')) {
    throw new InvalidClaimGlobError(raw, 'Backslashes sind nicht erlaubt (POSIX-Pfade)');
  }
  if (trimmed.startsWith('/')) {
    throw new InvalidClaimGlobError(raw, 'Claims sind relativ zum Projektwurzelverzeichnis');
  }

  const subtree = trimmed.endsWith('/');
  const segments = trimmed.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.includes('..')) {
    throw new InvalidClaimGlobError(raw, '".." führt aus dem Projekt heraus');
  }
  if (segments.length === 0) {
    throw new InvalidClaimGlobError(raw, 'verweist auf kein Verzeichnis und keine Datei');
  }
  if (subtree) segments.push('**');
  return segments.join('/');
}

/**
 * Validate a single glob and return its brace-free alternatives.
 *
 * One written glob can become several patterns (`*.{ts,tsx}` is two), and every
 * downstream question — matching, intersection — is then asked of each.
 */
export function parseClaimGlob(raw: string): string[] {
  const normalised = normaliseClaimGlob(raw);
  const expanded = expandBraces(normalised, raw);
  for (const pattern of expanded) {
    assertSupportedPattern(pattern, raw);
  }
  return expanded;
}

/**
 * Validate a claim set, normalised and de-duplicated, order preserved.
 *
 * Order is kept because it is the Planner's, and a claim set read back in a
 * different order than it was written reads like something changed it.
 */
export function validateClaimGlobs(globs: readonly string[]): string[] {
  if (globs.length > MAX_CLAIM_GLOBS) {
    throw new InvalidClaimGlobError(
      `${globs.length} Muster`,
      `mehr als ${MAX_CLAIM_GLOBS} Claims sprechen für einen zu groben Planungsschnitt (§10)`,
    );
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const glob of globs) {
    const normalised = normaliseClaimGlob(glob);
    // Parsed for its side effect — the syntax check — on every alternative.
    parseClaimGlob(glob);
    if (seen.has(normalised)) continue;
    seen.add(normalised);
    result.push(normalised);
  }
  return result;
}

/** Does this repository-relative path fall inside the glob? */
export function globMatchesPath(glob: string, path: string): boolean {
  const parts = normalisePath(path);
  if (parts === null) return false;
  return parseClaimGlob(glob).some((pattern) => segmentsMatch(pattern.split('/'), parts));
}

/** §6.6: may a session that holds these claims touch this path? */
export function claimAllowsPath(globs: readonly string[], path: string): boolean {
  return globs.some((glob) => globMatchesPath(glob, path));
}

/**
 * One `*`/`?` pattern against one path segment.
 *
 * Exported for `containment.ts`, whose secret-file patterns (`.env*`, `*.pem`)
 * are segment patterns rather than path globs. Sharing the matcher rather than
 * writing a second one is the point: two implementations of `*` would
 * eventually disagree, and the place they would disagree is a question of the
 * form "is this file a credential".
 */
export function segmentGlobMatches(pattern: string, segment: string): boolean {
  return segmentMatches(pattern, segment);
}

/**
 * Could any one path match both globs?
 *
 * The segment-level walk treats `**` as "zero or more segments" and hands each
 * ordinary segment pair to a character-level walk. Both are memoised, so a
 * pathological pair costs O(segments²·chars²) rather than exponential time —
 * this runs inside the scheduling lock, where a slow answer is a stalled queue.
 */
export function globsIntersect(left: string, right: string): boolean {
  const lefts = parseClaimGlob(left);
  const rights = parseClaimGlob(right);
  for (const a of lefts) {
    for (const b of rights) {
      if (segmentsIntersect(a.split('/'), b.split('/'))) return true;
    }
  }
  return false;
}

/** Which pairs of two claim sets collide. Empty means the two may run at once. */
export function claimSetsOverlap(
  ours: readonly string[],
  theirs: readonly string[],
): Array<{ ours: string; theirs: string }> {
  const overlaps: Array<{ ours: string; theirs: string }> = [];
  for (const a of ours) {
    for (const b of theirs) {
      if (globsIntersect(a, b)) overlaps.push({ ours: a, theirs: b });
    }
  }
  return overlaps;
}

// --- internals ---------------------------------------------------------------

/**
 * Reject what cannot be reasoned about, and say why in German (§2).
 *
 * `**` sharing a segment with anything else is the subtle one: minimatch quietly
 * downgrades `**.ts` to `*.ts`, which claims one directory level instead of the
 * subtree the author meant. Silently narrowing a claim is precisely how two
 * coders end up in one file, so it is refused instead.
 */
function assertSupportedPattern(pattern: string, raw: string): void {
  for (const forbidden of ['[', ']', '!', '{', '}']) {
    if (pattern.includes(forbidden)) {
      throw new InvalidClaimGlobError(
        raw,
        `"${forbidden}" wird nicht unterstützt (Zeichenklassen und Negation sind ausgeschlossen)`,
      );
    }
  }
  for (const segment of pattern.split('/')) {
    if (segment.includes('**') && segment !== '**') {
      throw new InvalidClaimGlobError(
        raw,
        '"**" muss ein ganzes Pfadsegment sein — "**/x" statt "**x"',
      );
    }
  }
}

/** `a{b,c}d` → `abd`, `acd`. Nested braces are refused, not half-supported. */
function expandBraces(pattern: string, raw: string): string[] {
  const open = pattern.indexOf('{');
  if (open === -1) {
    if (pattern.includes('}')) throw new InvalidClaimGlobError(raw, 'schließende "}" ohne "{"');
    return [pattern];
  }
  const close = pattern.indexOf('}', open);
  if (close === -1) throw new InvalidClaimGlobError(raw, 'öffnende "{" ohne "}"');
  const body = pattern.slice(open + 1, close);
  if (body.includes('{')) throw new InvalidClaimGlobError(raw, 'verschachtelte Klammern');
  if (body === '') throw new InvalidClaimGlobError(raw, 'leere Alternative "{}"');

  const head = pattern.slice(0, open);
  const tail = pattern.slice(close + 1);
  const results: string[] = [];
  for (const alternative of body.split(',')) {
    if (alternative === '') throw new InvalidClaimGlobError(raw, 'leere Alternative in "{…}"');
    for (const rest of expandBraces(`${head}${alternative}${tail}`, raw)) {
      if (results.length >= MAX_BRACE_EXPANSION) {
        throw new InvalidClaimGlobError(raw, `mehr als ${MAX_BRACE_EXPANSION} Alternativen`);
      }
      results.push(rest);
    }
  }
  return results;
}

/**
 * Path → segments, or null when the path is not one we could ever claim.
 *
 * An absolute path is refused rather than reinterpreted. Dropping the leading
 * empty segment would turn `/etc/passwd` into `etc/passwd`, which a claim of
 * `**` then happily matches — and §6.6's hook asks this function whether a
 * write is inside the claim set. Silently making an absolute path relative is
 * how a containment check says yes to a file outside the repository.
 */
function normalisePath(path: string): string[] | null {
  if (path.includes('\\') || path.startsWith('/')) return null;
  const segments = path.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.length === 0 || segments.includes('..')) return null;
  return segments;
}

function segmentsMatch(pattern: readonly string[], parts: readonly string[]): boolean {
  const memo = new Int8Array((pattern.length + 1) * (parts.length + 1));
  const width = parts.length + 1;

  const go = (i: number, j: number): boolean => {
    const key = i * width + j;
    const cached = memo[key];
    if (cached !== 0) return cached === 1;
    let result: boolean;
    if (i === pattern.length) {
      result = j === parts.length;
    } else if (pattern[i] === '**') {
      // Zero segments, or absorb this one and stay put.
      result = go(i + 1, j) || (j < parts.length && go(i, j + 1));
    } else if (j === parts.length) {
      result = false;
    } else {
      result = segmentMatches(pattern[i] as string, parts[j] as string) && go(i + 1, j + 1);
    }
    memo[key] = result ? 1 : -1;
    return result;
  };

  return go(0, 0);
}

/** One segment pattern (`*`, `?`, literals) against one concrete segment. */
function segmentMatches(pattern: string, text: string): boolean {
  const memo = new Int8Array((pattern.length + 1) * (text.length + 1));
  const width = text.length + 1;

  const go = (i: number, j: number): boolean => {
    const key = i * width + j;
    const cached = memo[key];
    if (cached !== 0) return cached === 1;
    let result: boolean;
    if (i === pattern.length) {
      result = j === text.length;
    } else if (pattern[i] === '*') {
      result = go(i + 1, j) || (j < text.length && go(i, j + 1));
    } else if (j === text.length) {
      result = false;
    } else {
      result = (pattern[i] === '?' || pattern[i] === text[j]) && go(i + 1, j + 1);
    }
    memo[key] = result ? 1 : -1;
    return result;
  };

  return go(0, 0);
}

/**
 * Do two *patterns* share a path?
 *
 * Same shape as the matcher above, except that both sides can consume. The
 * tail rule is the one worth reading twice: a pattern that has run out matches
 * the other only if everything left over is `**`, since `**` is the sole token
 * that can stand for nothing at all.
 */
function segmentsIntersect(left: readonly string[], right: readonly string[]): boolean {
  const memo = new Int8Array((left.length + 1) * (right.length + 1));
  const width = right.length + 1;

  const go = (i: number, j: number): boolean => {
    const key = i * width + j;
    const cached = memo[key];
    if (cached !== 0) return cached === 1;
    let result: boolean;
    if (i === left.length) {
      result = right.slice(j).every((segment) => segment === '**');
    } else if (j === right.length) {
      result = left.slice(i).every((segment) => segment === '**');
    } else if (left[i] === '**') {
      // Either the `**` ends here, or it swallows the other side's segment —
      // legal for any segment pattern, since every one of them matches at
      // least one non-empty string and `**` matches every segment.
      result = go(i + 1, j) || go(i, j + 1);
    } else if (right[j] === '**') {
      result = go(i, j + 1) || go(i + 1, j);
    } else {
      result = segmentPatternsIntersect(left[i] as string, right[j] as string) && go(i + 1, j + 1);
    }
    memo[key] = result ? 1 : -1;
    return result;
  };

  return go(0, 0);
}

/**
 * Do two segment patterns share a string?
 *
 * No pattern in this grammar matches *only* the empty string, so allowing the
 * empty witness costs nothing: if the only common string were empty, both sides
 * would be all-`*`, and both then also match "a".
 */
function segmentPatternsIntersect(left: string, right: string): boolean {
  const memo = new Int8Array((left.length + 1) * (right.length + 1));
  const width = right.length + 1;

  const go = (i: number, j: number): boolean => {
    const key = i * width + j;
    const cached = memo[key];
    if (cached !== 0) return cached === 1;
    let result: boolean;
    if (i === left.length) {
      result = allStars(right, j);
    } else if (j === right.length) {
      result = allStars(left, i);
    } else if (left[i] === '*') {
      result = go(i + 1, j) || go(i, j + 1);
    } else if (right[j] === '*') {
      result = go(i, j + 1) || go(i + 1, j);
    } else {
      const a = left[i] as string;
      const b = right[j] as string;
      result = (a === '?' || b === '?' || a === b) && go(i + 1, j + 1);
    }
    memo[key] = result ? 1 : -1;
    return result;
  };

  return go(0, 0);
}

function allStars(pattern: string, from: number): boolean {
  for (let index = from; index < pattern.length; index += 1) {
    if (pattern[index] !== '*') return false;
  }
  return true;
}
