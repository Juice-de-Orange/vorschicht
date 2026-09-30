/**
 * The gate suite (§11) — the runner behind the registry.
 *
 * §11 locks six gates and offers an optional catalogue on top; which of them
 * apply to a project is decided by `@vorschicht/shared/gates` and what they
 * *do* is decided here. The suite iterates whatever `resolveGates` returns, in
 * catalogue order, against an arbitrary working tree — because the whole point
 * of the merge queue is to run it against *the tree that will become `main`*
 * rather than against the one the coder happened to leave behind.
 *
 * Seven decisions that are not transcription of §11:
 *
 *  1. **Peer review is checked mechanically, from the event log.** §11 calls it
 *     "Reviewer artifact" and §8.1 produces one: the dev chain moves a task to
 *     `gates` with the Reviewer as actor. So the gate asks whether *that* row
 *     exists and is the most recent one — not whether someone remembered to set
 *     a flag. A task that reached the queue by any other route fails it, which
 *     is the only reason to have the gate at all.
 *
 *  2. **Commands are argv, never a shell line.** A gate command is proposed by
 *     an onboarding agent (§20) and confirmed by the operator — so a model writes it and
 *     a human waves it through, which is precisely the input a shell must never
 *     see. `parseGateCommand` splits on whitespace and refuses metacharacters,
 *     the same posture `buildRoleSettings` takes for hook paths (A51). The
 *     registry refuses the same string at write time; this is the second layer,
 *     for a configuration that reached the column some other way.
 *
 *  3. **A missing command is a finding, not a skip.** §11's six are locked and
 *     "not un-checkable"; a project without a test command has not opted out of
 *     testing, it has an incomplete configuration. Reporting that as green would
 *     make the suite's verdict depend on config completeness in the one
 *     direction that ships.
 *
 *  4. **A25 lives at the step, not at the suite.** Third-party tools do not
 *     speak our exit codes (A50), so a command step reads *any* non-zero exit as
 *     a finding. Only the checks we wrote ourselves can report an infra failure,
 *     and only they do.
 *
 *  5. **The secrets scan reads the tree, not the diff.** Scanning only what the
 *     candidate adds would be cheaper and would let a secret already on the
 *     integration branch merge again forever. §10 asks whether the tree that
 *     becomes `main` is clean; that is the question this answers. A project
 *     whose `main` is already dirty therefore blocks every merge, loudly, which
 *     is the correct outcome under §19 and not a false positive.
 *
 *  6. **The diff-based gates fail closed when there is no diff to read.** The
 *     CHANGELOG and docs gates need to know what the candidate changed; without
 *     a base reference, or with a git invocation that fails, nothing was checked
 *     and the honest answer is an infra failure (A25) rather than a pass.
 *
 *  7. **Every internal gate in the catalogue must have a runner here, and that
 *     is asserted at module load.** A catalogue entry whose runner does not
 *     exist is §8.2's sixth domain — configuration that reads as covered and
 *     cannot carry a signal. `assertInternalRunnersComplete` fails the import
 *     instead, in both directions: a new internal gate without a runner, and a
 *     runner for a gate the catalogue still marks as unavailable.
 *
 *  8. **A25's retry is per step, and only an infra step is retried.** §22's
 *     Phase 3 step 3 asks for the classification's retry policy where the
 *     classification is made, and the granularity is the whole content of it:
 *     re-running the *suite* because docker was unreachable for ten seconds
 *     would re-run a fifteen-minute test suite to find out. A `finding` is never
 *     retried — §11 has no warning mode, and "run it again and hope" is that
 *     mode arriving through the back door.
 */
import { execFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import {
  CITATION_MIN_LEVEL,
  EMPTY_GATE_CONFIG,
  GATE_CATALOGUE,
  GATE_SHELL_METACHARACTERS,
  type GateDefinition,
  type GateId,
  gateDefinition,
  type LegalResult,
  type MigrationReviewResult,
  type ProjectGateConfig,
  resolveGates,
  trustLevelCode,
} from '@vorschicht/shared';
import type { LegalReviewer, ResolvedCitation } from './legal-review.js';
import { type MigrationReviewer, selectMigrations } from './migration-review.js';
import { AutoSecretScanner, type SecretScanner } from './secret-scan.js';
import type { Queryable } from './sql.js';

const exec = promisify(execFile);

/**
 * The internal gates whose runner lives in this file.
 *
 * The one place the switch below and the catalogue can disagree, which is why
 * `assertInternalRunnersComplete` compares them at module load.
 */
const INTERNAL_GATE_IDS = [
  'review',
  'secrets',
  'changelog',
  'docs',
  'migration-review',
  'legal',
] as const;
type InternalGateId = (typeof INTERNAL_GATE_IDS)[number];

function isInternalGateId(id: GateId): id is InternalGateId {
  return (INTERNAL_GATE_IDS as readonly string[]).includes(id);
}

/** Decision 7: the catalogue and this file describe the same set. */
export function assertInternalRunnersComplete(): void {
  const needed = GATE_CATALOGUE.filter(
    (gate) => gate.kind === 'internal' && !gate.availableFrom,
  ).map((gate) => gate.id);
  const missing = needed.filter((id) => !isInternalGateId(id));
  if (missing.length > 0) {
    throw new Error(
      `Für ${missing.join(', ')} gibt es keinen Prüflauf. Ein Gate im Katalog ohne Prüflauf ` +
        'liest sich als abgedeckt und kann kein Signal tragen (§8.2, Bereich 6).',
    );
  }
  const extra = INTERNAL_GATE_IDS.filter((id) => !needed.includes(id));
  if (extra.length > 0) {
    throw new Error(
      `Für ${extra.join(', ')} gibt es einen Prüflauf, aber der Katalog führt sie als noch ` +
        'nicht verfügbar — dann sollte das Feld "availableFrom" fallen.',
    );
  }
}
assertInternalRunnersComplete();

/** A25: a finding blocks, an infra failure retries and never colours a task. */
export type GateVerdict = 'green' | 'finding' | 'infra';

/** One execution of one gate, before A25's retry loop has anything to say. */
export interface GateAttemptResult {
  id: GateId;
  verdict: GateVerdict;
  /** German, for the timeline and the findings pipeline (§2). */
  detail: string;
  /** Captured output, trimmed. Empty for steps that produce none. */
  output: string;
  durationMs: number;
  /** The argv actually executed, for the trace. Null for our own checks. */
  command: string[] | null;
  exitCode: number | null;
}

export interface GateStepResult extends GateAttemptResult {
  /**
   * How often this gate ran. `1` in the ordinary case; more means A25 retried.
   *
   * Recorded rather than inferred from `retries.length`, because the number is
   * what the trace and the weekly report want, and because a retry that
   * *recovered* is otherwise invisible — a gate that goes green on the third
   * attempt every single merge is a machine problem hiding inside a green run.
   */
  attempts: number;
  /**
   * German, one line per discarded infra attempt, oldest first.
   *
   * Empty in the ordinary case. Non-empty means something was thrown away, and
   * §11 has nowhere to hide a discarded result: what could not be checked has
   * to be visible even when the next attempt succeeded.
   */
  retries: string[];
}

export interface GateSuiteResult {
  ok: boolean;
  steps: GateStepResult[];
  findings: GateStepResult[];
  infra: GateStepResult[];
  /** Steps that ran more than once (A25). Green ones included, deliberately. */
  retried: GateStepResult[];
  durationMs: number;
}

/**
 * A25's retry policy, at the layer that makes the classification.
 *
 * `attempts` and `backoffMs` are A25's sentence — "infra failures retry up to
 * 3× with backoff". `budgetMs` is not in the spec and is the reason this is a
 * policy object rather than two constants: the merge queue holds a per-project
 * advisory lock for the whole suite run (A55.2), so every second spent waiting
 * for a machine to come back is a second no other candidate in that project can
 * merge. The budget is a ceiling on what the retries may add to one suite run,
 * shared across its steps, and when it bites it is **reported in the step's own
 * detail line** rather than silently shortening the loop.
 */
export interface GateRetryPolicy {
  attempts: number;
  /** Base wait; doubled per attempt, as `DevChain.leg` already does. */
  backoffMs: number;
  /** Wall clock the retries of one whole suite run may add, in total. */
  budgetMs: number;
}

/** A25: "infra failures retry up to 3× with backoff". */
export const DEFAULT_GATE_RETRY_POLICY: GateRetryPolicy = {
  attempts: 3,
  backoffMs: 5_000,
  budgetMs: 5 * 60_000,
};

export class GateCommandError extends Error {
  constructor(
    readonly spec: string,
    message: string,
  ) {
    super(message);
    this.name = 'GateCommandError';
  }
}

/**
 * Characters that mean something to a shell and nothing to `execFile`.
 *
 * Refused rather than escaped: a gate command that genuinely needs a pipe is a
 * gate command that should be a script in the project, where it is reviewable,
 * versioned and covered by the project's own gates.
 *
 * **Re-exported, not declared.** This was its own byte-identical copy of
 * `GATE_SHELL_METACHARACTERS` for as long as both existed, in two packages,
 * with both files' comments warning that two dialects of "which characters are
 * dangerous" are two answers to one question and that the day they differ the
 * narrower one is the only guard. They never differed — and nothing would have
 * said so if they had, which is the whole shape. Phase 5 gave it a third
 * consumer (`deploy/target-guards.ts` took one, `shared/deploy.ts` the other)
 * and that is when a latent duplicate became one worth removing. The name stays
 * so importers here are unaffected; `gate-suite.test.ts` asserts the two are
 * the same object, so a future re-declaration fails rather than agreeing.
 */
export const SHELL_METACHARACTERS = GATE_SHELL_METACHARACTERS;

/**
 * Turn `pnpm test --run` into an argv, or explain why it will not be run.
 *
 * The refusal names the character, because "invalid command" in an unattended
 * log costs somebody twenty minutes and a sentence costs nothing.
 */
export function parseGateCommand(spec: string): string[] {
  const trimmed = spec.trim();
  if (trimmed === '') {
    throw new GateCommandError(spec, 'Leerer Gate-Befehl');
  }
  const offending = SHELL_METACHARACTERS.exec(trimmed);
  if (offending) {
    throw new GateCommandError(
      spec,
      `Gate-Befehl enthält das Sonderzeichen "${offending[0]}". Vorschicht führt Gate-Befehle ` +
        'ohne Shell aus (§19); ein Befehl, der eine Shell braucht, gehört als Skript ins ' +
        'Projekt, wo er selbst geprüft wird.',
    );
  }
  return trimmed.split(/\s+/);
}

/**
 * The secrets scanner lives in `secret-scan.ts`, in two implementations.
 *
 * It moved out when it stopped being one thing. §11 locks gate 4, and the only
 * way to run it used to be `docker run` — which the orchestrator image cannot
 * do, so in the deployed studio that gate answered `infra` on every attempt and
 * no merge could ever complete. There is now a pinned binary beside the pinned
 * image, both held to one contract suite, and `AutoSecretScanner` picks
 * whichever the machine has. This file keeps the *types* in view because
 * `GateSuiteDeps` takes one; the implementations are a different concern and a
 * long one.
 */
export type { SecretScanner, SecretScanResult } from './secret-scan.js';

export interface GateSuiteDeps {
  sql: Queryable;
  /**
   * This project's gate configuration (§11) — checkboxes, commands and tools.
   *
   * Read fresh per suite instance, not cached, for the reason `ProjectService`
   * gives: a gate set that changed since the process started is the current
   * truth, and the merge queue may hold a candidate for minutes.
   */
  config: ProjectGateConfig;
  secrets?: SecretScanner;
  /**
   * §11's migration gate (A63) — the one gate that is an agent session.
   *
   * Absent means the gate cannot run. That is reported as an **infra** failure
   * and never as green: a suite constructed without model access has not
   * examined the migration, and §11's optional gates are ungeprüft rather than
   * exempt when they cannot run. It stays optional here so that every test of
   * the other fifteen gates does not have to construct a runner.
   */
  migrationReview?: MigrationReviewer;
  /**
   * §11's legal gate (§8 row 5, §14) — the second gate that is a session.
   *
   * Absent means the gate cannot run, reported as **infra** and never as green,
   * for `migrationReview`'s reason: a suite built without model access has not
   * examined anything, and §11's optional gates are ungeprüft rather than
   * exempt when they cannot run (A63.5).
   */
  legalReview?: LegalReviewer;
  /** Wall clock per command step. A hung test suite must not hold the queue. */
  timeoutMs?: number;
  /** A25's retry, overridable per field. Defaults to `DEFAULT_GATE_RETRY_POLICY`. */
  retry?: Partial<GateRetryPolicy>;
  /** Injected so a test can prove the backoff without waiting it out. */
  sleep?(ms: number): Promise<void>;
  onWarning?(message: string): void;
}

export interface GateSuiteContext {
  /** The tree under test — for the merge queue, the rebased worktree. */
  cwd: string;
  /** Whose peer review is being checked. */
  taskId: string;
  /**
   * The integration branch the candidate will merge into (§10).
   *
   * What the diff-based gates measure against: everything between
   * `merge-base(baseRef, HEAD)` and `HEAD` is what this candidate changes. The
   * merge queue supplies the project's default branch, after the rebase, so the
   * merge base is that branch's tip. Absent means those gates cannot run, which
   * they report as an infra failure rather than as a pass (decision 6).
   */
  baseRef?: string;
  /** The project, for the gates that spawn a session. */
  projectId?: string | null;
  /** A41 — an analysed-only project. Passed through to the runner unchanged. */
  readOnlyProject?: boolean;
}

export const DEFAULT_GATE_TIMEOUT_MS = 15 * 60_000;

/**
 * What a delivered migration review means for the merge (§11, §12/A24, §23).
 *
 * Pure, and separate from the session that produced it, because this is where
 * the two questions the reviewer answered turn into one gate verdict — and the
 * mapping is the part that has to be right whether or not a model is reachable.
 *
 * Three rules, in this order:
 *
 *  1. `changes_requested` blocks. §11 has no warning mode.
 *  2. `undocumented` reversibility blocks *whatever the verdict said*. §23 makes
 *     "reversible or explicitly documented" a definition-of-done item, and the
 *     observation is the reviewer's while the consequence is ours (A54.2). Where
 *     an approval and an undocumented irreversible migration arrive together,
 *     the divergence is named rather than resolved in the model's favour.
 *  3. `backwardCompatible: false` does **not** block. §12 routes it to the
 *     deploy, which stops and escalates instead of rolling out — the merge is
 *     not the decision point, and blocking here would be stricter than the spec
 *     in a way that quietly forbids every contract step.
 */
export function judgeMigrationReview(result: MigrationReviewResult): InternalOutcome {
  const findings = result.findings
    .map(
      (finding) => `- ${finding.file}${finding.line ? `:${finding.line}` : ''}: ${finding.summary}`,
    )
    .join('\n');
  const deployNote = result.backwardCompatible
    ? ''
    : '\nDie Migration ist **nicht** rückwärtskompatibel mit der laufenden Version. Das ' +
      'blockiert den Merge nicht, hält aber das Deployment an: es geht nach §12/A24 an den Betreiber, ' +
      'statt automatisch auszurollen.';

  if (result.verdict === 'changes_requested') {
    return {
      verdict: 'finding',
      detail: `Milo verlangt Nachbesserung an der Migration (§11).${deployNote}`,
      output: `${result.summary}\n${findings}`.trim(),
    };
  }
  if (result.reversibility === 'undocumented') {
    return {
      verdict: 'finding',
      detail:
        'Die Migration ist nicht umkehrbar und sagt nirgends warum (§23). Das ist ein Befund ' +
        'unabhängig vom Urteil der Prüfung — hier lautete das Urteil „freigegeben", was die ' +
        `Abweichung selbst festhaltenswert macht.${deployNote}`,
      output: `${result.summary}\n${findings}`.trim(),
    };
  }
  return {
    verdict: 'green',
    detail:
      `Migration geprüft und freigegeben (${result.migrations.length} Datei(en), ` +
      `Umkehrbarkeit: ${REVERSIBILITY_LABELS[result.reversibility]}).${deployNote}`,
    output: result.summary,
  };
}

/**
 * What a delivered legal review means for the merge (§11, §14).
 *
 * Pure, and separate from the session and from the registry lookup, because
 * this is where §14's one enforceable sentence — "Legal/compliance outputs must
 * cite sources with level ≥ L4; anything lower triggers a corroboration pass" —
 * becomes a verdict. Four rules, and the shape of them is the design:
 *
 *  1. **`changes_requested` blocks.** §11 has no warning mode.
 *  2. **A citation to a source the registry does not have blocks on its own**,
 *     however good the others are. It is a *fabricated* reference, which is a
 *     different defect from a weak one: the reader cannot follow it and cannot
 *     tell that from a typo. `checkCitation` separates the two for exactly this.
 *  3. **At least one citation has to carry.** That is §14's threshold, and it
 *     is stated as "at least one" rather than "every one" because §14's own
 *     second clause permits a weaker source to run alongside a stronger one —
 *     a corroboration pass, not silence. A review that cites nothing at all
 *     lands here too, which is why `citations` is not `.min(1)` in the contract.
 *  4. **Claiming a higher level than the registry granted blocks.** The
 *     observation is the session's and the fact is the registry's (A54.2), and
 *     where the two disagree the registry wins and the divergence is itself the
 *     finding. Understating is caution and costs nothing; overstating is how a
 *     community post is made to look decisive in a document the operator acts on.
 *
 * Every problem is reported, never the first: §11 sends the work back, and a
 * reviewer told one defect per round takes a round per defect.
 */
export function judgeLegalReview(
  result: LegalResult,
  citations: readonly ResolvedCitation[],
): InternalOutcome {
  const problems: string[] = [];
  const threshold = trustLevelCode(CITATION_MIN_LEVEL);

  if (result.verdict === 'changes_requested') {
    problems.push('Die Rechtsprüfung verlangt Nachbesserung (§11).');
  }

  const fabricated = citations.filter((entry) => entry.check.reason === 'unknown');
  if (fabricated.length > 0) {
    problems.push(
      `${fabricated.length} Zitation(en) nennen eine Quellenkennung, die es im Register nicht ` +
        'gibt — eine erfundene Fundstelle. Das ist unabhängig von den übrigen Zitationen ein ' +
        `Befund: ${fabricated.map((entry) => entry.citation.sourceId).join(', ')}`,
    );
  }

  const carrying = citations.filter((entry) => entry.check.ok);
  if (carrying.length === 0) {
    problems.push(
      citations.length === 0
        ? `Die Rechtsprüfung nennt gar keine Quelle. §14 verlangt für eine rechtliche Aussage ` +
            `mindestens eine Quelle auf ${threshold} oder höher.`
        : `Keine der ${citations.length} Zitation(en) trägt: sie liegen unter ${threshold} oder ` +
            `stehen nicht als aufgenommene Quelle im Register. §14 verlangt für eine rechtliche ` +
            `Aussage mindestens eine Quelle auf ${threshold} oder höher.`,
    );
  }

  const overstated = citations.filter(
    (entry) => entry.check.level !== null && entry.citation.claimedLevel > entry.check.level,
  );
  if (overstated.length > 0) {
    problems.push(
      `${overstated.length} Zitation(en) behaupten eine höhere Vertrauensstufe, als das Register ` +
        'vergeben hat. Die Stufe des Registers gilt, und die Abweichung ist selbst der Befund: ' +
        overstated
          .map(
            (entry) =>
              `${entry.citation.sourceId} (behauptet ${trustLevelCode(
                entry.citation.claimedLevel,
              )}, Register ${trustLevelCode(entry.check.level)})`,
          )
          .join(', '),
    );
  }

  const output = legalLedger(result, citations);
  if (problems.length > 0) {
    return { verdict: 'finding', detail: problems.join('\n'), output };
  }

  const corroborated = citations.filter((entry) => entry.check.needsCorroboration);
  const note =
    corroborated.length > 0
      ? ` ${corroborated.length} schwächere Quelle(n) laufen mit und sind durch die stärkeren ` +
        'gedeckt (§14s Bestätigungsdurchgang).'
      : '';
  return {
    verdict: 'green',
    detail:
      `Rechtsprüfung erteilt, getragen von ${carrying.length} Quelle(n) auf ${threshold} oder ` +
      `höher (${carrying.map((entry) => trustLevelCode(entry.check.level)).join(', ')}).${note}`,
    output,
  };
}

/**
 * The citation ledger — §22's "citations and trust levels shown in the trace".
 *
 * Every citation, whether it carried or not, with the level the session claimed
 * beside the level the registry granted and the registry's own German sentence
 * about it. A ledger of only the failures would make a green review's evidence
 * invisible, which is the half of that gate sentence that a verdict cannot say.
 */
function legalLedger(result: LegalResult, citations: readonly ResolvedCitation[]): string {
  const lines = [result.summary.trim()];
  if (citations.length > 0) {
    lines.push('', 'Zitationen:');
    for (const { citation, check } of citations) {
      lines.push(
        `- ${citation.sourceId} — behauptet ${trustLevelCode(citation.claimedLevel)}, Register: ` +
          `${trustLevelCode(check.level)}${check.ok ? '' : ' — nicht tragend'}` +
          `${citation.locator ? ` (${citation.locator})` : ''}`,
        `  ${citation.statement}`,
        `  ${check.message}`,
      );
    }
  }
  if (result.documents.length > 0) {
    lines.push('', `Gelesene Tresor-Dokumente: ${result.documents.join(', ')}`);
  }
  if (result.findings.length > 0) {
    lines.push('', 'Befunde:');
    for (const finding of result.findings) {
      lines.push(`- ${finding.file}${finding.line ? `:${finding.line}` : ''}: ${finding.summary}`);
    }
  }
  return lines.join('\n');
}

/** German (§2), for the timeline. */
const REVERSIBILITY_LABELS: Record<MigrationReviewResult['reversibility'], string> = {
  reversible: 'umkehrbar',
  documented_irreversible: 'nicht umkehrbar, begründet',
  undocumented: 'nicht umkehrbar, unbegründet',
};

/** What an internal gate answers before it is dressed as a `GateStepResult`. */
interface InternalOutcome {
  verdict: GateVerdict;
  detail: string;
  output: string;
}

export class GateSuite {
  private readonly secrets: SecretScanner;
  private readonly retry: GateRetryPolicy;

  constructor(private readonly deps: GateSuiteDeps) {
    // A machine that has neither gitleaks nor docker answers `infra` and never
    // green, so the default cannot quietly stop checking anything.
    this.secrets = deps.secrets ?? new AutoSecretScanner();
    this.retry = { ...DEFAULT_GATE_RETRY_POLICY, ...deps.retry };
  }

  /** Which gates this project runs, in catalogue order (§11). */
  gates(): GateDefinition[] {
    return resolveGates(this.deps.config);
  }

  /**
   * Run every resolved gate against one tree.
   *
   * Every step runs even after one fails, exactly as `pnpm gate` does and for
   * the same reason: §11 has no warning mode, but a coder sent back with one
   * finding at a time takes six rounds to learn what six findings would have
   * told them at once.
   */
  async run(context: GateSuiteContext): Promise<GateSuiteResult> {
    const started = Date.now();
    const steps: GateStepResult[] = [];
    // One budget for the whole run, not one per gate: what it protects is the
    // merge lock, and the lock is held for the run rather than for a step. A
    // per-gate budget would multiply by however many gates a broken machine
    // happens to break at once.
    const deadline = started + this.retry.budgetMs;

    for (const gate of this.gates()) {
      steps.push(await this.attempt(gate, context, deadline));
    }

    const findings = steps.filter((step) => step.verdict === 'finding');
    const infra = steps.filter((step) => step.verdict === 'infra');
    for (const step of infra) this.deps.onWarning?.(`Gate "${step.id}": ${step.detail}`);

    return {
      ok: findings.length === 0 && infra.length === 0,
      steps,
      findings,
      infra,
      retried: steps.filter((step) => step.attempts > 1),
      durationMs: Date.now() - started,
    };
  }

  /**
   * One gate, with A25's retry around it.
   *
   * The loop covers `infra` and nothing else. Three properties are deliberate:
   *
   *  - **A `finding` returns on the first attempt.** Re-running a red test suite
   *    until it passes is §11's warning mode wearing a retry's clothes.
   *  - **The discarded attempts survive in `retries`.** A gate that needed three
   *    goes green with its history attached, because "green on the third
   *    attempt, every merge, for a month" is a machine that wants fixing and it
   *    is invisible from the verdict alone.
   *  - **`durationMs` is the whole span**, retries and backoff included. It is
   *    what the merge queue paid, and the queue is what the budget protects.
   */
  private async attempt(
    gate: GateDefinition,
    context: GateSuiteContext,
    deadline: number,
  ): Promise<GateStepResult> {
    const started = Date.now();
    const retries: string[] = [];
    let result = await this.once(gate, context);
    let attempts = 1;
    let outOfBudget = false;

    while (result.verdict === 'infra' && attempts < this.retry.attempts) {
      const wait = this.retry.backoffMs * 2 ** (attempts - 1);
      if (Date.now() + wait > deadline) {
        outOfBudget = true;
        break;
      }
      retries.push(`Versuch ${attempts}/${this.retry.attempts}: ${result.detail}`);
      this.deps.onWarning?.(
        `Gate "${gate.id}": Infrastrukturfehler in Versuch ${attempts}/${this.retry.attempts}, ` +
          `neuer Versuch in ${Math.round(wait / 1000)}s (A25) — ${result.detail}`,
      );
      await this.sleep(wait);
      result = await this.once(gate, context);
      attempts += 1;
    }

    return {
      ...result,
      detail: this.retryDetail(result, attempts, outOfBudget),
      attempts,
      retries,
      durationMs: Date.now() - started,
    };
  }

  /** What the timeline reads when a gate did not come back on the first try. */
  private retryDetail(result: GateAttemptResult, attempts: number, outOfBudget: boolean): string {
    if (attempts === 1 && !outOfBudget) return result.detail;
    if (outOfBudget) {
      return (
        `${result.detail} Abgebrochen nach ${attempts} Versuch(en): das Wiederholungsbudget ` +
        `der Prüfsuite (${Math.round(this.retry.budgetMs / 1000)}s) ist erschöpft. Der Baum ` +
        'bleibt ungeprüft (A25) — die Aufgabe wird nicht rot.'
      );
    }
    if (result.verdict === 'infra') {
      return (
        `${result.detail} Auch nach ${attempts} Versuchen mit Wartezeit unverändert (A25); ` +
        'der Baum bleibt ungeprüft.'
      );
    }
    return `${result.detail} (erst im ${attempts}. Versuch — davor Infrastrukturfehler, A25.)`;
  }

  private once(gate: GateDefinition, context: GateSuiteContext): Promise<GateAttemptResult> {
    return gate.kind === 'command'
      ? this.command(gate.id, context.cwd)
      : this.internal(gate.id, context);
  }

  private sleep(ms: number): Promise<void> {
    if (this.deps.sleep) return this.deps.sleep(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Dispatch to the checks Vorschicht implements itself.
   *
   * The switch is exhaustive over `InternalGateId` — no `default` — so adding a
   * member to that tuple without a case fails the build, and adding an internal
   * gate to the catalogue without adding it to the tuple fails the import.
   */
  private async internal(id: GateId, context: GateSuiteContext): Promise<GateAttemptResult> {
    const started = Date.now();
    const base = { id, output: '', command: null, exitCode: null };
    if (!isInternalGateId(id)) {
      // Unreachable while `assertInternalRunnersComplete` holds; kept as a
      // refusal rather than an assumption, because the one thing this may not
      // do is report an unrun gate as green.
      return {
        ...base,
        verdict: 'infra',
        detail: `Für „${gateDefinition(id).label}" gibt es keinen Prüflauf.`,
        durationMs: Date.now() - started,
      };
    }
    const outcome = await this.runInternal(id, context);
    return { ...base, ...outcome, durationMs: Date.now() - started };
  }

  private runInternal(id: InternalGateId, context: GateSuiteContext): Promise<InternalOutcome> {
    switch (id) {
      case 'review':
        return this.review(context.taskId);
      case 'secrets':
        return this.secrets.scan(context.cwd);
      case 'changelog':
        return this.changelog(context);
      case 'docs':
        return this.docs(context);
      case 'migration-review':
        return this.migrationReview(context);
      case 'legal':
        return this.legal(context);
    }
  }

  // --- the checks Vorschicht runs itself --------------------------------------

  /**
   * §11.6: peer review approved, read off the task's own lifecycle.
   *
   * The artefact is §8.1's third step: a `state_changed → gates` row whose actor
   * is the Reviewer. Two things make this a real check rather than a formality —
   * it must be the *most recent* `gates` entry (a task sent back to coding and
   * pushed forward again by anyone else fails), and the actor must be the
   * reviewer role (the orchestrator moving a task along is not a review).
   */
  private async review(taskId: string): Promise<InternalOutcome> {
    try {
      const [row] = await this.deps.sql<Array<{ actor: string; payload: unknown }>>`
        SELECT actor, payload FROM task_events
        WHERE task_id = ${taskId} AND kind = 'state_changed' AND state = 'gates'
        ORDER BY seq DESC LIMIT 1
      `;
      if (!row) {
        return {
          verdict: 'finding',
          output: '',
          detail:
            'Kein Review-Nachweis: die Aufgabe hat den Zustand "Prüfungen laufen" nie über ' +
            'ein erteiltes Review erreicht (§8.1, §11.6).',
        };
      }
      if (row.actor !== 'reviewer') {
        return {
          verdict: 'finding',
          output: '',
          detail:
            `Der letzte Übergang nach "Prüfungen laufen" stammt von "${row.actor}", nicht vom ` +
            'Review. Ein Merge ohne Peer-Review ist nach §11 ausgeschlossen.',
        };
      }
      return {
        verdict: 'green',
        detail: 'Review erteilt (§8.1).',
        output: JSON.stringify(row.payload ?? {}),
      };
    } catch (error) {
      // The database, not the code under test. Fail as infra so the candidate
      // is retried rather than marked red for something it did not do.
      return {
        verdict: 'infra',
        output: '',
        detail: `Review-Nachweis nicht lesbar: ${(error as Error).message}`,
      };
    }
  }

  /**
   * §23: the change summarises itself in the project's CHANGELOG.
   *
   * Mechanical and deliberately narrow — it asks whether a CHANGELOG file is
   * among the changed paths, not whether the entry is any good. Judging that is
   * Doris's job and arrives with the documentation department in Phase 6; what
   * a gate can do today is make the omission impossible to merge.
   */
  private async changelog(context: GateSuiteContext): Promise<InternalOutcome> {
    const changed = await this.changedFiles(context);
    if (!changed.ok) return changed.outcome;
    if (changed.files.length === 0) {
      return { verdict: 'green', detail: 'Der Kandidat ändert nichts.', output: '' };
    }
    const hit = changed.files.find((path) => /^CHANGELOG(\.|$)/i.test(basename(path)));
    if (hit) {
      return { verdict: 'green', detail: `„${hit}" wurde mitgeführt.`, output: '' };
    }
    return {
      verdict: 'finding',
      detail:
        'Die Änderung führt keinen CHANGELOG-Eintrag mit (§23). Eine zusammengeführte Änderung, ' +
        'die sich nirgends zusammenfasst, ist für die nächste Person unsichtbar.',
      output: changed.files.join('\n'),
    };
  }

  /**
   * §23: a change that is not only documentation also carries documentation.
   *
   * Two judgement calls, both recorded because the alternative reading is
   * defensible. The CHANGELOG deliberately does **not** count as documentation
   * here — a project that enables both gates should get two different questions
   * rather than one asked twice. And "documentation" is a file extension and a
   * directory name rather than a per-project pattern list: the narrower
   * question, "is *the right* document stale", needs judgement and is Doris's
   * (Phase 6). This is the half a gate can decide.
   */
  private async docs(context: GateSuiteContext): Promise<InternalOutcome> {
    const changed = await this.changedFiles(context);
    if (!changed.ok) return changed.outcome;
    if (changed.files.length === 0) {
      return { verdict: 'green', detail: 'Der Kandidat ändert nichts.', output: '' };
    }
    const docs = changed.files.filter(isDocumentation);
    const rest = changed.files.filter((path) => !isDocumentation(path));
    if (rest.length === 0) {
      return { verdict: 'green', detail: 'Die Änderung ist selbst Dokumentation.', output: '' };
    }
    if (docs.length > 0) {
      return {
        verdict: 'green',
        detail: `Dokumentation mitgeführt (${docs.length} Datei(en)).`,
        output: docs.join('\n'),
      };
    }
    return {
      verdict: 'finding',
      detail:
        `Die Änderung berührt ${rest.length} Datei(en) und keine Dokumentation (§23). ` +
        'Erwartet wird mindestens eine Markdown-Datei oder eine Datei unterhalb von "docs/" — ' +
        'der CHANGELOG zählt hier bewusst nicht, dafür gibt es ein eigenes Gate.',
      output: rest.slice(0, 50).join('\n'),
    };
  }

  /**
   * §11's migration gate (A63) — the only gate that may spend a model session.
   *
   * The order below is the economy of it. Detection first, from the diff and a
   * glob list, because that is a question git answers: a candidate that touches
   * no migration is green here without anything being spawned, which is the
   * ordinary case for most merges in a project that has the box ticked at all.
   * Only when there *is* something to review does a session start.
   */
  private async migrationReview(context: GateSuiteContext): Promise<InternalOutcome> {
    const changed = await this.changedFiles(context);
    if (!changed.ok) return changed.outcome;

    const migrations = selectMigrations(this.deps.config, changed.files);
    if (migrations.length === 0) {
      return {
        verdict: 'green',
        detail: 'Der Kandidat berührt keine Migration — keine Prüfsitzung nötig.',
        output: '',
      };
    }
    if (!this.deps.migrationReview) {
      // Never green. A gate with no runner behind it that reported a pass would
      // be the exact shape §8.2's sixth domain looks for: configuration that
      // reads as covered and cannot carry a signal.
      return {
        verdict: 'infra',
        detail:
          `Der Kandidat ändert ${migrations.length} Migration(en), aber diese Prüfsuite wurde ` +
          'ohne Migrationsprüfer gebaut — es lief nichts (A25).',
        output: migrations.join('\n'),
      };
    }

    const report = await this.deps.migrationReview.review({
      cwd: context.cwd,
      taskId: context.taskId,
      projectId: context.projectId ?? null,
      // `changedFiles` already refused to run without one, so this is a
      // narrowing rather than a default.
      baseRef: context.baseRef as string,
      migrations,
      changedFiles: changed.files,
      readOnlyProject: context.readOnlyProject ?? false,
    });

    if (report.status === 'infra') {
      return {
        verdict: 'infra',
        detail: `Die Migrationsprüfung konnte nicht laufen: ${report.problem}`,
        output: migrations.join('\n'),
      };
    }
    if (report.status === 'failed') {
      return {
        verdict: 'finding',
        detail: `Die Migrationsprüfung lieferte kein verwertbares Urteil: ${report.problem}`,
        output: migrations.join('\n'),
      };
    }
    return judgeMigrationReview(report.result);
  }

  /**
   * §11's legal gate (§8 row 5, §14) — the other gate that spends a session.
   *
   * Unlike the migration gate there is no detection step, and the difference is
   * not an oversight. A migration is a *file*, so a glob answers whether one is
   * present; whether a change has a legal dimension is the question the session
   * exists to answer, and a keyword list deciding it in advance would be this
   * gate's judgement made by a regular expression. So a project that ticks this
   * box pays for a session per candidate — which is why the box is optional and
   * why the one shortcut taken is the honest one: a candidate that changes
   * nothing is green without a session, exactly as the diff-based gates are.
   */
  private async legal(context: GateSuiteContext): Promise<InternalOutcome> {
    const changed = await this.changedFiles(context);
    if (!changed.ok) return changed.outcome;
    if (changed.files.length === 0) {
      return { verdict: 'green', detail: 'Der Kandidat ändert nichts.', output: '' };
    }
    if (!this.deps.legalReview) {
      return {
        verdict: 'infra',
        detail:
          'Diese Prüfsuite wurde ohne Rechtsprüfung gebaut — es lief nichts, und ein Gate ohne ' +
          'Prüflauf ist nicht grün, sondern ungeprüft (A25).',
        output: '',
      };
    }

    const report = await this.deps.legalReview.review({
      kind: 'change',
      // Absolute, and read from outside: the session runs in its own scratch
      // directory (§6.2) so that the repository cannot instruct its examiner.
      repoPath: context.cwd,
      taskId: context.taskId,
      projectId: context.projectId ?? null,
      // `changedFiles` already refused to run without one, so this is a
      // narrowing rather than a default.
      baseRef: context.baseRef as string,
      changedFiles: changed.files,
      readOnlyProject: context.readOnlyProject ?? false,
    });

    if (report.status === 'infra') {
      return {
        verdict: 'infra',
        detail: `Die Rechtsprüfung konnte nicht laufen: ${report.problem}`,
        output: '',
      };
    }
    if (report.status === 'failed') {
      return {
        verdict: 'finding',
        detail: `Die Rechtsprüfung lieferte kein verwertbares Urteil: ${report.problem}`,
        output: '',
      };
    }
    return judgeLegalReview(report.result, report.citations);
  }

  /**
   * What this candidate changes, relative to the branch it will merge into.
   *
   * Fails closed in every direction it can: no base reference, an unusable one,
   * or a git invocation that errors all produce an infra outcome (A25) rather
   * than an empty list — an empty list would make both diff-based gates pass on
   * exactly the runs where nothing could be read.
   */
  private async changedFiles(
    context: GateSuiteContext,
  ): Promise<{ ok: true; files: string[] } | { ok: false; outcome: InternalOutcome }> {
    if (!context.baseRef) {
      return {
        ok: false,
        outcome: {
          verdict: 'infra',
          detail:
            'Ohne Vergleichsbranch lässt sich nicht feststellen, was der Kandidat ändert — ' +
            'die Prüfung lief nicht (A25).',
          output: '',
        },
      };
    }
    try {
      const { stdout: mergeBase } = await exec('git', ['merge-base', context.baseRef, 'HEAD'], {
        cwd: context.cwd,
        maxBuffer: 1024 * 1024,
      });
      const { stdout } = await exec(
        'git',
        ['diff', '--name-only', '-z', `${mergeBase.trim()}`, 'HEAD'],
        { cwd: context.cwd, maxBuffer: 8 * 1024 * 1024 },
      );
      return { ok: true, files: stdout.split('\0').filter(Boolean) };
    } catch (error) {
      return {
        ok: false,
        outcome: {
          verdict: 'infra',
          detail: `Der Diff gegen „${context.baseRef}" ließ sich nicht lesen: ${
            (error as Error).message
          }`,
          output: '',
        },
      };
    }
  }

  private async command(id: GateId, cwd: string): Promise<GateAttemptResult> {
    const started = Date.now();
    const spec = this.deps.config.commands[id];
    if (!spec) {
      return {
        id,
        verdict: 'finding',
        detail:
          `Für "${gateDefinition(id).label}" ist kein Befehl hinterlegt — ohne Befehl ist ein ` +
          'Gate nicht grün, sondern ungeprüft (§11).',
        output: '',
        command: null,
        exitCode: null,
        durationMs: Date.now() - started,
      };
    }

    let argv: string[];
    try {
      argv = parseGateCommand(spec);
    } catch (error) {
      return {
        id,
        verdict: 'finding',
        detail: (error as Error).message,
        output: '',
        command: null,
        exitCode: null,
        durationMs: Date.now() - started,
      };
    }

    const { stdout, stderr, code, timedOut, spawnFailed } = await run(
      argv[0] as string,
      argv.slice(1),
      cwd,
      this.deps.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS,
    );
    const output = trim(`${stdout}\n${stderr}`);

    if (spawnFailed) {
      return {
        id,
        verdict: 'infra',
        detail:
          `"${argv[0]}" konnte nicht gestartet werden — das Gate lief nicht und der Baum ist ` +
          'damit ungeprüft (A25).',
        output,
        command: argv,
        exitCode: null,
        durationMs: Date.now() - started,
      };
    }
    if (timedOut) {
      // Deliberately a finding, not infra. A suite that does not terminate is a
      // property of the code under test far more often than of the machine, and
      // retrying it three times (A25) would cost three timeouts to learn the
      // same thing.
      return {
        id,
        verdict: 'finding',
        detail: `"${spec}" lief in die Zeitgrenze und wurde abgebrochen.`,
        output,
        command: argv,
        exitCode: code,
        durationMs: Date.now() - started,
      };
    }
    if (code === 0) {
      return {
        id,
        verdict: 'green',
        detail: `"${spec}" grün.`,
        output,
        command: argv,
        exitCode: 0,
        durationMs: Date.now() - started,
      };
    }
    // A50: third-party tools do not speak A25's codes, so any non-zero exit is
    // a finding. The safe direction — a misread infra failure costs an
    // investigation, a misread finding ships.
    return {
      id,
      verdict: 'finding',
      detail: `"${spec}" fehlgeschlagen (Exit ${code ?? '?'}).`,
      output,
      command: argv,
      exitCode: code,
      durationMs: Date.now() - started,
    };
  }
}

/** German, one line per failed step — what the timeline and the red path show. */
export function gateFailureSummary(result: GateSuiteResult): string {
  const lines: string[] = [];
  for (const step of result.findings) {
    lines.push(`- ${gateDefinition(step.id).label}: ${step.detail}`);
  }
  for (const step of result.infra) {
    lines.push(`- ${gateDefinition(step.id).label}: ${step.detail} (Infrastruktur)`);
  }
  return lines.join('\n');
}

/** A suite that runs only §11's locked six — the shape a caller with no project has. */
export function baselineOnly(): ProjectGateConfig {
  return { ...EMPTY_GATE_CONFIG };
}

// --- internals ---------------------------------------------------------------

const DOC_EXTENSIONS = ['.md', '.mdx', '.rst', '.adoc', '.txt'];

/**
 * Documentation, for the docs gate — extension or directory, never CHANGELOG.
 *
 * The exclusion is the whole reason the docs gate and the CHANGELOG gate are
 * two gates: without it, one CHANGELOG line would answer both questions and the
 * second checkbox would be decoration.
 */
function isDocumentation(path: string): boolean {
  const name = basename(path);
  if (/^CHANGELOG(\.|$)/i.test(name)) return false;
  if (path.split('/').includes('docs')) return true;
  return DOC_EXTENSIONS.some((extension) => name.toLowerCase().endsWith(extension));
}

const MAX_OUTPUT = 16_000;

function trim(text: string): string {
  const clean = text.trim();
  return clean.length > MAX_OUTPUT
    ? `${clean.slice(0, MAX_OUTPUT)}\n… (${clean.length - MAX_OUTPUT} Zeichen gekürzt)`
    : clean;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
  timedOut: boolean;
  /**
   * The binary itself could not be started — `ENOENT` and friends.
   *
   * The one command failure that is unambiguously *not* a statement about the
   * tree, and therefore the one A50 does not make a finding: nothing ran, so
   * nothing was checked. A25's retry is the right response, and if the binary
   * is genuinely missing the Ops alert after three attempts says so.
   */
  spawnFailed: boolean;
}

/**
 * `execFile` with a timeout, never a shell, and no exception on a non-zero exit.
 *
 * The exit code *is* the answer here — throwing on it would make every failing
 * gate look like an error in the runner rather than like a red gate.
 */
async function run(
  file: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
): Promise<RunResult> {
  try {
    const { stdout, stderr } = await exec(file, args, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, CI: '1', GIT_TERMINAL_PROMPT: '0', NO_COLOR: '1' },
    });
    return { stdout, stderr, code: 0, timedOut: false, spawnFailed: false };
  } catch (error) {
    const err = error as Error & {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
      signal?: string;
    };
    const timedOut = err.killed === true || err.signal === 'SIGTERM';
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? err.message,
      code: typeof err.code === 'number' ? err.code : null,
      timedOut,
      spawnFailed: typeof err.code === 'string',
    };
  }
}
