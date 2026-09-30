/**
 * §14's source registry against a real Postgres (migration 0021).
 *
 * Everything load-bearing here *is* the database. The append-only guarantee is
 * a trigger, "a proposal is the first event" is a CHECK, "a level change
 * carries its reason" is a CHECK, the state is a `DISTINCT ON` over the log and
 * the score is an expression over `now()`. A stubbed store would let every one
 * of those assertions pass against a lie.
 *
 * Four things this suite is built to be able to fail.
 *
 *   1. **The history is the point, so it is asserted station by station.** A
 *      source that was proposed, accepted, promoted and retired has to give all
 *      four back with their timestamps and their actors — not merely "it is
 *      retired now". That is the assertion a stored `status` column cannot
 *      satisfy, and it is what 0021's decision 1 is for. Mutation (a) below is
 *      the state-as-a-column shape, and it reddens exactly this.
 *
 *   2. **Reading writes nothing.** §14's score is recomputed on every read
 *      (0021, decision 3), and the failure mode a written score has is 0014's:
 *      "achtzehn gleiche Zeilen pro Stunde begraben die eine, die etwas sagt".
 *      So the log's row count is asserted across repeated reads, which is the
 *      only assertion that can see a recomputation that decided to remember
 *      itself.
 *
 *   3. **The score is bounded below the next level, and the bound is what makes
 *      it a refinement rather than an override.** A freshly curated L3 must
 *      lose to a four-year-old L4, because §14's citation rule is about the
 *      level and a score that could cross a level would make that rule
 *      advisory. Asserted as an ordering *and* as the arithmetic invariant.
 *
 *   4. **The citation rule is proven end to end.** `resolve` answers in
 *      `checkCitation`'s vocabulary, so the two halves are put together here on
 *      real rows: a retired L5 is not citable, an accepted L4 is, and an id
 *      nobody proposed is a different answer from both.
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import { checkCitation } from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DocumentVault } from '../vault/documents.js';
import { type ProposeSourceSpec, SourceRegistry, SourceRegistryError } from './registry.js';

const url = process.env.TEST_DATABASE_URL;

/** §8's German label for the department that cites Gesetzestexte. */
const LENA = 'Recht';
const MAX = 'max';

function proposal(over: Partial<ProposeSourceSpec> = {}): ProposeSourceSpec {
  return {
    title: 'RIS — Vereinsgesetz 2002',
    url: 'https://www.ris.bka.gv.at/Vereinsgesetz',
    level: 5,
    assessment: 'Amtliche Fassung des Gesetzestextes, primäre Quelle (§14, L5).',
    ...over,
  };
}

