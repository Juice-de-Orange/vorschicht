import { describe, expect, it } from 'vitest';
import { fromPayload } from './proposals.js';

/**
 * Reading a stored proposal back, and the three refusals that make §20's
 * decision real.
 *
 * The positive case is the easy half. What carries this file is that every
 * missing piece is a **refusal** rather than a default: a proposal applied
 * under a guessed name, or applied although it was never `ok`, is a project
 * that differs from the document a person read — which is exactly the gap
 * `applyFromRun` closes. A defaulting reader would pass a test that only checks
 * the happy path and reintroduce the whole problem.
 */

const VOLL: Record<string, unknown> = {
  slug: 'pilot',
  name: 'Pilotprojekt',
  rootPath: '/projects/pilot',
  readOnly: false,
  runId: 'run-1',
  ok: true,
  errors: [],
  notes: ['Ein Hinweis.'],
  gateConfig: { test: true, lint: true },
  deployConfig: { method: 'none', rationale: 'kein Rollout' },
  defaultBranch: 'main',
  claimGranularity: 'package',
  commands: [{ gate: 'test', command: 'pnpm run gate:test', status: 'declared', detail: 'ok' }],
  deferred: [{ subject: 'deploy', reason: 'später' }],
  missingCommands: ['build'],
};

describe('einen gelesenen Vorschlag zurücklesen (§20)', () => {
  it('rekonstruiert alles, was `apply` braucht', () => {
    const stored = fromPayload('run-1', VOLL);

    expect(stored).not.toBeNull();
    expect(stored?.slug).toBe('pilot');
    expect(stored?.name).toBe('Pilotprojekt');
    expect(stored?.rootPath).toBe('/projects/pilot');
    expect(stored?.readOnly).toBe(false);
    // Die Felder, an denen `apply` sonst scheitert — einzeln, weil jedes von
    // ihnen eine eigene Verweigerung dort auslöst.
    expect(stored?.verification.ok).toBe(true);
    expect(stored?.verification.config).toEqual({ test: true, lint: true });
    expect(stored?.verification.defaultBranch).toBe('main');
    expect(stored?.verification.claimGranularity).toBe('package');
    expect(stored?.verification.deployConfig).toEqual({
      method: 'none',
      rationale: 'kein Rollout',
    });
    // Und die drei Listen, die der Bericht braucht: sie reisen mit, statt beim
    // Anwenden leer zu werden.
    expect(stored?.verification.notes).toEqual(['Ein Hinweis.']);
    expect(stored?.verification.deferred).toHaveLength(1);
    expect(stored?.verification.missingCommands).toEqual(['build']);
  });

  it('verweigert eine Zeile ohne Anzeigenamen, statt den Slug zu nehmen', () => {
    const { name, ...ohneNamen } = VOLL;
    void name;

    // Der Slug wäre die bequeme Vorgabe und genau der Fehler: das Projekt
    // entstünde unter einem Namen, der in keinem Vorschlag steht.
    expect(fromPayload('run-1', ohneNamen)).toBeNull();
  });

  it('verweigert eine Zeile ohne Kürzel oder ohne Pfad', () => {
    const { slug, ...ohneSlug } = VOLL;
    void slug;
    const { rootPath, ...ohnePfad } = VOLL;
    void rootPath;

    expect(fromPayload('run-1', ohneSlug)).toBeNull();
    expect(fromPayload('run-1', ohnePfad)).toBeNull();
  });

  it('liest `ok` als das, was dasteht — nicht als „kein Fehler gemeldet"', () => {
    // Eine Zeile ohne `ok` ist nicht übernehmbar. `payload.ok === true` statt
    // `!== false`: eine fehlende Angabe ist keine Zustimmung.
    const { ok, ...ohneOk } = VOLL;
    void ok;
    expect(fromPayload('run-1', ohneOk)?.verification.ok).toBe(false);
    expect(fromPayload('run-1', { ...VOLL, ok: false })?.verification.ok).toBe(false);
  });

  it('liest `readOnly` genauso streng', () => {
    // A41/A85: „nur lesend" ist eine Zusicherung, und eine fehlende Angabe darf
    // sie nicht aufheben — hier gilt die Gegenrichtung, weil `false` der
    // ungefährliche Wert ist: ein Projekt wird dadurch nicht schreibbar, es
    // wird nur ohne die Kennzeichnung angelegt, und `apply` bekommt sie
    // ausdrücklich übergeben statt sie zu erraten.
    expect(fromPayload('run-1', { ...VOLL, readOnly: true })?.readOnly).toBe(true);
    const { readOnly, ...ohne } = VOLL;
    void readOnly;
    expect(fromPayload('run-1', ohne)?.readOnly).toBe(false);
  });

  it('macht aus fehlenden Listen leere und nicht `undefined`', () => {
    // `apply` und der Bericht lesen sie ohne Prüfung; ein `undefined` dort wäre
    // ein Absturz beim Anwenden eines Vorschlags, der sonst in Ordnung ist.
    const knapp = {
      slug: 'p',
      name: 'P',
      rootPath: '/projects/p',
      ok: true,
      gateConfig: {},
    };
    const stored = fromPayload('run-2', knapp);
    expect(stored?.verification.errors).toEqual([]);
    expect(stored?.verification.notes).toEqual([]);
    expect(stored?.verification.commands).toEqual([]);
    expect(stored?.verification.deferred).toEqual([]);
    expect(stored?.verification.missingCommands).toEqual([]);
    expect(stored?.verification.deployConfig).toEqual({ method: 'none' });
  });
});
