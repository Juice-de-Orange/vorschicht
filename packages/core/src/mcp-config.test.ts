/**
 * The per-run `--mcp-config` document on disk (§6.2, §19).
 *
 * What is being checked here is mostly *absence*: that the file the CLI reads
 * before every session carries an identity and no credential, and that it lands
 * somewhere no agent's claim set can reach.
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mcpConfigPathFor, removeMcpRunConfig, writeMcpRunConfig } from './mcp-config.js';

describe('MCP-Konfiguration pro Lauf', () => {
  let root: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'vorschicht-mcp-'));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('legt die Datei unter <runsRoot>/<runId>/mcp.json ab', async () => {
    const path = await writeMcpRunConfig({
      runsRoot: root,
      runId: 'run-a',
      taskId: 'task-a',
      role: 'coder',
      serverEntry: '/app/packages/mcp/dist/main.js',
    });
    expect(path).toBe(mcpConfigPathFor(root, 'run-a'));
    const document = JSON.parse(await readFile(path, 'utf8'));
    expect(document.mcpServers.vorschicht.command).toBe('node');
    expect(document.mcpServers.vorschicht.args).toEqual(['/app/packages/mcp/dist/main.js']);
    expect(document.mcpServers.vorschicht.env.VORSCHICHT_TASK_ID).toBe('task-a');
  });

  it('schreibt kein Geheimnis in die Datei (§19)', async () => {
    const path = await writeMcpRunConfig({
      runsRoot: root,
      runId: 'run-b',
      taskId: 'task-b',
      role: 'reviewer',
      serverEntry: '/app/main.js',
    });
    const raw = await readFile(path, 'utf8');
    // The database URL is inherited from the orchestrator's environment — the
    // CLI merges this env block over the parent's rather than replacing it.
    expect(raw).not.toMatch(/postgres:\/\//);
    expect(raw).not.toMatch(/sk-ant/);
    // And the model token is actively blanked: this process talks to Postgres,
    // never to Anthropic.
    expect(JSON.parse(raw).mcpServers.vorschicht.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('');
  });

  it('gehört nur dem Besitzer', async () => {
    const path = await writeMcpRunConfig({
      runsRoot: root,
      runId: 'run-c',
      taskId: 'task-c',
      role: 'planner',
      serverEntry: '/app/main.js',
    });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it('räumt das Laufverzeichnis auf und beschwert sich nicht über ein fehlendes', async () => {
    await writeMcpRunConfig({
      runsRoot: root,
      runId: 'run-d',
      taskId: 'task-d',
      role: 'db',
      serverEntry: '/app/main.js',
    });
    await removeMcpRunConfig(root, 'run-d');
    await expect(stat(join(root, 'run-d'))).rejects.toThrow();
    // Cleanup runs on the way out of a run that may already have failed. An
    // error here would mask the failure that mattered.
    await expect(removeMcpRunConfig(root, 'run-does-not-exist')).resolves.toBeUndefined();
  });

  it('gibt jedem Lauf ein eigenes Verzeichnis', async () => {
    // Two sessions at once is the default (A7). Sharing one file would mean the
    // second spawn overwrites the first session's task id while it is running.
    expect(mcpConfigPathFor(root, 'run-1')).not.toBe(mcpConfigPathFor(root, 'run-2'));
  });
});
