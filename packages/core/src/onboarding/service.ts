/**
 * §20's onboarding flow — analysis, proposal, and only then a project.
 *
 * §20 describes one flow with a dry-run *mode*. This is built as **two
 * methods**, and that is the load-bearing decision in the file.
 *
 * `propose()` cannot create a project. Not "does not when the flag is set" —
 * cannot: it has no `ProjectService`, so there is no line of code that would
 * write a row. `apply()` takes a proposal that has already been verified and an
 * actor who approved it. A boolean parameter would put both behaviours in one
 * method and make A41's boundary — the pilot project is analysed, never written to —
 * depend on every future caller passing it correctly. This is the same reasoning
 * that kept `FindingsService` from having a `resolve()` (A69): a code path that
 * does not exist cannot be reached by mistake.
 *
 * What "no writes" means precisely, because the phrase is doing work: nothing is
 * written **to the analysed repository**. Vorschicht's own record of the
 * analysis — the `agent_runs` row, the transcript, the `onboarding.proposed`
 * event — is written in full, because §18's traceability applies to an analysis
 * exactly as it applies to a merge, and an unrecorded proposal is one nobody can
 * check afterwards.
 *
 * The session itself is contained twice over, in the pattern A63 established for
 * the migration reviewer: the profile carries no mutating tool, and the run's
 * containment policy grants no write root at all.
 */
import type { OnboardingResult } from '@vorschicht/shared';
import type { EventKind, EventLog } from '../event-log.js';
import { AGENT_PROFILES } from '../profiles/index.js';
import type { CreateProjectSpec, ProjectRecord, ProjectService } from '../project-service.js';
import type { AgentRunner } from '../runner.js';
import { onboardingPrompt } from './prompt.js';
import type { StoredProposal } from './proposals.js';
import { type RepositorySurvey, surveyRepository } from './survey.js';
import { type VerifiedProposal, verifyProposal } from './verify.js';

export interface ProposeSpec {
  /** Absolute path of the repository, as the orchestrator container sees it. */
  rootPath: string;
  /** The slug the project would get. Also how the report is named. */
  slug: string;
  /** A41 — analysed, never written to. Passed to the runner and to the prompt. */
  readOnly: boolean;
  /**
   * The display name, carried into `onboarding.proposed` so `applyFromRun`
   * needs nothing from a command line.
   *
   * Without it the second call would have to be told the name again, and a
   * proposal applied under a different name than the one the operator read is exactly
   * the divergence this whole path exists to close. Optional because the older
   * rows do not have it — and `applyFromRun` refuses those rather than guessing.
   */
  name?: string;
}

export type OnboardingProposal =
  | {
      status: 'proposed';
      slug: string;
      survey: RepositorySurvey;
      result: OnboardingResult;
      verification: VerifiedProposal;
      runId: string;
    }
  /** A25: the harness failed. Nothing was analysed; retry, never red. */
  | { status: 'infra'; slug: string; survey: RepositorySurvey; problem: string }
  /** The session ran and did not deliver a usable proposal. */
  | { status: 'failed'; slug: string; survey: RepositorySurvey; problem: string };

export interface OnboardingServiceDeps {
  /**
   * The session `propose` runs. Optional, because `applyFromRun` has no use for
   * one: applying a proposal a person has read is a database read and a write,
   * and requiring a model access path for it would be a precondition that path
   * does not have. `propose` refuses without it rather than failing on a null.
   */
  runner?: AgentRunner;
  eventLog?: EventLog;
  /**
   * Where the read-only session runs. Must exist; the runner refuses otherwise.
   *
   * Optional for the same reason as `runner` above: `applyFromRun` starts no
   * session, so a scratch directory is a precondition it does not have.
   * `propose` checks both together and says which is missing.
   */
  scratchDir?: string;
  onWarning?(message: string): void;
}

export class OnboardingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OnboardingError';
  }
}

export class OnboardingService {
  constructor(private readonly deps: OnboardingServiceDeps) {}

