/**
 * The Prüfbericht (§8.2).
 *
 * Three properties are checked here because §8.2 states them and none of them
 * survives being left to a prompt: the six sections always exist (an audit that
 * found nothing still has to say what it could not check), the length cap holds
 * against padded data, and the cap never eats a finding.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuditorResult } from '@vorschicht/shared';
import { describe, expect, it } from 'vitest';
import { pruefberichtDateiname, REPORT_MAX_CHARS, renderPruefbericht } from './report.js';

const BASE: AuditorResult = {
  status: 'done',
  summary: 'Vier Gates geprüft, zwei Belege tragen nicht.',
  artifacts: [],
  followups: [],
  domain: 'gate_truth',
  sample: ['P0.G1', 'P1.G4'],
  findings: [],
  scopeLimits: [],
  verdict: 'unbedenklich',
};

function render(result: Partial<AuditorResult>, proposed = ['P0.G1', 'P1.G4']): string {
  return renderPruefbericht({
    auditId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    domainLabel: 'Gate-Wahrheit',
    domain: 'gate_truth',
    scope: 'Phasen 0–2, rückwirkend.',
    trigger: 'phase_close',
    proposedSample: proposed,
    result: { ...BASE, ...result },
    date: '2026-08-02',
  });
}

const SECTIONS = [
  '## 1. Prüfumfang und Stichprobe',
  '## 2. Bestätigte Funde',
  '## 3. Verdachtsmomente',
  '## 4. Nicht prüfbar',
  '## 5. Revidierte Annahmen',
  '## 6. Urteil',
];

describe('renderPruefbericht', () => {
  it('always carries all six sections of §8.2, even for a clean audit', () => {
    const report = render({});
    for (const heading of SECTIONS) expect(report).toContain(heading);
    expect(report).toContain('unbedenklich');
  });

  it('keeps the sections in §8.2s order', () => {
    const report = render({});
    const positions = SECTIONS.map((heading) => report.indexOf(heading));
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('says out loud that an empty scopeLimits is itself a claim', () => {
    expect(render({ scopeLimits: [] })).toContain('den ganzen Umfang geprüft zu haben');
  });

  it('sorts findings into the sections their class belongs to', () => {
    const report = render({
      verdict: 'phase_nicht_abschliessbar',
      findings: [
        {
          class: 'gate_invalid',
          summary: 'Das Gate zitiert einen Test, der nichts prüft.',
          evidence: 'packages/core/src/x.test.ts:12',
          gate: 'P1.G3',
        },
        {
          class: 'suspicion',
          summary: 'Der Timeout wirkt zu kurz.',
          evidence: 'runner.ts:67',
        },
        {
          class: 'assumption_expired',
          summary: 'A35 nennt einen Tunnel, es läuft aber keiner.',
          evidence: 'CLAUDE.md Anhang A',
        },
      ],
      scopeLimits: ['Domäne 5 konnte nicht ausgeführt werden.'],
    });

    const confirmed = report.slice(
      report.indexOf(SECTIONS[1] as string),
      report.indexOf(SECTIONS[2] as string),
    );
    const suspicions = report.slice(
      report.indexOf(SECTIONS[2] as string),
      report.indexOf(SECTIONS[3] as string),
    );
    const assumptions = report.slice(
      report.indexOf(SECTIONS[4] as string),
      report.indexOf(SECTIONS[5] as string),
    );

    expect(confirmed).toContain('P1.G3');
    expect(confirmed).not.toContain('Timeout wirkt zu kurz');
    expect(suspicions).toContain('Timeout wirkt zu kurz');
    expect(assumptions).toContain('A35');
    expect(report).toContain('Domäne 5 konnte nicht ausgeführt werden.');
    expect(report).toContain('phase_nicht_abschliessbar');
  });

  it('carries the task reference and the consequence beside each finding', () => {
    const finding = {
      class: 'defect' as const,
      summary: 'Der Zähler zählt Nachrichten statt Züge.',
      evidence: 'backend/headless.ts:210',
    };
    const report = renderPruefbericht({
      auditId: 'a',
      domainLabel: 'Gate-Wahrheit',
      domain: 'gate_truth',
      scope: 's',
      trigger: 'weekly',
      proposedSample: ['x'],
      result: { ...BASE, sample: ['x'], findings: [finding], verdict: 'funde_zu_beheben' },
      taskRefs: { 'defect:Der Zähler zählt Nachrichten statt Züge.': 'task-42' },
      consequences: {
        'defect:Der Zähler zählt Nachrichten statt Züge.': 'Aufgabe task-42 angelegt.',
      },
      date: '2026-08-02',
    });
    expect(report).toContain('Aufgabe: task-42');
    expect(report).toContain('Folge: Aufgabe task-42 angelegt.');
  });

  it('notes when the reported sample does not cover what was drawn', () => {
    const report = render({ sample: ['P9.G9'] }, ['P0.G1', 'P1.G4']);
    expect(report).toContain('0 von 2 gezogenen Positionen');
    expect(report).toContain('P0.G1');
  });

  it('says nothing about divergence when the sample was fully covered', () => {
    expect(render({ sample: ['P0.G1', 'P1.G4', 'extra'] })).not.toContain('Nicht wiedergefunden');
  });

  it('holds the hard length cap against padded prose', () => {
    const report = render({ summary: 'x'.repeat(40_000) });
    expect(report.length).toBeLessThanOrEqual(REPORT_MAX_CHARS);
    expect(report).toContain('…');
  });

  it('says the prose was cut, rather than that there was none', () => {
    // The first real audit filled the whole cap with findings and the reader
    // was told the report contained no prose — false, and false in the
    // direction that reads as an auditor with nothing to say.
    const findings = Array.from({ length: 40 }, (_, i) => ({
      class: 'defect' as const,
      summary: `Fund ${i}: ${'Beschreibung '.repeat(30)}`,
      evidence: `${'Beleg '.repeat(30)}datei-${i}.ts:${i}`,
    }));
    const report = render({
      summary: 'Es gab durchaus etwas zu sagen.',
      findings,
      verdict: 'funde_zu_beheben',
    });
    expect(report).toContain('Der Fließtext wurde vollständig gekürzt');
    expect(report).not.toContain('enthielt keinen Fließtext');
  });

  it('still says "no prose" when there genuinely was none', () => {
    expect(render({ summary: '   ' })).toContain('enthielt keinen Fließtext');
  });

  it('cuts the prose, never a finding', () => {
    // The worst possible artefact would be a report trimmed to fit that dropped
    // the thing it exists to carry.
    const findings = Array.from({ length: 12 }, (_, i) => ({
      class: 'defect' as const,
      summary: `Fund ${i}: ${'Beschreibung '.repeat(20)}`,
      evidence: `datei-${i}.ts:${i}`,
    }));
    const report = render({ summary: 'y'.repeat(40_000), findings, verdict: 'funde_zu_beheben' });
    for (let i = 0; i < 12; i++) expect(report).toContain(`Fund ${i}:`);
    for (let i = 0; i < 12; i++) expect(report).toContain(`datei-${i}.ts:${i}`);
    expect(report).toContain('## 6. Urteil');
  });

  it('does not truncate a report that fits', () => {
    expect(render({})).toContain('Vier Gates geprüft, zwei Belege tragen nicht.');
  });
});

/**
 * Wo ein Bericht abgelegt wird — und warum das eine Zusicherung verdient.
 *
 * Der Anlass ist kein gedachter: am 2.8.2026 haben zwei Prüfungen derselben
 * Domäne am selben Tag stattgefunden (Phase 3 schloss, Phase 4 schloss), der
 * Name war `<datum>-<domäne>.md`, und die zweite hat die erste **überschrieben**.
 * Nach §8.2 ist die eingecheckte Datei der dauerhafte Teil des Nachweises —
 * die Datenbankzeile überlebt einen Handlauf nicht (A56) —, also ist das kein
 * verlorenes Duplikat, sondern der verlorene einzige Beleg.
 */
