/**
 * Startup self-check (§6.1) — the daemon refuses work until these pass.
 *
 * The interesting check is `assertSubscriptionAuth`. §2's "no API key, ever" is
 * usually policed by grepping the repo, but a grep cannot see an API key that
 * arrives through a mounted settings file, an `apiKeyHelper`, or an inherited
 * environment. `claude auth status --json` reports the *effective* auth state,
 * which is the thing that actually decides whether the operator gets billed. Checking
 * that is strictly stronger than checking our own source.
 *
 * The CLI version check exists for the same reason in a different dimension:
 * watchtower runs nightly across every container on the production host (A34), so an
 * unpinned image could silently change the runner's behaviour between one
 * night and the next.
 */

export interface AuthStatus {
  loggedIn: boolean;
  authMethod: string;
  apiProvider: string;
  subscriptionType?: string | null;
}

export type CheckResult = { ok: true } | { ok: false; reason: string };

/** Auth methods that mean "subscription", i.e. no money can be spent. */
const SUBSCRIPTION_AUTH_METHODS = new Set(['oauth_token', 'claude.ai', 'oauth']);

export function parseAuthStatus(raw: string): AuthStatus | null {
  try {
    const parsed = JSON.parse(raw) as Partial<AuthStatus>;
    if (typeof parsed.loggedIn !== 'boolean') return null;
    if (typeof parsed.authMethod !== 'string') return null;
    if (typeof parsed.apiProvider !== 'string') return null;
    return {
      loggedIn: parsed.loggedIn,
      authMethod: parsed.authMethod,
      apiProvider: parsed.apiProvider,
      subscriptionType: parsed.subscriptionType ?? null,
    };
  } catch {
    return null;
  }
}

export function assertSubscriptionAuth(status: AuthStatus | null): CheckResult {
  if (status === null) {
    return { ok: false, reason: 'claude auth status lieferte keine auswertbare Antwort' };
  }
  if (!status.loggedIn) {
    return { ok: false, reason: 'Claude Code ist nicht angemeldet (Auth-Vorfall, §6.1)' };
  }
  if (status.apiProvider !== 'firstParty') {
    return {
      ok: false,
      reason:
        `apiProvider ist "${status.apiProvider}", erwartet "firstParty". ` +
        'Ein Drittanbieter- oder API-Key-Pfad ist durch §2 verboten.',
    };
  }
  if (!SUBSCRIPTION_AUTH_METHODS.has(status.authMethod)) {
    return {
      ok: false,
      reason:
        `authMethod ist "${status.authMethod}", erwartet Abo-Auth. ` +
        'Vorschicht darf niemals über einen API-Key laufen (§2).',
    };
  }
  return { ok: true };
}

/**
 * Compare a CLI version against the pinned one.
 *
 * A mismatch is a hard stop rather than a warning: §6.2 says the flag set is
 * verified against the pinned version, and A32 turns an undocumented flag into
 * a build-breaking contract. Running on an unverified CLI would quietly
 * invalidate both.
 */
export function assertPinnedCliVersion(actual: string, pinned: string): CheckResult {
  const normalise = (v: string) => v.trim().match(/\d+\.\d+\.\d+/)?.[0] ?? null;
  const a = normalise(actual);
  const p = normalise(pinned);
  if (a === null) return { ok: false, reason: `CLI-Version nicht lesbar: "${actual}"` };
  if (p === null) return { ok: false, reason: `Gepinnte Version unlesbar: "${pinned}"` };
  if (a !== p) {
    return {
      ok: false,
      reason:
        `Claude-CLI ist ${a}, gepinnt ist ${p}. Updates laufen ausschließlich als ` +
        'Radar-Task durch die Gates (A27) — nie automatisch.',
    };
  }
  return { ok: true };
}

/** Guards against `--bare`, which would disable OAuth *and* the §6.6 hooks. */
export function assertSimpleModeOff(env: NodeJS.ProcessEnv): CheckResult {
  if (env.CLAUDE_CODE_SIMPLE) {
    return {
      ok: false,
      reason:
        'CLAUDE_CODE_SIMPLE ist gesetzt (--bare). Das erzwingt API-Key-Auth (§2 verboten) ' +
        'und überspringt still die Containment-Hooks aus §6.6.',
    };
  }
  return { ok: true };
}
