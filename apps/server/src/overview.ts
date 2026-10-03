/**
 * The overview endpoint (§17.1).
 *
 * §17 sets the design target plainly: opening the dashboard must answer "is
 * everything fine" with zero clicks. So this returns the few facts that answer
 * it — budget per window, guardian state *with its reason*, active runs — and
 * nothing else. A page that needs a second request to say whether it is worried
 * has already failed that target.
 *
 * Read-only and derived: the guardian's state is recomputed elsewhere and
 * merely read here. Nothing on this path can change what the system does.
 */
import {
  type BlockedTaskView,
  type DeploymentView,
  DISPATCHABLE_TASK_STATES,
  describeGuardian,
  GUARDIAN_THRESHOLDS,
  type GuardianDecision,
  type GuardianReason,
  type GuardianState,
  type MergeCandidateView,
  type MergeQueueView,
  OVERVIEW_DEPLOY_LIMIT,
  OVERVIEW_MERGE_QUEUE_LIMIT,
  type OverviewDeployView,
  type OverviewPayload,
  type Priority,
  type StalledTaskView,
  type UsageSample,
  type WindowLatch,
} from '@vorschicht/shared';
import type postgres from 'postgres';
import { authVorfall, healthTiles, readAuthVorfall } from './betrieb.js';

/**
 * The payload's shape is `@vorschicht/shared/inbox`'s, and the dashboard parses
 * the same document rather than declaring its own idea of it (see that module).
 */
export type Overview = OverviewPayload;

/**
 * The open inbox items, as far as the counters and the blocked list need them.
 *
 * Structurally typed rather than as `EscalationRecord[]` so this module keeps
 * its narrow import graph — and `EscalationService.open()` satisfies it as it
 * stands. The whole records are read rather than a `count(*)`, because the
 * blocked list is a *per-task* projection and no counting query answers it; the
 * list is the open inbox, which is a handful of rows by construction (§15
 * escalates decisions, not events).
 */
export interface OpenDecision {
  taskId: string | null;
  /** §15's "#X" — what the sentence says out loud and what the link addresses. */
  number: number;
}

/**
 * Eine nach §10 hinter fremden Claims wartende Aufgabe, so weit die Übersicht
 * sie braucht. Strukturell getypt wie `OpenDecision`, damit dieses Modul seinen
 * schmalen Importgraphen behält — `ClaimRegistry.blockedTasks()` erfüllt es.
 */
export interface ClaimBlocked {
  taskId: string;
  title: string;
  blockedByTaskId: string;
  blockedByTitle: string;
}

/**
 * One row per blocked task, newest question first.
 *
 * This is the de-duplication that used to live in the *page's counter* while the
 * page's list rendered every raw row — so one task with two open questions said
 * "1 Aufgabe wartet" above two `<li>`s sharing a React key and a `data-testid`.
 * Doing it once, here, lets the page count the array it renders: agreement
 * between two derivations can rot, identity cannot.
 *
 * A decision with no task is dropped rather than rendered under a made-up title:
 * it is a real open item (§17.5's badge counts it) that simply has no task
 * waiting behind it, which is the distinction `PendingDecisions` exists to keep.
 * A task whose title is unknown keeps its row and says so, because a *blocked*
 * task that vanished from the overview because a join missed is the failure this
 * list exists to prevent.
 */
