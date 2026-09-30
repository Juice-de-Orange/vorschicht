/**
 * The transcript reader, against real files.
 *
 * Real files rather than a stubbed filesystem, because every single thing this
 * module claims is a claim *about* the filesystem: that a `.gz` is read, that a
 * path outside the archive is refused before it is opened, that an absence is
 * classified by the run's age rather than guessed at. A stub would let each of
 * those assert whatever the stub was told, which is the opposite of a proof.
 *
 * The five availability answers are the substance. §18/A15 delete a transcript
 * on purpose after a year, and this project's recurring failure mode is exactly
 * the one that would collapse "deleted on purpose", "never written", "should be
 * here and is not" and "cannot be opened" into one empty page.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ESCALATION_TOOL_WIRE_NAME } from '@vorschicht/shared/spuren';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deuten, MAX_LINE_TEXT, readTranscript } from './transcript.js';

let root: string;

/** A day's directory under the archive root, as `transcriptArchivePath` lays it out. */
async function archiviere(runId: string, zeilen: string[], gepackt = false): Promise<string> {
  const tag = join(root, '2026-08-01');
  await mkdir(tag, { recursive: true });
  const pfad = join(tag, `${runId}.jsonl`);
  const inhalt = `${zeilen.join('\n')}\n`;
  if (gepackt) await writeFile(`${pfad}.gz`, gzipSync(Buffer.from(inhalt, 'utf8')));
  else await writeFile(pfad, inhalt, 'utf8');
  return pfad;
}

const JETZT = Date.parse('2026-08-10T12:00:00Z');
const GESTERN = new Date(JETZT - 86_400_000);

function lies(over: Partial<Parameters<typeof readTranscript>[0]>) {
  return readTranscript({
    transcriptsRoot: root,
    archivedPath: null,
    runEndedAt: GESTERN,
    now: () => JETZT,
    ...over,
  });
}

/** One assistant turn calling a tool, in the shape the CLI really writes. */
function werkzeugZeile(name: string, input: unknown): string {
  return JSON.stringify({
    type: 'assistant',
    message: { id: 'msg_1', role: 'assistant', content: [{ type: 'tool_use', name, input }] },
  });
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'vorschicht-transkript-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('readTranscript — die fünf Antworten auf „da ist nichts"', () => {
  it('nennt einen Lauf ohne aufgezeichnetes Protokoll „nie archiviert" und sagt warum', async () => {
    const ergebnis = await lies({
      archivedPath: null,
      problem: 'Das Backend führt kein Sitzungsprotokoll.',
    });

    expect(ergebnis.state).toBe('never_archived');
    // The reason travels: §6.2 records it on the run's `terminated` event
    // precisely so that a later reader finds out why there is none instead of
    // finding nothing at all.
    expect(ergebnis.erklaerung).toContain('Das Backend führt kein Sitzungsprotokoll.');
    expect(ergebnis.lines).toEqual([]);
  });

  it('nennt ein Protokoll jenseits der Aufbewahrungsfrist „abgelaufen"', async () => {
    const ergebnis = await lies({
      archivedPath: join(root, '2025-01-01', 'weg.jsonl'),
      // A15: raw 90 days, gzip a year. 400 days is past both.
      runEndedAt: new Date(JETZT - 400 * 86_400_000),
    });

    expect(ergebnis.state).toBe('expired');
    expect(ergebnis.erklaerung).toContain('abgelaufen');
    // The distinction that matters: this is A15 working, so the sentence has to
    // reassure rather than alarm — and it has to say what survives.
    expect(ergebnis.erklaerung).toContain('Ereignisprotokoll');
  });

  it('nennt dieselbe Abwesenheit innerhalb der Frist „fehlt", nicht „abgelaufen"', async () => {
    const ergebnis = await lies({
      archivedPath: join(root, '2026-08-01', 'nie-geschrieben.jsonl'),
      runEndedAt: new Date(JETZT - 3 * 86_400_000),
    });

    // The whole point of the pair. Same filesystem state, opposite meaning, and
    // only the run's age separates them: one is retention, the other is a hole
    // in the evidence §18 promises.
    expect(ergebnis.state).toBe('missing');
    expect(ergebnis.erklaerung).toContain('Lücke im Nachweis');
    expect(ergebnis.erklaerung).toContain('3 Tage alt');
  });

  it('nennt es „fehlt", wenn der Lauf gar kein Ende aufgezeichnet hat', async () => {
    // No date to measure against, so "expired" would be a guess — and a guess in
    // the direction that explains the absence away.
    const ergebnis = await lies({
      archivedPath: join(root, '2026-08-01', 'ohne-ende.jsonl'),
      runEndedAt: null,
    });

    expect(ergebnis.state).toBe('missing');
    expect(ergebnis.erklaerung).toContain('kein Ende aufgezeichnet');
  });

  it('öffnet einen Pfad außerhalb des Archivs nicht und sagt das', async () => {
    const ergebnis = await lies({ archivedPath: '/etc/passwd' });

    expect(ergebnis.state).toBe('unreadable');
    expect(ergebnis.erklaerung).toContain('außerhalb des Transkript-Archivs');
    expect(ergebnis.lines).toEqual([]);
  });

  it('unterscheidet eine vorhandene leere Datei von einer fehlenden', async () => {
    const tag = join(root, '2026-08-01');
    await mkdir(tag, { recursive: true });
    const pfad = join(tag, 'leer.jsonl');
    await writeFile(pfad, '', 'utf8');

    const ergebnis = await lies({ archivedPath: pfad });

    // `present` with zero lines. An archived file that is genuinely empty is a
    // fact, and it is not the same fact as any of the four above.
    expect(ergebnis.state).toBe('present');
    expect(ergebnis.totalLines).toBe(0);
    expect(ergebnis.erklaerung).toBe('');
  });
});

