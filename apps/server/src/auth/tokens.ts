/**
 * Token minting and verification for invites and sessions (§19).
 *
 * Only hashes ever reach the database. The backup sidecar dumps that database
 * nightly and ships it off-site (A14); a dump that contained live session
 * tokens would turn every backup into a spare set of keys.
 *
 * SHA-256 rather than a password hash is the right choice here *because* these
 * are 256-bit random tokens, not passwords: there is no low-entropy guess to
 * slow down, and a fast hash keeps session lookup cheap on every request.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** 32 bytes, base64url — 256 bits of entropy, URL-safe for invite links. */
export function mintToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Constant-time comparison of two hex digests.
 *
 * Lookups are by hash and therefore already constant-time-ish at the database
 * level, but any place that compares two digests in application code should not
 * leak position through early exit.
 */
export function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export const SESSION_COOKIE = 'vorschicht_session';

/** Sessions last 30 days; the rolling refresh happens on use. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Invites are short-lived on purpose: a lingering invite is a standing hole. */
export const INVITE_TTL_MS = 15 * 60 * 1000;

/** WebAuthn ceremonies are two-legged and should not straddle a coffee break. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

export interface CookieOptions {
  secure: boolean;
  maxAgeSeconds: number;
}

/**
 * Serialise the session cookie.
 *
 * `SameSite=Strict` is the CSRF control (§19): the browser will not attach this
 * cookie to any cross-site request, including top-level navigations, so a
 * mutation triggered from another origin arrives unauthenticated. The Origin
 * check in the route layer is the second, independent layer.
 */
export function serialiseSessionCookie(token: string, options: CookieOptions): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${options.maxAgeSeconds}`,
  ];
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

export function clearSessionCookie(secure: boolean): string {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (secure) parts.push('Secure');
  return parts.join('; ');
}

export function readSessionCookie(header: string | null | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === SESSION_COOKIE) {
      const value = rest.join('=');
      return value.length > 0 ? value : null;
    }
  }
  return null;
}
