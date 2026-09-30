/**
 * §17.8's transport, without a database.
 *
 * What lives here is what can be wrong in the *translation*: which refusal gets
 * which status code, whether the actor travels, whether the answer a write
 * returns is the state that was stored, and — the one this page turns on —
 * whether every number in the payload carries the sentence saying what it is
 * worth.
 *
 * The database half (§19's row, the two fallbacks, and the pause reaching a
 * real guardian) is `packages/core/src/controlling/settings.itest.ts`, because
 * none of it can fail against a fake.
 */

import type { UsageSample } from '@vorschicht/shared';
import { budgetVertrauen, PAUSE_MODE_LABELS, PAUSE_MODES } from '@vorschicht/shared/controlling';
import { describe, expect, it } from 'vitest';
import {
  type ControllingDeps,
  type ControllingSettingsPort,
  fensterView,
  getControlling,
  setPauseMode,
  setSparbetrieb,
  sparbetriebStufen,
} from './controlling.js';

/** The one `guardian_events` row the payload reads, and nothing else. */
function fakeSql(rows: unknown[] = []): ControllingDeps['sql'] {
  // Two different queries reach this: the guardian row and the history. The
  // first call answers the guardian, every later one answers empty — enough
  // for a transport test and honest about being a stand-in.
  let calls = 0;
  const sql = (() => {
    calls += 1;
    return Promise.resolve(calls === 1 ? rows : []);
  }) as unknown as ControllingDeps['sql'];
  return sql;
}

function sample(over: Partial<UsageSample> = {}): UsageSample {
  return {
    window: 'five_hour',
    modelClass: null,
    usedPercent: 12,
    resetsAt: null,
    source: 'estimated',
    anomaly: null,
    observedAt: Date.parse('2026-08-11T10:00:00Z'),
    ...over,
  };
}

/** Records what it was asked to store, and answers what it holds. */
function fakeSettings(): ControllingSettingsPort & {
  calls: Array<{ was: string; wert: unknown; actor: string }>;
  modus: 'normal' | 'pause' | 'hart';
  sparsam: boolean;
} {
  const state = {
    calls: [] as Array<{ was: string; wert: unknown; actor: string }>,
    modus: 'normal' as 'normal' | 'pause' | 'hart',
    sparsam: false,
    pause: async () => ({ wert: state.modus, unlesbar: false }),
    sparbetrieb: async () => ({ wert: state.sparsam, unlesbar: false }),
    setPause: async (mode: 'normal' | 'pause' | 'hart', actor: string) => {
      state.calls.push({ was: 'pause', wert: mode, actor });
      const before = state.modus;
      state.modus = mode;
      return { before, after: mode };
    },
    setSparbetrieb: async (aktiv: boolean, actor: string) => {
      state.calls.push({ was: 'sparbetrieb', wert: aktiv, actor });
      const before = state.sparsam;
      state.sparsam = aktiv;
      return { before, after: aktiv };
    },
  };
  return state;
}

function deps(samples: UsageSample[] = [sample()], rows: unknown[] = []): ControllingDeps {
  return {
    sql: fakeSql(rows),
    settings: fakeSettings(),
    currentSamples: async () => samples,
    betrieb: { planProfile: 'max_20x', concurrency: 2 },
  };
}

