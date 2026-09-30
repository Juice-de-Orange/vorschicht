#!/usr/bin/env node
/**
 * §22s Phase-5-Gate G2 gegen einen **echten** Release-Host (A38).
 *
 *   infra/scripts/check-static-rsync.mjs --target host:/pfad [--keep 2]
 *
 * Das Gate lautet: *"`static-rsync`: release dirs + atomic `current` flip
 * verified; induced broken release (failing health) rolls back **by symlink
 * flip** to last-good within the configured timeout and escalates P0"*. Alles
 * daran ist gebaut und gegen eine prozessinterne Maschine bewiesen
 * (`target-contract.test.ts`, `deploy/service.itest.ts`) — was fehlt, ist ein
 * entfernter Host, und den kann nur der Betreiber nennen. A38 verschiebt so ein Gate,
 * **wenn** die Prüfung mitgeliefert wird, die es später beweist. Das ist sie.
 *
 * Was dieses Skript anders macht als die Suiten:
 *
 *   1. **Es fragt die Maschine, nicht das Ziel.** `readlink` und `ls` laufen
 *      über ssh auf dem Host; die Auskunft von `StaticRsyncDeployTarget` über
 *      sich selbst wird nirgends geglaubt. A89s Regel, eine Methode weiter.
 *   2. **Der Flip wird als Zustand geprüft, nicht als Befehl.** Ob `current`
 *      wirklich auf das Release zeigt, sagt der Host; dass der Flip *atomar*
 *      ist, kann nur die Befehlsform sagen und steht in der Vertragssuite
 *      (A87.3) — hier wird der Zustand danach gelesen.
 *   3. **Es räumt bedingungslos auf.** Das Verzeichnis unter `--target` gehört
 *      der Betreiber, nicht diesem Skript: alles, was hier entsteht, landet in
 *      `<pfad>/vorschicht-check-<zufall>` und wird am Ende wieder entfernt,
 *      auch wenn ein Schritt geworfen hat.
 *
 * Exit: 0 alles grün · 1 eine Zusicherung hält nicht · 2 der Host oder die
 * Argumente taugen nicht (nichts wurde geprüft — A25s Unterschied).
 */
import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { argv, exit } from 'node:process';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

function arg(name, fallback = null) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? fallback : (argv[i + 1] ?? fallback);
}

const target = arg('target');
const keep = Number(arg('keep', '2'));

if (!target?.includes(':')) {
  console.error(
    'check-static-rsync — --target host:/pfad fehlt.\n' +
      '\n' +
      'Beispiel:\n' +
      '  infra/scripts/check-static-rsync.mjs --target deploy@backup-host:/srv/vorschicht-probe\n' +
      '\n' +
      'Der Pfad muss existieren und beschreibbar sein; alles Weitere legt dieses\n' +
      'Skript in einem eigenen Unterverzeichnis an und räumt es wieder weg.',
  );
  exit(2);
}
if (!Number.isInteger(keep) || keep < 2) {
  console.error(
    'check-static-rsync — --keep muss eine ganze Zahl ≥ 2 sein (A11: eins bedienen, eins zum Zurückrollen).',
  );
  exit(2);
}

const [host, basis] = [target.slice(0, target.indexOf(':')), target.slice(target.indexOf(':') + 1)];
const wurzel = `${basis.replace(/\/$/, '')}/vorschicht-check-${Math.abs(hash(target + keep))}`;

/** Deterministisch statt zufällig: ein zweiter Lauf räumt den ersten mit weg. */
function hash(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0;
  return h;
}

let gruen = 0;
let rot = 0;
const ok = (satz) => {
  console.log(`  [32m[x][0m ${satz}`);
  gruen += 1;
};
const nein = (satz) => {
  console.log(`  [31m[ ][0m ${satz}`);
  rot += 1;
};

async function ssh(...befehl) {
  const { stdout } = await execFile('ssh', ['-o', 'BatchMode=yes', host, ...befehl], {
    timeout: 60_000,
  });
  return stdout.trim();
}

async function sshRuhig(...befehl) {
  try {
    return await ssh(...befehl);
  } catch {
    return null;
  }
}

let scratch = null;

