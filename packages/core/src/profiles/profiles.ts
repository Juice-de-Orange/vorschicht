/**
 * Agent profiles v1 (§8, §8.1, §6.2, A8) — the five dev-chain roles.
 *
 * This is the table §8 asks for, plus the two things a spawn needs that a table
 * cannot hold: how a tier becomes a model alias, and how a profile becomes a
 * `SessionSpec`.
 *
 * The tool whitelists deserve one note up front, because what is *missing* from
 * them is deliberate. No role may run `cat`, `head`, `tail`, `sed` or `awk`.
 * §6.6's read hygiene is a `PreToolUse` hook, and a hook sees the tool that was
 * invoked — it can deny `Read` on `.env` cleanly, and it can only pattern-match
 * a shell command that might do the same thing. Rather than write a regex that
 * decides whether a shell line reads a secret, the shell readers are simply not
 * granted: `Read`, `Grep` and `Glob` do the same work through the layer that
 * can actually be enforced. Bash remains scoped to git and to the project's own
 * build commands, which is the accepted limit §6.6 states plainly.
 */
import {
  type McpToolName,
  type RunCaps,
  roleJsonSchema,
  type SessionSpec,
  whitelistNames,
} from '@vorschicht/shared';
import { COMMON_RULES, ROLE_PROMPT_BODIES } from './prompts.js';
import type { AgentProfile, ModelTier, Persona, ProfileId } from './types.js';

/** Reading the repository. The sanctioned read path, because hooks can see it. */
const READ_TOOLS = ['Read', 'Grep', 'Glob'] as const;

/** Inspecting history and the working copy. Read-only git. */
const GIT_INSPECT = [
  'Bash(git status:*)',
  'Bash(git diff:*)',
  'Bash(git log:*)',
  'Bash(git show:*)',
  'Bash(git branch:*)',
] as const;

/**
 * Recording work on the task branch.
 *
 * `git push` is absent: pushing is the merge queue's job (§10), performed after
 * gates pass, and a coder that could push would be able to put unreviewed work
 * where the deploy engine looks for it.
 */
const GIT_RECORD = ['Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git restore:*)'] as const;

/** File mutation. Only roles that produce code carry these. */
const EDIT_TOOLS = ['Write', 'Edit'] as const;

/**
 * Reading the open web (§6.2, A18).
 *
 * Exactly the two tools §6.2 names for the Research role, and granted to that
 * role only. Not because the others could not use a search — because a session
 * whose mandate is a diff has no business fetching a URL, and every tool a role
 * carries is one more way for a turn to be spent somewhere its mandate is not.
 * A18 settled that this is Claude Code's own web access; SearXNG is not wired.
 */
const WEB_TOOLS = ['WebSearch', 'WebFetch'] as const;

/** MCP tools every dev-chain role needs to know what it is doing. */
const CONTEXT_TOOLS: readonly McpToolName[] = [
  'task.get_context',
  'task.append_note',
  'claims.list',
  'escalate.ask',
  'docs.search',
  'docs.get',
];

/**
 * Budget backstop per turn, in USD (A32 cap 2).
 *
 * A backstop, not a throttle: sized so that a healthy session never meets it and
 * a session stuck in a loop does. The real budget authority is the guardian
 * (§7.2), which watches the subscription windows and parks work at 85%; this cap
 * only catches the shape the guardian is blind to — few turns, enormous context,
 * repeating. Under subscription auth `total_cost_usd` is populated (observed:
 * 0.05 for a one-turn haiku session, most of it cache creation), so the cap is a
 * real second limit rather than an inert one.
 */
const USD_PER_TURN_BACKSTOP = 0.4;

function caps(maxTurns: number, wallClockMinutes: number): RunCaps {
  return {
    maxTurns,
    maxBudgetUsd: Math.round(maxTurns * USD_PER_TURN_BACKSTOP),
    wallClockMs: wallClockMinutes * 60_000,
  };
}

function persona(name: string, desk: string, flavor: string, alternates?: string[]): Persona {
  return { name, desk, flavor, ...(alternates ? { alternates } : {}) };
}

/**
 * The profile table.
 *
 * Tiers follow A8 — opus-class for Planner and Reviewer, sonnet-class for the
 * Coder — with two additions recorded as A46: the Debugger and the DB
 * specialist are also strong. The Debugger is only ever called after a task has
 * failed twice, which is precisely where a weaker model produces a confident
 * wrong root cause and sends the next session into a third failure; the DB
 * specialist writes the one artefact a rollback does not undo (§12/A24). Both
 * are rare enough that the budget effect is small, and Sparbetrieb (A22) drops
 * both to standard anyway.
 */
