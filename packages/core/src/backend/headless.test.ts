/**
 * The `headless` backend against a scripted stand-in for the CLI.
 *
 * `contract.test.ts` proves every backend keeps the same promises; this file
 * covers the part that is specific to this one — the translation of Claude
 * Code's stream-json into domain events, which is the single place in the
 * codebase where vendor shapes are allowed to appear and therefore the single
 * place where a vendor change lands.
 *
 * The stand-in is a small node script that prints scripted lines. That is
 * deliberately not a mock: it exercises the real spawn, the real line reader,
 * the real exit handling and the real process-group teardown, and it costs no
 * subscription budget. What it cannot prove is that the real CLI still emits
 * these shapes — that is `gate:cli-contract`'s job for the flags, and the
 * demo scripts' job for the messages.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackendEvent, SessionSpec } from '@vorschicht/shared';
import { roleJsonSchema } from '@vorschicht/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildArgs, HeadlessBackend } from './headless.js';

let stubCli: string;
/**
 * A stand-in that behaves like the real CLI on the one point the other stub
 * gets wrong: it prints its lines and then **waits on stdin** instead of
 * exiting. That is what the pinned CLI does in bidirectional stream-json mode,
 * and what made every finished run hang until its wall-clock cap.
 */
let waitingStubCli: string;

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'vorschicht-headless-'));
  stubCli = join(dir, 'stub-cli.mjs');
  waitingStubCli = join(dir, 'stub-cli-waiting.mjs');
  writeFileSync(
    waitingStubCli,
    [
      'const lines = JSON.parse(process.env.VORSCHICHT_STUB_LINES ?? "[]");',
      'process.stdin.resume();',
      // Exits only when stdin reaches EOF — i.e. when the backend closes it.
      "process.stdin.on('end', () => process.exit(0));",
      "for (const line of lines) process.stdout.write(JSON.stringify(line) + '\\n');",
    ].join('\n'),
  );
  // Emits whatever VORSCHICHT_STUB_LINES contains, one JSON object per line,
  // then exits. stdin is drained so the parent's prompt write cannot EPIPE.
  writeFileSync(
    stubCli,
    [
      'process.stdin.resume();',
      'const lines = JSON.parse(process.env.VORSCHICHT_STUB_LINES ?? "[]");',
      "for (const line of lines) process.stdout.write(JSON.stringify(line) + '\\n');",
      'process.stdout.end(() => process.exit(Number(process.env.VORSCHICHT_STUB_EXIT ?? 0)));',
    ].join('\n'),
  );
});

function spec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    runId: 'run-headless-1',
    role: 'coder',
    prompt: 'tu nichts',
    systemPromptAppend: '',
    cwd: process.cwd(),
    model: 'haiku',
    allowedTools: ['Read'],
    settingsPath: '',
    mcpConfigPath: null,
    env: {},
    resultSchema: null,
    caps: { maxTurns: 4, maxBudgetUsd: null, wallClockMs: 30_000 },
    ...overrides,
  };
}

/** Run the backend against an arbitrary node argument vector. */
async function runRaw(
  args: string[],
  env: NodeJS.ProcessEnv,
  session = spec(),
): Promise<BackendEvent[]> {
  const backend = new HeadlessBackend({ command: process.execPath, env });
  const handle = await backend.spawn(session);
  const built = (handle as unknown as { args: string[] }).args;
  built.splice(0, built.length, ...args);
  const events: BackendEvent[] = [];
  for await (const event of handle.events()) events.push(event);
  return events;
}

