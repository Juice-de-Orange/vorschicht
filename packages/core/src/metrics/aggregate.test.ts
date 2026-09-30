/**
 * Die reinen Hälften der Kennzahlen-Erhebung (§22 Phase 8 Schritt 1).
 *
 * Alles, was hier geprüft wird, ist eine **Entscheidung** und keine Arithmetik:
 * welcher Gate-Lauf in den Nenner kommt, wann ein Fund als behoben gilt, was
 * eine blinde Budgetzeile ist, und wo eine Zahl fehlen muss statt 0 zu sein.
 * Die Abfragen daneben stehen in `service.itest.ts` gegen eine echte Postgres;
 * hier läuft nichts, was eine Datenbank braucht — und das ist kein Zufall,
 * sondern die Trennung, die A61 einmal teuer bezahlt hat.
 *
 * Zwei Formen wiederholen sich, beide mit Absicht:
 *
 *  - **Die Abwesenheiten werden so hart geprüft wie die Anwesenheiten.** Eine
 *    Suite, die nur „die Quote ist 0,5" prüft, besteht auch gegen eine
 *    Umsetzung, die das Fenster gar nicht filtert (A139.1s Lehre, dort an
 *    einer Suche). Deshalb steht neben jedem „zählt mit" ein „zählt nicht".
 *  - **Fehlt eine Zahl, wird der Grund mitgeprüft.** `null` allein wäre von
 *    „konnte nicht" nicht zu unterscheiden, und die Unterscheidung ist der
 *    ganze Zweck von `Quantity`.
 */
import { describe, expect, it } from 'vitest';
import { aggregateBudget, type BudgetGroupRow, weeklyUtilisation } from './budget.js';
import {
  classifyGateRun,
  findingsByGate,
  type GateRunRow,
  type GateStepSummary,
  gatePassRate,
  parseGateRun,
  timeToGreen,
} from './gate-runs.js';
import { redRate } from './metrics.js';
import { known, ratio, UNKNOWN_REASON_LABELS, UNKNOWN_REASONS, unknown } from './quantity.js';
import { median, percentile } from './statistics.js';
import { assertWindow, inWindow, type MetricsWindow, windowLabel } from './window.js';

const BASE = Date.parse('2026-08-10T00:00:00.000Z');
const MINUTE = 60_000;

/** Ein Fenster von einer Woche ab `BASE`. */
const WEEK: MetricsWindow = {
  from: new Date(BASE),
  to: new Date(BASE + 7 * 24 * 60 * MINUTE),
};

function step(id: string, verdict: string): GateStepSummary {
  return { id, verdict, detail: null };
}

/** Eine `gate.finished`-Zeile, so wie `service.ts` sie aus der Abfrage baut. */
function run(
  id: string,
  minutesAfterBase: number,
  taskId: string | null,
  steps: unknown,
  extraPayload: Record<string, unknown> = {},
): GateRunRow {
  return {
    id,
    occurredAt: new Date(BASE + minutesAfterBase * MINUTE),
    taskId,
    payload: { steps, ...extraPayload },
  };
}

