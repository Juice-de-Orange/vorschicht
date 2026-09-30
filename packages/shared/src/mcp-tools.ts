/**
 * The internal `vorschicht` MCP tool surface (§6.2, §6.4, §13).
 *
 * Names, input contracts and the `--mcp-config` document all live here rather
 * than in `@vorschicht/mcp`, for a dependency reason worth stating once: the MCP
 * package depends on `core` (its server calls the services), and `core` needs
 * this surface to build the per-role `--allowedTools` whitelists and to write
 * the config file a spawn points at. Putting it in the package that implements
 * the server would make that a cycle.
 *
 * The surface having exactly one home is the point. A whitelist that grants
 * `mcp__vorschicht__task_get_context` while the server registers
 * `task.getContext` does not fail loudly — it produces an agent that sits there
 * unable to find out what it was asked to do.
 *
 * Two facts about the CLI's name handling, verified against the pinned version
 * (2.1.220) rather than assumed, because both are silent when wrong:
 *
 *   1. **Dots become underscores in the exposed name, and only there.** A tool
 *      registered as `claims.list` appears to the model as
 *      `mcp__vorschicht__claims_list` — and the `tools/call` that comes back
 *      over JSON-RPC carries the *original* `claims.list`. So the server
 *      registers dotted names and `whitelistNames` does the substitution.
 *   2. **The substitution is not injective.** `task.get_context` and
 *      `task_get_context` collapse onto the same exposed name and one of them
 *      is silently dropped — observed: three registered tools, two visible. The
 *      collision check below is what keeps a future addition from quietly
 *      shadowing an existing tool.
 */
import { z } from 'zod';

/** Tools available to agent sessions. Read-only unless stated otherwise. */
export const MCP_TOOLS = {
  /** Full context for the task the session is working on. */
  'task.get_context': { readOnly: true },
  /** Append a note to the task timeline — the only write an agent may perform. */
  'task.append_note': { readOnly: false },
  /** The task's registered file claims (§10). */
  'claims.list': { readOnly: true },
  /** Raise an inbox item and end the turn with `needs_decision` (§6.4). */
  'escalate.ask': { readOnly: false },
  /** Report a gate finding (§11). Findings are always blockers. */
  'finding.report': { readOnly: false },
  /** Search the document vault (§13). */
  'docs.search': { readOnly: true },
  /** Fetch one vault document (§13). */
  'docs.get': { readOnly: true },
} as const;

export type McpToolName = keyof typeof MCP_TOOLS;

export const MCP_TOOL_NAMES = Object.keys(MCP_TOOLS) as McpToolName[];

export const MCP_SERVER_NAME = 'vorschicht';

/**
 * Fully-qualified tool names as they appear in a `--allowedTools` whitelist.
 *
 * The transformation is the CLI's, not ours. Written once here so that no call
 * site has to remember it — and guarded by `assertNoWhitelistCollision`, since
 * the transformation loses information.
 */
export function whitelistNames(tools: readonly McpToolName[]): string[] {
  return tools.map(whitelistName);
}

export function whitelistName(tool: McpToolName): string {
  return `mcp__${MCP_SERVER_NAME}__${tool.replaceAll('.', '_')}`;
}

/**
 * Two tools must never share an exposed name.
 *
 * Called at module load, so adding `task_get_context` beside
 * `task.get_context` fails the import rather than shadowing it at 3am on a
 * server nobody is watching.
 */
export function assertNoWhitelistCollision(names: readonly McpToolName[] = MCP_TOOL_NAMES): void {
  const seen = new Map<string, McpToolName>();
  for (const tool of names) {
    const exposed = whitelistName(tool);
    const other = seen.get(exposed);
    if (other) {
      throw new Error(
        `MCP-Werkzeuge "${other}" und "${tool}" ergeben denselben sichtbaren Namen ` +
          `"${exposed}". Die CLI ersetzt Punkte durch Unterstriche und verwirft dabei ` +
          'eines der beiden stillschweigend.',
      );
    }
    seen.set(exposed, tool);
  }
}

