/**
 * The escalation inbox and the decision log over HTTP (§15, §17.5).
 *
 * `EscalationService` already owns every rule that matters here — §15's card
 * format, the precedent scope, the "answered exactly once" guarantee. Nothing in
 * this module re-decides any of them. What it adds is the translation a
 * transport needs, and that translation is the whole content of the file:
 *
 *  1. **A refusal is a value, not an exception.** `answer()` reports both "this
 *     is already decided" and "that option does not exist" by throwing the same
 *     `EscalationError`, which is right for a service call and useless to a
 *     route: the two are 409 and 422. Matching on the message text would break
 *     the first time somebody improved the wording, so the error carries a
 *     `kind` and this layer switches on it. It used to *guess*, by re-reading
 *     the row afterwards — and that guess is what let a genuine concurrent
 *     answer through, because the database refuses it with a `PostgresError`
 *     rather than an `EscalationError`. The state is still read before the call,
 *     because a caller whose item is already decided should not be told about
 *     the shape of their body. The range rule is never duplicated; the service
 *     stays its only home (§15).
 *
 *  2. **The actor is the session, never the body.** §19's trail exists to say
 *     *who* decided, and a decision is the one thing in this system that resumes
 *     a parked session on the operator's authority (§6.4). A body naming somebody else is
 *     overwritten rather than believed, and that is asserted rather than assumed.
 *
 *  3. **Nothing here resumes anything.** Answering records the answer, and the
 *     scheduler's next tick reads it and continues the parked session (A78.8).
 *     A route that also drove §6.4 would put that round trip in a second place —
 *     one reached by a browser and one by a tick — and the two would disagree.
 *
 * The collaborator is declared structurally rather than as `EscalationService`
 * (A57.6): a test fake then has to match the real signatures, which is exactly
 * the drift a test of this layer exists to catch.
 */
import { type DecisionRecord, EscalationError, type EscalationRecord } from '@vorschicht/core';
import {
  type AnswerEscalationInput,
  answerEscalationInput,
  type DecisionView,
  decisionSummary,
  ESCALATION_SOURCE_LABELS,
  type EscalationCardView,
  type EscalationOption,
  type EscalationOptionView,
  type EscalationSource,
  MAX_DECISION_FREE_TEXT_LENGTH,
} from '@vorschicht/shared';

/** Exactly the four calls this module makes — see the note on structural deps. */
export interface InboxEscalations {
  open(): Promise<EscalationRecord[]>;
  byNumber(number: number): Promise<EscalationRecord | null>;
  answer(escalationId: string, input: AnswerEscalationInput): Promise<EscalationRecord>;
  decisions(limit?: number): Promise<DecisionRecord[]>;
}

export interface InboxDeps {
  escalations: InboxEscalations;
}

/**
 * The three views are `@vorschicht/shared/inbox`'s, not this module's.
 *
 * They were declared here and again, differently, in `apps/web` — which is how
 * the pages ended up unable to read a single field of what these routes answer.
 * `toCard` and `toDecisionView` below now carry a compile-time obligation to the
 * same document the dashboard parses; the reasoning for each field lives with
 * the schema, where both sides read it.
 */
export type { DecisionView, EscalationCardView, EscalationOptionView };

export type CardResult =
  | { ok: true; escalation: EscalationCardView }
  | { ok: false; reason: 'unknown' };

export type AnswerResult =
  | { ok: true; escalation: EscalationCardView }
  | { ok: false; reason: 'unknown' }
  /**
   * Already decided. The card travels with the refusal so the page can show what
   * the answer *was* instead of asking for it in a second request — the caller
   * has nothing to fix, so telling them only "no" is the least useful answer.
   */
  | { ok: false; reason: 'conflict'; errors: string[]; escalation: EscalationCardView }
  /** The submitted answer is not one. Every reason, German, ready to render. */
  | { ok: false; reason: 'invalid'; errors: string[] };

