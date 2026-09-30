/**
 * The adapter between §15's service and an HTTP status code.
 *
 * What is asserted here is only what belongs to this layer. Whether an answer is
 * *stored* once is `escalation-service`'s question and the database's; whether
 * §15's format is well-formed is `escalation.test.ts`'s. What this file pins is
 * the translation, and each of its three failure modes has cost somebody a
 * defect somewhere in this repository before:
 *
 *   * a refusal reported as the wrong kind, so a caller is sent to fix a form
 *     whose submission can never succeed;
 *   * an actor falling back to a default, so §19's trail says `system` where it
 *     should name a person (A75.3, one directory over);
 *   * an English message reaching a German boundary (§2).
 *
 * The fake declares `implements InboxEscalations`, so a signature that drifts
 * from `EscalationService` fails to compile rather than being tested against a
 * shape the real service no longer has (A57.6).
 */

import type { DecisionRecord, EscalationRecord } from '@vorschicht/core';
import { EscalationError } from '@vorschicht/core';
import type { AnswerEscalationInput } from '@vorschicht/shared';
import { describe, expect, it } from 'vitest';
import type { AnswerResult } from './inbox.js';
import {
  answerEscalation,
  DEFAULT_DECISION_LOG_LIMIT,
  decisionLogLimit,
  germanIssues,
  getInboxCard,
  type InboxEscalations,
  listDecisionLog,
  listInbox,
  MAX_DECISION_LOG_LIMIT,
} from './inbox.js';

const TASK = '22222222-2222-4222-8222-222222222222';
const PROJECT = '33333333-3333-4333-8333-333333333333';

function record(overrides: Partial<EscalationRecord> = {}): EscalationRecord {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    number: 12,
    source: 'agent_question',
    urgency: 'P1',
    projectId: PROJECT,
    taskId: TASK,
    runId: '44444444-4444-4444-8444-444444444444',
    question: 'Darf Vorschicht auf dev schreiben?',
    context: 'Der Coder braucht einen Integrationszweig. main ist geschützt.',
    options: [
      { title: 'Auf dev schreiben', pros: ['Schnell'], cons: ['Riskant'], recommended: true },
      {
        title: 'Nichts tun',
        pros: ['Sicher'],
        cons: ['Blockiert die Aufgabe'],
        recommended: false,
      },
    ],
    precedentKey: 'darf vorschicht auf dev schreiben',
    related: [
      {
        number: 3,
        question: 'Darf Vorschicht auf main schreiben?',
        summary: 'Entscheidung #3: Nein',
        decidedAt: '2026-07-30T10:00:00.000Z',
      },
    ],
    raisedAt: new Date('2026-08-02T08:00:00.000Z'),
    raisedBy: 'coder',
    state: 'open',
    answeredAt: null,
    answeredBy: null,
    chosenIndex: null,
    chosenTitle: null,
    freeText: null,
    ...overrides,
  };
}

function answeredRecord(overrides: Partial<EscalationRecord> = {}): EscalationRecord {
  return record({
    state: 'answered',
    answeredAt: new Date('2026-08-02T09:00:00.000Z'),
    answeredBy: 'dashboard:operator',
    chosenIndex: 0,
    chosenTitle: 'Auf dev schreiben',
    freeText: 'Aber nur auf einem Aufgabenzweig.',
    ...overrides,
  });
}

function decision(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    escalationId: '11111111-1111-4111-8111-111111111111',
    number: 12,
    source: 'agent_question',
    projectId: PROJECT,
    taskId: TASK,
    question: 'Darf Vorschicht auf dev schreiben?',
    precedentKey: 'darf vorschicht auf dev schreiben',
    options: record().options,
    chosenIndex: 0,
    chosenTitle: 'Auf dev schreiben',
    freeText: null,
    decidedAt: new Date('2026-08-02T09:00:00.000Z'),
    decidedBy: 'dashboard:operator',
    ...overrides,
  };
}

