/**
 * §22s Phase-8-Gate: „Schedule fires correctly in Europe/Vienna incl. DST test".
 *
 * Zwei Dinge werden hier geprüft, und sie scheitern auf verschiedene Weise.
 * Die Fälligkeit scheitert **laut** — ein Bericht kommt zwanzigmal oder gar
 * nicht, und man merkt es am selben Tag. Die Sommerzeit scheitert **leise**: ein
 * fester Stundenversatz ist ein halbes Jahr lang exakt richtig und schiebt den
 * Bericht danach um eine Stunde, was niemand meldet. Deshalb liegt das Gewicht
 * dieser Datei auf den vier Umstellungsterminen und auf zwei Durchläufen, die
 * ein ganzes Jahr absuchen, statt auf einer Handvoll gut gewählter Beispiele.
 *
 * **Nachgeprüft wird mit einem eigenen Formatierer**, nicht mit dem des Moduls.
 * Ein Test, der dieselbe `Intl`-Instanz befragt wie der Code, prüft, dass eine
 * Funktion mit sich selbst übereinstimmt; ein gemeinsamer Irrtum höbe sich auf
 * (§8.2s Gründungsthese, A89.4s Regel „wer die Antwort richtig machen kann, darf
 * nicht der Gefragte sein"). Der Formatierer unten hat deshalb eine andere
 * Sprache, ein anderes Format und einen ausgeschriebenen Wochentag.
 *
 * Die Ankerzeitpunkte sind gemessen, nicht gerechnet — jeder einzelne wurde
 * gegen `Intl` in Wien nachgesehen, bevor er hier stand:
 *
 *   Mo 2026-03-23 06:00Z = 07:00 CET   ·  Mo 2026-03-30 05:00Z = 07:00 CEST
 *   Mo 2026-10-19 05:00Z = 07:00 CEST  ·  Mo 2026-10-26 06:00Z = 07:00 CET
 */
import { describe, expect, it } from 'vitest';
import {
  addDays,
  evaluateReportSchedule,
  nextSlotAfter,
  REPORT_HOUR,
  slotAtOrBefore,
  viennaInstant,
} from './report-schedule.js';

/** Der unabhängige Zeuge: andere Sprache, anderes Format, Wochentag im Klartext. */
const WITNESS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Vienna',
  hourCycle: 'h23',
  weekday: 'short',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function viennaClock(instant: number): string {
  const parts = WITNESS.formatToParts(new Date(instant));
  const field = (type: string): string => parts.find((part) => part.type === type)?.value ?? '?';
  return [
    field('weekday'),
    ` ${field('year')}-${field('month')}-${field('day')}`,
    ` ${field('hour')}:${field('minute')}:${field('second')}`,
  ].join('');
}

/**
 * Sucht in einem Zeitraum nach Durchgängen, die die Grundordnung verletzen:
 * der fällige Termin liegt nicht nach `jetzt`, der nächste liegt nicht davor,
 * und der Termin zeigt in Wien Montag 07:00:00.
 *
 * Gibt höchstens drei Verstösse zurück — die Zahl ist eine Lesbarkeitsgrenze:
 * ein systematischer Fehler bricht jeden Durchgang, und eine Liste mit 8760
 * Zeilen sagt nicht mehr als eine mit dreien.
 */
function ordnungsverstoesse(beginn: number, schritte: number, schrittweite: number): string[] {
  const verstoesse: string[] = [];
  for (let schritt = 0; schritt < schritte && verstoesse.length < 3; schritt += 1) {
    const jetzt = beginn + schritt * schrittweite;
    const entscheidung = evaluateReportSchedule({ now: jetzt, lastReportAt: null });
    const termin = entscheidung.dueSlot;
    if (termin === null || termin > jetzt) {
      verstoesse.push(`${viennaClock(jetzt)}: Termin ${termin} liegt nicht vor jetzt`);
      continue;
    }
    if (entscheidung.nextSlot <= jetzt) {
      verstoesse.push(
        `${viennaClock(jetzt)}: nächster Termin ${entscheidung.nextSlot} liegt nicht danach`,
      );
      continue;
    }
    const gezeigt = viennaClock(termin);
    if (!/^Mon \d{4}-\d{2}-\d{2} 07:00:00$/.test(gezeigt)) {
      verstoesse.push(`${viennaClock(jetzt)}: Termin zeigt ${gezeigt}`);
    }
  }
  return verstoesse;
}