describe('Quantity — eine Zahl, die es geben kann oder nicht', () => {
  it('setzt genau eines von Wert und Grund', () => {
    expect(known(0.5)).toEqual({ value: 0.5, unknownReason: null });
    expect(unknown('no_data')).toEqual({ value: null, unknownReason: 'no_data' });
  });

  it('gibt bei leerem Nenner den Grund zurück, den der Aufrufer nennt', () => {
    // Nicht 0: „keine Aufgabe war rot" und „es gab keine Aufgabe" sind
    // verschiedene Wochen, und eine 0 sagt die erste, wo die zweite gilt.
    expect(ratio(0, 0, 'inconclusive')).toEqual({ value: null, unknownReason: 'inconclusive' });
    expect(ratio(3, 0, 'no_data').value).toBeNull();
  });

  it('rechnet eine gewöhnliche Quote', () => {
    expect(ratio(3, 4, 'no_data')).toEqual({ value: 0.75, unknownReason: null });
  });

  it('hat für jeden Grund einen deutschen Satz — abgeleitet, nicht aufgezählt', () => {
    // Über `UNKNOWN_REASONS` abgeleitet: ein dritter Grund ohne Satz färbt
    // diesen Fall rot, statt im Bericht als leere Klammer aufzutauchen.
    for (const reason of UNKNOWN_REASONS) {
      expect(UNKNOWN_REASON_LABELS[reason]).toBeTypeOf('string');
      expect(UNKNOWN_REASON_LABELS[reason].length).toBeGreaterThan(10);
    }
    expect(Object.keys(UNKNOWN_REASON_LABELS)).toHaveLength(UNKNOWN_REASONS.length);
  });
});

describe('Perzentile — nach Rang, ohne Interpolation', () => {
  it('nimmt bei gerader Anzahl den unteren der beiden mittleren Werte', () => {
    // Ausdrücklich: ein interpolierender Median gäbe hier 25 und wäre eine
    // Dauer, die kein Lauf hatte. §22s Prüfskript soll die Zahl abzählen
    // können, nicht die Interpolationsvorschrift raten.
    expect(median([10, 20, 30, 40]).value).toBe(20);
  });

  it('nimmt bei ungerader Anzahl die Mitte', () => {
    expect(median([30, 10, 20]).value).toBe(20);
  });

  it('liefert p90 als kleinsten Wert, unter oder auf dem 90 % liegen', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    expect(percentile(values, 0.9).value).toBe(9);
    expect(percentile(values, 1).value).toBe(10);
  });

  it('meldet bei leerer Eingabe keine Zahl statt einer 0', () => {
    expect(median([])).toEqual({ value: null, unknownReason: 'no_data' });
  });

  it('weist ein Perzentil ausserhalb (0, 1] zurück', () => {
    expect(() => percentile([1, 2], 0)).toThrow(RangeError);
    expect(() => percentile([1, 2], 1.5)).toThrow(RangeError);
  });
});

describe('Zeitfenster — halboffen, damit zwei Berichte nichts doppelt zählen', () => {
  it('nimmt den Anfang und lässt das Ende aus', () => {
    expect(inWindow(WEEK.from, WEEK)).toBe(true);
    expect(inWindow(new Date(WEEK.to.getTime() - 1), WEEK)).toBe(true);
    // Der Fall, der ohne halboffenes Fenster in zwei Wochenberichten stünde.
    expect(inWindow(WEEK.to, WEEK)).toBe(false);
  });

  it('lehnt ein Fenster ohne Dauer ab, statt es als ruhig zu beantworten', () => {
    expect(() => assertWindow({ from: WEEK.to, to: WEEK.from })).toThrow(RangeError);
    expect(() => assertWindow({ from: WEEK.from, to: WEEK.from })).toThrow(RangeError);
    expect(() => assertWindow({ from: new Date(Number.NaN), to: WEEK.to })).toThrow(RangeError);
  });

  it('reist als ISO mit, damit es durch JSON überlebt', () => {
    expect(windowLabel(WEEK).from).toBe('2026-08-10T00:00:00.000Z');
  });
});

