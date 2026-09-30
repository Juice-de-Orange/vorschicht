#!/usr/bin/env node
/**
 * Secrets-scan gate (§11.4, §19) — gitleaks over both the git history and the
 * set of files that could still reach it.
 *
 * gitleaks is deliberately NOT installed on the host: it runs from a container
 * image so the gate behaves identically on the build machine, on the production host and in CI,
 * and so no host state can quietly change what "clean" means.
 *
 * Why the working-tree scan is not simply `gitleaks dir .`
 * -------------------------------------------------------
 * A real deployment has a populated `.env` sitting in the working directory.
 * Scanning it flags four secrets on every single run — and a gate that is
 * permanently red teaches everyone to stop reading it, which is strictly worse
 * than having no gate. But allow-listing `.env` in the config would also blind
 * the scan to an `.env` that someone force-added.
 *
 * So the scan is pointed at exactly the right set: the files git can actually
 * see (tracked, plus untracked-but-not-ignored). A secret in an ignored file
 * cannot reach the repository; a secret in a file git would commit is caught
 * here *before* the commit; and anything that slipped through historically is
 * caught by the separate history scan, which reads the real object store.
 *
 * Why the history scan needs a second mount
 * -----------------------------------------
 * In an ordinary clone `.git` is a directory inside the repository, so the
 * `${REPO}:/scan` mount carries it. In a **git worktree** it is a *file* holding
 * `gitdir: <absolute path>` that points outside the repository — and every agent
 * of this studio writes in a worktree (§10), so that is not the exotic case but
 * the normal one. The mount then carries a pointer to nothing, git inside the
 * container answers `fatal: not a git repository`, gitleaks reports
 * `0 commits scanned` and **exits 0**, and this gate printed "keine Secrets in
 * der Historie". Measured on this repository, not deduced: 172 commits on HEAD,
 * zero of them read, exit 0 — §11's locked gate 4 examining nothing at every
 * single agent run and reporting clean. The administrative directory is
 * therefore mounted at its own absolute path, which is the path the `gitdir:`
 * file names, so the link resolves inside the container.
 *
 * Why a green history scan now has to prove it read something
 * -----------------------------------------------------------
 * Repairing the mount is not enough on its own: it fixes today's cause and
 * leaves the shape intact, and the shape is the defect. A scanner that cannot
 * reach the history reports the same green as one that read all of it (A104.4
 * measured the same thing for `gitleaks dir` on a missing path; A83.6 is the
 * general rule — "we could not look" and "it is clean" are one sentence only to
 * a system that has decided not to notice).
 *
 * So the count is established **independently, where gitleaks runs**: git inside
 * the container is asked how many commits it can see, and that number must equal
 * what git on the host sees. Deliberately not read off gitleaks' own
 * `N commits scanned` line, for two reasons. `secret-scan.ts` decision 4 already
 * rejected keying a locked gate on this vendor's log vocabulary (A73.4's
 * reason) — and that number does not mean what `rev-list --count HEAD` means
 * anyway. Measured here: gitleaks reported 151 against a HEAD of 172, and it
 * reports commits that are **not on HEAD at all** — a secret committed on a
 * second branch of the same repository is found from a worktree whose HEAD never
 * saw it, because refs are shared. Which is a good property for a secrets gate
 * and a useless one for a preflight: `rev-list --count HEAD` is a number with
 * one meaning on both sides of the mount, and that is the only thing being
 * compared here.
 *
 * Exit codes: 0 = clean · 1 = leak found (blocker) · 2 = infra failure (A25).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exit } from 'node:process';

/**
 * The image, pinned by tag and digest — kept identical to `GITLEAKS_IMAGE` in
 * `packages/core/src/secret-scan.ts`, which `gitleaks-pin.test.ts` asserts.
 *
 * It said `:latest` until the orchestrator grew a *second* way to run this tool
 * (a pinned binary, because the deployed container has no docker). Two
 * unsynchronised gitleaks versions deciding one locked gate is a merge that
 * blocks on one machine and passes on another, with nothing to point at
 * afterwards — so the pin is what makes "the same gate everywhere" true rather
 * than merely intended. A34 already requires it of every other image here.
 */
