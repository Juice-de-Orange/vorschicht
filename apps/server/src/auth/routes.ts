/**
 * WebAuthn routes (§19).
 *
 * Single user by design — Vorschicht has exactly one owner — so there is no
 * user table and no username step. The relying party is the public hostname,
 * and a credential *is* the identity.
 *
 * CSRF is defended twice over: `SameSite=Strict` on the session cookie means a
 * cross-site request never carries it, and every mutating route additionally
 * requires an `Origin` matching the configured public origin. Two independent
 * layers, because this endpoint is on the open internet (§2) and the browser
 * flag is the kind of thing that changes underneath you.
 */
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import {
  bootstrapState,
  decideRegistration,
  describeBootstrap,
  describeRefusal,
} from '@vorschicht/shared';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AuthStore } from './store.js';
import {
  clearSessionCookie,
  readSessionCookie,
  SESSION_TTL_MS,
  serialiseSessionCookie,
} from './tokens.js';

export interface AuthRouteDeps {
  store: AuthStore;
  rpId: string;
  rpName: string;
  origin: string;
  /** False only for local HTTP development; production is always true. */
  secureCookies: boolean;
}

/** Stable user handle: there is exactly one user, and it is the operator. */
/**
 * Wie viele Zugangsdaten höchstens in `excludeCredentials` reisen.
 *
 * Der Browser weist die Zeremonie über seiner Grenze **ganz** ab (gemessen: 64).
 * 32 lässt Luft, falls eine Fassung strenger zählt, und liegt weit über allem,
 * was ein Einzelnutzer je an Geräten hat — §19 verlangt zwei.
 */
export const EXCLUDE_CREDENTIALS_MAX = 32;

/**
 * Neueste zuerst, ohne die Eingabe anzufassen.
 *
 * `listCredentials` sortiert nach `created_at` aufsteigend, weil die
 * Einrichtungszählung sie in dieser Reihenfolge liest; hier wird die umgekehrte
 * gebraucht, und ein `reverse()` auf dem übergebenen Feld würde die andere
 * Leserin still verändern.
 */
export function neuesteZuerst<T extends { createdAt: Date }>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

const USER_HANDLE = new TextEncoder().encode('vorschicht-max');
const USER_NAME = 'max';

const registerBody = z.object({
  invite: z.string().min(1).optional(),
  label: z.string().min(1).max(64),
});

function clientContext(req: Request): { ip: string | null; userAgent: string | null } {
  return {
    ip: req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0] ?? null,
    userAgent: req.headers.get('user-agent'),
  };
}

