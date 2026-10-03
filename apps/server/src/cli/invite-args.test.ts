/**
 * `--purpose rescue` must not quietly mint a `bootstrap` invitation.
 *
 * Found by a functional check on a fresh clone: the CLI read `--purpose=<value>`
 * only, so the spelling with a space matched nothing and the fallback answered
 * — an invitation of the wrong kind, and no line saying so. These cases pin both
 * spellings and the refusal of everything else.
 */
import { describe, expect, it } from 'vitest';
import { INVITE_USAGE, parseInviteArgs } from './invite-args.js';

describe('parseInviteArgs', () => {
  it('nimmt ohne Argument den Zweck bootstrap', () => {
    expect(parseInviteArgs([])).toEqual({ ok: true, purpose: 'bootstrap' });
  });

  it('liest --purpose=rescue', () => {
    expect(parseInviteArgs(['--purpose=rescue'])).toEqual({ ok: true, purpose: 'rescue' });
  });

  it('liest --purpose rescue genauso — das war der stille Rückfall auf bootstrap', () => {
    expect(parseInviteArgs(['--purpose', 'rescue'])).toEqual({ ok: true, purpose: 'rescue' });
    expect(parseInviteArgs(['--purpose', 'additional'])).toEqual({
      ok: true,
      purpose: 'additional',
    });
  });

  it('lehnt einen unbekannten Zweck in beiden Schreibweisen ab', () => {
    for (const args of [['--purpose=rettung'], ['--purpose', 'rettung']]) {
      const parsed = parseInviteArgs(args);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok === false && parsed.problem).toContain('Unbekannter Zweck "rettung"');
    }
  });

  it('lehnt --purpose ohne Wert ab, statt das nächste Argument zu verschlucken', () => {
    expect(parseInviteArgs(['--purpose'])).toEqual({
      ok: false,
      problem: '--purpose braucht einen Wert.',
    });
    expect(parseInviteArgs(['--purpose', '--purpose=rescue']).ok).toBe(false);
    expect(parseInviteArgs(['--purpose=']).ok).toBe(false);
  });

  it('lehnt jedes Argument ab, das die CLI nicht kennt', () => {
    for (const arg of ['rescue', '--rescue', '--zweck=rescue', '-p']) {
      const parsed = parseInviteArgs([arg]);
      expect(parsed).toEqual({ ok: false, problem: `Unbekanntes Argument "${arg}".` });
    }
    // Auch hinter einem gültigen: ein Tippfehler darf nicht untergehen.
    expect(parseInviteArgs(['--purpose=rescue', 'jetzt']).ok).toBe(false);
  });

  it('lehnt einen doppelten Zweck ab, statt einen von beiden zu wählen', () => {
    expect(parseInviteArgs(['--purpose=rescue', '--purpose', 'bootstrap']).ok).toBe(false);
  });

  it('nennt in der Aufrufzeile beide erlaubten Formen über eine Schreibweise', () => {
    expect(INVITE_USAGE).toContain('--purpose <bootstrap|rescue|additional>');
  });
});
