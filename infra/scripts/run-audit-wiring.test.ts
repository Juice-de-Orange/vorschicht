/**
 * Der Prüfläufer muss ein Postfach mitbauen — sonst ist §8.2s schärfstes
 * Werkzeug stumm.
 *
 * ## Warum es diesen Test gibt
 *
 * `AuditService.deps.escalations` ist optional und hat einen sauberen Rückfall:
 * ohne Postfach vermerkt der Dienst am Fund „Kein Postfach angebunden — die
 * Entscheidung wurde nicht zugestellt". Bis zum 18.8.2026 baute `run-audit.mjs`
 * den Dienst nie mit, und es ist der einzige Läufer, der Prüfungen fährt — der
 * Rückfall war also nicht der Ausnahme-, sondern der **Normalfall**.
 *
 * Gemessen an diesem Tag: die Prüfung 49c549b4 entwertete P0.G5 und meldete
 * genau diesen Satz. §8.2 macht die P1-Karte zu dem Weg, auf dem der Betreiber von einem
 * entwerteten Gate erfährt; A83.6 lässt den Un-Tick in `CLAUDE.md` fail-closed
 * scheitern, wenn kein Projektverzeichnis bekannt ist. **Beide Wege zum Betreiber
 * waren gleichzeitig zu** — die Datei wurde nicht geschrieben (zu Recht) und
 * die Karte nicht gestellt (zu Unrecht). Die Entwertung überlebte nur, weil ein
 * Mensch die Ausgabe des Laufs gelesen hat.
 *
 * ## Warum ein Textnetz und kein Verhaltenstest
 *
 * `run-audit.mjs` ist ein Einstiegspunkt: es verbindet sich, baut ein halbes
 * Dutzend Dienste und startet eine Modellsitzung der stärksten Stufe. Ein
 * Verhaltenstest dafür kostet Budget und eine Datenbank. Dieses Haus benutzt für
 * genau diesen Fall ein mechanisches Netz über die Datei (A86.6 hat es für
 * `main.ts` per grep gemacht) — schwächer als ein Verhaltenstest und stark
 * genug für die eine Frage, die hier zählt: **wird der Dienst gebaut und
 * weitergereicht.**
 *
 * Die Grenze wird genannt statt versteckt: dieser Test beweist nicht, dass eine
 * Karte ankommt. Er beweist, dass der Weg dorthin verdrahtet ist. Dass die
 * Karte, wenn der Weg da ist, wirklich entsteht, prüft `audit-service.itest.ts`
 * gegen eine echte Postgres.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HIER = dirname(fileURLToPath(import.meta.url));
const LAEUFER = join(HIER, 'run-audit.mjs');

/** Kommentare weg, damit eine Erklärung nicht als Verdrahtung durchgeht. */
function ohneKommentare(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((zeile) => zeile.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

describe('run-audit.mjs — der Zustellweg für §8.2s Karten', () => {
  const roh = readFileSync(LAEUFER, 'utf8');
  const code = ohneKommentare(roh);

  it('findet die Datei überhaupt und sie ist nicht leer — sonst prüft der Rest nichts', () => {
    expect(roh.length).toBeGreaterThan(2000);
    expect(code).toContain('new AuditService');
  });

  it('importiert den EscalationService', () => {
    expect(code).toMatch(/EscalationService/);
  });

  it('baut ihn wirklich, statt ihn nur zu importieren', () => {
    expect(code).toMatch(/new EscalationService\s*\(/);
  });

  it('reicht ihn in den AuditService weiter — das ist die tragende Zusicherung', () => {
    // Der Abschnitt zwischen `new AuditService({` und der schliessenden Klammer.
    // Ein `escalations` irgendwo sonst in der Datei würde die Frage nicht
    // beantworten: gebaut und nicht übergeben ist genau der Zustand vom
    // 18.8.2026 minus einer Zeile.
    const beginn = code.indexOf('new AuditService({');
    expect(beginn).toBeGreaterThan(-1);
    const abschnitt = code.slice(beginn, code.indexOf('});', beginn));
    expect(abschnitt).toMatch(/\bescalations\b/);
  });

  it('erklärt eine Verdrahtung nicht bloss im Kommentar — der Code trägt sie', () => {
    // Die Gegenprobe zur Kommentar-Entfernung oben: stünde `new
    // EscalationService` nur in der Begründung, wäre `code` ohne sie und dieser
    // Fall zeigte den Unterschied. A74.2 hat genau das gefunden — ein Detektor,
    // dessen Zählung Prosa als Benutzung las.
    expect(roh).toMatch(/new EscalationService\s*\(/);
    expect(code).toMatch(/new EscalationService\s*\(/);
  });
});
