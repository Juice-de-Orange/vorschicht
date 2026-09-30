/**
 * In-process `fake` backend (A37).
 *
 * Not in the original spec, and the Phase 1 exit gate is why it exists:
 * "simulated usage streams prove the guardian's behaviour as automated tests".
 * Proving that against the real backend would mean spending subscription budget
 * on every test run, and — worse — it would mean the adversarial cases can only
 * be tested when the real service happens to produce them. `rate_limits_available:
 * false`, a reset timestamp in the past, a jump from 84.9% to 95.1% with no
 * sample in between: none of those can be requested from a real API, and all of
 * them have to work.
 *
 * It passes the same contract suite as `headless`. That is the discipline that
 * keeps it honest — a fake that drifts from the real thing tests nothing.
 */
import { randomUUID } from 'node:crypto';
import type {
  BackendCapabilities,
  BackendEvent,
  GetUsageResponse,
  SessionSpec,
} from '@vorschicht/shared';
import type { BackendName, ModelBackend, ResumeSpec, RunHandle, StopReason } from './types.js';

/**
 * One scripted event, with the run id left off — the handle owns that.
 *
 * Distributive on purpose: a bare `Omit<BackendEvent, 'runId'>` collapses the
 * union to the keys every member shares, which is `type` and nothing else. The
 * old form therefore rejected `{ type: 'assistant_text', text: '…' }` and every
 * script in the repository carried an `as never` to get past it — a cast that
 * would also have swallowed a genuinely wrong event shape.
 */
export type FakeEvent = BackendEvent extends infer E
  ? E extends { runId: string }
    ? Omit<E, 'runId'>
    : never
  : never;

/** A scripted run: what the fake should emit, and how it should end. */
export interface FakeScript {
  /** Events emitted before the terminal one, in order. */
  events?: FakeEvent[];
  /** Fault injection (A37): what `session_ready` reports about MCP. */
  mcpServers?: Array<{ name: string; status: string }>;
  /** Milliseconds between events, so tests can exercise interrupt timing. */
  stepDelayMs?: number;
  /** Usage payloads returned by successive `queryUsage()` calls. */
  usage?: Array<GetUsageResponse | null>;
  /**
   * Report `supportsUsageQuery: false` (A37 — fault injection).
   *
   * A backend that cannot answer a usage query is a real configuration, not a
   * hypothetical: both A31 stubs are one, and so is any future `api-key`
   * backend. The `ModelBackend` contract has a branch for it — `queryUsage`
   * must answer null — and until this switch existed nothing could reach that
   * branch, because the only backend the contract suite ever ran against
   * hard-coded the capability to true. The assertion was therefore executing
   * zero expectations, which is the shape §8.2's third domain asks about.
   */
  supportsUsageQuery?: boolean;
  /** How the run ends if it is left alone. */
  terminal?: Extract<BackendEvent, { type: 'terminated' }>['reason'];
  exitCode?: number;
  /**
   * Structured result handed back before termination.
   *
   * The cost and cache fields are optional here and only here: a fixture that
   * cares about the §6.3 contract should not have to invent a token breakdown,
   * while one that drives §7.1's estimator states exactly the numbers it means.
   */
  result?: {
    raw: unknown;
    tokensIn: number;
    tokensOut: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    costUsd?: number;
    byModel?: Readonly<Record<string, number>>;
  };
  /** Make `spawn` itself fail — used to test the runner's error path. */
  failOnSpawn?: string;
  /**
   * A session log to hand back, or null for a backend that keeps none.
   *
   * Both answers are real: the headless backend has a transcript, an in-process
   * one does not, and the runner has to behave for both. A test that wants the
   * §6.2 archive step exercised points this at a fixture file.
   */
  transcriptPath?: string | null;
  /**
   * What a *continuation* emits, when it should differ from the first run.
   *
   * §6.3's repair re-prompt is the case: the first run answers with something
   * the role schema refuses and the second answers correctly, and a fake that
   * replayed one script for both could only ever test the half where the repair
   * fails too.
   */
  onResume?: FakeScript;
}

/**
 * Decide what a given session should do, from the spec it was spawned with.
 *
 * Needed the moment more than one role runs in a single test: §8.1's chain
 * spawns a Planner, a Coder and a Reviewer against one backend, and each has to
 * answer with its own role's contract. May also perform a side effect before
 * returning — writing the file a Coder is pretending to have written, say —
 * which is how a scripted session produces a real diff for the claim check.
 */
export type FakeScriptResolver = (spec: SessionSpec) => FakeScript | Promise<FakeScript>;

export class FakeBackend implements ModelBackend {
  readonly name: BackendName = 'fake';
  /** Every run this backend produced, for assertions. */
  readonly runs: FakeRunHandle[] = [];
  /** Every spawn spec, so a test can assert what was actually asked for. */
  readonly spawns: SessionSpec[] = [];
  /** Every continuation spec — §6.3's repair leg is asserted through this. */
  readonly resumes: ResumeSpec[] = [];
  /**
   * Which script each live session got.
   *
   * `resume()` has no role and no profile — it continues a session by id — so
   * the only way for a continuation to reach the right `onResume` is to
   * remember what the original spawn resolved to.
   */
  private readonly bySession = new Map<string, FakeScript>();

  constructor(private readonly script: FakeScript | FakeScriptResolver = {}) {}

