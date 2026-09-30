/**
 * Writing the `--mcp-config` document for one run (§6.2).
 *
 * The document is **per run**, not per installation, because it is what tells
 * the MCP server which task it serves. §6.2's example points at a single
 * `/app/mcp/vorschicht.json`; a static file cannot carry a task id, and a task
 * id that arrived as a tool argument instead would put the entire "a session
 * can only touch its own task" boundary inside one `if` in a process whose sole
 * caller is a language model.
 *
 * Where it lives matters as much as what is in it:
 *
 *   * **Outside the worktree.** The agent can read its worktree and could edit
 *     a config file it found there; the run directory is not reachable through
 *     any claim, and the write-deny hook of §6.6 refuses paths outside the
 *     worktree anyway.
 *   * **On the container's own filesystem, not a volume.** The file is scratch:
 *     it is written before the spawn and removed after the run. A restart
 *     losing it costs nothing, because a restart also ends every run it
 *     belonged to (`reconcile()`).
 *   * **Without a single secret in it** — see `buildMcpServerConfig`. The
 *     database URL is inherited from the orchestrator's environment; the OAuth
 *     token is blanked. What is left is a task id, a run id and a role name.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { buildMcpServerConfig } from '@vorschicht/shared';
import { removeRunDir, runDirFor } from './run-dir.js';

export interface McpRunConfigInput {
  /** `<dataRoot>/runs` — see `Config.runsRoot`. */
  runsRoot: string;
  runId: string;
  taskId: string;
  /** Profile id; recorded as the actor on everything the session writes. */
  role: string;
  /** Absolute path of the MCP server entry point inside the container. */
  serverEntry: string;
  /** The interpreter. `node` unless a test needs otherwise. */
  command?: string;
}

export function mcpConfigPathFor(runsRoot: string, runId: string): string {
  return join(runDirFor(runsRoot, runId), 'mcp.json');
}

/**
 * Write the document and return its path.
 *
 * Mode 0600: the file names the task a session may act on, and while it holds
 * no credential, a run's identity is not something any other process on the
 * host has business reading.
 */
export async function writeMcpRunConfig(input: McpRunConfigInput): Promise<string> {
  const path = mcpConfigPathFor(input.runsRoot, input.runId);
  const document = buildMcpServerConfig({
    command: input.command ?? 'node',
    args: [input.serverEntry],
    taskId: input.taskId,
    runId: input.runId,
    role: input.role,
  });
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
  return path;
}

/**
 * Remove a run's scratch directory — the MCP document and the containment
 * policy together, since both belong to the run and neither outlives it.
 */
export async function removeMcpRunConfig(runsRoot: string, runId: string): Promise<void> {
  await removeRunDir(runsRoot, runId);
}
