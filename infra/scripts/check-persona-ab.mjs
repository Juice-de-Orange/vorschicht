#!/usr/bin/env node
/**
 * §22 Phase 6, exit gate 7 — the paid half.
 *
 * > "Persona A/B check: identical task with personas on (display-only) vs fully
 * > off produces equivalent-quality results (spot comparison documented) —
 * > personas verifiably cost nothing"
 *
 * **Read the gate's pair carefully, because it is settled without spending
 * anything.** "Display-only" and "fully off" differ only in what the *interface*
 * renders; §8 puts flavour in a prompt on neither of them. `renderSystemPrompt`
 * is the single place a prompt can differ, and `profiles.test.ts` asserts that
 * at `personaFlavor: false` the rendered prompt is **byte-identical** to the
 * profile's own, for every profile in the table. Two runs cannot improve on
 * that: they could only show that two identical prompts behaved alike.
 *
 * So this script does two things, in this order, and the first one is free:
 *
 *   1. **Proves the gate's own pair by construction**, in-process, with no model
 *      call: the specs `buildSessionSpec` produces for `aus` and for `anzeige`
 *      are the same bytes. If that ever stops holding, no amount of A/B running
 *      would rescue the claim, and this exits before spending anything.
 *
 *   2. **Runs the pair that _can_ differ** — display-only against flavour-on —
 *      because that is the only configuration in which §8's persona layer
 *      touches a session at all, and therefore the only one where "does this
 *      cost quality" is a real question. Same task, same model, same tools, same
 *      seed of a prompt; the *only* variable is the persona sentence.
 *
 * What this is and is not: a **spot comparison**, which is what the gate asks
 * for. Two runs establish an observation, not a distribution. The task is
 * therefore chosen so that a wrong answer is unmistakable rather than a matter
 * of taste — a small, factual code question with one defensible answer — so that
 * "equivalent quality" is a judgement about something checkable instead of about
 * prose style.
 *
 * Exit codes follow A25's convention, as the other `check-*` scripts do:
 *   0 = ran, and the comparison is recorded
 *   1 = a finding (the byte-equality broke, or a run produced nothing usable)
 *   2 = nothing was checked (no CLI, no credentials) — not a verdict
 *
 * Usage: node infra/scripts/check-persona-ab.mjs [--model haiku|sonnet]
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AGENT_PROFILES, renderSystemPrompt } from '../../packages/core/dist/profiles/profiles.js';

const CLI = process.env.VORSCHICHT_CLAUDE_BIN ?? 'claude';
const MODEL = argValue('--model') ?? 'haiku';

/**
 * The role under test.
 *
 * `qa` rather than a dev-chain role: Quentin's flavour is the most opinionated
 * in the table ("You do not believe a test until you have seen it fail for the
 * right reason"), so if a persona sentence can pull a session off its mandate,
 * this is where it would show. Picking a role with bland flavour would be
 * choosing the case least able to fail.
 */
const PROFILE = AGENT_PROFILES.qa;

/**
 * The task. Small, factual, and with an answer that is checkable rather than
 * a matter of taste — this is the whole reason "equivalent quality" can be
 * judged at all from two runs.
 *
 * It is deliberately the sort of question §8.2 and A61 are about, so a session
 * that drifted into character instead of answering would be visible.
 */
const TASK =
  'Eine Test-Suite ruft `pytest` auf und der Befehl endet mit Exit-Code 0. ' +
  '60 % der Testdateien haben sich per `pytest.skip` selbst übersprungen, weil ' +
  'Docker nicht erreichbar war.\n\n' +
  'Beantworte genau zwei Fragen, je in höchstens drei Sätzen:\n' +
  '1. Darf ein Gate diesen Exit-Code als "Tests grün" werten? Ja oder nein, mit Begründung.\n' +
  '2. Welche eine Messgröße müsste das Gate zusätzlich prüfen?\n\n' +
  'Antworte auf Deutsch. Rufe keine Werkzeuge auf.';

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
}

function bail(code, message) {
  console.error(message);
  process.exit(code);
}

// --- step 1: the gate's own pair, for free ----------------------------------

console.log('§22 Phase 6 G7 — Persona-A/B\n');
console.log('1) Anzeige gegen Aus — ohne Modellaufruf, weil beide denselben Prompt erzeugen');

let abweichungen = 0;
for (const profile of Object.values(AGENT_PROFILES)) {
  // `aus` and `anzeige` both mean `personaFlavor: false`; that is the whole
  // content of "display-only costs nothing".
  const aus = renderSystemPrompt(profile, { personaFlavor: false });
  const anzeige = renderSystemPrompt(profile);
  if (aus !== anzeige || aus !== profile.systemPrompt) {
    console.error(`   ✗ ${profile.id}: Prompt unterscheidet sich zwischen "aus" und "anzeige"`);
    abweichungen += 1;
  }
}
if (abweichungen > 0) {
  bail(1, `\n${abweichungen} Profil(e) mit abweichendem Prompt — A9 ist verletzt.`);
}
console.log(
  `   ✓ ${Object.keys(AGENT_PROFILES).length} Profile, Prompt byte-identisch (${
    renderSystemPrompt(PROFILE).length
  } Zeichen bei "${PROFILE.id}")`,
);

