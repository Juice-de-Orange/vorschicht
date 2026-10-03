import { describe, expect, it } from 'vitest';
import {
  AUTH_VORFALL_AKTUELL_MS,
  type AuthVorfallBeobachtung,
  alter,
  authVorfall,
  PLATTE_VERALTET_MS,
  plattenKachel,
  SICHERUNG_VERALTET_MS,
  type SicherungBeobachtung,
  sicherungKachel,
} from './betrieb.js';

/**
 * §18s Ops-Kacheln, in ihrer reinen Hälfte.
 *
 * Die eine Eigenschaft, die diese Datei wirklich trägt, ist A103s Ausfallbild:
 * der Sidecar starb, die letzte Zeile im Protokoll blieb `ok`, und **niemand
 * hat sieben Nächte lang etwas gemerkt**. Eine Kachel, die nur die letzte Zeile
 * liest, meldet in genau diesem Fall für immer Ruhe. Alles Übrige hier ist
 * Beiwerk gegen diesen einen Fall.
 */

const JETZT = Date.parse('2026-08-18T09:00:00.000Z');

const sicherung = (patch: Partial<SicherungBeobachtung> = {}): SicherungBeobachtung => ({
  outcome: 'ok',
  occurredAt: new Date(JETZT - 60_000),
  finishedAt: Math.floor((JETZT - 60_000) / 1000),
  stamp: '2026-08-18',
  components: { db: 'ok', docs: 'ok', transcripts: 'ok', prune: 'ok' },
  problem: null,
  ...patch,
});

describe('die Sicherungskachel (§18, A14, A103)', () => {
  it('sagt bei fehlender Meldung „unbekannt" und nicht „in Ordnung"', () => {
    const kachel = sicherungKachel(null, JETZT);
    expect(kachel.state).toBe('unbekannt');
    expect(kachel.at).toBeNull();
    expect(kachel.detail).toContain('niemand nachgesehen');
  });

  it('ist grün, wenn die letzte Sicherung frisch und vollständig war', () => {
    const kachel = sicherungKachel(sicherung(), JETZT);
    expect(kachel.state).toBe('ok');
    expect(kachel.detail).toContain('2026-08-18');
  });

  /**
   * Der Fall, für den diese Kachel gebaut ist. Kein Fehler im Protokoll, nur
   * Stille — und Stille sieht ohne diese Regel wie Ruhe aus.
   */
  it('warnt, wenn die letzte **erfolgreiche** Sicherung zu alt ist (A103)', () => {
    const kachel = sicherungKachel(
      sicherung({ occurredAt: new Date(JETZT - SICHERUNG_VERALTET_MS - 60_000) }),
      JETZT,
    );
    expect(kachel.state).toBe('warnung');
    expect(kachel.detail).toContain('A103');
  });

  it('nennt bei einem Fehlschlag die Komponenten, die scheiterten (A103)', () => {
    const kachel = sicherungKachel(
      sicherung({
        outcome: 'failed',
        components: { db: 'ok', docs: 'ok', transcripts: 'failed', prune: 'skipped' },
        problem: 'Permission denied',
      }),
      JETZT,
    );
    expect(kachel.state).toBe('fehler');
    expect(kachel.detail).toContain('Transkripte');
    expect(kachel.detail).toContain('Permission denied');
    // Die Komponenten, die liefen, gehören **nicht** in die Aufzählung der
    // gescheiterten — sonst liest sich ein Teilausfall als Totalausfall, und
    // genau die Unterscheidung war A103s teuerste.
    expect(kachel.detail).not.toContain('Datenbank');
  });

  /**
   * Alter verschlechtert, es verbessert nie. Ein alter Fehlschlag bleibt ein
   * Fehlschlag — ihn wegen seines Alters herabzustufen wäre die eine Richtung,
   * in der eine Sicherheitsanzeige nicht irren darf.
   */
  it('stuft einen alten Fehlschlag nicht auf „warnung" herunter', () => {
    const kachel = sicherungKachel(
      sicherung({
        outcome: 'failed',
        occurredAt: new Date(JETZT - 30 * 24 * 60 * 60_000),
        components: { db: 'failed', docs: 'skipped', transcripts: 'skipped', prune: 'skipped' },
      }),
      JETZT,
    );
    expect(kachel.state).toBe('fehler');
  });
});

