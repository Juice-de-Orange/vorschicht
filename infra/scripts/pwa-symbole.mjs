/**
 * Die PWA-Symbole (§17), gezeichnet statt gemalt.
 *
 *   node infra/scripts/pwa-symbole.mjs        schreibt die drei Dateien neu
 *
 * -----------------------------------------------------------------------------
 * WARUM EIN ERZEUGER UND NICHT DREI EINGECHECKTE BILDER
 * -----------------------------------------------------------------------------
 *
 * `.gitattributes` fuehrt `*.png` als binaer (A126.3), ein Symbol-Diff zeigt
 * also **nichts**. Ein eingechecktes Bild ist damit die eine Sorte Artefakt, die
 * §8.2s Methode — Diffs lesen — nicht pruefen kann: der Pruefer sieht, dass sich
 * eine Datei geaendert hat, und nie was darauf zu sehen ist. Dieselbe Klasse wie
 * A119.9, wo ein NUL-Byte eine Quelldatei fuer das Pruefverfahren unsichtbar
 * machte.
 *
 * Also liegt der Entwurf als Text daneben, in einem Raster, das man lesen kann,
 * und der Test nebenan haelt die ausgelieferten Dateien dagegen. Die PNGs
 * bleiben trotzdem eingecheckt: `vite build` kopiert `public/` unveraendert, und
 * ein Bauschritt, der ein Bild erst erzeugen muss, waere ein Bauschritt mehr in
 * einer Kette, die §22 ohnehin schon lang findet.
 *
 * -----------------------------------------------------------------------------
 * WARUM INDIZIERTE FARBEN UND FILTER 0
 * -----------------------------------------------------------------------------
 *
 * PNG-Farbtyp 3 (Palette, 8 Bit) kostet **ein** Byte je Bildpunkt statt vier,
 * und flaechige Pixelgrafik mit fuenf Farben ist genau der Fall, fuer den das
 * gebaut ist. Wichtiger noch: jede Zeile bekommt Filtertyp 0, also gar keine
 * Vorhersage. Das kostet etwas Kompression und kauft die Eigenschaft, auf der
 * der Drift-Test steht — **eine Datei laesst sich mit zehn Zeilen wieder in
 * Bildpunkte zerlegen**, ohne PNG-Bibliothek und ohne dass die Zusicherung von
 * der Deflate-Fassung des jeweiligen Node abhaengt. Ein Test, der Bytes
 * vergliche, wuerde auf einem anderen Node rot und saegte damit an genau der
 * Sorte Vertrauen, die A128.1 beschreibt.
 *
 * -----------------------------------------------------------------------------
 * DAS RASTER
 * -----------------------------------------------------------------------------
 *
 * 16 x 16 logische Zellen. 192 = 16 x 12 und 512 = 16 x 32, beide ganzzahlig —
 * die Vergroesserung ist reines Vervielfachen, es entsteht kein einziger
 * gemischter Bildpunkt. Ein Raster, das sich auf halbe Bildpunkte legt, ist kein
 * Pixelraster (`basis.css` sagt denselben Satz ueber die Abstaende).
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

const hier = dirname(fileURLToPath(import.meta.url));
export const repoWurzel = join(hier, '..', '..');
export const symbolVerzeichnis = join(repoWurzel, 'apps', 'web', 'public');

/**
 * Die Palette — dieselben Toene wie `apps/web/src/styles/basis.css`.
 *
 * Der Test daneben liest jene Datei und fordert, dass jeder Wert hier dort
 * vorkommt. Das ist der Unterschied zwischen „im Stil des Pixel-Bueros" als
 * Behauptung und als Tatsache: eine Palette, die sich frei bewegen darf, ist in
 * sechs Wochen eine zweite Palette, und niemandem faellt es auf, weil ein Bild
 * keinen Diff hat.
 */
