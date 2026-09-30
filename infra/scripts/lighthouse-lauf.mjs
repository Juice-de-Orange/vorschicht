/**
 * Ein Lighthouse-Lauf im gedrosselten Mobilprofil — die eine Stelle, an der
 * `check-leistungsbudget.mjs` (gegen den gebauten Bundle) und
 * `check-kaltstart.mjs` (gegen den VPS) dasselbe Messinstrument benutzen.
 *
 * Zwei Gates hängen daran und ihre Zahlen müssen vergleichbar sein: „performance
 * budget met" misst lokal, „cold load < 2s against the VPS" misst über das Netz,
 * und wenn die beiden verschieden drosselten, wäre die Differenz zwischen ihnen
 * nicht mehr die Leitung, sondern die Konfiguration.
 *
 * **Welches Profil.** Lighthouses Voreinstellung für Mobilgeräte, unverändert
 * übernommen und hier benannt statt vorausgesetzt: `formFactor: 'mobile'`,
 * Bildschirmemulation eines Mittelklassetelefons, 1,6 Mbit/s Abwärtsrate,
 * 150 ms Umlaufzeit, CPU-Verlangsamung 4×. Es ist die Drosselung, auf der jeder
 * veröffentlichte Lighthouse-Wert der Welt beruht — eine eigene wäre eine Zahl,
 * die mit nichts vergleichbar ist.
 *
 * **Simuliert, nicht angelegt.** Lighthouse misst standardmässig auf der
 * vorhandenen Leitung und rechnet die langsame daraus (`simulate`). Das ist
 * reproduzierbarer als echte Drosselung und der Grund, warum derselbe Baum
 * zweimal dieselbe Zahl ergibt. Der Preis steht in der Rückgabe: `beobachtet`
 * trägt die **ungedrosselten** Zeiten mit, damit eine Aussage über das Netz
 * („der VPS liefert 400 kB unkomprimiert aus") nicht in einem Modell verschwindet.
 *
 * **Kalt per Konstruktion.** Jeder Lauf startet Chrome mit einem frischen
 * Profil, also ohne Cache, ohne Service Worker, ohne Sitzung. Genau das meint
 * „cold load"; es muss nichts geleert werden, weil nie etwas da war.
 */
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { NichtsGeprueft } from './leistungsbudget.mjs';

/**
 * Ein vollständiger Chrome, in dieser Reihenfolge gesucht: `CHROME_PATH` · der
 * von Playwright angeheftete Build · irgendein anderer vollständiger Chromium in
 * Playwrights Ablage · ein systemweiter Chrome.
 *
 * Zuerst Playwright, weil das der Browser ist, den auch die Browserstrecke
 * fährt — eine Quelle statt einer zweiten Installation. Die Rückfallstufen sind
 * gemessen entstanden und nicht vorsorglich: auf dieser Maschine heftet
 * Playwright 1.62 den Build 1234 an, heruntergeladen ist davon aber nur die
 * *Headless-Schale*, und der vollständige Chrome liegt unter 1217. Lighthouse
 * braucht den vollständigen.
 *
 * **Welcher es wurde, steht in der Profilzeile jedes Laufs.** Lighthouse-Werte
 * hängen an der Chrome-Version, und eine Messung, die nicht sagt, womit sie
 * gemessen hat, ist mit der nächsten nicht vergleichbar.
 *
 * Die Headless-Schale wird ausdrücklich **nicht** genommen: sie ist kein
 * vollständiger Browser, und ein Prüfer, der stillschweigend darauf ausweicht,
 * meldet Zahlen aus einem anderen Programm unter demselben Namen.
 */
async function chromePfad() {
  const kandidaten = [];
  if (process.env.CHROME_PATH) kandidaten.push(process.env.CHROME_PATH);

  try {
    // Über `@playwright/test`, nicht über `playwright-core`: das Kernpaket ist
    // eine transitive Abhängigkeit und unter pnpms strengem Baum von der Wurzel
    // aus nicht auflösbar. Gemessen, nicht vermutet — der erste Anlauf
    // scheiterte genau daran und meldete „kein Browser gefunden" auf einer
    // Maschine, auf der Chromium liegt.
    const { chromium } = await import('@playwright/test');
    kandidaten.push(chromium.executablePath());
  } catch {
    // Kein Playwright — die Rückfallstufen unten bleiben.
  }

  const ablage = join(homedir(), '.cache', 'ms-playwright');
  try {
    for (const eintrag of await readdir(ablage)) {
      // `chromium_headless_shell-*` bleibt draussen, siehe oben.
      if (!/^chromium-\d+$/.test(eintrag)) continue;
      kandidaten.push(join(ablage, eintrag, 'chrome-linux64', 'chrome'));
      kandidaten.push(join(ablage, eintrag, 'chrome-linux', 'chrome'));
    }
  } catch {
    // Keine Ablage, keine Kandidaten von dort.
  }

  for (const name of ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']) {
    kandidaten.push(name);
  }

  for (const pfad of kandidaten) {
    try {
      await access(pfad);
      return pfad;
    } catch {
      // nächster
    }
  }

  throw new NichtsGeprueft(
    'Kein vollständiger Chrome gefunden. Gesucht in dieser Reihenfolge: CHROME_PATH, ' +
      `Playwrights angehefteter Build, ${ablage}/chromium-*, /usr/bin. ` +
      'Abhilfe: `pnpm exec playwright install chromium` oder CHROME_PATH setzen. ' +
      `Geprüft wurden: ${kandidaten.join(', ')}`,
  );
}