export function blockedTasksFrom(
  decisions: readonly OpenDecision[],
  titles: ReadonlyMap<string, string>,
  claimBlocked: readonly ClaimBlocked[] = [],
): BlockedTaskView[] {
  const newest = new Map<string, number>();
  for (const decision of decisions) {
    if (decision.taskId === null) continue;
    const seen = newest.get(decision.taskId);
    if (seen === undefined || decision.number > seen) newest.set(decision.taskId, decision.number);
  }

  const rows: BlockedTaskView[] = [...newest.entries()].map(([taskId, number]) => ({
    taskId,
    title: titles.get(taskId) ?? 'Aufgabe ohne Titel',
    number,
    art: 'fragend' as const,
    haltendeAufgabe: null,
  }));

  // Die zweite Art (§9, §15): hinter fremden Claims serialisiert. Die Nummer
  // ist die des Halters, nicht der eigenen — diese Aufgabe hat nie gefragt.
  // Ein Halter ohne offene Entscheidung erzeugt keine Zeile: dann ist die
  // Aufgabe zwar blockiert, aber nicht *durch eine Entscheidung*, und §9s Satz
  // handelt genau davon.
  const seenTask = new Set(rows.map((row) => row.taskId));
  for (const blocked of claimBlocked) {
    if (seenTask.has(blocked.taskId)) continue;
    const number = newest.get(blocked.blockedByTaskId);
    if (number === undefined) continue;
    seenTask.add(blocked.taskId);
    rows.push({
      taskId: blocked.taskId,
      title: blocked.title,
      number,
      art: 'blockiert',
      haltendeAufgabe: blocked.blockedByTitle,
    });
  }

  return rows.sort((a, b) => b.number - a.number);
}

export interface OverviewDeps {
  sql: postgres.Sql;
  currentSamples: () => Promise<UsageSample[]>;
  openDecisions: () => Promise<OpenDecision[]>;
  /**
   * §10s hinter fremden Claims wartende Aufgaben (§9, §15).
   *
   * Optional mit **leerer** Vorgabe, und das ist die sichere Richtung nur zur
   * Hälfte: ein Server ohne diese Verdrahtung zeigt die erste Art weiter an und
   * verschweigt die zweite — also genau der Zustand, den die Betriebsprüfung
   * 767db82c gefunden hat. Deshalb sagt die Startseite es auch, statt eine
   * kürzere Liste als vollständige auszugeben.
   */
  claimBlocked?: () => Promise<ClaimBlocked[]>;
  /**
   * Injiziert, damit die Gesundheitskacheln prüfbar sind.
   *
   * Ihre Aussage *ist* zur Hälfte eine über Zeit — „die letzte Sicherung ist
   * zwei Tage alt" —, und eine Uhr, die ein Test nicht anhalten kann, macht
   * genau diese Hälfte unbeobachtbar. `UsageMeter`, `GuardianService` und
   * `EscalationMailService` halten es ebenso.
   */
  now?: () => number;
}