export const PALETTE = {
  '.': '#e6dac6', // --flaeche-tisch  · der Schreibtisch
  P: '#fdf8ee', // --flaeche-blatt  · das Blatt
  I: '#26201a', // --tinte / --linie · Tinte, und zugleich die Kante
  W: '#4a3a2a', // --holz           · der Rahmen
  G: '#2f5c3f', // --gruen          · der eine Akzent
};

/**
 * Das gewoehnliche Symbol (`purpose: "any"`).
 *
 * Ein Blatt auf dem Schreibtisch, im Holzrahmen, mit dem V und einem gruenen
 * Strich darunter. Bei 48 Bildpunkten auf einem Startbildschirm bleibt davon
 * eine helle Flaeche mit einem dunklen V — das ist die Groesse, fuer die
 * entworfen wurde, nicht die 512.
 */
export const SYMBOL_ANY = [
  'WWWWWWWWWWWWWWWW',
  'W..............W',
  'W..IIIIIIIIII..W',
  'W..IPPPPPPPPI..W',
  'W..IIPPPPPPII..W',
  'W..IIPPPPPPII..W',
  'W..IPIPPPPIPI..W',
  'W..IPIPPPPIPI..W',
  'W..IPPIPPIPPI..W',
  'W..IPPIPPIPPI..W',
  'W..IPPPIIPPPI..W',
  'W..IPPPPPPPPI..W',
  'W..IPGGGGGGPI..W',
  'W..IIIIIIIIII..W',
  'W..............W',
  'WWWWWWWWWWWWWWWW',
];

/**
 * Die `maskable`-Fassung.
 *
 * Zwei Unterschiede, und beide sind Vorschrift statt Geschmack. Der Untergrund
 * geht **randlos** bis an die Kante, weil Android die Form selbst waehlt und ein
 * Rahmen genau dort abgeschnitten wuerde. Und der Inhalt liegt vollstaendig im
 * inneren Kreis mit 80 % Durchmesser.
 *
 * Die Zahl dahinter ist auf **Bildpunkt**-Ebene gerechnet und nicht auf
 * Zellenebene, weil das der strengere und der richtige Massstab ist: bei 512 px
 * ist der sichere Radius 204,8, und die aeusserste Ecke dieses Entwurfs liegt
 * bei 180,3 — knapp 12 % Luft. Der erste Entwurf reichte eine Zelle weiter nach
 * oben und unten und landete bei **204,2**, also innerhalb, mit einem halben
 * Bildpunkt Abstand. Innerhalb, und trotzdem falsch: eine spaetere Verschiebung
 * um eine Zelle waere dann beschnitten worden, auf einem Telefon, und auf keinem
 * Rechner aufgefallen. Der Test rechnet es an den **ausgelieferten**
 * Bildpunkten nach, nicht an diesem Feld.
 */
export const SYMBOL_MASKABLE = [
  '................',
  '................',
  '................',
  '................',
  '....IIIIIIII....',
  '....IIPPPPII....',
  '....IIPPPPII....',
  '....IPIPPIPI....',
  '....IPIPPIPI....',
  '....IPPIIPPI....',
  '....IPGGGGPI....',
  '....IIIIIIII....',
  '................',
  '................',
  '................',
  '................',
];

/** Die drei Dateien, die `manifest.webmanifest` nennt. */
export const SYMBOLE = [
  { datei: 'symbol-192.png', kunst: SYMBOL_ANY, kante: 192, zweck: 'any' },
  { datei: 'symbol-512.png', kunst: SYMBOL_ANY, kante: 512, zweck: 'any' },
  { datei: 'symbol-maskable-512.png', kunst: SYMBOL_MASKABLE, kante: 512, zweck: 'maskable' },
];

/** Die Palettenzeichen in fester Reihenfolge — der Index landet in der Datei. */
export const PALETTENFOLGE = Object.keys(PALETTE);

function farbeZuBytes(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * CRC-32 wie PNG es verlangt, mit eigener Tabelle.
 *
 * `node:zlib` bringt seit 22.2 ein `crc32` mit; hier steht trotzdem eines, weil
 * dieses Skript sonst eine Mindestversion von Node haette, die nirgends
 * aufgeschrieben ist — und ein Erzeuger, der auf einer aelteren Maschine
 * kommentarlos abstuerzt, ist schlechter als zwoelf Zeilen Tabelle.
 */
const CRC_TABELLE = (() => {
  const tabelle = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    tabelle[n] = c;
  }
  return tabelle;
})();

