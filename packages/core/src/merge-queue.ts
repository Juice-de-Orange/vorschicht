/**
 * The merge queue (§10) — the only route from a reviewed diff to `main`.
 *
 * §10 gives it in one paragraph: "Per project strictly serialized, FIFO by
 * priority. For each candidate: rebase onto latest `main` → run the **full gate
 * suite on the rebased tree** → all green → fast-forward merge to `main` →
 * release claims → hand to deploy engine. Any red → candidate leaves the queue
 * back to the task (red path)." Six decisions in building it are worth stating,
 * because each of them was available in a weaker form:
 *
 *  1. **The gates run on the rebased tree, never on the reviewed one.** This is
 *     the entire reason the queue exists rather than a merge on approval. The
 *     tree that becomes `main` is the tree that was tested; a candidate that was
 *     green three merges ago has been tested against a repository that no longer
 *     exists.
 *
 *  2. **Serialisation is a session-level advisory lock, not a transaction.** A
 *     candidate takes as long as its test suite, which is minutes. Holding a
 *     Postgres transaction open for that would pin a connection in
 *     idle-in-transaction and block autovacuum on every table the queue touches.
 *     So the lock lives on a reserved connection and is released in a `finally`,
 *     and a second worker that cannot take it reports `busy` rather than
 *     waiting — the queue is walked on a tick, and a waiter would just be a tick
 *     that costs a connection.
 *
 *  3. **The integration branch is per project, and never assumed.** §10 says
 *     "latest `main`", but A41's project develops on `dev` and A44.2 already
 *     made this configuration. Both the rebase target and the fast-forward
 *     target come from `projects.default_branch`.
 *
 *  4. **A failed candidate leaves the queue, and only §9 decides what that
 *     means.** There is no second copy of the red policy here: `RedPath.fail()`
 *     already requeues the first failure with the learnings and escalates the
 *     second with a diagnosis. The queue's job is to say *what* went wrong, in
 *     German, with the gate output attached.
 *
 *  5. **An infra failure does not fail the candidate.** A25 again: docker down
 *     during the secrets scan means the tree is unchecked, not wrong. The task
 *     goes back to `merge_queue` — where it was — and the next tick tries again.
 *     A candidate that went red because a registry was unreachable would be a
 *     red task nobody can explain, which is the failure §11's classification
 *     exists to prevent. What A25 adds beyond the retry is that *not* coming
 *     back has to be noticed: the queue counts consecutive infra requeues from
 *     the task's own log and raises one Ops alert when the count crosses
 *     `OPS_ALERT_AFTER_INFRA_ATTEMPTS`. Silently retrying forever is the same
 *     failure one level up — a studio that has stopped working and looks busy.
 *
 *  6. **A project this system cannot deploy is refused before it is merged**,
 *     not after. §12 makes deployment automatic after a green merge; merging
 *     code that then cannot be rolled out leaves production silently behind
 *     `main`. The question is now answered by the *registry* rather than by the
 *     calendar: a method with a registered target merges and hands over, a
 *     method without one throws a `MergeQueueError`, which per A54.6 is a defect
 *     in the scheduler and not a task that failed. The default is the empty set,
 *     so a studio that forgets to wire its targets refuses rather than merges —
 *     the same direction Phase 5's absence used to enforce by hard-coding it.
 *
 *  7. **The handover is a state, not a call.** A green merge for a deployable
 *     project ends at `deploying` and the scheduler picks it up (§9's pipeline,
 *     A57's tick). Calling the deploy engine from inside `merge()` would run a
 *     rollout — migrations, a swap, a health poll that may take its full
 *     timeout — while this project's advisory lock is held (decision 2 above)
 *     and a Postgres connection is reserved for it. Every other candidate in the
 *     project would wait out a health check that says nothing about them.
 */