describe('Gate-Läufe lesen', () => {
  it('liest eine gewöhnliche Nutzlast', () => {
    const record = parseGateRun(run('1', 5, 't1', [step('test', 'green')]));
    expect(record?.taskId).toBe('t1');
    expect(record?.steps).toEqual([{ id: 'test', verdict: 'green', detail: null }]);
  });

  it('verweigert eine Zeile ohne Aufgabenkennung', () => {
    // Ein Gate-Lauf ohne Aufgabe ist weder zurechenbar noch paarbar; als
    // bestanden zu zählen wäre eine Aussage über niemanden.
    expect(parseGateRun(run('1', 5, null, [step('test', 'green')]))).toBeNull();
  });

  it('verweigert eine Nutzlast ohne brauchbare Schrittliste', () => {
    expect(parseGateRun(run('1', 5, 't1', 'keine Liste'))).toBeNull();
    expect(parseGateRun(run('1', 5, 't1', [{ id: 'test' }]))).toBeNull();
    expect(parseGateRun(run('1', 5, 't1', [null]))).toBeNull();
    // Leer ist kein Lauf: §11 sperrt sechs Gates, die kein Projekt abwählen
    // kann. Ein Nichts als Bestehen zu buchen ist die gefährliche Richtung.
    expect(parseGateRun(run('1', 5, 't1', []))).toBeNull();
  });
});

describe('Urteil eines Gate-Laufs', () => {
  it('liest das Urteil aus den Schritten und nicht aus dem ok-Flag', () => {
    // Die tragende Zusicherung dieses Moduls. `summarise()` schreibt `ok`
    // neben die Schritte; eine Nutzlast, in der beides sich widerspricht,
    // muss aus dem Beleg entschieden werden, nicht aus der Zusammenfassung.
    const widerspruch = run('1', 5, 't1', [step('test', 'finding')], { ok: true });
    const record = parseGateRun(widerspruch);
    expect(record).not.toBeNull();
    expect(classifyGateRun(record as NonNullable<typeof record>)).toBe('failed');
  });

  it('lässt einen Fund über infra gewinnen', () => {
    const record = parseGateRun(
      run('1', 5, 't1', [step('lint', 'infra'), step('test', 'finding')]),
    );
    expect(classifyGateRun(record as NonNullable<typeof record>)).toBe('failed');
  });

  it('nennt einen reinen infra-Lauf unentschieden (A25)', () => {
    const record = parseGateRun(run('1', 5, 't1', [step('lint', 'green'), step('test', 'infra')]));
    expect(classifyGateRun(record as NonNullable<typeof record>)).toBe('inconclusive');
  });

  it('nennt einen unbekannten Urteilswert unentschieden statt grün', () => {
    const record = parseGateRun(run('1', 5, 't1', [step('test', 'vielleicht')]));
    expect(classifyGateRun(record as NonNullable<typeof record>)).toBe('inconclusive');
  });
});

describe('Gate-Durchlaufquote (§16.1)', () => {
  it('zählt nur Läufe im Fenster', () => {
    const rows = [
      run('1', -60, 't1', [step('test', 'green')]),
      run('2', 10, 't2', [step('test', 'green')]),
      // Genau auf der oberen Grenze — gehört in den nächsten Bericht.
      run('3', 7 * 24 * 60, 't3', [step('test', 'green')]),
      run('4', 7 * 24 * 60 + 5, 't4', [step('test', 'finding')]),
    ];
    const rate = gatePassRate(rows, WEEK);
    expect(rate.passed).toBe(1);
    expect(rate.failed).toBe(0);
    expect(rate.rate.value).toBe(1);
  });

  it('lässt unentschiedene Läufe aus dem Nenner', () => {
    // A25: ein Lauf an einer unerreichbaren Registry hat nichts geprüft. Ihn
    // mitzuzählen senkte die Quote für einen Maschinenausfall.
    const rows = [
      run('1', 1, 't1', [step('test', 'green')]),
      run('2', 2, 't2', [step('test', 'green')]),
      run('3', 3, 't3', [step('test', 'finding')]),
      run('4', 4, 't4', [step('test', 'infra')]),
      run('5', 5, 't5', [step('test', 'infra')]),
      run('6', 6, 't6', [step('test', 'infra')]),
    ];
    const rate = gatePassRate(rows, WEEK);
    expect(rate).toMatchObject({ passed: 2, failed: 1, inconclusive: 3, unreadable: 0 });
    expect(rate.rate.value).toBeCloseTo(2 / 3, 10);
  });

  it('zählt eine unlesbare Zeile und wertet sie nicht als bestanden', () => {
    const rows = [run('1', 1, null, [step('test', 'green')]), run('2', 2, 't2', [])];
    const rate = gatePassRate(rows, WEEK);
    expect(rate).toMatchObject({ passed: 0, failed: 0, inconclusive: 0, unreadable: 2 });
    expect(rate.rate).toEqual({ value: null, unknownReason: 'inconclusive' });
  });

  it('unterscheidet ein ruhiges Fenster von einem, in dem nichts entschieden wurde', () => {
    expect(gatePassRate([], WEEK).rate).toEqual({ value: null, unknownReason: 'no_data' });
    expect(gatePassRate([run('1', 1, 't1', [step('test', 'infra')])], WEEK).rate).toEqual({
      value: null,
      unknownReason: 'inconclusive',
    });
  });
});

