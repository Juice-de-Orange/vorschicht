/**
 * §17.8's page logic, without a browser.
 *
 * `apps/web` has no DOM test environment, so everything about this page that
 * can be wrong without a browser noticing lives in `controlling-format.ts` and
 * is asserted here. Two of these cases are about ways a *graph* misleads, which
 * is a class of defect no schema and no status code can catch.
 */
import { describe, expect, it } from 'vitest';
import type { ControllingBody, VerlaufPunkt } from './controlling-format.js';
import {
  budgetVertrauen,
  fensterReihenfolge,
  fensterTitel,
  kopfzeile,
  leseControlling,
  prozent,
  restzeit,
  verlaufPfad,
  verlaufReihen,
  verlaufSpanne,
  vertrauensEtikett,
} from './controlling-format.js';

const JETZT = Date.parse('2026-08-11T12:00:00Z');

function punkt(over: Partial<VerlaufPunkt> = {}): VerlaufPunkt {
  return {
    window: 'five_hour',
    modelClass: null,
    usedPercent: 10,
    source: 'estimated',
    observedAt: JETZT,
    ...over,
  };
}

function payload(over: Partial<ControllingBody['controlling']> = {}): ControllingBody {
  return {
    controlling: {
      waechter: { state: 'normal', text: 'Normalbetrieb', governingWindow: null, since: null },
      schwellen: { wrapUpPercent: 85, hardStopPercent: 95, degradedWrapUpPercent: 75 },
      fenster: [],
      verlauf: [],
      pause: { modus: 'normal', unlesbar: false },
      sparbetrieb: { aktiv: false, unlesbar: false, wirkungen: [], stufen: [] },
      betrieb: {
        planProfile: 'max_20x',
        concurrency: 2,
        concurrencyRange: { min: 0, max: 4 },
      },
      ...over,
    },
  };
}

describe('A81 — die Antwort wird geparst, nicht angenommen', () => {
  it('nimmt das vereinbarte Dokument an', () => {
    const gelesen = leseControlling(payload());
    expect(gelesen.ok).toBe(true);
  });

  it('sagt auf Deutsch, wenn die Form nicht stimmt — statt undefined zu rendern', () => {
    // Genau der Defekt, den A81 beschreibt: der Server antwortet
    // `{ posteingang: … }`, die Seite liest `koerper.items`, und niemand
    // bemerkt es, weil beide Hälften über ihre eigene Fixture grün sind.
    for (const kaputt of [null, {}, { controlling: {} }, { controllingg: {} }]) {
      const gelesen = leseControlling(kaputt);
      expect(gelesen.ok, JSON.stringify(kaputt)).toBe(false);
      if (gelesen.ok) throw new Error('unerreichbar');
      expect(gelesen.fehler).toContain('Controlling');
    }
  });
});

describe('die Kopfzeile sagt, wer angehalten hat', () => {
  it('nennt im Normalbetrieb den Wächtertext', () => {
    expect(kopfzeile(payload().controlling)).toBe('Normalbetrieb');
  });

  it('nennt eine Handpause als Handpause, nicht als Budget', () => {
    // Die tragende Zusicherung dieser Funktion. Der Wächterzustand ist in
    // beiden Fällen `wrap_up`, also sagt er nichts darüber, *wer* angehalten
    // hat — und „Budget erschöpft" zu melden, während der Betreiber selbst den Schalter
    // umgelegt hat, ist die Art Satz, die eine Seite unbrauchbar macht.
    const seite = payload({
      waechter: {
        state: 'wrap_up',
        text: 'Aufräummodus — 5-Stunden-Fenster bei 91,0 %',
        governingWindow: 'five_hour',
        since: null,
      },
      pause: { modus: 'pause', unlesbar: false },
    }).controlling;
    expect(kopfzeile(seite)).toContain('Von Hand angehalten');
    expect(kopfzeile(seite)).not.toContain('91,0');
  });

  it('unterscheidet die harte von der weichen Pause', () => {
    const hart = payload({ pause: { modus: 'hart', unlesbar: false } }).controlling;
    const weich = payload({ pause: { modus: 'pause', unlesbar: false } }).controlling;
    expect(kopfzeile(hart)).toContain('beendet');
    expect(kopfzeile(weich)).toContain('weggeräumt');
    expect(kopfzeile(hart)).not.toBe(kopfzeile(weich));
  });

  it('sagt es, wenn die Stellung selbst unlesbar ist', () => {
    // Sonst sähe der fail-closed-Fall wie eine bewusste Pause aus, und der Betreiber
    // hätte keinen Anlass, den kaputten Wert zu korrigieren.
    const seite = payload({ pause: { modus: 'pause', unlesbar: true } }).controlling;
    expect(kopfzeile(seite)).toContain('nicht lesbar');
  });
});

