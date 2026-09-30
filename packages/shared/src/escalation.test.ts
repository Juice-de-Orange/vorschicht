import { describe, expect, it } from 'vitest';
import {
  answerEscalationInput,
  decisionMessage,
  decisionSummary,
  ESCALATION_SOURCE_LABELS,
  ESCALATION_SOURCES,
  hasPrecedentKey,
  isPolicyMemorySource,
  isRelated,
  MAX_ESCALATION_CONTEXT_LENGTH,
  MAX_ESCALATION_QUESTION_LENGTH,
  POLICY_MEMORY_SOURCES,
  precedentKey,
  questionSimilarity,
  raiseEscalationInput,
} from './escalation.js';
import { ESCALATION_OPTION_RANGE, escalateAskInput } from './mcp-tools.js';

const OPTIONS = [
  { title: 'So lassen', pros: ['billig'], cons: ['langsam'], recommended: true },
  { title: 'Umbauen', pros: ['schnell'], cons: ['teuer'], recommended: false },
];

describe('precedentKey — normalisiert Form, niemals Bedeutung', () => {
  it('macht dieselbe Frage in zwei Schreibweisen zum selben Schlüssel', () => {
    const a = precedentKey('Darf Vorschicht auf `dev` schreiben?');
    const b = precedentKey('  darf vorschicht auf dev\n  schreiben  ');
    expect(a).toBe(b);
    expect(a).toBe('darf vorschicht auf dev schreiben');
  });

  it('lässt Anführungszeichen und Betonung fallen — beides ist Formatierung', () => {
    expect(precedentKey('Nehmen wir „React“ oder *Vue*?')).toBe(
      precedentKey("Nehmen wir 'React' oder Vue?"),
    );
  });

  it('entfernt Satzzeichen nur am Ende, nicht in der Mitte', () => {
    // Ein Doppelpunkt mittendrin trennt zwei Satzteile und gehört zur Frage;
    // das Fragezeichen am Ende trägt nichts, was zwei Fragen unterscheidet.
    expect(precedentKey('Zweig: dev oder main?')).toBe('zweig: dev oder main');
  });

  it.each([
    ['Soll ich auf Version 3 gehen?', 'Soll ich auf Version 4 gehen?'],
    ['Dürfen wir Sentry einsetzen?', 'Dürfen wir Datadog einsetzen?'],
    ['Soll example-app schreibbar werden?', 'Soll example-app lesbar bleiben?'],
    // Verneinung: die gefährlichste Kollision überhaupt, weil sich beide
    // Fragen bis auf ein Wort gleichen und die Antworten entgegengesetzt sind.
    ['Darf der Bot auf main pushen?', 'Darf der Bot nicht auf main pushen?'],
  ])('hält verschiedene Fragen auseinander: %s / %s', (a, b) => {
    expect(precedentKey(a)).not.toBe(precedentKey(b));
  });

  it('liefert einen leeren Schlüssel, wenn nichts Normalisierbares übrig bleibt', () => {
    // Der gefährlichste Fall des ganzen Moduls: ein leerer Schlüssel, der gegen
    // die Datenbank gehalten jede jemals getroffene Entscheidung träfe.
    for (const nothing of ['???', '   ', '„“', '***', '.']) {
      expect(precedentKey(nothing)).toBe('');
      expect(hasPrecedentKey(precedentKey(nothing))).toBe(false);
    }
    expect(hasPrecedentKey(precedentKey('Etwas Echtes?'))).toBe(true);
  });
});