describe('Funde je Gate (§16.3)', () => {
  it('zählt rote Schritte, nicht Läufe, und dazu die betroffenen Aufgaben', () => {
    const rows = [
      run('1', 1, 't1', [step('test', 'finding'), step('lint', 'finding')]),
      run('2', 2, 't2', [step('test', 'finding')]),
      run('3', 3, 't1', [step('test', 'finding')]),
      run('4', 4, 't3', [step('test', 'green')]),
    ];
    expect(findingsByGate(rows, WEEK)).toEqual([
      { gateId: 'test', findings: 3, tasks: 2 },
      { gateId: 'lint', findings: 1, tasks: 1 },
    ]);
  });

  it('sortiert bei Gleichstand alphabetisch statt nach Einfügereihenfolge', () => {
    const rows = [
      run('1', 1, 't1', [step('zeta', 'finding')]),
      run('2', 2, 't1', [step('alpha', 'finding')]),
    ];
    expect(findingsByGate(rows, WEEK).map((entry) => entry.gateId)).toEqual(['alpha', 'zeta']);
  });

  it('lässt Funde ausserhalb des Fensters aus', () => {
    const rows = [run('1', -1, 't1', [step('test', 'finding')])];
    expect(findingsByGate(rows, WEEK)).toEqual([]);
  });
});

