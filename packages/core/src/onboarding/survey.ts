/**
 * The onboarding survey (§20) — everything about a repository that a query can
 * answer, gathered before a single token is spent.
 *
 * The scheduler's rule applies here more sharply than anywhere else: never spend
 * a session to learn something a query answers (A57.3). A model asked "what is
 * the default branch" burns a turn and returns a guess; `git symbolic-ref`
 * returns the answer. So this file gathers the mechanical half, the prompt hands
 * it over **with the command each fact came from**, and the session spends its
 * turns on the half that is actually a judgement — which gate set fits this
 * project, how finely its work should be split, whether it deploys.
 *
 * Three properties are deliberate:
 *
 *  1. **Nothing here writes, and nothing here executes the project.** A41 makes
 *     the pilot project analysis-only and the first thing §20 asks for is a dry run; a
 *     survey that ran `npm install` to find out whether the tests pass would
 *     have broken both on its first use. Every collector reads a file or runs a
 *     read-only git command.
 *
 *  2. **Every fact carries its source.** `sources` records the command or path
 *     behind each section, so the proposal's rationales can be checked against
 *     something rather than believed — the auditor's posture (§8.2), applied one
 *     department over.
 *
 *  3. **A collector that fails is recorded as a gap, never as an absence.** A
 *     `package.json` that could not be parsed and a project with no
 *     `package.json` are different facts, and reporting them identically is how
 *     an onboarding proposes gates for a stack the project does not use.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { gitVisibleFiles, isGitRepository } from '../git.js';
import { execRead } from './exec.js';

/** How many repository-relative paths the survey will list per section. */
export const MAX_LISTED_PATHS = 40;

/** How many extensions the inventory reports. */
export const MAX_EXTENSIONS = 12;

/** Biggest manifest the survey will read, in bytes. A lockfile is not a manifest. */
const MAX_MANIFEST_BYTES = 256 * 1024;

/**
 * Files that tell you what a project is built with, in the order they are
 * looked for.
 *
 * Deliberately not exhaustive and deliberately not clever: this list decides
 * which files are *read for the agent*, not which stacks are supported. A stack
 * with none of these still gets a full file inventory, a git history and an
 * agent with `Read`, `Grep` and `Glob` — it just does not get its manifest
 * quoted in the prompt.
 */
export const MANIFEST_FILES = [
  'package.json',
  'pnpm-workspace.yaml',
  'deno.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'Gemfile',
  'composer.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'Makefile',
  'justfile',
] as const;

/** Where a project states how it is built and checked, outside its manifest. */
export const CI_FILES = [
  '.gitlab-ci.yml',
  '.circleci/config.yml',
  'azure-pipelines.yml',
  'Jenkinsfile',
] as const;

/** §12's deploy shapes, as they look on disk. */
export const DEPLOY_FILES = [
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  'Dockerfile',
  'Procfile',
  'fly.toml',
  'vercel.json',
  'netlify.toml',
] as const;

/** What a project calls the file that explains how work is done in it. */
export const CONVENTION_FILES = [
  'CLAUDE.md',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'README.md',
  'CHANGELOG.md',
] as const;

/**
 * Filename fragments that suggest personal data (§20, §11's legal gate).
 *
 * A hint for the agent, never a verdict: the presence of `datenschutz.md` says
 * there is something to read, and the absence of all of these says nothing at
 * all. Matched case-insensitively against the whole repository-relative path.
 */
export const PERSONAL_DATA_HINTS = [
  'dsgvo',
  'gdpr',
  'datenschutz',
  'privacy',
  'consent',
  'personenbezogen',
  'impressum',
  'avv',
] as const;

export interface SurveyFile {
  path: string;
  /** Trimmed content, capped. Null when the file exists and could not be read. */
  content: string | null;
  /** Set when reading failed; the reason, in German. */
  problem?: string;
  /** True when the content was cut to fit the cap. */
  truncated?: boolean;
}