describe('Ähnlichkeit — informiert die Karte, entscheidet nie', () => {
  it('erkennt dieselbe Frage in anderer Wortstellung', () => {
    expect(
      questionSimilarity(
        'darf vorschicht auf dev schreiben',
        'auf dev schreiben darf vorschicht das',
      ),
    ).toBeGreaterThan(0.6);
  });

  it('nennt die exakt gleiche Frage *nicht* verwandt — das ist ein Präzedenzfall', () => {
    // Sonst stünde dieselbe Entscheidung zweimal auf der Karte: einmal als
    // angewandter Präzedenzfall und einmal als "ähnlich".
    expect(isRelated('Darf X?', 'darf x?')).toBe(false);
  });

  it('nennt Unverwandtes nicht verwandt', () => {
    expect(isRelated('Welche Datenbank nehmen wir?', 'Wann ist das Backup fällig?')).toBe(false);
  });

  it('gibt für eine leere Frage nichts zurück, statt alles', () => {
    expect(isRelated('???', 'Irgendeine Frage?')).toBe(false);
    expect(questionSimilarity('', 'Irgendetwas')).toBe(0);
  });
});

describe('POLICY_MEMORY_SOURCES — was wiederverwendet werden darf', () => {
  it('enthält Agentenfragen', () => {
    expect(isPolicyMemorySource('agent_question')).toBe(true);
  });

  it('enthält den roten Pfad nicht', () => {
    // Der konkrete Unfall, gegen den die Liste geschrieben ist: die Frage aus
    // §9 nennt eine Aufgabe beim Namen, und eine wiederverwendbare Antwort
    // darauf hieße, dass eine später gleichnamige Aufgabe *automatisch*
    // abgebrochen wird, ohne dass jemand gefragt wird.
    expect(isPolicyMemorySource('task_red')).toBe(false);
  });

  it('enthält keine der drei Quellen, die in Phase 4.5 einen Erzeuger bekommen haben', () => {
    // Each has its own accident, and `audit_finding` is the worst of them: one
    // of its options is "Fund verwerfen — Haken wieder setzen", so a reusable
    // answer would let a later audit re-tick a gate out of memory with nobody
    // asked. Written as a list because the failure is somebody adding an entry
    // "while they are in there wiring the producer".
    for (const source of ['audit_finding', 'gate_proposal', 'budget_anomaly'] as const) {
      expect(isPolicyMemorySource(source), source).toBe(false);
    }
  });

  it('enthält die Design-Abnahme nicht — sie ist der Grund, warum es sie als eigene Quelle gibt', () => {
    // §22 P7.G7 verlangt des Betreibers Abnahme von Gestaltung und deutscher Oberfläche
    // als Posteingangskarte. `agent_question` wäre dafür die naheliegende
    // Quelle und die gefährliche: sie ist der **einzige** Eintrag hier, also
    // würde die zweite Abnahme — in Phase 9, über ein inzwischen geändertes
    // Design — stillschweigend aus der Präzedenz der ersten beantwortet, ohne
    // dass eine Karte entsteht. Deshalb eine eigene Quelle, und deshalb diese
    // Zusicherung: der Kommentar an der Liste ist eine Absicht, das hier ist
    // der Mechanismus (A44.3).
    expect(isPolicyMemorySource('design_signoff')).toBe(false);
    expect(ESCALATION_SOURCES).toContain('design_signoff');
  });

  it('ist eine echte Teilmenge der Quellen', () => {
    for (const source of POLICY_MEMORY_SOURCES) {
      expect(ESCALATION_SOURCES).toContain(source);
    }
    expect(POLICY_MEMORY_SOURCES.length).toBeLessThan(ESCALATION_SOURCES.length);
  });

  it('gibt jeder Quelle eine deutsche Beschriftung (§2)', () => {
    for (const source of ESCALATION_SOURCES) {
      expect(ESCALATION_SOURCE_LABELS[source]?.length).toBeGreaterThan(0);
    }
    expect(Object.keys(ESCALATION_SOURCE_LABELS).sort()).toEqual([...ESCALATION_SOURCES].sort());
  });
});

