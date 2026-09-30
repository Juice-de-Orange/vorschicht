/**
 * The Sources page's rules, where a unit test can reach them.
 *
 * `apps/web` has no DOM test environment, so everything about §17.7 that can be
 * wrong without a browser noticing lives in `quellen-format.ts` and is asserted
 * here; the browser suite covers what only a browser can (the history really
 * rendering, a curation really travelling). The two halves are deliberately not
 * the same assertions.
 *
 * The load-bearing ones are the parse and the act table. The parse is what turns
 * a contract violation into a German sentence instead of `undefined` in the DOM
 * (A81), and replacing it with a cast is the mutation this module exists to make
 * observable. The act table is what keeps the page from offering a button the
 * route answers with a 409.
 */
import { describe, expect, it } from 'vitest';
import {
  ALLE,
  filterUrl,
  kuratierPlan,
  LEERER_FILTER,
  leerText,
  leseQuelle,
  leseQuellen,
  punktzahl,
  QUELLEN_PFAD,
  quellenFehler,
  quellenKennung,
  quellenPfad,
  type SourceEventView,
  type SourceView,
  stufenText,
  verlaufsBegruendung,
  verlaufszeile,
  zitierbarkeit,
} from './quellen-format.js';

const ID = '11111111-2222-4333-8444-555555555555';

function quelle(over: Partial<SourceView> = {}): SourceView {
  return {
    id: ID,
    url: 'https://www.ris.bka.gv.at/Vereinsgesetz',
    documentId: null,
    title: 'RIS — Vereinsgesetz 2002',
    assessment: 'Amtliche Fassung.',
    proposedLevel: 5,
    level: null,
    state: 'proposed',
    stateLabel: 'vorgeschlagen',
    stateReason: null,
    levelReason: null,
    proposedAt: '2026-08-01T10:00:00.000Z',
    proposedBy: 'Recht',
    curatedAt: null,
    curatedBy: null,
    score: null,
    acts: ['accept', 'reject'],
    citable: false,
    ...over,
  };
}

function eintrag(over: Partial<SourceEventView> = {}): SourceEventView {
  return {
    seq: 2,
    kind: 'accepted',
    label: 'aufgenommen auf L4',
    occurredAt: '2026-08-02T09:00:00.000Z',
    actor: 'dashboard:kredential-7',
    level: 4,
    reason: null,
    note: null,
    ...over,
  };
}

describe('Der Weg in die Quellenseite und wieder heraus', () => {
  it('nimmt nur eine uuid als Kennung an', () => {
    expect(quellenKennung(ID)).toBe(ID);
    expect(quellenKennung('kaputt')).toBeNull();
    expect(quellenKennung('')).toBeNull();
    expect(quellenKennung(null)).toBeNull();
  });

  it('baut den Dauerlink aus einer Stelle', () => {
    expect(quellenPfad(ID)).toBe(`${QUELLEN_PFAD}/${ID}`);
    // Round trip: what the list links to is what the page reads back. The one
    // time this project wrote a path in two packages, every deep link landed on
    // the wrong page (A81.3).
    expect(quellenKennung(quellenPfad(ID).slice(QUELLEN_PFAD.length + 1))).toBe(ID);
  });
});

describe('Eine Antwort wird gelesen, nicht behauptet', () => {
  it('liest eine Liste und eine Quelle aus ihrer Hülle', () => {
    const liste = leseQuellen({ quellen: [quelle()] });
    expect(liste.ok).toBe(true);
    if (liste.ok) expect(liste.wert.quellen[0]?.title).toBe('RIS — Vereinsgesetz 2002');

    const eine = leseQuelle({ quelle: { source: quelle(), history: [eintrag()] } });
    expect(eine.ok).toBe(true);
    if (eine.ok) expect(eine.wert.history).toHaveLength(1);
  });

  it('sagt auf Deutsch, wenn die Antwort nicht die vereinbarte Form hat', () => {
    // The shape the inbox actually shipped once: the envelope key was different
    // and the page rendered the envelope as a row.
    const gelesen = leseQuellen({ sources: [] });
    expect(gelesen.ok).toBe(false);
    if (!gelesen.ok) {
      expect(gelesen.fehler).toContain('vereinbarte Form');
      expect(gelesen.fehler).not.toMatch(/\b(expected|invalid|required)\b/i);
    }
  });
});

describe('Warum der Server abgelehnt hat', () => {
  it('zitiert die Sätze des Servers, statt sie neu zu formulieren', () => {
    expect(quellenFehler(422, { errors: ['Ohne Begründung geht das nicht.'] })).toEqual([
      'Ohne Begründung geht das nicht.',
    ]);
  });

  it('erfindet einen Satz nur, wo die Antwort keinen trägt', () => {
    // A proxy's 502 carries no JSON at all, and a page that said nothing there
    // would look like it had worked.
    expect(quellenFehler(409, null)[0]).toContain('älteren Stand');
    expect(quellenFehler(401, null)[0]).toContain('Sitzung');
    expect(quellenFehler(502, null)[0]).toContain('502');
    expect(quellenFehler(422, { errors: [] })[0]).toContain('422');
  });
});