/** Run the scripted stand-in, keeping the real argument vector behind it. */
async function collect(
  lines: unknown[],
  session = spec(),
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<BackendEvent[]> {
  const backend = new HeadlessBackend({
    command: process.execPath,
    env: { VORSCHICHT_STUB_LINES: JSON.stringify(lines), ...extraEnv },
  });
  const handle = await backend.spawn(session);
  // The stub is a node script, so the interpreter needs it as its first
  // argument; `buildArgs` output follows unchanged — the stub ignores it, but
  // the spawn is then the real one down to the flags.
  (handle as unknown as { args: string[] }).args.unshift(stubCli);
  const events: BackendEvent[] = [];
  for await (const event of handle.events()) events.push(event);
  return events;
}

/** One assistant message as the CLI emits it, split across content blocks. */
const assistantLine = (id: string, block: Record<string, unknown>) => ({
  type: 'assistant',
  message: { id, content: [block] },
});

describe('buildArgs', () => {
  it('passes the result contract inline, never as a path (ADR 0002)', () => {
    // The pinned CLI parses `--json-schema` as JSON. A filename dies at startup
    // with "Unrecognized token '/'" — for every role, every time.
    const args = buildArgs(spec({ resultSchema: roleJsonSchema('coder') }), 'sid', null);
    const value = args[args.indexOf('--json-schema') + 1] ?? '';
    expect(() => JSON.parse(value)).not.toThrow();
    expect(JSON.parse(value).$schema).toBe('http://json-schema.org/draft-07/schema#');
  });

  it('omits the flag entirely when a role has no contract', () => {
    expect(buildArgs(spec(), 'sid', null)).not.toContain('--json-schema');
  });

  it('keeps --setting-sources empty, never "project" (§6.6)', () => {
    // `project` is `.claude/settings.json` inside the agent's own worktree —
    // the one input an agent could write to disarm its next session.
    const args = buildArgs(spec(), 'sid', null);
    expect(args[args.indexOf('--setting-sources') + 1]).toBe('');
  });

  it('assigns the session id on spawn and resumes by it', () => {
    expect(buildArgs(spec(), 'sid', null)).toContain('--session-id');
    expect(buildArgs(spec(), 'sid', 'sid')).toContain('--resume');
    expect(buildArgs(spec(), 'sid', 'sid')).not.toContain('--session-id');
  });
});

describe('translating the stream', () => {
  it('reports assistant prose and ends with exactly one terminated event', async () => {
    const events = await collect([assistantLine('m1', { type: 'text', text: 'hallo' })]);
    expect(events.filter((e) => e.type === 'terminated')).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('terminated');
    expect(events).toContainEqual({
      type: 'assistant_text',
      runId: 'run-headless-1',
      text: 'hallo',
    });
  });

  it('surfaces hook activity, which is the only runtime evidence of containment', async () => {
    // §6.6: a settings file that fails validation is ignored silently in -p
    // mode, so zero hook events in a writing run means containment was off.
    const events = await collect([
      {
        type: 'system',
        subtype: 'hook_response',
        hook_event: 'PreToolUse',
        hook_name: 'PreToolUse:Edit',
        outcome: 'deny',
        exit_code: 2,
      },
    ]);
    expect(events).toContainEqual({
      type: 'hook_event',
      runId: 'run-headless-1',
      event: 'PreToolUse',
      hookName: 'PreToolUse:Edit',
      phase: 'response',
      outcome: 'deny',
      exitCode: 2,
    });
  });

  it('records every refused tool call from the result message', async () => {
    const events = await collect([
      {
        type: 'result',
        subtype: 'success',
        usage: { input_tokens: 5, output_tokens: 7 },
        permission_denials: [{ tool_name: 'Edit', tool_input: { file_path: '/etc/passwd' } }],
        structured_output: { status: 'done', summary: 'x' },
      },
    ]);
    expect(events).toContainEqual({
      type: 'permission_denied',
      runId: 'run-headless-1',
      tool: 'Edit',
      input: { file_path: '/etc/passwd' },
    });
    expect(events).toContainEqual({
      type: 'result',
      runId: 'run-headless-1',
      raw: { status: 'done', summary: 'x' },
      tokensIn: 5,
      tokensOut: 7,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      costUsd: 0,
      byModel: {},
    });
  });

  /**
   * The numbers here are copied from a real result message of this
   * repository's own build loop, and they are the reason §7.1's estimator does
   * not meter on `input_tokens`: 200 against 19,213,630 cache reads. Anything
   * summing `tokensIn + tokensOut` would read about half a percent of what the
   * session consumed — an undercount, which is the direction that authorises
   * spending that is not there.
   */
  it('carries the whole usage breakdown, not the two fields that look like it', async () => {
    const events = await collect([
      {
        type: 'result',
        subtype: 'success',
        total_cost_usd: 14.629604,
        usage: {
          input_tokens: 200,
          cache_creation_input_tokens: 231_069,
          cache_read_input_tokens: 19_213_630,
          output_tokens: 108_360,
        },
        modelUsage: {
          'claude-opus-5[1m]': { costUSD: 14.627505, canonicalModel: 'claude-opus-5' },
          'claude-haiku-4-5-20251001': { costUSD: 0.002099, canonicalModel: 'claude-haiku-4-5' },
        },
        structured_output: { status: 'done', summary: 'x' },
      },
    ]);
    const result = events.find((e) => e.type === 'result');
    expect(result).toMatchObject({
      tokensIn: 200,
      tokensOut: 108_360,
      cacheReadTokens: 19_213_630,
      cacheCreationTokens: 231_069,
      costUsd: 14.629604,
    });
    // Keyed by canonical model, not by the versioned id — a weekly per-model
    // cap is about the class, and the id changes under it.
    expect(result?.type === 'result' && result.byModel).toEqual({
      'claude-opus-5': 14.627505,
      'claude-haiku-4-5': 0.002099,
    });
  });

  /**
   * §7.1's window boundary (A59), and — above the vendor's warning threshold —
   * the percentage with it (A73).
   *
   * An ordinary `allowed` frame carries no figure, which is what A59 observed
   * and what makes it decisive for the *estimating* meter: the observed
   * five-hour resets land on aligned boundaries, so `resetsAt - 5h` is a window
   * start exactly.
   */
  it('turns a rate_limit_event into an anchor, converting epoch seconds', async () => {
    const events = await collect([
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed',
          resetsAt: 1_785_578_400,
          rateLimitType: 'five_hour',
        },
      },
    ]);
    expect(events).toContainEqual({
      type: 'rate_limit_anchor',
      runId: 'run-headless-1',
      window: 'five_hour',
      resetsAt: 1_785_578_400_000,
      status: 'allowed',
      // Null rather than 0. A missing reading and a window at zero are opposite
      // facts, and only one of them may let the studio keep working.
      utilization: null,
    });
  });

  it('keeps the utilisation a warning frame carries — the only official figure there is', async () => {
    // Observed verbatim on 2026-08-01 at 22:00 CEST, in the build loop's own
    // transcript, under `CLAUDE_CODE_OAUTH_TOKEN` auth — the arrangement A64
    // proved `get_usage` answers nothing under. Fraction, not percent.
    const events = await collect([
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed_warning',
          resetsAt: 1_785_621_600,
          rateLimitType: 'five_hour',
          utilization: 0.97,
          surpassedThreshold: 0.75,
        },
      },
    ]);
    expect(events).toContainEqual({
      type: 'rate_limit_anchor',
      runId: 'run-headless-1',
      window: 'five_hour',
      resetsAt: 1_785_621_600_000,
      status: 'allowed_warning',
      utilization: 0.97,
    });
  });

  it('refuses a utilisation that is not a finite number rather than passing it on', async () => {
    // Everything downstream multiplies this by 100 and compares it against a
    // threshold. A NaN would compare false against every one of them, so §7.2
    // would read "not above the limit" and never fire — the failure mode this
    // whole file is paranoid about.
    const events = await collect([
      {
        type: 'rate_limit_event',
        rate_limit_info: {
          status: 'allowed_warning',
          resetsAt: 1_785_621_600,
          rateLimitType: 'five_hour',
          utilization: 'sehr viel',
        },
      },
    ]);
    const anchor = events.find((e) => e.type === 'rate_limit_anchor');
    expect(anchor && 'utilization' in anchor && anchor.utilization).toBeNull();
  });

  it('drops an anchor whose window or reset it cannot read, rather than inventing one', async () => {
    // A boundary is the one number the estimate may not guess: getting it wrong
    // moves the window start and silently drops spend that still counts.
    const events = await collect([
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour' },
      },
      {
        type: 'rate_limit_event',
        rate_limit_info: { status: 'allowed', resetsAt: 1, rateLimitType: 'lunar' },
      },
    ]);
    expect(events.some((e) => e.type === 'rate_limit_anchor')).toBe(false);
  });

  it('ignores non-JSON noise on stdout rather than dying on it', async () => {
    // The CLI prints warnings and progress lines alongside the stream; a parser
    // that threw on one would turn a cosmetic vendor change into a failed task.
    const events = await runRaw(
      ['-e', 'console.log("Warning: no stdin data received"); console.log("{ not json")'],
      {},
    );
    expect(events.at(-1)).toMatchObject({ type: 'terminated', reason: 'completed' });
  });
});