describe('die Plattenkachel (§18, A30)', () => {
  const platte = (patch: Partial<Parameters<typeof plattenKachel>[0] & object> = {}) => ({
    occurredAt: new Date(JETZT - 60_000),
    level: 'ok' as const,
    worstPercent: 62,
    worstPath: '/data',
    unreadable: [] as string[],
    ...patch,
  });

  it('sagt bei fehlender Messung „unbekannt"', () => {
    expect(plattenKachel(null, JETZT).state).toBe('unbekannt');
  });

  it('bildet die drei Stufen des Daemons ab', () => {
    expect(plattenKachel(platte(), JETZT).state).toBe('ok');
    expect(plattenKachel(platte({ level: 'warning' }), JETZT).state).toBe('warnung');
    expect(plattenKachel(platte({ level: 'alert' }), JETZT).state).toBe('fehler');
  });

  it('nennt den vollsten Pfad und seinen Wert', () => {
    expect(plattenKachel(platte({ level: 'warning' }), JETZT).detail).toContain('62 %');
    expect(plattenKachel(platte({ level: 'warning' }), JETZT).detail).toContain('/data');
  });

  /**
   * Eine veraltete Messung ist kein aktueller Zustand — aber sie darf einen
   * Alarm nicht entschärfen. Beide Richtungen in einem Fall, weil nur das Paar
   * die Regel festhält.
   */
  it('macht aus einer veralteten grünen Messung „unbekannt", aus einem Alarm nicht', () => {
    const alt = new Date(JETZT - PLATTE_VERALTET_MS - 60_000);
    expect(plattenKachel(platte({ occurredAt: alt }), JETZT).state).toBe('unbekannt');
    expect(plattenKachel(platte({ occurredAt: alt, level: 'alert' }), JETZT).state).toBe('fehler');
  });

  it('meldet nicht lesbare Ablagen, statt sie als in Ordnung zu zählen', () => {
    const kachel = plattenKachel(platte({ unreadable: ['/data/transcripts'] }), JETZT);
    expect(kachel.detail).toContain('/data/transcripts');
  });
});

describe('alter', () => {
  it('rechnet grob und sagt bei Unsinn nichts Beruhigendes', () => {
    expect(alter(30_000)).toBe('gerade eben');
    expect(alter(20 * 60_000)).toBe('vor 20 Minuten');
    expect(alter(3 * 3_600_000)).toBe('vor 3 Stunden');
    expect(alter(5 * 86_400_000)).toBe('vor 5 Tagen');
    expect(alter(Number.NaN)).toBe('zu einem unbekannten Zeitpunkt');
  });
});

/**
 * §6.1 auf der Übersicht. Gefunden bei einer Funktionsprüfung mit einem Token,
 * der sich nicht anmeldet: die Startseite sagte „Keine Budgetdaten" und sonst
 * nichts, der Orchestrator-Container war `(healthy)`, und die Ursache stand nur
 * in dessen Log.
 */
describe('der Auth-Vorfall auf der Übersicht (§6.1)', () => {
  const vorfall = (patch: Partial<AuthVorfallBeobachtung> = {}): AuthVorfallBeobachtung => ({
    occurredAt: new Date(JETZT - 3 * 60_000),
    reasons: ['Die Sitzung konnte sich nicht anmelden (§6.1).'],
    announced: true,
    ...patch,
  });

  it('ist ohne jede Meldung kein Vorfall', () => {
    expect(authVorfall(null, JETZT)).toBeNull();
  });

  it('nennt einen frischen Vorfall als Grund für die fehlenden Budgetdaten', () => {
    const streifen = authVorfall(vorfall(), JETZT);
    expect(streifen?.at).toBe(new Date(JETZT - 3 * 60_000).toISOString());
    expect(streifen?.text).toContain('Die Anmeldung bei Claude schlägt fehl');
    expect(streifen?.text).toContain('zuletzt gemeldet vor 3 Minuten');
    expect(streifen?.text).toContain('deshalb gibt es auch keine Budgetdaten');
    // Der Satz des Daemons reist mit — und was zu tun ist.
    expect(streifen?.text).toContain('Die Sitzung konnte sich nicht anmelden');
    expect(streifen?.text).toContain('Renew the OAuth token');
  });

  it('hält einen Vorfall nicht für laufend, wenn der Daemon ihn nicht mehr meldet', () => {
    // Das Ende schreibt keine Zeile; „läuft noch" ist eine Aussage über das Alter.
    const gerade = vorfall({ occurredAt: new Date(JETZT - AUTH_VORFALL_AKTUELL_MS) });
    const vorbei = vorfall({ occurredAt: new Date(JETZT - AUTH_VORFALL_AKTUELL_MS - 1) });
    expect(authVorfall(gerade, JETZT)).not.toBeNull();
    expect(authVorfall(vorbei, JETZT)).toBeNull();
  });

  it('sagt dazu, wenn der ntfy-Alarm nicht ankam — und nur dann', () => {
    expect(authVorfall(vorfall({ announced: false }), JETZT)?.text).toContain(
      'Der Alarm über ntfy kam nicht an',
    );
    expect(authVorfall(vorfall(), JETZT)?.text).not.toContain('ntfy');
    // Zeilen von vor dieser Angabe: unbekannt ist keine Behauptung.
    expect(authVorfall(vorfall({ announced: null }), JETZT)?.text).not.toContain('ntfy');
  });

  it('kommt ohne Begründung aus und kürzt eine überlange', () => {
    expect(authVorfall(vorfall({ reasons: [] }), JETZT)?.text).not.toContain('Gemeldet:');
    const lang = authVorfall(vorfall({ reasons: ['x'.repeat(1000)] }), JETZT);
    expect(lang?.text).toContain(`${'x'.repeat(240)}…`);
    expect(lang?.text).not.toContain('x'.repeat(241));
  });
});
