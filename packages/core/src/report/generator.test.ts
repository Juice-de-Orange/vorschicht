/**
 * Der Wochenbericht (§16), ohne Datenbank.
 *
 * Vier Dinge werden hier geprüft, und drei davon sind Eigenschaften, die man
 * verliert, wenn man nur die naheliegende Richtung ansieht:
 *
 *  1. **Die Struktur ist exakt §16s.** Sechs Abschnitte, in ihrer Reihenfolge,
 *     und **jeder steht auch dann, wenn er leer ist**. Die zweite Hälfte ist
 *     die wichtigere: ein fehlender Abschnitt ist von einem kaputten Renderer
 *     nicht zu unterscheiden, und §16.5 verlangt für die Betriebsprüfung
 *     ausdrücklich einen Satz auch dann, wenn nichts gefunden wurde.
 *
 *  2. **Die Längengrenze wird erzwungen, und zwar von der redaktionellen
 *     Schicht.** Der tragende Fall fährt aufgeblähte Daten und sichert zwei
 *     Dinge zu: der Klartext liegt unter der Grenze, **und** die mechanische
 *     Notbremse musste dafür nichts verwerfen (`droppedByCap === 0`). Ohne die
 *     zweite Hälfte wäre der Fall gegen eine Umsetzung grün, in der es
 *     überhaupt keine Abschnittsgrenzen gibt — die Notbremse würde dann eben
 *     kürzen, und der Bericht sähe unauffällig aus, während er in Wahrheit
 *     einen ganzen Abschnitt verloren hat.
 *
 *  3. **HTML und Klartext tragen dieselben Tatsachen.** A82s Lehre: eine
 *     Zusicherung, die nur eine Darstellung ansieht, liest sich wie eine, die
 *     beide ansieht. Deshalb läuft die Faktenliste über beide Teile.
 *
 *  4. **Eine fehlende Grösse wird zu ihrem Satz, nie zu einer 0.** Geprüft in
 *     beide Richtungen: der Satz steht da, **und** die 0 steht nicht da.
 */
import { describe, expect, it } from 'vitest';
import type { GateFindingCount, MetricsWindow, StudioMetrics } from '../metrics/index.js';
import { known, unknown, windowLabel } from '../metrics/index.js';
import {
  clampText,
  formatDay,
  formatInteger,
  formatMillis,
  type ProjectOutcome,
  plural,
  renderWeeklyReport,
  WEEKLY_REPORT_MAX_CHARS,
  type WeeklyReportData,
} from './generator.js';

const WINDOW: MetricsWindow = {
  from: new Date('2026-08-10T00:00:00+02:00'),
  to: new Date('2026-08-17T00:00:00+02:00'),
};

const SECTION_TITLES = [
  '1. Kopfzahlen',
  '2. Je Projekt',
  '3. Qualitätstrend',
  '4. Radar',
  '5. Betriebsprüfung',
  '6. Nächste Woche',
];

function studioMetrics(overrides: Partial<StudioMetrics> = {}): StudioMetrics {
  const label = windowLabel(WINDOW);
  return {
    headline: {
      window: label,
      throughput: { tasksDone: 12, merges: 9, deploys: 7, rollbacks: 1, failedDeploys: 0 },
      gates: {
        passed: 14,
        failed: 2,
        inconclusive: 3,
        unreadable: 0,
        rate: known(0.875),
      },
      budget: {
        source: 'usage_samples',
        windows: [
          {
            windowKind: 'five_hour',
            modelClass: null,
            samples: 38,
            blindSamples: 0,
            average: known(42.1),
            peak: known(91),
            bySource: { official: 4, estimated: 34 },
          },
          {
            windowKind: 'seven_day',
            modelClass: null,
            samples: 38,
            blindSamples: 2,
            average: known(51),
            peak: known(77),
            bySource: { official: 4, estimated: 34 },
          },
        ],
        unknownReason: null,
      },
      escalations: { answered: 4, open: 2 },
      ...overrides.headline,
    },
    quality: {
      window: label,
      redRate: { tasksRed: 2, tasksConcluded: 12, rate: known(2 / 12) },
      findingsByGate: [
        { gateId: 'test', findings: 4, tasks: 3 },
        { gateId: 'lint', findings: 1, tasks: 1 },
      ],
      timeToGreen: {
        resolved: 7,
        stillOpen: 2,
        medianMs: known(42 * 60_000),
        p90Ms: known(190 * 60_000),
        slowest: {
          taskId: 'aufgabe-1',
          gateId: 'test',
          raisedRunId: '1',
          raisedAt: '2026-08-11T08:00:00.000Z',
          resolvedRunId: '2',
          resolvedAt: '2026-08-11T11:10:00.000Z',
          durationMs: 190 * 60_000,
        },
      },
      ...overrides.quality,
    },
  };
}

