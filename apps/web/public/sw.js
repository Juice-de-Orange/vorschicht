/*
 * Vorschicht — Service Worker mit Offline-Hülle (§17).
 * =============================================================================
 *
 * §17 verlangt „service worker with offline app shell". Der Satz ist kurz und
 * die gefährliche Hälfte steht nicht darin: **ein Worker, der die Hülle
 * festhält, macht einen Rollout unsichtbar.** der Betreiber sieht nach dem Deploy weiter
 * die alte Anwendung, nichts schlägt fehl, und niemand merkt es — der teuerste
 * Fehlermodus dieser Datei, weil er wie Funktionieren aussieht.
 *
 * Der Server sagt genau das schon, in `apps/server/src/app.ts` (`serveShell`):
 * gehashte Dateien unter `/assets/` bekommen `immutable`, `index.html` bekommt
 * `no-cache`, „or a deploy leaves browsers on the previous shell". Diese Datei
 * ist dieselbe Regel eine Schicht weiter, denn ein Cache-API-Eintrag schert sich
 * nicht um `cache-control`: was hier abgelegt wird, bleibt liegen, bis dieser
 * Code es wegräumt.
 *
 * -----------------------------------------------------------------------------
 * DIE VIER REGELN
 * -----------------------------------------------------------------------------
 *
 *   1. **`/api/`, `/events`, `/healthz` werden nie angefasst.** Kein
 *      `respondWith`, keine Ablage, nichts. Eine zwischengespeicherte
 *      API-Antwort wäre ein Dashboard, das einen Stand von gestern als „live"
 *      zeigt; und `/events` ist der SSE-Strom aus §17, den ein Worker, der ihn
 *      durch eine eigene Antwort ersetzt, in manchen Browsern puffert und damit
 *      genau die Eigenschaft nimmt, für die es ihn gibt. Ebenso unangetastet:
 *      alles, was nicht GET ist, und alles von fremden Ursprüngen.
 *
 *   2. **Die Hülle kommt zuerst aus dem Netz.** Nur wenn das Netz nicht
 *      antwortet, kommt die abgelegte Fassung — das ist die Offline-Hülle, die
 *      §17 verlangt, und zugleich die einzige Anordnung, in der ein Rollout
 *      sofort sichtbar ist. Eine Antwort, die **nicht** `ok` ist, wird
 *      durchgereicht statt ersetzt: ein 401 oder ein 404 muss bei der Anwendung
 *      ankommen und nicht als beruhigende alte Seite.
 *
 *   3. **`/assets/…` kommt zuerst aus dem Speicher.** Diese Namen tragen den
 *      Inhaltshash, sind also unveränderlich; ein neuer Build hat neue Namen und
 *      damit von selbst einen Fehltreffer. Das ist die eine Stelle, an der
 *      Zwischenspeichern ohne Risiko ist — und die Stelle, die Offline
 *      überhaupt erst brauchbar macht, denn eine Hülle ohne ihr JavaScript ist
 *      eine leere Seite.
 *
 *   4. **Alles andere same-origin** (Manifest, Symbole) geht ebenfalls zuerst
 *      ins Netz und fällt auf den Speicher zurück. Diese Namen tragen keinen
 *      Hash, also wäre „zuerst der Speicher" wieder Regel 2s Falle, nur kleiner.
 *
 * -----------------------------------------------------------------------------
 * DER VERSIONSSTEMPEL
 * -----------------------------------------------------------------------------
 *
 * `public/` wird von `vite build` unverändert kopiert, diese Datei kann also
 * keine Build-Konstante enthalten. Der Stempel wird deshalb **aus der Hülle
 * gelesen**: der Name des gehashten Einstiegsskripts (`/assets/index-<hash>.js`)
 * ändert sich mit jedem Build, der etwas am Bündel ändert, und ist damit genau
 * der Stempel, den man sonst hineingeneriert hätte — nur ohne zweite Stelle, an
 * der er falsch stehen kann.
 *
 * Er benennt den Teilespeicher. Ein Rollout legt also einen neuen an und der
 * alte wird gelöscht; ohne das wüchse der Speicher mit jedem Deploy um ein
 * ganzes Bündel, für immer, weil eine gehashte Datei nie wieder angefragt wird.
 *
 * -----------------------------------------------------------------------------
 * skipWaiting JA, clients.claim NEIN — beides entschieden, nicht geerbt
 * -----------------------------------------------------------------------------
 *
 * `skipWaiting()`: **ja.** Ohne den Aufruf wartet ein neuer Worker, bis der
 * letzte Tab geschlossen ist, und auf einem Telefon ist das nie. Eine Korrektur
 * an dieser Datei käme also beliebig spät an. Sie ist gefahrlos, weil nach
 * Regel 3 nur inhaltsgehashte Dateien aus dem Speicher bedient werden: eine
 * sofortige Übernahme kann keine veraltete Hülle ausliefern.
 *
 * `clients.claim()`: **nein.** Die bereits geladene Seite kam gerade aus dem
 * Netz und braucht keinen Worker; sie mitten im Lauf zu übernehmen ist das
 * einzige, was das Verhalten einer offenen Seite ändert, und es kauft nichts.
 * Genannter Preis: die Offline-Hülle steht ab der **zweiten** Navigation, nicht
 * ab der ersten. Das ist die richtige Richtung — beim ersten Besuch war das
 * Netz nachweislich da.
 */

