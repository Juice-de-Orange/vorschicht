/**
 * §6.6's rule, case by case.
 *
 * Every test here asks the same question the hook asks a hundred times a
 * session, and the ones worth reading twice are the negative ones: this module
 * is only useful if it says no in the cases nobody thought to seed.
 */
import { describe, expect, it } from 'vitest';
import {
  decideToolCall,
  extractPaths,
  isMutating,
  matchesSecretPattern,
  parseRunContainmentPolicy,
  type RunContainmentPolicy,
  SECRET_PATH_EXCEPTIONS,
  SECRET_PATH_PATTERNS,
} from './containment.js';

const WORKTREE = '/srv/vorschicht/worktrees/sandbox/task-42';

function policy(overrides: Partial<RunContainmentPolicy> = {}): RunContainmentPolicy {
  return {
    runId: 'run-1',
    taskId: 'task-42',
    role: 'coder',
    writeRoot: WORKTREE,
    claims: ['src/**', 'docs/*.md'],
    extraSecretPatterns: [],
    readOnlyProject: false,
    ...overrides,
  };
}

function write(file: string, extra: Record<string, unknown> = {}) {
  return {
    toolName: 'Write',
    toolInput: { file_path: file, content: 'x', ...extra },
    cwd: WORKTREE,
  };
}

function read(file: string) {
  return { toolName: 'Read', toolInput: { file_path: file }, cwd: WORKTREE };
}

describe('write containment (§6.6)', () => {
  it('lets a claimed file inside the worktree through', () => {
    expect(decideToolCall(policy(), write(`${WORKTREE}/src/a.ts`)).decision).toBe('allow');
    expect(decideToolCall(policy(), write(`${WORKTREE}/docs/adr.md`)).decision).toBe('allow');
  });

  it('refuses a write outside the worktree, naming the worktree', () => {
    const result = decideToolCall(policy(), write('/opt/example-app/src/index.ts'));
    expect(result).toMatchObject({ decision: 'deny', rule: 'write-outside-worktree' });
    if (result.decision === 'deny') expect(result.reason).toContain(WORKTREE);
  });

  it('refuses a sibling worktree, which is the collision §10 exists to prevent', () => {
    const sibling = '/srv/vorschicht/worktrees/sandbox/task-43/src/a.ts';
    expect(decideToolCall(policy(), write(sibling))).toMatchObject({
      rule: 'write-outside-worktree',
    });
  });

  it('refuses a path that climbs out with ".."', () => {
    expect(decideToolCall(policy(), write(`${WORKTREE}/src/../../task-43/src/a.ts`))).toMatchObject(
      {
        rule: 'write-outside-worktree',
      },
    );
  });

  it('resolves a relative path against the session cwd rather than ignoring it', () => {
    expect(
      decideToolCall(policy(), {
        toolName: 'Write',
        toolInput: { file_path: 'src/a.ts', content: 'x' },
        cwd: WORKTREE,
      }),
    ).toMatchObject({ decision: 'allow' });
    expect(
      decideToolCall(policy(), {
        toolName: 'Write',
        toolInput: { file_path: '../task-43/a.ts', content: 'x' },
        cwd: WORKTREE,
      }),
    ).toMatchObject({ rule: 'write-outside-worktree' });
  });

  it('refuses an unclaimed file inside the worktree, and says what is held', () => {
    const result = decideToolCall(policy(), write(`${WORKTREE}/infra/deploy.sh`));
    expect(result).toMatchObject({ decision: 'deny', rule: 'write-outside-claims' });
    if (result.decision === 'deny') expect(result.reason).toContain('src/**');
  });

  it('refuses repository plumbing even when a claim would cover it', () => {
    // `**` covers `.git/hooks/pre-commit`, and a pre-commit hook is arbitrary
    // code that the Coder itself then executes on the next commit.
    const wide = policy({ claims: ['**'] });
    expect(decideToolCall(wide, write(`${WORKTREE}/.git/hooks/pre-commit`))).toMatchObject({
      rule: 'write-into-internals',
    });
    expect(decideToolCall(wide, write(`${WORKTREE}/.claude/settings.json`))).toMatchObject({
      rule: 'write-into-internals',
    });
  });

  it('refuses the worktree directory itself', () => {
    expect(decideToolCall(policy({ claims: ['**'] }), write(WORKTREE)).decision).toBe('deny');
  });

  it('refuses every write when the task holds no claims yet (§10 pending)', () => {
    expect(decideToolCall(policy({ claims: [] }), write(`${WORKTREE}/src/a.ts`))).toMatchObject({
      rule: 'no-claims',
    });
  });

  it('refuses every write in a read-only project (A41), whatever the claims say', () => {
    const p = policy({ readOnlyProject: true, claims: ['**'] });
    expect(decideToolCall(p, write(`${WORKTREE}/src/a.ts`))).toMatchObject({
      rule: 'read-only-project',
    });
    // …and still allows reading it, which is the whole point of "analysed".
    expect(decideToolCall(p, read(`${WORKTREE}/src/a.ts`)).decision).toBe('allow');
  });

  it('refuses every write when the session has no worktree', () => {
    expect(decideToolCall(policy({ writeRoot: null }), write('/tmp/x.ts'))).toMatchObject({
      rule: 'no-write-root',
    });
  });

  it('contains a scratch session by directory alone (claims: null)', () => {
    const p = policy({ writeRoot: '/scratch/research', claims: null, taskId: null });
    expect(
      decideToolCall(p, {
        toolName: 'Write',
        toolInput: { file_path: '/scratch/research/notes.md', content: 'x' },
        cwd: '/scratch/research',
      }).decision,
    ).toBe('allow');
    expect(
      decideToolCall(p, {
        toolName: 'Write',
        toolInput: { file_path: '/scratch/other/notes.md', content: 'x' },
        cwd: '/scratch/research',
      }),
    ).toMatchObject({
      rule: 'write-outside-worktree',
    });
  });

  it('checks every file of a multi-file edit, not only the first', () => {
    const call = {
      toolName: 'MultiEdit',
      toolInput: {
        edits: [
          { file_path: `${WORKTREE}/src/a.ts`, new_string: 'a' },
          { file_path: '/etc/passwd', new_string: 'b' },
        ],
      },
      cwd: WORKTREE,
    };
    expect(decideToolCall(policy(), call)).toMatchObject({ rule: 'write-outside-worktree' });
  });

  it('refuses a mutating call whose arguments name no file at all', () => {
    expect(
      decideToolCall(policy(), { toolName: 'Write', toolInput: { content: 'x' }, cwd: WORKTREE }),
    ).toMatchObject({ rule: 'unreadable-call' });
  });
});