function project(name: string, overrides: Partial<ProjectOutcome> = {}): ProjectOutcome {
  return {
    projectId: `id-${name}`,
    name,
    tasksDone: 3,
    merges: 2,
    deploys: 1,
    rollbacks: 0,
    shipped: [`${name}: erste Sache`, `${name}: zweite Sache`, `${name}: dritte Sache`],
    ...overrides,
  };
}

function data(overrides: Partial<WeeklyReportData> = {}): WeeklyReportData {
  return {
    window: WINDOW,
    metrics: studioMetrics(),
    projects: [project('vorschicht')],
    radar: {
      runs: 28,
      entries: [
        {
          kind: 'dependency_major',
          name: 'hono',
          current: '4.13.2',
          latest: '5.0.0',
          escalationNumber: 17,
          trustLevel: null,
        },
      ],
      tasks: 2,
      limits: ['Anthropics Help Center — kein Kanal konfiguriert'],
      problems: [],
    },
    audit: {
      runs: 1,
      verdicts: [
        {
          auditId: 'pruefung-1',
          domain: 'gate_truth',
          verdict: 'funde_zu_beheben',
          outcome: 'done',
        },
      ],
      confirmed: [
        {
          class: 'process',
          summary: 'Eine Belegzeile nennt eine falsche Datei.',
          gate: null,
          status: 'open',
        },
      ],
      suspicions: 1,
      dismissed: 0,
      scopeLimits: ['Der Prüfer führt nichts aus.'],
    },
    nextWeek: {
      source: 'queued_tasks',
      entries: [
        { taskId: 't-1', title: 'Archivseite bauen', priority: 'P1', project: 'vorschicht' },
      ],
      total: 4,
    },
    ...overrides,
  };
}

/** Ein Bericht ohne jeden Vorgang: sechs Abschnitte, die etwas sagen müssen. */
function emptyData(): WeeklyReportData {
  return data({
    metrics: studioMetrics({
      headline: {
        window: windowLabel(WINDOW),
        throughput: { tasksDone: 0, merges: 0, deploys: 0, rollbacks: 0, failedDeploys: 0 },
        gates: { passed: 0, failed: 0, inconclusive: 0, unreadable: 0, rate: unknown('no_data') },
        budget: { source: 'usage_samples', windows: [], unknownReason: 'no_data' },
        escalations: { answered: 0, open: 0 },
      },
      quality: {
        window: windowLabel(WINDOW),
        redRate: { tasksRed: 0, tasksConcluded: 0, rate: unknown('no_data') },
        findingsByGate: [],
        timeToGreen: {
          resolved: 0,
          stillOpen: 0,
          medianMs: unknown('no_data'),
          p90Ms: unknown('no_data'),
          slowest: null,
        },
      },
    }),
    projects: [],
    radar: { runs: 0, entries: [], tasks: 0, limits: [], problems: [] },
    audit: { runs: 0, verdicts: [], confirmed: [], suspicions: 0, dismissed: 0, scopeLimits: [] },
    nextWeek: { source: 'queued_tasks', entries: [], total: 0 },
  });
}

