import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * No person's name as an actor in production code (bar v2, point 8).
 *
 * The operator's own acts outside a dashboard session — a manual pause, an
 * answered ntfy card, a waived audit finding — and the WebAuthn user were
 * logged under one person's first name, as a string literal in five places.
 * They now come from `VORSCHICHT_OWNER_ACTOR` (`config.ownerActor`, default
 * `operator`). This test keeps the literal from coming back; fixtures in tests
 * may still use any name they like.
 */

const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));
const ROOTS = ['packages', 'apps'];
const SOURCE = /\.(ts|tsx)$/;
const TEST = /\.(test|itest|spec)\.(ts|tsx)$/;
/** The old literal, quoted in any of the three ways, or inside the WebAuthn handle. */
const LITERAL = /['"`]max['"`]|['"`]vorschicht-max['"`]/;
/** Comment lines: a parameter called `max` in a doc comment is not an actor. */
const COMMENT = /^\s*(\/\/|\/\*|\*)/;

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(path)));
    else if (SOURCE.test(entry.name) && !TEST.test(entry.name)) out.push(path);
  }
  return out;
}

describe('Besitzer-Akteur', () => {
  it('steht nirgends als Personenname im Produktivcode', async () => {
    const hits: string[] = [];
    for (const root of ROOTS) {
      for (const file of await sources(join(repoRoot, root))) {
        const lines = (await readFile(file, 'utf8')).split('\n');
        lines.forEach((line, index) => {
          if (LITERAL.test(line) && !COMMENT.test(line))
            hits.push(`${relative(repoRoot, file)}:${index + 1}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