describe('readTranscript — Inhalt, Seiten und Sprungmarken', () => {
  it('liest ein gepacktes Archiv (§18s zweite Stufe)', async () => {
    const pfad = await archiviere(
      'aaaaaaaa-1111-4111-8111-111111111111',
      [
        JSON.stringify({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'hallo' }] },
        }),
      ],
      true,
    );

    // The archive path recorded in the database names the *raw* file; the sweep
    // renames it. Reading `.gz` off the same recorded path is what keeps the
    // viewer working across A15's second stage instead of reporting `missing`
    // for every transcript older than ninety days.
    const ergebnis = await lies({ archivedPath: pfad });

    expect(ergebnis.state).toBe('present');
    expect(ergebnis.compressed).toBe(true);
    expect(ergebnis.lines[0]?.text).toBe('hallo');
  });

  it('findet die Zeile, auf der die Sitzung eine Entscheidung erbeten hat', async () => {
    const pfad = await archiviere('bbbbbbbb-1111-4111-8111-111111111111', [
      JSON.stringify({ type: 'system', subtype: 'init' }),
      werkzeugZeile('Read', { file: 'a.ts' }),
      werkzeugZeile(ESCALATION_TOOL_WIRE_NAME, { question: 'Welche Option?' }),
    ]);

    const ergebnis = await lies({ archivedPath: pfad, mark: 'decision' });

    // §22's exit gate in one assertion: the timeline says "jump to the decision"
    // and this is what resolves it. Mechanical — a tool name is exact — rather
    // than a search through prose.
    expect(ergebnis.focus).toBe(3);
    expect(ergebnis.focusProblem).toBeNull();
    expect(ergebnis.marks).toContainEqual(expect.objectContaining({ nr: 3, kind: 'decision' }));
    // The other tool call is a mark too, but a different one — otherwise the
    // decision jump would land on whichever tool ran first.
    expect(ergebnis.marks.find((m) => m.nr === 2)?.kind).toBe('tool');
  });

  it('sagt es, wenn ein Sprungziel in diesem Protokoll gar nicht vorkommt', async () => {
    const pfad = await archiviere('cccccccc-1111-4111-8111-111111111111', [
      werkzeugZeile('Read', { file: 'a.ts' }),
    ]);

    const ergebnis = await lies({ archivedPath: pfad, mark: 'decision' });

    // Silently falling back to page 1 would look like the link had worked and
    // the line had nothing in it — the exact confusion this module exists to
    // remove, arriving through the jump instead of through the absence.
    expect(ergebnis.focus).toBeNull();
    expect(ergebnis.focusProblem).toContain('keine Zeile der Art');
    expect(ergebnis.state).toBe('present');
  });

  it('liefert die Seite, auf der die gesuchte Zeile steht — nicht Seite 1', async () => {
    const zeilen = Array.from({ length: 450 }, (_, i) =>
      i === 399
        ? werkzeugZeile(ESCALATION_TOOL_WIRE_NAME, { question: 'tief unten' })
        : JSON.stringify({
            type: 'assistant',
            message: { content: [{ type: 'text', text: `z${i}` }] },
          }),
    );
    const pfad = await archiviere('dddddddd-1111-4111-8111-111111111111', zeilen);

    const ergebnis = await lies({ archivedPath: pfad, mark: 'decision', pageSize: 100 });

    // Line 400 with a page size of 100 is page 4. A reader that answered page 1
    // and merely reported the number would make the deep link a lie that counts
    // as one click.
    expect(ergebnis.focus).toBe(400);
    expect(ergebnis.page).toBe(4);
    expect(ergebnis.pages).toBe(5);
    expect(ergebnis.totalLines).toBe(450);
    expect(ergebnis.lines.map((z) => z.nr)).toEqual(Array.from({ length: 100 }, (_, i) => 301 + i));
  });

  it('klemmt eine Seite jenseits des Endes auf die letzte, statt leer zu antworten', async () => {
    const pfad = await archiviere(
      'eeeeeeee-1111-4111-8111-111111111111',
      Array.from({ length: 10 }, (_, i) => JSON.stringify({ type: 'mode', mode: i })),
    );

    const ergebnis = await lies({ archivedPath: pfad, page: 99, pageSize: 5 });

    expect(ergebnis.page).toBe(2);
    expect(ergebnis.lines).toHaveLength(5);
  });

  it('zählt die abschließende Leerzeile nicht als Datensatz', async () => {
    // Every JSONL file ends with a newline; counting it would make every
    // transcript one line longer than it is and put a phantom row on the page.
    const pfad = await archiviere('ffffffff-1111-4111-8111-111111111111', [
      JSON.stringify({ type: 'mode' }),
      JSON.stringify({ type: 'mode' }),
    ]);

    const ergebnis = await lies({ archivedPath: pfad });

    expect(ergebnis.totalLines).toBe(2);
  });
});

