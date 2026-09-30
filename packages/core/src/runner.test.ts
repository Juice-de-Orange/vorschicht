/**
 * The runner's decision, without a backend, a database or a clock.
 *
 * `classifyRun` is where §11's failure classification (A25), §6.1's auth
 * incident and §7.3's park all meet, and the *order* of those rules is the
 * content — not the individual branches. So most of what is asserted here is
 * precedence: which signal wins when two of them fire at once, because that is
 * the case a real run produces and the one an isolated branch test never sees.
 */
import { describe, expect, it } from 'vitest';
import { classifyRun, type RunSignals, repairPrompt } from './runner.js';

function signals(overrides: Partial<RunSignals> = {}): RunSignals {
  return {
    termination: 'completed',
    tools: { ok: true },
    containment: { ok: true },
    toolUses: 3,
    sawToolCheck: true,
    hasResult: true,
    resultProblem: null,
    ...overrides,
  };
}

describe('classifyRun (§11, A25)', () => {
  it('nennt einen sauberen Lauf ok', () => {
    expect(classifyRun(signals()).status).toBe('ok');
  });

  it('behandelt einen Anmeldefehler als Vorfall, nicht als gescheiterte Aufgabe', () => {
    // §6.1 — and it wins over everything else, because a session that could not
    // authenticate has no tools, no hooks and no result either. Reading those
    // symptoms first would file an auth incident as three different problems.
    const verdict = classifyRun(
      signals({
        termination: 'auth_incident',
        tools: { ok: false, problem: 'kein MCP' },
        containment: { ok: false, problem: 'keine Hooks' },
        hasResult: false,
      }),
    );
    expect(verdict.status).toBe('auth_incident');
    expect(verdict.problem).toMatch(/§6\.1/);
  });

  it('nennt einen abgebrochenen Lauf unterbrochen, nicht uneingedämmt', () => {
    // The case that would otherwise file every wrap-up as an infra failure: a
    // session stopped in its first second has no SessionStart hook event yet,
    // and the containment monitor fails closed on exactly that evidence.
    const verdict = classifyRun(
      signals({
        termination: 'interrupted',
        containment: { ok: false, problem: 'Kein einziges Hook-Ereignis' },
        hasResult: false,
        toolUses: 0,
        sawToolCheck: false,
      }),
    );
    expect(verdict.status).toBe('interrupted');
  });

  it('stuft eine Sitzung ohne ihre Werkzeuge als Infrastrukturfehler ein', () => {
    // A49: a pending MCP server leaves the first turn blind. Nothing about the
    // work was wrong, so §11's red path must not apply.
    const verdict = classifyRun(
      signals({ tools: { ok: false, problem: 'Der MCP-Server meldete "pending"' } }),
    );
    expect(verdict.status).toBe('infra');
    expect(verdict.problem).toMatch(/pending/);
  });

  it('stuft gebrochenes Containment als Infrastrukturfehler ein', () => {
    const verdict = classifyRun(
      signals({
        containment: { ok: false, problem: 'Der SessionStart-Hook meldete einen Fehler' },
      }),
    );
    expect(verdict.status).toBe('infra');
  });

  it('erkennt Werkzeugaufrufe ohne einen einzigen PreToolUse-Hook', () => {
    // §6.6's liveness rule. The matcher is `*`, so every call must produce one;
    // a run that called nothing proves nothing and is not accused (below).
    const verdict = classifyRun(signals({ toolUses: 5, sawToolCheck: false }));
    expect(verdict.status).toBe('infra');
    expect(verdict.problem).toMatch(/ungeprüft/);
  });

  it('beschuldigt einen Lauf ohne Werkzeugaufrufe nicht', () => {
    expect(classifyRun(signals({ toolUses: 0, sawToolCheck: false })).status).toBe('ok');
  });

  it('behandelt einen Absturz als Infrastrukturfehler, nicht als rote Aufgabe', () => {
    expect(classifyRun(signals({ termination: 'crashed', hasResult: false })).status).toBe('infra');
  });

  it('nennt einen Absturz einen Absturz, nicht ein Containment-Problem', () => {
    // A process that never started has no `SessionStart` hook either, so the
    // containment monitor fails closed — correctly, and about nothing. Both
    // branches say `infra`, so the studio behaves identically; what differs is
    // the sentence a human reads at three in the morning. This ordering was
    // wrong once and cost real time: a smoke session whose working directory
    // did not exist was reported as "the session ran without the §6.6
    // containment hooks", which is a true statement about a session that had
    // not happened (A58).
    const verdict = classifyRun(
      signals({
        termination: 'crashed',
        hasResult: false,
        containment: { ok: false, problem: 'Kein einziges Hook-Ereignis in dieser Sitzung.' },
      }),
    );
    expect(verdict.status).toBe('infra');
    expect(verdict.problem).toMatch(/Sitzungsprozess endete unerwartet/);
    expect(verdict.problem).not.toMatch(/Hook/);
  });

  it('nennt aber ungeprüfte Werkzeugaufrufe, auch wenn danach abgestürzt wurde', () => {
    // The other direction, and it is the one that must not be lost: a session
    // that called tools with no `PreToolUse` behind them ran uncontained, and
    // crashing afterwards does not make that less true. Evidence outranks an
    // absence.
    const verdict = classifyRun(
      signals({ termination: 'crashed', hasResult: false, toolUses: 3, sawToolCheck: false }),
    );
    expect(verdict.problem).toMatch(/ungeprüft/);
  });

  it.each(['max_turns', 'max_budget', 'timeout'] as const)(
    'behandelt die Kappung %s als gescheiterte Arbeit',
    (termination) => {
      // A32's caps are about the work not finishing, which is the red path —
      // unlike everything above it, where the harness was the problem.
      const verdict = classifyRun(signals({ termination, hasResult: false }));
      expect(verdict.status).toBe('failed');
      expect(verdict.problem).toMatch(/A32/);
    },
  );

  it('scheitert an einer Sitzung ohne Ergebnisnachricht', () => {
    const verdict = classifyRun(signals({ hasResult: false }));
    expect(verdict.status).toBe('failed');
    expect(verdict.problem).toMatch(/§6\.3/);
  });

  it('scheitert an einem Ergebnis, das den Rollenvertrag verletzt', () => {
    const verdict = classifyRun(signals({ resultProblem: 'status: erwartet "done"' }));
    expect(verdict.status).toBe('failed');
    expect(verdict.problem).toMatch(/erwartet "done"/);
  });

  it('lässt die Werkzeugprüfung aus, wenn die Sitzung ohne MCP gestartet wurde', () => {
    // A session spawned without a configured MCP server is degraded on purpose
    // (see `RunnerPaths`). Checking it for tools nobody granted would turn a
    // deliberate configuration into an infra failure on every single run.
    expect(classifyRun(signals({ tools: null })).status).toBe('ok');
  });
});

describe('repairPrompt (§6.3)', () => {
  it('benennt Rolle und Problem und verbietet neue Arbeit', () => {
    const prompt = repairPrompt('reviewer', 'verdict: Required');
    expect(prompt).toContain('reviewer');
    expect(prompt).toContain('verdict: Required');
    // The repair restates a result that already exists. A session that started
    // working again would produce a second answer describing work the first
    // run's record does not contain.
    expect(prompt).toMatch(/Do not run tools/);
    expect(prompt).toMatch(/do not redo any work/);
  });
});
