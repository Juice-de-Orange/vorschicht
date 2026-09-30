/**
 * §11's legal gate — Lena, inside a gate run (§8 row 5, §14).
 *
 * The second gate in this system that is an agent session, and it is built to
 * `migration-review.ts`'s shape deliberately: a read-only profile, one session,
 * one verdict, and a **pure** function holding the policy. What is different is
 * the one thing that made this gate the last one buildable — its result is not
 * believed. §14 states a rule about the sources a legal output rests on, and a
 * rule that only exists in a prompt is not a rule (A44.3), so every citation the
 * session writes is resolved against the registry before anything is judged.
 *
 * Six decisions:
 *
 *  1. **The session never enters the repository.** §6.2 lists Legal among the
 *     staff sessions that run in a per-role scratch dir, and the containment
 *     argument is the auditor's (§8.2 rule 2) with real force: a codebase whose
 *     `CLAUDE.md` loaded as system context would be instructing the session that
 *     renders a DSGVO verdict about it. So the candidate arrives as an absolute
 *     path plus the changed-file list the gate suite has already computed, and
 *     the prompt says so — a relative read in a scratch dir finds an empty
 *     directory and reports, in good faith, that the change contains nothing
 *     (A70.1's lesson, one department over).
 *
 *  2. **The citable sources are handed over, not looked up by the session.**
 *     There is no MCP surface on the registry, and building one for this would
 *     be a tool the whole studio carries for one role. More to the point: a
 *     citation must name a registry id, so listing them in the prompt makes a
 *     fabricated id a deliberate invention rather than a guess — which is what
 *     turns "this reference does not exist" into evidence. `AuditDomain.detail`
 *     supplies git evidence to the auditor for the same reason (A56.4).
 *
 *  3. **A registry that could not be read is `infra`, never green.** The gate's
 *     whole substance is the comparison against it; without it there is nothing
 *     to compare and §11's answer for "not established" is not "green" (A63.5).
 *     The same for a session that could not run. Only a session that ran and
 *     delivered nothing usable is a finding.
 *
 *  4. **This writes no event kind of its own.** `migration-review` writes
 *     `gate.migration_review` because §12/A24 reads it later, from another
 *     component, at another time. Nothing downstream reads a legal verdict:
 *     its consequence *is* the gate step, which the merge queue already records
 *     in `gate_runs` with its full output. A kind with no reader is A112.2's
 *     shape, and the citation ledger belongs where a reader of the gate run
 *     will find it rather than in a second place that can disagree.
 *
 *  5. **Resolution happens here; judgement happens in `judgeLegalReview`.**
 *     The resolver needs a database, the policy needs neither a database nor a
 *     model, and keeping them apart is what lets §14's rule be asserted as a
 *     pure function over the four answers `checkCitation` distinguishes.
 *
 *  6. **One component for the gate and for the question.** §22's Phase 6 exit
 *     gate asks for a question about the Verein answered with citations, and
 *     §11 asks for a review of a change. They differ in what the prompt states
 *     and in nothing else — same profile, same contract, same citation check —
 *     so a second component would be a second prompt exercised by half as much.
 */
import {
  CITATION_MIN_LEVEL,
  type CitationCheck,
  checkCitation,
  type LegalCitation,
  type LegalResult,
  trustLevelCode,
} from '@vorschicht/shared';
import { AGENT_PROFILES } from './profiles/index.js';
import type { AgentRunner } from './runner.js';
import type { SourceRecord, SourceRegistry } from './sources/registry.js';

/** Shared by both shapes below. */
interface LegalReviewCommon {
  taskId: string;
  projectId: string | null;
  /** A41 — an analysed-only project. Passed through to the runner unchanged. */
  readOnlyProject: boolean;
}

/** §11's gate: a merge candidate, read from outside (decision 1). */
export interface LegalChangeReviewInput extends LegalReviewCommon {
  kind: 'change';
  /** Absolute path of the rebased worktree. Read, never entered. */
  repoPath: string;
  /** The integration branch, so the session knows what "the change" means. */
  baseRef: string;
  /** Everything the candidate changes, repository-relative. */
  changedFiles: readonly string[];
}

/** §8 row 5's other half: a question, answered with citations. */
export interface LegalQuestionInput extends LegalReviewCommon {
  kind: 'question';
  /** German (§2) — the question as it was asked. */
  question: string;
  /** Absolute path, when the question is about a repository. */
  repoPath?: string;
}

