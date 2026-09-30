/**
 * §14's registry over HTTP, against a real Postgres and the real routes.
 *
 * `quellen.test.ts` proves the transport against a fake. It cannot answer the
 * question this file exists for, because that question is about a **row in
 * another table**: `SourceRegistry` deliberately writes no `audit_log` entry and
 * its header hands the obligation to whoever builds the route —
 *
 *   "§19 wants an `audit_log` row for every *dashboard action*, and the operator
 *   accepting or promoting a source on the Sources page is one. […] Wer die
 *   Route baut, muss die Zeile dort erzeugen. Fällt sie aus, fällt sie
 *   ausgerechnet in dem Teil des Registers aus, den §14 zur Evidenzgrundlage
 *   für Legal-Zitate macht."
 *
 * So the load-bearing assertion here is not that a curation worked; it is that
 * the trail behind it names **the session** — `dashboard:<credentialId>`, never
 * `system` — and that the two writes are one act. Everything else in this file
 * is the smallest set of cases that keeps that assertion honest: a refusal must
 * leave no source event *and* no audit row, or "the trail is complete" would be
 * true only for the paths somebody remembered.
 */
import { randomUUID } from 'node:crypto';
import { SourceAuditLog, SourceRegistry } from '@vorschicht/core';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import { QUELLEN_API, quellenListResponse, quelleResponse } from '@vorschicht/shared/quellen';
import type { Hono } from 'hono';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { curateSource, getSource, listSources, type QuellenDeps } from './quellen.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Quellenregister über HTTP (§14, §17.7)', () => {
  let database: TestDatabase;
  let sql: postgres.Sql;
  let app: Hono;

  /** What `/api/me` would report for this browser — the actor the trail must name. */
  const SESSION = 'kredential-quellen-9';
  const ACTOR = `dashboard:${SESSION}`;

  beforeAll(async () => {
    database = await createTestDatabase('server_quellen');
    sql = createSql({ url: database.url, max: 4 });

    // The wiring `apps/server/src/main.ts` uses, verbatim: reading on the pool,
    // writing in a transaction that carries the registry *and* §19's trail. A
    // fixture that wired two independent handles would pass every assertion
    // below while leaving the guarantee those two lines exist for untested.
    const quellen: QuellenDeps = {
      registry: new SourceRegistry(sql),
      curate: (fn) =>
        sql.begin((tx) =>
          fn({ registry: new SourceRegistry(tx), audit: new SourceAuditLog(tx) }),
        ) as ReturnType<typeof fn>,
    };

    app = createApp({
      health: { startedAt: Date.now(), pingDatabase: async () => {} },
      getSession: async () => ({ userId: SESSION }),
      quellen: {
        list: (params) => listSources(quellen, params),
        get: (id) => getSource(quellen, id),
        curate: (id, segment, input, actor) => curateSource(quellen, id, segment, input, actor),
      },
    });
  });

  afterAll(async () => {
    await sql?.end({ timeout: 5 });
    await database?.drop();
  });

  /**
   * A proposed source, seeded through the registry rather than through raw SQL.
   *
   * The registry is the proven producer here (`registry.itest.ts`), and a
   * fixture that hand-wrote `source_events` could seat a defect in it and let it
   * pass in the same run. The dashboard has no propose route on purpose (§14's
   * proposals come from departments), so this is the only honest way in.
   */
  async function proposed(title: string, level = 5): Promise<string> {
    const registry = new SourceRegistry(sql);
    const source = await registry.propose(
      {
        title,
        url: `https://www.ris.bka.gv.at/${randomUUID()}`,
        level: level as 1 | 2 | 3 | 4 | 5,
        assessment: 'Amtliche Fassung, primäre Quelle (§14).',
      },
      'Recht',
    );
    return source.id;
  }

  async function post(path: string, body: unknown) {
    return app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  async function trail(sourceId: string) {
    return sql<Array<{ action: string; actor: string; after: Record<string, unknown> }>>`
      SELECT action, actor, after FROM audit_log WHERE subject = ${sourceId} ORDER BY id
    `;
  }

  async function eventCount(sourceId: string): Promise<number> {
    const [row] = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM source_events WHERE source_id = ${sourceId}
    `;
    return Number(row?.count ?? 0);
  }

  it('schreibt für jede Kuratierung eine audit_log-Zeile mit der Sitzung als Urheber (§19)', async () => {
    const id = await proposed('RIS — Vereinsgesetz 2002');

    const angenommen = await post(QUELLEN_API.act(id, 'accept'), { level: 4, note: 'geprüft' });
    expect(angenommen.status).toBe(200);

    const hoch = await post(QUELLEN_API.act(id, 'level'), {
      level: 5,
      reason: 'Amtlicher Volltext, RIS ist die primäre Fundstelle.',
    });
    expect(hoch.status).toBe(200);

    const spur = await trail(id);
    expect(spur.map((zeile) => zeile.action)).toEqual(['source.accepted', 'source.level_changed']);
    // The whole point of the file: **the session**, not the service's default.
    // Asserted as an equality against the credential this app reports rather
    // than as "not system", so a future default of `dashboard:unbekannt` would
    // not slip through.
    expect(spur.map((zeile) => zeile.actor)).toEqual([ACTOR, ACTOR]);
    expect(ACTOR).not.toContain('system');

    // And the row says what was granted, so "which level replaced which" is
    // answerable from the trail alone rather than by joining back into a log the
    // reader may not have.
    expect(spur.at(-1)?.after.level).toBe(5);
    expect(spur.at(-1)?.after.state).toBe('accepted');
  });

  it('nimmt eine Quelle auf der gewählten Stufe auf, nicht auf der vorgeschlagenen', async () => {
    // §14 has the operator "decide inclusion", which is a second act after the
    // department's assessment — so an acceptance that inherited the proposal's
    // level would make the common case an edit rather than an answer.
    const id = await proposed('Blogbeitrag zur Vereinsreform', 5);
    const res = await post(QUELLEN_API.act(id, 'accept'), { level: 3 });
    expect(res.status).toBe(200);

    const body = quelleResponse.parse(await res.json());
    expect(body.quelle.source.proposedLevel).toBe(5);
    expect(body.quelle.source.level).toBe(3);
    // §14's citation rule, applied by the one function that owns it.
    expect(body.quelle.source.citable).toBe(false);
  });

  it('gibt den Verlauf mit Urheber und Begründung zurück — der Beleg hinter der Stufe', async () => {
    const id = await proposed('OWASP ASVS');
    await post(QUELLEN_API.act(id, 'accept'), { level: 4 });
    await post(QUELLEN_API.act(id, 'level'), { level: 5, reason: 'Als Norm anerkannt.' });
    await post(QUELLEN_API.act(id, 'retire'), { reason: 'Durch die Nachfolgefassung ersetzt.' });

    const body = quelleResponse.parse(await (await app.request(QUELLEN_API.source(id))).json());
    const verlauf = body.quelle.history;
    expect(verlauf.map((eintrag) => eintrag.kind)).toEqual([
      'proposed',
      'accepted',
      'level_changed',
      'retired',
    ]);
    expect(verlauf.map((eintrag) => eintrag.seq)).toEqual([1, 2, 3, 4]);
    expect(verlauf[0]?.actor).toBe('Recht');
    expect(verlauf[1]?.actor).toBe(ACTOR);
    expect(verlauf[2]?.label).toBe('auf L5 gesetzt');
    expect(verlauf[2]?.reason).toBe('Als Norm anerkannt.');
    expect(verlauf.at(-1)?.reason).toBe('Durch die Nachfolgefassung ersetzt.');
    // Retiring keeps the level it was granted and stops being citable through
    // its *state* — the distinction `SourceRegistry.retire` is built on.
    expect(body.quelle.source.level).toBe(5);
    expect(body.quelle.source.citable).toBe(false);
  });

  it('weist einen Akt ab, den der Zustand nicht zulässt — mit 409 und ohne Spur', async () => {
    const id = await proposed('Stack-Overflow-Antwort');
    await post(QUELLEN_API.act(id, 'accept'), { level: 2 });
    const vorher = await eventCount(id);
    const spurVorher = (await trail(id)).length;

    // A page opened before the acceptance still offers "Aufnehmen". A second
    // `accepted` row would be individually valid and jointly meaningless.
    const res = await post(QUELLEN_API.act(id, 'accept'), { level: 3 });
    expect(res.status).toBe(409);
    const koerper = (await res.json()) as { errors: string[] };
    expect(koerper.errors[0]).toContain('aufgenommen');
    expect(koerper.errors[0]).toContain('Stufe ändern');

    expect(await eventCount(id)).toBe(vorher);
    expect((await trail(id)).length).toBe(spurVorher);
  });

  it('weist eine unbrauchbare Eingabe mit 422 ab und schreibt nichts', async () => {
    const id = await proposed('Forenbeitrag');
    const vorher = await eventCount(id);

    // §14 has five levels; a sixth would rank above L5 and be citable by every
    // rule written against `>= 4`.
    const stufe = await post(QUELLEN_API.act(id, 'accept'), { level: 6 });
    expect(stufe.status).toBe(422);
    expect(((await stufe.json()) as { errors: string[] }).errors[0]).toContain('L1 bis L5');

    // A rejection without a reason is the one thing 0021's CHECK also refuses,
    // and both layers have to say so — the service is the friendly half.
    const grund = await post(QUELLEN_API.act(id, 'reject'), { reason: '   ' });
    expect(grund.status).toBe(422);
    expect(((await grund.json()) as { errors: string[] }).errors[0]).toContain('Begründung');

    expect(await eventCount(id)).toBe(vorher);
    expect((await trail(id)).length).toBe(0);
  });

  it('antwortet 404 auf eine unbekannte Kennung und auf einen unbekannten Akt', async () => {
    const id = await proposed('Irgendeine Quelle');
    expect((await app.request(QUELLEN_API.source('kaputt'))).status).toBe(404);
    expect(
      (await app.request(QUELLEN_API.source('00000000-0000-4000-8000-000000000000'))).status,
    ).toBe(404);
    // A segment that names no act is a route that does not exist, not a body
    // that is wrong — and it must not reach the registry at all.
    expect((await post(`/api/quellen/${id}/vernichten`, { reason: 'weg' })).status).toBe(404);
    expect(await eventCount(id)).toBe(1);
  });

  it('filtert die Liste nach Zustand und Mindeststufe', async () => {
    const hoch = await proposed('Amtliche Norm');
    await post(QUELLEN_API.act(hoch, 'accept'), { level: 5 });
    const niedrig = await proposed('Community-Notiz');
    await post(QUELLEN_API.act(niedrig, 'accept'), { level: 2 });

    const alle = quellenListResponse.parse(
      await (await app.request(`${QUELLEN_API.list}?zustand=accepted`)).json(),
    );
    const ids = alle.quellen.map((quelle) => quelle.id);
    expect(ids).toContain(hoch);
    expect(ids).toContain(niedrig);

    const zitierbar = quellenListResponse.parse(
      await (await app.request(`${QUELLEN_API.list}?zustand=accepted&abstufe=4`)).json(),
    );
    const zitierbareIds = zitierbar.quellen.map((quelle) => quelle.id);
    expect(zitierbareIds).toContain(hoch);
    expect(zitierbareIds).not.toContain(niedrig);
    // Everything §14 admits for a citation, and nothing else.
    expect(zitierbar.quellen.every((quelle) => quelle.citable)).toBe(true);
  });
});
