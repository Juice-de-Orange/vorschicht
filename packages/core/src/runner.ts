/**
 * The Claude Code runner (§6.2, §6.3, Phase 1 step 4 / Phase 2 step 7).
 *
 * One session, end to end: the per-run scratch documents, the spawn, the event
 * stream persisted as it arrives, the official usage samples the guardian
 * thresholds on, the two verdicts that say whether the harness worked, the
 * transcript copy §6.2 requires, the result validated against the role's
 * contract with §6.3's one repair attempt — and then a classification.
 *
 * Three properties are the design, and each of them is a decision rather than a
 * convenience:
 *
 *  1. **The runner never moves a task.** It returns an outcome; the caller
 *     transitions. The same rule `AgentChannel` follows (A48.2) and for a
 *     sharper reason here: this component is called by the dev chain, by the
 *     Debugger path, by the audit and eventually by the merge queue, each with
 *     different task semantics. A runner that also drove §9's lifecycle would be
 *     the second place that lifecycle lives, and the two would disagree the
 *     first time one of them changed.
 *
 *  2. **The record exists before the process can.** `created` is written before
 *     the backend is touched at all, so a crash during startup leaves a run that
 *     `reconcile()` can find and close (§7.2) rather than a process nobody knows
 *     about. The session id therefore arrives later, on `started` — the backend
 *     assigns it when it spawns, and migration 0011 reads the id from either
 *     event for exactly this reason.
 *
 *  3. **A broken harness is not a failed task** (§11, A25, §6.1). Four distinct
 *     non-success outcomes, because four different things have to happen: an
 *     infra failure retries, an auth incident parks and alerts, an interrupt
 *     parks quietly, and only a genuine failure takes the red path. Collapsing
 *     them into "the run failed" is how a pending MCP server turns into fifteen
 *     red tasks nobody can explain.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  assessSessionTools,
  type BackendEvent,
  type GetUsageResponse,
  type McpToolName,
  parseAgentResult,
  type RoleName,
  type RoleResult,
  type RunCaps,
  type RunContainmentPolicy,
  type SessionToolVerdict,
  type TerminationReason,
  type UsageSample,
  type UsageWindowKind,
} from '@vorschicht/shared';
import type postgres from 'postgres';
import type { ActiveRunRegistry } from './active-runs.js';
import type { BackendName, ModelBackend, RunHandle } from './backend/index.js';
import { ContainmentMonitor, type ContainmentVerdict } from './containment-monitor.js';
import type { EventLog } from './event-log.js';
import { writeMcpRunConfig } from './mcp-config.js';
import {
  type AgentProfile,
  buildSessionSpec,
  type ModelPolicy,
  profileWrites,
  resolveModel,
} from './profiles/index.js';
import { removeRunDir } from './run-dir.js';
import { writeRunPolicy } from './run-policy.js';
import { archiveTranscript } from './transcripts.js';

/** How often a live session is asked for official usage (§7.1). */
export const DEFAULT_USAGE_INTERVAL_MS = 120_000;

/**
 * Cap on one persisted assistant message.
 *
 * Assistant prose is kept in `agent_run_events` so Phase 7's trace explorer can
 * render a timeline without opening a transcript — but §18 keeps that table
 * forever while transcripts expire after a year (A15), so an unbounded copy here
 * would quietly undo that retention decision for the largest thing in the
 * stream. Generous enough that a normal message survives whole, small enough
 * that a run stuck repeating itself cannot fill a disk.
 */
export const MAX_PERSISTED_TEXT = 8_000;

/** Event kinds `agent_run_events` accepts (migration 0003, widened by 0011/0014). */
type RunEventKind =
  | 'created'
  | 'started'
  | 'session_ready'
  | 'assistant_text'
  | 'tool_use'
  | 'hook_event'
  | 'permission_denied'
  | 'usage_sample'
  | 'rate_limit_anchor'
  | 'result'
  | 'terminated';

export interface RunnerPaths {
  /** Where `settings.<role>.json` lives (§6.2). */
  roleSettingsDir: string;
  /** `<dataRoot>/runs` — per-run scratch, deliberately not a volume. */
  runsRoot: string;
  /** `<dataRoot>/transcripts` — the §6.2 copy, in the backup per A14. */
  transcriptsRoot: string;
  /**
   * The internal MCP server's entry point, or null.
   *
   * Null means sessions spawn without MCP: a role that cannot look up its own
   * task, which is a degraded run rather than a failed one. The tools verdict is
   * skipped in that case — checking a session for tools nobody granted it would
   * turn a deliberate configuration into an infra failure on every run.
   */
  mcpServerEntry: string | null;
}

/** What this run may touch (§6.6). Passed through to the policy unchanged. */
export interface RunContainmentInput {
  /** The task's worktree, or a staff role's scratch dir. Null = writes nothing. */
  writeRoot: string | null;
  /** Held claim globs, relative to `writeRoot`. Null = scratch, no claims. */
  claims: readonly string[] | null;
  /** A41 — an analysed-only project. */
  readOnlyProject: boolean;
  /** §6.6: the secret-pattern list is extendable per project. Additive only. */
  extraSecretPatterns?: readonly string[];
}

/**
 * The two things the runner needs from §7.1's meter — the two ways an official
 * reading can arrive.
 *
 * Structural rather than `UsageMeter` itself: the runner observes and hands the
 * reading over, and it has no business knowing about windows, calibration or
 * the estimated cross-check. It also keeps the guardian's half of the system
 * out of the runner's test setup.
 *
 * `ingestOfficial` is the *pulled* reading: the runner asks `get_usage` on a
 * timer. `ingestOfficialWindow` is the *pushed* one: the vendor volunteers a
 * percentage in a `rate_limit_event` once a window passes its warning
 * threshold (A73). Under token auth the pulled channel answers nothing at all
 * (A64), so today the pushed one is the only official figure this system ever
 * sees — and it only appears above 75%, which is the band that matters.
 */
