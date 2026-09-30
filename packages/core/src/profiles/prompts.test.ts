/**
 * What the role prompts must say (§6.2, §6.6, §10, §15).
 *
 * Prompt text is not code and cannot be typechecked, so the rules that would be
 * expensive to lose are asserted here instead. Deliberately no assertion on
 * wording: these check that a *rule* is present, not that a sentence is
 * phrased a particular way, because the second kind of test turns every
 * improvement to a prompt into a test edit and is therefore quietly deleted.
 */
import {
  auditFindingClassSchema,
  auditVerdictSchema,
  CLAIM_GLOB_SYNTAX,
  CLAIM_GLOB_SYNTAX_EN,
  CLAIM_GLOB_TOKENS,
} from '@vorschicht/shared';
import { describe, expect, it } from 'vitest';
import { AGENT_PROFILES, getProfile } from './profiles.js';
import { COMMON_RULES, ROLE_PROMPT_BODIES } from './prompts.js';
import type { ProfileId } from './types.js';

/**
 * Prompts are hard-wrapped, so a rule can fall across a line break and a
 * multi-word pattern then fails for a reason that has nothing to do with the
 * rule being present. Match against a single-spaced rendering instead: rewrapping
 * a paragraph should not turn a test red.
 */
const flat = (text: string): string => text.replaceAll(/\s+/g, ' ');

describe('the rules every role carries', () => {
  it('appears in every role prompt exactly once', () => {
    for (const profile of Object.values(AGENT_PROFILES)) {
      const occurrences = profile.systemPrompt.split(COMMON_RULES).length - 1;
      expect(occurrences, profile.id).toBe(1);
    }
  });

  it('states the containment rule and that it is enforced (§6.6)', () => {
    // An agent that does not know the rule spends its turns discovering it, and
    // turns are the budget.
    expect(flat(COMMON_RULES)).toMatch(/read/i);
    expect(flat(COMMON_RULES)).toMatch(/write/i);
    expect(flat(COMMON_RULES)).toMatch(/enforced before a tool runs/i);
  });

  it('lists the secret patterns from the single source (§6.6/A21)', () => {
    expect(COMMON_RULES).toContain('.env');
    expect(COMMON_RULES).toContain('id_ed25519*');
    expect(COMMON_RULES).toContain('.git-credentials');
  });

  it('states §11 without a warning mode', () => {
    expect(flat(COMMON_RULES)).toMatch(/blocker/i);
    expect(flat(COMMON_RULES)).toMatch(/no warning mode/i);
  });

  it('teaches the §15 escalation format, in German, with a recommendation', () => {
    expect(flat(COMMON_RULES)).toMatch(/escalate\.ask/);
    expect(flat(COMMON_RULES)).toMatch(/2 to 4/);
    expect(flat(COMMON_RULES)).toMatch(/recommendation/i);
    expect(flat(COMMON_RULES)).toMatch(/German/);
  });

  it('names all four result statuses (§6.3)', () => {
    for (const status of ['done', 'needs_decision', 'failed', 'parked']) {
      expect(COMMON_RULES, status).toContain(`\`${status}\``);
    }
  });

  it('describes parking the way §7.3 does — never mid-edit', () => {
    expect(flat(COMMON_RULES)).toMatch(/never stop mid-edit/i);
  });
});

describe('the Planner prompt', () => {
  const prompt = flat(getProfile('planner').systemPrompt);

  it('teaches the claim grammar from the single source (§10)', () => {
    // A Planner taught a grammar that has drifted from the validator produces
    // plans the registry rejects — and the rejection arrives as a failed plan,
    // not as a syntax error someone reads.
    for (const line of CLAIM_GLOB_SYNTAX_EN) expect(prompt).toContain(flat(line));
  });

  it('warns about both ways a claim set goes wrong', () => {
    // Too wide serialises the project behind one task; too narrow blocks the
    // Coder on a file it may not touch. A prompt that names only one of the two
    // reliably produces the other.
    expect(prompt).toMatch(/nothing more/i);
    expect(prompt).toMatch(/serialises/i);
    expect(prompt).toMatch(/tests and documentation/i);
    expect(prompt).toMatch(/cannot be widened/i);
  });

  it('says overlapping claims serialise rather than parallelise', () => {
    expect(prompt).toMatch(/overlap/i);
    expect(prompt).toMatch(/one after the other/i);
  });

  it('names the four artefacts §8.1 asks a Planner for', () => {
    for (const artefact of ['plan', 'claimSet', 'testPlan', 'risks']) {
      expect(prompt, artefact).toContain(artefact);
    }
  });
});

