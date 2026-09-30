/**
 * Registration policy for passkeys (§19).
 *
 * Pure decision logic, kept apart from the database and the HTTP layer so the
 * rule that guards a publicly reachable dashboard can be exhaustively tested
 * without spinning anything up.
 *
 * The rule in one sentence: **registration always requires either an
 * authenticated session or an unused, unexpired, single-use invite** — and
 * invites can only be minted from a shell on the host. There is no moment in
 * this system's life, not even on an empty database, when an anonymous caller
 * may register a credential.
 *
 * "Bootstrap requires two credentials before registration locks" (§19) is
 * therefore not a second, weaker mode. It is a *completeness* requirement: with
 * one passkey the operator is one lost phone away from being locked out of his own
 * studio, so the system reports the bootstrap as incomplete and keeps saying so
 * until a second credential exists.
 */

export type RegistrationPurpose = 'bootstrap' | 'rescue' | 'additional';

/** Minimum credentials before the bootstrap counts as done (§19). */
export const REQUIRED_BOOTSTRAP_CREDENTIALS = 2;

export interface InviteFacts {
  purpose: RegistrationPurpose;
  expiresAt: number;
  usedAt: number | null;
}

export interface RegistrationRequest {
  credentialCount: number;
  /** The invite presented, if any. */
  invite: InviteFacts | null;
  /** Whether the caller already holds a valid session. */
  authenticated: boolean;
  now: number;
}

export type RegistrationDecision =
  | { allow: true; purpose: RegistrationPurpose }
  | { allow: false; reason: RegistrationRefusal };

export type RegistrationRefusal =
  | 'no_credential_offered'
  | 'invite_unknown'
  | 'invite_already_used'
  | 'invite_expired';

export function decideRegistration(request: RegistrationRequest): RegistrationDecision {
  // An authenticated session is the ordinary way to add a passkey once the operator is
  // already inside (§19).
  if (request.authenticated) return { allow: true, purpose: 'additional' };

  if (request.invite === null) return { allow: false, reason: 'no_credential_offered' };
  if (request.invite.usedAt !== null) return { allow: false, reason: 'invite_already_used' };
  if (request.invite.expiresAt <= request.now) return { allow: false, reason: 'invite_expired' };

  return { allow: true, purpose: request.invite.purpose };
}

export interface BootstrapState {
  complete: boolean;
  credentialCount: number;
  missing: number;
}

export function bootstrapState(credentialCount: number): BootstrapState {
  const missing = Math.max(0, REQUIRED_BOOTSTRAP_CREDENTIALS - credentialCount);
  return { complete: missing === 0, credentialCount, missing };
}

/** German explanation for a refusal, shown to the caller and logged (§2). */
export function describeRefusal(reason: RegistrationRefusal): string {
  switch (reason) {
    case 'no_credential_offered':
      return 'Registrierung ist gesperrt: dafür braucht es eine angemeldete Sitzung oder eine gültige Einladung.';
    case 'invite_unknown':
      return 'Diese Einladung ist unbekannt.';
    case 'invite_already_used':
      return 'Diese Einladung wurde bereits verwendet. Einladungen gelten genau einmal.';
    case 'invite_expired':
      return 'Diese Einladung ist abgelaufen. Auf dem Produktionshost eine neue erzeugen: vorschicht-invite';
  }
}

/** German banner text while the bootstrap is incomplete (§2). */
export function describeBootstrap(state: BootstrapState): string | null {
  if (state.complete) return null;
  if (state.credentialCount === 0) {
    return 'Noch kein Passkey hinterlegt. Einrichtung auf dem Produktionshost starten: vorschicht-invite';
  }
  return (
    `Erst ${state.credentialCount} von ${REQUIRED_BOOTSTRAP_CREDENTIALS} Passkeys hinterlegt — ` +
    'mit nur einem Gerät sperrst du dich bei Verlust selbst aus. Zweiten Passkey ergänzen.'
  );
}
