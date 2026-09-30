/**
 * The onboarding proposal as the operator reads it (§20, §15).
 *
 * §15 fixes the shape of anything put in front of him: context, two to four
 * researched options with pros and cons, exactly one recommendation, free text
 * always available. That is asserted here rather than trusted, because the
 * inbox that will enforce it arrives in Phase 4 and this document is what he
 * gets until then.
 *
 * The other half is honesty about what the proposal does *not* establish. A
 * report that lists five green gates and stays quiet about the locked gate with
 * no command has told the truth and given the wrong impression, which is the
 * failure mode §8.2's `scope_limit` exists for one department over.
 */
import {
  MAX_ESCALATION_CONTEXT_LENGTH,
  MAX_ESCALATION_QUESTION_LENGTH,
  type OnboardingResult,
  type RaiseEscalationInput,
  raiseEscalationInput,
} from '@vorschicht/shared';
import { describe, expect, it } from 'vitest';
import type { EscalationService } from '../escalation-service.js';
import { proposalOptions, raiseProposal, renderOnboardingProposal } from './report.js';
import type { RepositorySurvey } from './survey.js';
import { verifyProposal } from './verify.js';

const PACKAGE_JSON = JSON.stringify({ scripts: { test: 'vitest run', lint: 'biome check .' } });

function survey(): RepositorySurvey {
  return {
    rootPath: '/opt/fixture',
    git: {
      isRepository: true,
      defaultBranch: 'main',
      checkedOutBranch: 'main',
      defaultBranchSource: 'git symbolic-ref --short refs/remotes/origin/HEAD',
      remoteUrl: null,
      headSha: 'abc',
      commitCount: 7,
      lastCommit: 'abc 2026-08-01 etwas',
      branches: ['main'],
    },
    files: ['package.json'],
    packages: [{ dir: '.', name: 'fixture', scripts: ['test', 'lint'] }],
    inventory: {
      fileCount: 1,
      extensions: [],
      topLevel: ['package.json'],
      personalDataHints: [],
      migrationCandidates: [],
      testCandidates: [],
    },
    manifests: [{ path: 'package.json', content: PACKAGE_JSON }],
    ci: [],
    deploy: [],
    conventions: [],
    sources: ['git ls-files --cached --others --exclude-standard'],
    gaps: [],
  };
}

function proposal(overrides: Partial<OnboardingResult> = {}): OnboardingResult {
  return {
    status: 'done',
    summary: 'Kleines TypeScript-Paket ohne Rollout.',
    artifacts: [],
    followups: [],
    stack: 'TypeScript',
    defaultBranch: 'main',
    gates: [
      { id: 'test', enabled: true, command: 'pnpm run test', rationale: 'Manifest sagt `test`.' },
      { id: 'lint', enabled: true, command: 'pnpm lint', rationale: 'Manifest sagt `lint`.' },
    ],
    claimGranularity: 'file',
    claimRationale: 'Flache Anwendung.',
    migrationPaths: [],
    tools: ['Bash(pnpm:*)'],
    deploy: { method: 'none', rationale: 'Bibliothek.' },
    personalData: { present: false, evidence: [] },
    departments: ['Entwicklung'],
    risks: [],
    ...overrides,
  };
}

function render(result = proposal(), readOnly = true): string {
  const s = survey();
  return renderOnboardingProposal({
    slug: 'fixture',
    name: 'Fixture',
    survey: s,
    result,
    verification: verifyProposal(s, result),
    readOnly,
    runId: 'run-1',
    date: '2026-08-01',
  });
}

