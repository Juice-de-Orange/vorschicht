/**
 * §17.9's settings over HTTP — the adapter and the two routes.
 *
 * Two of these cases exist for defects this project has already shipped once.
 *
 *  - **The path is built the way the dashboard builds it.** A81.3: the inbox
 *    deep link was written as a literal in two packages, the two disagreed, and
 *    every notification landed on the wrong page — with three test files
 *    encoding the wrong one. `app.ts` registers a literal (Hono needs one), the
 *    dashboard fetches `EINSTELLUNGEN_API.personas`, and the only assertion that
 *    can see them diverge is one that requests the constant and expects the
 *    route to answer.
 *
 *  - **The actor is the session's.** A75.3, and A93.7's lesson about a test that
 *    cannot tell two things apart: asserting "an actor was passed" would pass
 *    against the `'system'` default this house's other service still has. The
 *    assertion is the value.
 */

import {
  EINSTELLUNGEN_API,
  PERSONA_MODE_DEFAULT,
  type PersonaMode,
} from '@vorschicht/shared/personas';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import {
  type EinstellungenDeps,
  getPersonaSettings,
  setPersonaMode,
  sicherungStatus,
} from './einstellungen.js';

const ROSTER = [
  { id: 'reviewer', department: 'Entwicklung', name: 'Rita', desk: 'Review', alternates: [] },
];

interface Recorded {
  saved: Array<{ mode: PersonaMode; actor: string }>;
}

function deps(options: { mode?: PersonaMode; failOn?: 'read' | 'write' } = {}): {
  deps: EinstellungenDeps;
  recorded: Recorded;
} {
  const recorded: Recorded = { saved: [] };
  let mode: PersonaMode = options.mode ?? PERSONA_MODE_DEFAULT;
  return {
    recorded,
    deps: {
      mode: async () => {
        if (options.failOn === 'read') throw new Error('Datenbank weg');
        return mode;
      },
      setMode: async (next, actor) => {
        if (options.failOn === 'write') throw new Error('Prüfzeile nicht schreibbar');
        recorded.saved.push({ mode: next, actor });
        const before = mode;
        mode = next;
        return { before, after: next };
      },
      roster: () => ROSTER,
    },
  };
}

describe('getPersonaSettings', () => {
  it('answers the mode and the roster in one payload', async () => {
    const result = await getPersonaSettings(deps({ mode: 'aus' }).deps);
    expect(result).toEqual({ ok: true, value: { personas: { mode: 'aus', roster: ROSTER } } });
  });

  /**
   * A refusal is a value, never an exception: there is no `app.onError` in this
   * app, so a throw becomes a plain-text 500 with an English stack on a page
   * whose every other string is German (§2).
   */
  it('turns an unreachable store into a German refusal rather than a throw', async () => {
    const result = await getPersonaSettings(deps({ failOn: 'read' }).deps);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unerreichbar');
    expect(result.reason).toBe('failed');
    expect(result.errors.join(' ')).toContain('Datenbank weg');
    expect(result.errors.join(' ')).not.toMatch(/\bError\b/);
  });
});

describe('setPersonaMode', () => {
  it('stores the submitted mode and hands the actor through untouched', async () => {
    const { deps: d, recorded } = deps();
    const result = await setPersonaMode(d, { mode: 'prompt' }, 'dashboard:cred-1');
    expect(result.ok).toBe(true);
    expect(recorded.saved).toEqual([{ mode: 'prompt', actor: 'dashboard:cred-1' }]);
  });

  /** Decision: the reply is the whole payload, so the page redraws from storage. */
  it('answers with what was stored, not with what was sent', async () => {
    const result = await setPersonaMode(deps().deps, { mode: 'aus' }, 'dashboard:cred-1');
    expect(result).toEqual({ ok: true, value: { personas: { mode: 'aus', roster: ROSTER } } });
  });

  it('refuses an unknown mode as invalid, in German, and stores nothing', async () => {
    const { deps: d, recorded } = deps();
    const result = await setPersonaMode(d, { mode: 'theater' }, 'dashboard:cred-1');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unerreichbar');
    expect(result.reason).toBe('invalid');
    expect(result.errors.join(' ')).toContain('Persona-Stufe');
    expect(recorded.saved).toEqual([]);
  });

  it('refuses a body that is not an object at all', async () => {
    const result = await setPersonaMode(deps().deps, null, 'dashboard:cred-1');
    expect(result.ok).toBe(false);
  });

  it('reports a failed write as failed rather than as invalid', async () => {
    const result = await setPersonaMode(deps({ failOn: 'write' }).deps, { mode: 'aus' }, 'max');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unerreichbar');
    // The distinction matters to the page: `invalid` tells the operator to fix his
    // submission, and there is nothing wrong with it.
    expect(result.reason).toBe('failed');
  });
});

