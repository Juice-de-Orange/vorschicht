import { DESK_STATE_COLORS, DESK_STATES } from '@vorschicht/shared/buero';
import { describe, expect, it } from 'vitest';
import {
  ALLE_SPRITES,
  BLASEN,
  FENSTER,
  FIGUR,
  fensterPalette,
  figurPalette,
  HAAR,
  HAUT,
  HEMD,
  istRechteckig,
  KUGELN,
  kugelRects,
  PALETTE,
  PFLANZE,
  PFLANZE_PALETTE,
  personaLook,
  schirmRects,
  spriteRects,
  UHR,
  UHR_PALETTE,
} from './buero-pixel.js';

/**
 * The scene's rules, checked where a browser is not needed.
 *
 * `apps/web` has no DOM test environment, so this file can reach everything in
 * `buero-pixel.ts` and nothing in `Buero.tsx` — which is exactly the split that
 * module was written for. Two of the cases below are the ones worth the file:
 *
 *   * **the five states are told apart without colour.** §17.2 names five
 *     bubbles and §22's Phase 7 puts an axe scan over this page; a room whose
 *     five states differ only in hue answers nothing for a reader who does not
 *     see hue, and "we also show the word" is a claim nobody was checking. It
 *     is checked here as a property over every pair.
 *
 *   * **every sprite compiles.** A typo in pixel art is a hole in the picture,
 *     and a hole is the kind of defect that gets shrugged at. `spriteRects`
 *     throws on an unknown character; this walks all of them so the throw
 *     happens in a test run rather than in the operator's browser.
 */

describe('spriteRects', () => {
  it('fasst waagrechte Läufe zu einem Rechteck zusammen', () => {
    expect(spriteRects(['AAA.A'], { A: '#f00' })).toEqual([
      { x: 0, y: 0, w: 3, h: 1, fill: '#f00' },
      { x: 4, y: 0, w: 1, h: 1, fill: '#f00' },
    ]);
  });

  it('fasst gleiche Läufe auch senkrecht zusammen', () => {
    // Vier Zeilen desselben Blocks sind ein Rechteck, nicht vier — bei
    // vierundzwanzig Schreibtischen ist das der Unterschied zwischen ein paar
    // hundert und ein paar tausend Knoten.
    expect(spriteRects(['AAA', 'AAA', 'AAA', 'AAA'], { A: '#f00' })).toEqual([
      { x: 0, y: 0, w: 3, h: 4, fill: '#f00' },
    ]);
  });

  it('verschmilzt nur bei gleicher Breite, gleicher Spalte und gleicher Farbe', () => {
    const versetzt = spriteRects(['AAA', '.AAA'], { A: '#f00' });
    expect(versetzt).toHaveLength(2);
    const andersfarbig = spriteRects(['AAA', 'BBB'], { A: '#f00', B: '#0f0' });
    expect(andersfarbig).toHaveLength(2);
  });

  it('zeichnet nichts für Punkte und Leerzeichen', () => {
    expect(spriteRects(['. .', '...'], { A: '#f00' })).toEqual([]);
  });

  it('wirft bei einem unbekannten Zeichen, statt ein Loch zu zeichnen', () => {
    // Fail closed: ein stiller Ausfall wäre ein Bild mit einer Lücke, und eine
    // Lücke sieht aus wie Absicht.
    expect(() => spriteRects(['A?A'], { A: '#f00' })).toThrow(/Unbekanntes Sprite-Zeichen "\?"/);
  });
});

describe('die Sprites selbst', () => {
  it('sind rechteckig — keine verrutschte Zeile', () => {
    for (const { name, rows } of ALLE_SPRITES) {
      expect(istRechteckig(rows), `${name} hat unterschiedlich lange Zeilen`).toBe(true);
      expect(rows.length, `${name} ist leer`).toBeGreaterThan(0);
    }
  });

  it('übersetzen sich vollständig — jedes Zeichen hat eine Farbe', () => {
    const paletten: Array<[readonly string[], Record<string, string>]> = [
      [FIGUR, figurPalette(personaLook('coder'))],
      [PFLANZE, PFLANZE_PALETTE],
      [UHR, UHR_PALETTE],
      [FENSTER, fensterPalette(false)],
      [FENSTER, fensterPalette(true)],
      ...Object.values(BLASEN).map(
        (rows) => [rows, { R: '#000', B: '#fff' }] as [readonly string[], Record<string, string>],
      ),
    ];
    for (const [rows, palette] of paletten) {
      expect(() => spriteRects(rows, palette)).not.toThrow();
    }
    for (const state of DESK_STATES) {
      expect(() => kugelRects(state)).not.toThrow();
      expect(() => schirmRects(state)).not.toThrow();
    }
  });

  it('zeichnen tatsächlich etwas', () => {
    for (const state of DESK_STATES) {
      expect(kugelRects(state).length, `Blase ${state}`).toBeGreaterThan(4);
    }
    expect(spriteRects(FIGUR, figurPalette(personaLook('coder'))).length).toBeGreaterThan(8);
  });
});

