import { type BlockedTaskView, type DecisionView, inboxUrl } from '@vorschicht/shared/inbox';
import { describe, expect, it } from 'vitest';
import {
  ALLE_DRINGLICHKEITEN,
  antwortFehler,
  antwortNutzlast,
  blockiertHinweis,
  dringlichkeitLabel,
  type EscalationCardView,
  eskalationsNummer,
  eskalationsPfad,
  POSTEINGANG_PFAD,
  passtZurDringlichkeit,
  passtZurSuche,
  wartendeText,
  zeitpunkt,
} from './inbox-format.js';
import { segmentAfter } from './router.js';

/**
 * The two Phase 4 exit gates this file stands behind are both about wording
 * and about a link, so the assertions are on exact strings rather than on
 * "contains something". A counter that says "3 Aufgaben" while three *items*
 * are open is the failure being defended against, and a loose assertion would
 * not see it.
 */

const entscheidung = (over: Partial<DecisionView> = {}): DecisionView => ({
  escalationId: 'e1',
  number: 12,
  source: 'agent_question',
  sourceLabel: 'Frage aus einer Sitzung',
  question: 'Darf der Bot auf main pushen?',
  summary: 'Nein — nur über die Merge-Queue.',
  options: [],
  chosenIndex: null,
  chosenTitle: null,
  freeText: null,
  decidedAt: '2026-08-02T09:00:00.000Z',
  decidedBy: 'max',
  taskId: 'Merge-Queue härten',
  projectId: 'vorschicht',
  ...over,
});

describe('der Deep-Link auf eine Karte', () => {
  it('schreibt den Pfad, den der Leser wieder zerlegt', () => {
    // The round trip is the assertion. Either half alone would pass with a
    // link the inbox cannot read — which renders as "Kein Eintrag mit dieser
    // Nummer", i.e. exactly like a decision that has already been answered.
    //
    // The middle step is the **real** `segmentAfter`, not a `slice` standing in
    // for it. It used to be the stand-in, because `tsconfig.test.json` compiled
    // this file without the DOM library and `router.ts` touches `window`. That
    // exclusion is now the other way round (see that file), and the first thing
    // the real import found is the case below.
    const pfad = eskalationsPfad(42);
    expect(pfad).toBe('/posteingang/42');
    expect(eskalationsNummer(segmentAfter(pfad, POSTEINGANG_PFAD))).toBe(42);
  });

  it('überlebt einen Pfad, den `decodeURIComponent` nicht lesen kann', () => {
    // `/posteingang/%` raises `URIError`. `segmentAfter` runs during render with
    // no boundary between it and the root, so this used to blank the entire
    // dashboard — not the page, the application. It must come back as "not a
    // number" and let the page say so.
    expect(() => segmentAfter('/posteingang/%', POSTEINGANG_PFAD)).not.toThrow();
    expect(eskalationsNummer(segmentAfter('/posteingang/%', POSTEINGANG_PFAD))).toBeNull();
    expect(eskalationsNummer(segmentAfter('/posteingang/%E0%A4%A', POSTEINGANG_PFAD))).toBeNull();
  });

  it('liest die Nummer aus genau dem Pfad zurück, den eine Benachrichtigung verschickt', () => {
    // The one assertion that spans the two packages, and the only one that
    // could have caught the defect it exists for: `inboxUrl` built `/inbox/<n>`
    // while the router answered `/posteingang`, so every ntfy push and every
    // reminder mail linked to the overview instead of to the card. Each side's
    // own tests were green about its own literal.
    const url = new URL(inboxUrl('https://vorschicht.example', 42));
    expect(eskalationsNummer(segmentAfter(url.pathname, POSTEINGANG_PFAD))).toBe(42);
  });

  it('erkennt die Listenseite als „keine Nummer"', () => {
    expect(eskalationsNummer(null)).toBeNull();
  });

  it('weist alles zurück, was nur beinahe eine Nummer ist', () => {
    // `parseInt` would answer 42 for the first two and open a neighbouring
    // decision instead of admitting it does not know which one is meant.
    for (const kaputt of ['42abc', '4.2', '-1', '0', '', ' 42', '42 ', '+7', '٤٢']) {
      expect(eskalationsNummer(kaputt)).toBeNull();
    }
  });
});

describe('blockiertHinweis', () => {
  it('sagt §15s Satz wörtlich', () => {
    expect(blockiertHinweis(7)).toBe('blockiert durch Entscheidung #7');
  });
});

