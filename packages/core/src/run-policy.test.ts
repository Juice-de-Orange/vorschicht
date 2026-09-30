import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseRunContainmentPolicy, type RunContainmentPolicy } from '@vorschicht/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { removeRunDir, runDirFor } from './run-dir.js';
import { RunPolicyError, runPolicyPathFor, writeRunPolicy } from './run-policy.js';

const POLICY: RunContainmentPolicy = {
  runId: 'run-a',
  taskId: 'task-42',
  role: 'coder',
  writeRoot: '/srv/vorschicht/worktrees/sandbox/task-42',
  claims: ['src/**', 'docs/*.md'],
  extraSecretPatterns: ['*.vault'],
  readOnlyProject: false,
};

describe('writeRunPolicy', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'vorschicht-runs-'));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('writes what the hook will read back, byte for byte', async () => {
    const path = await writeRunPolicy({ runsRoot: root, policy: POLICY });
    expect(path).toBe(runPolicyPathFor(root, 'run-a'));
    expect(parseRunContainmentPolicy(JSON.parse(readFileSync(path, 'utf8')))).toEqual(POLICY);
  });

  it('lands beside the run’s MCP config, so one rm ends the run', async () => {
    await writeRunPolicy({ runsRoot: root, policy: POLICY });
    expect(runPolicyPathFor(root, 'run-a').startsWith(runDirFor(root, 'run-a'))).toBe(true);
    await removeRunDir(root, 'run-a');
    expect(() => statSync(runDirFor(root, 'run-a'))).toThrow();
  });

  it('is not world-readable — it names a worktree and a claim set', async () => {
    const path = await writeRunPolicy({ runsRoot: root, policy: POLICY });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('refuses a policy the hook could not parse', async () => {
    // The hook's parser is hand-written (it runs where zod would cost more than
    // the check), which makes it exactly the thing that can quietly disagree
    // with the writer — and a policy the hook cannot read denies every write.
    await expect(
      writeRunPolicy({
        runsRoot: root,
        policy: { ...POLICY, writeRoot: 'relative/path' },
      }),
    ).rejects.toThrow(RunPolicyError);
  });

  it('keeps a read-only run read-only across the round trip (A41)', async () => {
    const path = await writeRunPolicy({
      runsRoot: root,
      policy: { ...POLICY, readOnlyProject: true },
    });
    expect(parseRunContainmentPolicy(JSON.parse(readFileSync(path, 'utf8')))?.readOnlyProject).toBe(
      true,
    );
  });

  it('gives each run its own document', async () => {
    expect(runPolicyPathFor(root, 'run-1')).not.toBe(runPolicyPathFor(root, 'run-2'));
  });

  it('removes a directory that was never there without complaining', async () => {
    await expect(removeRunDir(root, 'never-existed')).resolves.toBeUndefined();
  });
});
