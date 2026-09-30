/**
 * gitleaks, twice — as a pinned binary and as a pinned container image (§11.4).
 *
 * §11 locks "secrets scan clean" as baseline gate 4, and until now there was
 * exactly one way to run it: `docker run zricethezav/gitleaks`. The orchestrator
 * image ships neither a docker client nor a socket, so in the **deployed**
 * studio that gate answered `infra` on every attempt — three retries, an Ops
 * alert (A25), and the task back in `queued`. A studio that cannot complete a
 * single merge, with a gate that had been demonstrated green on a laptop where
 * docker happens to exist. The container path is kept because that is what
 * `pnpm gate` uses on a developer machine; the binary path is what makes the
 * gate answerable where the daemon actually runs.
 *
 * Eight decisions, none of them transcription of §11:
 *
 *  1. **Two implementations, one contract.** `secret-scan-contract.itest.ts`
 *     holds both to the same promises, in one file, so an implementation that
 *     drifts *fails* rather than being differently correct. A87 built the same
 *     arrangement for `DeployTarget` and A31 for `ModelBackend`; the argument is
 *     stronger here, because these two decide a **locked** gate and a divergence
 *     between them is a merge that would have been blocked on another machine.
 *
 *  2. **One rule source, passed rather than discovered.** gitleaks reads
 *     `(target)/.gitleaks.toml` when no `--config` is given. That happens to be
 *     right for a git tree, whose scratch copy carries the committed config, and
 *     it is silently wrong for any directory that is not a repository — the
 *     transcripts volume (§6.6) has no config, so an auto-discovering scan there
 *     would quietly run the vendor's default rules and miss every credential
 *     class this project actually handles (`anthropic-oauth-token` first among
 *     them). Two rule sets under one gate name is A76.2's class. So the config
 *     is always passed with `--config`: resolved from the scanned tree for
 *     `scan`, which is byte-for-byte what discovery did, and **required** from
 *     the caller for `scanDirectory`, where a default would be the defect.
 *
 *  3. **The report is JSON, and the exit code alone decides nothing.** Measured
 *     against 8.30.1, all four cases, each captured without a pipe in between:
 *
 *     | case | exit | stdout |
 *     |---|---|---|
 *     | clean tree | 0 | `[]` |
 *     | leak found | 1 | JSON array |
 *     | config missing | 1 | *empty* |
 *     | config malformed | 1 | *empty* |
 *
 *     So `code === 1` means "leak" and "gitleaks could not start" equally, and
 *     the old classification read the second as a blocking finding. Both block a
 *     merge, so nothing shipped — but §11 distinguishes a finding from an infra
 *     failure precisely so that "the tree is dirty" and "the tree was never
 *     examined" produce different responses (A25). What separates them is the
 *     report: exit 1 **with** parsed findings is a finding, exit 1 **without**
 *     one is infra.
 *
 *  4. **A green verdict requires evidence that something was looked at.** The
 *     other measured pair is the dangerous one: `gitleaks dir /does/not/exist`
 *     exits **0** and prints `[]`, and a file it cannot open is skipped with the
 *     same result. Pointed at a mistyped path, the tool reports the tree clean.
 *     That is exactly the direction §19 cannot survive, and it would be strictly
 *     worse than the defect this module repairs — `infra` is loud, retried and
 *     alerted; `green` is silent and merges. So `scanDirectory` walks the tree
 *     itself first and refuses on a missing root or an unreadable file, and only
 *     an **empty** tree is green, which is the same answer `scan` has always
 *     given for a repository with no git-visible files.
 *
 *     Rejected alternative: reading gitleaks' `WRN skipping` line off stderr.
 *     It is the same information, and it makes a locked gate depend on a log
 *     vocabulary the vendor owns and may reword in a patch release — A73.4
 *     refused to key on a vendor status string for the same reason. An `access`
 *     call is our own observation and can be asserted.
 *
 *  5. **The version is pinned, and the binary is used only if it *is* the pin.**
 *     A27 pins the Claude CLI and A34 pins every image by digest; a tool that
 *     decides a locked gate deserves the same. The image carries its digest, the
 *     tarball its SHA-256, and `AutoSecretScanner` asks a binary for its version
 *     before trusting it — a developer laptop with some older gitleaks on `PATH`
 *     falls through to the pinned image rather than deciding gate 4 with a
 *     different rule engine than the production host uses. That makes "one gitleaks decides
 *     this gate" a mechanism instead of a hope.
 *
 *     The two distribution channels disagree about one character: the release
 *     tarball's binary answers `8.30.1` and the image's answers `v8.30.1`. Both
 *     were measured. `normaliseGitleaksVersion` strips the `v` rather than the
 *     comparison being loosened to a substring match — a `grep` without anchors
 *     would also accept `8.30.10`, which is a blunt assertion rather than a
 *     wrong one, and blunt is harder to notice.
 *
 *  6. **`detect --source … --no-git` for both, not `dir`.** 8.30.1 offers both
 *     and they produced identical reports here. `detect` is what the container
 *     path already issued, so keeping it means the git-tree scan's behaviour is
 *     unchanged in the one dimension that matters — which files are examined
 *     against which rules — while the report format and the classification get
 *     sharper.
 *
 *  7. **No `tool` field on the result, deliberately.** Which implementation ran
 *     belongs in the German detail line, where a human diagnosing a trace reads
 *     it. As a field it would invite a caller to branch on it, and the entire
 *     thesis of decision 1 is that the two are interchangeable: a caller that
 *     can tell them apart is a caller that can come to depend on one.
 *
 *  8. **No docker socket in the orchestrator, and that is a security decision
 *     rather than a packaging one.** Mounting `/var/run/docker.sock` would make
 *     the gate work with no new code at all — and hand every agent session a
 *     path to root on the production host, since a container that can talk to the daemon
 *     can start a privileged one mounting `/`. §19 runs these sessions as an
 *     unprivileged user with `no-new-privileges` precisely to prevent that. The
 *     binary is ~23 MB in the image and costs nothing at runtime.
 */
