/**
 * The half of the Phase 1 auth-incident gate that had no test (§6.1).
 *
 * The gate reads: "invalid/expired token simulation → **daemon idles + ntfy
 * alert**, zero tasks marked red, clean recovery after token replacement." The
 * evidence it cited (`wrap-up.itest.ts`) proves the last two clauses by calling
 * `parkAll` and `resumeAll` directly; the daemon's own decision — the clause
 * that separates "come and fix a token" from a compose restart loop — was
 * inside an entry point nothing exercised. The first Betriebsprüfung found
 * that, the gate un-ticked itself, and this file is why it can be ticked again.
 *
 * What is asserted is the loop's behaviour with injected failures, which is
 * what the gate names:
 *
 *  - a failing auth check parks work **once**, alerts, and returns rather than
 *    throwing or exiting;
 *  - a passing check afterwards resumes exactly what was parked;
 *  - the classification of a failure as an auth incident, which is a regular
 *    expression over a German sentence and therefore the kind of thing that
 *    silently stops matching.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  type CycleDeps,
  type CycleState,
  isAuthIncident,
  type NotifierLike,
  selfCheckCycle,
} from './incident-cycle.js';
import {
  assertPinnedCliVersion,
  assertSimpleModeOff,
  assertSubscriptionAuth,
  type CheckResult,
} from './self-check.js';

/**
 * The failures are produced by the real checks, never written out by hand.
 *
 * That is the lesson the audit that prompted this file taught: a test whose
 * inputs are a paraphrase of the real thing proves that the paraphrase behaves
 * as expected. `isAuthIncident` matches a regular expression against German
 * prose, so if a check's wording is reworded, the classification has to break
 * here rather than in production at three in the morning.
 */
function failing(result: CheckResult): { ok: false; reason: string } {
  if (result.ok) throw new Error('Erwartet wurde eine fehlgeschlagene Prüfung');
  return result;
}

const AUTH_FAILURE = failing(assertSubscriptionAuth({ loggedIn: false } as never));
const OTHER_FAILURE = failing(assertPinnedCliVersion('2.0.1', '2.1.220'));
const PASS: CheckResult = { ok: true };

const silentLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

function harness(script: CheckResult[][]) {
  let pass = 0;
  const parkAll = vi.fn(async (_reason: 'auth_incident' | 'manual_pause') => [
    { parked: true },
    { parked: true },
  ]);
  const resumeAll = vi.fn(async () => [{ id: 'a' }, { id: 'b' }]);
  // Typed, deliberately: a bare `vi.fn()` gives `mock.calls[0]` the type `[]`,
  // so every assertion that reads an argument would be checking `never` and
  // asserting nothing. That is the defect A50 records finding fifteen of.
  const send = vi.fn(async (_message: Parameters<NotifierLike['send']>[0]) => undefined);
  const appendEvent = vi.fn(
    async (_kind: 'auth.incident' | 'system.selfcheck_failed', _reasons: string[]) => undefined,
  );
  const onReady = vi.fn(async () => undefined);

  const deps: CycleDeps = {
    runChecks: async () => script[Math.min(pass++, script.length - 1)] ?? [PASS],
    wrapUp: { parkAll, resumeAll },
    notifier: { send },
    appendEvent,
    onReady,
    logger: silentLogger,
    retryMs: 300_000,
    readyMs: 60_000,
  };
  const state: CycleState = { authIncidentParked: false };
  return { deps, state, parkAll, resumeAll, send, appendEvent, onReady };
}

