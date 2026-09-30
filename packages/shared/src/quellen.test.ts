/**
 * §14's trust levels and its citation rule.
 *
 * The rule is one sentence of prose in the spec — "Legal/compliance outputs
 * must cite sources with level ≥ L4; anything lower triggers a corroboration
 * pass" — and A44.3 is why it is code: a rule that only exists in a prompt is
 * not a rule. So it is tested from both sides of the threshold and at it, and
 * the threshold's *position* is asserted rather than assumed: the two cases
 * below name L4 and L3 explicitly, so moving `CITATION_MIN_LEVEL` by one turns
 * exactly one of them red in each direction.
 */
import { describe, expect, it } from 'vitest';
import {
  CITATION_MIN_LEVEL,
  type CitationSubject,
  checkCitation,
  isSourceActAllowed,
  isTrustLevel,
  MAX_SOURCE_REASON_LENGTH,
  parseQuellenListQuery,
  parseSourceAct,
  quellenListUrl,
  SOURCE_ACT_SEGMENTS,
  SOURCE_ACTS,
  SOURCE_ACTS_BY_STATE,
  SOURCE_STATES,
  sourceActFromSegment,
  sourceActRefusal,
  sourceEventLabel,
  TRUST_LEVEL_CATALOGUE,
  TRUST_LEVELS,
  type TrustLevel,
  trustLevel,
  trustLevelCode,
} from './quellen.js';

function accepted(level: TrustLevel): CitationSubject {
  return { found: true, state: 'accepted', level };
}

describe('§14s Vertrauensstufen', () => {
  it('beschreibt genau die fünf Stufen der Tabelle, stärkste zuerst', () => {
    expect(TRUST_LEVEL_CATALOGUE.map((entry) => entry.level)).toEqual([5, 4, 3, 2, 1]);
    expect(TRUST_LEVEL_CATALOGUE.map((entry) => entry.code)).toEqual([
      'L5',
      'L4',
      'L3',
      'L2',
      'L1',
    ]);
    // Every column of §14's table is filled for every row. A level with no
    // examples renders as an empty list in the UI and reads as "we have none",
    // which is a statement §14 does not make about any of the five.
    for (const entry of TRUST_LEVEL_CATALOGUE) {
      expect(entry.label.length, entry.code).toBeGreaterThan(0);
      expect(entry.weight.length, entry.code).toBeGreaterThan(0);
      expect(entry.examples.length, entry.code).toBeGreaterThan(0);
    }
  });

  it('kennt keine sechste Stufe', () => {
    expect(isTrustLevel(0)).toBe(false);
    expect(isTrustLevel(6)).toBe(false);
    expect(isTrustLevel(null)).toBe(false);
    expect(isTrustLevel(undefined)).toBe(false);
    expect(trustLevel(6)).toBeNull();
    for (const level of TRUST_LEVELS) expect(isTrustLevel(level)).toBe(true);
  });

  it('nennt eine Quelle ohne Stufe beim Namen statt „L null"', () => {
    expect(trustLevelCode(null)).toBe('ohne Stufe');
    expect(trustLevelCode(5)).toBe('L5');
  });
});

