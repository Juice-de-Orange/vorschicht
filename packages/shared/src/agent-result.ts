/**
 * Structured result contract for every agent session (§6.3).
 *
 * The CLI is asked to conform to this via `--json-schema`; the runner then
 * re-validates with zod rather than trusting the flag. Two independent checks
 * of the same shape is not redundancy here — `--json-schema` is enforced by the
 * vendor's harness, zod is enforced by ours, and §6.3 gives exactly one repair
 * attempt before the task goes red. We want to know *which* layer disagreed.
 */
import { z } from 'zod';
import { GATE_IDS } from './gates.js';

/**
 * A uuid, for the two fields in this file that name a row in a database.
 *
 * One constant rather than two literals, because both exist for the same
 * reason and a second dialect would be a second answer to one question. The
 * reason is A56.7: `reopens` was an unconstrained string, the first real audit
 * filled it with `"Phase 1"`, and a completed audit was lost on the `uuid` cast
 * that followed. A110.4 met the same wall from the other side and put a uuid in
 * `docs.get`'s input, because a hallucinated id otherwise arrives at the model
 * as a Postgres syntax error rather than as an answer. Constrained here, the
 * same mistake is a contract violation §6.3's repair re-prompt can name.
 */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Terminal states an agent may report.
 *
 * `needs_decision` is not a failure — it is the escalation round-trip from
 * §6.4: the task parks with its claims held and resumes once the operator answers.
 * `parked` is the wrap-up outcome from §7.3. Neither may ever be rendered red.
 */
export const agentStatusSchema = z.enum(['done', 'needs_decision', 'failed', 'parked']);
export type AgentStatus = z.infer<typeof agentStatusSchema>;

export const agentResultSchema = z.object({
  status: agentStatusSchema,
  /** One paragraph, written for a human reading the task timeline. */
  summary: z.string().min(1),
  /** Paths, URLs or identifiers the run produced. */
  artifacts: z.array(z.string()).default([]),
  /** Work this run deliberately did not do — becomes candidate tasks. */
  followups: z.array(z.string()).default([]),
});
export type AgentResult = z.infer<typeof agentResultSchema>;

/** Reviewer verdict (§8.1). `changes_requested` findings are blockers, always. */
export const reviewVerdictSchema = z.enum(['approve', 'changes_requested']);

export const reviewerResultSchema = agentResultSchema.extend({
  verdict: reviewVerdictSchema,
  findings: z
    .array(
      z.object({
        file: z.string(),
        line: z.number().int().positive().optional(),
        severity: z.literal('blocker'),
        summary: z.string().min(1),
      }),
    )
    .default([]),
  /** Whether the diff stayed inside the task's claim set (§10). */
  claimsRespected: z.boolean(),
});
export type ReviewerResult = z.infer<typeof reviewerResultSchema>;

/**
 * Migration review (§11's optional gate, §12/A24, §23).
 *
 * The one result contract that belongs to a *gate* rather than to a step of
 * §8.1's chain, and its shape follows from what the gate has to decide
 * afterwards. Three fields carry that weight, and the split between them is the
 * design:
 *
 * `verdict` is the reviewer's own conclusion, and it is the only field that
 * speaks to §11 — `changes_requested` means findings, and a finding is a
 * blocker.
 *
 * `backwardCompatible` is an **observation**, not a verdict, and it deliberately
 * does not block the merge. §12 is explicit: a non-backward-compatible migration
 * "stops the deploy and escalates instead of auto-deploying", because a rollback
 * restores the previous release's *code* and cannot undo what the migration did
 * to the data. Sometimes a contract step is genuinely the right change; what may
 * not happen is that it deploys unattended. So the merge proceeds and the fact
 * travels to the deploy engine.
 *
 * `reversibility` is likewise an observation, and the gate derives the
 * consequence from it rather than asking for the conclusion — the same posture
 * A54.2 took for `claimsRespected`. §23 makes "migrations reversible or
 * explicitly documented" a definition-of-done item, so `undocumented` is a
 * finding whatever the reviewer's own verdict said; where the two disagree, the
 * divergence is itself worth recording.
 */
export const migrationReversibilitySchema = z.enum([
  /** A reverse migration exists and is stated. */
  'reversible',
  /** There is none, and the result says explicitly why (§23 satisfied). */
  'documented_irreversible',
  /** There is none and no reason given — a finding, whatever the verdict says. */
  'undocumented',
]);