import {
  type DeployMethod,
  isTerminalTaskState,
  type Priority,
  TASK_STATE_LABELS,
} from '@vorschicht/shared';
import type postgres from 'postgres';
import type { ClaimRegistry } from './claim-registry.js';
import type { EscalationService } from './escalation-service.js';
import type { EventLog } from './event-log.js';
import { type FindingRecord, type FindingsService, findingsNote } from './findings.js';
import { type GateSuite, type GateSuiteResult, gateFailureSummary } from './gate-suite.js';
import { BOT_IDENTITY, commitsBetween, fastForwardMerge, headSha, rebaseOnto } from './git.js';
import type { ProjectRecord, ProjectService } from './project-service.js';
import { RedPath, type RedPathResult } from './red-path.js';
import type { TaskRecord, TaskService } from './task-service.js';
import type { WorktreeManager } from './worktree.js';

/**
 * Namespace of the per-project merge lock.
 *
 * Its own constant, deliberately unequal to `CLAIM_LOCK_NAMESPACE`: both are
 * advisory, both are keyed by the project, and nothing but these two numbers
 * keeps a claim acquisition from blocking a merge of an unrelated task.
 */
export const MERGE_LOCK_NAMESPACE = 8_420_004;

/**
 * How many consecutive infra-blocked merge attempts make a failure "persistent".
 *
 * A25 has two halves and only the first is a loop: infra failures retry with
 * backoff *inside* the gate suite, and what is left over — a candidate whose
 * gates could not run across this many whole merge attempts — is the second
 * half, "persistent infra failure → Ops alert, task stays queued".
 *
 * The number is deliberately the same as `GateSuite`'s per-step attempt count,
 * so the alert means something specific: nine executions of the gate in
 * question, spread over three ticks, none of which reached a verdict.
 */
export const OPS_ALERT_AFTER_INFRA_ATTEMPTS = 3;

/** What A25's Ops alert carries. German text is the caller's (§2, §16). */
export interface OpsAlert {
  projectId: string;
  taskId: string;
  /** Consecutive infra-blocked merge attempts, including the one just made. */
  attempts: number;
  /** What went wrong the last time, verbatim from the gate suite. */
  problem: string;
}

export type MergeStatus =
  /** Fast-forwarded onto the integration branch; claims and worktree released. */
  | 'merged'
  /** §11 findings on the rebased tree. The task took §9's red path. */
  | 'red'
  /** §9 second failure: escalated with the Debugger's diagnosis. */
  | 'escalated'
  /** A25: nothing was proven. The task waits in the queue and is retried. */
  | 'infra'
  /** Another worker holds this project's merge lock. Nothing was attempted. */
  | 'busy'
  /** The queue was empty. */
  | 'idle';

export interface MergeAttempt {
  projectId: string;
  taskId: string | null;
  status: MergeStatus;
  /** German, for the timeline. Null when the merge succeeded. */
  problem: string | null;
  /** Where the integration branch stood before and after. */
  baseShaBefore: string | null;
  baseShaAfter: string | null;
  /** Commits the merge brought onto the integration branch, oldest first. */
  commits: Array<{ sha: string; authorName: string; authorEmail: string; subject: string }>;
  gates: GateSuiteResult | null;
  /** The §5 `gate_runs` row this attempt wrote. Null when no suite ran. */
  gateRunId: string | null;
  /** §5's `findings`, as recorded — empty on a green run and on a rebase conflict. */
  findings: FindingRecord[];
  red: RedPathResult | null;
  /** Globs handed back on a green merge (§10). */
  releasedClaims: string[];
  worktreeRemoved: boolean;
  /**
   * Whether a green merge ended the pipeline or handed it to §12.
   *
   * `status: 'merged'` cannot carry this and it is the difference a reader
   * cares about: one of the two means production is about to change. Null when
   * nothing merged, so "not handed over" and "no merge happened" stay distinct.
   */
  deployMethod: DeployMethod | null;
}

/** One row of the `merge_queue` view — §5's entity, projected from the log. */
export interface MergeCandidate {
  taskId: string;
  projectId: string;
  title: string;
  priority: Priority;
  enteredAt: Date;
  branch: string | null;
  worktreePath: string | null;
}