describe('raiseEscalationInput — §15s Format an der Grenze', () => {
  const valid = {
    source: 'agent_question' as const,
    question: 'Welchen Zweig nehmen wir?',
    context: 'Es geht um den Integrationszweig.',
    urgency: 'P2' as const,
    options: OPTIONS,
    raisedBy: 'planner',
  };

  it('nimmt eine wohlgeformte Eskalation an', () => {
    expect(raiseEscalationInput.parse(valid).options).toHaveLength(2);
  });

  it.each([
    ['keine Empfehlung', OPTIONS.map((o) => ({ ...o, recommended: false }))],
    ['zwei Empfehlungen', OPTIONS.map((o) => ({ ...o, recommended: true }))],
    ['nur eine Option', [OPTIONS[0]]],
    ['fünf Optionen', [...OPTIONS, ...OPTIONS, OPTIONS[0]]],
    ['eine Option ohne Nachteil', [{ ...OPTIONS[0], cons: [] }, OPTIONS[1]]],
    ['eine Option ohne Vorteil', [{ ...OPTIONS[0], pros: [] }, OPTIONS[1]]],
  ])('weist "%s" zurück', (_name, options) => {
    expect(raiseEscalationInput.safeParse({ ...valid, options }).success).toBe(false);
  });

  it('weist dieselben Optionsfehler zurück wie das Werkzeug des Agenten', () => {
    // Zwei Schemata, ein Format. Sie dürfen auseinanderlaufen, wo sie
    // verschiedene Aufrufer bedienen (`source`, `runId`), aber nicht bei §15s
    // Optionsregeln — sonst nimmt der Kanal an, was der Dienst verweigert,
    // und der Agent erfährt es erst, wenn der Zug schon abgefahren ist.
    const broken = { ...valid, options: OPTIONS.map((o) => ({ ...o, recommended: false })) };
    expect(raiseEscalationInput.safeParse(broken).success).toBe(false);
    expect(
      escalateAskInput.safeParse({
        question: broken.question,
        context: broken.context,
        urgency: 'P2',
        options: broken.options,
      }).success,
    ).toBe(false);
    expect(ESCALATION_OPTION_RANGE).toEqual({ min: 2, max: 4 });
  });

  it('teilt die Längengrenzen mit dem Werkzeug des Agenten', () => {
    // Der Grund steht in `escalateAskInput`: eine Frage, die der Agent
    // schreiben darf und der Dienst ablehnt, kostet eine ganze Sitzung.
    const long = 'x'.repeat(MAX_ESCALATION_QUESTION_LENGTH + 1);
    expect(raiseEscalationInput.safeParse({ ...valid, question: long }).success).toBe(false);
    expect(
      escalateAskInput.safeParse({
        question: long,
        context: 'egal',
        urgency: 'P2',
        options: OPTIONS,
      }).success,
    ).toBe(false);

    const longContext = 'x'.repeat(MAX_ESCALATION_CONTEXT_LENGTH + 1);
    expect(raiseEscalationInput.safeParse({ ...valid, context: longContext }).success).toBe(false);
    expect(
      escalateAskInput.safeParse({
        question: 'kurz?',
        context: longContext,
        urgency: 'P2',
        options: OPTIONS,
      }).success,
    ).toBe(false);
  });
});

describe('answerEscalationInput — eine Antwort ist eine Antwort', () => {
  it('nimmt eine gewählte Option', () => {
    expect(answerEscalationInput.parse({ optionIndex: 1, actor: 'max' }).optionIndex).toBe(1);
  });

  it('nimmt reinen Freitext (§15: immer möglich)', () => {
    expect(answerEscalationInput.parse({ freeText: 'nimm dev', actor: 'max' }).freeText).toBe(
      'nimm dev',
    );
  });

  it('nimmt beides zusammen — die häufigste Form', () => {
    const parsed = answerEscalationInput.parse({
      optionIndex: 0,
      freeText: 'aber erst nächste Woche',
      actor: 'max',
    });
    expect(parsed.optionIndex).toBe(0);
    expect(parsed.freeText).toBe('aber erst nächste Woche');
  });

  it.each([
    ['gar nichts', {}],
    ['leerer Freitext', { freeText: '   ' }],
    ['null und null', { optionIndex: null, freeText: null }],
  ])('weist "%s" zurück', (_name, answer) => {
    expect(answerEscalationInput.safeParse({ ...answer, actor: 'max' }).success).toBe(false);
  });

  it('verlangt einen Akteur — eine Entscheidung ohne Urheber ist keine', () => {
    expect(answerEscalationInput.safeParse({ optionIndex: 0, actor: '' }).success).toBe(false);
  });
});

