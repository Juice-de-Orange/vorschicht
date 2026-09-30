/**
 * The escalation inbox and its decision memory (§15, §22 Phase 4 step 1).
 *
 * §15 is the "studio owner" model: every question reaches the operator already
 * researched, and every answer he gives is kept and reused. This service owns
 * both halves — the inbox item and the decision it becomes — because in the
 * schema they are the same rows read from two ends (0016).
 *
 * Four properties are the design.
 *
 *  1. **Raising never consults policy memory; asking does.** `raise()` writes an
 *     inbox item, full stop. The precedent lookup lives one layer up, in
 *     `AgentChannel.requestEscalation`, and applies only to the source §15 means
 *     by policy memory. The separation is not tidiness: §9's second-failure
 *     escalation is *also* an escalation, and a `raise()` that auto-answered
 *     from memory could abort a task because a differently-numbered task with
 *     the same title was once aborted. The narrow list is in
 *     `POLICY_MEMORY_SOURCES` with that accident written out.
 *
 *  2. **An answer is a fact about an escalation, never a status somebody sets.**
 *     `state` is derived from the presence of an `answered` row, and there is no
 *     way to write one twice — the database refuses it. §6.4 injects the answer
 *     into a resumed session, so by the time anybody could revise a decision the
 *     studio has already acted on it; a second answer would read as the decision
 *     that was carried out while being the one that was not.
 *
 *  3. **Nothing here parks, resumes or transitions a task.** Same boundary
 *     `AgentChannel` keeps (A48.2) and for the same reason: the session that
 *     raised an escalation is still running when this returns, and §7.3 stops
 *     work on an atomic boundary rather than mid-tool. §6.4's round trip is the
 *     scheduler's, and this service is what it reads.
 *
 *  4. **The related decisions on a card inform and never decide.** They are
 *     computed once, at raise time, and stored with the item — so the card the operator
 *     reads is the card that was prepared for him, rather than a similarity
 *     search re-run against a corpus that has moved on since.
 */
import {
  type AnswerEscalationInput,
  answerEscalationInput,
  type DecisionSummaryInput,
  decisionSummary,
  type EscalationOption,
  type EscalationSource,
  type EscalationState,
  hasPrecedentKey,
  isRelated,
  MAX_RELATED_DECISIONS,
  POLICY_MEMORY_SOURCES,
  type Priority,
  precedentKey,
  type RaiseEscalationInput,
  type RelatedDecision,
  raiseEscalationInput,
} from '@vorschicht/shared';
import type postgres from 'postgres';
import type { EventLog } from './event-log.js';
import type { Queryable } from './sql.js';

/**
 * How many past decisions the similarity pass reads.
 *
 * A bounded scan rather than an index, because Jaccard over word sets is not
 * something a btree answers and the corpus is a human's decisions rather than a
 * machine's output — a busy year is a few hundred. The cap is stated rather than
 * silent: beyond it the *oldest* decisions stop being offered as context, which
 * costs a line on a card and never an answer.
 */
export const RELATED_SCAN_LIMIT = 200;

/**
 * A near-miss shown on the card, and the shape stored with the item.
 *
 * Declared in `@vorschicht/shared/inbox` and re-exported here: it travels on the
 * wire, and a shape declared where it is produced beside a copy where it is
 * consumed is exactly the arrangement that left the whole inbox page unable to
 * read a single field. Importers here are unaffected.
 */
export type { RelatedDecision };

export interface EscalationRecord {
  id: string;
  /** §15's "#X" — permanent, from a sequence rather than a position (0016). */
  number: number;
  source: EscalationSource;
  urgency: Priority;
  projectId: string | null;
  taskId: string | null;
  /** The run §6.4 resumes. Null where no session asked. */
  runId: string | null;
  question: string;
  context: string;
  options: EscalationOption[];
  /** Normalised question, or null when nothing normalisable survived. */
  precedentKey: string | null;
  related: RelatedDecision[];
  raisedAt: Date;
  raisedBy: string;
  state: EscalationState;
  answeredAt: Date | null;
  answeredBy: string | null;
  chosenIndex: number | null;
  chosenTitle: string | null;
  freeText: string | null;
}

