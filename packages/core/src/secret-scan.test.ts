/**
 * The measured gitleaks table, asserted directly (§11.4, A25).
 *
 * `secret-scan-contract.itest.ts` proves both implementations against the real
 * tool; this proves the rule they share, without one. The distinction is worth
 * two files because the rule is the part that was *wrong* before: exit 1 was
 * read as "leak found", and a config gitleaks cannot load also exits 1 with an
 * empty report. Both block a merge, so nothing shipped — but §11 separates a
 * finding from an infra failure precisely so that "the tree is dirty" and "the
 * tree was never examined" produce different responses, and only one of those
 * two is a statement about the code under test.
 *
 * Every case below is a row measured against 8.30.1 on 2026-08-09, captured
 * without a pipe in between (the first attempt read `head`'s exit status
 * instead of gitleaks', which turned "exit 1" into "exit 0" and would have
 * produced a scanner that reads a fatal config error as a clean tree).
 */
import { describe, expect, it } from 'vitest';
import {
  classifyGitleaksRun,
  gitleaksArgv,
  normaliseGitleaksVersion,
  parseGitleaksReport,
} from './secret-scan.js';

/** One entry in gitleaks' JSON report, as 8.30.1 writes it. */
function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    RuleID: 'anthropic-oauth-token',
    Description: 'Claude Code subscription OAuth token',
    StartLine: 3,
    File: '/scan/src/config.ts',
    Match: 'REDACTED',
    Secret: 'REDACTED',
    ...overrides,
  };
}

function classify(code: number | null, stdout: string, stderr = '') {
  return classifyGitleaksRun({ code, stdout, stderr, scanRoot: '/scan', tool: 'Prüffall' });
}

describe('parseGitleaksReport — ein Bericht, oder keiner', () => {
  it('unterscheidet „nichts gefunden" von „kein Bericht"', () => {
    // The load-bearing distinction of the whole module. An empty array is an
    // answer; an empty string is the absence of one, and reading the second as
    // the first is how a fatal error becomes a green gate.
    expect(parseGitleaksReport('[]', '/scan')).toEqual([]);
    expect(parseGitleaksReport('', '/scan')).toBeNull();
    expect(parseGitleaksReport('   \n ', '/scan')).toBeNull();
  });

  it('behandelt kaputtes JSON und Nicht-Arrays als „kein Bericht"', () => {
    expect(parseGitleaksReport('{ kaputt', '/scan')).toBeNull();
    expect(parseGitleaksReport('{"RuleID":"x"}', '/scan')).toBeNull();
  });

  it('macht den Pfad relativ zum gescannten Baum', () => {
    // gitleaks reports the path it was handed plus the entry beneath it, so the
    // same leak reads `/scan/src/config.ts` in a container and
    // `/tmp/…/src/config.ts` for the binary. Both implementations have to
    // answer alike or one finding means two things.
    const [finding] = parseGitleaksReport(JSON.stringify([entry()]), '/scan') ?? [];
    expect(finding).toEqual({ rule: 'anthropic-oauth-token', file: 'src/config.ts', line: 3 });
  });

  it('lässt einen Pfad außerhalb des Baums stehen, statt ihn zu verbiegen', () => {
    // `relative()` would answer `../…`, which reads as a path and is not one.
    const [finding] =
      parseGitleaksReport(JSON.stringify([entry({ File: '/woanders/x' })]), '/scan') ?? [];
    expect(finding?.file).toBe('/woanders/x');
  });

  it('überlebt einen Eintrag ohne Regel-Id', () => {
    const [finding] =
      parseGitleaksReport(JSON.stringify([entry({ RuleID: undefined })]), '/scan') ?? [];
    expect(finding?.rule).toBe('unbekannt');
  });
});

describe('classifyGitleaksRun — die gemessene Tabelle (A25)', () => {
  it('sauberer Baum: Exit 0 mit leerem Bericht ist grün', () => {
    const result = classify(0, '[]');
    expect({ verdict: result.verdict, findings: result.findings }).toEqual({
      verdict: 'green',
      findings: [],
    });
  });

  it('Fund: Exit 1 mit Bericht ist ein Befund und trägt Regel und Datei', () => {
    const result = classify(1, JSON.stringify([entry()]));
    expect(result.verdict).toBe('finding');
    expect(result.findings).toEqual([
      { rule: 'anthropic-oauth-token', file: 'src/config.ts', line: 3 },
    ]);
    // The detail is what a human reads in the timeline (§2), so the two facts
    // are in it as well as in the structured field.
    expect(result.output).toContain('src/config.ts:3');
    expect(result.output).toContain('anthropic-oauth-token');
  });

  it('fehlende Konfiguration: Exit 1 **ohne** Bericht ist infra, nicht Befund', () => {
    // Measured. This is the row that was classified wrongly, and the reason
    // exit code alone decides nothing here.
    const result = classify(1, '', 'FTL unable to load gitleaks config, err: open …');
    expect(result.verdict).toBe('infra');
    expect(result.findings).toEqual([]);
    expect(result.detail).toContain('nicht geprüft');
  });

  it('kaputte Konfiguration: dasselbe, und aus demselben Grund', () => {
    const result = classify(1, '', 'FTL unable to load gitleaks config, err: While parsing config');
    expect(result.verdict).toBe('infra');
  });

  it('ein Fund bleibt ein Fund, auch wenn der Exit-Code 0 sagt', () => {
    // `--exit-code 0` would make a real leak exit 0. Reporting findings as
    // green is the one outcome §19 cannot survive, so the report wins over the
    // exit code rather than the other way round.
    expect(classify(0, JSON.stringify([entry()])).verdict).toBe('finding');
  });

  it('jeder andere Exit-Code ohne Fundstellen ist infra', () => {
    expect(classify(125, '[]').verdict).toBe('infra');
    expect(classify(null, '[]').verdict).toBe('infra');
  });
});

describe('gitleaksArgv — beide Implementierungen rufen dasselbe auf', () => {
  it('gibt die Regeldatei ausdrücklich mit', () => {
    // Decision 2: auto-discovery is right for a git tree and silently wrong for
    // a directory that carries no config, where it would fall back to the
    // vendor's default rules and miss every credential class this project
    // handles.
    expect(gitleaksArgv('/scan', '/gitleaks.toml')).toContain('--config');
    expect(gitleaksArgv('/scan', '/gitleaks.toml')).toContain('/gitleaks.toml');
  });

  it('lässt sie weg, wenn es keine gibt, statt einen Pfad zu erfinden', () => {
    expect(gitleaksArgv('/scan', null)).not.toContain('--config');
  });

  it('fordert den Bericht als JSON auf stdout an', () => {
    // The report is the whole basis of the classification above; a run without
    // one would be indistinguishable from a run that could not start.
    const argv = gitleaksArgv('/scan', null);
    expect(argv.join(' ')).toContain('--report-format json');
    expect(argv.join(' ')).toContain('--report-path -');
  });
});

describe('normaliseGitleaksVersion', () => {
  it('erkennt beide Schreibweisen als dieselbe Version', () => {
    expect(normaliseGitleaksVersion('v8.30.1')).toBe(normaliseGitleaksVersion('8.30.1'));
  });
});