export function createAuthRoutes(deps: AuthRouteDeps): Hono {
  const app = new Hono();
  const { store } = deps;

  // Origin check on every mutation — the second CSRF layer.
  app.use('*', async (c, next) => {
    if (c.req.method === 'GET' || c.req.method === 'HEAD') return next();
    const origin = c.req.header('origin');
    if (origin && origin !== deps.origin) {
      await store.logAuthEvent({
        kind: 'origin_rejected',
        outcome: 'refused',
        detail: origin,
        ...clientContext(c.req.raw),
      });
      return c.json({ error: 'Ungültiger Origin.' }, 403);
    }
    return next();
  });

  /** Public state: how far the bootstrap has come, and whether we are logged in. */
  app.get('/state', async (c) => {
    const count = await store.countCredentials();
    const state = bootstrapState(count);
    const token = readSessionCookie(c.req.header('cookie'));
    const session = token ? await store.findSession(token) : null;
    return c.json({
      bootstrap: state,
      hinweis: describeBootstrap(state),
      angemeldet: session !== null,
    });
  });

  // --- registration ----------------------------------------------------------

  app.post('/register/options', async (c) => {
    const parsed = registerBody.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'Ungültige Anfrage.' }, 400);

    const decision = await decide(parsed.data.invite, c.req.raw);
    if (!decision.allow) {
      await store.logAuthEvent({
        kind: 'register_options',
        outcome: 'refused',
        detail: decision.reason,
        ...clientContext(c.req.raw),
      });
      return c.json({ error: describeRefusal(decision.reason) }, 403);
    }

    const existing = await store.listCredentials();
    const options = await generateRegistrationOptions({
      rpName: deps.rpName,
      rpID: deps.rpId,
      userID: USER_HANDLE,
      userName: USER_NAME,
      attestationType: 'none',
      // Prevents registering the same authenticator twice, which would look
      // like two credentials while being one device (§19 wants two devices).
      //
      // Gedeckelt, und das ist die Behebung eines gemessenen Fehlers: die Liste
      // hat eine Obergrenze, die der Browser durchsetzt, und darüber weist er
      // die **ganze** Zeremonie ab — „The `excludeCredentials` attribute exceeds
      // the maximum allowed size (64)". Ein Konto mit 64 Passkeys könnte dann
      // keinen einzigen weiteren registrieren, auch nicht mit einem gültigen
      // Rettungs-Invite, und §19s Rettungspfad wäre genau dort tot, wo er
      // gebraucht wird. Gefunden am 24.8.2026 in der Browserstrecke, die über
      // ihre zehn Suiten hinweg so viele anlegt.
      //
      // Die **neuesten** und nicht die ältesten: der Zweck ist, ein Gerät nicht
      // zweimal zu registrieren, und wer heute ein Gerät in der Hand hat, hat es
      // wahrscheinlich zuletzt benutzt. Genannter Preis: über der Grenze kann
      // ein sehr altes Gerät ein zweites Mal registriert werden — zwei Zeilen
      // für ein Gerät, was §19s Zählung verwässert, aber niemanden aussperrt.
      // Die Richtung ist bewusst gewählt: eine doppelte Zeile ist ein
      // Schönheitsfehler, eine unmögliche Registrierung ist ein verlorener
      // Zugang.
      excludeCredentials: neuesteZuerst(existing)
        .slice(0, EXCLUDE_CREDENTIALS_MAX)
        .map((cred) => ({ id: cred.id })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
    });

    await store.saveChallenge(options.challenge, 'registration');
    return c.json(options);
  });

  app.post('/register/verify', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = registerBody.extend({ response: z.unknown() }).safeParse(body);
    if (!parsed.success) return c.json({ error: 'Ungültige Anfrage.' }, 400);

    const decision = await decide(parsed.data.invite, c.req.raw);
    if (!decision.allow) {
      await store.logAuthEvent({
        kind: 'register_verify',
        outcome: 'refused',
        detail: decision.reason,
        ...clientContext(c.req.raw),
      });
      return c.json({ error: describeRefusal(decision.reason) }, 403);
    }

    // biome-ignore lint/suspicious/noExplicitAny: the WebAuthn response shape is validated by the library
    const response = parsed.data.response as any;
    const challenge = response?.response?.clientDataJSON
      ? JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString()).challenge
      : null;
    if (
      typeof challenge !== 'string' ||
      !(await store.consumeChallenge(challenge, 'registration'))
    ) {
      return c.json({ error: 'Challenge unbekannt oder abgelaufen.' }, 400);
    }

    let verification: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
    try {
      verification = await verifyRegistrationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: deps.origin,
        expectedRPID: deps.rpId,
      });
    } catch (error) {
      await store.logAuthEvent({
        kind: 'register_verify',
        outcome: 'error',
        detail: (error as Error).message,
        ...clientContext(c.req.raw),
      });
      return c.json({ error: 'Registrierung konnte nicht verifiziert werden.' }, 400);
    }

    if (!verification.verified || !verification.registrationInfo) {
      return c.json({ error: 'Registrierung konnte nicht verifiziert werden.' }, 400);
    }

    const { credential, credentialBackedUp } = verification.registrationInfo;
    const id = await store.saveCredential({
      credentialId: credential.id,
      publicKey: credential.publicKey,
      counter: credential.counter,
      transports: credential.transports ?? [],
      backedUp: credentialBackedUp,
      label: parsed.data.label,
    });

    // Consume the invite only after the credential exists. If this loses a race
    // the credential is already saved but the invite was spent by someone else,
    // so the safe move is to refuse and let the operator mint a new one.
    if (parsed.data.invite) {
      const invite = await store.findInvite(parsed.data.invite);
      if (!invite || !(await store.consumeInvite(invite.id, id))) {
        await store.logAuthEvent({
          kind: 'register_verify',
          outcome: 'refused',
          detail: 'invite_race',
          ...clientContext(c.req.raw),
        });
        return c.json({ error: 'Einladung wurde zwischenzeitlich verbraucht.' }, 409);
      }
    }

    const state = bootstrapState(await store.countCredentials());
    await store.logAuthEvent({
      kind: 'register_verify',
      outcome: 'ok',
      detail: parsed.data.label,
      ...clientContext(c.req.raw),
    });

    const token = await store.createSession(id, clientContext(c.req.raw));
    c.header(
      'Set-Cookie',
      serialiseSessionCookie(token, {
        secure: deps.secureCookies,
        maxAgeSeconds: Math.round(SESSION_TTL_MS / 1000),
      }),
    );
    return c.json({ ok: true, bootstrap: state, hinweis: describeBootstrap(state) });
  });

  // --- authentication --------------------------------------------------------

  app.post('/login/options', async (c) => {
    const options = await generateAuthenticationOptions({
      rpID: deps.rpId,
      userVerification: 'preferred',
    });
    await store.saveChallenge(options.challenge, 'authentication');
    return c.json(options);
  });

  app.post('/login/verify', async (c) => {
    // biome-ignore lint/suspicious/noExplicitAny: the WebAuthn response shape is validated by the library
    const response = (await c.req.json().catch(() => null)) as any;
    if (!response?.id) return c.json({ error: 'Ungültige Anfrage.' }, 400);

    const challenge = response?.response?.clientDataJSON
      ? JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString()).challenge
      : null;
    if (
      typeof challenge !== 'string' ||
      !(await store.consumeChallenge(challenge, 'authentication'))
    ) {
      return c.json({ error: 'Challenge unbekannt oder abgelaufen.' }, 400);
    }

    const stored = await store.findCredential(response.id);
    if (!stored) {
      await store.logAuthEvent({
        kind: 'login',
        outcome: 'refused',
        detail: 'unknown_credential',
        ...clientContext(c.req.raw),
      });
      return c.json({ error: 'Unbekannter Passkey.' }, 401);
    }

    let verification: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge,
        expectedOrigin: deps.origin,
        expectedRPID: deps.rpId,
        credential: {
          id: stored.credentialId,
          // Copied into a fresh view: the driver hands back a Uint8Array whose
          // buffer type is widened to ArrayBufferLike, which the library's
          // stricter signature rejects.
          publicKey: new Uint8Array(stored.publicKey),
          counter: Number(stored.counter),
          transports: stored.transports as never,
        },
      });
    } catch (error) {
      await store.logAuthEvent({
        kind: 'login',
        outcome: 'error',
        detail: (error as Error).message,
        ...clientContext(c.req.raw),
      });
      return c.json({ error: 'Anmeldung fehlgeschlagen.' }, 401);
    }

    if (!verification.verified) {
      await store.logAuthEvent({
        kind: 'login',
        outcome: 'refused',
        detail: 'not_verified',
        ...clientContext(c.req.raw),
      });
      return c.json({ error: 'Anmeldung fehlgeschlagen.' }, 401);
    }

    await store.touchCredential(stored.id, verification.authenticationInfo.newCounter);
    await store.logAuthEvent({
      kind: 'login',
      outcome: 'ok',
      detail: stored.label,
      ...clientContext(c.req.raw),
    });

    const token = await store.createSession(stored.id, clientContext(c.req.raw));
    c.header(
      'Set-Cookie',
      serialiseSessionCookie(token, {
        secure: deps.secureCookies,
        maxAgeSeconds: Math.round(SESSION_TTL_MS / 1000),
      }),
    );
    return c.json({ ok: true, passkey: stored.label });
  });

  app.post('/logout', async (c) => {
    const token = readSessionCookie(c.req.header('cookie'));
    if (token) await store.revokeSession(token);
    await store.logAuthEvent({ kind: 'logout', outcome: 'ok', ...clientContext(c.req.raw) });
    c.header('Set-Cookie', clearSessionCookie(deps.secureCookies));
    return c.json({ ok: true });
  });

  return app;

  async function decide(inviteToken: string | undefined, req: Request) {
    const count = await store.countCredentials();
    const sessionToken = readSessionCookie(req.headers.get('cookie'));
    const session = sessionToken ? await store.findSession(sessionToken) : null;
    const invite = inviteToken ? await store.findInvite(inviteToken) : null;

    // An unknown invite token and no invite at all are different mistakes and
    // deserve different messages.
    if (inviteToken && invite === null) {
      return { allow: false as const, reason: 'invite_unknown' as const };
    }
    return decideRegistration({
      credentialCount: count,
      invite,
      authenticated: session !== null,
      now: Date.now(),
    });
  }
}