class FakeEscalations implements InboxEscalations {
  openRows: EscalationRecord[] = [];
  decisionRows: DecisionRecord[] = [];
  /** What `byNumber` answers, in call order — so a re-read can differ. */
  reads: Array<EscalationRecord | null> = [];
  readCount = 0;
  answerCalls: Array<{ escalationId: string; input: AnswerEscalationInput }> = [];
  answerThrows: Error | null = null;
  answerResult: EscalationRecord = answeredRecord();
  decisionLimits: Array<number | undefined> = [];

  async open(): Promise<EscalationRecord[]> {
    return this.openRows;
  }

  async byNumber(): Promise<EscalationRecord | null> {
    const answer = this.reads[Math.min(this.readCount, this.reads.length - 1)] ?? null;
    this.readCount += 1;
    return answer;
  }

  async answer(escalationId: string, input: AnswerEscalationInput): Promise<EscalationRecord> {
    this.answerCalls.push({ escalationId, input });
    if (this.answerThrows) throw this.answerThrows;
    return this.answerResult;
  }

  async decisions(limit?: number): Promise<DecisionRecord[]> {
    this.decisionLimits.push(limit);
    return this.decisionRows;
  }
}

/**
 * The reasons behind a refusal, insisting on which refusal it is.
 *
 * `result.ok === false && result.errors` reads fine and does not typecheck —
 * the unknown case carries none — and the version that silently yields `false`
 * would turn a wrong *kind* of refusal into a passing assertion about a boolean.
 */
function errorsOf(result: AnswerResult, reason: 'invalid' | 'conflict'): string[] {
  if (result.ok || result.reason !== reason) {
    throw new Error(`${reason} erwartet, war: ${result.ok ? 'ok' : result.reason}`);
  }
  return result.errors;
}

function fake(reads: Array<EscalationRecord | null>): FakeEscalations {
  const escalations = new FakeEscalations();
  escalations.reads = reads;
  return escalations;
}

describe('Posteingang — die Karte trägt §15s Format vollständig', () => {
  it('liefert Kontext, Quelle, Dringlichkeit und die Optionen mit Vor- und Nachteilen', async () => {
    const escalations = fake([record()]);
    const result = await getInboxCard({ escalations }, 12);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const card = result.escalation;

    expect(card.number).toBe(12);
    expect(card.question).toBe('Darf Vorschicht auf dev schreiben?');
    expect(card.context).toContain('Integrationszweig');
    expect(card.urgency).toBe('P1');
    expect(card.projectId).toBe(PROJECT);
    expect(card.taskId).toBe(TASK);
    expect(card.raisedAt).toBe('2026-08-02T08:00:00.000Z');
    expect(card.state).toBe('open');
    // The card must say who is asking in words the operator reads (§2).
    expect(card.sourceLabel).toBe('Frage aus einer Sitzung');
    expect(card.options).toEqual([
      {
        index: 0,
        title: 'Auf dev schreiben',
        pros: ['Schnell'],
        cons: ['Riskant'],
        recommended: true,
      },
      {
        index: 1,
        title: 'Nichts tun',
        pros: ['Sicher'],
        cons: ['Blockiert die Aufgabe'],
        recommended: false,
      },
    ]);
    // Near misses inform and never decide (A77.6) — they belong on the card.
    expect(card.related).toHaveLength(1);
    expect(card.related[0]?.number).toBe(3);
  });

  it('meldet eine unbekannte Nummer als unbekannt statt als leere Karte', async () => {
    const result = await getInboxCard({ escalations: fake([null]) }, 99);
    expect(result).toEqual({ ok: false, reason: 'unknown' });
  });

  it('behält die Reihenfolge des Dienstes bei — dringend zuerst (§17.5)', async () => {
    const escalations = fake([null]);
    escalations.openRows = [
      record({ number: 7, urgency: 'P0' }),
      record({ number: 4, urgency: 'P2' }),
    ];
    const list = await listInbox({ escalations });
    expect(list.map((card) => card.number)).toEqual([7, 4]);
  });

  // §15 requires exactly one recommendation. A row stored before the schema's
  // default would otherwise render as an option set with none.
  it('liest eine fehlende Empfehlung als „nicht empfohlen"', async () => {
    const options = [
      { title: 'A', pros: ['p'], cons: ['c'] },
      { title: 'B', pros: ['p'], cons: ['c'], recommended: true },
    ] as EscalationRecord['options'];
    const result = await getInboxCard({ escalations: fake([record({ options })]) }, 12);
    expect(result.ok && result.escalation.options.map((o) => o.recommended)).toEqual([false, true]);
  });
});

