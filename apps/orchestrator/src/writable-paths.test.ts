/**
 * The write check that turns two silent production failures into a refusal.
 *
 * Read `writable-paths.ts` for what those two were. The tests below use a real
 * filesystem and a directory whose mode is actually changed, because a stubbed
 * `writeFile` would test the shape of the code and not the thing that broke.
 */
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { checkWritablePaths, repairAdvice } from './writable-paths.js';

describe('Schreibprüfung der Datenverzeichnisse', () => {
  let scratch: string;

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'vs-writable-'));
  });

  afterAll(async () => {
    // Restore the mode first, or the cleanup cannot remove what it made.
    await chmod(join(scratch, 'transcripts'), 0o755).catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  });

  it('legt fehlende Verzeichnisse an und meldet sie als in Ordnung', async () => {
    const target = join(scratch, 'runs');
    const [check] = await checkWritablePaths([target]);
    expect(check?.ok).toBe(true);
    expect(check?.problem).toBeNull();
  });

  it('erkennt ein vorhandenes, aber nicht beschreibbares Verzeichnis', async () => {
    const target = join(scratch, 'transcripts');
    await mkdir(target, { recursive: true });
    await chmod(target, 0o555);

    const [check] = await checkWritablePaths([target]);
    // The whole point of writing a probe file rather than calling `stat`: this
    // directory exists, is readable, and cannot be written. A `stat` would have
    // called it fine, which is exactly what happened in production.
    expect(check?.ok).toBe(false);
    expect(check?.problem).toMatch(/nicht beschreibbar/);
    // And it says what breaks, not merely that something did.
    expect(check?.problem).toMatch(/§6\.2/);
  });

  it('lässt nichts liegen, wenn die Prüfung durchgeht', async () => {
    const target = join(scratch, 'docs');
    await checkWritablePaths([target]);
    await checkWritablePaths([target]);
    const { readdir } = await import('node:fs/promises');
    expect(await readdir(target)).toEqual([]);
  });

  it('nennt in der Reparaturanleitung den Befehl, der es behebt', async () => {
    const advice = repairAdvice([{ path: '/data/worktrees', ok: false, problem: 'kaputt' }]);
    expect(advice).toContain('chown');
    expect(advice).toContain('10001:10001');
    expect(advice).toContain('OPERATIONS');
  });
});