const SCHEMA = 'v1';
const SCHALE_CACHE = `vorschicht-schale-${SCHEMA}`;
const TEILE_PRAEFIX = `vorschicht-teile-${SCHEMA}-`;

/*
 * Ein fester Schlüssel für die Hülle, kein Abfragepfad.
 *
 * Die Anwendung ist eine Einzelseite: `/`, `/posteingang` und `/aufgaben/17`
 * liefern alle dasselbe Dokument (`serveShell` fällt für jeden Nicht-API-Pfad
 * darauf zurück). Ein Speicher pro Pfad hielte also dieselben Bytes zwanzigmal
 * und wäre nach einem Rollout zwanzigmal einzeln veraltet.
 */
const SCHALE_SCHLUESSEL = '/index.html';

/** Was diesem Worker nicht gehört (Regel 1). */
const FREMDE_PFADE = ['/api/', '/events', '/healthz'];

const OFFLINE_SEITE = `<!doctype html>
<html lang="de"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Vorschicht — offline</title></head>
<body style="font-family: system-ui, sans-serif; margin: 3rem auto; max-width: 34rem; padding: 0 1rem">
<h1>Keine Verbindung</h1>
<p>Diese Ansicht war noch nie geladen, deshalb liegt hier nichts bereit.
Sobald wieder eine Verbindung besteht, lädt sie normal.</p>
</body></html>`;

/** Merker für den Stempel — je Worker-Leben, nicht dauerhaft. */
let stempelVersprechen = null;

function istFremd(pfad) {
  return FREMDE_PFADE.some(
    (praefix) => pfad === praefix.replace(/\/$/, '') || pfad.startsWith(praefix),
  );
}

function teileCache(stempel) {
  return TEILE_PRAEFIX + stempel;
}

/**
 * Der Stempel aus dem Dokument: der Dateiname des gehashten Einstiegsskripts.
 *
 * Kein Treffer ergibt `unbekannt` statt eines Fehlers. Das ist der Zustand einer
 * Hülle, die kein gebautes Bündel lädt (der Entwicklungsserver), und der darf
 * einen Worker nicht abstürzen lassen — er soll dort nur nichts Kluges tun.
 */