export async function buildOverview(deps: OverviewDeps): Promise<Overview> {
  const [guardianRow] = await deps.sql<
    Array<{
      state: GuardianState;
      reason: GuardianReason;
      governing_window: string | null;
      latches: WindowLatch[];
      occurred_at: Date;
    }>
  >`
    SELECT state, reason, governing_window, latches, occurred_at
    FROM guardian_events ORDER BY id DESC LIMIT 1
  `;

  const samples = await deps.currentSamples();

  const decision: GuardianDecision = {
    state: guardianRow?.state ?? 'wrap_up',
    // No recorded state yet means nothing has evaluated the budget — which is
    // exactly the "cannot see it" case, not a calm one.
    reason: guardianRow?.reason ?? { kind: 'no_data' },
    latches: guardianRow?.latches ?? [],
    governingWindow: (guardianRow?.governing_window as GuardianDecision['governingWindow']) ?? null,
  };

  const activeRuns = await deps.sql<
    Array<{ run_id: string; role: string | null; model: string | null; started_at: Date | null }>
  >`
    SELECT run_id, role, model, started_at FROM agent_runs
    WHERE NOT is_finished ORDER BY created_at DESC LIMIT 20
  `;

  const openDecisions = await deps.openDecisions();
  // Die zweite Art kostet zwei Abfragen je Projekt und wird deshalb nur geholt,
  // wenn überhaupt eine Entscheidung offen ist — ohne eine kann keine Aufgabe
  // „blockiert durch Entscheidung #X" sein, und die Startseite lädt bei jedem
  // Aufruf.
  const claimBlocked = openDecisions.length > 0 ? await (deps.claimBlocked?.() ?? []) : [];
  const blockedTasks = blockedTasksFrom(
    openDecisions,
    await taskTitles(deps.sql, openDecisions),
    claimBlocked,
  );

  // §10, §12 und §18 — die drei Dinge, ohne die §17.1s „null Klicks, um zu
  // wissen, ob alles in Ordnung ist" nicht zutrifft. Nebenläufig, weil keine
  // von ihnen die andere braucht und diese Seite bei jedem Aufruf lädt.
  const jetzt = deps.now?.() ?? Date.now();
  const [mergeQueue, deploys, health, vorfall] = await Promise.all([
    readMergeQueue(deps.sql),
    readRecentDeploys(deps.sql),
    healthTiles(deps.sql, jetzt),
    // §6.1: während eines Auth-Vorfalls sagt der Wächter nur „Keine Budgetdaten"
    // — das ist die Folge, und diese Zeile ist die Ursache (`authVorfall`).
    readAuthVorfall(deps.sql),
  ]);

  const weekly = samples.find((sample) => sample.window === 'seven_day');
  const weeklyExhausted =
    weekly && weekly.usedPercent >= GUARDIAN_THRESHOLDS.HARD_STOP_PERCENT && weekly.resetsAt
      ? new Date(weekly.resetsAt).toISOString()
      : null;

  return {
    guardian: {
      state: decision.state,
      text: describeGuardian(decision),
      governingWindow: decision.governingWindow,
      since: guardianRow?.occurred_at?.toISOString() ?? null,
    },
    windows: samples.map((sample) => ({
      window: sample.window,
      modelClass: sample.modelClass,
      usedPercent: sample.usedPercent,
      resetsAt: sample.resetsAt,
      source: sample.source,
      anomaly: sample.anomaly?.kind ?? null,
    })),
    thresholds: {
      wrapUpPercent: GUARDIAN_THRESHOLDS.WRAP_UP_PERCENT,
      hardStopPercent: GUARDIAN_THRESHOLDS.HARD_STOP_PERCENT,
    },
    activeRuns: activeRuns.map((run) => ({
      runId: run.run_id,
      role: run.role,
      model: run.model,
      startedAt: run.started_at?.toISOString() ?? null,
    })),
    weeklyExhaustedUntil: weeklyExhausted,
    mergeQueue,
    deploys,
    health,
    authIncident: authVorfall(vorfall, jetzt),
    // Asked unconditionally, unlike `claimBlocked` above: that one is skipped
    // when no decision is open because it cannot then produce a row, and this
    // one has no such precondition — a read-only project with tasks on it is
    // exactly the situation in which nothing else on this page says anything.
    stalledTasks: await stalledTasks(deps.sql),
    decisions: {
      open: openDecisions.length,
      // Not a second count of the same thing: the number *is* the list's length,
      // so the page's counter and the page's rows cannot disagree (§17.1).
      tasksWaiting: blockedTasks.length,
      blockedTasks,
    },
  };
}

/**
 * Tasks the tick would dispatch if their project were not read-only (A44.3).
 *
 * `DISPATCHABLE_TASK_STATES` is the scheduler's own list, imported rather than
 * re-typed, and that is the load-bearing part: the question is *"which tasks is
 * the tick skipping"*, so any second spelling of it would be a page that agrees
 * with the scheduler today and drifts silently later — with the drift showing up
 * as a task that vanishes from the overview while the tick keeps passing over
 * it, which is precisely the failure this list was added to end.
 *
 * Deliberately **not** restricted to the self-managed project. A85 is the reason
 * the flag exists today, but A41 set it for a foreign repository first, and a
 * list that quietly answered only for one project would be right for a while
 * and then wrong without saying so.
 *
 * `active` is required as well as `read_only`: a deactivated project's tasks are
 * not being skipped by the read-only rule, they are not being looked at at all,
 * and putting them under this sentence would name the wrong cause.
 */
