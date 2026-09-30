/**
 * §11's migration gate — Milo, inside a gate run (A63).
 *
 * This is the first gate in the system that is an **agent session**. Every other
 * one is a command the project supplies or a question Vorschicht answers from
 * git and the event log; this one asks whether a schema change is safe, which is
 * a judgement and not a query. Five decisions shaped it, and each of them was
 * available in a weaker form:
 *
 *  1. **A session is spawned only when the candidate touches a migration.** The
 *     detection is a glob match against `migrationGlobs(config)` and it happens
 *     in the gate suite, before anything here is called. A gate that started a
 *     strong-tier session on every merge of every project with the box ticked
 *     would cost more than it protects, and the cost would be invisible until a
 *     budget report.
 *
 *  2. **The session cannot write.** `db-review` is its own profile with no
 *     editing tools and no `git add`, for the reason §8.1 gives the Reviewer: a
 *     gate that can change the tree it is judging is not a gate.
 *
 *  3. **The merge verdict and the deploy verdict are separate answers.** §11
 *     makes a finding a blocker; §12/A24 makes a non-backward-compatible
 *     migration stop the *deploy* and escalate rather than blocking the merge,
 *     because a rollback restores code and cannot undo what a migration did to
 *     the data. Both facts come back in one result and are consumed by two
 *     different components at two different times — which is why the result is
 *     written to the event log as its own kind rather than folded into the gate
 *     summary.
 *
 *  4. **The consequence of `reversibility` is derived here, not asked for.** §23
 *     makes "reversible or explicitly documented" a definition-of-done item, so
 *     `undocumented` blocks whatever the reviewer's own verdict said. Asking the
 *     model for the conclusion instead of the observation is the weaker form
 *     A54.2 already rejected for `claimsRespected`; and where the two disagree —
 *     approve, but undocumented — the divergence is recorded rather than
 *     silently resolved in the model's favour.
 *
 *  5. **An unrunnable review is an infra failure, never a pass.** A25: a session
 *     that could not start proves nothing about the migration, and a gate that
 *     reported that as green would be worse than no gate, because it reads as
 *     covered.
 */
import type {
  MigrationReviewResult,
  migrationReversibilitySchema,
  ProjectGateConfig,
} from '@vorschicht/shared';
import { globMatchesPath, migrationGlobs } from '@vorschicht/shared';
import type { z } from 'zod';
import type { EventLog } from './event-log.js';
import { AGENT_PROFILES } from './profiles/index.js';
import type { AgentRunner } from './runner.js';

export type MigrationReversibility = z.infer<typeof migrationReversibilitySchema>;

/** Which of the candidate's changed files are migrations (§11, A24). */
export function selectMigrations(config: ProjectGateConfig, changed: readonly string[]): string[] {
  const globs = migrationGlobs(config);
  return changed.filter((path) => globs.some((glob) => globMatchesPath(glob, path)));
}

export interface MigrationReviewInput {
  /** The rebased worktree — the tree that will become the integration branch. */
  cwd: string;
  taskId: string;
  projectId: string | null;
  /** The integration branch, so the session can diff against the right thing. */
  baseRef: string;
  /** The migration files this candidate touches, repository-relative. */
  migrations: readonly string[];
  /** Everything the candidate changes, so the review sees the code around it. */
  changedFiles: readonly string[];
  /** A41 — an analysed-only project. Passed through to the runner unchanged. */
  readOnlyProject: boolean;
}

export type MigrationReviewReport =
  /** The session ran and its result satisfies the contract. */
  | { status: 'reviewed'; result: MigrationReviewResult; runId: string }
  /** A25: the harness failed. Nothing was proven; retry, never red. */
  | { status: 'infra'; problem: string }
  /** The session ran and did not deliver a usable review. §11: blocks. */
  | { status: 'failed'; problem: string };

/**
 * What the gate suite needs from this component.
 *
 * Structural, like `SecretScanner`: it keeps the runner, the profile table and
 * the model backend out of the gate suite's import graph, and it lets a test
 * drive the gate's own decisions without a database.
 */
export interface MigrationReviewer {
  review(input: MigrationReviewInput): Promise<MigrationReviewReport>;
}