describe('Was auf einer Zeile steht', () => {
  it('nennt Stufe und Klasse, weil die Nummer allein nichts sagt', () => {
    expect(stufenText(4)).toBe('L4 — Herstellerdokumentation und anerkannte Normungsgremien');
    expect(stufenText(null)).toBe('noch ohne Stufe');
  });

  it('schreibt die Punktzahl deutsch und unterscheidet „keine" von null', () => {
    expect(punktzahl(4.4712)).toBe('4,47');
    expect(punktzahl(null)).toContain('nicht im Register');
  });

  it('setzt Urheber und Zeit neben das Ereigniswort, die Begründung auf eine eigene Zeile', () => {
    const zeile = verlaufszeile(eintrag({ label: 'auf L5 gesetzt', level: 5 }));
    expect(zeile).toContain('auf L5 gesetzt');
    expect(zeile).toContain('dashboard:kredential-7');
    // The reason is §14's evidence and is prose of arbitrary length — a clause
    // at the end of the line would bury it.
    expect(zeile).not.toContain('Amtlicher Volltext');
    expect(verlaufsBegruendung(eintrag({ reason: 'Amtlicher Volltext.' }))).toBe(
      'Amtlicher Volltext.',
    );
    expect(verlaufsBegruendung(eintrag({ note: 'geprüft' }))).toBe('geprüft');
    expect(verlaufsBegruendung(eintrag())).toBeNull();
    expect(verlaufsBegruendung(eintrag({ reason: '   ' }))).toBeNull();
  });

  it('rendert §14s Zitierregel aus dem Merkmal des Servers, statt sie neu herzuleiten', () => {
    expect(zitierbarkeit(quelle({ state: 'accepted', level: 4, citable: true }))).toContain(
      'Zitierfähig',
    );
    const schwach = zitierbarkeit(quelle({ state: 'accepted', level: 3, citable: false }));
    expect(schwach).toContain('Nicht zitierfähig');
    expect(schwach).toContain('L4');
  });
});

describe('Der Filter', () => {
  it('baut die URL über den Builder des Vertrags', () => {
    expect(filterUrl(LEERER_FILTER)).toBe('/api/quellen');
    expect(filterUrl({ zustand: 'accepted', abStufe: '4' })).toBe(
      '/api/quellen?zustand=accepted&abstufe=4',
    );
  });

  it('lässt einen unbrauchbaren Wert fallen, statt die Seite abzulehnen', () => {
    // A list is a view: a mistyped bookmark costs a wider answer at worst, and
    // an error screen there would be the wrong direction.
    expect(filterUrl({ zustand: 'erfunden', abStufe: '9' })).toBe('/api/quellen');
    expect(filterUrl({ zustand: ALLE, abStufe: ALLE })).toBe('/api/quellen');
  });

  it('unterscheidet ein leeres Register von einem Filter, der alles verbirgt', () => {
    expect(leerText(LEERER_FILTER)).toContain('noch keine Quelle');
    expect(leerText({ zustand: 'accepted', abStufe: ALLE })).toContain('Filter');
  });
});

describe('Was abgeschickt wird', () => {
  it('schickt Stufe und Notiz beim Aufnehmen, die Notiz nur wenn es eine gibt', () => {
    const mit = kuratierPlan(quelle(), 'accept', { stufe: '4', grund: 'geprüft' });
    expect(mit).toMatchObject({ ok: true, koerper: { level: 4, note: 'geprüft' } });

    const ohne = kuratierPlan(quelle(), 'accept', { stufe: '4', grund: '   ' });
    expect(ohne.ok).toBe(true);
    // Absent rather than `""`: an acceptance's reasoning is the department's
    // assessment, which is already on the record.
    if (ohne.ok) expect('note' in ohne.koerper).toBe(false);
  });

  it('verlangt eine Begründung, wo §14 sie zum Beleg macht', () => {
    for (const akt of ['reject', 'retire'] as const) {
      const plan = kuratierPlan(
        quelle({ state: akt === 'reject' ? 'proposed' : 'accepted' }),
        akt,
        {
          stufe: '',
          grund: '  ',
        },
      );
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.fehler[0]).toContain('Begründung');
    }
  });

  it('verlangt bei einer Stufenänderung beides', () => {
    const angenommen = quelle({ state: 'accepted', level: 4, acts: ['level', 'retire'] });
    const ohneGrund = kuratierPlan(angenommen, 'level', { stufe: '5', grund: '' });
    expect(ohneGrund.ok).toBe(false);

    const ohneStufe = kuratierPlan(angenommen, 'level', { stufe: 'sieben', grund: 'weil' });
    expect(ohneStufe.ok).toBe(false);
    if (!ohneStufe.ok) expect(ohneStufe.fehler[0]).toContain('L1 bis L5');

    const gut = kuratierPlan(angenommen, 'level', { stufe: '5', grund: 'Amtlicher Volltext.' });
    expect(gut).toMatchObject({
      ok: true,
      url: `/api/quellen/${ID}/stufe`,
      koerper: { level: 5, reason: 'Amtlicher Volltext.' },
    });
  });

  it('schickt gar nichts für einen Akt, den der Zustand nicht zulässt', () => {
    // The page renders only `source.acts`, so this branch is the second layer —
    // and it is the one that still holds if a form is left standing while the
    // source underneath moves on.
    const plan = kuratierPlan(quelle({ state: 'accepted', level: 4 }), 'accept', {
      stufe: '5',
      grund: '',
    });
    expect(plan.ok).toBe(false);
    if (!plan.ok) expect(plan.fehler[0]).toContain('aufgenommen');
  });
});
