/**
 * The gate book — the step immediately in front of an irreversible edit.
 *
 * Two of these tests are the reason the module exists rather than a regex at
 * the call site: a gate id that does not exist must change nothing, and the
 * marker replaced must be the leading checkbox and not a `[x]` quoted inside a
 * gate's own text. Both are the failure that is invisible until the next phase
 * refuses to close.
 *
 * The last describe runs against the **real** `CLAUDE.md`. A parser proven only
 * against a fixture is a parser proven against the fixture's author.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findGate,
  gateCounts,
  parseAssumptions,
  parseGateBook,
  untickGate,
  untickNote,
} from './gate-book.js';

const REPO_ROOT = join(import.meta.dirname, '../../../..');

const SPEC = [
  '### Phase 0 — Foundation',
  '',
  'Steps:',
  '1. Do the thing.',
  '- [ ] this checkbox is not an exit gate and must not get an id',
  '',
  'Exit gates — Phase 0:',
  '- [x] Stack healthy *(verified locally)*',
  '- [~] Public DNS resolves *(deferred-to-target-host)*',
  '- [ ] Docs current',
  '',
  'Some prose that ends the block.',
  '',
  '### Phase 1 — Spine',
  '',
  'Exit gates — Phase 1 (= half done):',
  '- [x] The meter reads `[x]` from the spec and does not confuse it with a marker',
  '',
].join('\n');

describe('parseGateBook', () => {
  const gates = parseGateBook(SPEC);

  it('numbers gates per phase and reads all three states', () => {
    expect(gates.map((gate) => [gate.id, gate.state])).toEqual([
      ['P0.G1', 'green'],
      ['P0.G2', 'deferred'],
      ['P0.G3', 'open'],
      ['P1.G1', 'green'],
    ]);
  });

  it('ignores checkboxes outside an exit-gate block', () => {
    // The point of scoping: an unrelated checkbox in a step list would shift
    // every id after it, and ids are what a `gate_invalid` finding addresses.
    expect(gates.some((gate) => gate.text.includes('not an exit gate'))).toBe(false);
  });

  it('ends a block at the first line that is neither a checkbox nor blank', () => {
    expect(gates.filter((gate) => gate.phase === 0)).toHaveLength(3);
  });

  it('counts states for the report and the reconciliation domain', () => {
    expect(gateCounts(gates)).toEqual({ green: 2, deferred: 1, open: 1 });
  });
});

describe('untickGate', () => {
  it('opens a green gate and records the reason in the file', () => {
    const result = untickGate({
      source: SPEC,
      gateId: 'P0.G1',
      reason: 'Der angeführte Beleg prüft etwas anderes.',
      findingId: 'abcdef01-2345-6789-abcd-ef0123456789',
      date: '2026-08-02',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const line = result.source.split('\n')[7] ?? '';
    expect(line).toMatch(/^- \[ \] Stack healthy/);
    expect(line).toContain('Betriebsprüfung 2026-08-02');
    expect(line).toContain('war grün');
    expect(line).toContain('Fund abcdef01');
    // The original evidence stays: a reopened gate that lost the claim it is
    // being challenged over would make the finding unreadable next to it.
    expect(line).toContain('*(verified locally)*');
    expect(parseGateBook(result.source).find((g) => g.id === 'P0.G1')?.state).toBe('open');
  });

  it('records that a deferred gate was deferred, not green', () => {
    const result = untickGate({
      source: SPEC,
      gateId: 'P0.G2',
      reason: 'Das Skript prüft nicht, was das Gate behauptet.',
      findingId: 'ffffffff-0000-0000-0000-000000000000',
      date: '2026-08-02',
    });
    expect(result.ok && result.source.split('\n')[8]).toContain('war verschoben');
  });

  it('changes nothing when the gate id does not exist', () => {
    const result = untickGate({
      source: SPEC,
      gateId: 'P4.G9',
      reason: 'x',
      findingId: 'f',
      date: '2026-08-02',
    });
    expect(result.ok).toBe(false);
    // The whole reason ids exist. A near-match here would open a gate nobody
    // was talking about, in a file nobody re-reads.
    expect(result.ok === false && result.problem).toContain('P4.G9');
  });

  it('refuses to un-tick a gate that is already open', () => {
    const result = untickGate({
      source: SPEC,
      gateId: 'P0.G3',
      reason: 'x',
      findingId: 'f',
      date: '2026-08-02',
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.problem).toContain('bereits offen');
  });

  it('replaces the leading marker, not a `[x]` quoted in the gate text', () => {
    const result = untickGate({
      source: SPEC,
      gateId: 'P1.G1',
      reason: 'Beleg trägt nicht.',
      findingId: 'aaaa',
      date: '2026-08-02',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const line = result.source.split('\n')[16] ?? '';
    expect(line.startsWith('- [ ] The meter reads `[x]`')).toBe(true);
  });

  it('flattens a multi-line reason so the note stays one line', () => {
    expect(
      untickNote({
        reason: 'erste Zeile\n  zweite Zeile',
        findingId: 'abcd1234',
        date: '2026-08-02',
        previous: 'green',
      }),
    ).toBe(
      '*(Betriebsprüfung 2026-08-02: Haken entfernt — war grün. erste Zeile zweite Zeile [Fund abcd1234])*',
    );
  });
});

describe('against the real CLAUDE.md', () => {
  it('finds every phase and gives every gate a unique id', async () => {
    const source = await readFile(join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
    const gates = parseGateBook(source);

    // §22 defines ten phases, 0 through 9, and each has exit gates.
    expect(new Set(gates.map((gate) => gate.phase))).toEqual(
      new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
    );
    expect(new Set(gates.map((gate) => gate.id)).size).toBe(gates.length);
    expect(gates.length).toBeGreaterThan(50);

    // The audit's own gate, which is what this whole module serves.
    const audit = gates.find((gate) => gate.phase === 2 && gate.text.includes('Betriebsprüfung'));
    expect(audit).toBeDefined();
    expect(findGate(gates, audit?.id ?? '')).toBe(audit);
  });

  it('finds Appendix A and reads its ids in order', async () => {
    const source = await readFile(join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
    const assumptions = parseAssumptions(source);
    expect(assumptions.length).toBeGreaterThan(15);
    expect(assumptions[0]?.id).toBe('A1');
    expect(new Set(assumptions.map((entry) => entry.id)).size).toBe(assumptions.length);
    // A headline is a recognisable fragment, not the whole item.
    for (const entry of assumptions) expect(entry.headline.length).toBeLessThanOrEqual(200);
  });
});