describe('Zeit-bis-grün (§16.3)', () => {
  it('paart einen Fund mit dem nächsten grünen Lauf desselben Gates derselben Aufgabe', () => {
    const rows = [
      run('1', 0, 't1', [step('test', 'finding')]),
      run('2', 30, 't1', [step('test', 'green')]),
    ];
    const result = timeToGreen(rows, WEEK);
    expect(result.resolved).toBe(1);
    expect(result.stillOpen).toBe(0);
    expect(result.medianMs.value).toBe(30 * MINUTE);
    expect(result.slowest?.resolvedRunId).toBe('2');
  });

  it('lässt einen grünen Lauf einer anderen Aufgabe nicht auflösen', () => {
    const rows = [
      run('1', 0, 't1', [step('test', 'finding')]),
      run('2', 30, 't2', [step('test', 'green')]),
    ];
    expect(timeToGreen(rows, WEEK)).toMatchObject({ resolved: 0, stillOpen: 1 });
  });

  it('lässt einen grünen Lauf eines anderen Gates nicht auflösen', () => {
    const rows = [
      run('1', 0, 't1', [step('test', 'finding')]),
      run('2', 30, 't1', [step('lint', 'green')]),
    ];
    expect(timeToGreen(rows, WEEK)).toMatchObject({ resolved: 0, stillOpen: 1 });
  });

  it('lässt einen früheren grünen Lauf nicht auflösen', () => {
    // Die dritte Bedingung aus Migration 0015: *später*. Ohne sie wäre jeder
    // Fund eines Gates, das vorher schon einmal grün war, sofort behoben.
    const rows = [
      run('1', 0, 't1', [step('test', 'green')]),
      run('2', 30, 't1', [step('test', 'finding')]),
    ];
    expect(timeToGreen(rows, WEEK)).toMatchObject({ resolved: 0, stillOpen: 1 });
  });

  it('nimmt eine Auflösung nach dem Fenster an, einen Fund davor aber nicht', () => {
    // Entscheidung 5: sonst wäre ein Fund vom Sonntag 23:59 für immer offen.
    const spaet = 7 * 24 * 60 - 1;
    const rows = [
      run('1', -10, 't0', [step('test', 'finding')]),
      run('2', 5, 't0', [step('test', 'green')]),
      run('3', spaet, 't1', [step('test', 'finding')]),
      run('4', spaet + 120, 't1', [step('test', 'green')]),
    ];
    const result = timeToGreen(rows, WEEK);
    // Der Fund von t0 liegt vor dem Fenster und zählt gar nicht mit.
    expect(result.resolved).toBe(1);
    expect(result.stillOpen).toBe(0);
    expect(result.medianMs.value).toBe(120 * MINUTE);
  });

  it('nimmt auch einen roten Lauf als Auflösung, wenn dieses eine Gate grün war', () => {
    // Dieselbe Regel wie in der `findings`-Sicht: gefragt ist der Schritt,
    // nicht das Gesamturteil des späteren Laufs.
    const rows = [
      run('1', 0, 't1', [step('test', 'finding')]),
      run('2', 20, 't1', [step('test', 'green'), step('lint', 'finding')]),
    ];
    expect(timeToGreen(rows, WEEK).resolved).toBe(1);
  });

  it('trennt „keine Funde" von „kein Fund ist grün geworden"', () => {
    expect(timeToGreen([], WEEK).medianMs).toEqual({ value: null, unknownReason: 'no_data' });
    const offen = timeToGreen([run('1', 1, 't1', [step('test', 'finding')])], WEEK);
    expect(offen.stillOpen).toBe(1);
    expect(offen.medianMs).toEqual({ value: null, unknownReason: 'inconclusive' });
    expect(offen.p90Ms).toEqual({ value: null, unknownReason: 'inconclusive' });
  });

  it('nennt den langsamsten aufgelösten Fund', () => {
    const rows = [
      run('1', 0, 't1', [step('test', 'finding')]),
      run('2', 10, 't1', [step('test', 'green')]),
      run('3', 20, 't2', [step('lint', 'finding')]),
      run('4', 200, 't2', [step('lint', 'green')]),
    ];
    const result = timeToGreen(rows, WEEK);
    expect(result.resolved).toBe(2);
    expect(result.slowest?.gateId).toBe('lint');
    expect(result.slowest?.durationMs).toBe(180 * MINUTE);
    expect(result.medianMs.value).toBe(10 * MINUTE);
  });
});

describe('Rot-Quote (§16.3)', () => {
  it('rechnet je Aufgabe und gibt beide Zahlen mit', () => {
    expect(redRate(2, 8)).toEqual({
      tasksRed: 2,
      tasksConcluded: 8,
      rate: { value: 0.25, unknownReason: null },
    });
  });

  it('meldet bei leerem Nenner keine Quote statt einer 0', () => {
    expect(redRate(0, 0).rate).toEqual({ value: null, unknownReason: 'no_data' });
  });
});

