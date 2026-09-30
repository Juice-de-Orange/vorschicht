#!/usr/bin/env node
/**
 * „Doku aktuell" — der einzige Teilsatz der Gates, den bisher kein Test lesen kann.
 *
 * **Woher der Vorschlag kommt.** Die Betriebsprüfung f785a443 (11.8.2026) hat ihn
 * am Ende ihres Berichts gemacht, nachdem sie P6.G8 entwertet hatte: ein
 * Gate-Schritt, der die Zahl der Haken in `CLAUDE.md` gegen die Aussage in
 * `README.md` hält. Der Anlass ist keine Vermutung — **zwei** Gates sind
 * genau daran gescheitert, und beide Male hat es der Prüfer zwanzig Minuten nach
 * dem Haken gefunden:
 *
 *   - **P5.G8** (3.8.): „docs current" angehakt, `README.md` nicht nachgezogen.
 *   - **P6.G8** (11.8.): angehakt mit dem Satz „Doku im selben Commit wie die
 *     Haken", während dieselbe Datei fünf angehakte Gates führte, wo sechs
 *     standen.
 *
 * Beide Male war der Fehler für **jeden Test im Repository unsichtbar**: eine
 * Belegzeile liest nur ein Mensch oder der Prüfer (A76.4). Dieses Skript macht
 * aus der Regel einen Mechanismus, und A44.3 ist der Grund — eine Regel, an die
 * sich alle erinnern müssen, ist keine.
 *
 * ## Was es prüft, und was ausdrücklich nicht
 *
 * Prosa gegen Prosa zu prüfen ginge nicht ohne Raten. Geprüft werden deshalb
 * genau die zwei Dinge, die **Zahlen und Form** sind:
 *
 *   1. **Die Bilanz stimmt.** `README.md` trägt eine ausgeschriebene Zeile
 *      mit den drei Zahlen; sie muss der Auszählung in `CLAUDE.md` entsprechen.
 *      Ein Haken ohne nachgezogene Übergabe ist damit ein roter Schritt statt
 *      eines Fundes, den erst die nächste Prüfung macht.
 *   2. **Jedes angehakte oder verschobene Gate trägt einen Beleg** — die
 *      kursive Klammer `*(…)*` am Zeilenende. Ein Haken ohne Beleg ist die
 *      Form, aus der beide Entwertungen entstanden sind.
 *
 * **Nicht** geprüft wird, ob der Beleg *stimmt*. Das kann kein Skript, und so
 * zu tun als ob wäre schlimmer als die Lücke: §8.2s erste Domäne ist genau
 * diese Frage, und sie braucht einen Prüfer, der das Artefakt liest. Dieses
 * Skript nimmt ihm die mechanische Hälfte ab, damit er seine Sitzung an die
 * andere wenden kann.
 *
 * ## Warum die Bilanzzeile in STATE.md steht und nicht errechnet wird
 *
 * Eine Zahl, die das Skript sich selbst ausrechnet, prüft nichts — sie stimmt
 * per Konstruktion. Die Zeile ist eine **Behauptung eines Menschen** (oder
 * dieser Sitzung) über den Stand, und geprüft wird die Behauptung gegen das
 * Dokument, das sie beschreibt. Das ist derselbe Aufbau wie A107s Drift-Test
 * zwischen Budget-JSON und Budget-Dokument, und aus demselben Grund.
 *
 * Exit-Codes nach A25/A50:
 *   0  die Doku ist nachgezogen
 *   1  Befund — eine Zahl weicht ab oder ein Beleg fehlt
 *   2  nichts geprüft (eine Datei fehlt, oder die Auszählung ergibt zu wenig,
 *      um eine Aussage zu sein)
 */
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { argv, exit } from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** Eine Gate-Zeile in §22. Der Zustand ist genau eines von drei Zeichen (A38). */
const GATE_ZEILE = /^- \[([x~ ])\] (.*)$/;

