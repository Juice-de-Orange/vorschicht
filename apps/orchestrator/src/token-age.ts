/**
 * OAuth token lifecycle bookkeeping (A28, §6.1).
 *
 * `claude auth status` reports whether we are logged in — and nothing about
 * when the token expires. Verified: the response carries `loggedIn`,
 * `authMethod` and `apiProvider`, no date. So the expiry cannot be read; it has
 * to be *remembered*, from the moment the token was installed.
 *
 * That matters because a dead token is not a small inconvenience for an
 * unattended system. §6.1 makes an auth failure an incident rather than a task
 * failure, which contains the damage — but containment is not the same as
 * warning in time, and A28 asks for both.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/** Setup tokens are documented as roughly one year (§6.1, A5). */
export const TOKEN_LIFETIME_MS = 365 * 24 * 60 * 60_000;

/** A28: warn at 30 days remaining, escalate as P0 at 7. */
export const TOKEN_WARN_DAYS = 30;
export const TOKEN_CRITICAL_DAYS = 7;

export type TokenUrgency = 'ok' | 'warn' | 'critical' | 'unknown';

export interface TokenAge {
  urgency: TokenUrgency;
  installedAt: number | null;
  daysRemaining: number | null;
  /** German, for the notification (§2). */
  message: string | null;
}

/**
 * Record when the token was installed.
 *
 * Called by the install path, once. Deliberately not "on first sight": a token
 * that has already been in use for months would otherwise be recorded as new,
 * and the warning would arrive a year late.
 */
export function recordTokenInstall(path: string, at: number = Date.now()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ installedAt: at }, null, 2));
}

export function readTokenInstall(path: string): number | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { installedAt?: unknown };
    return typeof parsed.installedAt === 'number' ? parsed.installedAt : null;
  } catch {
    return null;
  }
}

/**
 * How much life the token has left, as far as anyone can tell.
 *
 * `unknown` is a real answer and is treated as one: it means nobody recorded an
 * install date, so the assumed lifetime cannot be applied. Reporting `ok` there
 * would be a guess dressed as a fact.
 */
export function assessTokenAge(installedAt: number | null, now: number = Date.now()): TokenAge {
  if (installedAt === null) {
    return {
      urgency: 'unknown',
      installedAt: null,
      daysRemaining: null,
      message:
        'Für den Claude-Token ist kein Installationsdatum hinterlegt — die Restlaufzeit ' +
        'lässt sich nicht abschätzen. Bei der nächsten Erneuerung wird sie erfasst.',
    };
  }

  const remainingMs = installedAt + TOKEN_LIFETIME_MS - now;
  const daysRemaining = Math.floor(remainingMs / (24 * 60 * 60_000));

  if (daysRemaining <= 0) {
    return {
      urgency: 'critical',
      installedAt,
      daysRemaining,
      message:
        'Der Claude-Token dürfte abgelaufen sein. Auf einer Maschine mit Browser ' +
        '`claude setup-token` ausführen und den neuen Token hinterlegen.',
    };
  }
  if (daysRemaining <= TOKEN_CRITICAL_DAYS) {
    return {
      urgency: 'critical',
      installedAt,
      daysRemaining,
      message:
        `Der Claude-Token läuft in ${daysRemaining} Tag(en) ab. Danach steht das Studio, ` +
        'bis ein neuer Token da ist: `claude setup-token`.',
    };
  }
  if (daysRemaining <= TOKEN_WARN_DAYS) {
    return {
      urgency: 'warn',
      installedAt,
      daysRemaining,
      message: `Der Claude-Token läuft in ${daysRemaining} Tagen ab — Erneuerung einplanen.`,
    };
  }
  return { urgency: 'ok', installedAt, daysRemaining, message: null };
}