describe('§16s Struktur', () => {
  it('trägt genau die sechs Abschnitte, in der Reihenfolge der Spezifikation', () => {
    const report = renderWeeklyReport(data());
    expect(report.sections.map((section) => section.title)).toEqual(SECTION_TITLES);
  });

  it('zeigt jeden der sechs Abschnitte in beiden Darstellungen', () => {
    const report = renderWeeklyReport(data());
    for (const title of SECTION_TITLES) {
      expect(report.text).toContain(title);
      expect(report.html).toContain(title);
    }
  });

  it('lässt keinen Abschnitt weg, wenn er leer ist — jeder sagt stattdessen etwas', () => {
    const report = renderWeeklyReport(emptyData());
    expect(report.sections.map((section) => section.title)).toEqual(SECTION_TITLES);
    for (const section of report.sections) {
      // Ein Abschnitt ohne Einträge **und** ohne Satz wäre von einem kaputten
      // Renderer nicht zu unterscheiden.
      expect(section.entries.length + section.notes.length).toBeGreaterThan(0);
    }
  });

  it('nennt im Betreff den letzten Tag des Fensters, nicht den ersten der Folgewoche', () => {
    // Das Fenster ist halboffen (`metrics/window.ts`): `to` ist der Montag
    // darauf. Ein Betreff, der ihn nennt, behauptet einen Bericht über acht
    // Tage — und zwei aufeinanderfolgende Berichte nennten denselben Tag.
    const report = renderWeeklyReport(data());
    expect(report.subject).toBe('Vorschicht — Wochenbericht 10.08.2026–16.08.2026');
    expect(report.subject).not.toContain('17.08.2026');
  });
});

describe('Entscheidung 2 — leere Abschnitte sagen, welche Art von Leere', () => {
  it('unterscheidet „kein Radar-Lauf" von „Radar lief, ohne Fund"', () => {
    const nieGelaufen = renderWeeklyReport(emptyData()).text;
    expect(nieGelaufen).toContain('Kein Radar-Lauf im Zeitfenster');
    expect(nieGelaufen).toContain('keine Entwarnung');
    expect(nieGelaufen).not.toContain('Kein Radar-Fund im Zeitfenster');

    const gelaufenOhneFund = renderWeeklyReport(
      data({ radar: { runs: 4, entries: [], tasks: 0, limits: [], problems: [] } }),
    ).text;
    expect(gelaufenOhneFund).toContain('Kein Radar-Fund im Zeitfenster');
    expect(gelaufenOhneFund).not.toContain('Kein Radar-Lauf im Zeitfenster');
  });

  it('sagt §16.5s Satz über die Betriebsprüfung auch dann, wenn sie nichts fand', () => {
    const ohnePruefung = renderWeeklyReport(emptyData()).text;
    expect(ohnePruefung).toContain('Keine Betriebsprüfung in diesem Zeitfenster');

    const ohneGrenzen = renderWeeklyReport(
      data({
        audit: {
          runs: 1,
          verdicts: [
            { auditId: 'a', domain: 'gate_truth', verdict: 'unbedenklich', outcome: 'done' },
          ],
          confirmed: [],
          suspicions: 0,
          dismissed: 0,
          scopeLimits: [],
        },
      }),
    ).text;
    // §16.5 wörtlich: „stated even when empty".
    expect(ohneGrenzen).toContain('Keine Prüfgrenzen gemeldet');
    expect(ohneGrenzen).toContain('Kein bestätigter Fund.');
  });

  it('benennt die abgestürzte Prüfung, statt sie wie eine ausgebliebene aussehen zu lassen', () => {
    const report = renderWeeklyReport(
      data({
        audit: {
          runs: 1,
          verdicts: [{ auditId: 'a', domain: 'gate_truth', verdict: null, outcome: 'failed' }],
          confirmed: [],
          suspicions: 0,
          dismissed: 0,
          scopeLimits: [],
        },
      }),
    );
    expect(report.text).toContain('abgebrochen, ohne Urteil');
    expect(report.text).not.toContain('Keine Betriebsprüfung in diesem Zeitfenster');
  });

  it('sagt, dass §5s `goals` keinen Erzeuger hat, statt Ziele zu erfinden', () => {
    const report = renderWeeklyReport(data());
    expect(report.text).toContain('weder Tabelle noch Erzeuger');
    expect(report.text).toContain('Warteschlange');
  });

  it('nennt die Herkunft der Budgetzahlen, weil sie nicht im Ereignisprotokoll liegen', () => {
    const report = renderWeeklyReport(data());
    expect(report.text).toContain('Budgetquelle: usage_samples (nicht das Ereignisprotokoll)');
  });

  it('sagt, dass die Radar-Funde keine Vertrauensstufe tragen — und leitet es ab', () => {
    const ohneStufe = renderWeeklyReport(data()).text;
    expect(ohneStufe).toContain('Vertrauensstufen (§14) fehlen an allen Funden');
    expect(ohneStufe).toContain('Vertrauensstufe nicht vergeben');

    // Die Gegenrichtung: gäbe es morgen einen Erzeuger, verschwände der Satz
    // von selbst. Ohne diesen Fall wäre der Hinweis eine Konstante, die auch
    // dann noch behauptet würde, wenn sie falsch ist.
    const mitStufe = renderWeeklyReport(
      data({
        radar: {
          runs: 1,
          entries: [
            {
              kind: 'dependency_advisory',
              name: 'hono',
              current: '4.0.0',
              latest: '4.13.2',
              escalationNumber: 3,
              trustLevel: 5,
            },
          ],
          tasks: 0,
          limits: [],
          problems: [],
        },
      }),
    ).text;
    expect(mitStufe).not.toContain('Vertrauensstufen (§14) fehlen');
    expect(mitStufe).toContain('Vertrauensstufe L5');
  });
});

