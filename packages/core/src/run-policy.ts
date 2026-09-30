/**
 * Writing the containment policy for one run (§6.6).
 *
 * The hook that reads this document runs as a separate process on every tool
 * call, so the policy is a *file* rather than a query: a hook that asked the
 * database whether a path is claimed would add a connection to every `Write`
 * and would stop containing anything the moment Postgres hiccupped. A file it
 * reads in a millisecond fails closed by construction — unreadable means deny.
 *
 * That the policy can be static at all is a property of §10, not a shortcut:
 * claims are registered before any coder starts and released on merge or abort
 * (A45), and a task re-planned with a different claim set is re-checked and
 * gets a new run. A claim set therefore does not change under a running
 * session, and a document written at spawn time is as current at the last tool
 * call as it was at the first.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunContainmentPolicy } from '@vorschicht/shared';
import { parseRunContainmentPolicy } from '@vorschicht/shared';
import { runDirFor } from './run-dir.js';

export class RunPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunPolicyError';
  }
}

export function runPolicyPathFor(runsRoot: string, runId: string): string {
  return join(runDirFor(runsRoot, runId), 'containment.json');
}

export interface WriteRunPolicyInput {
  /** `<dataRoot>/runs` — see `Config.runsRoot`. */
  runsRoot: string;
  policy: RunContainmentPolicy;
}

/**
 * Write the document and return its path.
 *
 * Round-tripped through the hook's own parser before it is written. The parser
 * is deliberately strict and hand-written (it runs in the hook, where zod would
 * cost more than the check it performs), which makes it exactly the thing that
 * can quietly disagree with the writer — and a policy the hook cannot parse
 * denies every write, i.e. a task that fails on its first edit for a reason
 * nobody would look for here. Cheaper to catch at the spawn.
 *
 * Mode 0600: it names a worktree and a claim set. No credential, but a run's
 * boundaries are not something other processes on the host need to read.
 */
export async function writeRunPolicy(input: WriteRunPolicyInput): Promise<string> {
  const { runsRoot, policy } = input;
  const body = `${JSON.stringify(policy, null, 2)}\n`;

  const reparsed = parseRunContainmentPolicy(JSON.parse(body));
  if (!reparsed) {
    throw new RunPolicyError(
      `Containment-Richtlinie für Lauf ${policy.runId} ist nicht wieder einlesbar. ` +
        'Der Hook würde daraufhin jeden Schreibzugriff verweigern (§6.6).',
    );
  }
  if (reparsed.readOnlyProject !== policy.readOnlyProject) {
    throw new RunPolicyError(
      `Containment-Richtlinie für Lauf ${policy.runId} liest sich anders zurück, als ` +
        'sie geschrieben wurde — readOnlyProject stimmt nicht überein.',
    );
  }

  const path = runPolicyPathFor(runsRoot, policy.runId);
  await mkdir(runDirFor(runsRoot, policy.runId), { recursive: true, mode: 0o700 });
  await writeFile(path, body, { mode: 0o600 });
  return path;
}