/** The task prompt (§6.2). English — agents work in English (§2). */
export function migrationReviewPrompt(input: MigrationReviewInput): string {
  const lines = [
    'A merge candidate in this repository touches one or more database migrations,',
    'and you are the gate in front of it.',
    '',
    `Integration branch: ${input.baseRef}`,
    `The change is everything between \`git merge-base ${input.baseRef} HEAD\` and HEAD.`,
    '',
    'Migrations in this change:',
    ...input.migrations.map((path) => `  - ${path}`),
    '',
  ];

  const others = input.changedFiles.filter((path) => !input.migrations.includes(path));
  if (others.length > 0) {
    lines.push(
      'Other files this change touches — read the ones that talk to the tables you',
      'are looking at, because whether the running release survives the new schema',
      'is a question about them:',
      ...others.slice(0, 60).map((path) => `  - ${path}`),
    );
    if (others.length > 60) lines.push(`  … and ${others.length - 60} more`);
    lines.push('');
  }

  lines.push(
    'Read the migrations, the diff and enough of the surrounding code to answer.',
    'Then fill the result contract. Two answers, deliberately separate:',
    '',
    '  - `verdict` decides whether this may merge. `changes_requested` blocks it.',
    '  - `backwardCompatible` decides whether it may deploy unattended. False does',
    '    not block the merge; it routes the deploy to the operator instead (§12).',
    '',
    'Also state `reversibility` and list in `migrations` the files you actually read.',
    'You have no editing tools: everything you would change is a finding.',
  );
  return lines.join('\n');
}

export interface AgentMigrationReviewerDeps {
  runner: AgentRunner;
  /**
   * Where the result is recorded, so the deploy engine can find it (§12/A24).
   *
   * Optional only so a test can construct the reviewer without one; in the
   * daemon it is not optional in any meaningful sense — without it a
   * non-backward-compatible migration merges and leaves no trace of the fact
   * that anybody noticed.
   */
  eventLog?: EventLog;
  onWarning?(message: string): void;
}

/** The real thing: one `db-review` session over the rebased tree. */
export class AgentMigrationReviewer implements MigrationReviewer {
  constructor(private readonly deps: AgentMigrationReviewerDeps) {}

  async review(input: MigrationReviewInput): Promise<MigrationReviewReport> {
    const outcome = await this.deps.runner.run({
      taskId: input.taskId,
      projectId: input.projectId ?? null,
      profile: AGENT_PROFILES['db-review'],
      prompt: migrationReviewPrompt(input),
      cwd: input.cwd,
      // Read-only, twice over: the profile carries no mutating tool, and the
      // containment policy grants no write root. §6.6 asks for exactly that
      // pairing — the hook refuses what the whitelist already does not offer.
      containment: {
        writeRoot: null,
        claims: null,
        readOnlyProject: input.readOnlyProject,
      },
    });

    if (outcome.status === 'ok') {
      await this.record(input, outcome.result, outcome.run.runId);
      return { status: 'reviewed', result: outcome.result, runId: outcome.run.runId };
    }
    // Everything that is not a delivered review is the harness, except an
    // outright failure: an auth incident and an interrupt both mean the tree was
    // not examined, and §11's honest answer for "not examined" is not "green".
    // The suite turns `infra` into A25's retry; only `failed` blocks.
    if (outcome.status === 'failed') {
      return { status: 'failed', problem: outcome.problem };
    }
    return { status: 'infra', problem: outcome.problem };
  }

  private async record(
    input: MigrationReviewInput,
    result: MigrationReviewResult,
    runId: string,
  ): Promise<void> {
    if (!this.deps.eventLog) return;
    try {
      await this.deps.eventLog.append({
        kind: 'gate.migration_review',
        actor: 'db-review',
        taskId: input.taskId,
        projectId: input.projectId ?? null,
        runId,
        payload: {
          verdict: result.verdict,
          // §12/A24 reads this one. Named at the top level rather than nested in
          // the result, so the deploy engine's query is a column and not a path
          // through a JSON document that may be reshaped.
          backwardCompatible: result.backwardCompatible,
          reversibility: result.reversibility,
          migrations: result.migrations,
          reviewed: input.migrations,
          findings: result.findings,
          summary: result.summary,
        },
      });
    } catch (error) {
      // The review itself stands. Losing the row costs the deploy engine its
      // input, which is worth a loud warning and not worth discarding a gate run
      // that already spent a session.
      this.deps.onWarning?.(
        `Migrationsprüfung konnte nicht protokolliert werden: ${(error as Error).message}`,
      );
    }
  }
}
