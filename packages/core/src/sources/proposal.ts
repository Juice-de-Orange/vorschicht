/**
 * §14's proposal flow: a department suggests a source, the operator decides inclusion.
 *
 * §14 gives it one sentence — "Departments may **propose** new highly-trusted
 * sources → inbox item with the agent's trust assessment → the operator decides
 * inclusion" — and §15 has carried `source_proposal` in `ESCALATION_SOURCES`
 * since Phase 4 with the note "Phase 6" beside it and no producer at all. This
 * module is both halves, and it is deliberately both: a card whose answer does
 * nothing is the shape this repository has now built twice (A86's `tick()` with
 * no caller, A105/A106's scan with no channel), and the way not to build it a
 * third time is to land the reader in the same commit as the writer.
 *
 * Six decisions.
 *
 *  1. **The options are computed once and *stored*, not derived twice.** §15's
 *     answer is an index, and an index means nothing without the list it points
 *     into — so the same list has to be in front of the operator and in front of the
 *     reader. Deriving it on both sides is A81's defect in miniature: two
 *     independent declarations of one document, each side green about its own.
 *     `sourceProposalChoices` builds it, the card renders `option`, and the
 *     **`source.proposed` event stores the `{ act, level }` pairs**, so a later
 *     change to this function cannot retroactively re-map a card that is already
 *     open. A payload without them is skipped rather than guessed at.
 *
 *  2. **The reader reads `chosenIndex`, never `state === 'answered'`.** That
 *     confusion has now been found twice in this repository, and the second time
 *     it ran over the *recommended* option: A93.5 for A12's self-deploy, A97 for
 *     A24's migration stop, where "Warten" released the rollout. Here the
 *     equivalent accident would take a source into §14's registry because the operator
 *     wrote a sentence declining it. A free-text-only answer therefore decides
 *     **nothing**: "nimm sie" and "auf keinen Fall" are both free text, and
 *     inferring consent from prose is guessing at exactly the question that was
 *     escalated (§1 principle 6).
 *
 *  3. **The memory is an `event_log` row, written after the act.** The process
 *     that would hold it is the one a deploy restarts (A57), so
 *     `periodic-pass.ts`'s decision 1 applies unchanged. Written after, per
 *     A86.4: a crash between the act and the memory costs one repeat, which the
 *     source's own state then absorbs (decision 4), where writing first would
 *     record a curation that never happened.
 *
 *  4. **The source's state is re-checked immediately before the act.** the operator may
 *     have curated it in the dashboard between the card being raised and this
 *     pass running, and `SOURCE_ACTS_BY_STATE` is the one table that says what
 *     is still possible. Belt and braces with decision 3 rather than a
 *     duplicate: the memory stops a *repeat*, this stops a *conflict*, and the
 *     two catch different things.
 *
 *     **The criterion is the act, not the touch**, and the difference is a real
 *     consequence rather than wording. A source the operator accepted on §17.7's page is
 *     skipped, because `accepted` does not admit `accept` and a second
 *     acceptance would silently re-level a source already in the registry. A
 *     source he *rejected* by hand is **not** skipped: `rejected` does admit
 *     `accept` on purpose (§14 is curated rather than final), so answering the
 *     still-open card with "Aufnehmen" takes it in after all — which is right,
 *     because the answer is the chronologically later act and it is his either
 *     way. Written down because it is a statement about §14's evidence base, and
 *     a reader who assumed "already curated ⇒ skipped" would have it backwards
 *     in the one direction that puts a source into the registry.
 *
 *  5. **Every outcome is recorded, including the ones that curated nothing.** A
 *     memory holding only the successes would leave a free-text answer and a
 *     source somebody curated meanwhile re-examined on every tick forever — the
 *     flood A98 and A101 both ended, in a table §18 never deletes from.
 *
 *  6. **§19's row is written here too, in the act's own transaction.** A
 *     curation arriving through the inbox is still the operator deciding, so a trail that
 *     named only the button-press channel would have a hole shaped exactly like
 *     §14's own flow. `curate` binds the registry and the trail to one handle
 *     for `quellen.ts`'s reason: with two sequential writes, an act whose audit
 *     row failed would be retried, skipped by decision 4, and left permanently
 *     without a §19 row — a level granted with nothing saying who granted it, in
 *     the one table a citation rests on.
 */