export class MergeQueueError extends Error {
  constructor(
    readonly projectId: string,
    message: string,
  ) {
    super(message);
    this.name = 'MergeQueueError';
  }
}

export interface MergeQueueDeps {
  /** The pool: the merge lock needs a connection of its own (`reserve`). */
  sql: postgres.Sql;
  tasks: TaskService;
  projects: ProjectService;
  claims: ClaimRegistry;
  worktrees: WorktreeManager;
  eventLog: EventLog;
  /** Built per project, because §11's commands are per-project config. */
  gates(project: ProjectRecord): GateSuite;
  /**
   * §5's `gate_runs` / `findings`, and §11's pipeline (step 4).
   *
   * Required rather than optional: a merge queue that silently records nothing
   * would leave every fix attempt as uninformed as it was before the pipeline
   * existed, and the absence would be invisible — which is precisely the wiring
   * §8.2's sixth domain hunts.
   */
  findings: FindingsService;
  /**
   * §15's inbox — passed through to the `RedPath` this builds when the caller
   * supplies none. Required for the same reason `findings` is: an optional
   * dependency nobody passes is indistinguishable from a working one, and the
   * symptom would be §9's second failure silently never reaching the operator.
   */
  escalations: EscalationService;
  redPath?: RedPath;
  /**
   * The deploy methods this studio can actually execute — the target registry's
   * keys (§12, A11).
   *
   * Optional, and **empty by default**, which is the fail-closed direction: a
   * studio whose wiring forgot to hand this over refuses every deployable
   * project instead of merging code nothing can roll out. That is exactly the
   * behaviour the hard-coded "Phase 5 does not exist yet" produced, so nothing
   * gets weaker by the engine arriving — only wider, and only for a method
   * somebody registered a target for.
   *
   * A set of methods rather than the targets themselves: the queue's question is
   * "can this be rolled out at all", and importing `DeployTarget` here would put
   * the engine in the import graph of the component that must run before it.
   */
  deployableMethods?: Iterable<DeployMethod>;
  onWarning?(message: string): void;
  /**
   * A25's Ops alert. Raised once, on the attempt that crosses the threshold.
   *
   * Not on every subsequent tick: a project blocked on an unreachable registry
   * would otherwise push a notification every fifteen seconds for as long as it
   * stayed broken, and a channel that cries every tick is a channel the operator mutes.
   * The state stays visible in the queue and in `ops.alert` rows meanwhile.
   */
  onOpsAlert?(alert: OpsAlert): void | Promise<void>;
}

export class MergeQueue {
  private readonly redPath: RedPath | null;
  private readonly deployable: ReadonlySet<string>;

  constructor(private readonly deps: MergeQueueDeps) {
    this.redPath = deps.redPath ?? null;
    this.deployable = new Set(deps.deployableMethods ?? []);
  }

  /**
   * Put a reviewed task into the queue (§9: `gates → merge_queue`).
   *
   * The state machine is the gatekeeper — `gates` is the only state with an edge
   * to `merge_queue`, and only §8.1's Reviewer moves a task into `gates`. So
   * this method does not re-check the review; the gate suite does that again on
   * the rebased tree, where it is a statement about the tree that will actually
   * merge.
   */
  async enqueue(taskId: string, options: { actor?: string } = {}): Promise<TaskRecord> {
    return this.deps.tasks.transition(taskId, 'merge_queue', {
      actor: options.actor ?? 'orchestrator',
      reason: 'In die Merge-Warteschlange aufgenommen (§10)',
    });
  }

  /**
   * The queue of one project, in the order §10 prescribes.
   *
   * "FIFO by priority": priority first, and within a priority the task that has
   * been waiting longest. Entry time is the moment the task entered
   * `merge_queue`, read from its own log — `updated_at` would move on every
   * note and would quietly reorder the queue whenever anybody wrote one.
   */
  async list(projectId: string): Promise<MergeCandidate[]> {
    const rows = await this.deps.sql<
      Array<{
        task_id: string;
        project_id: string;
        title: string;
        priority: string;
        entered_at: Date;
        branch: string | null;
        worktree_path: string | null;
      }>
    >`SELECT * FROM merge_queue WHERE project_id = ${projectId}`;
    return rows.map((row) => ({
      taskId: row.task_id,
      projectId: row.project_id,
      title: row.title,
      priority: row.priority as Priority,
      enteredAt: row.entered_at,
      branch: row.branch,
      worktreePath: row.worktree_path,
    }));
  }

