/**
 * §12's release history, as the project page reads and renders it.
 *
 * The page's own module is a `.tsx` and this is a `.ts`, which is why only the
 * pure half lives here — but the pure half is the half that can be wrong
 * quietly. A cast would have made every case below pass over a payload that had
 * never matched the contract (A81), and a rollback row that shows an id instead
 * of a destination is the one row somebody opens this page to read.
 */
import { describe, expect, it } from 'vitest';
import { formatDuration, readReleaseHistory, releaseSummary, shortSha } from './Projekte.js';

const BASE = {
  id: 'd-2',
  sha: '1234567890abcdef1234567890abcdef12345678',
  method: 'compose' as const,
  artifact: 'image:1234567890abcdef1234567890abcdef12345678',
  outcome: 'succeeded' as const,
  lastStep: 'succeeded',
  startedAt: '2026-08-02T10:00:00.000Z',
  finishedAt: '2026-08-02T10:01:00.000Z',
  durationMs: 60_000,
  problem: null,
  rolledBackTo: null,
  taskId: 't-1',
};

describe('readReleaseHistory', () => {
  it('liest eine gültige Historie', () => {
    const history = readReleaseHistory({ releases: [BASE], releaseSource: 'records' });
    expect(history).toEqual({ kind: 'releases', releases: [BASE] });
  });

  it('unterscheidet „noch nichts ausgerollt" von „dieser Server sieht keine Deployments"', () => {
    // The distinction the page exists to make: both render as an empty table,
    // and only one of them says anything about the project.
    expect(readReleaseHistory({ releases: [], releaseSource: 'records' })).toEqual({
      kind: 'releases',
      releases: [],
    });
    expect(readReleaseHistory({ releases: [], releaseSource: 'unwired' })).toEqual({
      kind: 'unwired',
    });
  });

  it('meldet ein Dokument, das nicht zum Vertrag passt, statt es zu rendern', () => {
    // What a cast would have done here is render `undefined` into a cell. The
    // parse turns it into a sentence naming the field.
    const history = readReleaseHistory({
      releases: [{ ...BASE, outcome: 'erfolgreich' }],
      releaseSource: 'records',
    });
    expect(history.kind).toBe('invalid');
    expect(history.kind === 'invalid' && history.problem).toContain('outcome');
  });

  it('behandelt ein Feld, das gar nicht da ist, als leere Historie', () => {
    // An older server that does not send the field at all is not a contract
    // violation — it has nothing to say, and a red error banner would be wrong.
    expect(readReleaseHistory({ releases: undefined })).toEqual({ kind: 'releases', releases: [] });
  });
});

describe('releaseSummary', () => {
  it('nennt bei einem Rollback, wohin zurückgerollt wurde', () => {
    const summary = releaseSummary({
      ...BASE,
      outcome: 'rolled_back',
      rolledBackTo: { deploymentId: 'd-1', sha: 'abcdef1234567890', artifact: 'image:abcdef' },
    });
    expect(summary).toBe('zurückgerollt auf abcdef1234 (image:abcdef)');
  });

  it('sagt es, wenn das Ziel älter ist als das Fenster', () => {
    // An id presented as an answer is worse than "we cannot name it from here".
    const summary = releaseSummary({
      ...BASE,
      outcome: 'rolled_back',
      rolledBackTo: { deploymentId: 'd-0', sha: null, artifact: null },
    });
    expect(summary).toContain('älteres Release');
    expect(summary).toContain('d-0');
  });

  it('nennt bei einem unfertigen Rollout den letzten Schritt', () => {
    // The row that matters after a crash: `outcome` is null and `lastStep` is
    // the only thing that says whether anything was swapped.
    expect(releaseSummary({ ...BASE, outcome: null, lastStep: 'swapped' })).toBe(
      'unfertig (zuletzt: swapped)',
    );
    expect(releaseSummary({ ...BASE, outcome: null, lastStep: null })).toContain(
      'nichts protokolliert',
    );
  });

  it('sagt bei einem Erfolg nur das Ergebnis', () => {
    expect(releaseSummary(BASE)).toBe('ausgerollt');
  });
});

describe('formatDuration', () => {
  it('rundet einen schnellen Rollout nicht auf null', () => {
    expect(formatDuration(400)).toBe('400 ms');
    expect(formatDuration(1_500)).toBe('1,5 s');
    expect(formatDuration(600_000)).toBe('10 min');
  });

  it('unterscheidet „läuft noch" von „hat null gedauert"', () => {
    expect(formatDuration(null)).toBe('läuft noch');
    expect(formatDuration(0)).toBe('0 ms');
  });
});

describe('shortSha', () => {
  it('kürzt, aber erfindet nichts', () => {
    expect(shortSha(BASE.sha)).toBe('1234567890');
    expect(shortSha('abc')).toBe('abc');
  });
});