describe('Entscheidung 4 — eine fehlende Grösse wird zu ihrem Satz', () => {
  it('schreibt den deutschen Grund statt einer 0 oder eines Gedankenstrichs', () => {
    const report = renderWeeklyReport(emptyData());
    const zeile = lineWith(report.text, 'Rot-Quote:');
    expect(zeile).toContain('nicht feststellbar (keine Daten im Zeitfenster)');
    expect(zeile).not.toContain('0,0 %');
    expect(zeile).not.toContain('—');
  });

  it('unterscheidet „keine Daten" von „Daten da, aber keine, aus der sich die Zahl ergibt"', () => {
    const report = renderWeeklyReport(
      data({
        metrics: studioMetrics({
          headline: {
            ...studioMetrics().headline,
            gates: {
              passed: 0,
              failed: 0,
              inconclusive: 5,
              unreadable: 1,
              rate: unknown('inconclusive'),
            },
          },
        }),
      }),
    );
    const zeile = lineWith(report.text, 'Gate-Durchlaufquote:');
    expect(zeile).toContain('Daten vorhanden, aber keine, aus der sich die Zahl ergibt');
    expect(zeile).not.toContain('keine Daten im Zeitfenster');
  });

  it('verwechselt Anteil und Prozentpunkte nicht — dieselbe Zahl, zwei Skalen', () => {
    // A73.2 hat gemessen, was eine geteilte Skala kostet: 0,97 als „0,97
    // Prozent" gelesen setzt §7.2 still ausser Kraft. Beide Felder tragen hier
    // **denselben** Wert 0,9; ein gemeinsamer Formatierer könnte diesen Fall
    // nicht bestehen.
    const basis = studioMetrics();
    const report = renderWeeklyReport(
      data({
        metrics: studioMetrics({
          headline: {
            ...basis.headline,
            gates: { ...basis.headline.gates, rate: known(0.9) },
            budget: {
              source: 'usage_samples',
              windows: [
                {
                  windowKind: 'five_hour',
                  modelClass: null,
                  samples: 3,
                  blindSamples: 0,
                  average: known(0.9),
                  peak: known(0.9),
                  bySource: { official: 0, estimated: 3 },
                },
              ],
              unknownReason: null,
            },
          },
        }),
      }),
    );
    expect(lineWith(report.text, 'Gate-Durchlaufquote:')).toContain('90,0 %');
    expect(lineWith(report.text, 'Budget 5-Stunden-Fenster:')).toContain('0,9 %');
  });

  it('zählt blinde Budgetmessungen getrennt, statt sie zu mitteln', () => {
    const report = renderWeeklyReport(data());
    expect(lineWith(report.text, 'Budget Woche:')).toContain('2 blind');
  });
});

