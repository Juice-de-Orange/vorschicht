/**
 * The two questions both real deploy targets must answer before they touch a
 * machine, and the error they raise when the answer is no.
 *
 * §19 says every command is argv and never a shell, and `DeployContext.run`
 * keeps that promise **locally**. It cannot keep it remotely: `ssh host cmd`
 * and `rsync`'s remote path are both handed to a shell on the far side, by
 * construction. So what protects the remote side is not the transport but the
 * fact that nothing reaching it carries a metacharacter — checked here, once,
 * with the same regular expression `parseGateCommand` uses (A55.3, A62.4: two
 * dialects of "which characters are dangerous" are two answers to one
 * question, and the day they differ the narrower one is the only guard).
 *
 * The second question is narrower and sharper. A release name becomes a
 * **docker tag** in one target and a **directory name** in the other, and it
 * arrives from `DeployContext.sha`.
 *
 * This guard was written against a service that derived that value from
 * `task.branch ?? 'HEAD'` — and it was right to refuse it: a branch is
 * `vorschicht/task-<id>` (§10), which is not a legal docker tag and would nest
 * a release directory one level deeper than the prune ever looks. That
 * derivation is **gone** (`DeployService.deploy` now takes the sha as a
 * required parameter, because a value of this consequence must not be guessed
 * from a field meaning something else), so the guard no longer has a known
 * caller that trips it. It stays anyway, and not out of caution: every future
 * caller — the merge queue, a manual redeploy, a Phase 9 rollback drill — hands
 * this string in, and the one that gets it wrong will not be the one that wrote
 * this file.
 *
 * Worse in the other direction: the names a prune deletes come back from the
 * machine's own listing, and `..` there is a `rm -rf` outside the releases
 * directory. Both ends are checked, and both fail closed — a release whose name
 * we cannot vouch for is never built and never deleted.
 */
import { SHELL_METACHARACTERS } from '../gate-suite.js';

export class DeployTargetError extends Error {
  constructor(
    readonly command: string,
    message: string,
  ) {
    super(message);
    this.name = 'DeployTargetError';
  }
}

/**
 * What may be a release name.
 *
 * The intersection of docker's tag grammar (`[A-Za-z0-9_][A-Za-z0-9._-]{0,127}`)
 * and a directory name that is safe to hand a remote `rm -rf`: no slash, no
 * leading dot, nothing that could be `..`. Deliberately the intersection rather
 * than one grammar per target — a release recorded by one method and read back
 * by a human should not be legal in one place and not in the other.
 */
const RELEASE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

/** The sha as it will appear on the machine, or a refusal naming the value. */
export function assertReleaseName(value: string, what = 'Der Release-Name'): string {
  if (RELEASE_NAME.test(value)) return value;
  throw new DeployTargetError(
    value,
    `${what} „${value}" ist als Release-Name nicht verwendbar. Er wird zum Docker-Tag und zum ` +
      'Verzeichnisnamen auf der Zielmaschine, also sind nur Buchstaben, Ziffern, Punkt, ' +
      'Unterstrich und Bindestrich erlaubt — kein Schrägstrich, kein führender Punkt.',
  );
}

/** True when a name from the machine's own listing may be deleted. */
export function isReleaseName(value: string): boolean {
  return RELEASE_NAME.test(value);
}

/**
 * A configured value that reaches a remote shell, or a refusal naming the
 * character.
 *
 * The message names the offending character for the reason A55.3 gives: a
 * message that says "invalid" sends somebody hunting.
 */
export function assertRemoteSafe(what: string, value: string): string {
  const offending = SHELL_METACHARACTERS.exec(value);
  if (!offending) return value;
  throw new DeployTargetError(
    value,
    `${what} „${value}" enthält das Sonderzeichen "${offending[0]}". Es wird über ssh bzw. ` +
      'rsync auf der Zielmaschine ausgeführt, und dort steht eine Shell — Vorschicht gibt ' +
      'dorthin nichts, was sie umdeuten könnte (§19).',
  );
}
