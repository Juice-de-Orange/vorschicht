#!/usr/bin/env node
/**
 * Ship a build snapshot to the dashboard.
 *
 *   node infra/scripts/report-build.mjs [--local]
 *
 * The build runs on the build machine, the dashboard on the production host. Everything the
 * build knows about itself lived only on the build machine — which is why the
 * one screen meant to answer "is everything fine" could not see the build at
 * all. This closes that gap.
 *
 * Ships over SSH into the app container rather than connecting to Postgres
 * directly: §3 gives the database no published port, and opening one so a build
 * script could report progress would be a poor trade.
 *
 * **Never fatal.** A build step must not fail because a status update could not
 * be delivered. Every failure here is reported and swallowed.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { argv } from 'node:process';

const REPO = process.env.VORSCHICHT_REPO ?? process.cwd();
const LOCAL = argv.includes('--local');

function git(args) {
  try {
    return execFileSync('git', args, { cwd: REPO, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function read(path) {
  try {
    return readFileSync(`${REPO}/${path}`, 'utf8');
  } catch {
    return '';
  }
}

const state = read('the build log');
const spec = read('CLAUDE.md');

/** The phase line as a human wrote it, stripped of Markdown emphasis. */
function currentPhase() {
  const section = state.split('## Current phase')[1] ?? '';
  const bold = section.match(/\*\*(.+?)\*\*/);
  if (bold?.[1]) return bold[1].trim();
  const firstLine = section.split('\n').find((line) => line.trim().length > 0);
  return firstLine?.trim() ?? 'unbekannt';
}

/** The next step, as one line — the heading plus its first sentence. */
function nextStep() {
  const section = (state.split('## Next step')[1] ?? '').split('\n## ')[0];
  const bold = section.match(/\*\*(.+?)\*\*/);
  if (bold?.[1]) return bold[1].trim();
  const firstLine = section.split('\n').find((line) => line.trim().length > 0);
  return firstLine?.trim().slice(0, 200) ?? null;
}

/** Open questions, as headings. The full text stays in the inbox. */
function questions() {
  const section = (state.split('## WAITING FOR OPERATOR')[1] ?? '').split('\n## ')[0];
  return (
    [...section.matchAll(/^### (?:\d+\.\s*)?(.+)$/gm)]
      .map((match) => match[1].trim())
      // "Erledigt, keine Aktion nötig" and the informational notes are not asks.
      .filter((heading) => !/^(Erledigt|Zur Kenntnis)/i.test(heading))
  );
}

const snapshot = {
  phase: currentPhase(),
  step: nextStep(),
  gatesGreen: (spec.match(/^- \[x\]/gm) ?? []).length,
  gatesDeferred: (spec.match(/^- \[~\]/gm) ?? []).length,
  gatesOpen: (spec.match(/^- \[ \]/gm) ?? []).length,
  commits: Number(git(['rev-list', '--count', 'HEAD'])) || 0,
  headSha: git(['rev-parse', '--short', 'HEAD']) || null,
  headSubject: git(['log', '-1', '--format=%s']) || null,
  loopRunning:
    spawnSync('pgrep', ['-f', 'bash ./vorschicht-build.sh'], { stdio: 'ignore' }).status === 0,
  questions: questions(),
};

const payload = JSON.stringify(snapshot);

if (LOCAL) {
  console.log(payload);
  process.exit(0);
}

const COMPOSE =
  'docker compose -f infra/docker-compose.yml -f infra/docker-compose.override.yml --env-file .env';
const remote = spawnSync(
  'ssh',
  [
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    process.env.VORSCHICHT_HOST ?? '',
    `cd /opt/vorschicht && ${COMPOSE} exec -T app node dist/cli/report-build.js`,
  ],
  { input: payload, encoding: 'utf8', timeout: 60_000 },
);

if (remote.status === 0) {
  console.log(`  Bau gemeldet: ${snapshot.phase} · ${snapshot.gatesGreen} Gates grün`);
} else {
  // Reported, not thrown. A snapshot that did not arrive is worth knowing about
  // and is never worth failing a build step over.
  console.log(
    `  Bau-Meldung nicht zugestellt (${remote.status ?? 'kein Exit'}): ` +
      `${(remote.stderr ?? '').trim().split('\n').slice(-1)[0] ?? 'unbekannt'}`,
  );
}
