import { describe, expect, it } from 'vitest';
import { EVENT_KINDS } from './events.js';
import {
  EVENT_LEVELS,
  LOG_ALLE,
  LOG_DEFAULT_LIMIT,
  LOG_MAX_LIMIT,
  LOG_NOISY_KINDS,
  LOG_QUERY,
  LOG_RAUSCH_GRUENDE,
  logStufe,
  parseLogFilter,
} from './log.js';

/**
 * §18s Log-Explorer, in seiner prüfbaren Hälfte.
 *
 * Zwei Zusicherungen tragen hier wirklich etwas, und beide betreffen Dinge, die
 * ohne Test still falsch wären: die Stufenzuordnung, die §18s Wort „level"
 * überhaupt erst einlösbar macht, und ein Filter, der eine unbekannte Eingabe
 * als eine bekannte behandelt.
 */

const query = (paare: Record<string, string>) => new URLSearchParams(paare);

describe('§18s Stufen', () => {
  /**
   * Der Mechanismus, den A44.3 verlangt: eine neue Ereignisart ohne Stufe darf
   * nicht als „info" durchfallen.
   *
   * `Record<EventKind, LogLevel>` fängt die fehlende Richtung schon beim Bauen;
   * dieser Fall fängt die andere, die der Typ durchlässt — einen **überzähligen**
   * Schlüssel, der nach einer Umbenennung stehenbleibt und dann eine Stufe für
   * eine Art vergibt, die es nicht mehr gibt.
   */
  it('deckt genau die Ereignisarten ab, die es gibt — keine mehr, keine weniger', () => {
    expect(Object.keys(EVENT_LEVELS).sort()).toEqual([...EVENT_KINDS].sort());
  });

  it('gibt jeder Art eine der drei Stufen', () => {
    for (const kind of EVENT_KINDS) {
      expect(['alarm', 'warnung', 'info']).toContain(EVENT_LEVELS[kind]);
    }
  });

  /**
   * Die Regel im Kopf der Datei, an ihren Rändern festgehalten. Ohne diese
   * Zeilen wäre die Zuordnung eine Meinung, die jederzeit verrutschen kann,
   * ohne dass irgendetwas rot wird.
   */
  it('stuft ein, was liegen bleibt, als Alarm', () => {
    expect(logStufe('ops.alert')).toBe('alarm');
    expect(logStufe('auth.incident')).toBe('alarm');
    expect(logStufe('task.failed')).toBe('alarm');
    expect(logStufe('deploy.rolled_back')).toBe('alarm');
    expect(logStufe('backup.failed')).toBe('alarm');
  });

  it('stuft den gewöhnlichen Verlauf als Information', () => {
    expect(logStufe('run.finished')).toBe('info');
    expect(logStufe('gate.finished')).toBe('info');
    expect(logStufe('merge.finished')).toBe('info');
    expect(logStufe('backup.succeeded')).toBe('info');
  });

  /**
   * Eine Art, die dieses Dashboard nicht kennt, ist eine Abweichung zwischen
   * zwei Hälften dieses Systems — und §18 hebt alte Zeilen für immer auf. Sie
   * fällt deshalb auf `warnung` und nicht auf `info`: die beruhigende Lesart
   * wäre die, die niemand mehr findet.
   */
  it('lässt eine unbekannte Art auffallen, statt sie als Information zu führen', () => {
    expect(logStufe('irgendwas.neues')).toBe('warnung');
    expect(logStufe('')).toBe('warnung');
  });
});

