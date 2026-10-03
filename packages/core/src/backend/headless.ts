/**
 * The `headless` backend — Claude Code CLI in bidirectional stream-json mode.
 *
 * Bidirectional from the start, not one-shot `claude -p "prompt"`. ADR 0001
 * settled why: the official rate-limit percentages the guardian thresholds on
 * are reachable only through `control_request { subtype: "get_usage" }`, which
 * needs an open stdin. The same channel carries `interrupt`, which A32 relies
 * on for the only run cap that stops a session *gracefully* rather than killing
 * it mid-edit.
 *
 * Three caps, per A32, because no single one is trustworthy alone:
 *
 *   1. `--max-turns` — works on the pinned CLI but is undocumented (removed
 *      from `--help`, still parsing). Guarded by a contract test so its removal
 *      breaks the build instead of silently uncapping every run.
 *   2. `--max-budget-usd` — documented, and observed to be populated under
 *      subscription auth, so it is a real cap rather than an inert one.
 *   3. A backend-side turn counter and wall clock, enforced through
 *      `interrupt` and only then a SIGTERM to the **process group**. This one
 *      needs no CLI support at all, which is the point.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  BackendCapabilities,
  BackendEvent,
  GetUsageResponse,
  ResumeSpec,
  SessionSpec,
  TerminationReason,
} from '@vorschicht/shared';
import { getUsageResponseSchema } from '@vorschicht/shared';
import type { BackendName, ModelBackend, RunHandle, StopReason } from './types.js';

/** Grace between a graceful stop and the signal that ends the argument (§7.2). */
const SIGTERM_GRACE_MS = 60_000;
const CONTROL_TIMEOUT_MS = 15_000;

/**
 * How long the CLI may take to exit after its result, once stdin is closed.
 *
 * A backstop behind a deterministic mechanism rather than a mechanism in its
 * own right: closing stdin is what ends the session (see `finishAfterResult`),
 * and if the process is still there half a minute later something is wrong with
 * it, not with us. Long enough that a slow transcript flush is never mistaken
 * for a hang.
 */
const EXIT_AFTER_RESULT_MS = 30_000;

/**
 * What an authentication failure looks like in the CLI's own words (§6.1).
 *
 * One expression for both places it can turn up: stderr of a process that died
 * of it, and the text of an error result from one that reported it and exited.
 */
const AUTH_FAILURE =
  /401|authentication_error|Failed to authenticate|OAuth token has expired|invalid api key/i;

export interface HeadlessBackendOptions {
  /** Path to the pinned CLI. */
  command?: string;
  /** Extra environment for the child. The OAuth token arrives this way. */
  env?: NodeJS.ProcessEnv;
  onWarning?: (message: string) => void;
}

export class HeadlessBackend implements ModelBackend {
  readonly name: BackendName = 'headless';

  constructor(private readonly options: HeadlessBackendOptions = {}) {}

  capabilities(): BackendCapabilities {
    return {
      supportsResume: true,
      supportsStructuredOutput: true,
      supportsUsageQuery: true,
      supportsInterrupt: true,
    };
  }

  async spawn(spec: SessionSpec): Promise<RunHandle> {
    // We assign the session id rather than parsing it out of the first message.
    // That closes the classic crash window: a run killed during startup is
    // still a run we can name, reconcile and clean up.
    const sessionId = randomUUID();
    return new HeadlessRunHandle(spec, sessionId, buildArgs(spec, sessionId, null), this.options);
  }

