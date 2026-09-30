/**
 * §22 Phase 8 Schritt 1 — die Kennzahlen, aus denen §16s Wochenbericht seine
 * Abschnitte 1 und 3 baut.
 *
 * Bewusst **nicht** aus `packages/core/src/index.ts` re-exportiert: die
 * Verdrahtung gehört zu dem, der den Bericht anschliesst, und ein Export ohne
 * Aufrufer wäre A71s Form. Wer den Dienst braucht, importiert ihn von hier.
 */

export type { BudgetGroupRow, BudgetUtilisation, BudgetWindowUtilisation } from './budget.js';
export {
  aggregateBudget,
  BLIND_ANOMALY_KIND,
  WEEKLY_WINDOW_KIND,
  weeklyUtilisation,
} from './budget.js';
export type {
  GateFindingCount,
  GatePassRate,
  GateRunOutcome,
  GateRunRecord,
  GateRunRow,
  GateStepSummary,
  TimeToGreen,
  TimeToGreenSample,
} from './gate-runs.js';
export {
  classifyGateRun,
  findingsByGate,
  gatePassRate,
  parseGateRun,
  timeToGreen,
} from './gate-runs.js';
export type {
  EscalationCounts,
  HeadlineMetrics,
  QualityTrend,
  RedRate,
  StudioMetrics,
  Throughput,
} from './metrics.js';
export { redRate } from './metrics.js';
export type { Quantity, UnknownReason } from './quantity.js';
export { known, ratio, UNKNOWN_REASON_LABELS, UNKNOWN_REASONS, unknown } from './quantity.js';
export type { MetricsServiceDeps } from './service.js';
export { MetricsService } from './service.js';
export { median, percentile } from './statistics.js';
export type { MetricsWindow } from './window.js';
export { assertWindow, inWindow, windowLabel } from './window.js';