export interface UsageSink {
  ingestOfficial(
    payload: GetUsageResponse,
    context: { runId?: string | null },
  ): Promise<UsageSample[]>;
  ingestOfficialWindow(
    window: UsageWindowKind,
    rawUtilization: number,
    context: { runId?: string | null; resetsAt?: number | null; raw?: unknown },
  ): Promise<UsageSample>;
}

/**
 * Where the runner learns whether persona flavour is switched on (A9, §8).
 *
 * `PersonaSettings.mode` behind `personaFlavorEnabled` in the daemon; a bare
 * boolean everywhere the answer is fixed.
 */
export type PersonaFlavorSource = boolean | (() => boolean | Promise<boolean>);

/**
 * Resolve it, and never let it fail a run.
 *
 * A display setting that cannot be read must not cost a session. The fallback
 * is `false`, which is not an arbitrary safe value but the one A9 guarantees:
 * prompts untouched, byte-identical to the profile's own. Failing the other way
 * would mean an unreachable database silently started editing system prompts.
 */
async function resolvePersonaFlavor(
  source: PersonaFlavorSource | undefined,
  onWarning: (message: string) => void,
): Promise<boolean> {
  if (source === undefined) return false;
  if (typeof source === 'boolean') return source;
  try {
    return await source();
  } catch (cause) {
    onWarning(
      `Persona-Einstellung nicht lesbar (${cause instanceof Error ? cause.message : String(cause)}); ` +
        'die Sitzung läuft ohne Persona-Charakter, also mit dem unveränderten Rollen-Prompt.',
    );
    return false;
  }
}

export interface AgentRunnerDeps {
  sql: postgres.Sql;
  eventLog: EventLog;
  backend: ModelBackend;
  paths: RunnerPaths;
  /**
   * Where live sessions announce themselves, so §7.2 can stop them.
   *
   * Optional only because a test that asserts on a run's record does not need
   * one. In the daemon it is not optional in any meaningful sense: without it
   * the guardian's `wrap_up` and `hard_stop` transitions iterate an empty list
   * and stop nothing, while recording that they did.
   */
  activeRuns?: ActiveRunRegistry;
  /** §7.1's meter. Omitted means no usage sampling — tests, mostly. */
  usage?: UsageSink;
  modelPolicy?: ModelPolicy;
  /**
   * A9 — persona flavour reaches a prompt only when the operator turns it on (§8).
   *
   * A source rather than a value, because this is a switch on the settings page
   * (§17.9). Read once at construction it would go stale the instant the operator moved
   * it, and the change would take effect on the next daemon restart — a setting
   * that appears to work, is recorded in §19's trail as having been changed, and
   * quietly does nothing until a deploy. A plain boolean is still accepted:
   * that is what a test pinning the *rendering* wants to say, and it is what
   * `false` means for every caller that never had the setting at all.
   */
  personaFlavor?: PersonaFlavorSource;
  usageIntervalMs?: number;
  now?: () => number;
  /** Live feed for the office view (§17.2). Never allowed to break a run. */
  onEvent?: (event: BackendEvent) => void;
  onWarning?: (message: string) => void;
}

export interface AgentRunRequest<R extends RoleName = RoleName> {
  /**
   * The task this session serves, or null for a session that serves none.
   *
   * Null is the Betriebsprüfung's case (§8.2) and, so far, only its: an audit
   * examines the studio rather than a unit of work, so there is no task to
   * bind to. It carries a consequence rather than being a formality — **a run
   * without a task runs without MCP**, because every tool the internal server
   * registers is either scoped to one task (A48.1) or a Phase 6 stub. A
   * session handed task tools with no task would spend turns discovering that
   * they answer nothing.
   */
  taskId: string | null;
  projectId?: string | null;
  /** The role to run. Its literal `role` is what types the outcome. */
  profile: AgentProfile & { role: R };
  /** The task prompt. Assembled by the caller from the task's context. */
  prompt: string;
  /** Absolute: the task's worktree, or the role's scratch dir (§6.2). */
  cwd: string;
  containment: RunContainmentInput;
  /** The project's own gate and build commands (§11, A46.4). */
  extraTools?: readonly string[];
  /**
   * Tighten this run's caps below the profile's (A32).
   *
   * A **ceiling**, never a raise: every value is taken as the smaller of the
   * two. A caller able to widen a Coder to 500 turns would undo the sizing A32
   * describes, from a call site nobody reviews as carefully as the profile
   * table. Tightening is the case that actually comes up — a demo, a smoke
   * check, a probe that should cost cents rather than a Coder's full budget.
   */
  capsCeiling?: Partial<RunCaps>;
}

/**
 * Continuing a session that is already there (§6.4).
 *
 * The same request as a fresh run, plus the two facts that make it a
 * continuation — and `prompt` changes meaning: it is the *next message*, not the
 * task's mandate. One shape rather than two, because everything else is
 * identical and has to stay identical: a continuation gets its own run record,
 * its own containment policy file, its own MCP config and its own caps, and a
 * second request type would be the place those quietly drift apart.
 *
 * Deliberately not carried: `cwd` is the ordinary field and the caller fills it
 * from the parked run's record. Resume is scoped to the directory the session
 * began in — CLI behaviour — so a continuation pointed anywhere else does not
 * find its session at all, and re-deriving the directory here from the session
 * id would put a guess where the record already has the answer.
 */
export interface AgentResumeRequest<R extends RoleName = RoleName> extends AgentRunRequest<R> {
  /** The session to continue, from `agent_runs.session_id`. */
  sessionId: string;
  /** The run that session belonged to. Linked on the record, never resolved from. */
  resumeOf: string;
}