describe('Entscheidung 3 — HTML und Klartext tragen dieselben Tatsachen', () => {
  it('nennt jede tragende Zahl in beiden Teilen', () => {
    const report = renderWeeklyReport(data());
    const fakten = [
      'Aufgaben erledigt: 12',
      'Merges: 9',
      'gescheitert ohne Rückweg: 0',
      '87,5 %',
      'Entscheidungen: 4 beantwortet',
      'Rot-Quote:',
      'funde_zu_beheben',
      'Archivseite bauen',
    ];
    for (const fakt of fakten) {
      expect(report.text, `Klartext ohne "${fakt}"`).toContain(fakt);
      expect(report.html, `HTML ohne "${fakt}"`).toContain(fakt);
    }
  });

  it('maskiert im HTML und lässt den Klartext wörtlich', () => {
    const boese = '<script>alert("x")</script> & "Anführung"';
    const report = renderWeeklyReport(data({ projects: [project(boese, { tasksDone: 1 })] }));

    expect(report.text).toContain(boese);
    expect(report.html).not.toContain('<script>');
    expect(report.html).toContain('&lt;script&gt;');
    expect(report.html).toContain('&amp;');
    expect(report.html).toContain('&quot;');
  });

  it('liefert ein vollständiges HTML-Dokument', () => {
    const report = renderWeeklyReport(data());
    expect(report.html.startsWith('<!doctype html>')).toBe(true);
    expect(report.html).toContain('<html lang="de">');
    expect(report.html.endsWith('</body></html>')).toBe(true);
  });
});

/**
 * §22 P8.G1: „renders in common mail clients (HTML + plain verified)“.
 *
 * Die letzte Hälfte dieses Satzes kann kein Test hier beantworten — dafür
 * braucht es ein echtes Mailprogramm, und das Gate bleibt bis dahin nach A38
 * verschoben. Was ein Test **kann**, ist die Vorbedingung: dass die Fassung
 * nicht in einer Bauform ankommt, von der bekannt ist, dass sie bricht.
 *
 * Bis zum 25.8.2026 tat sie genau das. Der Erzeuger schrieb einen
 * `<style>`-Block in den `<head>` und `class`-Attribute darunter — Gmail
 * entfernt den `<head>` bei Nachrichten über ein Drittanbieter-Konto, und
 * Outlooks Desktop-Fassung rendert mit Words Maschine, die Klassenselektoren
 * nur teilweise auflöst. Gefunden wurde es **nicht** am Code, sondern an einem
 * Widerspruch: `packages/shared/src/berichte.ts` beschreibt diese Fassung seit
 * ihrem ersten Tag als „mit Tabellen, Inline-Stilen und einem eigenen
 * `<html>`-Dokument“, und niemand hatte die Beschreibung je gegen den Erzeuger
 * gehalten. Zwei von dreien stimmten.
 *
 * Als **Test** und nicht als Skript, weil ein Skript ohne Aufrufer die Form
 * ist, die dieses Projekt schon dreimal gefunden hat (A71): so läuft die
 * Prüfung in jedem Gate-Lauf statt dann, wenn jemand daran denkt.
 */
describe('§22 P8.G1 — die Mailfassung ist mailtauglich gebaut', () => {
  const html = () => renderWeeklyReport(data()).html;

  it('trägt keinen `<style>`-Block und keine Klassen', () => {
    // Die eine Regel, an der es lag. `<style>` wird von Gmail entfernt und von
    // Word nur teilweise gelesen; ohne sie fiele der Bericht auf Rohtext
    // zurück — formatiert genau dort nicht, wo §22s Satz ihn sehen will.
    expect(html()).not.toMatch(/<style[\s>]/i);
    expect(html()).not.toMatch(/\sclass=/i);
  });

  it('benutzt keine Layoutverfahren, die Word nicht kennt', () => {
    expect(html()).not.toMatch(/display\s*:\s*(flex|grid)/i);
    expect(html()).not.toMatch(/\bposition\s*:\s*(absolute|fixed)/i);
  });

  it('trägt das Layout in einer Tabelle, und die ist als Layout ausgewiesen', () => {
    // `role="presentation"`, damit ein Screenreader sie nicht als Datentabelle
    // vorliest — §17s a11y-Haltung endet nicht an der Mailgrenze.
    expect(html()).toMatch(/<table[^>]*role="presentation"/);
    expect(html()).not.toMatch(/<div[\s>]/i);
  });

  /**
   * Die tragende Zusicherung: **jedes** sichtbare Element trägt seinen Stil
   * selbst. Ohne sie bestünde die Datei auch dann, wenn ein einzelnes Element
   * beim nächsten Umbau wieder auf eine Klasse zurückfiele — und genau ein
   * unformatierter Abschnitt ist der Fehler, den niemand meldet.
   */
  it('stilisiert jedes sichtbare Element inline', () => {
    const roh = html();
    const ohneStil = [...roh.matchAll(/<(h1|h2|p|ul|li)(\s[^>]*)?>/g)].filter(
      (treffer) => !(treffer[2] ?? '').includes('style="'),
    );
    expect(
      ohneStil.map((t) => t[0]),
      'jedes sichtbare Element braucht seinen Stil inline',
    ).toEqual([]);
    // Und der Zähler darf nicht über einer leeren Menge bestehen (A134.4).
    expect([...roh.matchAll(/<(h1|h2|p|ul|li)(\s[^>]*)?>/g)].length).toBeGreaterThan(10);
  });

  it('macht die Beschreibung in `berichte.ts` wahr', () => {
    // Der Widerspruch, der den Fund getragen hat — als Zusicherung, damit er
    // nicht ein zweites Mal auseinanderläuft.
    const roh = html();
    expect(roh).toContain('<table');
    expect(roh).toContain('style="');
    expect(roh).toContain('<html lang="de">');
  });
});

