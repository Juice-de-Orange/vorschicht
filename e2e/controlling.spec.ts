import { execFileSync } from 'node:child_process';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createSql } from '@vorschicht/db';

/**
 * §17.8's Controlling page, in a browser, against the real API.
 *
 * Four things can only be settled here, and the first two are what the Phase 7
 * gate for A26 turns on.
 *
 *   * **That the pause switch exists at all and stores what it claims.** A26 has
 *     been implemented in `GuardianService` since Phase 1 and was reachable by
 *     nobody: the daemon and the dashboard are two processes, so the in-memory
 *     `setPause` could never be called by a person. What a browser can show and
 *     no unit test in this repository can is that clicking the control writes
 *     the `config` row the guardian reads.
 *
 *   * **That §19's trail names the session** (`dashboard:<credentialId>`), not
 *     `'system'` (A75.3). Asserted as the value `/api/me` reports for *this*
 *     browser rather than as "not the default", because the defect it guards
 *     against writes a perfectly well-formed row. Sharper here than anywhere
 *     else this rule has been applied: the row for a pause is the only record of
 *     why the studio stopped working.
 *
 *   * **That no percentage is rendered without the sentence saying what it is
 *     worth.** A73 means most numbers on this page are our own estimate, and
 *     `budgetVertrauen` is unit-tested — and would stay green against a page
 *     that never called it, which is exactly the shape §8.2's sixth domain
 *     hunts.
 *
 *   * **That the Sparbetrieb switch does not overstate itself.** Three of A22's
 *     four effects have no consumer; the page says so per effect. A page that
 *     silently claimed four would be the defect this project has found five
 *     times, freshly built.
 *
 * Conventions from `einstellungen.spec.ts` and `quellen.spec.ts`, binding
 * because seven Playwright projects share one database: every count is a
 * **relation** rather than an absolute number, and this suite restores both
 * defaults at the end — a pause left behind would stop a later suite's studio,
 * and this one runs last precisely so a crash between the two cannot mislead
 * anything downstream.
 */

const WEB_PORT = process.env.E2E_WEB_PORT ?? '5173';
const API_PORT = process.env.E2E_API_PORT ?? '8421';

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

/** A signed-in page standing on the Controlling page. */
async function zumControlling(context: BrowserContext, page: Page): Promise<void> {
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
  await page.getByTestId('label').fill('E2E-Controlling');
  await page.getByTestId('register').click();
  await expect(page.getByTestId('logout')).toBeVisible();

  await page.getByTestId('nav-controlling').click();
  await expect(page.getByTestId('controlling-pause')).toBeVisible();
}

/** Who the browser is, as the server sees it — the actor the trail must name. */
async function sessionUser(page: Page): Promise<string> {
  const body = (await (await page.request.get('/api/me')).json()) as {
    session: { userId: string } | null;
  };
  if (!body.session) throw new Error('Keine Sitzung — die Registrierung hat nicht angemeldet');
  return body.session.userId;
}

