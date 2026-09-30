import type { BlockedTaskView } from '@vorschicht/shared';
import { describe, expect, it } from 'vitest';
import {
  blockedTasksFrom,
  type MergeQueueZeile,
  mergeCandidatesFrom,
  type OpenDecision,
} from './overview.js';

/**
 * §17.1's blocked-task list, and the property that makes the page honest.
 *
 * `buildOverview` needed a database and therefore had no unit test at all, so
 * the one rule it has to get right — one row per *task*, however many questions
 * that task has asked — lived only inside a function nothing could call cheaply.
 * The consequence shipped: the page's counter de-duplicated while the page's
 * list did not, and one task with two open questions rendered "1 Aufgabe wartet"
 * above two `<li>`s sharing a React key and a `data-testid`.
 *
 * The rule is now here, pure, and the counter is this array's length.
 */
const entscheidung = (taskId: string | null, number: number): OpenDecision => ({ taskId, number });

const titel = (paare: Array<[string, string]>) => new Map(paare);

describe('die blockierten Aufgaben auf der Übersicht', () => {
  it('macht aus zwei Fragen derselben Aufgabe genau eine Zeile', () => {
    const zeilen = blockedTasksFrom(
      [entscheidung('a', 1), entscheidung('a', 2)],
      titel([['a', 'Merge-Queue härten']]),
    );
    expect(zeilen).toEqual<BlockedTaskView[]>([
      {
        taskId: 'a',
        title: 'Merge-Queue härten',
        number: 2,
        art: 'fragend',
        haltendeAufgabe: null,
      },
    ]);
  });

  /**
   * §9s zweite Art, die es bis zur Betriebsprüfung 767db82c gar nicht gab.
   *
   * Der Gate-Satz von P4.G5 lautet „a task waiting **behind** a parked task's
   * claims displays 'blockiert durch Entscheidung #X'". Gerendert wurde
   * ausschließlich die Aufgabe, die die Frage selbst gestellt hat — die nach
   * §10 dahinter serialisierte erschien auf der Übersicht überhaupt nicht.
   */
  it('nennt auch die Aufgabe, die hinter fremden Claims wartet (§9, §15)', () => {
    const zeilen = blockedTasksFrom(
      [entscheidung('halter', 12)],
      titel([['halter', 'Migration umbauen']]),
      [
        {
          taskId: 'wartend',
          title: 'Tests nachziehen',
          blockedByTaskId: 'halter',
          blockedByTitle: 'Migration umbauen',
        },
      ],
    );
    expect(zeilen).toHaveLength(2);
    const wartend = zeilen.find((zeile) => zeile.taskId === 'wartend');
    // Die Nummer ist die des **Halters**: diese Aufgabe hat nie gefragt, und
    // eine eigene Nummer gibt es für sie nicht.
    expect(wartend).toEqual<BlockedTaskView>({
      taskId: 'wartend',
      title: 'Tests nachziehen',
      number: 12,
      art: 'blockiert',
      haltendeAufgabe: 'Migration umbauen',
    });
  });

  it('erfindet keine Zeile, wenn der Halter gar keine offene Entscheidung hat', () => {
    // Blockiert **und** „blockiert durch Entscheidung #X" sind zweierlei: eine
    // Aufgabe kann hinter einem laufenden Coder stehen, und darüber sagt §9s
    // Satz nichts. Ohne diese Bedingung stünde auf der Übersicht eine Nummer,
    // die zu dieser Blockade nicht gehört.
    expect(
      blockedTasksFrom([entscheidung('anders', 3)], titel([['anders', 'Y']]), [
        {
          taskId: 'wartend',
          title: 'Tests nachziehen',
          blockedByTaskId: 'halter-ohne-frage',
          blockedByTitle: 'Coder läuft',
        },
      ]),
    ).toEqual<BlockedTaskView[]>([
      { taskId: 'anders', title: 'Y', number: 3, art: 'fragend', haltendeAufgabe: null },
    ]);
  });

  it('zählt eine Aufgabe nur einmal, wenn sie fragt und blockiert ist', () => {
    // Möglich, sobald eine Aufgabe selbst geparkt ist und daneben hinter einer
    // dritten wartet. Zwei Zeilen wären zwei `<li>` mit demselben React-Key —
    // genau der Defekt, den A81 auf der Zählerseite behoben hat.
    const zeilen = blockedTasksFrom([entscheidung('a', 5)], titel([['a', 'Doppelt']]), [
      { taskId: 'a', title: 'Doppelt', blockedByTaskId: 'a', blockedByTitle: 'Doppelt' },
    ]);
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0]?.art).toBe('fragend');
  });

  it('nennt die neueste Frage, weil das die ist, die vor dem Betreiber liegt', () => {
    // Reversed input: the answer must not depend on the order rows arrive in.
    const zeilen = blockedTasksFrom(
      [entscheidung('a', 7), entscheidung('a', 3)],
      titel([['a', 'X']]),
    );
    expect(zeilen[0]?.number).toBe(7);
  });

  it('lässt eine Eskalation ohne Aufgabe weg, statt sie zu erfinden', () => {
    // A gate proposal or a budget anomaly is a real open item — §17.5's badge
    // counts it — and there is no task waiting behind it. Rendering it here
    // under a made-up title would answer §17.1's sentence with something that is
    // not a task.
    expect(blockedTasksFrom([entscheidung(null, 1)], titel([]))).toEqual([]);
  });

  it('behält eine Aufgabe, deren Titel unbekannt ist, und sagt es', () => {
    // Dropping it would be the dangerous direction: a *blocked* task that
    // vanishes from the overview because a join missed is exactly what this
    // list exists to prevent.
    const zeilen = blockedTasksFrom([entscheidung('geist', 4)], titel([]));
    expect(zeilen).toHaveLength(1);
    expect(zeilen[0]?.title).toBe('Aufgabe ohne Titel');
  });

  it('sortiert die neueste Frage nach oben', () => {
    const zeilen = blockedTasksFrom(
      [entscheidung('a', 1), entscheidung('b', 9), entscheidung('c', 5)],
      titel([
        ['a', 'A'],
        ['b', 'B'],
        ['c', 'C'],
      ]),
    );
    expect(zeilen.map((zeile) => zeile.number)).toEqual([9, 5, 1]);
  });

  it('ist bei nichts Offenem leer, nicht einzeilig', () => {
    expect(blockedTasksFrom([], titel([]))).toEqual([]);
  });
});

