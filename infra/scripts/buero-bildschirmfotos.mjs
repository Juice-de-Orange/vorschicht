#!/usr/bin/env node
/**
 * Bildschirmfotos der Büro-Ansicht (§17.2) — der eigentliche Nachweis für eine
 * Kulisse.
 *
 * Ein Test kann sagen, dass ein Schreibtisch anklickbar ist und in unter einer
 * Sekunde umschaltet; das tut `e2e/buero.spec.ts` gegen die echte API und
 * echte Zeilen und wird davon nicht berührt. Was kein Test sagen kann, ist ob
 * der Raum aussieht wie ein Raum — und genau das war des Betreibers Befund über die erste
 * Fassung („keine Visualisierung"). Also: vier Bilder, wiederholbar erzeugt.
 *
 * **Warum eigener Server statt der Browserstrecke.** Die Strecke braucht
 * Postgres, eine Passkey-Zeremonie und die ganze Projektkette; für ein Bild der
 * Kulisse ist das Aufwand ohne Ertrag, und die fünf Zustände nebeneinander
 * bräuchten fünf gesäte Sitzungen in fünf §9-Zuständen. Hier läuft stattdessen
 * ein winziger HTTP-Server: er liefert **das gebaute Bundle** aus — dieselbe
 * Datei, die nginx ausliefert (A120) —, beantwortet `/api/auth/state` und
 * `/api/buero`, und hält `/events` offen, damit die Seite „Live verbunden."
 * meldet statt zwischen zwei Zuständen zu flackern.
 *
 * Was das beweist und was nicht, ausdrücklich: bewiesen ist, wie die echten
 * Komponenten eine **vertragskonforme** Antwort zeichnen — die Nutzlast geht
 * durch dasselbe zod-Schema wie in Produktion (A81), und was hier steht, ist
 * die echte `Buero.tsx`. Nicht bewiesen ist, dass der Server diese Antwort so
 * baut; das ist die Zusicherung von `apps/server/src/buero.itest.ts` und der
 * Browserstrecke.
 *
 * Aufruf: `node infra/scripts/buero-bildschirmfotos.mjs`
 * Exit-Codes nach A25/A50: **2** heisst „nichts geprüft" (kein Browser, kein
 * Bundle), **1** heisst „ein Bild kam nicht zustande".
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, resolve } from 'node:path';

const WURZEL = resolve(import.meta.dirname, '../..');
const DIST = join(WURZEL, 'apps/web/dist');
const ZIEL = join(WURZEL, 'docs/media');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.map': 'application/json',
};

// ---------------------------------------------------------------------------
// Die Kulisse, als Nutzlast
// ---------------------------------------------------------------------------

/**
 * Ein Schreibtisch, wie `apps/server/src/buero.ts` ihn meldet.
 *
 * `taskState` und `runLive` sind die **Eingaben**, nie das Urteil: `deskState`
 * entscheidet daraus die Kugel, in der Seite und nirgends sonst (§17.2,
 * `packages/shared/src/buero.ts` Entscheidung 2). Deshalb steht hier auch kein
 * Zustandsname — ein Bild, das die Kugel selbst setzt, würde die Regel
 * umgehen, die es zeigen soll.
 */
function platz(overrides) {
  return {
    seatId: `${overrides.profileId}#${overrides.taskId ?? '-'}`,
    department: 'Entwicklung',
    desk: 'Entwicklung',
    taskId: null,
    taskTitle: null,
    taskState: null,
    projectSlug: 'vorschicht',
    projectReadOnly: false,
    runId: null,
    runLive: false,
    since: new Date(Date.now() - 7 * 60_000).toISOString(),
    ...overrides,
  };
}

