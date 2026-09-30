/**
 * Der Rauschfilter des Log-Explorers gegen eine echte Datenbank (§18, A149).
 *
 * `log.test.ts` fährt den Adapter gegen eine Attrappe und beweist damit die
 * Verzweigungen. Was eine Attrappe nicht beweisen kann, ist genau das, worum es
 * hier geht: **welche Zeilen das Prädikat wirklich zurückhält**. Es ist ein
 * `NOT (… AND … AND payload ->> 'resolved' IS NULL)` über echtes JSONB, und ob
 * es die richtige Teilmenge trifft, weiß nur Postgres.
 *
 * Der Fall, gegen den dieser Test gebaut ist, ist eingetreten: bis A149 verbarg
 * die Vorgabe die **ganze** Art `guardian.anomaly`. Unter ihr melden aber auch
 * `wrap_up_failed` und `pause_unreadable` — „Das Aufräumprotokoll ist
 * fehlgeschlagen — Aufgaben prüfen" stand hinter einem Schalter, den man erst
 * umlegen muss. Das ist A67.6 wörtlich: ein Kanal, der zu viel meldet, wird
 * stummgeschaltet, und dann ist die nächste echte Meldung unsichtbar.
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listLog } from './log.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Log-Rauschfilter über echte Zeilen', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;

  beforeAll(async () => {
    database = await createTestDatabase('logfilter');
    sql = createSql({ url: database.url, max: 2 });

    const zeile = (payload: Record<string, unknown>) =>
      sql`INSERT INTO event_log (kind, actor, payload)
          VALUES ('guardian.anomaly', 'controlling', ${sql.json(payload as postgres.JSONValue)})`;

    // Die Flut, in ihrer alten Form: kein `resolved`.
    await zeile({ reason: 'meter_divergence', officialPercent: 71, estimatedPercent: 1.2 });
    await zeile({ reason: 'rate_limits_unavailable' });
    // Eine Übergangsmeldung derselben Gründe — selten und informativ.
    await zeile({ reason: 'meter_divergence', scope: 'seven_day', resolved: false });
    // Und die Alarme, die unter derselben Art melden.
    await zeile({ kind: 'wrap_up_failed', reason: 'guardian_wrap_up', error: 'kaputt' });
    await zeile({ kind: 'pause_unreadable', error: 'unlesbar' });
    await zeile({ reason: 'scale_mismatch', readings: [] });
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
  });

  const antwort = async (params = '') => {
    const ergebnis = await listLog({ sql }, new URLSearchParams(params));
    if (!ergebnis.ok) throw new Error(`Lesefehler: ${ergebnis.errors.join(', ')}`);
    return ergebnis.value.log;
  };

  /** Der Grund je sichtbarer Zeile — `reason` oder, bei den Alarmen, `kind`. */
  const gruende = async (params = '') => {
    const log = await antwort(params);
    return log.eintraege.map((z) => {
      const p = (z.payload ?? {}) as Record<string, unknown>;
      // Die Alarme benennen sich in `payload.kind` und tragen daneben ein
      // `reason`, das den Wrap-up-Auslöser meint — zwei Schlüssel, zwei
      // Bedeutungen, in derselben Ereignisart. `kind` zuerst zu lesen ist
      // deshalb das Richtige und nicht der Zufall, der es beim ersten Anlauf
      // war.
      return p.kind ?? p.reason;
    });
  };

  it('hält die beiden Vielschreiber der Flut zurück', async () => {
    const sichtbar = await gruende();
    expect(sichtbar).not.toContain('rate_limits_unavailable');
    // Die alte Divergenzzeile ist weg — die Übergangszeile desselben Grundes
    // aber nicht, und beide zu unterscheiden ist der Zweck der `resolved`-Marke.
    expect(sichtbar.filter((g) => g === 'meter_divergence')).toHaveLength(1);
  });

  it('zeigt die Alarme derselben Art weiterhin — das ist der eigentliche Fund', async () => {
    const sichtbar = await gruende();
    expect(sichtbar).toContain('wrap_up_failed');
    expect(sichtbar).toContain('pause_unreadable');
    expect(sichtbar).toContain('scale_mismatch');
  });

  it('zeigt mit umgelegtem Schalter alles', async () => {
    const alle = await gruende('rauschen=1');
    expect(alle).toContain('rate_limits_unavailable');
    expect(alle.filter((g) => g === 'meter_divergence')).toHaveLength(2);
    expect(alle).toHaveLength(6);
  });
});
