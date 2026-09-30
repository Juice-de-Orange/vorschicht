/**
 * The internal `vorschicht` MCP server (§3, §6.2, §22 Phase 2 step 3).
 *
 * One process per agent session, spawned by the Claude Code CLI from the
 * `--mcp-config` document the runner writes. It is a tool table and nothing
 * else: every handler is one call into `AgentChannel`, which is where the rules
 * live and which is bound to a single task (see its header). The wire is
 * `protocol.ts`; why that is hand-rolled rather than the vendor SDK is
 * documented there, in measurements.
 *
 * Three decisions are visible in the shape of this file.
 *
 * **All seven tools are registered, always.** `--allowedTools` decides which
 * ones a given role may call — that is the CLI's job and it does it per role.
 * Registering a role-dependent subset here would put the whitelist in two
 * places, and the failure mode of the two disagreeing is an agent that silently
 * cannot see a tool it was granted.
 *
 * **Tools answer with JSON as text, and the same object as structured content.**
 * The CLI puts the text into the model's context; the structured form is what
 * anything reading the transcript afterwards can rely on.
 *
 * **Failures come back as tool errors, never as JSON-RPC faults.** See
 * `McpStdioServer.call` — the difference is whether the model fixes its call or
 * decides the tool is broken and improvises around it.
 */
import { AGENT_PROFILES, type AgentChannel, type DocumentVault } from '@vorschicht/core/agent';
import {
  claimsListInput,
  docsGetInput,
  docsSearchInput,
  escalateAskInput,
  findingReportInput,
  MCP_SERVER_NAME,
  MCP_TOOL_DESCRIPTIONS,
  type McpToolName,
  taskAppendNoteInput,
  taskGetContextInput,
} from '@vorschicht/shared';
import { type AnyToolDefinition, McpStdioServer, toolOk } from './protocol.js';

export const MCP_SERVER_VERSION = '1.0.0';

export interface VorschichtServerDeps {
  channel: AgentChannel;
  /** §13's vault. Required: a session with a database has one. */
  vault: DocumentVault;
  /**
   * The profile id this session was spawned under (`VORSCHICHT_ROLE`).
   *
   * Not the department: the department is *derived* from it here, so that the
   * one place §8's labels live is the profile table (`askingDepartment`).
   */
  role: string;
}

/**
 * How much document text one `docs.get` may hand a session (§13).
 *
 * A53.6 capped assistant prose at 8 KB per message because the event log is
 * kept forever; this text never reaches the event log, so that argument does
 * not carry over and a different one has to. Two costs are real. The text goes
 * into the model's context, where an unbounded contract crowds out the work it
 * was fetched for; and it is copied verbatim into the session transcript, which
 * A15 keeps for a year and §6.6 scans nightly — so every call writes the whole
 * document to disk a second time.
 *
 * 20 000 characters is roughly ten pages: enough that §13's named corpus —
 * Vereinsstatuten, an AVV, a set of conventions — arrives whole, and small
 * enough that a scanned 2 MB contract cannot fill a session in one call.
 *
 * Truncation is reported rather than silent, which is the half that matters:
 * a session that does not know it read part of a document will cite that part
 * as though it were the document.
 */
export const MAX_DOCUMENT_TEXT_CHARS = 20_000;

/**
 * Which department is asking (§13's ranking), derived from the session's role.
 *
 * `VORSCHICHT_ROLE` is the profile id the runner spawned this session under and
 * §8's German department label hangs off that profile, so the answer is read out
 * of the profile table rather than out of a second environment variable. One
 * source on purpose: a second channel for the same fact is a second place it can
 * be wrong, and it would be wrong *silently* here — as a ranking nobody can see
 * is off.
 *
 * An unrecognised role answers `null` instead of throwing, and the direction is
 * deliberate. This decides a sort order, not an access: without it every search
 * still returns every match, merely unboosted, which is what §13 asks for
 * anyway ("ranking boosts", never filters). Failing closed would mean `main()`
 * exits, the CLI reports the server `failed`, and the session loses
 * `task.get_context` along with it — A49's measured failure, spent on a question
 * about ordering. What the session must not do is *assume* it was boosted, so
 * the answer travels in every search response.
 */
export function askingDepartment(role: string): string | null {
  const profiles = AGENT_PROFILES as Record<string, { department: string } | undefined>;
  return profiles[role]?.department ?? null;
}

