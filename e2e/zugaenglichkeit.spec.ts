import { execFileSync } from 'node:child_process';
import { AxeBuilder } from '@axe-core/playwright';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createSql } from '@vorschicht/db';
import { BERICHTE_PATH } from '@vorschicht/shared/berichte';
import { BUERO_PFAD } from '@vorschicht/shared/buero';
import { CONTROLLING_PFAD } from '@vorschicht/shared/controlling';
import { DECISIONS_PATH, INBOX_PATH } from '@vorschicht/shared/inbox';
import { LOG_PFAD } from '@vorschicht/shared/log';
import { EINSTELLUNGEN_PFAD } from '@vorschicht/shared/personas';
import { AUFGABEN_PFAD } from '@vorschicht/shared/spuren';

/**
 * Zwei Pfade stehen als Wort statt als Import, und zwei weitere gibt es
 * nirgends als Konstante.
 *
 * `DOKUMENTE_PFAD` und `QUELLEN_PFAD` sind in `apps/web/src` deklariert, nicht
 * in `@vorschicht/shared`, und die App ist kein Paket, aus dem eine Testdatei
 * importieren kann; `/` und `/projekte` schreibt auch `App.tsx` als Wort hin.
 * Was A81 daran fürchtet — eine zweite Deklaration, die auseinanderläuft —
 * trägt hier die Überschriftszusicherung unten: ein umbenannter Pfad fällt auf
 * den Überblick durch, und dessen `<h2>` heisst nicht „Dokumente". Der Fall
 * wird dann rot, statt still die falsche Seite zu messen.
 */
const DOKUMENTE_PFAD = '/dokumente';
const QUELLEN_PFAD = '/quellen';

/**
 * §22 Phase 7: „axe scan on all pages: zero violations (own medicine)".
 *
 * §11 führt `a11y scan (axe)` als optionales Gate für fremde Projekte. Dieses
 * Gate dreht es um: das Dashboard nimmt seine eigene Medizin. Vier Dinge daran
 * sind Entscheidungen und keine Bequemlichkeit.
 *
 *   1. **Keine Ausnahmeliste, in keiner Form.** Kein `disableRules`, kein
 *      `withTags`, kein „bekannter Verstoss". Der Gate-Satz sagt *zero
 *      violations*, und eine Ignorierliste ist die Form, in der so ein Satz
 *      still verfällt: sie wächst um eine Zeile je unbequemem Befund, jede mit
 *      einer damals guten Begründung, und am Ende ist grün eine Aussage über
 *      die Liste statt über die Seite. Eine Regel, die dieses Projekt wirklich
 *      nicht erfüllen kann, gehört als **Befund in den Bericht** und als
 *      Entscheidung zum Betreiber — nicht in eine Datei, die niemand mehr liest.
 *
 *      Folge, ausdrücklich genannt: gescannt wird mit axes **Standardregelsatz**,
 *      also einschliesslich der `best-practice`-Regeln, die über WCAG A/AA
 *      hinausgehen. Das ist strenger als „WCAG AA" und ist gewollt — „ein
 *      axe-Scan" ohne Zusatz *ist* der Standardregelsatz, und ihn auf WCAG-Tags
 *      zu verengen wäre dieselbe Ausnahmeliste, nur in einer Zeile statt in
 *      zehn. Jeder Verstoss wird mit seinen Tags gedruckt, damit die Trennung
 *      sichtbar bleibt, falls sie je zur Frage wird.
 *
 *   2. **Die Seite muss beweisen, dass sie die Seite ist.** Ein Pfad, den
 *      `App.tsx` nicht kennt, fällt auf den Überblick durch — der Scan liefe
 *      dann elfmal über dieselbe Seite und meldete elfmal null Verstösse.
 *      Genau die Form, die §8.2s sechste Domäne sucht: ein Signal, das nicht
 *      tragen kann und trotzdem grün liest. Also trägt jede Seite ihre
 *      erwartete `<h2>`-Überschrift, und die wird **vor** dem Scan zugesichert.
 *      Wo es eine Konstante gibt, wird sie aus `@vorschicht/shared` importiert —
 *      dieselbe, aus der `App.tsx` seinen Zweig baut (A81); wo es keine gibt,
 *      steht der Pfad als Wort und die Überschrift trägt die Zusicherung.
 *
 *   3. **Die Seitenliste darf nicht veralten**, und dagegen hilft kein
 *      Vorsatz. Ein eigener Fall vergleicht die Reiter der Navigation mit den
 *      hier gescannten Seiten: ein elfter Reiter macht ihn rot, statt still
 *      ungescannt zu bleiben. Eine Liste in einer Testdatei ist sonst genau
 *      das, was ein halbes Jahr später eine Seite zu wenig enthält.
 *
 *   4. **Das Werkzeug beweist sich in jedem Lauf mit.** Der letzte Fall sät
 *      einen echten Verstoss in die fertige Seite und verlangt, dass axe ihn
 *      **namentlich** findet, und dass dieselbe Seite ohne ihn wieder sauber
 *      ist. Ein Scanner, der versehentlich nichts prüft, meldet null Verstösse
 *      — ununterscheidbar von einer barrierefreien Seite, solange niemand ihn
 *      gegen einen bekannten Fehler hält (A55s gepflanztes Geheimnis, das
 *      gitleaks gar nicht kannte, ist dieselbe Lehre eine Abteilung weiter).
 *
 * Der Lauf steht **ans Ende** der erklärten Gesamtordnung (A75.6). Das ist hier
 * kein Ordnungssinn: die sieben Suiten davor lassen Projekte, Aufgaben, Läufe,
 * Dokumente, Quellen und Eskalationen in der geteilten Datenbank zurück, und
 * eine gefüllte Seite hat mehr zu prüfen als eine leere. Was dieser Scan
 * dadurch **nicht** deckt, ist gesagt statt verschwiegen: Zustände, die keine
 * frühere Suite herstellt (ein Fehlerstreifen, ein offenes Detail, ein
 * Formular mitten in der Eingabe), werden nicht besucht.
 *
 * Lizenz der Werkzeuge: `@axe-core/playwright` und `axe-core` stehen unter
 * **MPL-2.0** — als unveränderte Abhängigkeit verwendet, nicht abgeleitet.
 */