export const AGENT_PROFILES = {
  planner: {
    id: 'planner',
    role: 'planner',
    department: 'Entwicklung',
    persona: persona(
      'Paul',
      'Planung',
      'You are unhurried and exact. You would rather read one more file than ' +
        'guess one detail, and you write plans someone else can follow without you.',
    ),
    tier: 'strong',
    workspace: 'worktree',
    // No editing tools at all. §8.1 gives the Planner a plan to produce, and a
    // Planner who starts implementing writes a plan only they can follow.
    allowedTools: [...READ_TOOLS, ...GIT_INSPECT],
    mcpTools: CONTEXT_TOOLS,
    caps: caps(40, 30),
    systemPrompt: '',
  },
  coder: {
    id: 'coder',
    role: 'coder',
    department: 'Entwicklung',
    persona: persona(
      'Clara',
      'Entwicklung',
      'You write code that reads as though it had always been there, and you ' +
        'run the checks before you say you are finished.',
      // §8 seats two coders because the default concurrency is two (A7). It is
      // one profile at two desks, not two profiles.
      ['Chris'],
    ),
    tier: 'standard',
    workspace: 'worktree',
    allowedTools: [...READ_TOOLS, ...EDIT_TOOLS, ...GIT_INSPECT, ...GIT_RECORD],
    mcpTools: CONTEXT_TOOLS,
    caps: caps(80, 90),
    systemPrompt: '',
  },
  reviewer: {
    id: 'reviewer',
    role: 'reviewer',
    department: 'Entwicklung',
    persona: persona(
      'Rita',
      'Review',
      'You are hard to satisfy and easy to read. You name the failure, not the ' +
        'feeling, and you never approve what you would not deploy unattended.',
    ),
    tier: 'strong',
    workspace: 'worktree',
    // Exactly §6.2's list. Read-only by construction: findings travel through
    // `finding.report`, never through an edit.
    allowedTools: [...READ_TOOLS, 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'],
    mcpTools: [...CONTEXT_TOOLS, 'finding.report'],
    caps: caps(30, 30),
    systemPrompt: '',
  },
  debugger: {
    id: 'debugger',
    role: 'debugger',
    department: 'Entwicklung — Spezialisten',
    persona: persona(
      'Dora',
      'Fehlersuche',
      'You reproduce before you explain, and you would rather report an ' +
        'incomplete answer than a tidy one that is wrong.',
    ),
    tier: 'strong',
    workspace: 'worktree',
    // Read-only: a fix from the Debugger would arrive unplanned, unclaimed and
    // unreviewed, which is the one shape this studio does not allow. It does
    // get git inspection, because §7.2's integrity re-check is a question about
    // what a worktree actually contains.
    allowedTools: [...READ_TOOLS, ...GIT_INSPECT],
    mcpTools: [...CONTEXT_TOOLS, 'finding.report'],
    caps: caps(60, 60),
    systemPrompt: '',
  },
  db: {
    id: 'db',
    role: 'db',
    department: 'Entwicklung — Spezialisten',
    persona: persona(
      'Milo',
      'Datenbank',
      'You think in terms of the release that is still running, and you assume ' +
        'every migration will have to survive a rollback that does not undo it.',
    ),
    tier: 'strong',
    workspace: 'worktree',
    allowedTools: [...READ_TOOLS, ...EDIT_TOOLS, ...GIT_INSPECT, ...GIT_RECORD],
    mcpTools: [...CONTEXT_TOOLS, 'finding.report'],
    caps: caps(50, 45),
    systemPrompt: '',
  },
  /**
   * §11's migration gate — Milo, judging rather than designing (A63).
   *
   * Same person in the office view, same body of knowledge in the prompt, and a
   * deliberately different profile: this one has no editing tools and no
   * `git add`/`git commit`, because a gate that can change the tree it is
   * judging is not a gate. §8.1 already draws that line for the Reviewer and the
   * reason is identical here.
   *
   * Two further omissions are decisions rather than oversights. `escalate.ask`
   * is absent for the auditor's reason: this session runs *inside* a merge
   * attempt that holds the project's merge lock, and a gate must come back with
   * a verdict rather than with a question — A24's escalation is raised by the
   * deploy engine from the recorded result, where it carries the evidence. And
   * the caps are small: a migration review reads a handful of files and one
   * diff, so a run that needs forty turns has misunderstood its job rather than
   * found a hard problem.
   */
  'db-review': {
    id: 'db-review',
    role: 'migration_review',
    department: 'Entwicklung — Spezialisten',
    persona: persona(
      'Milo',
      'Datenbank',
      'You think in terms of the release that is still running, and you assume ' +
        'every migration will have to survive a rollback that does not undo it.',
    ),
    tier: 'strong',
    workspace: 'worktree',
    // Read-only by construction. Git inspection is granted and *works* here,
    // unlike the auditor's case (A56): this session runs in the task's worktree,
    // so `git diff` and `git show` have a repository to answer about.
    allowedTools: [...READ_TOOLS, 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'],
    mcpTools: ['task.get_context', 'task.append_note', 'claims.list', 'finding.report'],
    caps: caps(25, 20),
    systemPrompt: '',
  },
  /**
   * §20's onboarding agent — Petra, reading a repository she may not touch.
   *
   * Three properties are decisions, and the first is the one that would be easy
   * to get wrong:
   *
   * **Scratch cwd, and the repository reached by absolute path.** §6.2 puts
   * dev-chain sessions *inside* the target worktree precisely so the project's
   * own `CLAUDE.md` loads as instructions — which is right for a Coder and
   * exactly backwards here. This session decides which checks will ever run
   * against that repository; a repository able to instruct that decision is the
   * arrangement §8.2 rule 2 already refuses for the auditor. So the same posture:
   * the project's conventions file is read through `Read`, as evidence, and the
   * survey supplies everything a shell in the wrong directory could not answer.
   *
   * **Strong tier.** The proposal is rare — once per project — and its output is
   * permanent: a plausible-looking wrong test command configures a gate that
   * reports an infra failure on every merge attempt and never goes red (A55.3),
   * which surfaces months later as an Ops alert nobody connects to onboarding.
   *
   * **No MCP tools at all.** An onboarding run serves no task, so it spawns
   * without `--mcp-config` (A56.5); listing task-scoped tools it cannot call
   * would put names in `--allowedTools` that answer nothing.
   */
  onboarding: {
    id: 'onboarding',
    role: 'onboarding',
    department: 'Produktleitung',
    persona: persona(
      'Petra',
      'Produktleitung',
      'You read a codebase the way someone does who will have to live with the ' +
        'decision, and you would rather say "I could not tell" than propose a ' +
        'setting you did not check.',
    ),
    tier: 'strong',
    workspace: 'scratch',
    allowedTools: [...READ_TOOLS],
    mcpTools: [],
    // Generous turns, because a fair reading of an unfamiliar repository is many
    // cheap reads; a modest wall clock, because this runs while somebody waits.
    caps: caps(45, 30),
    systemPrompt: '',
  },
  auditor: {
    id: 'auditor',
    role: 'auditor',
    department: 'Betriebsprüfung',
    persona: persona(
      'Bruno',
      'Betriebsprüfung',
      "You take nothing on the author's word, and you say plainly when you " +
        'found nothing. You would rather report a gap in your own coverage ' +
        'than a finding you cannot show.',
    ),
    tier: 'strong',
    // Scratch, not worktree — and this is a containment property, not a
    // convenience. §6.2 puts dev-chain sessions inside the target worktree
    // precisely so the project's own `CLAUDE.md` loads as instructions. For an
    // auditor that is backwards: the repository under examination would be
    // telling its own examiner how to think. Here that file is evidence, read
    // through `Read` like anything else.
    workspace: 'scratch',
    // Read-only by construction (§8.2). No editing tools, no `git add/commit`:
    // whoever can make a finding disappear must not be the one deciding whether
    // it is real.
    //
    // No shell git either, and that follows from the scratch cwd rather than
    // from caution (A56). §8.2 lists "read-only git" among the auditor's tools,
    // but a whitelist entry of `Bash(git log:*)` runs the command *in the
    // session's own directory*, which is a scratch dir belonging to no
    // repository — so every such call answers "not a git repository". Granting
    // it would be a tool that cannot work: a signal path that reads as covered
    // and cannot carry a signal, which is the exact class domain 6 exists to
    // find. Git evidence therefore arrives through the collectors, which run
    // the real commands and record what they actually printed; anything beyond
    // what they gathered is a `scope_limit`, which is the honest answer and the
    // one §8.2 asks for by name.
    allowedTools: [...READ_TOOLS],
    // `escalate.ask` is deliberately absent, and it is the only role-shaped
    // omission here. Escalation parks the session until the operator answers; an audit
    // that stops halfway to ask a question delivers no report at all, and its
    // report is the thing with value. The consequences §8.2 attaches to a
    // verdict — the P1 item for a `gate_invalid`, the inbox item for an expired
    // assumption — are raised by the orchestrator from the finished result,
    // where they carry the evidence with them.
    mcpTools: ['task.get_context', 'task.append_note', 'claims.list', 'docs.search', 'docs.get'],
    // Generous turns, moderate wall clock: an audit is many cheap reads rather
    // than a few expensive edits, and the failure mode to avoid is a run that
    // stops mid-sample and reports a coverage gap it did not need to have.
    caps: caps(70, 60),
    systemPrompt: '',
  },
  /*
   * §8's nine remaining departments (Phase 6 step 1).
   *
   * **Tiers.** A8 names the strongest tier for Planner, Reviewer, Legal and
   * Security and the standard tier for "the Coder and most staff", so Sasha and
   * Lena are strong and the other seven are standard. None is economy, and that is a
   * decision rather than an omission: A8 reserves that tier for "bulk chores
   * (log digests, tagging)" — a *chore*, not a department. Every one of these
   * eight produces a judgement somebody acts on unattended, and the cheapest
   * model returns a judgement that reads identical and means less, which is the
   * one failure mode nothing downstream can detect. When a genuine bulk chore
   * gets its own session — digesting logs, tagging vault documents — it should
   * get its own economy profile, the way `smoke` got one for being a probe
   * rather than a role.
   *
   * **Workspaces.** §6.2 puts a session in the task's worktree so the project's
   * own conventions load, and staff sessions in a scratch dir "to keep them
   * deterministic". The line here follows what the session touches: the four
   * that read or write a diff run in the worktree, and the four whose subject is
   * not a repository — a goal, the open web, an incident record, the event log —
   * run in scratch and reach any repository by absolute path (A70.1).
   *
   * **No shell for the scratch four**, and that is A56.4's lesson rather than
   * caution: `Bash(git log:*)` in a directory belonging to no repository answers
   * "not a git repository" on every call. Granting it would be a tool that reads
   * as covered and cannot carry a signal — audit domain 6, in the table that
   * decides what every session may do.
   */
  /**
   * §8 row 1 — Petra again, one desk over from `onboarding`.
   *
   * Read-only in a scratch directory for the reason the whole role has: a
   * decomposition is a *proposal*, and nothing it says is applied by the session
   * that wrote it. Standard tier because that is what makes the proposal cheap
   * to be wrong about — unlike a Planner's plan, which a Coder executes
   * unattended, this one is read before anything runs on it.
   */
  product: {
    id: 'product',
    role: 'staff',
    department: 'Produktleitung',
    persona: persona(
      'Petra',
      'Produktleitung',
      'You ask what would have to be true for this to be finished, and you write ' +
        'it down before anyone starts.',
    ),
    tier: 'standard',
    workspace: 'scratch',
    allowedTools: [...READ_TOOLS],
    mcpTools: CONTEXT_TOOLS,
    // A goal is read once and cut up once; the turns go into reading the code
    // that changes the reading of it.
    caps: caps(40, 30),
    systemPrompt: '',
  },
  /**
   * §8 row 3 — Quentin, and one of only two departments here that writes.
   *
   * Writing is the point rather than a convenience: §8 gives QA "writes/maintains
   * unit/integration/E2E", and a QA role that could only report would file a
   * finding saying "this needs a test" — which is a task nobody has done, dressed
   * as work that was. Standard tier per A8, and defensible because the output is
   * code that goes back through the same review and the same gates as any other
   * change; a weak test is caught by the Reviewer, unlike a weak judgement.
   */
  qa: {
    id: 'qa',
    role: 'staff',
    department: 'QA/Testing',
    persona: persona(
      'Quentin',
      'Qualitätssicherung',
      'You do not believe a test until you have seen it fail for the right ' +
        'reason, and you say which one you broke to find out.',
    ),
    tier: 'standard',
    workspace: 'worktree',
    allowedTools: [...READ_TOOLS, ...EDIT_TOOLS, ...GIT_INSPECT, ...GIT_RECORD],
    mcpTools: [...CONTEXT_TOOLS, 'finding.report'],
    // Close to the Coder's: writing a suite and then mutating the implementation
    // to prove it fails is two passes over the same ground by construction.
    caps: caps(70, 75),
    systemPrompt: '',
  },
  /**
   * §8 row 4 — Sasha. Strong tier by A8, read-only by construction.
   *
   * The read-only property carries more weight in this role than in any other,
   * and the reason is specific rather than the general one: the scan
   * configuration is what decides whether a secret is found at all. A104.5
   * measured it — the same scanner, over the same file holding the same token,
   * reports a finding with its rule file and exits 0 with an empty list without
   * it. A role able to edit that file can silence its own gate, and a silenced
   * scan and a clean one are the same green.
   *
   * The general reason applies too (§8.1, and the Debugger's comment above): a
   * fix from this session would arrive unplanned, unclaimed and unreviewed.
   */
  security: {
    id: 'security',
    role: 'staff',
    department: 'Security',
    persona: persona(
      'Sasha',
      'Sicherheit',
      'You describe the attack with inputs somebody could type, or you do not ' +
        'call it a finding.',
    ),
    tier: 'strong',
    workspace: 'worktree',
    allowedTools: [...READ_TOOLS, ...GIT_INSPECT],
    mcpTools: [...CONTEXT_TOOLS, 'finding.report'],
    caps: caps(45, 45),
    systemPrompt: '',
  },
  /**
   * §8 row 5 — Lena, and §11's `legal` gate (§14).
   *
   * Four properties are decisions rather than transcription.
   *
   * **Scratch, not the worktree — which is §6.2's own list and, here, the
   * stronger containment property.** §6.2 names "Research, Legal, Controlling,
   * …" among the sessions that run in a per-role scratch dir. A gate normally
   * wants the worktree (`db-review` has it, so `git diff` has a repository to
   * answer about), and the argument that wins here is the auditor's (§8.2 rule
   * 2) and onboarding's (A70.1): a repository whose `CLAUDE.md` loads as system
   * context is instructing its own examiner, and of every judgement this studio
   * makes, a DSGVO verdict about a codebase is the one that codebase would most
   * like to shape. The candidate is read by absolute path instead, and the gate
   * hands over the changed files it has already computed.
   *
   * **The open web, which no role but Research has.** §14 makes L5 —
   * "RIS/Gesetzestexte" — the citation-grade level, and Austrian legal text
   * lives on the web and nowhere else; §8 row 5 says in as many words that she
   * "works from the document vault + L5 sources with citations". Without
   * `WebFetch` the role cannot produce the thing it exists to produce. §6.2's
   * "Research: WebSearch,WebFetch" is an example of a whitelist, not a claim of
   * exclusivity, and `profiles.test.ts` asserts the pair in both directions so
   * that a third grantee is a decision rather than a drift.
   *
   * **Read-only.** She judges, and §8.1's rule for every judging role applies:
   * whoever can make a finding disappear must not be the one deciding whether
   * it is real.
   *
   * **No `escalate.ask`**, which is `db-review`'s omission for `db-review`'s
   * reason: this session runs inside a merge attempt holding the project's
   * merge lock (A55.2), and a gate must come back with a verdict rather than
   * with a question. The consequence is stated rather than hidden — a legal
   * question only the operator can settle comes back as `changes_requested` carrying the
   * question as a finding, which reaches him through §11's red path (§9's second
   * failure escalates with a diagnosis) instead of through §15's inbox directly.
   * One hop further, and visible at every step of it.
   */
  legal: {
    id: 'legal',
    role: 'legal',
    // §8's label, and it is load-bearing rather than cosmetic: `docs.search`
    // derives the asking department from this string (A110.1), so a document
    // tagged `Recht` in the vault ranks for her only while the two agree.
    department: 'Recht',
    persona: persona(
      'Lena',
      'Recht',
      'You answer from the text in front of you, name the provision, and say ' +
        'plainly where the law stops and your reading begins.',
    ),
    tier: 'strong',
    workspace: 'scratch',
    allowedTools: [...READ_TOOLS, ...WEB_TOOLS],
    mcpTools: [
      'task.get_context',
      'task.append_note',
      'claims.list',
      'docs.search',
      'docs.get',
      'finding.report',
    ],
    // Between the Reviewer's and Research's: reading a statute and two vault
    // documents is a handful of cheap reads plus a few fetches, and a review
    // that has not concluded in forty minutes is looking for an answer the
    // sources do not contain.
    caps: caps(40, 40),
    systemPrompt: '',
  },
  /**
   * §8 row 6 — Rado, and one of two profiles in this table with web access.
   *
   * `WebSearch`/`WebFetch` are granted here and to Legal (§6.2 names them
   * for exactly this role, A18 settled that they are Claude Code's own). No git:
   * this session runs in a scratch directory, so a shell git would answer "not a
   * repository" on every call (A56.4).
   *
   * Standard tier, and the argument that it should be strong is real — §6.0
   * calls a billing change this project's #1 external risk. It stays standard
   * because the danger in this role is not depth of reasoning but invented
   * detail, and a stronger model does not fix that; the prompt's "never report a
   * fact you did not read" and §14's source levels do.
   */
  research: {
    id: 'research',
    role: 'staff',
    department: 'Research/Radar',
    persona: persona(
      'Rado',
      'Recherche',
      'You quote the page rather than your memory of it, and you say plainly ' +
        'when you could not establish something.',
    ),
    tier: 'standard',
    workspace: 'scratch',
    allowedTools: [...READ_TOOLS, ...WEB_TOOLS],
    mcpTools: CONTEXT_TOOLS,
    // A scan is many cheap fetches; the wall clock is the cap that matters, and
    // a radar run that has not finished in forty minutes has found a rabbit hole.
    caps: caps(50, 40),
    systemPrompt: '',
  },
  /**
   * §8 row 7 — Doris. The second writing department, and the asymmetry with
   * Sasha is deliberate rather than an inconsistency.
   *
   * Sasha may not write because her writes would land in the file that decides
   * whether her own gate fires. Doris's writes are documentation prose, which
   * arrives in the diff and is read by a Reviewer like any other change — and
   * §11's docs gate is mechanical (did the change carry documentation), so
   * writing documentation satisfies it rather than silencing it.
   *
   * What is deliberately **not** built here is the judging half: A62.5 leaves
   * "is *the right* document now stale" to Doris, and that is a gate session,
   * which by A63.3 must be a separate read-only profile rather than a mode flag
   * on this one. It arrives when Phase 6 wires that gate to a session.
   */
  docs: {
    id: 'docs',
    role: 'staff',
    department: 'Doku & Archiv',
    persona: persona(
      'Doris',
      'Doku & Archiv',
      'You would rather write the smaller true sentence, and you never let a ' +
        'document claim more than the code does.',
    ),
    tier: 'standard',
    workspace: 'worktree',
    allowedTools: [...READ_TOOLS, ...EDIT_TOOLS, ...GIT_INSPECT, ...GIT_RECORD],
    mcpTools: [...CONTEXT_TOOLS, 'finding.report'],
    caps: caps(50, 45),
    systemPrompt: '',
  },
  /**
   * §8 row 8 — Otto, who advises and never operates.
   *
   * No shell, no deploy tool, nothing that reaches a machine — and that is the
   * design. §12's engine performs the build, the migration, the swap, the health
   * poll and the rollback deterministically, within a configured timeout, and a
   * rollback decided instead by a session on evidence it assembled itself is a
   * second outage on top of the first.
   *
   * Standard tier, with the honest note that A46.2's argument for a strong
   * Debugger — "a weaker model produces a confident wrong root cause" — applies
   * to an incident analysis almost word for word. It stays at A8's letter here;
   * raising it is a decision with its own reasoning, not a side effect of adding
   * the profile.
   */
  ops: {
    id: 'ops',
    role: 'staff',
    department: 'Ops/SRE',
    persona: persona(
      'Otto',
      'Betrieb',
      'You reconstruct the sequence before you name a cause, and you would ' +
        'rather report that it is unestablished than tidy.',
    ),
    tier: 'standard',
    workspace: 'scratch',
    allowedTools: [...READ_TOOLS],
    mcpTools: [...CONTEXT_TOOLS, 'finding.report'],
    caps: caps(35, 30),
    systemPrompt: '',
  },
  /**
   * §8 row 9 — Uli, read-only in the worktree, like every role that judges a
   * diff (§8.1's rule for the Reviewer, for the same reason).
   *
   * Git inspection is exactly the Reviewer's three: this session reads a change,
   * not a repository's history of changes.
   */
  ux: {
    id: 'ux',
    role: 'staff',
    department: 'UX/A11y',
    persona: persona(
      'Uli',
      'UX & Barrierefreiheit',
      'You try the keyboard first, and you can tell a preference from a defect ' +
        'without being asked to.',
    ),
    tier: 'standard',
    workspace: 'worktree',
    allowedTools: [...READ_TOOLS, 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)'],
    mcpTools: [...CONTEXT_TOOLS, 'finding.report'],
    caps: caps(30, 30),
    systemPrompt: '',
  },
  /**
   * §8 row 10 — Konrad, who reads the meter and cannot move it.
   *
   * Read-only, and the absence that matters is not the editing tools: this
   * profile has no route to the guardian, to a plan budget or to a threshold at
   * all, because none of those is a tool. Stated here anyway, since the
   * temptation in Phase 8 will be to give Controlling a "adjust concurrency"
   * capability and that is a dashboard control with an audit trail (§7.2, A26),
   * never a session's.
   *
   * No `finding.report`: §11's findings are blockers on a task's merge, and a
   * budget observation is not one. Controlling's output is a report and a set of
   * proposals, which is what `summary` and `followups` are for.
   */
  controlling: {
    id: 'controlling',
    role: 'staff',
    department: 'Controlling',
    persona: persona(
      'Konrad',
      'Controlling',
      'You recompute rather than quote, and every number you write down comes ' +
        'with the window it belongs to.',
    ),
    tier: 'standard',
    workspace: 'scratch',
    allowedTools: [...READ_TOOLS],
    mcpTools: CONTEXT_TOOLS,
    caps: caps(35, 30),
    systemPrompt: '',
  },
  /**
   * §6.1's startup smoke session — one turn, no tools, the cheapest tier.
   *
   * Not a department and not a role anybody assigns work to. It exists because
   * §6.1 requires it ("a 1-turn smoke session must succeed before the daemon
   * accepts work") and because of a second consequence nobody wrote down: it is
   * the **only way the usage meter is ever seeded on a fresh installation**.
   *
   * §7.1's official reading arrives from `control_request { get_usage }` on a
   * live session (ADR 0001), so with no sessions there are no samples; with no
   * samples `evaluateGuardian` fails closed into `wrap_up` (correctly — an
   * unreadable budget is not a safe budget); and in `wrap_up` the scheduler
   * starts nothing. A studio with nothing to sample can therefore never
   * discover that it has budget. This session is the one that breaks that
   * circle, which is why it runs *before* the guardian is consulted rather than
   * behind it (A58).
   *
   * Tools: none at all. It is a liveness probe and a budget reading, and every
   * tool it were granted would be one more thing that can fail in a check whose
   * whole value is telling us that nothing is wrong.
   */
  smoke: {
    id: 'smoke',
    role: 'staff',
    department: 'Betrieb',
    persona: persona(
      'Signal',
      'Bereitschaft',
      'You answer in one line and stop. Nobody is reading you for content.',
    ),
    tier: 'economy',
    workspace: 'scratch',
    allowedTools: [],
    mcpTools: [],
    // One turn and a budget cap an order of magnitude under any other role: a
    // smoke check that can cost real money has stopped being a smoke check.
    //
    // The wall clock is three minutes rather than the one this session needs,
    // and generously so on purpose. A cold CLI start on a host that is also
    // running GitLab can take a while, and this cap failing does not mean "the
    // probe took too long" — it means the daemon idles and accepts no work at
    // all (§6.1). Erring short here buys nothing and costs the studio a night.
    caps: { maxTurns: 1, maxBudgetUsd: 1, wallClockMs: 3 * 60_000 },
    systemPrompt: '',
  },
  // `satisfies` rather than an annotation, so each entry keeps its literal
  // `role`. The runner is generic over the role — `run(reviewer)` returns a
  // `ReviewerResult` with its `verdict` and its `claimsRespected`, not the union
  // of every role's contract — and an annotation of `Record<ProfileId,
  // AgentProfile>` would widen `role` to the union and take that away. The
  // alternative was a cast at every call site in the dev chain, which
  // type-checks and lies about what the value can do.
} satisfies Record<ProfileId, AgentProfile>;

// The prompt bodies live in `prompts.ts` and are attached here, so that the
// table above stays readable and a prompt cannot be defined for a profile that
// does not exist.
for (const profile of Object.values(AGENT_PROFILES)) {
  const body = ROLE_PROMPT_BODIES[profile.id];
  if (!body) throw new Error(`Rollenprompt für Profil "${profile.id}" fehlt.`);
  (profile as { systemPrompt: string }).systemPrompt = `${COMMON_RULES}\n\n---\n\n${body}`;
}

export const PROFILE_IDS = Object.keys(AGENT_PROFILES) as ProfileId[];

export function getProfile(id: ProfileId): AgentProfile {
  const profile = AGENT_PROFILES[id];
  if (!profile) throw new Error(`Unbekanntes Agentenprofil "${id}".`);
  return profile;
}

/**
 * Tier → CLI model alias (A8).
 *
 * Aliases rather than model ids, so that a retired model or a plan change does
 * not silently break a role at 3am.
 */
export const MODEL_ALIASES: Record<ModelTier, string> = {
  strong: 'opus',
  standard: 'sonnet',
  economy: 'haiku',
};

export interface ModelPolicy {
  /** A22 — the emergency low-budget profile. */
  sparbetrieb?: boolean;
  /** A8 — Controlling may override a role's tier. */
  overrides?: Partial<Record<ProfileId, ModelTier>>;
}

/**
 * Which tier this profile runs at right now.
 *
 * Sparbetrieb is applied as a **ceiling**, after any override. That direction
 * matters twice: an override cannot raise a role back above the emergency
 * profile — which would make the switch decorative — and an economy role is not
 * *promoted* to standard by an emergency measure.
 */
export function resolveTier(profile: AgentProfile, policy: ModelPolicy = {}): ModelTier {
  // The auditor's tier is not adjustable at runtime at all (§8.2) — not by
  // Sparbetrieb, and not by a Controlling override either. A22's emergency
  // profile takes his *frequency* instead, which is the right dial: an audit
  // that happens less often still audits, whereas one run by a weaker model
  // returns a verdict that reads identical and means less, and nothing
  // downstream can tell the difference. The override is refused for a sharper
  // reason: Controlling is itself an agent, and a studio able to quietly
  // downgrade the one check on its own claims has effectively removed it.
  // Changing this tier means changing the table below — a reviewed diff.
  if (profile.id === 'auditor') return profile.tier;

  const base = policy.overrides?.[profile.id] ?? profile.tier;
  if (!policy.sparbetrieb) return base;
  // A22's own exemption: everything merges through the Reviewer's gate.
  if (profile.id === 'reviewer') return base;
  return base === 'strong' ? 'standard' : base;
}

export function resolveModel(profile: AgentProfile, policy: ModelPolicy = {}): string {
  return MODEL_ALIASES[resolveTier(profile, policy)];
}

/** §6.2: `--settings /app/claude/settings.<role>.json`, written in step 4. */
export function roleSettingsPath(dir: string, id: ProfileId): string {
  return `${dir.replace(/\/+$/, '')}/settings.${id}.json`;
}

/**
 * The full `--allowedTools` list: built-ins, then MCP tools, then whatever the
 * project contributes.
 *
 * Order is preserved and duplicates dropped, so the argument vector is stable
 * for a given profile — which is what makes a spawn reproducible from the run
 * record rather than merely describable.
 */
export function sessionTools(profile: AgentProfile, extraTools: readonly string[] = []): string[] {
  const all = [...profile.allowedTools, ...whitelistNames(profile.mcpTools), ...extraTools];
  const seen = new Set<string>();
  const tools: string[] = [];
  for (const tool of all) {
    if (seen.has(tool)) continue;
    seen.add(tool);
    tools.push(tool);
  }
  return tools;
}

export interface SessionPaths {
  /** Directory holding `settings.<profile>.json` (§6.2). */
  roleSettingsDir: string;
  /**
   * The run's containment document (§6.6), written by `writeRunPolicy`.
   *
   * Required, unlike `mcpConfigPath`, and the asymmetry is the whole point. A
   * session without MCP is degraded: it cannot look up its task, and that is a
   * bad run. A session without containment is *dangerous*: it can write
   * anywhere the process can, and nothing downstream would notice until a
   * Reviewer read a diff that reached outside the claim set. The first is
   * allowed to happen and reported; the second cannot be expressed.
   */
  policyPath: string;
  /**
   * The run's `--mcp-config` document, or null when there is none.
   *
   * Per run, not per installation: the document carries the task id, which is
   * what binds a session to exactly one task (see `mcp-config.ts`). The runner
   * writes it with `writeMcpRunConfig` before the spawn and removes it after.
   * Null means the session runs without MCP — a role that cannot look up its
   * task, which is a degraded run rather than a failed one.
   */
  mcpConfigPath: string | null;
}

export interface BuildSessionSpecInput {
  profile: AgentProfile;
  runId: string;
  /** The task prompt. Built by the runner from the task's context. */
  prompt: string;
  /** Absolute: the task's worktree, or the role's scratch dir (§6.2). */
  cwd: string;
  paths: SessionPaths;
  policy?: ModelPolicy;
  /** A9 — persona flavour reaches a prompt only when the operator turns it on. */
  personaFlavor?: boolean;
  /**
   * Project-supplied Bash scopes: its gate and build commands (§11).
   *
   * Not baked into the profile, because §11 makes gate commands per-project
   * config discovered at onboarding. A profile that guessed `Bash(pnpm:*)`
   * would be both too wide for a project that uses make and useless to one
   * that uses cargo.
   */
  extraTools?: readonly string[];
  /**
   * Run caps for this session, when they differ from the profile's (A32).
   *
   * The runner passes a tightened set here (`tightenCaps`); nothing else should.
   * Absent means the profile's own caps, which is what every ordinary run uses.
   */
  caps?: RunCaps;
}

export class SessionSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionSpecError';
  }
}

