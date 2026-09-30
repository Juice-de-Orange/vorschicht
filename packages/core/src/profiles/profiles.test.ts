/**
 * Invariants over the profile table (§8, §6.2, A8, A22).
 *
 * The interesting thing about these tests is that almost none of them assert a
 * value. A test that pins the Coder's tier to `sonnet` breaks the moment
 * Controlling exercises the override A8 explicitly grants it, and would have to
 * be edited to match — at which point it protects nothing. What is worth
 * asserting is the *shape*: that a read-only role has no way to write, that
 * every whitelisted MCP tool exists on the server, that Sparbetrieb cannot be
 * undone by an override, that a spawn cannot be assembled without a mandate.
 */
import { MCP_TOOLS, parseAgentResult, ROLE_RESULT_SCHEMAS } from '@vorschicht/shared';
import { describe, expect, it } from 'vitest';
import {
  AGENT_PROFILES,
  buildSessionSpec,
  getProfile,
  MODEL_ALIASES,
  PROFILE_IDS,
  renderSystemPrompt,
  resolveModel,
  resolveTier,
  roleSettingsPath,
  SessionSpecError,
  sessionTools,
} from './profiles.js';
import { MUTATING_TOOLS, profileWrites } from './types.js';

const PATHS = {
  roleSettingsDir: '/app/claude',
  mcpConfigPath: '/app/mcp/vorschicht.json',
  policyPath: '/data/runs/run-1/containment.json',
};

function specFor(id: (typeof PROFILE_IDS)[number], overrides = {}) {
  return buildSessionSpec({
    profile: getProfile(id),
    runId: 'run-1',
    prompt: 'Implementiere Aufgabe 42.',
    cwd: '/srv/vorschicht/worktrees/sandbox/task-42',
    paths: PATHS,
    ...overrides,
  });
}

