#!/usr/bin/env node
/**
 * The §6.6 containment hook — one process per tool call.
 *
 * The CLI runs this from the role's `--settings` file before every tool the
 * agent invokes. It reads the call from stdin, asks `decideToolCall`, and
 * answers on stdout. Everything difficult about it comes from that position:
 *
 * **It must be cheap.** ADR 0003 measured the MCP server's startup against a
 * ~400 ms budget it got once per session; this gets ~50 ms and is paid on every
 * `Write`. So it imports `@vorschicht/shared/containment` — a leaf that pulls
 * `claims.js`, `worktree.js` and `node:path`, measured at ~1 ms over bare node
 * startup — and nothing else. Not `@vorschicht/core`, not the barrel, not zod.
 * An import added here is an import multiplied by every tool call of the night.
 *
 * **It must never exit 1.** The pinned CLI's contract, verified by probe:
 *
 *   | how the hook answers          | what happens                                  |
 *   |-------------------------------|-----------------------------------------------|
 *   | JSON `deny` on stdout, exit 0 | tool blocked, reason shown verbatim, `success` |
 *   | exit 2 + stderr               | tool blocked, reason wrapped, outcome `error`  |
 *   | any other non-zero exit       | **tool proceeds**, stderr shown to the model   |
 *
 * The third row is why this file is defensive to the point of paranoia: an
 * uncaught exception in Node exits 1, and exit 1 means the write it was
 * supposed to stop happens anyway. Every path is wrapped, and the last-resort
 * handlers below deny and exit 0 rather than let the process die naturally.
 *
 * **Its verdict must stay distinguishable from its own failure.** Hence the
 * first row rather than the second for *every* decision, including internal
 * errors: a denial reports hook outcome `success`, so an outcome of `error` in
 * the event stream means one thing only — containment itself is broken, and
 * `ContainmentMonitor` treats the run as an infra failure (§11, A25).
 */
import { readFileSync } from 'node:fs';
import {
  decideToolCall,
  parseRunContainmentPolicy,
  type RunContainmentPolicy,
  type ToolDecision,
} from '@vorschicht/shared/containment';

/** Env var naming the run's policy document. Set per spawn by the runner. */
export const RUN_POLICY_ENV = 'VORSCHICHT_RUN_POLICY';

/** The two modes, matching the two hook events the settings file registers. */
export type HookMode = 'pre-tool-use' | 'session-start';

interface HookPayload {
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  cwd?: string;
  session_id?: string;
}

/**
 * The `PreToolUse` answer shape the CLI understands.
 *
 * Only `deny` is ever emitted. An `allow` would *override* the permission
 * system rather than defer to it — it would wave a call past `--allowedTools`,
 * which is §6.6's layer 2. Staying silent lets every other layer still say no.
 */
export function denyResponse(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  });
}

/**
 * Load the policy, or null.
 *
 * Null is not an error here — it is a decision, and `decideToolCall` turns it
 * into a refusal of everything that writes. Distinguishing "no policy" from "a
 * broken policy" would only matter if one of them were permissive.
 */
export function loadPolicy(
  env: NodeJS.ProcessEnv,
  read: (path: string) => string = (path) => readFileSync(path, 'utf8'),
): RunContainmentPolicy | null {
  const path = env[RUN_POLICY_ENV];
  if (typeof path !== 'string' || path.trim() === '') return null;
  try {
    return parseRunContainmentPolicy(JSON.parse(read(path)));
  } catch {
    return null;
  }
}

export interface HookOutcome {
  stdout: string;
  stderr: string;
  exitCode: 0 | 2;
}

const SILENT: HookOutcome = { stdout: '', stderr: '', exitCode: 0 };

/**
 * The whole hook as a function, so it can be tested without a process.
 *
 * `session-start` is the liveness half of §6.6. It writes nothing on success
 * and exits 0 — its value is that the CLI reports it at all: a `settings` file
 * that fails validation is ignored *silently* in `-p` mode, so a session with
 * no `SessionStart` hook event is a session running without containment, and
 * that is checkable for free before a single turn is spent. When the policy is
 * missing it exits 2, which surfaces as hook outcome `error` at the earliest
 * possible moment — before the model has been consulted once.
 */
export function runHook(
  mode: HookMode,
  rawStdin: string,
  policy: RunContainmentPolicy | null,
): HookOutcome {
  if (mode === 'session-start') {
    if (policy) return SILENT;
    return {
      stdout: '',
      stderr:
        'Vorschicht-Containment: keine Richtlinie für diesen Lauf lesbar ' +
        `(${RUN_POLICY_ENV}). Die Sitzung läuft ohne Schreibgrenze (§6.6) und darf ` +
        'nicht weiterverwendet werden.',
      exitCode: 2,
    };
  }

  let payload: HookPayload;
  try {
    const parsed: unknown = JSON.parse(rawStdin);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('kein Objekt');
    }
    payload = parsed as HookPayload;
  } catch {
    return {
      stdout: denyResponse(
        'Refused: the containment hook could not read this tool call. Nothing is ' +
          'established about what it would touch, so it is not permitted.',
      ),
      stderr: '',
      exitCode: 0,
    };
  }

  const decision: ToolDecision = decideToolCall(policy, {
    toolName: typeof payload.tool_name === 'string' ? payload.tool_name : '',
    toolInput: payload.tool_input ?? {},
    cwd: typeof payload.cwd === 'string' ? payload.cwd : process.cwd(),
  });

  if (decision.decision === 'allow') return SILENT;
  return {
    stdout: denyResponse(decision.reason),
    // The rule name never reaches the model — it goes to the CLI's own log, so
    // that a denial can be classified when a run is reconstructed afterwards.
    stderr: `containment: ${decision.rule}`,
    exitCode: 0,
  };
}

function parseMode(argv: readonly string[]): HookMode {
  return argv.includes('session-start') ? 'session-start' : 'pre-tool-use';
}

function emit(outcome: HookOutcome): void {
  if (outcome.stdout) process.stdout.write(outcome.stdout);
  if (outcome.stderr) process.stderr.write(outcome.stderr);
  process.exitCode = outcome.exitCode;
}

/**
 * The refusal of last resort.
 *
 * Reached when something failed that has no business failing — the stdin read,
 * the writer, a bug in this file. It denies rather than crashes, because a
 * crash exits 1 and exit 1 lets the tool run.
 */
function panic(): void {
  try {
    process.stdout.write(
      denyResponse(
        'Refused: the containment hook failed while checking this call. It refuses ' +
          'rather than guesses. Report this — it is an orchestrator fault, not yours.',
      ),
    );
  } catch {
    /* stdout is gone; the exit code below is all that is left */
  }
  process.exitCode = 0;
}

/** True when this file was started as a program rather than imported. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  return typeof entry === 'string' && entry.includes('hook-entry');
}

if (isEntryPoint()) {
  // Registered before any work: an exception thrown from a callback would
  // otherwise leave the default handler to exit 1, which is the one exit code
  // that means "carry on".
  process.on('uncaughtException', panic);
  process.on('unhandledRejection', panic);
  try {
    let stdin = '';
    try {
      stdin = readFileSync(0, 'utf8');
    } catch {
      stdin = '';
    }
    emit(runHook(parseMode(process.argv.slice(2)), stdin, loadPolicy(process.env)));
  } catch {
    panic();
  }
}