describe('the routes', () => {
  function app(recorded: Recorded, session = true) {
    let mode: PersonaMode = PERSONA_MODE_DEFAULT;
    return createApp({
      health: { startedAt: Date.now(), pingDatabase: async () => {} },
      getSession: async () => (session ? { userId: 'cred-abc' } : null),
      einstellungen: {
        // §17.9s ganze Seite. Hier absichtlich mager: dieser Fall prüft den
        // Transport, und was drinsteht, prüft `getEinstellungenSeite` weiter
        // unten gegen die echten Ableitungen.
        getSeite: async () => ({ ok: true as const, value: { einstellungen: { mode } } }),
        get: async () => ({ ok: true as const, value: { personas: { mode, roster: ROSTER } } }),
        setPersonas: async (input, actor) => {
          const submitted = (input as { mode?: PersonaMode } | null)?.mode;
          if (submitted !== 'aus' && submitted !== 'anzeige' && submitted !== 'prompt') {
            return { ok: false as const, reason: 'invalid' as const, errors: ['Unbekannte Stufe'] };
          }
          recorded.saved.push({ mode: submitted, actor });
          mode = submitted;
          return { ok: true as const, value: { personas: { mode, roster: ROSTER } } };
        },
      },
    });
  }

  /** A81.3's only mechanical net: request the constant the dashboard uses. */
  it('answers at exactly the path the dashboard fetches', async () => {
    const response = await app({ saved: [] }).request(EINSTELLUNGEN_API.personas);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      personas: { mode: PERSONA_MODE_DEFAULT, roster: ROSTER },
    });
  });

  it('passes the session as the actor, never a default (A75.3)', async () => {
    const recorded: Recorded = { saved: [] };
    const response = await app(recorded).request(EINSTELLUNGEN_API.personas, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'prompt' }),
    });
    expect(response.status).toBe(200);
    expect(recorded.saved).toEqual([{ mode: 'prompt', actor: 'dashboard:cred-abc' }]);
  });

  it('is 422 for a refused mode, carrying the reasons', async () => {
    const response = await app({ saved: [] }).request(EINSTELLUNGEN_API.personas, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'theater' }),
    });
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ errors: ['Unbekannte Stufe'] });
  });

  /** A body that is not JSON must not reach Hono's plain-text 500. */
  it('treats an unparseable body as a refusal rather than a fault', async () => {
    const response = await app({ saved: [] }).request(EINSTELLUNGEN_API.personas, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: 'nicht json',
    });
    expect(response.status).toBe(422);
  });

  /** §19's default deny: the settings are behind the session like everything else. */
  it('is 401 without a session', async () => {
    const response = await app({ saved: [] }, false).request(EINSTELLUNGEN_API.personas);
    expect(response.status).toBe(401);
  });

  /**
   * A81.3s Netz, ein zweites Mal: §17.9s ganze Seite hat ihren eigenen Pfad,
   * und die Seite holt ihn über dieselbe Konstante.
   */
  it('answers §17.9s whole page at the path the dashboard fetches', async () => {
    const response = await app({ saved: [] }).request(EINSTELLUNGEN_API.seite);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ einstellungen: { mode: PERSONA_MODE_DEFAULT } });
  });

  it('keeps the whole page behind the session too', async () => {
    const response = await app({ saved: [] }, false).request(EINSTELLUNGEN_API.seite);
    expect(response.status).toBe(401);
  });
});

/**
 * §18s Sicherungsstand, wie §17.9 ihn zeigt.
 *
 * Die tragende Zusicherung ist die **Ableitung über `SICHERUNG_KOMPONENTEN`**
 * statt über das, was die Nutzlast mitbringt: eine Komponente, die der Erzeuger
 * gar nicht gemeldet hat, muss als „unbekannt" erscheinen und darf nicht aus der
 * Liste fallen, wo ihr Fehlen wie „in Ordnung" aussähe. A103s Ausfall war ein
 * partieller, und genau diese Unterscheidung war die teure.
 */
describe('sicherungStatus', () => {
  const JETZT = Date.parse('2026-08-18T09:00:00.000Z');

  it('sagt bei fehlender Meldung nichts Beruhigendes und erfindet keine Komponenten', () => {
    const status = sicherungStatus(null, JETZT);
    expect(status.kachel.state).toBe('unbekannt');
    expect(status.komponenten).toEqual([]);
    expect(status.gemeldetAm).toBeNull();
  });

  it('führt jede Komponente, auch eine, die der Erzeuger nicht genannt hat', () => {
    const status = sicherungStatus(
      {
        outcome: 'failed',
        occurredAt: new Date(JETZT - 60_000),
        finishedAt: null,
        stamp: '2026-08-18',
        // `prune` fehlt absichtlich: die Nutzlast des Erzeugers und dieser
        // Leser sind zwei Hälften eines Dokuments, das `sh` schreibt.
        components: { db: 'ok', docs: 'ok', transcripts: 'failed' },
        problem: 'Permission denied',
      },
      JETZT,
    );
    expect(status.komponenten.map((k) => [k.id, k.ergebnis])).toEqual([
      ['db', 'ok'],
      ['docs', 'ok'],
      ['transcripts', 'failed'],
      ['prune', 'unbekannt'],
    ]);
    expect(status.kachel.state).toBe('fehler');
    expect(status.problem).toBe('Permission denied');
    expect(status.stand).toBe('2026-08-18');
  });

  it('macht aus einem unbekannten Ergebniswort nie „ok"', () => {
    const status = sicherungStatus(
      {
        outcome: 'ok',
        occurredAt: new Date(JETZT),
        finishedAt: null,
        stamp: null,
        components: { db: 'irgendwas' },
        problem: null,
      },
      JETZT,
    );
    expect(status.komponenten[0]).toEqual({ id: 'db', label: 'Datenbank', ergebnis: 'unbekannt' });
  });
});