describe('§14s Zitierregel', () => {
  it('lässt L5 und L4 zu', () => {
    for (const level of [5, 4] as const) {
      const check = checkCitation(accepted(level));
      expect(check.ok, `L${level}`).toBe(true);
      expect(check.reason).toBe('citable');
      expect(check.needsCorroboration).toBe(false);
    }
  });

  it('verlangt unterhalb von L4 eine Bestätigung, statt die Quelle zu verwerfen', () => {
    // §14 gives "below the threshold" a consequence that is *not* a refusal, so
    // a checker answering a bare boolean would collapse "cite something else"
    // and "corroborate this" into one verdict.
    for (const level of [3, 2, 1] as const) {
      const check = checkCitation(accepted(level));
      expect(check.ok, `L${level}`).toBe(false);
      expect(check.reason).toBe('below_threshold');
      expect(check.needsCorroboration, `L${level}`).toBe(true);
      expect(check.level).toBe(level);
    }
  });

  it('zieht die Schwelle genau zwischen L3 und L4', () => {
    // The assertion that makes the two cases above mean something: shifting
    // CITATION_MIN_LEVEL to 3 or to 5 breaks this pair, in the direction it was
    // shifted.
    expect(CITATION_MIN_LEVEL).toBe(4);
    expect(checkCitation(accepted(4)).ok).toBe(true);
    expect(checkCitation(accepted(3)).ok).toBe(false);
  });

  it('unterscheidet eine erfundene Quelle von einer zu schwachen', () => {
    const unknown = checkCitation({ found: false });
    expect(unknown.ok).toBe(false);
    expect(unknown.reason).toBe('unknown');
    // Not corroborable: a source that does not exist cannot be carried by a
    // second one, and offering that as the remedy would send a legal review
    // looking for support for a reference nobody wrote.
    expect(unknown.needsCorroboration).toBe(false);
    expect(unknown.level).toBeNull();
    expect(unknown.state).toBeNull();
  });

  it('lässt weder eine vorgeschlagene noch eine abgelehnte noch eine stillgelegte Quelle zu', () => {
    for (const state of SOURCE_STATES.filter((value) => value !== 'accepted')) {
      // L5 deliberately: what refuses here is the state, and a low level would
      // let this case pass for the wrong reason.
      const check = checkCitation({ found: true, state, level: 5 });
      expect(check.ok, state).toBe(false);
      expect(check.reason, state).toBe('not_accepted');
      expect(check.needsCorroboration, state).toBe(false);
      expect(check.state).toBe(state);
    }
  });

  it('verweigert eine aufgenommene Quelle ohne Stufe, statt sie durchzulassen', () => {
    // Unreachable through the schema — 0021 requires a level on every accept —
    // and asserted anyway, because that CHECK is the *other* layer and this one
    // has to fail closed on its own: "we could not find out whether we are
    // allowed" and "we are allowed" are the same sentence only to a system that
    // has decided not to notice.
    const check = checkCitation({ found: true, state: 'accepted', level: null });
    expect(check.ok).toBe(false);
    expect(check.reason).toBe('level_unknown');
    expect(check.needsCorroboration).toBe(false);
  });

  it('begründet jede Antwort auf Deutsch (§2)', () => {
    const subjects: CitationSubject[] = [
      { found: false },
      { found: true, state: 'retired', level: 5 },
      { found: true, state: 'accepted', level: 2 },
      { found: true, state: 'accepted', level: null },
      { found: true, state: 'accepted', level: 5 },
    ];
    for (const subject of subjects) {
      const check = checkCitation(subject);
      expect(check.message.length).toBeGreaterThan(20);
      // English leaking out of a sentence the operator reads is what this catches — the
      // same guard `mail.test.ts` puts on the reminder templates.
      expect(check.message).not.toMatch(/\b(source|level|citation|registry|accepted)\b/i);
    }
  });
});

describe('§17.7s Kurationsfläche', () => {
  it('bietet je Zustand genau die Akte, die dort etwas ändern', () => {
    // The whole table, asserted as a table: a page reads it to decide which
    // buttons exist and the route reads it to decide what to refuse, so a row
    // that drifted would let the two disagree — which is the arrangement
    // A81 exists to prevent, one layer down.
    expect(SOURCE_ACTS_BY_STATE).toEqual({
      proposed: ['accept', 'reject'],
      accepted: ['level', 'retire'],
      rejected: ['accept'],
      retired: ['accept'],
    });
    // Accepting twice says nothing and would append a second row to the log §14
    // makes the evidence behind a citation.
    expect(isSourceActAllowed('accepted', 'accept')).toBe(false);
    expect(isSourceActAllowed('accepted', 'level')).toBe(true);
    // A "nein" is not permanent in a registry §14 describes as curated.
    expect(isSourceActAllowed('rejected', 'accept')).toBe(true);
    expect(isSourceActAllowed('rejected', 'reject')).toBe(false);
  });

  it('sagt bei einer Verweigerung, was hier stattdessen ginge', () => {
    const satz = sourceActRefusal('accepted', 'accept');
    expect(satz).toContain('aufgenommen');
    expect(satz).toContain('Stufe ändern');
    expect(satz).toContain('Stilllegen');
    // A refusal that only says no leaves the reader of a stale page guessing
    // whether they misread the source or the system.
    expect(satz).toContain('lade sie neu');
    expect(satz).not.toMatch(/\b(state|allowed|refused|conflict)\b/i);
  });

  it('kennt jeden Akt genau unter einem Pfadsegment, und keinen sonst', () => {
    for (const act of SOURCE_ACTS) {
      expect(sourceActFromSegment(SOURCE_ACT_SEGMENTS[act])).toBe(act);
    }
    expect(new Set(Object.values(SOURCE_ACT_SEGMENTS)).size).toBe(SOURCE_ACTS.length);
    // An unknown segment is a route that does not exist — never a near match.
    expect(sourceActFromSegment('aufnehmen ')).toBeNull();
    expect(sourceActFromSegment('vernichten')).toBeNull();
    expect(sourceActFromSegment(undefined)).toBeNull();
  });
});

