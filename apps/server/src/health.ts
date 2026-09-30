/**
 * Health reporting for `/healthz`.
 *
 * The endpoint is public — nginx, the compose healthcheck and the host watchdog
 * (§18.1) all poll it, and none of them can hold a session. It therefore
 * reports *liveness facts only*: whether the process is up and whether the
 * database answers. No counts, no queue depths, no project names. Anything that
 * would tell an anonymous caller something about the operator's work belongs behind the
 * passkey, in the dashboard.
 */
import type { HealthReportView } from '@vorschicht/shared/inbox';

export type HealthStatus = 'ok' | 'degraded';

/**
 * The shape is the contract's, not a local interface (A81).
 *
 * It used to be declared here and nowhere else, which was harmless only because
 * **no page had ever read this endpoint** — the one arrangement in which two
 * declarations cannot disagree is the one where the second does not exist. §17.1
 * puts a health tile on the overview now, so the producer is type-checked
 * against the schema the page parses, and renaming `checks.database` breaks
 * `tsc` here rather than a tile at runtime.
 */
export type HealthReport = HealthReportView;

export interface HealthDeps {
  pingDatabase: () => Promise<void>;
  startedAt: number;
  now?: () => number;
}

export async function buildHealthReport(deps: HealthDeps): Promise<HealthReport> {
  const now = deps.now?.() ?? Date.now();
  let database: 'ok' | 'error' = 'ok';
  try {
    await deps.pingDatabase();
  } catch {
    database = 'error';
  }

  return {
    status: database === 'ok' ? 'ok' : 'degraded',
    uptimeSeconds: Math.max(0, Math.round((now - deps.startedAt) / 1000)),
    checks: { database },
  };
}