describe('Antwort auf eine Eskalation (§15)', () => {
  it('nimmt eine gewählte Option an und gibt die beantwortete Karte zurück', async () => {
    const escalations = fake([record()]);
    const result = await answerEscalation(
      { escalations },
      12,
      { optionIndex: 0 },
      'dashboard:operator',
    );

    expect(result.ok).toBe(true);
    expect(escalations.answerCalls).toHaveLength(1);
    expect(escalations.answerCalls[0]?.escalationId).toBe(record().id);
    expect(escalations.answerCalls[0]?.input.optionIndex).toBe(0);
    expect(result.ok && result.escalation.state).toBe('answered');
    expect(result.ok && result.escalation.chosenTitle).toBe('Auf dev schreiben');
  });

  it('nimmt eine reine Freitextantwort an', async () => {
    const escalations = fake([record()]);
    const result = await answerEscalation(
      { escalations },
      12,
      { freeText: 'Nimm dev, aber nur auf einem Aufgabenzweig.' },
      'dashboard:operator',
    );
    expect(result.ok).toBe(true);
    expect(escalations.answerCalls[0]?.input.freeText).toBe(
      'Nimm dev, aber nur auf einem Aufgabenzweig.',
    );
  });

  // §19: the trail exists to say *who* decided, and a decision resumes a parked
  // session on the operator's authority (§6.4). The body does not get a vote.
  it('nimmt den Urheber aus der Sitzung, auch wenn der Rumpf einen anderen nennt', async () => {
    const escalations = fake([record()]);
    await answerEscalation(
      { escalations },
      12,
      { optionIndex: 1, actor: 'jemand-anders' },
      'dashboard:operator',
    );
    expect(escalations.answerCalls[0]?.input.actor).toBe('dashboard:operator');
  });

  it('meldet eine unbekannte Nummer, ohne etwas zu schreiben', async () => {
    const escalations = fake([null]);
    const result = await answerEscalation(
      { escalations },
      99,
      { optionIndex: 0 },
      'dashboard:operator',
    );
    expect(result).toEqual({ ok: false, reason: 'unknown' });
    expect(escalations.answerCalls).toEqual([]);
  });
});

