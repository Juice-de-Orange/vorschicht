import { describe, expect, it } from 'vitest';
import {
  ACTIVE_TASK_STATES,
  canTransition,
  IN_FLIGHT_TASK_STATES,
  isSuspendedTaskState,
  SUSPENDED_TASK_STATES,
  TASK_STATE_LABELS,
  TASK_STATES,
  TASK_TRANSITIONS,
  type TaskState,
  TERMINAL_TASK_STATES,
} from './task-state.js';

describe('Aufgaben-Zustandsmaschine (§9)', () => {
  describe('Struktur der Übergangstabelle', () => {
    it('kennt jeden Zustand als Ausgangspunkt', () => {
      expect(Object.keys(TASK_TRANSITIONS).sort()).toEqual([...TASK_STATES].sort());
    });

    it('nennt nur bekannte Zustände als Ziel', () => {
      for (const [from, targets] of Object.entries(TASK_TRANSITIONS)) {
        for (const to of targets) {
          expect(TASK_STATES, `${from} → ${to}`).toContain(to);
        }
      }
    });

    it('führt aus Endzuständen nirgendwohin', () => {
      for (const state of TERMINAL_TASK_STATES) {
        expect(TASK_TRANSITIONS[state]).toEqual([]);
      }
    });

    it('erreicht jeden Zustand außer dem Startzustand von irgendwoher', () => {
      const reachable = new Set(Object.values(TASK_TRANSITIONS).flat());
      for (const state of TASK_STATES) {
        if (state === 'draft') continue;
        expect(reachable, `${state} ist von keinem Zustand aus erreichbar`).toContain(state);
      }
    });

    it('lässt aus jedem nicht-endgültigen Zustand einen Ausweg', () => {
      for (const state of TASK_STATES) {
        if ((TERMINAL_TASK_STATES as readonly TaskState[]).includes(state)) continue;
        expect(TASK_TRANSITIONS[state].length, `${state} ist eine Sackgasse`).toBeGreaterThan(0);
      }
    });

    it('erlaubt aus jedem Zustand außer den Endzuständen den Abbruch', () => {
      // §10 releases claims on merge or abort. A state with no route to
      // `aborted` would hold its claims forever and block the whole area.
      for (const state of TASK_STATES) {
        if ((TERMINAL_TASK_STATES as readonly TaskState[]).includes(state)) continue;
        expect(TASK_TRANSITIONS[state], `${state} kann nicht abgebrochen werden`).toContain(
          'aborted',
        );
      }
    });

    it('beschriftet jeden Zustand auf Deutsch (§2)', () => {
      for (const state of TASK_STATES) {
        expect(TASK_STATE_LABELS[state]).toBeTruthy();
      }
    });

    it('nennt nur aktive Zustände als "in Arbeit"', () => {
      for (const state of IN_FLIGHT_TASK_STATES) {
        expect(ACTIVE_TASK_STATES as readonly TaskState[], state).toContain(state);
      }
      // The two that are active but idle. If one of them ever slipped in here,
      // every orchestrator restart would spend a Debugger session on a task
      // whose worktree nobody had touched.
      expect(IN_FLIGHT_TASK_STATES as readonly TaskState[]).not.toContain('claimed');
      expect(IN_FLIGHT_TASK_STATES as readonly TaskState[]).not.toContain('merge_queue');
    });

    it('kann jede in Arbeit befindliche Aufgabe unterbrechen', () => {
      for (const state of IN_FLIGHT_TASK_STATES) {
        expect(TASK_TRANSITIONS[state], `${state} kann nicht unterbrochen werden`).toContain(
          'interrupted',
        );
      }
    });

    it('kann jede aktive Aufgabe parken', () => {
      // §7.3 walks exactly these states; one that could not be parked would be
      // the one the guardian has to kill mid-edit.
      for (const state of ACTIVE_TASK_STATES) {
        expect(TASK_TRANSITIONS[state], `${state} kann nicht geparkt werden`).toContain('parked');
      }
    });
  });

  describe('canTransition', () => {
    const plain = (state: TaskState) => ({ state, resumeState: null });

    it('lässt den Weg durch die Kette zu', () => {
      const chain: Array<[TaskState, TaskState]> = [
        ['draft', 'queued'],
        ['queued', 'planning'],
        ['planning', 'claimed'],
        ['claimed', 'coding'],
        ['coding', 'review'],
        ['review', 'gates'],
        ['gates', 'merge_queue'],
        ['merge_queue', 'merging'],
        ['merging', 'deploying'],
        ['deploying', 'done'],
      ];
      for (const [from, to] of chain) {
        expect(canTransition(plain(from), to), `${from} → ${to}`).toEqual({ ok: true });
      }
    });

    it('weist einen Sprung über die Kette hinweg ab', () => {
      const verdict = canTransition(plain('queued'), 'merging');
      expect(verdict.ok).toBe(false);
      expect(verdict.ok === false && verdict.reason).toMatch(/nicht vorgesehen/);
    });

    it('lässt aus einem Endzustand nichts mehr zu', () => {
      expect(canTransition(plain('done'), 'queued').ok).toBe(false);
      expect(canTransition(plain('aborted'), 'queued').ok).toBe(false);
    });

    describe('Fortsetzung aus den Wartezuständen', () => {
      it('kehrt genau zum gemerkten Punkt zurück', () => {
        for (const suspended of SUSPENDED_TASK_STATES) {
          const position = {
            state: suspended as TaskState,
            resumeState: 'coding' as TaskState,
            integrityChecked: true,
          };
          expect(canTransition(position, 'coding'), suspended).toEqual({ ok: true });
        }
      });

      it('weist jede andere Rückkehr ab, auch eine erlaubte aussehende', () => {
        // `review` is a perfectly legal state and a legal edge out of `parked`
        // in the coarse map — but not for *this* task, which was parked while
        // coding. Resuming there would skip the work in the worktree.
        const verdict = canTransition({ state: 'parked', resumeState: 'coding' }, 'review');
        expect(verdict.ok).toBe(false);
        expect(verdict.ok === false && verdict.reason).toMatch(/coding/);
      });

      it('verweigert die Fortsetzung ohne gemerkten Rückkehrpunkt', () => {
        const verdict = canTransition({ state: 'parked', resumeState: null }, 'coding');
        expect(verdict.ok).toBe(false);
        expect(verdict.ok === false && verdict.reason).toMatch(/Rückkehrpunkt/);
      });

      it('lässt den Abbruch aus jedem Wartezustand zu', () => {
        for (const suspended of SUSPENDED_TASK_STATES) {
          expect(
            canTransition({ state: suspended as TaskState, resumeState: 'coding' }, 'aborted'),
          ).toEqual({ ok: true });
        }
      });
    });

    describe('Unterbrochene Arbeit (§7.2)', () => {
      it('darf ohne Integritätsprüfung nicht weiterlaufen', () => {
        const verdict = canTransition(
          { state: 'interrupted', resumeState: 'coding', integrityChecked: false },
          'coding',
        );
        expect(verdict.ok).toBe(false);
        expect(verdict.ok === false && verdict.reason).toMatch(/Integritätsprüfung/);
      });

      it('darf nach bestandener Prüfung weiterlaufen', () => {
        expect(
          canTransition(
            { state: 'interrupted', resumeState: 'coding', integrityChecked: true },
            'coding',
          ),
        ).toEqual({ ok: true });
      });

      it('darf auch ohne Prüfung rot werden, wenn der Worktree hinüber ist', () => {
        expect(
          canTransition(
            { state: 'interrupted', resumeState: 'coding', integrityChecked: false },
            'red',
          ),
        ).toEqual({ ok: true });
      });
    });

    describe('Roter Pfad (§9)', () => {
      it('führt zurück in die Warteschlange und von dort zur Eskalation', () => {
        expect(canTransition(plain('red'), 'queued')).toEqual({ ok: true });
        expect(canTransition(plain('red'), 'escalated')).toEqual({ ok: true });
      });

      it('lässt eine beantwortete Eskalation wieder in die Warteschlange', () => {
        expect(canTransition(plain('escalated'), 'queued')).toEqual({ ok: true });
      });

      it('erklärt einen unterbrochenen Lauf nicht zum Fehlschlag', () => {
        // The distinction §7.2 insists on: interrupted work is a re-check state.
        expect(isSuspendedTaskState('interrupted')).toBe(true);
        expect(TASK_TRANSITIONS.parked).not.toContain('red');
      });
    });

    it('erlaubt den Abschluss direkt nach dem Merge, wenn es kein Deployment gibt (A24)', () => {
      expect(canTransition(plain('merging'), 'done')).toEqual({ ok: true });
    });
  });
});