const IMAGE =
  'zricethezav/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';
const GITLEAKS_VERSION = '8.30.1';
const REPO = process.cwd();

if (!existsSync(join(REPO, '.gitleaks.toml'))) {
  console.error('gate:secrets — .gitleaks.toml fehlt. Gate kann nicht ehrlich laufen.');
  exit(2);
}

/**
 * A local gitleaks, but only if it **is** the pin.
 *
 * `AutoSecretScanner` settled this rule already (A104.6): two gitleaks versions
 * deciding one locked gate is a candidate that blocks on one machine and merges
 * on another, with nothing in either trace naming why. A binary that is *not*
 * the pin is therefore not a cheaper path, it is a different gate.
 *
 * The version string is normalised because the two distributions disagree — the
 * release tarball answers `8.30.1`, the image answers `v8.30.1` (both measured).
 *
 * @returns {boolean}
 */
function localGitleaksMatchesPin() {
  const res = spawnSync('gitleaks', ['version'], { encoding: 'utf8' });
  if (res.error || res.status !== 0) return false;
  return (res.stdout ?? '').trim().replace(/^v/, '') === GITLEAKS_VERSION;
}

const useBinary = localGitleaksMatchesPin();

// Only the container path needs a daemon. Inside `Dockerfile.gate` — and in the
// deployed orchestrator, which ships no docker client at all — the binary is the
// only implementation there is.
if (!useBinary && spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
  console.error('gate:secrets — docker nicht erreichbar (Infra-Fehler, kein Finding).');
  exit(2);
}

const isGitRepo = spawnSync('git', ['rev-parse', '--git-dir'], { stdio: 'ignore' }).status === 0;

/** @param {string} child @param {string} parent */
const isUnder = (child, parent) => child === parent || child.startsWith(`${parent}/`);

/**
 * The git administrative directories that live outside `${REPO}` (see header).
 *
 * `--git-common-dir` is the object store — the worktree's commits are in there,
 * not in its own admin directory — and `--git-dir` is the per-worktree one that
 * the `gitdir:` file names. In a plain clone both resolve inside `${REPO}` and
 * this list is empty, so the ordinary case gains no mount and no behaviour.
 *
 * A path that does not exist is dropped rather than mounted: `docker run -v`
 * *creates* a missing host path, as a root-owned directory, so a wrong answer
 * here would leave litter on the host instead of failing.
 *
 * @returns {string[]}
 */
function externalGitDirs() {
  if (!isGitRepo) return [];
  /** @type {string[]} */
  const dirs = [];
  for (const flag of ['--git-common-dir', '--git-dir']) {
    const res = spawnSync('git', ['rev-parse', '--path-format=absolute', flag], {
      encoding: 'utf8',
    });
    const dir = res.status === 0 ? res.stdout.trim() : '';
    if (!dir || isUnder(dir, REPO) || !existsSync(dir)) continue;
    // The per-worktree directory normally sits inside the common one; mounting
    // both would be two mounts for one filesystem subtree.
    if (dirs.some((have) => isUnder(dir, have))) continue;
    dirs.push(dir);
  }
  return dirs;
}

const EXTERNAL_GIT_DIRS = externalGitDirs();

/**
 * What the history scan is given — and, by construction, what the preflight is
 * given too. It takes no argument precisely so that there is nothing a later
 * edit could pass differently.
 *
 * One list rather than two on purpose. The preflight below is evidence about
 * the scan only if it runs against **the same** filesystem: two lists that
 * happen to agree today would let an edit drop the mount from the scan alone,
 * and the probe would go on answering 172 while gitleaks read nothing — the
 * original defect, with a check in front of it that cannot see it. Proven by
 * mutation rather than asserted: emptying this turns the run into exit 2.
 *
 * @returns {string[]}
 */
function historyMounts() {
  return [
    '-v',
    `${REPO}:/scan:ro`,
    ...EXTERNAL_GIT_DIRS.flatMap((dir) => ['-v', `${dir}:${dir}:ro`]),
  ];
}

