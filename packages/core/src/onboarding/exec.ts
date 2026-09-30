/**
 * Running a read-only command and getting an answer rather than an exception.
 *
 * `git.ts` throws on a non-zero exit, which is right for the merge queue — a
 * failed rebase is not a result. A survey is the opposite case: half its
 * commands are *expected* to fail on some repositories (`origin/HEAD` is often
 * unset, a shallow clone has no `rev-list`), and each failure is a fact to
 * record rather than an error to propagate. One collector falling over must not
 * cost the whole survey.
 *
 * `execFile` with an argument array, never a shell, for the reason `git.ts`
 * already states: paths and branch names reach these arguments from a database
 * and ultimately from a model.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

export interface ReadResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** The command as it was run, for the survey's `sources`. */
  command: string;
}

export async function execRead(
  file: string,
  args: readonly string[],
  opts: { cwd?: string; timeoutMs?: number } = {},
): Promise<ReadResult> {
  const command = `${file} ${args.join(' ')}`.trim();
  try {
    const { stdout, stderr } = await exec(file, [...args], {
      ...(opts.cwd ? { cwd: opts.cwd } : {}),
      timeout: opts.timeoutMs ?? 30_000,
      maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' },
    });
    return { ok: true, stdout, stderr, command };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: err.stdout ?? '',
      stderr: (err.stderr || err.message || '').trim(),
      command,
    };
  }
}
