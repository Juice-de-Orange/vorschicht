/**
 * §6.0's billing watch and A27's CLI watch — the detection half, pure.
 *
 * §6.0 calls an Anthropic billing change "the project's **#1 external risk**",
 * and the reason is specific rather than dramatic: Anthropic announced
 * (2026-05-14) and then paused (2026-06-15) moving `claude -p` and Agent-SDK
 * usage off subscription limits onto a separate metered credit, and §2's hard
 * rule is that this studio has no API key and never spends money. If that plan
 * returns and nobody notices, the studio does not degrade — it either stops or
 * starts consuming something the operator never agreed to buy.
 *
 * §22's exit gate for this says "a **seeded** 'billing change' fixture produces
 * a P0 inbox item; a **seeded** CLI release lands as a normal radar task", so
 * the detection is deliberately a pure function over an input string and the
 * scan feeds it either a real fetch or a fixture (`feeds.ts`). Everything
 * decidable is decided here, where a test can drive it without a network and
 * without a model turn.
 *
 * Six decisions.
 *
 *  1. **Two terms in one sentence, never one term anywhere.** A page that says
 *     "Claude Code supports headless mode via `claude -p`" is documentation; a
 *     page that says "we updated our pricing" is a pricing page. Neither is the
 *     event. The event is a *subject* term (programmatic use of the model) and a
 *     *change* term (how it is paid for) in the same sentence, which is what
 *     Anthropic's own May announcement read like. One term alone would fire on
 *     both of the harmless pages above, and a P0 that fires on documentation is
 *     a P0 that gets ignored — the rule this repository has written down four
 *     times (A67.6, A86.5, A102, A105.3).
 *
 *  2. **The signature is a hash of the normalised sentence, and a reworded page
 *     therefore raises a second P0 — deliberately.** This reverses what the
 *     first draft of this file said, and it was the test that settled it: the
 *     draft keyed the memory on the matched *term pair* and claimed that made it
 *     stable across rewordings. It does not. `detectBillingChange` takes the
 *     first matching term from each list, so the same announcement written two
 *     ways matched `claude -p|will be billed` once and `claude -p|usage credits`
 *     the next time; widening it to the whole matched *set* does not help either,
 *     because a rewording changes the set. Stability across rewording is not
 *     obtainable from term matching at all, and a signature that claimed it would
 *     have been a comment nothing could check.
 *
 *     So the memory keys on the sentence, and the remaining asymmetry is chosen
 *     rather than tolerated: an edited page costs one extra P0, and a *changed*
 *     announcement is never missed. For §6.0's #1 external risk that is the
 *     right way round — A105.3's flood rule governs a signal that repeats
 *     unchanged, which this one does not, since the same page yields the same
 *     hash every six hours forever.
 *
 *  3. **The subject list includes the wording of the paused plan itself.**
 *     "usage credits", "extra usage", "metered", "separate credit" are the terms
 *     Anthropic actually used in May and June 2026, quoted in §6.0. A watch for
 *     a specific announced change should recognise that announcement's own
 *     vocabulary first and general billing language second.
 *
 *  4. **A version is extracted, never assumed.** `extractCliVersion` reads JSON
 *     if it is handed JSON and otherwise takes the first `x.y.z` in the text, so
 *     the same function serves a registry document, a `latest` endpoint and a
 *     changelog heading. The CLI is installed from `claude.ai/install.sh`
 *     (`infra/docker/Dockerfile.orchestrator`), not from a registry whose shape
 *     this project could pin, so the channel is configuration and its format is
 *     whatever it turns out to be.
 *
 *  5. **A downgrade or an equal version is not a release.** The comparison is
 *     `isUpgrade`, which also refuses a prerelease target — a channel that
 *     briefly serves an rc must not create a task proposing the studio pin one
 *     (A27: the pin is the thing that keeps the runner deterministic).
 *
 *  6. **Nothing here raises anything.** These functions return findings; the
 *     scan decides what becomes a card and what becomes a task. That is the
 *     separation `runner.ts` keeps (A53.1) and it is why the whole detection
 *     surface is testable with three string literals.
 */
import { createHash } from 'node:crypto';
import { isUpgrade } from './semver.js';

/** Terms naming *programmatic* model use — the thing whose price may change. */
export const BILLING_SUBJECT_TERMS: readonly string[] = [
  'claude -p',
  'headless',
  'agent sdk',
  'claude code sdk',
  'programmatic usage',
  'programmatic use',
  'programmatic access',
  'non-interactive',
  'noninteractive',
];

/**
 * Terms naming a change in how it is paid for.
 *
 * The first four are the paused plan's own vocabulary (decision 3); the rest are
 * the general ways such a change gets announced.
 */