import { execFile } from 'node:child_process';
import { type Dirent, constants as fsConstants, type Stats } from 'node:fs';
import { access, mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import type { GateVerdict } from './gate-suite.js';

const exec = promisify(execFile);

// --- the pin ------------------------------------------------------------------

/**
 * The one gitleaks version this project's baseline gate 4 is decided by.
 *
 * Without the leading `v`. Both spellings exist in the wild (decision 5) and
 * this is the one the release archive uses; every comparison normalises.
 */
export const GITLEAKS_VERSION = '8.30.1';

/**
 * The container image, pinned by tag **and** digest (A34).
 *
 * The tag is kept beside the digest on purpose: the digest is what docker
 * resolves, the tag is what a human reads when deciding whether a bump is due.
 */
export const GITLEAKS_IMAGE =
  'zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';

/**
 * SHA-256 of `gitleaks_8.30.1_linux_x64.tar.gz`, as the orchestrator image
 * installs it.
 *
 * Taken from the release's own `gitleaks_8.30.1_checksums.txt` and confirmed
 * against a separate download, so it is a statement about what upstream
 * published rather than about what one machine happened to receive.
 * `gitleaks-pin.test.ts` asserts the Dockerfile's `ARG` still says this.
 */
export const GITLEAKS_LINUX_X64_SHA256 =
  '551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb';

/** Where `Dockerfile.orchestrator` puts the binary. */
export const GITLEAKS_BINARY = 'gitleaks';

/** `v8.30.1` and `8.30.1` are the same version (decision 5). */
export function normaliseGitleaksVersion(reported: string): string {
  return reported.trim().replace(/^v/, '');
}

// --- what a scan answers -------------------------------------------------------

/** One leak, reduced to the two things a fix task needs to start. */
export interface SecretScanFinding {
  /** The rule that matched — `anthropic-oauth-token`, `generic-api-key`, … */
  rule: string;
  /** Relative to the scanned tree, so both implementations answer alike. */
  file: string;
  line: number | null;
}

export interface SecretScanResult {
  verdict: GateVerdict;
  /** German (§2) — the timeline and the findings pipeline read this. */
  detail: string;
  /** Captured output, trimmed. */
  output: string;
  /**
   * Empty unless `verdict` is `finding`.
   *
   * Structured rather than left in `output` because §11's pipeline turns a
   * finding into a briefing for the next session (A69.5), and "which rule, in
   * which file" is the whole of what that session needs. Scraping it back out
   * of a log line later would be a second parser nobody keeps in step.
   */
  findings: SecretScanFinding[];
}

/** What `GateSuite` needs: one tree, one verdict. */
export interface SecretScanner {
  scan(cwd: string): Promise<SecretScanResult>;
}

/**
 * The second entry point: a directory that is not a git repository.
 *
 * §6.6 asks for a nightly gitleaks run over the transcripts volume, which has
 * no repository, no index and no committed config. Kept as its own interface
 * rather than widened into `SecretScanner`, because `GateSuite` must not be able
 * to reach it by accident and because every stub in the test suites implements
 * the smaller one.
 */
export interface DirectoryScanner {
  scanDirectory(root: string, options: DirectoryScanOptions): Promise<SecretScanResult>;
}

export interface DirectoryScanOptions {
  /**
   * Required, and that is decision 2 made unrepresentable rather than checked.
   *
   * A default here would be the moment the transcripts scan silently starts
   * using different rules than the merge gate.
   */
  configPath: string;
}

/** Both gitleaks implementations answer both questions. */
export type GitleaksScanner = SecretScanner & DirectoryScanner;

// --- the parts both implementations share --------------------------------------

const MAX_OUTPUT = 16_000;

function trim(text: string): string {
  const clean = text.trim();
  return clean.length > MAX_OUTPUT
    ? `${clean.slice(0, MAX_OUTPUT)}\n… (${clean.length - MAX_OUTPUT} Zeichen gekürzt)`
    : clean;
}

/** One gitleaks entry, as 8.30.1 writes it. Only three fields are read. */
interface GitleaksReportEntry {
  RuleID?: unknown;
  File?: unknown;
  StartLine?: unknown;
}

/**
 * The JSON report, or `null` when there is none.
 *
 * The `null` is the load-bearing part: it is how "gitleaks ran and found
 * nothing" stays distinguishable from "gitleaks never got as far as scanning",
 * which is the distinction decision 3 exists for. An empty array is a report; an
 * empty string is not.
 */
export function parseGitleaksReport(stdout: string, scanRoot: string): SecretScanFinding[] | null {
  const text = stdout.trim();
  if (text === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.map((raw) => {
    const entry = (raw ?? {}) as GitleaksReportEntry;
    const line = typeof entry.StartLine === 'number' ? entry.StartLine : null;
    return {
      rule: typeof entry.RuleID === 'string' && entry.RuleID !== '' ? entry.RuleID : 'unbekannt',
      file: relativiseScanPath(typeof entry.File === 'string' ? entry.File : '', scanRoot),
      line,
    };
  });
}

/**
 * gitleaks reports `File` as the path it was handed plus the entry beneath it —
 * `/scan/packages/x.ts` in a container, `/tmp/…/packages/x.ts` for the binary.
 * Both are the same file and neither is what a human wants to read, so the scan
 * root comes off. That the two implementations then answer *identically* is a
 * contract case rather than a hope.
 */
function relativiseScanPath(file: string, scanRoot: string): string {
  if (file === '') return '';
  const rel = relative(scanRoot, file);
  if (rel === '' || rel.startsWith('..')) return file;
  return rel.split(sep).join('/');
}

/** German, for the timeline — at most a handful, since a card has to stay readable. */
function describeFindings(findings: readonly SecretScanFinding[]): string {
  const shown = findings.slice(0, 20).map((finding) => {
    const place = finding.line === null ? finding.file : `${finding.file}:${finding.line}`;
    return `- ${place} — Regel „${finding.rule}"`;
  });
  if (findings.length > shown.length) {
    shown.push(`… und ${findings.length - shown.length} weitere`);
  }
  return shown.join('\n');
}

/**
 * One finished gitleaks invocation, turned into a verdict (decision 3).
 *
 * Pure and exported, so the table in decision 3 is asserted directly rather than
 * only through a tool that has to be installed to ask.
 */
export function classifyGitleaksRun(input: {
  code: number | null;
  stdout: string;
  stderr: string;
  scanRoot: string;
  /** German, names the implementation — decision 7. */
  tool: string;
}): SecretScanResult {
  const findings = parseGitleaksReport(input.stdout, input.scanRoot);
  const noise = trim(`${input.stderr}\n${input.stdout}`);

  if (findings === null) {
    // No report at all. Measured: this is what a config gitleaks cannot load
    // looks like, at exit 1 — indistinguishable from a leak by exit code alone.
    return {
      verdict: 'infra',
      detail:
        `gitleaks (${input.tool}) hat keinen Bericht geliefert (Exit ${input.code ?? '?'}) — ` +
        'der Baum wurde nicht geprüft. Kein Befund, aber auch keine Freigabe (A25).',
      output: noise,
      findings: [],
    };
  }

  if (findings.length > 0) {
    // Deliberately independent of the exit code. `--exit-code 0` would make a
    // real leak exit 0, and reporting findings as green is the one outcome §19
    // cannot survive.
    return {
      verdict: 'finding',
      detail:
        `gitleaks (${input.tool}) hat ${findings.length} Fundstelle(n) im Baum gefunden — ` +
        'Merge blockiert (§11, §19).',
      output: trim(`${describeFindings(findings)}\n\n${noise}`),
      findings,
    };
  }

  if (input.code === 0) {
    return {
      verdict: 'green',
      detail: `Keine Fundstellen (gitleaks ${GITLEAKS_VERSION}, ${input.tool}).`,
      output: trim(input.stdout),
      findings: [],
    };
  }

  // An empty report with a non-zero exit: the tool objected to something it did
  // not describe as a leak. Not evidence about the tree.
  return {
    verdict: 'infra',
    detail:
      `gitleaks (${input.tool}) endete mit Exit ${input.code ?? '?'} ohne Fundstellen — ` +
      'der Baum bleibt ungeprüft (A25).',
    output: noise,
    findings: [],
  };
}

/** The argv both implementations issue, so a divergence has to be deliberate. */
export function gitleaksArgv(scanRoot: string, configPath: string | null): string[] {
  return [
    'detect',
    '--source',
    scanRoot,
    '--no-git',
    ...(configPath === null ? [] : ['--config', configPath]),
    '--report-format',
    'json',
    // `-` is stdout. A report path would need a writable mount in the container
    // case and a temp file in the other; stdout is the one channel both have,
    // and gitleaks keeps its logs on stderr (measured).
    '--report-path',
    '-',
    '--redact',
    '--no-banner',
  ];
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  /** The program could not be started at all — `ENOENT` and friends. */
  spawnFailed: boolean;
}

/** `execFile` without a shell and without throwing on a non-zero exit. */
async function run(file: string, args: string[], timeoutMs: number): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec(file, args, {
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: '1' },
    });
    return { stdout, stderr, code: 0, spawnFailed: false };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message,
      code: typeof err.code === 'number' ? err.code : null,
      spawnFailed: typeof err.code === 'string',
    };
  }
}