describe('renderOnboardingProposal (§15, §2)', () => {
  it('hat die §15-Form: Kontext, Optionen mit Pro und Contra, genau eine Empfehlung, Freitext', () => {
    const text = render();
    expect(text).toContain('## Kontext');
    expect(text).toContain('## Optionen');
    expect(text).toContain('**Dafür:**');
    expect(text).toContain('**Dagegen:**');
    expect(text.match(/\*\(Empfehlung\)\*/g)).toHaveLength(1);
    expect(text).toContain('**Freitext ist wie immer möglich**');
  });

  it('ist deutsch und nennt Projekt, Lauf und Pfad im Kopf', () => {
    const text = render();
    expect(text).toContain('**Von:** Produktleitung (Petra)');
    expect(text).toContain('`run-1`');
    expect(text).toContain('`/opt/fixture`');
    expect(text).toContain('Trockenlauf ohne jeden Schreibzugriff');
  });

  it('führt gesperrte Gates auf, die der Vorschlag gar nicht erwähnt hat', () => {
    // Otherwise the table is a table of what the model thought about rather
    // than of what will actually run before every merge.
    const text = render();
    expect(text).toContain('| Typprüfung | gesperrt (läuft immer) | — |');
    expect(text).toContain('ohne Befehl also ungeprüft');
    expect(text).toContain('| Secrets-Scan (gitleaks) | gesperrt (läuft immer) | — |');
  });

  it('zeigt zu jedem Befehl, woher er belegt ist', () => {
    const text = render();
    expect(text).toContain('### Woher die Befehle stammen');
    expect(text).toContain('belegt: `package.json` deklariert das Skript `test`.');
    expect(text).toMatch(/blockiert nie und\s+wird nie rot/);
  });

  it('sagt bei einem erfundenen Befehl, dass so nichts übernommen wird', () => {
    const text = render(
      proposal({
        gates: [{ id: 'test', enabled: true, command: 'pnpm run tests', rationale: 'x' }],
      }),
    );
    expect(text).toContain('### Was so nicht übernommen werden kann');
    expect(text).toContain('nicht** übernehmbar');
    expect(text).toContain('nicht vorhanden');
  });

  it('trennt „verschoben" von „abgelehnt"', () => {
    // Träger der Verschiebung ist seit A115 `static-rsync` statt `legal`: Lena
    // gibt es, den Zielhost nicht (A99). Der Abschnitt selbst ist unverändert
    // das, was er prüft — dass ein richtiger Vorschlag, der heute nicht
    // gespeichert werden kann, sichtbar bleibt statt zu verschwinden.
    const text = render(
      proposal({
        gates: [...proposal().gates, { id: 'legal', enabled: true, rationale: 'Mitgliedsdaten.' }],
        deploy: { method: 'static-rsync', rationale: 'Statischer Build.' },
      }),
    );
    expect(text).toContain('### Richtig, aber noch nicht baubar');
    expect(text).toContain('Zielhost');
    expect(text).toContain('Phase 5');
    expect(text).not.toContain('### Was so nicht übernommen werden kann');
    // Lena steht jetzt in der gewöhnlichen Spalte — die Tabelle muss also
    // zeigen, dass das Gate *übernommen* wird, nicht dass es fehlt.
    expect(text).toContain('| DSGVO-/Rechtsprüfung (Lena) | an |');
  });

  it('zeigt Anhaltspunkte für personenbezogene Daten und entscheidet nicht darüber', () => {
    const text = render(
      proposal({ personalData: { present: true, evidence: ['src/members.ts:14'] } }),
    );
    expect(text).toContain('### Personenbezogene Daten');
    expect(text).toContain('`src/members.ts:14`');
    expect(text).toMatch(/deine Entscheidung und Lenas Fach/);
  });
});

describe('proposalOptions', () => {
  const input = (readOnly: boolean, result = proposal()) => {
    const s = survey();
    return {
      slug: 'fixture',
      name: 'Fixture',
      survey: s,
      result,
      verification: verifyProposal(s, result),
      readOnly,
      runId: 'r',
      date: '2026-08-01',
    };
  };

  it('bietet bei einem A41-Projekt das Weiterlesen als Empfehlung an', () => {
    const options = proposalOptions(input(true));
    expect(options).toHaveLength(3);
    expect(options[0]?.recommended).toBe(true);
    expect(options[0]?.title).toContain('nur analysieren');
    expect(options[1]?.title).toContain('Schreibrechte freigeben');
    expect(options[1]?.cons.join(' ')).toContain('A41');
  });

  it('dreht die Optionen um, wenn das Projekt nicht nur lesbar ist', () => {
    const options = proposalOptions(input(false));
    expect(options[0]?.title).toContain('für Arbeit freigeben');
    expect(options[1]?.title).toContain('zunächst nur lesend');
  });

  it('bietet „übernehmen" gar nicht an, wenn der Vorschlag abgelehnt wurde', () => {
    const rejected = proposal({
      gates: [{ id: 'test', enabled: true, command: 'pnpm run tests', rationale: 'x' }],
    });
    const options = proposalOptions(input(true, rejected));
    expect(options.every((option) => !option.title.startsWith('So übernehmen'))).toBe(true);
    expect(options[0]?.title).toContain('zurückweisen');
    expect(options.filter((option) => option.recommended)).toHaveLength(1);
  });

  it('hat immer zwei bis vier Optionen, je mit Pro und Contra (§15)', () => {
    for (const options of [proposalOptions(input(true)), proposalOptions(input(false))]) {
      expect(options.length).toBeGreaterThanOrEqual(2);
      expect(options.length).toBeLessThanOrEqual(4);
      for (const option of options) {
        expect(option.pros.length).toBeGreaterThan(0);
        expect(option.cons.length).toBeGreaterThan(0);
      }
    }
  });
});

