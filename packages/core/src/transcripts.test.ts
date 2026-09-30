/**
 * Archiving a transcript (§6.2, §18).
 *
 * The interesting half is the failure half: this function runs after the work
 * is already done, so every way it can fail has to end with the run intact and
 * the reason recorded. A thrown exception here would discard a finished
 * session over a missing file.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { archiveTranscript, transcriptArchivePath } from './transcripts.js';

const roots: string[] = [];

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vs-transcripts-'));
  roots.push(dir);
  return dir;
}

afterAll(async () => {
  for (const dir of roots) await rm(dir, { recursive: true, force: true });
});

describe('archiveTranscript (§6.2)', () => {
  it('kopiert das Protokoll und lässt das Original stehen', async () => {
    const dir = await scratch();
    const source = join(dir, 'session.jsonl');
    await writeFile(source, '{"type":"assistant"}\n');

    const result = await archiveTranscript({
      transcriptsRoot: join(dir, 'archive'),
      runId: 'run-1',
      source,
      now: () => Date.parse('2026-08-01T12:00:00Z'),
    });

    expect(result.archived).toBe(true);
    if (!result.archived) return;
    expect(result.path).toBe(join(dir, 'archive', '2026-08-01', 'run-1.jsonl'));
    expect(await readFile(result.path, 'utf8')).toBe('{"type":"assistant"}\n');
    // A copy, not a move: `--resume` reads the original, and §6.4's escalation
    // round-trip continues a parked session days later.
    expect(await readFile(source, 'utf8')).toBe('{"type":"assistant"}\n');
  });

  it('meldet ein Backend ohne Protokoll als Tatsache, nicht als Fehler', async () => {
    const result = await archiveTranscript({
      transcriptsRoot: await scratch(),
      runId: 'run-2',
      source: null,
    });
    expect(result.archived).toBe(false);
    if (result.archived) return;
    expect(result.problem).toMatch(/kein Sitzungsprotokoll/);
  });

  it('wirft nicht, wenn die Quelle fehlt — sie benennt sie', async () => {
    const dir = await scratch();
    const result = await archiveTranscript({
      transcriptsRoot: join(dir, 'archive'),
      runId: 'run-3',
      source: join(dir, 'gibt-es-nicht.jsonl'),
    });
    expect(result.archived).toBe(false);
    if (result.archived) return;
    expect(result.problem).toContain('gibt-es-nicht.jsonl');
  });

  it('legt nach Tag ab, damit die Aufbewahrung aus §18 ein Verzeichnislauf ist', () => {
    const path = transcriptArchivePath('/data/transcripts', 'abc', Date.parse('2027-01-05T23:59Z'));
    expect(path).toBe('/data/transcripts/2027-01-05/abc.jsonl');
  });
});
