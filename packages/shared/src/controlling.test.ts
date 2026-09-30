/**
 * §17.8's two switches and the labelling rule, without a database or a browser.
 *
 * What is asserted here is what can be wrong in the *rules*: that the three
 * pause positions map onto the guardian's pair in exactly one direction each,
 * that the two unreadable-value fallbacks go in the two different directions the
 * header argues for, and that no budget number can be rendered without a
 * sentence saying how much it is worth.
 */
import { describe, expect, it } from 'vitest';
import { DEGRADED_WRAP_UP_PERCENT, USAGE_WINDOWS } from './constants.js';
import {
  budgetVertrauen,
  GUARDIAN_THRESHOLDS,
  manualPauseFor,
  OFFICIAL_REPORTING_FLOOR_PERCENT,
  PAUSE_MODE_DEFAULT,
  PAUSE_MODE_DESCRIPTIONS,
  PAUSE_MODE_LABELS,
  PAUSE_MODE_UNREADABLE,
  PAUSE_MODES,
  parsePauseSubmission,
  parseSparbetriebSubmission,
  pauseModeFor,
  pausiert,
  SPARBETRIEB_DEFAULT,
  SPARBETRIEB_WIRKUNGEN,
  sparbetriebAbdeckung,
  VERTRAUEN_LABELS,
  VERTRAUEN_STUFEN,
  WINDOW_LABELS,
} from './controlling.js';

describe('A26 — die drei Stellungen des Pauseschalters', () => {
  it('bildet jede Stellung auf genau ein Paar des Wächters ab', () => {
    expect(manualPauseFor('normal')).toEqual({ active: false, hard: false });
    expect(manualPauseFor('pause')).toEqual({ active: true, hard: false });
    expect(manualPauseFor('hart')).toEqual({ active: true, hard: true });
  });

  it('ist in beide Richtungen dieselbe Abbildung', () => {
    // Ohne diesen Fall könnten Hin- und Rückweg getrennt driften, und der
    // Rückweg ist der, über den ein im Prozess gesetzter Pausezustand
    // gemeldet wird — eine Drift dort meldete „Pause", wo hart angehalten ist.
    for (const modus of PAUSE_MODES) {
      expect(pauseModeFor(manualPauseFor(modus)), modus).toBe(modus);
    }
  });

  it('liest das unmögliche Paar als das, was es sagt, und nicht als hart', () => {
    // `{active:false, hard:true}` ist genau der Zustand, den die drei Modi
    // unmöglich machen sollen (Entscheidung 1). Wenn er trotzdem irgendwo
    // entsteht — eine handgeschriebene Zeile, ein alter Datensatz —, ist die
    // sichere Lesart „nicht angehalten, also entscheidet der Wächter" und
    // nicht „hart angehalten", denn das Zweite würde Sitzungen abräumen, die
    // niemand angehalten hat.
    expect(pauseModeFor({ active: false, hard: true })).toBe('normal');
  });

  it('läuft in der Voreinstellung und hält bei einem unlesbaren Wert an', () => {
    expect(PAUSE_MODE_DEFAULT).toBe('normal');
    // Entscheidung 2: die beiden sind absichtlich verschieden. Wären sie
    // gleich, wäre „konnte nicht gelesen werden" dasselbe wie „läuft weiter".
    expect(PAUSE_MODE_UNREADABLE).not.toBe(PAUSE_MODE_DEFAULT);
    expect(pausiert(PAUSE_MODE_UNREADABLE)).toBe(true);
    // Und die mildere der beiden Pausen: eine harte kostet je Aufgabe eine
    // Integritätsprüfung, und das darf ein kaputter Wert nicht auslösen.
    expect(PAUSE_MODE_UNREADABLE).toBe('pause');
  });

  it('beschriftet jede Stellung und nennt bei der harten den Preis', () => {
    for (const modus of PAUSE_MODES) {
      expect(PAUSE_MODE_LABELS[modus], modus).toMatch(/\S/);
      expect(PAUSE_MODE_DESCRIPTIONS[modus], modus).toMatch(/\S/);
    }
    // Die harte Pause ist die einzige, die etwas kostet, und §7.2 nennt genau
    // diese Folge. Eine Beschreibung, die sie verschweigt, macht den Schalter
    // harmloser, als er ist.
    expect(PAUSE_MODE_DESCRIPTIONS.hart).toContain('Integritätsprüfung');
    expect(PAUSE_MODE_DESCRIPTIONS.hart).toContain('60 Sekunden');
    expect(PAUSE_MODE_DESCRIPTIONS.pause).not.toContain('Integritätsprüfung');
  });

  it('weist eine Stellung zurück, die es nicht gibt — auf Deutsch', () => {
    const abgelehnt = parsePauseSubmission({ modus: 'halb' });
    expect(abgelehnt.ok).toBe(false);
    if (abgelehnt.ok) throw new Error('unerreichbar');
    expect(abgelehnt.errors.join(' ')).toContain('modus');
    expect(abgelehnt.errors.join(' ')).toContain('normal, pause, hart');
    expect(parsePauseSubmission({ modus: 'hart' })).toEqual({ ok: true, value: { modus: 'hart' } });
  });
});