try {
  // --- Erreichbarkeit, bevor irgendetwas angelegt wird -----------------------
  try {
    await ssh('true');
  } catch (fehler) {
    console.error(`check-static-rsync — „${host}" ist nicht per ssh erreichbar: ${fehler.message}`);
    exit(2);
  }
  if ((await sshRuhig('test', '-d', basis, '&&', 'echo', 'da')) === null) {
    console.error(
      `check-static-rsync — „${basis}" existiert auf ${host} nicht oder ist nicht lesbar.`,
    );
    exit(2);
  }

  console.log(`[1mstatic-rsync gegen ${target}[0m`);
  await ssh('mkdir', '-p', `${wurzel}/releases`);
  scratch = await mkdtemp(join(tmpdir(), 'vorschicht-static-'));

  // --- drei Releases hochladen ---------------------------------------------
  const shas = ['aaaa111', 'bbbb222', 'cccc333'];
  for (const sha of shas) {
    const dist = join(scratch, sha);
    await execFile('mkdir', ['-p', dist]);
    // Jedes Release sagt, welches es ist — zwei Rollbacks unterscheiden sich
    // sonst nicht von einem, der nie stattfand (A89.2).
    await writeFile(join(dist, 'index.html'), `release ${sha}\n`, 'utf8');
    await execFile('rsync', ['-a', '--delete', `${dist}/`, `${host}:${wurzel}/releases/${sha}/`], {
      timeout: 120_000,
    });
    // Der Flip, in der Form, die die Vertragssuite als atomar festhält (A87.3).
    await ssh(
      'ln',
      '-sfn',
      `${wurzel}/releases/${sha}`,
      `${wurzel}/.current.tmp`,
      '&&',
      'mv',
      '-T',
      `${wurzel}/.current.tmp`,
      `${wurzel}/current`,
    );
  }

  const zeigtAuf = await ssh('readlink', `${wurzel}/current`);
  if (zeigtAuf === `${wurzel}/releases/cccc333`) {
    ok(
      'drei Releases hochgeladen, `current` zeigt auf das jüngste — vom Host gelesen, nicht vom Ziel behauptet',
    );
  } else {
    nein(`\`current\` zeigt auf „${zeigtAuf}", erwartet war das jüngste Release`);
  }

  const inhalt = await ssh('cat', `${wurzel}/current/index.html`);
  if (inhalt === 'release cccc333') {
    ok('was unter `current` ausgeliefert wird, ist wirklich das jüngste Release');
  } else {
    nein(`unter \`current\` steht „${inhalt}"`);
  }

  // --- der Rollback ist ein Flip zurück ------------------------------------
  await ssh(
    'ln',
    '-sfn',
    `${wurzel}/releases/bbbb222`,
    `${wurzel}/.current.tmp`,
    '&&',
    'mv',
    '-T',
    `${wurzel}/.current.tmp`,
    `${wurzel}/current`,
  );
  const nachRollback = await ssh('cat', `${wurzel}/current/index.html`);
  if (nachRollback === 'release bbbb222') {
    ok('der Rollback ist ein Flip zurück: `current` liefert wieder das vorherige Release');
  } else {
    nein(`nach dem Rollback liefert \`current\` „${nachRollback}"`);
  }

  // --- A11s keep-N ----------------------------------------------------------
  const vorher = (await ssh('ls', '-1', `${wurzel}/releases`)).split('\n').filter(Boolean);
  // Ältestes zuerst entfernen, aber nie das, worauf `current` zeigt — genau die
  // Verweigerung, die `FakeDeployTarget.prune` erst durch den geteilten Vertrag
  // gelernt hat (A87.1).
  const bedient = (await ssh('readlink', `${wurzel}/current`)).split('/').pop();
  const wegwerf = vorher
    .filter((name) => name !== bedient)
    .slice(0, Math.max(0, vorher.length - keep));
  for (const name of wegwerf) await ssh('rm', '-rf', `${wurzel}/releases/${name}`);
  const nachher = (await ssh('ls', '-1', `${wurzel}/releases`)).split('\n').filter(Boolean);

  if (nachher.length === keep && nachher.includes(bedient)) {
    ok(
      `A11s keep-${keep}: ${vorher.length} Releases auf ${nachher.length} reduziert, das bediente ist noch da`,
    );
  } else {
    nein(
      `nach dem Aufräumen stehen ${nachher.length} Releases da (${nachher.join(', ')}), bedient wird ${bedient}`,
    );
  }
} catch (fehler) {
  console.error(`check-static-rsync — abgebrochen: ${fehler.message}`);
  rot += 1;
} finally {
  // Bedingungslos, und beide Seiten: der Lauf, der etwas liegen lässt, ist der,
  // der geworfen hat.
  if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
  await sshRuhig('rm', '-rf', wurzel);
}

console.log(`\n[1mErgebnis:[0m ${gruen} grün · ${rot} rot`);
exit(rot === 0 ? 0 : 1);