export const migrationReviewResultSchema = agentResultSchema.extend({
  verdict: reviewVerdictSchema,
  /** §12/A24: does the *currently running* release survive this schema? */
  backwardCompatible: z.boolean(),
  reversibility: migrationReversibilitySchema,
  /** The migration files actually examined. Empty means nothing was reviewed. */
  migrations: z.array(z.string()).min(1),
  findings: z
    .array(
      z.object({
        file: z.string(),
        line: z.number().int().positive().optional(),
        severity: z.literal('blocker'),
        summary: z.string().min(1),
      }),
    )
    .default([]),
});
export type MigrationReviewResult = z.infer<typeof migrationReviewResultSchema>;

/**
 * One citation of one registered source (§14).
 *
 * `claimedLevel` is what the session believes the source stands at. It is not
 * what decides anything — the level that does comes out of the registry and is
 * resolved by the gate — and that is deliberate rather than redundant. A54.2's
 * posture for `claimsRespected`, one department over: whether a source is L5 is
 * a mechanical fact, and a model's assertion about a mechanical fact is the
 * weakest evidence available for it.
 *
 * Asking for it anyway is what makes an **overstatement** visible. A legal
 * opinion that presents a community blog as decisive is precisely the failure
 * §14's threshold exists to catch, and without this field the opinion and the
 * registry would simply never be compared. A field nothing reads would be
 * §8.2's sixth domain; this one is read, compared against the registry, and its
 * divergence is a finding.
 */
export const legalCitationSchema = z.object({
  /** The registry id. A uuid in the contract — see `UUID_PATTERN`. */
  sourceId: z
    .string()
    .regex(UUID_PATTERN, 'sourceId muss die Kennung einer Quelle aus dem Register sein (uuid)'),
  /** §14's L1–L5, as the session assessed it. Overruled by the registry. */
  claimedLevel: z.number().int().min(1).max(5),
  /** German (§2): the statement this source is cited *for*. */
  statement: z.string().min(1),
  /** Where inside the source — a paragraph, a section, a page. */
  locator: z.string().optional(),
});
export type LegalCitation = z.infer<typeof legalCitationSchema>;

/**
 * Legal/compliance (§8 row 5, §11's `legal` gate, §14).
 *
 * The only one of §8's departments with a result contract of its own — every
 * other one shares `staff` — and the reason is one clause of §22's Phase 6 exit
 * gate: "with citations and trust levels shown in the trace". Prose can
 * *mention* a source; it cannot be checked against a registry, and §14's rule
 * ("Legal/compliance outputs must cite sources with level ≥ L4") is a rule about
 * something that has to be machine-readable or it is not a rule at all (A44.3).
 *
 * Three decisions beyond that:
 *
 * **The answer lives in `summary`, and there is no second prose field.** A
 * separate `assessment` would be a second place the answer can live and a
 * chance for the two to disagree; `summary` is already the thing a human reads
 * in the task timeline, and `CONTROLLING_BODY` sets the precedent for a role
 * whose summary *is* its deliverable. The role prompt says it is German (§2),
 * because a legal assessment is addressed to the operator.
 *
 * **`citations` is not `.min(1)`.** The obvious move is to make the contract
 * refuse an uncited opinion, and it puts half of §14's policy where the German
 * explanation cannot go: a zero-citation result would come back as a schema
 * failure and a repair round rather than as a gate finding that says which rule
 * was broken. The threshold lives in `judgeLegalReview`, once, and an empty
 * list reaches it as the same red an all-L2 list does.
 *
 * **`documents` is uuid-shaped and its existence is not verified here.** The
 * ids come from `docs.search`, so the shape costs the session nothing and keeps
 * a malformed one out of a later `uuid` cast (A110.4). The gate does not look
 * them up — that would give it a second dependency for a field that blocks
 * nothing — so what this proves is the format and not the fact. The real-session
 * check resolves them; a gate that pretended to would be claiming more than it
 * does.
 */