  capabilities(): BackendCapabilities {
    // A resolver decides per session and capabilities are a property of the
    // backend, so only a plain script can turn this off.
    const script = typeof this.script === 'function' ? {} : this.script;
    return {
      supportsResume: true,
      supportsStructuredOutput: true,
      supportsUsageQuery: script.supportsUsageQuery ?? true,
      supportsInterrupt: true,
    };
  }

  async spawn(spec: SessionSpec): Promise<RunHandle> {
    this.spawns.push(spec);
    const script = typeof this.script === 'function' ? await this.script(spec) : this.script;
    if (script.failOnSpawn) throw new Error(script.failOnSpawn);
    const sessionId = `fake-session-${spec.runId}`;
    this.bySession.set(sessionId, script);
    const handle = new FakeRunHandle(spec.runId, sessionId, spec.cwd, script, spec.allowedTools);
    this.runs.push(handle);
    return handle;
  }

  async resume(spec: ResumeSpec): Promise<RunHandle> {
    this.resumes.push(spec);
    // The contract suite asserts this refusal on every backend: a continuation
    // without role settings is a continuation without §6.6's hooks, and the
    // `fake` backend has to fail the same way the real one does or it stops
    // being a stand-in for it (A37).
    if (!spec.settingsPath) {
      throw new Error(
        'Fortsetzen ohne Rollen-Settings: die Sitzung liefe ohne die Containment-Hooks ' +
          'aus §6.6, und zwar genau dann, wenn sie wieder zu schreiben beginnt.',
      );
    }
    const original =
      this.bySession.get(spec.sessionId) ?? (typeof this.script === 'function' ? {} : this.script);
    const handle = new FakeRunHandle(
      // A fresh id, and a real UUID: a continuation is its own run in the
      // record (`agent_runs.repair_of` links the two), and `run_id` is a uuid
      // column — a readable `resumed-…` string would fail at the first insert.
      randomUUID(),
      spec.sessionId,
      spec.cwd,
      original.onResume ?? original,
      // What the continuation was actually granted. The headless backend puts
      // `resume.allowedTools` on the command line and the CLI reports them back
      // at `system:init`, so a fake that always reported none would make every
      // §6.4 continuation fail the tools verdict as an infra error — and the
      // §6.3 repair leg, which restates no tools, would be the only shape that
      // ever passed. A37: a fake that drifts from the real thing tests nothing.
      spec.allowedTools ?? [],
    );
    this.runs.push(handle);
    return handle;
  }
}

export class FakeRunHandle implements RunHandle {
  interrupted: StopReason | null = null;
  killed = false;
  private usageCalls = 0;

  constructor(
    readonly runId: string,
    readonly sessionId: string,
    readonly cwd: string,
    private readonly script: FakeScript,
    /** Mirrors what the headless backend reports at `system:init`. */
    private readonly allowedTools: readonly string[] = [],
  ) {}

  async *events(): AsyncIterable<BackendEvent> {
    yield {
      type: 'run_started',
      runId: this.runId,
      sessionId: this.sessionId,
      cwd: this.cwd,
      pid: null,
    };

    // The headless backend emits this from `system:init`, and a runner that
    // checks it (an MCP server still `pending` means a session with no tools)
    // has to see the same shape here, or the fake would be the one arrangement
    // in which that check never runs.
    yield {
      type: 'session_ready',
      runId: this.runId,
      mcpServers: this.script.mcpServers ?? [{ name: 'vorschicht', status: 'connected' }],
      tools: [...this.allowedTools],
    };

    for (const event of this.script.events ?? []) {
      if (this.killed) break;
      if (this.script.stepDelayMs) {
        await new Promise((resolve) => setTimeout(resolve, this.script.stepDelayMs));
      }
      // An interrupt stops the stream at the next boundary — never mid-event,
      // which is the in-process analogue of §7.3's "never mid-edit".
      if (this.interrupted) break;
      yield { ...event, runId: this.runId } as BackendEvent;
    }

    if (this.script.result && !this.interrupted && !this.killed) {
      yield {
        type: 'result',
        runId: this.runId,
        raw: this.script.result.raw,
        tokensIn: this.script.result.tokensIn,
        tokensOut: this.script.result.tokensOut,
        cacheReadTokens: this.script.result.cacheReadTokens ?? 0,
        cacheCreationTokens: this.script.result.cacheCreationTokens ?? 0,
        costUsd: this.script.result.costUsd ?? 0,
        byModel: this.script.result.byModel ?? {},
      };
    }

    yield {
      type: 'terminated',
      runId: this.runId,
      reason: this.killed
        ? 'crashed'
        : this.interrupted
          ? 'interrupted'
          : (this.script.terminal ?? 'completed'),
      exitCode: this.killed ? null : (this.script.exitCode ?? 0),
    };
  }

  async queryUsage(): Promise<GetUsageResponse | null> {
    // A backend that declares it cannot ask must answer null, whatever a script
    // says — otherwise the fake could satisfy the contract suite while
    // contradicting its own `capabilities()`.
    if (this.script.supportsUsageQuery === false) return null;
    const scripted = this.script.usage;
    if (!scripted || scripted.length === 0) return null;
    // Successive calls walk the script and then hold on its last entry, so a
    // test can describe a trajectory without counting calls.
    const index = Math.min(this.usageCalls++, scripted.length - 1);
    return scripted[index] ?? null;
  }

  async transcriptPath(): Promise<string | null> {
    return this.script.transcriptPath ?? null;
  }

  async interrupt(reason: StopReason): Promise<void> {
    this.interrupted = reason;
  }

  async kill(): Promise<void> {
    this.killed = true;
  }
}
