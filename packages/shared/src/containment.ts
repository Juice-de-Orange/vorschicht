/**
 * Containment policy (§6.6) — what a running session may touch, decided as a
 * pure function.
 *
 * §6.6's rule is one sentence: agents "may **read** across the projects root
 * … but may **write** only inside their own worktree and claim set", and they
 * may never read a credential. This module is that sentence as code, and the
 * `PreToolUse` hook is a thin process around it.
 *
 * Three properties it is built for, all of which come from *where* it runs:
 *
 *  1. **It runs in a process the CLI spawns per tool call.** So it imports
 *     nothing but `./claims.js`, `./worktree.js` and `node:path` — all leaves.
 *     ADR 0003 measured what a heavy import costs at startup; the MCP server
 *     had a ~400 ms budget once per session, and this has ~50 ms on *every*
 *     `Write`. A zod import here would be paid a hundred times a session.
 *  2. **It fails closed, and every ambiguity resolves to deny.** A payload it
 *     cannot parse, a policy it cannot read, a tool it has never heard of that
 *     looks like it mutates something — all denied. The cost of a wrong deny is
 *     a turn and a puzzled agent; the cost of a wrong allow is a write outside
 *     the claim set, which is the failure the whole of §10 exists to prevent.
 *  3. **It never decides by exit code.** The hook reports its verdict as JSON
 *     with exit 0, so that "the hook denied" and "the hook itself broke" stay
 *     distinguishable in the event stream — see `hook-entry.ts`.
 *
 * What it deliberately does **not** contain: any attempt to police `Bash`.
 * §6.6 states the accepted limit plainly — a shell cannot be confined without
 * per-session namespaces — and A46 already removed the shell readers (`cat`,
 * `sed`, …) from every whitelist for exactly this reason. A regex that decides
 * whether a shell line reads a credential would read as a safeguard and behave
 * like a coin toss. The Reviewer's claim-compliance check is the layer that
 * catches what the shell gets past, and the Phase 2 gate demands proof that it
 * works with this hook deliberately bypassed.
 */
import { isAbsolute, relative, resolve } from 'node:path';
import { claimAllowsPath, segmentGlobMatches } from './claims.js';
import { isPathWithin } from './worktree.js';

/**
 * Tools that can change a file, and therefore require write containment (§6.6).
 *
 * An explicit list rather than a heuristic, because these four are what the
 * pinned CLI offers. A future CLI that adds a fifth would escape the list — so
 * `looksMutating` below catches the shape as well as the name, and the
 * Reviewer remains the layer that does not depend on knowing the tool at all.
 */
export const MUTATING_TOOLS = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'] as const;

/** Tools that surface file contents, and therefore require read hygiene (A21). */
export const READING_TOOLS = ['Read', 'NotebookRead', 'Grep', 'Glob'] as const;

/**
 * Secret file patterns (§6.6, A21), matched against **every path segment**.
 *
 * Segment-wise rather than basename-only on purpose: a directory called
 * `secrets/` should shield everything below it, and `credentials/prod.json`
 * is exactly the shape the list is written against.
 *
 * Matching is case-insensitive. That is the safe direction on a filesystem
 * that might not be — a denial that fires once too often costs a turn.
 */
export const SECRET_PATH_PATTERNS: readonly string[] = [
  '.env*',
  '*.pem',
  '*.key',
  'id_rsa*',
  'id_ed25519*',
  '*.p12',
  'credentials*',
  'secrets*',
  '.npmrc',
  '.git-credentials',
];

/**
 * The four names `.env*` would otherwise take with it (A51).
 *
 * `.env.example` is documentation, is committed, and is a file §0.6 obliges
 * every session to keep current — so a rule that let an agent write it while
 * refusing to let it read it would be incoherent, and would bite Vorschicht as
 * its own pilot (A42) within the first task. The carve-out is principled
 * rather than convenient: these files are in git by convention, and a real
 * secret in a git-visible file is already caught by `gate:secrets`, a layer
 * that does not depend on this one.
 *
 * Matched **case-sensitively**, the opposite of the patterns above, and for the
 * same reason: an exception should be hard to trigger by accident.
 */
export const SECRET_PATH_EXCEPTIONS: readonly string[] = [
  '.env.example',
  '.env.sample',
  '.env.template',
  '.env.dist',
];