const HOUR = 3_600_000;

const MO_23_MAERZ = Date.parse('2026-03-23T06:00:00Z');
const MO_30_MAERZ = Date.parse('2026-03-30T05:00:00Z');
const MO_19_OKTOBER = Date.parse('2026-10-19T05:00:00Z');
const MO_26_OKTOBER = Date.parse('2026-10-26T06:00:00Z');

describe('der Termin: Montag 07:00 Europe/Vienna', () => {
  it('findet den Montag der laufenden Woche', () => {
    const mittwoch = Date.parse('2026-08-19T12:00:00Z');
    expect(viennaClock(slotAtOrBefore(mittwoch))).toBe('Mon 2026-08-17 07:00:00');
  });

  it('zählt den Termin selbst schon als verstrichen', () => {
    const termin = Date.parse('2026-08-17T05:00:00Z');
    expect(slotAtOrBefore(termin)).toBe(termin);
    expect(evaluateReportSchedule({ now: termin, lastReportAt: termin - 7 * 24 * HOUR }).due).toBe(
      true,
    );
  });

  it('rechnet Montag 06:59 noch der Vorwoche zu', () => {
    const kurzDavor = Date.parse('2026-08-17T04:59:00Z');
    expect(viennaClock(kurzDavor)).toBe('Mon 2026-08-17 06:59:00');
    expect(viennaClock(slotAtOrBefore(kurzDavor))).toBe('Mon 2026-08-10 07:00:00');
  });

  it('rechnet Sonntag 23:59 der Vorwoche zu', () => {
    const sonntagNacht = Date.parse('2026-08-16T21:59:00Z');
    expect(viennaClock(sonntagNacht)).toBe('Sun 2026-08-16 23:59:00');
    expect(viennaClock(slotAtOrBefore(sonntagNacht))).toBe('Mon 2026-08-10 07:00:00');
  });

  it('nennt als nächsten Termin einen, der echt nach jetzt liegt', () => {
    for (const iso of ['2026-08-17T04:59:00Z', '2026-08-17T05:00:00Z', '2026-08-19T12:00:00Z']) {
      const jetzt = Date.parse(iso);
      expect(nextSlotAfter(jetzt)).toBeGreaterThan(jetzt);
      expect(viennaClock(nextSlotAfter(jetzt))).toMatch(/^Mon .* 07:00:00$/);
    }
  });
});