/**
 * Turn a profile plus a task into something a `ModelBackend` can spawn (§6.2).
 *
 * Everything the CLI invocation needs is decided here, once, so that no caller
 * assembles flags by hand — that is the rule §6.0 exists to protect, and it
 * erodes one convenient exception at a time.
 */
export function buildSessionSpec(input: BuildSessionSpecInput): SessionSpec {
  const { profile, runId, prompt, cwd, paths } = input;

  if (!runId.trim()) throw new SessionSpecError('runId fehlt.');
  if (!prompt.trim()) {
    throw new SessionSpecError(
      `Sitzung für Profil "${profile.id}" hat keinen Auftrag — ein leerer Prompt ` +
        'würde eine Sitzung starten, die nichts zu tun hat, und trotzdem Budget kosten.',
    );
  }
  if (!cwd.startsWith('/')) {
    throw new SessionSpecError(
      `Arbeitsverzeichnis "${cwd}" ist nicht absolut. §6.2 knüpft das Fortsetzen ` +
        'einer Sitzung an genau dieses Verzeichnis; ein relativer Pfad hinge am ' +
        'Arbeitsverzeichnis des Daemons.',
    );
  }
  // `--allowedTools` is joined with commas, so a scope containing one would be
  // split into two half-scopes — and a half-scope like `Bash(pnpm run test`
  // grants nothing while looking like it grants something.
  const badScope = (input.extraTools ?? []).find((tool) => tool.includes(','));
  if (badScope) {
    throw new SessionSpecError(
      `Werkzeug-Scope "${badScope}" enthält ein Komma. Die Liste wird mit Kommas ` +
        'verbunden; der Scope würde zerteilt und wirkungslos.',
    );
  }
  if (!paths.policyPath.startsWith('/')) {
    throw new SessionSpecError(
      `Containment-Richtlinie "${paths.policyPath}" ist nicht absolut. Der Hook liest ` +
        'sie aus einem eigenen Prozess im Worktree der Sitzung; ein relativer Pfad ' +
        'zeigte dort ins Leere, und ein Hook ohne Richtlinie verweigert jeden ' +
        'Schreibzugriff (§6.6).',
    );
  }

  const systemPromptAppend = renderSystemPrompt(profile, {
    personaFlavor: input.personaFlavor ?? false,
  });

  return {
    runId,
    role: profile.id,
    prompt,
    systemPromptAppend,
    cwd,
    model: resolveModel(profile, input.policy),
    allowedTools: sessionTools(profile, input.extraTools),
    settingsPath: roleSettingsPath(paths.roleSettingsDir, profile.id),
    mcpConfigPath: paths.mcpConfigPath,
    env: sessionEnv(paths.policyPath),
    resultSchema: roleJsonSchema(profile.role),
    caps: input.caps ?? profile.caps,
  };
}

/**
 * The environment a session — and therefore its hooks — runs with (§6.6).
 *
 * Exactly one variable, and it is here rather than at the call site so that no
 * spawn can be assembled without it. The CLI passes its own environment to the
 * hook commands it runs (verified against the pinned CLI), which is what lets a
 * per-role settings file stay ignorant of any particular run.
 */
export function sessionEnv(policyPath: string): Record<string, string> {
  return { VORSCHICHT_RUN_POLICY: policyPath };
}

/**
 * The role prompt as it will be sent (§6.2, A9).
 *
 * Persona flavour is prepended only when enabled, and never replaces a rule —
 * A9's "quality must never compete with theater" is enforced by the shape:
 * flavour can add a sentence about temperament, it cannot edit the mandate.
 */
export function renderSystemPrompt(
  profile: AgentProfile,
  opts: { personaFlavor?: boolean } = {},
): string {
  if (!opts.personaFlavor) return profile.systemPrompt;
  return `You are ${profile.persona.name}. ${profile.persona.flavor}\n\n${profile.systemPrompt}`;
}
