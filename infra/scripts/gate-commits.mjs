#!/usr/bin/env node
/**
 * Conventional-commit lint (§0.6) for commits not yet on origin/main.
 *
 * Kept dependency-free on purpose: the rule is small, and a gate that needs a
 * network install to tell you a commit message is malformed is a gate that will
 * be skipped one tired evening.
 *
 * Exit codes: 0 = clean · 1 = finding · 2 = infra failure.
 */
import { spawnSync } from 'node:child_process';
import { exit } from 'node:process';

const TYPES = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
  'wip', // §7.3: wrap-up commits are `wip:` by design and must stay legal.
];

const PATTERN = new RegExp(`^(${TYPES.join('|')})(\\([a-z0-9./-]+\\))?!?: .{1,}$`);
const MAX_SUBJECT = 100;

function git(args) {
  const res = spawnSync('git', args, { encoding: 'utf8' });
  if (res.status !== 0) return null;
  return res.stdout.trim();
}

if (git(['rev-parse', '--git-dir']) === null) {
  console.error('gate:commits — kein git-Repository.');
  exit(2);
}

const hasUpstream = git(['rev-parse', '--verify', '--quiet', 'origin/main']) !== null;
const range = hasUpstream ? 'origin/main..HEAD' : 'HEAD';
const log = git(['log', '--no-merges', '--format=%H%x1f%s', range]);

if (log === null || log === '') {
  console.log('  ✓ keine neuen Commits zu prüfen');
  exit(0);
}

/** @type {string[]} */
const findings = [];

for (const line of log.split('\n')) {
  const [sha, subject] = line.split('\x1f');
  const short = sha.slice(0, 8);
  if (!PATTERN.test(subject)) {
    findings.push(`${short}  entspricht nicht "type(scope): beschreibung" — "${subject}"`);
  } else if (subject.length > MAX_SUBJECT) {
    findings.push(`${short}  Betreff ${subject.length} Zeichen (max ${MAX_SUBJECT})`);
  }
}

if (findings.length === 0) {
  const n = log.split('\n').length;
  console.log(`  ✓ ${n} Commit(s) konform`);
  exit(0);
}

console.error('\ngate:commits — Conventional-Commit-Verstöße:\n');
for (const f of findings) console.error(`  ✗ ${f}`);
console.error(`\n  Erlaubte Typen: ${TYPES.join(', ')}\n`);
exit(1);