assertNoWhitelistCollision();

// --- input contracts ---------------------------------------------------------
//
// Zod at the boundary (A4), and the boundary is a model. Two consequences shape
// these schemas: the messages have to read as instructions rather than as type
// errors, because the agent is the one who has to fix the call; and every limit
// is enforced here rather than trusted to the prompt, because a prompt is a
// request and this is the write path.

/** How long a single note may be. Long enough for a handover, short enough to read. */
export const MAX_NOTE_LENGTH = 8_000;

/** §15: "2–4 researched options", not one and not seven. */
export const ESCALATION_OPTION_RANGE = { min: 2, max: 4 } as const;

const relativePath = z
  .string()
  .min(1)
  .refine((p) => !p.startsWith('/'), {
    message: 'Pfad muss repository-relativ sein, nicht absolut',
  })
  .refine((p) => !p.split('/').includes('..'), {
    message: 'Pfad darf nicht aus dem Repository herausführen',
  });

export const taskGetContextInput = z.object({});

export const taskAppendNoteInput = z.object({
  text: z
    .string()
    .min(1, 'Eine leere Notiz sagt der nächsten Sitzung nichts')
    .max(MAX_NOTE_LENGTH, `Notiz überschreitet ${MAX_NOTE_LENGTH} Zeichen`),
});

export const claimsListInput = z.object({});

/**
 * One prepared option (§15).
 *
 * Pros *and* cons are both required, and that is not pedantry: an option
 * presented without a downside is a recommendation wearing an option's clothes,
 * and the whole point of the format is that the operator sees the trade-off rather than
 * the agent's preference dressed up as a choice.
 */
export const escalationOptionInput = z.object({
  title: z.string().min(1),
  pros: z.array(z.string().min(1)).min(1, 'Jede Option braucht mindestens einen Vorteil'),
  cons: z.array(z.string().min(1)).min(1, 'Jede Option braucht mindestens einen Nachteil'),
  recommended: z.boolean().default(false),
});

export const escalateAskInput = z
  .object({
    /**
     * The decision itself, in one sentence. German (§2).
     *
     * The cap is structural as well as editorial: the normalised question is
     * §15's precedent key and is stored in an indexed column, so an unbounded
     * question would turn a well-formed escalation into a database error at the
     * moment it is raised. `MAX_ESCALATION_QUESTION_LENGTH` in `escalation.ts`
     * is the same number and a test holds them equal — this schema is what an
     * agent sees, that one is what the service enforces, and a question this
     * side accepted and that side refused would be rejected *after* the model
     * had already spent the turn composing it.
     */
    question: z.string().min(1).max(500),
    /** §15: 3–5 sentences — what is happening, why it is blocked. German. */
    context: z.string().min(1).max(4_000),
    urgency: z.enum(['P0', 'P1', 'P2', 'P3']).default('P2'),
    options: z
      .array(escalationOptionInput)
      .min(ESCALATION_OPTION_RANGE.min)
      .max(ESCALATION_OPTION_RANGE.max),
  })
  .refine((value) => value.options.filter((o) => o.recommended).length === 1, {
    message:
      'Genau eine Option muss als Empfehlung markiert sein (§15) — ohne Empfehlung ' +
      'ist es eine Frage, mit mehreren ist es keine.',
    path: ['options'],
  });

export const findingReportInput = z.object({
  file: relativePath,
  line: z.number().int().positive().optional(),
  /** One sentence naming the defect. */
  summary: z.string().min(1),
  /** The concrete failure: inputs or state, and what goes wrong. */
  detail: z.string().optional(),
});

export const docsSearchInput = z.object({
  query: z.string().min(1),
  limit: z.number().int().positive().max(20).default(5),
});