describe('Was für einen Akt abgeschickt werden darf', () => {
  it('nimmt beim Aufnehmen eine Stufe und wahlweise eine Notiz', () => {
    const gut = parseSourceAct('accept', { level: 4, note: ' geprüft ' });
    expect(gut).toMatchObject({ ok: true, submission: { act: 'accept' } });
    if (gut.ok && gut.submission.act === 'accept') {
      expect(gut.submission.input.level).toBe(4);
      expect(gut.submission.input.note).toBe('geprüft');
    }
    expect(parseSourceAct('accept', {}).ok).toBe(false);
  });

  it('lehnt eine Stufe ab, die §14 nicht kennt — in beide Richtungen', () => {
    // Refused at all, whatever is wrong with it: a sixth level would rank above
    // L5 and be citable by every rule written against `>= 4`.
    for (const level of [0, 6, 4.5, '4', null, Number.NaN]) {
      expect(parseSourceAct('accept', { level }).ok, `Stufe ${String(level)}`).toBe(false);
    }
    // And the catalogue is named for the case it is about — a whole number
    // outside §14's five. `4.5` and `'4'` are refused one rule earlier, each
    // with its own German sentence, which the case below covers.
    for (const level of [0, 6, 42]) {
      const result = parseSourceAct('accept', { level });
      // Asserted *before* the narrowing, never only inside it: an assertion that
      // lives entirely in an `if` is green the moment the condition stops
      // holding, which is the shape A74.3 found in three tests at once.
      expect(result.ok, `Stufe ${level}`).toBe(false);
      if (!result.ok) expect(result.errors.join(' ')).toContain('L1 bis L5');
    }
    // Every level §14 does define passes.
    for (const level of TRUST_LEVELS) {
      expect(parseSourceAct('accept', { level }).ok, `Stufe ${level}`).toBe(true);
    }
  });

  it('verlangt eine Begründung, wo §14 sie zum Beleg macht — und nur dort', () => {
    expect(parseSourceAct('reject', { reason: '   ' }).ok).toBe(false);
    expect(parseSourceAct('retire', {}).ok).toBe(false);
    expect(parseSourceAct('level', { level: 5 }).ok).toBe(false);
    expect(parseSourceAct('level', { level: 5, reason: 'Amtlich.' }).ok).toBe(true);
    // …and an acceptance carries no reason requirement at all: its reasoning is
    // the department's assessment, which is already on the record.
    expect(parseSourceAct('accept', { level: 5 }).ok).toBe(true);
  });

  it('antwortet auf jede erreichbare Beanstandung auf Deutsch (§2)', () => {
    const cases: Array<[Parameters<typeof parseSourceAct>[0], unknown]> = [
      ['accept', {}],
      ['accept', { level: 9 }],
      ['accept', { level: 4, note: 'x'.repeat(MAX_SOURCE_REASON_LENGTH + 1) }],
      ['reject', {}],
      ['reject', { reason: 42 }],
      ['reject', { reason: 'x'.repeat(MAX_SOURCE_REASON_LENGTH + 1) }],
      ['level', { level: 4 }],
      ['retire', 'kein Objekt'],
    ];
    for (const [act, body] of cases) {
      const result = parseSourceAct(act, body);
      expect(result.ok, `${act} / ${JSON.stringify(body)}`).toBe(false);
      if (result.ok) continue;
      expect(result.errors.length).toBeGreaterThan(0);
      // The guarantee is this loop rather than a regex over the output: these
      // issues arrive as `too_small`/`invalid_type`, which a *generated* message
      // uses too, so there is nothing for a re-wording layer to switch on.
      for (const satz of result.errors) {
        expect(satz).not.toMatch(/\b(expected|required|invalid|string|number|received)\b/i);
      }
    }
  });
});

describe('Die Liste und ihre Filter', () => {
  it('baut und liest dieselben Schlüssel', () => {
    expect(quellenListUrl()).toBe('/api/quellen');
    const url = quellenListUrl({ state: 'accepted', minLevel: 4 });
    const filter = parseQuellenListQuery(new URLSearchParams(url.split('?')[1] ?? ''));
    expect(filter).toEqual({ state: 'accepted', minLevel: 4 });
  });

  it('verwirft einen unbrauchbaren Filter, statt die Liste abzulehnen', () => {
    const filter = parseQuellenListQuery(new URLSearchParams('zustand=erfunden&abstufe=9'));
    expect(filter).toEqual({ state: null, minLevel: null });
  });
});

describe('Ein Verlaufseintrag in Worten', () => {
  it('setzt die Stufe in das Verb, statt sie anzuhängen', () => {
    expect(sourceEventLabel('proposed', 5)).toBe('vorgeschlagen mit L5');
    expect(sourceEventLabel('accepted', 4)).toBe('aufgenommen auf L4');
    expect(sourceEventLabel('level_changed', 5)).toBe('auf L5 gesetzt');
    // The two that carry no level at all — a template appending it would write
    // "abgelehnt · ohne Stufe" about an act that never had one.
    expect(sourceEventLabel('rejected', null)).toBe('abgelehnt');
    expect(sourceEventLabel('retired', null)).toBe('stillgelegt');
  });
});