describe('§17.2s fünf Zustände', () => {
  it('sind ohne Farbe voneinander unterscheidbar', () => {
    // Der Satz, den dieses Departement sonst niemand prüfen würde: nimm die
    // Farbe weg, und zwei Zustände dürfen sich immer noch nicht gleichen.
    const ohneFarbe = (state: (typeof DESK_STATES)[number]) =>
      `${KUGELN[state].form}|${KUGELN[state].glyph.join('/')}`;
    const gesehen = new Map<string, string>();
    for (const state of DESK_STATES) {
      const schlüssel = ohneFarbe(state);
      const schon = gesehen.get(schlüssel);
      expect(schon, `${state} sieht ohne Farbe aus wie ${schon}`).toBeUndefined();
      gesehen.set(schlüssel, state);
    }
    expect(gesehen.size).toBe(DESK_STATES.length);
  });

  it('benutzen dieselben Farben wie der Rest der Ansicht', () => {
    // Zweite Quelle für dieselbe Farbe wäre eine, die auseinanderlaufen kann:
    // die Blase im Raum und die Umrandung am gewählten Platz müssen dasselbe
    // Gelb meinen.
    for (const state of DESK_STATES) {
      expect(KUGELN[state].farbe).toBe(DESK_STATE_COLORS[state]);
    }
  });

  it('lassen genau den ruhenden Bildschirm dunkel', () => {
    expect(schirmRects('ruht')).toEqual([]);
    for (const state of DESK_STATES.filter((s) => s !== 'ruht')) {
      expect(schirmRects(state).length, `Bildschirm ${state}`).toBeGreaterThan(0);
    }
    expect(schirmRects(null)).toEqual([]);
  });

  it('deckt alle fünf ab — ein sechster Zustand wäre ein Tippfehler wert', () => {
    expect(Object.keys(KUGELN).sort()).toEqual([...DESK_STATES].sort());
  });
});

describe('personaLook', () => {
  it('gibt demselben Profil immer dasselbe Gesicht', () => {
    expect(personaLook('coder')).toEqual(personaLook('coder'));
    expect(personaLook('reviewer')).toEqual(personaLook('reviewer'));
  });

  it('malt nicht achtzehnmal dieselbe Person', () => {
    const profile = [
      'planner',
      'coder',
      'reviewer',
      'debugger',
      'db',
      'db-review',
      'onboarding',
      'auditor',
      'product',
      'qa',
      'security',
      'legal',
      'research',
      'docs',
      'ops',
      'ux',
      'controlling',
      'smoke',
    ];
    const looks = new Set(profile.map((id) => JSON.stringify(personaLook(id))));
    // Kein Anspruch auf Kollisionsfreiheit — die Zusicherung ist, dass der Raum
    // nicht aus einer einzigen wiederholten Figur besteht.
    expect(looks.size).toBeGreaterThan(profile.length / 2);
  });

  it('nimmt nur Farben aus der Palette', () => {
    for (const id of ['planner', 'coder', 'auditor', '', 'ein-sehr-langer-profilname']) {
      const look = personaLook(id);
      expect(HAUT).toContain(look.haut);
      expect(HAAR).toContain(look.haar);
      expect(HEMD).toContain(look.hemd);
    }
  });

  it('benutzt keine der fünf Zustandsfarben für Kleidung', () => {
    // Eine bedeutungslose Instanz einer bedeutungstragenden Farbe ist der Weg,
    // auf dem eine Farbe aufhört, ein Signal zu sein.
    const zustandsfarben = new Set<string>(Object.values(DESK_STATE_COLORS));
    for (const farbe of [...HAUT, ...HAAR, ...HEMD]) {
      const roh = farbe.slice(farbe.lastIndexOf(',') + 1, -1).trim();
      expect(zustandsfarben.has(roh), `${roh} ist eine Zustandsfarbe`).toBe(false);
    }
  });
});

describe('die Palette', () => {
  it('ist durchweg überschreibbar und trägt einen Rückfallwert', () => {
    // Ein Auschecken ohne Gestaltungssystem malt einen fertigen Raum; ein
    // Gestaltungssystem übernimmt jeden Wert ohne eine Zeile hier.
    for (const [name, wert] of Object.entries(PALETTE)) {
      expect(wert, name).toMatch(/^var\(--px-[a-z-]+, #[0-9a-f]{6}\)$/);
    }
    for (const wert of [...HAUT, ...HAAR, ...HEMD]) {
      expect(wert).toMatch(/^var\(--px-[a-z0-9-]+, #[0-9a-f]{6}\)$/);
    }
  });
});