describe('the Coder prompt', () => {
  const prompt = flat(getProfile('coder').systemPrompt);

  it('requires the project’s own checks to be run before handover (§8.1)', () => {
    expect(prompt).toMatch(/run the project's own checks/i);
    expect(prompt).toMatch(/coverage must not decrease/i);
  });

  it('forbids committing to the integration branch (§7.3)', () => {
    expect(prompt).toMatch(/never commit to the project's integration branch/i);
  });

  it('routes unclaimed files to a stop, not to a workaround (§10)', () => {
    expect(prompt).toMatch(/unclaimed/i);
    expect(prompt).toMatch(/do not touch it/i);
  });
});

describe('the Reviewer prompt', () => {
  const prompt = flat(getProfile('reviewer').systemPrompt);

  it('makes the claim-compliance check the Reviewer’s own (§10)', () => {
    // The gate wants this layer to work when the hooks are bypassed via Bash,
    // so the prompt has to say the check is independent of them.
    expect(prompt).toMatch(/claims\.list/);
    expect(prompt).toMatch(/independently of the hooks/i);
    expect(prompt).toMatch(/shell command can step around/i);
  });

  it('sets the approval bar at unattended deployment (§12)', () => {
    expect(prompt).toMatch(/without anyone looking at it again/i);
  });

  it('tells the Reviewer not to file taste as a finding (§11)', () => {
    // Everything reported is a blocker here, so a preference filed as a finding
    // stops a merge.
    expect(prompt).toMatch(/preference/i);
  });
});

describe('the specialist prompts', () => {
  it('makes the Debugger diagnose rather than fix (§8 row 2a)', () => {
    const prompt = flat(getProfile('debugger').systemPrompt);
    expect(prompt).toMatch(/diagnosis, not a fix/i);
    expect(prompt).toMatch(/reproduce/i);
    expect(prompt).toMatch(/interrupted/i);
  });

  it('makes the DB specialist reason from the running release (§12/A24)', () => {
    const prompt = flat(getProfile('db').systemPrompt);
    expect(prompt).toMatch(/backward-compatible/i);
    expect(prompt).toMatch(/migrate, then swap/i);
    expect(prompt).toMatch(/expand and contract/i);
    expect(prompt).toMatch(/append-only/i);
  });
});

describe('the Betriebsprüfer prompt (§8.2)', () => {
  const prompt = flat(getProfile('auditor').systemPrompt);

  it('puts the evidence before the claim, in that order', () => {
    // The single most important instruction in this prompt: reading the
    // author's summary first anchors the auditor to the author's frame, which
    // is the failure the whole department exists to catch.
    expect(prompt).toMatch(/read the evidence before the claim/i);
    expect(prompt).toMatch(/assertion under examination, never an input/i);
  });

  it('separates it from the Reviewer rather than duplicating them', () => {
    expect(prompt).toMatch(/a second code review adds nothing/i);
  });

  it('permits an empty result and forbids an unevidenced one', () => {
    expect(prompt).toMatch(/finding nothing is a correct outcome/i);
    expect(prompt).toMatch(/no quota/i);
    expect(prompt).toMatch(/cite it or drop it/i);
  });

  it('requires the coverage gaps to be reported as loudly as the findings', () => {
    expect(prompt).toMatch(/scopeLimits/);
    expect(prompt).toMatch(/an area nobody examined is not a clean one/i);
  });

  it('offers exactly the verdicts the schema accepts, and no others', () => {
    // Prompt and contract are two descriptions of one closed set, so they can
    // drift — and the drift is silent: a model told about a fourth verdict
    // simply fails validation, and §6.3 spends its one repair attempt on it.
    const verdicts = auditVerdictSchema.options;
    expect(verdicts).toHaveLength(3);
    for (const verdict of verdicts) expect(prompt, verdict).toContain(verdict);
    expect(prompt).toMatch(/hedging between them is not available/i);
  });

  it('names every finding class the schema knows', () => {
    for (const cls of auditFindingClassSchema.options) expect(prompt, cls).toContain(cls);
  });

  it('states the limits of its own authority', () => {
    expect(prompt).toMatch(/you fix nothing/i);
    expect(prompt).toMatch(/cannot pause the studio/i);
  });

  it('writes to the operator in German, like every other user-facing text (§2)', () => {
    expect(prompt).toMatch(/Prüfbericht.*in German/i);
  });
});

/**
 * §8's eight departments, asserted against the **body** rather than the whole
 * prompt.
 *
 * Two reasons, and the first is a real hazard rather than tidiness. Every
 * profile's `systemPrompt` is `COMMON_RULES` plus its body, and the common rules
 * already say "every finding is a blocker", "written in German", "read", "write"
 * — so a role assertion phrased with any of those passes against an **empty**
 * role prompt, and reads exactly like one that checked something. Matching the
 * body makes each of these a statement about the role's own text.
 *
 * The second: the file header's rule is that these check for a *rule*, not for a
 * wording, so that improving a prompt does not turn a test red. Where a short
 * phrase *is* the rule's name — the way the Debugger's "diagnosis, not a fix"
 * and the DB specialist's "expand and contract" already are above — it is
 * matched as written. Everything secondary is matched on the one distinctive
 * word it cannot lose without losing the rule.
 */
const body = (id: ProfileId): string => {
  // `ROLE_PROMPT_BODIES` is keyed loosely, so this could be `undefined` — and
  // `flat(undefined)` would throw somewhere unhelpful. The id is typed and
  // `profiles.ts` already refuses at import to attach a missing body, so this
  // never fires; it is here to make the type honest rather than cast it away.
  const text = ROLE_PROMPT_BODIES[id];
  if (!text) throw new Error(`Rollenprompt für Profil "${id}" fehlt.`);
  return flat(text);
};

describe('the Produktleitung prompt (§8 row 1)', () => {
  const prompt = body('product');

  it('makes acceptance criteria the thing it is for (A48.3)', () => {
    // A title is not a mandate. The next session is handed what this one wrote
    // and has to know what "done" means without asking — the gap A48.3 records
    // and migration 0010 opened the column for.
    expect(prompt).toMatch(/acceptance criteria/i);
    expect(prompt).toMatch(/observabl/i);
    expect(prompt).toMatch(/guess/i);
  });

  it('ties task size to the claim set rather than to effort (§10)', () => {
    // The obvious cut is by topic, and it produces two tasks whose claims
    // overlap — which are then run one after the other anyway, for the price of
    // a second plan and a second review.
    expect(prompt).toMatch(/claim set/i);
    expect(prompt).toMatch(/one after the other|serialis/i);
  });

  it('warns against priority inflation', () => {
    expect(prompt).toMatch(/P0/);
    expect(prompt).toMatch(/inflation/i);
  });

  it('says where the decomposition goes, since the staff contract has no field for it', () => {
    // `staff` is status/summary/artifacts/followups. Without an instruction the
    // structure lands wherever the model puts it, and whoever reads `followups`
    // as candidate tasks gets prose about them.
    expect(prompt).toMatch(/followups/);
    expect(prompt).toMatch(/summary/);
  });

  it('says it is not inside the repository (A70.1)', () => {
    expect(prompt).toMatch(/scratch/i);
    expect(prompt).toMatch(/absolute path/i);
  });
});

describe('the QA prompt (§8 row 3)', () => {
  const prompt = body('qa');

  it('requires a test to have been seen failing (§8.2 domain 3)', () => {
    // "Could this test ever fail" is the audit domain that has found the most
    // here, and the cheapest honest answer is to break the thing and look.
    expect(prompt).toMatch(/pass without the change/i);
    expect(prompt).toMatch(/mutation/i);
  });

  it('teaches that a green exit code is not a suite that ran (A61, A79.4)', () => {
    // The same defect in two repositories: 285 integration cases skipping
    // themselves here, and 60% of a backend suite skipping itself in the pilot project —
    // both exiting 0. A gate reading only the exit code reports green forever.
    expect(prompt).toMatch(/skips? itself/i);
    expect(prompt).toMatch(/exit code/i);
  });

  it('forbids weakening a test instead of fixing it (§11)', () => {
    expect(prompt).toMatch(/never weaken a test/i);
    expect(prompt).toMatch(/toleran/i);
    expect(prompt).toMatch(/coverage/i);
  });

  it('asks for both directions of an assertion (A92.3)', () => {
    // A check that can only report success reads exactly like one that can
    // fail; a one-sided assertion here once survived its own mutation.
    expect(prompt).toMatch(/both directions/i);
  });

  it('rules out what makes a red gate meaningless at three in the morning', () => {
    expect(prompt).toMatch(/determinist/i);
    expect(prompt).toMatch(/sleep/i);
  });
});

describe('the Security prompt (§8 row 4)', () => {
  const prompt = body('security');

  it('says why this role in particular may not write (A104.5)', () => {
    // The general rule is that a judge who can edit can erase its own finding.
    // Here it is sharper and was measured: without its rule file the same
    // scanner reports nothing over the same token, so an editable configuration
    // is a gate that can be silenced into looking clean.
    expect(prompt).toMatch(/do not fix/i);
    expect(prompt).toMatch(/silenc/i);
  });

  it('forbids quoting a credential even as evidence (§18, §6.6)', () => {
    // The event log is kept forever, so a secret quoted in a finding is a
    // second leak in the place least likely to be cleaned up.
    expect(prompt).toMatch(/credential/i);
    expect(prompt).toMatch(/quote/i);
    expect(prompt).toMatch(/rotation/i);
  });

  it('states that a scan which could not run is not a clean scan (A104.4)', () => {
    expect(prompt).toMatch(/not a clean scan/i);
    expect(prompt).toMatch(/empty list/i);
  });

  it('makes an advisory a question about reachability, not a severity score', () => {
    expect(prompt).toMatch(/reachab/i);
    expect(prompt).toMatch(/read the advisory/i);
  });

  it('keeps hardening ideas out of the finding channel (§11)', () => {
    expect(prompt).toMatch(/hardening/i);
    expect(prompt).toMatch(/followups/);
  });
});

describe('the Legal prompt (§8 row 5)', () => {
  const prompt = body('legal');

  it('says it is not inside the repository (§6.2, A70.1)', () => {
    // A relative read in a scratch dir finds an empty directory, and the
    // session then reports in good faith that the change contains nothing.
    expect(prompt).toMatch(/scratch/i);
    expect(prompt).toMatch(/absolute path/i);
  });

  it('teaches §14’s threshold as the rule it is', () => {
    expect(prompt).toMatch(/L4/);
    expect(prompt).toMatch(/L5/);
    expect(prompt).toMatch(/corroborat/i);
  });

  it('says the citations are resolved afterwards, not taken on trust', () => {
    // The file header's second rule. A session that does not know its ids are
    // checked spends turns discovering it, and an invented one costs a whole
    // review instead of a sentence.
    expect(prompt).toMatch(/resolves every id you write against the registry/i);
    expect(prompt).toMatch(/the registry's is what counts/i);
  });

  it('keeps the three ways a citation fails apart', () => {
    // `checkCitation` distinguishes them because the remedies differ: cite
    // something that exists, wait for it to be accepted, or corroborate it.
    expect(prompt).toMatch(/fabricated reference/i);
    expect(prompt).toMatch(/has not accepted/i);
    expect(prompt).toMatch(/may run alongside/i);
  });

  it('makes overstating a level the finding, and understating harmless (A54.2)', () => {
    expect(prompt).toMatch(/than the registry grants is a finding/i);
    expect(prompt).toMatch(/understating costs nothing/i);
  });

  it('separates the vault from the registry, because they are not interchangeable', () => {
    // §13 holds what the law is applied *to*; §14 holds what may be cited. A
    // session that conflated them would "cite" the Statuten with a vault id and
    // produce a citation that resolves to nothing.
    expect(prompt).toMatch(/docs\.search/);
    expect(prompt).toMatch(/a vault document is not a source/i);
  });

  it('forbids the invented provision this role fails by', () => {
    // The Research role's failure mode, sharper: a plausible paragraph number
    // is indistinguishable from a real one to the next reader, who acts on it.
    expect(prompt).toMatch(/did not read/i);
    expect(prompt).toMatch(/locator/i);
  });

  it('makes it say where the law stops and its reading begins', () => {
    expect(prompt).toMatch(/not a lawyer/i);
    expect(prompt).toMatch(/unsettled|discretion/i);
  });

  it('writes the assessment to the operator in German (§2)', () => {
    expect(prompt).toMatch(/the assessment itself, in German/i);
  });
});

describe('the Research prompt (§8 row 6)', () => {
  const prompt = body('research');

  it('forbids the invented detail this role fails by', () => {
    // A version number that reads plausibly becomes an automatic task (A10)
    // that upgrades to a release which does not exist.
    expect(prompt).toMatch(/did not read/i);
    expect(prompt).toMatch(/could not establish/i);
  });

  it('teaches §14’s trust levels with the rule that L1 carries nothing', () => {
    expect(prompt).toMatch(/L5/);
    expect(prompt).toMatch(/L1/);
    expect(prompt).toMatch(/load-bearing/i);
    expect(prompt).toMatch(/corroborat/i);
  });

  it('states A10’s policy, so a finding names its own consequence', () => {
    expect(prompt).toMatch(/patch/i);
    expect(prompt).toMatch(/major/i);
    expect(prompt).toMatch(/advisor/i);
  });

  it('carries the two standing watches §6.0 and A27 ask for', () => {
    // The billing watch is why this department is not optional; the CLI half
    // has to say that a release is never an automatic upgrade, because the pin
    // is deliberate and a bump is reviewed like any dependency change.
    expect(prompt).toMatch(/billing/i);
    expect(prompt).toMatch(/automatic upgrade/i);
  });

  it('says it is not inside the repository (A70.1)', () => {
    expect(prompt).toMatch(/scratch/i);
    expect(prompt).toMatch(/absolute path/i);
  });
});

describe('the Doku prompt (§8 row 7)', () => {
  const prompt = body('docs');

  it('states the failure only a human or the auditor can catch (A76.4)', () => {
    // No test reads prose. An over-claiming sentence is invisible to every
    // check in this repository and is believed by the next reader.
    expect(prompt).toMatch(/worse than a missing one/i);
    expect(prompt).toMatch(/unverified/i);
  });

  it('separates intent from fact', () => {
    expect(prompt).toMatch(/intent as fact/i);
  });

  it('requires an ADR to carry what was rejected', () => {
    expect(prompt).toMatch(/rejected/i);
  });

  it('says to correct rather than erase (A71, A82.1)', () => {
    // Rewriting the record so the first pass looks right costs the one thing an
    // archive is for.
    expect(prompt).toMatch(/do not erase/i);
  });
});

describe('the Ops prompt (§8 row 8)', () => {
  const prompt = body('ops');

  it('draws the line between advising and operating (§12)', () => {
    // The engine deploys and rolls back deterministically. A rollback decided
    // by a session, on evidence it assembled itself, is a second outage.
    expect(prompt).toMatch(/the engine acts/i);
    expect(prompt).toMatch(/second outage/i);
  });

  it('carries the alert-cadence rule this project has learned four times', () => {
    // A67.6, A86.5, A98.2, A102: a channel that fires every pass gets muted,
    // and then the next real alert is invisible.
    expect(prompt).toMatch(/muted/i);
    expect(prompt).toMatch(/fires/i);
  });

  it('refuses the two shapes of making a symptom go away', () => {
    expect(prompt).toMatch(/disabling a check/i);
    expect(prompt).toMatch(/widening a permission/i);
  });

  it('states §18’s backup and prune rules, including what is never pruned', () => {
    expect(prompt).toMatch(/untested backup/i);
    expect(prompt).toMatch(/never pruned/i);
  });

  it('keeps A25’s distinction, since it decides whether a task goes red', () => {
    expect(prompt).toMatch(/the machine is broken/i);
  });
});

describe('the UX prompt (§8 row 9)', () => {
  const prompt = body('ux');

  it('makes §2’s German rule this role’s job, because nothing else checks it', () => {
    // There is no mechanical checker for user-facing language anywhere in this
    // system, including for a string that arrives from a library default.
    expect(prompt).toMatch(/every string a person reads/i);
    expect(prompt).toMatch(/aria-label/i);
  });

  it('says the automated scan is the smaller half', () => {
    expect(prompt).toMatch(/smaller half/i);
    expect(prompt).toMatch(/focus order/i);
    expect(prompt).toMatch(/colour alone/i);
  });

  it('names the three states an interface must not collapse (A88.7)', () => {
    // An empty list that means two different things tells someone their data is
    // gone when the server merely did not answer.
    expect(prompt).toMatch(/could not load/i);
    expect(prompt).toMatch(/still loading/i);
  });

  it('keeps taste out of the finding channel (§11)', () => {
    expect(prompt).toMatch(/taste/i);
    expect(prompt).toMatch(/preference/i);
  });
});

describe('the Controlling prompt (§8 row 10)', () => {
  const prompt = body('controlling');

  it('separates reading the meter from moving it (§7.2)', () => {
    expect(prompt).toMatch(/do not move it/i);
    expect(prompt).toMatch(/remove them/i);
  });

  it('forbids the inference that cost this studio seven days (A101)', () => {
    // A vendor warning says the account is above a threshold; it does not say
    // the limit equals what has been spent. Made once, it lowered a weekly
    // budget from 1120 to 3 and stopped everything for a week.
    expect(prompt).toMatch(/never infer a ceiling/i);
    expect(prompt).toMatch(/seven days/i);
  });

  it('requires recomputation rather than quotation (§8.2 domain 8)', () => {
    expect(prompt).toMatch(/recompute/i);
    expect(prompt).toMatch(/event log/i);
    expect(prompt).toMatch(/wrong until/i);
  });

  it('keeps official and estimated readings apart (§7.1)', () => {
    expect(prompt).toMatch(/estimate/i);
  });

  it('states §16’s report rules, including the empty Betriebsprüfung section', () => {
    expect(prompt).toMatch(/metric-first/i);
    expect(prompt).toMatch(/filler/i);
    expect(prompt).toMatch(/Betriebsprüfung/);
  });
});

describe('prompt hygiene', () => {
  it('defines a body for every profile and no orphans', () => {
    expect(Object.keys(ROLE_PROMPT_BODIES).sort()).toEqual(Object.keys(AGENT_PROFILES).sort());
  });

  it('keeps prompts substantial but not unbounded', () => {
    // A role prompt is prepended to every turn of every session, so its length
    // is a recurring cost, not a one-off one.
    for (const profile of Object.values(AGENT_PROFILES)) {
      expect(profile.systemPrompt.length, profile.id).toBeGreaterThan(1500);
      expect(profile.systemPrompt.length, profile.id).toBeLessThan(12_000);
    }
  });

  it('keeps the two renderings of the claim grammar in step', () => {
    // Two descriptions of one grammar is a drift risk; this is the guard.
    expect(CLAIM_GLOB_SYNTAX_EN).toHaveLength(CLAIM_GLOB_SYNTAX.length);
    expect(CLAIM_GLOB_SYNTAX_EN).toHaveLength(CLAIM_GLOB_TOKENS.length);
    CLAIM_GLOB_TOKENS.forEach((token, index) => {
      expect(CLAIM_GLOB_SYNTAX[index]).toContain(`\`${token}\``);
      expect(CLAIM_GLOB_SYNTAX_EN[index]).toContain(`\`${token}\``);
    });
  });
});
