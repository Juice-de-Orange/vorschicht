/**
 * The sandbox fixture's own checkers, one per optional command gate (§11).
 *
 * §22's Phase 3 exit gate reads: *"Every optional gate demonstrably blocks a
 * seeded violation in the sandbox project and passes after fix."* Six of §11's
 * optional gates are `kind: 'command'` — licenses, deps-audit, sast, a11y, e2e
 * and lighthouse — and Vorschicht implements none of them. It executes the
 * project's argv and reads the exit code (A50). So the six share one code path
 * in `GateSuite.command`, and six tests that differ only in a gate id would
 * prove that a loop iterates, which is exactly the "reads as covered" class
 * §8.2's sixth domain exists for.
 *
 * What the gate actually asks for is a *violation of that class* turning into a
 * blocked merge. That needs a checker of that class, examining the tree, going
 * red for a reason it can name. Hence this file: six real checkers the fixture
 * owns, each narrow but each genuinely reading the repository.
 *
 * **What this proves, and what it does not.** It does not prove that semgrep,
 * axe or Lighthouse work — those are third-party tools a real project
 * configures, and testing them would be testing them. It proves Vorschicht's
 * half of §11: an enabled optional gate runs the project's checker against the
 * candidate tree, a real violation of that gate's class becomes a blocking
 * finding carrying *that gate's* id, and removing the violation clears it. The
 * distinction is the same one A46.4 already drew — gate commands come from the
 * project, not from a profile.
 *
 * Two properties the tests lean on, and both are the reason the checkers had to
 * be real rather than `process.exit(1)`:
 *
 *  1. **Each seeded violation is caught by its own gate and by no other.** A
 *     seed that also failed `lint` would make its gate's test prove nothing.
 *     `sandbox-gates.test.ts` asserts the whole suite and expects exactly one
 *     red id, which is the assertion that gives the fixture teeth (the same
 *     shape as A63's "the two answers must differ").
 *  2. **Each checker is green on the unseeded tree.** A checker that always
 *     exited 1 would pass the blocking half of the gate and fail the project on
 *     every merge, which is the failure mode A55 found in the planted secret.
 *
 * Written with `String.raw` throughout. These sources contain regular
 * expressions, and `\b`, `\s` and friends are string escapes in an ordinary
 * template literal — `'\b'` is a backspace character, not a word boundary. The
 * existing fixture constants double every backslash by hand; that works and is
 * one missed keystroke from a checker that silently matches nothing. The price
 * is that `String.raw` cannot escape `${` either, so the generated code
 * concatenates strings instead of interpolating them.
 */

/**
 * Licence compliance (§11) — the dependency metadata against an allowlist.
 *
 * A real licence gate is exactly this: a policy list, and a walk over what the
 * project depends on. The narrowness is in the walk (a vendored directory
 * rather than a resolved dependency tree), not in the question.
 */
export const CHECK_LICENSES = String.raw`import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

// The policy. A licence gate is this list plus a walk; the list is the part a
// project owns and the part a reviewer argues about.
const ALLOWED = new Set(['MIT', 'ISC', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause']);

const problems = [];
let checked = 0;
for (const name of (await readdir('vendor')).sort()) {
  const path = join('vendor', name, 'package.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    problems.push(path + ': Manifest nicht lesbar (' + error.message + ')');
    continue;
  }
  checked += 1;
  const license = typeof manifest.license === 'string' ? manifest.license : 'UNBEKANNT';
  if (!ALLOWED.has(license)) {
    problems.push(path + ': Lizenz "' + license + '" steht nicht auf der Positivliste');
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('Lizenzen geprüft: ' + checked + ' Abhängigkeit(en), alle zulässig.');
`;

/**
 * Dependency audit (§11) — the vendored versions against an advisory file.
 *
 * The threshold lives in the checker rather than in Vorschicht, exactly as §11
 * says it does for `npm audit --audit-level=high`: the threshold is part of the
 * project's command. Deliberately, the clean tree contains a dependency that
 * *does* match an advisory below the threshold — so a checker that flagged
 * every match rather than applying the threshold fails on the unseeded tree,
 * and the fixture catches it instead of the fixture being wrong.
 */
export const CHECK_DEPS_AUDIT = String.raw`import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const advisories = JSON.parse(await readFile(join('checks', 'advisories.json'), 'utf8'));
// The threshold §11 talks about, in the command rather than in the orchestrator.
const BLOCKING = new Set(['high', 'critical']);

const problems = [];
const ignored = [];
for (const name of (await readdir('vendor')).sort()) {
  const manifest = JSON.parse(await readFile(join('vendor', name, 'package.json'), 'utf8'));
  for (const advisory of advisories) {
    if (advisory.name !== manifest.name) continue;
    if (!advisory.versions.includes(manifest.version)) continue;
    const line =
      manifest.name + '@' + manifest.version + ': ' + advisory.id +
      ' (' + advisory.severity + ') — ' + advisory.title;
    if (BLOCKING.has(advisory.severity)) problems.push(line);
    else ignored.push(line);
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('Abhängigkeits-Audit: kein Hinweis ab Stufe "high" (' + ignored.length + ' darunter).');
`;

/**
 * Static analysis (§11) — a rule set over the source tree.
 *
 * Three rules rather than semgrep's thousands, and that is the honest scope: a
 * SAST gate is a pattern language plus a walk, and what is being demonstrated
 * is that a finding of that class blocks the merge and names its location.
 */
