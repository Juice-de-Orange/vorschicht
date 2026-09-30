import { describe, expect, it } from 'vitest';
import {
  clearSessionCookie,
  digestsEqual,
  hashToken,
  mintToken,
  readSessionCookie,
  SESSION_COOKIE,
  serialiseSessionCookie,
} from './tokens.js';

describe('mintToken', () => {
  it('produces URL-safe tokens with 256 bits of entropy', () => {
    const token = mintToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('never repeats', () => {
    const tokens = new Set(Array.from({ length: 500 }, mintToken));
    expect(tokens.size).toBe(500);
  });
});

describe('hashToken', () => {
  it('is deterministic and does not reveal the token', () => {
    const token = mintToken();
    expect(hashToken(token)).toBe(hashToken(token));
    expect(hashToken(token)).not.toContain(token);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('digestsEqual', () => {
  it('compares equal and unequal digests correctly', () => {
    const a = hashToken('a');
    expect(digestsEqual(a, a)).toBe(true);
    expect(digestsEqual(a, hashToken('b'))).toBe(false);
  });

  it('returns false rather than throwing on a length mismatch', () => {
    expect(digestsEqual(hashToken('a'), 'deadbeef')).toBe(false);
  });
});

describe('session cookie', () => {
  // These flags are the CSRF and interception controls from §19. A regression
  // here would be invisible in every functional test, so it gets its own.
  it('sets HttpOnly, SameSite=Strict and Secure over TLS', () => {
    const cookie = serialiseSessionCookie('tok', { secure: true, maxAgeSeconds: 60 });
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=60');
  });

  it('omits Secure only when explicitly running without TLS', () => {
    expect(serialiseSessionCookie('tok', { secure: false, maxAgeSeconds: 60 })).not.toContain(
      'Secure',
    );
  });

  it('expires the cookie when clearing', () => {
    expect(clearSessionCookie(true)).toContain('Max-Age=0');
  });

  it('reads its own cookie out of a header with several', () => {
    const header = `theme=dark; ${SESSION_COOKIE}=abc123; other=1`;
    expect(readSessionCookie(header)).toBe('abc123');
  });

  it('returns null when absent, empty or headerless', () => {
    expect(readSessionCookie(null)).toBeNull();
    expect(readSessionCookie('')).toBeNull();
    expect(readSessionCookie('theme=dark')).toBeNull();
    expect(readSessionCookie(`${SESSION_COOKIE}=`)).toBeNull();
  });
});