describe('§16.2 — höchstens drei Stichpunkte je Projekt', () => {
  it('zeigt drei und sagt, wie viele fehlen', () => {
    const report = renderWeeklyReport(
      data({
        projects: [
          project('gross', {
            tasksDone: 10,
            shipped: ['eins', 'zwei', 'drei', 'vier', 'fünf'],
          }),
        ],
      }),
    );
    const abschnitt = report.sections.find((section) => section.id === 'projekte');
    const eintrag = abschnitt?.entries[0];
    // Die drei Stichpunkte plus die Angabe, wie viele fehlen — der Hinweis ist
    // ausdrücklich kein vierter Stichpunkt im Sinne von §16.2.
    expect(eintrag?.details.slice(0, 3)).toEqual(['eins', 'zwei', 'drei']);
    expect(eintrag?.details.at(-1)).toBe('… und 7 weitere');
    expect(report.text).toContain('… und 7 weitere');
  });

  it('rechnet die fehlenden aus der Zählung, nicht aus der Länge der Titelliste', () => {
    // Die Abfrage holt höchstens drei Titel je Projekt; die Zahl der
    // fertiggestellten Aufgaben kommt aus dem Aggregat. Käme die Kürzungsangabe
    // aus der Titelliste, wäre sie immer 0 und der Bericht behauptete
    // Vollständigkeit.
    const report = renderWeeklyReport(
      data({ projects: [project('knapp', { tasksDone: 9, shipped: ['nur einer'] })] }),
    );
    expect(report.text).toContain('… und 8 weitere');
  });

  it('sortiert Projekte nach dem, was sie geliefert haben, dann nach Namen', () => {
    const report = renderWeeklyReport(
      data({
        projects: [
          project('bbb', { tasksDone: 1, merges: 0, deploys: 0 }),
          project('aaa', { tasksDone: 1, merges: 0, deploys: 0 }),
          project('viel', { tasksDone: 9, merges: 9, deploys: 9 }),
        ],
      }),
    );
    const abschnitt = report.sections.find((section) => section.id === 'projekte');
    expect(abschnitt?.entries.map((item) => item.text.split(' —')[0])).toEqual([
      'viel',
      'aaa',
      'bbb',
    ]);
  });

  it('behält die Zahlen eines Projekts, dessen Zeile in `projects` fehlt', () => {
    const report = renderWeeklyReport(
      data({ projects: [project('ohne Projekt', { projectId: null, tasksDone: 2 })] }),
    );
    expect(report.text).toContain('ohne Projekt — 2 Aufgaben');
  });
});

