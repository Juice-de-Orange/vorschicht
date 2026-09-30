/**
 * Ein Kaltstart über ein gedrosseltes Mobilprofil, gemessen im Browser statt
 * über Lighthouse — und der Grund dafür ist gemessen, nicht gewählt.
 *
 * **Warum nicht Lighthouse, wo das Gate es doch für die Nachbarmessung nutzt.**
 * Lighthouse bringt gegen **jede** HTTPS-Seite von nennenswerter Grösse den
 * Renderer dieses Chromium zum Absturz: `Inspector.targetCrashed`, danach
 * `TARGET_CRASHED` und ein abgebrochener Dokumentabruf. Nachgestellt und
 * eingegrenzt statt vermutet — dieselbe Chrome-Instanz, dieselben Flags:
 *
 *   | Ziel                                  | Lighthouse | Playwright |
 *   |---------------------------------------|------------|------------|
 *   | http://127.0.0.1 (unser Bundle)       | läuft      | läuft      |
 *   | https://example.com                   | läuft      | läuft      |
 *   | https://github.com                    | **Absturz**| läuft      |
 *   | https://vorschicht.example.com        | **Absturz**| läuft      |
 *
 * github.com stürzt genauso ab, es ist also **keine Eigenschaft dieses Hosts**,
 * und die lokale Vorschau derselben Anwendung läuft durch, es ist also auch
 * keine Eigenschaft dieser Anwendung. Drei Fahnenhypothesen wurden geprüft und
 * widerlegt (chrome-launchers Voreinstellungen weglassen, den
 * CT-Komponentenaktualisierer wieder einschalten, Zertifikatsfehler ignorieren).
 * Es bleibt: dieser Chromium-Build kann unter Lighthouse keine HTTPS-Seite
 * dieser Grösse laden.
 *
 * **Was der Wechsel kostet und was er bringt.** Lighthouse *simuliert* die
 * langsame Leitung (es misst auf der schnellen und rechnet um); hier wird sie
 * **angelegt** — Chrome drosselt wirklich. Die Zahlen sind deshalb nicht
 * dieselben, und die angelegte Drosselung fällt in der Regel pessimistischer
 * aus. Für eine Obergrenze ist das die richtige Richtung: sie darf zu streng
 * sein, nicht zu milde. Und „throttled" liest sich für eine angelegte
 * Drosselung eher wörtlich als für eine gerechnete.
 *
 * Die Zahlen des Profils sind **dieselben** wie Lighthouses Mobilprofil, damit
 * die beiden Messungen dieser Phase über dieselbe Leitung sprechen: 1,6 Mbit/s
 * abwärts, 750 kbit/s aufwärts, 150 ms Umlaufzeit, CPU-Verlangsamung 4×, dazu
 * die Bildschirm- und Gerätemerkmale eines Mittelklassetelefons.
 *
 * **Kalt per Konstruktion:** jeder Lauf bekommt einen frischen Kontext, also
 * leeren Cache, keine Sitzung, keinen Service Worker. Es muss nichts geleert
 * werden, weil nie etwas da war.
 */
import { NichtsGeprueft } from './leistungsbudget.mjs';

/**
 * Lighthouses Mobilprofil, in den Einheiten, die CDP erwartet.
 *
 * `throughputKbps` ist in Lighthouse 1638,4 kbit/s; CDP will Byte pro Sekunde.
 * Die Umrechnung steht hier einmal und nicht an drei Stellen — ein Faktor 8,
 * den jemand vergisst, ergäbe eine achtmal zu schnelle Leitung und eine Zahl,
 * die den Gate-Satz mühelos einhält.
 */
export const MOBILPROFIL = {
  abwaertsKbps: 1638.4,
  aufwaertsKbps: 750,
  umlaufzeitMs: 150,
  cpuFaktor: 4,
  breite: 412,
  hoehe: 823,
  pixelverhaeltnis: 1.75,
  benutzerkennung:
    'Mozilla/5.0 (Linux; Android 12; moto g power (2022)) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/147.0.0.0 Mobile Safari/537.36',
};