describe('reading (§6.6: read across the projects root, never a credential)', () => {
  it('allows reading another project — that is explicitly wanted', () => {
    expect(decideToolCall(policy(), read('/opt/example-app/src/index.ts')).decision).toBe('allow');
  });

  it('refuses every listed credential pattern', () => {
    const cases = [
      '/opt/app/.env',
      '/opt/app/.env.production',
      '/home/x/certs/server.pem',
      '/home/x/keys/deploy.key',
      '/home/x/.ssh/id_rsa',
      '/home/x/.ssh/id_ed25519',
      '/home/x/store.p12',
      '/opt/app/credentials.json',
      '/opt/app/secrets/db.txt',
      '/opt/app/.npmrc',
      '/opt/app/.git-credentials',
    ];
    for (const path of cases) {
      expect(decideToolCall(policy(), read(path)), path).toMatchObject({ rule: 'secret-path' });
    }
  });

  it('refuses on a directory segment, not only on the filename', () => {
    expect(decideToolCall(policy(), read('/opt/app/secrets/harmless-readme.md'))).toMatchObject({
      rule: 'secret-path',
    });
  });

  it('matches patterns case-insensitively — the safe direction', () => {
    expect(decideToolCall(policy(), read('/opt/app/.ENV')).decision).toBe('deny');
    expect(decideToolCall(policy(), read('/opt/app/Server.PEM')).decision).toBe('deny');
  });

  it('lets the committed examples through (A51), and only those', () => {
    for (const name of SECRET_PATH_EXCEPTIONS) {
      expect(decideToolCall(policy(), read(`/opt/app/${name}`)).decision, name).toBe('allow');
    }
    // The exception is case-sensitive: an exception should be hard to hit by
    // accident, which is the opposite trade from the patterns above.
    expect(decideToolCall(policy(), read('/opt/app/.ENV.EXAMPLE')).decision).toBe('deny');
    expect(decideToolCall(policy(), read('/opt/app/.env.example.bak')).decision).toBe('deny');
  });

  it('applies the credential rule to writes as well as to reads', () => {
    // `Edit` reads before it writes, and a `.env` created inside a worktree is
    // a credential the transcript then carries for a year (§18).
    expect(decideToolCall(policy({ claims: ['**'] }), write(`${WORKTREE}/.env`))).toMatchObject({
      rule: 'secret-path',
    });
  });

  it('honours a project-supplied extra pattern (§6.6: additive)', () => {
    const p = policy({ extraSecretPatterns: ['*.vault'] });
    expect(decideToolCall(p, read('/opt/app/prod.vault'))).toMatchObject({ rule: 'secret-path' });
    expect(decideToolCall(policy(), read('/opt/app/prod.vault')).decision).toBe('allow');
  });

  it('refuses a search restricted to credential files', () => {
    expect(
      decideToolCall(policy(), {
        toolName: 'Grep',
        toolInput: { pattern: 'TOKEN', path: '/opt', glob: '**/.env*' },
        cwd: WORKTREE,
      }),
    ).toMatchObject({ rule: 'secret-path' });
  });

  it('allows an ordinary search — the residual leak is A21’s nightly scan, not this hook', () => {
    expect(
      decideToolCall(policy(), {
        toolName: 'Grep',
        toolInput: { pattern: 'TODO', path: '/opt/example-app', output_mode: 'files_with_matches' },
        cwd: WORKTREE,
      }).decision,
    ).toBe('allow');
  });
});

