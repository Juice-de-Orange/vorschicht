#!/usr/bin/env node
/**
 * Prüft §11s gesperrtes Basis-Gate 4 in einem **git-Worktree**, in beide
 * Richtungen (§23: bewiesen durch eine wiederholbare Prüfung, nicht durch einen
 * einmaligen Lauf).
 *
 *   node infra/scripts/check-secrets-history.mjs
 *
 * Warum es das gibt: `gate:secrets` hat in einem Worktree die Historie **gar
 * nicht gelesen** und trotzdem grün gemeldet. In einem Worktree ist `.git` eine
 * *Datei* mit `gitdir: <absoluter Pfad>` nach außen; eingehängt war nur
 * `${REPO}`, also antwortete git im Container `fatal: not a git repository`,
 * gitleaks meldete `0 commits scanned` **und beendete sich mit 0**. Gemessen:
 * 172 Commits auf HEAD, null gelesen, Gate grün — und zwar bei **jedem**
 * Agentenlauf dieses Studios, weil hier jede Zeile Code in einem Worktree
 * entsteht (§10). Das ist A104.4s Klasse (`gitleaks dir` auf einen fehlenden
 * Pfad endet mit 0 und leerer Liste) und A83.6s Regel: „wir konnten nicht
 * nachsehen" und „es ist sauber" sind derselbe Satz nur für ein System, das
 * sich entschieden hat, nicht hinzusehen.
 *
 * Drei Eigenschaften, die diese Prüfung von einem Unit-Test unterscheiden:
 *
 *   1. **Sie fährt einen echten Worktree.** Der Defekt ist eine Eigenschaft der
 *      `.git`-*Datei* und des Container-Mounts; eine Attrappe hätte ihn nicht.
 *   2. **Das Geheimnis ist abgeleitet, nie ein Literal** — sha256 einer festen
 *      Phrase, in der Form, die `.gitleaks.toml` erkennt. A55 hat schon einmal
 *      ein Geheimnis gesät, das gitleaks mangels Entropie gar nicht erkannte;
 *      das Gate darauf bewies nichts. Nichts Geheimnisförmiges steht dafür in
 *      diesem Repository.
 *   3. **Das Geheimnis wird wieder gelöscht, bevor geprüft wird.** Es liegt
 *      dann nur noch in der Historie, also kann der Befund nicht vom
 *      Dateiscan stammen — nur die Historien-Hälfte kann ihn überhaupt sehen.
 *      Ohne diesen Schritt wäre ein grünes Ergebnis hier eine Aussage über den
 *      Dateiscan und keine über das, was repariert wurde.
 *   4. **Der saubere Fall läuft zuerst, und das ist keine Stilfrage.**
 *      `gitleaks git` liest **alle Refs**, nicht nur HEAD — gemessen: ein
 *      Geheimnis auf einem zweiten Zweig wird aus einem Worktree gefunden,
 *      dessen HEAD es nie gesehen hat, weil Refs im Repository geteilt sind.
 *      Die erste Fassung dieser Prüfung fuhr den Leak-Fall zuerst und ließ
 *      seinen Zweig stehen; der „saubere" Lauf danach fand ihn und meldete rot.
 *      Für ein Secrets-Gate ist die Ref-Reichweite eine gute Eigenschaft — für
 *      diese Prüfung heißt sie: erst messen, dann säen, und den gesäten Zweig
 *      sofort wieder entfernen.
 *
 * Bewusst **nicht** in `pnpm gate`: die Prüfung legt Worktrees an, committet und
 * startet mehrere Container, und `pnpm gate` läuft vor jedem Commit. Sie steht
 * neben `check:migration-review` und `check:runner` als Prüfung auf Abruf.
 *
 * Exit: 0 beide Richtungen halten · 1 eine Zusicherung hält nicht (Befund) ·
 * 2 es konnte nichts geprüft werden (A25/A50 — ungeprüft ist keine Feststellung).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exit } from 'node:process';

const REPO = process.cwd();
const GATE = join(REPO, 'infra/scripts/gate-secrets.mjs');

/** @param {string} cmd @param {string[]} args @param {string} [cwd] */
function run(cmd, args, cwd = REPO) {
  return spawnSync(cmd, args, { cwd, encoding: 'utf8' });
}