const WEB_PORT = process.env.E2E_WEB_PORT ?? '5173';
const API_PORT = process.env.E2E_API_PORT ?? '8421';

const sql = createSql({ url: process.env.TEST_DATABASE_URL ?? '', max: 1 });

/**
 * Jede Seite des Dashboards (§17), mit dem Reiter, der sie öffnet, und der
 * Überschrift, die beweist, dass sie geöffnet wurde.
 *
 * `nav` ist absichtlich mit dabei, obwohl navigiert wird, indem der Pfad
 * angesteuert wird: der Vollständigkeitsfall unten vergleicht genau diese
 * Menge mit dem, was die Navigation im Browser anbietet.
 */
const SEITEN = [
  { nav: 'nav-ueberblick', pfad: '/', titel: 'Überblick' },
  { nav: 'nav-buero', pfad: BUERO_PFAD, titel: 'Büro' },
  { nav: 'nav-projekte', pfad: '/projekte', titel: 'Projekte' },
  { nav: 'nav-aufgaben', pfad: AUFGABEN_PFAD, titel: 'Aufgaben' },
  { nav: 'nav-posteingang', pfad: INBOX_PATH, titel: 'Posteingang' },
  { nav: 'nav-entscheidungen', pfad: DECISIONS_PATH, titel: 'Entscheidungen' },
  { nav: 'nav-dokumente', pfad: DOKUMENTE_PFAD, titel: 'Dokumente' },
  { nav: 'nav-quellen', pfad: QUELLEN_PFAD, titel: 'Quellen' },
  { nav: 'nav-berichte', pfad: BERICHTE_PATH, titel: 'Wochenberichte' },
  { nav: 'nav-controlling', pfad: CONTROLLING_PFAD, titel: 'Controlling' },
  { nav: 'nav-einstellungen', pfad: EINSTELLUNGEN_PFAD, titel: 'Einstellungen' },
  { nav: 'nav-log', pfad: LOG_PFAD, titel: 'Log' },
] as const;

function mintRescueInvite(): string {
  const output = execFileSync(
    process.execPath,
    ['apps/server/dist/cli/invite.js', '--purpose=rescue'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
        PUBLIC_ORIGIN: `http://localhost:${WEB_PORT}`,
        WEBAUTHN_RP_ID: 'localhost',
        APP_PORT: API_PORT,
        SESSION_SECRET: 'e2e-only-session-secret-that-is-long-enough-xxxx',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-placeholder-e2e-kein-echter-token',
        CLAUDE_CLI_VERSION: '2.1.220',
        NTFY_SERVER: 'http://127.0.0.1:9',
        NTFY_TOKEN: 'tk_e2e_placeholder',
      },
    },
  );
  const match = output.match(/#([A-Za-z0-9_-]{43})/);
  if (!match?.[1]) throw new Error(`Kein Token in der CLI-Ausgabe:\n${output}`);
  return match[1];
}