/**
 * Build the tool table for one session.
 *
 * Takes the channel rather than a database handle, so that a test can drive the
 * real protocol against a real channel — and so that this file has no way to
 * reach a task other than the one the channel was constructed with. The vault is
 * the one exception and is a different kind of thing: it is not scoped to the
 * task, because §13 makes the vault the studio's shared knowledge channel and
 * every department may read all of it.
 */
export function buildTools(deps: VorschichtServerDeps): AnyToolDefinition[] {
  const { channel, vault, role } = deps;
  const describe = (name: McpToolName) => MCP_TOOL_DESCRIPTIONS[name];
  const department = askingDepartment(role);

  return [
    {
      name: 'task.get_context',
      title: 'Task context',
      description: describe('task.get_context'),
      input: taskGetContextInput,
      readOnly: true,
      handle: async () => toolOk({ ...(await channel.context()) }),
    },
    {
      name: 'task.append_note',
      title: 'Append a note to the task timeline',
      description: describe('task.append_note'),
      input: taskAppendNoteInput,
      handle: async ({ text }) => toolOk({ recorded: true, ...(await channel.appendNote(text)) }),
    },
    {
      name: 'claims.list',
      title: 'File claims for this task',
      description: describe('claims.list'),
      input: claimsListInput,
      readOnly: true,
      handle: async () => toolOk({ ...(await channel.listClaims()) }),
    },
    {
      name: 'escalate.ask',
      title: 'Put a decision to the operator',
      description: describe('escalate.ask'),
      input: escalateAskInput,
      handle: async (input) => {
        const result = await channel.requestEscalation(input);

        // §15's policy memory answered it: no inbox item was created, and the
        // instruction is the *opposite* of the one below. A session told to park
        // after receiving an answer would park holding a decision nobody is
        // going to make again — waiting on the operator for something he already said.
        if (result.answeredFromPrecedent && result.decision) {
          return toolOk({
            recorded: true,
            answeredFromPrecedent: true,
            decision: result.decision,
            next:
              'The operator has already answered this exact question. No inbox item was created ' +
              'and nothing is waiting on him. Apply the decision above, carry on with ' +
              'the task, and reference it by its number in your `summary` so the trace ' +
              'shows which decision you followed rather than that you decided yourself. ' +
              'Do **not** end this turn with `needs_decision`.',
          });
        }

        return toolOk({
          recorded: true,
          answeredFromPrecedent: false,
          escalationRef: result.escalationRef,
          number: result.number,
          // Similar earlier decisions, if any. Context, never an answer — the
          // exact-match path is the only thing that answers, and it did not
          // fire. Worth returning so the session can name them in its summary.
          relatedDecisions: result.related,
          // Repeated here rather than left to the role prompt because this is
          // the moment it applies. §6.4 keeps the claims and resumes *this*
          // session with the answer, so whatever is left half-written is what
          // the resumed session will find.
          next:
            'End this turn now with status `needs_decision`. Your task parks with its ' +
            "claims held and this same session is resumed with the operator's answer, so leave " +
            'the work in a state you can pick up from, and put where you got to in ' +
            '`summary`.',
        });
      },
    },
    {
      name: 'finding.report',
      title: 'Report a blocking defect',
      description: describe('finding.report'),
      input: findingReportInput,
      handle: async (input) => toolOk({ recorded: true, ...(await channel.reportFinding(input)) }),
    },
    {
      name: 'docs.search',
      title: 'Search the document vault',
      description: describe('docs.search'),
      input: docsSearchInput,
      readOnly: true,
      handle: async ({ query, limit }) => {
        const { hits, pendingDocuments } = await vault.search({ query, department, limit });

        // Two sentences that are worth a turn, and neither is always true — a
        // note that is always present makes "there is something to know here"
        // unreadable, which is A69.6's argument for the findings briefing one
        // subsystem over.
        const notes: string[] = [];
        if (pendingDocuments > 0) {
          notes.push(
            `${pendingDocuments} document(s) in the vault have no extracted text yet and ` +
              'cannot match any query, so this result is not evidence that no such document ' +
              'exists — say so in your result if the work needed one.',
          );
        }
        if (department === null) {
          notes.push(
            `No department could be derived from this session's role ("${role}"), so nothing ` +
              'was ranked up for you. The hits themselves are complete.',
          );
        }

        return toolOk({
          query,
          // What the ranking used. Reported rather than implied: "ranked for
          // your department" and "ranked for nobody" are different answers and
          // look identical from a list of hits.
          department,
          results: hits.map((hit) => ({
            id: hit.document.id,
            title: hit.document.title,
            departmentTags: hit.document.departmentTags,
            tags: hit.document.tags,
            /** Which version carried the hit — a document may have several. */
            version: hit.version,
            /** What the text alone was worth, before the boost. */
            rank: hit.rank,
            departmentMatch: hit.departmentMatch,
            /** `rank` boosted; this is what the order above is by. */
            score: hit.score,
          })),
          pendingDocuments,
          ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
        });
      },
    },
    {
      name: 'docs.get',
      title: 'Fetch a vault document',
      description: describe('docs.get'),
      input: docsGetInput,
      readOnly: true,
      handle: async ({ id }) => {
        const detail = await vault.get(id);
        if (!detail) {
          // Not a tool error: a well-formed id that names nothing is a fact
          // about the vault the session can act on, not a malformed call. The
          // malformed one is refused by the schema before this runs.
          return toolOk({
            id,
            document: null,
            note:
              'No document with this id. Ids come from docs.search — search for the ' +
              'document by what it says rather than constructing an id.',
          });
        }

        // Newest first (`vault.get`), so this is the most recent version anybody
        // has read. Deliberately not "the newest version": a fresh upload with
        // no text layer would otherwise answer `null` for a document whose
        // earlier version is right there and readable, which is the same
        // "nothing there" / "not read yet" confusion `pendingDocuments` refuses
        // one layer down.
        const read = detail.versions.find((version) => version.extractedText !== null);
        const full = read?.extractedText ?? null;
        const truncated = full !== null && full.length > MAX_DOCUMENT_TEXT_CHARS;

        const notes: string[] = [];
        if (read === undefined) {
          notes.push(
            'No version of this document has been read yet, so the vault has its metadata ' +
              'and nothing else. That says nothing about what the document contains.',
          );
        } else if (read.version !== detail.versions[0]?.version) {
          notes.push(
            `The newest upload (version ${detail.versions[0]?.version}) has no extracted text; ` +
              `the text below is version ${read.version}, the most recent one that was read.`,
          );
        }
        if (truncated && full !== null) {
          notes.push(
            `The text is truncated: ${full.length - MAX_DOCUMENT_TEXT_CHARS} of ` +
              `${full.length} characters were left out. Cite it as a truncated document.`,
          );
        }

        return toolOk({
          id,
          document: {
            id: detail.document.id,
            title: detail.document.title,
            departmentTags: detail.document.departmentTags,
            tags: detail.document.tags,
            createdAt: detail.document.createdAt.toISOString(),
            updatedAt: detail.document.updatedAt.toISOString(),
          },
          // Metadata only. The text of every version at once is what the cap
          // above exists to prevent, and `textChars` says which ones have any.
          versions: detail.versions.map((version) => ({
            version: version.version,
            filename: version.filename,
            mimeType: version.mimeType,
            byteSize: version.byteSize,
            checksum: version.checksum,
            uploadedAt: version.uploadedAt.toISOString(),
            uploadedBy: version.uploadedBy,
            textChars: version.extractedText === null ? null : version.extractedText.length,
          })),
          text:
            read === undefined || full === null
              ? null
              : {
                  version: read.version,
                  content: truncated ? full.slice(0, MAX_DOCUMENT_TEXT_CHARS) : full,
                  truncated,
                  omittedChars: truncated ? full.length - MAX_DOCUMENT_TEXT_CHARS : 0,
                },
          ...(notes.length > 0 ? { note: notes.join(' ') } : {}),
        });
      },
    },
  ];
}

export function createVorschichtServer(deps: VorschichtServerDeps): McpStdioServer {
  return new McpStdioServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    buildTools(deps),
  );
}

/**
 * The names registered above, written out by hand.
 *
 * Deliberately not derived from `MCP_TOOL_NAMES` and not read back out of the
 * table: a drift test whose expectation is computed from the thing it checks
 * agrees with whatever the code happens to do. This list is edited when a tool
 * is added or removed, and `server.test.ts` fails when it and `MCP_TOOLS`
 * disagree in either direction. `server.itest.ts` closes the loop from the far
 * side by listing the tools over the vendor's own client.
 */
export const SERVER_TOOL_NAMES: readonly McpToolName[] = [
  'task.get_context',
  'task.append_note',
  'claims.list',
  'escalate.ask',
  'finding.report',
  'docs.search',
  'docs.get',
];
