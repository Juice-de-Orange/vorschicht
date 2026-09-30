import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, Script } from 'node:vm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Die Offline-Hülle (§17) — geprüft an der Datei, die ausgeliefert wird.
 *
 * `apps/web/public/sw.js` wird von `vite build` unverändert kopiert, es gibt
 * also kein Modul, das man importieren könnte, und keinen Bauschritt, der etwas
 * daran ändert. Diese Suite lädt deshalb **genau diese Bytes** in einen
 * `node:vm`-Kontext und stellt ihm einen Cache-Speicher und ein Netz hin, die
 * sie steuert. Ein nachgebauter Worker prüfte eine Kopie; A55s Lehre (das
 * gepflanzte Geheimnis, das der echte Scanner gar nicht kannte) gilt hier
 * genauso.
 *
 * **Die tragende Frage ist nicht „funktioniert offline", sondern „bleibt ein
 * Rollout sichtbar".** `apps/server/src/app.ts` liefert `index.html` mit
 * `no-cache` aus, damit ein Deploy niemanden auf der alten Hülle stehen lässt;
 * ein Worker, der sie festhält, hebt das auf, und niemand merkt es, weil nichts
 * fehlschlägt. Fall „ein Rollout ist sofort sichtbar" ist deshalb der Fall, an
 * dem diese Datei hängt — er wird gefahren, bevor irgendetwas über Offline
 * behauptet wird.
 */

const hier = dirname(fileURLToPath(import.meta.url));
const swPfad = join(hier, '..', '..', 'apps', 'web', 'public', 'sw.js');
const URSPRUNG = 'https://vorschicht.example';

type Ablage = Map<string, Response>;

/** Ein Cache-Speicher, so klein wie der Worker ihn benutzt. */
function baueCaches() {
  const speicher = new Map<string, Ablage>();
  return {
    speicher,
    api: {
      async open(name: string) {
        let ablage = speicher.get(name);
        if (!ablage) {
          ablage = new Map();
          speicher.set(name, ablage);
        }
        const fest = ablage;
        return {
          async match(schluessel: string) {
            const treffer = fest.get(schluessel);
            return treffer ? treffer.clone() : undefined;
          },
          async put(schluessel: string, antwort: Response) {
            fest.set(schluessel, antwort);
          },
          async keys() {
            return [...fest.keys()].map((pfad) => ({ url: new URL(pfad, URSPRUNG).href }));
          },
          async delete(schluessel: string) {
            return fest.delete(schluessel);
          },
        };
      },
      async keys() {
        return [...speicher.keys()];
      },
      async delete(name: string) {
        return speicher.delete(name);
      },
    },
  };
}

type Zuhoerer = (ereignis: unknown) => void;

type Welt = {
  zuhoerer: Map<string, Zuhoerer>;
  caches: ReturnType<typeof baueCaches>;
  netz: ReturnType<typeof vi.fn>;
  skipWaiting: ReturnType<typeof vi.fn>;
  claim: ReturnType<typeof vi.fn>;
};

const quelle = new Script(readFileSync(swPfad, 'utf8'), { filename: swPfad });

/** Die ausgelieferte Datei in einem Kontext auswerten, den dieser Test hält. */
function starteWorker(): Welt {
  const zuhoerer = new Map<string, Zuhoerer>();
  const caches = baueCaches();
  const netz = vi.fn();
  const skipWaiting = vi.fn();
  const claim = vi.fn();

  const self = {
    addEventListener: (art: string, fn: Zuhoerer) => zuhoerer.set(art, fn),
    location: new URL(`${URSPRUNG}/sw.js`),
    skipWaiting,
    clients: { claim },
    registration: {},
  };

  const kontext = createContext({
    self,
    caches: caches.api,
    fetch: netz,
    Response,
    Request,
    URL,
    console,
    setTimeout,
    clearTimeout,
    Promise,
    Set,
    Map,
  });
  quelle.runInContext(kontext);

  return { zuhoerer, caches, netz, skipWaiting, claim };
}

type Ergebnis = { antwort?: Response; behandelt: boolean };

