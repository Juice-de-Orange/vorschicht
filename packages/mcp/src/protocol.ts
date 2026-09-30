/**
 * A minimal MCP server over stdio: JSON-RPC 2.0, three methods, no framework.
 *
 * The official SDK was used first and then deliberately replaced here, for one
 * measured reason. This process is spawned by the Claude Code CLI **per
 * session**, and it races the CLI's own startup: the CLI emits `system:init`
 * roughly 400 ms after it spawns the server, and whatever is not connected by
 * then is reported `pending` — which means the agent's first turn has none of
 * its tools. Importing `@modelcontextprotocol/sdk/server` costs ~320 ms on its
 * own, against a node boot of ~50 ms, so the handshake landed at ~450 ms and
 * lost that race about half the time. Measured, not estimated:
 *
 *   * SDK server core, import alone: 317 ms
 *   * spawn → `initialize` answered, with the SDK: 424–494 ms
 *   * CLI spawn → CLI `init`: ~400 ms
 *
 * A session that starts without `task.get_context` cannot find out what it was
 * asked to do. Observed on the pinned CLI: it says so and stops, having spent a
 * turn. Half of all sessions is not a rate this system can carry.
 *
 * What the SDK was giving us — protocol conformance — is kept, and kept more
 * directly: `server.itest.ts` drives this server with the **vendor's own
 * `Client`**, which validates every response against the vendor's schemas. The
 * SDK is therefore a devDependency, exercising the wire from the other side,
 * rather than a runtime dependency in the hot path. That is a better test than
 * using the SDK on both ends, where a shared misunderstanding cancels out.
 *
 * Scope is deliberately exactly what the CLI uses: `initialize`, `tools/list`,
 * `tools/call`, `ping`, and notifications that need no answer. Resources,
 * prompts, sampling, completion and roots are not implemented, and an unknown
 * method gets a proper `-32601` rather than silence.
 */
import type { Interface } from 'node:readline';
import { createInterface } from 'node:readline';
import { z } from 'zod';

/** Protocol revisions this server is known to work with. Newest first. */
export const SUPPORTED_PROTOCOL_VERSIONS = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
] as const;

export const LATEST_PROTOCOL_VERSION = SUPPORTED_PROTOCOL_VERSIONS[0];

/** What a tool handler returns; the shape MCP defines for `tools/call`. */
export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

// biome-ignore lint/suspicious/noExplicitAny: a tool table holds heterogeneous schemas
export type AnyToolDefinition = ToolDefinition<any>;

export interface ToolDefinition<S extends z.ZodType> {
  name: string;
  title: string;
  description: string;
  input: S;
  /** Advertised as `annotations.readOnlyHint`. */
  readOnly?: boolean;
  handle: (input: z.output<S>) => Promise<ToolResult> | ToolResult;
}