  /**
   * Take the head of the queue through §10, once.
   *
   * Returns `idle` when there is nothing to do and `busy` when somebody else is
   * already merging this project. Neither is an error; both are what a scheduler
   * tick sees most of the time.
   */
  async runOnce(projectId: string): Promise<MergeAttempt> {
    const project = await this.deps.projects.require(projectId);
    const method = this.assertDeployable(project);

    const connection = await this.deps.sql.reserve();
    let locked = false;
    try {
      const [lock] = await connection<Array<{ ok: boolean }>>`
        SELECT pg_try_advisory_lock(${MERGE_LOCK_NAMESPACE}, hashtext(${projectId})) AS ok
      `;
      locked = lock?.ok === true;
      if (!locked) {
        return this.empty(projectId, 'busy', 'Für dieses Projekt läuft bereits ein Merge (§10).');
      }

      // Read the queue *after* taking the lock. A list read before it can name a
      // candidate the winner of the race has already merged.
      const [candidate] = await this.list(projectId);
      if (!candidate) return this.empty(projectId, 'idle', null);

      return await this.merge(project, candidate, method);
    } finally {
      if (locked) {
        await connection`
          SELECT pg_advisory_unlock(${MERGE_LOCK_NAMESPACE}, hashtext(${projectId}))
        `;
      }
      await connection.release();
    }
  }

  /**
   * Walk the queue until it stops producing merges.
   *
   * Stops on anything that is not a merge — including `red`, because the next
   * candidate rebases onto a `main` that has not moved and the tick will pick it
   * up anyway. `limit` is a runaway guard rather than a policy: a queue that
   * produced more merges than it had candidates would be a defect, and an
   * unattended loop is a poor place to discover one.
   */
  async drain(projectId: string, options: { limit?: number } = {}): Promise<MergeAttempt[]> {
    const limit = options.limit ?? 50;
    const attempts: MergeAttempt[] = [];
    for (let index = 0; index < limit; index += 1) {
      const attempt = await this.runOnce(projectId);
      attempts.push(attempt);
      if (attempt.status !== 'merged') break;
    }
    return attempts;
  }

  // --- one candidate -----------------------------------------------------------