const DREI = [
  platz({
    profileId: 'planner',
    name: 'Paul',
    desk: 'Planung',
    taskId: 'a1',
    taskTitle: 'Die Bürokulisse zeichnen',
    taskState: 'coding',
    runId: 'r0',
    runLive: false,
  }),
  platz({
    profileId: 'coder',
    name: 'Clara',
    taskId: 'a1',
    taskTitle: 'Die Bürokulisse zeichnen',
    taskState: 'coding',
    runId: 'r1',
    runLive: true,
  }),
  platz({
    profileId: 'reviewer',
    name: 'Rita',
    desk: 'Review',
    taskId: 'a2',
    taskTitle: 'Quellenregister: Kuratierung im Prüfpfad',
    taskState: 'review',
    runId: 'r2',
    runLive: true,
  }),
];

/** Alle fünf Kugeln nebeneinander — jede aus ihren Eingaben, nicht gesetzt. */
const FUENF = [
  platz({
    profileId: 'docs',
    name: 'Doris',
    department: 'Doku & Archiv',
    desk: 'Doku',
    taskId: 'b1',
    taskTitle: 'CHANGELOG für Phase 7',
    taskState: 'coding',
    runId: 'r3',
    runLive: false,
  }),
  platz({
    profileId: 'coder',
    name: 'Clara',
    taskId: 'b2',
    taskTitle: 'Die Bürokulisse zeichnen',
    taskState: 'coding',
    runId: 'r4',
    runLive: true,
  }),
  platz({
    profileId: 'reviewer',
    name: 'Rita',
    desk: 'Review',
    taskId: 'b3',
    taskTitle: 'Gates über dem neuen Baum',
    taskState: 'gates',
    runId: 'r5',
    runLive: true,
  }),
  platz({
    profileId: 'db',
    name: 'Milo',
    department: 'Entwicklung — Spezialisten',
    desk: 'Datenbank',
    taskId: 'b4',
    taskTitle: 'Migration 0023 rückwärtskompatibel machen',
    taskState: 'parked',
    runId: 'r6',
    runLive: true,
  }),
  platz({
    profileId: 'ops',
    name: 'Otto',
    department: 'Ops/SRE',
    desk: 'Betrieb',
    taskId: 'b5',
    taskTitle: 'Rollback auf dem Host prüfen',
    taskState: 'needs_decision',
    runId: 'r7',
    runLive: true,
  }),
];

const SZENARIEN = [
  {
    datei: 'buero-leer.png',
    was: 'Feierabendbüro — niemand da',
    desks: [],
    breite: 1120,
  },
  {
    datei: 'buero-drei-plaetze.png',
    was: 'drei belegte Schreibtische',
    desks: DREI,
    breite: 1120,
  },
  {
    datei: 'buero-fuenf-zustaende.png',
    was: 'alle fünf Zustände nebeneinander',
    desks: FUENF,
    breite: 1400,
  },
  {
    datei: 'buero-handy-390.png',
    was: 'Handybreite, 390 px',
    desks: DREI,
    breite: 390,
    hoehe: 900,
  },
];

// ---------------------------------------------------------------------------
// Der Server
// ---------------------------------------------------------------------------

/** Aktuelle Nutzlast; jedes Szenario setzt sie, bevor die Seite geladen wird. */
let desks = [];

function starteServer() {
  const server = createServer(async (req, res) => {
    const pfad = (req.url ?? '/').split('?')[0];

    if (pfad === '/api/auth/state') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          bootstrap: { complete: true, credentialCount: 2, missing: 0 },
          hinweis: null,
          angemeldet: true,
        }),
      );
      return;
    }

    if (pfad === '/api/buero') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          buero: {
            personaMode: 'anzeige',
            desks,
            omitted: 0,
            generatedAt: new Date().toISOString(),
          },
        }),
      );
      return;
    }

    // Offen halten, sonst meldet die Seite abwechselnd „Nicht verbunden." und
    // das Bild zeigt einen Zustand, den es im Betrieb nicht gibt.
    if (pfad === '/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': offen\n\n');
      return;
    }

    // Alles Übrige aus dem gebauten Bundle, mit SPA-Rückfall auf index.html.
    const kandidat = join(DIST, pfad === '/' ? 'index.html' : pfad.slice(1));
    const datei = existsSync(kandidat) && extname(kandidat) ? kandidat : join(DIST, 'index.html');
    try {
      const inhalt = await readFile(datei);
      res.writeHead(200, { 'content-type': MIME[extname(datei)] ?? 'application/octet-stream' });
      res.end(inhalt);
    } catch {
      res.writeHead(404).end('nicht gefunden');
    }
  });

  return new Promise((ok) => {
    server.listen(0, '127.0.0.1', () => ok(server));
  });
}