export type LegalReviewInput = LegalChangeReviewInput | LegalQuestionInput;

/**
 * One citation, and what the registry says about it.
 *
 * Deliberately not collapsed into a boolean: `checkCitation` distinguishes four
 * answers, and a fabricated reference, a source nobody accepted and a source
 * that is merely too weak are three different defects with three different
 * remedies. A caller handed "not ok" for all of them could not tell a legal
 * opinion that invented a reference from one that cited a blog.
 */
export interface ResolvedCitation {
  citation: LegalCitation;
  check: CitationCheck;
}

export type LegalReviewReport =
  /** The session ran, satisfied the contract, and its citations are resolved. */
  | { status: 'reviewed'; result: LegalResult; citations: ResolvedCitation[]; runId: string }
  /** A25: the harness or the registry failed. Nothing was proven; retry. */
  | { status: 'infra'; problem: string }
  /** The session ran and did not deliver a usable review. §11: blocks. */
  | { status: 'failed'; problem: string };

/**
 * What the gate suite needs from this component.
 *
 * Structural, like `MigrationReviewer`: it keeps the runner, the profile table
 * and the source registry out of the gate suite's import graph, and it lets a
 * test drive the gate's own decisions without a model and without a database.
 */
export interface LegalReviewer {
  review(input: LegalReviewInput): Promise<LegalReviewReport>;
}

/**
 * How many accepted sources the prompt lists.
 *
 * A cap rather than everything, because the list is paid for on every turn of
 * the session; and the prompt says when it bit, because a session that silently
 * saw two thirds of the registry would cite what it was shown and look as
 * though it had chosen.
 */
export const LEGAL_SOURCE_LIST_LIMIT = 60;

/** The task prompt (§6.2). English — agents work in English (§2). */
export function legalReviewPrompt(
  input: LegalReviewInput,
  sources: readonly SourceRecord[],
  totalAccepted = sources.length,
): string {
  const lines: string[] = [];

  if (input.kind === 'change') {
    lines.push(
      'A merge candidate in this repository needs a legal assessment before it may',
      'be merged, and you are the gate in front of it.',
      '',
      `The repository is at \`${input.repoPath}\` — an absolute path, because you are`,
      'not inside it. Read it from there.',
      `Integration branch: ${input.baseRef}. The change is everything between`,
      `\`git merge-base ${input.baseRef} HEAD\` and HEAD; the files are listed below,`,
      'because you have no shell to ask git yourself.',
      '',
      'Files this change touches:',
      ...input.changedFiles.slice(0, 80).map((path) => `  - ${path}`),
    );
    if (input.changedFiles.length > 80) {
      lines.push(`  … and ${input.changedFiles.length - 80} more`);
    }
    lines.push(
      '',
      'Read the ones that could touch personal data, a contractual obligation or a',
      'statutory duty: what is collected, on what legal basis, how long it is kept,',
      'who it is passed to. A change that touches none of that is approved, and',
      'saying so plainly with the provision that defines the term is a real answer.',
    );
  } else {
    lines.push(
      'You have been asked a question of law. Answer it.',
      '',
      'The question, as it was asked:',
      '',
      input.question.trim(),
    );
    if (input.repoPath) {
      lines.push(
        '',
        `Where it concerns code, the repository is at \`${input.repoPath}\` — an`,
        'absolute path, because you are not inside it.',
      );
    }
  }

  lines.push(
    '',
    "The organisation's own papers are in the document vault: search it with",
    '`docs.search` before you answer, and read what you find with `docs.get`. A',
    'question about this association is answered from its Statuten first and the',
    'statute second, because the statute is what the Statuten have to be read',
    'against.',
    '',
    'Sources you may cite, with the level the registry has granted each of them.',
    'These ids are the only ones `citations` may name; anything else is a',
    'fabricated reference and is a finding on its own:',
    '',
  );

  if (sources.length === 0) {
    lines.push(
      '  (The registry holds no accepted source at all. Then there is nothing that',
      `  reaches ${trustLevelCode(CITATION_MIN_LEVEL)}, this review cannot carry a`,
      '  conclusion under §14, and saying that in `summary` is the honest answer —',
      '  propose the sources it would need in `followups`.)',
    );
  } else {
    for (const source of sources) {
      const where = source.url ?? '(Dokument im Tresor)';
      lines.push(`  - ${source.id} · ${trustLevelCode(source.level)} · ${source.title} · ${where}`);
    }
    if (totalAccepted > sources.length) {
      lines.push(
        `  … and ${totalAccepted - sources.length} further accepted sources not listed here.`,
        '  If you need one of them, say so in `summary` rather than guessing an id.',
      );
    }
  }

  lines.push(
    '',
    'Every id you cite is resolved against the registry after you finish, and the',
    'level you claim is compared with the level it actually carries. Write what is',
    'there.',
  );

  return lines.join('\n');
}

