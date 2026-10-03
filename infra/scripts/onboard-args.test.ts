/**
 * `onboard.mjs` — where the transcript goes, and who approved.
 *
 * Both findings come from reading the script against its callers, not from a
 * run: an onboarding is a model session at the strongest tier, and nothing in
 * `pnpm gate` starts one. So the two decisions are pure functions in
 * `onboard-args.mjs`, tested here, plus the same kind of text net
 * `run-audit-wiring.test.ts` casts over its runner — weaker than a behavioural
 * test and strong enough for the one question that matters: **is the decision
 * actually used.** What this does not prove is said in the last case.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// A plain `.mjs` beside this file, typed by its JSDoc (`allowJs`, A125.5).
import { actorFor, transcriptsRootFor } from './onboard-args.mjs';

const HIER = dirname(fileURLToPath(import.meta.url));

/** Kommentare weg, damit eine Erklärung nicht als Verdrahtung durchgeht. */
function ohneKommentare(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((zeile) => zeile.replace(/(^|\s)\/\/.*$/, '$1'))
    .join('\n');
}

describe('transcriptsRootFor — wohin das Sitzungsprotokoll eines Onboardings geht', () => {
  const SCRATCH = '/tmp/vorschicht-onboard-abc';

  it('nimmt VORSCHICHT_TRANSCRIPTS_ROOT — den Pfad, den onboard-remote.sh einhängt', () => {
    expect(
      transcriptsRootFor({ VORSCHICHT_TRANSCRIPTS_ROOT: '/data/transcripts' }, SCRATCH),
    ).toEqual({ root: '/data/transcripts', durable: true });
  });

  it('leitet ihn sonst aus VORSCHICHT_DATA_ROOT ab, wie config.ts', () => {
    expect(transcriptsRootFor({ VORSCHICHT_DATA_ROOT: '/srv/vorschicht' }, SCRATCH)).toEqual({
      root: '/srv/vorschicht/transcripts',
      durable: true,
    });
  });

  it('zieht den ausdrücklichen Pfad dem abgeleiteten vor', () => {
    expect(
      transcriptsRootFor({ VORSCHICHT_TRANSCRIPTS_ROOT: '/a', VORSCHICHT_DATA_ROOT: '/b' }, SCRATCH)
        .root,
    ).toBe('/a');
  });

  it('fällt ohne beides auf das Wegwerfverzeichnis zurück und sagt, dass es nicht bleibt', () => {
    expect(transcriptsRootFor({}, SCRATCH)).toEqual({
      root: join(SCRATCH, 'transcripts'),
      durable: false,
    });
    // Eine leere Variable ist keine Angabe.
    expect(transcriptsRootFor({ VORSCHICHT_TRANSCRIPTS_ROOT: '' }, SCRATCH).durable).toBe(false);
  });
});

describe('actorFor — wer einen Vorschlag freigibt', () => {
  it('nimmt --actor', () => {
    expect(actorFor('erika', {})).toBe('erika');
  });

  it('nimmt sonst VORSCHICHT_ACTOR', () => {
    expect(actorFor(null, { VORSCHICHT_ACTOR: 'erika' })).toBe('erika');
  });

  it('zieht --actor der Umgebung vor', () => {
    expect(actorFor('erika', { VORSCHICHT_ACTOR: 'jemand-anders' })).toBe('erika');
  });

  it('hat keine Vorgabe — niemand genannt heisst niemand', () => {
    expect(actorFor(null, {})).toBeNull();
    expect(actorFor('', { VORSCHICHT_ACTOR: '  ' })).toBeNull();
  });

  it('hält das nächste Flag nicht für einen Namen', () => {
    expect(actorFor('--apply', {})).toBeNull();
  });
});

describe('onboard.mjs — die beiden Entscheidungen sind verdrahtet', () => {
  const roh = readFileSync(join(HIER, 'onboard.mjs'), 'utf8');
  const code = ohneKommentare(roh);

  it('findet die Datei überhaupt und sie ist nicht leer — sonst prüft der Rest nichts', () => {
    expect(roh.length).toBeGreaterThan(2000);
    expect(code).toContain('new AgentRunner');
  });

  it('übergibt dem Läufer den Pfad aus transcriptsRootFor, nicht mehr den im Wegwerfordner', () => {
    expect(code).toMatch(/transcriptsRootFor\(env, scratch\)/);
    const beginn = code.indexOf('new AgentRunner({');
    const abschnitt = code.slice(beginn, code.indexOf('onWarning', beginn));
    expect(abschnitt).toMatch(/transcriptsRoot: transkripte\.root/);
    expect(code).not.toMatch(/transcriptsRoot:\s*join\(scratch/);
  });

  it('hat keinen Namen mehr als Vorgabe für --actor', () => {
    expect(code).not.toMatch(/arg\('actor',\s*'/);
    expect(code).toMatch(/actorFor\(arg\('actor'\), env\)/);
  });

  it('verweigert die Übernahme ohne Namen, bevor eine Datenbank oder Sitzung berührt wird', () => {
    const verweigerung = code.indexOf('actor === null');
    expect(verweigerung).toBeGreaterThan(-1);
    expect(verweigerung).toBeLessThan(code.indexOf('createSql({'));
    expect(verweigerung).toBeLessThan(code.indexOf('new AgentRunner'));
  });

  it('sagt es, wenn das Protokoll nirgends bleibt, statt still einen toten Pfad zu hinterlassen', () => {
    // Die Grenze dieses Netzes: es beweist die Verdrahtung, nicht die Ablage.
    // Ob eine echte Sitzung ihr Protokoll dort ablegt, ist `AgentRunner`s Sache;
    // ein Onboarding kostet Abo-Budget und läuft in keinem Gate.
    expect(code).toMatch(/if \(transkripte\.durable\)/);
    expect(code).toMatch(/console\.warn\(/);
  });
});
