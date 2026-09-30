import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createSql } from '@vorschicht/db';

/**
 * §14's source registry (§17.7), in a browser, against the real API.
 *
 * Three things can only be settled here, and the first is the reason §14's
 * registry is an append-only log at all:
 *
 *   * that the page renders the **history** — who proposed, who accepted, who
 *     promoted it and on what grounds — rather than only the current standing.
 *     0021 chose that shape because §14 makes level ≥ L4 the condition for
 *     citing anything, so "who raised this to L5, and why" is the evidence a
 *     Rechtsgutachten rests on; a page answering only "L5 today" throws it away
 *     while looking complete.
 *   * that a curation performed in this browser reaches the database **and**
 *     leaves §19's trail naming the session (`dashboard:<credentialId>`), which
 *     is the seam `SourceRegistry` explicitly hands to whoever builds the route;
 *   * that the page offers exactly the acts the route accepts, so the operator is never
 *     shown a button that answers 409.
 *
 * Conventions from `dokumente.spec.ts`, binding because five Playwright projects
 * share one database: fixtures are seeded through **raw SQL** (`SourceRegistry`
 * is the proven producer, and a fixture that used it could seat a defect in it
 * and pass in the same run), every assertion is scoped to this file's own ids,
 * and every count is a relation rather than an absolute number.
 */

const WEB_PORT = process.env.E2E_WEB_PORT ?? '5173';
const API_PORT = process.env.E2E_API_PORT ?? '8421';

/** Nonsense titles, so every assertion is about this file and nothing else. */
const TITEL_VORSCHLAG = `E2E Zwergohreule ${randomUUID().slice(0, 8)}`;
const TITEL_AUFGENOMMEN = `E2E Feldhamster ${randomUUID().slice(0, 8)}`;

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

