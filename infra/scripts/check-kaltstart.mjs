#!/usr/bin/env node
/**
 * Der Kaltstart der Übersicht gegen den VPS (§22 Phase 7).
 *
 *   infra/scripts/check-kaltstart.mjs [--ziel https://…] [--laeufe 3] [--json]
 *
 * Der Gate-Satz lautet wörtlich: „Cold load of the overview < 2s over a
 * throttled mobile profile **against the VPS** (measured, documented)". Fünf
 * Entscheidungen stecken darin, die er nicht ausspricht.
 *
 *   1. **Gegen den Zielhost, nicht gegen localhost.** Steht so im Satz, und der
 *      Unterschied ist nicht theoretisch: derselbe Bundle wiegt hinter einem
 *      Server mit Kompression ein Drittel dessen, was er ohne wiegt. Eine
 *      Messung auf der eigenen Maschine misst die eigene Leitung und beantwortet
 *      die Frage nicht.
 *
 *   2. **Die Seite ist Passkey-geschützt** (§19), und dieser Lauf hat keinen.
 *      Gemessen wird also, was ein Besucher ohne Sitzung sieht: die
 *      ausgelieferte Hülle mit dem Anmeldehinweis. Das ist **nicht** die
 *      gefüllte Übersicht, und die Grenze steht in der Ausgabe jedes Laufs.
 *      Was fehlt, sind die Datenabrufe nach der Anmeldung (`/api/uebersicht`,
 *      der Ereignisstrom) und alles, was deren Antworten an Arbeit auslösen.
 *      Was drin ist, ist alles, was den Kaltstart im engeren Sinn ausmacht:
 *      Verbindungsaufbau, TLS, HTML, das gesamte JavaScript, das CSS und die
 *      Schriften — und die sind bei einer Einzelseiten-Anwendung der
 *      allergrösste Teil. Wer die Zahl liest, muss wissen, welche Hälfte sie
 *      beschreibt.
 *
 *   3. **Welche Zahl „geladen" heisst.** Genommen wird LCP (grösste inhaltliche
 *      Anzeige) — der Zeitpunkt, zu dem der Hauptinhalt sichtbar ist. FCP wäre
 *      zu früh (das erste Pixel kann ein leerer Rahmen sein), `load` zu spät und
 *      zugleich zu beliebig. Die Nachbarwerte werden mitgedruckt, damit ein
 *      Leser die Wahl nachvollziehen und anders entscheiden kann.
 *
 *   4. **Mehrere Läufe, und berichtet wird der schlechteste.** Eine einzelne
 *      Messung über ein echtes Netz ist eine Stichprobe; der Median klänge
 *      besser und wäre die falsche Richtung für eine Zusicherung. Alle Läufe
 *      werden gedruckt, damit Streuung sichtbar bleibt statt in einer Kennzahl
 *      zu verschwinden.
 *
 *   5. **Gemessen wird im Browser, nicht mit Lighthouse** — die Begründung samt
 *      der Tabelle, die sie trägt, steht in `kaltstart-messung.mjs`. Kurz:
 *      Lighthouse bringt mit dem hier verfügbaren Chromium den Renderer jeder
 *      HTTPS-Seite dieser Grösse zum Absturz, github.com eingeschlossen. Der
 *      Nachbarprüfer `check-leistungsbudget.mjs` benutzt Lighthouse weiterhin,
 *      weil er gegen `http://127.0.0.1` misst und es dort läuft.
 *
 * Exit: 0 eingehalten · 1 Befund (zu langsam) · 2 nichts geprüft — kein Ziel
 * erreichbar, kein Browser, kein Budget (A25/A50).
 */
import { argv, exit } from 'node:process';
import { messeEinmal, profilbeschreibung } from './kaltstart-messung.mjs';
import {
  ladeBudget,
  mitEinheit,
  NichtsGeprueft,
  positionen,
  vergleiche,
} from './leistungsbudget.mjs';

function arg(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
}