describe('GET /api/controlling', () => {
  it('liefert Wächter, Schwellen, Fenster und beide Schalter in einer Antwort', async () => {
    const result = await getControlling(deps());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unerreichbar');
    const c = result.value.controlling;
    // §17.1s Begründung, eine Seite weiter: eine Seite, die für „läuft das
    // Studio noch" eine zweite Anfrage braucht, hat ihr Ziel verfehlt.
    expect(c.waechter.state).toBe('wrap_up');
    expect(c.schwellen).toEqual({
      wrapUpPercent: 85,
      hardStopPercent: 95,
      degradedWrapUpPercent: 75,
    });
    expect(c.pause.modus).toBe('normal');
    expect(c.sparbetrieb.aktiv).toBe(false);
    expect(c.betrieb).toEqual({
      planProfile: 'max_20x',
      concurrency: 2,
      concurrencyRange: { min: 0, max: 4 },
    });
  });

  it('liest keinen Wächterzustand als „vorsichtshalber angehalten", nicht als ruhig', async () => {
    // `overview.ts` trifft dieselbe Entscheidung und aus demselben Grund: noch
    // kein Eintrag heisst, dass niemand das Budget bewertet hat — und das ist
    // der „ich sehe es nicht"-Fall, nicht der ruhige.
    const result = await getControlling(deps([], []));
    if (!result.ok) throw new Error('unerreichbar');
    expect(result.value.controlling.waechter.state).toBe('wrap_up');
    expect(result.value.controlling.waechter.text).toContain('Keine Budgetdaten');
  });

  it('hängt an jedes Fenster die Bewertung, und zwar dieselbe wie die Regel', async () => {
    const samples = [
      sample({ usedPercent: 12, source: 'estimated' }),
      sample({ window: 'seven_day', usedPercent: 91, source: 'official' }),
      sample({ window: 'seven_day_model', modelClass: 'Opus', anomaly: { kind: 'unavailable' } }),
    ];
    const result = await getControlling(deps(samples));
    if (!result.ok) throw new Error('unerreichbar');
    const fenster = result.value.controlling.fenster;
    expect(fenster).toHaveLength(3);
    // Die tragende Zusicherung: nicht „irgendein Satz ist da", sondern der
    // Satz, den `budgetVertrauen` liefert. Eine zweite Umsetzung der Regel im
    // Server wäre genau das, was §17.8 hier nicht haben darf.
    for (const [index, sam] of samples.entries()) {
      expect(fenster[index]?.vertrauen).toEqual(
        budgetVertrauen({
          usedPercent: sam.usedPercent,
          source: sam.source,
          anomaly: sam.anomaly?.kind ?? null,
        }),
      );
    }
    expect(fenster[0]?.vertrauen.stufe).toBe('geschaetzt');
    expect(fenster[1]?.vertrauen.stufe).toBe('offiziell');
    expect(fenster[2]?.vertrauen.stufe).toBe('blind');
  });

  it('lässt kein Fenster ohne Bewertung durch', async () => {
    // Die Zusicherung, die der Gate-Satz meint: eine geschätzte Zahl **ohne**
    // Kennzeichnung darf es nicht geben. Über alle Fenster, nicht als
    // Stichprobe — eine Lücke wäre genau ein Fenster, und welches, weiss man
    // vorher nicht.
    const samples = [
      sample({ source: 'estimated' }),
      sample({ window: 'seven_day', source: 'estimated' }),
    ];
    const result = await getControlling(deps(samples));
    if (!result.ok) throw new Error('unerreichbar');
    for (const fenster of result.value.controlling.fenster) {
      expect(fenster.vertrauen.satz, fenster.window).toMatch(/\S/);
      expect(fenster.vertrauen.stufe, fenster.window).toBe('geschaetzt');
    }
  });

  it('meldet jede A22-Wirkung samt Verdrahtung, und den Grund, wenn sie fehlt', async () => {
    const result = await getControlling(deps());
    if (!result.ok) throw new Error('unerreichbar');
    const wirkungen = result.value.controlling.sparbetrieb.wirkungen;
    expect(wirkungen.length).toBeGreaterThan(0);
    for (const wirkung of wirkungen) {
      expect(wirkung.verdrahtung, wirkung.id).toMatch(/\S/);
      // `null` statt fehlend: ein optionaler Schlüssel liesse einen Erzeuger
      // ihn versehentlich weglassen, und dann sind „kein Grund genannt" und
      // „kein Grund nötig" nicht mehr zu unterscheiden.
      if (!wirkung.wirksam) expect(wirkung.offen, wirkung.id).toMatch(/\S/);
      else expect(wirkung.offen, wirkung.id).toBeNull();
    }
  });

  it('antwortet auf einen Serverfehler auf Deutsch statt mit einem Stack', async () => {
    const kaputt: ControllingDeps = {
      ...deps(),
      currentSamples: async () => {
        throw new Error('Datenbank weg');
      },
    };
    const result = await getControlling(kaputt);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unerreichbar');
    expect(result.reason).toBe('failed');
    expect(result.errors.join(' ')).toContain('Controlling konnte nicht');
    expect(result.errors.join(' ')).toContain('Datenbank weg');
  });
});

