import { describe, expect, it } from 'vitest';
import {
  bootstrapState,
  decideRegistration,
  describeBootstrap,
  describeRefusal,
  type InviteFacts,
  REQUIRED_BOOTSTRAP_CREDENTIALS,
} from './auth-policy.js';

const NOW = 1_800_000_000_000;

function invite(overrides: Partial<InviteFacts> = {}): InviteFacts {
  return { purpose: 'bootstrap', expiresAt: NOW + 900_000, usedAt: null, ...overrides };
}

describe('decideRegistration', () => {
  it('allows registration with a fresh invite on an empty system', () => {
    expect(
      decideRegistration({ credentialCount: 0, invite: invite(), authenticated: false, now: NOW }),
    ).toEqual({ allow: true, purpose: 'bootstrap' });
  });

  // There is no moment — not even with zero credentials — when an anonymous
  // caller may register. The dashboard is on the public internet (§2).
  it('refuses an anonymous caller without an invite, even on an empty system', () => {
    expect(
      decideRegistration({ credentialCount: 0, invite: null, authenticated: false, now: NOW }),
    ).toEqual({ allow: false, reason: 'no_credential_offered' });
  });

  it('refuses a used invite', () => {
    expect(
      decideRegistration({
        credentialCount: 1,
        invite: invite({ usedAt: NOW - 1000 }),
        authenticated: false,
        now: NOW,
      }),
    ).toEqual({ allow: false, reason: 'invite_already_used' });
  });

  it('refuses an expired invite, boundary included', () => {
    expect(
      decideRegistration({
        credentialCount: 1,
        invite: invite({ expiresAt: NOW }),
        authenticated: false,
        now: NOW,
      }),
    ).toEqual({ allow: false, reason: 'invite_expired' });
  });

  // This is the gate's "further registration attempt correctly refused".
  it('refuses a further registration once bootstrap is complete', () => {
    expect(
      decideRegistration({
        credentialCount: REQUIRED_BOOTSTRAP_CREDENTIALS,
        invite: null,
        authenticated: false,
        now: NOW,
      }),
    ).toEqual({ allow: false, reason: 'no_credential_offered' });
  });

  it('lets an authenticated session add a passkey', () => {
    expect(
      decideRegistration({ credentialCount: 2, invite: null, authenticated: true, now: NOW }),
    ).toEqual({ allow: true, purpose: 'additional' });
  });

  // §19's rescue path: whoever can mint an invite already has SSH on the host,
  // which outranks a passkey. It must therefore still work after the lock.
  it('honours a rescue invite after bootstrap is complete', () => {
    expect(
      decideRegistration({
        credentialCount: 5,
        invite: invite({ purpose: 'rescue' }),
        authenticated: false,
        now: NOW,
      }),
    ).toEqual({ allow: true, purpose: 'rescue' });
  });
});

describe('bootstrapState', () => {
  it.each([
    [0, false, 2],
    [1, false, 1],
    [2, true, 0],
    [7, true, 0],
  ])('with %i credentials → complete=%s, missing=%i', (count, complete, missing) => {
    expect(bootstrapState(count)).toEqual({ complete, credentialCount: count, missing });
  });
});

describe('German copy (§2)', () => {
  it('names the CLI command when there is no passkey at all', () => {
    const hint = describeBootstrap(bootstrapState(0));
    // A command that exists: the CLI is in the `app` image, and there is no
    // `vorschicht-invite` binary anywhere (the hint used to name one).
    expect(hint).toContain('exec app node dist/cli/invite.js');
    expect(hint).not.toContain('vorschicht-invite');
  });

  it('explains the lock-out risk at one credential', () => {
    expect(describeBootstrap(bootstrapState(1))).toContain('selbst aus');
  });

  it('says nothing once the bootstrap is complete', () => {
    expect(describeBootstrap(bootstrapState(2))).toBeNull();
  });

  it('tells an expired invite how to get a new one', () => {
    expect(describeRefusal('invite_expired')).toContain('exec app node dist/cli/invite.js');
  });
});
