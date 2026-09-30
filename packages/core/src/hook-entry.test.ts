/**
 * The containment hook, in two halves.
 *
 * `runHook` is tested as a function, and then the **compiled artefact** is
 * spawned as a process and driven over real stdio. Both matter, and for
 * different reasons: the function decides, and the process is what the CLI
 * actually runs — with an exit code that decides whether a refusal refuses.
 * A hook that returns the right JSON and exits 1 lets the write happen.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { RunContainmentPolicy } from '@vorschicht/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadPolicy, RUN_POLICY_ENV, runHook } from './hook-entry.js';

const WORKTREE = '/srv/vorschicht/worktrees/sandbox/task-42';

const POLICY: RunContainmentPolicy = {
  runId: 'run-1',
  taskId: 'task-42',
  role: 'coder',
  writeRoot: WORKTREE,
  claims: ['src/**'],
  extraSecretPatterns: [],
  readOnlyProject: false,
};

function payload(toolName: string, toolInput: unknown): string {
  return JSON.stringify({
    session_id: 's1',
    cwd: WORKTREE,
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
  });
}

function parseDecision(stdout: string): {
  permissionDecision?: string;
  permissionDecisionReason?: string;
} {
  return JSON.parse(stdout).hookSpecificOutput;
}

describe('runHook — pre-tool-use', () => {
  it('stays silent when the call is fine', () => {
    const out = runHook(
      'pre-tool-use',
      payload('Write', { file_path: `${WORKTREE}/src/a.ts`, content: 'x' }),
      POLICY,
    );
    expect(out).toEqual({ stdout: '', stderr: '', exitCode: 0 });
  });

  it('never emits an allow — that would override the permission system', () => {
    // A hook `allow` waves a call past `--allowedTools`, which is §6.6's layer
    // 2. Staying silent lets every other layer still say no.
    const out = runHook('pre-tool-use', payload('Read', { file_path: '/opt/other/a.ts' }), POLICY);
    expect(out.stdout).toBe('');
  });

  it('denies as JSON with exit 0, so a refusal stays distinguishable from a crash', () => {
    const out = runHook(
      'pre-tool-use',
      payload('Write', { file_path: '/etc/passwd', content: 'x' }),
      POLICY,
    );
    expect(out.exitCode).toBe(0);
    expect(parseDecision(out.stdout).permissionDecision).toBe('deny');
    expect(parseDecision(out.stdout).permissionDecisionReason).toContain('outside your worktree');
    // The rule name goes to the CLI's log, never to the model.
    expect(out.stderr).toBe('containment: write-outside-worktree');
  });

  it('denies a credential read', () => {
    const out = runHook('pre-tool-use', payload('Read', { file_path: '/opt/app/.env' }), POLICY);
    expect(parseDecision(out.stdout).permissionDecision).toBe('deny');
    expect(out.stderr).toBe('containment: secret-path');
  });

  it('denies an unreadable payload rather than assuming the best', () => {
    for (const bad of ['', 'not json', '[]', 'null']) {
      const out = runHook('pre-tool-use', bad, POLICY);
      expect(parseDecision(out.stdout).permissionDecision, bad).toBe('deny');
      expect(out.exitCode).toBe(0);
    }
  });

  it('denies everything when no policy could be loaded', () => {
    const out = runHook(
      'pre-tool-use',
      payload('Write', { file_path: `${WORKTREE}/src/a.ts`, content: 'x' }),
      null,
    );
    expect(parseDecision(out.stdout).permissionDecision).toBe('deny');
    expect(parseDecision(out.stdout).permissionDecisionReason).toContain('orchestrator fault');
  });
});

describe('runHook — session-start (the liveness half)', () => {
  it('says nothing when containment is armed', () => {
    expect(runHook('session-start', '{}', POLICY)).toEqual({ stdout: '', stderr: '', exitCode: 0 });
  });

  it('reports an error before a single turn is spent when the policy is missing', () => {
    const out = runHook('session-start', '{}', null);
    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain(RUN_POLICY_ENV);
  });
});

describe('loadPolicy', () => {
  it('returns null rather than throwing on every way it can fail', () => {
    expect(loadPolicy({})).toBeNull();
    expect(loadPolicy({ [RUN_POLICY_ENV]: '   ' })).toBeNull();
    expect(
      loadPolicy({ [RUN_POLICY_ENV]: '/x' }, () => {
        throw new Error('ENOENT');
      }),
    ).toBeNull();
    expect(loadPolicy({ [RUN_POLICY_ENV]: '/x' }, () => 'not json')).toBeNull();
    expect(loadPolicy({ [RUN_POLICY_ENV]: '/x' }, () => '{"runId":""}')).toBeNull();
  });

  it('reads a well-formed document', () => {
    expect(loadPolicy({ [RUN_POLICY_ENV]: '/x' }, () => JSON.stringify(POLICY))).toEqual(POLICY);
  });
});

/**
 * The compiled hook as the CLI runs it.
 *
 * `hook-entry.js` from `dist/`, not the source — `tsc --build` runs before
 * `gate:test`, and the artefact is what ships. What this proves that the
 * function tests cannot: the process reads stdin, writes stdout, and **exits
 * 0**, including on the paths that went wrong. Exit 1 is the one code that
 * means "carry on regardless".
 */
