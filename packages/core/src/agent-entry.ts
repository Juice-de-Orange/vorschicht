/**
 * The slice of `core` an agent session needs — and nothing else.
 *
 * Same reasoning as `@vorschicht/db/sql`, and the same measurement behind it.
 * The MCP server (§6.2) is spawned per session and races the CLI's `system:init`
 * by roughly 400 ms; a server that misses it leaves the agent's first turn
 * without its tools. Importing the `@vorschicht/core` barrel costs ~175 ms
 * because it pulls the job queue, the model backends and the git helpers, none
 * of which an MCP server has any business loading — it reads and writes task
 * events, and that is all.
 *
 * So this module is the entry point that process imports. It is not a second
 * public API: every symbol here is also exported from the barrel, and this file
 * adds none of its own.
 *
 * The two §13 additions were measured before they were made, because that is
 * the whole point of this file: `profiles` costs 4–5 ms (it is prompt strings
 * and a table, and its only import is `@vorschicht/shared`, which the server
 * already loads) and `vault/documents.js` costs 0.7 ms (its only import is a
 * `type`, so nothing of it survives compilation). Against a handshake measured
 * at 144–178 ms and a budget of ~400 ms, both are affordable; the barrel, at
 * ~175 ms, still is not.
 */
export { AgentChannel, AgentChannelError, type AgentTaskContext } from './agent-channel.js';
export { ClaimRegistry } from './claim-registry.js';
export { EscalationService } from './escalation-service.js';
export { EventLog } from './event-log.js';
/** §13's ranking asks which department is searching; §8's labels live here. */
export { AGENT_PROFILES } from './profiles/index.js';
export { ProjectService } from './project-service.js';
export { TaskService } from './task-service.js';
export { DocumentVault } from './vault/documents.js';
