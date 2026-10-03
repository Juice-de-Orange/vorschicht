/**
 * The two decisions of `onboard.mjs` that can be tested without a session.
 *
 * `onboard.mjs` is an entry point: it connects, builds half a dozen services
 * and starts a model session at the strongest tier, so nothing in it runs under
 * `pnpm gate`. These two were wrong in exactly that blind spot, and they are
 * pure — so they live here, where a test can call them
 * (`audit-project.mjs` is the same arrangement for `run-audit.mjs`).
 */
import { join } from 'node:path';

/**
 * Where the session's transcript is archived (§6.2, A14).
 *
 * Until now this was `join(scratch, 'transcripts')` unconditionally, and the
 * `finally` block deletes `scratch` — while `onboard-remote.sh` sets
 * `VORSCHICHT_TRANSCRIPTS_ROOT`, mounts a directory there and afterwards looks
 * into it for the transcript to put on the backed-up volume. It would have
 * found nothing: the transcript of every onboarding went with the scratch
 * directory, and `agent_runs.transcript_path` kept pointing at it. A150 fixed
 * the same defect in `run-audit.mjs`; this is its twin.
 *
 * The order is `config.ts`'s: the explicit root, else `<data root>/transcripts`.
 * Without either there is no place that outlives the run, and the scratch
 * directory is the honest answer — `durable: false` lets the caller say so
 * instead of leaving a path in the database that reads as if it existed
 * (`check-idle-audit.mjs` does the same).
 *
 * @param {Record<string, string | undefined>} env
 * @param {string} scratch
 * @returns {{ root: string, durable: boolean }}
 */
export function transcriptsRootFor(env, scratch) {
  if (env.VORSCHICHT_TRANSCRIPTS_ROOT) {
    return { root: env.VORSCHICHT_TRANSCRIPTS_ROOT, durable: true };
  }
  if (env.VORSCHICHT_DATA_ROOT) {
    return { root: `${env.VORSCHICHT_DATA_ROOT}/transcripts`, durable: true };
  }
  return { root: join(scratch, 'transcripts'), durable: false };
}

/**
 * Who approves a proposal: `--actor`, else `VORSCHICHT_ACTOR`, else nobody.
 *
 * The fallback used to be the literal `'max'` — one person's name as the
 * recorded approver of every project anybody applies without the flag, in the
 * `audit_log` row §19 keeps forever. `OnboardingService.apply` says there is
 * "deliberately no default, so a project cannot be created without somebody
 * having been named"; a default one layer up undid that. Null means "not
 * named", and the caller refuses to apply.
 *
 * @param {string | null | undefined} flag
 * @param {Record<string, string | undefined>} env
 * @returns {string | null}
 */
export function actorFor(flag, env) {
  const named = (flag ?? '').trim() || (env.VORSCHICHT_ACTOR ?? '').trim();
  // `--actor --apply`: the next flag is not a name.
  if (!named || named.startsWith('--')) return null;
  return named;
}