export interface DecisionRecord {
  escalationId: string;
  number: number;
  source: EscalationSource;
  projectId: string | null;
  taskId: string | null;
  question: string;
  precedentKey: string | null;
  options: EscalationOption[];
  chosenIndex: number | null;
  chosenTitle: string | null;
  freeText: string | null;
  decidedAt: Date;
  decidedBy: string;
}

export interface PrecedentQuery {
  question: string;
  /** Null asks for a global decision only — see `scopeClause`. */
  projectId?: string | null;
}

export interface EscalationServiceDeps {
  sql: Queryable;
  eventLog: EventLog;
}

/**
 * Which of the five refusals this is.
 *
 * A required field rather than five error classes, following `GateConfigError`:
 * one error class per subsystem carrying structured data, because the subsystem
 * is the boundary and the situations are data. Five classes would also land one
 * by one in the dead-wiring detector, three of them caught by nothing.
 *
 * It is required, deliberately: a future throw site must pick one, the posture
 * A77.2 already takes for `POLICY_MEMORY_SOURCES`. Before this existed the HTTP
 * layer had only the message text to tell "already decided" (409) from "that
 * option does not exist" (422), so it re-read the row afterwards and guessed —
 * and a real concurrent answer, which arrives as a `PostgresError` rather than
 * an `EscalationError`, fell through the guess entirely.
 */
export type EscalationErrorKind = 'conflict' | 'invalid_option' | 'not_found' | 'not_created';

export class EscalationError extends Error {
  constructor(
    message: string,
    readonly kind: EscalationErrorKind,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'EscalationError';
  }
}

/** Written once so the pre-check and the race path say the same thing. */
function alreadyAnsweredSentence(number: number, answeredAt: Date | null): string {
  return (
    `Entscheidung #${number} ist bereits beantwortet (am ` +
    `${answeredAt?.toISOString() ?? 'unbekannt'}). Eine geänderte Meinung ist ` +
    'eine neue Frage — die Antwort ist zu diesem Zeitpunkt bereits in die ' +
    'fortgesetzte Sitzung eingespielt worden (§6.4).'
  );
}

/** Postgres' unique-violation code. Both reachable constraints mean the same. */
const UNIQUE_VIOLATION = '23505';

export class EscalationService {
  constructor(private readonly deps: EscalationServiceDeps) {}

  /**
   * Put a prepared decision in front of the operator (§15).
   *
   * Validation is the schema's, and it is not a formality: §15's format —
   * 2 to 4 options, each with at least one pro *and* one con, exactly one marked
   * as the recommendation — is the entire difference between this system's
   * escalations and a bare question, and the party supplying it is usually a
   * language model.
   */
  async raise(input: RaiseEscalationInput): Promise<EscalationRecord> {
    const parsed = raiseEscalationInput.parse(input);
    const key = precedentKey(parsed.question);
    const related = await this.relatedTo({
      question: parsed.question,
      projectId: parsed.projectId ?? null,
    });

    const payload = {
      source: parsed.source,
      urgency: parsed.urgency,
      projectId: parsed.projectId ?? null,
      taskId: parsed.taskId ?? null,
      runId: parsed.runId ?? null,
      question: parsed.question,
      context: parsed.context,
      options: parsed.options,
      // Null, not '', when nothing normalisable survived the question. The view
      // NULLIFs the empty string as well, deliberately twice: this is the one
      // value that must never match, and a key of '' held against the column
      // would match every other question that also normalised to nothing.
      precedentKey: hasPrecedentKey(key) ? key : null,
      related,
    };

    const [row] = await this.deps.sql<Array<{ escalation_id: string; number: string }>>`
      INSERT INTO escalation_events (escalation_id, seq, kind, actor, number, payload)
      VALUES (
        gen_random_uuid(), 1, 'raised', ${parsed.raisedBy},
        nextval('escalation_number_seq'),
        ${this.deps.sql.json(payload as unknown as postgres.JSONValue)}
      )
      RETURNING escalation_id, number::text AS number
    `;
    /* c8 ignore next 3 */
    if (!row) {
      throw new EscalationError(
        'Eskalation konnte nicht angelegt werden — kein Datensatz zurück.',
        'not_created',
      );
    }

    const record = await this.require(row.escalation_id);
    await this.deps.eventLog.append({
      kind: 'escalation.raised',
      actor: parsed.raisedBy,
      projectId: parsed.projectId ?? null,
      taskId: parsed.taskId ?? null,
      runId: parsed.runId ?? null,
      payload: {
        escalationId: record.id,
        number: record.number,
        source: record.source,
        urgency: record.urgency,
        question: record.question,
        relatedCount: record.related.length,
      },
    });
    return record;
  }