  async resume(resume: ResumeSpec): Promise<RunHandle> {
    // §6.2: resume is scoped to the directory the session started in, so the
    // caller supplies cwd rather than us guessing it. The role settings and the
    // run environment travel with it for a blunter reason — without them the
    // continuation runs with no containment hooks (§6.6).
    if (!resume.settingsPath) {
      throw new Error(
        'Fortsetzen ohne Rollen-Settings: die Sitzung liefe ohne die Containment-Hooks ' +
          'aus §6.6, und zwar genau dann, wenn sie wieder zu schreiben beginnt.',
      );
    }
    const spec: SessionSpec = {
      runId: randomUUID(),
      role: 'resume',
      prompt: resume.message,
      systemPromptAppend: '',
      cwd: resume.cwd,
      // A continuation inherits the session's history, never its command line —
      // the CLI is invoked afresh. So a repair re-prompt that does not restate
      // `--json-schema` asks for prose and then fails it against the schema
      // (§6.3), and an escalation resumed to keep working (§6.4) would come back
      // with no tools at all.
      model: resume.model ?? '',
      allowedTools: resume.allowedTools ?? [],
      settingsPath: resume.settingsPath,
      mcpConfigPath: resume.mcpConfigPath ?? null,
      env: resume.env,
      resultSchema: resume.resultSchema ?? null,
      caps: resume.caps ?? { maxTurns: 50, maxBudgetUsd: null, wallClockMs: 30 * 60_000 },
    };
    return new HeadlessRunHandle(
      spec,
      resume.sessionId,
      buildArgs(spec, resume.sessionId, resume.sessionId),
      this.options,
    );
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** Builds the argument vector. Every flag explicit, per §6.2. */
export function buildArgs(spec: SessionSpec, sessionId: string, resumeId: string | null): string[] {
  const args = [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    // Hook activity is the only runtime evidence that containment is live:
    // settings files that fail validation are silently ignored in -p mode
    // (§6.6), so a writing run with zero hook events is a failed run.
    '--include-hook-events',
    // Empty, not 'project'.
    //
    // `project` is `.claude/settings.json` **inside the target repository** —
    // that is, inside the agent's own worktree, a file the agent can write. An
    // earlier version pinned exactly that source while excluding the host's,
    // which is backwards: it loaded the one input an agent could use to
    // disarm its own next session and shut out the harmless ones. With an
    // empty value only the role settings passed via --settings apply.
    '--setting-sources',
    '',
  ];

  if (resumeId) args.push('--resume', resumeId);
  else args.push('--session-id', sessionId);

  if (spec.systemPromptAppend) args.push('--append-system-prompt', spec.systemPromptAppend);
  if (spec.model) args.push('--model', spec.model);
  if (spec.allowedTools.length > 0) args.push('--allowedTools', spec.allowedTools.join(','));
  if (spec.settingsPath) args.push('--settings', spec.settingsPath);
  if (spec.mcpConfigPath) args.push('--mcp-config', spec.mcpConfigPath, '--strict-mcp-config');
  // Inline JSON, not a path. §6.2 prescribes a filename and the pinned CLI
  // refuses one — it parses the argument as JSON and answers "--json-schema is
  // not valid JSON: Unrecognized token '/'". See ADR 0002; the checked-in
  // `contracts/*.json` files remain the reviewable form of the same schemas.
  if (spec.resultSchema) args.push('--json-schema', JSON.stringify(spec.resultSchema));

  args.push('--permission-mode', 'acceptEdits');
  args.push('--max-turns', String(spec.caps.maxTurns));
  if (spec.caps.maxBudgetUsd !== null)
    args.push('--max-budget-usd', String(spec.caps.maxBudgetUsd));

  return args;
}

class HeadlessRunHandle implements RunHandle {
  readonly runId: string;
  readonly sessionId: string;
  readonly cwd: string;

  private child: ChildProcess | null = null;
  private readonly pending = new Map<string, (value: unknown) => void>();
  private stopping: StopReason | null = null;
  /** Set once the run's result message has arrived — see `finishAfterResult`. */
  private resultSeen = false;
  private stdinClosed = false;
  private turns = 0;
  /** Assistant message ids already counted — see the turn counter in `translate`. */
  private readonly seenMessageIds = new Set<string>();
  private terminalReason: TerminationReason | null = null;

  constructor(
    private readonly spec: SessionSpec,
    sessionId: string,
    private readonly args: string[],
    private readonly options: HeadlessBackendOptions,
  ) {
    this.runId = spec.runId;
    this.sessionId = sessionId;
    this.cwd = spec.cwd;
  }

  async *events(): AsyncIterable<BackendEvent> {
    // Per-spec last: `VORSCHICHT_RUN_POLICY` names this run's containment
    // document and must not be overridable by a backend-wide default.
    const env = { ...process.env, ...this.options.env, ...this.spec.env };
    // `--bare` is disqualified twice over: it forces API-key auth (§2 forbids
    // it) and silently skips hooks, i.e. the whole §6.6 containment layer.
    // Asserting the environment is cheaper than discovering it afterwards.
    if (env.CLAUDE_CODE_SIMPLE) {
      throw new Error(
        'CLAUDE_CODE_SIMPLE ist gesetzt. Das erzwingt API-Key-Auth (§2) und ' +
          'überspringt still die Containment-Hooks (§6.6).',
      );
    }

    const child = spawn(this.options.command ?? 'claude', this.args, {
      cwd: this.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group. `claude` starts tool subprocesses; a signal sent to
      // the parent alone would leave them running, which is how a "killed" run
      // keeps holding a worktree.
      detached: true,
    });
    this.child = child;

    /*
     * A broken stdin pipe must not take the daemon down.
     *
     * `write()` below sits in a `try/catch`, and that catch is **structurally
     * unable** to do the job it looks like it does: a stream reports a broken
     * pipe *asynchronously*, on the stream's `error` event, long after `write`
     * has returned. An `error` event with no listener is an uncaught exception
     * in Node — so an EPIPE here reaches `main().catch()` and exits the
     * orchestrator, taking every other running session with it.
     *
     * Reachable whenever the CLI goes away between our decision to write and
     * the write landing: a crash, an OOM kill, `finishAfterResult` racing an
     * exit. Observed twice as `Error: write EPIPE` out of this file, in two
     * independent runs by two parties, each time as a test suite reporting exit
     * 1 with **zero failed tests** — which is what an uncaught exception looks
     * like from outside.
     *
     * The listener is what makes it handled; the `catch` in `write` stays for
     * the synchronous failures (`write after end`), which it can catch.
     */
    child.stdin?.on('error', (error: Error) => {
      this.stdinClosed = true;
      this.options.onWarning?.(`stdin der Sitzung ist gebrochen: ${error.message}`);
    });

    const queue: BackendEvent[] = [];
    let notify: (() => void) | null = null;
    let finished = false;
    const push = (event: BackendEvent) => {
      queue.push(event);
      notify?.();
    };

    const wallClock = setTimeout(() => {
      void this.interrupt('cap_exceeded');
      this.terminalReason = 'timeout';
    }, this.spec.caps.wallClockMs);
    wallClock.unref();

    createInterface({ input: child.stdout }).on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(trimmed);
      } catch {
        return;
      }
      this.handleControlResponse(message);
      for (const event of this.translate(message)) push(event);
    });

    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 8000) stderr = stderr.slice(-8000);
    });

    const exited = new Promise<number | null>((resolve) => {
      child.on('close', (code) => resolve(code));
      child.on('error', (error) => {
        this.options.onWarning?.(`Prozessfehler: ${error.message}`);
        this.terminalReason = 'crashed';
        resolve(null);
      });
    });

    push({
      type: 'run_started',
      runId: this.runId,
      sessionId: this.sessionId,
      cwd: this.cwd,
      pid: child.pid ?? null,
    });

    // The prompt goes in as a stream-json user message; stdin stays open so
    // control requests remain possible for the run's lifetime.
    this.write({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: this.spec.prompt }] },
    });

    void exited.then((code) => {
      clearTimeout(wallClock);
      finished = true;
      push({
        type: 'terminated',
        runId: this.runId,
        reason: this.classify(code, stderr),
        exitCode: code,
      });
      notify?.();
    });

    while (!finished || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
          setTimeout(resolve, 100).unref();
        });
        notify = null;
        continue;
      }
      const next = queue.shift();
      if (next) yield next;
    }
  }

  /** Maps a CLI message onto domain events. The only place vendor shapes appear. */
  private *translate(message: Record<string, unknown>): Iterable<BackendEvent> {
    switch (message.type) {
      case 'assistant': {
        const inner = message.message as {
          id?: string;
          content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>;
        };
        // Count *messages*, not stream events. One assistant turn arrives as
        // several `assistant` lines that share a `message.id` — a thinking
        // block, then a tool_use block, then text — so incrementing per line
        // counted a single turn two or three times and fired the cap early.
        // Observed on the pinned CLI: one haiku turn produced two lines under
        // the same id. A line without an id is counted once, on its own.
        const messageId = typeof inner?.id === 'string' ? inner.id : null;
        if (!messageId || !this.seenMessageIds.has(messageId)) {
          if (messageId) this.seenMessageIds.add(messageId);
          this.turns += 1;
        }
        // The backend-side turn cap (A32 layer 3): holds even if the CLI drops
        // `--max-turns` entirely.
        if (this.turns > this.spec.caps.maxTurns) {
          this.terminalReason = 'max_turns';
          void this.interrupt('cap_exceeded');
        }
        const content = inner?.content ?? [];
        const text = content
          .filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('');
        if (text) yield { type: 'assistant_text', runId: this.runId, text };
        // Tool calls are content *blocks* of an assistant message; there is no
        // top-level `tool_use` line in the stream. An earlier version matched
        // `message.type.startsWith('tool_')` and therefore never fired once —
        // which mattered beyond the audit trail, because §6.6's liveness rule
        // ("a run that used a tool with no PreToolUse event behind it was not
        // contained") compares these against the hook events, and a signal path
        // that cannot carry a signal reads as covered.
        for (const part of content) {
          if (part.type !== 'tool_use') continue;
          yield {
            type: 'tool_use',
            runId: this.runId,
            tool: String(part.name ?? 'unbekannt'),
            input: part.input,
          };
        }
        break;
      }
      case 'system': {
        // Hook lifecycle arrives as system messages, not as a `hook_event`
        // type — verified against the real stream. SessionStart hooks are
        // reported even without --include-hook-events, which is what makes the
        // containment liveness check free.
        const subtype = String(message.subtype ?? '');
        // `init` reports what the session starts with. An MCP server that is
        // still `pending` here is not a slow start that catches up — the first
        // turn simply has none of its tools, and the model reports that and
        // stops (verified with a deliberately slow server). The runner needs
        // this before it interprets a useless result as a failed task.
        if (subtype === 'init') {
          yield {
            type: 'session_ready',
            runId: this.runId,
            mcpServers: ((message.mcp_servers ?? []) as Array<Record<string, unknown>>).map(
              (server) => ({
                name: String(server.name ?? 'unbekannt'),
                status: String(server.status ?? 'unbekannt'),
              }),
            ),
            tools: ((message.tools ?? []) as unknown[]).map(String),
          };
          break;
        }
        if (!subtype.startsWith('hook_')) break;
        yield {
          type: 'hook_event',
          runId: this.runId,
          event: String(message.hook_event ?? 'unbekannt'),
          hookName: String(message.hook_name ?? 'unbekannt'),
          phase:
            subtype === 'hook_started'
              ? 'started'
              : subtype === 'hook_progress'
                ? 'progress'
                : 'response',
          outcome: (message.outcome as string | undefined) ?? null,
          exitCode: typeof message.exit_code === 'number' ? message.exit_code : null,
        };
        break;
      }
      // A window boundary, pushed rather than asked for. Below the vendor's
      // warning threshold it carries no percentage (A59, corrected by A73) —
      // but `resetsAt` is what turns §7.1's estimated five-hour window from a
      // rolling approximation into an exact one.
      //
      // This comment used to end with "a `status` other than 'allowed' is the
      // only calibration evidence that exists". That was the inference A101
      // removed, and it is worth knowing that it stood written down here as
      // well: `allowed_warning` is a *warning*, `status` is passed through
      // verbatim (including the literal 'unbekannt' below), and nothing
      // downstream may treat either as a refusal. What acts on a real limit
      // event is `utilization`, three lines further down.
      case 'rate_limit_event': {
        const info = (message.rate_limit_info ?? {}) as {
          status?: string;
          resetsAt?: number;
          rateLimitType?: string;
          utilization?: number | null;
        };
        const window =
          info.rateLimitType === 'five_hour'
            ? 'five_hour'
            : info.rateLimitType === 'seven_day'
              ? 'seven_day'
              : null;
        // Epoch *seconds* in the observed payload. Anything else is a shape we
        // do not understand, and inventing a boundary from it would move the
        // window start — the one number the estimate is not allowed to guess.
        if (!window || typeof info.resetsAt !== 'number' || !Number.isFinite(info.resetsAt)) break;
        yield {
          type: 'rate_limit_anchor',
          runId: this.runId,
          window,
          resetsAt: info.resetsAt < 1e11 ? Math.round(info.resetsAt * 1000) : info.resetsAt,
          status: String(info.status ?? 'unbekannt'),
          // Present only above the vendor's warning threshold, which is why it
          // is read off the *frame* rather than off `status`: keying on the
          // string would hard-code a vocabulary the vendor owns, and a future
          // `rejected` frame carrying a number would then be discarded at the
          // one moment the number matters most.
          utilization:
            typeof info.utilization === 'number' && Number.isFinite(info.utilization)
              ? info.utilization
              : null,
        };
        break;
      }
      case 'result': {
        // Deliberately the *whole* usage breakdown. `input_tokens` on a Claude
        // Code result is not the input: measured on a real session, 200 against
        // 19,213,630 cache reads. Anything metering on the narrow pair reads
        // roughly 1% of the truth, in the direction that authorises spending.
        const usage = (message.usage ?? {}) as {
          input_tokens?: number;
          output_tokens?: number;
          cache_read_input_tokens?: number;
          cache_creation_input_tokens?: number;
        };
        const modelUsage = (message.modelUsage ?? {}) as Record<
          string,
          { costUSD?: number; canonicalModel?: string }
        >;
        const byModel: Record<string, number> = {};
        for (const [id, entry] of Object.entries(modelUsage)) {
          const key = entry?.canonicalModel ?? id;
          byModel[key] = (byModel[key] ?? 0) + (entry?.costUSD ?? 0);
        }
        const subtype = message.subtype as string | undefined;
        if (subtype === 'error_max_turns') this.terminalReason = 'max_turns';
        if (subtype === 'error_max_budget_usd') this.terminalReason = 'max_budget';
        // An auth failure the CLI *reports* instead of dying of (§6.1). The
        // pinned CLI answers a rejected token with an ordinary result frame —
        // `subtype: "success"`, `is_error: true`, `api_error_status: 401`, the
        // sentence "Failed to authenticate. API Error: 401 …" as `result` — and
        // an empty stderr, so `classify` below never saw it. The run then read
        // as `completed` with a string where the role contract wants an object,
        // was re-prompted once and reported as a contract violation: a dead
        // token filed as bad work. Only on `is_error`, so that a model writing
        // "401" in an honest answer accuses nobody.
        if (
          message.is_error === true &&
          (message.api_error_status === 401 || AUTH_FAILURE.test(String(message.result ?? '')))
        ) {
          this.terminalReason = 'auth_incident';
        }
        // Every refused tool call, hook denials included. §6.6's second layer
        // becomes auditable without transcript parsing.
        for (const denial of (message.permission_denials ?? []) as Array<Record<string, unknown>>) {
          yield {
            type: 'permission_denied',
            runId: this.runId,
            tool: String(denial.tool_name ?? 'unbekannt'),
            input: denial.tool_input,
          };
        }
        yield {
          type: 'result',
          runId: this.runId,
          raw: (message.structured_output ?? message.result) as unknown,
          tokensIn: usage.input_tokens ?? 0,
          tokensOut: usage.output_tokens ?? 0,
          cacheReadTokens: usage.cache_read_input_tokens ?? 0,
          cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
          costUsd: typeof message.total_cost_usd === 'number' ? message.total_cost_usd : 0,
          byModel,
        };
        this.finishAfterResult();
        break;
      }
      // `user` carries tool *results*, `stream_event` the partial deltas of a
      // message we will see whole; neither adds anything the domain vocabulary
      // needs, and both are in the transcript.
      default:
        break;
    }
  }

  /**
   * End the session once its result has arrived.
   *
   * **The CLI does not exit on its own here.** In bidirectional stream-json mode
   * stdin is an open pipe and the process waits on it — so a run that finished
   * its work in three seconds stayed alive until the wall-clock cap fired,
   * spent its 60-second SIGTERM grace, and was reported as `timeout`. Measured
   * against the pinned CLI: result at +2.7 s, `terminated` at +150.3 s. Every
   * run would have occupied a concurrency slot for its full budget — 90 minutes
   * for a Coder — and every one of them would have been classified as a failure
   * rather than as done. Invisible in every unit test, because the stub process
   * exits by itself.
   *
   * Closing stdin is the deterministic end. The timer behind it is only a
   * backstop, and it classifies as `completed` rather than `crashed`: the work
   * was finished and reported before any of this: only the shutdown misbehaved.
   */
  private finishAfterResult(): void {
    if (this.resultSeen) return;
    this.resultSeen = true;
    this.closeStdin();
    const timer = setTimeout(() => {
      this.options.onWarning?.(
        `Sitzung ${this.sessionId} lief nach dem Ergebnis noch ` +
          `${EXIT_AFTER_RESULT_MS / 1000}s weiter; Prozessgruppe wird beendet.`,
      );
      this.terminalReason ??= 'completed';
      void this.kill();
    }, EXIT_AFTER_RESULT_MS);
    timer.unref();
  }

  private closeStdin(): void {
    if (this.stdinClosed) return;
    this.stdinClosed = true;
    try {
      this.child?.stdin?.end();
    } catch {
      /* the process is already gone, which is the outcome we wanted */
    }
  }

  private classify(code: number | null, stderr: string): TerminationReason {
    if (this.terminalReason) return this.terminalReason;
    // An auth failure is an auth incident, never a task failure (§6.1).
    if (AUTH_FAILURE.test(stderr)) {
      return 'auth_incident';
    }
    if (this.stopping) return 'interrupted';
    if (code === 0) return 'completed';
    // A non-zero exit after a delivered result is a shutdown problem, not a
    // failed run: the work was done and reported before the process went.
    if (this.resultSeen) return 'completed';
    return 'crashed';
  }

  private write(message: unknown): void {
    if (this.stdinClosed) return;
    try {
      this.child?.stdin?.write(`${JSON.stringify(message)}\n`);
    } catch (error) {
      this.options.onWarning?.(`stdin nicht schreibbar: ${(error as Error).message}`);
    }
  }

  private handleControlResponse(message: Record<string, unknown>): void {
    if (message.type !== 'control_response') return;
    const response = message.response as { request_id?: string; response?: unknown } | undefined;
    const id = response?.request_id;
    if (typeof id !== 'string') return;
    const resolve = this.pending.get(id);
    if (!resolve) return;
    this.pending.delete(id);
    resolve(response?.response);
  }

  private control(subtype: string): Promise<unknown> {
    // Once stdin is closed there is nobody left to answer, and waiting the full
    // control timeout to find that out would stall a caller for 15 seconds per
    // question. §7.1's meter therefore samples *during* a run, not after it.
    if (this.stdinClosed) return Promise.resolve(null);
    const requestId = `vs-${randomUUID()}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(null);
      }, CONTROL_TIMEOUT_MS);
      timer.unref();
      this.pending.set(requestId, (value) => {
        clearTimeout(timer);
        resolve(value);
      });
      this.write({ type: 'control_request', request_id: requestId, request: { subtype } });
    });
  }

  async queryUsage(): Promise<GetUsageResponse | null> {
    const raw = await this.control('get_usage');
    if (!raw) return null;
    const parsed = getUsageResponseSchema.safeParse(raw);
    if (!parsed.success) {
      // The endpoint is self-declared experimental; a shape change is a fact
      // about the vendor, not a reason to crash a run.
      this.options.onWarning?.(
        `get_usage-Antwort unerwartet: ${parsed.error.message.slice(0, 200)}`,
      );
      return null;
    }
    return parsed.data;
  }

  /**
   * The CLI's own session log for this run.
   *
   * The layout is `<config dir>/projects/<slug>/<session id>.jsonl`, where the
   * slug is the working directory with every non-alphanumeric character
   * replaced by a hyphen. That is vendor knowledge and it is deliberately
   * confined to this file (§6.0) — but it is also *guessed* knowledge, so the
   * guess is checked and there is a fallback: we know the file's name exactly,
   * because we chose the session id, so a scan of the project directories finds
   * it even if the slug rule changes under us. Returning null rather than
   * throwing is the third layer: a missing transcript costs traceability for
   * one run, and must never cost the run itself.
   */
  async transcriptPath(): Promise<string | null> {
    const env = { ...process.env, ...this.options.env, ...this.spec.env };
    const configDir = env.CLAUDE_CONFIG_DIR || join(env.HOME || homedir(), '.claude');
    const projects = join(configDir, 'projects');
    const file = `${this.sessionId}.jsonl`;

    const guess = join(projects, this.cwd.replace(/[^a-zA-Z0-9]/g, '-'), file);
    if (await isFile(guess)) return guess;

    let entries: string[];
    try {
      entries = await readdir(projects);
    } catch {
      return null;
    }
    for (const entry of entries) {
      const candidate = join(projects, entry, file);
      if (await isFile(candidate)) return candidate;
    }
    return null;
  }

  async interrupt(reason: StopReason): Promise<void> {
    if (this.stopping) return;
    this.stopping = reason;
    await this.control('interrupt');
    // The grace window §7.2 grants before the argument ends. The CLI still
    // writes a result message after an interrupt, so the wrap-up protocol has
    // something to record.
    const timer = setTimeout(() => void this.kill(), SIGTERM_GRACE_MS);
    timer.unref();
  }

  async kill(): Promise<void> {
    const pid = this.child?.pid;
    if (!pid) return;
    try {
      // Negative pid: the whole process group, including tool subprocesses.
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        this.child?.kill('SIGTERM');
      } catch {
        /* already gone */
      }
    }
  }
}
