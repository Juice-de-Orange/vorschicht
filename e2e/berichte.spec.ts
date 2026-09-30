import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createSql } from '@vorschicht/db';
import { BERICHTE_PATH } from '@vorschicht/shared/berichte';

/**
 * §16s Wochenbericht-Archiv (§17, §22 Phase 8 Schritt 2), im Browser gegen die
 * echte API.
 *
 * Der Gate-Satz lautet „archive shows history" — **Historie**, nicht „eine
 * Seite existiert". Zwei Berichte sind deshalb das Minimum: mit einem einzigen
 * wäre jede Aussage über Reihenfolge und über die Auswahl eines bestimmten
 * Berichts leer, und genau die beiden trägt eine Mail nicht.
 *
 * Konventionen aus `quellen.spec.ts`, verbindlich weil viele Playwright-Projekte
 * sich eine Datenbank teilen: gesät wird über **rohes SQL** (`ReportRecords` ist
 * anderswo der geprüfte Erzeuger, und eine Fixture darauf könnte einen Defekt
 * darin aufsetzen und im selben Lauf bestehen), jede Zusicherung ist auf die
 * eigenen Zeitraum-Werte begrenzt, und keine Zahl ist absolut.
 */

const WEB_PORT = process.env.E2E_WEB_PORT ?? '5173';
const API_PORT = process.env.E2E_API_PORT ?? '8421';

/*
 * Zeiträume weit in der Vergangenheit, damit sie mit nichts kollidieren, was
 * eine andere Suite oder ein echter Lauf erzeugt — `reports.period_start` ist
 * eindeutig (0024), also wäre eine Kollision ein Fehlschlag beim Säen und keine
 * falsche Zusicherung. Zwei aufeinanderfolgende Wochen, weil die Reihenfolge
 * geprüft wird.
 */
const AELTER = '2019-09-02';
const NEUER = '2019-09-09';
const MARKE = randomUUID().slice(0, 8);

let sql: ReturnType<typeof createSql>;

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

async function seedBericht(periodStart: string, betreff: string, text: string): Promise<void> {
  await sql`
    INSERT INTO reports (period_start, period_end, generated_at, subject, body_text, body_html, metrics)
    VALUES (
      ${`${periodStart}T00:00:00Z`}::timestamptz,
      ${`${periodStart}T00:00:00Z`}::timestamptz + interval '7 days',
      ${`${periodStart}T05:00:00Z`}::timestamptz,
      ${betreff},
      ${text},
      ${`<html><body><p>MAILFASSUNG-${MARKE}</p></body></html>`},
      ${sql.json({ tasksDone: 3 } as never)}
    )
    ON CONFLICT (period_start) DO NOTHING
  `;
}

/**
 * Einmal anmelden, Kontext teilen — das Muster aus `log.spec.ts`, und hier
 * nicht Bequemlichkeit: diese Suite steht am Ende einer Kette von neun, und
 * eine Registrierung je Testfall legt bei jedem Lauf weitere Passkeys an. Der
 * erste Entwurf tat das und scheiterte reproduzierbar daran, dass `logout` nie
 * erschien.
 */
async function signIn(context: BrowserContext, page: Page): Promise<void> {
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
  await page.getByTestId('label').fill('E2E-Berichte');
  await page.getByTestId('register').click();
  // Diagnose, falls die Registrierung nicht durchgeht: der Fehlerstreifen sagt,
  // warum — ohne ihn steht nur „logout nicht gefunden" im Protokoll.
  const fehler = page.getByTestId('error');
  await Promise.race([
    page
      .getByTestId('logout')
      .waitFor({ state: 'visible', timeout: 10_000 })
      .catch(() => {}),
    fehler.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {}),
  ]);
  if (await fehler.isVisible().catch(() => false)) {
    throw new Error(`Registrierung abgewiesen: ${await fehler.textContent()}`);
  }
  await expect(page.getByTestId('logout')).toBeVisible();
}