  private async merge(
    project: ProjectRecord,
    candidate: MergeCandidate,
    method: DeployMethod,
  ): Promise<MergeAttempt> {
    const task = await this.requireTask(candidate.taskId);
    const worktree = task.worktreePath;
    const branch = task.branch;
    const baseShaBefore = await headSha(project.rootPath).catch(() => null);

    const base = (status: MergeStatus, problem: string | null): MergeAttempt => ({
      projectId: project.id,
      taskId: task.id,
      status,
      problem,
      baseShaBefore,
      baseShaAfter: baseShaBefore,
      commits: [],
      gates: null,
      gateRunId: null,
      findings: [],
      red: null,
      releasedClaims: [],
      worktreeRemoved: false,
      deployMethod: null,
    });

    if (!worktree || !branch) {
      // Nothing to merge and nothing to diagnose in a worktree that is not
      // there. Red rather than infra: a candidate without a branch did not lose
      // a race with the machine, something upstream of here went wrong.
      return this.fail(
        project,
        task,
        base('red', null),
        'Der Kandidat hat kein Arbeitsverzeichnis und keinen Branch mehr — es gibt nichts ' +
          'zusammenzuführen (§10).',
        [],
      );
    }

    const merging = await this.deps.tasks.transition(task.id, 'merging', {
      actor: 'orchestrator',
      reason: `Merge-Kandidat: Rebase auf "${project.defaultBranch}" (§10)`,
      payload: { branch, baseBranch: project.defaultBranch, baseShaBefore },
    });

    // --- 1. rebase onto the current integration branch -------------------------
    const rebased = await rebaseOnto(worktree, project.defaultBranch);
    if (!rebased.ok) {
      return this.fail(
        project,
        merging,
        base('red', null),
        rebased.problem ?? 'Rebase fehlgeschlagen',
        rebased.conflicts.map(
          (path) => `${path}: Konflikt mit "${project.defaultBranch}" — Änderung neu aufsetzen`,
        ),
      );
    }

    // --- 2. the full baseline suite, on the tree that will become main ---------
    // `baseRef` is the integration branch and not `baseShaBefore`: the rebase
    // just moved the candidate, so what this change *is* now means everything
    // between that branch's tip and HEAD. The diff-based gates (§11's CHANGELOG
    // and docs) ask exactly that question.
    const gates = await this.deps.gates(project).run({
      cwd: worktree,
      taskId: task.id,
      baseRef: project.defaultBranch,
      projectId: project.id,
      readOnlyProject: project.readOnly,
    });

    // §5's entities, before the verdict is acted on and for every run including
    // the green ones. A green run is what *closes* an earlier finding (§11:
    // "gate re-run → only then merge"), so recording failures alone would leave
    // every finding open forever.
    const recorded = await this.deps.findings.record({
      taskId: task.id,
      projectId: project.id,
      stage: 'merge_queue',
      result: gates,
      headSha: rebased.head,
      baseRef: project.defaultBranch,
    });

    // Recorded before the verdict is acted on, and unconditionally. §8.2's
    // seventh audit domain asks whether any commit reached the integration
    // branch without a gate run behind it in the event log — a question that can
    // only be answered if the row exists for the runs that failed too.
    await this.deps.eventLog.append({
      kind: 'gate.finished',
      actor: 'orchestrator',
      projectId: project.id,
      taskId: task.id,
      payload: {
        stage: 'merge_queue',
        branch,
        rebasedOnto: project.defaultBranch,
        head: rebased.head,
        gateRunId: recorded.run.id,
        findingIds: recorded.findings.map((finding) => finding.id),
        ...summarise(gates),
      },
    });

    if (gates.infra.length > 0 && gates.findings.length === 0) {
      // A25: nothing was proven, so nothing is decided. Back into the queue at
      // the position it already had — `merging → red` is the only other edge and
      // it would colour a task for a failure it did not cause.
      const problem = `Gates konnten nicht vollständig laufen:\n${gateFailureSummary(gates)}`;
      this.deps.onWarning?.(problem);
      await this.deps.tasks.note(task.id, {
        text: problem,
        actor: 'orchestrator',
        payload: { gates: summarise(gates), classification: 'infra' },
      });
      await this.requeueForRetry(merging, problem);
      return { ...base('infra', problem), gates, gateRunId: recorded.run.id };
    }
    if (!gates.ok) {
      const problem = `Prüfungen auf dem rebasierten Baum rot (§11):\n${gateFailureSummary(gates)}`;
      // The findings go onto the timeline in full — detail *and* output — before
      // §9 moves the task. `learningsNote` carries a summary into the requeue,
      // and this is the evidence behind it: a note that says "the tests failed"
      // and a note that shows which assertion failed are worth very different
      // amounts to whoever reads the task next, human or otherwise.
      await this.deps.tasks.note(task.id, {
        text: findingsNote(recorded.findings),
        actor: 'orchestrator',
        payload: {
          gateRunId: recorded.run.id,
          findingIds: recorded.findings.map((finding) => finding.id),
          gates: recorded.findings.map((finding) => finding.gateId),
        },
      });
      return {
        ...(await this.fail(
          project,
          merging,
          base('red', null),
          problem,
          gates.findings.map((step) => `${step.id}: ${step.detail}`),
          recorded.findings.map((finding) => finding.id),
        )),
        gates,
        gateRunId: recorded.run.id,
        findings: recorded.findings,
      };
    }

    // --- 3. fast-forward -------------------------------------------------------
    const forwarded = await fastForwardMerge(project.rootPath, branch, project.defaultBranch);
    if (!forwarded.merged) {
      // Everything that lands here is about the *repository*, not about the
      // change: a dirty checkout, the wrong branch checked out, a tip that moved
      // between the rebase and the merge. None of that is the task's fault, so
      // it is an infra outcome and the candidate keeps its place.
      const problem = forwarded.problem ?? 'Fast-Forward-Merge fehlgeschlagen';
      this.deps.onWarning?.(problem);
      await this.deps.tasks.note(task.id, {
        text: problem,
        actor: 'orchestrator',
        payload: { classification: 'infra', stage: 'fast_forward' },
      });
      await this.requeueForRetry(merging, problem);
      return { ...base('infra', problem), gates, gateRunId: recorded.run.id };
    }

    const commits =
      baseShaBefore === null
        ? []
        : await commitsBetween(project.rootPath, baseShaBefore, forwarded.head).catch(() => []);

    // --- 4. release, record, finish -------------------------------------------
    const releasedClaims = await this.deps.claims.release(
      task.id,
      `Zusammengeführt nach "${project.defaultBranch}" (§10)`,
      { actor: 'orchestrator' },
    );
    const release = await this.deps.worktrees.release(
      task.id,
      `Zusammengeführt nach "${project.defaultBranch}"`,
      { deleteBranch: true },
    );
    if (!release.removed) {
      // Reported, never forced (A44.5). The merge itself stands — the commits
      // are on the integration branch — and the leftover is the GC's problem.
      this.deps.onWarning?.(release.problem ?? `Worktree ${release.path} blieb bestehen`);
    }

    await this.deps.eventLog.append({
      kind: 'merge.finished',
      actor: 'orchestrator',
      projectId: project.id,
      taskId: task.id,
      payload: {
        branch,
        baseBranch: project.defaultBranch,
        baseShaBefore,
        baseShaAfter: forwarded.head,
        commits: commits.map((commit) => ({ sha: commit.sha, author: commit.authorEmail })),
        releasedClaims,
        deployMethod: method,
        gates: summarise(gates),
      },
    });

    // A24: `deploy: none` makes a green merge the terminal state; anything else
    // has a registered target (`assertDeployable` refused it otherwise) and goes
    // to §12 through `deploying`. The handover is this transition and nothing
    // else — see decision 7 in the header for why the engine is not called from
    // inside the lock this method is holding.
    if (method === 'none') {
      await this.deps.tasks.transition(task.id, 'done', {
        actor: 'orchestrator',
        reason: `Zusammengeführt nach "${project.defaultBranch}" — kein Deployment konfiguriert (A24)`,
        payload: { baseShaAfter: forwarded.head, commits: commits.length },
      });
    } else {
      await this.deps.tasks.transition(task.id, 'deploying', {
        actor: 'orchestrator',
        reason:
          `Zusammengeführt nach "${project.defaultBranch}" — Rollout nach §12 folgt ` +
          `(Methode „${method}")`,
        payload: { baseShaAfter: forwarded.head, commits: commits.length, deployMethod: method },
      });
    }

    return {
      projectId: project.id,
      taskId: task.id,
      status: 'merged',
      problem: null,
      baseShaBefore,
      baseShaAfter: forwarded.head,
      commits,
      gates,
      gateRunId: recorded.run.id,
      findings: [],
      red: null,
      releasedClaims,
      worktreeRemoved: release.removed,
      deployMethod: method,
    };
  }

