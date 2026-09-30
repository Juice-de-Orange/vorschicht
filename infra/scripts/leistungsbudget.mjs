/**
 * Das Leistungsbudget lesen, vergleichen und darstellen — die eine Stelle, an
 * der `check-leistungsbudget.mjs` und `check-kaltstart.mjs` sich einig sind.
 *
 * Warum überhaupt eine gemeinsame Datei: die beiden Skripte prüfen zwei Gates
 * (§22 Phase 7, „performance budget met" und „cold load < 2s"), lesen aber
 * dieselbe Budgetdatei und müssen dieselbe Zahl auf dieselbe Art als eingehalten
 * oder überschritten lesen. Zwei Implementierungen desselben Vergleichs wären
 * zwei Stellen, an denen „ist gleich der Grenze" einmal grün und einmal rot
 * bedeutet — und die Grenze selbst ist der Fall, den niemand von Hand prüft.
 *
 * Kein Import aus dem Arbeitsbereich, mit Absicht: dieses Modul muss laufen,
 * bevor irgendetwas gebaut ist, und darf nicht davon abhängen, dass `dist`
 * existiert.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const budgetPfad = join(repoRoot, 'infra', 'leistungsbudget.json');
export const budgetDokument = join(repoRoot, 'docs', 'leistungsbudget.md');

/**
 * Ein Fehler, der „nichts geprüft" bedeutet und nie „Befund" (A25/A50).
 *
 * Eine eigene Klasse statt eines Rückgabewerts, weil die Unterscheidung sonst
 * an jeder Aufrufstelle neu getroffen — und irgendwann einmal falsch getroffen —
 * würde. `catch` fragt einmal, und der Aufrufer setzt Exit 2.
 */
export class NichtsGeprueft extends Error {}

/** Das Budget, mit einer Fehlermeldung, die den Pfad nennt. */
export async function ladeBudget(pfad = budgetPfad) {
  let roh;
  try {
    roh = await readFile(pfad, 'utf8');
  } catch (cause) {
    throw new NichtsGeprueft(
      `Kein Leistungsbudget unter ${pfad}. Der Gate-Satz verlangt „budget documented in repo" — ` +
        'ohne die Datei ist nichts zu prüfen.',
      { cause },
    );
  }
  try {
    return JSON.parse(roh);
  } catch (cause) {
    throw new NichtsGeprueft(`${pfad} ist kein lesbares JSON: ${cause.message}`, { cause });
  }
}

/**
 * Eine Zahl so, wie sie im Dokument steht — und das ist der Grund, warum es
 * diese Funktion gibt.
 *
 * Die Drift-Prüfung sucht die Zeichenkette wörtlich in `docs/leistungsbudget.md`.
 * Formatierte also das Dokument seine Zahlen anders als der Prüfer, schlüge die
 * Prüfung dauerhaft fehl, und das Naheliegende wäre, sie zu lockern. Eine
 * Funktion, zwei Leser.
 */
export function formatiere(wert, einheit) {
  // Millisekunden werden gerundet: Lighthouse liefert 1945,057, und eine
  // Tausendstelsekunde Genauigkeit über ein echtes Netz zu drucken behauptet
  // eine Auflösung, die die Messung nicht hat.
  if (einheit === 'millisekunden') return Math.round(wert).toLocaleString('de-DE');
  if (einheit === 'byte' || einheit === 'punkte') return wert.toLocaleString('de-DE');
  // CLS und Ähnliches: drei Nachkommastellen, deutsch geschrieben, damit die
  // Drift-Prüfung im Dokument dieselbe Zeichenkette findet.
  return wert.toLocaleString('de-DE', { maximumFractionDigits: 3 });
}

/** Und dieselbe Zahl für einen Menschen, mit Einheit dahinter. */
export function mitEinheit(wert, einheit) {
  if (einheit === 'byte') return `${formatiere(wert, einheit)} B`;
  if (einheit === 'millisekunden') return `${formatiere(wert, einheit)} ms`;
  if (einheit === 'punkte') return `${formatiere(wert, einheit)} Punkte`;
  // Über `formatiere` und nicht über `String`: `String(0.07939399999999999)`
  // druckt siebzehn Stellen einer Grösse, die auf drei genau ist, und die Zahl
  // im Dokument fände die Drift-Prüfung dann nie wieder.
  return formatiere(wert, einheit);
}

/**
 * Eingehalten oder nicht.
 *
 * `<=` und `>=`, also **die Grenze selbst gilt als eingehalten**. Ausdrücklich
 * so entschieden und nicht so entstanden: eine Grenze ist eine Obergrenze, und
 * ein Budget, das seinen eigenen genannten Wert ablehnt, ist um eins kleiner,
 * als sein Dokument behauptet. Der Selbsttest fährt genau diesen Fall.
 */
export function vergleiche(position, ist) {
  if (ist === null || ist === undefined || Number.isNaN(ist)) {
    return { ...position, ist, urteil: 'ungemessen' };
  }
  const eingehalten =
    position.richtung === 'mindestens' ? ist >= position.grenze : ist <= position.grenze;
  return { ...position, ist, urteil: eingehalten ? 'eingehalten' : 'überschritten' };
}