describe('pruefberichtDateiname', () => {
  const REPORTS = join(dirname(fileURLToPath(import.meta.url)), '../../../../docs/pruefberichte');
  /** Die erste Zeile eines Berichts, aus der die Id gelesen wird. */
  const BERICHTSKOPF = /^# Prüfbericht ([0-9a-f]{8}) —/;

  it('trennt zwei Prüfungen derselben Domäne am selben Tag', () => {
    // Genau der Fall, der eingetreten ist: gleiches Datum, gleiche Domäne.
    const a = pruefberichtDateiname({
      auditId: '5d60476e-1111-4222-8333-444444444444',
      date: '2026-08-02',
      domain: 'gate_truth',
    });
    const b = pruefberichtDateiname({
      auditId: '67ac096c-1111-4222-8333-444444444444',
      date: '2026-08-02',
      domain: 'gate_truth',
    });
    expect(a).not.toBe(b);
    expect(a).toBe('2026-08-02-5d60476e-gate_truth.md');
    expect(b).toBe('2026-08-02-67ac096c-gate_truth.md');
  });

  it('benutzt dieselbe Kürzung wie die Überschrift des Berichts', () => {
    // Wer eine Datei sucht, sucht sie über die Id im Kopf. Zwei Kürzungen, die
    // auseinanderlaufen, machen die Ablage unauffindbar, ohne rot zu werden.
    const auditId = '0123abcd-1111-4222-8333-444444444444';
    const bericht = renderPruefbericht({
      auditId,
      domainLabel: 'Gate-Wahrheit',
      domain: 'gate_truth',
      trigger: 'phase_close',
      date: '2026-08-02',
      scope: 'Phase 5.',
      proposedSample: ['P5.G1'],
      result: BASE,
    });
    const kopf = BERICHTSKOPF.exec(bericht)?.[1];
    expect(kopf, `erste Zeile ist kein Berichtskopf: "${bericht.split('\n')[0]}"`).toBeTruthy();
    // Mit Trennzeichen, nicht nackt: `toContain(kopf)` allein ist einseitig —
    // eine *kürzere* Überschrift steckt in der längeren Kürzung des Namens und
    // hat die Mutation „slice(0, 6)" überlebt. Erst die Bindestriche machen
    // daraus eine Gleichheit.
    expect(pruefberichtDateiname({ auditId, date: '2026-08-02', domain: 'gate_truth' })).toContain(
      `-${kopf}-`,
    );
  });

  it('jeder abgelegte Bericht trägt die Id, die in ihm steht', () => {
    // Die Zusicherung über den echten Bestand, nicht über die Funktion: ein
    // Bericht, dessen Name nicht zu seinem Kopf passt, ist einer, der an der
    // Stelle eines anderen liegt. Genau so sah der Baum vor dieser Reparatur
    // aus — eine Datei ohne Id im Namen, mit fremdem Inhalt.
    const alle = readdirSync(REPORTS).filter((name) => name.endsWith('.md'));
    // Ein Bericht heisst `YYYY-MM-DD-<8 hex>-<domäne>.md` — das ist genau, was
    // `pruefberichtDateiname` erzeugt. Alles andere im Verzeichnis ist kein
    // Bericht, und **das wird auch zugesichert**: eine Ausnahme per Dateiname
    // („ausser README.md") wäre das Loch, durch das ein falsch benannter
    // Bericht als „ist ja keiner" entkommt. Erlaubt ist genau eine
    // Nicht-Bericht-Datei, der Index (seit dem 25.8.2026); taucht eine zweite
    // auf, ist das ein Fund und keine Ausnahme.
    const NAME = /^\d{4}-\d{2}-\d{2}-[0-9a-f]{8}-[a-z_]+\.md$/;
    const dateien = alle.filter((name) => NAME.test(name));
    expect(alle.filter((name) => !NAME.test(name))).toEqual(['README.md']);
    expect(dateien.length).toBeGreaterThan(0);
    // Als Paare gesammelt und **einmal** zugesichert, statt in der Schleife: ein
    // `continue` bei fehlendem Kopf wäre eine Schleife, die bei kaputten Daten
    // nichts prüft und grün bleibt.
    const paare = dateien.map((name) => ({
      name,
      id: BERICHTSKOPF.exec(readFileSync(join(REPORTS, name), 'utf8'))?.[1] ?? null,
    }));
    expect(paare.filter((paar) => paar.id === null)).toEqual([]);
    expect(paare.filter((paar) => paar.id !== null && !paar.name.includes(`-${paar.id}-`))).toEqual(
      [],
    );
  });
});