  // --- exits ---------------------------------------------------------------------

  /** §9's red path, with the gate output attached as learnings. */
  private async fail(
    project: ProjectRecord,
    task: TaskRecord,
    attempt: MergeAttempt,
    problem: string,
    learnings: readonly string[],
    findingIds: readonly string[] = [],
  ): Promise<MergeAttempt> {
    const current = (await this.deps.tasks.get(task.id)) ?? task;
    const redPath =
      this.redPath ??
      new RedPath({
        tasks: this.deps.tasks,
        eventLog: this.deps.eventLog,
        escalations: this.deps.escalations,
      });
    const red = await redPath.fail({
      task: current,
      project,
      problem,
      learnings,
      findingIds,
      actor: 'orchestrator',
      worktree:
        current.worktreePath && current.branch
          ? {
              path: current.worktreePath,
              branch: current.branch,
              baseBranch: project.defaultBranch,
              baseSha: attempt.baseShaBefore ?? '',
            }
          : null,
    });
    return {
      ...attempt,
      status: red.status === 'escalated' ? 'escalated' : 'red',
      problem,
      red,
    };
  }

  /**
   * Put an infra-blocked candidate back into the queue it came from.
   *
   * A25 says it plainly — "persistent infra failure → Ops alert, task stays
   * queued" — and `merging → merge_queue` is the edge that makes that sentence
   * expressible. It was added to §9's map for this (A55): every other route out
   * of `merging` either merges, colours the task, or suspends it, and all three
   * are wrong for a machine that was briefly unavailable.
   *
   * The candidate keeps its claims, its worktree and its place in the FIFO; only
   * the attempt is discarded. Within one attempt the retrying is the gate
   * suite's (A25's three with backoff, per step); across attempts it is the
   * scheduler's tick. What this method adds is the *count*, because A25's second
   * half — "persistent infra failure → Ops alert" — needs one, and the count has
   * to survive a restart of the process that is doing the retrying.
   */
  private async requeueForRetry(task: TaskRecord, problem: string): Promise<void> {
    await this.deps.tasks.transition(task.id, 'merge_queue', {
      actor: 'orchestrator',
      reason: `Merge zurückgestellt (Infrastruktur, A25): ${problem}`,
      payload: { classification: 'infra' },
    });

    const attempts = await this.consecutiveInfraRequeues(task.id);
    // Exactly at the threshold, never above it: this runs on every tick for as
    // long as the machine stays broken, and `>=` would push a notification each
    // time. Crossing the line is the news; staying behind it is the queue's job
    // to show.
    if (attempts !== OPS_ALERT_AFTER_INFRA_ATTEMPTS) return;

    const alert: OpsAlert = { projectId: task.projectId, taskId: task.id, attempts, problem };
    await this.deps.eventLog.append({
      kind: 'ops.alert',
      actor: 'orchestrator',
      projectId: task.projectId,
      taskId: task.id,
      payload: { classification: 'infra', stage: 'merge_queue', attempts, problem },
    });
    this.deps.onWarning?.(
      `Anhaltender Infrastrukturfehler: Aufgabe ${task.id} steht seit ${attempts} Anläufen in ` +
        `der Merge-Warteschlange, ohne dass die Prüfungen laufen konnten (A25). ${problem}`,
    );
    await this.deps.onOpsAlert?.(alert);
  }