/** §17.5's inbox: everything waiting, most urgent first. */
export async function listInbox(deps: InboxDeps): Promise<EscalationCardView[]> {
  const rows = await deps.escalations.open();
  return rows.map(toCard);
}

/** One card, by the number every notification and every deep link uses. */
export async function getInboxCard(deps: InboxDeps, number: number): Promise<CardResult> {
  const record = await deps.escalations.byNumber(number);
  return record ? { ok: true, escalation: toCard(record) } : { ok: false, reason: 'unknown' };
}

/**
 * The operator decides (§15).
 *
 * Order of the three refusals is deliberate. An unknown item comes first because
 * there is nothing to talk about. A conflict comes *before* validation because a
 * caller whose item is already answered has nothing to fix — reporting a
 * malformed body there would send them to correct a form whose submission can
 * never succeed.
 */
export async function answerEscalation(
  deps: InboxDeps,
  number: number,
  input: unknown,
  actor: string,
): Promise<AnswerResult> {
  const existing = await deps.escalations.byNumber(number);
  if (!existing) return { ok: false, reason: 'unknown' };

  if (existing.state === 'answered') {
    return {
      ok: false,
      reason: 'conflict',
      errors: [alreadyAnswered(number)],
      escalation: toCard(existing),
    };
  }

  // Spread first, then the actor: a body that names somebody else is overwritten
  // rather than believed (§19). Anything that is not an object becomes an empty
  // one, so the schema answers it as "no decision" instead of a shell spreading
  // a string into characters.
  const body = isPlainObject(input) ? input : {};
  const parsed = answerEscalationInput.safeParse({ ...body, actor });
  if (!parsed.success) {
    return { ok: false, reason: 'invalid', errors: germanIssues(parsed.error.issues) };
  }

  try {
    const answered = await deps.escalations.answer(existing.id, parsed.data);
    return { ok: true, escalation: toCard(answered) };
  } catch (error) {
    if (!(error instanceof EscalationError)) throw error;
    // The service says which refusal this is; this layer no longer guesses from
    // the row afterwards. That guess is what let a *real* concurrent answer
    // through: two callers both pass the service's non-transactional pre-check,
    // the database refuses the second with `23505`, and a `PostgresError` is not
    // an `EscalationError` — so it was rethrown and surfaced as Hono's plain-text
    // 500. The service now translates it, and `kind` carries the verdict here.
    if (error.kind !== 'conflict') {
      return { ok: false, reason: 'invalid', errors: [error.message] };
    }
    // Re-read only to *fetch* the answered card the 409 body carries — no longer
    // to diagnose anything. It is reliable: the losing INSERT blocks on the
    // unique index until the winner commits, so by the time `23505` is raised
    // the winning answer is visible to a fresh statement.
    const after = await deps.escalations.byNumber(number);
    return {
      ok: false,
      reason: 'conflict',
      errors: [alreadyAnswered(number)],
      escalation: toCard(after ?? existing),
    };
  }
}

/** How many decisions the log returns when the caller does not say. */
export const DEFAULT_DECISION_LOG_LIMIT = 100;

/**
 * The ceiling on that.
 *
 * The limit arrives in a query string, so it is an input a caller picks; an
 * unclamped one is a way to ask this process to materialise every decision the operator
 * has ever made into one JSON body.
 */
export const MAX_DECISION_LOG_LIMIT = 500;

export function decisionLogLimit(raw: number | null): number {
  if (raw === null || !Number.isFinite(raw)) return DEFAULT_DECISION_LOG_LIMIT;
  return Math.min(MAX_DECISION_LOG_LIMIT, Math.max(1, Math.trunc(raw)));
}

/** The decision log (§15, §17.5), newest first. */
export async function listDecisionLog(
  deps: InboxDeps,
  limit: number | null,
): Promise<DecisionView[]> {
  const rows = await deps.escalations.decisions(decisionLogLimit(limit));
  return rows.map(toDecisionView);
}