describe('deuten — was eine Zeile ist', () => {
  it('nennt die spezifischste Art einer Zeile, nicht die erste', () => {
    // One assistant turn arrives as one line carrying thinking *and* a tool
    // call. Calling that "Antwort" loses exactly what an auditor is looking for.
    const zeile = deuten(
      1,
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'thinking', thinking: 'hm' },
            { type: 'tool_use', name: 'Grep', input: { pattern: 'x' } },
          ],
        },
      }),
    );

    expect(zeile.kind).toBe('tool_use');
    expect(zeile.titel).toBe('Werkzeug: Grep');
    expect(zeile.marks).toEqual(['tool']);
  });

  it('behält eine Zeile, die gar kein JSON ist, statt sie zu verschlucken', () => {
    const zeile = deuten(7, 'das ist kein json');

    // §18 makes this file the evidence; a viewer that drops rows decides for the
    // auditor what the session consisted of.
    expect(zeile.kind).toBe('unparsed');
    expect(zeile.text).toBe('das ist kein json');
  });

  it('klassifiziert die Buchführungszeilen der CLI, ohne sie zu verlieren', () => {
    // Verified against a real transcript: a session's file carries `mode`,
    // `bridge-session`, `file-history-delta`, `ai-title` … and they outnumber
    // the conversation.
    expect(deuten(1, JSON.stringify({ type: 'mode', mode: 'default' })).kind).toBe('bookkeeping');
    expect(deuten(2, JSON.stringify({ type: 'ai-title' })).kind).toBe('bookkeeping');
    expect(deuten(3, JSON.stringify({ type: 'system', subtype: 'init' })).kind).toBe('system');
  });

  it('markiert ein fehlerhaftes Ergebnis zusätzlich als Fehler', () => {
    const zeile = deuten(1, JSON.stringify({ type: 'result', is_error: true, result: 'kaputt' }));

    expect(zeile.kind).toBe('result');
    expect(zeile.marks).toEqual(['result', 'error']);
  });

  it('kürzt eine sehr lange Zeile und sagt, dass sie gekürzt ist', () => {
    const lang = 'x'.repeat(MAX_LINE_TEXT + 500);
    const zeile = deuten(
      1,
      JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', content: lang }] },
      }),
    );

    // Reported rather than trailing off (A110's rule): a silent cut reads as the
    // tool having returned less than it did.
    expect(zeile.truncated).toBe(true);
    expect(zeile.text.length).toBe(MAX_LINE_TEXT);
  });
});