/**
 * Directories inside a worktree that no agent may write, whatever it claims.
 *
 * `.git` is the one that matters and it is not a matter of tidiness: a write to
 * `.git/hooks/pre-commit` executes on the next commit, which the Coder itself
 * performs — arbitrary code, outside every whitelist, before any Reviewer sees
 * a diff. `.claude` is here because `--setting-sources ''` already shuts that
 * door and a second lock on it costs nothing.
 */
export const FORBIDDEN_WRITE_SEGMENTS: readonly string[] = ['.git', '.claude'];

/** Why a call was refused. Recorded so a denial can be counted, not just read. */
export type ContainmentRule =
  | 'policy-missing'
  | 'unreadable-call'
  | 'read-only-project'
  | 'no-write-root'
  | 'no-claims'
  | 'write-outside-worktree'
  | 'write-outside-claims'
  | 'write-into-internals'
  | 'secret-path';

/**
 * The per-run containment document (§6.6).
 *
 * Written next to the run's `--mcp-config`, named by `VORSCHICHT_RUN_POLICY`,
 * and read by the hook on every tool call. Per run rather than per role,
 * because the claim set belongs to the task — and static because it is: §10
 * registers claims before any coder starts, and a task re-planned with a
 * different claim set is a different run (A45).
 */
export interface RunContainmentPolicy {
  runId: string;
  /** Null for sessions that serve no task — none exist in Phase 2. */
  taskId: string | null;
  /** Profile id (§8), carried so a denial names who was refused. */
  role: string;
  /**
   * Absolute path that writes are confined to: the task's worktree, or a
   * staff role's scratch dir (§6.2). Null means this session writes nothing.
   */
  writeRoot: string | null;
  /**
   * Claim globs, relative to `writeRoot` (§10).
   *
   * `null` means "no claim restriction beyond `writeRoot`" and is for scratch
   * sessions, which hold no claims because they touch no project. An empty
   * array is the opposite and means "holds no claims, may write nothing" —
   * which is what a Coder looks like before the scheduler has granted its set.
   */
  claims: readonly string[] | null;
  /** §6.6: the pattern list is extendable per project. Additive only. */
  extraSecretPatterns: readonly string[];
  /** A41: an analysed-only project. No writes at all, whatever else says yes. */
  readOnlyProject: boolean;
}

export type ToolDecision =
  | { decision: 'allow' }
  | { decision: 'deny'; rule: ContainmentRule; reason: string };

const ALLOW: ToolDecision = { decision: 'allow' };

function deny(rule: ContainmentRule, reason: string): ToolDecision {
  return { decision: 'deny', rule, reason };
}

export interface ToolCall {
  toolName: string;
  toolInput: unknown;
  /** The session's working directory, as the hook payload reports it. */
  cwd: string;
}

/**
 * May this tool call proceed?
 *
 * Reasons are written in English because their only reader is the model, which
 * has to act on them — §2 puts agents in English and the operator in German, and this
 * text goes to an agent. It goes on to say what *would* be allowed, because a
 * refusal an agent cannot act on costs the same turn twice.
 */
export function decideToolCall(policy: RunContainmentPolicy | null, call: ToolCall): ToolDecision {
  if (!policy) {
    return deny(
      'policy-missing',
      'No containment policy is present for this run, so nothing can be established ' +
        'about what you may touch. This is an orchestrator fault, not yours: stop and ' +
        'report it rather than trying another path.',
    );
  }

  const input = asRecord(call.toolInput);
  if (input === null) {
    return deny(
      'unreadable-call',
      `The containment hook could not read the arguments of ${call.toolName}. ` +
        'Refused rather than guessed at.',
    );
  }

  const paths = extractPaths(call.toolName, input);

  // The secret rule applies to every tool, not only to reading ones. `Edit`
  // reads before it writes, and a `Write` that creates a `.env` inside a
  // worktree is a credential the transcript then carries for a year (§18).
  for (const candidate of paths) {
    const hit = matchesSecretPattern(candidate.value, policy.extraSecretPatterns);
    if (hit) {
      return deny(
        'secret-path',
        `Refused: "${candidate.value}" matches the credential pattern "${hit}" (§6.6). ` +
          'Agents learn from code, never from credentials. If you need to know the ' +
          'shape of a configuration file, read its committed example instead.',
      );
    }
  }

  if (!isMutating(call.toolName, input)) return ALLOW;

  if (policy.readOnlyProject) {
    return deny(
      'read-only-project',
      'Refused: this project is registered as analysis-only (A41). Nothing in it may ' +
        'be written. Report what you would have changed instead of changing it.',
    );
  }
  const writeRoot = policy.writeRoot;
  if (!writeRoot) {
    return deny(
      'no-write-root',
      'Refused: this session has no worktree, so it may not write any file. If the ' +
        'work needs file changes, say so in your result — that is a planning gap.',
    );
  }
  if (policy.claims !== null && policy.claims.length === 0) {
    return deny(
      'no-claims',
      'Refused: your task holds no file claims yet, so it may write nothing (§10). ' +
        'Claims are granted by the scheduler before coding starts; report this rather ' +
        'than working around it.',
    );
  }

  const filePaths = paths.filter((candidate) => candidate.kind === 'path');
  if (filePaths.length === 0) {
    return deny(
      'unreadable-call',
      `Refused: ${call.toolName} looks like it changes a file, but the hook found no ` +
        'path in its arguments and cannot check it against your claims.',
    );
  }

  for (const candidate of filePaths) {
    const decision = checkWrite(policy, writeRoot, call.cwd, candidate.value);
    if (decision.decision === 'deny') return decision;
  }
  return ALLOW;
}