export const legalResultSchema = agentResultSchema.extend({
  /** §11: `changes_requested` blocks the merge. Findings are blockers, always. */
  verdict: reviewVerdictSchema,
  citations: z.array(legalCitationSchema).default([]),
  /** §13 vault documents actually read, by id. */
  documents: z
    .array(z.string().regex(UUID_PATTERN, 'Dokumentkennungen stammen aus docs.search (uuid)'))
    .default([]),
  findings: z
    .array(
      z.object({
        file: z.string(),
        line: z.number().int().positive().optional(),
        severity: z.literal('blocker'),
        summary: z.string().min(1),
      }),
    )
    .default([]),
});
export type LegalResult = z.infer<typeof legalResultSchema>;

export const plannerResultSchema = agentResultSchema.extend({
  /** Path globs this task will own for its lifetime (§10). */
  claimSet: z.array(z.string()).min(1),
  plan: z.array(z.string()).min(1),
  testPlan: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
});
export type PlannerResult = z.infer<typeof plannerResultSchema>;

/**
 * §10's claim granularity, as the `projects` table constrains it.
 *
 * Three values and no fourth, because migration 0001 has a CHECK constraint with
 * exactly these — a proposal offering a fourth would pass every layer above the
 * database and fail at the INSERT, which is the worst place for it to fail.
 */
export const claimGranularitySchema = z.enum(['file', 'directory', 'package']);
export type ClaimGranularity = z.infer<typeof claimGranularitySchema>;

/** §12/A11's deploy methods. `none` is a real answer, not a placeholder. */
export const deployMethodSchema = z.enum(['compose', 'static-rsync', 'none']);
export type DeployMethod = z.infer<typeof deployMethodSchema>;

/**
 * Onboarding proposal (§20, §11's gate-proposal agent).
 *
 * §20 has an agent analyse a repository and propose "gate checkbox set + gate
 * commands, claim granularity, deploy config (incl. `none` where applicable),
 * department relevance", after which the operator confirms via one multiple-choice
 * escalation. This is that proposal as a contract, and three things about its
 * shape are decisions rather than transcription:
 *
 * **`gates` is a list of opinions, not a map of all sixteen.** The agent lists
 * every gate it wants enabled plus every locked gate it can supply a command
 * for; anything absent means "not enabled", which for a locked gate means
 * "enabled with no command", which the verification names rather than hides. The
 * alternative — sixteen mandatory entries — would spend tokens on fourteen
 * "does not apply" rationales per onboarding.
 *
 * **A rationale is required for every entry.** the operator is reading this to decide,
 * and a checkbox with no reason behind it is a checkbox he has to research
 * himself, which is precisely the "bare question" §15 forbids. It is also what
 * makes a wrong proposal visible: an enabled gate whose rationale does not match
 * the repository is easier to catch than a boolean.
 *
 * **`personalData` is an observation with evidence, never a verdict.** §11 makes
 * the DSGVO gate a checkbox and §20 asks the analysis for "personal-data
 * signals"; whether the gate is warranted is the operator's call and Lena's department,
 * so the agent reports what it found and where. The same posture A54.2 took for
 * `claimsRespected`: the model supplies the observation, the system derives the
 * consequence.
 */
export const onboardingResultSchema = agentResultSchema.extend({
  /** One or two sentences: what this project is built with. */
  stack: z.string().min(1),
  /** §10: what task branches would be cut from, read from the repository. */
  defaultBranch: z.string().min(1),
  gates: z
    .array(
      z.object({
        id: z.enum(GATE_IDS),
        enabled: z.boolean(),
        /** argv for a command gate. Omitted for the ones Vorschicht runs itself. */
        command: z.string().optional(),
        rationale: z.string().min(1),
      }),
    )
    .min(1),
  claimGranularity: claimGranularitySchema,
  claimRationale: z.string().min(1),
  /** §11's migration gate, in the claim grammar. Empty = the broad defaults. */
  migrationPaths: z.array(z.string()).default([]),
  /** A46.4: the Bash scopes a Coder in this project needs, e.g. `Bash(pnpm:*)`. */
  tools: z.array(z.string()).default([]),
  deploy: z.object({
    method: deployMethodSchema,
    rationale: z.string().min(1),
    /** §12: what the deploy engine polls after the swap. */
    healthUrl: z.string().optional(),
    composeFile: z.string().optional(),
    service: z.string().optional(),
    /** A24: migrations run before the swap, where a project has them. */
    migrateCommand: z.string().optional(),
  }),
  personalData: z.object({
    present: z.boolean(),
    /** `file:line` or a path — where the signal is. Empty when `present` is false. */
    evidence: z.array(z.string()).default([]),
  }),
  /** §20's "department relevance" — §8's German department names. */
  departments: z.array(z.string()).default([]),
  /** What the next reader should know before this project is switched on. */
  risks: z.array(z.string()).default([]),
});
export type OnboardingResult = z.infer<typeof onboardingResultSchema>;