  /**
   * The operator decides (§15).
   *
   * The option index is checked against *this* escalation's options rather than
   * trusted: an out-of-range index would otherwise store a decision whose chosen
   * title is null while `chosenIndex` says one was picked, and the resumed
   * session would be handed an answer that names nothing.
   */
  async answer(escalationId: string, input: AnswerEscalationInput): Promise<EscalationRecord> {
    const parsed = answerEscalationInput.parse(input);
    const current = await this.require(escalationId);

    if (current.state === 'answered') {
      throw new EscalationError(
        alreadyAnsweredSentence(current.number, current.answeredAt),
        'conflict',
      );
    }

    const index = parsed.optionIndex ?? null;
    if (index !== null && !current.options[index]) {
      throw new EscalationError(
        `Option ${index} gibt es bei Entscheidung #${current.number} nicht — ` +
          `es sind ${current.options.length} zur Auswahl (0 bis ${current.options.length - 1}).`,
        'invalid_option',
      );
    }
    const chosenTitle = index === null ? null : (current.options[index]?.title ?? null);
    const freeText = parsed.freeText?.trim() ? parsed.freeText.trim() : null;

    /*
     * The check above is the friendly half; this is the half nothing can go
     * around (A77.8). Two callers can both pass a non-transactional read and
     * both reach here, and the database refuses the second — so a refusal that
     * is *only* a pre-check is not the guarantee, it is the polite version of
     * it.
     *
     * A bare `23505` is safe here, and that is checked rather than assumed:
     * exactly two unique constraints are reachable from this INSERT —
     * `escalation_events_one_answer` and `UNIQUE (escalation_id, seq)`, the
     * latter because `seq` is hard-coded to 2 — and **both mean "already
     * answered"**. Which of the two fires is not deterministic across index
     * build order, so matching on the constraint name would be the fragile
     * choice.
     *
     * Duck-typed rather than `instanceof sql.PostgresError`: `Queryable` is
     * `postgres.ISql`, chosen so a transaction handle can be passed, and
     * `PostgresError` is a member of `Sql` but not of `ISql`. That is a
     * constraint, not a preference.
     */
    try {
      await this.deps.sql`
        INSERT INTO escalation_events (escalation_id, seq, kind, actor, payload)
        VALUES (
          ${escalationId}, 2, 'answered', ${parsed.actor},
          ${this.deps.sql.json({ optionIndex: index, chosenTitle, freeText } as postgres.JSONValue)}
        )
      `;
    } catch (error) {
      if ((error as { code?: unknown }).code !== UNIQUE_VIOLATION) throw error;
      // `answeredAt` is null on the stale record this caller holds — it lost the
      // race, so it never saw the row that won it.
      throw new EscalationError(alreadyAnsweredSentence(current.number, null), 'conflict', {
        cause: error,
      });
    }

    const record = await this.require(escalationId);
    await this.deps.eventLog.append({
      kind: 'escalation.answered',
      actor: parsed.actor,
      projectId: record.projectId,
      taskId: record.taskId,
      runId: record.runId,
      payload: {
        escalationId: record.id,
        number: record.number,
        source: record.source,
        chosenIndex: index,
        chosenTitle,
        hasFreeText: freeText !== null,
      },
    });
    return record;
  }

  async get(id: string): Promise<EscalationRecord | null> {
    const [row] = await this.deps.sql<EscalationRow[]>`SELECT * FROM escalations WHERE id = ${id}`;
    return row ? toEscalation(row) : null;
  }

  /** §15's deep link target: `/posteingang/12` finds the item the operator was pushed. */
  async byNumber(number: number): Promise<EscalationRecord | null> {
    const [row] = await this.deps.sql<EscalationRow[]>`
      SELECT * FROM escalations WHERE number = ${number}`;
    return row ? toEscalation(row) : null;
  }