/** Die Phasenüberschrift in §22 — `### Phase 8 — Controlling …`. */
const PHASE_UEBERSCHRIFT = /^### Phase (\d+)\b/;

/**
 * Ein Abschnitt, den dieser Wächter **nicht** prüft (A152).
 *
 * Eine Chronik trägt Sätze, die zum Zeitpunkt ihres Schreibens richtig waren
 * und heute falsch sind — „Phase 8 läuft" ist im Sitzungsbericht vom 18.8. kein
 * Fehler, sondern der Bericht. Ohne diese Marke meldete der Phasencheck jede
 * historische Zeile als Befund, und ein Wächter, der ein gesundes Artefakt
 * anklagt, wird übersehen (A150.5, A151.5 — dieselbe Lehre, jetzt zum dritten
 * Mal, deshalb steht sie hier als Mechanismus statt als Vorsatz).
 *
 * Die Marke gilt **bis zur nächsten `##`-Überschrift**. Alles unter
 * `docs/archiv/` wird ohnehin nie geprüft: diese Dateien stehen in keiner
 * Prüfliste.
 */
const ARCHIV_MARKE = '<!-- archiv -->';

/**
 * Die Bilanzzeile in `README.md`. Bewusst so geschrieben, dass ein Mensch
 * sie im Fließtext liest — eine HTML-Kommentar-Marke wäre für den Leser
 * unsichtbar und würde deshalb genau dann nicht nachgezogen, wenn es darauf
 * ankommt.
 */
const BILANZ =
  /Gate(?:-Stand|s)[^\n]*?(\d+)\s*(?:grün|green)[^\n]*?(\d+)\s*(?:verschoben|deferred)[^\n]*?(\d+)\s*(?:offen|open)/;

/**
 * Dieselbe Bilanz in freierer Form — **jede** Zeile, die sie behauptet (A151).
 *
 * Die Betriebsprüfung 52a68316 hat am 25.8.2026 gefunden, dass `README.md` und
 * `HANDOVER.md` die Zahl ebenfalls tragen, dass sie dort **drei Haken
 * hinterher** war, und — das ist der eigentliche Fund — dass `HANDOVER.md`
 * wörtlich behauptet: *„`gate-doku.mjs` hält die beiden gegeneinander — geht
 * sie auseinander, wird der zwölfte Gate-Schritt rot."* Sie war auseinander,
 * der Schritt war grün. Dieses Skript las genau zwei Dateien.
 *
 * Das ist dieselbe Form, die `README.md` bei `APP_DB_PASSWORD` selbst benennt
 * (A94): ein Schutz, an den jemand guten Grund hat zu glauben, und der nicht
 * greift. Ein solcher ist schlechter als gar keiner.
 *
 * **Die vierte Zahl schliesst die Demo-Bilanzen aus.** „demo-phase8.sh steht auf
 * 1 grün · 1 verschoben · 3 offen · 0 rot" ist dieselbe Wortfolge und meint
 * etwas anderes — der erste Lauf dieses Wächters hat sie prompt als Abweichung
 * gemeldet. Ein Fehlalarm, der ein gesundes Artefakt anklagt, ist der teuerste
 * Fehler einer Prüfung: man lernt, sie zu übersehen (dieselbe Lehre wie bei
 * `restore-probe.sh`s geratener Grössenschwelle, A150.5, am selben Tag).
 */
const BILANZ_FREI =
  /(\d+)\s*grün\s*·\s*(\d+)\s*verschoben\s*·\s*(\d+)\s*offen(?!\s*·\s*\d+\s*rot)/g;

/**
 * Dieselbe Zahl auf Englisch — `README.md` schreibt sie so (§2: Repo-Dokumente
 * englisch).
 *
 * Beim ersten Lauf des Wächters oben blieb `README.md` **still**, weil das
 * deutsche Muster „green · deferred · open" nicht trifft. Eine Wache, die die
 * Sprache eines Dokuments nicht kennt, hat genau dort eine Lücke, wo das
 * Dokument steht — und der Fund, den sie schliessen sollte, lag in eben dieser
 * Datei.
 */