  /**
   * Infra-blocked merge attempts since this candidate last entered the queue
   * for an ordinary reason.
   *
   * Counted from the event log rather than held in memory, for A43's reason and
   * one more: the process doing the retrying is exactly the process most likely
   * to be restarted while a machine is down (a deploy is a restart, A57), and a
   * counter that resets on restart would never reach a threshold at all.
   *
   * The reference point is the most recent *non*-infra entry into
   * `merge_queue` — §8.1's Reviewer handing the task over. Everything after
   * that is one uninterrupted run of failures to check the tree.
   */
  private async consecutiveInfraRequeues(taskId: string): Promise<number> {
    const [row] = await this.deps.sql<Array<{ n: number }>>`
      SELECT count(*)::int AS n FROM task_events
      WHERE task_id = ${taskId}
        AND kind = 'state_changed' AND state = 'merge_queue'
        AND payload ->> 'classification' = 'infra'
        AND seq > COALESCE((
          SELECT max(seq) FROM task_events
          WHERE task_id = ${taskId}
            AND kind = 'state_changed' AND state = 'merge_queue'
            AND payload ->> 'classification' IS DISTINCT FROM 'infra'
        ), 0)
    `;
    return row?.n ?? 0;
  }

  /**
   * Can this project's merges be rolled out — and by which method (§12)?
   *
   * The **raw** column is read rather than `readDeployConfig`, deliberately: an
   * unreadable document falls back to `none` there, which is the safe direction
   * for the engine ("we could not read it" must mean "deploy nothing") and the
   * dangerous one here. A half-filled `compose` configuration would then merge,
   * end at `done`, and leave production behind `main` with nothing on the
   * timeline saying so. Read raw, and a method that names itself deployable has
   * to have a target whatever its fields look like — the engine then refuses it
   * loudly (`unsupported`) instead of the queue refusing it silently.
   */
  private assertDeployable(project: ProjectRecord): DeployMethod {
    const raw = (project.deployConfig as { method?: unknown }).method ?? 'none';
    if (raw === 'none') return 'none';
    if (typeof raw === 'string' && this.deployable.has(raw)) return raw as DeployMethod;
    throw new MergeQueueError(
      project.id,
      `Projekt "${project.slug}" ist auf die Deploy-Methode "${String(raw)}" konfiguriert, für ` +
        'die in diesem Studio kein Deploy-Ziel registriert ist (§12). Ein Merge ohne ' +
        'anschließendes Deployment ließe die Produktion still hinter "main" zurück und wird ' +
        'deshalb nicht ausgeführt.',
    );
  }