describe('Eine zweite Antwort ist ein Konflikt, kein stiller Überschreiber', () => {
  it('lehnt eine bereits beantwortete Eskalation ab und versucht gar nicht zu schreiben', async () => {
    const escalations = fake([answeredRecord()]);
    const result = await answerEscalation(
      { escalations },
      12,
      { optionIndex: 1 },
      'dashboard:operator',
    );

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe('conflict');
    // The load-bearing half: nothing was even attempted. A refusal that first
    // tries the write is one database rule away from an overwrite.
    expect(escalations.answerCalls).toEqual([]);
  });

  it('legt der Absage die bereits gegebene Antwort bei', async () => {
    const escalations = fake([answeredRecord()]);
    const result = await answerEscalation(
      { escalations },
      12,
      { optionIndex: 1 },
      'dashboard:operator',
    );
    if (result.ok || result.reason !== 'conflict') throw new Error('Konflikt erwartet');
    expect(result.escalation.chosenTitle).toBe('Auf dev schreiben');
    expect(result.escalation.answeredBy).toBe('dashboard:operator');
    expect(result.errors[0]).toContain('bereits beantwortet');
  });

  // The check above cannot see an answer that lands between it and the write —
  // only the database can, and it does. The service labels that refusal
  // `conflict`, and this layer reads the label rather than re-reading the row
  // and guessing. The *real* race is proven in `inbox.itest.ts`, without
  // injecting anything; this pins the branch.
  it('erkennt auch eine Antwort, die zwischen Prüfung und Schreiben eintrifft', async () => {
    const escalations = fake([record(), answeredRecord()]);
    escalations.answerThrows = new EscalationError(
      'Entscheidung #12 ist bereits beantwortet',
      'conflict',
    );

    const result = await answerEscalation(
      { escalations },
      12,
      { optionIndex: 1 },
      'dashboard:operator',
    );
    expect(result.ok === false && result.reason).toBe('conflict');
    expect(escalations.answerCalls).toHaveLength(1);
  });

  // Same class, different `kind` — and the kind is the whole difference.
  it('meldet eine nicht vorhandene Option dagegen als Eingabefehler', async () => {
    const escalations = fake([record(), record()]);
    escalations.answerThrows = new EscalationError(
      'Option 5 gibt es bei Entscheidung #12 nicht — es sind 2 zur Auswahl (0 bis 1).',
      'invalid_option',
    );

    const result = await answerEscalation(
      { escalations },
      12,
      { optionIndex: 5 },
      'dashboard:operator',
    );
    expect(result.ok === false && result.reason).toBe('invalid');
    expect(errorsOf(result, 'invalid')[0]).toContain('Option 5 gibt es');
  });

  // A fault that is not §15's refusal is a fault, not a 422. A real `23505`
  // used to land in this bucket; the service now translates it before it gets
  // here, which is why the case below still has to hold and still has to be
  // about something else.
  it('lässt einen fremden Fehler durch, statt ihn als Eingabefehler auszugeben', async () => {
    const escalations = fake([record(), record()]);
    escalations.answerThrows = new Error('Verbindung zur Datenbank verloren');
    await expect(
      answerEscalation({ escalations }, 12, { optionIndex: 0 }, 'dashboard:operator'),
    ).rejects.toThrow('Verbindung zur Datenbank verloren');
  });

  /**
   * The crossing case, and the reason it is worth its own test.
   *
   * An already-answered card **plus** an unusable body must come back as a
   * conflict, not as a validation error: the caller has nothing to fix, and
   * sending them to correct a form whose submission can never succeed is the
   * least useful answer available. The ordering that produces this is documented
   * at the top of `answerEscalation` — and until now nothing held it, so
   * swapping the two steps broke no test at all.
   */
  it('meldet eine beantwortete Karte mit leerem Rumpf als Konflikt, nicht als Eingabefehler', async () => {
    const escalations = fake([answeredRecord()]);
    const result = await answerEscalation({ escalations }, 12, {}, 'dashboard:operator');
    expect(result.ok === false && result.reason).toBe('conflict');
    // And it never reached the service: there is nothing to write.
    expect(escalations.answerCalls).toEqual([]);
  });
});