/**
 * Eine Sitzung für die ganze Datei, und das ist eine Korrektur an einem
 * gemessenen Fehlschlag, keine Bequemlichkeit.
 *
 * Jede Suite in dieser Kette meldet bisher **je Fall** einen neuen Passkey an.
 * `/register/options` legt dabei alle bereits vorhandenen Berechtigungen als
 * `excludeCredentials` bei, und Chrome reicht diese Liste stückweise an den
 * virtuellen Authentifikator weiter — die Anmeldung wird also mit jeder zuvor
 * registrierten Berechtigung langsamer. Allein gefahren lief diese Datei
 * dreizehn von dreizehn; **am Ende der vollständigen Kette** scheiterten sechs
 * Fälle daran, dass `logout` binnen zehn Sekunden nicht erschien — nicht an
 * axe, sondern am Anmelden davor.
 *
 * Zwölf Anmeldungen auf eine zu reduzieren löst das für diese Datei und
 * verkürzt sie nebenbei deutlich. Was es **nicht** löst, ist der Grund: die
 * Kette wird weiter langsamer, je mehr Suiten sie bekommt. Das ist als Befund
 * gemeldet und gehört nicht hierher repariert.
 *
 * Der Preis, ausdrücklich: die Fälle unten teilen sich eine Seite und sind
 * damit nicht voneinander isoliert. Vertretbar, weil dieser Scan **liest** —
 * der einzige Fall, der das DOM verändert, räumt hinter sich auf und prüft
 * danach, dass die Seite wieder sauber ist. Und sie laufen nacheinander, weil
 * `playwright.config.ts` `workers: 1` und `fullyParallel: false` setzt; eine
 * spätere Umstellung darauf müsste diese Datei mit ansehen.
 */
let sitzung: BrowserContext;
let seite: Page;

test.beforeAll(async ({ browser }) => {
  sitzung = await browser.newContext();
  seite = await sitzung.newPage();
  await anmelden(sitzung, seite);
});

test.afterAll(async () => {
  await sitzung?.close();
});

/**
 * Die Berechtigungen der vorherigen Suiten wegräumen, **bevor** hier eine neue
 * angelegt wird.
 *
 * **Gemessen am 18.8.2026, und es ist ein Skalierungsgesetz, kein Zufall.**
 * `/register/options` legt jede bereits vorhandene Berechtigung als
 * `excludeCredentials` bei, und Chrome reicht diese Liste stückweise an den
 * virtuellen Authentifikator weiter — jede zuvor registrierte macht die
 * Anmeldung langsamer. Zwölf Suiten registrieren je eine (`passkey` drei), und
 * diese hier läuft als **letzte**: sie zahlt die volle Rechnung.
 *
 * Der Kopf dieser Datei beschreibt denselben Effekt schon einmal, eine Stufe
 * früher — damals scheiterten sechs Fälle, und die Antwort war „eine Sitzung für
 * die ganze Datei". Das hat Zeit gekauft, nicht die Ursache beseitigt: am
 * 18.8. kam mit dem Log-Explorer eine zwölfte Suite dazu, und die Anmeldung
 * überschritt die zehn Sekunden. **Die Zeitgrenze anzuheben wäre dasselbe
 * Pflaster ein drittes Mal** und risse beim nächsten Reiter wieder.
 *
 * Sicher ist das Wegräumen aus zwei Gründen, die beide nachgesehen sind: diese
 * Suite ist das **Ende** der erklärten Gesamtordnung (`playwright.config.ts`),
 * es hängt also nichts mehr davon ab; und `passkey.spec.ts`, das als einziges
 * Berechtigungen *zählt* (Phase 0s Gate 6), läuft ganz am Anfang. Über Läufe
 * hinweg gibt es ohnehin keinen Zustand — `e2e-db.mjs` legt je Lauf eine eigene
 * Datenbank an (A129).
 */
