/**
 * The two pure pieces of §9's red policy.
 *
 * The rest of `RedPath` needs a database and a runner and is exercised through
 * the dev chain (`dev-chain.itest.ts`); these two are decisions in their own
 * right and cheap to pin down here.
 */
import { raiseEscalationInput } from '@vorschicht/shared';
import { describe, expect, it } from 'vitest';
import { learningsNote, lowerPriority, redPathEscalation } from './red-path.js';

describe('lowerPriority (§9)', () => {
  it('senkt um genau eine Stufe', () => {
    expect(lowerPriority('P0')).toBe('P1');
    expect(lowerPriority('P1')).toBe('P2');
    expect(lowerPriority('P2')).toBe('P3');
  });

  it('bleibt bei der untersten Stufe stehen, statt zu überlaufen', () => {
    // §9 senkt bei jedem Fehlschlag; ohne diesen Boden liefe der Index aus der
    // Liste und die Priorität würde undefiniert — und eine Aufgabe ohne
    // Priorität sortiert die Warteschlange falsch, statt laut zu scheitern.
    expect(lowerPriority('P3')).toBe('P3');
  });
});

describe('learningsNote (§9)', () => {
  it('nennt den Fehler und was der Versuch gelernt hat', () => {
    const text = learningsNote('Der Bau schlägt fehl.', ['Abhängigkeit fehlt', 'Test ist grün']);
    expect(text).toContain('Fehlgeschlagen: Der Bau schlägt fehl.');
    expect(text).toContain('- Abhängigkeit fehlt');
    expect(text).toContain('- Test ist grün');
  });

  it('lässt den Lehren-Abschnitt weg, wenn es keine gibt', () => {
    const text = learningsNote('Unklar.', []);
    expect(text).not.toContain('gelernt hat');
    expect(text).toContain('gesenkter Priorität');
  });
});

describe('redPathEscalation (§9 → §15)', () => {
  const base = {
    title: 'Cache-Invalidierung reparieren',
    problem: 'Der Test bleibt rot.',
    diagnosis: null as string | null,
    diagnosisProblem: null as string | null,
    followups: [] as string[],
    retryCount: 2,
  };

  it('erfüllt §15s Form: 2–4 Optionen, je Vor- und Nachteil, genau eine Empfehlung', () => {
    // Dieselbe Regel, die `raiseEscalationInput` erzwingt — hier geprüft, weil
    // eine Karte, die der Dienst zurückweist, §9s zweiten Fehlschlag ins Leere
    // laufen ließe: die Aufgabe stünde auf `escalated` und niemand bekäme sie.
    for (const diagnosis of [null, 'Der Cache-Schlüssel enthält die Zeitzone.']) {
      const card = redPathEscalation({ ...base, diagnosis });
      expect(card.options.length).toBeGreaterThanOrEqual(2);
      expect(card.options.length).toBeLessThanOrEqual(4);
      expect(card.options.filter((o) => o.recommended)).toHaveLength(1);
      for (const option of card.options) {
        expect(option.pros.length).toBeGreaterThan(0);
        expect(option.cons.length).toBeGreaterThan(0);
      }
    }
  });

  it('empfiehlt einen neuen Anlauf, wenn es einen Befund gibt', () => {
    const card = redPathEscalation({ ...base, diagnosis: 'Der Schlüssel enthält die Zeitzone.' });
    expect(card.options.find((o) => o.recommended)?.title).toBe('Erneut versuchen');
    expect(card.context).toContain('Der Schlüssel enthält die Zeitzone.');
  });

  it('empfiehlt einen neuen Zuschnitt, wenn es keinen gibt', () => {
    // Ohne Befund wäre ein dritter Anlauf derselbe Versuch noch einmal. Das ist
    // die einzige Urteilsfrage in dieser Funktion, und sie hängt an genau
    // diesem Unterschied.
    const card = redPathEscalation({
      ...base,
      diagnosis: null,
      diagnosisProblem: 'Kein Arbeitsverzeichnis mehr vorhanden',
    });
    expect(card.options.find((o) => o.recommended)?.title).toBe('Aufgabe neu zuschneiden');
    expect(card.context).toContain('Kein Arbeitsverzeichnis mehr vorhanden');
  });

  it('trägt die Vorschläge der Fehlersuche in den Kontext, nicht in die Optionen', () => {
    // §9 verlangt "MC options"; die Fehlersuche liefert Freitext. Aus einem
    // Freitext ehrliche Vor- und Nachteile abzuleiten geht nicht, also stehen
    // die Vorschläge dort, wo sie stimmen, und die Optionen sind das, was der Betreiber
    // mit einer zweimal gescheiterten Aufgabe wirklich tun kann.
    const card = redPathEscalation({
      ...base,
      diagnosis: 'Race im Invalidierungspfad.',
      followups: ['Sperre um den Schreibpfad', 'Test entkoppeln'],
    });
    expect(card.context).toContain('Sperre um den Schreibpfad');
    expect(card.options.map((o) => o.title)).not.toContain('Sperre um den Schreibpfad');
  });

  it('nennt die Aufgabe beim Namen und sagt, dass die Ansprüche gehalten werden', () => {
    const card = redPathEscalation(base);
    expect(card.question).toContain('Cache-Invalidierung reparieren');
    expect(card.context).toContain('Dateiansprüche');
  });

  it('bleibt innerhalb der Längengrenzen, die der Dienst durchsetzt', () => {
    // Ein sehr langer Aufgabentitel darf die Karte nicht unabsendbar machen.
    const card = redPathEscalation({
      ...base,
      title: 'T'.repeat(400),
      problem: 'P'.repeat(4_000),
      diagnosis: 'D'.repeat(4_000),
      followups: ['F'.repeat(2_000)],
    });
    expect(
      raiseEscalationInput.safeParse({
        source: 'task_red',
        question: card.question,
        context: card.context,
        options: card.options,
        urgency: 'P1',
        raisedBy: 'orchestrator',
      }).success,
    ).toBe(true);
  });
});
