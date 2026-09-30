import { LOG_PFAD, LOG_QUERY } from '@vorschicht/shared/log';
import { describe, expect, it } from 'vitest';
import {
  korrelationen,
  liesLog,
  logAbfrage,
  logAnfangsfilter,
  logZeilenId,
  logZeilenPfad,
  NUTZLAST_MAX,
  nutzlastText,
  rauschHinweis,
} from './log-format.js';

/**
 * §18s Log-Explorer, in der Hälfte, die ohne Browser prüfbar ist.
 *
 * Der Fall, auf den es hier ankommt, ist der Rauschhinweis: er ist die einzige
 * Stelle, an der diese Seite von einem stillen Filter zu einem ehrlichen wird,
 * und ohne Test wäre „sagt es" eine Behauptung im Kommentar.
 */

const zeile = {
  id: 4711,
  occurredAt: '2026-08-18T09:00:00.000Z',
  kind: 'deploy.rolled_back',
  level: 'alarm' as const,
  actor: 'system',
  projectId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  taskId: null,
  runId: null,
  deployId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  payload: { status: 503 },
};

describe('§18s Rauschhinweis', () => {
  /**
   * Die tragende Zusicherung: die Vorgabe blendet aus, und **sie sagt es** —
   * auch dann, wenn in diesem Ausschnitt zufällig nichts verborgen ist. Sonst
   * erschiene der Filter genau dann, wenn er zuschlägt, und wäre sonst
   * unsichtbar; ein Leser wüsste nie, ob er alles sieht.
   */
  it('sagt auch dann, dass gefiltert wird, wenn gerade nichts verborgen ist', () => {
    const hinweis = rauschHinweis(0, false);
    expect(hinweis).not.toBeNull();
    expect(hinweis).toContain('guardian.anomaly');
  });

  it('nennt die Zahl, wenn in diesem Ausschnitt etwas verborgen ist', () => {
    expect(rauschHinweis(812, false)).toContain('812 Zeilen sind hier verborgen');
    expect(rauschHinweis(1, false)).toContain('1 Zeile ist hier verborgen');
  });

  /**
   * Und er schweigt, wenn nichts gefiltert wird: ein Hinweis über einen Filter,
   * der nicht greift, ist eine Zeile, die man zu übersehen lernt — und dann
   * übersieht man auch die, die etwas sagt.
   */
  it('schweigt, wenn das Rauschen eingeblendet ist', () => {
    expect(rauschHinweis(0, true)).toBeNull();
    expect(rauschHinweis(812, true)).toBeNull();
  });
});

describe('die Abfrage', () => {
  it('lässt leere Filter weg, statt sie als „alle" zu schreiben', () => {
    expect(logAbfrage({ level: 'alarm' })).toBe(`${LOG_QUERY.level}=alarm`);
    expect(logAbfrage({})).toBe('');
  });

  it('schreibt jeden Filter unter dem Schlüssel, den die Route liest', () => {
    const abfrage = new URLSearchParams(
      logAbfrage({
        from: '2026-08-01',
        kind: 'ops.alert',
        search: 'permission denied',
        before: 99,
        noise: true,
      }),
    );
    expect(abfrage.get(LOG_QUERY.from)).toBe('2026-08-01');
    expect(abfrage.get(LOG_QUERY.kind)).toBe('ops.alert');
    expect(abfrage.get(LOG_QUERY.search)).toBe('permission denied');
    expect(abfrage.get(LOG_QUERY.before)).toBe('99');
    expect(abfrage.get(LOG_QUERY.noise)).toBe('1');
  });
});

describe('der Deep-Link auf eine Zeile', () => {
  /**
   * Gebaut und wieder gelesen, mit **einem** Pfadwissen: das ist die einzige
   * Zusicherung, die die beiden Enden auseinanderlaufen sieht, und §15s
   * `/inbox` gegen `/posteingang` ist der Fall, der dieses Repository das
   * einmal gekostet hat (A81.3).
   */
  it('lässt sich wieder lesen', () => {
    const pfad = logZeilenPfad(4711);
    expect(pfad.startsWith(LOG_PFAD)).toBe(true);
    expect(logZeilenId(pfad.slice(`${LOG_PFAD}/`.length))).toBe(4711);
  });

  it('deutet einen unbrauchbaren Abschnitt nicht um', () => {
    expect(logZeilenId('4711abc')).toBeNull();
    expect(logZeilenId('-1')).toBeNull();
    expect(logZeilenId('0')).toBeNull();
    expect(logZeilenId(null)).toBeNull();
  });
});