/**
 * What the working-tree scan is given: the materialised file list and nothing
 * else. It deliberately does **not** inherit the git mounts — that scan reads
 * `/scan` only, so the directories would be reachable without being read, and a
 * container sees least when it is given least (§19).
 *
 * @param {string} scratch
 * @returns {string[]}
 */
const treeMounts = (scratch) => ['-v', `${scratch}:/scan:ro`];

/**
 * How many commits the scanner can see, asked of git inside the container.
 *
 * The question is not "does the history exist" — the host already knows that —
 * but "can the process that is about to report on it read it at all".
 *
 * **Which is why it runs in the container and not beside it**, and that is
 * measured rather than argued. Replacing this body with `return commitsOnHost()`
 * survives on its own: the mounts are fine, so both numbers agree and nothing
 * looks wrong. Remove the mounts as well and the run goes green again reporting
 * `0 commits scanned` — with the green line now claiming "172 Commit(s)
 * Historie", a number that came from the host and describes nothing that was
 * read. A check that asks a different machine than the one doing the work is a
 * check that agrees with itself.
 *
 * **Only the container arm has a second view that could differ.** The binary
 * reads this very filesystem, so there is no mount to be wrong and nothing for
 * a comparison to catch; asking git twice on the same machine and finding the
 * same number would be a check that agrees with itself, which is precisely the
 * shape the paragraph above rejects. The caller therefore skips the comparison
 * for the binary and says so, rather than performing a reassuring no-op.
 *
 * @returns {number | null} null when the container's git could not answer
 */
function commitsVisibleToScanner() {
  const res = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--network=none',
      ...historyMounts(),
      '--entrypoint',
      'git',
      IMAGE,
      '-C',
      '/scan',
      'rev-list',
      '--count',
      'HEAD',
    ],
    { encoding: 'utf8' },
  );
  if (res.status !== 0) return null;
  const count = Number.parseInt(res.stdout.trim(), 10);
  return Number.isInteger(count) ? count : null;
}

/** @returns {number | null} null when HEAD names no commit yet (unborn branch) */
function commitsOnHost() {
  const res = spawnSync('git', ['rev-list', '--count', 'HEAD'], { encoding: 'utf8' });
  if (res.status !== 0) return null;
  const count = Number.parseInt(res.stdout.trim(), 10);
  return Number.isInteger(count) ? count : null;
}

/**
 * Materialise the git-visible files into a scratch directory.
 * @returns {string | null} scratch path, or null when it could not be built
 */
