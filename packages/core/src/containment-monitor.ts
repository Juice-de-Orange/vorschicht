/**
 * Did containment actually run? (§6.6)
 *
 * The companion to `assessSessionTools`: that one answers "did this session get
 * its tools", this one answers "did this session get its guard rails". Both
 * exist because the failure they catch is silent, and both hand the runner a
 * verdict rather than acting on it.
 *
 * Two ways containment fails without anyone noticing, and this catches both:
 *
 *  1. **The settings file was ignored.** A `--settings` document that fails the
 *     CLI's validation is discarded silently in `-p` mode. The session then has
 *     no hooks at all, and every write it attempts succeeds. The tell is that
 *     no `SessionStart` hook event ever arrives — the CLI reports that one even
 *     without `--include-hook-events`, so the check is free and lands before
 *     the first turn.
 *  2. **The hook process itself broke.** If `node` cannot start, or the hook
 *     times out, the CLI reports the hook as errored — and an errored
 *     `PreToolUse` hook **lets the tool proceed**. That is the one fail-open
 *     path in the design, and it cannot be closed from inside the hook, which
 *     is precisely why it is watched from outside. Our hook answers a refusal
 *     as JSON with exit 0 for exactly this reason: an outcome of `error` then
 *     means one thing only.
 *
 * The verdict is an **infra failure**, never a red task (§11, A25). Nothing
 * about the work was wrong; the harness was. A run that got this far is
 * interrupted and retried, and what it already wrote is the reason §7.2's
 * integrity re-check exists.
 */
import type { BackendEvent } from '@vorschicht/shared';

export type ContainmentVerdict = { ok: true } | { ok: false; problem: string };

/**
 * Exit code 2 means different things at the two events, and conflating them
 * would break the monitor in opposite directions.
 *
 * At `PreToolUse` it is a *deliberate* block: the CLI stops the tool and shows
 * stderr to the model (verified against the pinned CLI). Reading it as a
 * malfunction would fail every run whose hook refused something the only way
 * the CLI offers besides a JSON verdict.
 *
 * At `SessionStart` there is no tool to block, so exit 2 is nothing but an
 * alarm — and it is *our* alarm: the hook raises it when the run's containment
 * policy cannot be read. Reading it as a deliberate block would swallow the one
 * signal that arrives before a single turn has been spent.
 */
const BLOCKING_EXIT_CODE = 2;

export class ContainmentMonitor {
  private sessionStartSeen = false;
  private preToolUseSeen = false;
  private broken: string | null = null;

  /** Feed every backend event; only hook events are read. */
  observe(event: BackendEvent): void {
    if (event.type !== 'hook_event') return;
    if (event.phase !== 'response') return;

    if (event.event === 'SessionStart') {
      this.sessionStartSeen = true;
      // No exit-code exemption here: at SessionStart there is no tool to block,
      // so any non-success outcome is the hook telling us something is wrong.
      if (event.outcome !== null && event.outcome !== 'success') {
        this.recordBroken(
          'Der SessionStart-Hook meldete einen Fehler statt Erfolg. Entweder ist die ' +
            'Containment-Richtlinie dieses Laufs nicht lesbar oder der Hook selbst ist ' +
            'defekt — die Sitzung startete jedenfalls ohne nachweisbare Schreibgrenze (§6.6).',
        );
      }
      return;
    }
    if (event.event !== 'PreToolUse') return;
    this.preToolUseSeen = true;
    if (this.isFailure(event.outcome, event.exitCode)) {
      this.recordBroken(
        `Der Containment-Hook "${event.hookName}" scheiterte (outcome=${event.outcome ?? '—'}, ` +
          `exit=${event.exitCode ?? '—'}). Ein fehlgeschlagener PreToolUse-Hook hält das ` +
          'Werkzeug nicht auf — der Aufruf lief also ungeprüft durch.',
      );
    }
  }

  private isFailure(outcome: string | null, exitCode: number | null): boolean {
    if (exitCode === BLOCKING_EXIT_CODE) return false;
    if (outcome === null) return false;
    return outcome !== 'success';
  }

  private recordBroken(problem: string): void {
    // The first failure is the one worth reporting: everything after it happens
    // in a session that is already running unguarded.
    this.broken ??= problem;
  }

  /** Was containment demonstrably live? Fail-closed on "no evidence at all". */
  verdict(): ContainmentVerdict {
    if (this.broken) return { ok: false, problem: this.broken };
    if (!this.sessionStartSeen) {
      return {
        ok: false,
        problem:
          'Kein einziges Hook-Ereignis in dieser Sitzung. Die Rollen-Settings wurden ' +
          'nicht geladen — im -p-Modus geschieht das stillschweigend —, also lief die ' +
          'Sitzung ohne die Containment-Hooks aus §6.6.',
      };
    }
    return { ok: true };
  }

  /**
   * Did any tool call get checked?
   *
   * Weaker than `verdict()` and separate from it on purpose. A session that
   * called no tools legitimately has no `PreToolUse` events, so this must never
   * decide a run's fate on its own — the runner pairs it with `profileWrites`
   * to ask the one question that does have a right answer: a run that changed
   * files with no `PreToolUse` event behind it was not contained.
   */
  sawToolCheck(): boolean {
    return this.preToolUseSeen;
  }
}
