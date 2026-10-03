/**
 * The arguments of `dist/cli/invite.js`, parsed apart from the CLI itself.
 *
 * A module of its own because `invite.ts` runs on import, and because the one
 * defect this file exists for was invisible exactly there: `--purpose rescue`
 * (with a space) matched nothing, fell back to `bootstrap` and minted an
 * invitation of the wrong kind **without a word**. For the command somebody
 * runs when he is locked out, a silent fallback is the wrong direction to fail
 * in — so both spellings are read, and anything this CLI does not understand is
 * refused with the usage line instead of being ignored.
 */
import type { RegistrationPurpose } from '@vorschicht/shared';

export const INVITE_PURPOSES: readonly RegistrationPurpose[] = [
  'bootstrap',
  'rescue',
  'additional',
];

export const INVITE_USAGE = `Aufruf: node dist/cli/invite.js [--purpose <${INVITE_PURPOSES.join('|')}>]`;

export type InviteArgs =
  | { ok: true; purpose: RegistrationPurpose }
  | { ok: false; problem: string };

function alsZweck(wert: string): InviteArgs {
  return (INVITE_PURPOSES as readonly string[]).includes(wert)
    ? { ok: true, purpose: wert as RegistrationPurpose }
    : { ok: false, problem: `Unbekannter Zweck "${wert}". Erlaubt: ${INVITE_PURPOSES.join(', ')}` };
}

/** `--purpose=<value>` and `--purpose <value>`; no argument means `bootstrap`. */
export function parseInviteArgs(args: readonly string[]): InviteArgs {
  let result: InviteArgs = { ok: true, purpose: 'bootstrap' };
  let seen = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? '';
    let wert: string | undefined;
    if (arg === '--purpose') {
      wert = args[index + 1];
      index += 1;
      if (wert === undefined || wert.startsWith('--')) {
        return { ok: false, problem: '--purpose braucht einen Wert.' };
      }
    } else if (arg.startsWith('--purpose=')) {
      wert = arg.slice('--purpose='.length);
    } else {
      return { ok: false, problem: `Unbekanntes Argument "${arg}".` };
    }

    if (seen) return { ok: false, problem: '--purpose ist mehrfach angegeben.' };
    seen = true;
    result = alsZweck(wert);
    if (!result.ok) return result;
  }

  return result;
}