/** The smaller of each cap. `null` budget means "no limit from that side". */
export function tightenCaps(base: RunCaps, ceiling: Partial<RunCaps> = {}): RunCaps {
  const budgets = [base.maxBudgetUsd, ceiling.maxBudgetUsd].filter(
    (value): value is number => typeof value === 'number',
  );
  return {
    maxTurns: Math.min(base.maxTurns, ceiling.maxTurns ?? base.maxTurns),
    maxBudgetUsd: budgets.length > 0 ? Math.min(...budgets) : null,
    wallClockMs: Math.min(base.wallClockMs, ceiling.wallClockMs ?? base.wallClockMs),
  };
}

export interface RunSummary {
  runId: string;
  /** Null only if the run died before the backend reported one. */
  sessionId: string | null;
  taskId: string | null;
  role: string;
  model: string;
  backend: BackendName;
  cwd: string;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  /**
   * Context the session re-read, which on a Claude Code run dwarfs `tokensIn`
   * by two orders of magnitude and is the bulk of what a window actually
   * consumes. Carried so that §7.1's fallback cross-check has something to
   * reconcile against beyond the vendor's own weighting.
   */
  cacheReadTokens: number;
  cacheCreationTokens: number;
  /** Cost-equivalent, never billed (§2). The estimating meter's unit (A6). */
  costUsd: number;
  /** Cost-equivalent per canonical model class. */
  byModel: Readonly<Record<string, number>>;
  toolUses: number;
  hookEvents: number;
  /** Tool calls the permission layer refused — §6.6's audit trail. */
  denials: number;
  termination: TerminationReason | null;
  exitCode: number | null;
  /** Where the transcript was archived, or null if there is none (§6.2). */
  transcriptPath: string | null;
  /** The result as the model produced it, before validation. */
  resultRaw: unknown;
  /** §6.3: was the one repair re-prompt spent? */
  repairRunId: string | null;
}

export type AgentRunOutcome<R> =
  /** The run finished and its result satisfies the role's contract. */
  | { status: 'ok'; run: RunSummary; result: R }
  /** The harness failed, not the work. Retry with backoff; never red (A25). */
  | { status: 'infra'; run: RunSummary; problem: string }
  /** §6.1: park and alert. Nothing is marked red, ever. */
  | { status: 'auth_incident'; run: RunSummary; problem: string }
  /** §7.3: the guardian or an operator stopped it. Park, then resume. */
  | { status: 'interrupted'; run: RunSummary; problem: string }
  /** The red path (§9): the work did not get done. */
  | { status: 'failed'; run: RunSummary; problem: string };

export type RunOutcomeStatus = AgentRunOutcome<unknown>['status'];

export class RunnerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunnerError';
  }
}

/**
 * Everything the classification depends on, gathered in one place.
 *
 * Separated from the run loop so the decision can be tested without a backend,
 * a database or a clock — and so that the precedence below is readable as a
 * list rather than inferred from a sequence of `if`s scattered through 200
 * lines of I/O.
 */
export interface RunSignals {
  termination: TerminationReason | null;
  /** Skipped (`null`) when the session was spawned without MCP on purpose. */
  tools: SessionToolVerdict | null;
  containment: ContainmentVerdict;
  /** Did any tool call happen at all? */
  toolUses: number;
  /** Did any of them reach a `PreToolUse` hook? */
  sawToolCheck: boolean;
  hasResult: boolean;
  /** Set when the result — after any repair — still fails the role contract. */
  resultProblem: string | null;
}

/**
 * Which of the five outcomes this run had.
 *
 * The order is the whole content of this function:
 *
 *  1. **Auth incident first.** §6.1 makes it an incident rather than a failure,
 *     and it explains every other symptom — a session that could not
 *     authenticate has no tools, no hooks and no result either.
 *  2. **Interrupt second.** A run the guardian stopped in its first second has
 *     no hook events yet, and reading that as "containment never loaded" would
 *     file every wrap-up as an infra failure.
 *  3. **Then the tools verdict**: a session without its tools produces nothing
 *     usable no matter how well contained it was, and it is a retry rather than
 *     a red task (§11, A25).
 *  4. **Then uncontained tool calls** — a run that called tools with no
 *     `PreToolUse` event behind it ran unchecked (§6.6). The hook matcher is
 *     `*`, so *any* tool call must have produced one; a run that called nothing
 *     proves nothing and is not accused. This is *evidence* rather than an
 *     absence, which is why it outranks the crash below.
 *  5. **Then a crash**, ahead of the containment liveness check and for the
 *     same reason as the interrupt in 2: a process that never started has no
 *     `SessionStart` hook either, and the monitor fails closed on that. Both are
 *     `infra`, so only the reported cause differs — and reporting a missing
 *     working directory as "containment did not load" sends the reader to the
 *     wrong file entirely (observed, A58).
 *  6. **Then containment liveness** — the session ran but its `--settings`
 *     document never took effect, which in `-p` mode happens silently.
 *  7. **Then the caps** (A32) and the contract (§6.3), which are the only
 *     things left that are genuinely about the work.
 */