describe('eine Zeile', () => {
  it('nennt nur die Korrelations-Ids, die gesetzt sind', () => {
    expect(korrelationen(zeile)).toEqual([
      ['Projekt', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
      ['Rollout', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
    ]);
  });

  it('zeigt eine leere Nutzlast als nichts statt als „{}"', () => {
    expect(nutzlastText({})).toBeNull();
    expect(nutzlastText(null)).toBeNull();
    expect(nutzlastText({ status: 503 })).toBe('{"status":503}');
  });

  it('kürzt eine lange Nutzlast und sagt, dass gekürzt wurde', () => {
    const text = nutzlastText({ output: 'x'.repeat(NUTZLAST_MAX * 2) });
    expect(text).toContain('(gekürzt)');
    expect((text ?? '').length).toBeLessThan(NUTZLAST_MAX + 40);
  });
});

describe('liesLog', () => {
  it('nimmt die vereinbarte Form an', () => {
    const gelesen = liesLog({
      log: {
        eintraege: [zeile],
        naechsteSeite: null,
        unterdrueckt: 0,
        projekte: [],
        limit: 100,
      },
    });
    expect(gelesen.ok).toBe(true);
  });

  /**
   * §18 hebt diese Tabelle für immer auf, also muss eine Zeile aus einem
   * anderen Build lesbar bleiben — `kind` ist bewusst kein Enum. Ohne diesen
   * Fall wäre eine spätere Verengung auf `z.enum` eine Änderung, die den
   * ganzen Explorer für alte Zeilen abschaltet, und nichts würde rot.
   */
  it('nimmt eine Ereignisart an, die dieses Dashboard nicht kennt', () => {
    const gelesen = liesLog({
      log: {
        eintraege: [{ ...zeile, kind: 'irgendwas.neues', level: 'warnung' }],
        naechsteSeite: null,
        unterdrueckt: 0,
        projekte: [],
        limit: 100,
      },
    });
    expect(gelesen.ok).toBe(true);
  });

  it('weist eine Antwort ohne Umschlag ab, auf Deutsch', () => {
    const gelesen = liesLog({ eintraege: [] });
    expect(gelesen.ok).toBe(false);
    if (gelesen.ok) throw new Error('unerreichbar');
    expect(gelesen.fehler).toContain('vereinbarte Form');
  });
});

describe('der Anfangsfilter aus der Adresszeile', () => {
  const adresse = (s: string) => new URLSearchParams(s);

  it('liest die Suche aus der Abfrage — der Defekt vom 18.8.2026', () => {
    // Die Seite las ihren Filter aus einer leeren Vorgabe und sah die
    // Abfragezeichenkette nie an. `?suche=…` war damit wirkungslos.
    expect(logAnfangsfilter(adresse('?suche=Gesundheit'), null).search).toBe('Gesundheit');
  });

  it('liest die übrigen Filter mit, nicht nur die Suche', () => {
    const filter = logAnfangsfilter(
      adresse(`?${LOG_QUERY.level}=alarm&${LOG_QUERY.noise}=1`),
      null,
    );
    expect(filter.level).toBe('alarm');
    expect(filter.noise).toBe(true);
  });

  it('ist leer, wenn die Adresse leer ist', () => {
    const filter = logAnfangsfilter(adresse(''), null);
    expect(filter).toEqual({
      from: null,
      to: null,
      kind: null,
      level: null,
      projectId: null,
      search: null,
      noise: false,
      before: null,
    });
  });

  it('lässt die Id aus dem Pfad ein „vor" aus der Abfrage stechen', () => {
    // Wer einen Deep-Link auf eine Zeile öffnet, will das Protokoll an dieser
    // Zeile. Beides gleichzeitig zu meinen ergibt keinen sinnvollen Zustand.
    expect(logAnfangsfilter(adresse(`?${LOG_QUERY.before}=99`), 4711).before).toBe(4712);
    expect(logAnfangsfilter(adresse(`?${LOG_QUERY.before}=99`), null).before).toBe(99);
  });

  it('wirft Unbrauchbares weg, statt es weiterzureichen', () => {
    // `parseLogFilter` ist die eine Stelle, die das entscheidet — hier wird nur
    // zugesichert, dass diese Funktion sie wirklich benutzt und nicht daneben
    // eine zweite Lesart aufmacht (A81).
    const filter = logAnfangsfilter(adresse(`?${LOG_QUERY.level}=erfunden`), null);
    expect(filter.level).toBeNull();
  });
});