  /**
   * The inbox: everything waiting, most urgent first (§17.5).
   *
   * P0 before P3, and within a priority the *oldest* first — an item that has
   * been waiting three days should not sink under one raised this morning.
   */
  async open(): Promise<EscalationRecord[]> {
    const rows = await this.deps.sql<EscalationRow[]>`
      SELECT * FROM escalations WHERE state = 'open' ORDER BY urgency ASC, number ASC`;
    return rows.map(toEscalation);
  }

  /** §17.1's "N Tasks warten auf deine Entscheidung" counter. */
  async countOpen(): Promise<number> {
    const [row] = await this.deps.sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM escalations WHERE state = 'open'`;
    return Number(row?.count ?? 0);
  }

  /** Everything ever raised for one task, oldest first — the trace. */
  async forTask(taskId: string): Promise<EscalationRecord[]> {
    const rows = await this.deps.sql<EscalationRow[]>`
      SELECT * FROM escalations WHERE task_id = ${taskId} ORDER BY number ASC`;
    return rows.map(toEscalation);
  }

  /**
   * The one thing this task is waiting on, if it is (§15's "blockiert durch
   * Entscheidung #X").
   *
   * Newest first: a task that has asked twice is waiting on the second question.
   */
  async openForTask(taskId: string): Promise<EscalationRecord | null> {
    const [row] = await this.deps.sql<EscalationRow[]>`
      SELECT * FROM escalations
      WHERE task_id = ${taskId} AND state = 'open'
      ORDER BY number DESC LIMIT 1`;
    return row ? toEscalation(row) : null;
  }

  /**
   * The last question this task asked, answered or not — §6.4's trigger.
   *
   * The one a resumption acts on, and deliberately *not* filtered to `answered`:
   * a task waiting on a decision must be able to tell "the operator has answered" from
   * "there is nothing here", and a query that returned only answered items would
   * make an older, already-answered escalation look like the current one the
   * moment the task asked a second question. Same "newest wins" reading
   * `openForTask` uses, for the same reason.
   */
  async latestForTask(taskId: string): Promise<EscalationRecord | null> {
    const [row] = await this.deps.sql<EscalationRow[]>`
      SELECT * FROM escalations WHERE task_id = ${taskId}
      ORDER BY number DESC LIMIT 1`;
    return row ? toEscalation(row) : null;
  }

  /** The decision log (§15, §17.5), newest first. */
  async decisions(limit = 100): Promise<DecisionRecord[]> {
    const rows = await this.deps.sql<DecisionRow[]>`
      SELECT * FROM decisions ORDER BY decided_at DESC LIMIT ${limit}`;
    return rows.map(toDecision);
  }

  /**
   * Has the operator already answered exactly this question, in scope? (§15's policy memory.)
   *
   * Three filters, and every one of them is a safety property rather than an
   * optimisation:
   *
   *   * **Exact key.** `precedentKey` normalises formatting and nothing else, so
   *     a match means the operator saw this question. A fuzzy match here would apply a
   *     decision he never gave to a question he never read.
   *   * **Scope.** A decision raised inside a project applies to that project; a
   *     decision raised without one is global and applies anywhere. The narrow
   *     direction is deliberate — one project's conventions are not another's —
   *     and widening a precedent is the operator's call, with no code path for it yet.
   *   * **Source.** Only what `POLICY_MEMORY_SOURCES` admits. See the note there
   *     for what admitting §9's red path would automate.
   *
   * Newest wins: a later decision on the same question supersedes an earlier
   * one, which is the only reading under which the operator can change a policy at all.
   */
  async precedentFor(query: PrecedentQuery): Promise<DecisionRecord | null> {
    const key = precedentKey(query.question);
    if (!hasPrecedentKey(key)) return null;
    const projectId = query.projectId ?? null;

    // The array is passed plainly rather than through `sql.array()`. Untyped,
    // that helper only serialises correctly once the driver has learned its
    // element type from the server, so as the *first* statement on a fresh pool
    // it sends a scalar and Postgres answers `op ANY/ALL (array) requires array
    // on right side` — a query that works everywhere except on a cold
    // connection, which is where the orchestrator's first escalation runs.
    // Reduced to a two-line repro before changing it; `precedentFor` and
    // `relatedTo` were the only two paths that could hit it.
    const rows = await this.deps.sql<DecisionRow[]>`
      SELECT * FROM decisions
      WHERE precedent_key = ${key}
        AND source = ANY(${POLICY_MEMORY_SOURCES})
        AND (project_id IS NULL OR project_id = ${projectId})
      ORDER BY decided_at DESC LIMIT 1`;
    return rows[0] ? toDecision(rows[0]) : null;
  }