describe('the compiled hook as a process', () => {
  const entry = resolve(import.meta.dirname, '../dist/hook-entry.js');
  let dir: string;
  let policyPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vorschicht-hook-'));
    policyPath = join(dir, 'containment.json');
    writeFileSync(policyPath, JSON.stringify(POLICY));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  function run(
    stdin: string,
    env: NodeJS.ProcessEnv = { [RUN_POLICY_ENV]: policyPath },
    args: string[] = [],
  ) {
    return spawnSync(process.execPath, [entry, ...args], {
      input: stdin,
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...env },
    });
  }

  it('is present — it ships in the image and every session depends on it', () => {
    // Checked on the filesystem, not through `spawnSync().error`.
    //
    // `error` is set only when the *spawn* fails, and `node <missing file>` is
    // a perfectly successful spawn that then exits 1 with ERR_MODULE_NOT_FOUND.
    // So the old form was `expect(undefined).toBeUndefined()` — and it ran the
    // identical command as the exit-2 case forty lines below, with the
    // assertion removed. A missing artefact would have failed neither.
    expect(existsSync(entry), `${entry} fehlt: erst \`pnpm gate:typecheck\` laufen lassen`).toBe(
      true,
    );
  });

  it('allows a claimed write and says nothing', () => {
    const result = run(payload('Write', { file_path: `${WORKTREE}/src/a.ts`, content: 'x' }));
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('');
  });

  it('denies an out-of-worktree write with exit 0 and a deny document', () => {
    const result = run(payload('Write', { file_path: '/etc/passwd', content: 'x' }));
    expect(result.status).toBe(0);
    expect(parseDecision(result.stdout).permissionDecision).toBe('deny');
  });

  it('denies a credential read', () => {
    const result = run(payload('Read', { file_path: '/opt/app/.env' }));
    expect(result.status).toBe(0);
    expect(parseDecision(result.stdout).permissionDecision).toBe('deny');
  });

  it('denies — and does not exit 1 — when the policy file is gone', () => {
    const result = run(payload('Write', { file_path: `${WORKTREE}/src/a.ts`, content: 'x' }), {
      [RUN_POLICY_ENV]: join(dir, 'does-not-exist.json'),
    });
    expect(result.status).toBe(0);
    expect(parseDecision(result.stdout).permissionDecision).toBe('deny');
  });

  it('denies when the environment names no policy at all', () => {
    const result = run(payload('Write', { file_path: `${WORKTREE}/src/a.ts`, content: 'x' }), {});
    expect(result.status).toBe(0);
    expect(parseDecision(result.stdout).permissionDecision).toBe('deny');
  });

  it('denies when the policy file is corrupt', () => {
    const broken = join(dir, 'broken.json');
    writeFileSync(broken, '{ this is not json');
    const result = run(payload('Write', { file_path: `${WORKTREE}/src/a.ts`, content: 'x' }), {
      [RUN_POLICY_ENV]: broken,
    });
    expect(result.status).toBe(0);
    expect(parseDecision(result.stdout).permissionDecision).toBe('deny');
  });

  it('signals a broken session at SessionStart with exit 2', () => {
    const result = run('{}', {}, ['session-start']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('§6.6');
  });

  it('costs a fraction of a turn — it runs on every tool call', () => {
    const started = performance.now();
    for (let i = 0; i < 5; i += 1) {
      run(payload('Write', { file_path: `${WORKTREE}/src/a${i}.ts`, content: 'x' }));
    }
    const perCall = (performance.now() - started) / 5;
    // Generous by design: this is a regression guard against someone adding an
    // import, not a benchmark. ADR 0003 measured `@vorschicht/db` at 879 ms —
    // an import of that weight here would be paid on every `Write` of the night.
    expect(perCall).toBeLessThan(400);
  });
});
