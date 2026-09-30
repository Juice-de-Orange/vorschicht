/**
 * §14's proposal flow end to end, against a real Postgres: a department
 * proposes, §15 asks the operator, and what he answers is carried out.
 *
 * The one thing this file is built to be able to fail is the confusion that has
 * now been found twice in this repository — reading **that** an escalation was
 * answered instead of **what** was answered. A93.5 found it in A12's self-deploy
 * approval, where the option written to say "no" released the rollout; A97 found
 * the same shape in A24's migration stop, and there it ran over the *recommended*
 * option. Both defects sat in tests that existed and were green, because every
 * case answered with the index that happened to mean yes.
 *
 * So the load-bearing cases here are the ones that answer **no**:
 *
 *   * a rejection must leave the source un-accepted and not citable;
 *   * a free-text-only answer must decide nothing at all, because "nimm sie" and
 *     "auf keinen Fall" are both free text (§1 principle 6);
 *   * and an acceptance must land on the level the operator *chose*, which for the middle
 *     option is not the one the department proposed.
 *
 * Everything is real: the registry, the escalation service, the transaction that
 * binds §19's row to the act. A stubbed registry would let the level assertion
 * pass against a lie, and the whole question here is which number reached the
 * database.
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import { checkCitation } from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EscalationService } from '../escalation-service.js';
import { EventLog } from '../event-log.js';
import { SourceAuditLog } from './audit.js';
import { SourceProposals, sourceProposalChoices } from './proposal.js';
import { SourceRegistry } from './registry.js';

const url = process.env.TEST_DATABASE_URL;

const RADO = 'Recherche';

describe.skipIf(!url)('§14s Vorschlagsfluss (§15)', () => {
  let database: TestDatabase;
  let sql: postgres.Sql;
  let registry: SourceRegistry;
  let escalations: EscalationService;
  let proposals: SourceProposals;

  beforeAll(async () => {
    database = await createTestDatabase('sources_proposal');
    sql = createSql({ url: database.url, max: 4 });
    const eventLog = new EventLog(sql);
    registry = new SourceRegistry(sql);
    escalations = new EscalationService({ sql, eventLog });
    proposals = new SourceProposals({
      sql,
      registry,
      // The wiring `apps/orchestrator/src/main.ts` uses: the act and §19's row
      // on one handle. A fixture with two independent handles would pass the
      // assertions below and leave the guarantee those lines exist for untested.
      curate: (fn) =>
        sql.begin((tx) =>
          fn({ registry: new SourceRegistry(tx), audit: new SourceAuditLog(tx) }),
        ) as ReturnType<typeof fn>,
      escalations,
      eventLog,
    });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await database?.drop();
  });

  async function propose(title: string, level: 1 | 2 | 3 | 4 | 5 = 5): Promise<string> {
    const source = await registry.propose(
      { title, url: `https://example.org/${encodeURIComponent(title)}`, level },
      RADO,
    );
    return source.id;
  }

  /** Answer card `number` the way the dashboard does, and run one pass. */
  async function answer(
    nummer: number,
    input: { optionIndex?: number | null; freeText?: string | null },
  ) {
    const card = await escalations.byNumber(nummer);
    if (!card) throw new Error(`Keine Karte #${nummer}`);
    await escalations.answer(card.id, {
      optionIndex: input.optionIndex ?? null,
      freeText: input.freeText ?? null,
      actor: 'max',
    });
    return proposals.applyAnswers();
  }

  async function state(sourceId: string) {
    const detail = await registry.get(sourceId);
    if (!detail) throw new Error('Quelle weg');
    return detail.source;
  }

  async function curatedRows(sourceId: string) {
    return sql<Array<{ payload: Record<string, unknown> }>>`
      SELECT payload FROM event_log
      WHERE kind = 'source.curated' AND payload ->> 'sourceId' = ${sourceId}
      ORDER BY id
    `;
  }

  it('stellt einen Vorschlag als §15-Karte mit genau einer Empfehlung', async () => {
    const id = await propose('RIS — Vereinsgesetz 2002');
    const raised = await proposals.raise(id, RADO);
    expect(raised).not.toBeNull();

    const card = await escalations.byNumber(raised?.number ?? 0);
    expect(card?.source).toBe('source_proposal');
    expect(card?.question).toContain('RIS — Vereinsgesetz 2002');
    // §15's format, and it is the schema that enforces it — asserted here
    // because this is the first producer of this source and a card that failed
    // it would have been refused at `raise` with nothing in the inbox at all.
    expect(card?.options.length).toBeGreaterThanOrEqual(2);
    expect(card?.options.filter((option) => option.recommended)).toHaveLength(1);
    expect(card?.options.every((option) => option.pros.length > 0 && option.cons.length > 0)).toBe(
      true,
    );
    // The context has to say what the level *means*, because the whole content
    // of this decision is a number whose consequences live in §14.
    expect(card?.context).toContain('L4');
    expect(card?.context).toContain('L5');
  });

  it('fragt nicht zweimal, solange die erste Karte offen ist', async () => {
    const id = await propose('Doppelt vorgeschlagen');
    const erst = await proposals.raise(id, RADO);
    expect(erst).not.toBeNull();
    expect(await proposals.raise(id, RADO)).toBeNull();
  });

  it('nimmt die Quelle auf der gewählten Stufe auf — nicht auf der vorgeschlagenen', async () => {
    const id = await propose('Zeitschriftenaufsatz', 5);
    const raised = await proposals.raise(id, RADO);
    const choices = sourceProposalChoices({ proposedLevel: 5, title: 'Zeitschriftenaufsatz' });
    // The middle option: accept, but one level down. It is the case that tells
    // "the chosen index was read" apart from "an acceptance happened".
    const index = choices.findIndex((choice) => choice.act === 'accept' && choice.level === 4);
    expect(index).toBeGreaterThan(0);

    const result = await answer(raised?.number ?? 0, { optionIndex: index });
    expect(result.problems).toEqual([]);
    expect(result.applied.map((entry) => entry.outcome)).toEqual(['accepted']);

    const source = await state(id);
    expect(source.state).toBe('accepted');
    expect(source.proposedLevel).toBe(5);
    expect(source.level).toBe(4);
    expect(checkCitation({ found: true, state: source.state, level: source.level }).ok).toBe(true);
    // the operator's own decision is the note on the record, so a later reader can see
    // which inbox item granted this level.
    expect(source.levelReason ?? '').toBe('');
    const [event] = await sql<Array<{ payload: Record<string, unknown> }>>`
      SELECT payload FROM source_events
      WHERE source_id = ${id} AND kind = 'accepted'
    `;
    expect(String(event?.payload.note)).toContain('Entscheidung #');
  });

  it('nimmt sie NICHT auf, wenn die Karte abgelehnt beantwortet wurde', async () => {
    const id = await propose('Anonymer Forenbeitrag', 4);
    const raised = await proposals.raise(id, RADO);
    const choices = sourceProposalChoices({ proposedLevel: 4, title: 'Anonymer Forenbeitrag' });
    const index = choices.findIndex((choice) => choice.act === 'reject');
    expect(index).toBeGreaterThanOrEqual(0);

    const result = await answer(raised?.number ?? 0, { optionIndex: index });
    expect(result.applied.map((entry) => entry.outcome)).toEqual(['rejected']);

    const source = await state(id);
    expect(source.state).toBe('rejected');
    // The assertion that would go red if the reader read `state === 'answered'`
    // instead of `chosenIndex`: it would have accepted, and both of these would
    // be wrong in the direction §14 cares about.
    expect(source.level).toBeNull();
    expect(checkCitation({ found: true, state: source.state, level: source.level }).ok).toBe(false);
    expect(source.stateReason ?? '').toContain('Entscheidung #');
  });

  it('entscheidet bei reiner Freitextantwort gar nichts', async () => {
    const id = await propose('Unklar beantwortet', 5);
    const raised = await proposals.raise(id, RADO);

    const result = await answer(raised?.number ?? 0, {
      freeText: 'Bitte erst prüfen, ob es eine amtliche Fassung gibt.',
    });
    expect(result.applied.map((entry) => entry.outcome)).toEqual(['unentschieden']);

    const source = await state(id);
    expect(source.state).toBe('proposed');
    expect(source.level).toBeNull();
    // …and it is remembered, so the card is not re-examined on every pass
    // forever — the flood A98 and A101 both ended.
    expect(await curatedRows(id)).toHaveLength(1);
  });

  it('führt eine Karte genau einmal aus, über beliebig viele Durchläufe', async () => {
    const id = await propose('Nur einmal', 4);
    const raised = await proposals.raise(id, RADO);
    await answer(raised?.number ?? 0, { optionIndex: 0 });

    const zweiter = await proposals.applyAnswers();
    expect(zweiter.applied).toEqual([]);
    const dritter = await proposals.applyAnswers();
    expect(dritter.applied).toEqual([]);

    const [row] = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM source_events
      WHERE source_id = ${id} AND kind = 'accepted'
    `;
    expect(Number(row?.count)).toBe(1);
    expect(await curatedRows(id)).toHaveLength(1);
  });

  /**
   * The case `SOURCE_ACTS_BY_STATE` exists for, and the fixture had to be
   * corrected to reach it.
   *
   * The first version rejected the source by hand and then answered the card
   * with "accept" — and that went through, correctly: `rejected → accept` is in
   * the table on purpose ("better evidence arrives"), and answering the card is
   * a *later* act than the hand-rejection. What the guard is for is the other
   * order: The operator accepts on §17.7's page, the card is still open, and answering it
   * would append a second `accepted` row that silently re-levels a source
   * already in the registry. Recorded because the first fixture read like a test
   * of the guard and was a test of nothing.
   */
  it('überspringt eine Karte, deren Quelle inzwischen im Dashboard aufgenommen wurde', async () => {
    const id = await propose('Schon aufgenommen', 5);
    const raised = await proposals.raise(id, RADO);
    // the operator curates it on the Sources page while the card is still open.
    await registry.accept(
      id,
      { level: 3, note: 'Von Hand aufgenommen.' },
      'dashboard:kredential-1',
    );

    const result = await answer(raised?.number ?? 0, { optionIndex: 0 });
    expect(result.applied.map((entry) => entry.outcome)).toEqual(['uebersprungen']);
    expect(result.applied[0]?.detail).toContain('kuratiert');

    // The level he set by hand stands; the card did not quietly raise it to the
    // proposed L5 behind him.
    const source = await state(id);
    expect(source.state).toBe('accepted');
    expect(source.level).toBe(3);
    const [row] = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM source_events
      WHERE source_id = ${id} AND kind = 'accepted'
    `;
    expect(Number(row?.count)).toBe(1);
  });

  /**
   * The other half of the sentence above, and it is the surprising direction.
   *
   * `rejected → accept` is in `SOURCE_ACTS_BY_STATE` deliberately (§14 is
   * curated rather than final), so a hand-rejection does **not** make a
   * still-open card inert — answering it with "Aufnehmen" takes the source in
   * after all. That is right, because the answer is the chronologically later
   * act and both are the operator, but it is a statement about §14's evidence base that
   * a reader would otherwise get backwards from decision 4's first sentence.
   * Named as its own case rather than left in a comment for exactly that reason.
   */
  it('nimmt nach einer Ablehnung von Hand auf, wenn die offene Karte „Aufnehmen" beantwortet wird', async () => {
    const id = await propose('Später doch belegt', 4);
    const raised = await proposals.raise(id, RADO);
    await registry.reject(id, { reason: 'Von Hand abgelehnt.' }, 'dashboard:kredential-1');

    const result = await answer(raised?.number ?? 0, { optionIndex: 0 });
    expect(result.applied.map((entry) => entry.outcome)).toEqual(['accepted']);

    const source = await state(id);
    expect(source.state).toBe('accepted');
    expect(source.level).toBe(4);
    // Both acts stand in the history — the log is what makes the reversal
    // readable a year later rather than a level nobody can account for.
    const detail = await registry.get(id);
    expect(detail?.history.map((entry) => entry.kind)).toEqual([
      'proposed',
      'rejected',
      'accepted',
    ]);
  });

  it('schreibt §19s Prüfpfad mit dem Urheber der Antwort und der Kartennummer', async () => {
    const id = await propose('Mit Prüfpfad', 4);
    const raised = await proposals.raise(id, RADO);
    await answer(raised?.number ?? 0, { optionIndex: 0 });

    const spur = await sql<
      Array<{ action: string; actor: string; after: Record<string, unknown> }>
    >`
      SELECT action, actor, after FROM audit_log WHERE subject = ${id} ORDER BY id
    `;
    expect(spur).toHaveLength(1);
    expect(spur[0]?.action).toBe('source.accepted');
    expect(spur[0]?.actor).toBe('max');
    // The link that makes the two channels distinguishable in the trail: a row
    // without it was somebody pressing a button on §17.7's page.
    expect(spur[0]?.after.escalationNumber).toBe(raised?.number);
  });

  it('schlägt eine Quelle, die nicht mehr vorgeschlagen ist, gar nicht erst vor', async () => {
    const id = await propose('Bereits aufgenommen', 5);
    await registry.accept(id, { level: 5 }, 'max');
    expect(await proposals.raise(id, RADO)).toBeNull();
  });
});
