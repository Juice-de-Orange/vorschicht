/**
 * The domain event vocabulary a `ModelBackend` emits (§6.0).
 *
 * This file exists to keep one specific mistake out of the codebase: letting
 * raw Claude Code stream-json leak past the backend boundary. The moment a
 * caller pattern-matches on the CLI's own message shapes, the `interactive-pty`
 * and `api-key` backends from A31 become unimplementable and the abstraction
 * that §6.0 calls "the project's survival layer" is decoration.
 *
 * Everything downstream — runner, guardian, office view, transcripts — speaks
 * only these events.
 */
import type { UsageSample } from './usage.js';

/** Why a run stopped. Every value here maps to a distinct operational response. */
export type TerminationReason =
  /** Model finished on its own. */
  | 'completed'
  /** Turn cap reached (`--max-turns` / backend counter). */
  | 'max_turns'
  /** Spend cap reached (`--max-budget-usd`). */
  | 'max_budget'
  /** Backend-side wall clock elapsed. */
  | 'timeout'
  /** Guardian asked for a graceful stop (wrap-up or hard-stop grace). */
  | 'interrupted'
  /** Authentication failure — an auth incident (§6.1), never a task failure. */
  | 'auth_incident'
  /** The process died in a way we did not ask for. */
  | 'crashed';

export type BackendEvent =
  /** Emitted once, before any model output — carries the id we assigned. */
  | { type: 'run_started'; runId: string; sessionId: string; cwd: string; pid: number | null }
  /**
   * The CLI's `system:init` — what the session actually has, before turn one.
   *
   * The MCP state is the reason this event exists, and it is not cosmetic.
   * Verified against the pinned CLI with a deliberately slow server: when a
   * server is still `pending` at init, the session's first turn has **zero** of
   * its tools and the model says so and stops — an agent that cannot call
   * `task.get_context` cannot find out what it was asked to do. The session
   * still costs a turn. So the runner checks this event and treats a session
   * that started without its tools as an infra failure to retry (A25), not as a
   * task that failed.
   */
  | {
      type: 'session_ready';
      runId: string;
      /** MCP servers and the status each reported at init. */
      mcpServers: Array<{ name: string; status: string }>;
      /** Every tool the session can call, built-ins included. */
      tools: string[];
    }
  /** Assistant prose, for the live office view. */
  | { type: 'assistant_text'; runId: string; text: string }
  /** A tool the agent invoked. Containment observability (§6.6) depends on this. */
  | { type: 'tool_use'; runId: string; tool: string; input: unknown }
  /**
   * A hook fired. Zero of these in a writing run means containment is off (§6.6).
   *
   * Field names follow what the CLI actually emits: `type: "system"` with
   * `subtype: "hook_started" | "hook_progress" | "hook_response"`, carrying
   * `hook_event` (the lifecycle event) and `hook_name` (the composite, e.g.
   * "PreToolUse:Edit"). An earlier version of the parser looked for a
   * `hook_event_name` field on a top-level `hook_event` message — neither
   * exists, so the branch never fired and the §6.6 runtime check stood on
   * wiring that could never carry a signal.
   */
  | {
      type: 'hook_event';
      runId: string;
      /** Lifecycle event: PreToolUse, SessionStart, … */
      event: string;
      /** Composite name the CLI reports, e.g. "PreToolUse:Edit". */
      hookName: string;
      phase: 'started' | 'progress' | 'response';
      outcome: string | null;
      exitCode: number | null;
    }
  /**
   * A tool call the permission layer refused — including hook denials.
   *
   * Read from `permission_denials[]` on the result message, which the CLI fills
   * for every non-allow outcome. This is the evidence the Phase 2 containment
   * gate wants persisted: tool, input and time, without parsing a transcript.
   */
  | { type: 'permission_denied'; runId: string; tool: string; input: unknown }
  /** A budget observation. The guardian consumes only these. */
  | { type: 'usage_sample'; runId: string; sample: UsageSample }
  /**
   * A window boundary the vendor pushed at us — and, above a threshold, a
   * percentage with it.
   *
   * The CLI emits `rate_limit_event` carrying `rateLimitType` and `resetsAt`.
   * A59 recorded that it carries no utilisation figure and A64 kept that
   * finding; both were reading only `status: "allowed"` frames, and for those
   * it is exactly right — 29 observed, not one with a number. But a second
   * shape exists and had never been seen before 2026-08-01 22:00, because the
   * account had never been that far into a window:
   *
   *     {"status":"allowed_warning","rateLimitType":"five_hour",
   *      "utilization":0.97,"surpassedThreshold":0.75,"resetsAt":1785621600}
   *
   * So the official percentage *is* reachable under token auth (A5) — not on
   * demand, and not below the vendor's own 75% warning threshold, but precisely
   * in the band where §7.2 has to act. `utilization` is therefore null in the
   * ordinary case and a number in the dangerous one, which is the opposite of
   * the usual shape and is the point.
   *
   * **The scale here is 0–1, while `get_usage` reports 0–100.** Both feed the
   * same guardian. `usage.ts` opens with why that matters: read 0.97 as
   * "0.97 percent" and §7.2 never fires again. The two paths therefore pass
   * different `UtilizationScale` values and neither infers it.
   *
   * `status` is the other half. Anything but an allowing status means the
   * account was refused at the spend accumulated so far, which is the only
   * evidence that can calibrate a plan budget downwards (A6, A60).
   */
  | {
      type: 'rate_limit_anchor';
      runId: string;
      window: 'five_hour' | 'seven_day';
      resetsAt: number;
      status: string;
      /** Vendor-reported fraction 0–1, or null when the frame carried none. */
      utilization: number | null;
    }
  /**
   * The structured result, still unvalidated — the caller applies the role schema.
   *
   * The token fields are the whole breakdown rather than `input_tokens` alone,
   * because on a Claude Code session `input_tokens` is not the input: measured
   * on a real result message, `input_tokens: 200` sat beside
   * `cache_read_input_tokens: 19_213_630`. A meter fed the narrow pair would
   * have undercounted by roughly two orders of magnitude, in the direction that
   * authorises spending.
   */
  | {
      type: 'result';
      runId: string;
      raw: unknown;
      tokensIn: number;
      tokensOut: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
      /**
       * The vendor's own weighting of all of the above (§7.1's estimator uses
       * this, A32's budget cap already did). Cost-equivalent, never billed —
       * §2's hard rule is unaffected, and the account is verified to have
       * overage disabled.
       */
      costUsd: number;
      /** Cost-equivalent per canonical model, for the per-model weekly view. */
      byModel: Readonly<Record<string, number>>;
    }
  /** Always last. */
  | { type: 'terminated'; runId: string; reason: TerminationReason; exitCode: number | null };