describe('PUT /api/controlling/pause', () => {
  it('speichert jede der drei Stellungen mit der Sitzung als Urheber', async () => {
    for (const modus of PAUSE_MODES) {
      const settings = fakeSettings();
      const result = await setPauseMode({ ...deps(), settings }, { modus }, 'dashboard:cred-abc');
      expect(result.ok, modus).toBe(true);
      // A75.3: nicht „irgendein Aktor", sondern der der Sitzung. Der Defekt,
      // vor dem das schützt, schreibt eine vollkommen wohlgeformte Zeile.
      expect(settings.calls, modus).toEqual([
        { was: 'pause', wert: modus, actor: 'dashboard:cred-abc' },
      ]);
    }
  });

  it('antwortet mit dem gespeicherten Zustand, nicht mit dem eingereichten', async () => {
    // Entscheidung 3: der Wächterzustand ist eine *Folge* der Pause. Eine
    // Seite, die aus der eigenen Einreichung neu zeichnet, könnte „Pause"
    // über einer Wächterzeile zeigen, die noch Normalbetrieb sagt.
    const settings = fakeSettings();
    const result = await setPauseMode({ ...deps(), settings }, { modus: 'hart' }, 'dashboard:x');
    if (!result.ok) throw new Error('unerreichbar');
    expect(result.value.controlling.pause.modus).toBe('hart');
    expect(result.value.controlling.waechter).toBeDefined();
  });

  it('weist eine unbekannte Stellung mit 422 und deutschem Text zurück', async () => {
    const settings = fakeSettings();
    const result = await setPauseMode({ ...deps(), settings }, { modus: 'halb' }, 'dashboard:x');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unerreichbar');
    expect(result.reason).toBe('invalid');
    expect(result.errors.join(' ')).toContain('modus');
    // Und nichts wurde gespeichert — eine abgewiesene Einreichung, die
    // trotzdem schreibt, wäre schlimmer als eine, die durchgeht.
    expect(settings.calls).toEqual([]);
  });

  it('weist auch einen leeren Körper zurück, statt ihn als „normal" zu lesen', async () => {
    // `c.req.json().catch(() => null)` liefert bei kaputtem JSON `null`. Das
    // als Normalbetrieb zu lesen hiesse: ein zerschossener Request nimmt die
    // Pause zurück.
    const settings = fakeSettings();
    for (const koerper of [null, undefined, {}, { modus: null }]) {
      const result = await setPauseMode({ ...deps(), settings }, koerper, 'dashboard:x');
      expect(result.ok, JSON.stringify(koerper)).toBe(false);
    }
    expect(settings.calls).toEqual([]);
  });
});

describe('PUT /api/controlling/sparbetrieb', () => {
  it('speichert beide Stellungen mit der Sitzung als Urheber', async () => {
    const settings = fakeSettings();
    const an = await setSparbetrieb({ ...deps(), settings }, { aktiv: true }, 'dashboard:cred');
    if (!an.ok) throw new Error('unerreichbar');
    expect(an.value.controlling.sparbetrieb.aktiv).toBe(true);
    expect(settings.calls).toEqual([{ was: 'sparbetrieb', wert: true, actor: 'dashboard:cred' }]);
  });

  it('weist alles zurück, was kein Wahrheitswert ist', async () => {
    const settings = fakeSettings();
    for (const koerper of [{ aktiv: 'ja' }, { aktiv: 1 }, {}, null]) {
      const result = await setSparbetrieb({ ...deps(), settings }, koerper, 'dashboard:x');
      expect(result.ok, JSON.stringify(koerper)).toBe(false);
    }
    expect(settings.calls).toEqual([]);
  });
});

