/**
 * The task prompts of the dev chain (§6.2's `claude -p "<task prompt>"`).
 *
 * The *role* prompt lives in `profiles/prompts.ts` and says what a Planner is.
 * This file says what *this* Planner is being asked to do, and the split is not
 * cosmetic: the role prompt is `--append-system-prompt` and identical for every
 * run, so it is cache-friendly and reviewable as a diff, while everything below
 * changes per task and belongs in the turn.
 *
 * Three rules shaped these texts.
 *
 * **Everything load-bearing is in the prompt, not only in MCP.** A session can
 * call `task.get_context`, and it should — but a server that lost the startup
 * race leaves the first turn without tools (A49), and a run spawned with no MCP
 * at all is a degraded run rather than a failed one. A Coder that learns its
 * claim set only through a tool call is a Coder that sometimes does not learn it.
 * So the mandate, the acceptance criteria, the plan and the claim set are
 * written out; the tools are for what changes *during* the session.
 *
 * **The handover between roles is explicit.** §8.1 chains three sessions that
 * share no context: the Coder never sees the Planner's session and the Reviewer
 * never sees the Coder's. What crosses the boundary is exactly what is written
 * here, so anything a later role needs has to be carried deliberately.
 *
 * **English, per §2** — agents work in English; only what is addressed to the operator
 * is German.
 */
import type { PlannerResult, ReviewerResult } from '@vorschicht/shared';
import { type BriefableFinding, findingsBriefing } from './findings.js';
import type { ProjectRecord } from './project-service.js';
import type { TaskRecord } from './task-service.js';

/** What a review round handed back to the Coder. */
export interface ReviewFeedback {
  round: number;
  verdict: ReviewerResult['verdict'];
  summary: string;
  findings: ReviewerResult['findings'];
  /**
   * Paths the orchestrator itself found outside the claim set (§10).
   *
   * Separate from `findings` because these are not the Reviewer's opinion: they
   * are a diff compared against the registered globs. A Coder told "your change
   * is outside the claims" by a machine argues with it less than one told the
   * same thing by another model.
   */
  outOfClaims: string[];
}

export interface ChainPromptContext {
  task: TaskRecord;
  project: ProjectRecord;
  worktree: { path: string; branch: string; baseBranch: string; baseSha: string };
  /**
   * §11's open findings against this task — the middle arrow of "finding → fix
   * task → gate re-run".
   *
   * Empty on a first attempt and non-empty on every pass after a refused merge.
   * It is part of the shared context rather than an argument to one role
   * because all three need it for different reasons: the Planner has to plan
   * the fix (and claim the paths it will touch), the Coder has to make it, and
   * the Reviewer has to check it was made rather than routed around. A Planner
   * that does not know why the task came back produces the same plan again,
   * which is what a requeue looked like before this existed.
   */
  openFindings?: readonly BriefableFinding[];
}

/** The findings block, or nothing at all on a first attempt. */
function findingsSection(context: ChainPromptContext): string[] {
  const lines = findingsBriefing(context.openFindings ?? []);
  return lines.length > 0 ? ['', ...lines] : [];
}

const bullets = (items: readonly string[]): string =>
  items.length > 0 ? items.map((item) => `- ${item}`).join('\n') : '- (none given)';

const numbered = (items: readonly string[]): string =>
  items.map((item, index) => `${index + 1}. ${item}`).join('\n');

/**
 * The task block every role starts from.
 *
 * `description` and `acceptanceCriteria` are what A48.3 added to the task model,
 * and the reason is visible here: without them a role prompt can only offer a
 * title, and a title is not a mandate. A task with no acceptance criteria says
 * so out loud rather than letting a session infer that none exist.
 */
export function mandateBlock(context: ChainPromptContext): string {
  const { task, project, worktree } = context;
  return [
    `# Task ${task.id}`,
    '',
    `**Title:** ${task.title}`,
    `**Project:** ${project.name} (${project.slug}), integration branch \`${worktree.baseBranch}\``,
    `**Priority:** ${task.priority}`,
    '',
    '## What is wanted',
    '',
    task.description?.trim() ||
      '(No description was recorded. Work from the title and the acceptance criteria, ' +
        'and say in your result if that is not enough to proceed responsibly.)',
    '',
    '## Acceptance criteria — this is what "done" means',
    '',
    task.acceptanceCriteria.length > 0
      ? numbered(task.acceptanceCriteria)
      : '(None were recorded. Treat that as a planning gap and name it in your result.)',
    '',
    '## Where you are',
    '',
    `You are in this task's own git worktree at \`${worktree.path}\`, on branch`,
    `\`${worktree.branch}\`, cut from \`${worktree.baseBranch}\` at commit`,
    `\`${worktree.baseSha.slice(0, 12)}\`. Nothing you do here affects any other task.`,
  ].join('\n');
}