describe('selfCheckCycle (§6.1)', () => {
  it('parks, alerts and idles when the token is refused — it does not throw', async () => {
    const h = harness([[AUTH_FAILURE]]);
    const outcome = await selfCheckCycle(h.deps, h.state);

    expect(outcome.ready).toBe(false);
    expect(outcome.authIncident).toBe(true);
    expect(outcome.parked).toBe(2);
    // Idle, not exit. A daemon that exited here would be restarted by compose
    // within seconds and would produce pages of noise for a token problem.
    expect(outcome.waitMs).toBe(300_000);

    expect(h.parkAll).toHaveBeenCalledWith('auth_incident');
    expect(h.appendEvent).toHaveBeenCalledWith('auth.incident', [AUTH_FAILURE.reason]);
    expect(h.send).toHaveBeenCalledTimes(1);
    const alert = h.send.mock.calls[0]?.[0];
    expect(alert?.topic).toBe('alerts');
    expect(alert?.title).toContain('Auth-Vorfall');
    expect(alert?.message).toContain('nicht angemeldet');
    // Housekeeping belongs to a healthy pass only.
    expect(h.onReady).not.toHaveBeenCalled();
  });

  it('parks once, however long the incident lasts', async () => {
    // The retry interval is five minutes. Parking on every pass would write a
    // WIP commit and a handover note every five minutes for the duration.
    const h = harness([[AUTH_FAILURE]]);
    await selfCheckCycle(h.deps, h.state);
    await selfCheckCycle(h.deps, h.state);
    await selfCheckCycle(h.deps, h.state);

    expect(h.parkAll).toHaveBeenCalledTimes(1);
    // The alert still repeats — the operator has to keep hearing about it.
    expect(h.send).toHaveBeenCalledTimes(3);
  });

  it('resumes exactly what it parked, once the checks pass again', async () => {
    const h = harness([[AUTH_FAILURE], [PASS]]);
    await selfCheckCycle(h.deps, h.state);
    const recovered = await selfCheckCycle(h.deps, h.state);

    expect(recovered.ready).toBe(true);
    expect(recovered.resumed).toBe(2);
    expect(h.resumeAll).toHaveBeenCalledTimes(1);
    expect(h.state.authIncidentParked).toBe(false);
    expect(h.send.mock.calls.at(-1)?.[0]?.title).toContain('wieder in Ordnung');
    expect(h.onReady).toHaveBeenCalledTimes(1);
  });

  it('does not resume work it never parked', async () => {
    // §7.3 parks work for the budget guardian too, and that is a different
    // mechanism with a different reason. A healthy pass must not un-park it.
    const h = harness([[PASS]]);
    const outcome = await selfCheckCycle(h.deps, h.state);

    expect(outcome.ready).toBe(true);
    expect(outcome.resumed).toBe(0);
    expect(h.resumeAll).not.toHaveBeenCalled();
    expect(h.send).not.toHaveBeenCalled();
  });

  it('resumes only once, not on every healthy pass afterwards', async () => {
    const h = harness([[AUTH_FAILURE], [PASS]]);
    await selfCheckCycle(h.deps, h.state);
    await selfCheckCycle(h.deps, h.state);
    await selfCheckCycle(h.deps, h.state);

    expect(h.resumeAll).toHaveBeenCalledTimes(1);
  });

  /**
   * §8.2's `post_auth_incident`, which had no producer at all until now:
   * `Scheduler.requestAudit` was called by nothing outside a test, so two of
   * the eight values in `AUDIT_TRIGGERS` were unreachable — §8.2's own sixth
   * domain inside §8.2.
   */
  describe('§8.2 — die Prüfung nach einem Auth-Vorfall', () => {
    it('merkt eine Prüfung vor, wenn der Vorfall vorbei ist', async () => {
      const requestAudit = vi.fn();
      const h = harness([[AUTH_FAILURE], [PASS]]);
      h.deps.requestAudit = requestAudit;

      const incident = await selfCheckCycle(h.deps, h.state);
      // Not while it lasts: an audit is a model session and there is no model.
      expect(requestAudit).not.toHaveBeenCalled();
      expect(incident.auditRequested).toBe(false);

      const recovered = await selfCheckCycle(h.deps, h.state);
      expect(requestAudit).toHaveBeenCalledWith('post_auth_incident');
      expect(recovered.auditRequested).toBe(true);
    });

    it('merkt nichts vor, wenn es gar keinen Vorfall gab', async () => {
      const requestAudit = vi.fn();
      const h = harness([[PASS]]);
      h.deps.requestAudit = requestAudit;

      await selfCheckCycle(h.deps, h.state);
      await selfCheckCycle(h.deps, h.state);

      // Every healthy pass reaches this function. Requesting on all of them
      // would ask §8.2 for a run every fifteen seconds, forever.
      expect(requestAudit).not.toHaveBeenCalled();
    });

    it('merkt genau einmal vor, nicht bei jedem gesunden Durchlauf danach', async () => {
      const requestAudit = vi.fn();
      const h = harness([[AUTH_FAILURE], [PASS]]);
      h.deps.requestAudit = requestAudit;

      await selfCheckCycle(h.deps, h.state);
      await selfCheckCycle(h.deps, h.state);
      await selfCheckCycle(h.deps, h.state);

      expect(requestAudit).toHaveBeenCalledTimes(1);
    });

    it('nimmt die Wiederaufnahme nicht mit, wenn der Ablaufplaner wirft', async () => {
      const requestAudit = vi.fn(() => {
        throw new Error('Ablaufplaner gibt es noch nicht');
      });
      const h = harness([[AUTH_FAILURE], [PASS]]);
      h.deps.requestAudit = requestAudit;

      await selfCheckCycle(h.deps, h.state);
      const recovered = await selfCheckCycle(h.deps, h.state);

      // The resume already happened by the time this runs; a throw here would
      // undo an incident recovery for the sake of a cadence.
      expect(recovered.ready).toBe(true);
      expect(recovered.resumed).toBe(2);
      expect(recovered.auditRequested).toBe(false);
    });
  });

  it('treats a non-auth failure as a self-check failure, and still parks', async () => {
    const h = harness([[OTHER_FAILURE]]);
    const outcome = await selfCheckCycle(h.deps, h.state);

    expect(outcome.authIncident).toBe(false);
    expect(h.appendEvent).toHaveBeenCalledWith('system.selfcheck_failed', [OTHER_FAILURE.reason]);
    expect(h.parkAll).toHaveBeenCalledWith('manual_pause');
    expect(h.send.mock.calls[0]?.[0]?.title).toContain('Selbstprüfung fehlgeschlagen');
  });

  it('still alerts when parking itself fails', async () => {
    // The tasks are no worse off than before, and the operator still has to
    // hear about the incident. Swallowing the alert here would leave a daemon
    // that is idle and silent.
    const h = harness([[AUTH_FAILURE]]);
    h.parkAll.mockRejectedValueOnce(new Error('Datenbank weg'));

    const outcome = await selfCheckCycle(h.deps, h.state);
    expect(outcome.ready).toBe(false);
    expect(h.send).toHaveBeenCalledTimes(1);
    // And it did not latch, so the next pass tries to park again.
    expect(h.state.authIncidentParked).toBe(false);
  });

  it('waits the ready interval on a healthy pass and the retry interval otherwise', async () => {
    const healthy = harness([[PASS]]);
    expect((await selfCheckCycle(healthy.deps, healthy.state)).waitMs).toBe(60_000);
    const broken = harness([[AUTH_FAILURE]]);
    expect((await selfCheckCycle(broken.deps, broken.state)).waitMs).toBe(300_000);
  });
});