function checkWrite(
  policy: RunContainmentPolicy,
  writeRoot: string,
  cwd: string,
  raw: string,
): ToolDecision {
  // The CLI sends absolute paths, but a relative one must not silently mean
  // something different here than it would to the tool: both resolve against
  // the session's cwd.
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(cwd, raw);

  if (!isPathWithin(writeRoot, absolute)) {
    return deny(
      'write-outside-worktree',
      `Refused: "${absolute}" is outside your worktree (${writeRoot}). You may ` +
        'read across the projects root, but you may only write inside your own ' +
        'worktree (§6.6). Nothing you need to change lives elsewhere.',
    );
  }
  if (absolute === resolve(writeRoot)) {
    return deny(
      'unreadable-call',
      'Refused: the target is the worktree directory itself rather than a file in it.',
    );
  }

  const rel = relative(resolve(writeRoot), absolute).split('\\').join('/');
  for (const segment of rel.split('/')) {
    if (FORBIDDEN_WRITE_SEGMENTS.includes(segment)) {
      return deny(
        'write-into-internals',
        `Refused: "${rel}" writes into "${segment}", which is repository plumbing ` +
          'rather than project source. No task claims it and no review would see it.',
      );
    }
  }

  if (policy.claims !== null && !claimAllowsPath(policy.claims, rel)) {
    return deny(
      'write-outside-claims',
      `Refused: "${rel}" is not covered by your file claims (§10). You hold: ` +
        `${policy.claims.join(', ')}. Another task may hold the file you are trying ` +
        'to change; if your plan needs it, report that instead of widening it yourself.',
    );
  }
  return ALLOW;
}

// --- classification -----------------------------------------------------------

/**
 * Does this call change a file?
 *
 * Name first, shape second. The shape check is what covers a CLI that grows a
 * tool this list has never heard of: an unknown tool arriving with `content` or
 * `new_string` in its arguments is treated as a write and contained, which is
 * the direction that fails safe. An unknown tool with only a path is treated as
 * a read, because reading across the projects root is something §6.6 explicitly
 * wants and refusing it would break the studio to prevent nothing.
 */
export function isMutating(toolName: string, input: Record<string, unknown>): boolean {
  if ((MUTATING_TOOLS as readonly string[]).includes(toolName)) return true;
  if ((READING_TOOLS as readonly string[]).includes(toolName)) return false;
  // MCP tools carry their own boundary: a channel serves exactly one task and
  // cannot move it (A48). Bash is §6.6's accepted limit, stated there plainly.
  if (toolName.startsWith('mcp__') || toolName === 'Bash') return false;
  return looksMutating(input);
}

const MUTATION_KEYS = ['content', 'new_string', 'new_str', 'edits', 'replace_all', 'patch'];

function looksMutating(input: Record<string, unknown>): boolean {
  return MUTATION_KEYS.some((key) => key in input);
}

/** Where a tool hides the thing it is about to touch. */
const PATH_KEYS = ['file_path', 'notebook_path', 'path', 'filePath', 'target_file'];
/** Keys that hold a *pattern* rather than a path — checked, never resolved. */
const PATTERN_KEYS = ['glob', 'pattern'];

