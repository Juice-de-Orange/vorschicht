/**
 * Every card this radar can produce, held against the schema that will reject it.
 *
 * The assertions run `raiseEscalationInput` itself rather than restating §15's
 * rules, for A77.10's reason: a card that a long input pushes past the length
 * cap is refused at the boundary, and the finding it carried then reaches
 * nobody — the task escalates correctly and has no card to answer. Restating the
 * rules here would prove that this file agrees with my reading of §15; running
 * the schema proves it agrees with the service.
 *
 * The second thing this file exists for is A93.5/A97's defect, which this
 * project has now shipped twice: a card whose acting option moved because
 * somebody reordered the list, while the code kept releasing index 0. Both
 * dependency cards pin `RADAR_APPROVE_INDEX` **by title**.
 */
import { raiseEscalationInput } from '@vorschicht/shared';
import { describe, expect, it } from 'vitest';
import type { BillingSignal } from './billing.js';
import {
  advisoryCard,
  approvedUpdateTask,
  billingCard,
  cliUpdateTask,
  majorUpdateCard,
  RADAR_APPROVE_INDEX,
  type RadarCard,
  routineUpdateTask,
} from './cards.js';
import type { AdvisoryFinding, DependencyUpdate } from './dependencies.js';

const signal: BillingSignal = {
  subject: 'claude -p',
  change: 'usage credits',
  sentence: 'Programmatic usage via claude -p moves to usage credits on 1 September.',
  origin: 'https://example.test/pricing',
  signature: 'deadbeefdeadbeef',
};

const major: DependencyUpdate = {
  name: 'hono',
  current: '4.12.32',
  latest: '5.0.0',
  bump: 'major',
  importers: ['.', 'apps/server'],
};

const advisory: AdvisoryFinding = {
  id: 'GHSA-xxxx-yyyy-zzzz',
  name: 'hono',
  version: '4.12.32',
  severity: 'high',
  title: 'Beispielhafte Schwachstelle',
  url: 'https://example.test/advisory',
};

/** The boundary a card really has to pass — the service's own parser. */
function assertAcceptedByTheInbox(card: RadarCard, source: string): void {
  const parsed = raiseEscalationInput.safeParse({
    source,
    urgency: card.urgency,
    question: card.question,
    context: card.context,
    options: card.options,
    raisedBy: 'research',
  });
  expect(parsed.success ? null : JSON.stringify(parsed.error.issues)).toBeNull();
}

describe('billingCard', () => {
  const card = billingCard([signal]);

  it('ist P0 und wird vom Postfach angenommen', () => {
    expect(card.urgency).toBe('P0');
    assertAcceptedByTheInbox(card, 'billing_change');
  });

  it('zitiert den gefundenen Satz, statt ihn zu umschreiben', () => {
    // The rule fired on two words in one sentence; whether that sentence means
    // what the rule thinks is exactly the judgement being escalated.
    expect(card.context).toContain(signal.sentence);
    expect(card.context).toContain(signal.origin);
  });

  it('empfiehlt anzuhalten und nennt den Fehlalarm als echte Option', () => {
    // Decision 3: the studio cannot judge an announcement about its own funding,
    // so the recommendation costs throughput rather than a decision the operator never
    // made — and the common outcome, a documentation page, has its own option.
    const recommended = card.options.filter((option) => option.recommended);
    expect(recommended).toHaveLength(1);
    expect(recommended[0]?.title).toMatch(/pause/i);
    expect(card.options.some((option) => /fehlalarm/i.test(option.title))).toBe(true);
  });

  it('ist deutsch (§2)', () => {
    expect(card.question).toMatch(/anhalten/i);
    expect(card.context).not.toMatch(/\b(the|billing change was detected|options)\b/);
  });
});

describe('majorUpdateCard', () => {
  const card = majorUpdateCard(major, 'Vorschicht');

  it('wird vom Postfach angenommen und ist nicht dringend', () => {
    expect(card.urgency).toBe('P2');
    assertAcceptedByTheInbox(card, 'dependency_major');
  });

  it('setzt die handelnde Option auf RADAR_APPROVE_INDEX', () => {
    // A93.5 and A97, pinned. A reordered option list must fail here rather than
    // quietly promote "Vorerst nicht" to "Aktualisieren".
    expect(card.options[RADAR_APPROVE_INDEX]?.title).toBe('Aktualisieren — Aufgabe anlegen');
    expect(card.options[RADAR_APPROVE_INDEX]?.recommended).toBe(true);
  });

  it('sagt, dass der Changelog nicht gelesen wurde', () => {
    // Decision 4. §22's gate asks for "researched options"; this scan is
    // deterministic and read no changelog, and claiming otherwise would be an
    // evidence line nothing checks (A76.4).
    expect(card.context).toMatch(/nicht.*geprüft/i);
    expect(card.context).toContain('Changelog');
    expect(card.context).toContain('4.12.32');
    expect(card.context).toContain('5.0.0');
    expect(card.context).toContain('apps/server');
  });

  it('sagt bei einer unlesbaren Version, dass sie unlesbar war', () => {
    // Not "this is a major release" — that is a claim nobody established.
    const unknown = majorUpdateCard({ ...major, bump: 'unknown' }, 'Vorschicht');
    expect(unknown.question).toMatch(/nicht lesbar/i);
    expect(unknown.context).toMatch(/Semver/);
    assertAcceptedByTheInbox(unknown, 'dependency_major');
  });
});

