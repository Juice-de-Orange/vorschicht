/**
 * The escalation inbox and its decision memory (§15) — the pure half.
 *
 * §15 describes the "studio owner" experience: every question reaches the operator fully
 * prepared, and every answer he gives becomes policy. "Decisions land in the
 * `decisions` log and become **policy memory**: before escalating, agents must
 * search prior decisions — the same question is never asked twice; matching
 * precedent is applied and referenced instead."
 *
 * That sentence contains the one genuinely dangerous mechanism in this phase. An
 * auto-answer applies a decision the operator made *about something else* to a question
 * he never saw, and then the agent acts on it — so everything here leans in the
 * direction of asking twice rather than answering wrongly. Four rules follow
 * from that, and each is enforced below rather than in a comment:
 *
 *   1. **Only an exact question matches.** `precedentKey` normalises away
 *      formatting and nothing else. Near matches are surfaced as *context* on
 *      the inbox card (`isRelated`) and can never answer anything.
 *   2. **An empty key matches nothing.** A normalisation that collapsed a
 *      question to the empty string would otherwise match every decision ever
 *      made, which is the worst possible failure of this module.
 *   3. **Scope is narrow by default.** A decision raised inside a project
 *      applies to that project; only a decision raised without one is global.
 *      Widening a precedent across projects is the operator's call and deliberately has
 *      no code path yet.
 *   4. **Not every escalation becomes policy.** `POLICY_MEMORY_SOURCES` is the
 *      closed list of what may be reused, and it is short on purpose — see the
 *      note there for the concrete accident it prevents.
 */
import { z } from 'zod';
import { escalationOptionInput } from './mcp-tools.js';

/**
 * Where an inbox item came from (§15: "Sources of escalations").
 *
 * Transcribed from §15 in full rather than grown one producer at a time, so the
 * dashboard's filter and the weekly report count against the specified set
 * rather than against whatever happens to be wired. Which of them actually have
 * a producer today is stated here and asserted nowhere else, because it changes
 * every phase:
 *
 *   * `agent_question` — `escalate.ask` (§6.4). Wired.
 *   * `task_red` — §9's second failure, with the Debugger's diagnosis. Wired.
 *   * `gate_proposal` — §20's onboarding proposal. Wired: the card and its
 *     delivery are `onboarding/report.ts` (`raiseProposal`), called by
 *     `infra/scripts/onboard.mjs`. That script is `.mjs` and outside `pnpm
 *     gate`, so it holds one call and nothing else worth checking.
 *   * `source_proposal` — §14's trust-level proposal. Phase 6.
 *   * `dependency_major` — A10's major/breaking update. Wired: the radar's
 *     dependency scan (`scans/radar/scan.ts`).
 *   * `dependency_advisory` — A10's third branch, the security advisory, always
 *     P0. Wired by the same scan, and **not** folded into `dependency_major`
 *     for `migration_stop`'s reason one line down: §16 counts by source, so one
 *     label for both would answer "how many major updates are we deferring"
 *     with a number that silently includes CVEs, and the two have different
 *     urgencies by A10's own text.
 *   * `rollback` — §12's failed health check. Wired.
 *   * `migration_stop` — A24's refusal to roll out a migration the previous
 *     release cannot read. Wired. **Not folded into `rollback`**, although both
 *     come from §12 and neither is named separately in §15's list: a rollback
 *     is a deploy that happened and was undone, and a migration stop is a deploy
 *     that never started. This list is what the dashboard filters on and what
 *     §16's weekly report counts, so one label for both would answer "how often
 *     did we roll back" with a number that includes rollouts which never
 *     touched production. The cost of the extra entry is one line; the cost of
 *     the shared one is a metric that quietly means something else.
 *   * `deploy_failed` — §12's third ending, and the same argument once more:
 *     a rollout that broke and could **not** be rolled back. Wired. Distinct
 *     from `rollback` for the reason above (nothing was put back) and from
 *     `migration_stop` (this one did touch production, or does not know
 *     whether it did). It is the branch where the studio has no automatic
 *     remedy left, so it is the branch that most needs a human — and it had
 *     no card at all until A93.
 *   * `self_deploy` — A12's approval, every time. Wired: `DeployService`
 *     raises it before the first artifact exists, and since A93 only the
 *     option that *means* "roll out" releases the deploy — `answered` alone
 *     used to, which made the option written to say no say yes.
 *   * `budget_anomaly` — §7.1's untrustworthy reading (`UsageMeter.onAnomaly`). Wired.
 *   * `billing_change` — §6.0's billing watch, always P0. Phase 6.
 *   * `transcript_leak` — §6.6's nightly scan, always P0. Phase 6.
 *   * `audit_finding` — §8.2's `gate_invalid`, `assumption_expired` and second
 *     dismissal, through `AuditService`. Wired.
 */
