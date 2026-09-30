/**
 * The sandbox fixture project (§22, Phase 2 and Phase 3).
 *
 * Several Phase 2 and Phase 3 exit gates are worded around a "sandbox project":
 * two parallel tasks merging cleanly, a seeded test failure blocking a merge, a
 * planted secret, a lint error, an out-of-claim edit the Reviewer must catch.
 * None of those can live in a real repository — a repository with a smuggled
 * credential in it is a repository with a smuggled credential in it, whatever
 * the intent — so the fixture is built here, into a throwaway directory, and
 * exists only for the length of a test or a demo run.
 *
 * Three properties it needs and a real project would not give:
 *
 *  1. **It is complete and cheap.** A real git repository with a real initial
 *     commit on a real integration branch, because the worktree manager, the
 *     wrap-up's WIP commit and the claim check all talk to git rather than to an
 *     abstraction over it. Nothing here is mocked.
 *  2. **Its checks are runnable without a toolchain.** `node --test` and a
 *     three-line lint script, so a gate run inside a test costs milliseconds and
 *     depends on nothing that could be missing on the target host.
 *  3. **Its failures are seeded on purpose.** `seed` plants exactly one defect
 *     of a named class, which is what turns "the gate is green" into "the gate
 *     goes red for this reason and green again afterwards".
 *  4. **It is deployable** (§22, Phase 5). A `Dockerfile`, a one-service
 *     `docker-compose.yml` and a dependency-free HTTP server that answers
 *     `/healthz` — enough for §12's engine to build an image per commit, swap
 *     it in, poll a real URL and roll back, against a real docker daemon.
 *
 * It deliberately does **not** live as checked-in files under a fixtures
 * directory. A planted lint error in this repository would be linted by our own
 * `pnpm gate`, and a planted secret would be found by `gate:secrets` — both
 * correctly, and both permanently red. Generating the fixture at run time is
 * what keeps the seeded defects seeded rather than shipped. That argument
 * applies **doubly** to property 4: two of Phase 5's exit gates ask for an
 * *induced broken release*, and a repository carrying a health check that
 * answers 503 is a repository carrying a health check that answers 503,
 * whatever the intent — `gate:build` and every reader would be right to object.
 */
import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { BOT_IDENTITY } from './git.js';
import {
  CHECK_A11Y,
  CHECK_BUDGET,
  CHECK_DEPS_AUDIT,
  CHECK_E2E,
  CHECK_LICENSES,
  CHECK_SAST,
} from './sandbox-checks.js';

const run = promisify(execFile);

/** A defect the fixture can be given, one at a time. */
export type SandboxSeed =
  /** An assertion that does not hold — the test gate must go red. */
  | 'failing_test'
  /** A credential-shaped string in a versionable file — the secrets gate. */
  | 'planted_secret'
  /** A style violation the fixture's own lint script rejects. */
  | 'lint_error'
  /** A file outside any plausible claim set — §10's second layer. */
  | 'out_of_claims'
  /**
   * A schema change the running release would not survive — §11's migration gate.
   *
   * Deliberately a `DROP COLUMN` in a file the default migration globs match
   * (A63), because that is the shape §12's rollback cannot undo: the previous
   * release's code is restored and still selects the column.
   */
  | 'bad_migration'
  /** The same change done additively — what the fixed candidate looks like. */
  | 'safe_migration'
  /**
   * One violation per optional **command** gate (§11), for §22's Phase 3 gate
   * "every optional gate demonstrably blocks a seeded violation".
   *
   * Each is a genuine violation of its gate's own class, and — the property the
   * tests assert and the reason they are worth having — each is caught by that
   * gate and by no other. A seed that also tripped `lint` would make its gate's
   * demonstration a statement about `lint`.
   */
  /** A vendored dependency under a licence the policy list refuses. */
  | 'bad_license'
  /** A vendored dependency downgraded onto a high-severity advisory. */
  | 'vulnerable_dependency'
  /** A source file using `eval` on data from outside — the SAST rule set. */
  | 'sast_finding'
  /** Markup axe would reject: an image with no text alternative. */
  | 'a11y_violation'
  /**
   * The entry point wired wrongly while every unit test still passes.
   *
   * The distinction between the `test` gate and the `e2e` gate, made concrete:
   * `greet()` keeps its contract, and the program built on top of it does not.
   */
  | 'broken_smoke'
  /** A shipped asset that puts the tree over its performance budget. */
  | 'oversized_bundle'
  /**
   * The release that comes up and is not well — §12's induced broken release.
   *
   * The same server, listening on the same port, answering `/healthz` with 503
   * and naming itself in the body. It belongs in the seed mechanism rather than
   * in a second fixture for the reason every other seed does: what the two
   * rollback gates ask for is not "a broken project" but "the same project,
   * broken *here*", so that a green run and a red one differ in one thing and
   * the difference is the thing under test.
   *
   * Deliberately a 503 rather than a crash or a hang. A container that exits
   * would be caught by docker itself and a hang would be caught by the poll's
   * timeout — both are rollbacks for a reason that is not §12's health check.
   * A process that starts, serves, and answers "not well" is the case where
   * only the health check can tell, which is what §12 says it is for.
   */
  | 'broken_health';