export function classifyRun(signals: RunSignals): { status: RunOutcomeStatus; problem: string } {
  if (signals.termination === 'auth_incident') {
    return {
      status: 'auth_incident',
      problem:
        'Die Sitzung konnte sich nicht anmelden. Das ist ein Auth-Vorfall (§6.1), ' +
        'keine gescheiterte Aufgabe — nichts wird rot markiert.',
    };
  }
  if (signals.termination === 'interrupted') {
    return {
      status: 'interrupted',
      problem: 'Die Sitzung wurde planmäßig angehalten (§7.3). Die Aufgabe wird geparkt.',
    };
  }
  if (signals.tools && !signals.tools.ok) {
    return { status: 'infra', problem: signals.tools.problem };
  }
  // Hard evidence of an uncontained tool call outranks everything below,
  // including a subsequent crash: a session that wrote without a `PreToolUse`
  // behind it is the fact worth reporting, whatever happened to it afterwards.
  if (signals.toolUses > 0 && !signals.sawToolCheck) {
    return {
      status: 'infra',
      problem:
        `Die Sitzung rief ${signals.toolUses} Werkzeug(e) auf, ohne dass ein einziger ` +
        'PreToolUse-Hook dazu gemeldet wurde. Der Matcher ist "*" — jeder Aufruf müsste ' +
        'einen erzeugen. Die Aufrufe liefen also ungeprüft durch (§6.6).',
    };
  }
  // A crash outranks the containment *liveness* verdict, for the same reason
  // the interrupt above does: a process that never started has no `SessionStart`
  // hook event either, and the monitor fails closed on exactly that evidence.
  // Both classify as `infra`, so nothing about the studio's behaviour changes —
  // what changes is the sentence a human reads. Observed for real: a smoke
  // session whose working directory did not exist never spawned, and the daemon
  // reported "the role settings were not loaded, the session ran without the
  // §6.6 containment hooks" — a true statement about a session that had not
  // happened, pointing at entirely the wrong file.
  if (signals.termination === 'crashed') {
    return {
      status: 'infra',
      problem:
        'Der Sitzungsprozess endete unerwartet. Behandelt als Infrastrukturfehler ' +
        '(§11, A25) — mit Backoff wiederholen, nicht rot markieren.',
    };
  }
  if (!signals.containment.ok) {
    return { status: 'infra', problem: signals.containment.problem };
  }
  if (signals.termination === 'max_turns') {
    return { status: 'failed', problem: 'Zuglimit erreicht (A32); die Arbeit wurde nicht fertig.' };
  }
  if (signals.termination === 'max_budget') {
    return {
      status: 'failed',
      problem: 'Budgetgrenze des Laufs erreicht (A32); die Arbeit wurde nicht fertig.',
    };
  }
  if (signals.termination === 'timeout') {
    return {
      status: 'failed',
      problem: 'Wanduhr-Grenze des Laufs erreicht (A32); die Arbeit wurde nicht fertig.',
    };
  }
  if (!signals.hasResult) {
    return {
      status: 'failed',
      problem:
        'Die Sitzung endete ohne Ergebnisnachricht. Ohne sie ist nicht feststellbar, ' +
        'was getan wurde (§6.3).',
    };
  }
  if (signals.resultProblem) {
    return {
      status: 'failed',
      problem: `Ergebnis erfüllt den Rollenvertrag nicht: ${signals.resultProblem}`,
    };
  }
  return { status: 'ok', problem: '' };
}

/** What §6.3's one repair attempt says. English — agents work in English (§2). */
export function repairPrompt(role: string, problem: string): string {
  return [
    `Your previous message did not satisfy the result contract for the role "${role}".`,
    `Validation reported: ${problem}`,
    '',
    'Reply with the structured result and nothing else. Do not run tools, do not',
    'change files and do not redo any work — restate what you already did, in the',
    'shape the contract requires.',
  ].join('\n');
}

/** Appends one run's events, in order, with gap-free per-run sequence numbers. */
class RunRecorder {
  private seq = 0;

  constructor(
    private readonly sql: postgres.Sql,
    readonly runId: string,
  ) {}

  async write(kind: RunEventKind, payload: Record<string, unknown> = {}): Promise<void> {
    const seq = this.seq++;
    await this.sql`
      INSERT INTO agent_run_events (run_id, seq, kind, payload)
      VALUES (${this.runId}, ${seq}, ${kind}, ${this.sql.json(payload as postgres.JSONValue)})
    `;
  }
}

/** Everything one leg of a run (first attempt, or the repair) produced. */
interface LegResult {
  sessionId: string | null;
  termination: TerminationReason | null;
  exitCode: number | null;
  tokensIn: number;
  tokensOut: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  byModel: Record<string, number>;
  toolUses: number;
  hookEvents: number;
  denials: number;
  hasResult: boolean;
  resultRaw: unknown;
  tools: SessionToolVerdict | null;
  containment: ContainmentVerdict;
  sawToolCheck: boolean;
  transcriptPath: string | null;
}

/**
 * A leg that never happened.
 *
 * `containment: { ok: true }` on purpose: nothing was contained because nothing
 * ran, and a fail-closed verdict here would report "the session ran without its
 * write boundary" for a session that never started — pointing every reader at
 * the wrong problem. `crashed` is the honest signal and it classifies as an
 * infra failure on its own.
 */
function crashedLeg(): LegResult {
  return {
    sessionId: null,
    termination: 'crashed',
    exitCode: null,
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    costUsd: 0,
    byModel: {},
    toolUses: 0,
    hookEvents: 0,
    denials: 0,
    hasResult: false,
    resultRaw: null,
    tools: null,
    containment: { ok: true },
    sawToolCheck: false,
    transcriptPath: null,
  };
}