/** §8.1 step 1. */
export function plannerPrompt(context: ChainPromptContext): string {
  const findings = context.openFindings ?? [];
  return [
    mandateBlock(context),
    ...findingsSection(context),
    '',
    '## Your job now',
    '',
    'Read the repository around this task before you plan anything: the code it will',
    'change, the tests that cover it, the conventions the project already follows.',
    'Then produce the plan, the claim set, the test plan and the risks.',
    '',
    'The Coder who executes this plan will not see this session, will not be able to',
    'ask you anything, and can only write inside the globs you claim. Anything you',
    'leave implicit becomes a guess someone else makes.',
    ...(findings.length > 0
      ? [
          '',
          'This is not a first attempt. The plan you produce has to clear the findings',
          'above as well as meet the acceptance criteria, and the claim set has to cover',
          'every path a fix will touch — a fix that needs a file you did not claim is',
          'refused before it runs, and the task comes straight back here.',
        ]
      : []),
  ].join('\n');
}

export interface CoderPromptInput extends ChainPromptContext {
  plan: PlannerResult;
  /** The globs actually granted (§10). Normally identical to the plan's. */
  claims: readonly string[];
  /** Empty on the first round; §8.1 step 3 sends the diff back with findings. */
  feedback?: ReviewFeedback;
}

/** §8.1 step 2. */
export function coderPrompt(input: CoderPromptInput): string {
  const sections = [
    mandateBlock(input),
    ...findingsSection(input),
    '',
    '## The plan you are implementing',
    '',
    numbered(input.plan.plan),
    '',
    '## What proves it correct',
    '',
    bullets(input.plan.testPlan),
    '',
    '## Risks the Planner named',
    '',
    bullets(input.plan.risks),
    '',
    '## The files you may write',
    '',
    bullets(input.claims),
    '',
    'These globs are the whole of your write access. A write outside them is refused',
    'before the tool runs, and routing around the refusal is itself reported. If the',
    'plan cannot be carried out inside them, stop and say so in your result — that is',
    'a planning gap, and re-planning is cheaper than an unreviewable diff.',
  ];

  if (input.feedback) {
    sections.push(
      '',
      `## Review round ${input.feedback.round}: changes were requested`,
      '',
      'A reviewer read your previous diff and did not approve it. Every finding below',
      'is a blocker — this system has no severity beneath that. Fix each one, and if',
      'you believe a finding is wrong, say why in your result rather than ignoring it.',
      '',
      input.feedback.summary.trim(),
      '',
      ...(input.feedback.findings.length > 0
        ? [
            '### Findings',
            '',
            input.feedback.findings
              .map(
                (finding) =>
                  `- \`${finding.file}${finding.line ? `:${finding.line}` : ''}\` — ${finding.summary}`,
              )
              .join('\n'),
          ]
        : ['### Findings', '', '- (The reviewer requested changes without naming a file.)']),
      ...(input.feedback.outOfClaims.length > 0
        ? [
            '',
            '### Paths changed outside your claim set',
            '',
            'These were found by comparing the diff against the registered globs — they',
            'are a fact about the working copy, not an opinion. Revert them.',
            '',
            bullets(input.feedback.outOfClaims),
          ]
        : []),
    );
  }

  return sections.join('\n');
}

export interface ReviewerPromptInput extends ChainPromptContext {
  plan: PlannerResult;
  claims: readonly string[];
  /** What the Coder said it did. An assertion under examination, not an input. */
  coderSummary: string;
  round: number;
}

/**
 * §8.1 step 3.
 *
 * The Coder's summary is included and explicitly labelled as a claim to check.
 * Leaving it out would be the safer-looking choice, and it is the wrong one: a
 * reviewer who cannot see what was asserted cannot report the divergence between
 * the assertion and the diff, which is the single most common defect shape this
 * project has caught (§8.2's opening paragraph).
 */
export function reviewerPrompt(input: ReviewerPromptInput): string {
  const findings = input.openFindings ?? [];
  return [
    mandateBlock(input),
    ...findingsSection(input),
    ...(findings.length > 0
      ? [
          '',
          'Those findings are why this task came back. Check specifically that each one is',
          'genuinely addressed and not merely made to pass — a disabled test, a widened',
          'lint exception or a skipped check clears a gate without fixing anything, and',
          'catching that is a thing only a reader can do.',
        ]
      : []),
    '',
    '## The diff you are reviewing',
    '',
    `Everything on this branch since \`${input.worktree.baseSha.slice(0, 12)}\`. Start with:`,
    '',
    '```',
    `git diff --stat ${input.worktree.baseSha}`,
    `git diff ${input.worktree.baseSha}`,
    '```',
    '',
    'Uncommitted changes in the working copy are part of the diff too — compare',
    'against the commit above, not against HEAD.',
    '',
    '## The claim set this task holds',
    '',
    bullets(input.claims),
    '',
    'Every changed path must be inside these globs. Report `claimsRespected`',
    'independently of your verdict; that answer is needed even when everything else',
    'is fine.',
    '',
    '## The plan this was supposed to implement',
    '',
    numbered(input.plan.plan),
    '',
    '## What the Coder says it did',
    '',
    'Read this **after** you have read the diff. It is a claim you are checking, not',
    'a description you can rely on.',
    '',
    input.coderSummary.trim() || '(The Coder recorded no summary.)',
    ...(input.round > 1
      ? [
          '',
          `## This is review round ${input.round}`,
          '',
          'Earlier findings on this task are in `task.get_context`. Check specifically',
          'that each one was actually addressed rather than worked around.',
        ]
      : []),
  ].join('\n');
}

