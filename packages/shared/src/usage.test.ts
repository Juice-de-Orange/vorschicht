import { describe, expect, it } from 'vitest';
import {
  DIVERGENCE_THRESHOLD_PERCENT,
  detectScaleMismatch,
  getUsageResponseSchema,
  normaliseResetsAt,
  normaliseUtilization,
  overageEnabled,
  parseUsageSnapshot,
  reconcile,
} from './usage.js';

/**
 * Verbatim excerpt of a real `get_usage` response (CLI 2.1.220, 2026-08-01),
 * trimmed only of `behaviors` — which ADR 0001 decided never to store. Using
 * the observed payload rather than an invented one is the point: the internal
 * codename keys and the double representation are exactly the shape surprises
 * a hand-written fixture would smooth away.
 */
const REAL_PAYLOAD = {
  subscription_type: 'max',
  rate_limits_available: true,
  session: { total_cost_usd: 0.37, model_usage: { 'claude-opus-5[1m]': { inputTokens: 2 } } },
  rate_limits: {
    five_hour: { utilization: 2, resets_at: '2026-08-01T09:59:59.734298+00:00' },
    seven_day: { utilization: 24, resets_at: '2026-08-02T02:59:59.734320+00:00' },
    seven_day_opus: null,
    seven_day_sonnet: null,
    tangelo: null,
    iguana_necktie: null,
    model_scoped: [
      { display_name: 'Fable', utilization: 11, resets_at: '2026-08-02T02:59:59.734660+00:00' },
    ],
    limits: [
      {
        kind: 'session',
        group: 'session',
        percent: 2,
        severity: 'normal',
        resets_at: '2026-08-01T09:59:59.734298+00:00',
        scope: null,
        is_active: false,
      },
      {
        kind: 'weekly_all',
        group: 'weekly',
        percent: 24,
        severity: 'normal',
        resets_at: '2026-08-02T02:59:59.734320+00:00',
        scope: null,
        is_active: true,
      },
      {
        kind: 'weekly_scoped',
        group: 'weekly',
        percent: 11,
        severity: 'normal',
        resets_at: '2026-08-02T02:59:59.734660+00:00',
        scope: { model: { id: null, display_name: 'Fable' } },
        is_active: false,
      },
    ],
    extra_usage: { is_enabled: false, disabled_reason: 'out_of_credits' },
  },
};

const NOW = 1_800_000_000_000;

describe('normaliseUtilization', () => {
  it('passes through an unambiguous percentage', () => {
    expect(normaliseUtilization(85, 'percent')).toEqual({ usedPercent: 85, anomaly: null });
    expect(normaliseUtilization(0, 'percent')).toEqual({ usedPercent: 0, anomaly: null });
    expect(normaliseUtilization(100, 'percent')).toEqual({ usedPercent: 100, anomaly: null });
  });

  it('scales a fraction to percent without float noise', () => {
    expect(normaliseUtilization(0.85, 'fraction')).toEqual({ usedPercent: 85, anomaly: null });
    expect(normaliseUtilization(0.077, 'fraction')).toEqual({ usedPercent: 7.7, anomaly: null });
  });

  // An earlier version resolved values ≤ 1 upward, on the theory that 0.85
  // might mean 85%. That turned a genuine 1% reading into 100% and would have
  // shut the studio down at one percent of budget — a worse failure than the
  // one it guarded against, and one a single value can never distinguish.
  it('takes a percentage at face value, however small', () => {
    expect(normaliseUtilization(1, 'percent')).toEqual({ usedPercent: 1, anomaly: null });
    expect(normaliseUtilization(0.85, 'percent')).toEqual({ usedPercent: 0.85, anomaly: null });
  });

  it('flags a fraction-scaled source that reports above 1', () => {
    const { usedPercent, anomaly } = normaliseUtilization(42, 'fraction');
    expect(usedPercent).toBe(42);
    expect(anomaly?.kind).toBe('ambiguous_scale');
  });

  it('treats out-of-range and non-finite input as fully consumed', () => {
    expect(normaliseUtilization(150, 'percent')).toEqual({
      usedPercent: 100,
      anomaly: { kind: 'out_of_range', raw: 150 },
    });
    expect(normaliseUtilization(-1, 'percent').usedPercent).toBe(100);
    expect(normaliseUtilization(Number.NaN, 'percent').usedPercent).toBe(100);
  });
});

