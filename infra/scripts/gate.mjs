#!/usr/bin/env node
/**
 * Vorschicht baseline gate runner (§11).
 *
 * Runs the project's own gate suite — the same medicine Vorschicht will later
 * prescribe to onboarded projects. Two deliberate design points:
 *
 *  1. All steps run even after one fails, so a single command shows the full
 *     picture. §11 has no warning mode: any finding blocks, but you should see
 *     every finding at once rather than peeling them off one per run.
 *  2. Steps classify their failure as `finding` or `infra` (A25). Infra
 *     failures (docker down, registry unreachable) are reported separately and
 *     never masquerade as a code problem.
 *
 * The classification needs one distinction that is easy to get wrong, and was:
 * A25's exit-code convention (1 = finding, 2 = infra) is **ours**, and only the
 * scripts in this directory follow it. Third-party tools use their own codes —
 * `tsc` exits 2 on a plain type error, and reading that as "infrastructure"
 * turns a blocker into a retry. Every step therefore declares which convention
 * it speaks, and a tool that does not speak ours has *any* non-zero exit read
 * as a finding. That is the safe direction: a misread infra failure costs a
 * pointless investigation, a misread finding ships.
 *
 * Exit codes: 0 = all green · 1 = at least one finding · 2 = infra failure only.
 */
import { spawn } from 'node:child_process';
import { argv, exit, stdout } from 'node:process';
import { label, verdict } from './gate-verdict.mjs';

/**
 * @typedef {{
 *   id: string,
 *   title: string,
 *   cmd: string[],
 *   optional?: boolean,
 *   classify?: 'a25' | 'any-failure',
 * }} Step
 */

