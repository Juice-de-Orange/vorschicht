/**
 * The agent channel (§6.2, §6.4, §11, §13) — everything a running session may
 * ask this system, and everything it may tell it.
 *
 * The internal MCP server is a thin protocol wrapper over this class. The logic
 * lives here rather than there for two reasons: the runner needs the same reads
 * when it assembles a prompt, and Phase 3/4 need the same writes when they turn
 * findings into fix tasks and escalations into inbox items.
 *
 * **A channel serves exactly one task, and that is structural.** The task id is
 * a constructor argument and no method takes one. An agent therefore cannot
 * read another task's timeline, append to it, or report a finding against it —
 * not because the tool schema omits the parameter, but because there is nothing
 * to pass it to. The alternative (a task id in the tool input, validated
 * against the session) would put the whole boundary in one `if`, in a process
 * whose sole caller is a language model.
 *
 * **The channel cannot move a task.** There is no `transition` here. An agent
 * that could change its own state could mark its own work reviewed, resume
 * itself past the §7.2 integrity check, or unpark itself during a wrap-up. It
 * reports; the orchestrator acts. §9's lifecycle stays a thing the scheduler
 * does, which is also why `escalate.ask` records a request rather than parking
 * the task — the session is still running when the tool returns.
 */

import {
  claimAllowsPath,
  decisionSummary,
  type EscalateAskInput,
  type FindingReportInput,
  type Priority,
  TASK_STATE_LABELS,
  type TaskState,
} from '@vorschicht/shared';
import type postgres from 'postgres';
import type { ClaimRegistry, ClaimStatus } from './claim-registry.js';
import type { DecisionRecord, EscalationService, RelatedDecision } from './escalation-service.js';
import type { EventLog } from './event-log.js';
import type { ProjectService } from './project-service.js';
import type { Queryable } from './sql.js';
import type { TaskRecord, TaskService } from './task-service.js';

/** How much history a session gets. Enough to continue, not enough to drown in. */
export const CONTEXT_LIMITS = { notes: 20, history: 20, findings: 50 } as const;

export interface AgentTaskContext {
  task: {
    id: string;
    title: string;
    description: string | null;
    acceptanceCriteria: string[];
    state: TaskState;
    stateLabel: string;
    priority: Priority;
    type: string | null;
    department: string | null;
    /** §9's red path: how often this task has already failed. */
    retryCount: number;
    parkCount: number;
    interruptCount: number;
  };
  project: {
    slug: string;
    name: string;
    /** What task branches are cut from (§10). */
    defaultBranch: string;
    claimGranularity: string;
    /** A41: analysed, never written to. */
    readOnly: boolean;
  };
  worktree: { path: string; branch: string } | null;
  claims: { status: ClaimStatus | 'none'; globs: string[] };
  notes: Array<{ at: string; actor: string; text: string }>;
  history: Array<{ at: string; from: string | null; to: string; reason: string | null }>;
  findings: Array<{
    at: string;
    reportedBy: string;
    file: string;
    line: number | null;
    summary: string;
    detail: string | null;
  }>;
  /**
   * Decisions this task has asked for, and what came back.
   *
   * `decision` is the whole reason a resumed session (§6.4) reads this: it was
   * suspended waiting on an answer, and the answer is what it must act on. A
   * list that only said "answered: true" would tell it that it may continue
   * without telling it how.
   */
  escalations: Array<{
    at: string;
    number: number | null;
    question: string;
    urgency: string;
    answered: boolean;
    decision: string | null;
  }>;
}

export interface AgentClaimsView {
  status: ClaimStatus | 'none';
  globs: string[];
  worktreePath: string | null;
  /** English, agent-facing (§2): what the status means for what it may do now. */
  note: string;
}

export interface AgentChannelDeps {
  sql: Queryable;
  tasks: TaskService;
  projects: ProjectService;
  claims: ClaimRegistry;
  eventLog: EventLog;
  /** §15's inbox and its policy memory. Required, never optional — see below. */
  escalations: EscalationService;
}