export const ESCALATION_SOURCES = [
  'agent_question',
  'task_red',
  'gate_proposal',
  'source_proposal',
  'dependency_major',
  'dependency_advisory',
  'rollback',
  'migration_stop',
  'deploy_failed',
  'self_deploy',
  'budget_anomaly',
  'billing_change',
  'transcript_leak',
  'audit_finding',
  // §22 Phase 7 G7: „the operator sign-off on design, German UI copy & overview via an
  // inbox item". Eine eigene Quelle und **nicht** `agent_question`, obwohl das
  // die naheliegende Wahl wäre — `agent_question` ist der einzige Eintrag in
  // `POLICY_MEMORY_SOURCES`, und eine Abnahme, die beim zweiten Mal aus dem
  // Gedächtnis beantwortet wird, ist keine. Der Betreiber nähme die Oberfläche einmal ab,
  // und die Abnahme in Phase 9 verschwände lautlos in einer Präzedenz über ein
  // Design, das sich seither geändert hat. Dieselbe Klasse, die A77.2 für §9s
  // roten Pfad namentlich ausgeschlossen hat.
  'design_signoff',
] as const;
export type EscalationSource = (typeof ESCALATION_SOURCES)[number];

/** German (§2) — the inbox card says who is asking, in words the operator reads. */
export const ESCALATION_SOURCE_LABELS: Record<EscalationSource, string> = {
  agent_question: 'Frage aus einer Sitzung',
  task_red: 'Zweiter Fehlschlag',
  gate_proposal: 'Onboarding-Vorschlag',
  source_proposal: 'Quellenvorschlag',
  dependency_major: 'Größeres Abhängigkeits-Update',
  dependency_advisory: 'Sicherheitshinweis zu einer Abhängigkeit',
  rollback: 'Rollback',
  migration_stop: 'Migration ohne Rückweg',
  deploy_failed: 'Rollout gescheitert, kein Rückweg',
  self_deploy: 'Freigabe für Selbst-Deploy',
  budget_anomaly: 'Budget-Auffälligkeit',
  billing_change: 'Änderung an der Abrechnung',
  transcript_leak: 'Fund im Transkript',
  audit_finding: 'Fund der Betriebsprüfung',
  design_signoff: 'Abnahme von Gestaltung und Sprache',
};

/**
 * Which answers become reusable policy (§15).
 *
 * Deliberately one entry. §15's policy memory is about *questions of policy* —
 * "dürfen wir diese Bibliothek einsetzen", "welcher Zweig ist der
 * Integrationszweig" — and those are the questions agents ask. The exclusion
 * that matters is `task_red`: its question names a specific task, and if such an
 * answer were reusable, a task that failed twice, was aborted by the operator, and later
 * failed twice again under the same title would be **aborted automatically, from
 * memory, without an inbox item**. That is not policy memory applying a
 * precedent; it is a machine deciding to throw work away because it once had
 * permission to throw away work that looked like it.
 *
 * Three sources gained producers with Phase 4 step 5 and **none of them was
 * added here**, each for its own reason rather than by omission:
 *
 *   * `audit_finding` — the sharpest case after `task_red`. One of its options
 *     is "Fund verwerfen — Haken wieder setzen", and a reusable answer to
 *     "Gate P1.G1 wurde entwertet — wie weiter?" would let a *later* audit
 *     re-tick a gate **from memory**, with nobody asked. §8.2 gives the un-tick
 *     to the auditor and the reversal to the operator; policy memory would hand the
 *     reversal to whoever asked a similar-sounding question first.
 *   * `gate_proposal` — the question names a repository and the answer
 *     configures it. Two projects that happen to produce the same sentence do
 *     not have the same gates.
 *   * `budget_anomaly` — "so lassen" answered once would silence the next
 *     divergence, which is the one signal §7.1 keeps for a meter it cannot
 *     trust.
 *
 * The remaining sources are excluded for the plainer reason that they have no
 * producer yet (see `ESCALATION_SOURCES`), and a source whose answers are
 * reusable before anything can raise it is untestable in both directions. Each
 * one is a one-line addition here, with its own test, at the moment it lands.
 */
