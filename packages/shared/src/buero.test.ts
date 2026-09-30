/**
 * §17.2's five bubbles, and the two properties the office turns on.
 *
 * The load-bearing case is the ordering: `deskState` decides "cannot continue"
 * before it asks whether a session is alive, because §7.3 parks a task and ends
 * its session afterwards — so a rule that asked `runLive` first would paint a
 * parked desk "arbeitet" for the length of the wrap-up. That is the one moment
 * §7.3 exists to make legible, and it is asserted rather than assumed.
 *
 * The second is totality: every member of `TASK_STATES` is walked, so a state
 * added to §9 without a bubble is a failure here rather than a desk that quietly
 * reads "ruht".
 */
import { describe, expect, it } from 'vitest';
import {
  BUERO_MAX_DESKS,
  DESK_STATE_COLORS,
  DESK_STATE_HINTS,
  DESK_STATE_LABELS,
  DESK_STATES,
  type DeskState,
  deskState,
  seatId,
  seatName,
} from './buero.js';
import { TASK_STATES, type TaskState } from './task-state.js';

function at(taskState: TaskState | null, runLive: boolean, projectReadOnly = false): DeskState {
  return deskState({ taskState, runLive, projectReadOnly });
}

describe('deskState — §9s Zustände auf §17.2s fünf Kugeln', () => {
  it('kennt für jeden Zustand aus §9 eine Kugel, mit und ohne laufende Sitzung', () => {
    for (const state of TASK_STATES) {
      for (const runLive of [true, false]) {
        const bubble = at(state, runLive);
        expect(DESK_STATES, `${state}/${runLive}`).toContain(bubble);
      }
    }
  });

  /**
   * Die Zusicherung, gegen die sich die ganze Ansicht prüfen lässt.
   *
   * „ruht" heißt: dieser Platz könnte neue Arbeit annehmen. Ein Platz mit
   * laufender Sitzung kann das nicht — und eine Sitzung, die im Büro wie nichts
   * aussieht, ist genau die Auskunft, die §7 sich nicht leisten kann.
   */
  it('malt niemals „ruht", solange eine Sitzung läuft', () => {
    for (const state of [...TASK_STATES, null]) {
      expect(at(state, true), `${state}`).not.toBe('ruht');
      expect(at(state, true, true), `${state} (nur lesbar)`).not.toBe('ruht');
    }
  });

  it('zeigt „fragt nach", wenn eine Frage im Posteingang wartet (A100s `fragend`)', () => {
    expect(at('needs_decision', true)).toBe('eskaliert');
    expect(at('needs_decision', false)).toBe('eskaliert');
    expect(at('escalated', false)).toBe('eskaliert');
  });

  /**
   * Der Fund, den die Reihenfolge verhindert.
   *
   * §7.3 beendet den atomaren Schritt, schreibt den WIP-Commit und die
   * Übergabenotiz — die Sitzung läuft in dieser Zeit noch. Wer `runLive` zuerst
   * fragt, malt genau dann „arbeitet", wenn das Studio anhält.
   */
  it('zeigt einen geparkten Platz als blockiert, auch während die Sitzung noch ausläuft', () => {
    expect(at('parked', true)).toBe('blockiert');
    expect(at('parked', false)).toBe('blockiert');
  });

  it('zeigt „blockiert" für unterbrochene und rote Aufgaben — niemand wurde gefragt', () => {
    expect(at('interrupted', true)).toBe('blockiert');
    expect(at('red', false)).toBe('blockiert');
  });

  /**
   * A119.6s dritte Blockade-Art. Sie steht *hinter* der Frage-Prüfung: ein nur
   * lesbares Projekt, dessen Aufgabe gefragt hat, wartet trotzdem auf die
   * Antwort — und „blockiert" statt „fragt nach" nähme der Betreiber genau den Hinweis,
   * dass er dran ist.
   */
  it('zeigt ein nur lesbares Projekt als blockiert, aber nicht statt einer offenen Frage', () => {
    expect(at('coding', false, true)).toBe('blockiert');
    expect(at('queued', false, true)).toBe('blockiert');
    expect(at('needs_decision', false, true)).toBe('eskaliert');
    // Fertig ist fertig: eine abgeschlossene Aufgabe auf einem gesperrten
    // Projekt ist nicht blockiert, sie ist vorbei.
    expect(at('done', false, true)).toBe('ruht');
    expect(at('aborted', false, true)).toBe('ruht');
  });

  it('zeigt „prüft" für Review und Gates — die Arbeit wird beurteilt', () => {
    expect(at('review', true)).toBe('prueft');
    expect(at('gates', true)).toBe('prueft');
  });

  it('zeigt „arbeitet" nur, solange eine Sitzung läuft', () => {
    expect(at('coding', true)).toBe('arbeitet');
    expect(at('merging', true)).toBe('arbeitet');
    expect(at('deploying', true)).toBe('arbeitet');
    // Derselbe Zustand ohne Sitzung: dieser Platz hat nichts in der Hand,
    // auch wenn die Aufgabe woanders weiterläuft.
    expect(at('coding', false)).toBe('ruht');
    expect(at('review', false)).toBe('ruht');
    expect(at('gates', false)).toBe('ruht');
  });

  it('behandelt eine Sitzung ohne Aufgabe als arbeitend, solange sie läuft (A56.5)', () => {
    expect(at(null, true)).toBe('arbeitet');
    expect(at(null, false)).toBe('ruht');
  });

  it('nennt für jede Kugel ein deutsches Etikett, einen Satz und eine Farbe', () => {
    for (const state of DESK_STATES) {
      expect(DESK_STATE_LABELS[state]).toMatch(/\S/);
      // Ein ganzer Satz, kein zweites Etikett: die beiden verwechselbaren
      // Kugeln müssen sagen, ob der Betreiber dran ist.
      expect(DESK_STATE_HINTS[state].length).toBeGreaterThan(20);
      expect(DESK_STATE_COLORS[state]).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(new Set(Object.values(DESK_STATE_LABELS)).size).toBe(DESK_STATES.length);
  });
});

describe('Sitzplätze (§8, A46.5)', () => {
  it('unterscheidet ein Profil an zwei Aufgaben, nicht zwei Läufe an einer', () => {
    expect(seatId('coder', 'a')).not.toBe(seatId('coder', 'b'));
    expect(seatId('coder', 'a')).toBe(seatId('coder', 'a'));
    expect(seatId('auditor', null)).toBe(seatId('auditor', null));
    expect(seatId('auditor', null)).not.toBe(seatId('planner', null));
  });

  it('setzt Clara und Chris an zwei Tische und nummeriert erst danach', () => {
    const clara = { name: 'Clara', alternates: ['Chris'] as const };
    expect(seatName(clara, 0)).toBe('Clara');
    expect(seatName(clara, 1)).toBe('Chris');
    // Kein zweites „Clara": falsch wäre schlimmer als schlicht.
    expect(seatName(clara, 2)).toBe('Clara 3');
    expect(seatName({ name: 'Rita' }, 1)).toBe('Rita 2');
  });

  it('deckelt das Büro auf eine Zimmergröße', () => {
    expect(BUERO_MAX_DESKS).toBeGreaterThan(4);
    expect(BUERO_MAX_DESKS).toBeLessThanOrEqual(48);
  });
});
