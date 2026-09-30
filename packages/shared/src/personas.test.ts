/**
 * §8's three persona states, and the rules they carry.
 *
 * The load-bearing case is the ladder: the whole justification for collapsing
 * §8's two named switches into one enum is that the three states are nested, so
 * if that stops being true the arrangement is hiding a combination rather than
 * ruling one out. It is therefore asserted rather than assumed.
 */
import { describe, expect, it } from 'vitest';
import {
  PERSONA_MODE_DEFAULT,
  PERSONA_MODE_DESCRIPTIONS,
  PERSONA_MODE_KEY,
  PERSONA_MODE_LABELS,
  PERSONA_MODES,
  type PersonaMode,
  parsePersonaModeSubmission,
  personaAlternates,
  personaFlavorEnabled,
  personaLabel,
  personaNamesShown,
  personaSettingsView,
} from './personas.js';

const RITA = { name: 'Rita', desk: 'Review' };
const CLARA = { name: 'Clara', desk: 'Entwicklung', alternates: ['Chris'] };

describe('the three modes', () => {
  it('is exactly §8’s three states, in ascending order', () => {
    expect(PERSONA_MODES).toEqual(['aus', 'anzeige', 'prompt']);
  });

  /**
   * The ladder, and the reason one enum is honest rather than merely compact.
   *
   * Each state is a superset of the one before it: whatever is switched on at
   * `anzeige` is still on at `prompt`, and `aus` has nothing. If a future state
   * broke that — say, flavour without names — this case goes red and the shape
   * of the setting has to be reconsidered rather than the state quietly added.
   */
  it('is nested: names imply nothing is hidden below, flavour implies names', () => {
    expect(PERSONA_MODES.filter(personaNamesShown)).toEqual(['anzeige', 'prompt']);
    expect(PERSONA_MODES.filter(personaFlavorEnabled)).toEqual(['prompt']);
    for (const mode of PERSONA_MODES) {
      if (personaFlavorEnabled(mode)) expect(personaNamesShown(mode)).toBe(true);
    }
  });

  /** A9 fixes the middle value: display-only by default, flavour opt-in. */
  it('defaults to display-only (A9)', () => {
    expect(PERSONA_MODE_DEFAULT).toBe('anzeige');
    expect(personaNamesShown(PERSONA_MODE_DEFAULT)).toBe(true);
    expect(personaFlavorEnabled(PERSONA_MODE_DEFAULT)).toBe(false);
  });

  it('labels and describes every state, in German (§2)', () => {
    for (const mode of PERSONA_MODES) {
      expect(PERSONA_MODE_LABELS[mode]).toBeTruthy();
      expect(PERSONA_MODE_DESCRIPTIONS[mode]).toBeTruthy();
      // The identifiers are English and the values are not — the house rule,
      // asserted because a translated label is invisible until the operator reads it.
      expect(PERSONA_MODE_LABELS[mode]).not.toMatch(/\b(display|off|prompt only|persona)\b/i);
    }
  });

  it('stores itself under one key', () => {
    expect(PERSONA_MODE_KEY).toBe('personas.mode');
  });
});

describe('personaLabel', () => {
  it('shows the name while personas are on', () => {
    expect(personaLabel('anzeige', RITA)).toBe('Rita');
    expect(personaLabel('prompt', RITA)).toBe('Rita');
  });

  /** §8's "fully disabled (neutral role labels)" — the whole visible substance. */
  it('shows the neutral role label when they are off', () => {
    expect(personaLabel('aus', RITA)).toBe('Review');
    expect(personaLabel('aus', CLARA)).toBe('Entwicklung');
  });

  /**
   * An alternate is a name, so `aus` has none.
   *
   * Asserted separately from the label because the two are separate reads on the
   * page, and dropping the name while keeping "(auch Chris)" would be personas
   * half-disabled — which is the state §8's word *fully* rules out.
   */
  it('drops the alternates with the names', () => {
    expect(personaAlternates('anzeige', CLARA)).toEqual(['Chris']);
    expect(personaAlternates('prompt', CLARA)).toEqual(['Chris']);
    expect(personaAlternates('aus', CLARA)).toEqual([]);
  });

  it('answers an empty list for a persona that has no alternates', () => {
    expect(personaAlternates('anzeige', RITA)).toEqual([]);
  });
});

describe('the wire', () => {
  it('accepts each of the three modes', () => {
    for (const mode of PERSONA_MODES) {
      const parsed = parsePersonaModeSubmission({ mode });
      expect(parsed).toEqual({ ok: true, value: { mode } });
    }
  });

  /**
   * The refusal is German, and the message names what is allowed.
   *
   * zod's own text is English and this reaches a page (§2). Asserting the
   * absence of the English is what catches a template that stopped being
   * translated — the same check `mail.test.ts` makes on the reminder.
   */
  it('refuses an unknown mode in German, naming the three that exist', () => {
    const parsed = parsePersonaModeSubmission({ mode: 'theater' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unerreichbar');
    expect(parsed.errors.join(' ')).toContain('Persona-Stufe');
    expect(parsed.errors.join(' ')).toContain('anzeige');
    expect(parsed.errors.join(' ')).not.toMatch(/\b(invalid|expected|option)\b/i);
  });

  it('refuses a body with no mode at all, and a body that is not an object', () => {
    expect(parsePersonaModeSubmission({}).ok).toBe(false);
    expect(parsePersonaModeSubmission(null).ok).toBe(false);
    expect(parsePersonaModeSubmission('anzeige').ok).toBe(false);
  });

  /**
   * A payload is parsed, never cast (A81).
   *
   * The case that matters is the one that *fails*: a roster entry missing its
   * desk would render `undefined` where §8's neutral label belongs, and under
   * `aus` that is the entire page.
   */
  it('refuses a roster entry that could not carry a neutral label', () => {
    const gut = {
      mode: 'aus' satisfies PersonaMode,
      roster: [
        { id: 'reviewer', department: 'Entwicklung', name: 'Rita', desk: 'Review', alternates: [] },
      ],
    };
    expect(personaSettingsView.safeParse(gut).success).toBe(true);

    const ohneDesk = {
      mode: 'aus',
      roster: [{ id: 'reviewer', department: 'Entwicklung', name: 'Rita', alternates: [] }],
    };
    expect(personaSettingsView.safeParse(ohneDesk).success).toBe(false);
  });
});