/** What a backend can do. Callers must branch on these, never on backend identity. */
export interface BackendCapabilities {
  supportsResume: boolean;
  supportsStructuredOutput: boolean;
  supportsUsageQuery: boolean;
  supportsInterrupt: boolean;
}

/**
 * Run caps, expressed as data (A32).
 *
 * Passing these as flags from the call site would tie the cap to one vendor's
 * CLI surface. Here they are a contract every backend must honour with whatever
 * mechanism it has — and the `headless` backend deliberately enforces the turn
 * count itself as well, so the cap survives a CLI that drops the flag.
 */
export interface RunCaps {
  maxTurns: number;
  maxBudgetUsd: number | null;
  wallClockMs: number;
}

/** A JSON Schema document. Structural only — validation is zod's job (§6.3). */
export type JsonSchema = Record<string, unknown>;

export interface SessionSpec {
  runId: string;
  role: string;
  prompt: string;
  systemPromptAppend: string;
  cwd: string;
  model: string;
  allowedTools: readonly string[];
  /**
   * The role's `--settings` document (§6.2) — where §6.6's hooks are armed.
   *
   * Never empty for a spawn. A session started without it has no containment,
   * and the CLI says nothing about that: an unloadable settings file is
   * discarded silently in `-p` mode.
   */
  settingsPath: string;
  mcpConfigPath: string | null;
  /**
   * Environment added to the session process, and inherited by its hooks.
   *
   * Verified against the pinned CLI: a variable set on the `claude` process
   * reaches the hook it spawns, and `CLAUDE_CODE_OAUTH_TOKEN` notably does not
   * — the CLI strips its own credential before running hook commands. This is
   * how `VORSCHICHT_RUN_POLICY` reaches the containment hook without the
   * per-role settings file having to know anything about a particular run.
   */
  env: Readonly<Record<string, string>>;
  /**
   * The role's result contract as a **value**, not a path (§6.3).
   *
   * §6.2 prescribes `--json-schema /app/contracts/<role>.result.schema.json`.
   * On the pinned CLI that flag does not read files: it parses its argument as
   * JSON and rejects a path with `--json-schema is not valid JSON:
   * Unrecognized token '/'` (ADR 0002). Carrying the schema as data rather than
   * as a filename is also the version that survives a backend swap — an
   * `api-key` backend would put it in a tool definition, never in a file.
   */
  resultSchema: JsonSchema | null;
  caps: RunCaps;
}

/**
 * Continuing an existing session (§6.4, §6.2).
 *
 * An object rather than positional arguments, and `settingsPath`/`env` are
 * required rather than optional, because the first version of `resume` carried
 * neither: an escalation answered by the operator would have resumed the parked session
 * **without hooks**, i.e. with §6.6's containment silently switched off at the
 * exact moment the task starts writing again. An optional field would have
 * left that hole open for whoever forgot to fill it.
 */
export interface ResumeSpec {
  /** The session to continue. Resume is scoped to the directory it began in. */
  sessionId: string;
  cwd: string;
  /** The next user message — the operator's decision, in §6.4's round trip. */
  message: string;
  /** §6.6: the role settings carrying the containment hooks. */
  settingsPath: string;
  /** Carries `VORSCHICHT_RUN_POLICY`; see `SessionSpec.env`. */
  env: Readonly<Record<string, string>>;
  /** A32's caps. Omitted means the backend's defaults for a continuation. */
  caps?: RunCaps;
  /**
   * The parts of a `SessionSpec` a continuation may need to restate.
   *
   * All optional, because a continuation inherits its session's history but not
   * its command line — the CLI is invoked afresh. §6.3's repair re-prompt is the
   * case that forced them into existence: asking a session to restate its result
   * without passing `--json-schema` again asks it for prose, and prose fails the
   * very validation the repair exists to satisfy. §6.4's escalation round-trip
   * needs the other three, since a session resumed to *keep working* needs its
   * tools and its MCP server back.
   */
  resultSchema?: JsonSchema | null;
  model?: string;
  allowedTools?: readonly string[];
  mcpConfigPath?: string | null;
}