/** @type {Step[]} */
const STEPS = [
  // `classify: 'any-failure'` for every third-party tool: tsc, biome and vitest
  // never promised A25's codes and tsc actively contradicts them.
  // The PWA is the third leg deliberately. `tsc --build` walks the root's
  // project references and `apps/web` is not among them — it cannot be, being
  // `noEmit` and non-composite — while `tsconfig.test.json` matches only test
  // globs and `vite build` transpiles without checking types. So the app's own
  // `typecheck` script existed and nothing called it, and a hard type error in
  // a `.tsx` file passed `pnpm gate` end to end. Verified by planting one.
  {
    id: 'typecheck',
    title: 'Typecheck (tsc --build, Tests, PWA)',
    cmd: ['pnpm', 'run', 'gate:typecheck'],
    classify: 'any-failure',
  },
  {
    id: 'lint',
    title: 'Lint & Format (biome)',
    cmd: ['pnpm', 'run', 'gate:lint'],
    classify: 'any-failure',
  },
  {
    id: 'test',
    title: 'Tests (vitest)',
    cmd: ['pnpm', 'run', 'gate:test'],
    classify: 'any-failure',
  },
  /**
   * The integration tests, against a throwaway Postgres.
   *
   * Separate from `test` because it needs docker and the unit pass must not.
   * It exists at all because the first Betriebsprüfung noticed that it did
   * not: every `*.itest.ts` skips itself without `TEST_DATABASE_URL`, and
   * `pnpm gate` never set it — so a gate that reported "Tests: grün" had
   * silently skipped every proof that touches the database, which is most of
   * what Phases 1 and 2 claim. Recorded there as a `suspicion` (§8.2: blocks
   * nothing, carried forward); closed here because §7.1's estimator rests on
   * exactly such a proof.
   *
   * A25 classification is correct for this one: `with-test-db.sh` exits 2 when
   * docker is unreachable and passes vitest's own code through otherwise, so a
   * machine without docker reports an infra failure rather than a finding.
   */
  {
    id: 'test-integration',
    title: 'Integrationstests (echte Postgres)',
    cmd: ['infra/scripts/with-test-db.sh', 'pnpm', 'exec', 'vitest', 'run', '.itest.ts'],
  },
  { id: 'secrets', title: 'Secrets scan (gitleaks)', cmd: ['pnpm', 'run', 'gate:secrets'] },
  {
    id: 'migrations',
    title: 'Append-only migration lint',
    cmd: ['pnpm', 'run', 'gate:migrations'],
  },
  // After `typecheck`, which is what produces the `dist/` this step imports.
  {
    id: 'contracts',
    title: 'Ergebnisverträge (§6.3)',
    cmd: ['pnpm', 'run', 'gate:contracts'],
  },
  {
    id: 'cli-contract',
    title: 'CLI contract (A32 run caps)',
    cmd: ['pnpm', 'run', 'gate:cli-contract'],
  },
  {
    id: 'build',
    title: 'Build',
    cmd: ['pnpm', 'run', 'gate:build'],
    classify: 'any-failure',
  },
  /*
   * Der zehnte Schritt, nachgetragen am 11.8.2026 (A122).
   *
   * `e2e/**` lief in **keinem** der neun Schritte — nur in den Demo-Skripten.
   * Gefunden von der Betriebsprüfung f785a443 als `coverage_gap`, und die Zahl
   * dahinter ist der Grund: **fünf angehakte Gates ruhen für je eine Hälfte
   * ausschliesslich auf dieser Strecke** (P3.G4s bedienbare Checkboxen, P4.G4s
   * Karte im Browser, P4.G7, P5.G1s „visible in UI", P6.G6s Upload). Bewiesen
   * hat es dieselbe Sitzung, die es beschrieb: eine Regression in
   * `e2e/projekte.spec.ts` wurde committet, während `pnpm gate` neunmal grün
   * meldete, und gefunden hat sie ein fremder Strang.
   *
   * Nach dem Muster, mit dem A61 den `test-integration`-Schritt nachtrug,
   * nachdem 282 Integrationstests sich stillschweigend übersprungen hatten —
   * und mit derselben Klassifikation: **A25**, damit eine Maschine ohne
   * Browser oder ohne Docker einen Infrastrukturfehler meldet statt eines
   * Befunds. Das Wrapper-Skript setzt Exit 2, wo nichts geprüft werden konnte,
   * und reicht Playwrights eigenen Code sonst durch.
   *
   * Kosten, genannt statt entdeckt: rund zwei Minuten je Gate-Lauf und ein
   * `vite build` vorweg. Das ist der Preis dafür, dass fünf Belegzeilen nicht
   * länger auf einer Strecke stehen, die niemand fährt.
   */
  {
    id: 'e2e',
    title: 'Browserstrecke (Playwright)',
    cmd: ['pnpm', 'run', 'gate:e2e'],
  },
  /*
   * Der elfte Schritt (18.8.2026, A138).
   *
   * `infra/leistungsbudget.json` liegt seit dem 12.8. im Repository und wurde
   * von **keinem** Gate-Schritt gelesen: eine Bündel-Regression war für den
   * Gate unsichtbar. `docs/plan-phase7.md:300` hat das benannt, ohne es zu
   * schliessen.
   *
   * **Warum erst jetzt und nicht damals:** das Skript konnte es nicht. Jeder
   * Eintrag in seiner `ungeprueft`-Liste führt zu Exit 2, und
   * `--ohne-lighthouse` legt selbst einen an — der Schritt hätte für immer
   * `infra` gemeldet, auch bei sechs von sechs grünen Positionen. `--nur-artefakt`
   * trennt „konnte nicht geprüft werden" (bleibt Exit 2) von „gehört nicht zum
   * erklärten Umfang" (darf grün sein, **wenn** der Umfang gedruckt wird).
   *
   * Was hier absichtlich **nicht** läuft: Lighthouse, die Installierbarkeitsliste
   * und der Kaltstart. Die ersten beiden brauchen einen vollen Chrome und drei
   * Läufe (~3–4 Min auf einen 6-Minuten-Gate); der Kaltstart misst den
   * **Live-Host** und machte `pnpm gate` abhängig vom Internet, von der
   * Erreichbarkeit des Produktionshosts und davon, dass er *diesen* Baum trägt — seine ehrliche
   * Einordnung wäre auf fast jedem Lauf `infra`, also A122s „ein Schritt, der
   * nie etwas prüft", in einem Container, den der ganze Entwurf hermetisch hält.
   * Beide sind **Release**-Prüfungen und laufen in `demo-phase7.sh` und vor dem
   * Rollout.
   *
   * Klassifikation A25: das Skript spricht die Konvention selbst (0 · 1 · 2).
   * Steht nach `build`, weil es dessen `dist` misst.
   */
  {
    id: 'leistungsbudget',
    title: 'Leistungsbudget (Artefaktzahlen)',
    cmd: ['node', 'infra/scripts/check-leistungsbudget.mjs', '--nur-artefakt'],
  },
  /*
   * Der zwölfte Schritt (18.8.2026, A134) — „Doku aktuell", soweit es mechanisch
   * geht.
   *
   * Vorgeschlagen hat ihn die Betriebsprüfung f785a443 am Ende ihres Berichts,
   * und **drei** Gates sind inzwischen an genau diesem Teilsatz entwertet
   * worden: P5.G8, P6.G8 und am 18.8. P3.G6. Jedes Mal war der Fehler für jeden
   * Test im Repository unsichtbar, weil eine Belegzeile nur ein Mensch oder der
   * Prüfer liest (A76.4).
   *
   * Geprüft werden die zwei Dinge, die Zahl und Form sind: die Bilanzzeile in
   * `README.md` gegen die Auszählung in `CLAUDE.md`, und dass jedes
   * angehakte oder verschobene Gate eine Belegklammer trägt. **Nicht** geprüft
   * wird, ob der Beleg stimmt — das kann kein Skript, und so zu tun als ob wäre
   * die Klasse, gegen die es gebaut ist.
   *
   * **Verdrahtet erst jetzt, und das war der Plan von heute Morgen:** solange
   * die Dokumentwidersprüche absichtlich standen, damit die Prüfung sie findet
   * (§8.2s Methode), hätte dieser Schritt jeden Lauf rot gefärbt — für zwei
   * Dateien, die ein Implementierer nicht schreiben darf. Die Prüfung ist
   * gelaufen, die Funde sind behoben, also darf er scharf werden.
   *
   * Klassifikation A25: das Skript spricht die Konvention selbst (0 · 1 · 2),
   * und „zu wenige Gate-Zeilen gefunden" ist Exit 2 statt eines Befunds.
   */
  {
    id: 'doku',
    title: 'Doku aktuell (Bilanz und Belege)',
    cmd: ['node', 'infra/scripts/gate-doku.mjs'],
  },
];