  /**
   * Earlier decisions that resemble this question, for the card (§15).
   *
   * Same scope and source rules as `precedentFor`, and that is a decision rather
   * than symmetry for its own sake: offering the operator a decision the system would
   * have refused to apply invites the question "why was that not simply used",
   * whose honest answer is "it is out of scope" — a card that has to explain its
   * own suggestions is worse than one that makes fewer.
   *
   * The exact match is excluded here (`isRelated`) because it is not a related
   * decision, it is *the* decision, and it never reaches this path: an escalation
   * with an exact precedent is answered from memory instead of being raised.
   */
  async relatedTo(
    query: PrecedentQuery,
    limit = MAX_RELATED_DECISIONS,
  ): Promise<RelatedDecision[]> {
    const key = precedentKey(query.question);
    if (!hasPrecedentKey(key)) return [];
    const projectId = query.projectId ?? null;

    const rows = await this.deps.sql<DecisionRow[]>`
      SELECT * FROM decisions
      WHERE source = ANY(${POLICY_MEMORY_SOURCES})
        AND (project_id IS NULL OR project_id = ${projectId})
      ORDER BY decided_at DESC LIMIT ${RELATED_SCAN_LIMIT}`;

    return rows
      .map(toDecision)
      .filter((decision) => isRelated(query.question, decision.question))
      .slice(0, limit)
      .map((decision) => ({
        number: decision.number,
        question: decision.question,
        summary: decisionSummary(decision as DecisionSummaryInput),
        decidedAt: decision.decidedAt.toISOString(),
      }));
  }

  private async require(id: string): Promise<EscalationRecord> {
    const record = await this.get(id);
    if (!record) throw new EscalationError(`Eskalation ${id} existiert nicht.`, 'not_found');
    return record;
  }
}

// --- rows --------------------------------------------------------------------

interface EscalationRow {
  id: string;
  number: string;
  source: string;
  urgency: string;
  project_id: string | null;
  task_id: string | null;
  run_id: string | null;
  question: string;
  context: string;
  options: EscalationOption[];
  precedent_key: string | null;
  related: RelatedDecision[];
  raised_at: Date;
  raised_by: string;
  answered_at: Date | null;
  answered_by: string | null;
  chosen_index: number | null;
  chosen_title: string | null;
  free_text: string | null;
  state: string;
}

interface DecisionRow {
  escalation_id: string;
  number: string;
  source: string;
  project_id: string | null;
  task_id: string | null;
  question: string;
  precedent_key: string | null;
  options: EscalationOption[];
  chosen_index: number | null;
  chosen_title: string | null;
  free_text: string | null;
  decided_at: Date;
  decided_by: string;
}

function toEscalation(row: EscalationRow): EscalationRecord {
  return {
    id: row.id,
    number: Number(row.number),
    source: row.source as EscalationSource,
    urgency: row.urgency as Priority,
    projectId: row.project_id,
    taskId: row.task_id,
    runId: row.run_id,
    question: row.question,
    context: row.context,
    options: row.options ?? [],
    precedentKey: row.precedent_key,
    related: row.related ?? [],
    raisedAt: row.raised_at,
    raisedBy: row.raised_by,
    state: row.state as EscalationState,
    answeredAt: row.answered_at,
    answeredBy: row.answered_by,
    chosenIndex: row.chosen_index,
    chosenTitle: row.chosen_title,
    freeText: row.free_text,
  };
}

function toDecision(row: DecisionRow): DecisionRecord {
  return {
    escalationId: row.escalation_id,
    number: Number(row.number),
    source: row.source as EscalationSource,
    projectId: row.project_id,
    taskId: row.task_id,
    question: row.question,
    precedentKey: row.precedent_key,
    options: row.options ?? [],
    chosenIndex: row.chosen_index,
    chosenTitle: row.chosen_title,
    freeText: row.free_text,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
  };
}