describe('Sommerzeit: der Termin bleibt auf der Uhr stehen, nicht auf dem Zeitstrahl', () => {
  it('setzt den Montag nach der Frühjahrsumstellung auf 05:00 UTC', () => {
    const dienstagDavor = Date.parse('2026-03-31T09:00:00Z');
    const termin = slotAtOrBefore(dienstagDavor);
    expect(termin).toBe(MO_30_MAERZ);
    expect(viennaClock(termin)).toBe('Mon 2026-03-30 07:00:00');
  });

  it('setzt den Montag nach der Herbstumstellung auf 06:00 UTC', () => {
    const dienstagDanach = Date.parse('2026-10-27T09:00:00Z');
    const termin = slotAtOrBefore(dienstagDanach);
    expect(termin).toBe(MO_26_OKTOBER);
    expect(viennaClock(termin)).toBe('Mon 2026-10-26 07:00:00');
  });

  it('lässt über die Frühjahrsumstellung 167 Stunden zwischen zwei Terminen', () => {
    expect(slotAtOrBefore(MO_23_MAERZ)).toBe(MO_23_MAERZ);
    expect(nextSlotAfter(MO_23_MAERZ)).toBe(MO_30_MAERZ);
    expect((MO_30_MAERZ - MO_23_MAERZ) / HOUR).toBe(167);
  });

  it('lässt über die Herbstumstellung 169 Stunden zwischen zwei Terminen', () => {
    expect(slotAtOrBefore(MO_19_OKTOBER)).toBe(MO_19_OKTOBER);
    expect(nextSlotAfter(MO_19_OKTOBER)).toBe(MO_26_OKTOBER);
    expect((MO_26_OKTOBER - MO_19_OKTOBER) / HOUR).toBe(169);
  });

  it('zeigt an jedem Termin des Jahres 2026 lokal Montag 07:00:00', () => {
    // Die Zusicherung, die ein fester Stundenversatz nicht überlebt: er hielte
    // die UTC-Zeit fest und liesse die Ortszeit im Sommer auf 08:00 wandern.
    let termin = slotAtOrBefore(Date.parse('2026-01-05T12:00:00Z'));
    const abstaende: number[] = [];
    for (let woche = 0; woche < 52; woche += 1) {
      expect(viennaClock(termin)).toMatch(/^Mon \d{4}-\d{2}-\d{2} 07:00:00$/);
      const naechster = nextSlotAfter(termin);
      abstaende.push((naechster - termin) / HOUR);
      termin = naechster;
    }
    // Genau eine kurze und genau eine lange Woche im Jahr, alles andere 168 h.
    expect(abstaende.filter((stunden) => stunden === 167)).toHaveLength(1);
    expect(abstaende.filter((stunden) => stunden === 169)).toHaveLength(1);
    expect(abstaende.every((stunden) => stunden >= 167 && stunden <= 169)).toBe(true);
  });

  it('hält stündlich über ein Jahr die Ordnung Termin ≤ jetzt < nächster Termin', () => {
    // Gesammelt statt je Durchgang zugesichert: 8760 × 3 Zusicherungen kosten
    // mehr Zeit als die Rechnung selbst, und eine belastete Maschine färbte
    // sonst einen richtigen Code rot (A68). Der Bericht nennt die ersten drei
    // Verstösse im Klartext, was mehr sagt als ein einzelner roter Durchgang.
    expect(ordnungsverstoesse(Date.parse('2026-01-01T00:00:00Z'), 365 * 24, HOUR)).toEqual([]);
  });

  it('gibt über beide Eingänge dieselben Termine aus', () => {
    // Der Durchlauf oben fährt `evaluateReportSchedule`; die beiden einzelnen
    // Funktionen sind ein zweiter Eingang in dieselbe Rechnung, und zwei
    // Eingänge, die auseinanderlaufen können, tun es irgendwann (A81).
    for (const iso of [
      '2026-03-29T00:30:00Z',
      '2026-03-30T04:59:59Z',
      '2026-10-25T01:30:00Z',
      '2026-10-26T05:59:59Z',
      '2026-08-19T12:00:00Z',
    ]) {
      const jetzt = Date.parse(iso);
      const entscheidung = evaluateReportSchedule({ now: jetzt, lastReportAt: null });
      expect(entscheidung.dueSlot).toBe(slotAtOrBefore(jetzt));
      expect(entscheidung.nextSlot).toBe(nextSlotAfter(jetzt));
    }
  });

  it('hält dieselbe Ordnung minutennah um jede der vier Umstellungen', () => {
    const umstellungen = [
      Date.parse('2026-03-29T01:00:00Z'),
      Date.parse('2026-10-25T01:00:00Z'),
      Date.parse('2027-03-28T01:00:00Z'),
      Date.parse('2027-10-31T01:00:00Z'),
    ];
    for (const umstellung of umstellungen) {
      expect(ordnungsverstoesse(umstellung - 36 * HOUR, 864, 5 * 60_000)).toEqual([]);
    }
  });
});

