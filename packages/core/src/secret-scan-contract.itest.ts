/**
 * The shared `SecretScanner` contract suite (§11.4, §19, A25).
 *
 * `deploy/target-contract.test.ts` is the model and `backend/contract.test.ts`
 * is its model: every implementation is held to the same promises, in the same
 * file, so one that drifts **fails** rather than being differently correct. The
 * argument is sharper here than in either of those, because these two decide a
 * **locked** baseline gate. A divergence between them is not a wrong answer —
 * it is a merge that blocks on a developer's laptop and passes in the deployed
 * studio, or the reverse, with nothing in either trace naming the reason.
 *
 * That is not hypothetical. Until this commit there was one implementation and
 * it needed a docker daemon; the orchestrator image has none, so §11's gate 4
 * answered `infra` on every merge the studio ever attempted. The gate read
 * green in `CLAUDE.md` because it had been demonstrated where docker exists.
 *
 * Four properties of how this is written matter more than the cases:
 *
 *  1. **Real tools, no stubs.** A stub would agree with whichever model of
 *     gitleaks the author held, which is the shared misunderstanding §8.2
 *     exists to break. Both implementations run the pinned 8.30.1 for real, so
 *     the file is an `.itest.ts`.
 *
 *  2. **The binary is obtained from the pin, not from the machine.** A machine
 *     with no gitleaks would otherwise skip exactly the half this commit adds.
 *     Resolution order is `$VORSCHICHT_GITLEAKS_BIN`, then a `gitleaks` on
 *     `PATH` *that reports the pinned version*, then extraction from the pinned
 *     image. The middle rung refuses a different version deliberately: a suite
 *     that quietly tested 8.18 would prove the wrong tool works.
 *
 *  3. **Every planted secret is derived, never written.** A55's lesson, and it
 *     cost a whole gate once: the fixture wrote `glpat-` plus twenty `x`, which
 *     has the right shape and no entropy, so gitleaks ignored it and the gate
 *     built on it could never have blocked anything. Nothing here is a literal
 *     — that would make `gate:secrets` flag this very file — and everything is
 *     a hash, which carries real entropy for the rules that require it.
 *
 *  4. **One case is about the *rules*, not about a leak.** `ntfy-access-token`
 *     exists only in this project's `.gitleaks.toml`; the vendor's default set
 *     has never heard of it. So a scan that finds it proves the configuration
 *     was actually loaded — which is the whole of decision 2 in
 *     `secret-scan.ts`, and the one thing a directory with no committed config
 *     silently gets wrong.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AutoSecretScanner,
  GITLEAKS_IMAGE,
  GITLEAKS_VERSION,
  GitleaksBinaryScanner,
  type GitleaksScanner,
  GitleaksSecretScanner,
  normaliseGitleaksVersion,
} from './secret-scan.js';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const configPath = join(repoRoot, '.gitleaks.toml');

/** Everything this file creates, removed in one place however a case ends. */
const scratchDirs: string[] = [];

async function scratch(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), `vorschicht-${prefix}-`));
  scratchDirs.push(path);
  return path;
}

afterAll(async () => {
  await Promise.all(scratchDirs.map((path) => rm(path, { recursive: true, force: true })));
});

// --- the two derived secrets ----------------------------------------------------

/**
 * A token of the shape `anthropic-oauth-token` matches (A55, decision 3).
 *
 * The prefix is split so the literal never appears in this repository even as a
 * substring of a comment — `gate:secrets` scans this file like any other.
 */
function anthropicToken(): string {
  const digest = createHash('sha256').update('vorschicht-scanner-contract').digest('hex');
  return `sk-ant-${'oat'}01-${digest.slice(0, 40)}`;
}

/**
 * A token only *this* project's rules know about — the rule-source case.
 *
 * `ntfy-access-token` is one of the four classes `.gitleaks.toml` adds on top
 * of the vendor's defaults, and its pattern (`tk_` plus lowercase alphanumerics)
 * is not in that default set. A hash in hex satisfies it and carries entropy.
 */