/**
 * Betriebsprüfung (§8.2).
 *
 * Two properties of this schema are the contract rather than decoration.
 *
 * `verdict` is a closed set of three with no neutral member, because an auditor
 * permitted to hedge will: "some concerns remain" reads as diligence and commits
 * to nothing, and the one question the reader actually has — may this phase
 * close? — goes unanswered. The enum forces it.
 *
 * `scopeLimits` is required, not optional. What an audit could *not* examine is
 * the half of its result that silence misrepresents: an unexamined area and a
 * clean one look identical in a report that only lists findings. An auditor with
 * genuinely no limits writes an empty array and has thereby said so.
 */
export const auditFindingClassSchema = z.enum([
  /** A ticked exit gate whose cited evidence does not establish the claim. Un-ticks it. */
  'gate_invalid',
  /** A real fault in work that already merged. */
  'defect',
  /** A rule of this system was not followed. */
  'process',
  /**
   * A proof the project should have and does not — and the reason this
   * examination could not conclude (A65).
   *
   * Distinct from `scope_limit`, which is silence about the auditor's *own*
   * limits and files nothing. This one always files a task, and it exists
   * because the first real audit reported "I could not establish whether the
   * integration tests ever ran against a real database" as a scope limit — a
   * true statement about the project, filed under a class designed to produce
   * no work. It was closed only because a human read the report.
   */
  'coverage_gap',
  /** An Appendix A assumption whose premises no longer hold. */
  'assumption_expired',
  /** Believed but not shown. Blocks nothing and may not become a task. */
  'suspicion',
]);

export const auditVerdictSchema = z.enum([
  'unbedenklich',
  'funde_zu_beheben',
  'phase_nicht_abschliessbar',
]);

export const auditorResultSchema = agentResultSchema.extend({
  /** Which of §8.2's eight domains this run examined. */
  domain: z.enum([
    'gate_truth',
    'claim_vs_evidence',
    'test_substance',
    'assumption_revision',
    'containment_boundaries',
    'dead_wiring',
    'process_compliance',
    'number_reconciliation',
  ]),
  /** What was sampled — recorded so a later audit can re-check the same items. */
  sample: z.array(z.string()).min(1),
  findings: z
    .array(
      z.object({
        class: auditFindingClassSchema,
        /** What is wrong, in one sentence. */
        summary: z.string().min(1),
        /**
         * `file:line`, a command with the output it actually produced, or an
         * event-log id. §8.2: a finding without evidence is not a finding — so
         * the schema will not accept one, and a `suspicion` must still say what
         * prompted it.
         */
        evidence: z.string().min(1),
        /**
         * For `gate_invalid`: which tick is being challenged.
         *
         * A gate **id** (`P2.G4`), not a quotation. §8.2 lets this class un-tick
         * a gate in `CLAUDE.md`, which is the only authority in this system that
         * runs backwards through §0's phase discipline — and matching a model's
         * paraphrase of a gate line against that file is exactly the kind of
         * fuzzy step that must not sit in front of an irreversible edit. The
         * prompt hands over the ticked gates with their ids; naming one is
         * exact, and naming one that does not exist is caught rather than
         * guessed at.
         */
        gate: z.string().optional(),
        /**
         * For `process`: the mechanical guard this rule admits, if it admits one.
         *
         * §8.2 attaches "a task to build the mechanical guard where the violated
         * rule admits one" to this class, and whether it admits one is a
         * judgement only the auditor can make. Present → the task is created
         * with this as its mandate; absent → the finding is recorded and no
         * task is invented for it (A44.3's rule the other way round: not every
         * rule can stop depending on being remembered).
         */
        guard: z.string().optional(),
        /**
         * The id of an earlier finding this one re-raises (§8.2's dismissal rule).
         *
         * "A dismissal is re-opened exactly once." The prompt lists findings the
         * dev chain has dismissed once, with their ids and the dismissal as
         * evidence; setting this says "I examined that dismissal and I still
         * hold the finding". A finding whose second dismissal is re-raised goes
         * to the operator as a decision instead of round again — which is only
         * enforceable because the link is an id rather than a resemblance.
         *
         * The pattern is enforced because the first real audit did not obey the
         * prose: with no dismissed findings in its prompt, it set this to
         * `"Phase 1"`, meaning something else entirely. That is a reasonable
         * reading of an unconstrained string field, so the field is constrained.
         */
        reopens: z
          .string()
          .regex(
            UUID_PATTERN,
            'reopens muss die id eines früheren Funds sein (uuid), nicht ein Freitext',
          )
          .optional(),
      }),
    )
    .default([]),
  /** What could not be examined, and why. Reported as prominently as a finding. */
  scopeLimits: z.array(z.string()),
  verdict: auditVerdictSchema,
});
export type AuditorResult = z.infer<typeof auditorResultSchema>;