import {
  type EscalationOption,
  isSourceActAllowed,
  type RaiseEscalationInput,
  SOURCE_ACT_LABELS,
  type SourceAct,
  type TrustLevel,
  trustLevelCode,
} from '@vorschicht/shared';
import type { EventLog } from '../event-log.js';
import type { Queryable } from '../sql.js';
import type { SourceAuditTrail } from './audit.js';
import type { SourceRecord } from './registry.js';

/** What one entry of the card offers, and what answering it carries out. */
export interface SourceProposalChoice {
  /** `accept` or `reject`. Promotion and retirement are dashboard acts, never a card's. */
  act: Extract<SourceAct, 'accept' | 'reject'>;
  /** The level an acceptance grants. Null for a rejection. */
  level: TrustLevel | null;
  option: EscalationOption;
}

/** Stored on the `source.proposed` event, so the mapping outlives this function (decision 1). */
export interface StoredChoice {
  act: SourceProposalChoice['act'];
  level: TrustLevel | null;
}

/**
 * §15's options for one proposal, in the order the card shows them.
 *
 * Three, or two at L1, which is inside §15's 2–4. The middle one exists because
 * "yes" and "no" are not the whole answer §14 asks for: The operator decides *inclusion
 * and the level*, and a card offering only the department's own assessment would
 * make "I take it, but not at that level" a free-text answer — which decision 2
 * then correctly refuses to act on. Offering it as an option is what keeps the
 * common middle case inside the mechanism.
 *
 * The recommendation is the proposed level, and the con on that option says
 * plainly what it costs. The reasoning is §14's own posture: "curated sources
 * are weighted reference works, **not restrictions**", so an acceptance boosts a
 * ranking rather than granting a power — with the one exception that L4 and L5
 * *are* a power, because §14 makes them the condition for a legal citation. That
 * exception is why the con is written from the level rather than fixed.
 */
export function sourceProposalChoices(
  source: Pick<SourceRecord, 'proposedLevel' | 'title'>,
): SourceProposalChoice[] {
  const proposed = source.proposedLevel;
  const lower = (proposed - 1) as TrustLevel;
  const choices: SourceProposalChoice[] = [
    {
      act: 'accept',
      level: proposed,
      option: {
        title: `Aufnehmen auf ${trustLevelCode(proposed)}`,
        pros: [
          `Die Quelle steht ab sofort im Register und rankt auf ${trustLevelCode(proposed)}.`,
          'Die vorschlagende Abteilung hat sie eingeschätzt; die Begründung steht auf der Quelle.',
        ],
        cons: [citationCon(proposed)],
        recommended: true,
      },
    },
  ];

  if (proposed > 1) {
    choices.push({
      act: 'accept',
      level: lower,
      option: {
        title: `Aufnehmen, aber nur auf ${trustLevelCode(lower)}`,
        pros: [
          'Nimmt die Quelle auf, ohne die Einschätzung der Abteilung ungeprüft zu übernehmen.',
        ],
        cons: [citationCon(lower)],
        recommended: false,
      },
    });
  }

  choices.push({
    act: 'reject',
    level: null,
    option: {
      title: 'Ablehnen',
      pros: ['Nichts kommt ins Register, was du nicht selbst für belastbar hältst.'],
      cons: [
        'Die Abteilung recherchiert weiter ohne diese Quelle — §14 gewichtet nur, es ' +
          'verbietet nichts, also bleibt sie als ungewichteter Treffer erreichbar.',
      ],
      recommended: false,
    },
  });

  return choices;
}

/** The one sentence that differs by level, written from §14's threshold. */
function citationCon(level: TrustLevel): string {
  return level >= 4
    ? `Ab ${trustLevelCode(level)} darf Lena sie in einer rechtlichen Aussage zitieren (§14) — ` +
        'die Einschätzung stammt von der vorschlagenden Abteilung, nicht von dir.'
    : `Auf ${trustLevelCode(level)} ist sie für rechtliche Aussagen nicht tragend (§14) und ` +
        'braucht dort eine stärkere Quelle daneben.';
}

// --- the ports ---------------------------------------------------------------

/**
 * Exactly the calls this module makes on the registry.
 *
 * Structural rather than `SourceRegistry` (A57.6): a fake then has to match the
 * real signatures, which is the drift a test of this flow exists to catch.
 */
export interface ProposalRegistry {
  get(sourceId: string): Promise<{ source: SourceRecord } | null>;
  accept(
    sourceId: string,
    input: { level: TrustLevel; note?: string | null },
    actor: string,
  ): Promise<SourceRecord>;
  reject(sourceId: string, input: { reason: string }, actor: string): Promise<SourceRecord>;
}