/**
 * Eine Zeile der `merge_queue`-Sicht (Migration 0012), roh.
 *
 * Sie ist bereits in §10s Reihenfolge sortiert — `ORDER BY priority, entered_at`
 * steht in der Sicht selbst —, also wird hier nicht ein zweites Mal sortiert.
 * Eine zweite Sortierregel wäre eine zweite Antwort auf „was wird als Nächstes
 * gemerged", und die, die niemand ausführt, ist die auf dieser Seite.
 */
export interface MergeQueueZeile {
  taskId: string;
  title: string;
  projectId: string;
  projectSlug: string | null;
  priority: Priority;
  branch: string | null;
  enteredAt: Date | null;
}

/**
 * §10s Position: 1-basiert **innerhalb des eigenen Projekts**.
 *
 * Rein, weil genau das die Zusicherung ist, die eine gemischte Liste bricht:
 * §10 serialisiert je Projekt, die Übersicht zeigt alle Projekte, und ein
 * Durchzählen der gerenderten Zeilen schriebe „3." an eine Aufgabe, die in ihrem
 * Projekt als Erste an der Reihe ist. Die Eingabe ist schon sortiert, also
 * genügt ein Zähler je Projekt.
 */
export function mergeCandidatesFrom(
  zeilen: readonly MergeQueueZeile[],
  limit: number,
): MergeCandidateView[] {
  const gezaehlt = new Map<string, number>();
  const alle: MergeCandidateView[] = zeilen.map((zeile) => {
    const position = (gezaehlt.get(zeile.projectId) ?? 0) + 1;
    gezaehlt.set(zeile.projectId, position);
    return {
      taskId: zeile.taskId,
      title: zeile.title,
      projectId: zeile.projectId,
      projectSlug: zeile.projectSlug,
      priority: zeile.priority,
      branch: zeile.branch,
      enteredAt: zeile.enteredAt?.toISOString() ?? null,
      position,
    };
  });
  // Erst zählen, dann deckeln: die Position der neunten Zeile ist eine Aussage
  // über die Warteschlange, nicht über die Seitengrösse.
  return alle.slice(0, limit);
}

/**
 * §10s Warteschlange über alle Projekte, samt Gesamtzahl.
 *
 * Ungedeckelt gelesen und danach gedeckelt, weil `total` sonst eine zweite
 * Abfrage wäre, die einen Sekundenbruchteil später einen anderen Stand sieht —
 * und eine Liste, deren Zahl nicht zu ihr passt, ist genau der Riss, den A81.4
 * an der Übersicht schon einmal geschlossen hat. Die Sicht ist per Konstruktion
 * kurz: sie enthält nur Aufgaben im Zustand `merge_queue`, und §10 merged sie
 * nacheinander weg.
 */
async function readMergeQueue(sql: postgres.Sql): Promise<MergeQueueView> {
  const rows = await sql<
    Array<{
      task_id: string;
      title: string;
      project_id: string;
      slug: string | null;
      priority: Priority;
      branch: string | null;
      entered_at: Date | null;
    }>
  >`
    SELECT q.task_id, q.title, q.project_id, p.slug, q.priority, q.branch, q.entered_at
    FROM merge_queue q LEFT JOIN projects p ON p.id = q.project_id
  `;
  const zeilen: MergeQueueZeile[] = rows.map((row) => ({
    taskId: row.task_id,
    title: row.title,
    projectId: row.project_id,
    projectSlug: row.slug,
    priority: row.priority,
    branch: row.branch,
    enteredAt: row.entered_at,
  }));
  return {
    candidates: mergeCandidatesFrom(zeilen, OVERVIEW_MERGE_QUEUE_LIMIT),
    total: zeilen.length,
  };
}