/** Role → result schema. Used to emit `contracts/<role>.result.schema.json`. */
export const ROLE_RESULT_SCHEMAS = {
  planner: plannerResultSchema,
  coder: agentResultSchema,
  reviewer: reviewerResultSchema,
  debugger: agentResultSchema,
  db: agentResultSchema,
  migration_review: migrationReviewResultSchema,
  legal: legalResultSchema,
  onboarding: onboardingResultSchema,
  auditor: auditorResultSchema,
  staff: agentResultSchema,
} as const;

export type RoleName = keyof typeof ROLE_RESULT_SCHEMAS;

/**
 * The result type belonging to one role.
 *
 * Exists so the runner can be generic over the role it ran: asking for a
 * reviewer session and getting back something with a `verdict` on it, rather
 * than the union of every role's contract plus a cast at the call site.
 */
export type RoleResult<R extends RoleName> = z.infer<(typeof ROLE_RESULT_SCHEMAS)[R]>;

export const ROLE_NAMES = Object.keys(ROLE_RESULT_SCHEMAS) as RoleName[];

/**
 * The role's contract as JSON Schema, for `--json-schema` (§6.3).
 *
 * Generated from the zod schema rather than hand-written, so the shape the CLI
 * enforces and the shape zod re-validates cannot disagree — §6.3 wants to know
 * *which* layer objected, which is only informative while both layers describe
 * the same contract.
 *
 * Two options carry the weight:
 *
 * `io: 'input'` — in output mode zod marks every field with a `.default()` as
 * required, because after parsing it always is. But this schema constrains what
 * the *model* produces, and `artifacts: []` is a legitimate omission there.
 * Output mode would fail runs for leaving out an empty list.
 *
 * `target: 'draft-7'` — zod's default is draft 2020-12, and the pinned CLI
 * rejects it outright: `--json-schema is not a valid JSON Schema: no schema
 * with key or ref "https://json-schema.org/draft/2020-12/schema"`. Its
 * validator only knows draft-07. Verified in both directions on 2.1.220 (ADR
 * 0002); a CLI bump that changes this is caught by `gate:contracts`.
 */
const jsonSchemaCache = new Map<RoleName, Record<string, unknown>>();

export function roleJsonSchema(role: RoleName): Record<string, unknown> {
  const cached = jsonSchemaCache.get(role);
  if (cached) return cached;
  const schema = z.toJSONSchema(ROLE_RESULT_SCHEMAS[role], {
    io: 'input',
    target: 'draft-7',
  }) as Record<string, unknown>;
  jsonSchemaCache.set(role, schema);
  return schema;
}

/**
 * Parse a result the CLI produced.
 *
 * Returns a discriminated outcome instead of throwing, because §6.3 prescribes
 * a specific recovery — one repair re-prompt via `--resume` — and the caller
 * needs the reason to put in that prompt.
 */
export function parseAgentResult<R extends RoleName>(
  role: R,
  raw: unknown,
): { ok: true; result: z.infer<(typeof ROLE_RESULT_SCHEMAS)[R]> } | { ok: false; problem: string } {
  const schema = ROLE_RESULT_SCHEMAS[role];
  const parsed = schema.safeParse(raw);
  if (parsed.success) {
    return { ok: true, result: parsed.data as z.infer<(typeof ROLE_RESULT_SCHEMAS)[R]> };
  }
  const problem = parsed.error.issues
    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
    .join('; ');
  return { ok: false, problem };
}