/** The files git would carry — tracked plus untracked-but-not-ignored. */
async function gitVisible(cwd: string): Promise<string[]> {
  const { stdout } = await exec(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd, maxBuffer: 8 * 1024 * 1024 },
  );
  return stdout.split('\0').filter(Boolean);
}

/**
 * Copy the named files into a scratch directory, preserving their paths.
 *
 * `cp --parents` rather than a recursive copy, so nothing outside the file list
 * comes along — the list is the whole point of the exercise (A55.5: a deployed
 * project has a populated `.env` in its working tree, and a gate that is red on
 * every run teaches everyone to stop reading it).
 */
async function copyInto(from: string, to: string, files: readonly string[]): Promise<void> {
  const BATCH = 500;
  for (let index = 0; index < files.length; index += BATCH) {
    await exec('cp', ['--parents', '-t', to, ...files.slice(index, index + BATCH)], {
      cwd: from,
      maxBuffer: 8 * 1024 * 1024,
    });
  }
}

/**
 * Walk a directory that is not a repository, and refuse rather than guess.
 *
 * This is decision 4. gitleaks answers "clean" for a path that is not there and
 * for a file it cannot open, so the only way a green verdict can mean anything
 * is for the caller to have established, itself, that there was something
 * readable to scan. The transcripts volume is the live example: A103 found that
 * those files are mode 0600 owned by uid 10001, and a scanner running as any
 * other user would have reported §6.6's nightly leak scan clean, every night,
 * over files it never opened.
 *
 * Symlinks are skipped, because gitleaks skips them unless `--follow-symlinks`
 * is passed and we do not pass it — a walk that counted them would refuse over
 * files the tool was never going to read.
 */
