/**
 * What an agent profile *is* (§8, §6.2).
 *
 * §8 defines a department as "one or more agent profiles: a role system prompt,
 * a tool whitelist, a model tier, entry triggers, and output contracts". This
 * file is that sentence as a type, with two additions the spec implies rather
 * than states:
 *
 *  - `workspace`, because §6.2 splits sessions into dev-chain sessions that run
 *    inside the task's worktree and staff sessions that run in a scratch dir,
 *    and the runner has to know which it is holding.
 *  - `writes`, derived rather than declared, because §6.6 makes "a writing run
 *    with zero hook events is a failed run" a runtime check and something has to
 *    answer whether this run was a writing one.
 *
 * Entry triggers are deliberately *not* here. §8 lists them, but a trigger is a
 * scheduler rule about when to start a profile, not a property of the profile;
 * putting it here would make the profile table the second place where the
 * scheduler's logic lives.
 */
import { type McpToolName, MUTATING_TOOLS, type RoleName, type RunCaps } from '@vorschicht/shared';

// One list, defined where the containment hook can reach it without importing
// this package. A second copy here would be the drift that decides whether a
// tool is contained and whether a run counts as a writing one — two answers to
// one question, in the two places that must never disagree.
export { MUTATING_TOOLS };

/**
 * Model tiers (A8), named by capability rather than by model.
 *
 * Aliases, not model ids: A8 asks for "aliases so plan changes don't break it",
 * and a pinned `claude-opus-5-20260214` in a profile is a time bomb that goes
 * off the day a model is retired — during an unattended night, in a role whose
 * whole purpose is to catch other people's mistakes.
 */
export type ModelTier = 'strong' | 'standard' | 'economy';

/** §6.2: dev-chain sessions run in the task's worktree, staff in a scratch dir. */
export type Workspace = 'worktree' | 'scratch';

/**
 * Every profile §8 names, plus the two this system needs and §8 does not list.
 *
 * The five dev-chain roles and the auditor arrived in Phase 2 — `auditor` ahead
 * of the other staff (§8.2, A52), because from that phase onward every phase
 * closes with a Betriebsprüfung and an auditor arriving in Phase 6 would let
 * Phases 2–5 close unexamined. The nine department profiles at the end are
 * Phase 6 step 1; `smoke` and `onboarding` belong to no department at all.
 */
export type ProfileId =
  | 'planner'
  | 'coder'
  | 'reviewer'
  | 'debugger'
  | 'db'
  /**
   * Milo again, read-only, as §11's migration gate (A63).
   *
   * Two profiles rather than a mode flag, because the two runs differ in the
   * one property that must not be a parameter: `db` designs a migration and
   * therefore writes, `db-review` judges one and therefore must not. A single
   * profile with the editing tools would be a gate able to change the tree it
   * is judging — the shape §8.1 already refuses for the Reviewer.
   */
  | 'db-review'
  /**
   * §20's onboarding agent, §11's "gate proposal agent".
   *
   * Built in Phase 3 with the gates system it proposes, and read-only in a
   * scratch directory for the auditor's reason (A56, §8.2 rule 2): a repository
   * that could load its own `CLAUDE.md` as system context would be instructing
   * the agent that decides which checks will ever run against it.
   */
  | 'onboarding'
  | 'auditor'
  /**
   * §8 row 1 — Produktleitung, Petra. Goals become tasks here.
   *
   * Exists because §9 starts at a task with acceptance criteria and nothing in
   * this studio produces one: `goals` is an entity in §5 with no decomposer.
   * A48.3 records what the absence costs — a session handed a title has to
   * guess what "done" means, which is what §1 principle 6 forbids.
   *
   * The same persona as `onboarding` at a second desk, the way `db` and
   * `db-review` are one specialist twice (A63.3): one reads a repository that
   * is not yet a project, the other reads a goal for one that is.
   */
  | 'product'
  /**
   * §8 row 3 — QA/Testing, Quentin.
   *
   * Exists because §11's test gate asks whether a suite is green and cannot ask
   * whether it is worth anything. A61 and A79.4 are the same defect in two
   * repositories: a suite that skipped most of itself and still exited 0. That
   * question needs a session, and it needs one that writes tests rather than
   * merely reporting on them.
   */
  | 'qa'
  /**
   * §8 row 4 — Security, Sasha. Strong tier by A8, read-only by construction.
   *
   * Exists for the questions §11's mechanical security gates cannot ask: is the
   * scan configured to look where the secrets are, is the advisory's code path
   * reachable here, does this feature widen an attack surface nobody named.
   */
  | 'security'
  /**
   * §8 row 5 — Legal/Compliance, Lena. The last profile of §8's table, and the
   * one that unlocks §11's `legal` gate.
   *
   * Exists because §14 states a rule — "Legal/compliance outputs must cite
   * sources with level ≥ L4" — that until now lived only in prose, and a rule
   * that depends on everyone remembering it is not a rule (A44.3). She is the
   * one department with a result contract of her own (`legal`), because a
   * citation whose trust level is checkable is the whole substance of that rule
   * and no `staff` field can hold one.
   *
   * Read-only, and in a scratch directory: §6.2 names Legal among the staff
   * sessions that run in a per-role scratch dir, and the containment reason is
   * the auditor's (§8.2 rule 2, A70.1) with real force here — a repository whose
   * `CLAUDE.md` loaded as system context would be instructing the session that
   * renders a DSGVO verdict about it. The candidate is read by absolute path.
   */
  | 'legal'
  /**
   * §8 row 6 — Research/Radar, Rado.
   *
   * Exists because §6.0 makes an Anthropic billing change this project's #1
   * external risk and A27 forbids automatic CLI updates: both need something
   * that watches and reports rather than acts. A10's dependency policy and
   * §14's source proposals are the same shape.
   */
  | 'research'
  /**
   * §8 row 7 — Doku & Archiv, Doris.
   *
   * Exists because A62.5 built only the mechanical half of §11's docs gate —
   * "did the change carry documentation" — and said in as many words that "is
   * *the right* document now stale" needs judgement and is hers. She writes:
   * the READMEs, the CHANGELOG and the ADRs are the artefact, not a report
   * about one.
   */
  | 'docs'
  /**
   * §8 row 8 — Ops/SRE, Otto. Advises; never operates.
   *
   * Exists to read what a deploy, a health check or a backup actually did and
   * say what happened. §12's engine performs the deploy and the rollback
   * deterministically, and that division is the reason this profile has no
   * shell: a rollback decided by a language model is a second outage.
   */
  | 'ops'
  /**
   * §8 row 9 — UX/A11y, Uli. Read-only, like every role that judges a diff.
   *
   * Exists because axe answers roughly a third of the accessibility questions
   * and none of the interface ones, and because §2 makes every string a person
   * reads German — a rule with no mechanical checker anywhere in this system.
   */
  | 'ux'
  /**
   * §8 row 10 — Controlling, Konrad. Reads the meter; never moves it.
   *
   * Exists for §16's weekly report and §7.1's quality metrics. It has no way to
   * change a threshold, a budget or the guardian's state, and that is the whole
   * design: A101 is what one wrong inference about a limit costs — seven days
   * of a stopped studio — and a session able to act on such an inference would
   * have made it permanent instead of loud.
   */
  | 'controlling'
  | 'smoke';

