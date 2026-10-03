/**
 * §17.4's state filter offers every state once — by value *and* by label.
 *
 * `escalated` and `needs_decision` share the label "Wartet auf deine
 * Entscheidung", so the dropdown listed that sentence twice: two entries that
 * select different tasks and cannot be told apart. Found by a functional check
 * on a fresh clone.
 */
import { describe, expect, it } from 'vitest';
import { ZUSTAND_OPTIONEN } from './spuren.js';
import { TASK_STATE_LABELS, TASK_STATES } from './task-state.js';

describe('ZUSTAND_OPTIONEN', () => {
  it('bietet jeden Zustand genau einmal an', () => {
    expect(ZUSTAND_OPTIONEN.map((option) => option.wert)).toEqual([...TASK_STATES]);
  });

  it('nennt keine zwei Zustände gleich', () => {
    const labels = ZUSTAND_OPTIONEN.map((option) => option.label);
    expect(labels.filter((label, index) => labels.indexOf(label) !== index)).toEqual([]);
  });

  it('behält das Etikett der Aufgabe und hängt nur die Unterscheidung an', () => {
    for (const option of ZUSTAND_OPTIONEN) {
      expect(
        option.label.startsWith(TASK_STATE_LABELS[option.wert as keyof typeof TASK_STATE_LABELS]),
      ).toBe(true);
    }
    const label = (wert: string) => ZUSTAND_OPTIONEN.find((o) => o.wert === wert)?.label;
    expect(label('escalated')).toBe('Wartet auf deine Entscheidung (nach zweitem Fehlschlag)');
    expect(label('needs_decision')).toBe('Wartet auf deine Entscheidung (Rückfrage einer Sitzung)');
  });
});