describe('Entscheidung 1 — die Längengrenze', () => {
  /** Alles, was unbegrenzt werden kann, aufgebläht — und jeder Text zu lang. */
  function padded(): WeeklyReportData {
    const lang = 'x'.repeat(5_000);
    const basis = studioMetrics();
    const gates: GateFindingCount[] = Array.from({ length: 200 }, (_, index) => ({
      gateId: `${lang}-gate-${index}`,
      findings: 200 - index,
      tasks: 3,
    }));
    return data({
      metrics: {
        headline: {
          ...basis.headline,
          budget: {
            source: 'usage_samples',
            windows: Array.from({ length: 40 }, (_, index) => ({
              windowKind: 'seven_day_model',
              modelClass: `${lang}-modell-${index}`,
              samples: 5,
              blindSamples: 0,
              average: known(50),
              peak: known(90),
              bySource: { official: 1, estimated: 4 },
            })),
            unknownReason: null,
          },
        },
        quality: { ...basis.quality, findingsByGate: gates },
      },
      projects: Array.from({ length: 500 }, (_, index) =>
        project(`${lang}-projekt-${index}`, {
          tasksDone: 40,
          shipped: Array.from({ length: 20 }, (_, titel) => `${lang}-titel-${titel}`),
        }),
      ),
      radar: {
        runs: 30,
        entries: Array.from({ length: 100 }, (_, index) => ({
          kind: 'dependency_major',
          name: `${lang}-paket-${index}`,
          current: '1.0.0',
          latest: '2.0.0',
          escalationNumber: index,
          trustLevel: null,
        })),
        tasks: 12,
        limits: Array.from({ length: 30 }, (_, index) => `${lang}-grenze-${index}`),
        problems: Array.from({ length: 30 }, (_, index) => `${lang}-problem-${index}`),
      },
      audit: {
        runs: 3,
        verdicts: Array.from({ length: 3 }, (_, index) => ({
          auditId: `pruefung-${index}`,
          domain: `${lang}-domaene`,
          verdict: 'funde_zu_beheben',
          outcome: 'done',
        })),
        confirmed: Array.from({ length: 60 }, (_, index) => ({
          class: 'defect',
          summary: `${lang}-fund-${index}`,
          gate: `${lang}-gate`,
          status: 'open',
        })),
        suspicions: 5,
        dismissed: 2,
        scopeLimits: Array.from({ length: 30 }, (_, index) => `${lang}-prüfgrenze-${index}`),
      },
      nextWeek: {
        source: 'queued_tasks',
        entries: Array.from({ length: 400 }, (_, index) => ({
          taskId: `t-${index}`,
          title: `${lang}-aufgabe-${index}`,
          priority: 'P2',
          project: lang,
        })),
        total: 400,
      },
    });
  }

  it('hält aufgeblähte Daten unter der Grenze — und die redaktionelle Schicht reicht dafür', () => {
    const report = renderWeeklyReport(padded());
    expect(report.text.length).toBeLessThanOrEqual(WEEKLY_REPORT_MAX_CHARS);
    expect(report.truncation.withinCap).toBe(true);
    // Die zweite Hälfte, ohne die der Fall nichts über die Abschnittsgrenzen
    // sagt: die mechanische Notbremse musste **nichts** verwerfen.
    expect(report.truncation.droppedByCap).toBe(0);
    expect(report.truncation.emptiedByCap).toEqual([]);
  });

  it('schreibt jede Kürzung aus, mit der Zahl der fehlenden Einträge', () => {
    const report = renderWeeklyReport(padded());
    expect(report.text).toContain('Gekürzt: 496 weitere Projekte');
    expect(report.text).toContain('Gekürzt: 196 weitere Gates mit Funden');
    expect(report.text).toContain('Gekürzt: 96 weitere Radar-Funde');
    expect(report.text).toContain('Gekürzt: 56 weitere bestätigte Funde');
    expect(report.text).toContain('Gekürzt: 396 weitere wartende Aufgaben');
    expect(report.text).toContain('Gekürzt: 36 weitere Budgetfenster');
    // Und dasselbe im HTML — eine Kürzung, die nur eine Darstellung nennt, ist
    // in der anderen unsichtbar.
    expect(report.html).toContain('Gekürzt: 496 weitere Projekte');
  });

  it('kürzt auch den einzelnen Eintrag, statt eine Zeile beliebig lang werden zu lassen', () => {
    const report = renderWeeklyReport(padded());
    for (const section of report.sections) {
      for (const item of section.entries) {
        expect(item.text.length).toBeLessThanOrEqual(120);
        for (const detail of item.details) expect(detail.length).toBeLessThanOrEqual(90);
      }
    }
  });

  it('greift mechanisch, wenn die Grenze enger gesetzt wird, und sagt es', () => {
    // 3 000 liegt über dem Boden aus Überschriften und Abwesenheitssätzen
    // (gemessen: 1 314 Zeichen) und weit unter dem, was diese Daten füllen —
    // also der Bereich, in dem Schicht 2 wirklich etwas zu tun hat.
    const report = renderWeeklyReport(padded(), { maxChars: 3_000 });
    expect(report.truncation.droppedByCap).toBeGreaterThan(0);
    expect(report.truncation.withinCap).toBe(true);
    expect(report.text.length).toBeLessThanOrEqual(3_000);
    expect(report.text).toContain('Längengrenze:');
    expect(report.html).toContain('Längengrenze:');
  });

  it('opfert §16.6 vor §16.5 — die Betriebsprüfung geht als letzte', () => {
    const report = renderWeeklyReport(padded(), { maxChars: 900 });
    expect(report.truncation.emptiedByCap[0]).toBe('naechste_woche');
    const betriebspruefung = report.truncation.emptiedByCap.indexOf('betriebspruefung');
    const radar = report.truncation.emptiedByCap.indexOf('radar');
    expect(radar).toBeGreaterThanOrEqual(0);
    expect(betriebspruefung === -1 || betriebspruefung > radar).toBe(true);
  });

  it('sagt es, wenn die Grenze kleiner ist als die sechs Abschnitte selbst', () => {
    const report = renderWeeklyReport(data(), { maxChars: 200 });
    expect(report.truncation.withinCap).toBe(false);
    // Der Bericht liegt dann über der Grenze — und behauptet nicht, es nicht zu
    // tun. Ein still zu langer Bericht wäre die Kürzung, die niemand sieht.
    expect(report.text).toContain('über der Längengrenze');
    expect(report.text.length).toBeGreaterThan(200);
  });
});

