/**
 * The latest build report, for the dashboard (see migration 0007).
 *
 * Read-only, and deliberately tolerant of there being nothing: before the first
 * report arrives the honest answer is "the build has not said anything", which
 * is different from "everything is quiet".
 */
import type postgres from 'postgres';

export interface BuildReport {
  reportedAt: string;
  phase: string;
  step: string | null;
  gates: { green: number; deferred: number; open: number };
  commits: number;
  head: { sha: string | null; subject: string | null };
  loopRunning: boolean;
  questions: string[];
  /** True when the newest report is old enough to be worth doubting. */
  stale: boolean;
}

/** Beyond this the report describes a past the dashboard should not present as now. */
export const BUILD_REPORT_MAX_AGE_MS = 30 * 60_000;

export async function latestBuildReport(
  sql: postgres.Sql,
  now: number = Date.now(),
): Promise<BuildReport | null> {
  const [row] = await sql<
    Array<{
      reported_at: Date;
      phase: string;
      step: string | null;
      gates_green: number;
      gates_deferred: number;
      gates_open: number;
      commits: number;
      head_sha: string | null;
      head_subject: string | null;
      loop_running: boolean;
      questions: string[];
    }>
  >`
    SELECT reported_at, phase, step, gates_green, gates_deferred, gates_open,
           commits, head_sha, head_subject, loop_running, questions
    FROM build_reports ORDER BY id DESC LIMIT 1
  `;

  if (!row) return null;

  return {
    reportedAt: row.reported_at.toISOString(),
    phase: row.phase,
    step: row.step,
    gates: { green: row.gates_green, deferred: row.gates_deferred, open: row.gates_open },
    commits: row.commits,
    head: { sha: row.head_sha, subject: row.head_subject },
    loopRunning: row.loop_running,
    questions: row.questions ?? [],
    stale: now - row.reported_at.getTime() > BUILD_REPORT_MAX_AGE_MS,
  };
}