function ntfyToken(): string {
  const digest = createHash('sha256').update('vorschicht-ntfy-contract').digest('hex');
  return `${'tk'}_${digest.slice(0, 30)}`;
}

// --- fixtures --------------------------------------------------------------------

/**
 * A git repository carrying this project's own rules.
 *
 * The config has to be *inside* the tree because `scan()` examines a copy of
 * what git can see (A55.5), which is also exactly how the rules reach the
 * scanner in production.
 */
async function gitTree(files: Record<string, string>): Promise<string> {
  const path = await scratch('scanner-git');
  await run('git', ['init', '-q'], { cwd: path });
  await copyFile(configPath, join(path, '.gitleaks.toml'));
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(path, name, '..'), { recursive: true });
    await writeFile(join(path, name), content, 'utf8');
  }
  return path;
}

/** A plain directory — no repository, no committed config. */
async function plainTree(files: Record<string, string>): Promise<string> {
  const path = await scratch('scanner-plain');
  for (const [name, content] of Object.entries(files)) {
    await mkdir(join(path, name, '..'), { recursive: true });
    await writeFile(join(path, name), content, 'utf8');
  }
  return path;
}

// --- resolving the two implementations --------------------------------------------

const containerAvailable = await GitleaksSecretScanner.available();

/**
 * The pinned binary, however this machine can reach it (property 2).
 *
 * The last rung takes it out of the pinned image, which is the only way this
 * half of the contract runs at all on a developer machine that has docker and
 * no gitleaks — i.e. on every machine this project has been built on so far.
 */
async function resolvePinnedBinary(): Promise<string | null> {
  const wanted = normaliseGitleaksVersion(GITLEAKS_VERSION);

  const configured = process.env.VORSCHICHT_GITLEAKS_BIN;
  if (configured && (await GitleaksBinaryScanner.version(configured)) === wanted) return configured;

  if ((await GitleaksBinaryScanner.version()) === wanted) return 'gitleaks';

  if (!containerAvailable) return null;
  try {
    const home = await scratch('scanner-bin');
    const target = join(home, 'gitleaks');
    const { stdout } = await run('docker', ['create', GITLEAKS_IMAGE]);
    const container = stdout.trim();
    try {
      await run('docker', ['cp', `${container}:/usr/bin/gitleaks`, target]);
    } finally {
      await run('docker', ['rm', '-f', container]);
    }
    await chmod(target, 0o755);
    return (await GitleaksBinaryScanner.version(target)) === wanted ? target : null;
  } catch {
    return null;
  }
}

const pinnedBinary = await resolvePinnedBinary();

interface ScannerUnderTest {
  /** A working instance. */
  make(): GitleaksScanner;
  /** The same implementation, pointed at a tool that is not there. */
  broken(): GitleaksScanner;
}

// --- the contract ------------------------------------------------------------------