export function profilbeschreibung(browserVersion) {
  return (
    `mobil ${MOBILPROFIL.breite}×${MOBILPROFIL.hoehe}@${MOBILPROFIL.pixelverhaeltnis}, ` +
    `${MOBILPROFIL.abwaertsKbps} kbit/s, ${MOBILPROFIL.umlaufzeitMs} ms RTT, ` +
    `CPU ${MOBILPROFIL.cpuFaktor}×, Drosselung angelegt (nicht simuliert), ${browserVersion}`
  );
}

/**
 * Einmal kalt laden und messen.
 *
 * @param {import('@playwright/test').Browser} browser
 * @param {string} url
 * @returns {Promise<{lcp: number|null, fcp: number|null, domInhalt: number, geladen: number, antworten: Array<object>}>}
 */
export async function messeEinmal(browser, url) {
  const context = await browser.newContext({
    viewport: { width: MOBILPROFIL.breite, height: MOBILPROFIL.hoehe },
    deviceScaleFactor: MOBILPROFIL.pixelverhaeltnis,
    isMobile: true,
    hasTouch: true,
    userAgent: MOBILPROFIL.benutzerkennung,
  });
  const page = await context.newPage();
  try {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: MOBILPROFIL.umlaufzeitMs,
      downloadThroughput: (MOBILPROFIL.abwaertsKbps * 1000) / 8,
      uploadThroughput: (MOBILPROFIL.aufwaertsKbps * 1000) / 8,
    });
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: MOBILPROFIL.cpuFaktor });

    // Der Beobachter muss **vor** der Navigation stehen: LCP-Einträge, die vor
    // seiner Registrierung entstehen, holt `buffered: true` zwar nach, aber nur
    // innerhalb desselben Dokuments — ein Skript, das erst nach dem Laden läuft,
    // hätte im ungünstigen Fall nichts zu holen.
    await page.addInitScript(() => {
      window.__lcp = null;
      new PerformanceObserver((liste) => {
        const eintraege = liste.getEntries();
        window.__lcp = eintraege[eintraege.length - 1]?.startTime ?? null;
      }).observe({ type: 'largest-contentful-paint', buffered: true });
    });

    const antwort = await page.goto(url, { waitUntil: 'load', timeout: 120_000 });
    if (!antwort) throw new NichtsGeprueft(`${url} lieferte keine Antwort.`);
    if (!antwort.ok()) throw new NichtsGeprueft(`${url} antwortet mit HTTP ${antwort.status()}.`);

    // Nach `load` noch kurz zusehen: LCP kann sich verschieben, solange Inhalt
    // nachrückt. Eine feste kleine Wartezeit statt `networkidle` — eine
    // Anwendung mit offenem Ereignisstrom wird nie ruhig, und `networkidle`
    // wartete dann bis zum Zeitlimit.
    await page.waitForTimeout(1500);

    const gemessen = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      return {
        lcp: window.__lcp,
        fcp: fcp ? fcp.startTime : null,
        domInhalt: nav ? nav.domContentLoadedEventEnd : 0,
        geladen: nav ? nav.loadEventEnd : 0,
        antworten: performance.getEntriesByType('resource').map((e) => ({
          url: e.name,
          typ: e.initiatorType,
          // Was wirklich über die Leitung ging, gegen das, was ausgepackt
          // ankam. Der Quotient der beiden ist der einzige Weg, eine fehlende
          // Kompression zu **sehen** statt sie zu vermuten.
          uebertragen: e.transferSize,
          kodiert: e.encodedBodySize,
          entpackt: e.decodedBodySize,
          dauer: e.duration,
        })),
      };
    });

    // Das Dokument selbst steht nicht unter `resource`, sondern unter
    // `navigation` — ohne diesen Eintrag fehlte in der Auslieferungstabelle
    // ausgerechnet die Antwort, die den Kaltstart eröffnet.
    const dokument = await page.evaluate(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      return nav
        ? {
            url: location.href,
            typ: 'document',
            uebertragen: nav.transferSize,
            kodiert: nav.encodedBodySize,
            entpackt: nav.decodedBodySize,
            dauer: nav.duration,
          }
        : null;
    });
    if (dokument) gemessen.antworten.unshift(dokument);

    return gemessen;
  } finally {
    await context.close();
  }
}