export interface SandboxProject {
  /** The repository root. Also the project's `rootPath`. */
  path: string;
  /** The integration branch (§10). */
  defaultBranch: string;
  /** Where the first commit sits, so a diff has something to compare against. */
  baseSha: string;
  /**
   * Gate commands, in the shape §11 stores per project.
   *
   * The locked three the fixture has always carried, plus one per optional
   * command gate. They are listed here rather than assembled at the call site
   * so that adding an optional gate to §11's catalogue and forgetting to give
   * the fixture a checker is a type error rather than a silently unproven gate.
   */
  commands: {
    test: string;
    lint: string;
    build: string;
    typecheck: string;
    licenses: string;
    'deps-audit': string;
    sast: string;
    a11y: string;
    e2e: string;
    lighthouse: string;
  };
  /**
   * The Bash scopes these commands need (A46.4).
   *
   * Given to a Coder as `extraTools`; a project that used make or cargo would
   * contribute a different list, which is exactly why this is project data and
   * not part of a profile.
   */
  tools: string[];
  /**
   * What §12's `compose` method needs to know about this fixture (A11).
   *
   * Named here rather than reconstructed by the caller for the same reason
   * `commands` is: the compose file, the service and the image repository are
   * written by this function, and a test that spelled them out a second time
   * would be a second declaration of one fact (A81.1).
   */
  deploy: {
    /** Relative to `path`, in the shape `DeployConfig.composeFiles` takes. */
    composeFile: string;
    /** The one service §12 swaps. */
    service: string;
    /**
     * The repository every release of this fixture is tagged under.
     *
     * Unique per fixture, so that a teardown can remove *everything* under it
     * without guessing and two runs on one host cannot prune each other's
     * releases.
     */
    image: string;
    /** The published host port, or null when the fixture publishes none. */
    port: number | null;
    /** What §12's health check polls, or null without a port. */
    healthUrl: string | null;
  };
  /** Remove the directory. Safe to call twice. */
  cleanup(): Promise<void>;
}

const SOURCE = `/**
 * The sandbox's single unit of behaviour.
 *
 * Kept trivial on purpose: what the fixture exercises is the studio around it,
 * not the arithmetic.
 */
export function greet(name) {
  if (typeof name !== 'string' || name.trim() === '') {
    throw new TypeError('name must be a non-empty string');
  }
  return \`Hallo, \${name.trim()}!\`;
}
`;

const TEST = `import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { greet } from './src/greet.js';

test('greets a name', () => {
  assert.equal(greet('the operator'), 'Hallo, the operator!');
});

test('refuses an empty name', () => {
  assert.throws(() => greet('  '), TypeError);
});
`;

/**
 * A lint the fixture owns.
 *
 * Three lines of node rather than a dependency: the point is a check that can
 * be made to fail on demand and that runs anywhere, not a real linter.
 */
const LINT = `import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const problems = [];
for (const name of await readdir('src')) {
  const text = await readFile(join('src', name), 'utf8');
  text.split('\\n').forEach((line, index) => {
    if (line.length > 100) problems.push(\`src/\${name}:\${index + 1}: line longer than 100 characters\`);
    if (/\\t/.test(line)) problems.push(\`src/\${name}:\${index + 1}: tab indentation\`);
  });
}
if (problems.length > 0) {
  console.error(problems.join('\\n'));
  process.exit(1);
}
console.log('lint clean');
`;

const README = `# Sandkasten

Ein Wegwerf-Projekt für die Prüfungen der Entwicklungskette. Es existiert nur
für die Dauer eines Tests oder einer Demo und wird danach gelöscht.
`;

