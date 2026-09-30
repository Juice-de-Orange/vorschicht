/**
 * §9's red policy — what happens to a task that did not get done.
 *
 * The rule is two sentences: "first red → back to queue with lower priority and
 * an attached 'learnings' note (what failed, hypothesis); second red →
 * escalation to the operator with the Debugger's diagnosis and MC options." Everything
 * below follows from them, plus three decisions they leave open.
 *
 * **What counts as red is decided before this module is called.** A run can end
 * five ways (A53.2) and only one of them is a failure of the *work*. An infra
 * failure retries, an auth incident parks, an interrupt parks. This module is
 * reached only by the fifth, and keeping the classification out of here is what
 * stops a bad Tuesday on the network from looking like fifteen broken tasks.
 *
 * **The count comes from the event log, not from a caller.** `retry_count` is
 * the number of `state_changed → red` rows the task already has, so "is this the
 * second failure" is a question about history rather than about what this
 * process happens to remember. An orchestrator restart between the two failures
 * changes nothing, which is the property that matters.
 *
 * **The Debugger runs after the transition to `red`, not before.** §9 attaches
 * a diagnosis to the escalation, and a diagnosis is a model session that can
 * itself fail, park or be interrupted. Ordering it after the state change means
 * a task whose diagnosis could not be produced is still correctly `escalated`
 * with the reason recorded — rather than sitting in `coding` with nobody
 * working on it because a second session went wrong.
 */
import {
  type EscalationOption,
  MAX_ESCALATION_CONTEXT_LENGTH,
  PRIORITIES,
  type Priority,
} from '@vorschicht/shared';
import { debuggerPrompt } from './dev-chain-prompts.js';
import type { EscalationService } from './escalation-service.js';
import type { EventLog } from './event-log.js';
import { AGENT_PROFILES } from './profiles/index.js';
import type { ProjectRecord } from './project-service.js';
import type { AgentRunner } from './runner.js';
import type { TaskRecord, TaskService } from './task-service.js';

/** One step less urgent, and never past the least urgent (§9). */
export function lowerPriority(priority: Priority): Priority {
  const index = PRIORITIES.indexOf(priority);
  return PRIORITIES[Math.min(index + 1, PRIORITIES.length - 1)] ?? priority;
}

/**
 * §9's second failure, in §15's format.
 *
 * §9 says the escalation carries "the Debugger's diagnosis and MC options", and
 * the Debugger produces neither options nor pros and cons — it produces a root
 * cause and a list of concrete followups. Deriving a pro and a con from a bare
 * followup string is not something that can be done honestly, so the options are
 * not derived from it: they are the three things the operator can actually do with a task
 * that has failed twice, each with the trade-off it really carries, and the
 * Debugger's findings go into the context where they belong.
 *
 * The recommendation depends on whether there is a diagnosis, and that is the
 * one judgement in here. With a root cause in hand a third attempt has something
 * the first two did not; without one, a retry is the same attempt again and
 * re-cutting the task is the only move that changes anything.
 */
export function redPathEscalation(input: {
  title: string;
  problem: string;
  diagnosis: string | null;
  diagnosisProblem: string | null;
  followups: readonly string[];
  retryCount: number;
}): { question: string; context: string; options: EscalationOption[] } {
  const hasDiagnosis = input.diagnosis !== null;
  // Every free-text part is clipped before assembly, and the whole is clipped
  // again as a backstop. Found by the test rather than foreseen: a task with a
  // long title and a thorough Debugger produced a card the service's own schema
  // refused, so §9's second failure would have left the task on `escalated`
  // with no card for the operator to answer — a warning line in a log, and silence.
  const title = clipText(input.title, 200);
  const context = clipText(
    [
      `Die Aufgabe „${title}“ ist ${input.retryCount} Mal gescheitert. ` +
        `Zuletzt: ${clipText(input.problem, 800)}`,
      hasDiagnosis
        ? `Die Fehlersuche kommt zu diesem Befund: ${clipText(input.diagnosis ?? '', 1_500)}`
        : `Es liegt kein Befund vor: ${clipText(input.diagnosisProblem ?? 'die Fehlersuche lief nicht', 400)}. ` +
          'Ein dritter Anlauf wüsste also nicht mehr als der zweite.',
      input.followups.length > 0
        ? `Vorgeschlagene Wege: ${clipText(input.followups.join('; '), 800)}`
        : 'Konkrete Vorschläge gibt es keine.',
      'Die Aufgabe hält ihre Dateiansprüche, bis du entscheidest (§15) — Aufgaben, die ' +
        'dieselben Pfade brauchen, warten so lange.',
    ].join(' '),
    MAX_ESCALATION_CONTEXT_LENGTH,
  );

  const options: EscalationOption[] = [
    {
      title: 'Erneut versuchen',
      pros: hasDiagnosis
        ? ['Der Befund der Fehlersuche liegt vor, der nächste Anlauf beginnt nicht bei null.']
        : ['Kostet nichts außer einem Durchlauf, falls der Fehlschlag äußere Gründe hatte.'],
      cons: hasDiagnosis
        ? ['Zwei Anläufe sind bereits gescheitert; der Befund kann falsch sein.']
        : ['Ohne Befund ist es derselbe Versuch noch einmal — vermutlich mit demselben Ende.'],
      recommended: hasDiagnosis,
    },
    {
      title: 'Aufgabe neu zuschneiden',
      pros: [
        'Ein kleinerer oder anders geschnittener Auftrag umgeht die Stelle, an der es ' +
          'zweimal hängen geblieben ist.',
      ],
      cons: ['Kostet eine neue Planung, und das ursprüngliche Ziel bleibt vorerst offen.'],
      recommended: !hasDiagnosis,
    },
    {
      title: 'Aufgabe abbrechen',
      pros: [
        'Gibt die Dateiansprüche frei; blockierte Aufgaben im selben Projekt laufen ' +
          'sofort weiter.',
      ],
      cons: ['Die bisherige Arbeit an dieser Aufgabe ist damit erledigt, das Ziel bleibt offen.'],
      recommended: false,
    },
  ];

  return {
    question: `Aufgabe „${title}“ ist zweimal gescheitert — wie soll es weitergehen?`,
    context,
    options,
  };
}

