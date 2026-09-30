/**
 * Budget guardian state machine (§7.2/§7.3).
 *
 * Pure functions only. The guardian's decision must be reproducible from
 * `usage_samples` alone, with no clock of its own and no I/O — that is what
 * makes the Phase 1 exit gate ("simulated usage streams prove the behaviour as
 * automated tests") possible without spending a single token on a real model
 * call, and what lets the live state be recomputed from scratch after a crash.
 *
 * The latch
 * ---------
 * Once a window has crossed 85%, this module refuses to go back to `normal`
 * until a genuine window reset is observed. Without that, one cached or noisy
 * low reading — and `get_usage` explicitly has a "seeded" state, so cached
 * values are real — would reopen the gate and start new sessions with the
 * budget nearly gone. Recovery is tied to evidence of a reset, not to a
 * friendlier number.
 */
import {
  DEGRADED_WRAP_UP_PERCENT,
  GUARDIAN_THRESHOLDS,
  type UsageWindowKind,
  WINDOW_NOMINAL_MS,
} from './constants.js';
import type { UsageSample } from './usage.js';

/**
 * §7.2's three states, as a value.
 *
 * A `const` array rather than a hand-written union, following `ESCALATION_STATES`
 * and `PRIORITIES`: the wire schema in `./inbox.js` needs to *enumerate* them,
 * and a `z.enum([...])` written out beside a union is a second list that drifts
 * the first time a fourth state is considered.
 */
export const GUARDIAN_STATES = ['normal', 'wrap_up', 'hard_stop'] as const;
export type GuardianState = (typeof GUARDIAN_STATES)[number];

/** Why the guardian is in its current state — shown to the operator, never inferred by the UI. */
export type GuardianReason =
  | { kind: 'below_thresholds' }
  | { kind: 'threshold'; window: UsageWindowKind; usedPercent: number; modelClass: string | null }
  | { kind: 'latched'; window: UsageWindowKind; since: number }
  | { kind: 'degraded_source'; window: UsageWindowKind; usedPercent: number }
  | { kind: 'no_data' }
  | { kind: 'manual_pause'; hard: boolean };

export interface WindowLatch {
  window: UsageWindowKind;
  modelClass: string | null;
  /** State the window latched into. */
  state: Exclude<GuardianState, 'normal'>;
  since: number;
  /** Reset observed at-or-after this epoch clears the latch. */
  resetsAt: number | null;
}

export interface GuardianInput {
  /** Latest sample per window (and per model class for `seven_day_model`). */
  samples: readonly UsageSample[];
  /** Latches carried over from previous evaluations. */
  latches: readonly WindowLatch[];
  /** Manual pause from the Controlling page (A26). */
  manualPause?: { active: boolean; hard: boolean };
  now: number;
}

export interface GuardianDecision {
  state: GuardianState;
  reason: GuardianReason;
  /** Latches after this evaluation — persist these. */
  latches: WindowLatch[];
  /** Windows that are currently at or beyond wrap-up. */
  governingWindow: UsageWindowKind | null;
}

function latchKey(window: UsageWindowKind, modelClass: string | null): string {
  return `${window}::${modelClass ?? ''}`;
}

/** Threshold for a sample, honouring the fail-closed rule for estimated data. */
function wrapUpThresholdFor(sample: UsageSample): number {
  return sample.source === 'official'
    ? GUARDIAN_THRESHOLDS.WRAP_UP_PERCENT
    : DEGRADED_WRAP_UP_PERCENT;
}

const SEVERITY: Record<GuardianState, number> = { normal: 0, wrap_up: 1, hard_stop: 2 };

/**
 * Evaluate every tracked window and return the tightest governing state.
 *
 * A missing or unusable reading is never treated as "fine": with no samples at
 * all the guardian reports `wrap_up`, because an autonomous system that cannot
 * see its budget must not start new work.
 */