function crc32(puffer) {
  let c = 0xffffffff;
  for (const byte of puffer) c = CRC_TABELLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(typ, daten) {
  const laenge = Buffer.alloc(4);
  laenge.writeUInt32BE(daten.length, 0);
  const koerper = Buffer.concat([Buffer.from(typ, 'ascii'), daten]);
  const pruefsumme = Buffer.alloc(4);
  pruefsumme.writeUInt32BE(crc32(koerper), 0);
  return Buffer.concat([laenge, koerper, pruefsumme]);
}

const SIGNATUR = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Das Raster auf die Zielgroesse vervielfachen — ganzzahlig oder gar nicht.
 *
 * Eine Kantenlaenge, die kein Vielfaches von 16 ist, wird **abgelehnt** statt
 * gerundet: gerundet entstuenden Zellen unterschiedlicher Breite, also genau der
 * ungleichmaessige Rand, den ein Pixelstil nicht haben darf, und er waere auf
 * dem Bildschirm sichtbar und in keinem Test.
 */
export function zeichneIndizes(kunst, kante) {
  const raster = kunst.length;
  if (kante % raster !== 0) {
    throw new Error(
      `Kantenlaenge ${kante} ist kein Vielfaches des Rasters ${raster} — ` +
        'das ergaebe Zellen unterschiedlicher Breite.',
    );
  }
  const faktor = kante / raster;
  const indizes = Buffer.alloc(kante * kante);
  for (let y = 0; y < kante; y += 1) {
    const zeile = kunst[Math.floor(y / faktor)];
    for (let x = 0; x < kante; x += 1) {
      const zeichen = zeile[Math.floor(x / faktor)];
      const index = PALETTENFOLGE.indexOf(zeichen);
      if (index === -1) throw new Error(`Unbekanntes Palettenzeichen „${zeichen}".`);
      indizes[y * kante + x] = index;
    }
  }
  return indizes;
}

/** Ein vollstaendiges PNG, Farbtyp 3, Filtertyp 0 auf jeder Zeile. */
export function zeichneSymbol(kunst, kante) {
  const indizes = zeichneIndizes(kunst, kante);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(kante, 0);
  ihdr.writeUInt32BE(kante, 4);
  ihdr.writeUInt8(8, 8); // Bittiefe
  ihdr.writeUInt8(3, 9); // Farbtyp 3: Palette
  ihdr.writeUInt8(0, 10); // Kompression: deflate
  ihdr.writeUInt8(0, 11); // Filterverfahren
  ihdr.writeUInt8(0, 12); // kein Interlacing

  const plte = Buffer.from(PALETTENFOLGE.flatMap((zeichen) => farbeZuBytes(PALETTE[zeichen])));

  const roh = Buffer.alloc((kante + 1) * kante);
  for (let y = 0; y < kante; y += 1) {
    roh[y * (kante + 1)] = 0; // Filtertyp 0 — siehe Kopf
    indizes.copy(roh, y * (kante + 1) + 1, y * kante, (y + 1) * kante);
  }

  return Buffer.concat([
    SIGNATUR,
    chunk('IHDR', ihdr),
    chunk('PLTE', plte),
    chunk('IDAT', deflateSync(roh, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function schreibeAlle() {
  for (const symbol of SYMBOLE) {
    const bytes = zeichneSymbol(symbol.kunst, symbol.kante);
    await writeFile(join(symbolVerzeichnis, symbol.datei), bytes);
    console.log(
      `  ${symbol.datei.padEnd(28)} ${String(symbol.kante).padStart(4)} px  ` +
        `${bytes.byteLength.toLocaleString('de-DE').padStart(7)} B  (${symbol.zweck})`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await schreibeAlle();
}