  /**
   * §20's dry run: survey the repository, ask for a proposal, check it.
   *
   * Never touches the analysed repository and never creates a project.
   */
  async propose(spec: ProposeSpec): Promise<OnboardingProposal> {
    const survey = await surveyRepository(spec.rootPath);

    if (!this.deps.runner || this.deps.scratchDir === undefined) {
      const fehlt = !this.deps.runner ? 'einen Runner' : 'ein Scratch-Verzeichnis';
      throw new OnboardingError(
        `Für einen Trockenlauf braucht dieser Dienst ${fehlt} — er ist nur zum Übernehmen ` +
          'eines gelesenen Vorschlags ohne beides gebaut worden (§20).',
      );
    }
    const outcome = await this.deps.runner.run({
      // No task: this analysis serves none, and a run without a task runs
      // without MCP (A56.5) — every tool the internal server registers is either
      // task-scoped or a Phase 6 stub, so a session handed them would spend
      // turns discovering they answer nothing.
      taskId: null,
      projectId: null,
      profile: AGENT_PROFILES.onboarding,
      prompt: onboardingPrompt({ survey, slug: spec.slug, readOnly: spec.readOnly }),
      cwd: this.deps.scratchDir,
      containment: {
        // No write root at all: the session's own scratch directory is not
        // writable to it either. It reads and it answers.
        writeRoot: null,
        claims: null,
        // Deliberately *not* `spec.readOnly`. A41's flag says whether the
        // studio may ever write to this project; an onboarding analysis may not
        // write to any project, read-only or not, so passing the flag through
        // would make containment depend on a property that is about something
        // else. The runner refuses a writing profile under this flag, and this
        // profile does not write in either case.
        readOnlyProject: true,
      },
    });

    if (outcome.status !== 'ok') {
      const problem = outcome.problem;
      await this.record('onboarding.failed', spec, {
        status: outcome.status,
        problem,
        runId: outcome.run.runId,
      });
      // Only an outright failure is the work; everything else is the harness.
      // An auth incident and an interrupt both mean the repository was not read,
      // and the honest answer for "not read" is not "here is a proposal".
      return outcome.status === 'failed'
        ? { status: 'failed', slug: spec.slug, survey, problem }
        : { status: 'infra', slug: spec.slug, survey, problem };
    }

    const verification = verifyProposal(survey, outcome.result);
    await this.record('onboarding.proposed', spec, {
      name: spec.name ?? spec.slug,
      runId: outcome.run.runId,
      ok: verification.ok,
      errors: verification.errors,
      notes: verification.notes,
      deferred: verification.deferred,
      commands: verification.commands,
      missingCommands: verification.missingCommands,
      defaultBranch: verification.defaultBranch,
      claimGranularity: verification.claimGranularity,
      deployConfig: verification.deployConfig,
      gateConfig: verification.config,
      result: outcome.result,
    });

    return {
      status: 'proposed',
      slug: spec.slug,
      survey,
      result: outcome.result,
      verification,
      runId: outcome.run.runId,
    };
  }

  /**
   * §20's last step: the confirmed proposal becomes a project.
   *
   * Separate from `propose()` and separately callable, because §20 puts a human
   * decision between them. `actor` is who approved it and lands in `audit_log`
   * through `ProjectService.create`; there is deliberately no default, so a
   * caller cannot create a project that nobody appears to have approved.
   */
  /**
   * Apply the proposal a session produced and a person has read (§20).
   *
   * **No model session.** That is the whole point: `propose()` and `apply()` in
   * one process meant the thing the operator confirmed and the thing applied were only
   * ever the same by luck — a second run is a second session, free to answer
   * differently. Everything below comes from `onboarding.proposed`, which has
   * carried it all along and which nobody read back (§8.2's sixth domain, in
   * the flow whose entire purpose is a human decision).
   *
   * Fail closed in three places, all of them refusals rather than defaults: no
   * row for that run, a proposal that was not `ok`, and a row too old to carry
   * the name. Guessing any of the three would produce a project that differs
   * from the document the operator read, which is the failure this closes.
   */
  async applyFromRun(
    projects: ProjectService,
    proposals: { byRun(runId: string): Promise<StoredProposal | null> },
    runId: string,
    actor: string,
  ): Promise<ProjectRecord> {
    const stored = await proposals.byRun(runId);
    if (!stored) {
      throw new OnboardingError(
        `Zu Lauf „${runId}" gibt es keinen übernehmbaren Vorschlag im Ereignisprotokoll. ` +
          'Entweder hat der Trockenlauf nie stattgefunden, oder seine Zeile stammt aus einer ' +
          'Zeit, in der der Anzeigename noch nicht mitgeschrieben wurde — beides wird ' +
          'verweigert statt geraten, weil ein Projekt sonst unter einem Namen entstünde, ' +
          'der in keinem Vorschlag steht.',
      );
    }
    if (!stored.verification.ok) {
      throw new OnboardingError(
        `Der Vorschlag aus Lauf „${runId}" war nicht übernehmbar und ist es weiterhin nicht:\n` +
          stored.verification.errors.map((line) => `- ${line}`).join('\n'),
      );
    }
    return this.apply(
      projects,
      {
        slug: stored.slug,
        name: stored.name,
        rootPath: stored.rootPath,
        readOnly: stored.readOnly,
        verification: stored.verification,
        runId: stored.runId,
      },
      actor,
    );
  }