function nichtsGeprueft(nachricht) {
  console.error(`check-kaltstart — nicht geprüft: ${nachricht}`);
  exit(2);
}

let budget;
try {
  budget = await ladeBudget();
} catch (fehler) {
  if (fehler instanceof NichtsGeprueft) nichtsGeprueft(fehler.message);
  throw fehler;
}

const ziel = arg('ziel', budget.kaltstart?.ziel ?? null);
const laeufe = Number(arg('laeufe', '3'));
const alsJson = argv.includes('--json');

if (!ziel) {
  nichtsGeprueft(
    'Kein Ziel — weder --ziel noch `kaltstart.ziel` im Budget. Der Gate-Satz nennt den VPS; ' +
      'ohne Adresse ist nichts zu messen.',
  );
}
if (!Number.isInteger(laeufe) || laeufe < 1) {
  nichtsGeprueft(`--laeufe ${arg('laeufe')} ist keine Anzahl ≥ 1.`);
}

// Erreichbarkeit zuerst, und ausdrücklich getrennt vom Messen: ein Host, der
// nicht antwortet, ist keine langsame Seite. Die beiden zu verwechseln hiesse,
// einen Netzausfall als Leistungsbefund zu melden — genau die Fehlklassifikation,
// gegen die A50 geschrieben ist.
try {
  const antwort = await fetch(ziel, { redirect: 'follow' });
  if (!antwort.ok) nichtsGeprueft(`${ziel} antwortet mit HTTP ${antwort.status}.`);
} catch (fehler) {
  nichtsGeprueft(`${ziel} ist nicht erreichbar: ${fehler.message}`);
}

let chromium;
try {
  ({ chromium } = await import('@playwright/test'));
} catch (fehler) {
  nichtsGeprueft(`Playwright ist nicht auflösbar: ${fehler.message}`);
}

let browser;
try {
  browser = await chromium.launch();
} catch (fehler) {
  nichtsGeprueft(
    `Kein Browser startbar (pnpm exec playwright install chromium): ${fehler.message.split('\n')[0]}`,
  );
}

console.log(`\n\x1b[1mKaltstart\x1b[0m gegen ${ziel}`);
console.log(
  '  Ohne Sitzung gemessen (§19): die Zahl deckt Verbindungsaufbau, TLS, HTML,\n' +
    '  JavaScript, CSS und Schriften — nicht die Datenabrufe nach der Anmeldung.',
);
// Einmal gebildet und zweimal ausgegeben (Bildschirm und `--json`): eine zweite
// Herleitung wäre eine zweite Wahrheit darüber, womit gemessen wurde, und genau
// die braucht man, um zwei Messungen überhaupt vergleichen zu können.
const profil = profilbeschreibung(browser.version());
console.log(`  Profil: ${profil}\n`);

const messungen = [];
try {
  for (let i = 0; i < laeufe; i += 1) {
    messungen.push(await messeEinmal(browser, ziel));
  }
} catch (fehler) {
  await browser.close();
  if (fehler instanceof NichtsGeprueft) nichtsGeprueft(fehler.message);
  throw fehler;
} finally {
  if (browser.isConnected()) await browser.close();
}

const ms = (wert) => (wert === null ? '—' : `${Math.round(wert)} ms`);
console.log(
  `  ${'Lauf'.padEnd(6)}${'LCP'.padStart(11)}${'FCP'.padStart(11)}${'DOM'.padStart(11)}${'load'.padStart(11)}`,
);
for (const [i, m] of messungen.entries()) {
  console.log(
    `  ${String(i + 1).padEnd(6)}${ms(m.lcp).padStart(11)}${ms(m.fcp).padStart(11)}` +
      `${ms(m.domInhalt).padStart(11)}${ms(m.geladen).padStart(11)}`,
  );
}