async function collectReadableFiles(
  root: string,
): Promise<{ ok: true; files: string[] } | { ok: false; problem: string }> {
  let rootStat: Stats;
  try {
    rootStat = await stat(root);
  } catch (error) {
    return { ok: false, problem: `„${root}" ist nicht lesbar: ${(error as Error).message}` };
  }
  if (!rootStat.isDirectory()) {
    return { ok: false, problem: `„${root}" ist kein Verzeichnis.` };
  }

  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop() as string;
    let entries: Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      return {
        ok: false,
        problem: `„${directory}" konnte nicht gelesen werden: ${(error as Error).message}`,
      };
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        pending.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        await access(path, fsConstants.R_OK);
      } catch {
        return {
          ok: false,
          problem:
            `„${path}" ist für diesen Prozess nicht lesbar. gitleaks würde die Datei ` +
            'stillschweigend überspringen und den Baum als sauber melden — das wäre ' +
            'kein Befund, sondern ein nicht durchgeführter Scan (A25, §19).',
        };
      }
      files.push(path);
    }
  }
  return { ok: true, files };
}

/** German, for a tree that had nothing in it — the honest green (decision 4). */
function emptyTree(what: string): SecretScanResult {
  return { verdict: 'green', detail: what, output: '', findings: [] };
}

