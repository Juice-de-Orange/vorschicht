/**
 * The two briefings a finding produces (§11, §2).
 *
 * Everything here is a pure function over a finding, and each assertion is a
 * fact that has to survive a boundary: the German note crosses into a timeline
 * the operator reads, the English briefing crosses into the prompt of a session that has
 * no other way to learn why its task came back. A wording test would be worth
 * nothing; what these pin is that the load-bearing content is *present* and
 * that a truncation says it truncated.
 */
import { describe, expect, it } from 'vitest';
import {
  type BriefableFinding,
  FINDING_OUTPUT_IN_NOTE,
  FINDING_OUTPUT_IN_PROMPT,
  findingsBriefing,
  findingsNote,
} from './findings.js';

const finding = (over: Partial<BriefableFinding> = {}): BriefableFinding => ({
  id: 'a1b2c3d4-5555-6666-7777-888899990000',
  gateId: 'test',
  detail: 'Die Testsuite ist rot: 1 von 4 Prüfungen fehlgeschlagen.',
  output: 'not ok 3 - greets a name\n  AssertionError: expected Servus, got Hallo',
  ...over,
});

describe('findingsNote (§2 — der Zeitstrahl, den der Betreiber liest)', () => {
  it('nennt Gate, Befund-Handle, Begründung und die echte Ausgabe', () => {
    const text = findingsNote([finding()]);
    // The catalogue's German label, not the raw id: the timeline is for a
    // reader, and `test` alone says nothing about which gate that is.
    expect(text).toContain('Tests');
    expect(text).toContain('a1b2c3d4');
    expect(text).toContain('1 von 4 Prüfungen fehlgeschlagen');
    expect(text).toContain('AssertionError');
  });

  it('sagt, dass jeder Befund blockiert — §11 kennt keine Warnstufe', () => {
    expect(findingsNote([finding()])).toContain('jeder Befund ist ein Blocker');
    expect(findingsNote([finding(), finding({ gateId: 'lint' })])).toContain('2 Befunde');
  });

  it('kürzt lange Ausgaben und sagt, dass gekürzt wurde', () => {
    const text = findingsNote([finding({ output: 'x'.repeat(FINDING_OUTPUT_IN_NOTE + 500) })]);
    expect(text).toContain('gekürzt');
    expect(text).toContain('am Gate-Lauf');
    expect(text.length).toBeLessThan(FINDING_OUTPUT_IN_NOTE + 1_500);
  });

  it('behauptet bei leerer Liste nichts', () => {
    expect(findingsNote([])).toBe('Keine Befunde.');
  });
});

describe('findingsBriefing (§2 — der Auftrag der nächsten Sitzung)', () => {
  it('ist auf einem ersten Anlauf gar nicht da', () => {
    // Not "an empty section": a heading with nothing under it reads as "there
    // were findings and they are gone", which is the opposite of the truth.
    expect(findingsBriefing([])).toEqual([]);
  });

  it('trägt Gate, Handle, Begründung und Ausgabe in den Prompt', () => {
    const text = findingsBriefing([finding()]).join('\n');
    expect(text).toContain('`test`');
    expect(text).toContain('a1b2c3d4');
    expect(text).toContain('1 von 4 Prüfungen fehlgeschlagen');
    expect(text).toContain('AssertionError');
  });

  it('verbietet das Abschalten der Prüfung und lässt trotzdem Widerspruch zu', () => {
    // Both halves, because the first one alone produces a coder that fakes a
    // pass rather than arguing — the failure mode this pipeline cannot see.
    const text = findingsBriefing([finding()]).join('\n');
    expect(text).toContain('Do not disable, skip, weaken or work around');
    expect(text).toContain('say so in your result');
  });

  it('sagt, dass es keine Warnstufe gibt', () => {
    expect(findingsBriefing([finding()]).join('\n')).toContain('no warning level');
  });

  it('kürzt lange Ausgaben und sagt es', () => {
    const text = findingsBriefing([
      finding({ output: 'y'.repeat(FINDING_OUTPUT_IN_PROMPT + 5_000) }),
    ]).join('\n');
    expect(text).toContain('gekürzt');
    expect(text.length).toBeLessThan(FINDING_OUTPUT_IN_PROMPT + 2_000);
  });

  it('führt mehrere Befunde einzeln auf, statt sie zusammenzufassen', () => {
    const text = findingsBriefing([
      finding({ gateId: 'test' }),
      finding({
        id: 'ffffffff-0000-0000-0000-000000000000',
        gateId: 'lint',
        detail: 'Zwei Fehler.',
      }),
    ]).join('\n');
    expect(text).toContain('`test`');
    expect(text).toContain('`lint`');
    expect(text).toContain('ffffffff');
  });
});
