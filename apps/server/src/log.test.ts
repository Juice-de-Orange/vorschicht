import { readFileSync } from 'node:fs';
import { EVENT_KINDS } from '@vorschicht/shared/events';
import { logStufe } from '@vorschicht/shared/log';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { artenDerStufe, LOG_VOLLTEXT_AUSDRUCK } from './log.js';

/**
 * §18s Log-Explorer, in dem Teil, der ohne Datenbank prüfbar ist.
 *
 * Was hier steht, sind zwei Dinge, die still falsch wären: ein Stufenfilter, der
 * die falsche Menge Arten trifft, und ein Volltextausdruck, der von seinem Index
 * abweicht — die Abfrage bliebe dabei **korrekt** und würde nur langsam, was die
 * unangenehmere Richtung ist, weil nichts rot wird.
 */

describe('der Stufenfilter', () => {
  /**
   * Die Menge wird aus `EVENT_LEVELS` abgeleitet und nicht in SQL nachgebaut
   * (A81). Der Fall hält fest, dass die Ableitung eine **Partition** ist: jede
   * Art gehört zu genau einer Stufe, und keine fällt zwischen die drei Mengen.
   */
  it('teilt alle Ereignisarten auf genau drei Mengen auf', () => {
    const alarm = artenDerStufe('alarm');
    const warnung = artenDerStufe('warnung');
    const info = artenDerStufe('info');
    expect(alarm.length + warnung.length + info.length).toBe(EVENT_KINDS.length);
    expect(new Set([...alarm, ...warnung, ...info]).size).toBe(EVENT_KINDS.length);
    for (const kind of alarm) expect(logStufe(kind)).toBe('alarm');
  });

  /**
   * Ohne Stufenfilter darf die Menge **leer** sein — der Aufrufer setzt die
   * Bedingung dann gar nicht. Eine nicht-leere Menge hier wäre ein Filter, den
   * niemand angefordert hat.
   */
  it('ist ohne gewählte Stufe leer', () => {
    expect(artenDerStufe(null)).toEqual([]);
  });

  it('trifft nicht versehentlich alles', () => {
    expect(artenDerStufe('alarm').length).toBeGreaterThan(0);
    expect(artenDerStufe('alarm').length).toBeLessThan(EVENT_KINDS.length);
  });
});

describe('der Volltextausdruck', () => {
  /**
   * Die Zusicherung, die A81s Klasse hier schliesst.
   *
   * Migration 0023 legt einen **Ausdrucksindex** an; Postgres benutzt ihn nur,
   * wenn die Abfrage denselben Ausdruck schreibt. Weichen die beiden ab, bleibt
   * das Ergebnis richtig und der Scan wird voll — ein Defekt, den kein Test
   * bemerkt, der nur auf das Ergebnis sieht.
   */
  it('steht in der Abfrage wörtlich so wie im Index von 0023', () => {
    const migration = readFileSync('packages/db/migrations/0023_event_log_search.sql', 'utf8');
    expect(migration).toContain(LOG_VOLLTEXT_AUSDRUCK);
  });

  it('steht auch in der Abfrage selbst und nicht nur in der Konstante', () => {
    // Die Konstante ist heute für den Test da; die Abfrage schreibt den Ausdruck
    // aus, weil `postgres` ein Fragment und kein Literal einsetzen würde. Beide
    // müssen übereinstimmen, sonst prüft der Fall darüber eine Zeichenkette, die
    // niemand ausführt.
    const modul = readFileSync('apps/server/src/log.ts', 'utf8');
    expect(modul).toContain(`jsonb_to_tsvector('simple', payload, '["all"]')\n`);
  });
});

describe('die Route', () => {
  const app = (
    antwort: Awaited<ReturnType<NonNullable<Parameters<typeof createApp>[0]['log']>>>,
    session = true,
  ) =>
    createApp({
      health: { startedAt: Date.now(), pingDatabase: async () => {} },
      getSession: async () => (session ? { userId: 'cred-abc' } : null),
      log: async () => antwort,
    });

  it('antwortet unter dem Pfad, den die Seite abruft', async () => {
    const response = await app({ ok: true, value: { log: { eintraege: [] } } }).request('/api/log');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ log: { eintraege: [] } });
  });

  /**
   * §19s Vorgabe-Verweigerung: das Protokoll steht hinter der Sitzung wie alles
   * andere. Es trägt Projektnamen, Aufgabentitel und Nutzlasten — genau das,
   * was `/healthz` einem anonymen Aufrufer bewusst vorenthält.
   */
  it('ist ohne Sitzung 401', async () => {
    const response = await app({ ok: true, value: { log: {} } }, false).request('/api/log');
    expect(response.status).toBe(401);
  });

  it('macht aus einem Lesefehler einen deutschen 500 statt eines nackten Stacks', async () => {
    const response = await app({
      ok: false,
      reason: 'failed',
      errors: ['Das Protokoll konnte nicht gelesen werden: Datenbank weg'],
    }).request('/api/log');
    expect(response.status).toBe(500);
    const koerper = (await response.json()) as { errors: string[] };
    expect(koerper.errors[0]).toContain('Datenbank weg');
    expect(koerper.errors[0]).not.toMatch(/\bError\b/);
  });
});