/**
 * What the decision the session may now act on looks like (§15).
 *
 * the operator's own words travel verbatim: `chosenTitle` is the option he picked and
 * `freeText` is whatever he added or wrote instead. Neither is paraphrased on
 * the way through, for the reason `findingsBriefing` already states — a second
 * wording of a decision is a second decision that nothing keeps in step.
 */
export interface AppliedDecision {
  number: number;
  question: string;
  chosenTitle: string | null;
  freeText: string | null;
  decidedAt: string;
  decidedBy: string;
  /** German, one line, for a summary or a note. */
  summary: string;
}

/** What `escalate.ask` did: raised an item, or applied one the operator already answered. */
export interface EscalationRequestResult {
  answeredFromPrecedent: boolean;
  /** The task-event sequence this wrote — the note, or the escalation request. */
  seq: number;
  /** `#12`, or null when policy memory answered and nothing was raised. */
  escalationRef: string | null;
  number: number | null;
  /** Similar earlier decisions, attached to the card as context. Never an answer. */
  related: RelatedDecision[];
  decision: AppliedDecision | null;
}

export class AgentChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentChannelError';
  }
}

export class AgentChannel {
  constructor(
    private readonly deps: AgentChannelDeps,
    /** The one task this session serves. */
    readonly taskId: string,
    /** Recorded as the actor on everything written — the profile id (§8). */
    readonly role: string,
    /** The `agent_runs` row, so a finding can be traced back to its session. */
    readonly runId: string,
  ) {}

  /** `task.get_context` — the mandate, the surroundings, and what happened so far. */
  async context(): Promise<AgentTaskContext> {
    const task = await this.requireTask();
    const project = await this.deps.projects.require(task.projectId);
    const claims = await this.deps.claims.claimsOf(this.taskId);
    const held = claims.filter((c) => c.status !== 'released');

    const [notes, history, findings, escalations] = await Promise.all([
      this.notes(),
      this.history(),
      this.findings(),
      this.escalations(),
    ]);

    return {
      task: {
        id: task.id,
        title: task.title,
        description: task.description,
        acceptanceCriteria: task.acceptanceCriteria,
        state: task.state,
        stateLabel: TASK_STATE_LABELS[task.state],
        priority: task.priority,
        type: task.type,
        department: task.department,
        retryCount: task.retryCount,
        parkCount: task.parkCount,
        interruptCount: task.interruptCount,
      },
      project: {
        slug: project.slug,
        name: project.name,
        defaultBranch: project.defaultBranch,
        claimGranularity: project.claimGranularity,
        readOnly: project.readOnly,
      },
      worktree:
        task.worktreePath && task.branch ? { path: task.worktreePath, branch: task.branch } : null,
      claims: {
        status: held[0]?.status ?? 'none',
        globs: held.map((c) => c.glob),
      },
      notes,
      history,
      findings,
      escalations,
    };
  }

  /**
   * `claims.list` — the globs, the status, and what that means right now.
   *
   * The `note` is written for the model rather than for a log. A Coder that
   * reads "pending" without being told what pending implies will either wait
   * for something that never arrives or start writing into files it does not
   * hold; both cost a full cycle, and a sentence costs nothing.
   */
  async listClaims(): Promise<AgentClaimsView> {
    const task = await this.requireTask();
    const claims = await this.deps.claims.claimsOf(this.taskId);
    const held = claims.filter((c) => c.status !== 'released');
    const status = held[0]?.status ?? 'none';
    const globs = held.map((c) => c.glob);

    const note =
      status === 'active' || status === 'parked'
        ? 'These globs are held by your task. You may write inside them and nowhere ' +
          'else; attempts outside are refused before the tool runs.'
        : status === 'pending'
          ? 'These globs are registered but not yet granted — the scheduler has not ' +
            'checked them against the rest of the project. You may not write yet.'
          : 'No claims are registered for this task, so you may not write to any file. ' +
            'If the work needs file changes, that is a planning gap: say so in your result.';

    return { status, globs, worktreePath: task.worktreePath, note };
  }