  async apply(projects: ProjectService, input: ApplyInput, actor: string): Promise<ProjectRecord> {
    if (!actor.trim()) {
      throw new OnboardingError(
        'Ein Projekt wird nie ohne benannten Freigebenden angelegt (§19, §20).',
      );
    }
    if (!input.verification.ok || !input.verification.config) {
      throw new OnboardingError(
        `Der Vorschlag für „${input.slug}" ist nicht übernehmbar:\n` +
          input.verification.errors.map((line) => `- ${line}`).join('\n'),
      );
    }
    if (!input.verification.defaultBranch) {
      throw new OnboardingError(
        `Für „${input.slug}" ist kein Integrationszweig bestimmt. §10 schneidet jeden ` +
          'Task-Zweig davon ab; ein geratener Standard wäre genau dort falsch, wo es teuer wird.',
      );
    }
    const existing = await projects.getBySlug(input.slug);
    if (existing) {
      throw new OnboardingError(`Ein Projekt mit dem Kürzel „${input.slug}" existiert bereits.`);
    }

    const spec: CreateProjectSpec = {
      slug: input.slug,
      name: input.name,
      rootPath: input.rootPath,
      gateConfig: input.verification.config as unknown as Record<string, unknown>,
      deployConfig: input.verification.deployConfig,
      claimGranularity: input.verification.claimGranularity,
      readOnly: input.readOnly,
      selfManaged: input.selfManaged ?? false,
      // §10 cuts every task branch from this, so a missing answer is not a
      // default worth guessing: `main` is right often enough to be dangerous.
      ...(input.verification.defaultBranch
        ? { defaultBranch: input.verification.defaultBranch }
        : {}),
      ...(input.repoUrl ? { repoUrl: input.repoUrl } : {}),
    };

    const project = await projects.create(spec, actor);
    await this.record(
      'onboarding.applied',
      { rootPath: input.rootPath, slug: input.slug, readOnly: input.readOnly },
      {
        projectId: project.id,
        actor,
        runId: input.runId ?? null,
        deferred: input.verification.deferred,
        missingCommands: input.verification.missingCommands,
      },
    );
    return project;
  }

  private async record(
    kind: EventKind,
    spec: ProposeSpec,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!this.deps.eventLog) return;
    try {
      await this.deps.eventLog.append({
        kind,
        actor: 'onboarding',
        taskId: null,
        projectId: null,
        payload: { slug: spec.slug, rootPath: spec.rootPath, readOnly: spec.readOnly, ...payload },
      });
    } catch (error) {
      // The proposal stands. Losing the row costs traceability for this
      // analysis and is worth a loud warning; discarding a finished analysis
      // over a logging failure would cost the session that produced it.
      this.deps.onWarning?.(
        `Onboarding-Ereignis "${kind}" konnte nicht protokolliert werden: ${(error as Error).message}`,
      );
    }
  }
}

export interface ApplyInput {
  slug: string;
  name: string;
  rootPath: string;
  readOnly: boolean;
  selfManaged?: boolean;
  repoUrl?: string;
  verification: VerifiedProposal;
  /** The run that produced the proposal, for the trace. */
  runId?: string;
}
