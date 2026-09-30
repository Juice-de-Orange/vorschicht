/**
 * Internal "vorschicht" MCP stdio server (§3, §13).
 *
 * The server lives in `server.ts`; `main.ts` is the entry point the CLI spawns
 * per session. The tool *names*, their input contracts and the `--mcp-config`
 * document live in `@vorschicht/shared`: this package depends on
 * `@vorschicht/core` (the server calls the services), and `core` needs that
 * surface to build the per-role `--allowedTools` whitelists of §6.2 and to
 * write the config file a spawn points at. Keeping them here would have made
 * that a dependency cycle.
 *
 * They are re-exported so that this package still reads as the owner of its own
 * surface.
 */
export {
  buildMcpServerConfig,
  MCP_SERVER_NAME,
  MCP_TOOL_DESCRIPTIONS,
  MCP_TOOL_NAMES,
  MCP_TOOLS,
  type McpToolName,
  whitelistName,
  whitelistNames,
} from '@vorschicht/shared';
export {
  type AnyToolDefinition,
  LATEST_PROTOCOL_VERSION,
  McpStdioServer,
  negotiateVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
  type ToolDefinition,
  type ToolResult,
  toolError,
  toolOk,
} from './protocol.js';
export {
  askingDepartment,
  buildTools,
  createVorschichtServer,
  MAX_DOCUMENT_TEXT_CHARS,
  MCP_SERVER_VERSION,
  SERVER_TOOL_NAMES,
  type VorschichtServerDeps,
} from './server.js';