  /** Does this task hold `relativePath`? Fail-closed — see `ClaimRegistry`. */
  async allowsPath(relativePath: string): Promise<boolean> {
    return claimAllowsPath(await this.deps.claims.heldGlobs(this.taskId), relativePath);
  }

  /**
   * `task.append_note` — the one write an agent may perform outside its worktree.
   *
   * Deliberately not gated on state: a session that is being wrapped up (§7.3
   * step 3) is exactly the case where the handover note matters most, and that
   * happens while the task is on its way to `parked`.
   */
  async appendNote(text: string): Promise<{ seq: number }> {
    const trimmed = text.trim();
    if (!trimmed) throw new AgentChannelError('Eine leere Notiz sagt der nächsten Sitzung nichts.');
    const task = await this.deps.tasks.note(this.taskId, {
      text: trimmed,
      actor: this.role,
      payload: { runId: this.runId, source: 'mcp' },
    });
    return { seq: task.version };
  }

  /**
   * `finding.report` — §11's blocker, recorded against this task.
   *
   * The severity is not an input. §11 has exactly one: "Every finding is a
   * blocker. No warning mode exists anywhere." A severity field would be a
   * place for that to erode one convenient exception at a time.
   */
  async reportFinding(input: FindingReportInput): Promise<{ seq: number; severity: 'blocker' }> {
    const task = await this.requireTask();
    const updated = await this.append(task, 'finding_reported', {
      file: input.file,
      line: input.line ?? null,
      summary: input.summary,
      detail: input.detail ?? null,
      severity: 'blocker',
      runId: this.runId,
    });
    await this.deps.eventLog.append({
      kind: 'finding.reported',
      actor: this.role,
      projectId: task.projectId,
      taskId: this.taskId,
      runId: this.runId,
      payload: { file: input.file, line: input.line ?? null, summary: input.summary },
    });
    return { seq: updated.version, severity: 'blocker' };
  }

  /**
   * `escalate.ask` — put a decision to the operator, unless he has already made it
   * (§6.4, §15).
   *
   * This is the one place §15's policy memory is consulted, and the placement is
   * deliberate: "before escalating, agents must search prior decisions — the
   * same question is never asked twice; matching precedent is applied and
   * referenced instead". The search belongs where an *agent* asks, not in
   * `EscalationService.raise`, because §9's second-failure escalation goes
   * through that method too and its question names a specific task — a
   * precedent lookup there could abort work from memory. `POLICY_MEMORY_SOURCES`
   * carries that reasoning in full.
   *
   * Two outcomes, and each writes a different record:
   *
   *   * **A precedent exists.** No inbox item is created, the decision comes
   *     back for the session to act on, and the task timeline records which
   *     decision was applied. The session continues rather than parking — so it
   *     must *not* end with `needs_decision`, which is what the tool response
   *     says in the words the model reads.
   *   * **No precedent.** An inbox item is raised with §15's options and any
   *     similar earlier decisions attached as context, and the task event
   *     carries the escalation id — the handle `task_escalations` joins on, so a
   *     resumed session can see that its question was answered.
   *
   * The task is *not* parked either way. The session that called this is still
   * running, and §7.3's ordering is explicit that work stops on an atomic
   * boundary rather than mid-tool. The runner parks it when the session ends
   * with `status: needs_decision`, which is also the only moment at which the
   * session id worth resuming is known.
   */
  async requestEscalation(input: EscalateAskInput): Promise<EscalationRequestResult> {
    const task = await this.requireTask();

    const precedent = await this.deps.escalations.precedentFor({
      question: input.question,
      projectId: task.projectId,
    });
    if (precedent) return this.applyPrecedent(task, input, precedent);

    const escalation = await this.deps.escalations.raise({
      source: 'agent_question',
      question: input.question,
      context: input.context,
      urgency: input.urgency,
      options: input.options,
      projectId: task.projectId,
      taskId: this.taskId,
      runId: this.runId,
      raisedBy: this.role,
    });

    const updated = await this.append(task, 'escalation_requested', {
      question: input.question,
      context: input.context,
      urgency: input.urgency,
      options: input.options,
      runId: this.runId,
      escalationId: escalation.id,
      number: escalation.number,
    });
    await this.deps.eventLog.append({
      kind: 'escalation.requested',
      actor: this.role,
      projectId: task.projectId,
      taskId: this.taskId,
      runId: this.runId,
      payload: {
        question: input.question,
        urgency: input.urgency,
        escalationId: escalation.id,
        number: escalation.number,
      },
    });

    return {
      answeredFromPrecedent: false,
      seq: updated.version,
      escalationRef: `#${escalation.number}`,
      number: escalation.number,
      related: escalation.related,
      decision: null,
    };
  }

