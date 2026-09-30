import { describe, expect, it } from 'vitest';
import {
  type AngelegteAufgabe,
  type AufgabenDeps,
  type AufgabenProjekt,
  type AufgabenTransaction,
  anlegenAufgabe,
  listProjektwahl,
} from './aufgaben.js';

/**
 * `POST /api/aufgaben`, and the assertions that carry it are the **absences**.
 *
 * Three of the four refusals below are only worth their line because they also
 * check that nothing was written. A route that answers 409 and files the task
 * anyway passes every test that reads the status code — and the task then sits
 * in `queued` forever, because §10's scheduler skips a read-only project
 * (A44.3), looking filed and being nothing. The same shape A90 and A119.2 both
 * record: a suite that only checks presence passes against an implementation
 * that does both.
 */

const PROJEKT: AufgabenProjekt = {
  id: '11111111-1111-4111-8111-111111111111',
  slug: 'pilot',
  name: 'Pilotprojekt',
  readOnly: false,
};

const NUR_LESEND: AufgabenProjekt = {
  id: '22222222-2222-4222-8222-222222222222',
  slug: 'vorschicht',
  name: 'Vorschicht',
  readOnly: true,
};

interface Protokoll {
  created: Parameters<AufgabenTransaction['create']>[0][];
  audited: Parameters<AufgabenTransaction['audit']>[0][];
  /** Every call, in order, so "the audit row came after the task" is checkable. */
  reihenfolge: string[];
  transaktionen: number;
}

function deps(projekte: readonly AufgabenProjekt[] = [PROJEKT, NUR_LESEND]): {
  deps: AufgabenDeps;
  log: Protokoll;
} {
  const log: Protokoll = { created: [], audited: [], reihenfolge: [], transaktionen: 0 };
  return {
    log,
    deps: {
      projekte: async () => projekte,
      anlegen: async (fn) => {
        log.transaktionen += 1;
        return fn({
          create: async (input): Promise<AngelegteAufgabe> => {
            log.created.push(input);
            log.reihenfolge.push('create');
            return {
              id: '33333333-3333-4333-8333-333333333333',
              title: input.title,
              state: input.initialState,
              priority: input.priority,
              projectId: input.projectId,
            };
          },
          audit: async (entry) => {
            log.audited.push(entry);
            log.reihenfolge.push('audit');
          },
        });
      },
    },
  };
}

const GUELTIG = {
  projektId: PROJEKT.id,
  titel: 'Rohdokumentablage bauen',
  beschreibung: 'Bytes unverändert ablegen, mit SHA-256.',
  akzeptanzkriterien: ['Ein Abruf legt die Bytes byteweise unverändert ab.'],
  prioritaet: 'P1',
  art: 'manuell',
  anfangszustand: 'queued',
};

