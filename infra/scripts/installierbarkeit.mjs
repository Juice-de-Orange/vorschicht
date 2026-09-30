/**
 * Chromes Installierbarkeitskriterien, einzeln geprüft — weil das Werkzeug, das
 * der Gate-Satz nennt, sie nicht mehr prüft.
 *
 * §22 Phase 7 verlangt „Lighthouse: PWA installable pass". Nachgesehen in
 * `lighthouse/core/config/default-config.js` der hier installierten Version
 * 13.4.1: die Kategorien sind performance, accessibility, best-practices, seo
 * und agentic-browsing, und **kein einziger Prüfpunkt** trägt install, manifest,
 * service-worker, maskable, pwa oder offline im Namen. Die PWA-Kategorie samt
 * `installable-manifest` wurde mit Lighthouse 12 entfernt. Der Gate-Satz nennt
 * also ein Instrument, das seine eigene Frage nicht mehr beantwortet.
 *
 * Daraus „nicht prüfbar" zu machen wäre bequem und falsch: die Kriterien sind
 * veröffentlicht und einzeln nachprüfbar. Also werden sie einzeln geprüft, jedes
 * mit eigenem Urteil, damit ein Fehlschlag **sagt, welches fehlt** statt „nicht
 * installierbar" zu melden.
 *
 * Quelle der Liste: web.dev, „What does it take to be installable?"
 * (https://web.dev/articles/install-criteria), abgerufen am 12.8.2026 — Googles
 * eigene Dokumentation zu Chromes Verhalten, nach §14 eine L4/L5-Quelle. Zwei
 * Dinge daraus sind ausdrücklich **nicht** hier geprüft, weil sie keine
 * Eigenschaft der Auslieferung sind: dass die App nicht schon installiert ist,
 * und Chromes Nutzungsheuristik (ein Klick, dreissig Sekunden Verweildauer).
 *
 * Und einer, der dort **nicht** steht: ein Service Worker ist nach dieser
 * Fassung der Dokumentation keine Bedingung für Installierbarkeit. §17 verlangt
 * trotzdem einen („service worker with offline app shell"), also wird er
 * geprüft — aber unter §17s Namen und nicht unter Chromes, weil die beiden
 * Aussagen verschieden sind und ein Zusammenwerfen später als Chrome-Kriterium
 * gelesen würde.
 */

const ERLAUBTE_ANZEIGE = ['fullscreen', 'standalone', 'minimal-ui', 'window-controls-overlay'];

function ja(titel, detail = '') {
  return { titel, urteil: 'ja', detail };
}
function nein(titel, detail) {
  return { titel, urteil: 'nein', detail };
}
function unbekannt(titel, detail) {
  return { titel, urteil: 'unbekannt', detail };
}

export function alsInstallZeile(kriterium) {
  const zeichen =
    kriterium.urteil === 'ja'
      ? '\x1b[32m✓\x1b[0m'
      : kriterium.urteil === 'nein'
        ? '\x1b[31m✗\x1b[0m'
        : '\x1b[33m?\x1b[0m';
  return `  ${zeichen} ${kriterium.titel}${kriterium.detail ? ` — ${kriterium.detail}` : ''}`;
}

/**
 * Breite und Höhe eines PNG aus dem IHDR-Block.
 *
 * Warum überhaupt: `sizes: "512x512"` im Manifest ist eine **Behauptung** des
 * Autors. Chrome lädt das Bild und misst nach, und ein als 512 deklariertes
 * 64-Pixel-Symbol macht die App unin­stallierbar, während jede Prüfung, die nur
 * das Manifest liest, grün meldet. Acht Bytes aus dem Kopf der Datei zu lesen
 * ist billiger als eine Bildbibliothek und beantwortet genau die Frage.
 */