  /**
   * §15's "matching precedent is applied and referenced instead".
   *
   * The reference is not decoration. A session told only "you may proceed" has
   * no way to say *why* in its result, and the next reader of the trace cannot
   * tell an applied policy from an agent that decided for itself — which is the
   * one thing §1 principle 6 forbids. So the decision number travels into the
   * timeline note, into the event log, and into the session's own hands.
   */
  private async applyPrecedent(
    task: TaskRecord,
    input: EscalateAskInput,
    precedent: DecisionRecord,
  ): Promise<EscalationRequestResult> {
    const summary = decisionSummary(precedent);
    const note = await this.deps.tasks.note(this.taskId, {
      text:
        `Frage aus der Sitzung: „${input.question}“\n\n` +
        `Bereits entschieden — ${summary} (${precedent.decidedAt.toISOString().slice(0, 10)}, ` +
        `${precedent.decidedBy}). Die Aufgabe läuft weiter; es ist kein neuer ` +
        'Eintrag im Postfach entstanden (§15).',
      actor: this.role,
      payload: {
        runId: this.runId,
        source: 'mcp',
        precedentEscalationId: precedent.escalationId,
        precedentNumber: precedent.number,
      },
    });
    await this.deps.eventLog.append({
      kind: 'escalation.requested',
      actor: this.role,
      projectId: task.projectId,
      taskId: this.taskId,
      runId: this.runId,
      payload: { question: input.question, urgency: input.urgency, answeredFromPrecedent: true },
    });
    await this.deps.eventLog.append({
      kind: 'escalation.precedent_applied',
      actor: this.role,
      projectId: task.projectId,
      taskId: this.taskId,
      runId: this.runId,
      payload: {
        question: input.question,
        decisionNumber: precedent.number,
        decisionEscalationId: precedent.escalationId,
        summary,
      },
    });

    return {
      answeredFromPrecedent: true,
      seq: note.version,
      escalationRef: null,
      number: null,
      related: [],
      decision: {
        number: precedent.number,
        question: precedent.question,
        chosenTitle: precedent.chosenTitle,
        freeText: precedent.freeText,
        decidedAt: precedent.decidedAt.toISOString(),
        decidedBy: precedent.decidedBy,
        summary,
      },
    };
  }

  // --- reads -----------------------------------------------------------------

  async notes(limit = CONTEXT_LIMITS.notes): Promise<AgentTaskContext['notes']> {
    const rows = await this.deps.sql<Array<{ occurred_at: Date; actor: string; text: string }>>`
      SELECT occurred_at, actor, payload ->> 'text' AS text
      FROM task_events
      WHERE task_id = ${this.taskId} AND kind = 'note' AND payload ->> 'text' IS NOT NULL
      ORDER BY seq DESC LIMIT ${limit}
    `;
    // Oldest first: a session reads a handover as a story, not as a stack.
    return rows
      .reverse()
      .map((r) => ({ at: r.occurred_at.toISOString(), actor: r.actor, text: r.text }));
  }