async function raeumeBerechtigungen(): Promise<number> {
  // Zwei Tabellen zeigen auf `credentials` (`0002_auth.sql`), und sie werden
  // verschieden behandelt, weil sie Verschiedenes bedeuten:
  //   · `sessions.credential_id` hat `ON DELETE CASCADE` — eine Sitzung ohne
  //     Berechtigung ergibt keinen Sinn, sie geht mit.
  //   · `invites.used_by` ist ein **Beleg**, wer eine Einladung eingelöst hat,
  //     und deshalb bewusst ohne Kaskade. Der Verweis wird gelöst statt die
  //     Einladung gelöscht: die Zeile bleibt als Beleg stehen, sie zeigt nur
  //     nicht mehr auf eine Berechtigung, die es nicht mehr gibt.
  await sql`UPDATE invites SET used_by = NULL WHERE used_by IS NOT NULL`;
  const weg = await sql`DELETE FROM credentials RETURNING id`;
  return weg.length;
}

async function anmelden(context: BrowserContext, page: Page): Promise<void> {
  const entfernt = await raeumeBerechtigungen();
  console.log(
    `a11y · ${entfernt} Berechtigung(en) der vorherigen Suiten entfernt, ` +
      'damit die Anmeldung nicht an excludeCredentials skaliert',
  );
  const client = await context.newCDPSession(page);
  await client.send('WebAuthn.enable');
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.goto(`/#${mintRescueInvite()}`);
  await page.getByTestId('label').fill('E2E-Zugaenglichkeit');
  await page.getByTestId('register').click();
  await expect(page.getByTestId('logout')).toBeVisible();
}

/**
 * Ein Verstoss, so gedruckt, dass jemand ihn beheben kann, ohne den Lauf zu
 * wiederholen: Regel, Wirkung, Regelwerke und **die betroffenen Knoten**.
 *
 * Die Knoten sind der Teil, den eine Zusammenfassung gern weglässt und den
 * niemand ohne einen zweiten Lauf zurückbekommt.
 */
function alsBericht(violations: Awaited<ReturnType<AxeBuilder['analyze']>>['violations']): string {
  return violations
    .map((v) => {
      const knoten = v.nodes
        .slice(0, 5)
        .map((n) => `      · ${n.target.join(' ')}\n        ${n.failureSummary ?? ''}`)
        .join('\n');
      const weitere = v.nodes.length > 5 ? `\n      · … und ${v.nodes.length - 5} weitere` : '';
      return (
        `  ${v.id} (${v.impact ?? 'ohne Einstufung'}, ${v.nodes.length}×)\n` +
        `    ${v.help}\n` +
        `    Regelwerke: ${v.tags.join(', ')}\n` +
        `    ${v.helpUrl}\n${knoten}${weitere}`
      );
    })
    .join('\n\n');
}

/** Das Ergebnis eines Scans, wie es die gesamte axe-Schnittstelle zurückgibt. */
type Scanergebnis = Awaited<ReturnType<AxeBuilder['analyze']>>;

/**
 * Die Zahl gehört gedruckt, auch wenn sie null ist: ein Nachweis, der nur im
 * Erfolgsfall schweigt, hinterlässt keine Messung, und §22 verlangt für dieses
 * Gate eine.
 *
 * `unentschieden` wird **namentlich und mit der Zahl der betroffenen Knoten**
 * mitgedruckt. Das ist die Menge der Regeln, die axe nicht entscheiden konnte —
 * weder grün noch rot —, und ein blosser Regelname macht daraus stillschweigend
 * „nichts gefunden". A25s Unterscheidung, eine Abteilung weiter.
 *
 * **Gemessen am 12.8.2026, behoben am 18.8.2026** — und beides steht hier, weil
 * der Grund für die Knotenzahl der Fund war, den sie sichtbar gemacht hat.
 *
 * Damals war `color-contrast` auf **allen elf** Seiten unentschieden, mit zwei
 * Ursachen: „could not be determined because it uses complex text shadows" auf
 * der Wortmarke und „background color could not be determined due to a
 * background gradient" auf den Überschriften. Der Kontrast des Kopfbereichs war
 * damit von nichts geprüft, und ausgerechnet dort traf eine Pixelschrift auf
 * einen Verlauf. Ein Gate, das „null Verstösse" meldet und diese Lücke
 * verschweigt, behauptet mehr, als es weiss.
 *
 * Seit dem 18.8. sind Schatten und Verlauf aus der Elternkette jedes Textknotens
 * entfernt (des Betreibers Entscheidung 9 vom 17.8.: so umbauen, dass axe entscheiden
 * kann), und `pruefeEntschieden` unten macht aus der gedruckten Zahl eine
 * **Zusicherung**. Die Meldung bleibt, weil sie im roten Fall Knoten und
 * Begründung nennt — ohne sie kostet jeder Fehlschlag einen zweiten Lauf mit
 * Diagnose.
 */