export const BILLING_CHANGE_TERMS: readonly string[] = [
  'usage credits',
  'extra usage',
  'metered',
  'separate credit',
  'billed separately',
  'billing change',
  'pricing change',
  'no longer count',
  'no longer included',
  'no longer draw',
  'will be billed',
  'pay-as-you-go',
  'purchase credits',
  'separate from your subscription',
  'subscription limits',
  'rate limits will change',
];

/** One sentence that satisfied decision 1, with what made it match. */
export interface BillingSignal {
  /** The subject term that matched, lowercased as listed above. */
  subject: string;
  /** The change term that matched, lowercased as listed above. */
  change: string;
  /** The sentence, clipped. Quoted in the card so the operator can judge it himself. */
  sentence: string;
  /** Where the text came from — a URL, or a fixture's name. */
  origin: string;
  /** Decision 2: a hash of the normalised sentence. Same page, same signature. */
  signature: string;
}

/**
 * Decision 2's key: lowercase, letters and digits only, whitespace collapsed.
 *
 * Deliberately more than a trim. An unchanged page reached through a different
 * renderer differs in markup, casing and spacing and says exactly the same
 * thing; a normalisation that stopped at `trim()` would call that an edit and
 * raise a second P0 for it.
 */
export function billingSignature(sentence: string): string {
  const normalised = sentence
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return createHash('sha256').update(normalised).digest('hex').slice(0, 16);
}

/** How much of a matched sentence the card is allowed to quote. */
const MAX_SENTENCE = 400;

/**
 * Split on sentence ends, keeping it deliberately crude.
 *
 * A page is HTML or Markdown as often as prose, so `. ` alone would treat a
 * whole bullet list as one sentence and make decision 1 meaningless — two terms
 * anywhere in a page would then match. Newlines and list markers end a unit
 * here, which is stricter than grammar and is the direction that avoids the
 * false positive.
 */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?;:])\s+|\n+|<\/(?:p|li|h[1-6]|div)>/i)
    .map((part) =>
      part
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((part) => part.length > 0);
}

/**
 * Every sentence in `text` that names both a subject and a change (decision 1).
 *
 * Deduplicated by signature within one text: a page repeating the same claim in
 * a heading and a paragraph is one finding, not two.
 */
export function detectBillingChange(text: string, origin: string): BillingSignal[] {
  const found = new Map<string, BillingSignal>();

  for (const raw of sentences(text)) {
    const haystack = raw.toLowerCase();
    const subject = BILLING_SUBJECT_TERMS.find((term) => haystack.includes(term));
    if (subject === undefined) continue;
    const change = BILLING_CHANGE_TERMS.find((term) => haystack.includes(term));
    if (change === undefined) continue;

    const signature = billingSignature(raw);
    if (found.has(signature)) continue;
    found.set(signature, {
      subject,
      change,
      sentence: raw.length > MAX_SENTENCE ? `${raw.slice(0, MAX_SENTENCE)}…` : raw,
      origin,
      signature,
    });
  }

  return [...found.values()];
}

/**
 * The version a release channel is advertising, or null (decision 4).
 *
 * JSON first, because a machine-readable channel is the one worth reading
 * precisely: `latest`, `version` and `tag_name` cover a `dist-tags`-shaped
 * document, a bare `{"latest": …}` and a GitHub release. Anything else falls
 * back to the first `x.y.z` in the text, which is what a changelog or an
 * `install.sh` answers with.
 */
export function extractCliVersion(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const document = JSON.parse(trimmed) as Record<string, unknown>;
      const direct = firstVersionField(document);
      if (direct) return direct;
      const tags = document['dist-tags'];
      if (tags && typeof tags === 'object') {
        const tagged = firstVersionField(tags as Record<string, unknown>);
        if (tagged) return tagged;
      }
    } catch {
      // Not JSON after all — fall through to the text scan rather than failing.
      // A channel that answers HTML with a leading brace is not worth an error.
    }
  }
  const match = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/.exec(trimmed);
  return match?.[1] ?? null;
}

function firstVersionField(document: Record<string, unknown>): string | null {
  for (const field of ['latest', 'version', 'tag_name'] as const) {
    const value = document[field];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value.trim().replace(/^v/, '');
    }
  }
  return null;
}

/** A27: the pin is behind the channel by this much. */
export interface CliRelease {
  pinned: string;
  latest: string;
}

/**
 * Null unless the channel is genuinely ahead of the pin (decision 5).
 *
 * A27 makes a CLI update "a radar task through the normal gates" and never an
 * automatic bump, so all this decides is whether there is something to file.
 */
export function detectCliRelease(pinned: string, channel: string | null): CliRelease | null {
  if (channel === null) return null;
  if (!isUpgrade(pinned, channel)) return null;
  return { pinned, latest: channel };
}