/**
 * §10s Warteschlange auf der Übersicht.
 *
 * Die tragende Zusicherung ist die **Position**, und sie ist projektintern: §10
 * serialisiert je Projekt, die Übersicht mischt alle Projekte, und eine Seite,
 * die ihre gerenderten Zeilen durchzählt, schreibt „3." an eine Aufgabe, die in
 * ihrem eigenen Projekt als erste an der Reihe ist. Genau der Grund, aus dem
 * `escalationOptionView.index` mitreist statt aus der Reihenfolge zu folgen.
 */
describe('§10s Merge-Queue auf der Übersicht', () => {
  const zeile = (taskId: string, projectId: string): MergeQueueZeile => ({
    taskId,
    title: `Aufgabe ${taskId}`,
    projectId,
    projectSlug: projectId,
    priority: 'P2',
    branch: `vorschicht/task-${taskId}`,
    enteredAt: new Date('2026-08-18T08:00:00.000Z'),
  });

  it('zählt je Projekt, nicht über die ganze Liste', () => {
    const kandidaten = mergeCandidatesFrom(
      [zeile('t1', 'alpha'), zeile('t2', 'beta'), zeile('t3', 'alpha')],
      10,
    );
    expect(kandidaten.map((k) => [k.projectId, k.position])).toEqual([
      ['alpha', 1],
      ['beta', 1],
      ['alpha', 2],
    ]);
  });

  it('behält die Reihenfolge der Sicht, statt ein zweites Mal zu sortieren', () => {
    // Migration 0012 sortiert bereits nach `priority, entered_at`. Eine zweite
    // Sortierregel hier wäre eine zweite Antwort auf „was wird als Nächstes
    // gemerged" — und die, die niemand ausführt, ist die auf dieser Seite.
    const kandidaten = mergeCandidatesFrom([zeile('spaet', 'alpha'), zeile('frueh', 'alpha')], 10);
    expect(kandidaten.map((k) => k.taskId)).toEqual(['spaet', 'frueh']);
  });

  /**
   * Erst zählen, dann deckeln. Die Position der neunten Zeile ist eine Aussage
   * über die Warteschlange und keine über die Seitengrösse — ein Deckel *vor*
   * dem Zählen wäre unsichtbar, weil beide Varianten dieselbe Liste liefern,
   * solange nichts abgeschnitten wird.
   */
  it('deckelt die Liste, ohne die Positionen zu verfälschen', () => {
    const alle = Array.from({ length: 5 }, (_, i) => zeile(`t${i}`, 'alpha'));
    const kandidaten = mergeCandidatesFrom(alle, 2);
    expect(kandidaten.map((k) => k.position)).toEqual([1, 2]);
    expect(kandidaten).toHaveLength(2);
  });

  it('gibt für eine leere Warteschlange eine leere Liste', () => {
    expect(mergeCandidatesFrom([], 8)).toEqual([]);
  });
});