const mitFlavor = renderSystemPrompt(PROFILE, { personaFlavor: true });
const ohneFlavor = renderSystemPrompt(PROFILE);
if (mitFlavor === ohneFlavor || !mitFlavor.endsWith(ohneFlavor)) {
  bail(1, '   ✗ Die Stufe "prompt" ändert den Prompt nicht oder ersetzt den Auftrag (A46).');
}
console.log(
  `   ✓ Stufe "prompt" stellt ${mitFlavor.length - ohneFlavor.length} Zeichen voran und lässt den Auftrag unangetastet\n`,
);

// --- step 2: the pair that can differ ---------------------------------------

if (spawnSync(CLI, ['--version'], { encoding: 'utf8' }).status !== 0) {
  bail(2, `Kein lauffähiges "${CLI}" — nichts geprüft, also keine Feststellung (A25).`);
}
const version = spawnSync(CLI, ['--version'], { encoding: 'utf8' }).stdout.trim();

console.log(`2) Anzeige gegen Prompt — zwei echte Sitzungen, Modell "${MODEL}", CLI ${version}`);
console.log('   Die einzige Variable ist der vorangestellte Persona-Satz.\n');

const scratch = await mkdtemp(join(tmpdir(), 'vorschicht-persona-ab-'));
// No tools, so the only thing a session can do is answer — and a difference in
// the answer cannot be blamed on a different tool path.
const settings = join(scratch, 'settings.json');
await writeFile(settings, JSON.stringify({ hooks: {} }), 'utf8');

/** One session, returning what it said and what it cost. */
function run(label, systemPrompt) {
  const runId = randomUUID();
  const begonnen = Date.now();
  return new Promise((resolve) => {
    const child = spawn(
      CLI,
      [
        '-p',
        TASK,
        '--append-system-prompt',
        systemPrompt,
        '--output-format',
        'json',
        '--setting-sources',
        '',
        '--session-id',
        runId,
        '--settings',
        settings,
        '--allowedTools',
        '',
        '--permission-mode',
        'acceptEdits',
        '--max-turns',
        '4',
        '--model',
        MODEL,
      ],
      { cwd: scratch, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    const out = [];
    const err = [];
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => err.push(c));
    child.on('close', (code) => {
      const raw = Buffer.concat(out).toString('utf8');
      let parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        /* reported below as an unusable run */
      }
      resolve({
        label,
        runId,
        code,
        dauerMs: Date.now() - begonnen,
        text: parsed?.result ?? null,
        kosten: parsed?.total_cost_usd ?? null,
        stderr: Buffer.concat(err).toString('utf8').slice(0, 400),
      });
    });
  });
}

// Sequential, not parallel: two concurrent sessions share one rate-limit window,
// and a run that got throttled would look like a run that answered differently.
const a = await run('anzeige (ohne Persona-Satz)', ohneFlavor);
const b = await run('prompt (mit Persona-Satz)', mitFlavor);

let befunde = 0;
for (const lauf of [a, b]) {
  console.log(`   ── ${lauf.label}`);
  console.log(`      Lauf-Id   ${lauf.runId}`);
  console.log(`      Exit      ${lauf.code}   Dauer ${(lauf.dauerMs / 1000).toFixed(1)} s`);
  // A memory of this project: `total_cost_usd` is a notional equivalent under
  // subscription auth, never money spent (A60.1). Named accordingly.
  console.log(`      Äquivalent ${lauf.kosten === null ? '—' : lauf.kosten.toFixed(4)} USD-Äq.`);
  if (lauf.code !== 0 || !lauf.text) {
    console.error(`      ✗ Kein verwertbares Ergebnis. stderr: ${lauf.stderr}`);
    befunde += 1;
  } else {
    console.log(
      `      Antwort:\n${lauf.text
        .split('\n')
        .map((l) => `        ${l}`)
        .join('\n')}`,
    );
  }
  console.log('');
}

if (befunde > 0) {
  bail(1, `${befunde} von 2 Läufen ohne verwertbares Ergebnis — der Vergleich fand nicht statt.`);
}

console.log('   Beide Läufe haben geantwortet. Die Bewertung ist eine Beobachtung, kein Test:');
console.log('   sie gehört nach docs/personas-ab-vergleich.md und wird dort begründet.');
console.log(`\n   Scratch: ${scratch}`);