/** Eine Tabellenzeile für die Ausgabe. */
export function alsZeile(ergebnis) {
  const zeichen =
    ergebnis.urteil === 'eingehalten'
      ? '[32m✓[0m'
      : ergebnis.urteil === 'überschritten'
        ? '[31m✗[0m'
        : '[33m?[0m';
  const richtung = ergebnis.richtung === 'mindestens' ? '≥' : '≤';
  const ist =
    ergebnis.ist === null || ergebnis.ist === undefined
      ? 'nicht gemessen'
      : mitEinheit(ergebnis.ist, ergebnis.einheit);
  return `  ${zeichen} ${ergebnis.titel.padEnd(42)} ${ist.padStart(16)}  (${richtung} ${mitEinheit(ergebnis.grenze, ergebnis.einheit)})`;
}

/**
 * Die Übertragungsgrösse einer Datei: gzip, wo es hilft, sonst roh.
 *
 * `min(roh, gzip)` und nicht schlicht gzip, weil woff2 bereits komprimiert ist
 * und beim Gzippen **wächst** — 8 404 B werden zu 8 457 B. Ein Server, der eine
 * grössere Antwort schickt als die Datei, ist keiner, den es gibt; die Zahl wäre
 * also eine Erfindung. Was hier gemessen wird, ist die Grösse des Artefakts,
 * nicht die einer bestimmten Auslieferung — was der VPS tatsächlich schickt,
 * misst `check-kaltstart.mjs`, und die beiden Zahlen dürfen auseinandergehen.
 */
export function uebertragung(inhalt) {
  return Math.min(inhalt.byteLength, gzipSync(inhalt, { level: 9 }).byteLength);
}

/*
 * Wohin eine Datei zählt.
 *
 * `.png` ist `symbole` und nicht `sonstiges`, und das ist der Grund, warum
 * diese Tabelle überhaupt einen Kommentar hat: eine Budgetposition, für die
 * `messeBundle` keinen Wert liefert, löst zu `undefined` auf, `vergleiche`
 * antwortet `ungemessen`, und `check-leistungsbudget.mjs` endet **dauerhaft
 * mit 2** — also „nichts geprüft" statt eines Urteils. Eine Kategorie und eine
 * Budgetposition entstehen deshalb im selben Commit; sie sind zwei Hälften
 * einer Aussage, und die zweite ohne die erste ist ein Prüfer, der zu einer
 * Zahl nie etwas sagt.
 *
 * Was hier bewusst **nicht** steht: `.svg` und `.ico`. Ein SVG kann ein Symbol
 * sein und ebenso eine Illustration mitten in einer Seite, und eine Kategorie
 * für eine Dateiart zu erfinden, die es im Baum nicht gibt, ist die tote
 * Verdrahtung aus §8.2s sechster Domäne. Beide fallen heute nach `sonstiges`
 * und zählen damit weiterhin in `uebertragung-gesamt` mit — sie verschwinden
 * also nicht, sie haben nur keinen eigenen Deckel. Wer einen braucht, trägt
 * ihn hier **und** in beiden Budgetdateien nach.
 *
 * Und `sw.js` ist bewusst `js`: der Service Worker landet im Wurzelverzeichnis
 * von `dist` und zählt damit gegen `js-uebertragung` und `js-roh`, obwohl der
 * Browser ihn nicht beim ersten Anzeigen holt, sondern nach `load`. Das ist
 * eine Überzählung des kritischen Pfads und damit die sichere Richtung
 * (A60.4s Asymmetrie): ein zu enger Deckel kostet eine Entscheidung, ein zu
 * weiter kostet die Ladezeit, die das Budget schützen soll.
 */
const KATEGORIEN = {
  '.js': 'js',
  '.mjs': 'js',
  '.css': 'css',
  '.woff2': 'schriften',
  '.woff': 'schriften',
  '.ttf': 'schriften',
  '.otf': 'schriften',
  '.html': 'html',
  '.png': 'symbole',
};

/**
 * Alles messen, was der Browser bei einem Kaltstart wirklich holt.
 *
 * `*.map` zählt nicht mit, und das ist die einzige Auslassung: eine Quellkarte
 * holt ein Browser nur, wenn die Entwicklerwerkzeuge offen sind. Sie mitzuzählen
 * verdreifachte das Budget mit einer Datei, die kein Besucher je anfordert —
 * und sie stillschweigend wegzulassen wäre die Sorte Auslassung, die später
 * niemand mehr findet, deshalb steht sie hier und im Dokument.
 */