describe('Eingabefehler kommen auf Deutsch zurück (§2)', () => {
  it('weist eine Antwort ohne Option und ohne Freitext ab', async () => {
    const escalations = fake([record()]);
    const result = await answerEscalation({ escalations }, 12, {}, 'dashboard:operator');
    expect(result.ok === false && result.reason).toBe('invalid');
    expect(errorsOf(result, 'invalid')[0]).toContain('entweder eine gewählte Option');
    expect(escalations.answerCalls).toEqual([]);
  });

  it('behandelt einen Rumpf, der kein Objekt ist, als leere Antwort', async () => {
    for (const body of ['kein json', null, 42, ['a']]) {
      const escalations = fake([record()]);
      const result = await answerEscalation({ escalations }, 12, body, 'dashboard:operator');
      expect(result.ok === false && result.reason).toBe('invalid');
      expect(escalations.answerCalls).toEqual([]);
    }
  });

  it('nennt einen zu langen Freitext auf Deutsch statt in zods Englisch', async () => {
    const escalations = fake([record()]);
    const result = await answerEscalation(
      { escalations },
      12,
      { freeText: 'x'.repeat(9_000) },
      'dashboard:operator',
    );
    expect(errorsOf(result, 'invalid')).toEqual([
      'Der Freitext ist zu lang — höchstens 8000 Zeichen.',
    ]);
  });

  it('nennt eine unbrauchbare Option auf Deutsch statt in zods Englisch', async () => {
    const escalations = fake([record()]);
    const result = await answerEscalation(
      { escalations },
      12,
      { optionIndex: 'die erste' },
      'dashboard:operator',
    );
    if (result.ok || result.reason !== 'invalid') throw new Error('Eingabefehler erwartet');
    expect(result.errors).toContain('Die gewählte Option hat nicht die erwartete Form.');
    for (const message of result.errors) expect(message).not.toMatch(/[Ii]nvalid|[Ee]xpected/);
  });
});

describe('germanIssues', () => {
  it('reicht die deutsche Meldung einer Verfeinerung wörtlich durch', () => {
    expect(
      germanIssues([{ code: 'custom', path: ['optionIndex'], message: 'Eine Regel aus §15.' }]),
    ).toEqual(['Eine Regel aus §15.']);
  });

  it('gibt auch für einen unbekannten Code Deutsch aus', () => {
    expect(
      germanIssues([{ code: 'invalid_type', path: ['freeText'], message: 'Expected string' }]),
    ).toEqual(['Der Freitext hat nicht die erwartete Form.']);
  });

  it('benennt ein unbekanntes Feld, ohne zu raten', () => {
    expect(germanIssues([{ code: 'invalid_type', path: ['irgendwas'], message: 'nope' }])).toEqual([
      'Die Eingabe hat nicht die erwartete Form.',
    ]);
  });
});

describe('Entscheidungslog (§15, §17.5)', () => {
  it('liefert die Kontextverweise und eine deutsche Zusammenfassung', async () => {
    const escalations = fake([null]);
    escalations.decisionRows = [decision({ freeText: 'Nur auf einem Aufgabenzweig.' })];
    const [row] = await listDecisionLog({ escalations }, null);

    expect(row?.escalationId).toBe(decision().escalationId);
    expect(row?.number).toBe(12);
    expect(row?.projectId).toBe(PROJECT);
    expect(row?.taskId).toBe(TASK);
    expect(row?.question).toBe('Darf Vorschicht auf dev schreiben?');
    expect(row?.sourceLabel).toBe('Frage aus einer Sitzung');
    expect(row?.decidedBy).toBe('dashboard:operator');
    expect(row?.decidedAt).toBe('2026-08-02T09:00:00.000Z');
    // the operator's own words travel verbatim — a paraphrase is a second wording of a
    // decision that nothing keeps in step.
    expect(row?.summary).toBe(
      'Entscheidung #12: Auf dev schreiben — „Nur auf einem Aufgabenzweig.“',
    );
  });

  it('reicht die vorgegebene Grenze an den Dienst durch', async () => {
    const escalations = fake([null]);
    await listDecisionLog({ escalations }, 5);
    expect(escalations.decisionLimits).toEqual([5]);
  });

  it.each([
    [null, DEFAULT_DECISION_LOG_LIMIT],
    [Number.NaN, DEFAULT_DECISION_LOG_LIMIT],
    [0, 1],
    [-9, 1],
    [7.9, 7],
    [10_000, MAX_DECISION_LOG_LIMIT],
  ])('begrenzt %s auf %i', (raw, expected) => {
    expect(decisionLogLimit(raw)).toBe(expected);
  });
});