interface PathCandidate {
  /** `path` participates in write containment; `pattern` only in the secret check. */
  kind: 'path' | 'pattern';
  value: string;
}

/**
 * Every path-ish string in a tool's arguments.
 *
 * `Grep`'s `glob` and `pattern` are included as patterns: a search restricted
 * to `.env*` under any directory is an attempt to read credentials whichever
 * way the tool is documented. What this cannot cover is a broad grep whose
 * *output* happens to
 * include a line from a `.env` — a `PreToolUse` hook allows or denies, it does
 * not filter. That residual is exactly why A21 also runs gitleaks over new
 * transcripts nightly; recorded here so nobody later mistakes this function for
 * a complete answer.
 */
export function extractPaths(toolName: string, input: Record<string, unknown>): PathCandidate[] {
  const found: PathCandidate[] = [];
  const seen = new Set<string>();
  const add = (kind: 'path' | 'pattern', value: unknown) => {
    if (typeof value !== 'string' || value.trim() === '') return;
    const key = `${kind}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ kind, value });
  };

  for (const key of PATH_KEYS) add('path', input[key]);
  for (const key of PATTERN_KEYS) add('pattern', input[key]);

  // MultiEdit-shaped input: a list of edits, each naming its own file.
  const edits = input.edits;
  if (Array.isArray(edits)) {
    for (const edit of edits) {
      const record = asRecord(edit);
      if (!record) continue;
      for (const key of PATH_KEYS) add('path', record[key]);
    }
  }

  // A tool we do not know, whose arguments name a file some other way. Better
  // one string too many in the secret check than a credential read through a
  // key this list never learned. Kept to `pattern` so it cannot widen the
  // write check into refusing calls it does not understand.
  if (!(MUTATING_TOOLS as readonly string[]).includes(toolName) && found.length === 0) {
    for (const value of Object.values(input)) {
      if (typeof value === 'string' && value.includes('/')) add('pattern', value);
    }
  }

  return found;
}

// --- secrets -------------------------------------------------------------------

/**
 * Which credential pattern this path trips, or null.
 *
 * Every segment is tested, so `/opt/app/secrets/db.json` is refused on its
 * directory rather than on its harmless-looking filename.
 */
export function matchesSecretPattern(
  path: string,
  extraPatterns: readonly string[] = [],
): string | null {
  const patterns = [...SECRET_PATH_PATTERNS, ...extraPatterns];
  for (const segment of path.split(/[\\/]/)) {
    if (segment === '' || segment === '.' || segment === '..') continue;
    if (SECRET_PATH_EXCEPTIONS.includes(segment)) continue;
    const lower = segment.toLowerCase();
    for (const pattern of patterns) {
      if (segmentGlobMatches(pattern.toLowerCase(), lower)) return pattern;
    }
  }
  return null;
}

// --- policy serialisation --------------------------------------------------------

/**
 * Parse a policy document, or null when it is not one.
 *
 * Hand-written rather than zod: this runs in the per-tool-call hook, where the
 * import budget is measured in single milliseconds (see the file header). It is
 * also the only shape in the system whose *rejection* is safe — a policy that
 * does not parse denies everything, so a permissive parser would be the only
 * dangerous mistake available here.
 */
export function parseRunContainmentPolicy(raw: unknown): RunContainmentPolicy | null {
  const record = asRecord(raw);
  if (!record) return null;
  const runId = record.runId;
  const role = record.role;
  if (typeof runId !== 'string' || runId === '') return null;
  if (typeof role !== 'string' || role === '') return null;

  const writeRoot = record.writeRoot;
  if (writeRoot !== null && (typeof writeRoot !== 'string' || !isAbsolute(writeRoot))) return null;

  const claims = record.claims;
  if (claims !== null && !isStringArray(claims)) return null;

  const extra = record.extraSecretPatterns;
  if (extra !== undefined && !isStringArray(extra)) return null;

  const taskId = record.taskId;
  if (taskId !== null && typeof taskId !== 'string') return null;

  // Anything other than a literal `false` is read as read-only. A policy whose
  // flag is missing or mistyped must not become a writable project by default.
  const readOnlyProject = record.readOnlyProject !== false;

  return {
    runId,
    taskId: taskId ?? null,
    role,
    writeRoot: writeRoot ?? null,
    claims: claims ?? null,
    extraSecretPatterns: extra ?? [],
    readOnlyProject,
  };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}