if (!existsSync(GATE)) {
  console.error(`check:secrets-history — ${GATE} fehlt. Nichts geprüft.`);
  exit(2);
}
if (run('git', ['rev-parse', '--git-dir']).status !== 0) {
  console.error('check:secrets-history — kein git-Repository. Nichts geprüft.');
  exit(2);
}
if (spawnSync('docker', ['info'], { stdio: 'ignore' }).status !== 0) {
  console.error('check:secrets-history — docker nicht erreichbar. Nichts geprüft (A25).');
  exit(2);
}

/**
 * Ein Token in der Form, die `.gitleaks.toml`s Regel `anthropic-oauth-token`
 * erkennt — abgeleitet statt geschrieben, und `oat` zusammengesetzt, damit die
 * erkennbare Zeichenfolge in dieser Datei nirgends vollständig steht.
 */
function derivedToken() {
  const digest = createHash('sha256').update('vorschicht-secrets-history-check').digest('hex');
  return `sk-ant-${'oat'}01-${digest.slice(0, 40)}`;
}

/** Alle angelegten Zweige/Worktrees, damit `finally` sie sicher wieder los wird. */
/** @type {{ path: string; branch: string }[]} */
const angelegt = [];

/**
 * Ein Wegwerf-Worktree auf HEAD.
 * @param {string} name
 * @returns {string | null}
 */
function worktreeAnlegen(name) {
  const dir = mkdtempSync(join(tmpdir(), `vorschicht-${name}-`));
  rmSync(dir, { recursive: true, force: true });
  const branch = `throwaway/secrets-history-${name}-${process.pid}`;
  const add = run('git', ['worktree', 'add', '--quiet', '-b', branch, dir, 'HEAD']);
  if (add.status !== 0) {
    console.error(`  ✗ Worktree ${name} konnte nicht angelegt werden: ${add.stderr?.trim()}`);
    return null;
  }
  angelegt.push({ path: dir, branch });
  return dir;
}

/**
 * Einen Wegwerf-Worktree samt Zweig sofort wieder entfernen.
 *
 * Sofort und nicht erst im `finally`: solange der gesäte Zweig existiert, findet
 * ihn jeder weitere Lauf im selben Repository (Kopf, Punkt 4).
 *
 * @param {string} dir
 */
function aufraeumen(dir) {
  const i = angelegt.findIndex((w) => w.path === dir);
  if (i < 0) return;
  const [{ branch }] = angelegt.splice(i, 1);
  run('git', ['worktree', 'remove', '--force', dir]);
  run('git', ['branch', '-D', branch]);
  rmSync(dir, { recursive: true, force: true });
}

/** @param {string} dir @param {string} message */
function committen(dir, message) {
  const res = run(
    'git',
    [
      '-c',
      'user.name=Vorschicht Bot',
      '-c',
      'user.email=vorschicht-bot@example.com',
      'commit',
      '--quiet',
      '-m',
      message,
    ],
    dir,
  );
  return res.status === 0;
}

/**
 * `gate:secrets` in diesem Verzeichnis, mit seinem Ausgang und seiner Ausgabe.
 * @param {string} dir
 */
function gateLaufen(dir) {
  const res = spawnSync('node', [GATE], { cwd: dir, encoding: 'utf8' });
  return { code: res.status ?? 2, text: `${res.stdout ?? ''}${res.stderr ?? ''}` };
}

let rot = 0;
/** @param {boolean} ok @param {string} satz */
const zusicherung = (ok, satz) => {
  console.log(`  ${ok ? '✓' : '✗'} ${satz}`);
  if (!ok) rot += 1;
};