describe('die Fensterliste', () => {
  it('benennt die Modellklasse, wenn es eine gibt', () => {
    expect(fensterTitel({ window: 'five_hour', modelClass: null })).toBe('5-Stunden-Fenster');
    expect(fensterTitel({ window: 'seven_day_model', modelClass: 'Opus' })).toContain('Opus');
  });

  it('ordnet stabil nach Fensterart und nicht nach Auslastung', () => {
    // Nach Prozent zu sortieren sähe aufgeräumter aus und liesse die Zeilen
    // springen, sobald sich eine Zahl ändert — auf einer Seite, die jemand
    // beobachtet, ist das das Gegenteil von nützlich.
    const sortiert = fensterReihenfolge([
      { window: 'seven_day_model', modelClass: 'Sonnet' },
      { window: 'five_hour', modelClass: null },
      { window: 'seven_day_model', modelClass: 'Opus' },
      { window: 'seven_day', modelClass: null },
    ]);
    expect(sortiert.map((f) => `${f.window}:${f.modelClass ?? ''}`)).toEqual([
      'five_hour:',
      'seven_day:',
      'seven_day_model:Opus',
      'seven_day_model:Sonnet',
    ]);
  });

  it('gibt Prozente deutsch aus', () => {
    expect(prozent(91.44)).toBe('91,4 %');
    expect(prozent(0)).toBe('0,0 %');
  });

  it('beschriftet jede Vertrauensstufe', () => {
    expect(vertrauensEtikett('geschaetzt')).toBe('Geschätzt');
    expect(vertrauensEtikett('offiziell')).toBe('Gemessen');
    // Und die Regel ist dieselbe, die der Server anwendet — kein zweiter
    // Nachbau auf dieser Seite.
    expect(budgetVertrauen({ usedPercent: 5, source: 'estimated', anomaly: null }).stufe).toBe(
      'geschaetzt',
    );
  });
});

describe('die Restzeit', () => {
  it('erfindet keine Frist, wenn die Quelle keine genannt hat', () => {
    // `get_usage` liefert gar keine Reset-Zeit (A73). „in 0 min" wäre eine
    // erfundene Frist an genau der Stelle, an der der Betreiber eine Entscheidung
    // darauf stützen würde.
    expect(restzeit(null, JETZT)).toBeNull();
  });

  it('rechnet Minuten, Stunden und Tage in deutschen Wörtern', () => {
    expect(restzeit(JETZT + 25 * 60_000, JETZT)).toBe('noch 25 min');
    expect(restzeit(JETZT + (2 * 60 + 14) * 60_000, JETZT)).toBe('noch 2 h 14 min');
    expect(restzeit(JETZT + 26 * 60 * 60_000, JETZT)).toBe('noch 1 Tag 2 h');
    expect(restzeit(JETZT + 50 * 60 * 60_000, JETZT)).toBe('noch 2 Tage 2 h');
  });

  it('sagt „abgelaufen" statt einer negativen Zahl', () => {
    expect(restzeit(JETZT - 60_000, JETZT)).toBe('Fenster ist abgelaufen');
  });
});

describe('der Verlauf — die zwei Arten, wie ein Diagramm lügt', () => {
  it('trennt die Fenster, statt eine Sägezahnlinie über alle zu ziehen', () => {
    // `usage_samples` verschränkt die Fenster. Eine einzige Linie über die
    // Rohzeilen zöge zwischen 5-Stunden- und Wochenwert hin und her und
    // nennte das einen Trend.
    const reihen = verlaufReihen([
      punkt({ window: 'five_hour', usedPercent: 10 }),
      punkt({ window: 'seven_day', usedPercent: 80 }),
      punkt({ window: 'five_hour', usedPercent: 12 }),
      punkt({ window: 'seven_day_model', modelClass: 'Opus', usedPercent: 40 }),
    ]);
    expect(reihen).toHaveLength(3);
    expect(reihen[0]?.window).toBe('five_hour');
    expect(reihen[0]?.punkte).toHaveLength(2);
    expect(reihen[2]?.modelClass).toBe('Opus');
  });

  it('skaliert die y-Achse fest auf 0–100 und nicht auf die Daten', () => {
    // Die eine Zusicherung, die dieses Diagramm ehrlich macht. Bei
    // Autoskalierung sähen 3 % und 93 % identisch aus — auf einem
    // Budgetdiagramm ist das genau der Fehler, der zählt.
    const spanne = { von: 0, bis: 100 };
    const flach = verlaufPfad(
      [punkt({ usedPercent: 2, observedAt: 0 }), punkt({ usedPercent: 3, observedAt: 100 })],
      { breite: 100, hoehe: 100 },
      spanne,
    );
    const hoch = verlaufPfad(
      [punkt({ usedPercent: 92, observedAt: 0 }), punkt({ usedPercent: 93, observedAt: 100 })],
      { breite: 100, hoehe: 100 },
      spanne,
    );
    expect(flach).toBe('0,98 100,97');
    expect(hoch).toBe('0,8 100,7');
    expect(flach).not.toBe(hoch);
  });

  it('zeichnet aus einem einzelnen Messwert keine Linie', () => {
    // Ein Punkt ist kein Trend, und eine Ein-Pixel-Linie, die einen behauptet,
    // ist schlechter als ein leeres Feld, das es sagt.
    expect(verlaufPfad([punkt()], { breite: 100, hoehe: 50 }, { von: 0, bis: 100 })).toBeNull();
    expect(verlaufPfad([], { breite: 100, hoehe: 50 }, { von: 0, bis: 100 })).toBeNull();
  });

  it('deckelt Werte ausserhalb 0–100, statt aus dem Diagramm zu laufen', () => {
    const pfad = verlaufPfad(
      [punkt({ usedPercent: -5, observedAt: 0 }), punkt({ usedPercent: 140, observedAt: 100 })],
      { breite: 10, hoehe: 100 },
      { von: 0, bis: 100 },
    );
    expect(pfad).toBe('0,100 10,0');
  });

  it('meldet die Spanne der Messwerte, und null wenn es keine gibt', () => {
    expect(verlaufSpanne([])).toBeNull();
    expect(verlaufSpanne([punkt({ observedAt: 50 }), punkt({ observedAt: 10 })])).toEqual({
      von: 10,
      bis: 50,
    });
  });

  it('weist eine leere Zeitspanne zurück, statt durch null zu teilen', () => {
    expect(
      verlaufPfad([punkt(), punkt()], { breite: 100, hoehe: 50 }, { von: 5, bis: 5 }),
    ).toBeNull();
  });
});