export class AgentRunner {
  constructor(private readonly deps: AgentRunnerDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private warn(message: string): void {
    this.deps.onWarning?.(message);
  }

  /**
   * Persist an observed window boundary (§7.1's estimator, A59).
   *
   * Never allowed to break a run: a missing anchor degrades the estimate from
   * exact to rolling, and rolling over-counts (see `estimate.ts`). Losing a
   * session over a bookkeeping row would be the wrong trade by a wide margin —
   * the same reasoning that already guards the usage sampler above.
   */
  private async recordAnchor(
    window: string,
    resetsAt: number,
    status: string,
    runId: string,
  ): Promise<void> {
    try {
      await this.deps.sql`
        INSERT INTO usage_window_anchors (window_kind, resets_at, status, run_id)
        VALUES (${window}, ${new Date(resetsAt)}, ${status}, ${runId})
        ON CONFLICT (window_kind, resets_at) DO NOTHING
      `;
    } catch (error) {
      this.warn(`Fenstergrenze konnte nicht gespeichert werden: ${(error as Error).message}`);
    }
  }

  /** One fresh session, start to classified outcome. */
  async run<R extends RoleName>(
    request: AgentRunRequest<R>,
  ): Promise<AgentRunOutcome<RoleResult<R>>> {
    return this.execute(request, null);
  }

  /**
   * §6.4: continue a parked session with the operator's decision as its next message.
   *
   * Its own run in the record, linked by `resumeOf`, for the reason §6.3's
   * repair leg is one (A53.5): it is a separate session invocation with its own
   * tokens, its own transcript and its own outcome, and folding it into the run
   * that parked would make the token figures wrong and hide that a decision was
   * ever injected. That linkage is also the only durable evidence connecting an
   * answer in the inbox to the work that followed from it.
   *
   * Unlike the repair leg this one gets its tools, its MCP server and its full
   * caps back: the repair restates a result it already has, this one goes back to
   * work. Which is exactly why `settingsPath` is not optional anywhere in
   * `ResumeSpec` — a session that resumes writing without §6.6's hooks is
   * uncontained at the one moment it matters (A51.4).
   */
  async resume<R extends RoleName>(
    request: AgentResumeRequest<R>,
  ): Promise<AgentRunOutcome<RoleResult<R>>> {
    if (!this.deps.backend.capabilities().supportsResume) {
      throw new RunnerError(
        `Backend "${this.deps.backend.name}" kann eine Sitzung nicht fortsetzen — ` +
          'die Runde aus §6.4 ist damit nicht ausführbar.',
      );
    }
    if (!request.sessionId.trim()) {
      throw new RunnerError(
        'Fortsetzen ohne Sitzungskennung (§6.4). Der geparkte Lauf hat keine ' +
          'aufgezeichnet — die Sitzung ist nicht wieder aufnehmbar.',
      );
    }
    return this.execute(request, { sessionId: request.sessionId, resumeOf: request.resumeOf });
  }

  private async execute<R extends RoleName>(
    request: AgentRunRequest<R>,
    continuation: { sessionId: string; resumeOf: string } | null,
  ): Promise<AgentRunOutcome<RoleResult<R>>> {
    const { profile, taskId } = request;
    const writes = profileWrites(profile);

    // A41, refused before a single token is spent. The worktree manager already
    // refuses at its entrance; this is the last checkpoint before a model sees
    // the files, and a read-only project reaching a writing role is a bug in the
    // caller rather than a task that failed.
    if (request.containment.readOnlyProject && writes) {
      throw new RunnerError(
        `Profil "${profile.id}" darf schreiben, das Projekt ist aber als nur lesbar ` +
          'gekennzeichnet (A41). Die Sitzung wird nicht gestartet.',
      );
    }
    if (!request.cwd.startsWith('/')) {
      throw new RunnerError(`Arbeitsverzeichnis "${request.cwd}" ist nicht absolut (§6.2).`);
    }
    // Checked here rather than left to `spawn`, because the failure it produces
    // is unreadable: the process never starts, so there is no pid, no exit code
    // and no hook event — and the run is then indistinguishable from a session
    // whose containment did not load. Observed on the first wired daemon start,
    // where the smoke session's scratch directory did not exist and the log
    // blamed §6.6 (A58). A directory is cheap to check and the alternative is
    // an error message that points at the wrong subsystem.
    if (!existsSync(request.cwd)) {
      throw new RunnerError(
        `Arbeitsverzeichnis "${request.cwd}" existiert nicht — die Sitzung wird nicht ` +
          'gestartet. (Ein Prozess mit fehlendem cwd startet gar nicht erst, und der ' +
          'Fehler sähe danach wie ein Containment-Problem aus.)',
      );
    }

    const runId = randomUUID();
    const model = resolveModel(profile, this.deps.modelPolicy);
    const recorder = new RunRecorder(this.deps.sql, runId);
    const startedAt = this.now();

    // Before anything that could spawn a process (see the header, point 2).
    await recorder.write('created', {
      taskId,
      projectId: request.projectId ?? null,
      role: profile.id,
      contract: profile.role,
      model,
      backend: this.deps.backend.name,
      cwd: request.cwd,
      caps: tightenCaps(profile.caps, request.capsCeiling),
      writes,
      // A continuation knows its session id before anything spawns — which is
      // precisely the case 0011's COALESCE over `created`/`started` was written
      // for. Recorded here as well as on `started`, so a continuation that dies
      // during startup still says which session it was continuing.
      ...(continuation
        ? { sessionId: continuation.sessionId, resumeOf: continuation.resumeOf }
        : {}),
    });
    await this.deps.eventLog.append({
      kind: 'run.created',
      actor: profile.id,
      taskId,
      runId,
      projectId: request.projectId ?? null,
      payload: {
        role: profile.id,
        model,
        backend: this.deps.backend.name,
        cwd: request.cwd,
        resumeOf: continuation?.resumeOf ?? null,
      },
    });

    let leg: LegResult;
    let repairRunId: string | null = null;
    let resultProblem: string | null = null;
    let parsed: RoleResult<R> | null = null;
    /** Set when the run never got far enough to have a verdict of its own. */
    let harnessProblem: string | null = null;
    let spec: ReturnType<typeof buildSessionSpec> | null = null;

    try {
      const policy: RunContainmentPolicy = {
        runId,
        taskId,
        role: profile.id,
        writeRoot: request.containment.writeRoot,
        claims: request.containment.claims,
        extraSecretPatterns: request.containment.extraSecretPatterns ?? [],
        readOnlyProject: request.containment.readOnlyProject,
      };
      const policyPath = await writeRunPolicy({ runsRoot: this.deps.paths.runsRoot, policy });
      // No task, no MCP — see `AgentRunRequest.taskId`. The config file's whole
      // job is to bind a session to one task; written without one it would grant
      // tools that cannot answer.
      const mcpConfigPath =
        this.deps.paths.mcpServerEntry && taskId
          ? await writeMcpRunConfig({
              runsRoot: this.deps.paths.runsRoot,
              runId,
              taskId,
              role: profile.id,
              serverEntry: this.deps.paths.mcpServerEntry,
            })
          : null;

      spec = buildSessionSpec({
        profile,
        runId,
        prompt: request.prompt,
        cwd: request.cwd,
        paths: { roleSettingsDir: this.deps.paths.roleSettingsDir, policyPath, mcpConfigPath },
        ...(this.deps.modelPolicy ? { policy: this.deps.modelPolicy } : {}),
        personaFlavor: await resolvePersonaFlavor(this.deps.personaFlavor, (m) => this.warn(m)),
        extraTools: request.extraTools ?? [],
        caps: tightenCaps(profile.caps, request.capsCeiling),
      });

      const handle = continuation
        ? await this.deps.backend.resume({
            sessionId: continuation.sessionId,
            cwd: request.cwd,
            message: request.prompt,
            settingsPath: spec.settingsPath,
            env: spec.env,
            // A continuation inherits the session's history and none of its
            // command line (A53.5). Everything the role needs to keep *working*
            // has to be restated, which is the whole difference between this and
            // §6.3's repair leg — that one deliberately restates neither tools
            // nor MCP, because it must not start working again.
            resultSchema: spec.resultSchema,
            model: spec.model,
            allowedTools: spec.allowedTools,
            mcpConfigPath: spec.mcpConfigPath,
            caps: spec.caps,
          })
        : await this.deps.backend.spawn(spec);
      leg = await this.consume(handle, recorder, {
        // Skipped deliberately when no server was configured: see `RunnerPaths`.
        expectTools: mcpConfigPath ? profile.mcpTools : null,
        identity: { taskId, role: profile.id },
      });
    } catch (error) {
      // A run that could not be started or could not be drained: a missing CLI,
      // an unwritable scratch directory, a database that went away mid-stream.
      // All of them are the harness rather than the work (§11, A25) — and all of
      // them have to leave a *closed* run behind, because a run with no terminal
      // event stays "live" until the next restart, and `reconcile()` would then
      // mark the task `interrupted` for a session that never existed.
      harnessProblem = `Sitzung konnte nicht ausgeführt werden: ${(error as Error).message}`;
      this.warn(harnessProblem);
      await recorder
        .write('terminated', { reason: 'crashed', exitCode: null, problem: harnessProblem })
        .catch(() => undefined);
      leg = crashedLeg();
    }

    // §6.3: exactly one repair attempt, and only for the failure it is meant
    // for — a session that produced *something* the contract refuses. A run
    // that crashed, hit a cap or was interrupted has a different problem, and
    // spending a second session on it would cost budget to learn nothing.
    if (spec && leg.termination === 'completed' && leg.hasResult) {
      const first = parseAgentResult(profile.role, leg.resultRaw);
      if (first.ok) {
        parsed = first.result as RoleResult<R>;
      } else if (leg.sessionId && this.deps.backend.capabilities().supportsResume) {
        try {
          const repair = await this.repair(request, spec, leg.sessionId, first.problem);
          repairRunId = repair.runId;
          leg = { ...leg, ...repair.leg, sessionId: leg.sessionId };
          const second = parseAgentResult(profile.role, repair.leg.resultRaw);
          if (second.ok) parsed = second.result as RoleResult<R>;
          else resultProblem = `${first.problem} (auch nach Nachbesserung: ${second.problem})`;
        } catch (error) {
          // The repair is a courtesy, not a requirement. If it cannot run, the
          // original verdict stands rather than being replaced by a second
          // problem the reader did not ask about.
          this.warn(`Nachbesserung nicht möglich: ${(error as Error).message}`);
          resultProblem = first.problem;
        }
      } else {
        resultProblem = first.problem;
      }
    }

    await removeRunDir(this.deps.paths.runsRoot, runId);

    const verdict = harnessProblem
      ? ({ status: 'infra', problem: harnessProblem } as const)
      : classifyRun({
          termination: leg.termination,
          tools: leg.tools,
          containment: leg.containment,
          toolUses: leg.toolUses,
          sawToolCheck: leg.sawToolCheck,
          hasResult: leg.hasResult,
          resultProblem,
        });

    const summary: RunSummary = {
      runId,
      sessionId: leg.sessionId,
      taskId,
      role: profile.id,
      model,
      backend: this.deps.backend.name,
      cwd: request.cwd,
      durationMs: this.now() - startedAt,
      tokensIn: leg.tokensIn,
      tokensOut: leg.tokensOut,
      cacheReadTokens: leg.cacheReadTokens,
      cacheCreationTokens: leg.cacheCreationTokens,
      costUsd: leg.costUsd,
      byModel: leg.byModel,
      toolUses: leg.toolUses,
      hookEvents: leg.hookEvents,
      denials: leg.denials,
      termination: leg.termination,
      exitCode: leg.exitCode,
      transcriptPath: leg.transcriptPath,
      resultRaw: leg.resultRaw,
      repairRunId,
    };

    await this.deps.eventLog.append({
      kind: verdict.status === 'interrupted' ? 'run.interrupted' : 'run.finished',
      actor: profile.id,
      taskId,
      runId,
      projectId: request.projectId ?? null,
      payload: {
        outcome: verdict.status,
        problem: verdict.problem || null,
        termination: leg.termination,
        durationMs: summary.durationMs,
        tokensIn: leg.tokensIn,
        tokensOut: leg.tokensOut,
        cacheReadTokens: leg.cacheReadTokens,
        costUsd: leg.costUsd,
        denials: leg.denials,
        repairRunId,
        transcriptPath: leg.transcriptPath,
      },
    });

    if (verdict.status === 'ok' && parsed) return { status: 'ok', run: summary, result: parsed };
    if (verdict.status === 'ok') {
      // Cannot happen through `classifyRun` — kept because "ok without a result"
      // is the one combination that would hand a caller an undefined and let it
      // proceed as though the work were done.
      return {
        status: 'failed',
        run: summary,
        problem: 'Lauf als erfolgreich eingestuft, aber ohne geprüftes Ergebnis.',
      };
    }
    return { status: verdict.status, run: summary, problem: verdict.problem };
  }

  /**
   * §6.3's repair leg.
   *
   * Its own run in the record, linked by `repairOf`, because it is its own
   * session with its own tokens and its own transcript — folding it into the
   * first run's row would make the token figures wrong and hide that a repair
   * happened at all, which is exactly the signal Controlling wants when a role's
   * prompt starts producing malformed results.
   */
  private async repair(
    request: AgentRunRequest,
    spec: ReturnType<typeof buildSessionSpec>,
    sessionId: string,
    problem: string,
  ): Promise<{ runId: string; leg: LegResult }> {
    const handle = await this.deps.backend.resume({
      sessionId,
      cwd: request.cwd,
      message: repairPrompt(request.profile.role, problem),
      settingsPath: spec.settingsPath,
      env: spec.env,
      resultSchema: spec.resultSchema,
      model: spec.model,
      // No tools and no MCP: the repair restates a result it already has. A
      // session handed its tools back would be free to start working again,
      // and the second answer would then describe work the first run's record
      // does not contain.
      allowedTools: [],
      mcpConfigPath: null,
      caps: { maxTurns: 2, maxBudgetUsd: 1, wallClockMs: 5 * 60_000 },
    });

    const recorder = new RunRecorder(this.deps.sql, handle.runId);
    await recorder.write('created', {
      taskId: request.taskId,
      projectId: request.projectId ?? null,
      role: request.profile.id,
      contract: request.profile.role,
      model: spec.model,
      backend: this.deps.backend.name,
      cwd: request.cwd,
      repairOf: spec.runId,
      repairReason: problem,
    });

    const leg = await this.consume(handle, recorder, {
      expectTools: null,
      identity: { taskId: request.taskId, role: request.profile.id },
    });
    return { runId: handle.runId, leg };
  }

  /**
   * Drain one run's event stream into the record, and hand back what it means.
   *
   * The usage poll runs alongside rather than inside the loop: §7.1's meter has
   * to sample *during* a session, because once the result arrives stdin is
   * closed and there is nobody left to answer (verified — `queryUsage` returns
   * null immediately after that, by design).
   */
  private async consume(
    handle: RunHandle,
    recorder: RunRecorder,
    options: {
      expectTools: readonly McpToolName[] | null;
      /** Who this session belongs to, for the live registry (§7.2). */
      identity: { taskId: string | null; role: string };
    },
  ): Promise<LegResult> {
    // §7.2: the guardian stops what it can see. Registered here rather than at
    // the two call sites because this is exactly the window in which the session
    // is alive — from the first event to the terminal one — and because both the
    // ordinary leg and §6.3's repair leg pass through here, so neither can be
    // forgotten. The deregister runs in the `finally` that also stops the usage
    // poll: a run left in the registry after it ended would be interrupted and
    // killed by a later guardian transition, against a process that no longer
    // exists, and `kill()` would raise where nobody is catching.
    const release = this.deps.activeRuns?.register({
      // The *record's* run id, not the handle's. They coincide for a spawn and
      // for §6.3's repair, and diverge for §6.4's continuation: `resume()` mints
      // its own id inside the backend, and a registry keyed by that one would
      // list live sessions under ids `agent_runs` has never heard of — so the
      // guardian's own log of what it stopped would name nothing findable.
      runId: recorder.runId,
      taskId: options.identity.taskId,
      role: options.identity.role,
      cwd: handle.cwd,
      startedAt: this.now(),
      interrupt: (reason) => handle.interrupt(reason),
      kill: () => handle.kill(),
    });

    const monitor = new ContainmentMonitor();
    const leg: LegResult = {
      sessionId: null,
      termination: null,
      exitCode: null,
      tokensIn: 0,
      tokensOut: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      byModel: {},
      toolUses: 0,
      hookEvents: 0,
      denials: 0,
      hasResult: false,
      resultRaw: null,
      tools: null,
      containment: { ok: true },
      sawToolCheck: false,
      transcriptPath: null,
    };

    let sampling: Promise<void> = Promise.resolve();
    const sample = async (): Promise<void> => {
      if (!this.deps.usage) return;
      if (!this.deps.backend.capabilities().supportsUsageQuery) return;
      try {
        const payload = await handle.queryUsage();
        if (!payload) return;
        const samples = await this.deps.usage.ingestOfficial(payload, { runId: recorder.runId });
        await recorder.write('usage_sample', {
          samples: samples.map((s) => ({
            window: s.window,
            usedPercent: s.usedPercent,
            source: s.source,
          })),
        });
      } catch (error) {
        // A budget reading that could not be taken is a gap the guardian
        // already handles (it fails closed on a stale window); losing the run
        // over it would be the worse trade by a wide margin.
        this.warn(`Usage-Abfrage fehlgeschlagen: ${(error as Error).message}`);
      }
    };
    const poll = setInterval(() => {
      sampling = sampling.then(sample);
    }, this.deps.usageIntervalMs ?? DEFAULT_USAGE_INTERVAL_MS);
    poll.unref();

    try {
      for await (const event of handle.events()) {
        try {
          this.deps.onEvent?.(event);
        } catch (error) {
          this.warn(`Ereignis-Abnehmer warf: ${(error as Error).message}`);
        }
        monitor.observe(event);

        switch (event.type) {
          case 'run_started':
            leg.sessionId = event.sessionId;
            await recorder.write('started', { sessionId: event.sessionId, pid: event.pid });
            break;
          case 'session_ready':
            await recorder.write('session_ready', {
              mcpServers: event.mcpServers,
              toolCount: event.tools.length,
              tools: event.tools,
            });
            if (options.expectTools) {
              leg.tools = assessSessionTools(event, options.expectTools);
            }
            // The first budget reading, as early as the session can answer one.
            // Without it a run shorter than the polling interval would produce
            // no sample at all, and a busy day is made of short runs.
            sampling = sampling.then(sample);
            break;
          case 'assistant_text': {
            const text = event.text.slice(0, MAX_PERSISTED_TEXT);
            await recorder.write('assistant_text', {
              text,
              truncated: text.length < event.text.length,
            });
            break;
          }
          case 'tool_use':
            leg.toolUses += 1;
            await recorder.write('tool_use', { tool: event.tool, input: event.input });
            break;
          case 'hook_event':
            leg.hookEvents += 1;
            await recorder.write('hook_event', {
              event: event.event,
              hookName: event.hookName,
              phase: event.phase,
              outcome: event.outcome,
              exitCode: event.exitCode,
            });
            break;
          case 'permission_denied':
            leg.denials += 1;
            await recorder.write('permission_denied', { tool: event.tool, input: event.input });
            break;
          case 'usage_sample':
            await recorder.write('usage_sample', { sample: event.sample });
            break;
          case 'rate_limit_anchor':
            // The window boundary, kept where §7.1's estimator can find it.
            // Recorded on the run *and* in `usage_window_anchors`: the run
            // record is the trace, the table is the query — the estimator asks
            // for the newest anchor per window on every tick, and scanning an
            // append-only event stream for that would get slower every day.
            await recorder.write('rate_limit_anchor', {
              window: event.window,
              resetsAt: event.resetsAt,
              status: event.status,
              utilization: event.utilization,
            });
            await this.recordAnchor(event.window, event.resetsAt, event.status, recorder.runId);
            // Above the vendor's warning threshold the frame also carries the
            // real percentage — the only official figure obtainable under token
            // auth (A64, A73). It is persisted as an `official` sample, which
            // outranks the estimate in `projectSamples`, so from 75% upwards
            // §7.2 acts on a measurement instead of on `PLAN_BUDGETS`.
            if (event.utilization !== null) {
              await this.deps.usage?.ingestOfficialWindow(event.window, event.utilization, {
                runId: recorder.runId,
                resetsAt: event.resetsAt,
                raw: { source: 'rate_limit_event', status: event.status },
              });
            }
            break;
          case 'result':
            leg.hasResult = true;
            leg.resultRaw = event.raw;
            leg.tokensIn = event.tokensIn;
            leg.tokensOut = event.tokensOut;
            leg.cacheReadTokens = event.cacheReadTokens;
            leg.cacheCreationTokens = event.cacheCreationTokens;
            leg.costUsd = event.costUsd;
            leg.byModel = { ...event.byModel };
            await recorder.write('result', {
              raw: event.raw,
              tokensIn: event.tokensIn,
              tokensOut: event.tokensOut,
              cacheReadTokens: event.cacheReadTokens,
              cacheCreationTokens: event.cacheCreationTokens,
              // `agent_runs.cost_usd` has read this key since migration 0003 and
              // nothing had ever written it — the column was NULL on every run
              // ever recorded. §7.1's estimator is the first consumer, which is
              // how a view column with no producer came to light.
              costUsd: event.costUsd,
              byModel: event.byModel,
            });
            // The reading that actually works, and the last moment it can be
            // taken (A58).
            //
            // `get_usage` answers `rate_limits_available: false, rate_limits:
            // null` until the session has made an API call — verified against
            // the pinned CLI. So the sample on `session_ready` above, which is
            // the *only* one a short session ever reaches, is always blind, and
            // the meter recorded an `unavailable` sentinel for it. That is
            // correct behaviour for an unreadable budget and it left the
            // guardian permanently in `wrap_up`: on a fresh installation the
            // studio could never start.
            //
            // Here the answer exists and the session is still alive. The
            // backend closes stdin in `finishAfterResult()` — which runs when
            // the generator is *resumed*, i.e. after this block returns — so
            // this is the last instant at which there is anybody to ask.
            // Awaited rather than chained for exactly that reason.
            sampling = sampling.then(sample);
            await sampling;
            break;
          case 'terminated':
            leg.termination = event.reason;
            leg.exitCode = event.exitCode;
            break;
        }
      }
    } finally {
      release?.();
      clearInterval(poll);
      // A sample still in flight would otherwise land after `terminated` and
      // leave the run's last event something other than its ending.
      await sampling;
    }

    leg.containment = monitor.verdict();
    leg.sawToolCheck = monitor.sawToolCheck();

    // §6.2's copy, taken before the terminal event so the record points at it.
    const archived = await archiveTranscript({
      transcriptsRoot: this.deps.paths.transcriptsRoot,
      runId: recorder.runId,
      source: await handle.transcriptPath().catch(() => null),
      now: () => this.now(),
    });
    if (archived.archived) leg.transcriptPath = archived.path;
    else this.warn(`Lauf ${recorder.runId}: ${archived.problem}`);

    await recorder.write('terminated', {
      reason: leg.termination ?? 'crashed',
      exitCode: leg.exitCode,
      transcriptPath: leg.transcriptPath,
      transcriptProblem: archived.archived ? null : archived.problem,
      containmentOk: leg.containment.ok,
      toolUses: leg.toolUses,
      hookEvents: leg.hookEvents,
      denials: leg.denials,
    });

    return leg;
  }
}
