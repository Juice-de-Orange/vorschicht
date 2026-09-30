import { describe, expect, it } from 'vitest';
import {
  assertPinnedCliVersion,
  assertSimpleModeOff,
  assertSubscriptionAuth,
  parseAuthStatus,
} from './self-check.js';

const REAL_OUTPUT = JSON.stringify({
  loggedIn: true,
  authMethod: 'oauth_token',
  apiProvider: 'firstParty',
});

describe('parseAuthStatus', () => {
  it('parses the real CLI output shape', () => {
    expect(parseAuthStatus(REAL_OUTPUT)).toEqual({
      loggedIn: true,
      authMethod: 'oauth_token',
      apiProvider: 'firstParty',
      subscriptionType: null,
    });
  });

  it('returns null on anything unparseable rather than guessing', () => {
    expect(parseAuthStatus('not json')).toBeNull();
    expect(parseAuthStatus('{}')).toBeNull();
    expect(parseAuthStatus(JSON.stringify({ loggedIn: 'yes' }))).toBeNull();
  });
});

describe('assertSubscriptionAuth', () => {
  it('accepts subscription auth', () => {
    expect(assertSubscriptionAuth(parseAuthStatus(REAL_OUTPUT))).toEqual({ ok: true });
    expect(
      assertSubscriptionAuth({
        loggedIn: true,
        authMethod: 'claude.ai',
        apiProvider: 'firstParty',
      }),
    ).toEqual({ ok: true });
  });

  // This is §2's hard rule checked against the *effective* state rather than
  // against our own source, which is the only version of the check that can
  // catch a key arriving via settings, apiKeyHelper or inherited env.
  it('refuses an API-key path even when logged in', () => {
    const result = assertSubscriptionAuth({
      loggedIn: true,
      authMethod: 'api_key',
      apiProvider: 'firstParty',
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('§2') });
  });

  it('refuses a third-party provider', () => {
    const result = assertSubscriptionAuth({
      loggedIn: true,
      authMethod: 'oauth_token',
      apiProvider: 'bedrock',
    });
    expect(result.ok).toBe(false);
  });

  it('treats "not logged in" as an auth incident, with §6.1 named', () => {
    const result = assertSubscriptionAuth({
      loggedIn: false,
      authMethod: 'oauth_token',
      apiProvider: 'firstParty',
    });
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('§6.1') });
  });

  it('refuses when the status could not be read at all', () => {
    expect(assertSubscriptionAuth(null).ok).toBe(false);
  });
});

describe('assertPinnedCliVersion', () => {
  it('accepts the pinned version in the CLI’s own output format', () => {
    expect(assertPinnedCliVersion('2.1.220 (Claude Code)', '2.1.220')).toEqual({ ok: true });
  });

  // watchtower updates every container on the production host nightly (A34); a drifted
  // CLI must stop the daemon rather than quietly change how runs behave.
  it('refuses a drifted version and names the radar rule', () => {
    const result = assertPinnedCliVersion('2.1.221 (Claude Code)', '2.1.220');
    expect(result).toEqual({ ok: false, reason: expect.stringContaining('A27') });
  });

  it('refuses unreadable version strings', () => {
    expect(assertPinnedCliVersion('unknown', '2.1.220').ok).toBe(false);
    expect(assertPinnedCliVersion('2.1.220', 'latest').ok).toBe(false);
  });
});

describe('assertSimpleModeOff', () => {
  it('passes when --bare is not in play', () => {
    expect(assertSimpleModeOff({})).toEqual({ ok: true });
  });

  // --bare is disqualified twice: it forces API-key auth and it silently skips
  // hooks, i.e. the entire §6.6 containment layer.
  it('refuses when CLAUDE_CODE_SIMPLE is set, naming both consequences', () => {
    const result = assertSimpleModeOff({ CLAUDE_CODE_SIMPLE: '1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('§2');
      expect(result.reason).toContain('§6.6');
    }
  });
});
