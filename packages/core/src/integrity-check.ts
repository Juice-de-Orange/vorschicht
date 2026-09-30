/**
 * §7.2's mandatory re-check — the only way out of `interrupted`.
 *
 * The rule is one clause in §7.2's `hard_stop` row: "affected tasks are marked
 * `interrupted` for a mandatory integrity re-check (Debugger verifies worktree
 * state) before resuming." A43.3 turned that clause into a database rule — an
 * `interrupted` task cannot move at all until an `integrity_check` with
 * `ok: true` exists *after* the most recent interrupt — and then nothing in the
 * running system ever wrote one. `recordIntegrityCheck` had exactly three
 * callers, all of them tests.
 *
 * That is a worse state than a missing feature, because the two halves conspire:
 * `reconcile()` marks tasks `interrupted` on every restart, and a deploy is a
 * restart. Every rollout would have permanently frozen whatever was in flight,
 * quietly, in a state that reads as recoverable. The guard was doing exactly
 * what it was built to do, and there was nobody on the other side of it.
 *
 * Three decisions this module makes that §7.2 leaves open:
 *
 * **A task with no worktree passes without a session.** §7.2 asks the Debugger
 * to verify *worktree state*; a task interrupted before one was assigned has no
 * state to verify, and there is nothing a model could look at. It records
 * `ok: true` with the reason and resumes. Spending a session to have it report
 * that the directory it was pointed at does not exist would cost budget to learn
 * what the record already says.
 *
 * **The verdict is `status`, and an unsure verdict is `failed`.** The Debugger's
 * contract is the shared `agentResultSchema`, so the verdict rides on a field
 * every role has. That is narrower than the field's usual meaning, so the prompt
 * states the mapping explicitly and states which way to err: a wrong "sound"
 * sends a coder into a broken tree, a wrong "broken" costs one re-plan.
 *
 * **A session that could not run is not a verdict.** Only a Debugger that looked
 * and said no takes the task down §9's red path. An infra failure, an auth
 * incident or an interrupt during the check itself leave the task exactly where
 * it is, to be retried — because "the check could not be performed" and "the
 * worktree is broken" are different facts, and only one of them is about the
 * task.
 */
import { integrityPrompt } from './dev-chain-prompts.js';
import type { EscalationService } from './escalation-service.js';
import type { EventLog } from './event-log.js';
import { AGENT_PROFILES } from './profiles/index.js';
import type { ProjectRecord, ProjectService } from './project-service.js';
import { RedPath, type RedPathResult } from './red-path.js';
import type { AgentRunner } from './runner.js';
import type { TaskRecord, TaskService } from './task-service.js';
import { ProjectReadOnlyError, type WorktreeManager } from './worktree.js';

export interface IntegrityCheckDeps {
  tasks: TaskService;
  projects: ProjectService;
  worktrees: WorktreeManager;
  runner: AgentRunner;
  eventLog: EventLog;
  /** §9, for the case where the worktree really is unusable. */
  /**
   * §15's inbox — passed through to the `RedPath` this builds when the caller
   * supplies none. Required for the same reason `findings` is: an optional
   * dependency nobody passes is indistinguishable from a working one, and the
   * symptom would be §9's second failure silently never reaching the operator.
   */
  escalations: EscalationService;
  redPath?: RedPath;
  onWarning?(message: string): void;
}

export type IntegrityStatus =
  /** The worktree is sound; the task went back to the state it was stopped in. */
  | 'resumed'
  /** The Debugger looked and said no. The task took §9's red path (first fail). */
  | 'red'
  /** Same, and it was the second failure — with the diagnosis attached (§9). */
  | 'escalated'
  /** The check could not be performed. The task is untouched; try again later. */
  | 'infra'
  /** §6.1 or §7.3 stopped the check itself. Untouched, and not this task's fault. */
  | 'blocked';

export interface IntegrityCheckResult {
  taskId: string;
  status: IntegrityStatus;
  /** Did a verdict exist at all, and was it positive? Null when none was reached. */
  ok: boolean | null;
  /** Where the task went back to, on `resumed`. */
  resumedTo: string | null;
  /** The Debugger's account, or null when no session produced one. */
  summary: string | null;
  /** German, for the timeline. Null when the check passed cleanly. */
  problem: string | null;
  runId: string | null;
  red: RedPathResult | null;
  /** True when the verdict was reached without spending a session. */
  withoutSession: boolean;
}