/**
 * Display identity (§8, A9).
 *
 * Personas are display-only by default and the flavour text reaches a prompt
 * only when the operator turns it on. That is why `flavor` is English while `name` and
 * `desk` are what the office view renders — the first is agent-facing, the other
 * two are user-facing (§2).
 */
export interface Persona {
  /** Office-view name, e.g. "Paul". */
  readonly name: string;
  /** German desk label for the office view, e.g. "Planung". */
  readonly desk: string;
  /** Prompt flavour, injected only when `personaFlavorInPrompts` is on (A9). */
  readonly flavor: string;
  /**
   * Further names for the same profile at another desk.
   *
   * §8 seats two coders — Clara and Chris — because the default concurrency is
   * two (A7). That is one profile at two desks, not two profiles, and the
   * office view needs the second name without the model mapping gaining a
   * second entry to drift.
   */
  readonly alternates?: readonly string[];
}

export interface AgentProfile {
  readonly id: ProfileId;
  /** Which result contract applies (§6.3). Several profiles may share one. */
  readonly role: RoleName;
  /** German department label from §8's table. */
  readonly department: string;
  readonly persona: Persona;
  readonly tier: ModelTier;
  readonly workspace: Workspace;
  /**
   * Built-in tools this role may use (§6.2). MCP tools are listed separately
   * and appended by `sessionTools`, because their fully-qualified form is the
   * CLI's convention and no profile should have to spell it out.
   */
  readonly allowedTools: readonly string[];
  readonly mcpTools: readonly McpToolName[];
  readonly caps: RunCaps;
  /** The role prompt, appended to Claude Code's own system prompt (§6.2). */
  readonly systemPrompt: string;
}

/**
 * Does this profile write?
 *
 * Derived from the whitelist rather than declared, so that widening a role's
 * tools cannot quietly leave a `writes: false` flag behind it. The runner uses
 * the answer for §6.6's liveness rule: a writing run that produced no hook
 * event ran without containment and must be treated as failed, not as done.
 *
 * Bash is deliberately not counted. Every role that has Bash at all can in
 * principle change a file through it — §6.6 says so and calls it the accepted
 * limit — but that is an argument for keeping shell scopes narrow, not for
 * declaring every role a writer and thereby making the flag mean nothing.
 */
export function profileWrites(profile: AgentProfile): boolean {
  return profile.allowedTools.some((tool) => (MUTATING_TOOLS as readonly string[]).includes(tool));
}
