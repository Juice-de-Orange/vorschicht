/**
 * §6.6's transcript scan — the parts that need no filesystem and no database.
 *
 * The card's wording is pure on purpose (`budget-anomaly.ts`'s arrangement): the
 * one property that must never regress is that a *secret* cannot reach the card,
 * and asserting that against a scan would make it a statement about gitleaks
 * rather than about this module.
 */
import { describe, expect, it } from 'vitest';
import type { SecretScanFinding } from '../secret-scan.js';
import { daysToScan, leakCard, secretClasses, transcriptFindingKey } from './transcript-leak.js';

const finding = (rule: string, file: string, line = 1): SecretScanFinding => ({
  rule,
  file,
  line,
});

describe('daysToScan', () => {
  const dirs = ['2026-08-01', '2026-08-02', '2026-08-09', 'nicht-ein-tag', 'README'];

  it('nimmt ohne Marke alles, älteste zuerst', () => {
    expect(daysToScan(dirs, null)).toEqual(['2026-08-01', '2026-08-02', '2026-08-09']);
  });

  it('ignoriert alles, was kein Tagesverzeichnis ist', () => {
    // The archive's root is not ours alone — a stray file must not become a
    // scan target, and `gitleaks dir` on one would not fail loudly.
    expect(daysToScan(dirs, null)).not.toContain('nicht-ein-tag');
    expect(daysToScan(dirs, null)).not.toContain('README');
  });

  it('schließt den zuletzt geprüften Tag wieder ein, statt ihn zu überspringen', () => {
    // Decision 1: that directory was still growing when it was last read. The
    // mutation that turns `>=` into `>` loses every transcript written after
    // the scan on the day it ran — silently, because nothing else looks.
    expect(daysToScan(dirs, '2026-08-02')).toEqual(['2026-08-02', '2026-08-09']);
  });
});

describe('transcriptFindingKey', () => {
  it('unterscheidet zwei Klassen in derselben Datei', () => {
    expect(transcriptFindingKey(finding('a', 'x.jsonl'))).not.toBe(
      transcriptFindingKey(finding('b', 'x.jsonl')),
    );
  });

  it('unterscheidet dieselbe Klasse in zwei Dateien', () => {
    expect(transcriptFindingKey(finding('a', 'x.jsonl'))).not.toBe(
      transcriptFindingKey(finding('a', 'y.jsonl')),
    );
  });

  it('ist unabhängig von der Zeilennummer', () => {
    // A transcript is appended to, so the same secret moves. Keying on the line
    // would re-report it as new — which is decision 3 defeated by an accident
    // of formatting.
    expect(transcriptFindingKey(finding('a', 'x.jsonl', 7))).toBe(
      transcriptFindingKey(finding('a', 'x.jsonl', 9002)),
    );
  });
});

describe('secretClasses', () => {
  it('entdoppelt und ordnet', () => {
    expect(
      secretClasses([finding('ntfy', 'a'), finding('anthropic', 'b'), finding('ntfy', 'c')]),
    ).toEqual(['anthropic', 'ntfy']);
  });
});

describe('leakCard', () => {
  const findings = [
    finding('anthropic-oauth-token', '2026-08-09/aaa.jsonl', 12),
    finding('ntfy-access-token', '2026-08-09/bbb.jsonl', 3),
  ];

  it('ist P0 (A21) und nennt die Klassen in der Frage', () => {
    const card = leakCard(findings);
    expect(card.urgency).toBe('P0');
    expect(card.question).toContain('anthropic-oauth-token');
    expect(card.question).toContain('ntfy-access-token');
  });

  it('nennt die betroffenen Dateien', () => {
    expect(leakCard(findings).context).toContain('2026-08-09/aaa.jsonl');
  });

  it('erfüllt §15s Format: 2–4 Optionen, genau eine Empfehlung', () => {
    const card = leakCard(findings);
    expect(card.options.length).toBeGreaterThanOrEqual(2);
    expect(card.options.length).toBeLessThanOrEqual(4);
    expect(card.options.filter((o) => o.recommended)).toHaveLength(1);
    for (const option of card.options) {
      expect(option.pros.length).toBeGreaterThan(0);
      expect(option.cons.length).toBeGreaterThan(0);
    }
  });

  it('empfiehlt rotieren, nicht bewerten', () => {
    const card = leakCard(findings);
    expect(card.options.find((o) => o.recommended)?.title).toBe('Rotieren');
  });

  it('kürzt eine lange Dateiliste und sagt, dass sie gekürzt ist', () => {
    // An unbounded list would run into `MAX_ESCALATION_CONTEXT_LENGTH` and the
    // card would be refused by its own schema — A77.10's failure, where §9's
    // second-red card was silently unraisable because nobody clipped it.
    const many = Array.from({ length: 12 }, (_, i) =>
      finding('anthropic-oauth-token', `2026-08-09/run-${i}.jsonl`),
    );
    const card = leakCard(many);
    expect(card.context).toContain('weitere');
    // Alphabetisch sortiert liegt run-11 in den ersten fünf; run-9 ist der letzte.
    expect(card.context).not.toContain('run-9.jsonl');
  });

  it('bringt das Geheimnis selbst nirgends unter — strukturell, nicht gefiltert', () => {
    // `SecretScanFinding` has no field for the match, so there is nothing to
    // leak here. The assertion pins that: if the type ever grows one and the
    // card starts rendering it, this goes red.
    const rendered = JSON.stringify(leakCard(findings));
    for (const key of Object.keys(findings[0] as object)) {
      expect(['rule', 'file', 'line']).toContain(key);
    }
    expect(rendered).not.toMatch(/secret|match|redact/i);
  });
});