export const POLICY_MEMORY_SOURCES: readonly EscalationSource[] = ['agent_question'];

export function isPolicyMemorySource(source: string): source is EscalationSource {
  return (POLICY_MEMORY_SOURCES as readonly string[]).includes(source);
}

/** Open until the operator answers. §15 has no timeout: claims are held indefinitely. */
export const ESCALATION_STATES = ['open', 'answered'] as const;
export type EscalationState = (typeof ESCALATION_STATES)[number];

/**
 * A question is one sentence (§15), and the cap is a boundary constraint.
 *
 * Two reasons, one of them structural: `precedent_key` is the normalised
 * question and it is indexed, and a btree entry has a hard size limit — an
 * unbounded question would turn a well-formed escalation into a database error
 * at the moment it is raised. The other is that the party supplying this string
 * is a language model, and §15's format is only worth specifying if it is
 * enforced where it can be.
 */
export const MAX_ESCALATION_QUESTION_LENGTH = 500;

/** Enough for §15's "3–5 sentences", short enough that a card stays readable. */
export const MAX_ESCALATION_CONTEXT_LENGTH = 4_000;

/** the operator's own words, when he answers in free text rather than picking an option. */
export const MAX_DECISION_FREE_TEXT_LENGTH = 8_000;

// --- the precedent key -------------------------------------------------------

/**
 * The normalised form two questions must share to count as the same question.
 *
 * Every rule below is meaning-preserving, and that is the whole specification:
 * a normalisation that merges two questions the operator would answer differently is a
 * defect in this function, not a tuning parameter. So it removes formatting and
 * nothing else — no stemming, no stop words, no synonym folding, no number
 * rounding. "Soll ich auf Version 3 gehen?" and "Soll ich auf Version 4 gehen?"
 * are different questions and stay different keys.
 *
 * Returns the empty string when nothing survives; callers must treat that as
 * "no precedent is possible" rather than as a key (`hasPrecedentKey`).
 */