/** A signed-in page standing on the registry. */
async function zumRegister(context: BrowserContext, page: Page): Promise<void> {
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
  await page.getByTestId('label').fill('E2E-Quellen');
  await page.getByTestId('register').click();
  await expect(page.getByTestId('logout')).toBeVisible();

  await page.getByTestId('nav-quellen').click();
  await expect(page.getByTestId('zustands-filter')).toBeVisible();
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
 * One source event, written straight into the log.
 *
 * Raw SQL on purpose: `SourceRegistry` is the producer under test everywhere
 * else, and a fixture built on it could seat a defect in it and let this suite
 * pass in the same run (`projekte.spec.ts` seeds its releases the same way).
 */
async function ereignis(
  sourceId: string,
  seq: number,
  kind: string,
  actor: string,
  fields: { url?: string; level?: number; payload?: Record<string, unknown> } = {},
): Promise<void> {
  await sql`
    INSERT INTO source_events (source_id, seq, kind, actor, url, level, payload)
    VALUES (
      ${sourceId}, ${seq}, ${kind}, ${actor}, ${fields.url ?? null}, ${fields.level ?? null},
      ${sql.json((fields.payload ?? {}) as never)}
    )
  `;
}

async function seedVorschlag(titel: string): Promise<string> {
  const id = randomUUID();
  await ereignis(id, 1, 'proposed', 'Recherche', {
    url: `https://www.ris.bka.gv.at/${randomUUID()}`,
    level: 5,
    payload: { title: titel, assessment: 'Amtliche Fassung des Gesetzestextes (§14, L5).' },
  });
  return id;
}

/** A source with a whole story behind it: proposed, accepted, promoted. */
async function seedMitVerlauf(titel: string): Promise<string> {
  const id = await seedVorschlag(titel);
  await ereignis(id, 2, 'accepted', 'max', {
    level: 3,
    payload: { note: 'zunächst zurückhaltend' },
  });
  await ereignis(id, 3, 'level_changed', 'dashboard:frueher', {
    level: 4,
    payload: { reason: 'Als Normungsgremium anerkannt, Fassung geprüft.' },
  });
  return id;
}

async function pruefspur(subject: string): Promise<Array<{ action: string; actor: string }>> {
  return sql<Array<{ action: string; actor: string }>>`
    SELECT action, actor FROM audit_log WHERE subject = ${subject} ORDER BY id
  `;
}

async function stand(sourceId: string): Promise<{ state: string; level: number | null } | null> {
  const rows = await sql<Array<{ state: string; level: number | null }>>`
    SELECT state, level FROM sources WHERE id = ${sourceId}
  `;
  return rows[0] ?? null;
}

test.beforeAll(async () => {
  sql = createSql({ url: process.env.TEST_DATABASE_URL ?? '', max: 2 });
});

test.afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

test.describe
  .serial('Quellenregister (§14, §17.7) im Browser', () => {
    test('zeigt eine Quelle mit Zustand, Stufe und Punktzahl', async ({ context, page }) => {
      const id = await seedMitVerlauf(TITEL_AUFGENOMMEN);
      await zumRegister(context, page);

      const zeile = page.getByTestId(`quelle-${id}`);
      await expect(zeile).toContainText(TITEL_AUFGENOMMEN);
      const stand_ = page.getByTestId(`stand-${id}`);
      await expect(stand_).toContainText('aufgenommen');
      // The class beside the code: "L4" alone is a number in a costume for
      // anybody who has not memorised §14's table, and this page is where that
      // table is being applied.
      await expect(stand_).toContainText('L4 — Herstellerdokumentation');
      // §14's score refines *within* a level and can never cross one, so a
      // German decimal between 4 and 5 is the assertion, not a fixed number.
      await expect(stand_).toContainText(/Punktzahl 4,\d\d/);
    });

    test('zeigt auf dem Dauerlink den ganzen Verlauf mit Urheber und Begründung', async ({
      context,
      page,
    }) => {
      const id = await seedMitVerlauf(`${TITEL_AUFGENOMMEN} Verlauf`);
      await zumRegister(context, page);
      await page.getByTestId(`quelle-link-${id}`).click();

      // A real page change: the server serves the shell for every non-API path,
      // so the permalink survives a reload.
      await expect(page).toHaveURL(new RegExp(`/quellen/${id}$`));
      await expect(page.getByTestId('detail-titel')).toContainText(TITEL_AUFGENOMMEN);

      // The load-bearing assertion of this file. Three stations, in order, each
      // with the party that performed it — the evidence §14 makes a citation
      // rest on, and the thing a page showing only "L4 heute" throws away.
      const verlauf = page.getByTestId('verlauf');
      await expect(verlauf.locator('> li')).toHaveCount(3);
      await expect(page.getByTestId('verlauf-1')).toContainText('vorgeschlagen mit L5');
      await expect(page.getByTestId('verlauf-1')).toContainText('Recherche');
      await expect(page.getByTestId('verlauf-2')).toContainText('aufgenommen auf L3');
      await expect(page.getByTestId('verlauf-2')).toContainText('max');
      await expect(page.getByTestId('verlauf-3')).toContainText('auf L4 gesetzt');
      await expect(page.getByTestId('verlauf-3')).toContainText('dashboard:frueher');
      // And the reason for the promotion, which is the sentence the level is
      // worth exactly as much as.
      await expect(page.getByTestId('verlauf-3-grund')).toContainText(
        'Als Normungsgremium anerkannt',
      );

      // The proposal's own level survives beside the granted one: a page showing
      // one number could not tell "the department claimed L5" from "the registry
      // granted L5".
      await expect(page.getByTestId('detail-stand')).toContainText('vorgeschlagen mit L5');
      await expect(page.getByTestId('detail-zitierfaehig')).toContainText('Zitierfähig');
    });

    test('nimmt einen Vorschlag auf und nennt dabei die Sitzung im Prüfpfad (§19)', async ({
      context,
      page,
    }) => {
      const id = await seedVorschlag(TITEL_VORSCHLAG);
      await zumRegister(context, page);
      const actor = `dashboard:${await sessionUser(page)}`;

      await page.goto(`/quellen/${id}`);
      await expect(page.getByTestId('detail-titel')).toContainText(TITEL_VORSCHLAG);
      // Proposed: exactly two acts, and neither of the two an accepted source
      // would offer. The page reads `SOURCE_ACTS_BY_STATE`, so this is the
      // assertion that it never shows a button the route answers with a 409.
      await expect(page.getByTestId('akt-accept')).toBeVisible();
      await expect(page.getByTestId('akt-reject')).toBeVisible();
      await expect(page.getByTestId('akt-level')).toHaveCount(0);
      await expect(page.getByTestId('akt-retire')).toHaveCount(0);

      // §14 has the operator decide *inclusion and the level*: L4 rather than the L5 the
      // department assessed, which is the case that tells "the chosen level
      // travelled" apart from "an acceptance happened".
      await page.getByTestId('akt-accept-stufe').selectOption('4');
      await page.getByTestId('akt-accept-grund').fill('Fassung stichprobenartig geprüft.');
      await page.getByTestId('akt-accept-senden').click();
      await expect(page.getByTestId('kuratier-erfolg')).toContainText('Aufnehmen');

      expect(await stand(id)).toEqual({ state: 'accepted', level: 4 });

      // §19's trail — the seam `SourceRegistry` deliberately leaves to the route.
      const spur = await pruefspur(id);
      expect(spur.map((zeile) => zeile.action)).toEqual(['source.accepted']);
      expect(spur[0]?.actor).toBe(actor);
      expect(actor).not.toContain('system');

      // And the page has moved on with the source: the acts an accepted source
      // admits, and the new station in the history.
      await expect(page.getByTestId('akt-level')).toBeVisible();
      await expect(page.getByTestId('akt-accept')).toHaveCount(0);
      await expect(page.getByTestId('verlauf-2')).toContainText('aufgenommen auf L4');
      await expect(page.getByTestId('verlauf-2-grund')).toContainText('stichprobenartig');
    });

    test('verlangt für eine Stufenänderung eine Begründung und schickt sonst nichts', async ({
      context,
      page,
    }) => {
      const id = await seedMitVerlauf(`${TITEL_AUFGENOMMEN} Begründung`);
      await zumRegister(context, page);
      await page.goto(`/quellen/${id}`);

      await page.getByTestId('akt-level-stufe').selectOption('5');
      await page.getByTestId('akt-level-senden').click();
      await expect(page.getByTestId('kuratier-fehler')).toContainText('Begründung');
      // Nothing travelled: the level is still what it was.
      expect(await stand(id)).toEqual({ state: 'accepted', level: 4 });
      expect(await pruefspur(id)).toHaveLength(0);

      await page.getByTestId('akt-level-grund').fill('Amtlicher Volltext auf RIS, primäre Quelle.');
      await page.getByTestId('akt-level-senden').click();
      await expect(page.getByTestId('kuratier-erfolg')).toBeVisible();
      expect(await stand(id)).toEqual({ state: 'accepted', level: 5 });
      expect((await pruefspur(id)).map((zeile) => zeile.action)).toEqual(['source.level_changed']);
    });

    test('filtert nach Zustand und Mindeststufe', async ({ context, page }) => {
      const vorschlag = await seedVorschlag(`${TITEL_VORSCHLAG} Filter`);
      const aufgenommen = await seedMitVerlauf(`${TITEL_AUFGENOMMEN} Filter`);
      await zumRegister(context, page);

      await expect(page.getByTestId(`quelle-${vorschlag}`)).toBeVisible();
      await expect(page.getByTestId(`quelle-${aufgenommen}`)).toBeVisible();

      await page.getByTestId('zustands-filter').selectOption('proposed');
      await expect(page.getByTestId(`quelle-${vorschlag}`)).toBeVisible();
      await expect(page.getByTestId(`quelle-${aufgenommen}`)).toHaveCount(0);

      // A proposal has no granted level at all, so §14's threshold excludes it
      // — which is the distinction the two level columns exist for.
      await page.getByTestId('zustands-filter').selectOption('alle');
      await page.getByTestId('stufen-filter').selectOption('4');
      await expect(page.getByTestId(`quelle-${aufgenommen}`)).toBeVisible();
      await expect(page.getByTestId(`quelle-${vorschlag}`)).toHaveCount(0);
    });

    test('zeigt einen unbrauchbaren und einen unbekannten Dauerlink als solchen, statt die Liste', async ({
      context,
      page,
    }) => {
      await zumRegister(context, page);

      await page.goto('/quellen/kaputt');
      await expect(page.getByTestId('quelle-unbekannt')).toBeVisible();
      await expect(page.getByTestId('quellenliste')).toHaveCount(0);
      // A path `decodeURIComponent` cannot read once blanked the whole dashboard.
      await page.goto('/quellen/%25');
      await expect(page.getByTestId('navigation')).toBeVisible();
      await expect(page.getByTestId('quelle-unbekannt')).toBeVisible();

      await page.goto('/quellen/00000000-0000-4000-8000-000000000000');
      await expect(page.getByTestId('quelle-unbekannt')).toContainText('Keine Quelle');
      await page.getByTestId('zu-den-quellen').click();
      await expect(page.getByTestId('zustands-filter')).toBeVisible();
    });

    test('bleibt ohne Sitzung verschlossen', async ({ page }) => {
      const id = await seedVorschlag(`${TITEL_VORSCHLAG} Verschlossen`);
      await page.goto('/quellen');
      await expect(page.getByTestId('nav-quellen')).toHaveCount(0);
      expect((await page.request.get('/api/quellen')).status()).toBe(401);
      expect((await page.request.get(`/api/quellen/${id}`)).status()).toBe(401);
      expect(
        (
          await page.request.post(`/api/quellen/${id}/aufnehmen`, {
            headers: { 'content-type': 'application/json' },
            data: { level: 5 },
          })
        ).status(),
      ).toBe(401);
      // And nothing happened behind the 401.
      expect(await stand(id)).toEqual({ state: 'proposed', level: null });
    });
  });