describe('A22 — der Sparbetrieb und was er wirklich erreicht', () => {
  it('ist aus, solange der Betreiber ihn nicht einschaltet', () => {
    expect(SPARBETRIEB_DEFAULT).toBe(false);
  });

  it('nennt jede unverdrahtete Wirkung samt Grund', () => {
    // Der Sinn des Flags ist, dass die Seite nicht mehr behauptet als das
    // System tut. Eine Wirkung, die als unwirksam gemeldet wird, ohne zu
    // sagen warum, ist für einen Leser dasselbe wie gar keine Angabe.
    for (const wirkung of SPARBETRIEB_WIRKUNGEN) {
      expect(wirkung.verdrahtung, wirkung.id).toMatch(/\S/);
      if (!wirkung.wirksam) expect(wirkung.offen, wirkung.id).toMatch(/\S/);
      else expect(wirkung.offen, wirkung.id).toBeUndefined();
    }
  });

  it('trennt die Ausnahme der Betriebsprüfung von den Leerlauf-Audits', () => {
    // §8.2 Regel 3 nimmt *den Prüfer* von der Herabstufung aus; A22 schaltet
    // *Leerlauf-Audits* ab. Zwei verschiedene Dinge, einen Satz auseinander,
    // und die naheliegende Verwechslung wäre, sie zu einer Zeile zu machen.
    const stufe = SPARBETRIEB_WIRKUNGEN.find((w) => w.id === 'tier');
    const leerlauf = SPARBETRIEB_WIRKUNGEN.find((w) => w.id === 'idle_audits');
    expect(stufe?.text).toContain('Betriebsprüfung');
    expect(stufe?.text).toContain('Reviewerin');
    expect(leerlauf?.text).toContain('§21');
    expect(leerlauf?.text).not.toContain('Betriebsprüfung');
  });

  it('sagt die Abdeckung als Zahl und nicht als Gefühl', () => {
    const abdeckung = sparbetriebAbdeckung(SPARBETRIEB_WIRKUNGEN);
    expect(abdeckung.gesamt).toBe(SPARBETRIEB_WIRKUNGEN.length);
    expect(abdeckung.wirksam).toBe(SPARBETRIEB_WIRKUNGEN.filter((w) => w.wirksam).length);
    expect(abdeckung.satz).toContain(`${abdeckung.wirksam} von ${abdeckung.gesamt}`);
  });

  it('sagt bei vollständiger Verdrahtung etwas anderes als bei teilweiser', () => {
    const alle = sparbetriebAbdeckung([
      { id: 'a', text: 'a', wirksam: true, verdrahtung: 'x' },
      { id: 'b', text: 'b', wirksam: true, verdrahtung: 'y' },
    ]);
    expect(alle.satz).toContain('Alle 2');
    expect(alle.satz).not.toContain('von 2 Wirkungen aus A22 sind verdrahtet. Die übrigen');
  });

  it('weist eine Einreichung ohne Wahrheitswert zurück', () => {
    const abgelehnt = parseSparbetriebSubmission({ aktiv: 'ja' });
    expect(abgelehnt.ok).toBe(false);
    if (abgelehnt.ok) throw new Error('unerreichbar');
    expect(abgelehnt.errors.join(' ')).toContain('aktiv');
    expect(parseSparbetriebSubmission({ aktiv: true })).toEqual({
      ok: true,
      value: { aktiv: true },
    });
  });
});