// --- German, at the boundary -------------------------------------------------

function alreadyAnswered(number: number): string {
  return (
    `Entscheidung #${number} ist bereits beantwortet — eine geänderte Meinung ist eine ` +
    'neue Frage, weil die Antwort zu diesem Zeitpunkt schon in die fortgesetzte Sitzung ' +
    'eingespielt wurde (§6.4).'
  );
}

const FIELD_LABELS: Record<string, string> = {
  optionIndex: 'Die gewählte Option',
  freeText: 'Der Freitext',
  actor: 'Der Urheber',
};

/**
 * Zod's issues as sentences the operator can read (§2).
 *
 * A `custom` issue is one of the schema's own refinements and already carries a
 * German sentence — §15's rules live there and are quoted verbatim rather than
 * re-worded here, so the two cannot drift. Everything else is a shape error
 * whose zod message is English, and passing it through would put English in the
 * one place the language policy is unconditional: the text a person reads.
 *
 * Typed structurally rather than as `ZodError` so the mapping can be tested
 * without constructing one.
 */
export function germanIssues(
  issues: ReadonlyArray<{ code: string; path: ReadonlyArray<PropertyKey>; message: string }>,
): string[] {
  return issues.map((issue) => {
    if (issue.code === 'custom') return issue.message;
    if (issue.code === 'too_big' && issue.path[0] === 'freeText') {
      return `Der Freitext ist zu lang — höchstens ${MAX_DECISION_FREE_TEXT_LENGTH} Zeichen.`;
    }
    const field = FIELD_LABELS[String(issue.path[0] ?? '')] ?? 'Die Eingabe';
    return `${field} hat nicht die erwartete Form.`;
  });
}

// --- views -------------------------------------------------------------------

function toCard(record: EscalationRecord): EscalationCardView {
  return {
    id: record.id,
    number: record.number,
    source: record.source,
    sourceLabel: sourceLabel(record.source),
    urgency: record.urgency,
    projectId: record.projectId,
    taskId: record.taskId,
    runId: record.runId,
    question: record.question,
    context: record.context,
    options: toOptions(record.options),
    related: record.related,
    raisedAt: record.raisedAt.toISOString(),
    raisedBy: record.raisedBy,
    state: record.state,
    answeredAt: record.answeredAt?.toISOString() ?? null,
    answeredBy: record.answeredBy,
    chosenIndex: record.chosenIndex,
    chosenTitle: record.chosenTitle,
    freeText: record.freeText,
  };
}

function toDecisionView(record: DecisionRecord): DecisionView {
  return {
    escalationId: record.escalationId,
    number: record.number,
    source: record.source,
    sourceLabel: sourceLabel(record.source),
    projectId: record.projectId,
    taskId: record.taskId,
    question: record.question,
    summary: decisionSummary(record),
    options: toOptions(record.options),
    chosenIndex: record.chosenIndex,
    chosenTitle: record.chosenTitle,
    freeText: record.freeText,
    decidedAt: record.decidedAt.toISOString(),
    decidedBy: record.decidedBy,
  };
}

function toOptions(options: EscalationOption[]): EscalationOptionView[] {
  return options.map((option, index) => ({
    index,
    title: option.title,
    pros: option.pros,
    cons: option.cons,
    // A stored row predating the schema's default would render as an option set
    // with no recommendation, which is a §15 format violation shown to the operator.
    recommended: option.recommended === true,
  }));
}

/**
 * The source in words.
 *
 * The record casts the column to `EscalationSource`, so a row carrying a source
 * this build does not know would otherwise render as `undefined` on the card.
 * Falling back to the raw value keeps the card readable and says what it is.
 */
function sourceLabel(source: EscalationSource): string {
  return ESCALATION_SOURCE_LABELS[source] ?? source;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
