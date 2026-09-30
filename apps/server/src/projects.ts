/**
 * The projects endpoint (§17.3) — what the settings page reads and writes.
 *
 * §11's rules live in `validateProjectGateConfig` and its persistence and audit
 * rows in `ProjectService.setGateConfig`. Nothing here re-decides either. What
 * this module adds is the shape the page renders and, more importantly, the
 * translation of a refusal into something a transport can carry: `setGateConfig`
 * signals a rejected document by **throwing** `GateConfigError`, which is right
 * for a service call and wrong for an HTTP route, where "your document is not
 * acceptable, and here is every reason" is an ordinary answer rather than an
 * exception.
 *
 * So `saveProjectGates` returns a result union and `app.ts` maps it to a status
 * code without importing anything from the core. That keeps the one property
 * the route layer must have: it is transport, and the rule it enforces lives in
 * exactly one place (§11, A62).
 *
 * The audit row is written by the service *before* it throws, so it survives
 * this translation — and `projects.itest.ts` asserts that it does, because the
 * refusal being recorded is half of the exit gate rather than a nicety.
 *
 * §12's release history rides along on the same payload. Its shape is a zod
 * schema in `@vorschicht/shared/inbox` and the view below is typed *from* it, so
 * renaming a field breaks the build here rather than a page at runtime — A81's
 * whole point, applied before the mistake this time rather than after it.
 */
import type { DeploymentRecord, ProjectRecord, ProjectService } from '@vorschicht/core';
import { GateConfigError, type ProjectGateConfig, resolveGates } from '@vorschicht/shared';
import { type DeploymentView, RELEASE_HISTORY_LIMIT } from '@vorschicht/shared/inbox';

/**
 * One project, as the settings page needs it.
 *
 * Deliberately not the whole `ProjectRecord`: `gitAccessRef` is a pointer into
 * the secret regime (§19, A20) and has no business on a page, and the raw
 * `gateConfig` column is the lenient read rather than the normalised document.
 * `resolvedGateIds` is sent alongside the configuration because the two can
 * differ legitimately — the locked six are added by `resolveGates` whatever the
 * document says, and a gate that is ticked but not yet available is dropped —
 * and a page that only showed the checkboxes would quietly misreport both.
 */
export interface ProjectSettingsView {
  id: string;
  slug: string;
  name: string;
  rootPath: string;
  defaultBranch: string;
  selfManaged: boolean;
  /** A41: may be analysed, never written to. */
  readOnly: boolean;
  active: boolean;
  gateConfig: ProjectGateConfig;
  /** What actually runs for this project, in catalogue order. */
  resolvedGateIds: string[];
  /** §12's release history, newest first. Empty when nothing has deployed. */
  releases: DeploymentView[];
  /**
   * Whether that list was read at all.
   *
   * `unwired` means this process has no `DeployRecords`, so the empty list says
   * nothing about the project. Without this the page would render "noch nichts
   * ausgerollt" over a table it never queried — which is the dead wiring §8.2's
   * sixth domain hunts, and it would read as covered.
   */
  releaseSource: 'records' | 'unwired';
}

export type SaveGatesResult =
  | { ok: true; project: ProjectSettingsView }
  /** §11 refused the document. Every reason, German, ready to render. */
  | { ok: false; reason: 'invalid'; errors: string[] }
  | { ok: false; reason: 'unknown' };

export interface ProjectsDeps {
  projects: ProjectService;
  /**
   * §12's `deployments`, if this process has them.
   *
   * Optional **and reported as such**: the daemon that owns `DeployRecords` and
   * the process that serves this page are wired separately, and a required
   * dependency here would stop the API booting rather than showing an empty
   * table. What must never happen is that the two states look alike, so a
   * caller without this gets `releases: []` *and* `releaseSource: 'unwired'` —
   * "this project has never deployed" and "this server cannot see deployments"
   * are different sentences and the page says which one it is.
   */
  deployments?: {
    forProject(projectId: string, limit?: number): Promise<DeploymentRecord[]>;
  };
}