export interface ProposalEscalations {
  raise(input: RaiseEscalationInput): Promise<{ id: string; number: number }>;
}

/** A registry and a §19 trail on the same transaction (decision 6). */
export interface ProposalTransaction {
  registry: ProposalRegistry;
  audit: SourceAuditTrail;
}

export interface SourceProposalsDeps {
  sql: Queryable;
  /** Reading needs no transaction and takes the pool. */
  registry: Pick<ProposalRegistry, 'get'>;
  /** One transaction per act, so the curation and §19's row land together. */
  curate<T>(fn: (tx: ProposalTransaction) => Promise<T>): Promise<T>;
  escalations: ProposalEscalations;
  eventLog: EventLog;
}

/** What one answered card turned into. Every value is recorded (decision 5). */
export type ProposalOutcome = 'accepted' | 'rejected' | 'unentschieden' | 'uebersprungen';

export interface AppliedProposal {
  escalationNumber: number;
  sourceId: string;
  outcome: ProposalOutcome;
  /** German, for the log — why nothing was curated, when nothing was. */
  detail: string | null;
}

export interface ApplyProposalsResult {
  applied: AppliedProposal[];
  /** German. A card whose act failed stays open for the next pass. */
  problems: string[];
}

/** How many answered cards one pass carries out. A tick is not a batch job. */
export const MAX_PROPOSALS_PER_PASS = 25;

export class SourceProposals {
  constructor(private readonly deps: SourceProposalsDeps) {}

  /**
   * Put a proposed source in front of the operator (§14, §15).
   *
   * Refuses anything that is not `proposed`: a card asking whether to include a
   * source that is already in the registry is a question with no answer, and
   * §15's inbox is the one channel that must not carry noise.
   *
   * Returns null when a card is already open for this source, rather than
   * raising a second one. The producer runs per department session and the same
   * source can be found twice in a week; two cards for one question is how an
   * inbox becomes something the operator stops opening.
   */
  async raise(sourceId: string, raisedBy: string): Promise<{ number: number } | null> {
    const detail = await this.deps.registry.get(sourceId);
    if (!detail) return null;
    const source = detail.source;
    if (source.state !== 'proposed') return null;
    if (await this.hasOpenCard(sourceId)) return null;

    const choices = sourceProposalChoices(source);
    const escalation = await this.deps.escalations.raise({
      source: 'source_proposal',
      question: `Soll „${clip(source.title, 200)}" ins Quellenregister aufgenommen werden?`,
      context: proposalContext(source),
      urgency: 'P2',
      options: choices.map((choice) => choice.option),
      raisedBy,
    });

    await this.deps.eventLog.append({
      kind: 'source.proposed',
      actor: raisedBy,
      payload: {
        sourceId,
        escalationId: escalation.id,
        escalationNumber: escalation.number,
        title: source.title,
        proposedLevel: source.proposedLevel,
        // Decision 1: the mapping travels with the card rather than being
        // recomputed against a function that may have moved on by the time the operator
        // gets round to answering.
        choices: choices.map((choice) => ({ act: choice.act, level: choice.level })),
      },
    });

    return { number: escalation.number };
  }

  /**
   * Carry out every answered proposal card that has not been carried out yet.
   *
   * Never throws: it runs from the daemon's loop, where a rejection reaches
   * `main().catch()` and becomes `process.exit(1)` — a restart carousel under
   * compose (`notifications-pass.ts`, property 1). One card that failed must
   * also not cost the next one its pass, so each is guarded on its own.
   */
  async applyAnswers(): Promise<ApplyProposalsResult> {
    const result: ApplyProposalsResult = { applied: [], problems: [] };

    let pending: PendingRow[];
    try {
      pending = await this.pendingAnswers();
    } catch (error) {
      result.problems.push(`Beantwortete Quellenvorschläge nicht lesbar: ${message(error)}`);
      return result;
    }

    for (const row of pending) {
      try {
        result.applied.push(await this.applyOne(row));
      } catch (error) {
        // No memory written: the card stays pending and the next pass tries
        // again. That is the right direction — a source the operator said yes to and the
        // studio failed to record is worth retrying, and decision 4 stops the
        // retry from doubling an act that did land.
        result.problems.push(
          `Quellenvorschlag #${row.number} konnte nicht ausgeführt werden: ${message(error)}`,
        );
      }
    }

    return result;
  }