describe('POST /api/aufgaben — die Tür, durch die Arbeit hereinkommt', () => {
  it('legt die Aufgabe an und schreibt §19s Zeile in derselben Transaktion', async () => {
    const { deps: d, log } = deps();
    const result = await anlegenAufgabe(d, GUELTIG, 'dashboard:abc');

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.aufgabe.titel).toBe('Rohdokumentablage bauen');
    expect(result.value.aufgabe.zustand).toBe('queued');
    expect(result.value.aufgabe.prioritaet).toBe('P1');

    // Eine Transaktion, und die Prüfzeile darin — nicht daneben.
    expect(log.transaktionen).toBe(1);
    expect(log.reihenfolge).toEqual(['create', 'audit']);
    expect(log.audited).toHaveLength(1);
  });

  it('schreibt die Sitzung als Urheber, nicht die Voreinstellung', async () => {
    const { deps: d, log } = deps();
    const result = await anlegenAufgabe(d, GUELTIG, 'dashboard:0123abcd');

    // §19: ein Prüfpfad, in dem jede Aufgabe von `system` stammt, beantwortet
    // *dass* etwas geschah und verliert die Frage, für die er geführt wird.
    expect(log.created[0]?.actor).toBe('dashboard:0123abcd');
    expect(log.audited[0]?.actor).toBe('dashboard:0123abcd');
    // Und die Prüfzeile zeigt auf **diese** Aufgabe, nicht auf irgendeine:
    // ein Prüfpfad, dessen Subjekt nicht auflösbar ist, ist keiner.
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(log.audited[0]?.taskId).toBe(result.value.aufgabe.id);
  });

  it('weist ein unbekanntes Projekt ab — und legt nichts an', async () => {
    const { deps: d, log } = deps();
    const result = await anlegenAufgabe(
      d,
      { ...GUELTIG, projektId: '99999999-9999-4999-8999-999999999999' },
      'dashboard:abc',
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('unknown');
    expect(log.transaktionen).toBe(0);
    expect(log.created).toEqual([]);
  });

  it('weist ein nur-lesendes Projekt ab — und legt nichts an', async () => {
    const { deps: d, log } = deps();
    const result = await anlegenAufgabe(d, { ...GUELTIG, projektId: NUR_LESEND.id }, 'max');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('conflict');
    // Der Satz nennt das Projekt und den Grund, weil eine Aufgabe dort für
    // immer in `queued` stünde und das von aussen wie „eingeplant" aussieht.
    expect(result.errors.join(' ')).toContain('Vorschicht');
    expect(result.errors.join(' ')).toContain('nur-lesend');
    expect(log.transaktionen).toBe(0);
  });

  it('prüft „nimmt dieses Projekt Arbeit an" vor „ist das Formular richtig"', async () => {
    const { deps: d } = deps();
    // Ein Rumpf, der die Schema-Prüfung sicher nicht bestünde: kein Titel,
    // keine Kriterien. Trotzdem muss `conflict` herauskommen — wer gegen ein
    // nur-lesendes Projekt einreicht, kann an seiner Eingabe nichts richten.
    const result = await anlegenAufgabe(d, { projektId: NUR_LESEND.id }, 'max');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('conflict');
  });

  it('verlangt mindestens ein Akzeptanzkriterium (§8.1, A48.3)', async () => {
    const { deps: d, log } = deps();
    const result = await anlegenAufgabe(d, { ...GUELTIG, akzeptanzkriterien: [] }, 'max');

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('invalid');
    expect(result.errors.join(' ')).toContain('Akzeptanzkriterium');
    expect(log.transaktionen).toBe(0);
  });

  it('nimmt keinen Rumpf an, der gar keiner ist', async () => {
    const { deps: d, log } = deps();
    for (const body of [null, undefined, 'nein', 42, []]) {
      const result = await anlegenAufgabe(d, body, 'max');
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unknown');
    }
    expect(log.transaktionen).toBe(0);
  });

  it('reicht keine Felder durch, die nur die Maschine füllen darf', async () => {
    const { deps: d, log } = deps();
    await anlegenAufgabe(
      d,
      { ...GUELTIG, runId: 'gefaelscht', parentTaskId: 'auch', worktreePath: '/tmp/x' },
      'max',
    );

    // §18s Kette ist nur etwas wert, wenn ausschliesslich der Runner den Link
    // schreibt: eine Aufgabe, die behauptet, aus einer Sitzung zu stammen, die
    // nie lief, macht jede Spur unglaubwürdig.
    const angelegt = log.created[0] as Record<string, unknown> | undefined;
    expect(angelegt).toBeDefined();
    expect(angelegt).not.toHaveProperty('runId');
    expect(angelegt).not.toHaveProperty('parentTaskId');
    expect(angelegt).not.toHaveProperty('worktreePath');
  });

  it('setzt die Voreinstellungen, die das Formular offen lassen darf', async () => {
    const { deps: d, log } = deps();
    await anlegenAufgabe(
      d,
      { projektId: PROJEKT.id, titel: 'Kurz', akzeptanzkriterien: ['Läuft.'] },
      'max',
    );

    expect(log.created[0]?.priority).toBe('P2');
    expect(log.created[0]?.initialState).toBe('queued');
    expect(log.created[0]?.type).toBe('manuell');
  });

  it('bietet die Projektwahl mit der Nur-Lesend-Kennzeichnung an', async () => {
    const { deps: d } = deps();
    const result = await listProjektwahl(d);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.projekte).toHaveLength(2);
    // Die Kennzeichnung reist mit, damit das Formular sagen kann, warum ein
    // Projekt nichts annimmt — statt eine Ablehnung erst nach dem Absenden.
    expect(result.value.projekte.find((p) => p.slug === 'vorschicht')?.readOnly).toBe(true);
    expect(result.value.projekte.find((p) => p.slug === 'pilot')?.readOnly).toBe(false);
  });
});
