/**
 * Integration test for the event log and its NOTIFY fan-out (migration 0005).
 *
 * Unit tests can prove the hub formats frames correctly; only this can prove
 * that inserting a row actually reaches a listener. §4 makes that chain — event
 * → NOTIFY → SSE → dashboard — the way the operator sees anything at all, so the link
 * that crosses the database boundary deserves a real database.
 *
 * Its **own** database, specifically. This file listens on a channel and then
 * asserts exactly how many notifications arrived; on the shared test database
 * that assertion is a statement about every other test file running at the same
 * moment, and `schema.itest.ts` inserts into `event_log` too. It failed roughly
 * one full-suite run in three and never on its own — which is the signature of
 * shared state, not of a timing bug.
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EVENT_CHANNEL, EventLog, parseEventNotification } from './event-log.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Ereignisprotokoll und NOTIFY', () => {
  let sql: postgres.Sql;
  let listener: postgres.Sql;
  let database: TestDatabase;
  let log: EventLog;

  beforeAll(async () => {
    database = await createTestDatabase('eventlog');
    sql = createSql({ url: database.url, max: 2 });
    listener = createSql({ url: database.url, max: 1 });
    log = new EventLog(sql);
  }, 60_000);

  afterAll(async () => {
    await listener?.end();
    await sql?.end();
    await database?.drop();
  });

  it('schreibt ein Ereignis und liefert es per NOTIFY aus', async () => {
    const received: string[] = [];
    const subscription = await listener.listen(EVENT_CHANNEL, (raw) => received.push(raw));

    const id = await log.append({
      kind: 'guardian.state_changed',
      actor: 'system',
      payload: { state: 'wrap_up', usedPercent: 86.5 },
    });

    const deadline = Date.now() + 3000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await subscription.unlisten();

    expect(received).toHaveLength(1);
    const notification = parseEventNotification(received[0] as string);
    expect(notification?.id).toBe(id);
    expect(notification?.kind).toBe('guardian.state_changed');
  });

  // NOTIFY is capped at 8000 bytes. Carrying the payload would work in testing
  // and then fail at runtime on exactly the interesting events — a big diff, a
  // gate output. The trigger sends identifiers only; the hub reads the row.
  it('bleibt zustellbar, auch wenn die Nutzlast das NOTIFY-Limit sprengen würde', async () => {
    const received: string[] = [];
    const subscription = await listener.listen(EVENT_CHANNEL, (raw) => received.push(raw));

    const id = await log.append({
      kind: 'gate.finished',
      actor: 'system',
      payload: { output: 'x'.repeat(50_000) },
    });

    const deadline = Date.now() + 3000;
    while (received.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    await subscription.unlisten();

    expect(received).toHaveLength(1);
    expect((received[0] as string).length).toBeLessThan(8000);
    const full = await log.byId(id);
    expect(full).not.toBeNull();
    expect((full?.payload.output as string | undefined)?.length).toBe(50_000);
  });

  it('holt genau die Ereignisse nach, die ein Client verpasst hat', async () => {
    const before = await log.append({ kind: 'run.created', actor: 'system' });
    const first = await log.append({ kind: 'run.started', actor: 'system' });
    const second = await log.append({ kind: 'run.finished', actor: 'system' });

    const missed = await log.since(before);
    const ids = missed.map((event) => event.id);
    expect(ids).toContain(first);
    expect(ids).toContain(second);
    expect(ids).not.toContain(before);
    // Oldest first: the dashboard appends rather than sorts.
    expect(Number(ids[0])).toBeLessThan(Number(ids[ids.length - 1]));
  });

  it('liefert den Schnappschuss neueste zuerst', async () => {
    const newest = await log.append({ kind: 'system.started', actor: 'system' });
    const recent = await log.recent(5);
    expect(recent[0]?.id).toBe(newest);
  });

  it('weist unbekannte Ereignisarten schon in der Datenbank ab', async () => {
    await expect(
      sql`INSERT INTO event_log (kind, actor) VALUES ('Grossbuchstaben.Verboten', 'system')`,
    ).rejects.toThrow(/event_log_kind_format/);
  });
});