export interface ServerInfo {
  name: string;
  version: string;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

const METHOD_NOT_FOUND = -32601;
const INVALID_REQUEST = -32600;
const PARSE_ERROR = -32700;
const INTERNAL_ERROR = -32603;

/**
 * Negotiate the protocol revision.
 *
 * The specification is explicit: answer with the requested version when it is
 * supported, otherwise with one this server does support and let the client
 * decide. Echoing an unrecognised future version would be a claim we cannot
 * back — this surface has been verified against the versions listed above and
 * nothing else.
 */
export function negotiateVersion(requested: unknown): string {
  const wanted = typeof requested === 'string' ? requested : '';
  return (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(wanted)
    ? wanted
    : LATEST_PROTOCOL_VERSION;
}

/** The `inputSchema` a client sees. draft-07, like the result contracts (A47). */
export function toolInputSchema(tool: AnyToolDefinition): Record<string, unknown> {
  return z.toJSONSchema(tool.input, { io: 'input', target: 'draft-7' }) as Record<string, unknown>;
}

export class McpStdioServer {
  private readonly tools = new Map<string, AnyToolDefinition>();
  private reader: Interface | null = null;

  constructor(
    private readonly info: ServerInfo,
    tools: readonly AnyToolDefinition[],
  ) {
    for (const tool of tools) {
      if (this.tools.has(tool.name)) {
        throw new Error(`MCP-Werkzeug "${tool.name}" ist doppelt registriert.`);
      }
      this.tools.set(tool.name, tool);
    }
  }

  toolNames(): string[] {
    return [...this.tools.keys()];
  }

  /**
   * Answer one message, or `null` when none is owed.
   *
   * Pure with respect to the transport, which is what makes the protocol
   * testable without a pipe — and what keeps `listen` down to plumbing.
   */
  async handle(message: JsonRpcRequest): Promise<JsonRpcResponse | null> {
    const id = message.id ?? null;
    // A notification carries no id and gets no answer, ever — replying to one
    // is a protocol violation that clients report as an unexpected response.
    const isNotification = message.id === undefined || message.id === null;

    if (message.jsonrpc !== '2.0') {
      return isNotification ? null : error(id, INVALID_REQUEST, 'jsonrpc muss "2.0" sein');
    }

    switch (message.method) {
      case 'initialize':
        return result(id, {
          protocolVersion: negotiateVersion(message.params?.protocolVersion),
          capabilities: { tools: { listChanged: false } },
          serverInfo: this.info,
        });

      case 'ping':
        return result(id, {});

      case 'tools/list':
        return result(id, {
          tools: [...this.tools.values()].map((tool) => ({
            name: tool.name,
            title: tool.title,
            description: tool.description,
            inputSchema: toolInputSchema(tool),
            ...(tool.readOnly ? { annotations: { readOnlyHint: true } } : {}),
          })),
        });

      case 'tools/call':
        return result(id, await this.call(message.params ?? {}));

      default:
        if (isNotification) return null;
        return error(id, METHOD_NOT_FOUND, `Methode "${message.method}" gibt es hier nicht`);
    }
  }

  /**
   * Run one tool.
   *
   * Every failure below comes back as a *tool* error rather than a JSON-RPC
   * fault, and that distinction is the whole point: a JSON-RPC error reads to
   * the model as "this tool is broken" and it routes around; `isError: true`
   * with a sentence reads as "fix the call". Improvising around a broken tool
   * is the one behaviour this studio does not want.
   */
  private async call(params: Record<string, unknown>): Promise<ToolResult> {
    const name = String(params.name ?? '');
    const tool = this.tools.get(name);
    if (!tool) {
      return toolError(`No tool named "${name}". Available: ${this.toolNames().join(', ')}.`);
    }

    const parsed = tool.input.safeParse(params.arguments ?? {});
    if (!parsed.success) {
      const problems = (parsed.error as z.ZodError).issues
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; ');
      return toolError(`Invalid arguments for ${name} — ${problems}`);
    }

    try {
      return await tool.handle(parsed.data);
    } catch (cause) {
      return toolError((cause as Error).message);
    }
  }

  /**
   * Speak the protocol on a pipe.
   *
   * Nothing else may be written to `output`: stdout *is* the wire, and a single
   * stray line corrupts a frame, after which the CLI reports the server as
   * failed with no indication of why.
   */
  listen(input: NodeJS.ReadableStream, output: NodeJS.WritableStream): void {
    this.reader = createInterface({ input });
    this.reader.on('line', (line) => {
      if (!line.trim()) return;
      let message: JsonRpcRequest;
      try {
        message = JSON.parse(line);
      } catch {
        output.write(`${JSON.stringify(error(null, PARSE_ERROR, 'Kein gültiges JSON'))}\n`);
        return;
      }
      // Handlers are async and answers are id-matched, so completing out of
      // order is correct JSON-RPC and no queue is needed.
      void this.handle(message)
        .then((response) => {
          if (response) output.write(`${JSON.stringify(response)}\n`);
        })
        .catch((cause: unknown) => {
          const id = message.id ?? null;
          if (id === null) return;
          output.write(`${JSON.stringify(error(id, INTERNAL_ERROR, (cause as Error).message))}\n`);
        });
    });
  }

  close(): void {
    this.reader?.close();
    this.reader = null;
  }
}

function result(id: string | number | null, value: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id, result: value };
}

function error(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

export function toolError(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

export function toolOk(payload: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}
