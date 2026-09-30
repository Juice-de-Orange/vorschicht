/**
 * The estimating meter against a real Postgres (§7.1, A6).
 *
 * Against a real database because everything under test is a property of what
 * the *tables* hand back: `agent_runs` is a view over an append-only event
 * stream, `spent_at` and `by_model` are columns 0014 added, and the whole point
 * of the exercise is that the estimator reads what the runner actually wrote
 * rather than what a stub says it wrote. Migration 0014 exists because the two
 * had silently disagreed since 0003 — `cost_usd` was read by the view and
 * written by nobody.
 *
 * No model tokens are spent: runs are inserted as the events a run leaves
 * behind, which is the same thing the runner does and one layer below it.
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import { DEGRADED_WRAP_UP_PERCENT, evaluateGuardian } from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { estimatePermitsWork, UsageEstimator } from './usage-estimator.js';
import { UsageMeter } from './usage-meter.js';

const url = process.env.TEST_DATABASE_URL;
const HOUR = 60 * 60_000;

describe.skipIf(!url)('UsageEstimator', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let clock = Date.parse('2026-08-01T14:00:00Z');

  beforeAll(async () => {
    database = await createTestDatabase('usageestimator');
    sql = createSql({ url: database.url, max: 4 });
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
  });

  beforeEach(async () => {
    // Everything here is append-only, so each case advances the clock and works
    // on its own runs rather than cleaning up — which is also how the system
    // behaves in production.
    clock += 30 * 24 * HOUR;
  });

  const meter = () => new UsageMeter({ sql, now: () => clock });
  const estimator = (overrides: Partial<ConstructorParameters<typeof UsageEstimator>[0]> = {}) =>
    new UsageEstimator({
      sql,
      meter: meter(),
      planProfile: 'max_20x',
      budget: { fiveHourUsd: 100, sevenDayUsd: 700 },
      now: () => clock,
      ...overrides,
    });

  /** Write the events a finished run leaves behind, and nothing more. */
  async function recordRun(
    at: number,
    costUsd: number,
    byModel: Record<string, number> = {},
  ): Promise<string> {
    const [row] = await sql<Array<{ run_id: string }>>`SELECT gen_random_uuid() AS run_id`;
    const runId = row?.run_id as string;
    await sql`
      INSERT INTO agent_run_events (run_id, seq, kind, occurred_at, payload)
      VALUES (${runId}, 0, 'created', ${new Date(at)},
              ${sql.json({ role: 'coder', model: 'sonnet', backend: 'fake', cwd: '/tmp' })})
    `;
    await sql`
      INSERT INTO agent_run_events (run_id, seq, kind, occurred_at, payload)
      VALUES (${runId}, 1, 'result', ${new Date(at)},
              ${sql.json({ raw: {}, tokensIn: 2, tokensOut: 100, costUsd, byModel })})
    `;
    await sql`
      INSERT INTO agent_run_events (run_id, seq, kind, occurred_at, payload)
      VALUES (${runId}, 2, 'terminated', ${new Date(at)},
              ${sql.json({ reason: 'completed', exitCode: 0 })})
    `;
    return runId;
  }

  async function recordAnchor(
    window: 'five_hour' | 'seven_day',
    resetsAt: number,
    status = 'allowed',
    observedAt = clock,
  ): Promise<void> {
    await sql`
      INSERT INTO usage_window_anchors (window_kind, resets_at, status, observed_at)
      VALUES (${window}, ${new Date(resetsAt)}, ${status}, ${new Date(observedAt)})
      ON CONFLICT (window_kind, resets_at) DO NOTHING
    `;
  }

  it('liest die Kosten aus agent_runs und meldet beide Fenster an den Zähler', async () => {
    await recordRun(clock - HOUR, 45);
    const report = await estimator().sample();

    // 45 / (100 * 0.9) = 50%.
    expect(report.windows.find((w) => w.window === 'five_hour')?.usedPercent).toBe(50);
    expect(report.windows.find((w) => w.window === 'seven_day')?.usedPercent).toBeCloseTo(7.14, 1);

    const samples = await meter().currentSamples();
    const five = samples.find((s) => s.window === 'five_hour');
    expect(five?.source).toBe('estimated');
    expect(five?.usedPercent).toBe(50);
  });

  /**
   * The whole reason 0014 exists. `agent_runs.cost_usd` was read by the view
   * from migration 0003 onward and written by nothing, so it was NULL on every
   * run this system ever recorded. If it were still NULL, the estimator would
   * read every session as free and the guardian would never close.
   */
  it('bekommt cost_usd tatsächlich aus dem Ereignisstrom, nicht NULL', async () => {
    const runId = await recordRun(clock - HOUR, 12.5, { 'claude-opus-5': 12.5 });
    const [run] = await sql<Array<{ cost_usd: string | null; spent_at: Date | null }>>`
      SELECT cost_usd, spent_at FROM agent_runs WHERE run_id = ${runId}
    `;
    expect(run?.cost_usd).not.toBeNull();
    expect(Number(run?.cost_usd)).toBe(12.5);
    expect(run?.spent_at).not.toBeNull();
  });

  it('schlüsselt Kosten nach Modellklasse auf, ohne sie dem Wächter vorzulegen', async () => {
    await recordRun(clock - HOUR, 10, { 'claude-opus-5': 9, 'claude-haiku-4-5': 1 });
    const report = await estimator().sample();
    expect(report.byModel).toEqual({ 'claude-opus-5': 9, 'claude-haiku-4-5': 1 });
    // §7.1's per-model weekly window is deliberately not estimated — nothing
    // says what the plan defines without the official reading (A60).
    const samples = await meter().currentSamples();
    expect(samples.some((s) => s.window === 'seven_day_model')).toBe(false);
  });

  it('nutzt eine beobachtete Fenstergrenze als exakten Anfang', async () => {
    // Reset in one hour → the window began four hours ago. The older run is
    // outside it and must not count.
    await recordRun(clock - 4.5 * HOUR, 90);
    await recordRun(clock - 2 * HOUR, 18);
    await recordAnchor('five_hour', clock + HOUR);

    const report = await estimator().sample();
    const five = report.windows.find((w) => w.window === 'five_hour');
    expect(five?.basis.kind).toBe('anchored');
    expect(five?.spendUsd).toBe(18);
  });

  it('ignoriert eine bereits abgelaufene Fenstergrenze', async () => {
    await recordRun(clock - 2 * HOUR, 18);
    await recordAnchor('five_hour', clock - HOUR);

    const report = await estimator().sample();
    expect(report.windows.find((w) => w.window === 'five_hour')?.basis.kind).toBe('rolling');
  });

  /**
   * The end-to-end claim of this whole iteration: with the official source
   * blind (A59), an estimate reaches the guardian and the guardian acts on it —
   * closing above the degraded threshold and opening below it, with nothing in
   * §7.2 relaxed to make that happen.
   */
  it('schließt und öffnet das Tor über den Wächter, ohne §7.2 anzufassen', async () => {
    // A blind official reading, exactly as a real run produces one today.
    await meter().ingestOfficial({ rate_limits_available: false });
    expect(
      evaluateGuardian({ samples: await meter().currentSamples(), latches: [], now: clock }).state,
    ).toBe('wrap_up');

    // Spend well past the degraded threshold: 80 / 90 = 88.9%.
    await recordRun(clock - HOUR, 80);
    await estimator().sample();
    const closed = evaluateGuardian({
      samples: await meter().currentSamples(),
      latches: [],
      now: clock,
    });
    expect(closed.state).toBe('wrap_up');
    expect(closed.reason.kind).toBe('degraded_source');

    // Move past the moment that spend leaves the rolling window and re-estimate.
    clock += 5 * HOUR + 60_000;
    await estimator().sample();
    expect(
      evaluateGuardian({ samples: await meter().currentSamples(), latches: [], now: clock }).state,
    ).toBe('normal');
  });

  /**
   * A latch that outlived its cause. Without a computed relief time the
   * guardian falls back to a full nominal window from the moment it latched,
   * which for a rolling estimate rests the studio for five hours over spend
   * that expires in one.
   */
  it('gibt dem Wächter eine Entlastungszeit mit, statt ihn voll auslaufen zu lassen', async () => {
    await recordRun(clock - 4 * HOUR, 80);
    await recordRun(clock, 5);
    const report = await estimator().sample();
    const five = report.windows.find((w) => w.window === 'five_hour');
    expect(five?.usedPercent).toBeGreaterThanOrEqual(DEGRADED_WRAP_UP_PERCENT);
    // Relief when the four-hour-old entry ages out — one hour from now, not five.
    expect(five?.resetsAt).toBe(clock - 4 * HOUR + 5 * HOUR);

    const samples = await meter().currentSamples();
    expect(samples.find((s) => s.window === 'five_hour')?.resetsAt).toBe(five?.resetsAt);
  });

  /*
   * A101 — the three cases that replace "senkt das Plan-Budget auf ein
   * beobachtetes Limit-Ereignis (A6)".
   *
   * That case passed for a year and encoded the defect: it only ever used
   * `'rejected'`, so the status the vendor actually sends — `allowed_warning`,
   * its 75% *warning* — was absent from the code and from the test in exactly
   * the same way. §8.2's founding thesis, in the file whose subject is the
   * studio's own budget.
   */

  it('senkt das Budget nicht auf eine Warnung des Anbieters (A101, der Defekt vom 2.8.)', async () => {
    await recordRun(clock - 2 * HOUR, 30);
    await recordRun(clock - HOUR, 25);
    // `allowed_warning` is what a real account sends above 75% (A73). It is not
    // a refusal, and the old `WHERE status <> 'allowed'` matched it anyway.
    await recordAnchor('five_hour', clock + HOUR, 'allowed_warning');

    const service = estimator();
    const report = await service.sample();
    expect(service.budget.fiveHourUsd).toBe(100);
    // 55 / (100 × 0.9) — the reading the configured budget gives, not 100.
    expect(report.windows.find((w) => w.window === 'five_hour')?.usedPercent).toBeCloseTo(61.1, 1);
  });

  it('senkt das Budget auch auf eine echte Ablehnung nicht (A101)', async () => {
    await recordRun(clock - HOUR, 25);
    await recordAnchor('five_hour', clock + HOUR, 'rejected');

    const service = estimator();
    await service.sample();
    // Deliberately identical to the case above: the decision is not "refusals
    // are rarer than warnings", it is that our own spend cannot measure an
    // account-wide cap (A60.6). A genuine refusal still reaches the guardian —
    // through `ingestOfficialWindow`, which the runner gates on the frame's
    // utilisation rather than on its status (A73.4).
    expect(service.budget.fiveHourUsd).toBe(100);
  });

  it('behandelt einen unbekannten Status nicht als Limit-Ereignis (A101)', async () => {
    await recordRun(clock - HOUR, 40);
    // The backend writes the literal 'unbekannt' for a frame shape it does not
    // recognise. Under `<> 'allowed'` that was a refusal — fail-open, in the
    // one component §1 principle 3 calls the most safety-critical there is.
    await recordAnchor('five_hour', clock + HOUR, 'unbekannt');

    const service = estimator();
    await service.sample();
    expect(service.budget.fiveHourUsd).toBe(100);
  });

  it('hebt ein Budget niemals an, egal wie viel überstanden wurde', async () => {
    await recordRun(clock - HOUR, 40);
    await recordAnchor('five_hour', clock + HOUR, 'allowed');
    const service = estimator();
    await service.sample();
    expect(service.budget.fiveHourUsd).toBe(100);
  });

  it('rechnet die Zeitreihe vom 2.8.2026 als ~0,4 % statt als 100 % (A101)', async () => {
    // The incident, reproduced from the server's own rows rather than from a
    // round number: three runs on 2026-08-02 (two smoke sessions and one audit)
    // and the seven-day anchor that arrived at 18:40 reporting utilisation 0.36
    // — a *warning*, which the old code read as "the cap is 3".
    const service = estimator({ budget: { fiveHourUsd: 250, sevenDayUsd: 1120 } });
    await recordRun(clock - 8 * HOUR, 0.0511);
    await recordRun(clock - 7 * HOUR, 3.5335);
    await recordRun(clock - 2 * HOUR, 0.051);
    await recordAnchor('seven_day', clock + 6 * 24 * HOUR, 'allowed_warning', clock - HOUR);

    const report = await service.sample();
    const week = report.windows.find((w) => w.window === 'seven_day');
    // 3.6356 / (1120 × 0.9) = 0.36%. Under the old code: 3.6356 / (3 × 0.9),
    // clamped to 100, and the guardian on `hard_stop` for seven days.
    expect(week?.usedPercent).toBeCloseTo(0.36, 2);
    expect(week?.usedPercent).toBeLessThan(DEGRADED_WRAP_UP_PERCENT);
    expect(estimatePermitsWork(report.windows)).toBe(true);
  });

  it('behandelt einen Lauf ohne Ergebnis als nicht abgerechnet, statt zu raten', async () => {
    const [row] = await sql<Array<{ run_id: string }>>`SELECT gen_random_uuid() AS run_id`;
    if (!row) throw new Error('keine run_id');
    await sql`
      INSERT INTO agent_run_events (run_id, seq, kind, occurred_at, payload)
      VALUES (${row.run_id}, 0, 'created', ${new Date(clock - HOUR)},
              ${sql.json({ role: 'coder', model: 'sonnet', backend: 'fake', cwd: '/tmp' })})
    `;
    const report = await estimator().sample();
    expect(report.windows.every((w) => w.spendUsd === 0)).toBe(true);
  });

  it('teilt dieselbe Schwelle wie der Wächter, statt eine zweite Politik zu führen', async () => {
    await recordRun(clock - HOUR, 90 * (DEGRADED_WRAP_UP_PERCENT / 100));
    const report = await estimator().sample();
    expect(estimatePermitsWork(report.windows)).toBe(false);
    expect(
      evaluateGuardian({ samples: await meter().currentSamples(), latches: [], now: clock }).state,
    ).toBe('wrap_up');
  });

  it('hält eine Fenstergrenze nur einmal fest, so oft sie auch gemeldet wird', async () => {
    const resetsAt = clock + 2 * HOUR;
    await recordAnchor('five_hour', resetsAt);
    await recordAnchor('five_hour', resetsAt);
    await recordAnchor('five_hour', resetsAt);
    const [row] = await sql<Array<{ count: string }>>`
      SELECT count(*) FROM usage_window_anchors WHERE resets_at = ${new Date(resetsAt)}
    `;
    expect(Number(row?.count)).toBe(1);
  });

  it('verweigert das Ändern und Löschen einer Fenstergrenze (§5)', async () => {
    await recordAnchor('five_hour', clock + 3 * HOUR);
    await expect(
      sql`UPDATE usage_window_anchors SET status = 'gefälscht' WHERE window_kind = 'five_hour'`,
    ).rejects.toThrow(/append-only/i);
    await expect(sql`DELETE FROM usage_window_anchors`).rejects.toThrow(/append-only/i);
    await expect(sql`TRUNCATE usage_window_anchors`).rejects.toThrow(/append-only/i);
  });
});