/** Ein `fetch`-Ereignis in den Worker geben und auf alle Nebenwirkungen warten. */
async function feuere(
  welt: Welt,
  anfrage: { url: string; method?: string; mode?: string },
): Promise<Ergebnis> {
  const zuhoerer = welt.zuhoerer.get('fetch');
  if (!zuhoerer) throw new Error('kein fetch-Zuhörer angemeldet');

  const nacharbeit: Promise<unknown>[] = [];
  let versprechen: Promise<Response> | null = null;
  zuhoerer({
    request: { method: 'GET', mode: 'no-cors', ...anfrage },
    respondWith: (p: Promise<Response>) => {
      versprechen = p;
    },
    waitUntil: (p: Promise<unknown>) => nacharbeit.push(p),
  });

  if (versprechen === null) return { behandelt: false };
  const antwort = await (versprechen as Promise<Response>);
  await Promise.all(nacharbeit);
  return { antwort, behandelt: true };
}

async function lebenszyklus(welt: Welt, art: 'install' | 'activate') {
  const zuhoerer = welt.zuhoerer.get(art);
  if (!zuhoerer) throw new Error(`kein ${art}-Zuhörer angemeldet`);
  const nacharbeit: Promise<unknown>[] = [];
  zuhoerer({ waitUntil: (p: Promise<unknown>) => nacharbeit.push(p) });
  await Promise.all(nacharbeit);
}

const huelle = (marke: string, teil = 'index-aaaa.js') =>
  `<!doctype html><html><head><link rel="stylesheet" href="/assets/index-aaaa.css">` +
  `</head><body><!-- ${marke} --><script type="module" src="/assets/${teil}"></script></body></html>`;

function html(koerper: string) {
  return new Response(koerper, { status: 200, headers: { 'content-type': 'text/html' } });
}

/**
 * Ein Netz, das nach Pfad antwortet — kein `mockResolvedValueOnce`-Stapel.
 *
 * Der Unterschied ist nicht Bequemlichkeit: der Worker holt beim Installieren
 * die Hülle **und** jedes Teil, auf das sie zeigt, und in welcher Reihenfolge er
 * das tut, ist seine Sache und nicht die dieses Tests. Eine Reihenfolge zu
 * mocken hiesse, eine Zusicherung an eine Eigenschaft zu binden, die niemand
 * verspricht — der erste Anlauf tat genau das und wurde rot, weil die
 * Stylesheet-Anfrage die Antwort verbrauchte, die für das Skript gedacht war.
 *
 * Ein nicht eingetragener Pfad wird **abgelehnt**, nicht mit einem leeren 200
 * beantwortet: „gibt es nicht" und „ist leer" sind verschiedene Tatsachen, und
 * die zweite hätte hier einen abgelegten leeren Eintrag erzeugt.
 */
function netzRoutet(welt: Welt, tabelle: Record<string, () => Response>) {
  welt.netz.mockImplementation((eingabe: unknown) => {
    const roh = typeof eingabe === 'string' ? eingabe : (eingabe as { url: string }).url;
    const pfad = new URL(roh, URSPRUNG).pathname;
    const bauer = tabelle[pfad];
    if (!bauer) return Promise.reject(new Error(`kein Eintrag für ${pfad}`));
    return Promise.resolve(bauer());
  });
}

/** Die Hülle unter jedem Pfad, wie `serveShell` es tut, plus ihre zwei Teile. */
function server(marke: string, teil = 'index-aaaa.js'): Record<string, () => Response> {
  const dokument = () => html(huelle(marke, teil));
  return new Proxy(
    {
      '/assets/index-aaaa.css': () => new Response('css', { status: 200 }),
      [`/assets/${teil}`]: () => new Response(`js ${teil}`, { status: 200 }),
    },
    {
      get(ziel, name: string) {
        // `serveShell` fällt für jeden Nicht-API-Pfad auf index.html zurück;
        // dieser Stellvertreter tut dasselbe, damit eine Navigation auf
        // `/posteingang` hier dieselbe Antwort bekommt wie dort.
        if (name in ziel) return (ziel as Record<string, () => Response>)[name];
        return name.startsWith('/assets/') ? undefined : dokument;
      },
    },
  ) as Record<string, () => Response>;
}