describe('A64/A73 — keine Budgetzahl ohne Angabe, was sie wert ist', () => {
  it('gibt für jede erreichbare Kombination genau eine Stufe und einen Satz', () => {
    const faelle = [
      { usedPercent: 12, source: 'estimated' as const, anomaly: null },
      { usedPercent: 91, source: 'official' as const, anomaly: null },
      { usedPercent: 0, source: 'estimated' as const, anomaly: 'unavailable' },
      { usedPercent: 80, source: 'official' as const, anomaly: 'divergence' },
    ];
    for (const fall of faelle) {
      const vertrauen = budgetVertrauen(fall);
      expect(VERTRAUEN_STUFEN, JSON.stringify(fall)).toContain(vertrauen.stufe);
      // Der Satz ist die eigentliche Zusicherung: eine Stufe ohne Erklärung
      // ist ein Etikett, das ein Leser für Schmuck hält.
      expect(vertrauen.satz.length, JSON.stringify(fall)).toBeGreaterThan(20);
    }
  });

  it('nennt eine Schätzung eine Schätzung und sagt, warum es keine Messung gibt', () => {
    const vertrauen = budgetVertrauen({ usedPercent: 12, source: 'estimated', anomaly: null });
    expect(vertrauen.stufe).toBe('geschaetzt');
    expect(vertrauen.satz).toContain('Schätzung');
    expect(vertrauen.satz).toContain(String(OFFICIAL_REPORTING_FLOOR_PERCENT));
  });

  it('nennt eine gemessene Zahl gemessen — und behauptet dabei keine Schätzung', () => {
    const vertrauen = budgetVertrauen({ usedPercent: 91, source: 'official', anomaly: null });
    expect(vertrauen.stufe).toBe('offiziell');
    expect(vertrauen.satz).not.toMatch(/Schätzung/);
  });

  it('lässt eine Anomalie die Quelle überstimmen, in beide Richtungen', () => {
    // `unavailable` wird als `estimated` gespeichert (A60.7) und `divergence`
    // sitzt auf einer offiziellen Zeile. Würde die Quelle zuerst gelesen,
    // verschwände die erste hinter „Geschätzt" und die zweite hinter
    // „Gemessen" — also gerade die beiden Fälle, in denen die Zahl nicht
    // heißt, was sie zu heißen scheint.
    expect(
      budgetVertrauen({ usedPercent: 0, source: 'estimated', anomaly: 'unavailable' }).stufe,
    ).toBe('blind');
    expect(
      budgetVertrauen({ usedPercent: 80, source: 'official', anomaly: 'divergence' }).stufe,
    ).toBe('strittig');
  });

  it('beschriftet jede Stufe und jedes Fenster auf Deutsch', () => {
    for (const stufe of VERTRAUEN_STUFEN) expect(VERTRAUEN_LABELS[stufe], stufe).toMatch(/\S/);
    for (const fenster of USAGE_WINDOWS) expect(WINDOW_LABELS[fenster], fenster).toMatch(/\S/);
  });

  it('liegt die Meldeschwelle des Anbieters unter der Aufräumschwelle für Schätzungen', () => {
    // Die Reihenfolge ist der Grund, warum A73s Anordnung überhaupt trägt:
    // ab 75 % gibt es eine echte Zahl, und der Wächter räumt bei Schätzungen
    // genau dort auf. Läge die Meldeschwelle darüber, gäbe es ein Band, in dem
    // nach der Schätzung angehalten wird, ohne dass je gemessen wurde.
    expect(OFFICIAL_REPORTING_FLOOR_PERCENT).toBeLessThanOrEqual(DEGRADED_WRAP_UP_PERCENT);
    expect(DEGRADED_WRAP_UP_PERCENT).toBeLessThan(GUARDIAN_THRESHOLDS.WRAP_UP_PERCENT);
    expect(GUARDIAN_THRESHOLDS.WRAP_UP_PERCENT).toBeLessThan(GUARDIAN_THRESHOLDS.HARD_STOP_PERCENT);
  });
});
