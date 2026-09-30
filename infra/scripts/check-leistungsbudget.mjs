#!/usr/bin/env node
/**
 * Das Leistungsbudget und die Installierbarkeit der PWA (§22 Phase 7).
 *
 *   infra/scripts/check-leistungsbudget.mjs [--selbsttest] [--ohne-lighthouse]
 *                                           [--ohne-build] [--budget <pfad>] [--json]
 *
 * Das Gate lautet: „Lighthouse: PWA installable pass; performance budget met
 * (budget documented in repo)". Drei Sätze in einem, und sie werden hier
 * getrennt beantwortet, weil sie getrennt scheitern können.
 *
 *   1. **„budget documented in repo"** — `infra/leistungsbudget.json` trägt die
 *      Zahlen, `docs/leistungsbudget.md` ihre Begründung, und dieser Lauf prüft,
 *      dass beide dieselben nennen. Ein Budget, dessen Dokument etwas anderes
 *      sagt als der Prüfer anwendet, erfüllt den Satz nur dem Wortlaut nach:
 *      gelesen wird das Dokument, gewirkt hat die Datei.
 *
 *   2. **„performance budget met"** — zwei Messungen, und die Trennung ist
 *      Absicht. Die **Bundle-Grössen** kommen aus `apps/web/dist` und sind
 *      deterministisch: gleicher Baum, gleiche Zahl, kein Browser, kein Netz.
 *      Sie sind das, was ein Commit steuert. Die **Lighthouse-Werte** kommen aus
 *      einem echten Lauf gegen `vite preview` im gedrosselten Mobilprofil und
 *      schwanken mit der Last der Maschine; ihre Grenzen fangen deshalb einen
 *      Einbruch und keine Nuance. Ein einziger gemittelter „Leistungswert"
 *      hätte beide Eigenschaften verloren.
 *
 *   3. **„PWA installable"** — und hier steht ein Befund über das Gate selbst,
 *      der beim Bauen herausfiel: **Lighthouse kann das seit Version 12 nicht
 *      mehr messen.** Die PWA-Kategorie samt `installable-manifest` wurde
 *      entfernt; die hier verwendete Version 13.4.1 kennt die Kategorien
 *      performance, accessibility, best-practices, seo und agentic-browsing und
 *      keinen einzigen Installierbarkeits-Prüfpunkt (nachgesehen in
 *      `lighthouse/core/config/default-config.js`, nicht erinnert). Der
 *      Gate-Satz nennt also ein Werkzeug, das seine eigene Frage nicht mehr
 *      beantwortet.
 *
 *      Statt daraus „nicht prüfbar" zu machen, werden Chromes veröffentlichte
 *      Installierbarkeitskriterien **einzeln** geprüft — gegen den wirklich
 *      ausgelieferten Ursprung, nicht gegen die Dateien im Baum. Jedes
 *      Kriterium wird namentlich grün oder rot gemeldet, damit ein Fehlschlag
 *      sagt, welches fehlt. Quelle der Liste: web.dev, „What does it take to be
 *      installable?" (https://web.dev/articles/install-criteria) — Googles
 *      eigene Dokumentation, nach §14 eine L4/L5-Quelle.
 *
 * **Der Selbsttest läuft immer**, nicht nur auf Verlangen. Er hält die
 * Vergleichslogik gegen Fälle, deren Antwort feststeht — darunter der Wert, der
 * genau auf der Grenze liegt, weil das der Fall ist, den niemand von Hand
 * nachrechnet. Ein Prüfer, der versehentlich alles für eingehalten hält, meldet
 * dasselbe wie ein eingehaltenes Budget (dieselbe Lehre wie A55s gepflanztes
 * Geheimnis, das gitleaks gar nicht kannte).
 *
 * Exit: 0 alles eingehalten · 1 Befund · 2 nichts geprüft — kein Budget, kein
 * gebauter Bundle, kein Browser (A25/A50: „nicht geprüft" ist kein Befund und
 * darf nicht als einer gemeldet werden).
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { argv, exit } from 'node:process';
import { pngGroesse } from './installierbarkeit.mjs';
import {
  alsZeile,
  budgetDokument,
  budgetPfad,
  formatiere,
  ladeBudget,
  messeBundle,
  mitEinheit,
  NichtsGeprueft,
  positionen,
  pruefeDrift,
  repoRoot,
  vergleiche,
} from './leistungsbudget.mjs';

function arg(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
}

const nurSelbsttest = argv.includes('--selbsttest');
/**
 * Der Modus, der aus diesem Skript einen **Gate-Schritt** machen kann.
 *
 * Ohne ihn ist es dafür unbrauchbar, und zwar aus einem Grund, der wie ein
 * Fehler aussieht und keiner ist: jeder Eintrag in `ungeprueft` führt am Ende zu
 * **Exit 2**, und `--ohne-lighthouse` legt selbst einen an. Der Schritt meldete
 * also für immer `infra`, auch bei sechs von sechs grünen Positionen — A122s
 * „ein Schritt, der nie etwas prüft", diesmal nicht aus Versehen, sondern weil
 * A25s Regel korrekt angewandt wurde.
 *
 * Der Ausweg ist eine Unterscheidung, die A25 nicht trifft, weil sie dort nicht
 * nötig war:
 *
 *   - **„konnte nicht geprüft werden"** — der Build scheiterte, `vite preview`
 *     kam nicht hoch, eine Position liefert keinen Messwert. Das bleibt
 *     `ungeprueft` und bleibt **Exit 2**. Nichts geprüft ist keine Feststellung.
 *   - **„gehört nicht zum erklärten Umfang dieses Laufs"** — Lighthouse und die
 *     Installierbarkeitsliste in `--nur-artefakt`. Das ist keine ausgefallene
 *     Prüfung, sondern eine, die dieser Modus gar nicht behauptet.
 *
 * Der Unterschied trägt nur, solange der Umfang **ausgesprochen** wird, und
 * genau deshalb druckt der Modus ihn immer — auch im grünen Fall. Ein Lauf, der
 * seinen eigenen Zuschnitt verschweigt, liest sich wie ein vollständiger, und
 * das ist die Klasse, gegen die dieses Skript sonst antritt.
 *
 * Was ausserhalb bleibt, ist damit **nicht** ungeprüft, sondern anderswo
 * geprüft: Lighthouse und der Kaltstart sind **Release**-Prüfungen und gehören
 * in `demo-phase7.sh` und in die Rollout-Liste, nicht in einen Gate, der
 * hermetisch und ohne Netz laufen soll.
 */