describe('Fälligkeit: genau einmal je Termin', () => {
  it('wird von zwanzig Ticks innerhalb von 15 Sekunden genau einmal ausgelöst', () => {
    const vorwoche = Date.parse('2026-08-10T05:00:00Z');
    let letzterBericht: number | null = vorwoche;
    let ausloesungen = 0;
    for (let tick = 0; tick < 20; tick += 1) {
      const jetzt = Date.parse('2026-08-17T05:00:00Z') + tick * 750;
      const entscheidung = evaluateReportSchedule({ now: jetzt, lastReportAt: letzterBericht });
      if (entscheidung.due) {
        ausloesungen += 1;
        // Der Aufrufer schreibt seine Zeile, nachdem der Bericht erzeugt wurde.
        letzterBericht = jetzt;
      }
    }
    expect(ausloesungen).toBe(1);
  });

  it('holt nach einer Ausfallzeit von Montag 06:00 bis Dienstag 09:00 genau einen nach', () => {
    const vorwoche = Date.parse('2026-08-10T05:00:00Z');
    let letzterBericht: number | null = vorwoche;
    let ausloesungen = 0;
    const start = Date.parse('2026-08-18T07:00:00Z');
    for (let tick = 0; tick < 40; tick += 1) {
      const jetzt = start + tick * 15_000;
      const entscheidung = evaluateReportSchedule({ now: jetzt, lastReportAt: letzterBericht });
      if (entscheidung.due) {
        ausloesungen += 1;
        expect(entscheidung.reason).toBe('slot_passed');
        expect(entscheidung.dueSlot).toBe(Date.parse('2026-08-17T05:00:00Z'));
        letzterBericht = jetzt;
      }
    }
    expect(ausloesungen).toBe(1);
  });

  it('holt nach drei Wochen Ausfall einen Bericht nach und nicht drei', () => {
    const dreiWochenAlt = Date.parse('2026-07-27T05:00:00Z');
    let letzterBericht: number | null = dreiWochenAlt;
    let ausloesungen = 0;
    for (let tick = 0; tick < 10; tick += 1) {
      const jetzt = Date.parse('2026-08-19T12:00:00Z') + tick * 15_000;
      const entscheidung = evaluateReportSchedule({ now: jetzt, lastReportAt: letzterBericht });
      if (entscheidung.due) {
        ausloesungen += 1;
        letzterBericht = jetzt;
      }
    }
    expect(ausloesungen).toBe(1);
  });

  it('ist ohne vorherigen Bericht sofort fällig und sagt, warum', () => {
    const jetzt = Date.parse('2026-08-19T12:00:00Z');
    const entscheidung = evaluateReportSchedule({ now: jetzt, lastReportAt: null });
    expect(entscheidung.due).toBe(true);
    expect(entscheidung.reason).toBe('never_run');
    expect(entscheidung.dueSlot).toBe(Date.parse('2026-08-17T05:00:00Z'));
  });

  it('meldet nach einem frischen Bericht nichts Fälliges und nennt keinen Termin', () => {
    const jetzt = Date.parse('2026-08-19T12:00:00Z');
    const entscheidung = evaluateReportSchedule({ now: jetzt, lastReportAt: jetzt - HOUR });
    expect(entscheidung.due).toBe(false);
    expect(entscheidung.reason).toBe('already_reported');
    expect(entscheidung.dueSlot).toBeNull();
    expect(viennaClock(entscheidung.nextSlot)).toBe('Mon 2026-08-24 07:00:00');
  });
});

describe('Fälligkeit über eine Umstellung hinweg', () => {
  it('wird nach 167 Stunden fällig, statt auf die 168. zu warten', () => {
    const knappDavor = evaluateReportSchedule({
      now: MO_30_MAERZ - 1,
      lastReportAt: MO_23_MAERZ,
    });
    expect(knappDavor.due).toBe(false);

    const amTermin = evaluateReportSchedule({ now: MO_30_MAERZ, lastReportAt: MO_23_MAERZ });
    expect(amTermin.due).toBe(true);
    expect(amTermin.dueSlot).toBe(MO_30_MAERZ);
    // Der Satz, den ein fester Versatz nicht sagen kann: es sind erst 167 h.
    expect((MO_30_MAERZ - MO_23_MAERZ) / HOUR).toBeLessThan(168);
  });

  it('wird nach 168 Stunden noch nicht fällig, wenn die Woche 169 hat', () => {
    const nach168 = MO_19_OKTOBER + 168 * HOUR;
    expect(viennaClock(nach168)).toBe('Mon 2026-10-26 06:00:00');
    expect(evaluateReportSchedule({ now: nach168, lastReportAt: MO_19_OKTOBER }).due).toBe(false);

    const amTermin = evaluateReportSchedule({ now: MO_26_OKTOBER, lastReportAt: MO_19_OKTOBER });
    expect(amTermin.due).toBe(true);
    expect(amTermin.dueSlot).toBe(MO_26_OKTOBER);
  });

  it('löst über die lange Woche genau einmal aus, nicht zweimal', () => {
    let letzterBericht: number | null = MO_19_OKTOBER;
    let ausloesungen = 0;
    // Jede Viertelstunde von Sonntag früh bis Montagmittag — quer über die
    // Umstellung, quer über die doppelt gezählte Stunde, quer über den Termin.
    const start = Date.parse('2026-10-24T22:00:00Z');
    const ende = Date.parse('2026-10-26T12:00:00Z');
    for (let jetzt = start; jetzt <= ende; jetzt += 15 * 60_000) {
      const entscheidung = evaluateReportSchedule({ now: jetzt, lastReportAt: letzterBericht });
      if (entscheidung.due) {
        ausloesungen += 1;
        letzterBericht = jetzt;
      }
    }
    expect(ausloesungen).toBe(1);
  });
});