export const CHECK_SAST = String.raw`import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const RULES = [
  {
    id: 'no-eval',
    pattern: /\beval\s*\(/,
    message: 'eval() führt eine Zeichenkette als Code aus',
  },
  {
    id: 'no-new-function',
    pattern: /\bnew\s+Function\s*\(/,
    message: 'new Function() ist eval unter anderem Namen',
  },
  {
    id: 'no-shell-interpolation',
    pattern: /\bexecSync?\s*\(\s*[a-zA-Z_$][\w$]*\s*\+/,
    message: 'Eine zusammengesetzte Shell-Zeile ist eine Befehlsinjektion in Wartestellung',
  },
];

async function sources(dir) {
  const found = [];
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sources(path)));
    else if (/\.(m|c)?js$/.test(entry.name)) found.push(path);
  }
  return found;
}

const problems = [];
const files = await sources('src');
for (const path of files) {
  const lines = (await readFile(path, 'utf8')).split('\n');
  lines.forEach((line, index) => {
    for (const rule of RULES) {
      if (rule.pattern.test(line)) {
        problems.push(path + ':' + (index + 1) + ': [' + rule.id + '] ' + rule.message);
      }
    }
  });
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('Statische Analyse: ' + files.length + ' Datei(en), kein Fund.');
`;

/**
 * Accessibility (§11) — three of the checks axe would run, over the real markup.
 *
 * Regular expressions rather than a DOM, because the fixture may not depend on
 * a parser; the questions (`lang`, `alt`, a label for every input) are three of
 * the ones axe actually asks, and they are asked of the file on disk.
 */
export const CHECK_A11Y = String.raw`import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const path = join('public', 'index.html');
const html = await readFile(path, 'utf8');
const problems = [];

if (!/<html[^>]*\slang\s*=/i.test(html)) {
  problems.push(path + ': <html> ohne lang-Attribut — Screenreader raten die Sprache');
}

for (const match of html.matchAll(/<img\b[^>]*>/gi)) {
  if (!/\salt\s*=/i.test(match[0])) {
    problems.push(path + ': <img> ohne alt-Attribut — ' + match[0]);
  }
}

const labelled = new Set();
for (const match of html.matchAll(/<label\b[^>]*\sfor\s*=\s*"([^"]+)"/gi)) {
  labelled.add(match[1]);
}
for (const match of html.matchAll(/<input\b[^>]*>/gi)) {
  const id = /\sid\s*=\s*"([^"]+)"/i.exec(match[0]);
  if (!id || !labelled.has(id[1])) {
    problems.push(path + ': <input> ohne zugehöriges <label for> — ' + match[0]);
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('Barrierefreiheit: keine Verstöße in ' + path + '.');
`;

/**
 * The smoke suite (§11) — the program run as a user runs it.
 *
 * The distinction from the `test` gate is the whole point and it is load-bearing
 * for the seed: the unit tests import `src/greet.js` directly, this spawns
 * `src/index.js` as a process and reads what it prints. A seed that broke both
 * would prove nothing about the e2e gate that the test gate had not already
 * proven.
 */
export const CHECK_E2E = String.raw`import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);
const entry = join('src', 'index.js');

async function invoke(args) {
  try {
    const { stdout } = await run(process.execPath, [entry, ...args]);
    return { code: 0, stdout: stdout.trim() };
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : 1,
      stdout: (error.stdout ?? '').trim(),
    };
  }
}

const problems = [];

const happy = await invoke(['the operator']);
if (happy.code !== 0) {
  problems.push(entry + ' the operator: Exit ' + happy.code + ', erwartet 0');
}
if (happy.stdout !== 'Hallo, the operator!') {
  problems.push(entry + ' the operator: Ausgabe "' + happy.stdout + '", erwartet "Hallo, the operator!"');
}

const missing = await invoke([]);
if (missing.code === 0) {
  problems.push(entry + ' ohne Namen: Exit 0, erwartet ein Fehlschlag mit Hinweis');
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exit(1);
}
console.log('Smoke-Suite: 2 Szenarien über den echten Einstiegspunkt, beide erwartungsgemäß.');
`;

/**
 * The performance budget (§11) — bytes shipped against a budget file.
 *
 * Lighthouse's performance-budget feature is byte budgets per resource type, so
 * this is the same question at fixture scale. It reads a budget the project
 * owns and measures the tree, which is the half a gate can decide without a
 * browser.
 */
export const CHECK_BUDGET = String.raw`import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const budget = JSON.parse(await readFile(join('checks', 'budget.json'), 'utf8'));

let total = 0;
const parts = [];
for (const name of (await readdir('public')).sort()) {
  const info = await stat(join('public', name));
  if (!info.isFile()) continue;
  total += info.size;
  parts.push('  public/' + name + ': ' + info.size + ' Byte');
}

if (total > budget.publicMaxBytes) {
  console.error(
    'Performance-Budget überschritten: ' + total + ' Byte ausgeliefert, erlaubt sind ' +
      budget.publicMaxBytes + ' Byte.',
  );
  console.error(parts.join('\n'));
  process.exit(1);
}
console.log(
  'Performance-Budget eingehalten: ' + total + ' von ' + budget.publicMaxBytes + ' Byte.',
);
`;