/**
 * A vault id is a uuid, and saying so here is what keeps the refusal readable.
 *
 * `documents.id` is a uuid column, so anything else reaches Postgres and comes
 * back as `invalid input syntax for type uuid` — a database error quoted at a
 * model that has no way to act on it. Refused at the boundary instead, with a
 * sentence that says where an id comes from. Same posture as `relativePath`
 * above: the limit lives where the call is checked, not in the prompt.
 */
export const docsGetInput = z.object({
  id: z.uuid('Eine Dokument-Id ist eine UUID und stammt aus docs.search'),
});

export type TaskAppendNoteInput = z.infer<typeof taskAppendNoteInput>;
export type EscalateAskInput = z.infer<typeof escalateAskInput>;
export type EscalationOption = z.infer<typeof escalationOptionInput>;
export type FindingReportInput = z.infer<typeof findingReportInput>;
export type DocsSearchInput = z.infer<typeof docsSearchInput>;
export type DocsGetInput = z.infer<typeof docsGetInput>;

/**
 * What the model reads before deciding whether to call a tool.
 *
 * English, per §2 — agents work internally in English; only what they address
 * to the operator is German. Each description states the constraint the schema enforces,
 * so that a refusal is a reminder rather than a discovery.
 */
export const MCP_TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
  'task.get_context':
    'Everything known about the task you are working on: its title, description ' +
    'and acceptance criteria, its state and history, the worktree and branch you ' +
    'are in, the file claims registered for it, any findings reported against it, ' +
    'and the notes previous sessions left. Takes no arguments — a session serves ' +
    'exactly one task and cannot read another. Call this first.',
  'task.append_note':
    'Append a note to the task timeline. This is the only thing you can write ' +
    'outside your worktree, and it is read by whoever picks the task up next — ' +
    'so record decisions, handovers and anything you learned that is not obvious ' +
    'from the diff. It does not change the task state.',
  'claims.list':
    'The file claims registered for this task (§10): the path globs you may ' +
    'write inside, and their status. Writes outside them are refused before the ' +
    'tool runs. As a reviewer, this is the set every changed path must fall in.',
  'escalate.ask':
    'Put a decision to the operator. Requires the context, and 2 to 4 researched options ' +
    'with pros and cons, exactly one of them marked as your recommendation — all ' +
    'written in German. Prior decisions are searched for you: if the operator has already ' +
    'answered this exact question the tool returns his answer instead of asking ' +
    'him again, and you carry on with the task, citing the decision number. ' +
    'Otherwise an inbox item is created — then end your turn with status ' +
    '`needs_decision`: the task parks with its claims held and this same session ' +
    'is resumed with his answer. Read the `next` field of the response; it says ' +
    'which of the two happened.',
  'finding.report':
    'Report a defect. Every finding is a blocker in this system — there is no ' +
    'severity below it and no warning mode — so report defects, not preferences. ' +
    'Name the file, a line where you can, and what specifically is wrong.',
  'docs.search':
    'Full-text search over the document vault (§13) — Statuten, contracts, ' +
    'AVVs, conventions, anything uploaded for the studio to work from. It ' +
    'searches the whole vault whatever department you belong to; documents ' +
    'tagged for your department are merely ranked higher, and every hit says ' +
    'which of the two it was. Read `pendingDocuments` before you conclude that ' +
    'something is not in the vault: it counts documents nobody has extracted ' +
    'text from yet, and those cannot match any query. Search first, then fetch ' +
    'by id with docs.get.',
  'docs.get':
    'Fetch one vault document (§13) by the id docs.search gave you — ids are ' +
    'uuids and are not to be constructed. Returns the metadata, every version ' +
    'with its upload details, and the text of the most recent version that has ' +
    'been read. Long text is truncated and the response says so; quote it as a ' +
    'truncated document rather than as the whole one.',
};

// --- did the session actually get its tools? ---------------------------------