describe('§18s Rauschvorgabe', () => {
  /**
   * Genau eine Art, und das ist die Zusicherung: jede weitere ist eine
   * Vertragsänderung, die jemand sieht. Eine Liste, die still wächst, ist ein
   * Filter, der immer mehr verbirgt, ohne dass es jemandem auffällt.
   */
  it('blendet genau `guardian.anomaly` aus und sonst nichts', () => {
    expect(LOG_NOISY_KINDS).toEqual(['guardian.anomaly']);
  });

  /**
   * A149 — und die Gründe sind die schärfere Hälfte derselben Zusicherung.
   *
   * Vorher verbarg die Vorgabe die **ganze** Art. Unter ihr melden aber auch
   * `wrap_up_failed`, `pause_unreadable`, `wrap_up_incomplete`,
   * `scale_mismatch` und `unknown_window_kinds` — also genau die Zeilen, für
   * die ein Protokoll da ist. Das war A67.6 eingetreten: der Kanal war
   * stummgeschaltet, und die nächste echte Meldung wäre unsichtbar gewesen.
   *
   * Diese Liste darf deshalb **nicht** wachsen, ohne dass jemand hinsieht —
   * dieselbe Begründung wie beim Fall darüber, eine Ebene feiner.
   */
  it('nennt genau die beiden Vielschreiber als Rauschen — und keinen Alarm', () => {
    expect(LOG_RAUSCH_GRUENDE).toEqual(['rate_limits_unavailable', 'meter_divergence']);
    for (const alarm of [
      'wrap_up_failed',
      'wrap_up_incomplete',
      'pause_unreadable',
      'scale_mismatch',
      'unknown_window_kinds',
    ]) {
      expect(LOG_RAUSCH_GRUENDE).not.toContain(alarm);
    }
  });

  it('ist ausgeschaltet, solange niemand den Schalter umlegt', () => {
    expect(parseLogFilter(query({})).noise).toBe(false);
    expect(parseLogFilter(query({ [LOG_QUERY.noise]: '1' })).noise).toBe(true);
    // Alles andere ist kein Einschalten: ein `rauschen=vielleicht` darf nicht
    // versehentlich alles einblenden.
    expect(parseLogFilter(query({ [LOG_QUERY.noise]: 'ja' })).noise).toBe(false);
  });
});

describe('parseLogFilter', () => {
  it('liest die Filter, die §18 nennt', () => {
    const filter = parseLogFilter(
      query({
        [LOG_QUERY.from]: '2026-08-01',
        [LOG_QUERY.to]: '2026-08-18',
        [LOG_QUERY.kind]: 'deploy.rolled_back',
        [LOG_QUERY.level]: 'alarm',
        [LOG_QUERY.project]: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        [LOG_QUERY.task]: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        [LOG_QUERY.search]: 'permission denied',
      }),
    );
    expect(filter).toMatchObject({
      from: '2026-08-01',
      to: '2026-08-18',
      kind: 'deploy.rolled_back',
      level: 'alarm',
      projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      taskId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      search: 'permission denied',
    });
  });

  /**
   * Die tragende Zusicherung dieses Blocks: nichts wird geraten.
   *
   * Eine unbekannte Stufe filtert **nicht**, statt auf eine bekannte zu fallen —
   * sonst zeigt die Seite eine Liste, die eine andere Frage beantwortet als die
   * gestellte, und niemand merkt es.
   */
  it('macht aus einer unbekannten Eingabe keinen Filter statt eines geratenen', () => {
    const filter = parseLogFilter(
      query({
        [LOG_QUERY.level]: 'dringend',
        [LOG_QUERY.kind]: 'Deploy Rolled Back',
        [LOG_QUERY.project]: 'nicht-uuid',
        [LOG_QUERY.from]: '18.08.2026',
      }),
    );
    expect(filter.level).toBeNull();
    expect(filter.kind).toBeNull();
    expect(filter.projectId).toBeNull();
    expect(filter.from).toBeNull();
  });

  it('behandelt „alle" und leer wie „kein Filter"', () => {
    const filter = parseLogFilter(query({ [LOG_QUERY.level]: LOG_ALLE, [LOG_QUERY.kind]: '   ' }));
    expect(filter.level).toBeNull();
    expect(filter.kind).toBeNull();
  });

  it('deckelt die Seitengrösse und fällt sonst auf die Vorgabe', () => {
    expect(parseLogFilter(query({})).limit).toBe(LOG_DEFAULT_LIMIT);
    expect(parseLogFilter(query({ [LOG_QUERY.limit]: '9999' })).limit).toBe(LOG_MAX_LIMIT);
    expect(parseLogFilter(query({ [LOG_QUERY.limit]: '0' })).limit).toBe(LOG_DEFAULT_LIMIT);
    expect(parseLogFilter(query({ [LOG_QUERY.limit]: 'viele' })).limit).toBe(LOG_DEFAULT_LIMIT);
  });

  /**
   * Der Cursor ist eine `id`, kein Offset (Entscheidung 3). Ein unbrauchbarer
   * Wert blättert an den Anfang statt an eine geratene Stelle.
   */
  it('nimmt nur eine brauchbare Cursor-Id', () => {
    expect(parseLogFilter(query({ [LOG_QUERY.before]: '4711' })).before).toBe(4711);
    expect(parseLogFilter(query({ [LOG_QUERY.before]: '-1' })).before).toBeNull();
    expect(parseLogFilter(query({ [LOG_QUERY.before]: '1.5' })).before).toBeNull();
    expect(parseLogFilter(query({ [LOG_QUERY.before]: 'gestern' })).before).toBeNull();
  });
});