function melde(titel: string, ergebnis: Scanergebnis): void {
  const offen = ergebnis.incomplete.map((v) => `${v.id} (${v.nodes.length})`).join(', ');
  console.log(
    `axe · ${titel.padEnd(15)} ${ergebnis.violations.length} Verstösse ` +
      `(${ergebnis.passes.length + ergebnis.violations.length} Regeln angewandt` +
      `${offen === '' ? '' : `, unentschieden: ${offen}`})`,
  );
}

/**
 * Die Zusicherung selbst — verglichen werden **Regelkennungen**, nicht die
 * vollständigen axe-Objekte.
 *
 * Der erste Anlauf verglich `violations` gegen `[]`, und ein einziger Verstoss
 * warf daraufhin siebenundneunzig Zeilen Objektdiff aus, in denen die eine
 * Zeile unterging, die jemand braucht. Der lesbare Bericht steht in der
 * Meldung; der Diff nennt die Regel.
 */
function pruefe(wo: string, ergebnis: Scanergebnis): void {
  const kennungen = ergebnis.violations.map((v) => v.id);
  expect(
    kennungen,
    kennungen.length === 0
      ? ''
      : `\n${wo} — ${kennungen.length} Verstoss/Verstösse:\n\n${alsBericht(ergebnis.violations)}\n`,
  ).toEqual([]);
}

/**
 * Die zweite Hälfte des Gate-Satzes, und bis zum 18.8.2026 fehlte sie.
 *
 * `incomplete` ist die Menge der Regeln, die axe **nicht entscheiden** konnte —
 * weder grün noch rot. §22 verlangt „zero violations", und über einen
 * ungerechneten Kontrast sagt das nichts: dieser Scan meldete auf allen elf
 * Seiten „0 Verstösse" und liess dabei `color-contrast` unentschieden (Überblick
 * 2 Knoten, Posteingang 3, Büro 4). **Ein Kontrast, den niemand gerechnet hat,
 * ist kein bestandener** — A25s Unterscheidung, eine Abteilung weiter.
 *
 * Geprüft wird die **ganze** Menge, nicht namentlich `color-contrast`. Eine
 * Zusicherung auf eine einzelne Regel wäre eine Ignorierliste in der anderen
 * Richtung: sie schwiege über alles Übrige. Wird eine axe-Regel je aus einem
 * Grund unentscheidbar, den dieses Projekt nicht verantwortet, gehört das als
 * Befund zum Betreiber und nicht in einen Filter.
 *
 * Die Meldung nennt **Knoten und Begründung**, und das ist der wichtige Teil:
 * ohne sie kostet jeder rote Lauf einen zweiten mit Diagnose — genau der, den
 * B1 heute gebraucht hat, um die drei letzten Knoten vom Browser abzulesen
 * statt sie zu raten.
 */
function pruefeEntschieden(wo: string, ergebnis: Scanergebnis): void {
  const offen = ergebnis.incomplete;
  expect(
    offen.map((v) => `${v.id} (${v.nodes.length})`),
    offen.length === 0
      ? ''
      : `\n${wo} — axe konnte ${offen.length} Regel(n) nicht entscheiden. ` +
          'Unentschieden ist nicht bestanden (§22, A25):\n\n' +
          offen
            .flatMap((v) =>
              v.nodes.map(
                (n) =>
                  `      · ${v.id} — ${n.target.join(' ')}\n` +
                  `        ${(n.any ?? []).map((c) => c.message).join(' | ')}`,
              ),
            )
            .join('\n') +
          '\n',
  ).toEqual([]);
}