describe('the backend-side turn cap (A32 layer 3)', () => {
  it('counts one assistant message once, however many blocks it arrives in', async () => {
    // Observed on the pinned CLI: a single haiku turn produced two `assistant`
    // lines — a thinking block and a tool_use block — under one `message.id`.
    // Counting lines made a 1-turn cap fire on the first turn.
    const events = await collect(
      [
        assistantLine('m1', { type: 'thinking', thinking: 'hm' }),
        assistantLine('m1', { type: 'text', text: 'fertig' }),
      ],
      spec({ caps: { maxTurns: 1, maxBudgetUsd: null, wallClockMs: 30_000 } }),
    );
    expect(events.at(-1)).toMatchObject({ reason: 'completed' });
  });

  it('still fires when the cap is genuinely exceeded', async () => {
    const events = await collect(
      [
        assistantLine('m1', { type: 'text', text: 'eins' }),
        assistantLine('m2', { type: 'text', text: 'zwei' }),
      ],
      spec({ caps: { maxTurns: 1, maxBudgetUsd: null, wallClockMs: 30_000 } }),
    );
    expect(events.at(-1)).toMatchObject({ reason: 'max_turns' });
  });

  it('counts an id-less assistant message on its own', async () => {
    const events = await collect(
      [
        { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: 'b' }] } },
      ],
      spec({ caps: { maxTurns: 1, maxBudgetUsd: null, wallClockMs: 30_000 } }),
    );
    expect(events.at(-1)).toMatchObject({ reason: 'max_turns' });
  });
});