function materialiseGitVisibleFiles() {
  const scratch = mkdtempSync(join(tmpdir(), 'vorschicht-secrets-'));
  // `-c` tracked, `-o` untracked, `--exclude-standard` honours .gitignore.
  const copy = spawnSync(
    'bash',
    [
      '-c',
      `git ls-files -co --exclude-standard -z | tar --null -cf - --files-from=- | tar -xf - -C "${scratch}"`,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8' },
  );
  if (copy.status !== 0) {
    rmSync(scratch, { recursive: true, force: true });
    console.error(`gate:secrets — konnte Dateiliste nicht materialisieren: ${copy.stderr?.trim()}`);
    return null;
  }
  return scratch;
}

/**
 * One scan, either implementation.
 *
 * The container arm needs `mountArgs` — the `-v` set that also carries the
 * external git directories a worktree's history lives in. The binary arm needs
 * none of that: it reads this filesystem directly, so it only wants the path.
 * Both are handed the same subcommand against the same rules, which is the one
 * property a reader of a green gate relies on (A104.2's shared contract suite).
 *
 * @param {string} label
 * @param {string} source  path to scan, on this machine — the binary arm
 * @param {string[]} mountArgs the complete `-v` set — the container arm
 * @param {'dir' | 'git'} subcommand
 * @returns {number}
 */
function scan(label, source, mountArgs, subcommand) {
  console.log(`  → ${label}${useBinary ? '' : ' (Container)'}`);
  const common = ['--no-banner', '--redact'];
  const res = useBinary
    ? spawnSync(
        'gitleaks',
        [subcommand, source, `--config=${join(REPO, '.gitleaks.toml')}`, ...common],
        { stdio: 'inherit' },
      )
    : spawnSync(
        'docker',
        [
          'run',
          '--rm',
          '--network=none',
          ...mountArgs,
          '-v',
          `${REPO}/.gitleaks.toml:/gitleaks.toml:ro`,
          IMAGE,
          subcommand,
          '/scan',
          '--config=/gitleaks.toml',
          ...common,
        ],
        { stdio: 'inherit' },
      );
  if (res.error) {
    console.error(`gate:secrets — konnte gitleaks nicht starten: ${res.error.message}`);
    return 2;
  }
  return res.status ?? 2;
}

// gitleaks 8.19+ splits `detect` into `git` and `dir`. This used to be probed
// at run time — one container start per gate run to answer a question the
// version already answers. With the image pinned above, the probe could only
// ever return the same result, and a branch that cannot be reached differently
// reads as covered while carrying no signal (§8.2, domain 6). The pinned 8.30.1
// has both; `dir`/`git` is what the probe resolved to, so behaviour is
// unchanged and the legacy arm is gone rather than unreachable.
let worst = 0;
/** @param {number} code */
const record = (code) => {
  if (code === 1) worst = 1;
  else if (code !== 0 && worst !== 1) worst = 2;
};

/**
 * The commit count the preflight verified, kept for the green line.
 *
 * Read once rather than again at the end, so the number reported is the number
 * that was checked. Not pedantry: several agents commit into this repository
 * concurrently, so a second `rev-list` can legitimately return something the
 * scan never saw — and a green line whose number drifted from the verified one
 * is exactly the reassuring-but-unearned figure this whole preflight exists to
 * remove.
 *
 * @type {number | null}
 */
let verifiedCommits = null;

let scratch = null;
try {
  if (isGitRepo) {
    scratch = materialiseGitVisibleFiles();
    if (scratch === null) {
      worst = 2;
    } else {
      record(scan('Versionierbare Dateien', scratch, treeMounts(scratch), 'dir'));
    }

    // The history scan, and the proof that it had a history to read.
    //
    // An unborn HEAD is the one honest zero: a repository with no commits has
    // no history, so there is nothing to examine and nothing to claim. Every
    // other zero is the defect this preflight exists to catch.
    const onHost = commitsOnHost();
    if (onHost === null) {
      console.log('  → Git-Historie — HEAD nennt noch keinen Commit, es gibt keine zu prüfen');
    } else {
      // Mit dem Binaer gibt es keinen Mount, also auch keine zweite Sicht, die
      // abweichen koennte. Der Host *ist* die Sicht des Scanners.
      const visible = useBinary ? onHost : commitsVisibleToScanner();
      if (visible === null) {
        console.error(
          '  ✗ Git-Historie — der Scanner kann das Repository nicht lesen: git im Container ' +
            'beantwortet `rev-list --count HEAD` nicht.\n' +
            `    Auf dem Host sind es ${onHost} Commit(s). Ungeprüft ist kein Befund und kein ` +
            'grünes Ergebnis (A25, A83.6).',
        );
        record(2);
      } else if (visible !== onHost) {
        console.error(
          `  ✗ Git-Historie — der Scanner sieht ${visible} Commit(s), der Host ${onHost}. ` +
            'Es würde also eine andere Historie geprüft als die, über die berichtet wird.',
        );
        record(2);
      } else {
        verifiedCommits = visible;
        record(scan('Git-Historie', REPO, historyMounts(), 'git'));
      }
    }
  } else {
    record(scan('Arbeitsverzeichnis', REPO, treeMounts(REPO), 'dir'));
  }
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
}

if (worst === 0) {
  // The commit count is in the green line on purpose. "Keine Secrets in der
  // Historie" was true of a run that read nothing, and a reader had no way to
  // tell — the number is what makes the sentence checkable at a glance.
  console.log(
    isGitRepo
      ? '  ✓ keine Secrets in versionierbaren Dateien und keine in ' +
          (verifiedCommits === null
            ? 'der Historie (noch keine Commits)'
            : `${verifiedCommits} Commit(s) Historie`)
      : '  ✓ keine Secrets gefunden',
  );
}
exit(worst);
