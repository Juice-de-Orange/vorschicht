import { BerichteListeSchema, BerichtSchema } from '@vorschicht/shared/berichte';
import { describe, expect, it } from 'vitest';
import {
  ARCHIV_LIMIT,
  type BerichteReader,
  getReport,
  isPeriodStart,
  listReports,
} from './berichte.js';

/**
 * §16s Archiv über HTTP.
 *
 * Der Adapter ist dünn, und genau deshalb sind zwei seiner Zusicherungen
 * tragend statt Formsache: dass `bodyHtml` **nicht** hinausgeht, und dass ein
 * Pfadabschnitt, der kein Datum ist, hier endet statt in Postgres.
 */

const zeile = {
  id: '11111111-1111-4111-8111-111111111111',
  periodStart: new Date('2026-09-07T00:00:00.000Z'),
  periodEnd: new Date('2026-09-14T00:00:00.000Z'),
  generatedAt: new Date('2026-09-14T05:00:00.000Z'),
  subject: 'Vorschicht — Woche vom 7. September 2026',
  bodyText: 'Zahlen\n  Aufgaben erledigt: 3\n',
  // Absichtlich mitgeführt, obwohl der Leser sie nicht deklariert: der Test
  // unten prüft, dass sie den Adapter nicht verlässt.
  bodyHtml: '<html><body><table>…</table></body></html>',
};

function leser(overrides: Partial<BerichteReader> = {}): BerichteReader {
  return {
    list: async () => [zeile],
    forPeriod: async (start) => (start.getTime() === zeile.periodStart.getTime() ? zeile : null),
    ...overrides,
  };
}

describe('§16s Archiv — die Liste', () => {
  it('gibt Zeitpunkte als ISO-Zeichenketten heraus, wie der Vertrag sie zusagt', async () => {
    const ergebnis = await listReports({ reports: leser() });
    expect(ergebnis.ok).toBe(true);
    if (!ergebnis.ok) return;
    // Geparst und nicht behauptet: ein `as` würde hier jede Formabweichung
    // durchlassen, und genau das ist A81s Defekt.
    const gelesen = BerichteListeSchema.parse(ergebnis.value);
    expect(gelesen.berichte).toHaveLength(1);
    expect(gelesen.berichte[0]?.periodStart).toBe('2026-09-07T00:00:00.000Z');
    expect(gelesen.berichte[0]?.subject).toBe(zeile.subject);
  });

  it('deckelt auf ein Jahr und lässt den Deckel nicht der Datenschicht', async () => {
    let gefragt: number | undefined;
    await listReports({
      reports: leser({
        list: async (limit) => {
          gefragt = limit;
          return [];
        },
      }),
    });
    // Ausdrücklich übergeben statt auf die Voreinstellung von `ReportRecords`
    // zu vertrauen: ändert die sich, änderte sich hier still das Verhalten.
    expect(gefragt).toBe(ARCHIV_LIMIT);
    expect(ARCHIV_LIMIT).toBe(52);
  });

  it('antwortet auf ein leeres Archiv mit einer leeren Liste, nicht mit einem Fehler', async () => {
    const ergebnis = await listReports({ reports: leser({ list: async () => [] }) });
    expect(ergebnis).toEqual({ ok: true, value: { berichte: [] } });
  });
});

describe('§16s Archiv — ein Bericht', () => {
  it('liefert den Klartext und **nicht** das Mail-HTML', async () => {
    const ergebnis = await getReport({ reports: leser() }, '2026-09-07');
    expect(ergebnis.ok).toBe(true);
    if (!ergebnis.ok) return;
    const gelesen = BerichtSchema.parse(ergebnis.value.bericht);
    expect(gelesen.bodyText).toBe(zeile.bodyText);
    // Die tragende Zusicherung dieser Datei. §16 hält beide Fassungen; nur eine
    // davon kommt ohne `dangerouslySetInnerHTML` auf eine Seite, und die andere
    // wäre die einzige XSS-Fläche dieses Dashboards. Ein Test auf „bodyText ist
    // da" allein ginge gegen einen Adapter durch, der beides herausgibt.
    expect(JSON.stringify(ergebnis.value)).not.toContain('<html');
    expect(Object.keys(ergebnis.value.bericht)).not.toContain('bodyHtml');
  });

  it('nennt einen unbekannten Zeitraum unbekannt, auf Deutsch', async () => {
    const ergebnis = await getReport({ reports: leser() }, '2020-01-06');
    expect(ergebnis.ok).toBe(false);
    if (ergebnis.ok) return;
    expect(ergebnis.reason).toBe('unknown');
    expect(ergebnis.errors[0]).toMatch(/keinen Bericht/);
  });

  it('lässt einen Pfadabschnitt, der kein Datum ist, nie bis zur Datenbank', async () => {
    let gefragt = false;
    const deps = {
      reports: leser({
        forPeriod: async () => {
          gefragt = true;
          return null;
        },
      }),
    };
    for (const kaputt of ['quatsch', '2026-13-45', '2026-9-7', '', undefined]) {
      const ergebnis = await getReport(deps, kaputt);
      expect(ergebnis.ok, `„${String(kaputt)}“ hätte abgewiesen werden müssen`).toBe(false);
    }
    // Der Punkt ist nicht die Ablehnung, sondern dass Postgres nie gefragt wird:
    // dort würde `invalid input syntax` als nackter 500 zurückkommen, für einen
    // Tippfehler in einer URL, in einer Anwendung ohne `app.onError`.
    expect(gefragt).toBe(false);
  });

  it('erkennt genau die Form, die der Pfad trägt', () => {
    expect(isPeriodStart('2026-09-07')).toBe(true);
    expect(isPeriodStart('2026-02-30')).toBe(false);
    expect(isPeriodStart('2026-09-07T00:00:00Z')).toBe(false);
  });
});