describe('detectScaleMismatch', () => {
  // A single reading cannot reveal its own scale. A whole snapshot can: a
  // fraction-scaled source puts every window at or below 1 at once.
  it('erkennt einen Schnappschuss, der auf Bruchteile umgestellt hat', () => {
    expect(detectScaleMismatch([0.02, 0.24, 0.11])).toBe(true);
  });

  it('schlägt nicht an, wenn auch nur ein Fenster über 1 liegt', () => {
    expect(detectScaleMismatch([0.02, 24, 0.11])).toBe(false);
  });

  // The observed real snapshot (ADR 0001) must never look like a mismatch.
  it('lässt echte Prozentwerte in Ruhe', () => {
    expect(detectScaleMismatch([2, 24, 11])).toBe(false);
  });

  // One low reading is just a low reading — an idle Monday morning.
  it('braucht mindestens zwei Werte, um überhaupt zu urteilen', () => {
    expect(detectScaleMismatch([0.4])).toBe(false);
    expect(detectScaleMismatch([])).toBe(false);
  });

  it('ignoriert Nullen, die über die Skala nichts aussagen', () => {
    expect(detectScaleMismatch([0, 0, 0.5])).toBe(false);
    expect(detectScaleMismatch([0, 0.3, 0.5])).toBe(true);
  });

  // A quiet system at 1% on every window is far likelier than a fraction
  // source pinned at 100%. Flagging it would halt the studio at one percent —
  // the exact mistake this function replaced.
  it('hält genau 1 für echte Prozent, nicht für einen Bruchteil', () => {
    expect(detectScaleMismatch([1, 1, 1])).toBe(false);
    expect(detectScaleMismatch([0.99, 0.99])).toBe(true);
  });
});

describe('normaliseResetsAt', () => {
  it('accepts epoch seconds, epoch millis and ISO strings', () => {
    expect(normaliseResetsAt(1_800_000_000)).toBe(1_800_000_000_000);
    expect(normaliseResetsAt(1_800_000_000_000)).toBe(1_800_000_000_000);
    expect(normaliseResetsAt('2026-08-01T12:00:00Z')).toBe(Date.parse('2026-08-01T12:00:00Z'));
  });

  it('returns null for anything unusable', () => {
    expect(normaliseResetsAt(null)).toBeNull();
    expect(normaliseResetsAt(undefined)).toBeNull();
    expect(normaliseResetsAt(0)).toBeNull();
    expect(normaliseResetsAt('irgendwann')).toBeNull();
  });
});

describe('reconcile', () => {
  it('keeps the official number when the estimate agrees', () => {
    expect(reconcile(50, 55)).toEqual({ usedPercent: 50, anomaly: null });
  });

  it('takes the higher number and raises an anomaly on large divergence', () => {
    const { usedPercent, anomaly } = reconcile(10, 10 + DIVERGENCE_THRESHOLD_PERCENT);
    expect(usedPercent).toBe(30);
    expect(anomaly).toEqual({ kind: 'divergence', officialPercent: 10, estimatedPercent: 30 });
  });

  /**
   * A149: die Richtung, die es vorher nicht gab.
   *
   * Bis zum 25.8.2026 hatte `reconcile` genau die beiden Fälle darüber — beide
   * mit der **Schätzung** als der höheren Zahl. Die Umstellung von `Math.abs`
   * auf eine einseitige Prüfung färbte deshalb **keinen einzigen** Test rot,
   * und das ist der Grund, warum diese vier hier stehen: eine Verhaltensregel,
   * die keine Zusicherung liest, ist eine Behauptung im Kommentar.
   *
   * Gemessen hat die stille Richtung vom 18. bis 23.8.2026 rund 1.330 Zeilen am
   * Tag erzeugt, alle über denselben erwarteten Sachverhalt: das Konto ist zu
   * 71 % ausgelastet, davon 1,2 % von uns.
   */
  it('schweigt, wenn die offizielle Zahl die höhere ist — das ist kein Fund', () => {
    const { usedPercent, anomaly } = reconcile(71, 1.2);
    expect(anomaly).toBeNull();
    // Der Wächter bekommt trotzdem die offizielle Zahl: es entfällt die
    // Meldung, nicht die Wirkung.
    expect(usedPercent).toBe(71);
  });

  it('schweigt auch genau auf der Schwelle, wenn offiziell oben steht', () => {
    expect(reconcile(DIVERGENCE_THRESHOLD_PERCENT, 0).anomaly).toBeNull();
  });

  it('meldet genau auf der Schwelle, wenn die Schätzung oben steht', () => {
    expect(reconcile(0, DIVERGENCE_THRESHOLD_PERCENT).anomaly).not.toBeNull();
  });

  it('meldet knapp unter der Schwelle nicht', () => {
    expect(reconcile(0, DIVERGENCE_THRESHOLD_PERCENT - 0.01).anomaly).toBeNull();
  });
});