export interface SurveyGit {
  isRepository: boolean;
  /** `origin/HEAD` where it is set, otherwise the checked-out branch. */
  defaultBranch: string | null;
  /**
   * The branch actually checked out, which is not always the same thing.
   *
   * Kept separately because the divergence is information rather than noise:
   * A41 names a project whose `origin/HEAD` is `main` and whose development
   * happens on `dev`, and a proposal that only ever saw `main` would never put
   * that question in front of anybody.
   */
  checkedOutBranch: string | null;
  /** How the default branch was established — quoted in the prompt. */
  defaultBranchSource: string;
  remoteUrl: string | null;
  headSha: string | null;
  commitCount: number | null;
  lastCommit: string | null;
  branches: string[];
}

/**
 * One `package.json` in the repository — the root's, or a workspace member's.
 *
 * Collected because a monorepo's gate commands do not live in the root
 * manifest. `pnpm --filter web build` is a correct command in a workspace where
 * `apps/web` declares `build`, and a verification that only read the root would
 * refuse it — which is the direction that costs a correct proposal (A72).
 */
export interface SurveyPackage {
  /** Repository-relative directory, `.` for the root. */
  dir: string;
  /** The manifest's `name`, which is what `--filter` matches against. */
  name: string | null;
  scripts: string[];
}

export interface SurveyInventory {
  /** Files git would put into a commit — so no `node_modules`, no build output. */
  fileCount: number;
  /** Extension → count, biggest first. */
  extensions: Array<{ extension: string; count: number }>;
  /** Top-level directories, so the agent can see the shape before reading. */
  topLevel: string[];
  /** Paths matching `PERSONAL_DATA_HINTS`. A hint, not a finding. */
  personalDataHints: string[];
  /** Paths that look like database migrations. */
  migrationCandidates: string[];
  /** Paths that look like tests. */
  testCandidates: string[];
}

export interface RepositorySurvey {
  /** Absolute path of the repository, as the agent will address it. */
  rootPath: string;
  git: SurveyGit;
  /**
   * Every file git would commit, complete and uncapped.
   *
   * For **verification**, not for the prompt: `verifyCommand` has to be able to
   * say whether `infra/scripts/check.sh` exists, and a capped sample can only
   * ever answer "I did not see it", which is not the same fact. Nothing quotes
   * this into a session — the agent has `Glob` and the absolute path — and
   * nothing writes it to the event log, where it would be a few thousand
   * strings per onboarding forever.
   */
  files: string[];
  inventory: SurveyInventory;
  /** Every `package.json` git can see, root first. Empty for a non-JS project. */
  packages: SurveyPackage[];
  manifests: SurveyFile[];
  ci: SurveyFile[];
  deploy: SurveyFile[];
  conventions: SurveyFile[];
  /** One line per collector: what was run or read to produce this. */
  sources: string[];
  /** What the survey could not establish. Reported, never silently absent. */
  gaps: string[];
}

export class SurveyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SurveyError';
  }
}

/**
 * Read a repository without changing it.
 *
 * Throws only when the path is not a directory at all — a caller that asks for a
 * survey of something that does not exist has made a mistake, and returning an
 * empty survey would let that mistake reach a model as "this project is empty".
 * Everything else degrades into `gaps`.
 */