describe('advisoryCard', () => {
  const card = advisoryCard([advisory], 'Vorschicht', major);

  it('ist P0, auch wenn der Versionssprung klein wäre', () => {
    // A10 makes advisories P0 outright; the version class has no say.
    expect(card.urgency).toBe('P0');
    expect(advisoryCard([advisory], 'Vorschicht', { ...major, bump: 'patch' }).urgency).toBe('P0');
    assertAcceptedByTheInbox(card, 'dependency_advisory');
  });

  it('nennt die Kennung, die Einstufung und den Titel', () => {
    expect(card.context).toContain('GHSA-xxxx-yyyy-zzzz');
    expect(card.context).toContain('high');
    expect(card.context).toContain('Beispielhafte Schwachstelle');
  });

  it('setzt dieselbe handelnde Option nach vorn', () => {
    expect(card.options[RADAR_APPROVE_INDEX]?.title).toBe('Aktualisieren — Aufgabe anlegen');
  });

  it('behauptet nicht, das Update behebe den Hinweis', () => {
    // The radar compares versions; it does not read a security bulletin.
    expect(card.context).toMatch(/nicht geprüft/i);
  });

  it('sagt es, wenn der Kanal keine neuere Version kennt', () => {
    const none = advisoryCard([advisory], 'Vorschicht', null);
    expect(none.context).toMatch(/keine neuere Version/i);
    assertAcceptedByTheInbox(none, 'dependency_advisory');
  });
});

describe('Längenschranken (A77.10)', () => {
  it('überlebt ein Lockfile mit zweihundert Fundstellen', () => {
    // The shape that produced a task with no card to answer: a thorough input
    // pushing a card past the schema's cap.
    const many: AdvisoryFinding[] = Array.from({ length: 200 }, (_, index) => ({
      ...advisory,
      id: `GHSA-${String(index).padStart(4, '0')}`,
      title: `Sehr ausführlich beschriebene Schwachstelle Nummer ${index} `.repeat(4),
    }));
    assertAcceptedByTheInbox(advisoryCard(many, 'Vorschicht', major), 'dependency_advisory');

    const manySignals: BillingSignal[] = Array.from({ length: 50 }, (_, index) => ({
      ...signal,
      sentence: `${signal.sentence} (${index}) ${'x'.repeat(600)}`,
      origin: `https://example.test/${index}`,
      signature: `sig-${index}`,
    }));
    assertAcceptedByTheInbox(billingCard(manySignals), 'billing_change');
  });

  it('kürzt sichtbar, statt still abzuschneiden', () => {
    const many: AdvisoryFinding[] = Array.from({ length: 20 }, (_, index) => ({
      ...advisory,
      id: `GHSA-${index}`,
    }));
    expect(advisoryCard(many, 'Vorschicht', major).context).toMatch(/und \d+ weitere/);
  });
});

describe('Aufgaben', () => {
  it('legt die CLI-Aufgabe auf A27s Prüfflächen fest', () => {
    const task = cliUpdateTask({ pinned: '2.1.220', latest: '2.1.230' });
    expect(task.title).toContain('2.1.220');
    expect(task.title).toContain('2.1.230');
    expect(task.priority).toBe('P2');
    // The surfaces this project actually contests with the CLI, so a bump that
    // breaks one of them fails a criterion rather than a vibe.
    expect(task.acceptanceCriteria.join('\n')).toMatch(/cli-contract/);
    expect(task.acceptanceCriteria.join('\n')).toMatch(/mcp-handshake/);
    expect(task.description).toMatch(/A27/);
  });

  it('bündelt Patch und Minor in einer Aufgabe der niedrigsten Priorität', () => {
    // A10's routine branch must not preempt the operator's own goals; it still outranks
    // an idle audit, which runs only on an empty queue (§21).
    const task = routineUpdateTask(
      [
        { name: 'a', current: '1.0.0', latest: '1.0.1', bump: 'patch', importers: ['.'] },
        { name: 'b', current: '1.0.0', latest: '1.1.0', bump: 'minor', importers: ['.'] },
      ],
      'Vorschicht',
    );
    expect(task.priority).toBe('P3');
    expect(task.title).toContain('2 Paket(e)');
    expect(task.description).toContain('a: 1.0.0 → 1.0.1');
    expect(task.description).toContain('b: 1.0.0 → 1.1.0');
  });

  it('nennt in der freigegebenen Aufgabe die Entscheidung, aus der sie stammt', () => {
    const task = approvedUpdateTask({
      name: 'hono',
      current: '4.12.32',
      latest: '5.0.0',
      projectName: 'Vorschicht',
      escalationNumber: 42,
      advisory: false,
    });
    expect(task.description).toContain('#42');
    expect(task.priority).toBe('P2');
    expect(task.description).toMatch(/brechenden Änderungen/);
  });

  it('unterscheidet die Sicherheits-Fassung von der Hauptversions-Fassung', () => {
    const security = approvedUpdateTask({
      name: 'hono',
      current: '4.12.32',
      latest: '5.0.0',
      projectName: 'Vorschicht',
      escalationNumber: 7,
      advisory: true,
    });
    expect(security.description).toMatch(/Sicherheitshinweis/);
    expect(security.description).not.toMatch(/brechenden Änderungen/);
  });
});