describe('eine gebrochene stdin-Leitung (§6.1)', () => {
  /**
   * Der Defekt, den zwei unabhängige Läufe gefunden haben, und warum der
   * vorhandene `try/catch` ihn nicht fangen konnte.
   *
   * `write()` schreibt in einem `try/catch` auf `child.stdin`. Ein Stream meldet
   * eine gebrochene Leitung aber **asynchron**, über sein `error`-Ereignis,
   * lange nachdem `write` zurückgekehrt ist — der `catch` sieht sie nie. Ein
   * `error`-Ereignis ohne Zuhörer ist in Node eine unbehandelte Ausnahme, und
   * die nimmt den Daemon mit, samt jeder anderen laufenden Sitzung.
   *
   * Von außen sieht das aus wie eine Testsuite, die mit Exit 1 endet und **null
   * fehlgeschlagene Tests** meldet. Genau so ist es zweimal aufgetreten, beide
   * Male aus `headless.ts` heraus, beide Male an derselben Zeile.
   *
   * **Was dieser Test nicht tut, und warum:** er stellt den Wettlauf nicht her,
   * der die EPIPE erzeugt (`interrupt()` schreibt, während die CLI gerade
   * verschwindet). Ich habe es versucht — ein Prozess, der sofort endet, und ein
   * Schreibversuch danach — und dabei nur bewiesen, dass dieser Weg **keine**
   * EPIPE erzeugt: nach dem Lauf ist stdin bereits geschlossen, `write` kehrt
   * sofort zurück (A51.5). Der echte Auslöser ist zeitabhängig und deshalb kein
   * Testfall, sondern eine Beobachtung. Was hier geprüft wird, ist die
   * Zusicherung selbst: ein Fehler auf dieser Leitung wird **behandelt**, statt
   * den Prozess zu beenden. Das ist die Eigenschaft, die gefehlt hat.
   */
  it('wird zur Warnung, statt eine unbehandelte Ausnahme zu werden', async () => {
    const warnungen: string[] = [];
    const backend = new HeadlessBackend({
      command: process.execPath,
      env: { VORSCHICHT_STUB_LINES: JSON.stringify([]) },
      onWarning: (message) => warnungen.push(message),
    });
    const handle = await backend.spawn(spec());
    (handle as unknown as { args: string[] }).args.unshift(stubCli);

    // Der Kindprozess entsteht erst, wenn der Ereignisstrom läuft — also erst
    // starten, dann auf die Leitung zugreifen.
    const lauf = (async () => {
      for await (const _ of handle.events()) {
        // den Lauf auslaufen lassen
      }
    })();

    const kind = handle as unknown as { child?: { stdin?: NodeJS.EventEmitter } };
    for (let versuch = 0; versuch < 100 && !kind.child?.stdin; versuch += 1) {
      await new Promise((fertig) => setTimeout(fertig, 10));
    }
    const stdin = kind.child?.stdin;
    if (!stdin) throw new Error('kein stdin — die Aufstellung stimmt nicht mehr');

    // Ohne Zuhörer wirft genau diese Zeile und beendet den Testlauf; mit einem
    // wird sie zu einer Zeile im Protokoll. Das ist der ganze Unterschied.
    expect(() => stdin.emit('error', new Error('write EPIPE'))).not.toThrow();
    expect(warnungen.join(' ')).toMatch(/stdin/i);

    await lauf;
  });
});