export async function surveyRepository(
  rootPath: string,
  opts: { maxManifestBytes?: number } = {},
): Promise<RepositorySurvey> {
  if (!rootPath.startsWith('/')) {
    throw new SurveyError(`Projektpfad "${rootPath}" ist nicht absolut.`);
  }
  const info = await stat(rootPath).catch(() => null);
  if (!info?.isDirectory()) {
    throw new SurveyError(`Projektpfad "${rootPath}" ist kein Verzeichnis.`);
  }

  const sources: string[] = [];
  const gaps: string[] = [];
  const cap = opts.maxManifestBytes ?? MAX_MANIFEST_BYTES;

  const git = await surveyGit(rootPath, sources, gaps);
  const { files, inventory } = await surveyInventory(rootPath, git.isRepository, sources, gaps);

  const manifests = await readAll(rootPath, MANIFEST_FILES, cap);
  const ci = [
    ...(await readAll(rootPath, CI_FILES, cap)),
    ...(await readGithubWorkflows(rootPath, cap, gaps)),
  ];
  const deploy = await readAll(rootPath, DEPLOY_FILES, cap);
  const conventions = await readAll(rootPath, CONVENTION_FILES, cap);
  const packages = await readPackages(rootPath, files, gaps);
  if (packages.length > 0) {
    sources.push(
      `package.json gelesen (${packages.length}): ${packages.map((p) => p.dir).join(', ')}`,
    );
  }

  sources.push(
    `Manifeste gelesen: ${manifests.map((file) => file.path).join(', ') || '—'}`,
    `CI-Dateien gelesen: ${ci.map((file) => file.path).join(', ') || '—'}`,
    `Deploy-Hinweise gelesen: ${deploy.map((file) => file.path).join(', ') || '—'}`,
    `Konventionen gelesen: ${conventions.map((file) => file.path).join(', ') || '—'}`,
  );

  if (manifests.length === 0) {
    gaps.push(
      'Keine der bekannten Manifest-Dateien gefunden — der Stack ist aus der ' +
        'Dateiliste zu erschließen, nicht aus einem Manifest.',
    );
  }

  return {
    rootPath,
    git,
    files,
    inventory,
    packages,
    manifests,
    ci,
    deploy,
    conventions,
    sources,
    gaps,
  };
}

/**
 * How many `package.json` files are read for their script names.
 *
 * A cap rather than a full walk, because a repository that vendors manifests
 * could otherwise make this the slowest part of a survey. When it bites it is
 * recorded as a gap, so a command that could not be verified for this reason is
 * reported as unverifiable rather than as wrong.
 */
export const MAX_PACKAGES = 60;

async function readPackages(
  root: string,
  files: readonly string[],
  gaps: string[],
): Promise<SurveyPackage[]> {
  const candidates = files.filter(
    (path) => path === 'package.json' || path.endsWith('/package.json'),
  );
  if (candidates.length > MAX_PACKAGES) {
    gaps.push(
      `Das Repository enthält ${candidates.length} package.json-Dateien; gelesen wurden ` +
        `${MAX_PACKAGES}. Ein Befehl aus einem der übrigen Pakete gilt als nicht prüfbar.`,
    );
  }
  // Root first, then by depth, so a cap drops the deepest packages rather than
  // whichever ones git happened to list last.
  const ordered = candidates.sort(
    (a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b),
  );

  const out: SurveyPackage[] = [];
  for (const path of ordered.slice(0, MAX_PACKAGES)) {
    const raw = await readFile(join(root, path), 'utf8').catch(() => null);
    if (raw === null) continue;
    try {
      const parsed = JSON.parse(raw) as { name?: unknown; scripts?: Record<string, unknown> };
      out.push({
        dir: path === 'package.json' ? '.' : path.slice(0, -'/package.json'.length),
        name: typeof parsed.name === 'string' ? parsed.name : null,
        scripts:
          parsed.scripts && typeof parsed.scripts === 'object' ? Object.keys(parsed.scripts) : [],
      });
    } catch {
      // An unparseable manifest is a gap, not an empty package: reporting it as
      // "declares nothing" would turn every command naming one of its scripts
      // into a refusal.
      gaps.push(`\`${path}\` ist kein lesbares JSON; seine Skripte sind unbekannt.`);
    }
  }
  return out;
}

