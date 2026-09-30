import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import budget from '../leistungsbudget.json' with { type: 'json' };
import {
  PALETTE,
  PALETTENFOLGE,
  repoWurzel,
  SYMBOL_ANY,
  SYMBOL_MASKABLE,
  SYMBOLE,
  symbolVerzeichnis,
  zeichneIndizes,
  zeichneSymbol,
} from './pwa-symbole.mjs';

/**
 * Die drei PWA-Symbole (§17, §22 Phase 7 G3).
 *
 * Ein Bild ist das eine Artefakt, das ein Diff nicht zeigt — `.gitattributes`
 * fuehrt `*.png` als binaer. Diese Datei ist deshalb das, was ein Leser statt
 * des Diffs bekommt, und sie prueft vier Dinge, die man nicht sehen kann:
 *
 *   1. Die ausgelieferte Datei zeigt, was der Entwurf daneben sagt.
 *   2. Die `maskable`-Fassung liegt in Androids Sicherheitszone — **gerechnet
 *      an den Bildpunkten der Datei**, nicht am Entwurfsfeld.
 *   3. Die Farben stammen aus dem Gestaltungssystem und nicht aus der Naehe.
 *   4. Das Manifest nennt genau die Dateien, die es gibt.
 *
 * Verglichen werden **Bildpunkte, nie Bytes.** Ein Byte-Vergleich haenge an der
 * Deflate-Fassung des jeweiligen Node und wuerde auf einer anderen Maschine rot,
 * ohne dass sich am Bild etwas geaendert haette — die Sorte Rot, die niemand
 * mehr liest (A128.1). Der Erzeuger schreibt jede Zeile mit Filtertyp 0, damit
 * genau dieser Vergleich mit zehn Zeilen moeglich ist.
 */

type Bild = { breite: number; hoehe: number; farbtyp: number; punkte: number[][] };

/**
 * Ein PNG des Erzeugers wieder in Bildpunkte zerlegen.
 *
 * Bewusst **kein** allgemeiner Decoder: er verlangt Farbtyp 3 und Filtertyp 0
 * und bricht sonst ab. Ein Decoder, der mehr kann, als der Erzeuger produziert,
 * wuerde eine spaetere Umstellung auf einen anderen Filter klaglos mitmachen —
 * und damit die eine Eigenschaft verschlucken, auf der die Vergleichbarkeit
 * dieser Suite steht.
 */
function zerlege(bytes: Buffer): Bild {
  const signatur = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(bytes.subarray(0, 8).equals(signatur)).toBe(true);

  let offset = 8;
  let kopf: { breite: number; hoehe: number; tiefe: number; farbtyp: number } | null = null;
  const daten: Buffer[] = [];
  while (offset < bytes.length) {
    const laenge = bytes.readUInt32BE(offset);
    const typ = bytes.subarray(offset + 4, offset + 8).toString('ascii');
    const inhalt = bytes.subarray(offset + 8, offset + 8 + laenge);
    if (typ === 'IHDR') {
      kopf = {
        breite: inhalt.readUInt32BE(0),
        hoehe: inhalt.readUInt32BE(4),
        tiefe: inhalt.readUInt8(8),
        farbtyp: inhalt.readUInt8(9),
      };
    }
    if (typ === 'IDAT') daten.push(inhalt);
    offset += 12 + laenge;
  }
  if (kopf === null) throw new Error('kein IHDR');
  expect(kopf.tiefe).toBe(8);
  expect(kopf.farbtyp).toBe(3);

  const roh = inflateSync(Buffer.concat(daten));
  const punkte: number[][] = [];
  for (let y = 0; y < kopf.hoehe; y += 1) {
    const anfang = y * (kopf.breite + 1);
    expect(roh[anfang]).toBe(0); // Filtertyp 0 — siehe Kopf des Erzeugers
    punkte.push(Array.from(roh.subarray(anfang + 1, anfang + 1 + kopf.breite)));
  }
  return { breite: kopf.breite, hoehe: kopf.hoehe, farbtyp: kopf.farbtyp, punkte };
}

function ausgeliefert(datei: string): Bild {
  return zerlege(readFileSync(join(symbolVerzeichnis, datei)));
}

/**
 * Der aeusserste Inhaltspunkt, als Abstand von der Mitte in Bildpunkten.
 *
 * „Inhalt" ist alles, was nicht der Untergrundton ist (Palettenindex 0). Der
 * Abstand wird von der **Mitte des Bildpunkts** gemessen, nicht von seiner Ecke:
 * ein Bildpunkt, dessen Mitte innerhalb liegt, wird von einer Maske getroffen
 * und nicht abgeschnitten.
 */
function aeussersterInhalt(bild: Bild): number {
  const mitte = bild.breite / 2;
  let weiteste = 0;
  for (let y = 0; y < bild.hoehe; y += 1) {
    const zeile = bild.punkte[y] ?? [];
    for (let x = 0; x < bild.breite; x += 1) {
      if (zeile[x] === 0) continue;
      const abstand = Math.hypot(x + 0.5 - mitte, y + 0.5 - mitte);
      if (abstand > weiteste) weiteste = abstand;
    }
  }
  return weiteste;
}

/** Androids Sicherheitszone: der innere Kreis mit 80 % Durchmesser. */
const SICHERE_ZONE = 0.4;