export function pngGroesse(puffer) {
  const signatur = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (puffer.length < 24 || !puffer.subarray(0, 8).equals(signatur)) return null;
  if (puffer.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { breite: puffer.readUInt32BE(16), hoehe: puffer.readUInt32BE(20) };
}

async function hole(url) {
  try {
    const antwort = await fetch(url);
    return { ok: antwort.ok, status: antwort.status, antwort };
  } catch (fehler) {
    return { ok: false, status: 0, fehler };
  }
}

/**
 * @param {string} basis Der ausgelieferte Ursprung, z. B. `https://…` oder `http://127.0.0.1:4173`.
 */
export async function pruefeInstallierbarkeit(basis) {
  const kriterien = [];
  const ursprung = new URL(basis);

  // 1. Sicherer Ursprung. `localhost` und `127.0.0.1` gelten Chrome ausdrücklich
  //    als sicher, sonst wäre keine lokale Entwicklung möglich.
  const sicher =
    ursprung.protocol === 'https:' ||
    ursprung.hostname === 'localhost' ||
    ursprung.hostname === '127.0.0.1';
  kriterien.push(
    sicher
      ? ja('Sicherer Ursprung', ursprung.origin)
      : nein('Sicherer Ursprung', `${ursprung.origin} ist weder HTTPS noch localhost`),
  );

  // 2. Das Dokument verweist auf ein Manifest — geprüft am ausgelieferten HTML,
  //    nicht an der Vorlage im Baum, weil der Build die Verweise umschreibt.
  const seite = await hole(basis);
  // Einmal geholt, zweimal gelesen: der Rumpf einer `Response` lässt sich nur ein
  // einziges Mal auswerten, und zwei Abrufe wären zwei Antworten, die
  // auseinandergehen können.
  const html = seite.ok ? await seite.antwort.text() : '';
  let manifestUrl = null;
  if (!seite.ok) {
    kriterien.push(
      unbekannt(
        'Manifest verlinkt',
        `${basis} antwortet nicht (${seite.status || seite.fehler?.message})`,
      ),
    );
  } else {
    const treffer = html.match(/<link[^>]+rel=["']manifest["'][^>]*>/i);
    const href = treffer?.[0].match(/href=["']([^"']+)["']/i)?.[1] ?? null;
    if (href === null) {
      kriterien.push(
        nein('Manifest verlinkt', 'kein <link rel="manifest"> im ausgelieferten HTML'),
      );
    } else {
      manifestUrl = new URL(href, basis).toString();
      kriterien.push(ja('Manifest verlinkt', href));
    }
  }

  if (manifestUrl === null) return kriterien;

  // 3. Das Manifest ist abrufbar und lesbar.
  const manifestAntwort = await hole(manifestUrl);
  if (!manifestAntwort.ok) {
    kriterien.push(
      nein(
        'Manifest abrufbar',
        `${manifestUrl} → ${manifestAntwort.status || manifestAntwort.fehler?.message}`,
      ),
    );
    return kriterien;
  }
  let manifest;
  try {
    manifest = JSON.parse(await manifestAntwort.antwort.text());
  } catch (fehler) {
    kriterien.push(
      nein('Manifest abrufbar', `${manifestUrl} ist kein lesbares JSON: ${fehler.message}`),
    );
    return kriterien;
  }
  kriterien.push(ja('Manifest abrufbar', manifestUrl));

  // 4. Name.
  const name = manifest.name ?? manifest.short_name ?? null;
  kriterien.push(
    name
      ? ja('name oder short_name', name)
      : nein('name oder short_name', 'beide fehlen oder sind leer'),
  );

  // 5. start_url.
  kriterien.push(
    manifest.start_url ? ja('start_url', String(manifest.start_url)) : nein('start_url', 'fehlt'),
  );

  // 6. display.
  kriterien.push(
    ERLAUBTE_ANZEIGE.includes(manifest.display)
      ? ja('display', String(manifest.display))
      : nein(
          'display',
          `„${manifest.display ?? 'fehlt'}" — erlaubt sind ${ERLAUBTE_ANZEIGE.join(', ')}`,
        ),
  );

  // 7. prefer_related_applications.
  kriterien.push(
    manifest.prefer_related_applications === undefined ||
      manifest.prefer_related_applications === false
      ? ja('prefer_related_applications', 'fehlt oder false')
      : nein(
          'prefer_related_applications',
          'steht auf true — Chrome bietet dann die native App an',
        ),
  );

  // 8. Symbole in 192 und 512 Pixeln, und zwar wirklich.
  const symbole = Array.isArray(manifest.icons) ? manifest.icons : [];
  if (symbole.length === 0) {
    kriterien.push(nein('Symbole 192 px und 512 px', 'die Symbolliste des Manifests ist leer'));
  } else {
    const gemessen = [];
    for (const symbol of symbole) {
      const url = new URL(symbol.src, manifestUrl).toString();
      const antwort = await hole(url);
      if (!antwort.ok) {
        gemessen.push({
          url,
          fehler: `nicht abrufbar (${antwort.status || antwort.fehler?.message})`,
        });
        continue;
      }
      const puffer = Buffer.from(await antwort.antwort.arrayBuffer());
      const groesse = pngGroesse(puffer);
      gemessen.push({
        url,
        deklariert: symbol.sizes ?? '?',
        // Nur PNG wird nachgemessen. Ein SVG hat keine feste Pixelgrösse und
        // wird deshalb geglaubt, was hier ausdrücklich als Grenze steht statt
        // als stille Ausnahme.
        gemessen: groesse ? `${groesse.breite}x${groesse.hoehe}` : null,
        kante: groesse ? Math.min(groesse.breite, groesse.hoehe) : null,
      });
    }
    const nichtAbrufbar = gemessen.filter((g) => g.fehler);
    for (const eintrag of nichtAbrufbar) {
      kriterien.push(nein('Symbol abrufbar', `${eintrag.url}: ${eintrag.fehler}`));
    }
    const falschDeklariert = gemessen.filter(
      (g) =>
        g.gemessen !== null &&
        g.deklariert !== '?' &&
        !String(g.deklariert).split(/\s+/).includes(g.gemessen),
    );
    for (const eintrag of falschDeklariert) {
      kriterien.push(
        nein(
          'Symbolgrösse stimmt',
          `${eintrag.url}: deklariert ${eintrag.deklariert}, gemessen ${eintrag.gemessen}`,
        ),
      );
    }
    const kanten = gemessen.map((g) => g.kante).filter((k) => k !== null);
    const ungemessen = gemessen.filter((g) => !g.fehler && g.gemessen === null);
    // „**Mindestens** 192" und „mindestens 512", nicht „genau". Die
    // Dokumentation nennt die beiden Zahlen, und ein Projekt mit einem
    // 256-Pixel-Symbol erfüllt die Absicht, während ein Gleichheitsvergleich es
    // ablehnte — ein falsches Nein ist hier die teurere Richtung, weil es jemanden
    // an eine Datei schickt, mit der nichts ist.
    const hatMindestens = (n) => kanten.some((k) => k >= n);
    if (hatMindestens(192) && hatMindestens(512)) {
      kriterien.push(ja('Symbole 192 px und 512 px', `${kanten.join(', ')} px gemessen`));
    } else if (ungemessen.length > 0) {
      // Ein SVG hat keine Pixelgrösse zum Nachmessen. „Nicht nachgemessen" ist
      // nicht dasselbe wie „zu klein", und die beiden zu verwechseln wäre genau
      // die Fehlklassifikation, gegen die A25 geschrieben ist.
      kriterien.push(
        unbekannt(
          'Symbole 192 px und 512 px',
          `${ungemessen.length} Symbol(e) sind kein PNG — Grösse nicht nachgemessen` +
            `${kanten.length ? `; nachgemessen: ${kanten.join(', ')} px` : ''}`,
        ),
      );
    } else {
      kriterien.push(
        nein(
          'Symbole 192 px und 512 px',
          `gemessen: ${kanten.length ? `${kanten.join(', ')} px` : 'keines'}`,
        ),
      );
    }
  }

  // 9. §17s Service Worker — kein Chrome-Kriterium, siehe Kopf.
  //
  // Zwei Fallen stecken hier, und beide führen zu einem falschen Ja.
  //
  // Die App liefert die Hülle für **jeden** Pfad aus, der nicht zur API gehört
  // (`isAppShellPath`). `/sw.js` antwortet deshalb mit 200 und HTML, und eine
  // Prüfung, die nur den Status ansieht, fände einen Service Worker, den es
  // nicht gibt. Also entscheidet der Inhaltstyp.
  //
  // Und die Registrierung steht nicht im Dokument, sondern im Bundle: `index.html`
  // ist eine leere Hülle mit einem `<script>`-Verweis. Gesucht wird deshalb in
  // dem, was dieser Verweis lädt.
  const swAntwort = await hole(new URL('/sw.js', basis).toString());
  const swTyp = swAntwort.ok ? (swAntwort.antwort.headers.get('content-type') ?? '') : '';
  const swAusgeliefert = swAntwort.ok && /javascript|ecmascript/i.test(swTyp);

  let imBundle = false;
  for (const treffer of html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)) {
    const skript = await hole(new URL(treffer[1], basis).toString());
    if (!skript.ok) continue;
    if (/serviceWorker\s*\.\s*register/.test(await skript.antwort.text())) {
      imBundle = true;
      break;
    }
  }

  kriterien.push(
    swAusgeliefert || imBundle
      ? ja(
          'Service Worker (§17, kein Chrome-Kriterium)',
          swAusgeliefert ? `/sw.js wird als ${swTyp} ausgeliefert` : 'im Bundle registriert',
        )
      : nein(
          'Service Worker (§17, kein Chrome-Kriterium)',
          'keine Registrierung im Bundle, und /sw.js liefert ' +
            (swAntwort.ok ? `„${swTyp || 'ohne Typ'}" statt JavaScript` : 'nichts') +
            ' — §17 verlangt eine Offline-Hülle',
        ),
  );

  return kriterien;
}