function stempelAus(html) {
  const treffer = html.match(/\/assets\/([^"'\s]+\.js)/);
  return treffer ? treffer[1] : 'unbekannt';
}

/** Jede `/assets/`-Datei, auf die das Dokument selbst zeigt. */
function teileAus(html) {
  const gefunden = new Set();
  for (const treffer of html.matchAll(/(?:src|href)=["'](\/assets\/[^"']+)["']/g)) {
    gefunden.add(treffer[1]);
  }
  return [...gefunden];
}

async function bekannterStempel() {
  if (stempelVersprechen === null) {
    stempelVersprechen = (async () => {
      const schale = await caches.open(SCHALE_CACHE);
      const abgelegt = await schale.match(SCHALE_SCHLUESSEL);
      return abgelegt ? stempelAus(await abgelegt.text()) : 'unbekannt';
    })();
  }
  return stempelVersprechen;
}

/** Die Dateien vorladen, auf die die frische Hülle zeigt. */
async function ladeTeileVor(pfade, stempel) {
  const teile = await caches.open(teileCache(stempel));
  await Promise.all(
    pfade.map(async (pfad) => {
      if (await teile.match(pfad)) return;
      try {
        const antwort = await fetch(pfad);
        if (antwort.ok) await teile.put(pfad, antwort);
      } catch {
        // Ein Teil, das jetzt nicht kommt, holt Regel 3 später nach.
      }
    }),
  );
}

/** Jeden Teilespeicher entfernen, der nicht zum aktuellen Stempel gehört. */
async function raeumeAlteTeile(stempel) {
  const behalten = teileCache(stempel);
  for (const name of await caches.keys()) {
    if (name.startsWith(TEILE_PRAEFIX) && name !== behalten) await caches.delete(name);
  }
}

/**
 * Eine frische Hülle ablegen — und nur bei einem *neuen* Stempel aufräumen.
 *
 * Das Vorladen und das Wegräumen hängen ausdrücklich am Stempelwechsel und
 * nicht an jeder Navigation: sonst liefe bei jedem Seitenwechsel ein Abgleich
 * über den gesamten Speicher, für eine Frage, deren Antwort sich nur bei einem
 * Rollout ändert.
 */
async function legeSchaleAb(antwort) {
  const text = await antwort.clone().text();
  const neu = stempelAus(text);
  const alt = await bekannterStempel();

  const schale = await caches.open(SCHALE_CACHE);
  await schale.put(SCHALE_SCHLUESSEL, antwort);

  if (neu === alt) return;
  stempelVersprechen = Promise.resolve(neu);
  await ladeTeileVor(teileAus(text), neu);
  await raeumeAlteTeile(neu);
}

/** Regel 2: die Hülle. */
async function hoeleSchale(ereignis) {
  try {
    const antwort = await fetch(ereignis.request);
    // Nur eine gelungene Antwort wird abgelegt **und** nur eine gelungene
    // ersetzt die abgelegte. Ein 401 gehört der Anwendung, nicht diesem Worker.
    if (antwort.ok) ereignis.waitUntil(legeSchaleAb(antwort.clone()));
    return antwort;
  } catch {
    const schale = await caches.open(SCHALE_CACHE);
    const abgelegt = await schale.match(SCHALE_SCHLUESSEL);
    if (abgelegt) return abgelegt;
    return new Response(OFFLINE_SEITE, {
      status: 503,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
}

/** Regel 3: gehashte Teile. */
async function holeTeil(ereignis, pfad) {
  const stempel = await bekannterStempel();
  const teile = await caches.open(teileCache(stempel));
  const abgelegt = await teile.match(pfad);
  if (abgelegt) return abgelegt;

  const antwort = await fetch(ereignis.request);
  // `basic` heisst same-origin und lesbar; eine undurchsichtige Antwort abzulegen
  // hiesse, einen Fehlschlag als Erfolg zu speichern und dauerhaft auszuliefern.
  if (antwort.ok && antwort.type !== 'opaque') {
    ereignis.waitUntil(teile.put(pfad, antwort.clone()));
  }
  return antwort;
}

/** Regel 4: alles übrige gleichen Ursprungs. */
async function holeSonstiges(ereignis, pfad) {
  const stempel = await bekannterStempel();
  const teile = await caches.open(teileCache(stempel));
  try {
    const antwort = await fetch(ereignis.request);
    if (antwort.ok && antwort.type !== 'opaque') {
      ereignis.waitUntil(teile.put(pfad, antwort.clone()));
    }
    return antwort;
  } catch (fehler) {
    const abgelegt = await teile.match(pfad);
    if (abgelegt) return abgelegt;
    throw fehler;
  }
}

self.addEventListener('install', (ereignis) => {
  // Der Aufruf steht vor dem `waitUntil`, damit auch eine Installation ohne Netz
  // den neuen Worker übernehmen lässt: eine Korrektur an dieser Datei soll nicht
  // daran hängen, ob gerade eine Verbindung besteht.
  self.skipWaiting();
  ereignis.waitUntil(
    (async () => {
      try {
        const antwort = await fetch('/', { cache: 'no-store' });
        if (antwort.ok) await legeSchaleAb(antwort);
      } catch {
        // Offline installiert: die Hülle kommt bei der ersten Navigation.
      }
    })(),
  );
});

self.addEventListener('activate', (ereignis) => {
  ereignis.waitUntil(
    (async () => {
      const stempel = await bekannterStempel();
      // Kein Wegräumen ohne bekannten Stempel: sonst löschte ein Worker, der die
      // Hülle noch nie gesehen hat, genau die Teile, die er gerade vorgeladen hat.
      if (stempel !== 'unbekannt') await raeumeAlteTeile(stempel);
    })(),
  );
});

self.addEventListener('fetch', (ereignis) => {
  const anfrage = ereignis.request;
  if (anfrage.method !== 'GET') return;

  const url = new URL(anfrage.url);
  if (url.origin !== self.location.origin) return;
  if (istFremd(url.pathname)) return;

  if (anfrage.mode === 'navigate') {
    ereignis.respondWith(hoeleSchale(ereignis));
    return;
  }
  if (url.pathname.startsWith('/assets/')) {
    ereignis.respondWith(holeTeil(ereignis, url.pathname));
    return;
  }
  ereignis.respondWith(holeSonstiges(ereignis, url.pathname));
});
