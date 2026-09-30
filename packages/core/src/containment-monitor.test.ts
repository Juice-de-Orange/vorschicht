import type { BackendEvent } from '@vorschicht/shared';
import { describe, expect, it } from 'vitest';
import { ContainmentMonitor } from './containment-monitor.js';

function hook(
  event: string,
  overrides: Partial<Extract<BackendEvent, { type: 'hook_event' }>> = {},
): BackendEvent {
  return {
    type: 'hook_event',
    runId: 'run-1',
    event,
    hookName: `${event}:startup`,
    phase: 'response',
    outcome: 'success',
    exitCode: 0,
    ...overrides,
  };
}

function feed(...events: BackendEvent[]): ContainmentMonitor {
  const monitor = new ContainmentMonitor();
  for (const event of events) monitor.observe(event);
  return monitor;
}

describe('ContainmentMonitor', () => {
  it('accepts a session whose SessionStart hook ran', () => {
    expect(feed(hook('SessionStart')).verdict()).toEqual({ ok: true });
  });

  it('refuses a session with no hook events at all', () => {
    // The silent failure §6.6 names: a settings file that fails validation is
    // discarded in -p mode with no warning, and every write then succeeds.
    const verdict = feed({ type: 'assistant_text', runId: 'run-1', text: 'hallo' }).verdict();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problem).toContain('ohne die Containment-Hooks');
  });

  it('refuses a session whose SessionStart hook itself errored', () => {
    // Exit 2 at SessionStart is our own alarm — the hook raises it when the
    // run's policy cannot be read — and it arrives before any turn is spent.
    // At PreToolUse the same code means a deliberate block; see below.
    const verdict = feed(hook('SessionStart', { outcome: 'error', exitCode: 2 })).verdict();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problem).toContain('Richtlinie');
  });

  it('refuses a run whose PreToolUse hook failed — the tool then ran unchecked', () => {
    const verdict = feed(
      hook('SessionStart'),
      hook('PreToolUse', { hookName: 'PreToolUse:Write', outcome: 'error', exitCode: 1 }),
    ).verdict();
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problem).toContain('PreToolUse:Write');
  });

  it('reads a deliberate exit 2 as a block, not as a malfunction', () => {
    // Verified against the pinned CLI: exit 2 blocks the tool and reports the
    // hook as errored. Treating it as a broken hook would fail every run whose
    // hook refused something the only way the CLI offers besides JSON.
    expect(
      feed(hook('SessionStart'), hook('PreToolUse', { outcome: 'error', exitCode: 2 })).verdict(),
    ).toEqual({ ok: true });
  });

  it('accepts our own denial shape — JSON deny, outcome success, exit 0', () => {
    expect(feed(hook('SessionStart'), hook('PreToolUse')).verdict()).toEqual({ ok: true });
  });

  it('keeps the first failure, since everything after it happens unguarded', () => {
    const verdict = feed(
      hook('SessionStart'),
      hook('PreToolUse', { hookName: 'PreToolUse:Write', outcome: 'error', exitCode: 1 }),
      hook('PreToolUse', { hookName: 'PreToolUse:Edit', outcome: 'error', exitCode: 127 }),
    ).verdict();
    // Asserted before the narrowing, unlike its three siblings above, which had
    // this line and this one did not. Without it the whole case sits inside
    // `if (!verdict.ok)`: a monitor that started accepting a run whose
    // PreToolUse hook failed — i.e. one whose tools ran unchecked, the §6.6
    // guarantee itself — would skip the body and the test would stay green.
    // Verified by mutation: with `isFailure` disabled this case passed, and its
    // sibling at line 49 did not.
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.problem).toContain('PreToolUse:Write');
  });

  it('ignores the started and progress phases — only a response is a result', () => {
    expect(feed(hook('SessionStart', { phase: 'started', outcome: null })).verdict().ok).toBe(
      false,
    );
  });

  it('reports separately whether any tool call was ever checked', () => {
    // Weaker than the verdict on purpose: a session that called no tools
    // legitimately has no PreToolUse events, so this must not decide a run's
    // fate alone. The runner pairs it with `profileWrites`.
    expect(feed(hook('SessionStart')).sawToolCheck()).toBe(false);
    expect(feed(hook('SessionStart'), hook('PreToolUse')).sawToolCheck()).toBe(true);
  });

  it('ignores events from other parts of the stream', () => {
    expect(
      feed(
        { type: 'run_started', runId: 'run-1', sessionId: 's', cwd: '/tmp', pid: 1 },
        { type: 'permission_denied', runId: 'run-1', tool: 'Write', input: {} },
        hook('SessionStart'),
      ).verdict(),
    ).toEqual({ ok: true });
  });
});
