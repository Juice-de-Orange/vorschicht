/**
 * This repository's own `.gitleaks.toml`, against the real scanner.
 *
 * `.env.example` used to sit in the config's **path** allowlist, and a path
 * entry switches off *every* rule for that file — including the two written
 * specifically for the credentials this project handles. So the one versioned
 * file that exists to show what a secret looks like was the one file no scan
 * ever looked at; the only thing searching it was a grep in `demo-phase0.sh`
 * for a single prefix. Found by the Betriebsprüfung of 2026-08-02
 * (`coverage_gap`, P0.G3), which could not even open the file — the auditor's
 * read-hygiene hook denies `.env*` (§6.6) — and inferred it from the config.
 *
 * The entry turned out to be unnecessary: the regex allowlist already covers
 * every placeholder in the file. This is the guard the auditor asked for, and
 * it is what stops the entry from coming back — re-add the path and the second
 * case goes green with a real token sitting in a versioned file.
 *
 * It lives in `@vorschicht/core` rather than beside `gate-secrets.mjs` because
 * the scanner is here and this must exercise the production path rather than a
 * second copy of the invocation, which could drift from it.
 *
 * **Corrected on 2026-08-16: the production path is `AutoSecretScanner`, not the
 * container one.** This named `GitleaksSecretScanner` — the docker implementation —
 * and called it production, which is true of a developer laptop and false of the
 * deployed studio: the orchestrator image ships no docker client at all (A104),
 * so on the production host this file would have failed exactly as it failed on the first
 * run inside the new gate image. `AutoSecretScanner` picks the pinned binary when
 * one is present and the container otherwise, which is what actually decides
 * this gate in both places — and A104.2 already holds the two to one shared
 * contract suite, so nothing about *which files are examined against which
 * rules* changes here. `onboarding/self.ts` already sets the precedent of this package carrying
 * statements about Vorschicht's own checks (A70.6).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AutoSecretScanner } from './secret-scan.js';

const run = promisify(execFile);
const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const configPath = join(repoRoot, '.gitleaks.toml');
const examplePath = join(repoRoot, '.env.example');

/**
 * A token of the shape the `anthropic-oauth-token` rule matches, derived rather
 * than written — the same bargain `fakeCredential()` makes and for the same two
 * reasons: it must never appear as a literal in this repository, or
 * `gate:secrets` flags this very file, and it must carry real entropy, or a
 * rule with an entropy floor silently ignores it.
 */
function plausibleToken(): string {
  const digest = createHash('sha256').update('vorschicht-gitleaks-config-fixture').digest('hex');
  return `sk-ant-${'oat'}01-${digest.slice(0, 40)}`;
}

let scratch: string;
let dockerAvailable = true;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'vorschicht-gitleaks-config-'));
  // A git repository, because the scanner scans what git can see. Untracked but
  // unignored is enough — `git ls-files -co --exclude-standard`.
  await run('git', ['init', '-q'], { cwd: scratch });
  await copyFile(configPath, join(scratch, '.gitleaks.toml'));
  await copyFile(examplePath, join(scratch, '.env.example'));
  try {
    await run('docker', ['info'], { timeout: 20_000 });
  } catch {
    dockerAvailable = false;
  }
});

afterAll(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe('.gitleaks.toml — die eigene Konfiguration (§11.4, §19)', () => {
  it('nimmt .env.example nicht mehr per Pfad aus', async () => {
    // The mechanism, read directly: a path entry disables every rule for the
    // file, which is why the two cases below can mean anything at all.
    const config = await readFile(configPath, 'utf8');
    const paths = /paths\s*=\s*\[([\s\S]*?)\]/.exec(config)?.[1] ?? '';
    expect(paths).not.toContain('env');
  });

  it.skipIf(!dockerAvailable)('lässt die echte .env.example durch', async () => {
    const result = await new AutoSecretScanner().scan(scratch);
    // Green rather than "no path exemption needed" as an opinion: the
    // placeholders in the committed file are covered by the *regex* allowlist,
    // and if one ever stops being, this says so before a commit does.
    expect({ verdict: result.verdict, output: result.output }).toMatchObject({ verdict: 'green' });
  });

  it.skipIf(!dockerAvailable)('findet ein echt geformtes Token in .env.example', async () => {
    const original = await readFile(join(scratch, '.env.example'), 'utf8');
    await writeFile(
      join(scratch, '.env.example'),
      original.replace(
        /^CLAUDE_CODE_OAUTH_TOKEN=.*$/m,
        `CLAUDE_CODE_OAUTH_TOKEN=${plausibleToken()}`,
      ),
    );
    try {
      const result = await new AutoSecretScanner().scan(scratch);
      expect(result.verdict).toBe('finding');
    } finally {
      await writeFile(join(scratch, '.env.example'), original);
    }
  });
});
