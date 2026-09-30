import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// Ein `.mjs` neben dieser Datei — `allowJs` in `tsconfig.test.json` ist dafür an (A125.5).
import { lesBilanz, ohneBeleg, pruefe, zaehleGates } from './gate-doku.mjs';

const REPO_ROOT = join(import.meta.dirname, '../..');

/**
 * Eine Spezifikation mit **zwei** Phasen: die erste geschlossen, die zweite
 * offen. `SPEC_MIT_44` taugt für den Phasencheck nicht — dort trägt Phase 0
 * selbst offene Gates, `geschlossenBis` antwortet also `-1`, und jeder
 * Phasensatz wäre falsch. Eine Fixture, die nur eine Richtung zulässt, prüft
 * nichts (A152).
 */
const SPEC_ZWEI_PHASEN = [
  '### Phase 0 — Fundament',
  ...Array.from({ length: 40 }, (_, i) => `- [x] Gate ${i} *(Beleg ${i})*`),
  '- [~] Verschoben eins *(Skript liegt bei)*',
  '### Phase 1 — Rückgrat',
  '- [x] Erstes Gate *(Beleg)*',
  '- [ ] Offen eins',
  '- [ ] Offen zwei',
].join('\n');

/** Die Bilanzzeile, die zu `SPEC_ZWEI_PHASEN` passt: 41 · 1 · 2. */
const STATE_ZWEI = '**Gate-Stand (CLAUDE.md §22):** 41 grün · 1 verschoben · 2 offen';

const SPEC_MIT_44 = [
  '### Phase 0',
  ...Array.from({ length: 40 }, (_, i) => `- [x] Gate ${i} *(Beleg ${i})*`),
  '- [~] Verschoben eins *(Skript liegt bei)*',
  '- [~] Verschoben zwei *(braucht sein Telefon)*',
  '- [ ] Offen eins',
  '- [ ] Offen zwei',
].join('\n');

const STATE_PASSEND =
  'Text davor.\n\n**Gate-Stand (CLAUDE.md §22):** 40 grün · 2 verschoben · 2 offen\n\nText danach.';

describe('zaehleGates', () => {
  it('zählt die drei Zustände aus A38 getrennt', () => {
    const { gruen, verschoben, offen } = zaehleGates(SPEC_MIT_44);
    expect({ gruen, verschoben, offen }).toEqual({ gruen: 40, verschoben: 2, offen: 2 });
  });

  it('liest keine Zeile, die nur so aussieht wie ein Gate', () => {
    // Eine Aufzählung in einer Belegzeile oder ein Zitat darf nicht mitzählen —
    // der Anker ist der Zeilenanfang, und das ist hier die ganze Zusicherung.
    const spec = ['  - [x] eingerückt, also ein Unterpunkt', 'Fließtext mit - [x] mittendrin'].join(
      '\n',
    );
    expect(zaehleGates(spec).gates).toHaveLength(0);
  });
});

describe('lesBilanz', () => {
  it('findet die drei Zahlen im Fließtext', () => {
    expect(lesBilanz(STATE_PASSEND)).toEqual({ gruen: 40, verschoben: 2, offen: 2 });
  });

  it('antwortet null, wenn es keine Bilanzzeile gibt — statt eine zu raten', () => {
    expect(lesBilanz('Eine Übergabe ohne jede Zahl.')).toBeNull();
  });
});

describe('ohneBeleg', () => {
  it('verlangt einen Beleg von angehakten und verschobenen Gates', () => {
    const { gates } = zaehleGates(
      ['- [x] mit Beleg *(hier)*', '- [x] ohne Beleg', '- [~] auch ohne'].join('\n'),
    );
    expect(ohneBeleg(gates)).toHaveLength(2);
  });

  it('verlangt keinen von einem offenen Gate — es behauptet nichts', () => {
    const { gates } = zaehleGates('- [ ] noch offen');
    expect(ohneBeleg(gates)).toEqual([]);
  });

  it('nimmt eine Klammer mitten im Satz nicht als Beleg', () => {
    // Ein `*(…)*` mitten im Gate-Satz ist eine Betonung. Der Beleg dieses
    // Dokuments steht immer am Zeilenende.
    const { gates } = zaehleGates('- [x] ein Gate *(nebenbei)* und dann noch Text');
    expect(ohneBeleg(gates)).toHaveLength(1);
  });
});

