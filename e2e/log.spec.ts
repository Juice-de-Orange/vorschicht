/**
 * §18s Log-Explorer im Browser, gegen echte Zeilen.
 *
 * §18 verlangt „a queryable log explorer in the dashboard (filter by
 * project/task/level/time + full-text)". Drei Zusicherungen kann nur ein
 * Browser abgeben, und die zweite ist die, die diese Seite von einem stillen
 * Filter unterscheidet:
 *
 *   1. **Die abgeleitete Stufe erreicht wirklich die Seite.** `logStufe` ist
 *      unit-getestet und bliebe grün gegen eine Seite, die sie nie aufruft —
 *      genau die Form, die §8.2s sechste Domäne sucht.
 *   2. **Das Rauschen ist ausgeblendet, die Seite sagt es, und der Schalter
 *      holt es zurück.** A64 macht `guardian.anomaly` zum Dauerzustand und A101
 *      hat 18 411 Zeilen aus einem Defekt gezählt; ein Explorer, der sie
 *      stillschweigend wegfiltert, wäre die Klasse, die dieses Projekt sonst
 *      als Fund führt.
 *   3. **Der Volltext trifft die Nutzlast**, nicht nur die Art — er geht über
 *      `jsonb_to_tsvector` und damit über den Index aus 0023.
 *
 * Gesät wird **roh über SQL**: `EventLog` ist der geprüfte Erzeuger, und eine
 * Fixture, die ihn benutzt, kann einen Fehler in ihm aufsetzen und im selben
 * Zug bestehen lassen.
 */
import { execFileSync } from 'node:child_process';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createSql } from '@vorschicht/db';

const sql = createSql({ url: process.env.TEST_DATABASE_URL ?? '', max: 1 });

const WEB_PORT = process.env.E2E_WEB_PORT ?? '5173';
const API_PORT = process.env.E2E_API_PORT ?? '8421';

/** Eine Marke je Lauf: die Suiten teilen sich eine Datenbank, die nie aufräumt. */
const MARKE = `e2e-log-${Date.now()}`;

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
  await page.getByTestId('label').fill('E2E-Log');
  await page.getByTestId('register').click();
  await expect(page.getByTestId('logout')).toBeVisible();
}

async function saeEreignis(kind: string, payload: Record<string, unknown>): Promise<number> {
  const [row] = await sql<Array<{ id: string }>>`
    INSERT INTO event_log (kind, actor, payload)
    VALUES (${kind}, ${MARKE}, ${sql.json(payload as never)})
    RETURNING id
  `;
  return Number(row?.id ?? 0);
}

test.describe
  .serial('§18s Log-Explorer', () => {
    let sitzung: BrowserContext;
    let seite: Page;
    let alarmId = 0;
    let rauschId = 0;

    test.beforeAll(async ({ browser }) => {
      alarmId = await saeEreignis('deploy.rolled_back', {
        marke: MARKE,
        problem: 'Gesundheitspruefung gescheitert',
        status: 503,
      });
      rauschId = await saeEreignis('guardian.anomaly', {
        marke: MARKE,
        reason: 'rate_limits_unavailable',
      });
      expect(alarmId).toBeGreaterThan(0);
      expect(rauschId).toBeGreaterThan(0);

      sitzung = await browser.newContext();
      seite = await sitzung.newPage();
      await signIn(sitzung, seite);
    });

    test.afterAll(async () => {
      await sitzung?.close();
      await sql?.end({ timeout: 5 });
    });

    /**
     * §18 nennt „filter by level", und `event_log` hat keine Stufenspalte. Der
     * Fall prüft, dass die **abgeleitete** Stufe die Seite wirklich erreicht —
     * eine Zeile mit `deploy.rolled_back` muss dort „Alarm" tragen, als Wort und
     * nicht nur als Farbe.
     */
    test('zeigt die abgeleitete Stufe als Wort und filtert danach', async () => {
      await seite.goto(`/log?suche=${MARKE}`);

      const zeile = seite.getByTestId(`log-zeile-${alarmId}`);
      await expect(zeile).toBeVisible();
      await expect(zeile).toContainText('Alarm');
      await expect(zeile).toContainText('deploy.rolled_back');
      // Farbe trägt die Aussage nicht allein (a11y) — der Ton steht daneben.
      await expect(zeile).toHaveAttribute('data-ton', 'alarm');

      // Der Stufenfilter trifft dieselbe Menge: „Information" darf diese Zeile
      // nicht mehr enthalten.
      await seite.getByTestId('log-stufe').selectOption('info');
      await expect(seite.getByTestId(`log-zeile-${alarmId}`)).toHaveCount(0);
      await seite.getByTestId('log-stufe').selectOption('alarm');
      await expect(seite.getByTestId(`log-zeile-${alarmId}`)).toBeVisible();
    });

    /**
     * Die tragende Zusicherung dieser Datei: ausgeblendet **und gesagt**, und der
     * Schalter holt es zurück. Ein stiller Filter wäre hier genau der Fund, den
     * dieses Projekt sonst meldet.
     */
    test('blendet §18s Rauschen aus, sagt es, und der Schalter holt es zurück', async () => {
      await seite.goto(`/log?suche=${MARKE}`);

      await expect(seite.getByTestId(`log-zeile-${rauschId}`)).toHaveCount(0);
      const hinweis = seite.getByTestId('log-rauschhinweis');
      await expect(hinweis).toContainText('guardian.anomaly');
      // Die Zahl über den gezeigten Ausschnitt, nicht nur ein allgemeiner Satz.
      await expect(hinweis).toContainText('verborgen');

      await seite.getByTestId('log-rauschen').check();
      await expect(seite.getByTestId(`log-zeile-${rauschId}`)).toBeVisible();
      // Und der Hinweis verschwindet: ein Hinweis über einen Filter, der nicht
      // greift, ist eine Zeile, die man zu übersehen lernt.
      await expect(seite.getByTestId('log-rauschhinweis')).toHaveCount(0);
    });

    /**
     * §18s Volltext geht über die **Nutzlast** und nicht nur über die Art — sonst
     * fände man den Rollout nicht, dessen Grund in `problem` steht. Derselbe
     * Ausdruck wie der Index aus Migration 0023.
     */
    test('findet eine Zeile über ein Wort aus ihrer Nutzlast', async () => {
      await seite.goto('/log?suche=Gesundheitspruefung');
      await expect(seite.getByTestId(`log-zeile-${alarmId}`)).toBeVisible();

      await seite.goto('/log?suche=gibtesnichtimprotokoll');
      await expect(seite.getByTestId('log-leer')).toBeVisible();
    });

    /**
     * §18s Deep-Link auf eine Zeile: er öffnet das Protokoll **an** ihr — sie
     * steht oben, die älteren darunter — und markiert sie, damit ein Leser sie
     * findet, statt sie in hundert Zeilen zu suchen.
     */
    test('öffnet das Protokoll an einer angesteuerten Zeile', async () => {
      await seite.goto(`/log/${alarmId}`);
      const zeile = seite.getByTestId(`log-zeile-${alarmId}`);
      await expect(zeile).toBeVisible();
      await expect(zeile).toHaveAttribute('data-angesteuert', '');
      // Die Zeile darüber gehört nicht dazu: der Cursor schneidet alles Neuere ab.
      await expect(seite.getByTestId('log-liste').locator('> li').first()).toHaveAttribute(
        'data-angesteuert',
        '',
      );
    });
  });