const BILANZ_FREI_EN =
  /(\d+)\s*green\s*·\s*(\d+)\s*deferred\s*·\s*(\d+)\s*open(?!\s*·\s*\d+\s*red)/g;

/**
 * Die Dokumente, die einen Gate-Stand behaupten — als Zahl, als Phasensatz oder
 * als Gate-Id. Die Liste wächst mit den Dokumenten, und genau darum steht sie
 * hier statt in sechs Köpfen: eine Datei, die den Stand behauptet und hier
 * fehlt, ist der nächste Fund derselben Art.
 *
 * Der Name sagt bewusst nicht mehr „Bilanz": eine Bilanzzeile trägt von diesen
 * sechs nur die Hälfte, und `MAX_CHECKLISTE.md` wird nie eine tragen — sie ist
 * ein Wegweiser, der über sich selbst schreibt, dass Zahlen darin altern, und
 * eine Zahl dort einzusetzen wäre genau die Aussage, gegen die sie warnt. Sie
 * steht trotzdem in dieser Liste, und seit A152 nicht mehr wirkungslos: geprüft
 * wird dort der Phasensatz und jede genannte Gate-Id.
 */
export const WEITERE_WAECHTERDATEIEN = [
  'CONTRIBUTING.md',
  'docs/ARCHITECTURE.md',
  'docs/DEVELOPMENT.md',
  // Seit A152 dabei, weil sie beide **Phasensätze** tragen: `AUTONOMIE.md` war
  // am 25.8. das am stärksten veraltete Hauptdokument (Phase 7 als „7 grün + 1
  // verschoben", Phase 8 als „begonnen"), und `FUER_MAX.md` widersprach sich
  // innerhalb einer Tabellenzelle. Eine Bilanzzeile trägt keine von beiden —
  // die Prüfung ist trotzdem wirksam, weil sie mehr prüft als die Zahl.
  'docs/OPERATIONS.md',
];

/**
 * Der **Phasensatz** — die nächste Ausbaustufe von A151 (A152).
 *
 * Der Anlass ist gemessen: am 25.8.2026 war die Gate-**Zahl** in allen vier
 * Wächterdateien richtig, weil dieses Skript sie hält — und der Gate-**Satz**
 * („Phase 8 läuft", „Phases 0–7 closed") in **fünf** Dokumenten falsch, weil
 * ihn nichts hielt. `README.md:12`, `HANDOVER.md:12`, `docs/AUTONOMIE.md:156`,
 * `README.md:791`, und `docs/FUER_MAX.md:25` widersprach sich sogar
 * innerhalb einer Tabellenzelle.
 *
 * Eine Zahl zu halten und den Satz daneben nicht, ist ein halber Schutz — und
 * der ist nach A94 schlechter als keiner, weil er das Nachsehen ersetzt.
 */
const PHASEN_ZU_DE = /Phasen\s+0\s*(?:bis|–|-|—)\s*(\d+)\s+(?:sind\s+)?geschlossen/g;
const PHASEN_ZU_EN = /Phases\s+0\s*(?:to|–|-|—)\s*(\d+)\s+(?:are\s+)?closed/gi;
const PHASE_LAEUFT =
  /Phase\s+(\d+)\s*(?:\([^)]*\)\s*)?(?:ist\s+)?(?:läuft|begonnen|is under way|under way)/gi;

/** Eine Gate-Id, wie §22 sie nummeriert. */
const GATE_ID = /\bP(\d+)\.G(\d+)\b/g;

/** Wörter, die eine Zeile zu einer Aussage über eine Verschiebung machen. */
const VERSCHIEBUNGSWORT = /verschoben|deferred|A38/i;