const nurArtefakt = argv.includes('--nur-artefakt');
const ohneLighthouse = argv.includes('--ohne-lighthouse') || nurArtefakt;
const ohneBuild = argv.includes('--ohne-build') || nurArtefakt;
const alsJson = argv.includes('--json');
const budgetdatei = arg('budget', budgetPfad);

const befunde = [];
const ungeprueft = [];
/** Was dieser Lauf ausdrücklich nicht behauptet — gedruckt, nie exit-wirksam. */
const ausserhalb = [];

// ---------------------------------------------------------------------------
// Selbsttest — die Vergleichslogik gegen Fälle mit feststehender Antwort.
// ---------------------------------------------------------------------------

function selbsttest() {
  const fehler = [];
  let anzahl = 0;
  const pruefe = (was, bedingung, gesehen) => {
    anzahl += 1;
    if (!bedingung) fehler.push(`${was} (gesehen: ${gesehen})`);
  };

  const hoechstens = { id: 'x', titel: 'x', einheit: 'byte', richtung: 'hoechstens', grenze: 100 };
  const mindestens = { id: 'y', titel: 'y', einheit: 'punkte', richtung: 'mindestens', grenze: 90 };

  pruefe(
    'darunter ist eingehalten',
    vergleiche(hoechstens, 99).urteil === 'eingehalten',
    vergleiche(hoechstens, 99).urteil,
  );
  pruefe(
    'darüber ist überschritten',
    vergleiche(hoechstens, 101).urteil === 'überschritten',
    vergleiche(hoechstens, 101).urteil,
  );
  // Der Fall, den niemand von Hand nachrechnet, und der einzige, bei dem sich
  // zwei vertretbare Lesarten unterscheiden.
  pruefe(
    'genau auf der Grenze ist eingehalten',
    vergleiche(hoechstens, 100).urteil === 'eingehalten',
    vergleiche(hoechstens, 100).urteil,
  );
  pruefe(
    'ein Byte darüber ist überschritten',
    vergleiche(hoechstens, 101).urteil === 'überschritten',
    vergleiche(hoechstens, 101).urteil,
  );
  pruefe(
    '„mindestens" dreht die Richtung um',
    vergleiche(mindestens, 89).urteil === 'überschritten',
    vergleiche(mindestens, 89).urteil,
  );
  pruefe(
    '„mindestens" hält auf der Grenze',
    vergleiche(mindestens, 90).urteil === 'eingehalten',
    vergleiche(mindestens, 90).urteil,
  );
  // Nicht gemessen ist weder eingehalten noch überschritten — sonst würde ein
  // ausgefallener Lighthouse-Lauf als bestandenes Budget gelesen.
  pruefe(
    'nicht gemessen ist ein eigenes Urteil',
    vergleiche(hoechstens, null).urteil === 'ungemessen',
    vergleiche(hoechstens, null).urteil,
  );
  pruefe(
    'NaN ebenso',
    vergleiche(hoechstens, Number.NaN).urteil === 'ungemessen',
    vergleiche(hoechstens, Number.NaN).urteil,
  );

  // Und die Drift-Prüfung, in beide Richtungen: sie muss eine fehlende Zahl
  // finden und darf eine vorhandene nicht beanstanden.
  const beispiel = {
    bundle: {
      positionen: [
        { id: 'a', titel: 'Titel A', einheit: 'byte', richtung: 'hoechstens', grenze: 135000 },
      ],
    },
  };
  pruefe(
    'Drift: fehlende Zahl wird gefunden',
    pruefeDrift(beispiel, 'Titel A ohne Zahl').length === 1,
    JSON.stringify(pruefeDrift(beispiel, 'Titel A ohne Zahl')),
  );
  pruefe(
    'Drift: fehlender Titel wird gefunden',
    pruefeDrift(beispiel, 'nur 135.000').length === 1,
    JSON.stringify(pruefeDrift(beispiel, 'nur 135.000')),
  );
  pruefe(
    'Drift: vollständiges Dokument ist sauber',
    pruefeDrift(beispiel, 'Titel A: 135.000 B').length === 0,
    JSON.stringify(pruefeDrift(beispiel, 'Titel A: 135.000 B')),
  );
  pruefe(
    'Formatierung ist deutsch',
    formatiere(135000, 'byte') === '135.000',
    formatiere(135000, 'byte'),
  );

  /*
   * Und das Nachmessen der Symbolgrössen, das sonst in **keinem** Lauf ausgeführt
   * wird: die Symbolliste des Manifests ist heute leer, also erreicht die
   * Installierbarkeitsprüfung diesen Zweig gar nicht. Ungeprüfter Code, der bei
   * der ersten echten Symbolliste die Antwort gäbe — genau die tote Verdrahtung,
   * die §8.2s sechste Domäne sucht. Vier Byte-Muster kosten nichts und machen
   * daraus eine Zusicherung.
   */
  const png = (breite, hoehe) => {
    const puffer = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(puffer, 0);
    puffer.write('IHDR', 12, 'ascii');
    puffer.writeUInt32BE(breite, 16);
    puffer.writeUInt32BE(hoehe, 20);
    return puffer;
  };
  pruefe(
    'PNG: Breite und Höhe kommen aus dem IHDR-Block',
    JSON.stringify(pngGroesse(png(512, 512))) === JSON.stringify({ breite: 512, hoehe: 512 }),
    JSON.stringify(pngGroesse(png(512, 512))),
  );
  pruefe(
    'PNG: ein als quadratisch deklariertes, in Wahrheit schmales Bild wird erkannt',
    pngGroesse(png(512, 64))?.hoehe === 64,
    JSON.stringify(pngGroesse(png(512, 64))),
  );
  pruefe(
    'PNG: etwas, das kein PNG ist, ergibt null statt einer Zahl',
    pngGroesse(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')) === null,
    String(pngGroesse(Buffer.from('<svg/>'))),
  );

  return { fehler, anzahl };
}

/**
 * Und die Installierbarkeitsliste als Ganzes, gegen einen Ursprung, der eigens
 * dafür läuft.
 *
 * Der Grund ist derselbe wie beim gesäten axe-Verstoss, nur schärfer: gegen das
 * heutige Manifest (`icons: []`) wird der **gesamte** Symbolzweig nie betreten,
 * und der Zweig für den Service Worker nie in seiner Ja-Richtung. Zwei Drittel
 * dieses Moduls wären damit Code, den kein Lauf je ausführt — und der beim
 * ersten echten Symbol die Antwort gäbe, ohne dass ihn je jemand ausprobiert
 * hätte. Ein Fixture-Server auf einem zufälligen Port kostet zwanzig
 * Millisekunden und macht daraus eine Zusicherung.
 *
 * Enthalten ist absichtlich ein **lügendes** Symbol: als 512×512 deklariert,
 * in Wahrheit 64×64. Chrome misst nach und lehnt ab; eine Prüfung, die nur das
 * Manifest liest, meldete grün.
 */
async function selbsttestInstallierbarkeit() {
  const fehler = [];
  let anzahl = 0;
  const pruefe = (was, bedingung, gesehen) => {
    anzahl += 1;
    if (!bedingung) fehler.push(`${was} (gesehen: ${gesehen})`);
  };

  const alsPng = (breite, hoehe) => {
    const puffer = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(puffer, 0);
    puffer.write('IHDR', 12, 'ascii');
    puffer.writeUInt32BE(breite, 16);
    puffer.writeUInt32BE(hoehe, 20);
    return puffer;
  };

  const manifest = {
    name: 'Selbsttest',
    start_url: '/',
    display: 'standalone',
    icons: [
      { src: '/i192.png', sizes: '192x192' },
      { src: '/i512.png', sizes: '512x512' },
      { src: '/luege.png', sizes: '512x512' },
    ],
  };
  const antworten = {
    '/': ['text/html', '<link rel="manifest" href="/m.json"><script src="/a.js"></script>'],
    '/m.json': ['application/manifest+json', JSON.stringify(manifest)],
    '/i192.png': ['image/png', alsPng(192, 192)],
    '/i512.png': ['image/png', alsPng(512, 512)],
    '/luege.png': ['image/png', alsPng(64, 64)],
    '/a.js': ['text/javascript', 'navigator.serviceWorker.register("/sw.js")'],
  };

  const server = createHttpServer((anfrage, antwort) => {
    const eintrag = antworten[anfrage.url ?? ''];
    if (!eintrag) {
      antwort.writeHead(404);
      return antwort.end();
    }
    antwort.writeHead(200, { 'content-type': eintrag[0] });
    antwort.end(eintrag[1]);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));

  try {
    const { pruefeInstallierbarkeit } = await import('./installierbarkeit.mjs');
    const kriterien = await pruefeInstallierbarkeit(`http://127.0.0.1:${server.address().port}`);
    const urteil = (titel) => kriterien.find((k) => k.titel === titel)?.urteil ?? 'fehlt';

    pruefe(
      'Manifest wird gefunden und gelesen',
      urteil('Manifest abrufbar') === 'ja',
      urteil('Manifest abrufbar'),
    );
    pruefe(
      '192 und 512 werden erkannt',
      urteil('Symbole 192 px und 512 px') === 'ja',
      urteil('Symbole 192 px und 512 px'),
    );
    // Der Fall, für den das Nachmessen überhaupt gebaut ist.
    pruefe(
      'ein falsch deklariertes Symbol wird beanstandet',
      urteil('Symbolgrösse stimmt') === 'nein',
      urteil('Symbolgrösse stimmt'),
    );
    pruefe(
      'eine Registrierung im Bundle zählt als Service Worker',
      urteil('Service Worker (§17, kein Chrome-Kriterium)') === 'ja',
      urteil('Service Worker (§17, kein Chrome-Kriterium)'),
    );
  } finally {
    server.close();
  }

  return { fehler, anzahl };
}

const eigenpruefung = selbsttest();
const installPruefung = await selbsttestInstallierbarkeit();
eigenpruefung.fehler.push(...installPruefung.fehler);
eigenpruefung.anzahl += installPruefung.anzahl;
if (eigenpruefung.fehler.length > 0) {
  // Exit 1, nicht 2: ein kaputter Prüfer ist kein fehlendes Werkzeug, sondern
  // ein Befund über diesen Baum — und der gefährlichste, weil alles darunter
  // von ihm abhängt.
  console.error('check-leistungsbudget — der Prüfer selbst ist kaputt:');
  for (const zeile of eigenpruefung.fehler) console.error(`  ✗ ${zeile}`);
  exit(1);
}
if (nurSelbsttest) {
  console.log(`check-leistungsbudget: Selbsttest grün (${eigenpruefung.anzahl} Zusicherungen).`);
  exit(0);
}

// ---------------------------------------------------------------------------
// Budget und Dokument.
// ---------------------------------------------------------------------------

let budget;
try {
  budget = await ladeBudget(budgetdatei);
} catch (fehler) {
  if (fehler instanceof NichtsGeprueft) {
    console.error(`check-leistungsbudget — nicht geprüft: ${fehler.message}`);
    exit(2);
  }
  throw fehler;
}

console.log(
  `\n\x1b[1mLeistungsbudget\x1b[0m (Stand ${budget.stand}, festgelegt bei ${budget.festgelegt_bei_commit})`,
);

let dokumentText = null;
try {
  dokumentText = await readFile(budgetDokument, 'utf8');
} catch {
  befunde.push(`${budgetDokument} fehlt — §22 verlangt „budget documented in repo".`);
}
if (dokumentText !== null) {
  const abweichungen = pruefeDrift(budget, dokumentText);
  for (const abweichung of abweichungen)
    befunde.push(`Budget und Dokument gehen auseinander — ${abweichung}`);
  if (abweichungen.length === 0) {
    console.log('  \x1b[32m✓\x1b[0m Dokument und Budgetdatei nennen dieselben Zahlen');
  }
}

// ---------------------------------------------------------------------------
// Die Bundle-Grössen.
// ---------------------------------------------------------------------------

const dist = join(repoRoot, 'apps', 'web', 'dist');

/*
 * Erst bauen, dann messen — und das ist keine Bequemlichkeit.
 *
 * Ein `dist` von gestern ist die gefährlichste Eingabe, die dieser Prüfer haben
 * kann: er misst dann ein Artefakt statt des Baums, meldet ein eingehaltenes
 * Budget und sagt nichts darüber, worüber er es sagt. A90.7 hat genau das für
 * `demo-phase5.sh` festgehalten, nachdem eine bereits zurückgenommene Mutation
 * in `dist` einen korrekten Baum rot färbte — dieselbe Mechanik kann ebenso gut
 * einen kaputten grün färben.
 *
 * `--ohne-build` bleibt für den Fall, dass jemand ein bestimmtes Artefakt
 * vermessen will; dann sagt die Ausgabe das auch.
 */
if (!ohneBuild) {
  process.stdout.write('\n  Baue den Bundle neu, damit die Zahlen den Baum beschreiben … ');
  const gebaut = await new Promise((resolve) => {
    const kind = spawn('pnpm', ['--filter', '@vorschicht/web', 'build'], {
      cwd: repoRoot,
      stdio: 'ignore',
    });
    kind.on('close', (code) => resolve(code === 0));
    kind.on('error', () => resolve(false));
  });
  console.log(gebaut ? 'fertig.' : 'fehlgeschlagen.');
  if (!gebaut) {
    // Ein gescheiterter Build ist ein Befund für `gate:build` und für diesen
    // Prüfer eine fehlende Eingabe: gemessen wurde nichts (A25).
    console.error('check-leistungsbudget — nicht geprüft: `vite build` schlug fehl.');
    exit(2);
  }
} else if (nurArtefakt) {
  // Im Gate hat der Schritt `build` unmittelbar davor gebaut — „das vorhandene
  // `dist`" *ist* dort der Baum. Als Umfang gedruckt, nicht als Ausfall gezählt.
  ausserhalb.push('Gebaut wurde nicht selbst; gemessen wird das vorhandene `dist`.');
} else {
  ungeprueft.push('--ohne-build: gemessen wurde das vorhandene `dist`, nicht der Baum.');
}

let bundle = null;
try {
  bundle = await messeBundle(dist);
} catch (fehler) {
  if (!(fehler instanceof NichtsGeprueft)) throw fehler;
  ungeprueft.push(fehler.message);
}

const ergebnisse = [];
if (bundle !== null) {
  console.log('\n\x1b[1mArtefakt\x1b[0m (apps/web/dist, ohne Quellkarten)');
  for (const datei of bundle.dateien.sort((a, b) => b.uebertragen - a.uebertragen)) {
    console.log(
      `    ${datei.name.padEnd(38)} ${mitEinheit(datei.roh, 'byte').padStart(13)} roh` +
        ` → ${mitEinheit(datei.uebertragen, 'byte').padStart(13)} übertragen`,
    );
  }
  console.log('');
  for (const position of positionen(budget, 'bundle')) {
    const ergebnis = vergleiche(position, bundle.werte[position.id] ?? null);
    ergebnisse.push(ergebnis);
    console.log(alsZeile(ergebnis));
    if (ergebnis.urteil === 'überschritten') {
      befunde.push(
        `${position.titel}: ${mitEinheit(ergebnis.ist, position.einheit)} überschreitet ` +
          `${mitEinheit(position.grenze, position.einheit)} um ` +
          `${mitEinheit(ergebnis.ist - position.grenze, position.einheit)}.`,
      );
    }
    if (ergebnis.urteil === 'ungemessen') {
      ungeprueft.push(`${position.titel} — die Messung liefert keinen Wert für „${position.id}".`);
    }
  }
}

// ---------------------------------------------------------------------------
// Lighthouse gegen den gebauten Bundle, plus Chromes Installierbarkeitsliste.
// ---------------------------------------------------------------------------

/** Ein freier Port, statt einer festen Zahl — vierzehn Worktrees teilen sich diese Maschine (A121). */
async function freierPort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function warteAufAntwort(url, frist = 60_000) {
  const ende = Date.now() + frist;
  while (Date.now() < ende) {
    try {
      const antwort = await fetch(url);
      if (antwort.ok) return true;
    } catch {
      // noch nicht oben
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

if (!ohneLighthouse && bundle !== null) {
  const port = await freierPort();
  const vorschau = spawn(
    'pnpm',
    [
      '--filter',
      '@vorschicht/web',
      'exec',
      'vite',
      'preview',
      // **Die Adresse wird gesetzt, nicht aufgelöst.** Ohne `--host` bindet
      // vite an den Namen `localhost`, und im Gate-Container löst der zuerst
      // auf `::1` auf — der Poll unten fragt `127.0.0.1` und bekommt nie eine
      // Antwort. Gemessen am 18.8.2026: der Server kam hoch und meldete
      // `Local: http://localhost:41999/`, während dieses Skript
      // „vite preview kam nicht hoch" schrieb und mit **2** endete. Also für
      // immer „nicht geprüft" statt eines Ergebnisses, und zwar für die eine
      // Hälfte von P7.G3, die der Gate-Satz „PWA installable pass" nennt —
      // A122s „ein Schritt, der nie etwas prüft", hier in einem Skript, dessen
      // Artefakthälfte grün meldete und dadurch bewohnt aussah.
      // Playwright entgeht dem nur, weil `playwright.config.ts` denselben
      // Server unter `http://localhost:` anspricht (A120). Eine Zeichenkette
      // an beiden Enden ist die Reparatur, die keine Namensauflösung braucht.
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--strictPort',
    ],
    { cwd: repoRoot, stdio: 'ignore' },
  );
  const basis = `http://127.0.0.1:${port}`;
  try {
    if (!(await warteAufAntwort(basis))) {
      ungeprueft.push(`vite preview kam auf ${basis} nicht hoch — Lighthouse nicht gelaufen.`);
    } else {
      const { lighthouseLauf } = await import('./lighthouse-lauf.mjs');
      /*
       * Drei Läufe, und gewertet wird der **Median** — gemessen entstanden und
       * nicht aus Vorsicht.
       *
       * Auf dieser Maschine ergaben drei Läufe hintereinander eine gesamte
       * Blockierzeit von 66, 86 und 358 ms und Leistungswerte von 97, 97 und 89,
       * während LCP mit 1.954–1.961 ms fast unbewegt blieb. Der Grund ist keine
       * Eigenschaft der Seite: TBT und der daraus gespeiste Wert messen
       * **CPU-Zeit**, und wer auf dieser Maschine gerade sonst noch rechnet,
       * entscheidet mit. Ein Budget auf einem Einzellauf wäre damit ein Gate,
       * das je nach Nachbarschaft rot wird — und ein Gate, dessen Rot niemand
       * glaubt, ist schlimmer als keines.
       *
       * Median und nicht Bestwert: der Bestwert wäre Rosinenpickerei, der
       * schlechteste bildete die Nachbarschaft ab statt den Baum. Alle drei
       * Läufe werden gedruckt, damit die Streuung sichtbar bleibt statt in
       * einer Kennzahl zu verschwinden.
       */
      const LAEUFE = 3;
      const messungen = [];
      for (let i = 0; i < LAEUFE; i += 1) {
        try {
          messungen.push(await lighthouseLauf(`${basis}/`));
        } catch (fehler) {
          if (!(fehler instanceof NichtsGeprueft)) throw fehler;
          ungeprueft.push(fehler.message);
          break;
        }
      }

      const median = (werte) => {
        const sortiert = [...werte].filter((w) => typeof w === 'number').sort((a, b) => a - b);
        return sortiert.length === 0 ? null : sortiert[Math.floor(sortiert.length / 2)];
      };
      const messung =
        messungen.length === 0
          ? null
          : {
              profil: messungen[0].profil,
              werte: Object.fromEntries(
                Object.keys(messungen[0].werte).map((schluessel) => [
                  schluessel,
                  median(messungen.map((m) => m.werte[schluessel])),
                ]),
              ),
            };

      if (messung) {
        console.log(`\n\x1b[1mLighthouse\x1b[0m (${messung.profil})`);
        console.log(
          `  ${messungen.length} Läufe, gewertet wird der Median — Wert ` +
            `${messungen.map((m) => m.werte.leistungswert).join('/')}, ` +
            `LCP ${messungen.map((m) => Math.round(m.werte.lcp)).join('/')} ms, ` +
            `TBT ${messungen.map((m) => Math.round(m.werte.tbt)).join('/')} ms\n`,
        );
        for (const position of positionen(budget, 'lighthouse')) {
          const ergebnis = vergleiche(position, messung.werte[position.id] ?? null);
          ergebnisse.push(ergebnis);
          console.log(alsZeile(ergebnis));
          if (ergebnis.urteil === 'überschritten') {
            befunde.push(
              `${position.titel}: ${mitEinheit(ergebnis.ist, position.einheit)} gegen ` +
                `${position.richtung === 'mindestens' ? 'mindestens' : 'höchstens'} ` +
                `${mitEinheit(position.grenze, position.einheit)}.`,
            );
          }
          if (ergebnis.urteil === 'ungemessen') {
            ungeprueft.push(
              `${position.titel} — Lighthouse liefert keinen Wert für „${position.id}".`,
            );
          }
        }
      }

      // Installierbarkeit gegen den ausgelieferten Ursprung, nicht gegen den Baum.
      const { pruefeInstallierbarkeit, alsInstallZeile } = await import('./installierbarkeit.mjs');
      const kriterien = await pruefeInstallierbarkeit(basis);
      console.log(
        '\n\x1b[1mInstallierbarkeit\x1b[0m (Chromes Kriterien, web.dev/articles/install-criteria)',
      );
      for (const kriterium of kriterien) {
        console.log(alsInstallZeile(kriterium));
        if (kriterium.urteil === 'nein')
          befunde.push(`Installierbarkeit — ${kriterium.titel}: ${kriterium.detail}`);
        if (kriterium.urteil === 'unbekannt')
          ungeprueft.push(`Installierbarkeit — ${kriterium.titel}: ${kriterium.detail}`);
      }
    }
  } finally {
    vorschau.kill('SIGTERM');
  }
} else if (nurArtefakt) {
  ausserhalb.push(
    'Lighthouse und die Installierbarkeitsliste — Release-Prüfungen, nicht Gate-Prüfungen.',
    'Sie laufen in `demo-phase7.sh` und vor dem Rollout, wo ein Browser und das Netz da sind.',
  );
} else if (ohneLighthouse) {
  ungeprueft.push(
    '--ohne-lighthouse: Lighthouse und die Installierbarkeitsliste wurden übersprungen.',
  );
}

// ---------------------------------------------------------------------------
// Urteil.
// ---------------------------------------------------------------------------

if (alsJson) {
  console.log(JSON.stringify({ ergebnisse, befunde, ungeprueft }, null, 2));
}

console.log('');
// Der Umfang wird **immer** gedruckt, auch im grünen Fall: ein Lauf, der seinen
// eigenen Zuschnitt verschweigt, liest sich wie ein vollständiger.
if (ausserhalb.length > 0) {
  console.log('\x1b[36mAusserhalb des Umfangs dieses Laufs:\x1b[0m');
  for (const zeile of ausserhalb) console.log(`  · ${zeile}`);
}
if (ungeprueft.length > 0) {
  console.log('\x1b[33mNicht geprüft:\x1b[0m');
  for (const zeile of ungeprueft) console.log(`  ? ${zeile}`);
}
if (befunde.length > 0) {
  console.error('\x1b[31mBefunde:\x1b[0m');
  for (const zeile of befunde) console.error(`  ✗ ${zeile}`);
  console.error(`\ncheck-leistungsbudget: ${befunde.length} Befund(e).`);
  exit(1);
}
if (ungeprueft.length > 0) {
  console.error('\ncheck-leistungsbudget: nichts Rotes, aber auch nicht alles geprüft (A25).');
  exit(2);
}
console.log(
  nurArtefakt
    ? '\x1b[32mcheck-leistungsbudget: die Artefaktzahlen halten das Budget ein.\x1b[0m'
    : '\x1b[32mcheck-leistungsbudget: Budget eingehalten, PWA installierbar.\x1b[0m',
);
exit(0);
