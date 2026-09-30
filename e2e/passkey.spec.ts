import { execFileSync } from 'node:child_process';
import { type BrowserContext, type CDPSession, expect, type Page, test } from '@playwright/test';

/**
 * Phase 0 gate 6 — passkey bootstrap, lock and CLI rescue (§19).
 *
 * Each `it` here corresponds to a clause of the exit gate:
 *   · bootstrap enforces two credentials before it counts as complete
 *   · register + login + logout demonstrated
 *   · a further registration attempt is correctly refused
 *   · the CLI rescue mints a working one-time invite
 *
 * Every credential gets its own virtual authenticator, because a second passkey
 * on the same authenticator would be one device wearing two hats — and §19 asks
 * for two *devices* precisely so that losing one does not lock the operator out.
 */

const API_PORT = process.env.E2E_API_PORT ?? '8421';
const WEB_PORT = process.env.E2E_WEB_PORT ?? '5173';

/** Mint an invite by running the real CLI, exactly as the operator would over SSH. */
function mintInvite(purpose: 'bootstrap' | 'rescue' = 'bootstrap'): string {
  const output = execFileSync(
    process.execPath,
    ['apps/server/dist/cli/invite.js', `--purpose=${purpose}`],
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

async function addAuthenticator(context: BrowserContext, page: Page): Promise<CDPSession> {
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
  return client;
}

async function registerPasskey(page: Page, label: string, invite?: string) {
  await page.goto(invite ? `/#${invite}` : '/');
  await page.getByTestId('label').fill(label);
  await page.getByTestId('register').click();
}

test.describe
  .serial('Passkey-Bootstrap', () => {
    test('erste Registrierung per Einladung, Bootstrap noch unvollständig', async ({
      context,
      page,
    }) => {
      await addAuthenticator(context, page);
      await registerPasskey(page, 'Handy', mintInvite());

      await expect(page.getByTestId('note')).toContainText('Noch 1');
      await expect(page.getByTestId('credential-count')).toContainText('1');
      // The banner must keep saying the setup is incomplete: one passkey means
      // one lost phone away from being locked out.
      await expect(page.getByTestId('bootstrap-hinweis')).toContainText('selbst aus');
    });

    test('eine verbrauchte Einladung wird abgewiesen', async ({ context, page }) => {
      await addAuthenticator(context, page);
      const invite = mintInvite();
      await registerPasskey(page, 'Zweitgerät', invite);
      await expect(page.getByTestId('note')).toBeVisible();

      // Sign out first: registration issues a session, and an authenticated
      // caller is allowed to add passkeys without any invite at all (§19). The
      // invite rule can only be observed from an unauthenticated state.
      await page.getByTestId('logout').click();
      await expect(page.getByTestId('login')).toBeVisible();

      // Same token again, fresh authenticator: single-use must mean single-use.
      await page.goto(`/#${invite}`);
      await page.getByTestId('label').fill('Drittgerät');
      await page.getByTestId('register').click();
      await expect(page.getByTestId('error')).toContainText('bereits verwendet');
    });

    test('nach zwei Passkeys gilt die Einrichtung als vollständig', async ({ page }) => {
      await page.goto('/');
      await expect(page.getByTestId('credential-count')).toContainText('2');
      await expect(page.getByTestId('bootstrap-hinweis')).toHaveCount(0);
    });

    test('Registrierung ohne Einladung und ohne Sitzung wird verweigert', async ({
      context,
      page,
    }) => {
      await addAuthenticator(context, page);
      await page.goto('/');
      await page.getByTestId('label').fill('Fremdgerät');
      await page.getByTestId('register').click();
      await expect(page.getByTestId('error')).toContainText('gesperrt');
      await expect(page.getByTestId('credential-count')).toContainText('2');
    });

    test('CLI-Rescue erzeugt eine funktionierende Einladung — auch nach dem Lock', async ({
      context,
      page,
    }) => {
      await addAuthenticator(context, page);
      // Whoever can run this already has SSH on the host, which outranks a
      // passkey — so the rescue path must still work after the lock (§19).
      await registerPasskey(page, 'Ersatzgerät', mintInvite('rescue'));
      await expect(page.getByTestId('note')).toContainText('Passkey gespeichert');
      await expect(page.getByTestId('credential-count')).toContainText('3');
    });
  });

test.describe
  .serial('Anmelden und Abmelden', () => {
    test('Registrierung meldet an, Abmelden beendet die Sitzung, Passkey meldet wieder an', async ({
      context,
      page,
    }) => {
      const client = await addAuthenticator(context, page);
      await registerPasskey(page, 'Login-Gerät', mintInvite());
      await expect(page.getByTestId('logout')).toBeVisible();

      // A guarded route must be reachable while the session lives …
      expect((await page.request.get(`http://127.0.0.1:${API_PORT}/api/me`)).status()).toBe(401);
      expect((await page.request.get('/api/me')).status()).toBe(200);

      await page.getByTestId('logout').click();
      await expect(page.getByTestId('login')).toBeVisible();
      // … and unreachable once it is gone.
      expect((await page.request.get('/api/me')).status()).toBe(401);

      await page.getByTestId('login').click();
      await expect(page.getByTestId('note')).toContainText('Angemeldet mit');
      expect((await page.request.get('/api/me')).status()).toBe(200);

      await client.send('WebAuthn.disable');
    });
  });
