import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../packages/core/src/config.js';

/**
 * Where the projects live, and who owns that place (#27).
 *
 * The base compose file bind-mounted `infra/.vorschicht-data/projects` when
 * `VORSCHICHT_PROJECTS_ROOT` was unset. Docker creates a missing bind source
 * as root, so the quick start left a directory the orchestrator (uid 10001)
 * could not write and the user could not delete without sudo. The production
 * overlay fell back to `/opt` — the whole of it, read-write, in the container
 * that runs model sessions.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const read = (...parts: string[]) => readFile(join(repoRoot, ...parts), 'utf8');

/** What the `/projects` mount falls back to when `VORSCHICHT_PROJECTS_ROOT` is unset. */
function projectsFallback(compose: string): string | null {
  return (
    /^\s*- \$\{VORSCHICHT_PROJECTS_ROOT:-([^}]+)\}:\/projects:rw\s*$/m.exec(compose)?.[1] ?? null
  );
}

describe('Projektwurzel (#27)', () => {
  it('ist in der Basis-Compose-Datei ohne Einstellung ein benanntes Volume', async () => {
    const compose = await read('infra', 'docker-compose.yml');
    expect(projectsFallback(compose)).toBe('projects');
    // A bare name is a named volume only if it is declared as one.
    expect(compose.split(/^volumes:\s*$/m)[1]).toMatch(/^ {2}projects:\s*$/m);
  });

  it('gehört im Image dem Orchestrator, damit ein neues Volume ihm gehört', async () => {
    const dockerfile = await read('infra', 'docker', 'Dockerfile.orchestrator');
    expect(dockerfile).toMatch(
      /mkdir -p[^\n]*\/projects[\s\S]*?chown[^\n]*10001:10001[^\n]*\/projects/,
    );
  });

  it('fällt im Produktions-Overlay nicht auf /opt zurück', async () => {
    const overlay = await read('infra', 'docker-compose.override.example.yml');
    expect(projectsFallback(overlay)).toBe('/srv/vorschicht-projects');
  });

  it('hat im Code die Pfadvorgabe, unter der Compose den Ordner einhängt', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://u:p@127.0.0.1:5432/db',
      PUBLIC_ORIGIN: 'https://vorschicht.example.com',
      WEBAUTHN_RP_ID: 'vorschicht.example.com',
      SESSION_SECRET: 'x'.repeat(48),
      CLAUDE_CODE_OAUTH_TOKEN: `sk-ant-oat01-${'y'.repeat(40)}`,
      CLAUDE_CLI_VERSION: '2.1.220',
      NTFY_SERVER: 'https://ntfy.example.com',
      NTFY_TOKEN: 'tk_example',
    });
    expect(config.projectsRoot).toBe('/projects');
  });
});
