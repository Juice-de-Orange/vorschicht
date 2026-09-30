#!/usr/bin/env node
/**
 * Does the pinned CLI actually load our MCP server and see all seven tools?
 *
 * This is the one link in the chain that neither unit nor integration tests can
 * reach. `server.itest.ts` drives the real protocol with a real client, and
 * `mcp-tools.test.ts` checks the name substitution — but between them sits the
 * CLI: it reads the `--mcp-config` document, spawns the process, performs the
 * handshake, and renames every tool. Each of those steps fails *silently*. A
 * server that will not start is reported as `status: "failed"` in one line of a
 * stream nobody reads; a tool whose exposed name collides simply disappears.
 * The result either way is an agent that sits there unable to do its job while
 * burning turns finding out.
 *
 * It costs nothing. The `system:init` message carries the tool list and the
 * server status, and it arrives *before* the model is consulted — so the check
 * spawns a session, reads one line, and kills it. No tokens, no turn.
 *
 * What it deliberately does not do is call a tool: that needs a model turn, and
 * the tool handlers are already covered against a real database and a real
 * client in `server.itest.ts`.
 *
 * Usage:  node infra/scripts/check-mcp-handshake.mjs
 * Exit:   0 = handshake good · 1 = finding · 2 = infra failure (A25)
 */
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exit } from 'node:process';
import { createInterface } from 'node:readline';

const CLI = process.env.VORSCHICHT_CLAUDE_BIN ?? 'claude';
const ENTRY = resolve(process.env.VORSCHICHT_MCP_SERVER ?? 'packages/mcp/dist/main.js');
const SERVER_NAME = 'vorschicht';
const TIMEOUT_MS = 90_000;

/** The seven tools of §6.2/§13, as the CLI exposes them. Written out by hand. */
const EXPECTED = [
  'mcp__vorschicht__claims_list',
  'mcp__vorschicht__docs_get',
  'mcp__vorschicht__docs_search',
  'mcp__vorschicht__escalate_ask',
  'mcp__vorschicht__finding_report',
  'mcp__vorschicht__task_append_note',
  'mcp__vorschicht__task_get_context',
];

function infra(message) {
  console.error(`check-mcp-handshake — ${message} (Infra-Fehler, kein Finding).`);
  exit(2);
}

if (spawnSync(CLI, ['--version'], { encoding: 'utf8' }).status !== 0) {
  infra(`${CLI} nicht ausführbar`);
}
if (!existsSync(ENTRY)) {
  infra(`${ENTRY} fehlt — erst \`pnpm gate:build\` laufen lassen`);
}

const dir = mkdtempSync(join(tmpdir(), 'vorschicht-handshake-'));
const configPath = join(dir, 'mcp.json');

// The same document `buildMcpServerConfig` produces. Written out here rather
// than imported so the check exercises the shape the CLI is given, not the
// function that happens to build it.
writeFileSync(
  configPath,
  JSON.stringify(
    {
      mcpServers: {
        [SERVER_NAME]: {
          command: 'node',
          args: [ENTRY],
          env: {
            VORSCHICHT_TASK_ID: randomUUID(),
            VORSCHICHT_RUN_ID: randomUUID(),
            VORSCHICHT_ROLE: 'coder',
            CLAUDE_CODE_OAUTH_TOKEN: '',
          },
        },
      },
    },
    null,
    2,
  ),
);

// The server connects to Postgres lazily, so the handshake needs a URL that
// parses, not a database that answers. Every tool call is covered elsewhere.
const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL ?? 'postgres://handshake@127.0.0.1:5432/handshake',
};

const child = spawn(
  CLI,
  [
    '-p',
    '--input-format',
    'stream-json',
    '--output-format',
    'stream-json',
    '--verbose',
    '--setting-sources',
    '',
    '--mcp-config',
    configPath,
    '--strict-mcp-config',
    '--allowedTools',
    EXPECTED.join(','),
    '--permission-mode',
    'acceptEdits',
    '--max-turns',
    '1',
    '--model',
    'haiku',
  ],
  { cwd: dir, env, stdio: ['pipe', 'pipe', 'pipe'] },
);

let settled = false;
const stderr = [];
child.stderr.on('data', (chunk) => stderr.push(String(chunk)));

// The CLI emits nothing until it has been given something to do — `system:init`
// does not arrive on startup alone. So a minimal user message goes in, and the
// check kills the process the moment init comes back. init is emitted before
// the model is consulted, which is what keeps this free: the prompt below is
// never answered and, on every observed run, never sent.
child.stdin.write(
  `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'handshake' }] },
  })}\n`,
);

function finish(code, message) {
  if (settled) return;
  settled = true;
  // SIGKILL rather than a graceful stop: the session has not been asked to do
  // anything and there is nothing to wind down. Killing before the model is
  // consulted is what makes this check free.
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
  rmSync(dir, { recursive: true, force: true });
  if (message) console.error(message);
  exit(code);
}

const timer = setTimeout(
  () =>
    finish(
      2,
      `check-mcp-handshake — keine init-Nachricht innerhalb von ${TIMEOUT_MS / 1000}s.` +
        `${stderr.length ? `\n${stderr.join('').slice(0, 800)}` : ''}`,
    ),
  TIMEOUT_MS,
);
timer.unref();

createInterface({ input: child.stdout }).on('line', (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.type !== 'system' || message.subtype !== 'init') return;
  clearTimeout(timer);

  const server = (message.mcp_servers ?? []).find((s) => s.name === SERVER_NAME);
  if (!server) {
    finish(1, `check-mcp-handshake — Server "${SERVER_NAME}" taucht gar nicht auf.`);
    return;
  }
  if (server.status !== 'connected') {
    finish(
      1,
      `check-mcp-handshake — Server "${SERVER_NAME}" meldet "${server.status}" statt ` +
        `"connected".${stderr.length ? `\n${stderr.join('').slice(0, 800)}` : ''}`,
    );
    return;
  }

  const seen = (message.tools ?? []).filter((t) => String(t).startsWith('mcp__')).sort();
  const missing = EXPECTED.filter((t) => !seen.includes(t));
  const extra = seen.filter((t) => !EXPECTED.includes(t));
  if (missing.length > 0 || extra.length > 0) {
    finish(
      1,
      'check-mcp-handshake — die sichtbaren Werkzeuge stimmen nicht:\n' +
        `  fehlend: ${missing.join(', ') || '—'}\n` +
        `  zusätzlich: ${extra.join(', ') || '—'}`,
    );
    return;
  }

  console.log(`  ✓ MCP-Server verbunden, ${seen.length} Werkzeuge sichtbar`);
  for (const tool of seen) console.log(`      ${tool}`);
  finish(0);
});

child.on('error', (error) => finish(2, `check-mcp-handshake — ${error.message}`));
child.on('exit', (code) =>
  finish(
    2,
    `check-mcp-handshake — CLI beendet (Code ${code}), bevor eine init-Nachricht kam.` +
      `${stderr.length ? `\n${stderr.join('').slice(0, 800)}` : ''}`,
  ),
);