describe('Was diesem Worker nicht gehört, fasst er nicht an', () => {
  let welt: Welt;
  beforeEach(() => {
    welt = starteWorker();
  });

  for (const pfad of ['/api/overview', '/api/projekte/17/gates', '/events', '/healthz']) {
    it(`lässt ${pfad} unberührt durch`, async () => {
      // Kein `respondWith` heisst: der Browser holt es selbst, ohne diesen
      // Worker in der Mitte. Eine zwischengespeicherte API-Antwort wäre ein
      // Dashboard, das einen Stand von gestern als „live" zeigt, und ein durch
      // eine eigene Antwort ersetzter SSE-Strom verliert seinen Zweck.
      const ergebnis = await feuere(welt, { url: `${URSPRUNG}${pfad}`, mode: 'cors' });
      expect(ergebnis.behandelt).toBe(false);
      expect(welt.netz).not.toHaveBeenCalled();
    });
  }

  it('lässt jede Anfrage durch, die nicht GET ist', async () => {
    const ergebnis = await feuere(welt, { url: `${URSPRUNG}/`, method: 'PUT', mode: 'navigate' });
    expect(ergebnis.behandelt).toBe(false);
  });

  it('lässt fremde Ursprünge durch', async () => {
    const ergebnis = await feuere(welt, { url: 'https://example.org/assets/index-aaaa.js' });
    expect(ergebnis.behandelt).toBe(false);
  });
});

describe('Ein Rollout bleibt sichtbar', () => {
  let welt: Welt;
  beforeEach(() => {
    welt = starteWorker();
  });

  it('bedient die Hülle aus dem Netz, auch wenn eine ältere abgelegt ist', async () => {
    // Der Fall, für den diese Datei existiert. `serveShell` schickt index.html
    // mit `no-cache`, „or a deploy leaves browsers on the previous shell" — ein
    // Worker, der die Hülle zuerst aus dem Speicher bedient, hebt genau das auf,
    // und nichts schlägt dabei fehl.
    netzRoutet(welt, server('alt'));
    await lebenszyklus(welt, 'install');

    netzRoutet(welt, server('neu', 'index-bbbb.js'));
    const ergebnis = await feuere(welt, { url: `${URSPRUNG}/posteingang`, mode: 'navigate' });

    expect(await ergebnis.antwort?.text()).toContain('neu');
  });

  it('legt die frische Hülle ab und räumt den alten Teilespeicher weg', async () => {
    netzRoutet(welt, server('alt'));
    await lebenszyklus(welt, 'install');
    expect([...welt.caches.speicher.keys()]).toContain('vorschicht-teile-v1-index-aaaa.js');

    netzRoutet(welt, server('neu', 'index-bbbb.js'));
    await feuere(welt, { url: `${URSPRUNG}/`, mode: 'navigate' });

    const namen = [...welt.caches.speicher.keys()];
    expect(namen).toContain('vorschicht-teile-v1-index-bbbb.js');
    expect(namen).not.toContain('vorschicht-teile-v1-index-aaaa.js');
  });

  it('reicht eine Antwort, die nicht ok ist, durch statt sie zu ersetzen', async () => {
    // Ein 401 oder 404 gehört der Anwendung. Ihn durch die abgelegte Hülle zu
    // beantworten hiesse, einen Fehler als beruhigende alte Seite auszuliefern —
    // und der Server hätte keine Möglichkeit mehr, etwas zu sagen.
    netzRoutet(welt, server('alt'));
    await lebenszyklus(welt, 'install');

    netzRoutet(welt, { '/weg': () => new Response('nicht gefunden', { status: 404 }) });
    const ergebnis = await feuere(welt, { url: `${URSPRUNG}/weg`, mode: 'navigate' });

    expect(ergebnis.antwort?.status).toBe(404);
    expect(await ergebnis.antwort?.text()).toBe('nicht gefunden');
  });
});

