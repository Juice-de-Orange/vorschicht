/**
 * Client side of the passkey ceremony (§19).
 *
 * The base64url ↔ ArrayBuffer conversions WebAuthn needs are handled by
 * `@simplewebauthn/browser`, the counterpart to the server library — hand-rolled
 * conversions here would be a second implementation of the same encoding rules,
 * and the two would eventually disagree.
 */
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

export interface BootstrapInfo {
  bootstrap: { complete: boolean; credentialCount: number; missing: number };
  hinweis: string | null;
  angemeldet: boolean;
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // The session cookie is SameSite=Strict; same-origin requests carry it.
    credentials: 'same-origin',
    body: JSON.stringify(body),
  });
}

async function unwrap<T>(response: Response): Promise<T> {
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      (payload as { error?: string } | null)?.error ?? `Serverfehler (${response.status})`,
    );
  }
  return payload as T;
}

export async function fetchAuthState(): Promise<BootstrapInfo> {
  return unwrap<BootstrapInfo>(await fetch('/api/auth/state', { credentials: 'same-origin' }));
}

/**
 * Register a new passkey.
 *
 * The invite token is read from the URL fragment by the caller and never put
 * into a query string: everything after `#` stays in the browser, so the token
 * appears in no access log and no Referer header.
 */
export async function register(label: string, invite?: string): Promise<BootstrapInfo> {
  const options = await unwrap<Parameters<typeof startRegistration>[0]['optionsJSON']>(
    await post('/api/auth/register/options', { label, invite }),
  );
  const attestation = await startRegistration({ optionsJSON: options });
  return unwrap<BootstrapInfo>(
    await post('/api/auth/register/verify', { label, invite, response: attestation }),
  );
}

export async function login(): Promise<{ ok: true; passkey: string }> {
  const options = await unwrap<Parameters<typeof startAuthentication>[0]['optionsJSON']>(
    await post('/api/auth/login/options', {}),
  );
  const assertion = await startAuthentication({ optionsJSON: options });
  return unwrap<{ ok: true; passkey: string }>(await post('/api/auth/login/verify', assertion));
}

export async function logout(): Promise<void> {
  await unwrap(await post('/api/auth/logout', {}));
}