describe('pruefe', () => {
  it('ist grün, wenn Bilanz und Belege stimmen', () => {
    const ergebnis = pruefe(SPEC_MIT_44, STATE_PASSEND);
    expect(ergebnis.code).toBe(0);
  });

  it('meldet einen Befund, wenn die Übergabe eine andere Zahl behauptet', () => {
    // Das ist P5.G8 und P6.G8, als Zusicherung: der Haken steht, die Übergabe
    // wurde nicht nachgezogen.
    const state = '**Gate-Stand (CLAUDE.md §22):** 39 grün · 2 verschoben · 2 offen';
    const ergebnis = pruefe(SPEC_MIT_44, state);
    expect(ergebnis.code).toBe(1);
    expect(ergebnis.zeilen.join('\n')).toContain('39 grün');
    expect(ergebnis.zeilen.join('\n')).toContain('40 grün');
  });

  /**
   * A151 — die Wache las zwei Dateien, und vier behaupteten die Zahl.
   *
   * Die Betriebsprüfung 52a68316 hat am 25.8.2026 gefunden, dass `README.md`
   * und `HANDOVER.md` dieselbe Bilanz tragen, dass sie dort **drei Haken
   * hinterher** war — und dass `HANDOVER.md` wörtlich behauptet, dieser Schritt
   * halte sie gegeneinander. Er tat es nicht. Das ist ein Schutz, an den jemand
   * guten Grund hat zu glauben und der nicht greift (A94s Form, ein Dokument
   * weiter).
   */
  it('meldet eine abweichende Bilanz auch aus einer weiteren Datei', () => {
    const ergebnis = pruefe(SPEC_MIT_44, STATE_PASSEND, {
      'HANDOVER.md': 'Gates: 39 grün · 2 verschoben · 2 offen',
    });
    expect(ergebnis.code).toBe(1);
    expect(ergebnis.zeilen.join('\n')).toContain('HANDOVER.md');
  });

  it('kennt die englische Form — sonst bliebe genau die Datei still, um die es ging', () => {
    // `README.md` schreibt die Zahl englisch (§2). Beim ersten Lauf des
    // Wächters blieb sie deshalb stumm, obwohl der Fund in ihr lag.
    const ergebnis = pruefe(SPEC_MIT_44, STATE_PASSEND, {
      'CONTRIBUTING.md':
        '**Gates: 39 green · 2 deferred · 2 open**, counted rather than remembered',
    });
    expect(ergebnis.code).toBe(1);
    expect(ergebnis.zeilen.join('\n')).toContain('CONTRIBUTING.md');
  });

  /**
   * Der Fehlalarm, den der erste Lauf erzeugt hat: eine **Demo-Bilanz** trägt
   * dieselbe Wortfolge und eine vierte Zahl. Ein Wächter, der ein gesundes
   * Artefakt anklagt, wird übersehen — dieselbe Lehre wie bei
   * `restore-probe.sh`s geratener Grössenschwelle (A150.5), am selben Tag.
   */
  it('hält eine Demo-Bilanz nicht für die Gate-Bilanz', () => {
    const ergebnis = pruefe(SPEC_MIT_44, STATE_PASSEND, {
      'HANDOVER.md': '`demo-phase8.sh` steht auf 1 grün · 1 verschoben · 3 offen · 0 rot',
    });
    expect(ergebnis.code).toBe(0);
  });

  it('nimmt eine übereinstimmende weitere Datei an', () => {
    const ergebnis = pruefe(SPEC_MIT_44, STATE_PASSEND, {
      'HANDOVER.md': 'Gates: 40 grün · 2 verschoben · 2 offen',
      'CONTRIBUTING.md': 'Gates: 40 green · 2 deferred · 2 open',
    });
    expect(ergebnis.code).toBe(0);
  });

  /**
   * A152 — die nächste Ausbaustufe von A151, und ihr Anlass ist gemessen.
   *
   * Am 25.8.2026 war die Gate-**Zahl** in allen vier Wächterdateien richtig,
   * weil dieses Skript sie hält — und der Gate-**Satz** in **fünf** Dokumenten
   * falsch, weil ihn nichts hielt. Eine Zahl zu halten und den Satz daneben
   * nicht, ist ein halber Schutz, und der ist nach A94 schlechter als keiner.
   */
  it('meldet einen falschen Phasensatz — deutsch', () => {
    const ergebnis = pruefe(SPEC_ZWEI_PHASEN, STATE_ZWEI, {
      'HANDOVER.md': '**Phasen 0 bis 1 sind geschlossen**, Phase 2 läuft.',
    });
    expect(ergebnis.code).toBe(1);
    expect(ergebnis.zeilen.join('\n')).toContain('Phasen 0–1 geschlossen');
  });

  it('meldet eine Phase als laufend, die geschlossen ist', () => {
    const ergebnis = pruefe(SPEC_ZWEI_PHASEN, STATE_ZWEI, {
      'CONTRIBUTING.md': 'Phase 0 is under way.',
    });
    expect(ergebnis.code).toBe(1);
    expect(ergebnis.zeilen.join('\n')).toMatch(/Phase 0 .*geschlossen/);
  });

  it('nimmt den richtigen Phasensatz an', () => {
    const ergebnis = pruefe(SPEC_ZWEI_PHASEN, STATE_ZWEI, {
      'HANDOVER.md': '**Phasen 0 bis 0 sind geschlossen.** Phase 1 läuft.',
      'CONTRIBUTING.md': 'Phases 0–0 closed.',
    });
    // SPEC_ZWEI_PHASEN: Phase 0 ist zu, Phase 1 trägt offene Gates.
    expect(ergebnis.zeilen.join('\n')).not.toContain('Phasen 0–0 geschlossen');
  });

  /**
   * Die Ausnahme ist der schwierige Teil, und sie hat ihren eigenen Fall: eine
   * Chronik trägt Sätze, die zum Zeitpunkt ihres Schreibens richtig waren.
   * Ohne die Marke meldete der Wächter jede historische Zeile — und ein
   * Fehlalarm, der ein gesundes Artefakt anklagt, ist der teuerste Fehler einer
   * Prüfung (A150.5, A151.5, jetzt zum dritten Mal).
   */
  it('lässt einen als Archiv markierten Abschnitt in Ruhe', () => {
    const ergebnis = pruefe(SPEC_ZWEI_PHASEN, STATE_ZWEI, {
      'HANDOVER.md': [
        '## Chronik',
        '<!-- archiv -->',
        '**Phasen 0 bis 99 sind geschlossen**, Phase 0 läuft, und P9.G9 ist verschoben.',
        '',
        '## Jetzt',
        'Nichts Falsches hier.',
      ].join('\n'),
    });
    expect(ergebnis.code).toBe(0);
  });

  it('nimmt eine Marke im Kopf als „das ganze Dokument ist Archiv"', () => {
    // Der Fall, den die erste Fassung nicht konnte: eine Datei, die als Ganzes
    // Archiv ist, trägt die Marke im Kopf — und die erste `## `-Überschrift
    // kommt drei Zeilen später, womit die Ausnahme genau die Präambel gedeckt
    // hätte und nichts sonst.
    const ergebnis = pruefe(SPEC_ZWEI_PHASEN, STATE_ZWEI, {
      'HANDOVER.md': [
        '# Ein altes Dokument',
        '',
        '<!-- archiv -->',
        '',
        '## Damals',
        'Phase 0 läuft, P9.G9 ist verschoben, Phasen 0 bis 99 sind geschlossen.',
      ].join('\n'),
    });
    expect(ergebnis.code).toBe(0);
  });

  it('prüft wieder ab der nächsten Überschrift — die Marke gilt nicht für den Rest der Datei', () => {
    const ergebnis = pruefe(SPEC_ZWEI_PHASEN, STATE_ZWEI, {
      'HANDOVER.md': [
        '## Chronik',
        '<!-- archiv -->',
        'Phase 0 läuft.',
        '',
        '## Jetzt',
        'Phase 0 läuft.',
      ].join('\n'),
    });
    expect(ergebnis.code).toBe(1);
    // Genau **einmal**: die erste Zeile ist ausgenommen, die zweite nicht.
    const treffer = ergebnis.zeilen.join('\n').match(/Phase 0 .*geschlossen/g) ?? [];
    expect(treffer).toHaveLength(1);
  });

  /**
   * Die Zusammensetzung, nicht nur die Zahl. `README.md` und
   * `docs/AUTONOMIE.md` nannten beide **fünf** verschobene Gates — und beide die
   * falschen fünf (P7.G7 statt P8.G1). Der Zähler war zufrieden.
   */
  it('meldet eine Gate-Id, die als verschoben geführt wird und es nicht ist', () => {
    const ergebnis = pruefe(SPEC_ZWEI_PHASEN, STATE_ZWEI, {
      'CONTRIBUTING.md': 'Verschoben sind heute: P0.G1 und P1.G1.',
    });
    expect(ergebnis.code).toBe(1);
    expect(ergebnis.zeilen.join('\n')).toContain('P0.G1');
  });

  it('meldet eine Gate-Id, die es gar nicht gibt', () => {
    const ergebnis = pruefe(SPEC_ZWEI_PHASEN, STATE_ZWEI, {
      'CONTRIBUTING.md': 'Siehe P42.G7.',
    });
    expect(ergebnis.code).toBe(1);
    expect(ergebnis.zeilen.join('\n')).toContain('gibt es in §22 nicht');
  });

  it('nimmt eine Gate-Id ohne Verschiebungswort in Ruhe hin', () => {
    // Eine Id zu **nennen** ist keine Aussage über ihren Zustand. Nur dieselbe
    // Zeile zählt — eine Näherung erzeugte Fehlalarme.
    const ergebnis = pruefe(SPEC_ZWEI_PHASEN, STATE_ZWEI, {
      'CONTRIBUTING.md': 'P0.G1 ist der erste Haken dieses Projekts.',
    });
    expect(ergebnis.code).toBe(0);
  });

  it('meldet einen Befund, wenn die Bilanzzeile ganz fehlt', () => {
    const ergebnis = pruefe(SPEC_MIT_44, 'Eine Übergabe ohne Bilanz.');
    expect(ergebnis.code).toBe(1);
    expect(ergebnis.zeilen.join('\n')).toContain('keine Bilanzzeile');
  });

  it('meldet einen Befund, wenn ein Haken ohne Beleg steht', () => {
    const spec = `${SPEC_MIT_44}\n- [x] frisch angehakt, ohne Beleg`;
    const state = '**Gate-Stand (CLAUDE.md §22):** 41 grün · 2 verschoben · 2 offen';
    const ergebnis = pruefe(spec, state);
    expect(ergebnis.code).toBe(1);
    expect(ergebnis.zeilen.join('\n')).toContain('ohne Belegklammer');
  });

  /**
   * Die Anti-Leerlauf-Zusicherung. Ohne sie besteht dieser Schritt über einem
   * Dokument, dessen Format sich geändert hat, und liest sich wie „Doku
   * aktuell" — genau die Klasse, die er verhindern soll (§8.2, Domäne 6).
   */
  it('behauptet nichts, wenn die Auszählung zu wenig findet — Exit 2, kein Befund', () => {
    const ergebnis = pruefe('- [x] ein einziges Gate *(Beleg)*', STATE_PASSEND);
    expect(ergebnis.code).toBe(2);
    expect(ergebnis.zeilen.join('\n')).toContain('Es wird nichts behauptet');
  });
});

describe('gegen die echten Dokumente', () => {
  /**
   * Der Fall, der das Werkzeug an seinem eigenen Gegenstand prüft. Er sichert
   * **nicht** zu, dass die Doku heute stimmt — sie stimmt heute absichtlich
   * nicht, weil die Betriebsprüfung die Widersprüche noch sehen soll. Er
   * sichert zu, dass der Parser das echte Format liest, statt an ihm
   * vorbeizugreifen und deshalb immer grün zu sein.
   */
  it('liest das echte CLAUDE.md und findet dort eine plausible Zahl Gates', async () => {
    const spec = await readFile(join(REPO_ROOT, 'CLAUDE.md'), 'utf8');
    const { gates, gruen, offen } = zaehleGates(spec);
    expect(gates.length).toBeGreaterThan(60);
    expect(gruen).toBeGreaterThan(40);
    expect(offen).toBeGreaterThan(0);
  });
});