describe('Offline steht die Hülle bereit', () => {
  let welt: Welt;
  beforeEach(() => {
    welt = starteWorker();
  });

  it('bedient eine Navigation aus dem Speicher, wenn das Netz schweigt', async () => {
    netzRoutet(welt, server('abgelegt'));
    await lebenszyklus(welt, 'install');

    welt.netz.mockRejectedValue(new Error('offline'));
    const ergebnis = await feuere(welt, { url: `${URSPRUNG}/aufgaben`, mode: 'navigate' });

    expect(ergebnis.antwort?.status).toBe(200);
    expect(await ergebnis.antwort?.text()).toContain('abgelegt');
  });

  it('antwortet auf Deutsch, wenn auch nichts abgelegt ist', async () => {
    welt.netz.mockRejectedValue(new Error('offline'));
    const ergebnis = await feuere(welt, { url: `${URSPRUNG}/`, mode: 'navigate' });

    expect(ergebnis.antwort?.status).toBe(503);
    const text = (await ergebnis.antwort?.text()) ?? '';
    expect(text).toContain('Keine Verbindung');
    expect(text).not.toMatch(/\b(offline available|no connection|please retry)\b/i);
  });

  it('holt ein gehashtes Teil beim zweiten Mal ohne Netz', async () => {
    // Regel 3, und der Grund, warum Offline überhaupt etwas nützt: eine Hülle
    // ohne ihr JavaScript ist eine leere Seite.
    netzRoutet(welt, server('alt'));
    await lebenszyklus(welt, 'install');

    welt.netz.mockClear();
    welt.netz.mockRejectedValue(new Error('offline'));
    const ergebnis = await feuere(welt, { url: `${URSPRUNG}/assets/index-aaaa.js` });

    expect(await ergebnis.antwort?.text()).toBe('js index-aaaa.js');
    expect(welt.netz).not.toHaveBeenCalled();
  });
});

describe('Die Anmeldung zeigt auf die Datei, die es gibt', () => {
  it('meldet genau den Pfad an, unter dem der Worker ausgeliefert wird', () => {
    // Zwei unabhängige Zeichenketten in zwei Dateien, und die eine Prüfung, die
    // sie aneinander hält. §17s Kriterium in `installierbarkeit.mjs` ist ein
    // **Oder** — `/sw.js` wird als JavaScript ausgeliefert *oder* das Bündel
    // meldet einen an —, also bestünde es auch bei einer Anmeldung auf einen
    // Pfad, den es nicht gibt: die Datei liegt ja da. Genau diese Form hat
    // A81.3 gekostet (`/inbox` gegen `/posteingang`), wo jeder Deep Link in
    // jeder Benachrichtigung ins Leere lief und beide Hälften für sich richtig
    // waren.
    const einstieg = readFileSync(join(hier, '..', '..', 'apps', 'web', 'src', 'main.tsx'), 'utf8');
    const treffer = einstieg.match(/serviceWorker\s*\.\s*register\(\s*'([^']+)'/);
    expect(treffer, 'main.tsx meldet keinen Service Worker an').not.toBeNull();

    const angemeldet = treffer?.[1] ?? '';
    expect(angemeldet.startsWith('/')).toBe(true);
    expect(join(hier, '..', '..', 'apps', 'web', 'public', angemeldet.slice(1))).toBe(swPfad);
  });
});

describe('Die beiden Übernahme-Entscheidungen stehen im Code, nicht im Kopf', () => {
  it('übernimmt sofort (skipWaiting) und claimt nie eine laufende Seite', async () => {
    // Beides ist im Dateikopf begründet. Diese Zusicherung sorgt dafür, dass ein
    // späteres `clients.claim()` eine Entscheidung ist und kein Zusatz, den
    // jemand aus einem Beispiel übernommen hat: es ist die eine Zeile, die das
    // Verhalten einer bereits geladenen Seite ändert.
    const welt = starteWorker();
    welt.netz.mockRejectedValue(new Error('offline'));
    await lebenszyklus(welt, 'install');
    await lebenszyklus(welt, 'activate');

    expect(welt.skipWaiting).toHaveBeenCalledTimes(1);
    expect(welt.claim).not.toHaveBeenCalled();
  });

  it('löscht bei unbekanntem Stempel keinen Teilespeicher', async () => {
    // Ein Worker, der die Hülle noch nie gesehen hat, weiss nicht, welcher
    // Speicher der aktuelle ist. Räumte er trotzdem auf, löschte er genau die
    // Teile, die er gerade vorgeladen hat.
    const welt = starteWorker();
    welt.netz.mockRejectedValue(new Error('offline'));
    const speicher = welt.caches.speicher;
    speicher.set('vorschicht-teile-v1-index-aaaa.js', new Map());

    await lebenszyklus(welt, 'activate');

    expect([...speicher.keys()]).toContain('vorschicht-teile-v1-index-aaaa.js');
  });
});