// Ein Lauf ohne LCP ist keine schnelle Seite, sondern eine ungemessene.
const ohneLcp = messungen.filter((m) => m.lcp === null || m.lcp === undefined);
if (ohneLcp.length === messungen.length) {
  nichtsGeprueft(
    'Kein einziger Lauf lieferte einen LCP-Wert — die Seite hat nichts gerendert, was der ' +
      'Browser als grösste inhaltliche Anzeige zählt. Das ist keine Zeitmessung, sondern eine Lücke.',
  );
}

// Was der Host wirklich geschickt hat. Diese Tabelle ist der Grund, warum dieser
// Prüfer die Antworten mitdruckt statt nur die Metrik: eine fehlende Kompression
// ist an einer Kennzahl nicht zu erkennen und an dieser Liste sofort.
const letzte = messungen[messungen.length - 1];
const netz = letzte.antworten
  .filter((a) => (a.entpackt ?? 0) > 1024)
  .sort((a, b) => (b.entpackt ?? 0) - (a.entpackt ?? 0));
if (netz.length > 0) {
  console.log('\n  \x1b[1mAusgeliefert\x1b[0m (was der Host wirklich geschickt hat)');
  for (const eintrag of netz.slice(0, 8)) {
    const pfad = new URL(eintrag.url).pathname;
    const faktor = eintrag.entpackt > 0 ? (eintrag.kodiert / eintrag.entpackt).toFixed(2) : '?';
    console.log(
      `    ${pfad.slice(-40).padEnd(40)} ${mitEinheit(eintrag.kodiert, 'byte').padStart(13)}` +
        ` von ${mitEinheit(eintrag.entpackt, 'byte').padStart(13)}  (Faktor ${faktor})`,
    );
  }
  // `transferSize` ist 0, wenn die Antwort aus dem Cache kam — hier nie, weil
  // jeder Lauf einen frischen Kontext bekommt. Ein Faktor nahe 1 auf einer
  // Textantwort heisst deshalb wirklich: unkomprimiert übertragen.
  const unkomprimiert = netz.filter(
    (a) =>
      a.entpackt > 10_000 &&
      a.kodiert >= a.entpackt * 0.95 &&
      !/\.(woff2?|png|jpe?g|webp|gz)$/.test(a.url),
  );
  if (unkomprimiert.length > 0) {
    const verschwendet = unkomprimiert.reduce((s, a) => s + a.kodiert, 0);
    console.log(
      `\n  \x1b[33mHinweis:\x1b[0m ${unkomprimiert.length} Textantwort(en) über 10 kB kamen ` +
        `unkomprimiert an (${mitEinheit(verschwendet, 'byte')} gesamt). Das ist eine Eigenschaft ` +
        'der Auslieferung, nicht des Bundles — und deshalb kein Budgetposten, sondern ein Befund\n' +
        '  für den, der die nginx-Konfiguration hält.',
    );
  }
}

const position = positionen(budget, 'kaltstart').find((p) => p.id === 'kaltstart');
if (!position) nichtsGeprueft('Das Budget kennt keine Position „kaltstart".');

const schlechtester = Math.max(...messungen.map((m) => m.lcp ?? 0));
const ergebnis = vergleiche(position, schlechtester);

if (alsJson) {
  console.log(
    JSON.stringify(
      {
        ziel,
        profil,
        laeufe: messungen.map(({ antworten, ...rest }) => rest),
        schlechtester,
        ergebnis,
        ausgeliefert: netz,
      },
      null,
      2,
    ),
  );
}

console.log('');
if (ergebnis.urteil === 'eingehalten') {
  console.log(
    `\x1b[32mcheck-kaltstart: ${mitEinheit(schlechtester, 'millisekunden')} im schlechtesten von ` +
      `${laeufe} Läufen, Grenze ${mitEinheit(position.grenze, position.einheit)}.\x1b[0m`,
  );
  exit(0);
}
console.error(
  `\x1b[31mcheck-kaltstart: ${mitEinheit(schlechtester, 'millisekunden')} im schlechtesten von ` +
    `${laeufe} Läufen — die Grenze ist ${mitEinheit(position.grenze, position.einheit)} (§22).\x1b[0m`,
);
exit(1);