async function trailCount(action: string): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM audit_log WHERE action = ${action}
  `;
  return Number(rows[0]?.n ?? 0);
}

async function storedPause(): Promise<string | null> {
  const rows = await sql<{ value: string }[]>`
    SELECT value #>> '{}' AS value FROM config WHERE key = 'controlling.pause'
  `;
  return rows[0]?.value ?? null;
}

test.beforeAll(async () => {
  sql = createSql({ url: process.env.TEST_DATABASE_URL ?? '', max: 2 });
  // Ein gemessener und ein geschätzter Wert, roh gesät: `UsageMeter` ist der
  // geprüfte Erzeuger, und eine Fixture, die ihn benutzt, könnte einen Fehler
  // in ihm aufsetzen und im selben Zug bestehen lassen (A95.3).
  await sql`
    INSERT INTO usage_samples (window_kind, model_class, used_percent, source, raw, observed_at)
    VALUES
      ('five_hour', NULL, 12.5, 'estimated', ${sql.json({ e2e: true })}, now()),
      ('seven_day', NULL, 91.0, 'official', ${sql.json({ e2e: true })}, now())
  `;
});

test.afterAll(async () => {
  // Beide Stellungen zurück — eine liegengebliebene Pause hielte das Studio
  // eines späteren Laufs an. Über die Tabelle statt über die Seite: der Browser
  // ist längst weg, und was zählt, ist die Zeile.
  await sql`DELETE FROM config WHERE key IN ('controlling.pause', 'controlling.sparbetrieb')`;
  await sql?.end();
});

test.describe('§17.8 — Budget und die zwei Schalter', () => {
  test('zeigt keine Zahl ohne die Angabe, was sie wert ist (A73)', async ({ context, page }) => {
    await zumControlling(context, page);

    const fenster = page.getByTestId('controlling-fenster').locator('li');
    await expect(fenster.first()).toBeVisible();

    // Die tragende Zusicherung dieser Datei: **jede** gerenderte Zeile trägt
    // ein Etikett. Eine Stichprobe würde die eine Lücke übersehen, die es
    // gibt — und welche das wäre, weiss man vorher nicht.
    const anzahl = await fenster.count();
    expect(anzahl).toBeGreaterThan(0);
    for (let i = 0; i < anzahl; i += 1) {
      await expect(fenster.nth(i)).toContainText(/\[(Gemessen|Geschätzt|Strittig|Keine Messung)\]/);
    }

    // Und die beiden Quellen werden wirklich unterschieden — sonst wäre ein
    // fest verdrahtetes „Geschätzt" mit der Schleife oben vereinbar.
    const fuenfStunden = page.getByTestId('controlling-fenster-five_hour:');
    await expect(fuenfStunden).toContainText('[Geschätzt]');
    await expect(fuenfStunden).toContainText('12,5 %');
    await expect(fuenfStunden).toContainText('75 %');
    const woche = page.getByTestId('controlling-fenster-seven_day:');
    await expect(woche).toContainText('[Gemessen]');
    await expect(woche).not.toContainText('Schätzung');
  });

  test('hält das Studio an und schreibt die Stellung wirklich in config', async ({
    context,
    page,
  }) => {
    await zumControlling(context, page);
    await expect(page.getByTestId('controlling-pause-normal')).toBeChecked();

    await page.getByTestId('controlling-pause-pause').check();
    await expect(page.getByTestId('controlling-notiz')).toBeVisible();

    // Die Zeile, die der Wächter im Daemon liest. Ohne sie wäre der Schalter
    // React-Zustand, der sich wie gespeichert liest.
    expect(await storedPause()).toBe('pause');

    // Und die Kopfzeile nennt die Handpause als Handpause — nicht als Budget.
    await expect(page.getByTestId('controlling-kopfzeile')).toContainText('Von Hand angehalten');

    await page.reload();
    await expect(page.getByTestId('controlling-pause-pause')).toBeChecked();

    await page.getByTestId('controlling-pause-normal').check();
    await expect(page.getByTestId('controlling-notiz')).toBeVisible();
    expect(await storedPause()).toBe('normal');
  });

  test('trägt jede Betätigung mit der Sitzung ins Prüfprotokoll (§19, A75.3)', async ({
    context,
    page,
  }) => {
    await zumControlling(context, page);
    const actor = `dashboard:${await sessionUser(page)}`;
    const vorher = await trailCount('config.pause_changed');

    await page.getByTestId('controlling-pause-pause').check();
    await expect(page.getByTestId('controlling-notiz')).toBeVisible();

    expect(await trailCount('config.pause_changed')).toBe(vorher + 1);
    const rows = await sql<{ actor: string; before: unknown; after: unknown }[]>`
      SELECT actor, before, after FROM audit_log
      WHERE action = 'config.pause_changed' ORDER BY occurred_at DESC, id DESC LIMIT 1
    `;
    expect(rows[0]?.actor).toBe(actor);
    expect(rows[0]?.actor).toContain('dashboard:');
    // Beide Seiten: „nach Pause" allein sagt nicht, ob das Studio vorher lief.
    expect(rows[0]?.after).toEqual({ modus: 'pause' });

    await page.getByTestId('controlling-pause-normal').check();
    await expect(page.getByTestId('controlling-notiz')).toBeVisible();
  });

  test('schaltet den Sparbetrieb und behauptet dabei nicht mehr, als er tut', async ({
    context,
    page,
  }) => {
    await zumControlling(context, page);
    const vorher = await trailCount('config.sparbetrieb_changed');

    await page.getByTestId('controlling-sparbetrieb').check();
    await expect(page.getByTestId('controlling-notiz')).toBeVisible();
    expect(await trailCount('config.sparbetrieb_changed')).toBe(vorher + 1);

    // A22s vier Wirkungen, jede mit ihrem Stand. Die eine, die verdrahtet ist,
    // und mindestens eine, die es nicht ist — eine Seite, die alle vier als
    // wirksam meldete, wäre genau der Defekt, den dieses Projekt fünfmal
    // gefunden hat, frisch nachgebaut.
    await expect(page.getByTestId('controlling-wirkung-idle_audits')).toContainText('Verdrahtet');
    await expect(page.getByTestId('controlling-wirkung-idle_audits')).not.toContainText(
      'Noch nicht verdrahtet',
    );
    await expect(page.getByTestId('controlling-wirkung-tier')).toContainText(
      'Noch nicht verdrahtet',
    );
    await expect(page.getByTestId('controlling-wirkung-concurrency')).toContainText(
      'Noch nicht verdrahtet',
    );

    // Und die Falle aus §8.2 Regel 3 gegen A22, auf der Seite: die
    // Betriebsprüfung wird *nicht* herabgestuft, die Reviewerin auch nicht,
    // eine gewöhnliche starke Rolle schon.
    await expect(page.getByTestId('controlling-stufe-auditor')).toContainText('strong → strong');
    await expect(page.getByTestId('controlling-stufe-reviewer')).toContainText('strong → strong');
    await expect(page.getByTestId('controlling-stufe-planner')).toContainText('strong → standard');

    await page.getByTestId('controlling-sparbetrieb').uncheck();
    await expect(page.getByTestId('controlling-notiz')).toBeVisible();
  });
});