describe('der Zähler auf der Übersicht', () => {
  const aufgabe = (
    id: string,
    entscheidungsnummer: number,
    art: BlockedTaskView['art'] = 'fragend',
  ): BlockedTaskView => ({
    taskId: id,
    title: `Aufgabe ${id}`,
    number: entscheidungsnummer,
    art,
    haltendeAufgabe: art === 'blockiert' ? 'Aufgabe halter' : null,
  });

  it('schweigt, wenn nichts offen ist', () => {
    expect(wartendeText(0)).toBeNull();
    expect(wartendeText(0, [])).toBeNull();
  });

  it('schweigt auch, wenn das Feld gar nicht mitgeliefert wurde', () => {
    // The half-shipped API is the realistic case, and a sentence with
    // "undefined" in it is worse than no sentence.
    expect(wartendeText(undefined)).toBeNull();
    expect(wartendeText(Number.NaN)).toBeNull();
  });

  it('zählt offene Einträge als Einträge, nicht als Aufgaben', () => {
    expect(wartendeText(1)).toBe('1 Entscheidung wartet auf dich');
    expect(wartendeText(3)).toBe('3 Entscheidungen warten auf dich');
  });

  it('sagt §15s Satz, sobald die blockierten Aufgaben bekannt sind', () => {
    expect(wartendeText(9, [aufgabe('a', 1)])).toBe('1 Aufgabe wartet auf deine Entscheidung');
    expect(wartendeText(9, [aufgabe('a', 1), aufgabe('b', 1)])).toBe(
      '2 Aufgaben warten auf deine Entscheidung',
    );
  });

  it('zählt beide Arten wartender Aufgaben (§9, §15)', () => {
    // Die fragende Aufgabe *und* die, die hinter ihren Claims steht. Bis zur
    // Betriebsprüfung 767db82c kannte die Übersicht nur die erste, und die
    // zweite verschwand — obwohl §15 ihre Sichtbarkeit ausdrücklich als
    // Gegengewicht dazu wählt, dass eine Entscheidung keine Frist hat.
    expect(wartendeText(1, [aufgabe('a', 4), aufgabe('b', 4, 'blockiert')])).toBe(
      '2 Aufgaben warten auf deine Entscheidung',
    );
  });

  it('zählt genau so viele Aufgaben, wie die Seite Zeilen zeigt', () => {
    // The number is the list's length and nothing else. It used to be a `Set`
    // built here while the page rendered the raw rows, so one task with two
    // open questions said "1 Aufgabe wartet" above two `<li>`s sharing a React
    // key and a `data-testid`. The de-duplication now happens once, on the
    // server, and this asserts the property that replaced it.
    const liste = [aufgabe('a', 1), aufgabe('b', 2), aufgabe('c', 3)];
    expect(wartendeText(9, liste)).toBe(`${liste.length} Aufgaben warten auf deine Entscheidung`);
  });
});

describe('was abgeschickt wird', () => {
  it('schickt die gewählte Option als Index, so wie der Server sie nimmt', () => {
    // `optionIndex`, not `optionId`. The form used to post `{ optionId: 'b' }`
    // against a schema that takes `optionIndex`, so no answer could ever have
    // been accepted.
    expect(antwortNutzlast({ optionIndex: 1, freitext: '   ' })).toEqual({
      ok: true,
      nutzlast: { optionIndex: 1 },
    });
  });

  it('nimmt auch die erste Option, deren Index 0 ist', () => {
    // `if (option)` was falsy for index 0, so the recommendation — which is
    // usually the first option — would have been sent as an empty answer.
    expect(antwortNutzlast({ optionIndex: 0, freitext: '' })).toEqual({
      ok: true,
      nutzlast: { optionIndex: 0 },
    });
  });

  it('schickt den Freitext beschnitten, aber unverändert', () => {
    expect(antwortNutzlast({ optionIndex: null, freitext: '  Mach Variante C.  ' })).toEqual({
      ok: true,
      nutzlast: { freeText: 'Mach Variante C.' },
    });
  });

  it('verweigert leer', () => {
    const ergebnis = antwortNutzlast({ optionIndex: null, freitext: '\n  ' });
    expect(ergebnis.ok).toBe(false);
    expect(ergebnis.ok === false && ergebnis.fehler[0]).toContain('leer');
  });

  it('verweigert beides zusammen, statt die Worte fallen zu lassen', () => {
    // The dangerous alternative is to send the option and drop the text.
    // Nothing downstream would report that; the operator would simply never see his
    // sentence again.
    const ergebnis = antwortNutzlast({ optionIndex: 0, freitext: 'aber bitte ohne Migration' });
    expect(ergebnis.ok).toBe(false);
    expect(ergebnis.ok === false && ergebnis.fehler.join(' ')).toContain('Entweder eine Option');
  });
});

