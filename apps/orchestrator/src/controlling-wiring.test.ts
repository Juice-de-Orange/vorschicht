/**
 * The net under A26's and A22's call sites in the daemon.
 *
 * `main.ts` has no test, and this repository has produced a mechanism with no
 * caller six times: `EscalationMailService.tick()` (A86), `JobQueue` (A74.2),
 * `gate:commits` (A71), §6.6's transcript scan (A105), the eight staff profiles
 * (A108) — and `GuardianService.setPause`, which shipped in Phase 1 with an
 * itest driving it directly and *no way for a person to reach it*, because the
 * dashboard and the daemon are two processes. Deleting the `manualPause:` line
 * below would kill nothing in `guardian-service.itest.ts`, and A26 would go back
 * to being a switch that stops nothing.
 *
 * Its own file rather than assertions appended elsewhere: that is the house
 * pattern (`radar-wiring.test.ts`, `backup-pass.test.ts` and `sources-pass.test.ts`
 * each carry their own grep), and it keeps several agents out of one file.
 *
 * **And it is what makes `SPARBETRIEB_WIRKUNGEN.wirksam` a claim rather than a
 * comment.** That flag is what the Controlling page prints beside each of A22's
 * four effects, so it is a statement about the daemon made on a page — the exact
 * shape that goes stale silently. The last block asserts it in *both* directions:
 * a `true` whose wiring vanished fails, and a `false` that quietly grew a
 * consumer fails too, so the page cannot keep understating an effect either.
 *
 * The honest limit, the same one `radar-wiring.test.ts` and `backup-pass.test.ts`
 * both record: these assertions prove a call site **exists**, never that it is
 * reached. Restructuring an entry point is outside this change. What *is* proven
 * end to end is the pause, in `controlling/settings.itest.ts`, where a real
 * `GuardianService` reads a real `config` row and stops a real run.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { SPARBETRIEB_WIRKUNGEN } from '@vorschicht/shared/controlling';
import { describe, expect, it } from 'vitest';

const repoRoot = join(import.meta.dirname, '../../..');
const main = readFileSync(join(repoRoot, 'apps/orchestrator/src/main.ts'), 'utf8');
const buildScheduler = readFileSync(
  join(repoRoot, 'apps/orchestrator/src/build-scheduler.ts'),
  'utf8',
);

describe('A26 — die Verdrahtung der Pause in main.ts', () => {
  it('gibt dem Wächter den Leser der gespeicherten Stellung', () => {
    expect(main).toContain('new ControllingSettings(');
    // Die eine Zeile, ohne die der Schalter nichts anhält.
    expect(main).toContain('manualPause: () => controllingSettings.manualPause()');
  });

  it('liest die Stellung als Funktion und nicht als einmaligen Wert', () => {
    // Eine Pause, die erst nach einem Neustart wirkt, ist keine Pause. Ein
    // `manualPause: await …` wäre beim Start einmal gelesen und danach nie
    // wieder — grün in jeder Zusicherung über den Zustand, und trotzdem tot.
    expect(main).toMatch(/manualPause:\s*\(\)\s*=>/);
    expect(main).not.toMatch(/manualPause:\s*await/);
  });
});

describe('A22 — die Verdrahtung des Sparbetriebs', () => {
  it('gibt den Leerlauf-Audits die gespeicherte Stellung', () => {
    expect(main).toContain('sparbetrieb: async () => (await controllingSettings.sparbetrieb())');
    expect(buildScheduler).toContain('sparbetrieb: deps.sparbetrieb');
  });

  it('liest auch sie bei jedem Durchgang neu', () => {
    expect(main).toMatch(/sparbetrieb:\s*async\s*\(\)\s*=>/);
  });
});

describe('A7 — die Nebenläufigkeit steht nur an einer Stelle', () => {
  it('leitet sie aus PLAN_PROFILES ab statt aus einer zweiten Tabelle', () => {
    // §17.8 zeigt den Betreiber diese Zahl als „womit der Daemon läuft". Eine eigene
    // Kopie hier wäre A81s Defekt in klein: zwei Deklarationen einer Tatsache,
    // die übereinstimmen, bis jemand eine davon ändert — und die Seite hätte
    // keinen Anlass, an ihrer Zahl zu zweifeln.
    expect(main).toContain('PLAN_PROFILES.max_20x.concurrency');
    expect(main).toContain('PLAN_PROFILES.max_5x.concurrency');
    // Die nackten Zahlen wären genau die Kopie, die hier entfernt wurde.
    expect(main).not.toMatch(/CONCURRENCY_BY_PLAN\s*=\s*\{\s*max_20x:\s*\d/);
  });
});

describe('SPARBETRIEB_WIRKUNGEN — das Flag ist eine Behauptung über den Daemon', () => {
  /** Wo eine Wirkung verdrahtet ist, als Suchmuster im jeweiligen Quelltext. */
  const MUSTER: Record<string, { quelle: string; muster: RegExp }> = {
    concurrency: { quelle: main, muster: /concurrency:\s*CONCURRENCY_BY_PLAN/ },
    tier: { quelle: main, muster: /modelPolicy:/ },
    idle_audits: { quelle: main, muster: /sparbetrieb:\s*async\s*\(\)\s*=>/ },
    radar: { quelle: main, muster: /intervalMs:\s*RADAR_INTERVAL_MS/ },
  };

  it('kennt für jede der vier Wirkungen eine Fundstelle', () => {
    // Ohne diesen Fall könnte eine fünfte Wirkung dazukommen und ungeprüft
    // bleiben — die Abdeckung dieser Datei schrumpfte still.
    expect(Object.keys(MUSTER).sort()).toEqual(SPARBETRIEB_WIRKUNGEN.map((w) => w.id).sort());
  });

  it('meldet „wirksam" nur, wo der Sparbetrieb-Schalter wirklich gelesen wird', () => {
    // Die einzige Wirkung mit `wirksam: true` ist die, deren Verdrahtung den
    // Schalter selbst liest. Die anderen drei haben zwar eine Fundstelle —
    // die Nebenläufigkeit wird gesetzt, das Radar bekommt sein Intervall —
    // aber keine davon fragt, ob der Sparbetrieb an ist.
    const wirksam = SPARBETRIEB_WIRKUNGEN.filter((w) => w.wirksam).map((w) => w.id);
    expect(wirksam).toEqual(['idle_audits']);
  });

  it('findet jede Fundstelle wirklich im Quelltext, wirksam oder nicht', () => {
    // Auch die drei unwirksamen: ihre `verdrahtung` ist der Ort, an dem die
    // Wirkung *entstehen müsste*, und den der Betreiber auf der Seite genannt bekommt.
    // Ein Verweis auf eine Zeile, die es nicht mehr gibt, schickt den nächsten
    // Leser ins Leere — dieselbe Klasse wie eine überzeichnende Belegzeile
    // (A76.4), nur eine Ebene tiefer.
    for (const wirkung of SPARBETRIEB_WIRKUNGEN) {
      const eintrag = MUSTER[wirkung.id];
      if (!eintrag) throw new Error(`kein Muster für ${wirkung.id}`);
      // `tier` ist die Ausnahme und der Grund, warum dieser Fall so gebaut
      // ist: `modelPolicy` wird von *niemandem* gesetzt, die Fundstelle
      // existiert also gerade nicht. Genau das behauptet `wirksam: false`.
      if (wirkung.id === 'tier') {
        expect(eintrag.quelle, wirkung.id).not.toMatch(eintrag.muster);
        continue;
      }
      expect(eintrag.quelle, wirkung.id).toMatch(eintrag.muster);
    }
  });

  it('nennt in jeder Fundstellen-Angabe eine Datei, die es gibt', () => {
    for (const wirkung of SPARBETRIEB_WIRKUNGEN) {
      const datei = wirkung.verdrahtung.split('→')[0]?.trim() ?? '';
      expect(datei, wirkung.id).toMatch(/^apps\/orchestrator\/src\/[\w-]+\.ts$/);
      expect(() => readFileSync(join(repoRoot, datei), 'utf8'), wirkung.id).not.toThrow();
    }
  });
});