/** What `assessSessionTools` decided. `ok: false` means: do not use this run. */
export type SessionToolVerdict = { ok: true } | { ok: false; problem: string };

/**
 * Did this session start with the MCP tools it was granted?
 *
 * Verified against the pinned CLI with a deliberately slow server: an MCP
 * server still `pending` at `system:init` does not catch up. The first turn has
 * none of its tools, the model reports that it cannot call them, and the run
 * ends having spent a turn and produced nothing. `connected` is the only status
 * that means the session is usable.
 *
 * The right response is a retry, not a red task (§11, A25): nothing about the
 * work was wrong. That decision belongs to the runner; this function only
 * supplies the verdict — and it fails closed, because a session running blind
 * is more expensive than one that starts twice.
 */
export function assessSessionTools(
  event: { mcpServers: Array<{ name: string; status: string }>; tools: string[] },
  expected: readonly McpToolName[],
): SessionToolVerdict {
  if (expected.length === 0) return { ok: true };

  const server = event.mcpServers.find((s) => s.name === MCP_SERVER_NAME);
  if (!server) {
    return {
      ok: false,
      problem:
        `Der MCP-Server "${MCP_SERVER_NAME}" taucht in der Sitzung nicht auf. ` +
        'Ohne ihn kann die Rolle ihre Aufgabe nicht einmal nachlesen.',
    };
  }
  if (server.status !== 'connected') {
    return {
      ok: false,
      problem:
        `Der MCP-Server meldete beim Start "${server.status}" statt "connected". ` +
        'Eine Sitzung, die so beginnt, hat keines ihrer Werkzeuge — sie holt das ' +
        'nicht nach, sondern meldet, dass sie nichts tun kann.',
    };
  }

  const available = new Set(event.tools);
  const missing = expected.map(whitelistName).filter((name) => !available.has(name));
  if (missing.length > 0) {
    return {
      ok: false,
      problem: `Der Sitzung fehlen zugesagte Werkzeuge: ${missing.join(', ')}.`,
    };
  }
  return { ok: true };
}

// --- the --mcp-config document ----------------------------------------------

export interface McpServerConfigInput {
  /** Interpreter or binary, e.g. `node`. */
  command: string;
  /** Arguments — the server entry point, typically. */
  args: readonly string[];
  /** The one task this session serves. */
  taskId: string;
  /** The `agent_runs` row this session belongs to. */
  runId: string;
  /** Profile id, recorded as the actor on everything the session writes. */
  role: string;
}

/**
 * The document `--mcp-config` points at (§6.2).
 *
 * Three properties of the CLI's spawn behaviour were verified on the pinned
 * version and are load-bearing here:
 *
 *   * The child's environment is the orchestrator's **merged with** this `env`
 *     block, so `DATABASE_URL` arrives by inheritance. It is deliberately not
 *     written into this file: the file sits on disk with no access control
 *     worth the name, and §19 keeps credentials out of anything an agent could
 *     read. Only the task-scoped, non-secret values are written.
 *   * `${VAR}` in a value is expanded from the parent environment. Not used —
 *     recorded so nobody re-derives it.
 *   * An empty string blanks an inherited variable for the child. That is why
 *     `CLAUDE_CODE_OAUTH_TOKEN` is cleared: the MCP server talks to Postgres,
 *     never to Anthropic, and a process that cannot spend the subscription is
 *     one fewer place a mistake can spend it.
 */
export function buildMcpServerConfig(input: McpServerConfigInput): {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
} {
  return {
    mcpServers: {
      [MCP_SERVER_NAME]: {
        command: input.command,
        args: [...input.args],
        env: {
          VORSCHICHT_TASK_ID: input.taskId,
          VORSCHICHT_RUN_ID: input.runId,
          VORSCHICHT_ROLE: input.role,
          CLAUDE_CODE_OAUTH_TOKEN: '',
        },
      },
    },
  };
}