export function evaluateGuardian(input: GuardianInput): GuardianDecision {
  const { samples, now } = input;

  if (input.manualPause?.active) {
    return {
      state: input.manualPause.hard ? 'hard_stop' : 'wrap_up',
      reason: { kind: 'manual_pause', hard: input.manualPause.hard },
      latches: [...input.latches],
      governingWindow: null,
    };
  }

  const latches = new Map<string, WindowLatch>(
    input.latches.map((l) => [latchKey(l.window, l.modelClass), l]),
  );

  // Clear latches whose window has demonstrably reset. A latch that never
  // learned its reset time falls back to the window's nominal length —
  // otherwise fail-closed would become fail-forever, with no way out short of
  // editing the database.
  for (const [key, latch] of latches) {
    const expiry = latch.resetsAt ?? latch.since + WINDOW_NOMINAL_MS[latch.window];
    if (now >= expiry) latches.delete(key);
  }

  if (samples.length === 0) {
    return {
      state: 'wrap_up',
      reason: { kind: 'no_data' },
      latches: [...latches.values()],
      governingWindow: null,
    };
  }

  let state: GuardianState = 'normal';
  let reason: GuardianReason = { kind: 'below_thresholds' };
  let governingWindow: UsageWindowKind | null = null;

  const consider = (
    candidate: GuardianState,
    candidateReason: GuardianReason,
    window: UsageWindowKind | null,
  ) => {
    if (SEVERITY[candidate] > SEVERITY[state]) {
      state = candidate;
      reason = candidateReason;
      governingWindow = window;
    }
  };

  for (const sample of samples) {
    const key = latchKey(sample.window, sample.modelClass);

    if (sample.anomaly?.kind === 'unavailable') {
      consider('wrap_up', { kind: 'no_data' }, sample.window);
      continue;
    }

    const wrapUpAt = wrapUpThresholdFor(sample);

    if (sample.usedPercent >= GUARDIAN_THRESHOLDS.HARD_STOP_PERCENT) {
      latches.set(key, {
        window: sample.window,
        modelClass: sample.modelClass,
        state: 'hard_stop',
        since: latches.get(key)?.since ?? now,
        resetsAt: sample.resetsAt,
      });
      consider(
        'hard_stop',
        {
          kind: 'threshold',
          window: sample.window,
          usedPercent: sample.usedPercent,
          modelClass: sample.modelClass,
        },
        sample.window,
      );
      continue;
    }

    if (sample.usedPercent >= wrapUpAt) {
      const existing = latches.get(key);
      latches.set(key, {
        window: sample.window,
        modelClass: sample.modelClass,
        state: existing?.state === 'hard_stop' ? 'hard_stop' : 'wrap_up',
        since: existing?.since ?? now,
        resetsAt: sample.resetsAt,
      });
      const degraded = sample.source !== 'official';
      consider(
        existing?.state === 'hard_stop' ? 'hard_stop' : 'wrap_up',
        degraded
          ? { kind: 'degraded_source', window: sample.window, usedPercent: sample.usedPercent }
          : {
              kind: 'threshold',
              window: sample.window,
              usedPercent: sample.usedPercent,
              modelClass: sample.modelClass,
            },
        sample.window,
      );
      continue;
    }

    // Below threshold — but a latch only clears on an observed reset, never on
    // a friendlier reading. Keep the reset time fresh so recovery still works.
    const latch = latches.get(key);
    if (latch) latches.set(key, { ...latch, resetsAt: sample.resetsAt ?? latch.resetsAt });
  }

  // Latches are evaluated after the samples, over *all* of them — including
  // windows that produced no sample this round. A window that simply stops
  // reporting must not quietly reopen the gate; only an observed reset does
  // that, and that is handled above.
  for (const latch of latches.values()) {
    consider(
      latch.state,
      { kind: 'latched', window: latch.window, since: latch.since },
      latch.window,
    );
  }

  return { state, reason, latches: [...latches.values()], governingWindow };
}

/** Human-readable German status line for the dashboard (§2 language policy). */
export function describeGuardian(decision: GuardianDecision): string {
  switch (decision.reason.kind) {
    case 'below_thresholds':
      return 'Normalbetrieb';
    case 'threshold': {
      const { window, usedPercent } = decision.reason;
      const pct = usedPercent.toFixed(1).replace('.', ',');
      return decision.state === 'hard_stop'
        ? `Budget erschöpft — ${windowLabel(window)} bei ${pct} %`
        : `Aufräummodus — ${windowLabel(window)} bei ${pct} %`;
    }
    case 'latched':
      return `Aufräummodus hält an — ${windowLabel(decision.reason.window)} wartet auf Reset`;
    case 'degraded_source':
      return `Aufräummodus (geschätzte Daten) — ${windowLabel(decision.reason.window)}`;
    case 'no_data':
      return 'Keine Budgetdaten — vorsichtshalber keine neuen Aufgaben';
    case 'manual_pause':
      return decision.reason.hard ? 'Harte Pause (manuell)' : 'Pause (manuell)';
  }
}

function windowLabel(window: UsageWindowKind): string {
  switch (window) {
    case 'five_hour':
      return '5-Stunden-Fenster';
    case 'seven_day':
      return 'Wochenfenster';
    case 'seven_day_model':
      return 'Wochenfenster (Modellklasse)';
  }
}