/**
 * Unter dieser Zahl gefundener Gate-Zeilen ist die Auszählung keine Aussage,
 * sondern ein Hinweis darauf, dass das Format sich geändert hat. Dann wird
 * nichts behauptet (Exit 2), statt eine Bilanz aus zwei Zeilen zu vergleichen —
 * §8.2s sechste Domäne, angewandt auf das eigene Werkzeug.
 */
const MINDESTENS = 40;

export function zaehleGates(spec) {
  const gates = [];
  // Die Phase und die laufende Nummer darin ergeben die Gate-Id (`P8.G1`) —
  // dieselbe Ableitung, die `gate-book.ts` für die Betriebsprüfung macht (A56.2:
  // adressiert wird über die Id, nie über den Text, weil eine Paraphrase
  // unmittelbar vor einem unumkehrbaren Eingriff der falsche Anker ist).
  let phase = null;
  let nummer = 0;
  for (const zeile of spec.split('\n')) {
    const kopf = PHASE_UEBERSCHRIFT.exec(zeile);
    if (kopf) {
      phase = Number(kopf[1]);
      nummer = 0;
      continue;
    }
    const treffer = GATE_ZEILE.exec(zeile);
    if (!treffer) continue;
    nummer += 1;
    gates.push({
      zustand: treffer[1],
      text: treffer[2] ?? '',
      phase,
      id: phase === null ? null : `P${phase}.G${nummer}`,
    });
  }
  return {
    gates,
    gruen: gates.filter((g) => g.zustand === 'x').length,
    verschoben: gates.filter((g) => g.zustand === '~').length,
    offen: gates.filter((g) => g.zustand === ' ').length,
  };
}

/**
 * Bis zu welcher Phase ist alles geschlossen? (A152)
 *
 * „Geschlossen" heisst nach §22 und A38: **kein** Gate der Phase steht auf
 * `[ ]`. Ein `[~]` zählt als geschlossen, weil A38 genau dafür gebaut ist — es
 * blockiert die Abnahme, nicht den Fortschritt.
 *
 * Gezählt wird **lückenlos von 0 aufwärts**: wäre Phase 6 offen und Phase 7 zu,
 * bliebe die Antwort 5. Alles andere hiesse, aus einer Lücke einen Fortschritt
 * zu machen.
 */
export function geschlossenBis(gates) {
  const phasen = new Map();
  for (const g of gates) {
    if (g.phase === null) continue;
    if (!phasen.has(g.phase)) phasen.set(g.phase, []);
    phasen.get(g.phase).push(g);
  }
  let bis = -1;
  for (let p = 0; phasen.has(p); p += 1) {
    if (phasen.get(p).some((g) => g.zustand === ' ')) break;
    bis = p;
  }
  return bis;
}

/** Den Text ohne die als Archiv markierten Abschnitte (A152). */
export function ohneArchiv(text) {
  const raus = [];
  let ueberspringen = false;
  let ueberschriftGesehen = false;
  for (const zeile of text.split('\n')) {
    if (zeile.includes(ARCHIV_MARKE)) {
      // Steht die Marke **vor** der ersten `## `-Überschrift, meint sie das
      // ganze Dokument und nicht seine Präambel. Ohne diese Unterscheidung wäre
      // sie in genau den Dateien wirkungslos, die als Ganzes Archiv sind —
      // `plan-phase7.md`, `personas-ab-vergleich.md`, `example-app.md`,
      // `BOOTSTRAP_PROMPT.md` (alle vier am 25.8.2026 so markiert): dort steht
      // sie im Kopf, und die erste Überschrift käme drei Zeilen später.
      if (!ueberschriftGesehen) return '';
      ueberspringen = true;
      continue;
    }
    if (/^## /.test(zeile)) {
      ueberschriftGesehen = true;
      if (ueberspringen) ueberspringen = false;
    }
    if (!ueberspringen) raus.push(zeile);
  }
  return raus.join('\n');
}