export interface DebuggerPromptInput extends ChainPromptContext {
  /** Why the task went red, in the orchestrator's words. */
  problem: string;
  /** How often it has failed now (§9: the second failure escalates). */
  retryCount: number;
}

/**
 * §8 row 2a, the diagnosis attached to a second-red escalation (§9).
 *
 * Written for a reader who is not the next agent: this text becomes the body of
 * an inbox card the operator reads (§15), so the Debugger is told who its audience is.
 */
export function debuggerPrompt(input: DebuggerPromptInput): string {
  return [
    mandateBlock(input),
    '',
    '## Why you were called',
    '',
    `This task has now failed ${input.retryCount} time(s). The orchestrator's account of`,
    'the most recent failure:',
    '',
    `> ${input.problem.replace(/\n/g, '\n> ')}`,
    '',
    'Earlier attempts left their notes, findings and state history on the task —',
    'read them through `task.get_context` before forming a view.',
    '',
    '## What is wanted from you',
    '',
    'A root cause, reproduced rather than reasoned about, with the evidence that',
    'supports it. You fix nothing. Your summary becomes the body of a decision card',
    'that the operator reads, so state what is actually wrong, what you verified, and what you',
    'could not determine — and put each concrete way forward in `followups`.',
    '',
    'If the evidence does not support a single root cause, say that instead of',
    'choosing the most plausible one.',
  ].join('\n');
}

export interface IntegrityPromptInput extends ChainPromptContext {
  /** Why the task was interrupted, as the record has it. German or English. */
  reason: string;
  /** How often this task has been interrupted, from its own history. */
  interruptCount: number;
}

/**
 * §7.2's mandatory re-check: is this worktree still in a state work can resume in?
 *
 * A different question from the Debugger's usual one, and the prompt says so.
 * §9's Debugger asks *why did this fail*; this asks *what did the stop leave
 * behind* — which is a question about the filesystem and about git, answerable
 * from evidence, with no judgement about the work itself. A session that starts
 * reasoning about whether the feature was a good idea has misread its mandate.
 *
 * The verdict travels in `status`, which is what makes it mechanically readable:
 * `done` means resume, anything else means do not. That mapping is stated here
 * in the prompt rather than inferred at the call site, because the field is
 * shared with every other role and its meaning here is narrower than usual.
 */
export function integrityPrompt(input: IntegrityPromptInput): string {
  return [
    mandateBlock(input),
    '',
    '## Why you were called',
    '',
    'This task was **interrupted** — a budget hard stop (§7.2), an operator pause or',
    'an orchestrator restart stopped its session part-way through. The account on',
    'record:',
    '',
    `> ${input.reason.replace(/\n/g, '\n> ')}`,
    '',
    `It has been interrupted ${input.interruptCount} time(s). Nothing may move this task`,
    'until you have verified what the stop left behind. That is the whole of your',
    'mandate — you are not reviewing the work, and you are not fixing anything.',
    '',
    '## What to check',
    '',
    'Establish, from evidence rather than from the notes:',
    '',
    '1. Is the working tree in a state git can operate on — no rebase, merge, cherry-pick',
    '   or bisect in progress, no index lock left behind?',
    `2. Is HEAD still on \`${input.worktree.branch}\`, and does the branch still descend from`,
    `   \`${input.worktree.baseSha}\` on \`${input.worktree.baseBranch}\`?`,
    '3. Are uncommitted changes coherent, or is a file half-written — a truncated source',
    '   file, an unterminated string, a partially applied edit?',
    '4. Does anything on disk contradict the task notes about where the work stood?',
    '',
    '## What is wanted from you',
    '',
    '**`status: "done"`** — the worktree is sound and work may resume. Say in `summary`',
    'what you checked and what you found, including the uncommitted changes, so the',
    'session that picks this up knows where it stands.',
    '',
    '**`status: "failed"`** — the worktree cannot be resumed into. Say exactly what is',
    "wrong and how you established it. The task takes §9's red path; a fresh attempt",
    'starts from planning. Choose this when you are unsure: a wrong "sound" verdict',
    'sends a coder into a broken tree, a wrong "broken" verdict costs one re-plan.',
    '',
    'Report nothing in `artifacts`. Put anything worth doing about it in `followups`.',
  ].join('\n');
}