export class IntegrityCheckError extends Error {
  constructor(
    readonly taskId: string,
    message: string,
  ) {
    super(message);
    this.name = 'IntegrityCheckError';
  }
}

export class IntegrityCheck {
  private readonly redPath: RedPath;

  constructor(private readonly deps: IntegrityCheckDeps) {
    this.redPath =
      deps.redPath ??
      new RedPath({
        tasks: deps.tasks,
        eventLog: deps.eventLog,
        escalations: deps.escalations,
        runner: deps.runner,
        ...(deps.onWarning ? { onWarning: deps.onWarning } : {}),
      });
  }

  /**
   * Verify one interrupted task and, if it holds up, put it back to work.
   *
   * Throws only when asked for something that cannot be done — a task that is
   * not interrupted, a read-only project (A41). Per A54.6 that is a defect in
   * the caller rather than a task that failed, and the scheduler quarantines it
   * rather than retrying it forever.
   */
  async verify(taskId: string): Promise<IntegrityCheckResult> {
    const task = await this.deps.tasks.get(taskId);
    if (!task) throw new IntegrityCheckError(taskId, `Aufgabe ${taskId} existiert nicht`);
    if (task.state !== 'interrupted') {
      throw new IntegrityCheckError(
        taskId,
        `Die Integritätsprüfung (§7.2) gilt nur für unterbrochene Aufgaben — ` +
          `die Aufgabe ist "${task.state}".`,
      );
    }

    const project = await this.deps.projects.require(task.projectId);

    // §7.2 never says what to do with a task that has no return point, and the
    // database refuses to guess: `resume()` throws without one. Reaching this
    // means an interrupt was recorded without a `resume_state`, which the task
    // service does not allow — so it is a defect rather than a condition, and
    // saying so is better than resuming to an invented state.
    if (!task.resumeState) {
      throw new IntegrityCheckError(
        taskId,
        'Die Aufgabe ist unterbrochen, hat aber keinen gemerkten Rückkehrpunkt — ' +
          'eine Fortsetzung wäre geraten statt hergeleitet.',
      );
    }

    if (!task.worktreePath) {
      // Nothing on disk belongs to this task: the stop happened before a
      // worktree existed. There is no state to be inconsistent.
      return this.pass(task, {
        summary:
          'Kein Arbeitsverzeichnis vorhanden — die Unterbrechung geschah vor der Umsetzung, ' +
          'es gibt keinen Zustand, der inkonsistent sein könnte.',
        withoutSession: true,
      });
    }

    // A41. The check itself reads only, but `ensure()` below writes a worktree,
    // and a read-only project should never have owned a task to interrupt.
    if (project.readOnly) throw new ProjectReadOnlyError(project.slug);

    return this.inspect(task, project);
  }