/**
 * The entry point the smoke suite drives, and the unit tests do not.
 *
 * `greet.test.js` imports `src/greet.js` directly, so this file is the only
 * thing standing between a green test gate and a working program — which is
 * what makes `broken_smoke` a seed the `e2e` gate catches alone.
 */
const ENTRY = `import { greet } from './greet.js';

const [name] = process.argv.slice(2);
if (name === undefined) {
  console.error('Aufruf: node src/index.js <Name>');
  process.exit(2);
}
console.log(greet(name));
`;

/** Markup for the a11y gate, deliberately correct: alt, lang, and a label. */
const INDEX_HTML = `<!doctype html>
<html lang="de">
  <head>
    <meta charset="utf-8" />
    <title>Sandkasten</title>
  </head>
  <body>
    <h1>Sandkasten</h1>
    <form>
      <label for="name">Name</label>
      <input id="name" name="name" type="text" />
    </form>
    <script src="app.js" type="module"></script>
  </body>
</html>
`;

/** A shipped asset, so the performance budget has something to measure. */
const APP_JS = `document.querySelector('form')?.addEventListener('submit', (event) => {
  event.preventDefault();
});
`;

/**
 * What the fixture's container serves, and why it says which release it is.
 *
 * Three constraints, all of them from §22's Phase 5 gates rather than from
 * taste. It must need **no dependencies**, because `npm install` inside an
 * image build would put a network between a gate and its verdict. It must
 * **name its release in every answer**, because the two gates that matter here
 * ask what is *serving* — "the health URL serves the good release again" and
 * "the previous container is still serving" are both questions a status code
 * cannot answer. And the release marker has to arrive by **`COPY`**, not by an
 * environment variable, so that two releases are two different images: docker
 * caches an unchanged build, and three deploys of a byte-identical tree would
 * produce one image under three tags — after which a prune protects all three
 * (they share the serving id) and A11's keep-N could not be demonstrated at all.
 *
 * `.mjs` rather than `.js`: the image has no `package.json`, so node reads a
 * `.js` file as CommonJS and the first `import` is a syntax error.
 */
function serverSource(health: { status: number; word: string }): string {
  return `import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

// Baked in at build time — see the note in sandbox.ts on why this is a file.
const release = readFileSync(new URL('./release.txt', import.meta.url), 'utf8').trim();

createServer((request, response) => {
  const path = (request.url ?? '/').split('?')[0];
  const healthz = path === '/healthz';
  response.writeHead(healthz ? ${health.status} : 404, {
    'content-type': 'text/plain; charset=utf-8',
  });
  response.end((healthz ? '${health.word}' : path) + ' ' + release + '\\n');
}).listen(8080, '0.0.0.0');
`;
}

const SERVER = serverSource({ status: 200, word: 'ok' });

/**
 * The same server, not well (`broken_health`).
 *
 * It still starts, still binds, still names its release — so the only thing
 * that distinguishes it from the healthy one is the status code, which is
 * exactly the signal §12's health check exists to read.
 *
 * Derived through the same factory rather than by a `replace` over the healthy
 * source: a replacement whose pattern stops matching produces two identical
 * files and a seed that is not a seed, which is precisely the shape A55 found
 * in the planted secret. A parameter cannot silently fail to apply.
 */
const BROKEN_SERVER = serverSource({ status: 503, word: 'kaputt' });

const DOCKERFILE = `FROM node:22-alpine
WORKDIR /app
# Only the two files the server needs. A release marker that arrived as an
# environment variable would leave every release sharing one image id.
COPY server.mjs release.txt ./
EXPOSE 8080
CMD ["node", "server.mjs"]
`;

/** Keeps the git objects and any stray build output out of the build context. */
const DOCKERIGNORE = `.git
node_modules
migrate.mjs
`;

/** The service §12 swaps, and the release the image reports before one is set. */
export const SANDBOX_DEPLOY_SERVICE = 'app';
export const DEFAULT_SANDBOX_RELEASE = 'r0';