  async history(limit = CONTEXT_LIMITS.history): Promise<AgentTaskContext['history']> {
    const rows = await this.deps.sql<
      Array<{ occurred_at: Date; state: string; from: string | null; reason: string | null }>
    >`
      SELECT occurred_at, state, payload ->> 'from' AS from, payload ->> 'reason' AS reason
      FROM task_events
      WHERE task_id = ${this.taskId} AND kind = 'state_changed'
      ORDER BY seq DESC LIMIT ${limit}
    `;
    return rows.reverse().map((r) => ({
      at: r.occurred_at.toISOString(),
      from: r.from,
      to: r.state,
      reason: r.reason,
    }));
  }

  async findings(limit = CONTEXT_LIMITS.findings): Promise<AgentTaskContext['findings']> {
    const rows = await this.deps.sql<
      Array<{
        reported_at: Date;
        reported_by: string;
        file: string;
        line: number | null;
        summary: string;
        detail: string | null;
      }>
    >`
      SELECT reported_at, reported_by, file, line, summary, detail
      FROM task_findings
      WHERE task_id = ${this.taskId} AND open
      ORDER BY seq ASC LIMIT ${limit}
    `;
    return rows.map((r) => ({
      at: r.reported_at.toISOString(),
      reportedBy: r.reported_by,
      file: r.file,
      line: r.line,
      summary: r.summary,
      detail: r.detail,
    }));
  }

  async escalations(): Promise<AgentTaskContext['escalations']> {
    const rows = await this.deps.sql<
      Array<{
        raised_at: Date;
        escalation_number: string | null;
        question: string;
        urgency: string;
        answered: boolean;
        chosen_title: string | null;
        free_text: string | null;
      }>
    >`
      SELECT raised_at, escalation_number, question, urgency, answered, chosen_title, free_text
      FROM task_escalations WHERE task_id = ${this.taskId}
      ORDER BY seq ASC
    `;
    return rows.map((r) => {
      const number = r.escalation_number === null ? null : Number(r.escalation_number);
      return {
        at: r.raised_at.toISOString(),
        number,
        question: r.question,
        urgency: r.urgency,
        answered: r.answered,
        decision:
          r.answered && number !== null
            ? decisionSummary({ number, chosenTitle: r.chosen_title, freeText: r.free_text })
            : null,
      };
    });
  }

  // --- internals ---------------------------------------------------------------

  private async requireTask(): Promise<TaskRecord> {
    const task = await this.deps.tasks.get(this.taskId);
    if (!task) {
      throw new AgentChannelError(
        `Aufgabe ${this.taskId} existiert nicht — die Sitzung wurde für eine Aufgabe ` +
          'gestartet, die es nicht (mehr) gibt.',
      );
    }
    return task;
  }

  /**
   * Append one non-lifecycle event.
   *
   * It carries the task's current state and resume point unchanged, which the
   * 0006 guard requires and which is the whole reason this cannot become a
   * transition by accident: an event whose `state` differs from the previous
   * one and whose kind is not `state_changed` is refused by the database.
   */
  private async append(
    task: TaskRecord,
    kind: 'finding_reported' | 'escalation_requested',
    payload: Record<string, unknown>,
  ): Promise<TaskRecord> {
    await this.deps.sql`
      INSERT INTO task_events
        (task_id, seq, kind, project_id, state, priority, resume_state, actor, payload)
      VALUES (
        ${task.id}, ${task.version + 1}, ${kind}, ${task.projectId}, ${task.state},
        ${task.priority}, ${task.resumeState}, ${this.role},
        ${this.deps.sql.json(payload as postgres.JSONValue)}
      )
    `;
    const updated = await this.deps.tasks.get(task.id);
    if (!updated) throw new AgentChannelError(`Aufgabe ${task.id} ist verschwunden`);
    return updated;
  }
}