  private async applyOne(row: PendingRow): Promise<AppliedProposal> {
    const base = { escalationNumber: row.number, sourceId: row.sourceId };
    const detail = await this.deps.registry.get(row.sourceId);

    if (!detail) {
      return this.remember({
        ...base,
        outcome: 'uebersprungen',
        detail: 'Die Quelle steht nicht mehr im Register.',
      });
    }

    // Decision 2. `chosenIndex` and nothing else — not `state`, not the prose.
    if (row.chosenIndex === null) {
      return this.remember({
        ...base,
        outcome: 'unentschieden',
        detail:
          'Die Antwort war reiner Freitext, also nennt sie keine der Optionen. Aus Prosa ' +
          'herauszulesen, ob aufgenommen werden soll, wäre geraten (§1 Prinzip 6).',
      });
    }

    const choice = row.choices[row.chosenIndex];
    if (!choice) {
      return this.remember({
        ...base,
        outcome: 'uebersprungen',
        detail:
          `Option ${row.chosenIndex} gehört zu keinem gespeicherten Vorschlag — die Karte ` +
          'nennt keine ausführbare Wahl.',
      });
    }

    const before = detail.source;
    if (!isSourceActAllowed(before.state, choice.act)) {
      return this.remember({
        ...base,
        outcome: 'uebersprungen',
        detail:
          `„${SOURCE_ACT_LABELS[choice.act]}" geht bei dieser Quelle nicht mehr; sie ist ` +
          'inzwischen im Dashboard kuratiert worden.',
      });
    }

    if (choice.act === 'accept' && choice.level === null) {
      return this.remember({
        ...base,
        outcome: 'uebersprungen',
        detail: 'Die gespeicherte Wahl nennt keine Stufe, also gibt es nichts zu gewähren.',
      });
    }

    const actor = row.answeredBy ?? 'max';
    const level = choice.level;

    // Decision 6: the act and §19's row are one transaction, and the state is
    // re-read inside it so that the standing landing in `before` is the one the
    // act was applied to rather than the one the check above saw.
    await this.deps.curate(async (tx) => {
      const inside = await tx.registry.get(row.sourceId);
      if (!inside || !isSourceActAllowed(inside.source.state, choice.act)) {
        throw new Error(
          `Die Quelle ist nicht mehr im Zustand „${before.state}" — inzwischen kuratiert.`,
        );
      }
      const after =
        choice.act === 'accept'
          ? await tx.registry.accept(
              row.sourceId,
              { level: level as TrustLevel, note: acceptNote(row) },
              actor,
            )
          : await tx.registry.reject(row.sourceId, { reason: rejectReason(row) }, actor);

      await tx.audit.record({
        actor,
        act: choice.act,
        before: inside.source,
        after,
        escalationNumber: row.number,
      });
    });

    return this.remember({
      ...base,
      outcome: choice.act === 'accept' ? 'accepted' : 'rejected',
      detail: null,
    });
  }

  /** Decision 3: the memory, and it is what `pendingAnswers` reads back. */
  private async remember(applied: AppliedProposal): Promise<AppliedProposal> {
    await this.deps.eventLog.append({
      kind: 'source.curated',
      actor: 'orchestrator',
      payload: {
        sourceId: applied.sourceId,
        escalationNumber: applied.escalationNumber,
        outcome: applied.outcome,
        detail: applied.detail,
      },
    });
    return applied;
  }