test.describe('§22 Phase 7 — axe über alle Seiten', () => {
  /**
   * Die angemeldete Oberfläche, Seite für Seite.
   *
   * Ein Fall je Seite und nicht eine Schleife in einem Fall: ein roter Lauf
   * soll die Seite **benennen**, und eine Schleife bricht beim ersten Verstoss
   * ab und lässt die restlichen neun ungeprüft — der Bericht nennt dann eine
   * Seite und schweigt über den Rest, was sich wie „nur diese eine" liest.
   */
  for (const eintrag of SEITEN) {
    test(`${eintrag.titel} ist frei von axe-Verstössen`, async () => {
      await seite.goto(eintrag.pfad);

      // Beweist, dass diese Seite offen ist. Ohne das misst ein umbenannter
      // Pfad den Überblick und meldet die Zahl unter fremdem Namen.
      await expect(seite.getByRole('heading', { level: 2, name: eintrag.titel })).toBeVisible();

      const ergebnis = await new AxeBuilder({ page: seite }).analyze();
      melde(eintrag.titel, ergebnis);
      pruefe(`${eintrag.titel} (${eintrag.pfad})`, ergebnis);
      pruefeEntschieden(`${eintrag.titel} (${eintrag.pfad})`, ergebnis);
    });
  }

  /**
   * Die elfte Seite: die abgemeldete Ansicht.
   *
   * Sie ist die einzige, die ein Besucher ohne Passkey je sieht (§19), also
   * die einzige, deren Zugänglichkeit nicht von einer bestandenen Anmeldung
   * abhängt — und sie fällt aus jeder Liste heraus, die von der Navigation
   * ausgeht, weil es dort gar keine Navigation gibt.
   */
  test('die Anmeldeseite ist frei von axe-Verstössen', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('login')).toBeVisible();
    // Ohne Sitzung gibt es keine Navigation — die Zusicherung hält den Fall
    // davon ab, versehentlich die angemeldete Seite zu messen.
    await expect(page.getByTestId('navigation')).toHaveCount(0);

    const ergebnis = await new AxeBuilder({ page }).analyze();
    melde('Anmeldung', ergebnis);
    pruefe('Anmeldeseite (/, ohne Sitzung)', ergebnis);
    pruefeEntschieden('Anmeldeseite (/, ohne Sitzung)', ergebnis);
  });

  /**
   * Die Liste oben gegen die Navigation im Browser.
   *
   * Der Gate-Satz sagt „**all** pages", und diese Datei kann das nur halten,
   * solange ihre Liste vollständig ist. Eine elfte Seite, die jemand in die
   * Navigation legt, macht diesen Fall rot — statt still ungescannt zu
   * bleiben, was die teuerste Art wäre, das Wort „all" zu verlieren.
   */
  test('die gescannte Liste ist die Navigation, ohne Rest', async () => {
    const angeboten = await seite
      .getByTestId('navigation')
      .locator('button[data-testid]')
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-testid') ?? '').sort());

    expect(angeboten).toEqual([...SEITEN.map((s) => s.nav)].sort());
  });

  /**
   * Der Scanner, gegen einen bekannten Fehler gehalten.
   *
   * Beide Richtungen in einem Fall, weil nur das Paar etwas aussagt: findet er
   * den gesäten Verstoss **namentlich**, und ist dieselbe Seite ohne ihn
   * wieder sauber. Der erste Teil allein liesse einen Scanner durchgehen, der
   * alles beanstandet; der zweite allein einen, der nichts prüft.
   *
   * Gesät wird ein Link ohne zugänglichen Namen (`link-name`) — ein echter
   * WCAG-A-Verstoss, keine Attrappe, und einer, den ein Vorleser als „Link"
   * ohne Ziel ankündigt.
   */
  test('findet einen gesäten Verstoss und ist ohne ihn wieder sauber', async () => {
    await seite.goto('/');
    await expect(seite.getByRole('heading', { level: 2, name: 'Überblick' })).toBeVisible();

    const vorher = await new AxeBuilder({ page: seite }).analyze();
    pruefe('Überblick vor der Saat', vorher);

    await seite.evaluate(() => {
      const a = document.createElement('a');
      a.id = 'gesaeter-verstoss';
      a.href = '/projekte';
      document.querySelector('main')?.append(a);
    });

    const nachher = await new AxeBuilder({ page: seite }).analyze();
    expect(nachher.violations.map((v) => v.id)).toContain('link-name');
    expect(
      nachher.violations.find((v) => v.id === 'link-name')?.nodes.map((n) => n.target.join(' ')),
    ).toContain('#gesaeter-verstoss');

    // Aufräumen, weil diese Datei sich eine Seite teilt: ein liegengebliebener
    // Verstoss machte jeden späteren Fall rot und sähe aus wie ein Befund.
    await seite.evaluate(() => document.getElementById('gesaeter-verstoss')?.remove());

    const wieder = await new AxeBuilder({ page: seite }).analyze();
    pruefe('Überblick nach dem Entfernen der Saat', wieder);
  });
});
