/**
 * §14's registry as a transport (§17.7) — the half that needs no database.
 *
 * `quellen.itest.ts` puts the real registry, the real transaction and §19's real
 * row together and asserts what lands in Postgres. This file asserts the things
 * that are decisions of *this* layer and would be invisible there, because a
 * green route hides them: which refusal wins when two apply, that a refused act
 * never reaches the registry at all, and that the actor travelling into the
 * audit row is the one the route was handed rather than a default.
 *
 * The fake is built from the same interfaces the real wiring satisfies
 * (`QuellenWriter`, `SourceAuditTrail`), so a signature that drifts breaks here
 * rather than being differently correct (A57.6).
 */
import type { SourceAuditEntry, SourceDetail, SourceRecord } from '@vorschicht/core';
import { SourceRegistryError } from '@vorschicht/core';
import { QUELLEN_API, SOURCE_ACT_SEGMENTS } from '@vorschicht/shared/quellen';
import { describe, expect, it } from 'vitest';
import {
  curateSource,
  getSource,
  listSources,
  type QuellenDeps,
  type QuellenTransaction,
  type QuellenWriter,
} from './quellen.js';

const ID = '11111111-2222-4333-8444-555555555555';

function record(over: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: ID,
    url: 'https://www.ris.bka.gv.at/Vereinsgesetz',
    documentId: null,
    title: 'RIS — Vereinsgesetz 2002',
    assessment: 'Amtliche Fassung.',
    proposedLevel: 5,
    level: null,
    state: 'proposed',
    stateReason: null,
    levelReason: null,
    proposedAt: new Date('2026-08-01T10:00:00Z'),
    proposedBy: 'Recht',
    curatedAt: null,
    curatedBy: null,
    score: null,
    ...over,
  };
}

interface Spur {
  calls: string[];
  audits: SourceAuditEntry[];
  transactions: number;
}

/** A registry and a trail that record what they were asked, and nothing else. */
function fake(
  source: SourceRecord,
  over: { failAt?: 'accept' | 'audit' | 'begin' } = {},
): { deps: QuellenDeps; spur: Spur } {
  const spur: Spur = { calls: [], audits: [], transactions: 0 };
  let current = source;

  const writer: QuellenWriter = {
    list: async () => [current],
    get: async (id) =>
      id === current.id ? ({ source: current, history: [] } satisfies SourceDetail) : null,
    accept: async (_id, input, actor) => {
      spur.calls.push(`accept:${input.level}:${actor}`);
      if (over.failAt === 'accept') {
        throw new SourceRegistryError('kaputt', 'invalid_level');
      }
      current = { ...current, state: 'accepted', level: input.level };
      return current;
    },
    reject: async (_id, input, actor) => {
      spur.calls.push(`reject:${input.reason}:${actor}`);
      current = { ...current, state: 'rejected', stateReason: input.reason };
      return current;
    },
    changeLevel: async (_id, input, actor) => {
      spur.calls.push(`level:${input.level}:${actor}`);
      current = { ...current, level: input.level, levelReason: input.reason };
      return current;
    },
    retire: async (_id, input, actor) => {
      spur.calls.push(`retire:${input.reason}:${actor}`);
      current = { ...current, state: 'retired', stateReason: input.reason };
      return current;
    },
  };

  const transaction: QuellenTransaction = {
    registry: writer,
    audit: {
      record: async (entry) => {
        if (over.failAt === 'audit') throw new Error('audit_log nicht schreibbar');
        spur.audits.push(entry);
      },
    },
  };

  return {
    spur,
    deps: {
      registry: writer,
      curate: async (fn) => {
        spur.transactions += 1;
        if (over.failAt === 'begin') throw new Error('keine Verbindung');
        return fn(transaction);
      },
    },
  };
}