describe('Budget-Auslastung (§16.1)', () => {
  function group(over: Partial<BudgetGroupRow>): BudgetGroupRow {
    return {
      windowKind: 'seven_day',
      modelClass: null,
      source: 'estimated',
      anomalyKind: null,
      samples: 1,
      sumPercent: 50,
      maxPercent: 50,
      ...over,
    };
  }

  it('lässt den unavailable-Sentinel aus Mittel und Spitze heraus', () => {
    // Der Sentinel trägt `used_percent = 0`. Mitgemittelt würde eine Woche,
    // in der das Budget nicht lesbar war, als ruhigste des Jahres erscheinen.
    const budget = aggregateBudget([
      group({ samples: 2, sumPercent: 160, maxPercent: 90 }),
      group({ anomalyKind: 'unavailable', samples: 8, sumPercent: 0, maxPercent: 0 }),
    ]);
    const woche = weeklyUtilisation(budget);
    expect(woche?.samples).toBe(2);
    expect(woche?.blindSamples).toBe(8);
    expect(woche?.average.value).toBe(80);
    expect(woche?.peak.value).toBe(90);
  });

  it('meldet nur blinde Zeilen als unbekannt und nicht als 0 %', () => {
    const budget = aggregateBudget([
      group({ anomalyKind: 'unavailable', samples: 5, sumPercent: 0, maxPercent: 0 }),
    ]);
    const woche = weeklyUtilisation(budget);
    expect(woche?.average).toEqual({ value: null, unknownReason: 'inconclusive' });
    expect(woche?.peak).toEqual({ value: null, unknownReason: 'inconclusive' });
    expect(budget.unknownReason).toBe('inconclusive');
  });

  it('zählt andere Anomalien mit — sie tragen eine echte Antwort des Anbieters', () => {
    const budget = aggregateBudget([
      group({ anomalyKind: 'divergence', samples: 1, sumPercent: 40, maxPercent: 40 }),
      group({ anomalyKind: 'out_of_range', samples: 1, sumPercent: 100, maxPercent: 100 }),
    ]);
    expect(weeklyUtilisation(budget)?.samples).toBe(2);
    expect(weeklyUtilisation(budget)?.average.value).toBe(70);
  });

  it('mittelt gewichtet über die Quellen statt Mittel aus Mitteln zu bilden', () => {
    // 9 Schätzungen zu je 10 % und 1 offizielle Ablesung zu 90 %: gewichtet
    // 18 %, als Mittel der Gruppenmittel 50 %. Die Schätzung misst häufiger.
    const budget = aggregateBudget([
      group({ source: 'estimated', samples: 9, sumPercent: 90, maxPercent: 10 }),
      group({ source: 'official', samples: 1, sumPercent: 90, maxPercent: 90 }),
    ]);
    const woche = weeklyUtilisation(budget);
    expect(woche?.average.value).toBe(18);
    expect(woche?.peak.value).toBe(90);
    expect(woche?.bySource).toEqual({ official: 1, estimated: 9 });
  });

  it('hält Fensterarten und Modellklassen auseinander', () => {
    const budget = aggregateBudget([
      group({ windowKind: 'five_hour', samples: 1, sumPercent: 20, maxPercent: 20 }),
      group({ windowKind: 'seven_day', samples: 1, sumPercent: 40, maxPercent: 40 }),
      group({
        windowKind: 'seven_day_model',
        modelClass: 'opus',
        samples: 1,
        sumPercent: 60,
        maxPercent: 60,
      }),
    ]);
    expect(budget.windows).toHaveLength(3);
    // „dazu die Woche" ist die klassenlose seven_day-Zeile — nicht die
    // per-Modell-Decke, die zufällig dieselbe Fensterlänge hat.
    expect(weeklyUtilisation(budget)?.average.value).toBe(40);
    expect(weeklyUtilisation(budget)?.modelClass).toBeNull();
  });

  it('nennt ein leeres Fenster no_data und sagt, woher die Zahlen kämen', () => {
    const budget = aggregateBudget([]);
    expect(budget.windows).toEqual([]);
    expect(budget.unknownReason).toBe('no_data');
    // Punkt 2: nicht aus `event_log`, und das steht im Ergebnis statt in einem
    // Kommentar, den der Bericht nicht lesen kann.
    expect(budget.source).toBe('usage_samples');
    expect(weeklyUtilisation(budget)).toBeNull();
  });
});