try {
  // ---- Richtung 1: ein sauberer Worktree bleibt grün, und zwar belegt ------
  //
  // Zuerst, weil `gitleaks git` alle Refs liest (Kopf, Punkt 4): stünde der
  // gesäte Zweig schon, wäre dieser Lauf zu Recht rot und würde nichts über den
  // sauberen Fall sagen.
  console.log('→ sauberer Worktree');
  const sauber = worktreeAnlegen('clean');
  if (sauber === null) exit(2);

  const sauberesErgebnis = gateLaufen(sauber);
  zusicherung(
    sauberesErgebnis.code === 0,
    `gate:secrets bleibt grün (Ausgang ${sauberesErgebnis.code}, erwartet 0)`,
  );

  // Die eigentliche Regression: grün *und* gelesen. Ein Lauf über null Commits
  // wäre vorher genauso grün gewesen, und genau das ist der Defekt.
  const gelesen = /keine in (\d+) Commit\(s\) Historie/.exec(sauberesErgebnis.text);
  zusicherung(
    gelesen !== null && Number(gelesen[1]) > 0,
    `die grüne Zeile nennt gelesene Commits (${gelesen ? gelesen[1] : 'keine Zahl'}), statt über null zu schweigen`,
  );
  zusicherung(
    !/0 commits scanned/.test(sauberesErgebnis.text),
    'gitleaks hat nicht null Commits gescannt',
  );
  aufraeumen(sauber);

  // ---- Richtung 2: ein Geheimnis in der Historie eines Worktree-Zweigs -----
  console.log('→ Geheimnis nur in der Historie eines Worktree-Zweigs');
  const schmutzig = worktreeAnlegen('leak');
  if (schmutzig === null) exit(2);

  zusicherung(
    !existsSync(join(schmutzig, '.git', 'HEAD')),
    '.git ist dort eine Datei, kein Verzeichnis — genau die Lage, in der der Defekt lebte',
  );

  writeFileSync(join(schmutzig, 'geleakt.txt'), `CLAUDE_CODE_OAUTH_TOKEN=${derivedToken()}\n`);
  run('git', ['add', 'geleakt.txt'], schmutzig);
  if (!committen(schmutzig, 'test: abgeleitetes Geheimnis')) {
    console.error('  ✗ konnte nicht committen. Nichts geprüft.');
    exit(2);
  }
  run('git', ['rm', '--quiet', 'geleakt.txt'], schmutzig);
  if (!committen(schmutzig, 'test: wieder entfernt — liegt jetzt nur in der Historie')) {
    console.error('  ✗ konnte nicht committen. Nichts geprüft.');
    exit(2);
  }

  zusicherung(
    !existsSync(join(schmutzig, 'geleakt.txt')),
    'die Datei ist aus dem Arbeitsbaum verschwunden — nur der Historienscan kann sie noch sehen',
  );

  const schmutzigesErgebnis = gateLaufen(schmutzig);
  zusicherung(
    schmutzigesErgebnis.code === 1,
    `gate:secrets meldet einen Befund (Ausgang ${schmutzigesErgebnis.code}, erwartet 1)`,
  );
  // `/leaks found/` wäre hier falsch und war es in der ersten Fassung: gitleaks
  // schreibt im sauberen Fall **`no leaks found`**, was diesen Ausdruck enthält.
  // Die Zusicherung war damit auch dann grün, wenn gar nichts gefunden wurde —
  // dieselbe Klasse, gegen die diese ganze Prüfung geschrieben ist, in ihr
  // selbst. Aufgefallen ist es erst, als die Prüfung gegen die ausgelieferte
  // Fassung lief und diese eine Zeile weiter grün meldete.
  zusicherung(
    /leaks found: [1-9]/.test(schmutzigesErgebnis.text),
    'der Befund kommt von gitleaks und nicht von einem Abbruch davor',
  );
} finally {
  for (const { path } of [...angelegt]) aufraeumen(path);
}

console.log(
  rot === 0
    ? '\n✓ beide Richtungen halten: die Historie eines Worktrees wird wirklich gelesen'
    : `\n✗ ${rot} Zusicherung(en) halten nicht`,
);
exit(rot === 0 ? 0 : 1);