export async function messeBundle(distVerzeichnis) {
  let eintraege;
  try {
    eintraege = await sammle(distVerzeichnis);
  } catch (cause) {
    throw new NichtsGeprueft(
      `${distVerzeichnis} ist nicht lesbar — ohne gebauten Bundle gibt es nichts zu messen ` +
        '(`pnpm --filter @vorschicht/web build`).',
      { cause },
    );
  }
  if (eintraege.length === 0) {
    throw new NichtsGeprueft(`${distVerzeichnis} ist leer — nichts gebaut, nichts gemessen.`);
  }

  const dateien = [];
  for (const pfad of eintraege) {
    if (extname(pfad) === '.map') continue;
    const inhalt = await readFile(pfad);
    dateien.push({
      name: basename(pfad),
      kategorie: KATEGORIEN[extname(pfad)] ?? 'sonstiges',
      roh: inhalt.byteLength,
      uebertragen: uebertragung(inhalt),
    });
  }

  const summe = (kategorie, feld) =>
    dateien
      .filter((d) => kategorie === null || d.kategorie === kategorie)
      .reduce((a, d) => a + d[feld], 0);

  return {
    dateien,
    werte: {
      'js-uebertragung': summe('js', 'uebertragen'),
      'js-roh': summe('js', 'roh'),
      'css-uebertragung': summe('css', 'uebertragen'),
      schriften: summe('schriften', 'uebertragen'),
      symbole: summe('symbole', 'uebertragen'),
      'uebertragung-gesamt': summe(null, 'uebertragen'),
    },
  };
}

async function sammle(verzeichnis) {
  const gefunden = [];
  for (const eintrag of await readdir(verzeichnis, { withFileTypes: true })) {
    const pfad = join(verzeichnis, eintrag.name);
    if (eintrag.isDirectory()) gefunden.push(...(await sammle(pfad)));
    else if ((await stat(pfad)).isFile()) gefunden.push(pfad);
  }
  return gefunden;
}

/**
 * Nennt das Dokument dieselben Zahlen wie die Budgetdatei?
 *
 * §22 verlangt „budget **documented** in repo", und ein Budget, dessen Dokument
 * eine andere Zahl nennt als der Prüfer anwendet, erfüllt den Satz dem
 * Wortlaut nach und in der Sache nicht: gelesen wird das Dokument, gewirkt hat
 * die Datei. Das ist dieselbe Abmachung, die A43.1 für die §9-Übergangstabelle
 * trifft — zweimal geschrieben, mit einem Test, der bei Abweichung scheitert.
 *
 * Geprüft wird eine Richtung: jede Position der Datei muss im Dokument mit
 * Titel und Grenze vorkommen. Die Gegenrichtung — das Dokument nennt eine
 * Position, die es nicht mehr gibt — ist mechanisch nicht sauber zu greifen,
 * weil Fliesstext beliebige Zahlen enthalten darf; sie ist damit die benannte
 * Lücke dieser Prüfung.
 */
export function pruefeDrift(budget, dokumentText) {
  const abweichungen = [];
  for (const [gruppe, inhalt] of Object.entries(budget)) {
    if (typeof inhalt !== 'object' || inhalt === null || !Array.isArray(inhalt.positionen))
      continue;
    for (const position of inhalt.positionen) {
      const zahl = formatiere(position.grenze, position.einheit);
      if (!dokumentText.includes(position.titel)) {
        abweichungen.push(`${gruppe}.${position.id}: „${position.titel}" steht nicht im Dokument`);
      }
      if (!dokumentText.includes(zahl)) {
        abweichungen.push(
          `${gruppe}.${position.id}: die Grenze ${zahl} steht nicht im Dokument — ` +
            'die Datei wurde geändert, das Dokument nicht',
        );
      }
      /*
       * **Auch der gemessene Wert**, nicht nur die Grenze.
       *
       * Nachgetragen am 18.8.2026 auf eine Verdachtsmeldung der Betriebsprüfung
       * 49c549b4: für denselben Tag standen **drei** verschiedene CLS-Werte im
       * Baum — 0,061 in `CLAUDE.md`, 0,088 in einem Kommentar von
       * `demo-phase7.sh`, 0,079 hier und im Dokument. Der Prüfer hat auch
       * gesagt, warum es niemandem auffiel: diese Funktion sah die Grenze an
       * und den Messwert nie, also durfte er beliebig altern.
       *
       * Die Grenze ist eine Entscheidung und ändert sich selten; der Messwert
       * ändert sich bei jedem ernsthaften Lauf, ist also **genau** die Zahl,
       * die auseinanderläuft. Eine Driftprüfung, die nur das Stabile prüft,
       * prüft die Stelle nicht, an der Drift entsteht.
       */
      if (position.gemessen_bei_festlegung !== undefined) {
        const gemessen = formatiere(position.gemessen_bei_festlegung, position.einheit);
        if (!dokumentText.includes(gemessen)) {
          abweichungen.push(
            `${gruppe}.${position.id}: der gemessene Wert ${gemessen} steht nicht im Dokument — ` +
              'eine der beiden Stellen ist von einem älteren Lauf',
          );
        }
      }
    }
  }
  return abweichungen;
}

/** Alle Positionen einer Gruppe, flach. */
export function positionen(budget, gruppe) {
  return budget[gruppe]?.positionen ?? [];
}