describe.skipIf(!url)('Quellenregister (§14)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let registry: SourceRegistry;

  beforeAll(async () => {
    database = await createTestDatabase('sources');
    sql = createSql({ url: database.url, max: 3 });
    registry = new SourceRegistry(sql);
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
  });

  describe('das Log ist append-only, der Zustand wird abgeleitet', () => {
    it('weist UPDATE, DELETE und TRUNCATE ab — auch dem Eigentümer', async () => {
      const source = await registry.propose(proposal(), LENA);
      await expect(sql`UPDATE source_events SET actor = 'gefälscht'`).rejects.toThrow(
        /append-only/i,
      );
      await expect(sql`DELETE FROM source_events`).rejects.toThrow(/append-only/i);
      // A statement-level guard, because a row-level one is structurally blind
      // to TRUNCATE — 0004's reason, and A100.7's coverage gap.
      await expect(sql`TRUNCATE source_events`).rejects.toThrow(/append-only/i);
      expect((await registry.get(source.id))?.history).toHaveLength(1);
    });

    it('nimmt kein Ereignis für eine Quelle an, die niemand vorgeschlagen hat', async () => {
      // Two layers (decision 4): the service says it in German …
      await expect(
        registry.accept('3f1a5b2c-0000-4000-8000-000000000000', { level: 4 }, MAX),
      ).rejects.toThrow(SourceRegistryError);

      // … and the schema says it whatever a caller skipped. With no rows the
      // next seq is 1, and 1 is reserved for the proposal.
      await expect(
        sql`
          INSERT INTO source_events (source_id, seq, kind, actor, level)
          SELECT '3f1a5b2c-0000-4000-8000-000000000000', COALESCE(MAX(seq), 0) + 1,
                 'accepted', ${MAX}, 4
          FROM source_events WHERE source_id = '3f1a5b2c-0000-4000-8000-000000000000'
        `,
      ).rejects.toThrow(/proposal_is_first/);
    });

    it('verlangt eine Begründung für Stufenänderung, Ablehnung und Stilllegung', async () => {
      const source = await registry.propose(proposal(), LENA);
      await registry.accept(source.id, { level: 4 }, MAX);

      await expect(
        registry.changeLevel(source.id, { level: 5, reason: '  ' }, MAX),
      ).rejects.toThrow(/Begründung/);
      await expect(registry.retire(source.id, { reason: '' }, MAX)).rejects.toThrow(/Begründung/);
      await expect(registry.reject(source.id, { reason: '' }, MAX)).rejects.toThrow(/Begründung/);

      // And the schema again, for the same reason as above.
      await expect(
        sql`
          INSERT INTO source_events (source_id, seq, kind, actor, level, payload)
          SELECT ${source.id}, COALESCE(MAX(seq), 0) + 1, 'level_changed', ${MAX}, 5, '{}'::jsonb
          FROM source_events WHERE source_id = ${source.id}
        `,
      ).rejects.toThrow(/reason_where_required/);
    });
  });

  describe('der Verlauf ist der Punkt', () => {
    it('gibt jede Station mit Zeitpunkt und Urheber wieder her und zeigt den heutigen Stand', async () => {
      const source = await registry.propose(
        proposal({ title: 'OWASP Cheat Sheet Series', url: 'https://cheatsheetseries.owasp.org' }),
        'Sicherheit',
      );
      await registry.accept(source.id, { level: 3, note: 'Erst einmal als Sekundärquelle.' }, MAX);
      await registry.changeLevel(
        source.id,
        { level: 4, reason: 'OWASP ist ein anerkanntes Normungsgremium (§14, L4).' },
        MAX,
      );
      const retired = await registry.retire(
        source.id,
        { reason: 'Durch die neue Fassung ersetzt.' },
        MAX,
      );

      const detail = await registry.get(source.id);
      expect(detail).not.toBeNull();
      const history = detail?.history ?? [];

      // All four stations, in order, each with who and when. This is the
      // assertion a `status` column cannot satisfy — mutation (a).
      expect(history.map((entry) => entry.kind)).toEqual([
        'proposed',
        'accepted',
        'level_changed',
        'retired',
      ]);
      expect(history.map((entry) => entry.actor)).toEqual(['Sicherheit', MAX, MAX, MAX]);
      expect(history.map((entry) => entry.level)).toEqual([5, 3, 4, null]);
      for (const entry of history) expect(entry.occurredAt).toBeInstanceOf(Date);
      expect(history[1]?.note).toBe('Erst einmal als Sekundärquelle.');
      expect(history[2]?.reason).toMatch(/Normungsgremium/);
      expect(history[3]?.reason).toBe('Durch die neue Fassung ersetzt.');

      // And the standing today: retired, still carrying the level it was last
      // granted, with the proposal's own assessment beside it.
      expect(retired.state).toBe('retired');
      expect(retired.level).toBe(4);
      expect(retired.proposedLevel).toBe(5);
      expect(retired.levelReason).toMatch(/Normungsgremium/);
      expect(retired.stateReason).toBe('Durch die neue Fassung ersetzt.');
      expect(retired.proposedBy).toBe('Sicherheit');
      expect(retired.curatedBy).toBe(MAX);
    });

    it('behandelt eine Stufenänderung nicht als Zustandswechsel', async () => {
      // Folding `level_changed` into the state would make every promoted source
      // read as being in a state called "level_changed", and §14's citation
      // rule turns on the state.
      const source = await registry.propose(proposal(), LENA);
      await registry.accept(source.id, { level: 4 }, MAX);
      const promoted = await registry.changeLevel(
        source.id,
        { level: 5, reason: 'Amtliche Fassung, primäre Quelle.' },
        MAX,
      );
      expect(promoted.state).toBe('accepted');
      expect(promoted.level).toBe(5);
    });

    it('nimmt eine abgelehnte Quelle nicht auf, und eine erneute Aufnahme ist ein Ereignis mehr', async () => {
      const source = await registry.propose(
        proposal({
          title: 'Ein Forenbeitrag',
          url: 'https://forum.example.org/thread/1',
          level: 2,
        }),
        LENA,
      );
      const rejected = await registry.reject(
        source.id,
        { reason: 'Unklare Herkunft, für Rechtsfragen nicht tragfähig.' },
        MAX,
      );
      expect(rejected.state).toBe('rejected');
      // The level was never granted — a proposal's assessment is not a level.
      expect(rejected.level).toBeNull();
      expect(rejected.proposedLevel).toBe(2);
      expect(rejected.score).toBeNull();
      expect(checkCitation(await registry.resolve(source.id)).ok).toBe(false);

      // §14's lifecycle is a log, not a straight line (0021, decision 8): a
      // rejection on better evidence can be revisited, and the log keeps both.
      const accepted = await registry.accept(source.id, { level: 4 }, MAX);
      expect(accepted.state).toBe('accepted');
      expect((await registry.get(source.id))?.history.map((entry) => entry.kind)).toEqual([
        'proposed',
        'rejected',
        'accepted',
      ]);
    });
  });

  describe('§14s Zahlenscore', () => {
    it('schreibt beim Lesen nichts — auch nicht über viele Aufrufe', async () => {
      // Decision 3 / 0014's failure mode. The score changes while nothing
      // happens (it is a function of `now()`), so a recomputation that decided
      // to remember itself would bury the events that mean something. Nothing
      // but a row count across repeated reads can see that.
      const source = await registry.propose(proposal(), LENA);
      await registry.accept(source.id, { level: 5 }, MAX);
      const before = await eventCount(sql);

      for (let round = 0; round < 5; round += 1) {
        await registry.list();
        await registry.get(source.id);
        await registry.resolve(source.id);
      }

      expect(await eventCount(sql)).toBe(before);
      expect((await registry.get(source.id))?.history).toHaveLength(2);
    });

    it('bleibt zwischen der eigenen Stufe und der nächsten, nie darüber', async () => {
      const source = await registry.propose(proposal(), LENA);
      const accepted = await registry.accept(source.id, { level: 3 }, MAX);
      expect(accepted.score).not.toBeNull();
      const score = accepted.score as number;
      // The invariant that makes the score a refinement of the level rather
      // than a replacement for it.
      expect(score).toBeGreaterThanOrEqual(3);
      expect(score).toBeLessThan(4);
      // Freshly curated is the top of the band: level + RECENCY_WEIGHT.
      expect(score).toBeCloseTo(3.5, 3);
    });

    it('lässt eine frisch kuratierte L3 nicht an einer alten L4 vorbeiziehen', async () => {
      const fresh = await registry.propose(
        proposal({ title: 'Frische L3', url: 'https://example.org/frisch' }),
        LENA,
      );
      await registry.accept(fresh.id, { level: 3 }, MAX);

      const stale = await registry.propose(
        proposal({ title: 'Alte L4', url: 'https://example.org/alt' }),
        LENA,
      );
      await registry.accept(stale.id, { level: 4 }, MAX);
      // Four years of neglect, written straight into the log — the one thing a
      // test cannot do through the service, because the timestamp is the
      // database's. Append-only permits the insert; it forbids changing it.
      await sql`
        INSERT INTO source_events (source_id, seq, kind, actor, level, occurred_at, payload)
        SELECT ${stale.id}, COALESCE(MAX(seq), 0) + 1, 'level_changed', ${MAX}, 4,
               now() - interval '4 years',
               ${sql.json({ reason: 'Turnusmäßig bestätigt.' } as never)}
        FROM source_events WHERE source_id = ${stale.id}
      `;

      const staleRecord = await registry.get(stale.id);
      const freshRecord = await registry.get(fresh.id);
      const staleScore = staleRecord?.source.score as number;
      const freshScore = freshRecord?.source.score as number;

      // Decayed almost to its floor, and still ahead of a perfect L3.
      expect(staleScore).toBeLessThan(4.2);
      expect(freshScore).toBeGreaterThan(3.4);
      expect(staleScore).toBeGreaterThan(freshScore);

      const listed = await registry.list({ state: 'accepted', minLevel: 4 });
      expect(listed.map((entry) => entry.id)).toContain(stale.id);
      expect(listed.map((entry) => entry.id)).not.toContain(fresh.id);
    });

    it('gibt einer Quelle, die nicht im Register steht, keinen Score statt einer Null', async () => {
      // Zero would sort them last, which is a different and wrong statement:
      // they have no place in the order rather than the worst one.
      const source = await registry.propose(proposal(), LENA);
      expect(source.score).toBeNull();
      await registry.accept(source.id, { level: 5 }, MAX);
      const retired = await registry.retire(source.id, { reason: 'Ersetzt.' }, MAX);
      expect(retired.score).toBeNull();
    });
  });

  describe('§14s Zitierregel auf echten Zeilen', () => {
    it('trennt „gibt es nicht" von „ist zu schwach" von „ist stillgelegt"', async () => {
      const unknown = checkCitation(await registry.resolve('9f9f9f9f-0000-4000-8000-00000000ffff'));
      expect(unknown.reason).toBe('unknown');

      const weak = await registry.propose(
        proposal({ title: 'Ein Blogbeitrag', url: 'https://blog.example.org/x', level: 2 }),
        LENA,
      );
      await registry.accept(weak.id, { level: 2 }, MAX);
      const weakCheck = checkCitation(await registry.resolve(weak.id));
      expect(weakCheck.reason).toBe('below_threshold');
      expect(weakCheck.needsCorroboration).toBe(true);

      const strong = await registry.propose(
        proposal({ title: 'RFC 9110', url: 'https://www.rfc-editor.org/rfc/rfc9110' }),
        LENA,
      );
      await registry.accept(strong.id, { level: 4 }, MAX);
      expect(checkCitation(await registry.resolve(strong.id)).ok).toBe(true);

      await registry.retire(strong.id, { reason: 'Durch RFC 9999 ersetzt.' }, MAX);
      const retiredCheck = checkCitation(await registry.resolve(strong.id));
      expect(retiredCheck.ok).toBe(false);
      expect(retiredCheck.reason).toBe('not_accepted');
      // Still L4 — retiring is not a demotion, and saying so keeps the two
      // different curation acts distinguishable a year later.
      expect(retiredCheck.level).toBe(4);
    });
  });

  describe('§13s Verweis-Einträge (A107.7)', () => {
    it('lässt eine Quelle auf ein Tresor-Dokument zeigen, statt umgekehrt', async () => {
      const vault = new DocumentVault(sql);
      const { document } = await vault.create(
        {
          title: 'Vereinsstatuten, Fassung 2024',
          departmentTags: [LENA],
          version: { filename: 'statuten.pdf', storagePath: 'vault/statuten-2024.pdf' },
        },
        MAX,
      );

      const source = await registry.propose(
        { title: 'Vereinsstatuten (Tresor)', documentId: document.id, level: 5 },
        LENA,
      );
      expect(source.documentId).toBe(document.id);
      expect(source.url).toBeNull();

      // The document is not deleted out from under a source that cites it. Both
      // layers say so; this is the one 0021 adds.
      await expect(sql`DELETE FROM documents WHERE id = ${document.id}`).rejects.toThrow(
        /source_events|violates foreign key/i,
      );
    });

    it('verlangt eine Fundstelle und lässt keine erfundene URL zu', async () => {
      await expect(
        registry.propose({ title: 'Irgendwas', level: 3 } as ProposeSourceSpec, LENA),
      ).rejects.toThrow(/Fundstelle/);
      await expect(
        registry.propose(proposal({ url: 'javascript:alert(1)' }), LENA),
      ).rejects.toThrow(/http/);
      await expect(registry.propose(proposal({ level: 6 as never }), LENA)).rejects.toThrow(
        /Vertrauensstufe/,
      );

      // The schema is the second layer, and it refuses the same string.
      await expect(
        sql`
          INSERT INTO source_events (source_id, seq, kind, actor, url, level, payload)
          VALUES (gen_random_uuid(), 1, 'proposed', ${LENA}, 'javascript:alert(1)', 3,
                  ${sql.json({ title: 'x' } as never)})
        `,
      ).rejects.toThrow(/url_shape/);
    });
  });

  describe('auflisten', () => {
    it('filtert nach Zustand, Mindeststufe und URL', async () => {
      const duplicate = 'https://example.org/doppelt';
      const first = await registry.propose(proposal({ url: duplicate, title: 'Erste' }), LENA);
      const second = await registry.propose(proposal({ url: duplicate, title: 'Zweite' }), LENA);

      // Deliberately not refused (0021, decision 8) — a re-proposal of a
      // rejected source is legitimate and an index cannot tell the two apart.
      // What exists instead is the lookup the producer needs.
      const byUrl = await registry.list({ url: duplicate });
      expect(byUrl.map((entry) => entry.id).sort()).toEqual([first.id, second.id].sort());

      const open = await registry.list({ state: 'proposed', url: duplicate });
      expect(open).toHaveLength(2);
      expect(await registry.list({ state: 'accepted', url: duplicate })).toHaveLength(0);
    });
  });
});

async function eventCount(sql: postgres.Sql): Promise<number> {
  const [row] = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM source_events`;
  return row?.count ?? 0;
}