  private empty(projectId: string, status: MergeStatus, problem: string | null): MergeAttempt {
    return {
      projectId,
      taskId: null,
      status,
      problem,
      baseShaBefore: null,
      baseShaAfter: null,
      commits: [],
      gates: null,
      gateRunId: null,
      findings: [],
      red: null,
      releasedClaims: [],
      worktreeRemoved: false,
      deployMethod: null,
    };
  }

  private async requireTask(taskId: string): Promise<TaskRecord> {
    const task = await this.deps.tasks.get(taskId);
    if (!task) throw new MergeQueueError('', `Aufgabe ${taskId} existiert nicht`);
    if (isTerminalTaskState(task.state)) {
      throw new MergeQueueError(
        task.projectId,
        `Aufgabe ist "${TASK_STATE_LABELS[task.state]}" und steht trotzdem in der ` +
          'Merge-Warteschlange — das ist ein Fehler im Scheduler, kein fehlgeschlagener Merge.',
      );
    }
    return task;
  }
}

/**
 * Every commit that landed is authored by the bot (§22 Phase 2, A20/A36).
 *
 * A fast-forward creates no merge commit, so "merge commits are authored as
 * Vorschicht Bot" is only meaningful as a statement about the commits the merge
 * *brings in* — which is the stronger reading anyway: a human-authored commit
 * on a task branch would reach `main` unreviewed by any human process.
 */
export function foreignCommits(
  commits: readonly { authorName: string; authorEmail: string; sha: string }[],
): Array<{ sha: string; author: string }> {
  return commits
    .filter(
      (commit) =>
        commit.authorName !== BOT_IDENTITY.name || commit.authorEmail !== BOT_IDENTITY.email,
    )
    .map((commit) => ({ sha: commit.sha, author: `${commit.authorName} <${commit.authorEmail}>` }));
}

function summarise(gates: GateSuiteResult): Record<string, unknown> {
  return {
    ok: gates.ok,
    durationMs: gates.durationMs,
    steps: gates.steps.map((step) => ({
      id: step.id,
      verdict: step.verdict,
      detail: step.detail,
      exitCode: step.exitCode,
      durationMs: step.durationMs,
      // A25's retry, carried into the log even when the gate ended green. A
      // gate that needs three attempts on every merge is a machine problem
      // hiding inside a green run, and the verdict alone cannot show it.
      attempts: step.attempts,
      ...(step.retries.length > 0 ? { retries: step.retries } : {}),
    })),
  };
}
