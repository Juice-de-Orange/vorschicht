/**
 * Usage metering types and the normalisation that stands between the CLI's
 * rate-limit payload and the budget guardian (§7.1).
 *
 * Why this file is more paranoid than it looks
 * --------------------------------------------
 * The official rate-limit data is *not* in the stream-json result message and
 * *not* in the transcript JSONL — it is only reachable through the experimental
 * `control_request { subtype: "get_usage" }` channel, whose own SDK method is
 * named `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET`. On top of
 * that, `utilization` is documented as 0–100 in one place and multiplied by 100
 * in another. If the guardian ever reads 0.85 as "0.85 percent used", it will
 * never fire, and §7.2 — the single most safety-critical rule in this project —
 * silently stops existing.
 *
 * So: the scale is an explicit, configured decision (settled by the Phase 1
 * spike and recorded in ADR 0001 as percent), every sample is range-asserted,
 * a *snapshot* that looks like it switched scale is distrusted rather than
 * silently rescaled, and the raw payload is persisted verbatim next to the
 * normalised value so a wrong guess stays forensically recoverable.
 */
import { z } from 'zod';
import type { UsageWindowKind } from './constants.js';

/**
 * How the source reports `utilization`.
 * - `percent`  — 0–100 (what the get_usage schema documents)
 * - `fraction` — 0–1   (what the statusline builder implies by multiplying)
 */
export type UtilizationScale = 'percent' | 'fraction';

/** One window as reported by `get_usage`. Fields beyond these are ignored but kept raw. */
export const rateLimitWindowSchema = z.object({
  utilization: z.number().nullable(),
  resets_at: z.union([z.number(), z.string()]).nullable().optional(),
});
export type RateLimitWindow = z.infer<typeof rateLimitWindowSchema>;

/** Per-model-class weekly caps — available *only* via get_usage, per §7.1. */
export const modelScopedWindowSchema = rateLimitWindowSchema.extend({
  display_name: z.string(),
});

/**
 * One entry of the normalised `limits[]` array — the preferred source (ADR 0001).
 *
 * Preferred over the per-window keys because those include internal codenames
 * (`tangelo`, `iguana_necktie`, …) and are demonstrably not a stable enum, while
 * this array names the *kind* and carries the model scope that §7.1's
 * per-model weekly cap needs and that nothing else provides.
 */
export const usageLimitEntrySchema = z.object({
  kind: z.string(),
  group: z.string().optional(),
  percent: z.number().nullable(),
  severity: z.string().nullable().optional(),
  resets_at: z.union([z.number(), z.string()]).nullable().optional(),
  scope: z
    .object({
      model: z.object({ display_name: z.string().nullable().optional() }).nullable().optional(),
    })
    .nullable()
    .optional(),
  is_active: z.boolean().optional(),
});
export type UsageLimitEntry = z.infer<typeof usageLimitEntrySchema>;

/**
 * The `get_usage` control response.
 *
 * Deliberately permissive: the endpoint is self-declared experimental, and
 * `.loose()` keeps unknown fields rather than stripping them, because the raw
 * payload is persisted verbatim (ADR 0001) and a field we do not understand
 * today is exactly what a later diagnosis will want.
 */