function describeSecretScanner(name: string, available: boolean, under: ScannerUnderTest): void {
  describe.skipIf(!available)(`${name}: SecretScanner-Vertrag (§11.4, §19, A25)`, () => {
    it('meldet einen sauberen git-Baum grün', async () => {
      const tree = await gitTree({ 'src/app.ts': 'export const gruss = "Servus";\n' });
      const result = await under.make().scan(tree);
      expect({ verdict: result.verdict, findings: result.findings }).toEqual({
        verdict: 'green',
        findings: [],
      });
    });

    it('blockiert ein abgeleitetes Token im git-Baum und nennt Regel und Datei', async () => {
      const tree = await gitTree({
        'src/config.ts': `export const token = '${anthropicToken()}';\n`,
      });
      const result = await under.make().scan(tree);

      expect(result.verdict).toBe('finding');
      // The two facts a fix task needs to start, and the reason `findings` is
      // structured rather than left in a log line (A69.5).
      expect(result.findings).toContainEqual(
        expect.objectContaining({ rule: 'anthropic-oauth-token', file: 'src/config.ts' }),
      );
      // Relative to the scanned tree — gitleaks reports the path it was handed
      // (`/scan/…` in a container, a temp path for the binary), and both
      // implementations have to answer alike or a finding means two things.
      for (const finding of result.findings) expect(finding.file).not.toMatch(/^\//);
    });

    it('meldet ein sauberes Verzeichnis ohne git grün', async () => {
      const tree = await plainTree({ 'sitzung.jsonl': '{"rolle":"assistant"}\n' });
      const result = await under.make().scanDirectory(tree, { configPath });
      expect({ verdict: result.verdict, findings: result.findings }).toEqual({
        verdict: 'green',
        findings: [],
      });
    });

    it('blockiert ein abgeleitetes Token in einem Verzeichnis ohne git', async () => {
      // §6.6's nightly transcript scan is this entry point: a directory with no
      // repository, no index and no committed config.
      const tree = await plainTree({
        'a/sitzung.jsonl': `{"text":"${anthropicToken()}"}\n`,
      });
      const result = await under.make().scanDirectory(tree, { configPath });

      expect(result.verdict).toBe('finding');
      expect(result.findings).toContainEqual(
        expect.objectContaining({ rule: 'anthropic-oauth-token', file: 'a/sitzung.jsonl' }),
      );
    });

    it('wendet auch ohne git die Regeln dieses Projekts an, nicht die des Herstellers', async () => {
      // Property 4, and the whole of decision 2. `ntfy-access-token` exists
      // only in this repository's `.gitleaks.toml`. A scan that discovered its
      // config from the scanned tree would find nothing here — there is no
      // config in that tree — and would report a credential-carrying directory
      // clean, every night, for as long as nobody looked.
      const tree = await plainTree({ 'transkript.jsonl': `token=${ntfyToken()}\n` });
      const result = await under.make().scanDirectory(tree, { configPath });

      expect(result.verdict).toBe('finding');
      expect(result.findings.map((finding) => finding.rule)).toContain('ntfy-access-token');
    });

    it('verweigert ein Verzeichnis, das es gar nicht gibt — niemals grün', async () => {
      // Measured on 8.30.1: `gitleaks dir /does/not/exist` exits **0** and
      // prints `[]`. Pointed at a mistyped path the tool reports the tree
      // clean, which is silent and merges, where `infra` is loud and retried.
      const missing = join(await scratch('scanner-missing'), 'nicht-da');
      const result = await under.make().scanDirectory(missing, { configPath });
      expect(result.verdict).toBe('infra');
    });

    it('verweigert einen Baum mit einer unlesbaren Datei — niemals grün', async () => {
      // A103's shape exactly: the transcripts are mode 0600 owned by uid 10001,
      // and a scanner running as anyone else would have reported §6.6's nightly
      // scan clean over files it never opened.
      const tree = await plainTree({ 'geheim.jsonl': 'egal\n' });
      await chmod(join(tree, 'geheim.jsonl'), 0o000);
      try {
        const result = await under.make().scanDirectory(tree, { configPath });
        expect(result.verdict).toBe('infra');
        expect(result.detail).toContain('nicht lesbar');
      } finally {
        await chmod(join(tree, 'geheim.jsonl'), 0o644);
      }
    });

    it('meldet ein leeres Verzeichnis grün, und das ist der ehrliche Fall', async () => {
      // The counterweight to the two cases above: "nothing was there" and
      // "nothing could be read" must not collapse into one answer, or the
      // refusal becomes noise and gets removed.
      const empty = await scratch('scanner-empty');
      const result = await under.make().scanDirectory(empty, { configPath });
      expect(result.verdict).toBe('green');
    });

    it('ist infra und niemals grün, wenn das Werkzeug gar nicht erreichbar ist', async () => {
      // A25's distinction, and the defect this whole commit repairs: the
      // deployed studio had no docker, so this branch was every merge it ever
      // attempted. It must never be able to answer green.
      const tree = await gitTree({ 'src/app.ts': 'export const gruss = "Servus";\n' });
      const broken = under.broken();

      const git = await broken.scan(tree);
      const plain = await broken.scanDirectory(tree, { configPath });
      expect([git.verdict, plain.verdict]).toEqual(['infra', 'infra']);
    });

    it('prüft, was git sieht — eine ignorierte Datei blockiert nichts', async () => {
      // A55.5, pinned because the scanner moved modules in this commit: a
      // deployed project has a populated `.env` in its working tree, and a gate
      // that is red on every run teaches everyone to stop reading it.
      const tree = await gitTree({
        '.gitignore': '.env\n',
        '.env': `CLAUDE_CODE_OAUTH_TOKEN=${anthropicToken()}\n`,
        'src/app.ts': 'export const gruss = "Servus";\n',
      });
      const result = await under.make().scan(tree);
      expect(result.verdict).toBe('green');
    });
  });
}

describeSecretScanner('Container', containerAvailable, {
  make: () => new GitleaksSecretScanner(),
  // A digest that exists nowhere, rather than a bogus repository name: it fails
  // at the same place a real image would when the registry is unreachable.
  broken: () =>
    new GitleaksSecretScanner({
      image: `zricethezav/gitleaks@sha256:${'0'.repeat(64)}`,
      timeoutMs: 60_000,
    }),
});

describeSecretScanner('Binär', pinnedBinary !== null, {
  make: () => new GitleaksBinaryScanner({ binary: pinnedBinary as string }),
  broken: () => new GitleaksBinaryScanner({ binary: '/nicht/vorhanden/gitleaks' }),
});

/**
 * The selector, and the one property of it that can fail quietly.
 *
 * `AutoSecretScanner` prefers the binary because the orchestrator container has
 * no daemon. Preferring *any* binary would mean a developer's stray gitleaks
 * deciding a locked gate with a different rule engine than the production host uses —
 * which is exactly the divergence the pin exists to remove, and it would be
 * invisible, because a wrong-version gitleaks answers plausibly.
 */
describe.skipIf(!containerAvailable)('AutoSecretScanner — die Auswahl (§11.4, A27)', () => {
  /**
   * A binary that answers like gitleaks and is the wrong version.
   *
   * It reports a clean tree for any scan, so a selector that accepted it would
   * answer **green** — which is what makes this case decisive rather than
   * decorative.
   */
  async function wrongVersionBinary(): Promise<string> {
    const home = await scratch('scanner-fake');
    const path = join(home, 'gitleaks');
    await writeFile(
      path,
      '#!/bin/sh\nif [ "$1" = "version" ]; then echo v8.18.0; exit 0; fi\necho "[]"\nexit 0\n',
      'utf8',
    );
    await chmod(path, 0o755);
    return path;
  }

  it('nimmt kein Binär, das nicht die gepinnte Version ist', async () => {
    const tree = await gitTree({ 'src/app.ts': 'export const gruss = "Servus";\n' });
    // The fake would answer green; the image is a digest that exists nowhere.
    // So the only way out is `infra` — and if the selector ever starts trusting
    // an unpinned binary, this goes green instead.
    const scanner = new AutoSecretScanner({
      binary: await wrongVersionBinary(),
      image: `zricethezav/gitleaks@sha256:${'0'.repeat(64)}`,
    });

    const result = await scanner.scan(tree);
    expect(result.verdict).toBe('infra');
  });

  it('nimmt das gepinnte Binär, wenn es da ist', async () => {
    const tree = await gitTree({ 'src/app.ts': 'export const gruss = "Servus";\n' });
    // Same bogus image, so a green verdict can only have come from the binary —
    // which is the half that makes gate 4 answerable in the container at all.
    const scanner = new AutoSecretScanner({
      binary: pinnedBinary ?? '/nicht/vorhanden/gitleaks',
      image: `zricethezav/gitleaks@sha256:${'0'.repeat(64)}`,
    });

    const result = await scanner.scan(tree);
    expect(result.verdict).toBe(pinnedBinary === null ? 'infra' : 'green');
  });
});