/**
 * @param {string} url
 * @returns {Promise<{profil: string, werte: Record<string, number>, beobachtet: Record<string, number>, roh: object}>}
 */
export async function lighthouseLauf(url) {
  const pfad = await chromePfad();

  let lighthouse;
  let chromeLauncher;
  try {
    lighthouse = (await import('lighthouse')).default;
    chromeLauncher = await import('chrome-launcher');
  } catch (cause) {
    throw new NichtsGeprueft('lighthouse ist nicht installiert (pnpm install).', { cause });
  }

  const chrome = await chromeLauncher.launch({
    chromePath: pfad,
    // `--no-sandbox` ist hier vertretbar und anderswo nicht: der Browser lädt
    // ausschliesslich eine Adresse, die dieses Skript ihm nennt, und läuft in
    // einem Wegwerfprofil. Ohne das Flag scheitert der Start in Containern und
    // unter manchen Kernel-Härtungen — und ein Prüfer, der auf der Zielmaschine
    // gar nicht startet, misst nichts.
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const ergebnis = await lighthouse(
      url,
      { port: chrome.port, output: 'json', logLevel: 'error' },
      // Nur die Leistungskategorie: die anderen kosten Zeit und beantworten
      // Fragen, die woanders beantwortet werden — Zugänglichkeit misst der
      // axe-Lauf über **alle** Seiten, nicht eine Stichprobe auf der Startseite.
      { extends: 'lighthouse:default', settings: { onlyCategories: ['performance'] } },
    );
    if (!ergebnis?.lhr) throw new NichtsGeprueft(`Lighthouse lieferte kein Ergebnis für ${url}.`);
    const lhr = ergebnis.lhr;

    if (lhr.runtimeError) {
      throw new NichtsGeprueft(
        `Lighthouse konnte ${url} nicht laden: ${lhr.runtimeError.code} — ${lhr.runtimeError.message}`,
      );
    }

    const zahl = (id) => lhr.audits?.[id]?.numericValue ?? null;
    const drosselung = lhr.configSettings?.throttling ?? {};

    return {
      profil:
        `${lhr.configSettings?.formFactor ?? '?'}, ${drosselung.throughputKbps ?? '?'} kbit/s, ` +
        `${drosselung.rttMs ?? '?'} ms RTT, CPU ${drosselung.cpuSlowdownMultiplier ?? '?'}×, ` +
        `Drosselung ${lhr.configSettings?.throttlingMethod ?? '?'}, ` +
        // Ohne die Version ist eine Lighthouse-Zahl mit der nächsten nicht
        // vergleichbar; ohne den Pfad weiss niemand, welcher der Kandidaten
        // oben genommen wurde.
        `${lhr.environment?.hostUserAgent ?? '?'} (${pfad})`,
      werte: {
        // Lighthouse gibt 0–1 zurück; das Budget spricht in Punkten, wie jede
        // veröffentlichte Lighthouse-Zahl.
        leistungswert: Math.round((lhr.categories?.performance?.score ?? 0) * 100),
        lcp: zahl('largest-contentful-paint'),
        fcp: zahl('first-contentful-paint'),
        tbt: zahl('total-blocking-time'),
        cls: lhr.audits?.['cumulative-layout-shift']?.numericValue ?? null,
        si: zahl('speed-index'),
        tti: zahl('interactive'),
        // Was wirklich über die Leitung ging — die Zahl, die eine fehlende
        // Kompression sichtbar macht und die keine Modellrechnung ersetzt.
        uebertragen: zahl('total-byte-weight'),
      },
      beobachtet: {
        lcp: lhr.audits?.['largest-contentful-paint']?.numericValue ?? null,
        ladezeit: lhr.timing?.total ?? null,
      },
      roh: lhr,
    };
  } finally {
    await chrome.kill();
  }
}

/**
 * Was der Ursprung je Antwort wirklich geschickt hat, aus Lighthouses eigenem
 * Netzwerkprotokoll.
 *
 * Getrennt von den Metriken, weil es eine Aussage über die **Auslieferung** ist
 * und nicht über das Artefakt: derselbe Bundle ist hinter einem Server mit
 * Kompression ein Drittel so schwer wie ohne. Ein Budget, das beides in einer
 * Zahl führte, gäbe einer Änderung an der nginx-Konfiguration und einer neuen
 * Abhängigkeit dieselbe Stimme.
 */
export function antworten(lhr) {
  const eintraege = lhr?.audits?.['network-requests']?.details?.items ?? [];
  return eintraege.map((eintrag) => ({
    url: eintrag.url,
    typ: eintrag.mimeType ?? eintrag.resourceType ?? '?',
    uebertragen: eintrag.transferSize ?? null,
    entpackt: eintrag.resourceSize ?? null,
  }));
}