describe('decisionSummary', () => {
  it('nennt Nummer und gewählte Option', () => {
    expect(decisionSummary({ number: 12, chosenTitle: 'So lassen', freeText: null })).toBe(
      'Entscheidung #12: So lassen',
    );
  });

  it('hängt des Betreibers eigene Worte an, ohne sie umzuschreiben', () => {
    expect(
      decisionSummary({ number: 3, chosenTitle: 'Umbauen', freeText: 'aber ohne Migration' }),
    ).toBe('Entscheidung #3: Umbauen — „aber ohne Migration“');
  });

  it('kommt mit reinem Freitext aus', () => {
    expect(decisionSummary({ number: 7, chosenTitle: null, freeText: 'nimm dev' })).toBe(
      'Entscheidung #7: „nimm dev“',
    );
  });
});

describe('decisionMessage (§6.4)', () => {
  const base = {
    number: 12,
    question: 'Soll die Migration in einem Schritt laufen?',
    decidedBy: 'max',
    decidedAt: '2026-08-02T10:00:00.000Z',
  };

  it('nennt die Nummer, die Frage und wer wann entschieden hat', () => {
    const message = decisionMessage({
      ...base,
      chosen: { index: 1, title: 'In zwei Schritten', pros: ['rückrollbar'], cons: ['langsamer'] },
      freeText: null,
    });
    expect(message).toContain('#12');
    expect(message).toContain(base.question);
    expect(message).toContain('max');
    expect(message).toContain('2026-08-02T10:00:00.000Z');
  });

  it('zählt die Option so, wie sie auf der Karte steht — ab eins', () => {
    const message = decisionMessage({
      ...base,
      chosen: { index: 1, title: 'In zwei Schritten', pros: ['rückrollbar'], cons: ['langsamer'] },
      freeText: null,
    });
    // Der Index ist intern nullbasiert; der Betreiber hat die zweite Option gewählt, und
    // „Option 1" wäre in seiner Ansicht die andere gewesen.
    expect(message).toContain('option 2: In zwei Schritten');
    expect(message).toContain('rückrollbar');
    expect(message).toContain('langsamer');
  });

  it('gibt des Betreibers eigene Worte wörtlich weiter — deutsch, im englischen Rahmen (§2)', () => {
    const freeText = 'Mach es in zwei Schritten, aber ohne die Spalte zu löschen.';
    const message = decisionMessage({ ...base, chosen: null, freeText });
    expect(message).toContain(freeText);
    // Kein Umschreiben, kein Übersetzen: eine paraphrasierte Entscheidung ist
    // eine zweite Fassung derselben, die nichts synchron hält.
    expect(message).not.toContain('two steps');
  });

  it('sagt es, wenn keine Option gewählt wurde', () => {
    const message = decisionMessage({ ...base, chosen: null, freeText: 'nimm dev' });
    expect(message).toContain('did not pick one of your options');
  });

  it('verbietet dieselbe Frage ein zweites Mal — sonst antwortet §15 sich selbst', () => {
    const message = decisionMessage({
      ...base,
      chosen: { index: 0, title: 'Ja', pros: ['schnell'], cons: ['riskant'] },
      freeText: null,
    });
    expect(message).toContain('do not raise the same question again');
  });

  it('lässt die Sitzung sagen, dass die Antwort nicht reicht, statt selbst zu entscheiden', () => {
    const message = decisionMessage({
      ...base,
      chosen: { index: 0, title: 'Ja', pros: ['schnell'], cons: ['riskant'] },
      freeText: null,
    });
    // §1 Grundsatz 6: raten ist genau bei dieser Klasse von Frage verboten.
    expect(message).toContain('say so in your result and stop');
    expect(message).toContain('do not decide it for');
  });
});