const args = argv.slice(2);
const only = args.find((a) => a.startsWith('--only='))?.slice('--only='.length);
const failFast = args.includes('--fail-fast');

const selected = only ? STEPS.filter((s) => only.split(',').includes(s.id)) : STEPS;
if (selected.length === 0) {
  console.error(`No gate step matches --only=${only}. Known: ${STEPS.map((s) => s.id).join(', ')}`);
  exit(2);
}

/**
 * @param {Step} step
 * @returns {Promise<{ step: Step, code: number, ms: number }>}
 */
function run(step) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    /** @param {{ code: number, spawned: boolean, reason?: string }} outcome */
    const done = (outcome) => resolve({ step, ms: Date.now() - startedAt, ...outcome });
    let child;
    try {
      child = spawn(step.cmd[0], step.cmd.slice(1), { stdio: 'inherit', shell: false });
    } catch (err) {
      // `spawn` throws synchronously when the target has no executable format
      // (win32, a `.sh`), and then no `error` event ever arrives. Without this
      // catch the whole suite dies on its first unstartable step and reports
      // nothing at all about the eight others.
      done({ code: 2, spawned: false, reason: reasonOf(err) });
      return;
    }
    child.on('close', (code) => done({ code: code ?? 1, spawned: true }));
    // The binary is missing or not executable. Nothing ran, so this is never a
    // finding — the reasoning is in `gate-verdict.mjs`.
    child.on('error', (err) => done({ code: 2, spawned: false, reason: reasonOf(err) }));
  });
}

/**
 * The shortest true thing we can say about why nothing started. `spawn` errors
 * carry a `code` like `ENOENT` or `EFTYPE`, which names the machine problem
 * better than the message does.
 *
 * @param {unknown} err
 */
function reasonOf(err) {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') {
    return err.code;
  }
  return err instanceof Error ? err.message : String(err);
}

const results = [];
for (const step of selected) {
  stdout.write(`\n\x1b[1m▶ ${step.title}\x1b[0m\n`);
  const result = await run(step);
  results.push(result);
  if (failFast && result.code !== 0) break;
}

const findings = results.filter((r) => verdict(r) === 'finding');
const infra = results.filter((r) => verdict(r) === 'infra');

stdout.write('\n\x1b[1m── Gate-Ergebnis ──────────────────────────────\x1b[0m\n');
for (const result of results) {
  const { step, ms } = result;
  const state = verdict(result);
  const mark =
    state === 'green'
      ? '\x1b[32m✓\x1b[0m'
      : state === 'finding'
        ? '\x1b[31m✗\x1b[0m'
        : '\x1b[33m⚠\x1b[0m';
  stdout.write(`  ${mark} ${step.title.padEnd(34)} ${label(result)}  ${(ms / 1000).toFixed(1)}s\n`);
}

if (findings.length === 0 && infra.length === 0) {
  stdout.write('\n\x1b[32mAlle Gates grün.\x1b[0m\n');
  exit(0);
}
if (findings.length > 0) {
  stdout.write(`\n\x1b[31m${findings.length} Gate(s) rot — Findings sind Blocker (§11).\x1b[0m\n`);
  exit(1);
}
stdout.write(
  `\n\x1b[33mNur Infra-Fehler (${infra.length}) — kein Code-Problem, aber ungeprüft (A25).\x1b[0m\n`,
);
exit(2);
