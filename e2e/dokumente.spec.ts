import { execFileSync } from 'node:child_process';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createSql } from '@vorschicht/db';

/**
 * §13's document vault (§17.6), in a browser, against the real API and the real
 * docs volume.
 *
 * Nothing here is seeded through the vault: an upload **is** the thing under
 * test, so it goes through the file picker and through drag & drop the way §13
 * describes, and what is read back afterwards is the database. That is the one
 * arrangement in which the two halves of this feature — the raw-body upload
 * route (A111) and this page — are put into each other rather than each into
 * its own fixture, which is the failure `posteingang.spec.ts` was written for
 * after it had already happened once (A81).
 *
 * Four things can only be settled here:
 *
 *   * that an uploaded file appears with its title and its tags,
 *   * that §13's full-text search finds it — asserted against a list that is
 *     **provably empty first**, because a row left over from an upload would
 *     make "the search found it" true whether or not it did,
 *   * that a PDF, which is stored today and read by nothing, says so instead of
 *     being silently unfindable,
 *   * and that the trail names the session (`dashboard:<credentialId>`) rather
 *     than `system` (§19, A75.3).
 *
 * Two conventions from `posteingang.spec.ts`, and they are binding because the
 * four Playwright projects share one database: every assertion is scoped to
 * **this file's own document ids**, and every count is a relation rather than an
 * absolute number.
 */

const WEB_PORT = process.env.E2E_WEB_PORT ?? '5173';
const API_PORT = process.env.E2E_API_PORT ?? '8421';

/** Nonsense words, so a search assertion is about this file and nothing else. */
const WORT_TEXT = 'Zwergfledermaus';
const WORT_PDF = 'Grasmuecke';
const WORT_OPS = 'Baumfalke';

const TITEL_TEXT = 'E2E Vereinsstatuten';
const TITEL_PDF = 'E2E Vertrag als PDF';

let sql: ReturnType<typeof createSql>;

/** Mint a rescue invite: it works after the bootstrap lock, which by now holds. */
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

/** A signed-in page standing on the vault. */
async function zumTresor(context: BrowserContext, page: Page): Promise<void> {
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
  await page.getByTestId('label').fill('E2E-Dokumente');
  await page.getByTestId('register').click();
  await expect(page.getByTestId('logout')).toBeVisible();

  await page.getByTestId('nav-dokumente').click();
  await expect(page.getByTestId('dokument-hochladen')).toBeVisible();
}

/** Who the browser is, as the server sees it — the actor the trail must name. */
async function sessionUser(page: Page): Promise<string> {
  const body = (await (await page.request.get('/api/me')).json()) as {
    session: { userId: string } | null;
  };
  if (!body.session) throw new Error('Keine Sitzung — die Registrierung hat nicht angemeldet');
  return body.session.userId;
}

/**
 * The upload limit, read off the page rather than out of a second constant.
 *
 * `MAX_UPLOAD_BYTES` lives in `@vorschicht/shared/dokumente`, which the root
 * workspace does not depend on; copying its value here would be the shape A81.3
 * is about — one number in two packages, each side green about its own. Reading
 * it from the sentence the page shows the operator has a second property that a copy
 * would not: a page that started claiming a *wrong* limit builds a file the
 * route accepts, and this suite goes red instead of quietly proving nothing.
 */
async function grenzeInBytes(page: Page): Promise<number> {
  const text = await page.getByTestId('upload-grenze').innerText();
  const megabytes = Number(text.match(/(\d+)\s*MB/)?.[1]);
  expect(Number.isFinite(megabytes)).toBe(true);
  expect(megabytes).toBeGreaterThan(0);
  return megabytes * 1024 * 1024;
}

interface Ablage {
  titel: string;
  abteilungen?: string;
  schlagworte?: string;
  name: string;
  mimeType: string;
  inhalt: Buffer;
}

async function ablegen(page: Page, ablage: Ablage): Promise<void> {
  await page.getByTestId('dokument-titel').fill(ablage.titel);
  await page.getByTestId('dokument-abteilungen').fill(ablage.abteilungen ?? '');
  await page.getByTestId('dokument-schlagworte').fill(ablage.schlagworte ?? '');
  await page
    .getByTestId('dokument-datei')
    .setInputFiles({ name: ablage.name, mimeType: ablage.mimeType, buffer: ablage.inhalt });
  await page.getByTestId('dokument-hochladen').click();
}

/** The vault's own record — read back, never assumed from what the page said. */
async function kennungVon(titel: string): Promise<string | null> {
  const rows = await sql<Array<{ id: string }>>`
    SELECT id FROM documents WHERE title = ${titel}
  `;
  return rows[0]?.id ?? null;
}