describe('isAuthIncident', () => {
  it('recognises every failure `assertSubscriptionAuth` can produce', () => {
    // Taken from the real function rather than paraphrased. A reworded check
    // that stops matching would otherwise turn an auth incident into a generic
    // self-check failure — same parking behaviour, wrong event kind, and an
    // alert that sends the reader looking in the wrong place.
    const auth = [
      assertSubscriptionAuth(null),
      assertSubscriptionAuth({ loggedIn: false } as never),
      assertSubscriptionAuth({ loggedIn: true, apiProvider: 'bedrock' } as never),
      assertSubscriptionAuth({
        loggedIn: true,
        apiProvider: 'firstParty',
        authMethod: 'api_key',
      } as never),
    ].map(failing);

    for (const failure of auth) expect(isAuthIncident([failure]), failure.reason).toBe(true);
  });

  it('counts `--bare` as an auth incident, because that is what it causes', () => {
    // `CLAUDE_CODE_SIMPLE` forces API-key auth (§2) and skips the §6.6 hooks.
    // Either half is a reason to stop; classing it with auth keeps the daemon
    // parking rather than failing tasks, which is the important half.
    expect(isAuthIncident([failing(assertSimpleModeOff({ CLAUDE_CODE_SIMPLE: '1' }))])).toBe(true);
  });

  it('does not claim an incident for a version mismatch', () => {
    expect(isAuthIncident([OTHER_FAILURE])).toBe(false);
    expect(isAuthIncident([failing(assertPinnedCliVersion('kaputt', '2.1.220'))])).toBe(false);
    expect(isAuthIncident([])).toBe(false);
  });

  it('is true when any one failure is an auth failure', () => {
    expect(isAuthIncident([OTHER_FAILURE, AUTH_FAILURE])).toBe(true);
  });
});