/**
 * The compose file §12's `compose` method reads (A11).
 *
 * The image reference is what `docker compose config --images` answers and what
 * `ComposeDeployTarget` treats as A24's `current` pointer, so it carries the
 * `:current` tag rather than `:latest` — the same name the target re-points on
 * every swap.
 *
 * **The published port is fixed, not ephemeral, and that is a decision.**
 * `127.0.0.1::8080` would let docker pick a free one and remove every chance of
 * colliding with something else on the host — but the swap is
 * `up -d --force-recreate`, so docker would pick a *different* port on every
 * deploy, while §12's health URL is fixed configuration read once from
 * `deploy_config`. The URL would then stop pointing at the service precisely
 * between the broken release and the rollback, which is the one moment the two
 * rollback gates are about. So the caller picks a free port and the fixture
 * publishes it; the small race between "this port was free" and "docker bound
 * it" is the price, and it surfaces as a loud `port is already allocated`
 * rather than as a wrong verdict.
 */
function composeFile(image: string, port: number | null): string {
  const ports = port === null ? '' : `    ports:\n      - "127.0.0.1:${port}:8080"\n`;
  return (
    `services:\n` +
    `  ${SANDBOX_DEPLOY_SERVICE}:\n` +
    `    image: ${image}:current\n` +
    `    build:\n` +
    `      context: .\n` +
    `      dockerfile: Dockerfile\n` +
    ports
  );
}

/**
 * Two vendored dependencies, so the licence and audit gates have metadata.
 *
 * `text-wrap@1.5.0` is the patched version — `vulnerable_dependency` downgrades
 * it onto the advisory below. `greet-utils@0.1.0` matches an advisory that is
 * *under* the audit threshold, which is what makes the clean tree a real test
 * of the checker: one that reported every match rather than applying the
 * threshold goes red before anything has been seeded.
 */
const VENDOR: Array<[string, Record<string, string>]> = [
  ['greet-utils', { name: 'greet-utils', version: '0.1.0', license: 'MIT' }],
  ['text-wrap', { name: 'text-wrap', version: '1.5.0', license: 'Apache-2.0' }],
];

const ADVISORIES = JSON.stringify(
  [
    {
      id: 'VS-2026-0001',
      name: 'text-wrap',
      versions: ['1.4.0'],
      severity: 'high',
      title: 'Katastrophales Backtracking im Zeilenumbruch (ReDoS)',
    },
    {
      id: 'VS-2026-0002',
      name: 'greet-utils',
      versions: ['0.1.0'],
      severity: 'low',
      title: 'Zeitabhängiger Zeichenkettenvergleich in einer Hilfsfunktion',
    },
  ],
  null,
  2,
);

/** Comfortably above the clean tree (~700 bytes), well below the seeded one. */
const BUDGET = JSON.stringify({ publicMaxBytes: 4096 }, null, 2);

const PACKAGE_JSON = JSON.stringify(
  {
    name: 'vorschicht-sandbox',
    private: true,
    type: 'module',
    version: '0.0.0',
    scripts: {
      test: 'node --test',
      lint: 'node lint.mjs',
      build: 'node --check src/greet.js',
      // The fixture has no type system; a syntax check over the entry point is
      // the honest equivalent and keeps §11's second locked gate from being
      // absent rather than passing. `build` checks the other source file, so
      // the two are not the same command wearing two labels.
      typecheck: 'node --check src/index.js',
      licenses: 'node checks/licenses.mjs',
      audit: 'node checks/deps-audit.mjs',
      sast: 'node checks/sast.mjs',
      a11y: 'node checks/a11y.mjs',
      e2e: 'node checks/e2e.mjs',
      lighthouse: 'node checks/budget.mjs',
    },
  },
  null,
  2,
);

export interface CreateSandboxOptions {
  /** Directory to create the repository in. Must not exist yet. */
  path: string;
  defaultBranch?: string;
  /** Plant exactly one defect of this class before the initial commit. */
  seed?: SandboxSeed;
  /**
   * The host port the compose file publishes, picked by the caller.
   *
   * Absent means the fixture publishes nothing at all — the container still
   * runs and every `DeployTarget` verb still works, there is simply no way to
   * reach it from the host, which is the truth for a fixture nobody polls.
   * The reasoning behind "the caller picks it" is at `composeFile`.
   */
  deployPort?: number;
}

/**
 * Build the fixture and return everything a project record needs.
 *
 * The seeded defect is committed with the rest, so the repository's *starting*
 * state is the broken one. That is the shape the gate tests need: a merge
 * candidate that fails, is fixed, and passes — rather than a clean tree that a
 * test has to break at the right moment.
 */