/**
 * §12's release rows, as a page can read them.
 *
 * The one piece of work here is `rolledBackTo`: the record holds the *id* of the
 * release that was swapped back in, and an id answers nothing. It is resolved
 * against the same window that is being sent — which is where the sha and the
 * artifact live — rather than by a query per row. A destination older than the
 * window comes back with nulls beside its id, because "we cannot name it from
 * here" is the truth and an id presented as an answer is not.
 */
export function toReleaseHistory(records: readonly DeploymentRecord[]): DeploymentView[] {
  const byId = new Map(records.map((record) => [record.id, record]));
  return records.map((record) => {
    const destination = record.rolledBackTo ? byId.get(record.rolledBackTo) : undefined;
    return {
      id: record.id,
      sha: record.sha,
      method: record.method,
      artifact: record.artifact,
      outcome: record.outcome,
      lastStep: record.lastStep,
      startedAt: record.startedAt.toISOString(),
      finishedAt: record.finishedAt?.toISOString() ?? null,
      durationMs: record.durationMs,
      problem: record.problem,
      rolledBackTo: record.rolledBackTo
        ? {
            deploymentId: record.rolledBackTo,
            sha: destination?.sha ?? null,
            artifact: destination?.artifact ?? null,
          }
        : null,
      taskId: record.taskId,
    };
  });
}

export function toSettingsView(
  projects: ProjectService,
  project: ProjectRecord,
  releases: DeploymentView[] | null = null,
): ProjectSettingsView {
  const gateConfig = projects.gateConfigOf(project);
  return {
    id: project.id,
    slug: project.slug,
    name: project.name,
    rootPath: project.rootPath,
    defaultBranch: project.defaultBranch,
    selfManaged: project.selfManaged,
    readOnly: project.readOnly,
    active: project.active,
    gateConfig,
    resolvedGateIds: resolveGates(gateConfig).map((gate) => gate.id),
    releases: releases ?? [],
    releaseSource: releases ? 'records' : 'unwired',
  };
}

export async function listProjectSettings(deps: ProjectsDeps): Promise<ProjectSettingsView[]> {
  const rows = await deps.projects.listActive();
  const deployments = deps.deployments;
  if (!deployments) return rows.map((row) => toSettingsView(deps.projects, row));
  return Promise.all(
    rows.map(async (row) =>
      toSettingsView(
        deps.projects,
        row,
        toReleaseHistory(await deployments.forProject(row.id, RELEASE_HISTORY_LIMIT)),
      ),
    ),
  );
}

/**
 * Store a submitted gate configuration, or report why it was refused.
 *
 * `actor` is the session, never a default. §19 asks for a trail of every config
 * change, and a trail in which every attempt was made by `system` answers the
 * question "was this changed" while losing the one it exists for.
 */
export async function saveProjectGates(
  deps: ProjectsDeps,
  id: string,
  input: unknown,
  actor: string,
): Promise<SaveGatesResult> {
  const existing = await deps.projects.get(id);
  if (!existing) return { ok: false, reason: 'unknown' };
  try {
    const updated = await deps.projects.setGateConfig(id, input, actor);
    // The same payload as the list route, releases included. A save that
    // answered `releaseSource: 'unwired'` while the list said `records` would be
    // two shapes of one document disagreeing — which is the defect
    // `@vorschicht/shared/inbox` exists because of.
    const releases = deps.deployments
      ? toReleaseHistory(await deps.deployments.forProject(updated.id, RELEASE_HISTORY_LIMIT))
      : null;
    return { ok: true, project: toSettingsView(deps.projects, updated, releases) };
  } catch (error) {
    if (error instanceof GateConfigError) {
      return { ok: false, reason: 'invalid', errors: error.errors };
    }
    throw error;
  }
}