/** Die drei Zahlen aus der Bilanzzeile, oder `null`, wenn es keine gibt. */
export function lesBilanz(state) {
  const treffer = BILANZ.exec(state);
  if (!treffer) return null;
  return {
    gruen: Number(treffer[1]),
    verschoben: Number(treffer[2]),
    offen: Number(treffer[3]),
  };
}

/**
 * Ein Gate, das etwas behauptet, muss sagen woran es das festmacht.
 *
 * Nur `[x]` und `[~]` — ein offenes Gate behauptet nichts und braucht keinen
 * Beleg. Die Klammer muss am Zeilenende stehen, weil genau dort die
 * Belegzeilen dieses Dokuments stehen und ein `*(…)*` mitten im Gate-Satz eine
 * Betonung wäre, kein Beleg.
 */
export function ohneBeleg(gates) {
  return gates
    .filter((g) => g.zustand === 'x' || g.zustand === '~')
    .filter((g) => !/\*\([\s\S]*\)\*\s*$/.test(g.text))
    .map((g) => g.text.slice(0, 90));
}

export function pruefe(spec, state, weitere = {}) {
  const { gates, gruen, verschoben, offen } = zaehleGates(spec);
  if (gates.length < MINDESTENS) {
    return {
      code: 2,
      zeilen: [
        `Nur ${gates.length} Gate-Zeilen in CLAUDE.md gefunden (erwartet mindestens ${MINDESTENS}).`,
        'Vermutlich hat sich das Format geändert. Es wird nichts behauptet (A25).',
      ],
    };
  }

  const befunde = [];
  const bilanz = lesBilanz(state);
  if (bilanz === null) {
    befunde.push(
      'README.md trägt keine Bilanzzeile. Erwartet wird eine Zeile der Form:',
      `  **Gates (CLAUDE.md §22):** ${gruen} green · ${verschoben} deferred · ${offen} open`,
    );
  } else if (bilanz.gruen !== gruen || bilanz.verschoben !== verschoben || bilanz.offen !== offen) {
    befunde.push(
      'Die Bilanz in README.md stimmt nicht mit CLAUDE.md überein:',
      `  STATE.md sagt:  ${bilanz.gruen} grün · ${bilanz.verschoben} verschoben · ${bilanz.offen} offen`,
      `  CLAUDE.md zählt: ${gruen} grün · ${verschoben} verschoben · ${offen} offen`,
    );
  }

  // Jede weitere Datei, die dieselbe Zahl behauptet — beliebig oft, weil eine
  // Übergabe sie im Kopf und noch einmal im Fliesstext tragen kann.
  for (const [datei, inhalt] of Object.entries(weitere)) {
    if (typeof inhalt !== 'string') continue;
    const treffer_alle = [...inhalt.matchAll(BILANZ_FREI), ...inhalt.matchAll(BILANZ_FREI_EN)];
    for (const treffer of treffer_alle) {
      const [g, v, o] = [Number(treffer[1]), Number(treffer[2]), Number(treffer[3])];
      if (g !== gruen || v !== verschoben || o !== offen) {
        befunde.push(
          `${datei} behauptet eine andere Bilanz als CLAUDE.md:`,
          `  ${datei} sagt:   ${g} grün · ${v} verschoben · ${o} offen`,
          `  CLAUDE.md zählt: ${gruen} grün · ${verschoben} verschoben · ${offen} offen`,
        );
      }
    }
  }

  // --- Der Phasensatz und die Gate-Ids (A152) --------------------------------
  //
  // Geprüft wird **ohne** die als Archiv markierten Abschnitte: eine Chronik
  // darf sagen, was am 18.8. richtig war.
  const bis = geschlossenBis(gates);
  const zustandVon = new Map(gates.filter((g) => g.id).map((g) => [g.id, g.zustand]));

  // `README.md` kommt hier mit hinein: es trägt die kanonische Bilanzzeile
  // (oben schon geprüft) **und** einen `## Current phase`-Abschnitt, der am
  // 25.8. „Phasen 0 bis 7 … Phase 8 läuft" sagte. Ein Dokument, das die Frage
  // beantworten soll, ist der letzte Ort, an dem sie ungeprüft bleiben darf.
  const zuPruefen = { ...weitere, 'README.md': state };
  for (const [datei, roh] of Object.entries(zuPruefen)) {
    if (typeof roh !== 'string') continue;
    const inhalt = ohneArchiv(roh);

    for (const treffer of [...inhalt.matchAll(PHASEN_ZU_DE), ...inhalt.matchAll(PHASEN_ZU_EN)]) {
      const n = Number(treffer[1]);
      if (n !== bis) {
        befunde.push(`${datei} sagt „Phasen 0–${n} geschlossen"; §22 zählt bis Phase ${bis}.`);
      }
    }
    for (const treffer of inhalt.matchAll(PHASE_LAEUFT)) {
      const n = Number(treffer[1]);
      if (n <= bis) {
        befunde.push(
          `${datei} sagt „Phase ${n} läuft/begonnen"; Phase ${n} ist nach §22 geschlossen.`,
        );
      }
    }

    // Jede genannte Gate-Id muss es geben — und wo sie in derselben Zeile mit
    // einem Verschiebungswort steht, muss sie auch wirklich `[~]` sein. Nur
    // dieselbe **Zeile**, nicht dieselbe Nähe: eine Näherung erzeugt genau die
    // Fehlalarme, die diesen Wächter unglaubwürdig machen.
    for (const zeile of inhalt.split('\n')) {
      for (const treffer of zeile.matchAll(GATE_ID)) {
        const id = treffer[0];
        const zustand = zustandVon.get(id);
        if (zustand === undefined) {
          befunde.push(`${datei} nennt ${id} — die Gate-Id gibt es in §22 nicht.`);
          continue;
        }
        if (VERSCHIEBUNGSWORT.test(zeile) && zustand !== '~') {
          befunde.push(
            `${datei} führt ${id} als verschoben; §22 sagt ` +
              `${zustand === 'x' ? 'angehakt' : 'offen'}.`,
          );
        }
      }
    }
  }

  const fehlend = ohneBeleg(gates);
  if (fehlend.length > 0) {
    befunde.push(
      `${fehlend.length} angehaktes oder verschobenes Gate ohne Belegklammer *(…)* am Zeilenende:`,
      ...fehlend.map((text) => `  - ${text}…`),
    );
  }

  if (befunde.length > 0) return { code: 1, zeilen: befunde };
  return {
    code: 0,
    zeilen: [`${gruen} grün · ${verschoben} verschoben · ${offen} offen — Übergabe stimmt überein`],
  };
}

// Beim direkten Aufruf ausführen; beim Import (Test) nicht.
if (argv[1] && fileURLToPath(import.meta.url) === argv[1]) {
  const lies = async (pfad) => {
    try {
      return await readFile(join(REPO_ROOT, pfad), 'utf8');
    } catch (fehler) {
      console.error(`gate-doku — ${pfad} ist nicht lesbar: ${fehler?.message ?? fehler}`);
      exit(2);
    }
  };
  const spec = await lies('CLAUDE.md');
  const state = await lies('README.md');
  const weitere = {};
  for (const pfad of WEITERE_WAECHTERDATEIEN) {
    try {
      weitere[pfad] = await readFile(join(REPO_ROOT, pfad), 'utf8');
    } catch {
      // Eine Datei, die es nicht gibt, behauptet auch nichts.
    }
  }
  const ergebnis = pruefe(spec, state, weitere);
  for (const zeile of ergebnis.zeilen) console.log(ergebnis.code === 0 ? `  ${zeile}` : zeile);
  exit(ergebnis.code);
}