describe('Die PWA-Symbole zeigen, was ihr Entwurf sagt', () => {
  for (const symbol of SYMBOLE) {
    it(`${symbol.datei} ist Punkt fuer Punkt der Entwurf, in ${symbol.kante} px`, () => {
      const bild = ausgeliefert(symbol.datei);
      expect(bild.breite).toBe(symbol.kante);
      expect(bild.hoehe).toBe(symbol.kante);
      expect(bild.punkte).toEqual(zerlege(zeichneSymbol(symbol.kunst, symbol.kante)).punkte);
    });
  }

  it('vervielfacht ganzzahlig und lehnt jede andere Kantenlaenge ab', () => {
    // 200 ist kein Vielfaches von 16. Gerundet entstuenden Zellen
    // unterschiedlicher Breite — auf dem Bildschirm sichtbar, in keinem Test.
    expect(() => zeichneIndizes(SYMBOL_ANY, 200)).toThrow(/Vielfaches/);
    expect(() => zeichneIndizes(SYMBOL_ANY, 192)).not.toThrow();
  });
});

describe('Androids Maske schneidet nichts weg', () => {
  it('haelt allen Inhalt der maskable-Fassung im inneren Kreis von 80 %', () => {
    const bild = ausgeliefert('symbol-maskable-512.png');
    const grenze = SICHERE_ZONE * bild.breite;
    expect(aeussersterInhalt(bild)).toBeLessThanOrEqual(grenze);
  });

  it('und die gewoehnliche Fassung reicht ueber diesen Kreis hinaus', () => {
    // Die Gegenprobe, ohne die der Fall darueber nichts sagt: eine Zusicherung
    // „alles liegt innen" bestuende auch fuer ein Symbol, das ueberall klein
    // ist — sie belegt dann nicht, dass die maskable-Fassung sich vom
    // gewoehnlichen Entwurf *unterscheidet*, und genau das ist ihr Zweck.
    const bild = ausgeliefert('symbol-512.png');
    expect(aeussersterInhalt(bild)).toBeGreaterThan(SICHERE_ZONE * bild.breite);
  });

  it('und die beiden Entwuerfe sind wirklich verschieden', () => {
    expect(SYMBOL_MASKABLE).not.toEqual(SYMBOL_ANY);
  });
});

describe('Die Symbole stammen aus dem Gestaltungssystem', () => {
  it('nennt keine Farbe, die basis.css nicht kennt', () => {
    // Gelesen wird die echte Datei, nicht eine Kopie der Werte. „Im Raster und
    // der Palette des Pixel-Bueros" ist sonst eine Behauptung, die in sechs
    // Wochen eine zweite Palette ist — und weil ein Bild keinen Diff hat, faellt
    // es niemandem auf.
    const basis = readFileSync(
      join(repoWurzel, 'apps', 'web', 'src', 'styles', 'basis.css'),
      'utf8',
    ).toLowerCase();
    const fremd = Object.entries(PALETTE).filter(([, hex]) => !basis.includes(hex.toLowerCase()));
    expect(fremd).toEqual([]);
  });

  it('benutzt jede Palettenfarbe wenigstens einmal', () => {
    // Ein Palettenzeichen, das kein Entwurf verwendet, ist tote Verdrahtung im
    // Kleinen (§8.2, sechste Domaene): es liest sich wie ein Teil des Entwurfs
    // und traegt nichts.
    const benutzt = new Set([...SYMBOL_ANY.join(''), ...SYMBOL_MASKABLE.join('')]);
    expect([...PALETTENFOLGE].filter((zeichen) => !benutzt.has(zeichen))).toEqual([]);
  });
});

describe('Das Manifest und die Budgetposition passen zu den Dateien', () => {
  const manifest = JSON.parse(
    readFileSync(join(symbolVerzeichnis, 'manifest.webmanifest'), 'utf8'),
  ) as { icons: { src: string; sizes: string; type: string; purpose: string }[] };

  it('nennt genau die drei erzeugten Dateien mit Groesse, Typ und Zweck', () => {
    expect(manifest.icons).toEqual(
      SYMBOLE.map((symbol) => ({
        src: `/${symbol.datei}`,
        sizes: `${symbol.kante}x${symbol.kante}`,
        type: 'image/png',
        purpose: symbol.zweck,
      })),
    );
  });

  it('deckt Chromes beide Pflichtgroessen mit `purpose: any` ab', () => {
    // Chrome verlangt 192 und 512, und eine reine `maskable`-Fassung zaehlt
    // dafuer nicht. Der Fall existiert, weil ein Entwurf, der nur die maskable
    // behaelt, plausibel aussieht und die App uninstallierbar macht.
    const any = manifest.icons.filter((symbol) => symbol.purpose === 'any');
    expect(any.map((symbol) => symbol.sizes).sort()).toEqual(['192x192', '512x512']);
  });

  it('bleibt zusammen unter der Budgetposition `symbole`', () => {
    // Die Grenze wird gelesen, nie wiederholt: eine zweite Zahl hier waere die
    // zweite Stelle, an der das Budget steht, und die beiden liefen
    // auseinander (A81s Klasse).
    const position = budget.bundle.positionen.find((p) => p.id === 'symbole');
    expect(position, 'Budgetposition `symbole` fehlt in infra/leistungsbudget.json').toBeDefined();
    const summe = SYMBOLE.reduce(
      (bisher, symbol) => bisher + readFileSync(join(symbolVerzeichnis, symbol.datei)).byteLength,
      0,
    );
    expect(summe).toBeLessThanOrEqual(position?.grenze ?? 0);
  });
});