/**
 * §20's "one multiple-choice escalation", and what it may not contain.
 *
 * The only caller is `infra/scripts/onboard.mjs` — untyped, outside every step
 * of `pnpm gate`, and exercised solely by a paid model session. So everything a
 * mistake could live in was moved into `raiseProposal`, and this is what makes
 * that move worth anything: it drives the real function against a stub inbox
 * and asserts the object that reaches `raise`.
 */
describe('raiseProposal — §20s Entscheidung landet im Postfach', () => {
  const input = (readOnly = true) => {
    const s = survey();
    const result = proposal();
    return {
      slug: 'fixture',
      name: 'Fixture',
      survey: s,
      result,
      verification: verifyProposal(s, result),
      readOnly,
      runId: 'r',
      date: '2026-08-01',
    };
  };

  function inbox() {
    const raised: RaiseEscalationInput[] = [];
    return {
      raised,
      service: {
        raise: async (value: RaiseEscalationInput) => {
          raised.push(value);
          return { number: 7 } as Awaited<ReturnType<EscalationService['raise']>>;
        },
      },
    };
  }

  it('legt die Karte als `gate_proposal` an — ohne Projekt, ohne Aufgabe, ohne Lauf', async () => {
    const box = inbox();
    const number = await raiseProposal(box.service, input(), { documentPath: 'docs/x.md' });

    expect(number).toBe(7);
    const card = box.raised[0];
    expect(card?.source).toBe('gate_proposal');
    expect(card?.urgency).toBe('P2');
    expect(card?.raisedBy).toBe('onboarding');
    // A dry run has created nothing, and that is what the answer decides (§20,
    // A70.3). A task id would additionally put this card in the slot
    // `Scheduler.resumeDecided` reads to continue a parked session.
    expect(card?.projectId).toBeNull();
    expect(card?.taskId).toBeNull();
    expect(card?.runId).toBeNull();
    expect(card?.context).toContain('docs/x.md');
  });

  it('hält §15s Format ein, sodass der Dienst die Karte nicht abweist', async () => {
    const box = inbox();
    await raiseProposal(box.service, input(), { documentPath: 'docs/x.md' });
    // The schema the service applies, applied here: a card refused at the
    // boundary is a proposal that was paid for and never asked.
    expect(() => raiseEscalationInput.parse(box.raised[0])).not.toThrow();
  });

  it('klemmt eine überlange Frage und einen überlangen Kontext, statt sie zu verlieren', async () => {
    const box = inbox();
    const long = input();
    const padded = {
      ...long,
      name: 'F'.repeat(MAX_ESCALATION_QUESTION_LENGTH * 2),
      survey: { ...long.survey, rootPath: '/opt/'.padEnd(MAX_ESCALATION_CONTEXT_LENGTH * 2, 'x') },
    };
    await raiseProposal(box.service, padded, { documentPath: 'docs/x.md' });

    const card = box.raised[0];
    expect(card?.question.length).toBeLessThanOrEqual(MAX_ESCALATION_QUESTION_LENGTH);
    expect(card?.context.length).toBeLessThanOrEqual(MAX_ESCALATION_CONTEXT_LENGTH);
    expect(() => raiseEscalationInput.parse(card)).not.toThrow();
  });

  it('verliert den Vorschlag nicht, wenn das Postfach nicht erreichbar ist', async () => {
    const warnings: string[] = [];
    const number = await raiseProposal(
      {
        raise: () => Promise.reject(new Error('Datenbank weg')),
      },
      input(),
      { onWarning: (message) => warnings.push(message) },
    );

    expect(number).toBeNull();
    expect(warnings.join(' ')).toContain('Das Dokument steht trotzdem.');
  });
});