export interface AgentLegalReviewerDeps {
  /**
   * Structural rather than the class (A57.6): a test drives the citation check
   * against a real registry with the model doubled, and `as unknown as
   * AgentRunner` would accept a double whose signature had drifted.
   */
  runner: Pick<AgentRunner, 'run'>;
  sources: Pick<SourceRegistry, 'list' | 'resolve'>;
  /**
   * Absolute scratch directory for the session (§6.2, decision 1).
   *
   * Supplied rather than derived, for the reason A83.3 gives about the path of
   * an irreversible edit: the caller is the one that knows how this daemon lays
   * out its run directories, and a default here would be the branch nothing
   * tests because every test injects a value.
   */
  scratchDir: string;
  onWarning?(message: string): void;
}

/** The real thing: one `legal` session, then the registry has the last word. */
export class AgentLegalReviewer implements LegalReviewer {
  constructor(private readonly deps: AgentLegalReviewerDeps) {}

  async review(input: LegalReviewInput): Promise<LegalReviewReport> {
    let accepted: SourceRecord[];
    try {
      accepted = await this.deps.sources.list({
        state: 'accepted',
        limit: LEGAL_SOURCE_LIST_LIMIT,
      });
    } catch (error) {
      // Fail closed. The comparison against the registry *is* this gate; with
      // the registry unreadable nothing was checked, and "we could not find out"
      // and "it is fine" are the same sentence only to a system that has decided
      // not to notice (A83.6, A87.6, A99.4).
      return {
        status: 'infra',
        problem: `Das Quellenregister war nicht lesbar: ${(error as Error).message}`,
      };
    }

    const outcome = await this.deps.runner.run({
      taskId: input.taskId,
      projectId: input.projectId ?? null,
      profile: AGENT_PROFILES.legal,
      prompt: legalReviewPrompt(input, accepted),
      cwd: this.deps.scratchDir,
      // Read-only, twice over: the profile carries no mutating tool and the
      // policy grants no write root. §6.6 asks for exactly that pairing.
      containment: {
        writeRoot: null,
        claims: null,
        readOnlyProject: input.readOnlyProject,
      },
    });

    if (outcome.status === 'failed') {
      return { status: 'failed', problem: outcome.problem };
    }
    if (outcome.status !== 'ok') {
      // An auth incident and an interrupt both mean the change was not
      // examined, and §11's honest answer for "not examined" is not "green".
      return { status: 'infra', problem: outcome.problem };
    }

    try {
      const citations = await resolveCitations(outcome.result.citations, this.deps.sources);
      return {
        status: 'reviewed',
        result: outcome.result,
        citations,
        runId: outcome.run.runId,
      };
    } catch (error) {
      this.deps.onWarning?.(
        `Zitationen konnten nicht gegen das Register geprüft werden: ${(error as Error).message}`,
      );
      return {
        status: 'infra',
        problem:
          'Die Zitationen konnten nicht gegen das Quellenregister aufgelöst werden: ' +
          `${(error as Error).message}`,
      };
    }
  }
}

/**
 * Every citation, resolved (§14).
 *
 * Sequential rather than concurrent: a legal opinion cites a handful of sources
 * and the registry is one indexed lookup each, so the only thing parallelism
 * would buy is a harder failure to attribute.
 */
export async function resolveCitations(
  citations: readonly LegalCitation[],
  sources: Pick<SourceRegistry, 'resolve'>,
): Promise<ResolvedCitation[]> {
  const resolved: ResolvedCitation[] = [];
  for (const citation of citations) {
    resolved.push({ citation, check: checkCitation(await sources.resolve(citation.sourceId)) });
  }
  return resolved;
}