describe('Quellenregister über HTTP (§17.7)', () => {
  it('reicht den Akt und die Sitzung an das Register und an §19s Spur durch', async () => {
    const { deps, spur } = fake(record());
    const res = await curateSource(
      deps,
      ID,
      SOURCE_ACT_SEGMENTS.accept,
      { level: 4, note: 'geprüft' },
      'dashboard:kredential-7',
    );

    expect(res.ok).toBe(true);
    expect(spur.calls).toEqual(['accept:4:dashboard:kredential-7']);
    expect(spur.audits).toHaveLength(1);
    expect(spur.audits[0]?.actor).toBe('dashboard:kredential-7');
    expect(spur.audits[0]?.act).toBe('accept');
    // `before` is the standing the act was applied to, `after` what it produced
    // — the pair is what makes "which level replaced which" answerable from the
    // trail alone.
    expect(spur.audits[0]?.before?.state).toBe('proposed');
    expect(spur.audits[0]?.after.level).toBe(4);
  });

  it('führt Akt und Prüfpfad in einer Transaktion aus', async () => {
    const { deps, spur } = fake(record());
    await curateSource(deps, ID, SOURCE_ACT_SEGMENTS.accept, { level: 5 }, 'dashboard:k');
    // One `curate`, both writes inside it. Two would be the gap decision 2
    // exists to close, and only a count can see the difference.
    expect(spur.transactions).toBe(1);
  });

  it('weist einen Akt ab, den der Zustand nicht zulässt — und ruft das Register gar nicht', async () => {
    const { deps, spur } = fake(record({ state: 'accepted', level: 4 }));
    const res = await curateSource(deps, ID, SOURCE_ACT_SEGMENTS.accept, { level: 5 }, 'max');

    expect(res).toMatchObject({ ok: false, reason: 'conflict' });
    // The load-bearing half: nothing was attempted. A 409 that had already
    // written a row would be a refusal in name only.
    expect(spur.calls).toEqual([]);
    expect(spur.transactions).toBe(0);
    expect(spur.audits).toEqual([]);
  });

  it('prüft den Zustand vor dem Rumpf, nicht danach', async () => {
    // Both are wrong: the act is impossible *and* the body is unusable. A caller
    // holding a stale page has nothing to fix in the body, so sending them to
    // correct it would be the least useful answer available (`answerEscalation`).
    const { deps } = fake(record({ state: 'retired', level: 4 }));
    const res = await curateSource(deps, ID, SOURCE_ACT_SEGMENTS.retire, {}, 'max');
    expect(res).toMatchObject({ ok: false, reason: 'conflict' });
    if (!res.ok) expect(res.errors[0]).toContain('stillgelegt');
  });

  it('weist einen unbekannten Akt und eine unbrauchbare Kennung als 404-Fall aus', async () => {
    const { deps, spur } = fake(record());
    expect(await curateSource(deps, ID, 'vernichten', {}, 'max')).toMatchObject({
      ok: false,
      reason: 'unknown',
    });
    expect(await curateSource(deps, 'kaputt', SOURCE_ACT_SEGMENTS.accept, {}, 'max')).toMatchObject(
      { ok: false, reason: 'unknown' },
    );
    expect(await getSource(deps, 'kaputt')).toMatchObject({ ok: false, reason: 'unknown' });
    expect(spur.calls).toEqual([]);
  });

  it('meldet eine unbrauchbare Eingabe als 422 mit dem deutschen Satz der Regel', async () => {
    const { deps, spur } = fake(record());
    const res = await curateSource(deps, ID, SOURCE_ACT_SEGMENTS.reject, { reason: '' }, 'max');
    expect(res).toMatchObject({ ok: false, reason: 'invalid' });
    if (!res.ok) expect(res.errors[0]).toContain('Begründung');
    expect(spur.calls).toEqual([]);
  });

  it('übersetzt eine Ablehnung des Registers, statt sie durchzuwerfen', async () => {
    // There is no `app.onError` in this app, so a throw is a plain-text 500 with
    // an English stack. The registry's own German sentence travels instead.
    const { deps } = fake(record(), { failAt: 'accept' });
    const res = await curateSource(deps, ID, SOURCE_ACT_SEGMENTS.accept, { level: 4 }, 'max');
    expect(res).toMatchObject({ ok: false, reason: 'invalid' });
    if (!res.ok) expect(res.errors).toEqual(['kaputt']);
  });

  it('meldet einen gescheiterten Prüfpfad als Serverfehler auf Deutsch', async () => {
    const { deps } = fake(record(), { failAt: 'audit' });
    const res = await curateSource(deps, ID, SOURCE_ACT_SEGMENTS.accept, { level: 4 }, 'max');
    expect(res).toMatchObject({ ok: false, reason: 'failed' });
    if (!res.ok) expect(res.errors[0]).toContain('nichts geändert');
  });

  it('stellt die Liste mit Zustandswort, Akten und §14s Zitierregel zusammen', async () => {
    const { deps } = fake(record({ state: 'accepted', level: 4, score: 4.5 }));
    const res = await listSources(deps, new URLSearchParams());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const [quelle] = res.value.quellen;
    expect(quelle?.stateLabel).toBe('aufgenommen');
    expect(quelle?.acts).toEqual(['level', 'retire']);
    expect(quelle?.citable).toBe(true);
    expect(quelle?.score).toBe(4.5);
  });

  it('nennt eine aufgenommene L3-Quelle nicht zitierfähig (§14)', async () => {
    const { deps } = fake(record({ state: 'accepted', level: 3, score: 3.5 }));
    const res = await listSources(deps, new URLSearchParams());
    if (!res.ok) throw new Error('unerwartet');
    expect(res.value.quellen[0]?.citable).toBe(false);
  });

  it('baut jeden Routenpfad aus einer Stelle', async () => {
    // A81.3's smallest possible version: the builder and the segment table are
    // the only place these words exist, so a renamed segment cannot leave the
    // page posting where the server does not listen.
    expect(QUELLEN_API.act(ID, 'level')).toBe(`/api/quellen/${ID}/stufe`);
    expect(QUELLEN_API.source(ID)).toBe(`/api/quellen/${ID}`);
  });
});