export async function createSandboxProject(options: CreateSandboxOptions): Promise<SandboxProject> {
  const { path } = options;
  const defaultBranch = options.defaultBranch ?? 'main';
  const port = options.deployPort ?? null;
  // Lowercase by construction: a docker repository name may not carry capitals,
  // and a fixture that produced one would fail at `docker tag` rather than here.
  const image = `vorschicht-sandbox-${randomBytes(5).toString('hex')}`;

  await mkdir(join(path, 'src'), { recursive: true });
  const files: Array<[string, string]> = [
    ['package.json', PACKAGE_JSON],
    ['README.md', README],
    ['lint.mjs', LINT],
    ['src/greet.js', SOURCE],
    ['src/index.js', ENTRY],
    ['greet.test.js', TEST],
    ['.gitignore', 'node_modules/\n'],
    // §12's half. None of the six optional command gates walks the repository
    // root — they read `src/`, `public/`, `vendor/` and `checks/` — so these
    // five files are inert for every gate the fixture already demonstrates.
    ['server.mjs', SERVER],
    ['release.txt', `${DEFAULT_SANDBOX_RELEASE}\n`],
    ['Dockerfile', DOCKERFILE],
    ['.dockerignore', DOCKERIGNORE],
    ['docker-compose.yml', composeFile(image, port)],
    ['public/index.html', INDEX_HTML],
    ['public/app.js', APP_JS],
    ['checks/licenses.mjs', CHECK_LICENSES],
    ['checks/deps-audit.mjs', CHECK_DEPS_AUDIT],
    ['checks/sast.mjs', CHECK_SAST],
    ['checks/a11y.mjs', CHECK_A11Y],
    ['checks/e2e.mjs', CHECK_E2E],
    ['checks/budget.mjs', CHECK_BUDGET],
    ['checks/advisories.json', `${ADVISORIES}\n`],
    ['checks/budget.json', `${BUDGET}\n`],
    ...VENDOR.map(([name, manifest]): [string, string] => [
      `vendor/${name}/package.json`,
      `${JSON.stringify(manifest, null, 2)}\n`,
    ]),
  ];
  for (const [name, content] of files) {
    await mkdir(dirname(join(path, name)), { recursive: true });
    await writeFile(join(path, name), content, 'utf8');
  }
  if (options.seed) await plantSeed(path, options.seed);

  const git = (...args: string[]) =>
    run('git', args, {
      cwd: path,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: BOT_IDENTITY.name,
        GIT_AUTHOR_EMAIL: BOT_IDENTITY.email,
        GIT_COMMITTER_NAME: BOT_IDENTITY.name,
        GIT_COMMITTER_EMAIL: BOT_IDENTITY.email,
      },
    });

  await git('init', `--initial-branch=${defaultBranch}`, '--quiet');
  await git('add', '--all');
  await git('-c', 'commit.gpgsign=false', 'commit', '--quiet', '--message', 'chore: Grundstein');
  const { stdout } = await git('rev-parse', 'HEAD');

  return {
    path,
    defaultBranch,
    baseSha: stdout.trim(),
    commands: {
      test: 'npm test',
      lint: 'npm run lint',
      build: 'npm run build',
      typecheck: 'npm run typecheck',
      licenses: 'npm run licenses',
      'deps-audit': 'npm run audit',
      sast: 'npm run sast',
      a11y: 'npm run a11y',
      e2e: 'npm run e2e',
      lighthouse: 'npm run lighthouse',
    },
    deploy: {
      composeFile: 'docker-compose.yml',
      service: SANDBOX_DEPLOY_SERVICE,
      image,
      port,
      healthUrl: port === null ? null : `http://127.0.0.1:${port}/healthz`,
    },
    // Deliberately only the three a Coder self-checks with before handing over
    // (§8.1). The six optional gates run in the merge queue, never in a coding
    // session, so granting their scopes would widen a whitelist for nothing —
    // and A46.3's rule is that a tool nobody needs is a tool nobody gets.
    tools: ['Bash(npm test:*)', 'Bash(npm run lint:*)', 'Bash(npm run build:*)'],
    cleanup: async () => {
      await rm(path, { recursive: true, force: true });
    },
  };
}

/**
 * Which seed demonstrates which optional command gate (§11, §22 Phase 3).
 *
 * The pairing is data rather than six hard-coded test bodies, so that the
 * catalogue and the fixture can be compared: `sandbox-gates.test.ts` asserts
 * that the keys here are *exactly* §11's optional command gates. A seventh
 * arriving in the catalogue without a seed therefore fails a test instead of
 * quietly reducing what the Phase 3 exit gate covers — the same posture
 * `assertInternalRunnersComplete` takes for the internal gates.
 */