describe('the profile table', () => {
  it('covers every department §8 names, plus the two roles it does not', () => {
    expect(PROFILE_IDS.sort()).toEqual([
      'auditor',
      'coder',
      // §8 row 10. Reads the meter and has no route to move it — §7.2's
      // thresholds are a safety device, and a session able to change them is a
      // session able to remove them.
      'controlling',
      'db',
      // A63: the same specialist, read-only, as §11's migration gate. Two
      // profiles rather than a mode flag, because the one thing that differs is
      // whether the session may write — and a gate that can change the tree it
      // judges is not a gate.
      'db-review',
      'debugger',
      // §8 row 7. The writing half of the department; §11's docs *gate* is a
      // judging session and would be its own read-only profile (A62.5, A63.3).
      'docs',
      // §8 row 5. The last of §8's departments and the one that unlocks §11's
      // `legal` gate — the one department with a result contract of its own,
      // because §14's "cite at or above L4" is a rule about something that has
      // to be machine-readable or it is not a rule (A44.3).
      'legal',
      // A70: §20's onboarding agent, read-only in a scratch directory — the
      // session that decides which checks will ever run against a repository
      // must not be one that repository can instruct.
      'onboarding',
      // §8 row 8. Advises; §12's engine is what deploys and rolls back.
      'ops',
      'planner',
      // §8 row 1. Goals become tasks with acceptance criteria here — A48.3
      // records what their absence costs the session that comes next.
      'product',
      // §8 row 3.
      'qa',
      // §8 row 6. The only profile with web access (§6.2, A18).
      'research',
      'reviewer',
      // §8 row 4. The one department A8 puts on the strongest tier.
      'security',
      // §6.1's start-up probe. Not a department — one turn, no tools, no task
      // — but it is a real spawned session and therefore a real profile (A58).
      'smoke',
      // §8 row 9.
      'ux',
    ]);
  });

  it('gives Legal a contract of her own, where the other eight share `staff`', () => {
    // §22's Phase 6 exit gate ends "with citations and trust levels shown in
    // the trace", and `staff` is status/summary/artifacts/followups — prose can
    // mention a source, and nothing can resolve one out of it. Asserted from
    // this side because the list below (`the shared staff contract`) is what
    // would silently swallow a Legal quietly demoted to `staff`, and with it
    // §14's only enforceable sentence.
    expect(getProfile('legal').role).toBe('legal');
    expect(ROLE_RESULT_SCHEMAS.legal).toBeDefined();
    expect(ROLE_RESULT_SCHEMAS.legal).not.toBe(ROLE_RESULT_SCHEMAS.staff);
  });

  it('gives every profile a result contract that exists', () => {
    for (const profile of Object.values(AGENT_PROFILES)) {
      expect(ROLE_RESULT_SCHEMAS[profile.role], profile.id).toBeDefined();
    }
  });

  it('whitelists only MCP tools the server actually offers', () => {
    // A whitelist naming a tool the server does not register does not fail
    // loudly — it produces an agent that cannot find out what it was asked to
    // do. Hence one home for the names, and this test over it.
    for (const profile of Object.values(AGENT_PROFILES)) {
      for (const tool of profile.mcpTools) {
        expect(Object.keys(MCP_TOOLS), `${profile.id} → ${tool}`).toContain(tool);
      }
    }
  });

  it('lets every role that serves a task read its context and park a note', () => {
    for (const profile of Object.values(AGENT_PROFILES)) {
      // The probe serves no task (A58), so `task.get_context` would answer
      // nothing — and A48.1 makes the channel task-scoped by construction, so
      // there is no id it could pass. A tool granted here would be one the
      // session spends a turn discovering is useless. Onboarding is the same
      // case for the same reason (A70): it analyses a repository, not a task,
      // so it spawns without MCP entirely (A56.5).
      if (profile.id === 'smoke' || profile.id === 'onboarding') continue;
      expect(profile.mcpTools, profile.id).toContain('task.get_context');
      expect(profile.mcpTools, profile.id).toContain('task.append_note');
    }
  });

  it('gives the roles that judge work a way to file a finding', () => {
    // §11: findings travel through `finding.report`, never through an edit.
    expect(getProfile('reviewer').mcpTools).toContain('finding.report');
    expect(getProfile('debugger').mcpTools).toContain('finding.report');
    expect(getProfile('db').mcpTools).toContain('finding.report');
  });

  it('keeps every role that judges, advises or plans unable to write', () => {
    // §8.1: the Reviewer's verdict is a gate artefact, and a reviewer that can
    // edit is a reviewer that can make its own findings disappear. The Debugger
    // is read-only for a different reason — a fix from it would arrive
    // unplanned, unclaimed and unreviewed.
    // The auditor is read-only for a third reason (§8.2): whoever can make a
    // finding disappear must not be the one deciding whether it is real.
    //
    // Security is the sharpest case of the first reason and the reason it is
    // named here rather than left to the code: the scan configuration decides
    // whether a secret is found at all (A104.5 measured the same scanner
    // reporting nothing over the same token without its rule file), so a role
    // that could edit it could silence its own gate — and a silenced scan and a
    // clean one produce the same green.
    //
    // UX judges a diff (the Reviewer's reason). Ops advises while §12's engine
    // acts, Controlling reads a meter it must not move, Research reports on the
    // world, Product proposes a decomposition, and onboarding and db-review are
    // both gates in front of something (A70.3, A63.3). Every one of them is
    // read-only in the code already; listing them here is what makes that a
    // guarantee rather than a coincidence of which tools somebody happened to
    // grant.
    for (const id of [
      'planner',
      'reviewer',
      'debugger',
      'auditor',
      'db-review',
      'onboarding',
      'security',
      'ux',
      'ops',
      'controlling',
      'research',
      'product',
      // §8 row 5. She is §11's `legal` gate, so the Reviewer's reason applies
      // unchanged — and sharper: a legal opinion that could edit the thing it
      // is judging could remove the clause it objected to and approve itself.
      'legal',
    ] as const) {
      expect(profileWrites(getProfile(id)), id).toBe(false);
      for (const tool of MUTATING_TOOLS) {
        expect(getProfile(id).allowedTools, id).not.toContain(tool);
      }
    }
  });

  it('grants the auditor no way to record anything in git either (§8.2)', () => {
    // `profileWrites` only watches the file-editing tools. An auditor with
    // `git add`/`git commit` could still put its own correction into the tree,
    // which is the separation this role is built around.
    for (const tool of getProfile('auditor').allowedTools) {
      expect(tool, 'auditor').not.toMatch(/^Bash\(git (add|commit|restore|checkout|reset)/);
    }
  });

  it('runs the auditor outside the repository it examines (§8.2)', () => {
    // Not a convenience. A dev-chain session sits inside the worktree so the
    // project's own CLAUDE.md loads as instructions (§6.2) — for an auditor
    // that would let the repository under examination instruct its examiner.
    expect(getProfile('auditor').workspace).toBe('scratch');
  });

  it('grants the auditor no shell at all, because a scratch cwd has no git (A56)', () => {
    // The consequence of the test above, and the reason it is asserted rather
    // than left implicit: a `Bash(git log:*)` entry would run in the session's
    // own directory, which belongs to no repository, so every call would answer
    // "not a git repository". That is a tool that cannot work — a signal path
    // that reads as covered and cannot carry a signal, which is precisely what
    // audit domain 6 exists to find. Git evidence is gathered by the collectors
    // and quoted with the command beside its output.
    expect(getProfile('auditor').allowedTools).toEqual(['Read', 'Grep', 'Glob']);
  });

  it('does not let the auditor stop to ask, because its report is its authority', () => {
    // §8.2: escalation parks the session until the operator answers, and an audit that
    // halts halfway delivers no report at all. The consequences of a verdict
    // are raised by the orchestrator from the finished result instead.
    expect(getProfile('auditor').mcpTools).not.toContain('escalate.ask');
  });

  it('lets the roles that produce code write', () => {
    expect(profileWrites(getProfile('coder'))).toBe(true);
    expect(profileWrites(getProfile('db'))).toBe(true);
    // §8 gives QA "writes/maintains unit/integration/E2E" and Doku "READMEs,
    // CHANGELOG, ADRs". A QA role that could only report would file a finding
    // saying "this needs a test" — work nobody has done, dressed as work that
    // was. Asserted from this side too, because the list above is what would
    // silently swallow either of them.
    expect(profileWrites(getProfile('qa'))).toBe(true);
    expect(profileWrites(getProfile('docs'))).toBe(true);
  });

  it('grants no shell at all to a role that runs outside a repository (A56)', () => {
    // The auditor's case, generalised, because there are now seven scratch
    // profiles rather than one. A `Bash(git log:*)` entry runs in the session's
    // *own* directory, which for these belongs to no repository, so every call
    // answers "not a git repository" — a tool that reads as covered and cannot
    // carry a signal, which is audit domain 6 in the table that decides what a
    // session may do. Their git and filesystem evidence is gathered for them
    // and quoted with the command beside its output.
    for (const profile of Object.values(AGENT_PROFILES)) {
      if (profile.workspace !== 'scratch') continue;
      for (const tool of profile.allowedTools) {
        expect(tool, profile.id).not.toMatch(/^Bash\(/);
      }
    }
  });

  it('grants the open web to Research and Legal and to nobody else (§6.2, §14, A18)', () => {
    // §6.2 names `WebSearch,WebFetch` when it gives the Research role as an
    // *example* of a whitelist. The restriction is not distrust of the other
    // roles: a session whose mandate is one diff has no business fetching a
    // URL, and every extra tool is another way for a turn to be spent outside
    // the mandate.
    //
    // Legal is the second grantee and the reason is §14 rather than
    // convenience: L5 — "RIS/Gesetzestexte" — is the citation-grade level, and
    // Austrian legal text lives on the web. Without a fetch the role cannot
    // produce the one thing §8 row 5 says it produces ("works from the document
    // vault + L5 sources with citations").
    //
    // Asserted in both directions, since only the negative half can be lost by
    // accident — and a third grantee should be a decision somebody wrote down
    // rather than a line that slipped into a profile.
    for (const id of ['research', 'legal'] as const) {
      expect(getProfile(id).allowedTools, id).toContain('WebSearch');
      expect(getProfile(id).allowedTools, id).toContain('WebFetch');
    }
    for (const profile of Object.values(AGENT_PROFILES)) {
      if (profile.id === 'research' || profile.id === 'legal') continue;
      expect(profile.allowedTools, profile.id).not.toContain('WebSearch');
      expect(profile.allowedTools, profile.id).not.toContain('WebFetch');
    }
  });

  it('gives §8’s departments the shared staff contract rather than a private one', () => {
    // The eight arrive on `staff` — the base result shape of status, summary,
    // artifacts and followups — which is what makes their prompts responsible
    // for saying which of those three fields a decomposition, a radar finding
    // or a weekly report belongs in. A new department quietly taking a
    // dev-chain contract would inherit fields (`claimSet`, `verdict`) that
    // nothing on its path reads. Legal is the ninth department and the one
    // exception, asserted separately above — she has a contract of her own
    // because §14's threshold needs citations something can resolve.
    const departments = [
      'product',
      'qa',
      'security',
      'research',
      'docs',
      'ops',
      'ux',
      'controlling',
    ] as const;
    expect(departments).toHaveLength(8);
    for (const id of departments) expect(getProfile(id).role, id).toBe('staff');
  });

  it('grants no shell command that could read a file behind the hooks', () => {
    // §6.6's read hygiene is a PreToolUse hook and a hook sees the tool that
    // was invoked. `Read` on a `.env` can be denied cleanly; `cat` on the same
    // file can only be pattern-matched. So the shell readers are not granted.
    const forbidden = ['cat', 'head', 'tail', 'sed', 'awk', 'less', 'more', 'strings', 'xxd'];
    for (const profile of Object.values(AGENT_PROFILES)) {
      for (const tool of profile.allowedTools) {
        const scope = /^Bash\(([^:)]+)/.exec(tool)?.[1];
        if (!scope) continue;
        expect(forbidden, `${profile.id} → ${tool}`).not.toContain(scope.split(' ')[0]);
      }
    }
  });

  it('grants nobody a push — putting work on a branch is the merge queue’s job', () => {
    for (const profile of Object.values(AGENT_PROFILES)) {
      for (const tool of profile.allowedTools) {
        expect(tool, profile.id).not.toMatch(/^Bash\(git push/);
      }
    }
  });

  it('caps every run three ways, with a budget backstop proportional to turns (A32)', () => {
    for (const profile of Object.values(AGENT_PROFILES)) {
      expect(profile.caps.maxTurns, profile.id).toBeGreaterThan(0);
      expect(profile.caps.wallClockMs, profile.id).toBeGreaterThan(60_000);
      expect(profile.caps.maxBudgetUsd, profile.id).not.toBeNull();
      expect(profile.caps.maxBudgetUsd ?? 0, profile.id).toBeGreaterThan(0);
    }
  });

  it('runs the whole dev chain inside the task worktree (§6.2)', () => {
    // §6.2 splits sessions two ways: dev-chain roles run in the task's worktree
    // so the project's own conventions load, staff roles in a scratch dir so
    // they stay deterministic. All three exceptions here are staff by that
    // definition — the auditor deliberately (§8.2 independence rule 2), the
    // probe because it has no task and therefore no worktree to run in, and
    // onboarding for the auditor's reason applied to a project that is not one
    // yet (A70): loading its `CLAUDE.md` as system context would let it
    // instruct the session that decides which checks it gets.
    // The four departments added here follow the same rule and split on what
    // the session's subject is: QA, Security, Doku and UX read or write a diff
    // and belong in the worktree; Produktleitung reads a goal, Research reads
    // the open web, Ops reads an incident record and Controlling the event log —
    // none of which is a repository, and all of which reach one by absolute
    // path where they need to (A70.1).
    // Legal is the one *gate* among them, and therefore the interesting entry:
    // `db-review` is a gate too and sits in the worktree so `git diff` has a
    // repository to answer about. §6.2 names Legal among the staff sessions
    // that run in a scratch dir, and the containment argument is the auditor's
    // (§8.2 rule 2, A70.1) with real force — a codebase whose `CLAUDE.md`
    // loaded as system context would be instructing the session that renders a
    // DSGVO verdict about it. It reads the candidate by absolute path instead.
    const staff = new Set([
      'auditor',
      'smoke',
      'onboarding',
      'product',
      'research',
      'ops',
      'controlling',
      'legal',
    ]);
    for (const profile of Object.values(AGENT_PROFILES)) {
      if (staff.has(profile.id)) continue;
      expect(profile.workspace, profile.id).toBe('worktree');
    }
  });

  it('refuses an unknown profile by name', () => {
    // This case used to ask for `legal`, which was the profile §8 named and
    // this table did not have. It has one now, so the id had to become one that
    // is genuinely absent — and the replacement is deliberately a plausible
    // neighbour of a real department rather than nonsense, because a guard that
    // only refuses `xxx` says nothing about the mistake anybody makes.
    // @ts-expect-error — the point is the runtime guard, not the type
    expect(() => getProfile('compliance')).toThrow(/Unbekanntes Agentenprofil/);
  });
});

describe('model mapping (A8, A22)', () => {
  it('maps tiers to aliases, never to pinned model ids', () => {
    // A pinned `claude-opus-5-20260214` in a profile goes off the day the model
    // is retired — unattended, at night, in a role whose job is catching other
    // people's mistakes.
    for (const alias of Object.values(MODEL_ALIASES)) {
      expect(alias).not.toMatch(/\d{8}|-\d+-\d+/);
    }
  });

  it('follows A8: strong for Planner, Reviewer and Security, standard for the Coder', () => {
    expect(resolveTier(getProfile('planner'))).toBe('strong');
    expect(resolveTier(getProfile('reviewer'))).toBe('strong');
    expect(resolveTier(getProfile('security'))).toBe('strong');
    expect(resolveTier(getProfile('coder'))).toBe('standard');
  });

  it('puts §8’s other departments on the standard tier, and none of them on economy', () => {
    // A8 reserves the economy tier for "bulk chores (log digests, tagging)" — a
    // chore, not a department. Every one of these produces a judgement somebody
    // acts on unattended, and a cheaper model returns one that reads identical
    // and means less, which is the failure nothing downstream can detect. The
    // assertion is the negative one: `standard` is what the table says today,
    // and `economy` is what must not arrive by way of a budget conversation.
    for (const id of ['product', 'qa', 'research', 'docs', 'ops', 'ux', 'controlling'] as const) {
      expect(resolveTier(getProfile(id)), id).toBe('standard');
      expect(resolveTier(getProfile(id), { sparbetrieb: true }), id).not.toBe('economy');
    }
  });

  it('lets Controlling override a role', () => {
    const policy = { overrides: { planner: 'standard' as const } };
    expect(resolveTier(getProfile('planner'), policy)).toBe('standard');
    expect(resolveModel(getProfile('planner'), policy)).toBe(MODEL_ALIASES.standard);
  });

  it('drops every strong role to standard under Sparbetrieb — except the two checks', () => {
    // A22 exempts the Reviewer; §8.2 adds the auditor and takes his *frequency*
    // instead. Both are the checks everything else passes through, and
    // downgrading them saves budget by making the studio worse at noticing that
    // it has got worse.
    const policy = { sparbetrieb: true };
    expect(resolveTier(getProfile('planner'), policy)).toBe('standard');
    expect(resolveTier(getProfile('debugger'), policy)).toBe('standard');
    expect(resolveTier(getProfile('db'), policy)).toBe('standard');
    // Security too, and it is the one that feels wrong to write down: A22 names
    // exactly one exemption and §8.2 adds the auditor, so an emergency profile
    // that quietly kept Security strong would be an exemption nobody decided.
    expect(resolveTier(getProfile('security'), policy)).toBe('standard');
    expect(resolveTier(getProfile('reviewer'), policy)).toBe('strong');
    expect(resolveTier(getProfile('auditor'), policy)).toBe('strong');
  });

  it('refuses to lower the auditor by any runtime route at all (§8.2)', () => {
    // Controlling is itself an agent. If it can downgrade the one check on the
    // studio's own claims, the studio can quietly remove that check — and the
    // resulting verdict reads exactly like a real one. So neither the override
    // nor the combination with Sparbetrieb moves it.
    const auditor = getProfile('auditor');
    expect(resolveTier(auditor, { overrides: { auditor: 'economy' } })).toBe('strong');
    expect(resolveTier(auditor, { overrides: { auditor: 'standard' } })).toBe('strong');
    expect(resolveTier(auditor, { sparbetrieb: true, overrides: { auditor: 'economy' } })).toBe(
      'strong',
    );
    expect(resolveModel(auditor, { sparbetrieb: true })).toBe(MODEL_ALIASES.strong);
  });

  it('does not let an override raise a role back above Sparbetrieb', () => {
    // Otherwise the emergency switch is decorative: anything Controlling had
    // already pushed up would stay up exactly when the budget is short.
    const policy = { sparbetrieb: true, overrides: { coder: 'strong' as const } };
    expect(resolveTier(getProfile('coder'), policy)).toBe('standard');
  });

  it('does not promote an economy role under Sparbetrieb', () => {
    const policy = { sparbetrieb: true, overrides: { coder: 'economy' as const } };
    expect(resolveTier(getProfile('coder'), policy)).toBe('economy');
  });
});

describe('sessionTools', () => {
  it('qualifies MCP tools the way the CLI expects', () => {
    expect(sessionTools(getProfile('reviewer'))).toContain('mcp__vorschicht__finding_report');
  });

  it('appends the project’s own gate commands (§11)', () => {
    const tools = sessionTools(getProfile('coder'), ['Bash(pnpm test:*)', 'Bash(pnpm build:*)']);
    expect(tools).toContain('Bash(pnpm test:*)');
    expect(tools).toContain('Edit');
  });

  it('is stable and duplicate-free, so a spawn is reproducible from the record', () => {
    const tools = sessionTools(getProfile('coder'), ['Read', 'Bash(pnpm test:*)', 'Read']);
    expect(tools).toEqual([...new Set(tools)]);
    expect(sessionTools(getProfile('coder'), ['Read'])).toEqual(sessionTools(getProfile('coder')));
  });
});

describe('buildSessionSpec', () => {
  it('produces a spec the backend can spawn', () => {
    const spec = specFor('coder');
    expect(spec.model).toBe(MODEL_ALIASES.standard);
    expect(spec.settingsPath).toBe('/app/claude/settings.coder.json');
    expect(spec.mcpConfigPath).toBe('/app/mcp/vorschicht.json');
    expect(spec.caps).toEqual(getProfile('coder').caps);
    expect(spec.systemPromptAppend).toContain('Your role: **Coder**');
  });

  it('carries the result contract as a value, not a path (ADR 0002)', () => {
    // The pinned CLI parses `--json-schema` as JSON and rejects a filename with
    // "Unrecognized token '/'". A spec that carried a path would produce a run
    // that dies at startup, every time, for every role.
    const spec = specFor('planner');
    expect(typeof spec.resultSchema).toBe('object');
    expect(spec.resultSchema).not.toBeNull();
    expect(JSON.stringify(spec.resultSchema)).toContain('claimSet');
  });

  it('gives each role its own contract', () => {
    expect(JSON.stringify(specFor('reviewer').resultSchema)).toContain('claimsRespected');
    expect(JSON.stringify(specFor('coder').resultSchema)).not.toContain('claimsRespected');
  });

  it('emits a contract the role parser accepts, for the fields it requires', () => {
    // Both layers of §6.3 describe one contract; this is the cheap half of
    // proving they agree.
    const schema = specFor('planner').resultSchema as { required?: string[] };
    for (const field of schema.required ?? []) {
      expect(['status', 'summary', 'claimSet', 'plan']).toContain(field);
    }
    expect(parseAgentResult('planner', { status: 'done', summary: 's' }).ok).toBe(false);
  });

  it('refuses a session with no mandate', () => {
    expect(() => specFor('coder', { prompt: '   ' })).toThrow(SessionSpecError);
  });

  it('refuses a relative working directory', () => {
    // §6.2 scopes resume to the directory a session started in; a relative path
    // would hang that on the daemon's cwd.
    expect(() => specFor('coder', { cwd: 'worktrees/task-42' })).toThrow(/nicht absolut/);
  });

  it('refuses a tool scope containing a comma', () => {
    // The list is joined with commas, so the scope would be split into two
    // halves that grant nothing while looking like they grant something.
    expect(() => specFor('coder', { extraTools: ['Bash(pnpm test:*),Bash(x)'] })).toThrow(/Komma/);
  });

  it('keeps persona flavour out of the prompt unless it is switched on (A9)', () => {
    expect(specFor('coder').systemPromptAppend).not.toContain('You are Clara');
    expect(specFor('coder', { personaFlavor: true }).systemPromptAppend).toContain('You are Clara');
  });

  it('lets flavour add to the mandate but never replace it', () => {
    const plain = renderSystemPrompt(getProfile('reviewer'));
    const flavoured = renderSystemPrompt(getProfile('reviewer'), { personaFlavor: true });
    expect(flavoured).toContain(plain);
    expect(flavoured.length).toBeGreaterThan(plain.length);
  });

  /**
   * A9, made mechanical — and this is the assertion the Phase 6 exit gate turns
   * on ("personas verifiably cost nothing").
   *
   * Not "does not contain the name", which is what the case above checks for one
   * profile and which a prompt could pass while still differing by a space, a
   * heading, or a reordered paragraph. **Byte-identical**, and for every profile
   * rather than for one: the flavour is prepended by a single function, so a
   * change that leaked it would leak it everywhere — and a spot check on the
   * Coder would be a spot check on the one profile somebody remembered.
   *
   * This is what makes the A/B comparison in `docs/personas-ab-vergleich.md` a
   * *documented observation* rather than the evidence. Two runs can only show
   * that two prompts behaved alike; this shows they were the same bytes.
   */
  it('sends byte-identical prompts with personas off, for every profile (A9)', () => {
    for (const id of PROFILE_IDS) {
      const profile = getProfile(id);
      expect(specFor(id).systemPromptAppend).toBe(profile.systemPrompt);
      expect(renderSystemPrompt(profile)).toBe(profile.systemPrompt);
      expect(renderSystemPrompt(profile, { personaFlavor: false })).toBe(profile.systemPrompt);
    }
  });

  /**
   * The other half, and it has to be asserted or the one above is satisfied by a
   * `renderSystemPrompt` that ignores its argument entirely.
   *
   * Every profile again: a persona whose flavour never reached a prompt would be
   * a switch that does nothing for that role — the dead wiring §8.2's sixth
   * domain hunts, and indistinguishable from the guarantee above.
   */
  it('reaches every profile’s prompt when it is switched on', () => {
    for (const id of PROFILE_IDS) {
      const profile = getProfile(id);
      const flavoured = specFor(id, { personaFlavor: true }).systemPromptAppend;
      expect(flavoured).not.toBe(profile.systemPrompt);
      expect(flavoured).toContain(profile.persona.name);
      expect(flavoured).toContain(profile.persona.flavor);
      // Adds, never edits (A46's last paragraph): the mandate survives whole,
      // and survives *at the end*, so nothing was appended after it either.
      expect(flavoured.endsWith(profile.systemPrompt)).toBe(true);
    }
  });
});

describe('roleSettingsPath', () => {
  it('follows §6.2’s naming', () => {
    expect(roleSettingsPath('/app/claude', 'reviewer')).toBe('/app/claude/settings.reviewer.json');
  });

  it('tolerates a trailing slash rather than producing a double one', () => {
    expect(roleSettingsPath('/app/claude/', 'coder')).toBe('/app/claude/settings.coder.json');
  });
});