export const rateLimitsSchema = z
  .object({
    five_hour: rateLimitWindowSchema.nullable().optional(),
    seven_day: rateLimitWindowSchema.nullable().optional(),
    model_scoped: z.array(modelScopedWindowSchema).nullable().optional(),
    limits: z.array(usageLimitEntrySchema).nullable().optional(),
    extra_usage: z
      .object({
        is_enabled: z.boolean().optional(),
        disabled_reason: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
  })
  .loose();

export const getUsageResponseSchema = z.object({
  subscription_type: z.string().nullable().optional(),
  rate_limits_available: z.boolean().optional(),
  rate_limits: rateLimitsSchema.nullable().optional(),
  session: z
    .object({
      total_cost_usd: z.number().optional(),
      model_usage: z.record(z.string(), z.unknown()).optional(),
    })
    .loose()
    .nullable()
    .optional(),
});
export type GetUsageResponse = z.infer<typeof getUsageResponseSchema>;

/** Maps a `limits[].kind` onto the windows the guardian tracks. */
const LIMIT_KIND_TO_WINDOW: Record<string, UsageWindowKind> = {
  session: 'five_hour',
  weekly_all: 'seven_day',
  weekly_scoped: 'seven_day_model',
};

/** Where a usage number came from — surfaced in the dashboard's confidence indicator. */
export type UsageSource = 'official' | 'estimated';

/** A single normalised observation of one window. */
export interface UsageSample {
  window: UsageWindowKind;
  /** Model class for `seven_day_model`, otherwise null. */
  modelClass: string | null;
  /** Always 0–100, whatever the source reported. */
  usedPercent: number;
  /** Epoch milliseconds, or null when the source did not say. */
  resetsAt: number | null;
  source: UsageSource;
  /** Set when the reading could not be trusted at face value. */
  anomaly: UsageAnomaly | null;
  observedAt: number;
}

export type UsageAnomaly =
  | { kind: 'ambiguous_scale'; raw: number; assumed: number }
  | { kind: 'out_of_range'; raw: number }
  | { kind: 'unavailable' }
  | { kind: 'divergence'; officialPercent: number; estimatedPercent: number };

/**
 * Convert a raw `utilization` into a 0–100 percentage.
 *
 * Returns the value plus, when applicable, the anomaly the caller must record.
 */
export function normaliseUtilization(
  raw: number,
  scale: UtilizationScale,
): { usedPercent: number; anomaly: UsageAnomaly | null } {
  if (!Number.isFinite(raw) || raw < 0) {
    return { usedPercent: 100, anomaly: { kind: 'out_of_range', raw } };
  }

  if (scale === 'fraction') {
    if (raw > 1) {
      // Configured as a fraction but clearly a percentage — trust the data.
      const assumed = round(Math.min(raw, 100));
      return { usedPercent: assumed, anomaly: { kind: 'ambiguous_scale', raw, assumed } };
    }
    return { usedPercent: round(raw * 100), anomaly: null };
  }

  // scale === 'percent'
  if (raw > 100) {
    return { usedPercent: 100, anomaly: { kind: 'out_of_range', raw } };
  }
  // A percentage is taken at face value. An earlier version resolved values
  // ≤ 1 *upward* on the theory that 0.85 might mean 85% — which turned a
  // genuine reading of 1% into 100% and would have shut the studio down at one
  // percent of budget. A single value cannot reveal its own scale; the set of
  // values can, and `detectScaleMismatch` does that job without touching the
  // number.
  return { usedPercent: round(raw), anomaly: null };
}

/**
 * Does a whole snapshot look like it is on the wrong scale?
 *
 * ADR 0001 settled the scale as percent by observation (2, 24, 11). A source
 * that switched to fractions would report every window *below* 1 at once — so
 * the discriminator is the set of readings, never one of them.
 *
 * The bound is strict on purpose. A snapshot reading exactly 1 on every window
 * is far more likely to be a genuinely quiet system at 1% than a fraction
 * source at 100%, and treating it as unreadable would halt the studio at one
 * percent of budget — the very mistake this function was written to replace.
 * The residual risk (a fraction source pinned at exactly 1.0) is covered by the
 * token-accounting cross-check, which would report a large divergence.
 *
 * The caller's response is to distrust the snapshot (fail-closed), not to
 * silently multiply it: guessing wrong in either direction is worse than
 * saying "I cannot read this".
 */
export function detectScaleMismatch(values: readonly number[]): boolean {
  const nonZero = values.filter((value) => Number.isFinite(value) && value > 0);
  return nonZero.length >= 2 && nonZero.every((value) => value < 1);
}

/**
 * Percentages are carried with four decimals.
 *
 * Not cosmetic: without it, `0.85 * 100` and a source that simply reports `85`
 * produce different numbers for the same budget state, which then differ again
 * once stored and compared. Four decimals is far more precision than any
 * threshold decision needs, and it makes samples from different sources
 * directly comparable.
 */
function round(value: number): number {
  return Math.round(value * 1e4) / 1e4;
}

/** Normalise `resets_at` (epoch seconds, epoch millis, or ISO string) to millis. */
export function normaliseResetsAt(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return null;
    // Anything below this is seconds, not milliseconds (≈ year 2001 in ms).
    return value < 1e11 ? Math.round(value * 1000) : Math.round(value);
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Turn a `get_usage` payload into guardian-ready samples (ADR 0001).
 *
 * Reads `limits[]` when present and falls back to the keyed windows otherwise.
 * Unknown `kind` values are **kept, not dropped**: an unrecognised window is
 * information about the vendor changing something, and §7.1's "the tightest
 * governing window wins" is safer when it can see windows we have no name for.
 * Such entries are reported under `unknownKinds` so Controlling can raise it.
 *
 * Returns no samples at all when rate limits are unavailable — the caller then
 * hands the guardian an explicit `unavailable` anomaly rather than silence,
 * because §7.2 must never read "no data" as "fine".
 */
export function parseUsageSnapshot(
  payload: GetUsageResponse,
  options: { scale?: UtilizationScale; observedAt: number },
): {
  samples: UsageSample[];
  unknownKinds: string[];
  rateLimitsAvailable: boolean;
  scaleMismatch: boolean;
} {
  const scale = options.scale ?? 'percent';
  const limits = payload.rate_limits;
  const available = payload.rate_limits_available !== false && limits != null;
  if (!available || !limits) {
    return { samples: [], unknownKinds: [], rateLimitsAvailable: false, scaleMismatch: false };
  }

  const samples: UsageSample[] = [];
  const unknownKinds: string[] = [];

  const push = (
    window: UsageWindowKind,
    modelClass: string | null,
    raw: number | null | undefined,
    resetsAt: number | string | null | undefined,
  ) => {
    if (raw === null || raw === undefined) return;
    const { usedPercent, anomaly } = normaliseUtilization(raw, scale);
    samples.push({
      window,
      modelClass,
      usedPercent,
      resetsAt: normaliseResetsAt(resetsAt),
      source: 'official',
      anomaly,
      observedAt: options.observedAt,
    });
  };

  if (limits.limits && limits.limits.length > 0) {
    for (const entry of limits.limits) {
      const window = LIMIT_KIND_TO_WINDOW[entry.kind];
      if (!window) {
        unknownKinds.push(entry.kind);
        // Treated as a weekly window: the more conservative reading, since a
        // weekly cap is the one that can rest operations for days.
        push('seven_day', `unbekannt:${entry.kind}`, entry.percent, entry.resets_at);
        continue;
      }
      push(window, entry.scope?.model?.display_name ?? null, entry.percent, entry.resets_at);
    }
    return {
      samples,
      unknownKinds,
      rateLimitsAvailable: true,
      scaleMismatch: detectScaleMismatch(samples.map((s) => s.usedPercent)),
    };
  }

  // Fallback: the keyed form, used only when `limits[]` is missing.
  push('five_hour', null, limits.five_hour?.utilization, limits.five_hour?.resets_at);
  push('seven_day', null, limits.seven_day?.utilization, limits.seven_day?.resets_at);
  for (const scoped of limits.model_scoped ?? []) {
    push('seven_day_model', scoped.display_name, scoped.utilization, scoped.resets_at);
  }

  return {
    samples,
    unknownKinds,
    rateLimitsAvailable: true,
    scaleMismatch: detectScaleMismatch(samples.map((s) => s.usedPercent)),
  };
}

/**
 * Is the account able to spend money at all?
 *
 * §2 forbids it outright, but the software can only enforce its own half; this
 * is the account-level half, and it is now checked rather than assumed.
 */
export function overageEnabled(payload: GetUsageResponse): boolean | null {
  const flag = payload.rate_limits?.extra_usage?.is_enabled;
  return typeof flag === 'boolean' ? flag : null;
}

/**
 * Cross-check the official reading against the token-accounting fallback (§7.1).
 * A large divergence is not resolved silently — it becomes an anomaly that
 * Controlling escalates, and the higher of the two is used meanwhile.
 *
 * **A149: die Prüfung ist einseitig, und das ist keine Abschwächung.** Die
 * beiden Zahlen haben verschiedene Nenner, was `Math.abs` stillschweigend
 * bestreitet:
 *
 *   - **offiziell** = Auslastung der Kontodecke des Anbieters, kontoweit,
 *     the operator's eigene Sitzungen eingeschlossen.
 *   - **geschätzt** = Vorschichts *eigene* Ausgaben gegen `PLAN_BUDGETS` —
 *     nach A6/A59.4 „eine Entscheidung, keine Entdeckung".
 *
 * `estimate.ts` schreibt es selbst hin: die Schätzung ist konstruktionsbedingt
 * eine **Untergrenze** der Kontoauslastung (A60.6). Damit ist
 * `offiziell 71 / geschätzt 1,2` keine Divergenz zweier Messungen desselben
 * Dings, sondern der Satz „das Konto ist zu 71 % ausgelastet, davon 1,2 % von
 * uns" — eine **erwartete** Zahl. Gemessen hat diese Richtung vom 18. bis
 * 23.8.2026 rund 1.330 Zeilen am Tag erzeugt, alle über denselben Sachverhalt.
 *
 * Gemeldet wird deshalb nur die Richtung, die **unmöglich** ist: unsere eigenen
 * Ausgaben allein übersteigen die gemeldete Kontoauslastung. Dann stimmt der
 * Nenner nicht oder es wird doppelt gezählt — das ist die Richtung, die A101
 * gebaut hat, und die einzige, die etwas belegt.
 *
 * **Der Wächter ist davon unberührt.** `projectSamples` lässt eine frische
 * offizielle Probe weiterhin gewinnen (A60.7), er handelt also weiter auf 71
 * und nicht auf 1,2. Es entfällt die *Meldung*, nicht die *Wirkung* — und dass
 * das so ist, behauptet ein Test und kein Kommentar (`guardian.test.ts`).
 *
 * Genannter Preis: eine offizielle Messung, die viel zu **hoch** meldet, wird
 * nicht mehr gemeldet. Unter A64/A73 ist das kein Verlust — die offizielle Zahl
 * spricht ohnehin nur oberhalb 75 —, aber es ist eine Verengung von §7.1s
 * Wortlaut und steht deshalb hier statt nur im Anhang.
 */
export const DIVERGENCE_THRESHOLD_PERCENT = 20;

export function reconcile(
  officialPercent: number,
  estimatedPercent: number,
): { usedPercent: number; anomaly: UsageAnomaly | null } {
  const delta = estimatedPercent - officialPercent;
  if (delta >= DIVERGENCE_THRESHOLD_PERCENT) {
    return {
      usedPercent: Math.max(officialPercent, estimatedPercent),
      anomaly: { kind: 'divergence', officialPercent, estimatedPercent },
    };
  }
  return { usedPercent: officialPercent, anomaly: null };
}