describe('parseUsageSnapshot', () => {
  it('reads the real payload into one sample per tracked window', () => {
    const { samples, unknownKinds, rateLimitsAvailable } = parseUsageSnapshot(REAL_PAYLOAD, {
      observedAt: NOW,
    });
    expect(rateLimitsAvailable).toBe(true);
    expect(unknownKinds).toEqual([]);
    expect(samples).toHaveLength(3);
    expect(samples.map((s) => [s.window, s.modelClass, s.usedPercent])).toEqual([
      ['five_hour', null, 2],
      ['seven_day', null, 24],
      ['seven_day_model', 'Fable', 11],
    ]);
    // ISO timestamps from get_usage, epoch from rate_limit_event — one normaliser.
    expect(samples[0]?.resetsAt).toBe(Date.parse('2026-08-01T09:59:59.734298+00:00'));
    expect(samples.every((s) => s.source === 'official' && s.anomaly === null)).toBe(true);
  });

  // The keyed form carries internal codenames (tangelo, iguana_necktie, …), so
  // switching on key names would silently miss a renamed or added window.
  it('prefers limits[] over the keyed windows', () => {
    const contradictory = {
      ...REAL_PAYLOAD,
      rate_limits: {
        ...REAL_PAYLOAD.rate_limits,
        five_hour: { utilization: 99, resets_at: null },
      },
    };
    const { samples } = parseUsageSnapshot(contradictory, { observedAt: NOW });
    expect(samples.find((s) => s.window === 'five_hour')?.usedPercent).toBe(2);
  });

  it('falls back to the keyed windows when limits[] is absent', () => {
    const { limits, ...withoutArray } = REAL_PAYLOAD.rate_limits;
    const { samples } = parseUsageSnapshot(
      { ...REAL_PAYLOAD, rate_limits: withoutArray },
      { observedAt: NOW },
    );
    expect(samples.map((s) => [s.window, s.usedPercent])).toEqual([
      ['five_hour', 2],
      ['seven_day', 24],
      ['seven_day_model', 11],
    ]);
  });

  // An unrecognised window is information, not noise. Dropping it would mean
  // the guardian cannot see a cap the vendor just introduced.
  it('keeps an unknown kind as a weekly window and reports it', () => {
    const withNewKind = {
      ...REAL_PAYLOAD,
      rate_limits: {
        ...REAL_PAYLOAD.rate_limits,
        limits: [
          ...REAL_PAYLOAD.rate_limits.limits,
          { kind: 'monthly_surprise', percent: 91, resets_at: null, scope: null },
        ],
      },
    };
    const { samples, unknownKinds } = parseUsageSnapshot(withNewKind, { observedAt: NOW });
    expect(unknownKinds).toEqual(['monthly_surprise']);
    const kept = samples.find((s) => s.modelClass === 'unbekannt:monthly_surprise');
    expect(kept?.window).toBe('seven_day');
    expect(kept?.usedPercent).toBe(91);
  });

  it('returns no samples when rate limits are unavailable', () => {
    for (const payload of [
      { rate_limits_available: false, rate_limits: REAL_PAYLOAD.rate_limits },
      { rate_limits_available: true, rate_limits: null },
      {},
    ]) {
      const parsed = parseUsageSnapshot(payload, { observedAt: NOW });
      expect(parsed.samples).toEqual([]);
      expect(parsed.rateLimitsAvailable).toBe(false);
    }
  });

  it('skips a window whose percent is null rather than inventing a zero', () => {
    const { samples } = parseUsageSnapshot(
      {
        rate_limits_available: true,
        rate_limits: { limits: [{ kind: 'session', percent: null, resets_at: null, scope: null }] },
      },
      { observedAt: NOW },
    );
    expect(samples).toEqual([]);
  });
});

describe('overageEnabled', () => {
  // The account-level half of §2's no-money rule: checked, not assumed.
  it('reports the account overage flag', () => {
    expect(overageEnabled(REAL_PAYLOAD)).toBe(false);
  });

  it('returns null when the payload does not say', () => {
    expect(overageEnabled({ rate_limits_available: true, rate_limits: {} })).toBeNull();
    expect(overageEnabled({})).toBeNull();
  });
});

describe('getUsageResponseSchema', () => {
  it('accepts the real payload and keeps unknown fields', () => {
    const parsed = getUsageResponseSchema.safeParse(REAL_PAYLOAD);
    expect(parsed.success).toBe(true);
    // `.loose()` matters: the raw payload is persisted verbatim (ADR 0001), and
    // a field we do not understand today is what a later diagnosis will want.
    if (parsed.success) {
      expect(parsed.data.rate_limits).toHaveProperty('iguana_necktie');
    }
  });

  it('accepts the documented shape including model-scoped windows', () => {
    const parsed = getUsageResponseSchema.safeParse({
      subscription_type: 'max',
      rate_limits_available: true,
      rate_limits: {
        five_hour: { utilization: 12.5, resets_at: 1_800_000_000 },
        seven_day: { utilization: 61, resets_at: 1_800_600_000 },
        model_scoped: [{ display_name: 'Opus', utilization: 80, resets_at: null }],
      },
    });
    expect(parsed.success).toBe(true);
  });

  // The endpoint is experimental and self-declares that its shape may change.
  // Missing data must parse into "unavailable", not throw somewhere upstream.
  it('tolerates absent or null rate limits rather than throwing', () => {
    expect(getUsageResponseSchema.safeParse({ rate_limits_available: false }).success).toBe(true);
    expect(getUsageResponseSchema.safeParse({ rate_limits: null }).success).toBe(true);
    expect(
      getUsageResponseSchema.safeParse({ rate_limits: { five_hour: { utilization: null } } })
        .success,
    ).toBe(true);
  });
});