  /**
   * Answered proposal cards with no `source.curated` row yet.
   *
   * The join is on the escalation id the `source.proposed` payload carries, and
   * that is the whole reason that kind exists: §15's escalation has `projectId`,
   * `taskId` and `runId` and a source is none of the three, so the linkage has
   * to be recorded rather than inferred. Ordered by the proposal's own id, so a
   * backlog is carried out in the order the operator was asked.
   */
  private async pendingAnswers(): Promise<PendingRow[]> {
    const rows = await this.deps.sql<PendingSqlRow[]>`
      SELECT p.payload ->> 'sourceId'  AS source_id,
             p.payload ->  'choices'   AS choices,
             e.number::text            AS number,
             e.chosen_index            AS chosen_index,
             e.chosen_title            AS chosen_title,
             e.free_text               AS free_text,
             e.answered_by             AS answered_by
      FROM event_log p
      JOIN escalations e ON e.id = (p.payload ->> 'escalationId')::uuid
      WHERE p.kind = 'source.proposed'
        AND e.source = 'source_proposal'
        AND e.state = 'answered'
        AND NOT EXISTS (
          SELECT 1 FROM event_log c
          WHERE c.kind = 'source.curated'
            AND c.payload ->> 'escalationNumber' = e.number::text
        )
      ORDER BY p.id ASC
      LIMIT ${MAX_PROPOSALS_PER_PASS}
    `;
    return rows.map((row) => ({
      sourceId: row.source_id,
      // Fail closed (A83.6, A87.6, A99.4): a payload without the stored mapping
      // is a card whose answer cannot be resolved, and an empty list makes
      // `applyOne` record that rather than fall back on a recomputation that may
      // have changed since.
      choices: Array.isArray(row.choices) ? (row.choices as StoredChoice[]) : [],
      number: Number(row.number),
      chosenIndex: row.chosen_index,
      chosenTitle: row.chosen_title,
      freeText: row.free_text,
      answeredBy: row.answered_by,
    }));
  }

  /** Is a card for this source still waiting? */
  private async hasOpenCard(sourceId: string): Promise<boolean> {
    const rows = await this.deps.sql<Array<{ open: boolean }>>`
      SELECT true AS open
      FROM event_log p
      JOIN escalations e ON e.id = (p.payload ->> 'escalationId')::uuid
      WHERE p.kind = 'source.proposed'
        AND p.payload ->> 'sourceId' = ${sourceId}
        AND e.state = 'open'
      LIMIT 1
    `;
    return rows.length > 0;
  }
}

interface PendingSqlRow {
  source_id: string;
  choices: unknown;
  number: string;
  chosen_index: number | null;
  chosen_title: string | null;
  free_text: string | null;
  answered_by: string | null;
}

interface PendingRow {
  sourceId: string;
  choices: StoredChoice[];
  number: number;
  chosenIndex: number | null;
  chosenTitle: string | null;
  freeText: string | null;
  answeredBy: string | null;
}

/**
 * §15's context, 3–5 sentences, German (§2).
 *
 * It names the level the department claimed *and* what that level would mean,
 * because the whole content of this decision is a number whose consequences live
 * in §14 rather than on the card.
 */
function proposalContext(source: SourceRecord): string {
  const reference = source.url ?? 'ein Dokument aus dem Tresor (§13)';
  const assessment = source.assessment
    ? `Die Abteilung begründet das so: „${clip(source.assessment, 1_200)}"`
    : 'Die Abteilung hat keine Begründung mitgeschickt.';
  return (
    `Eine Abteilung schlägt eine neue Quelle für das Register vor (§14): ${reference}. ` +
    `Vorgeschlagen ist ${trustLevelCode(source.proposedLevel)}. ${assessment} ` +
    'Kuratierte Quellen sind Gewichtung und keine Einschränkung — die Abteilungen ' +
    'recherchieren weiterhin frei, eine Aufnahme hebt diese Quelle nur im Ranking. ' +
    `Ab ${trustLevelCode(4)} darf Lena sie in einer rechtlichen Aussage zitieren; darunter ` +
    'braucht eine solche Aussage zusätzlich eine stärkere Quelle.'
  );
}

/**
 * The note an acceptance carries, and the reason a rejection needs.
 *
 * the operator's own words travel **verbatim** where he wrote any, for
 * `decisionMessage`'s reason: a paraphrase of a decision is a second wording of
 * it that nothing keeps in step, and this one is the sentence §14 makes a later
 * citation rest on. Where he only picked an option, the fallback names the item
 * — so the reason column is never a bare "—" that a reader has to chase.
 */
function acceptNote(row: PendingRow): string {
  const free = row.freeText?.trim();
  return free
    ? `Entscheidung #${row.number}: ${clip(free, 800)}`
    : `Entscheidung #${row.number}: ${row.chosenTitle ?? 'Aufnehmen'}.`;
}

function rejectReason(row: PendingRow): string {
  const free = row.freeText?.trim();
  return free
    ? `Entscheidung #${row.number}: ${clip(free, 800)}`
    : `Entscheidung #${row.number}: abgelehnt, ohne weitere Begründung.`;
}

/**
 * Clip, and say that it was clipped.
 *
 * A77.10's lesson: a long title plus a thorough assessment once produced a card
 * the escalation schema itself refused, so §9's second failure would have left a
 * task correctly escalated with no card to answer.
 */
function clip(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