test.describe
  .serial('§16s Wochenbericht-Archiv', () => {
    let sitzung: BrowserContext;
    let seite: Page;

    test.beforeAll(async ({ browser }) => {
      sql = createSql({ url: process.env.TEST_DATABASE_URL ?? '', max: 2 });
      await seedBericht(
        AELTER,
        `E2E Bericht älter ${MARKE}`,
        `RUMPF-AELTER-${MARKE}\n  Zahlen: 1\n`,
      );
      await seedBericht(NEUER, `E2E Bericht neuer ${MARKE}`, `RUMPF-NEUER-${MARKE}\n  Zahlen: 2\n`);

      sitzung = await browser.newContext();
      seite = await sitzung.newPage();
      await signIn(sitzung, seite);
    });

    /*
     * Kein Aufräumen der gesäten Zeilen, und das ist keine Nachlässigkeit:
     * `reports` ist append-only (§5/§18), der Wächter weist `DELETE` auch dem
     * Eigentümer ab. Der erste Entwurf versuchte es und bekam „Tabelle reports
     * ist append-only" — die Zusicherung des Schemas, im Testlauf ausgeführt.
     * Die Zeiträume liegen deshalb im Jahr 2019, wo sie mit nichts kollidieren.
     */
    test.afterAll(async () => {
      await sitzung?.close();
      await sql?.end({ timeout: 5 });
    });

    /**
     * Die Seite frisch laden statt nur hinzuklicken.
     *
     * Die Suite teilt sich eine Seite (`.serial`), und der aufgeklappte Bericht
     * ist React-Zustand: ein Test, der nur den Reiter anklickt, startet mit dem,
     * was sein Vorgänger offen gelassen hat — und der vierte Fall schloss damit
     * beim ersten Klick, statt zu öffnen. Ein `goto` setzt den Zustand zurück und
     * macht die Fälle voneinander unabhängig, was sie bei geteilter Seite sonst
     * nicht sind.
     */
    async function zumArchiv(): Promise<void> {
      await seite.goto(BERICHTE_PATH);
      await expect(seite.getByTestId('berichte')).toBeVisible();
    }

    test('zeigt beide Wochen, die neuere zuerst — das ist die Historie, die der Gate-Satz meint', async () => {
      await zumArchiv();

      await expect(seite.getByTestId(`bericht-${AELTER}`)).toBeVisible();
      await expect(seite.getByTestId(`bericht-${NEUER}`)).toBeVisible();

      // Die Reihenfolge als **Relation** statt als Position: die Suiten teilen
      // sich die Datenbank, es können also echte Berichte dazwischenstehen.
      const alle = await seite
        .getByTestId('berichte-liste')
        .locator('li[data-testid]')
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute('data-testid') ?? ''));
      expect(alle.indexOf(`bericht-${NEUER}`)).toBeLessThan(alle.indexOf(`bericht-${AELTER}`));
    });

    test('nennt den Zeitraum mit dem letzten Tag, der wirklich dazugehört', async () => {
      await zumArchiv();
      // `period_end` ist exklusiv (0024). Ein Archiv, das „2.–9. September"
      // schreibt, behauptet einen Tag, den der Bericht nicht beschreibt — und die
      // Zahlen sind das einzige, wofür er existiert.
      const zeile = seite.getByTestId(`bericht-${AELTER}`);
      await expect(zeile).toContainText('2. September 2019');
      await expect(zeile).toContainText('8. September 2019');
      await expect(zeile).not.toContainText('9. September 2019');
    });

    test('holt den Volltext erst auf Klick, und zeigt den Klartext statt der Mailfassung', async () => {
      await zumArchiv();

      // Vorher steht kein Rumpf auf der Seite: die Liste holt ihn nicht mit.
      await expect(seite.getByTestId(`bericht-text-${NEUER}`)).toHaveCount(0);

      await seite.getByTestId(`bericht-${NEUER}`).getByRole('button').click();
      const text = seite.getByTestId(`bericht-text-${NEUER}`);
      await expect(text).toBeVisible();
      await expect(text).toContainText(`RUMPF-NEUER-${MARKE}`);

      // Die tragende Zusicherung: die Mailfassung erreicht diese Seite nie. Ohne
      // sie ginge der Fall gegen eine Seite durch, die `bodyHtml` einhängt — die
      // einzige XSS-Fläche, die dieses Dashboard hätte.
      await expect(seite.locator('body')).not.toContainText(`MAILFASSUNG-${MARKE}`);
    });

    test('klappt wieder zu und öffnet den anderen Bericht, ohne den ersten zu zeigen', async () => {
      await zumArchiv();

      await seite.getByTestId(`bericht-${NEUER}`).getByRole('button').click();
      await expect(seite.getByTestId(`bericht-text-${NEUER}`)).toBeVisible();

      await seite.getByTestId(`bericht-${AELTER}`).getByRole('button').click();
      await expect(seite.getByTestId(`bericht-text-${AELTER}`)).toContainText(
        `RUMPF-AELTER-${MARKE}`,
      );
      // Zwei offene Rümpfe gleichzeitig wären zwei Berichte, die wie einer aussehen.
      await expect(seite.getByTestId(`bericht-text-${NEUER}`)).toHaveCount(0);
    });

    test('antwortet auf einen Zeitraum, den es nicht gibt, mit 404 statt mit 500', async () => {
      // Die Seite bietet den Fall nicht an, aber eine Adresse aus einer alten Mail
      // kann ihn erzeugen. `quatsch` ist der wichtigere der beiden: ohne
      // `isPeriodStart` ginge er nach Postgres und käme als nackter 500 zurück,
      // in einer Anwendung ohne `app.onError` (`berichte.ts`, Entscheidung 2).
      expect((await seite.request.get('/api/berichte/2019-01-07')).status()).toBe(404);
      expect((await seite.request.get('/api/berichte/quatsch')).status()).toBe(404);
    });

    test('gibt ohne Sitzung nichts heraus (§19)', async ({ request }) => {
      // Eigener Anfragekontext, ohne die Sitzungskekse oben — §19 verlangt, dass
      // jede Route ohne Sitzung 401 antwortet, und ein Archiv voller Kennzahlen
      // ist genau das, was ein öffentlich erreichbares Dashboard nicht preisgeben
      // darf. Gefunden, weil der erste Entwurf dieses Falls hier 401 statt 404
      // bekam und den Schutz damit versehentlich belegt hat.
      expect((await request.get('/api/berichte')).status()).toBe(401);
      expect((await request.get(`/api/berichte/${NEUER}`)).status()).toBe(401);
    });
  });