describe('die Stufentabelle kommt aus resolveTier (Entscheidung 4)', () => {
  const stufen = sparbetriebStufen();

  it('nennt jede Rolle einmal, mit beiden Stufen', () => {
    expect(stufen.length).toBeGreaterThan(10);
    expect(new Set(stufen.map((z) => z.profileId)).size).toBe(stufen.length);
    for (const zeile of stufen) {
      expect(zeile.department, zeile.profileId).toMatch(/\S/);
      expect(['strong', 'standard', 'economy'], zeile.profileId).toContain(zeile.normal);
      expect(['strong', 'standard', 'economy'], zeile.profileId).toContain(zeile.sparbetrieb);
    }
  });

  it('lässt die Betriebsprüfung auf der stärksten Stufe (§8.2 Regel 3)', () => {
    // Die eine Zeile, die die Falle aus dem Auftrag sichtbar macht: §8.2 nimmt
    // *den Prüfer* von der Herabstufung aus, A22 schaltet *Leerlauf-Audits*
    // ab. Zwei verschiedene Dinge — und wenn jemand sie je zusammenlegt,
    // ändert sich genau diese Zeile.
    const auditor = stufen.find((z) => z.profileId === 'auditor');
    expect(auditor?.normal).toBe('strong');
    expect(auditor?.sparbetrieb).toBe('strong');
  });

  it('lässt die Reviewerin auf der stärksten Stufe (A22s eigene Ausnahme)', () => {
    const reviewer = stufen.find((z) => z.profileId === 'reviewer');
    expect(reviewer?.normal).toBe('strong');
    expect(reviewer?.sparbetrieb).toBe('strong');
  });

  it('stuft mindestens eine andere starke Rolle wirklich herunter', () => {
    // Ohne diesen Fall wäre eine Tabelle, in der *nichts* heruntergestuft
    // wird, mit den beiden Ausnahmen oben vereinbar — und der Schalter sähe
    // wirkungslos aus, ohne dass es auffiele.
    const herabgestuft = stufen.filter((z) => z.normal === 'strong' && z.sparbetrieb !== z.normal);
    expect(herabgestuft.length).toBeGreaterThan(0);
    expect(herabgestuft.every((z) => z.sparbetrieb === 'standard')).toBe(true);
  });

  it('befördert niemanden — der Sparbetrieb ist eine Obergrenze', () => {
    const rang = { economy: 0, standard: 1, strong: 2 } as const;
    for (const zeile of stufen) {
      expect(rang[zeile.sparbetrieb as keyof typeof rang], zeile.profileId).toBeLessThanOrEqual(
        rang[zeile.normal as keyof typeof rang],
      );
    }
  });
});

describe('die Beschriftung', () => {
  it('beschriftet jede Stellung auf Deutsch (§2)', () => {
    for (const modus of PAUSE_MODES) {
      expect(PAUSE_MODE_LABELS[modus], modus).toMatch(/[a-zäöüß]/i);
    }
  });

  it('reicht die Anomalie als Zeichenkette durch, nicht als Objekt', () => {
    // Die Seite parst das Dokument (A81) und `anomaly` ist dort `string|null`.
    // Ein durchgereichtes Objekt wäre ein Parse-Fehler auf der Seite statt
    // einer Anzeige — und zwar genau im Blindflug-Fall.
    const view = fensterView(sample({ anomaly: { kind: 'unavailable' } }));
    expect(view.anomaly).toBe('unavailable');
  });
});