describe('viennaInstant: die beiden Konventionen, die der Wochenplan nie erreicht', () => {
  it('löst eine gewöhnliche Uhrzeit in beiden Jahreshälften auf', () => {
    expect(viennaInstant({ year: 2026, month: 1, day: 12 }, REPORT_HOUR)).toBe(
      Date.parse('2026-01-12T06:00:00Z'),
    );
    expect(viennaInstant({ year: 2026, month: 7, day: 13 }, REPORT_HOUR)).toBe(
      Date.parse('2026-07-13T05:00:00Z'),
    );
  });

  it('nimmt bei doppelter Uhrzeit die frühere der beiden Gelegenheiten', () => {
    // 2026-10-25: die Uhr zeigt 02:00 zweimal — um 00:00Z (CEST) und 01:00Z (CET).
    const aufgeloest = viennaInstant({ year: 2026, month: 10, day: 25 }, 2);
    expect(viennaClock(Date.parse('2026-10-25T00:00:00Z'))).toBe('Sun 2026-10-25 02:00:00');
    expect(viennaClock(Date.parse('2026-10-25T01:00:00Z'))).toBe('Sun 2026-10-25 02:00:00');
    expect(aufgeloest).toBe(Date.parse('2026-10-25T00:00:00Z'));
  });

  it('schiebt eine übersprungene Uhrzeit hinter die Lücke statt sie fallenzulassen', () => {
    // 2026-03-29: die Uhr springt von 02:00 auf 03:00, es gibt kein 02:xx.
    const zweiUhr = viennaInstant({ year: 2026, month: 3, day: 29 }, 2);
    expect(zweiUhr).toBe(Date.parse('2026-03-29T01:00:00Z'));
    expect(viennaClock(zweiUhr)).toBe('Sun 2026-03-29 03:00:00');
    // Und keinesfalls davor: eine ausgelassene Woche wäre die einzig falsche Antwort.
    expect(zweiUhr).toBeGreaterThan(Date.parse('2026-03-29T00:59:59Z'));
  });
});

describe('Verweigerungen', () => {
  it('wirft bei einem Zeitpunkt, der keine Zahl ist, statt still nie fällig zu werden', () => {
    expect(() => evaluateReportSchedule({ now: Number.NaN, lastReportAt: null })).toThrow(
      TypeError,
    );
    expect(() => evaluateReportSchedule({ now: Date.now(), lastReportAt: Number.NaN })).toThrow(
      TypeError,
    );
    expect(() => slotAtOrBefore(Number.POSITIVE_INFINITY)).toThrow(TypeError);
    expect(() => nextSlotAfter(Number.NaN)).toThrow(TypeError);
  });
});

describe('addDays: Kalenderarithmetik ohne Zeitzone', () => {
  it('geht über Monats-, Jahres- und Schaltjahresgrenzen', () => {
    expect(addDays({ year: 2026, month: 12, day: 28 }, 7)).toEqual({
      year: 2027,
      month: 1,
      day: 4,
    });
    expect(addDays({ year: 2026, month: 3, day: 2 }, -7)).toEqual({
      year: 2026,
      month: 2,
      day: 23,
    });
    expect(addDays({ year: 2028, month: 2, day: 26 }, 7)).toEqual({ year: 2028, month: 3, day: 4 });
  });
});