describe('Formatierung ohne ICU-Abhängigkeit', () => {
  it('setzt Tausenderpunkte und deutsche Kommata', () => {
    expect(formatInteger(0)).toBe('0');
    expect(formatInteger(999)).toBe('999');
    expect(formatInteger(1_000)).toBe('1.000');
    expect(formatInteger(18_411)).toBe('18.411');
    expect(formatInteger(-1_234)).toBe('-1.234');
  });

  it('setzt den Numerus, weil „1 Aufgaben" nach Maschine klingt', () => {
    expect(plural(0, 'Aufgabe', 'Aufgaben')).toBe('0 Aufgaben');
    expect(plural(1, 'Aufgabe', 'Aufgaben')).toBe('1 Aufgabe');
    expect(plural(2, 'Aufgabe', 'Aufgaben')).toBe('2 Aufgaben');
    expect(plural(1_500, 'Prüfung', 'Prüfungen')).toBe('1.500 Prüfungen');
    // Und im Bericht selbst — der Formatierer allein sagt nichts darüber, ob
    // ihn jemand benutzt.
    const report = renderWeeklyReport(
      data({ projects: [project('einzeln', { tasksDone: 1, merges: 1, deploys: 1 })] }),
    );
    expect(report.text).toContain('einzeln — 1 Aufgabe, 1 Merge, 1 Deploy');
  });

  it('formuliert Dauern grob, weil Sekunden hier Rauschen sind', () => {
    expect(formatMillis(42 * 60_000)).toBe('42 min');
    expect(formatMillis(190 * 60_000)).toBe('3 h 10 min');
    expect(formatMillis(120 * 60 * 60_000)).toBe('5 Tage');
  });

  it('liest das Datum in Wiener Ortszeit', () => {
    // 23:30 UTC ist in Wien bereits der Folgetag. Eine Formatierung über UTC
    // nennte in jedem Sommerbericht den falschen Tag.
    expect(formatDay(new Date('2026-08-16T23:30:00Z'))).toBe('17.08.2026');
  });

  it('kürzt einen Text sichtbar statt still', () => {
    expect(clampText('kurz', 10)).toBe('kurz');
    expect(clampText('a'.repeat(20), 10)).toBe(`${'a'.repeat(9)}…`);
    expect(clampText('  viel   Weissraum  ', 40)).toBe('viel Weissraum');
  });
});

/** Die eine Zeile des Klartexts, die diesen Anfang trägt. */
function lineWith(text: string, needle: string): string {
  const line = text.split('\n').find((candidate) => candidate.includes(needle));
  if (line === undefined) throw new Error(`Keine Zeile mit "${needle}" im Bericht.`);
  return line;
}