  /** The session half. Split out so the no-worktree path needs no runner at all. */
  private async inspect(task: TaskRecord, project: ProjectRecord): Promise<IntegrityCheckResult> {
    let worktree: Awaited<ReturnType<WorktreeManager['ensure']>>;
    try {
      worktree = await this.deps.worktrees.ensure(task.id);
    } catch (error) {
      // Git could not tell us where this task's work is. Not a verdict about
      // the worktree — a failure to reach it (§11, A25).
      const problem = `Arbeitsverzeichnis nicht erreichbar: ${(error as Error).message}`;
      this.deps.onWarning?.(problem);
      return this.result(task, { status: 'infra', problem });
    }

    // What kind of stop this was: a hard-stop kill mid-edit leaves a different
    // mess from an orchestrator that died between two commits, and the Debugger
    // should not have to guess which it is looking at.
    const reason =
      (await this.deps.tasks.lastTransitionReason(task.id, 'interrupted')) ??
      'Kein Grund vermerkt.';

    let outcome: Awaited<ReturnType<AgentRunner['run']>>;
    try {
      outcome = await this.deps.runner.run({
        taskId: task.id,
        projectId: task.projectId,
        profile: AGENT_PROFILES.debugger,
        prompt: integrityPrompt({
          task,
          project,
          worktree,
          reason,
          interruptCount: task.interruptCount,
        }),
        cwd: worktree.path,
        // Read-only twice over, as §9's diagnosis is and for the same reason:
        // this session runs over a tree whose state is already not what anyone
        // expected, and the one thing it must not do is change it further.
        containment: { writeRoot: null, claims: null, readOnlyProject: false },
      });
    } catch (error) {
      const problem = `Integritätsprüfung nicht möglich: ${(error as Error).message}`;
      this.deps.onWarning?.(problem);
      return this.result(task, { status: 'infra', problem });
    }

    if (outcome.status !== 'ok') {
      // A25/§6.1/§7.3 — the harness, not the tree. The task stays interrupted
      // and the scheduler comes back to it; nothing about its worktree has been
      // established either way, and pretending otherwise in either direction is
      // the failure this branch exists to avoid.
      const status: IntegrityStatus =
        outcome.status === 'infra' || outcome.status === 'failed' ? 'infra' : 'blocked';
      return this.result(task, {
        status,
        problem: `Die Prüfung selbst kam nicht zu einem Ergebnis: ${outcome.problem}`,
        runId: outcome.run.runId,
      });
    }

    const sound = outcome.result.status === 'done';
    if (sound) {
      return this.pass(task, {
        summary: outcome.result.summary,
        runId: outcome.run.runId,
        withoutSession: false,
      });
    }

    // The Debugger looked and said no. That is a failed attempt at the work,
    // which is what §9 is for — and §9 counts, so a task whose worktree is
    // broken twice reaches the operator with a diagnosis rather than looping.
    await this.deps.tasks.recordIntegrityCheck(task.id, {
      ok: false,
      findings: [...outcome.result.followups],
      actor: 'debugger',
    });
    await this.record(task, false, outcome.result.summary, outcome.run.runId);

    const red = await this.redPath.fail({
      task: await this.require(task.id),
      project,
      problem:
        'Die Arbeitskopie hat die Integritätsprüfung nach der Unterbrechung nicht bestanden ' +
        `(§7.2): ${outcome.result.summary}`,
      learnings: [...outcome.result.followups],
      actor: 'debugger',
      worktree,
    });

    return this.result(task, {
      status: red.status === 'escalated' ? 'escalated' : 'red',
      ok: false,
      summary: outcome.result.summary,
      problem: outcome.result.summary,
      runId: outcome.run.runId,
      red,
    });
  }

  /** Record the passing check and put the task back where it was stopped. */
  private async pass(
    task: TaskRecord,
    input: { summary: string; runId?: string; withoutSession: boolean },
  ): Promise<IntegrityCheckResult> {
    await this.deps.tasks.recordIntegrityCheck(task.id, {
      ok: true,
      findings: [],
      actor: 'debugger',
    });
    await this.record(task, true, input.summary, input.runId ?? null);

    const resumed = await this.deps.tasks.resume(task.id, {
      actor: 'orchestrator',
      reason: 'Integritätsprüfung bestanden — Fortsetzung (§7.2)',
      payload: { integrityCheck: 'ok', withoutSession: input.withoutSession },
    });

    return this.result(task, {
      status: 'resumed',
      ok: true,
      summary: input.summary,
      resumedTo: resumed.state,
      ...(input.runId ? { runId: input.runId } : {}),
      withoutSession: input.withoutSession,
    });
  }

  private async record(
    task: TaskRecord,
    ok: boolean,
    summary: string,
    runId: string | null,
  ): Promise<void> {
    await this.deps.eventLog.append({
      kind: 'task.integrity_checked',
      actor: 'debugger',
      projectId: task.projectId,
      taskId: task.id,
      runId,
      payload: { ok, summary, resumeState: task.resumeState },
    });
  }

  private async require(taskId: string): Promise<TaskRecord> {
    const task = await this.deps.tasks.get(taskId);
    if (!task) throw new IntegrityCheckError(taskId, `Aufgabe ${taskId} existiert nicht mehr`);
    return task;
  }

  private result(
    task: TaskRecord,
    over: Partial<IntegrityCheckResult> & { status: IntegrityStatus },
  ): IntegrityCheckResult {
    return {
      taskId: task.id,
      ok: null,
      resumedTo: null,
      summary: null,
      problem: null,
      runId: null,
      red: null,
      withoutSession: false,
      ...over,
    };
  }
}