/**
 * Cut a free-text fragment and say that it was cut.
 *
 * Same rule `findingsNote` follows: a silently truncated text reads as a
 * complete one, and the operator deciding on a diagnosis whose second half is missing —
 * without being told it is missing — is worse than a longer card.
 */
function clipText(text: string, limit: number): string {
  const clean = text.trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}… (gekürzt)`;
}

export interface RedPathDeps {
  tasks: TaskService;
  eventLog: EventLog;
  /**
   * §15's inbox. Required, deliberately, unlike `runner` below.
   *
   * It could have been optional with a sensible fallback, and every existing
   * test would have gone on passing while §9's second failure quietly stopped
   * reaching the operator — the same trap `DevChainDeps.findings` was kept out of. An
   * optional dependency nobody passes is indistinguishable from a working one
   * from every vantage point inside this repository. The runner is optional for
   * a reason that does not apply here: its absence is *visible*, because the
   * escalation then says in so many words that no diagnosis was produced.
   *
   * A raise that fails at runtime is a different matter and is caught: §9's
   * point is that a failed task ends somewhere definite, so the transition to
   * `escalated` must not depend on a network call succeeding.
   */
  escalations: EscalationService;
  /**
   * Used for the Debugger diagnosis on the second failure. Optional, and the
   * absence is reported rather than hidden: a caller without a runner still
   * escalates correctly, it just escalates with "no diagnosis was produced"
   * where the diagnosis would have been.
   */
  runner?: AgentRunner;
  /** §9: a third failure would loop. Escalation is where the loop stops. */
  escalateAfter?: number;
  onWarning?(message: string): void;
}

export interface RedPathInput {
  task: TaskRecord;
  project: ProjectRecord;
  /** German, for the timeline and the inbox card (§2). */
  problem: string;
  /** What the failed attempt learned. Attached verbatim to the requeue note. */
  learnings?: readonly string[];
  /**
   * §5's findings behind this failure, if any (§11's pipeline).
   *
   * Ids rather than the findings themselves: the record already holds the
   * detail and the full output, and copying either into the timeline would
   * create a second wording of the same fact that nothing keeps in step. What
   * the timeline needs is the handle — which findings made this task come back
   * — so that the trace runs both ways.
   */
  findingIds?: readonly string[];
  /** Which role's run produced the failure, for the trace. */
  actor?: string;
  /** The worktree the Debugger would inspect. Null → no diagnosis is possible. */
  worktree?: { path: string; branch: string; baseBranch: string; baseSha: string } | null;
}

export interface RedPathResult {
  taskId: string;
  /** `requeued` on the first failure, `escalated` on the second (§9). */
  status: 'requeued' | 'escalated';
  /** How often this task has now gone red, counted from the event log. */
  retryCount: number;
  priority: Priority;
  /** The Debugger's root cause, or null with the reason in `diagnosisProblem`. */
  diagnosis: string | null;
  diagnosisProblem: string | null;
  /** Concrete ways forward the Debugger proposed — the seed of §15's options. */
  followups: string[];
  /**
   * §15's "#X", or null when the card could not be written.
   *
   * Null only on the escalation path and only when the inbox write itself
   * failed; `requeued` never has one, because a first failure goes back to the
   * queue rather than to the operator.
   */
  escalationNumber: number | null;
}

/**
 * The learnings note (§9), in German because it lands in the task timeline.
 *
 * Written as prose with the hypothesis kept separate from the fact: the next
 * session reads this before it re-plans, and "the build failed" plus "probably
 * the lockfile" are worth very different amounts to it.
 */
export function learningsNote(problem: string, learnings: readonly string[]): string {
  const lines = [`Fehlgeschlagen: ${problem}`];
  if (learnings.length > 0) {
    lines.push('', 'Was der Versuch gelernt hat:');
    for (const item of learnings) lines.push(`- ${item}`);
  }
  lines.push(
    '',
    'Die Aufgabe geht mit gesenkter Priorität zurück in die Warteschlange (§9). ' +
      'Der nächste Anlauf beginnt bei der Planung und sollte diese Notiz zuerst lesen.',
  );
  return lines.join('\n');
}

export class RedPath {
  constructor(private readonly deps: RedPathDeps) {}

  /**
   * Take a task down §9's red path and say where it ended up.
   *
   * Always transitions to `red` first, whatever happens afterwards. That is what
   * makes the count in the event log the truth: a task that failed and was then
   * requeued has one red row, and the next failure can tell it apart from a
   * first attempt without anyone passing a counter around.
   */
  async fail(input: RedPathInput): Promise<RedPathResult> {
    const { task, problem } = input;
    const actor = input.actor ?? 'orchestrator';

    const findingIds = [...(input.findingIds ?? [])];
    const red = await this.deps.tasks.transition(task.id, 'red', {
      actor,
      reason: problem,
      payload: { learnings: [...(input.learnings ?? [])], findingIds },
    });
    await this.deps.eventLog.append({
      kind: 'task.failed',
      actor,
      projectId: task.projectId,
      taskId: task.id,
      payload: { problem, retryCount: red.retryCount, findingIds },
    });

    const escalateAfter = this.deps.escalateAfter ?? 2;
    if (red.retryCount < escalateAfter) {
      return this.requeue(red, input);
    }
    return this.escalate(red, input);
  }

  /** First failure: lower the priority, attach the learnings, queue it again. */
  private async requeue(task: TaskRecord, input: RedPathInput): Promise<RedPathResult> {
    await this.deps.tasks.note(task.id, {
      text: learningsNote(input.problem, input.learnings ?? []),
      actor: input.actor ?? 'orchestrator',
      payload: {
        redPath: 'requeue',
        attempt: task.retryCount,
        findingIds: [...(input.findingIds ?? [])],
      },
    });

    const priority = lowerPriority(task.priority);
    await this.deps.tasks.reprioritise(task.id, priority, 'orchestrator');
    await this.deps.tasks.transition(task.id, 'queued', {
      actor: 'orchestrator',
      reason: `Erneuter Anlauf mit Priorität ${priority} (§9, Versuch ${task.retryCount + 1})`,
      payload: { redPath: 'requeue' },
    });

    return {
      taskId: task.id,
      status: 'requeued',
      retryCount: task.retryCount,
      priority,
      diagnosis: null,
      diagnosisProblem: null,
      followups: [],
      escalationNumber: null,
    };
  }

  /** Second failure: diagnose, then hand it to the operator with the diagnosis attached. */
  private async escalate(task: TaskRecord, input: RedPathInput): Promise<RedPathResult> {
    const diagnosis = await this.diagnose(task, input);

    const note = [
      `Zweiter Fehlschlag — die Aufgabe geht an dich (§9).`,
      '',
      `Letzter Fehler: ${input.problem}`,
      '',
      diagnosis.text
        ? `Befund der Fehlersuche:\n${diagnosis.text}`
        : `Keine Diagnose erstellt: ${diagnosis.problem}`,
      ...(diagnosis.followups.length > 0
        ? ['', 'Vorgeschlagene Wege:', ...diagnosis.followups.map((item) => `- ${item}`)]
        : []),
    ].join('\n');

    await this.deps.tasks.note(task.id, {
      text: note,
      actor: 'debugger',
      payload: {
        redPath: 'escalate',
        attempt: task.retryCount,
        diagnosis: diagnosis.text,
        followups: diagnosis.followups,
      },
    });
    await this.deps.tasks.transition(task.id, 'escalated', {
      actor: 'orchestrator',
      reason: `Zweiter Fehlschlag — Entscheidung nötig (§9)`,
      payload: { problem: input.problem, hasDiagnosis: diagnosis.text !== null },
    });

    const escalationNumber = await this.raiseInboxItem(task, input, diagnosis);

    await this.deps.eventLog.append({
      kind: 'task.escalated',
      actor: 'orchestrator',
      projectId: task.projectId,
      taskId: task.id,
      payload: {
        problem: input.problem,
        retryCount: task.retryCount,
        diagnosis: diagnosis.text,
        followups: diagnosis.followups,
        escalationNumber,
      },
    });

    return {
      taskId: task.id,
      status: 'escalated',
      retryCount: task.retryCount,
      priority: task.priority,
      diagnosis: diagnosis.text,
      diagnosisProblem: diagnosis.problem,
      followups: diagnosis.followups,
      escalationNumber,
    };
  }

  /**
   * The card the operator answers (§15), built from what the Debugger found.
   *
   * Wrapped, and the wrap is the point. §9 requires a twice-failed task to end
   * in a definite state, and it has already reached one by the time this runs —
   * so a database that is briefly unreachable must cost the *card*, not the
   * transition. The failure is reported through `onWarning` and recorded on the
   * `task.escalated` payload as a null number, which is a fact an audit can find
   * (§8.2's sixth domain: a task escalated with nobody to answer it).
   *
   * Raising after the transition rather than before is the same ordering §9
   * already uses for the diagnosis itself, and for the same reason.
   */
  private async raiseInboxItem(
    task: TaskRecord,
    input: RedPathInput,
    diagnosis: { text: string | null; problem: string | null; followups: string[] },
  ): Promise<number | null> {
    const card = redPathEscalation({
      title: task.title,
      problem: input.problem,
      diagnosis: diagnosis.text,
      diagnosisProblem: diagnosis.problem,
      followups: diagnosis.followups,
      retryCount: task.retryCount,
    });
    try {
      const escalation = await this.deps.escalations.raise({
        source: 'task_red',
        question: card.question,
        context: card.context,
        options: card.options,
        // §9's second failure blocks a task and holds its claims, and P1 is what
        // "The operator should look at this today" means in §15's scale. P0 is reserved
        // for the things that are on fire without him — a rollback, a leaked
        // credential, a billing change.
        urgency: 'P1',
        projectId: task.projectId,
        taskId: task.id,
        runId: null,
        raisedBy: 'orchestrator',
      });
      return escalation.number;
    } catch (error) {
      this.deps.onWarning?.(
        `Eskalation für Aufgabe ${task.id} konnte nicht ins Postfach gelegt werden: ` +
          `${(error as Error).message}. Die Aufgabe steht korrekt auf "escalated", ` +
          'aber es gibt keine Karte zum Beantworten.',
      );
      return null;
    }
  }

  /**
   * One read-only Debugger session over the failed worktree (§8 row 2a).
   *
   * Every failure mode here returns a *reason* rather than throwing. The
   * escalation is the point of this path; losing it because a diagnostic session
   * could not start would turn a task that needs a decision into a task nobody
   * is looking at.
   */
  private async diagnose(
    task: TaskRecord,
    input: RedPathInput,
  ): Promise<{ text: string | null; problem: string | null; followups: string[] }> {
    if (!this.deps.runner) {
      return { text: null, problem: 'Kein Runner konfiguriert', followups: [] };
    }
    const worktree = input.worktree;
    if (!worktree) {
      return {
        text: null,
        problem:
          'Die Aufgabe hat kein Arbeitsverzeichnis mehr — es gibt nichts zu untersuchen. ' +
          'Der Fehlschlag geschah vermutlich vor der Umsetzung.',
        followups: [],
      };
    }

    try {
      const outcome = await this.deps.runner.run({
        taskId: task.id,
        projectId: task.projectId,
        profile: AGENT_PROFILES.debugger,
        prompt: debuggerPrompt({
          task,
          project: input.project,
          worktree,
          problem: input.problem,
          retryCount: task.retryCount,
        }),
        cwd: worktree.path,
        // Read-only by construction: the profile grants no editing tool, and the
        // policy grants no write root either. Two layers saying the same thing,
        // because this session runs over a worktree whose state is already not
        // what anyone expected.
        containment: {
          writeRoot: null,
          claims: null,
          readOnlyProject: input.project.readOnly,
        },
      });

      if (outcome.status !== 'ok') {
        return { text: null, problem: outcome.problem, followups: [] };
      }
      return {
        text: outcome.result.summary,
        problem: null,
        followups: [...outcome.result.followups],
      };
    } catch (error) {
      const problem = `Fehlersuche nicht möglich: ${(error as Error).message}`;
      this.deps.onWarning?.(problem);
      return { text: null, problem, followups: [] };
    }
  }
}