export const COMMAND_GATE_SEEDS = {
  licenses: 'bad_license',
  'deps-audit': 'vulnerable_dependency',
  sast: 'sast_finding',
  a11y: 'a11y_violation',
  e2e: 'broken_smoke',
  lighthouse: 'oversized_bundle',
} as const satisfies Record<string, SandboxSeed>;

export type CommandGateSeed = (typeof COMMAND_GATE_SEEDS)[keyof typeof COMMAND_GATE_SEEDS];

/**
 * Undo one of the command-gate seeds — the "passes after fix" half of the gate.
 *
 * A fix, not a fresh checkout: §22 asks that the *same* candidate go green once
 * the violation is removed, and rebuilding the fixture would answer a different
 * question (whether a clean tree is clean, which the unseeded case already
 * covers). Only the six command-gate seeds are repairable here; the older ones
 * are repaired by the chain that plants them.
 */
export async function repairSeed(path: string, seed: CommandGateSeed): Promise<void> {
  switch (seed) {
    case 'bad_license':
      await rm(join(path, 'vendor', 'kopierschutz-lib'), { recursive: true, force: true });
      return;
    case 'vulnerable_dependency': {
      const manifest = VENDOR.find(([name]) => name === 'text-wrap')?.[1];
      if (!manifest) throw new Error('Der Sandkasten kennt "text-wrap" nicht mehr');
      await writeFile(
        join(path, 'vendor', 'text-wrap', 'package.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8',
      );
      return;
    }
    case 'sast_finding':
      await rm(join(path, 'src', 'plugin.js'), { force: true });
      return;
    case 'a11y_violation':
      await writeFile(join(path, 'public', 'index.html'), INDEX_HTML, 'utf8');
      return;
    case 'broken_smoke':
      await writeFile(join(path, 'src', 'index.js'), ENTRY, 'utf8');
      return;
    case 'oversized_bundle':
      await rm(join(path, 'public', 'bundle.js'), { force: true });
      return;
  }
}

/**
 * Name the next release, so that what is serving can be asked rather than assumed.
 *
 * Two effects, and both are load-bearing for §22's Phase 5 gates. The container
 * reports this string on every request, so "which release answers" is a question
 * the health URL itself can be asked — which is the only honest way to check a
 * rollback, since a target asked what it swapped agrees with itself in exactly
 * the case where it is wrong (A87.2, one layer up). And it changes the build
 * context, so the next `docker compose build` produces a genuinely different
 * image rather than a cache hit under a second tag — without which A11's keep-N
 * prune has nothing to remove that is not also the release being served.
 */
export async function setSandboxRelease(path: string, name: string): Promise<void> {
  await writeFile(join(path, 'release.txt'), `${name}\n`, 'utf8');
}

/**
 * A credential-shaped string that gitleaks actually flags — derived, not written.
 *
 * Two constraints pull in opposite directions here, and both are load-bearing.
 * It must never appear as a literal in this repository, because `gate:secrets`
 * scans every file git can see and would flag the fixture itself — correctly,
 * and permanently. And it must have real entropy, because gitleaks' GitLab-PAT
 * rule carries an entropy threshold: the previous fixture used
 * `glpat-` + twenty `x` characters, which has the right shape, no entropy, and
 * is therefore **not detected**. That seeded defect was not a defect, and the
 * gate built on it could never have blocked anything — found by pointing the
 * real scanner at it (see the build log).
 *
 * A hash of a fixed phrase satisfies both: high entropy in the output, nothing
 * secret-shaped in the input, and the same value on every run so a failure is
 * reproducible.
 */
export function fakeCredential(): string {
  const digest = createHash('sha256').update('vorschicht-sandbox-fixture').digest('base64url');
  return `glpat-${digest.slice(0, 20)}`;
}

/**
 * One defect, of exactly the named class, written into an existing tree.
 *
 * Exported because the merge queue's seeded-failure suite (§22, Phase 2) needs
 * the defect to arrive *on the candidate branch* rather than in the base
 * commit — a gate that only catches a secret which was already on `main` is not
 * the gate §11 describes, and the base-commit variant would let a diff-scoped
 * scan pass while a tree-scoped one fails, for reasons that have nothing to do
 * with the change under test.
 */
export async function plantSeed(path: string, seed: SandboxSeed): Promise<void> {
  switch (seed) {
    case 'failing_test':
      await writeFile(
        join(path, 'greet.test.js'),
        `${TEST}
test('a claim that does not hold', () => {
  assert.equal(greet('the operator'), 'Servus, the operator!');
});
`,
        'utf8',
      );
      return;
    case 'planted_secret':
      await writeFile(
        join(path, 'src', 'config.js'),
        `export const config = {\n  token: '${fakeCredential()}',\n};\n`,
        'utf8',
      );
      return;
    case 'lint_error':
      await writeFile(
        join(path, 'src', 'wide.js'),
        `export const message = '${'sehr lang '.repeat(12)}';\n`,
        'utf8',
      );
      return;
    case 'out_of_claims':
      await writeFile(join(path, 'UNCLAIMED.md'), '# Nicht reserviert\n', 'utf8');
      return;
    case 'bad_migration':
      await mkdir(join(path, 'migrations'), { recursive: true });
      await writeFile(
        join(path, 'migrations', '0002_greeting.sql'),
        // The running release still selects `salutation`; restoring its code on
        // a rollback does not bring the column back (§12, A24).
        'ALTER TABLE greetings DROP COLUMN salutation;\n',
        'utf8',
      );
      return;
    case 'safe_migration':
      await mkdir(join(path, 'migrations'), { recursive: true });
      await writeFile(
        join(path, 'migrations', '0002_greeting.sql'),
        'ALTER TABLE greetings ADD COLUMN salutation_v2 text;\n-- down: ALTER TABLE greetings DROP COLUMN salutation_v2;\n',
        'utf8',
      );
      return;
    case 'bad_license':
      await mkdir(join(path, 'vendor', 'kopierschutz-lib'), { recursive: true });
      await writeFile(
        join(path, 'vendor', 'kopierschutz-lib', 'package.json'),
        `${JSON.stringify(
          { name: 'kopierschutz-lib', version: '2.0.0', license: 'GPL-3.0' },
          null,
          2,
        )}\n`,
        'utf8',
      );
      return;
    case 'vulnerable_dependency':
      // A downgrade onto the version `checks/advisories.json` lists as `high`.
      // Not a new dependency: the audit gate's question is which *version* is
      // installed, and a fixture that answered it by adding a file would be
      // demonstrating the licence walk a second time.
      await writeFile(
        join(path, 'vendor', 'text-wrap', 'package.json'),
        `${JSON.stringify({ name: 'text-wrap', version: '1.4.0', license: 'Apache-2.0' }, null, 2)}\n`,
        'utf8',
      );
      return;
    case 'sast_finding':
      // Short lines, no tabs, no test importing it, and not the file `build`
      // syntax-checks — so this is red in the SAST gate and nowhere else.
      await writeFile(
        join(path, 'src', 'plugin.js'),
        [
          '// Erweiterungen aus der Konfiguration laden.',
          'export function loadPlugin(source) {',
          '  return eval(source);',
          '}',
          '',
        ].join('\n'),
        'utf8',
      );
      return;
    case 'a11y_violation':
      await writeFile(
        join(path, 'public', 'index.html'),
        INDEX_HTML.replace('<h1>Sandkasten</h1>', '<h1>Sandkasten</h1>\n    <img src="logo.svg">'),
        'utf8',
      );
      return;
    case 'broken_smoke':
      // `greet()` is untouched, so every unit test still passes; the program
      // built on it prints something else. That gap is the e2e gate's subject.
      await writeFile(
        join(path, 'src', 'index.js'),
        ENTRY.replace('console.log(greet(name));', 'console.log(greet(name).toUpperCase());'),
        'utf8',
      );
      return;
    case 'broken_health':
      // Only `server.mjs`. `release.txt` is untouched on purpose, so a broken
      // release can still be told apart from the healthy one it replaced — a
      // rollback that went back to the wrong release and a rollback that never
      // happened look identical from a status code alone.
      await writeFile(join(path, 'server.mjs'), BROKEN_SERVER, 'utf8');
      return;
    case 'oversized_bundle': {
      // Readable filler rather than random bytes: high-entropy padding is what
      // gitleaks' generic rules look for, and a performance seed that also
      // tripped the secrets gate would prove nothing about either (A55).
      const filler = 'const hinweis = "Der Sandkasten liefert zu viel aus";\n';
      await writeFile(join(path, 'public', 'bundle.js'), filler.repeat(160), 'utf8');
      return;
    }
  }
}