function infra(detail: string, output = ''): SecretScanResult {
  return { verdict: 'infra', detail, output, findings: [] };
}

/** `<scratch>/.gitleaks.toml` if the scanned tree carries one (decision 2). */
async function resolveTreeConfig(root: string): Promise<string | null> {
  const candidate = join(root, '.gitleaks.toml');
  try {
    await access(candidate, fsConstants.R_OK);
    return candidate;
  } catch {
    return null;
  }
}

const DEFAULT_TIMEOUT_MS = 180_000;

// --- the container implementation ----------------------------------------------

/**
 * gitleaks in a container, over the git-visible files of a working tree.
 *
 * Containerised for the reason `gate-secrets.mjs` gives: the same image on the
 * the build machine, on the production host and in CI, so no host state can quietly change what
 * "clean" means. Docker being unreachable is an **infra** failure (A25) — the
 * tree was not scanned, and reporting that as clean is the one outcome §19
 * cannot survive.
 *
 * The name is unchanged although it is now one of two implementations: it is
 * what every call site imports, and a rename would churn four files to say
 * something the class comment says better.
 */
export class GitleaksSecretScanner implements GitleaksScanner {
  constructor(private readonly options: { image?: string; timeoutMs?: number } = {}) {}

  private get image(): string {
    return this.options.image ?? GITLEAKS_IMAGE;
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** True when a docker daemon answers — the probe both entry points share. */
  static async available(): Promise<boolean> {
    try {
      await exec('docker', ['info'], { timeout: 20_000 });
      return true;
    } catch {
      return false;
    }
  }

  async scan(cwd: string): Promise<SecretScanResult> {
    if (!(await GitleaksSecretScanner.available())) {
      return infra(
        'Docker ist nicht erreichbar — der Secrets-Scan konnte nicht laufen. ' +
          'Kein Befund, aber auch keine Freigabe (A25).',
      );
    }

    const scratch = await mkdtemp(join(tmpdir(), 'vorschicht-gate-secrets-'));
    try {
      const files = await gitVisible(cwd);
      if (files.length === 0) return emptyTree('Keine versionierbaren Dateien im Baum.');
      await copyInto(cwd, scratch, files);
      const config = await resolveTreeConfig(scratch);
      return await this.execute(scratch, config, 'Container');
    } catch (error) {
      return infra(`Secrets-Scan nicht möglich: ${(error as Error).message}`);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async scanDirectory(root: string, options: DirectoryScanOptions): Promise<SecretScanResult> {
    if (!(await GitleaksSecretScanner.available())) {
      return infra('Docker ist nicht erreichbar — das Verzeichnis wurde nicht geprüft (A25).');
    }
    const tree = await collectReadableFiles(root);
    if (!tree.ok) return infra(tree.problem);
    // Reachable only after the walk found no *unreadable* file, so this really
    // is "there was nothing here" and not "we could not look" — the two must
    // not share a sentence any more than they share a verdict.
    if (tree.files.length === 0) return emptyTree(`„${root}" enthält keine Dateien.`);
    try {
      await access(options.configPath, fsConstants.R_OK);
    } catch (error) {
      return infra(
        `Die Regeldatei „${options.configPath}" ist nicht lesbar: ${(error as Error).message}`,
      );
    }
    return this.execute(root, options.configPath, 'Container', options.configPath);
  }

  /**
   * One container run.
   *
   * `--network none` because a secret scanner has no business reaching the
   * network, and read-only mounts because it has no business writing either.
   */
  private async execute(
    scanRoot: string,
    configPath: string | null,
    tool: string,
    externalConfig?: string,
  ): Promise<SecretScanResult> {
    // The tree is mounted at a fixed path, so what gitleaks reports as `File`
    // is `/scan/...` regardless of where the tree happens to live. The config
    // travels either inside that mount (a git tree carries its own) or as its
    // own read-only mount.
    const mounts =
      externalConfig === undefined ? [] : ['--volume', `${externalConfig}:/gitleaks.toml:ro`];
    const inContainerConfig =
      externalConfig === undefined
        ? configPath === null
          ? null
          : `/scan/${relativiseScanPath(configPath, scanRoot)}`
        : '/gitleaks.toml';

    const result = await run(
      'docker',
      [
        'run',
        '--rm',
        '--network',
        'none',
        '--volume',
        `${scanRoot}:/scan:ro`,
        ...mounts,
        this.image,
        ...gitleaksArgv('/scan', inContainerConfig),
      ],
      this.timeoutMs,
    );

    if (result.spawnFailed) {
      return infra(
        'Docker konnte nicht gestartet werden — der Baum wurde nicht geprüft (A25).',
        trim(result.stderr),
      );
    }
    return classifyGitleaksRun({ ...result, scanRoot: '/scan', tool });
  }
}

// --- the binary implementation --------------------------------------------------

/**
 * gitleaks as a pinned binary in the orchestrator image.
 *
 * The implementation that makes baseline gate 4 answerable where the daemon
 * runs. It is deliberately the *same* tool at the *same* version as the
 * container path (decision 5) and issues the *same* argv (`gitleaksArgv`), so
 * the only thing that differs between the two is how the process is started.
 */
export class GitleaksBinaryScanner implements GitleaksScanner {
  constructor(private readonly options: { binary?: string; timeoutMs?: number } = {}) {}

  private get binary(): string {
    return this.options.binary ?? GITLEAKS_BINARY;
  }

  private get timeoutMs(): number {
    return this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * The version this binary reports, or null when it cannot be started.
   *
   * Separate from `available()` so that "there is no gitleaks here" and "there
   * is one and it is the wrong version" stay different answers — the second is
   * what `AutoSecretScanner` must not silently accept.
   */
  static async version(binary = GITLEAKS_BINARY): Promise<string | null> {
    const result = await run(binary, ['version'], 20_000);
    if (result.spawnFailed || result.code !== 0) return null;
    const reported = normaliseGitleaksVersion(result.stdout);
    return /^\d+\.\d+\.\d+/.test(reported) ? reported : null;
  }

  async scan(cwd: string): Promise<SecretScanResult> {
    const scratch = await mkdtemp(join(tmpdir(), 'vorschicht-gate-secrets-'));
    try {
      const files = await gitVisible(cwd);
      if (files.length === 0) return emptyTree('Keine versionierbaren Dateien im Baum.');
      await copyInto(cwd, scratch, files);
      const config = await resolveTreeConfig(scratch);
      return await this.execute(scratch, config);
    } catch (error) {
      return infra(`Secrets-Scan nicht möglich: ${(error as Error).message}`);
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }

  async scanDirectory(root: string, options: DirectoryScanOptions): Promise<SecretScanResult> {
    const tree = await collectReadableFiles(root);
    if (!tree.ok) return infra(tree.problem);
    // Reachable only after the walk found no *unreadable* file, so this really
    // is "there was nothing here" and not "we could not look" — the two must
    // not share a sentence any more than they share a verdict.
    if (tree.files.length === 0) return emptyTree(`„${root}" enthält keine Dateien.`);
    try {
      await access(options.configPath, fsConstants.R_OK);
    } catch (error) {
      return infra(
        `Die Regeldatei „${options.configPath}" ist nicht lesbar: ${(error as Error).message}`,
      );
    }
    return this.execute(root, options.configPath);
  }

  private async execute(scanRoot: string, configPath: string | null): Promise<SecretScanResult> {
    const result = await run(this.binary, gitleaksArgv(scanRoot, configPath), this.timeoutMs);
    if (result.spawnFailed) {
      return infra(
        `„${this.binary}" konnte nicht gestartet werden — der Baum wurde nicht geprüft (A25). ` +
          'Im Orchestrator-Image ist das Binär gepinnt installiert; fehlt es, ist das Image alt.',
        trim(result.stderr),
      );
    }
    return classifyGitleaksRun({ ...result, scanRoot, tool: 'Binär' });
  }
}

// --- choosing between them -------------------------------------------------------

/**
 * Whichever of the two can run here — the binary first, then the container.
 *
 * This is what `GateSuite` defaults to, and it is the whole repair: the same
 * construction answers in the orchestrator container (binary, no daemon) and on
 * a developer machine (image, no binary), with the same rules and the same
 * verdicts. Where neither is available the answer is `infra` and never green,
 * so a machine with no scanner blocks merges loudly instead of passing them
 * quietly.
 *
 * The binary is preferred because it is the cheaper probe and needs no daemon —
 * but **only at the pinned version** (decision 5). An unpinned gitleaks on a
 * developer's `PATH` would otherwise decide a locked gate with a different rule
 * engine than the production host uses, which is the divergence this pin exists to remove.
 *
 * The choice is made once per instance and cached: it is a property of the
 * machine, and re-probing docker before every merge would add a daemon round
 * trip to a gate that already holds the project's merge lock (A55.2).
 */
export class AutoSecretScanner implements GitleaksScanner {
  private chosen: Promise<GitleaksScanner | null> | null = null;

  constructor(private readonly options: { binary?: string; image?: string } = {}) {}

  private choose(): Promise<GitleaksScanner | null> {
    this.chosen ??= (async () => {
      const binary = this.options.binary ?? GITLEAKS_BINARY;
      const version = await GitleaksBinaryScanner.version(binary);
      if (version === normaliseGitleaksVersion(GITLEAKS_VERSION)) {
        return new GitleaksBinaryScanner({ binary });
      }
      if (await GitleaksSecretScanner.available()) {
        // Spelled out rather than `{ image: this.options.image }`: under
        // `exactOptionalPropertyTypes` an explicit `undefined` is not the same
        // as an absent key, and the absent one is what selects the pin.
        return new GitleaksSecretScanner(
          this.options.image === undefined ? {} : { image: this.options.image },
        );
      }
      return null;
    })();
    return this.chosen;
  }

  private unavailable(): SecretScanResult {
    return infra(
      'Auf dieser Maschine gibt es weder das gepinnte gitleaks-Binär noch einen erreichbaren ' +
        `Docker-Daemon — der Secrets-Scan (§11.4) lief nicht. Erwartet wird gitleaks ` +
        `${GITLEAKS_VERSION} als „${this.options.binary ?? GITLEAKS_BINARY}" im PATH oder ` +
        'ein Docker-Daemon für das gepinnte Image. Kein Befund, aber auch keine Freigabe (A25).',
    );
  }

  async scan(cwd: string): Promise<SecretScanResult> {
    const scanner = await this.choose();
    return scanner === null ? this.unavailable() : scanner.scan(cwd);
  }

  async scanDirectory(root: string, options: DirectoryScanOptions): Promise<SecretScanResult> {
    const scanner = await this.choose();
    return scanner === null ? this.unavailable() : scanner.scanDirectory(root, options);
  }
}