/**
 * §12s jüngste Rollouts über alle Projekte, neueste zuerst.
 *
 * `rolled_back_to` wird per `LEFT JOIN` gegen die **ganze** Sicht aufgelöst und
 * nicht gegen das gesendete Fenster, wie die Projektseite es tut (A95.4). Der
 * Unterschied ist hier keine Vorliebe: dieses Fenster ist fünf Zeilen gross, und
 * ein Rollback zeigt fast immer auf ein älteres Release, das nicht darin steht —
 * die Auflösung im Fenster käme also praktisch immer leer zurück. Das ist eine
 * Verbindung im selben Zugriff, keine zweite Abfrage je Zeile, und das Schema
 * ändert sich nicht: die Nullwerte bedeuten weiterhin „von hier aus nicht
 * benennbar", nur trifft das jetzt genau dann zu, wenn es wirklich zutrifft.
 */
async function readRecentDeploys(sql: postgres.Sql): Promise<OverviewDeployView[]> {
  const rows = await sql<
    Array<{
      id: string;
      project_id: string;
      slug: string | null;
      task_id: string | null;
      sha: string;
      method: DeploymentView['method'];
      artifact: string | null;
      outcome: DeploymentView['outcome'];
      last_step: string | null;
      started_at: Date;
      finished_at: Date | null;
      duration_ms: string | number | null;
      problem: string | null;
      rolled_back_to: string | null;
      ziel_sha: string | null;
      ziel_artifact: string | null;
    }>
  >`
    SELECT d.id, d.project_id, p.slug, d.task_id, d.sha, d.method, d.artifact, d.outcome,
           d.last_step, d.started_at, d.finished_at, d.duration_ms, d.problem,
           d.rolled_back_to, z.sha AS ziel_sha, z.artifact AS ziel_artifact
    FROM deployments d
    LEFT JOIN projects   p ON p.id = d.project_id
    LEFT JOIN deployments z ON z.id = d.rolled_back_to
    ORDER BY d.started_at DESC
    LIMIT ${OVERVIEW_DEPLOY_LIMIT}
  `;
  return rows.map((row) => ({
    projectId: row.project_id,
    projectSlug: row.slug,
    deployment: {
      id: row.id,
      sha: row.sha,
      method: row.method,
      artifact: row.artifact,
      outcome: row.outcome,
      lastStep: row.last_step,
      startedAt: row.started_at.toISOString(),
      finishedAt: row.finished_at?.toISOString() ?? null,
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      problem: row.problem,
      rolledBackTo: row.rolled_back_to
        ? {
            deploymentId: row.rolled_back_to,
            sha: row.ziel_sha,
            artifact: row.ziel_artifact,
          }
        : null,
      taskId: row.task_id,
    },
  }));
}

async function stalledTasks(sql: postgres.Sql): Promise<StalledTaskView[]> {
  const rows = await sql<Array<{ id: string; title: string; slug: string }>>`
    SELECT t.id, t.title, p.slug
    FROM tasks t JOIN projects p ON p.id = t.project_id
    WHERE p.read_only AND p.active
      AND t.state = ANY(${[...DISPATCHABLE_TASK_STATES] as string[]})
    ORDER BY t.priority, t.created_at
    LIMIT 50
  `;
  return rows.map((row) => ({
    taskId: row.id,
    title: row.title,
    projectSlug: row.slug,
    reason: 'read_only' as const,
  }));
}

/**
 * The titles of the tasks that are waiting, in one query.
 *
 * Skipped entirely when nothing is blocked — the ordinary state of a healthy
 * studio, and `= ANY('{}')` is a round trip to learn nothing.
 */
async function taskTitles(
  sql: postgres.Sql,
  decisions: readonly OpenDecision[],
): Promise<Map<string, string>> {
  const ids = [
    ...new Set(decisions.map((d) => d.taskId).filter((id): id is string => id !== null)),
  ];
  if (ids.length === 0) return new Map();
  const rows = await sql<Array<{ id: string; title: string }>>`
    SELECT id, title FROM tasks WHERE id = ANY(${ids})
  `;
  return new Map(rows.map((row) => [row.id, row.title]));
}
