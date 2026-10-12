import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Settings `.env.example` documents have to reach the process that reads them.
 *
 * Compose passes an explicit `environment:` list per service, not the whole
 * `.env`. A variable documented in the template but missing from that list is
 * read by nothing — which is how `GIT_AUTHOR_NAME` / `GIT_AUTHOR_EMAIL` sat in
 * `.env.example` for the whole of Phases 0–8 while the bot identity stayed a
 * literal.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** The `environment:` keys of one service in the base compose file. */
async function serviceEnvironment(service: string): Promise<string[]> {
  const text = await readFile(join(repoRoot, 'infra', 'docker-compose.yml'), 'utf8');
  const start = text.indexOf(`\n  ${service}:\n`);
  if (start < 0) throw new Error(`Dienst ${service} fehlt in infra/docker-compose.yml`);
  const rest = text.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  const block = next < 0 ? rest : rest.slice(0, next + 1);
  const env = block.split('\n    environment:\n')[1]?.split(/\n {4}[a-z_]+:/)[0] ?? '';
  return [...env.matchAll(/^ {6}([A-Z][A-Z0-9_]*):/gm)].map((match) => match[1] as string);
}

describe('infra/docker-compose.yml reicht dokumentierte Einstellungen durch', () => {
  it('gibt dem Orchestrator die Bot-Identität als Autor und Committer (A20/A36)', async () => {
    const keys = await serviceEnvironment('orchestrator');
    expect(keys).toEqual(
      expect.arrayContaining([
        'GIT_AUTHOR_NAME',
        'GIT_AUTHOR_EMAIL',
        'GIT_COMMITTER_NAME',
        'GIT_COMMITTER_EMAIL',
      ]),
    );
  });
});