async function pruefspur(subject: string): Promise<Array<{ action: string; actor: string }>> {
  return sql<Array<{ action: string; actor: string }>>`
    SELECT action, actor FROM audit_log WHERE subject = ${subject} ORDER BY id
  `;
}

/** A title this file uploaded, as a scoped id — `expect` narrows for TypeScript. */
async function kennungMuss(titel: string): Promise<string> {
  const id = await kennungVon(titel);
  expect(id, `Kein Dokument mit dem Titel „${titel}"`).not.toBeNull();
  return id as string;
}

test.beforeAll(async () => {
  sql = createSql({ url: process.env.TEST_DATABASE_URL ?? '', max: 2 });
});

test.afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

test.describe
  .serial('Dokumententresor (§13, §17.6) im Browser', () => {
    test('legt eine Textdatei ab, zeigt sie mit Titel und Schlagworten und nennt die Sitzung im Prüfpfad', async ({
      context,
      page,
    }) => {
      await zumTresor(context, page);
      const actor = `dashboard:${await sessionUser(page)}`;

      // Der Ausgangszustand, und er ist tragend: die Liste zeigt, was diese
      // Sitzung hochgeladen oder gefunden hat, und beginnt leer.
      await expect(page.getByTestId('dokumente-leer')).toBeVisible();

      await ablegen(page, {
        titel: TITEL_TEXT,
        abteilungen: 'Recht, Doku',
        schlagworte: 'Verein, Statuten',
        name: 'statuten.txt',
        mimeType: 'text/plain',
        inhalt: Buffer.from(
          `Statuten des Vereins. Die ${WORT_TEXT} ist Wappentier und wird jährlich gezählt.`,
          'utf8',
        ),
      });

      await expect(page.getByTestId('upload-erfolg')).toContainText(TITEL_TEXT);
      await expect(page.getByTestId('upload-fehler')).toHaveCount(0);

      const id = await kennungMuss(TITEL_TEXT);
      await expect(page.getByTestId(`dokument-${id}`)).toContainText(TITEL_TEXT);
      const schlagworte = page.getByTestId(`schlagworte-${id}`);
      await expect(schlagworte).toContainText('Abteilungen: Recht, Doku');
      await expect(schlagworte).toContainText('Schlagworte: Verein, Statuten');

      // Gelesen, und das ist die andere Hälfte des PDF-Falls weiter unten:
      // „durchsuchbar" und „noch nicht durchsuchbar" dürfen sich nicht
      // gegenseitig erfüllen, deshalb beide Richtungen.
      const zustand = page.getByTestId(`zustand-${id}`);
      await expect(zustand).toContainText('Abgelegt · durchsuchbar (');
      await expect(zustand).not.toContainText('noch nicht');

      // §19s Prüfpfad: die Sitzung hat abgelegt, nicht `system`.
      const spur = await pruefspur(id);
      expect(spur.map((zeile) => zeile.action)).toContain('document.created');
      expect(spur.at(-1)?.actor).toBe(actor);
      expect(actor).not.toContain('system');
    });

    test('findet die abgelegte Datei über die Volltextsuche — und sagt es, wenn nichts passt', async ({
      context,
      page,
    }) => {
      await zumTresor(context, page);
      const id = await kennungMuss(TITEL_TEXT);

      // Ohne diese Zeile wäre der Fall wertlos: eine Liste, in der das Dokument
      // ohnehin steht, macht „die Suche findet es" wahr, egal was die Suche tut.
      await expect(page.getByTestId('dokumente-leer')).toBeVisible();
      await expect(page.getByTestId(`dokument-${id}`)).toHaveCount(0);

      await page.getByTestId('dokumente-suche').fill(WORT_TEXT);
      await page.getByTestId('dokumente-suchen').click();

      await expect(page.getByTestId(`dokument-${id}`)).toBeVisible();
      // Und die Zeile sagt, dass sie ein Treffer ist und keine eigene Ablage.
      await expect(page.getByTestId(`zustand-${id}`)).toContainText('Gefunden in Fassung 1');

      await page.getByTestId('dokumente-suche').fill('Rhabarberkuchen');
      await page.getByTestId('dokumente-suchen').click();
      await expect(page.getByTestId('dokumente-nichts-gefunden')).toContainText('Rhabarberkuchen');
      await expect(page.getByTestId(`dokument-${id}`)).toHaveCount(0);
    });

    test('sagt bei einem PDF, dass es abgelegt und nicht ausgelesen ist (§13)', async ({
      context,
      page,
    }) => {
      await zumTresor(context, page);
      await ablegen(page, {
        titel: TITEL_PDF,
        abteilungen: 'Recht',
        schlagworte: 'Vertrag',
        name: 'vertrag.pdf',
        mimeType: 'application/pdf',
        // Das Suchwort steht wörtlich in den Bytes — genau deshalb ist die
        // Suche darunter aussagekräftig: nicht die Datei fehlt, der Text fehlt.
        inhalt: Buffer.from(`%PDF-1.4\n% ${WORT_PDF}\n%%EOF\n`, 'latin1'),
      });

      await expect(page.getByTestId('upload-erfolg')).toContainText(TITEL_PDF);
      const id = await kennungMuss(TITEL_PDF);

      const zustand = page.getByTestId(`zustand-${id}`);
      await expect(zustand).toContainText('noch nicht durchsuchbar');
      await expect(zustand).toContainText('PDF');

      // Der Satz, den §13 an dieser Stelle verlangt: „0 Treffer" über einem
      // Tresor mit ungelesenen Dateien ist wahr und irreführend.
      await page.getByTestId('dokumente-suche').fill(WORT_PDF);
      await page.getByTestId('dokumente-suchen').click();
      const nichts = page.getByTestId('dokumente-nichts-gefunden');
      await expect(nichts).toContainText('Nichts gefunden');
      await expect(nichts).toContainText('kein Text ausgelesen');
      await expect(page.getByTestId(`dokument-${id}`)).toHaveCount(0);
    });

    test('weist eine zu große Datei mit deutschem Grund ab und legt nichts an', async ({
      context,
      page,
    }) => {
      await zumTresor(context, page);
      const titel = 'E2E Zu groß';
      const grenze = await grenzeInBytes(page);

      await ablegen(page, {
        titel,
        name: 'riesig.txt',
        mimeType: 'text/plain',
        inhalt: Buffer.alloc(grenze + 1024, 0x61),
      });

      const fehler = page.getByTestId('upload-fehler');
      await expect(fehler).toBeVisible();
      await expect(fehler).toContainText('riesig.txt');
      await expect(fehler).toContainText('MB');
      await expect(page.getByTestId('upload-erfolg')).toHaveCount(0);

      // Nicht in der Liste …
      await expect(page.getByTestId('dokumente-leer')).toBeVisible();
      // … und nicht im Tresor. Die Route ist die Grenze, die zählt (A111.1);
      // das hier ist die Zusicherung, die auch dann noch hält, wenn die Prüfung
      // im Browser wegfällt.
      expect(await kennungVon(titel)).toBeNull();
    });

    test('weist einen Dateityp ab, den der Tresor nicht annimmt', async ({ context, page }) => {
      await zumTresor(context, page);
      const titel = 'E2E Bild';

      await ablegen(page, {
        titel,
        name: 'foto.png',
        mimeType: 'image/png',
        inhalt: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      });

      const fehler = page.getByTestId('upload-fehler');
      await expect(fehler).toContainText('image/png');
      await expect(fehler).toContainText('PDF');
      expect(await kennungVon(titel)).toBeNull();
    });

    test('nimmt eine per Drag & Drop abgelegte Datei an (§13)', async ({ context, page }) => {
      await zumTresor(context, page);
      const titel = 'E2E Fallengelassen';

      await page.getByTestId('dokument-titel').fill(titel);
      const ablage = await page.evaluateHandle(() => {
        const daten = new DataTransfer();
        daten.items.add(
          new File(['Der Steinmarder ist wieder auf dem Dachboden.'], 'notiz.md', {
            type: 'text/markdown',
          }),
        );
        return daten;
      });
      await page.getByTestId('ablegezone').dispatchEvent('drop', { dataTransfer: ablage });

      // §13 sagt „drag & drop" wörtlich, also wird der Weg gefahren und nicht
      // der Dateiwähler daneben, der ihn ersetzen würde.
      await expect(page.getByTestId('gewaehlte-datei')).toContainText('notiz.md');
      await expect(page.getByTestId('gewaehlte-datei')).toContainText('Markdown');

      await page.getByTestId('dokument-hochladen').click();
      await expect(page.getByTestId('upload-erfolg')).toContainText(titel);
      const id = await kennungMuss(titel);
      await expect(page.getByTestId(`zustand-${id}`)).toContainText('durchsuchbar (');
    });

    test('öffnet den Dauerlink und zeigt die Fassungen mit ihrem Zustand', async ({
      context,
      page,
    }) => {
      await zumTresor(context, page);
      const id = await kennungMuss(TITEL_TEXT);

      await page.getByTestId('dokumente-suche').fill(WORT_TEXT);
      await page.getByTestId('dokumente-suchen').click();
      await page.getByTestId(`dokument-link-${id}`).click();

      // Ein echter Seitenwechsel: der Server liefert die Hülle für jeden
      // Nicht-API-Pfad, also überlebt der Dauerlink auch ein Neuladen.
      await expect(page).toHaveURL(new RegExp(`/dokumente/${id}$`));
      await expect(page.getByTestId('detail-titel')).toHaveText(TITEL_TEXT);
      await expect(page.getByTestId('versionsliste').locator('> li')).toHaveCount(1);
      const fassung = page.getByTestId('version-1');
      await expect(fassung).toContainText('statuten.txt');
      await expect(fassung).toContainText('Textdatei');
      await expect(fassung).toContainText('dashboard:');
      await expect(page.getByTestId('version-1-zustand')).toContainText('durchsuchbar (');

      await page.getByTestId('zu-den-dokumenten').click();
      await expect(page.getByTestId('dokumente-leer')).toBeVisible();
    });

    test('filtert nach Abteilung und sagt, wenn der Filter alles verbirgt', async ({
      context,
      page,
    }) => {
      await zumTresor(context, page);

      await ablegen(page, {
        titel: 'E2E Filter Recht',
        abteilungen: 'Recht',
        name: 'recht.txt',
        mimeType: 'text/plain',
        inhalt: Buffer.from('Der Alpensalamander ist streng geschützt.', 'utf8'),
      });
      await expect(page.getByTestId('upload-erfolg')).toBeVisible();
      await ablegen(page, {
        titel: 'E2E Filter Ops',
        abteilungen: 'Ops',
        name: 'ops.txt',
        mimeType: 'text/plain',
        inhalt: Buffer.from(`Der ${WORT_OPS} nistet auf dem Serverschrank.`, 'utf8'),
      });
      await expect(page.getByTestId('upload-erfolg')).toBeVisible();

      const recht = await kennungMuss('E2E Filter Recht');
      const ops = await kennungMuss('E2E Filter Ops');

      await page.getByTestId('abteilungs-filter').selectOption('Recht');
      await expect(page.getByTestId(`dokument-${recht}`)).toBeVisible();
      await expect(page.getByTestId(`dokument-${ops}`)).toHaveCount(0);

      // Eine Suche **ersetzt** die Zeilen, der Filter überlebt sie — das ist der
      // gewöhnliche Weg in den Zustand „dein Filter verbirgt alles", und ohne
      // ihn wäre dieser Zweig unerreichbar.
      await page.getByTestId('dokumente-suche').fill(WORT_OPS);
      await page.getByTestId('dokumente-suchen').click();
      await expect(page.getByTestId('dokumente-gefiltert-leer')).toContainText('1 andere');

      await page.getByTestId('abteilungs-filter').selectOption('alle');
      await expect(page.getByTestId(`dokument-${ops}`)).toBeVisible();
    });

    test('zeigt einen unbrauchbaren und einen unbekannten Dauerlink als solchen, statt die Liste', async ({
      context,
      page,
    }) => {
      await zumTresor(context, page);

      // Die ganze Liste zu zeigen läse sich als „dein Dokument ist weg" statt
      // als „dieser Link ist kaputt" (A81.5).
      await page.goto('/dokumente/kaputt');
      await expect(page.getByTestId('dokument-unbekannt')).toBeVisible();
      await expect(page.getByTestId('dokumentenliste')).toHaveCount(0);
      await expect(page.getByTestId('dokument-hochladen')).toHaveCount(0);
      // Und das Dashboard steht noch: ein Pfad, den `decodeURIComponent` nicht
      // lesen kann, hat es einmal vollständig geleert.
      await page.goto('/dokumente/%25');
      await expect(page.getByTestId('navigation')).toBeVisible();
      await expect(page.getByTestId('dokument-unbekannt')).toBeVisible();

      await page.goto('/dokumente/00000000-0000-4000-8000-000000000000');
      await expect(page.getByTestId('dokument-unbekannt')).toContainText('Kein Dokument');
      await page.getByTestId('zu-den-dokumenten').click();
      await expect(page.getByTestId('dokument-hochladen')).toBeVisible();
    });

    test('bleibt ohne Sitzung verschlossen', async ({ page }) => {
      await page.goto('/dokumente');
      await expect(page.getByTestId('nav-dokumente')).toHaveCount(0);
      expect((await page.request.get('/api/dokumente/suche?q=Statuten')).status()).toBe(401);
      expect(
        (await page.request.get('/api/dokumente/00000000-0000-4000-8000-000000000000')).status(),
      ).toBe(401);
      expect(
        (
          await page.request.post('/api/dokumente?title=Heimlich&filename=heimlich.txt', {
            headers: { 'content-type': 'text/plain' },
            data: 'nicht abgelegt',
          })
        ).status(),
      ).toBe(401);
      expect(await kennungVon('Heimlich')).toBeNull();
    });
  });