export function precedentKey(question: string): string {
  return (
    question
      .normalize('NFC')
      .toLowerCase()
      // Markdown emphasis and code ticks are formatting: `--filter` and --filter
      // are the same question written by two agents with different habits.
      .replaceAll(/[*_`]/g, '')
      // Every quote mark German and English writers reach for, plus the ASCII pair.
      .replaceAll(/[„“”‚‘’«»"']/g, '')
      // Any whitespace run, including the newlines a wrapped prompt introduces.
      .replaceAll(/\s+/g, ' ')
      .trim()
      // Terminal punctuation only. Interior punctuation can carry meaning.
      .replace(/[?!.:;,\s]+$/u, '')
      .trim()
  );
}

/** Is this key usable for a lookup? An empty key would match everything. */
export function hasPrecedentKey(key: string): boolean {
  return key.length > 0;
}

// --- near misses, which inform and never decide ------------------------------

/**
 * How alike two questions must be before the card mentions the earlier one.
 *
 * This threshold governs *display*, never an answer, so it is tuned for
 * usefulness rather than for safety: a related decision that turns out to be
 * irrelevant costs the operator one line of reading, and one that would have been useful
 * and stayed hidden costs him a decision he already made.
 */
export const RELATED_DECISION_THRESHOLD = 0.6;

/** How many earlier decisions a card carries. More is a wall, not a help. */
export const MAX_RELATED_DECISIONS = 3;

/**
 * Token overlap of two questions, 0 (nothing in common) to 1 (same tokens).
 *
 * Jaccard over the word sets of the normalised forms. Order-insensitive on
 * purpose: "Darf Vorschicht auf dev schreiben" and "Auf dev schreiben — darf
 * Vorschicht das" are the same question asked twice, and a sequence measure
 * would score them apart.
 */
export function questionSimilarity(a: string, b: string): number {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / (left.size + right.size - shared);
}

/** Alike enough to be worth showing, and not the same question (that is a precedent). */
export function isRelated(a: string, b: string, threshold = RELATED_DECISION_THRESHOLD): boolean {
  const keyA = precedentKey(a);
  const keyB = precedentKey(b);
  if (!hasPrecedentKey(keyA) || !hasPrecedentKey(keyB)) return false;
  if (keyA === keyB) return false;
  return questionSimilarity(keyA, keyB) >= threshold;
}

function tokens(question: string): Set<string> {
  return new Set(precedentKey(question).split(' ').filter(Boolean));
}

// --- contracts ---------------------------------------------------------------

/**
 * What raising an inbox item requires (§15).
 *
 * The option rules are `escalationOptionInput`'s and the "exactly one
 * recommendation" refinement is repeated here rather than shared with
 * `escalateAskInput`: that schema is the *agent's* tool input and this one is
 * the service's, and they will drift — an orchestrator-raised item (§9's second
 * failure) has no agent behind it and a `runId` that may be absent. What must
 * not drift is §15's format, and the test that pins it asserts both schemas
 * refuse the same malformed option set.
 */
export const raiseEscalationInput = z
  .object({
    source: z.enum(ESCALATION_SOURCES),
    question: z.string().min(1).max(MAX_ESCALATION_QUESTION_LENGTH),
    context: z.string().min(1).max(MAX_ESCALATION_CONTEXT_LENGTH),
    urgency: z.enum(['P0', 'P1', 'P2', 'P3']),
    options: z.array(escalationOptionInput).min(2).max(4),
    projectId: z.string().uuid().nullish(),
    taskId: z.string().uuid().nullish(),
    /** The `agent_runs` row to resume from (§6.4). Null for anything not a session. */
    runId: z.string().uuid().nullish(),
    /** Role id, or `orchestrator` where no session asked. */
    raisedBy: z.string().min(1),
  })
  .refine((value) => value.options.filter((o) => o.recommended).length === 1, {
    message:
      'Genau eine Option muss als Empfehlung markiert sein (§15) — ohne Empfehlung ' +
      'ist es eine Frage, mit mehreren ist es keine.',
    path: ['options'],
  });

export type RaiseEscalationInput = z.infer<typeof raiseEscalationInput>;

/**
 * the operator's answer (§15).
 *
 * The free-text field is "always available", which is why this is not simply an
 * option index: he may pick an option, write his own instruction, or do both —
 * a chosen option with a qualifying sentence beside it is the common case and
 * losing the sentence would lose the decision. What he may not do is answer with
 * neither, and that is the refinement.
 */
/**
 * The two fields an answer carries, without the actor.
 *
 * Split out so the browser's submission schema (`answerSubmission`, in
 * `./inbox.js`) is built from the same object and the same refinement as the
 * service's input rather than restating them. The actor is deliberately not
 * here: §19 takes it from the session and overwrites whatever the body said, so
 * a schema that let a browser send one would be describing a field that is
 * always discarded.
 */
export const answerFields = {
  /** Index into the escalation's options, or null for a free-text-only answer. */
  optionIndex: z.number().int().min(0).nullish(),
  freeText: z.string().max(MAX_DECISION_FREE_TEXT_LENGTH).nullish(),
};

/** Does this hold a decision at all? Both empty is not an answer. */
export function hasAnswerDecision(value: {
  optionIndex?: number | null | undefined;
  freeText?: string | null | undefined;
}): boolean {
  return (
    (value.optionIndex !== null && value.optionIndex !== undefined) ||
    (value.freeText ?? '').trim().length > 0
  );
}

/** German (§2), and written once so the page and the service quote one sentence. */
export const ANSWER_WITHOUT_DECISION_MESSAGE =
  'Eine Entscheidung braucht entweder eine gewählte Option oder eine Antwort ' +
  'im Freitext — beides leer ist keine Antwort.';

export const answerEscalationInput = z
  .object({
    ...answerFields,
    /** Who decided. `max`, or `dashboard:<credentialId>` from an authenticated session. */
    actor: z.string().min(1),
  })
  .refine(hasAnswerDecision, {
    message: ANSWER_WITHOUT_DECISION_MESSAGE,
    path: ['optionIndex'],
  });

export type AnswerEscalationInput = z.infer<typeof answerEscalationInput>;

// --- rendering ---------------------------------------------------------------

/** What a decision says, in one line, for a timeline or a prompt. */
export interface DecisionSummaryInput {
  number: number;
  chosenTitle: string | null;
  freeText: string | null;
}

/**
 * One line naming what was decided, in German (§2).
 *
 * Used in the task timeline, in the "blockiert durch Entscheidung #X" copy, and
 * inside the English briefing an agent receives — the operator's words travel verbatim in
 * all three, because a paraphrase of a decision is a second wording of it that
 * nothing keeps in step (the reasoning `findingsBriefing` already follows).
 */
export function decisionSummary(decision: DecisionSummaryInput): string {
  const parts: string[] = [`Entscheidung #${decision.number}`];
  if (decision.chosenTitle) parts.push(`: ${decision.chosenTitle}`);
  const free = decision.freeText?.trim();
  if (free) parts.push(decision.chosenTitle ? ` — „${free}“` : `: „${free}“`);
  return parts.join('');
}

// --- §6.4's round trip -------------------------------------------------------

/** What the parked session is told when the operator has answered (§6.4). */
export interface DecisionMessageInput {
  number: number;
  /** The question as the session asked it. German, as the agent wrote it. */
  question: string;
  /** The option the operator picked, in full — null when he answered in free text only. */
  chosen: { index: number; title: string; pros: string[]; cons: string[] } | null;
  /** the operator's own words. Verbatim, German, never paraphrased. */
  freeText: string | null;
  decidedBy: string;
  /** ISO 8601. */
  decidedAt: string;
}

/**
 * The next message of a resumed session — §6.4's "decision injected".
 *
 * English frame, German content, and the split is deliberate rather than
 * untidy. §2 has agents work internally in English, so the instructions around
 * the answer are English; the answer itself is the operator's and travels **verbatim**,
 * for the reason `findingsBriefing` already states about gate output — a
 * translated decision is a second wording of it that nothing keeps in step, and
 * this one is about to be acted on.
 *
 * Three instructions, each closing a way the continuation could go wrong:
 *
 *   1. **Act on it, do not re-litigate it.** A session handed a decision and no
 *      instruction can reasonably read it as an opinion to weigh.
 *   2. **Do not ask again.** Without this the obvious failure is a session that
 *      escalates the same question a second time, which §15's policy memory
 *      would then answer from the precedent just created — a loop that looks
 *      like the feature working.
 *   3. **Say so rather than deciding for yourself** when the answer does not
 *      cover what was asked. §1 principle 6 forbids guessing on exactly the
 *      class of question that got escalated in the first place, and the honest
 *      escape is a second, *different* question — never a silent choice.
 */
export function decisionMessage(input: DecisionMessageInput): string {
  const lines: string[] = [
    `The operator has answered the question you raised. It is inbox item #${input.number}, ` +
      `decided by ${input.decidedBy} at ${input.decidedAt}.`,
    '',
    `Your question was: ${input.question}`,
    '',
  ];

  if (input.chosen) {
    lines.push(`He chose option ${input.chosen.index + 1}: ${input.chosen.title}`);
    for (const pro of input.chosen.pros) lines.push(`  + ${pro}`);
    for (const con of input.chosen.cons) lines.push(`  - ${con}`);
  } else {
    lines.push('He did not pick one of your options and answered in his own words instead.');
  }

  const free = input.freeText?.trim();
  if (free) {
    lines.push('', 'In his own words (German, verbatim — this is the decision):', free);
  }

  lines.push(
    '',
    'Proceed on that basis and continue exactly where you stopped. Do not re-open the',
    'decision and do not raise the same question again. If the answer does not cover',
    'what you actually needed, say so in your result and stop — do not decide it for',
    'yourself. When the work is done, end with the structured result your role',
    'requires.',
  );
  return lines.join('\n');
}