describe('warum der Server abgelehnt hat', () => {
  it('erklärt den 409 als „schon beantwortet"', () => {
    expect(antwortFehler(409, null)[0]).toContain('beantwortet');
  });

  it('reicht die Gründe eines 422 durch', () => {
    expect(antwortFehler(422, { errors: ['Unbekannte Option', 'Zu lang'] })).toEqual([
      'Unbekannte Option',
      'Zu lang',
    ]);
  });

  it('gibt nie eine leere Liste zurück', () => {
    // An empty list renders as nothing, and nothing on this page reads as
    // "gespeichert".
    for (const body of [null, {}, { errors: [] }, { errors: 'kaputt' }, { errors: [1, 2] }]) {
      expect(antwortFehler(422, body)).toHaveLength(1);
      expect(antwortFehler(422, body)[0]).toContain('ohne einen Grund');
    }
  });

  it('nennt jeden anderen Status beim Namen', () => {
    expect(antwortFehler(500, null)).toEqual(['Serverfehler 500']);
  });
});

describe('die Suche im Entscheidungsprotokoll', () => {
  it('zeigt ohne Suchbegriff alles', () => {
    expect(passtZurSuche(entscheidung(), '')).toBe(true);
    expect(passtZurSuche(entscheidung(), '   ')).toBe(true);
  });

  it('sucht ohne Rücksicht auf Groß- und Kleinschreibung', () => {
    expect(passtZurSuche(entscheidung(), 'MERGE-QUEUE')).toBe(true);
  });

  it('verlangt alle Begriffe, nicht irgendeinen', () => {
    // An OR would make the second word widen the result: type two words, get
    // more rows than with one, which is the opposite of searching a log.
    expect(passtZurSuche(entscheidung(), 'push main')).toBe(true);
    expect(passtZurSuche(entscheidung(), 'push rollback')).toBe(false);
  });

  it('findet die Nummer mit und ohne Raute', () => {
    expect(passtZurSuche(entscheidung({ number: 42 }), '#42')).toBe(true);
    expect(passtZurSuche(entscheidung({ number: 42 }), '42')).toBe(true);
    expect(passtZurSuche(entscheidung({ number: 42 }), '#43')).toBe(false);
  });

  it('kommt mit fehlender Aufgabe und fehlendem Projekt zurecht', () => {
    expect(passtZurSuche(entscheidung({ taskId: null, projectId: null }), 'main')).toBe(true);
    expect(passtZurSuche(entscheidung({ taskId: null, projectId: null }), 'vorschicht')).toBe(
      false,
    );
  });
});

describe('der Dringlichkeitsfilter', () => {
  const karte = (urgency: EscalationCardView['urgency']) => ({ urgency }) as EscalationCardView;

  it('lässt bei „alle" jede Karte durch', () => {
    for (const stufe of ['P0', 'P1', 'P2', 'P3'] as const) {
      expect(passtZurDringlichkeit(karte(stufe), ALLE_DRINGLICHKEITEN)).toBe(true);
    }
  });

  it('lässt genau eine Stufe durch', () => {
    expect(passtZurDringlichkeit(karte('P0'), 'P0')).toBe(true);
    expect(passtZurDringlichkeit(karte('P2'), 'P0')).toBe(false);
  });
});

describe('Beschriftungen', () => {
  it('übersetzt P0 bis P3', () => {
    expect(dringlichkeitLabel('P0')).toBe('P0 — sofort');
    expect(dringlichkeitLabel('P3')).toBe('P3 — wenn Zeit ist');
  });

  it('zeigt eine unbekannte Dringlichkeit unverändert, statt sie zu erfinden', () => {
    expect(dringlichkeitLabel('P9')).toBe('P9');
  });

  it('gibt einen unlesbaren Zeitpunkt zurück, statt „Invalid Date" zu zeigen', () => {
    expect(zeitpunkt('irgendwann')).toBe('irgendwann');
    expect(zeitpunkt('2026-08-02T09:00:00.000Z')).toContain('2026');
  });
});