async function surveyGit(root: string, sources: string[], gaps: string[]): Promise<SurveyGit> {
  const empty: SurveyGit = {
    isRepository: false,
    defaultBranch: null,
    checkedOutBranch: null,
    defaultBranchSource: 'kein git-Repository',
    remoteUrl: null,
    headSha: null,
    commitCount: null,
    lastCommit: null,
    branches: [],
  };
  if (!(await isGitRepository(root))) {
    sources.push('git rev-parse --is-inside-work-tree → kein Repository');
    gaps.push(
      'Das Verzeichnis ist kein git-Repository. Ohne Repository gibt es keinen ' +
        'Integrationszweig, keine Worktrees und damit keine Entwicklungskette (§10).',
    );
    return empty;
  }

  // `origin/HEAD` is the only mechanical statement of what a repository's
  // integration branch *is*; the checked-out branch is merely where somebody
  // last stood. Both are recorded, and which one answered is quoted, because
  // §10 cuts every task branch from this and a wrong answer here is a wrong
  // answer for every task the project ever gets.
  const symbolic = await execRead('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], {
    cwd: root,
  });
  const current = await execRead('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
  const checkedOut =
    current.ok && current.stdout.trim() && current.stdout.trim() !== 'HEAD'
      ? current.stdout.trim()
      : null;
  let defaultBranch: string | null = null;
  let defaultBranchSource = '';
  if (symbolic.ok && symbolic.stdout.trim()) {
    defaultBranch = symbolic.stdout.trim().replace(/^origin\//, '');
    defaultBranchSource = 'git symbolic-ref --short refs/remotes/origin/HEAD';
    if (checkedOut && checkedOut !== defaultBranch) {
      // Not a gap and not a problem — but the one fact that would otherwise be
      // invisible in a proposal, and the one A41 turns on.
      sources.push(
        `Ausgecheckt ist „${checkedOut}", Integrationszweig ist „${defaultBranch}" — ` +
          'wer in diesem Projekt arbeitet, steht offenbar woanders.',
      );
    }
  } else {
    if (checkedOut) {
      defaultBranch = checkedOut;
      defaultBranchSource =
        'git rev-parse --abbrev-ref HEAD (origin/HEAD ist nicht gesetzt — das ist ' +
        'der ausgecheckte Zweig, nicht notwendigerweise der Integrationszweig)';
    } else {
      defaultBranchSource = 'nicht ermittelbar';
      gaps.push(
        'Der Integrationszweig ließ sich nicht bestimmen: origin/HEAD ist nicht ' +
          'gesetzt und HEAD ist losgelöst. §10 schneidet jeden Task-Zweig davon ab.',
      );
    }
  }
  sources.push(`Integrationszweig: ${defaultBranchSource}`);

  const remote = await execRead('git', ['remote', 'get-url', 'origin'], { cwd: root });
  const head = await execRead('git', ['rev-parse', 'HEAD'], { cwd: root });
  const count = await execRead('git', ['rev-list', '--count', 'HEAD'], { cwd: root });
  const last = await execRead('git', ['log', '-1', '--format=%h %ad %s', '--date=short'], {
    cwd: root,
  });
  const branches = await execRead(
    'git',
    ['for-each-ref', '--format=%(refname:short)', '--count=30', 'refs/heads'],
    { cwd: root },
  );
  sources.push('git remote get-url origin · git rev-list --count HEAD · git log -1');

  const parsedCount = Number.parseInt(count.stdout.trim(), 10);
  return {
    isRepository: true,
    defaultBranch,
    checkedOutBranch: checkedOut,
    defaultBranchSource,
    remoteUrl: remote.ok ? remote.stdout.trim() || null : null,
    headSha: head.ok ? head.stdout.trim() || null : null,
    commitCount: Number.isFinite(parsedCount) ? parsedCount : null,
    lastCommit: last.ok ? last.stdout.trim() || null : null,
    branches: branches.ok ? lines(branches.stdout) : [],
  };
}

async function surveyInventory(
  root: string,
  isRepo: boolean,
  sources: string[],
  gaps: string[],
): Promise<{ files: string[]; inventory: SurveyInventory }> {
  let files: string[] = [];
  if (isRepo) {
    try {
      files = await gitVisibleFiles(root);
      sources.push('git ls-files --cached --others --exclude-standard');
    } catch (error) {
      gaps.push(`Dateiliste nicht lesbar: ${(error as Error).message}`);
    }
  } else {
    gaps.push(
      'Ohne git-Repository gibt es keine verlässliche Dateiliste — ignorierte ' +
        'Verzeichnisse wie node_modules sind nicht von echtem Quelltext zu trennen.',
    );
  }

  const counts = new Map<string, number>();
  const topLevel = new Set<string>();
  const personalDataHints: string[] = [];
  const migrationCandidates: string[] = [];
  const testCandidates: string[] = [];

  for (const path of files) {
    const dot = path.lastIndexOf('.');
    const slash = path.lastIndexOf('/');
    const extension = dot > slash && dot !== -1 ? path.slice(dot) : '(ohne Endung)';
    counts.set(extension, (counts.get(extension) ?? 0) + 1);

    const first = path.split('/')[0];
    if (first) topLevel.add(path.includes('/') ? `${first}/` : first);

    const lower = path.toLowerCase();
    if (PERSONAL_DATA_HINTS.some((hint) => lower.includes(hint))) personalDataHints.push(path);
    if (/(^|\/)(migrations?|migrate)\//.test(lower) || lower.endsWith('.sql')) {
      migrationCandidates.push(path);
    }
    if (/(^|\/)(tests?|__tests__|spec)\//.test(lower) || /\.(test|spec|itest)\./.test(lower)) {
      testCandidates.push(path);
    }
  }

  return {
    files,
    inventory: {
      fileCount: files.length,
      extensions: [...counts.entries()]
        .map(([extension, count]) => ({ extension, count }))
        .sort((a, b) => b.count - a.count || a.extension.localeCompare(b.extension))
        .slice(0, MAX_EXTENSIONS),
      topLevel: [...topLevel].sort().slice(0, MAX_LISTED_PATHS),
      personalDataHints: personalDataHints.slice(0, MAX_LISTED_PATHS),
      migrationCandidates: migrationCandidates.slice(0, MAX_LISTED_PATHS),
      testCandidates: testCandidates.slice(0, MAX_LISTED_PATHS),
    },
  };
}

async function readAll(root: string, names: readonly string[], cap: number): Promise<SurveyFile[]> {
  const out: SurveyFile[] = [];
  for (const name of names) {
    const file = await readOne(root, name, cap);
    if (file) out.push(file);
  }
  return out;
}

async function readOne(root: string, name: string, cap: number): Promise<SurveyFile | null> {
  const absolute = join(root, name);
  const info = await stat(absolute).catch(() => null);
  if (!info?.isFile()) return null;
  try {
    const raw = await readFile(absolute, 'utf8');
    const truncated = raw.length > cap;
    return {
      path: name,
      content: truncated ? `${raw.slice(0, cap)}\n…` : raw,
      ...(truncated ? { truncated: true } : {}),
    };
  } catch (error) {
    // Present and unreadable is a different fact from absent, and the agent has
    // to be able to tell them apart: one means "this project has no manifest",
    // the other means "somebody should look at this".
    return { path: name, content: null, problem: (error as Error).message };
  }
}

async function readGithubWorkflows(
  root: string,
  cap: number,
  gaps: string[],
): Promise<SurveyFile[]> {
  const dir = join(root, '.github', 'workflows');
  const info = await stat(dir).catch(() => null);
  if (!info?.isDirectory()) return [];
  const listed = await readdir(dir).catch(() => null);
  if (!listed) {
    gaps.push('.github/workflows ist vorhanden, aber nicht auflistbar.');
    return [];
  }
  const files: SurveyFile[] = [];
  // Two is enough to see how a project checks itself; a repository with fifteen
  // workflows would otherwise fill the prompt with release automation. Which
  // two is decided by name rather than alphabetically — the first live run of
  // this survey quoted `apply-brevo-key.yml` and `apply-smtp-key.yml` at a
  // project whose `ci.yml` is the file that says how it checks itself.
  for (const name of listed
    .filter((n) => /\.ya?ml$/.test(n))
    .sort((a, b) => workflowRank(a) - workflowRank(b) || a.localeCompare(b))
    .slice(0, 2)) {
    const file = await readOne(root, join('.github', 'workflows', name), cap);
    if (file) files.push(file);
  }
  return files;
}

/** Lower sorts first: a workflow that checks the project beats one that deploys it. */
function workflowRank(name: string): number {
  const lower = name.toLowerCase();
  if (/^(ci|test|check|build|lint|main|pr|pull)/.test(lower)) return 0;
  if (/^(release|publish|deploy)/.test(lower)) return 2;
  return 1;
}

function lines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}
