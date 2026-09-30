import type { ClaimGranularity } from '@vorschicht/shared';
import type { Queryable } from '../sql.js';
import type { VerifiedProposal } from './verify.js';

/**
 * Reading back a proposal that a human has read, so §20's decision is one.
 *
 * §20 describes onboarding as two acts with a person between them: an agent
 * analyses the repository and proposes, the operator confirms or edits, the project
 * becomes active. `OnboardingService.apply` takes the verification as an
 * **object**, and there was no way to hand it a *stored* one — so
 * `infra/scripts/onboard.mjs` called `propose()` and `apply()` in the same
 * process. Letting the operator read first therefore meant a second run, i.e. a **second
 * model session**, free to produce a different proposal than the one he read.
 * §20's decision was decoration: the thing confirmed and the thing applied were
 * never provably the same.
 *
 * The whole payload was already there. `onboarding.proposed` carries
 * `gateConfig`, `deployConfig`, `defaultBranch`, `claimGranularity`, `ok`,
 * `errors`, `notes`, `deferred`, `commands` and `missingCommands` — everything
 * `apply` needs. Nobody read it back. §8.2's sixth domain, in the one flow
 * whose whole point is a human decision.
 *
 * Three rules here, and the first two are refusals:
 *
 *  1. **A proposal that was not `ok` is never applied.** `apply` refuses it too,
 *     and this is the earlier, friendlier refusal: it names the run rather than
 *     the errors of a document nobody asked to see again.
 *  2. **A row without a name is refused, not guessed.** Rows written before the
 *     name travelled do not carry it, and inventing one would mean a project
 *     created under a name that appears in no proposal (the divergence this
 *     module exists to close).
 *  3. **The newest matching row wins, and there is only ever one.** The run id
 *     is minted per session; two rows with the same one would mean the same
 *     session was recorded twice, and the later is then the corrected one.
 */
export interface StoredProposal {
  runId: string;
  slug: string;
  name: string;
  rootPath: string;
  readOnly: boolean;
  verification: VerifiedProposal;
}

export class OnboardingProposals {
  constructor(private readonly sql: Queryable) {}

  /**
   * The proposal a given onboarding session produced, or null.
   *
   * A targeted query rather than `recentOfKind(n)` and a filter: A118 is the
   * story of a job that looked for its own last row in a global window and lost
   * it as soon as the studio got busy. One onboarding proposal can sit behind
   * thousands of unrelated rows.
   */
  async byRun(runId: string): Promise<StoredProposal | null> {
    const rows = await this.sql<{ payload: Record<string, unknown> }[]>`
      SELECT payload FROM event_log
      WHERE kind = 'onboarding.proposed' AND payload ->> 'runId' = ${runId}
      ORDER BY id DESC LIMIT 1
    `;
    const payload = rows[0]?.payload;
    if (!payload) return null;
    return fromPayload(runId, payload);
  }
}

/** The refusal a caller can show, or the proposal. Exported for its test. */
export function fromPayload(
  runId: string,
  payload: Record<string, unknown>,
): StoredProposal | null {
  const slug = typeof payload.slug === 'string' ? payload.slug : null;
  const name = typeof payload.name === 'string' ? payload.name : null;
  const rootPath = typeof payload.rootPath === 'string' ? payload.rootPath : null;
  if (slug === null || rootPath === null) return null;
  // Rule 2: refused rather than defaulted to the slug. A project created under
  // a name that appears in no proposal is the divergence this closes.
  if (name === null) return null;

  const config = (payload.gateConfig ?? null) as VerifiedProposal['config'];
  const verification: VerifiedProposal = {
    ok: payload.ok === true,
    errors: strings(payload.errors),
    notes: strings(payload.notes),
    config,
    defaultBranch: typeof payload.defaultBranch === 'string' ? payload.defaultBranch : null,
    claimGranularity: (payload.claimGranularity ?? 'file') as ClaimGranularity,
    deployConfig: (payload.deployConfig ?? { method: 'none' }) as Record<string, unknown>,
    commands: (payload.commands ?? []) as VerifiedProposal['commands'],
    deferred: (payload.deferred ?? []) as VerifiedProposal['deferred'],
    missingCommands: (payload.missingCommands ?? []) as VerifiedProposal['missingCommands'],
  };

  return {
    runId,
    slug,
    name,
    rootPath,
    readOnly: payload.readOnly === true,
    verification,
  };
}

function strings(raw: unknown): string[] {
  return Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === 'string')
    : [];
}
