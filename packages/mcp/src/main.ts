/**
 * Entry point for one session's MCP server (§6.2).
 *
 * The CLI spawns this from the `--mcp-config` document the runner writes. Its
 * whole job is: read who it serves, open a database connection, build the
 * channel, and speak stdio.
 *
 * Two properties matter more than the code does.
 *
 * **Nothing here is on stdout except protocol.** stdio transport means stdout
 * *is* the wire: one stray `console.log` corrupts a JSON-RPC frame and the CLI
 * reports the server as failed, with no indication of why. Diagnostics go to
 * stderr, which the CLI collects and which ends up in the run's log.
 *
 * **The identity comes from the environment, never from the caller.** The task
 * id arrives in `VORSCHICHT_TASK_ID`, set by the runner in the config document;
 * the agent has no way to influence it, because the config file is written
 * before the session starts and outside the worktree. `DATABASE_URL` is
 * inherited from the orchestrator rather than written into that file (§19: the
 * file has no access control worth the name), and the OAuth token is blanked in
 * it — this process talks to Postgres, never to Anthropic.
 */

import {
  AgentChannel,
  ClaimRegistry,
  DocumentVault,
  EscalationService,
  EventLog,
  ProjectService,
  TaskService,
} from '@vorschicht/core/agent';
import { createSql } from '@vorschicht/db/sql';
import { createVorschichtServer } from './server.js';

function require_(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} fehlt. Der MCP-Server wird pro Sitzung gestartet und bekommt seine ` +
        'Identität aus der --mcp-config des Laufs (§6.2).',
    );
  }
  return value;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Both ids are uuid columns, so a malformed one is a database error.
 *
 * Checked at startup rather than left to the first write, because that first
 * write is a session reporting a finding or raising an escalation — the two
 * moments where a failure costs the most and explains the least. Failing here
 * shows up as an MCP server that would not start, which is a sentence in the
 * run log; failing there shows up as a reviewer whose blocker vanished.
 */
function requireId(name: string): string {
  const value = require_(name);
  if (!UUID.test(value)) {
    throw new Error(`${name} ist keine UUID: "${value}".`);
  }
  return value;
}

export function main(): void {
  const databaseUrl = require_('DATABASE_URL');
  const taskId = requireId('VORSCHICHT_TASK_ID');
  const runId = requireId('VORSCHICHT_RUN_ID');
  const role = require_('VORSCHICHT_ROLE');

  // One session, a handful of tool calls: two connections is plenty, and a
  // large pool per session would multiply by the concurrency (A7) against a
  // database the orchestrator and the app also use.
  const sql = createSql({ url: databaseUrl, max: 2 });
  const eventLog = new EventLog(sql);
  const tasks = new TaskService({ sql, eventLog });
  const projects = new ProjectService(sql);
  const claims = new ClaimRegistry({ sql, tasks, projects, eventLog });
  // §15's inbox and its policy memory. The channel searches it before raising
  // anything, so a question the operator has already answered is answered from memory
  // rather than asked twice (§15, `AgentChannel.requestEscalation`).
  const escalations = new EscalationService({ sql, eventLog });
  const channel = new AgentChannel(
    { sql, tasks, projects, claims, eventLog, escalations },
    taskId,
    role,
    runId,
  );
  // §13's vault. Unlike everything above it is not scoped to the task: every
  // department may read all of it, and the role only decides what ranks first
  // (`askingDepartment`).
  const vault = new DocumentVault(sql);

  const server = createVorschichtServer({ channel, vault, role });
  server.listen(process.stdin, process.stdout);

  const shutdown = async () => {
    server.close();
    await sql.end({ timeout: 5 });
  };
  // The CLI ends a session by closing stdin and then signalling the group
  // (§6.2, A32). Closing the pool explicitly keeps a hard-stopped run from
  // leaving connections behind, which at concurrency 2 across a long night is
  // the difference between a tidy database and one that refuses new sessions.
  process.on('SIGTERM', () => void shutdown().then(() => process.exit(0)));
  process.on('SIGINT', () => void shutdown().then(() => process.exit(0)));
}

// Synchronous by design: the whole point of this process is to answer the CLI's
// `initialize` before it emits `system:init` (see `protocol.ts`), and every
// awaited step before `listen` is time spent losing that race. Connecting to
// Postgres is lazy in postgres.js, so nothing here needs to be awaited.
try {
  main();
} catch (error) {
  process.stderr.write(`vorschicht-mcp: ${(error as Error).message}\n`);
  process.exit(1);
}