describe('classification', () => {
  it('calls an authentication failure an auth incident, never a crash (§6.1)', async () => {
    // The distinction is the whole of §6.1: an auth incident parks work and
    // alerts, a crash fails a task. Nothing downstream can tell them apart
    // afterwards, so the reason has to be right here.
    const events = await runRaw(
      ['-e', 'console.error("401 authentication_error"); process.exit(1)'],
      {},
    );
    expect(events.at(-1)).toMatchObject({ type: 'terminated', reason: 'auth_incident' });
  });

  it('reports a non-zero exit with no known cause as crashed', async () => {
    const events = await collect([], spec(), { VORSCHICHT_STUB_EXIT: '3' });
    expect(events.at(-1)).toMatchObject({ type: 'terminated', reason: 'crashed', exitCode: 3 });
  });
});

describe('ending a session that has produced its result', () => {
  /** Like `collect`, but against the stub that waits on stdin. */
  async function collectWaiting(lines: unknown[], session = spec()): Promise<BackendEvent[]> {
    const backend = new HeadlessBackend({
      command: process.execPath,
      env: { VORSCHICHT_STUB_LINES: JSON.stringify(lines) },
    });
    const handle = await backend.spawn(session);
    (handle as unknown as { args: string[] }).args.unshift(waitingStubCli);
    const events: BackendEvent[] = [];
    for await (const event of handle.events()) events.push(event);
    return events;
  }

  const resultLine = {
    type: 'result',
    subtype: 'success',
    usage: { input_tokens: 1, output_tokens: 2 },
  };

  it('closes stdin so the process exits, instead of waiting out the wall clock', async () => {
    // The defect this guards against was invisible to every other test in this
    // file, because the ordinary stub exits on its own. Measured against the
    // real CLI before the fix: result at +2.7s, `terminated` at +150.3s — every
    // run holding a concurrency slot for its whole budget and being reported as
    // a timeout rather than as done.
    const started = Date.now();
    const events = await collectWaiting([resultLine]);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(events.at(-1)).toMatchObject({ type: 'terminated', reason: 'completed' });
  });

  it('keeps the cap reason when the result carries one', async () => {
    const events = await collectWaiting([{ ...resultLine, subtype: 'error_max_turns' }]);
    expect(events.at(-1)).toMatchObject({ reason: 'max_turns' });
  });

  it('answers a usage query after the result immediately rather than after the control timeout', async () => {
    const backend = new HeadlessBackend({
      command: process.execPath,
      env: { VORSCHICHT_STUB_LINES: JSON.stringify([resultLine]) },
    });
    const handle = await backend.spawn(spec());
    (handle as unknown as { args: string[] }).args.unshift(waitingStubCli);
    for await (const event of handle.events()) void event;
    const started = Date.now();
    expect(await handle.queryUsage()).toBeNull();
    // §7.1's meter samples during a run, not after it — but finding that out
    // must not cost 15 seconds of control timeout per question.
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});