// ---------------------------------------------------------------------------

async function main() {
  if (!existsSync(join(DIST, 'index.html'))) {
    console.error('Kein gebautes Bundle — baue apps/web …');
    const gebaut = spawnSync('pnpm', ['--filter', '@vorschicht/web', 'build'], {
      cwd: WURZEL,
      stdio: 'inherit',
    });
    if (gebaut.status !== 0 || !existsSync(join(DIST, 'index.html'))) {
      console.error('Bundle liess sich nicht bauen. Nichts geprüft (A25).');
      process.exit(2);
    }
  }

  let chromium;
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch {
    console.error('Playwright fehlt. Nichts geprüft (A25).');
    process.exit(2);
  }

  await mkdir(ZIEL, { recursive: true });
  const server = await starteServer();
  const port = server.address().port;
  const browser = await chromium.launch();
  let fehler = 0;

  try {
    for (const szenario of SZENARIEN) {
      desks = szenario.desks;
      const seite = await browser.newPage({
        viewport: { width: szenario.breite, height: szenario.hoehe ?? 760 },
        deviceScaleFactor: 2,
      });
      try {
        await seite.goto(`http://127.0.0.1:${port}/buero`, { waitUntil: 'load' });
        await seite.waitForSelector('.px-buero', { timeout: 15_000 });
        // Erst schiessen, wenn der Strom steht — sonst zeigt das Bild eine
        // Verbindungsmeldung, die im Betrieb nicht stehen bleibt.
        await seite.waitForFunction(
          () =>
            document.querySelector('[data-testid="buero-verbindung"]')?.textContent ===
            'Live verbunden.',
          undefined,
          { timeout: 15_000 },
        );
        await seite.screenshot({ path: join(ZIEL, szenario.datei), fullPage: true });

        // Was ein Bild nicht zeigt: ob die Seite dabei seitlich scrollt — und
        // ob der Raum stattdessen etwas **abschneidet**. Zwei Messungen, und
        // die zweite ist die, die hier gebraucht wird: `.px-buero` trägt
        // `overflow: hidden`, also erzeugt ein zu breiter Schreibtisch keinen
        // Querlauf, sondern verschwindet lautlos hinter der Wand. Die erste
        // Messung allein hat genau diese Mutation überlebt (Raster auf 40rem
        // festgenagelt, vier von vier grün) — festgehalten, weil eine
        // Zusicherung, die nur eine der beiden Richtungen sieht, sich liest wie
        // eine, die beide sieht.
        const [querlauf, beschnitten] = await seite.evaluate(() => {
          const boden = document.querySelector('.px-boden');
          return [
            document.documentElement.scrollWidth - window.innerWidth,
            boden ? boden.scrollWidth - boden.clientWidth : 0,
          ];
        });
        if (querlauf > 1) {
          throw new Error(`Seite scrollt waagrecht: ${querlauf} px über die Breite hinaus`);
        }
        if (beschnitten > 1) {
          throw new Error(`Der Raum schneidet ab: ${beschnitten} px liegen ausserhalb des Bodens`);
        }
        console.error(
          `  ✓ ${szenario.datei} — ${szenario.was} (kein Querlauf, nichts beschnitten)`,
        );
      } catch (ursache) {
        fehler += 1;
        console.error(`  ✗ ${szenario.datei} — ${ursache.message}`);
      } finally {
        await seite.close();
      }
    }
  } finally {
    await browser.close();
    server.close();
    // Die offene SSE-Verbindung hält den Server sonst am Leben.
    server.closeAllConnections?.();
  }

  if (fehler > 0) {
    console.error(`${fehler} Bild(er) kamen nicht zustande.`);
    process.exit(1);
  }
  console.error(`Fertig: ${SZENARIEN.length} Bilder in docs/media/`);
}

await main();