describe('tools this hook has never heard of', () => {
  it('treats an unknown tool carrying mutation-shaped arguments as a write', () => {
    expect(isMutating('Patch', { file_path: '/x', content: 'y' })).toBe(true);
    expect(
      decideToolCall(policy(), {
        toolName: 'Patch',
        toolInput: { file_path: '/etc/hosts', content: 'x' },
        cwd: WORKTREE,
      }),
    ).toMatchObject({
      rule: 'write-outside-worktree',
    });
  });

  it('treats an unknown tool with only a path as a read, because reading out is legal', () => {
    expect(isMutating('Inspect', { file_path: '/opt/other/x.ts' })).toBe(false);
    expect(
      decideToolCall(policy(), {
        toolName: 'Inspect',
        toolInput: { file_path: '/opt/other/x.ts' },
        cwd: WORKTREE,
      }).decision,
    ).toBe('allow');
  });

  it('still applies the credential rule to an unknown tool, through any string key', () => {
    expect(
      decideToolCall(policy(), {
        toolName: 'Inspect',
        toolInput: { somewhere: '/opt/app/.env' },
        cwd: WORKTREE,
      }),
    ).toMatchObject({ rule: 'secret-path' });
  });

  it('leaves Bash and MCP tools alone — §6.6 states that limit plainly', () => {
    expect(isMutating('Bash', { command: 'rm -rf /' })).toBe(false);
    expect(isMutating('mcp__vorschicht__task_append_note', { text: 'x' })).toBe(false);
  });

  it('refuses a call whose arguments are not an object at all', () => {
    expect(
      decideToolCall(policy(), { toolName: 'Write', toolInput: 'oops', cwd: WORKTREE }),
    ).toMatchObject({
      rule: 'unreadable-call',
    });
  });
});

describe('a missing policy denies rather than permits', () => {
  it('refuses everything that writes', () => {
    expect(decideToolCall(null, write(`${WORKTREE}/src/a.ts`))).toMatchObject({
      rule: 'policy-missing',
    });
  });

  it('refuses reads too — with no policy, nothing is established', () => {
    expect(decideToolCall(null, read('/opt/a.ts'))).toMatchObject({ rule: 'policy-missing' });
  });
});

describe('parsing a policy document', () => {
  const good = policy();

  it('round-trips what we write', () => {
    expect(parseRunContainmentPolicy(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });

  it('rejects everything that is not one', () => {
    for (const bad of [
      null,
      'string',
      [],
      {},
      { ...good, runId: '' },
      { ...good, role: 123 },
      { ...good, writeRoot: 'relative/path' },
      { ...good, claims: [1, 2] },
      { ...good, extraSecretPatterns: 'x' },
      { ...good, taskId: 7 },
    ]) {
      expect(parseRunContainmentPolicy(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('reads a missing or mistyped readOnlyProject as read-only, never as writable', () => {
    const { readOnlyProject: _drop, ...without } = good;
    expect(parseRunContainmentPolicy(without)?.readOnlyProject).toBe(true);
    expect(parseRunContainmentPolicy({ ...good, readOnlyProject: 'no' })?.readOnlyProject).toBe(
      true,
    );
    expect(parseRunContainmentPolicy(good)?.readOnlyProject).toBe(false);
  });
});

describe('the pattern list itself', () => {
  it('is the list §6.6 names, unchanged', () => {
    expect([...SECRET_PATH_PATTERNS]).toEqual([
      '.env*',
      '*.pem',
      '*.key',
      'id_rsa*',
      'id_ed25519*',
      '*.p12',
      'credentials*',
      'secrets*',
      '.npmrc',
      '.git-credentials',
    ]);
  });

  it('does not flag ordinary source, which is what makes it usable', () => {
    for (const path of [
      'packages/core/src/containment-monitor.ts',
      'packages/shared/src/claims.ts',
      'apps/web/src/main.tsx',
      'docs/adr/0003-mcp-server-startup.md',
      'infra/docker/Dockerfile.orchestrator',
      '.gitignore',
      'README.md',
    ]) {
      expect(matchesSecretPattern(path), path).toBeNull();
    }
  });

  it('names which pattern refused, so a denial can be classified', () => {
    expect(matchesSecretPattern('/a/b/.env.local')).toBe('.env*');
    expect(matchesSecretPattern('/a/b/tls.pem')).toBe('*.pem');
  });
});

describe('extractPaths', () => {
  it('finds the file behind each known key', () => {
    expect(extractPaths('Write', { file_path: '/a' })).toEqual([{ kind: 'path', value: '/a' }]);
    expect(extractPaths('NotebookEdit', { notebook_path: '/b' })).toEqual([
      { kind: 'path', value: '/b' },
    ]);
  });

  it('does not fall back to scanning strings for a known mutating tool', () => {
    // Falling back there would make an unparseable `Write` look checkable.
    expect(extractPaths('Write', { content: '/opt/app/.env' })).toEqual([]);
  });
});
