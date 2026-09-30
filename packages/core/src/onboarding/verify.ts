/**
 * Checking an onboarding proposal before anybody is asked to approve it (§20).
 *
 * §20 ends with "the operator confirms/edits via one multiple-choice escalation", and the
 * whole value of that step depends on what is put in front of him being true.
 * A proposal is a model's opinion about a repository, and parts of it are
 * **judgement** — which gate set fits, how finely to split work — while other
 * parts are **mechanical facts** the model merely reported: does the script it
 * named exist, does the branch it named exist, does the glob it wrote parse.
 * This file checks the second kind and leaves the first alone. That is A54.2's
 * posture, one department over: a model's claim about a mechanical fact is the
 * weakest evidence available for it, and here the fact is cheap to establish.
 *
 * It matters more than it looks. A gate command naming a script that does not
 * exist produces a gate that **never blocks and never goes red**: the binary
 * starts, the script is missing, and A25 classifies "nothing ran" as an
 * infrastructure failure to retry (A55.3). The project then merges nothing, the
 * task sits in the queue, and the only signal is an Ops alert three retries
 * later that names a registry outage. Months after onboarding, in a project
 * nobody is watching. One `package.json` read at proposal time removes the
 * class.
 *
 * Three refusals and three notes, and the split is deliberate:
 *
 *  - **Refused** — a named script that the manifest does not declare, a gate
 *    configuration the §11 validator rejects, a tool scope that would be split
 *    by the CLI's own argument joining. Each is something we *know* is wrong.
 *  - **Noted** — a command we cannot check (a binary, a stack with no manifest),
 *    a locked gate left without a command, a gate or a deploy method that is
 *    correct and not yet buildable. Each is something we do not know, and
 *    silence about it would read as approval.
 */
import {
  type ClaimGranularity,
  type GateId,
  gateDefinition,
  gateUnavailableReason,
  isGateId,
  type OnboardingResult,
  type ProjectGateConfig,
  validateProjectGateConfig,
} from '@vorschicht/shared';
import type { RepositorySurvey } from './survey.js';

/** Command runners whose first script-shaped argument is a manifest entry. */
const PACKAGE_MANAGERS = new Set(['pnpm', 'npm', 'yarn', 'bun']);

/** Sub-commands of those runners that execute a binary rather than a script. */
const BINARY_SUBCOMMANDS = new Set(['exec', 'dlx', 'x', 'run-script']);

/**
 * Programs whose first non-flag argument is a file in the repository.
 *
 * `bun` and `deno` are absent deliberately: `bun` is already a package manager
 * above and never reaches here, and `deno run` takes a URL as readily as a path.
 */
const INTERPRETERS = new Set(['node', 'python', 'python3', 'ruby', 'sh', 'bash']);

/**
 * Flags that select one package or directory.
 *
 * pnpm: `--filter` / `-F` (a package name or pattern).
 * npm:  `--prefix` / `-C` (a directory), `--workspace` / `-w` (a name).
 *
 * `-C` is unambiguous here because this set is only consulted when the command
 * starts with one of `PACKAGE_MANAGERS`; `make -C dir` never reaches it.
 */
const SELECTOR_FLAGS = new Set(['--filter', '-F', '--prefix', '-C', '--workspace', '-w']);

/** Flags that mean "in every workspace package". `pnpm -r test`. */
const RECURSIVE_FLAGS = new Set(['-r', '--recursive', '--workspaces', '-ws']);

/**
 * §12 methods this onboarding may write into a stored configuration today.
 *
 * A70.4 deferred everything but `none`, because before Phase 5 the merge queue
 * refused a project whose method it could not execute — a project configured
 * `compose` would have been one that could not merge at all. **That reason
 * expired when Phase 5 closed**, and the sentence the deferral printed
 * ("die Deployment-Maschine entsteht erst in Phase 5") became false while
 * nothing failed: every project onboarded since would have been silently
 * configured `none`, i.e. its pipeline would end at the merge with production
 * never touched. §8.2's fourth domain — an assumption nobody revisits is a
 * decision that quietly stopped being true — found in the same pass that
 * retired the `legal` deferral (A115), because both were A70.4's.
 *
 * `compose` is in, and `static-rsync` deliberately is not. The engine carries
 * both (A87, and A89 proves the compose journey against a real daemon), so the
 * distinction is not about what is built: a `static-rsync` deploy needs a target
 * host, and A99 records that only the operator can name it. Writing that method with no
 * target produces a configuration whose first deploy fails at the machine rather
 * than at the proposal — so it stays deferred, under its *true* reason.
 */
export const IMPLEMENTED_DEPLOY_METHODS = new Set(['none', 'compose']);

export interface VerifiedCommand {
  gate: GateId;
  command: string;
  /** `declared` — found in the project's own manifest. `unverifiable` — noted. */
  status: 'declared' | 'unverifiable' | 'undeclared';
  /** German, one sentence. What was checked and what it said. */
  detail: string;
}

export interface DeferredItem {
  /** Gate id, or `deploy`. */
  subject: string;
  /** German: why this is right and not yet applicable. */
  reason: string;
}

export interface VerifiedProposal {
  ok: boolean;
  /** German, one per refusal. Empty when `ok`. */
  errors: string[];
  /** German, one per thing the reader should know. Never a refusal. */
  notes: string[];
  /** The document to store, present exactly when `ok`. */
  config: ProjectGateConfig | null;
  /** What §10 cuts task branches from, after the survey has had its say. */
  defaultBranch: string | null;
  claimGranularity: ClaimGranularity;
  /** `{ method: 'none', … }` until Phase 5, with the recommendation preserved. */
  deployConfig: Record<string, unknown>;
  commands: VerifiedCommand[];
  /** Gates and deploy methods that are right and not yet buildable. */
  deferred: DeferredItem[];
  /** Locked gates §11 will run with no command — a finding on the first merge. */
  missingCommands: GateId[];
}

/**
 * Turn a proposal into a storable configuration, or say why it cannot be one.
 *
 * Pure: it takes the survey and the result and returns a verdict. Everything
 * that reads a file happened in the survey, which is what lets this be tested
 * against a fixture rather than against a repository.
 */
export function verifyProposal(
  survey: RepositorySurvey,
  result: OnboardingResult,
): VerifiedProposal {
  const errors: string[] = [];
  const notes: string[] = [];
  const deferred: DeferredItem[] = [];
  const commands: VerifiedCommand[] = [];

  const scripts = declaredScripts(survey);
  const makeTargets = declaredMakeTargets(survey);

  const gates: Partial<Record<GateId, boolean>> = {};
  const commandMap: Partial<Record<GateId, string>> = {};

  for (const entry of result.gates) {
    if (!isGateId(entry.id)) {
      // The contract already constrains this to the catalogue, so reaching here
      // means the schema and the catalogue have drifted. Refused rather than
      // dropped: a silently ignored gate id is a check nobody notices is off.
      errors.push(`„${entry.id}" ist kein Gate aus dem Katalog nach §11.`);
      continue;
    }
    const definition = gateDefinition(entry.id);

    const unavailable = gateUnavailableReason(definition);
    if (entry.enabled && unavailable) {
      // Right and not yet buildable. `resolveGates` would drop it anyway; the
      // difference is that this says so to the person deciding, instead of
      // letting the gate quietly not appear in the stored configuration.
      deferred.push({
        subject: entry.id,
        reason: `„${definition.label}" ist vorgeschlagen und noch nicht verfügbar: ${unavailable} Begründung des Vorschlags: ${entry.rationale}`,
      });
      continue;
    }
    if (entry.enabled && !definition.locked) gates[entry.id] = true;
    // A proposal that switches a locked gate **off** is written into the
    // document as the `false` it is, so §11's own validator refuses it by name
    // rather than this file silently ignoring it. That refusal is the Phase 3
    // exit gate ("baseline gates verified non-removable"), and it only exists
    // because the attempt is expressible (A62.1) — dropping it here would take
    // the attempt away and with it the proof.
    if (definition.locked && !entry.enabled) gates[entry.id] = false;

    const command = entry.command?.trim();
    if (!command) continue;
    if (!definition.needsCommand) {
      notes.push(
        `Für „${definition.label}" wurde ein Befehl vorgeschlagen, aber Vorschicht führt ` +
          'diese Prüfung selbst aus; der Befehl wird nicht übernommen.',
      );
      continue;
    }
    const verdict = verifyCommand(entry.id, command, { scripts, makeTargets, survey });
    commands.push(verdict);
    if (verdict.status === 'undeclared') errors.push(verdict.detail);
    if (verdict.status === 'unverifiable') notes.push(verdict.detail);
    const missing = missingProgramme(command);
    if (missing !== null) {
      notes.push(
        `Der Befehl für „${definition.label}" (\`${command}\`) beginnt mit \`${missing}\`, und ` +
          'dieses Programm liegt nicht im Orchestrator-Image. Der Gate-Lauf kann dort nicht ' +
          'starten — was nach A25 ein Infrastrukturfehler wäre, wird zusammen mit einem ' +
          'einzigen anderen Befund zu einem roten Kandidaten (A50). Entweder das Image ' +
          'ergänzen oder einen anderen Befehl wählen.',
      );
    }
    // Kept in the map even when it was refused, so §11's validator does not add
    // a second complaint — "kein Befehl hinterlegt" beside "der Befehl existiert
    // nicht" describes one problem as two and sends the reader looking for a
    // second one. The document is discarded whenever anything was refused.
    commandMap[entry.id] = command;
  }

  // §11's six run whatever the document says, so a locked gate without a command
  // is not "off" — it is a gate that reports a finding on the very first merge
  // attempt. Named here because that is the one thing a reader of this proposal
  // would otherwise discover from a blocked merge weeks later.
  const missingCommands: GateId[] = [];
  for (const id of ['typecheck', 'lint', 'test', 'build'] as const) {
    if (!commandMap[id]) missingCommands.push(id);
  }
  if (missingCommands.length > 0) {
    notes.push(
      `Ohne Befehl bleiben: ${missingCommands
        .map((id) => `„${gateDefinition(id).label}"`)
        .join(', ')}. Diese Gates gehören zum gesperrten Grundgerüst nach §11 und sind ` +
        'damit nicht abgewählt, sondern ungeprüft — sie melden beim ersten Merge einen ' +
        'Befund, nicht grün.',
    );
  }

  for (const tool of result.tools) {
    // The same refusal `buildSessionSpec` makes, made earlier. `--allowedTools`
    // is joined with commas, so a scope containing one is split into two
    // half-scopes — and a half-scope grants nothing while looking like it does.
    if (tool.includes(',')) {
      errors.push(
        `Der Werkzeug-Scope „${tool}" enthält ein Komma. Die Liste wird mit Kommas ` +
          'verbunden; der Scope würde zerteilt und wirkungslos.',
      );
    }
  }

  const validation = validateProjectGateConfig({
    gates,
    commands: commandMap,
    tools: result.tools,
    migrationPaths: result.migrationPaths,
  });
  if (!validation.ok || !validation.config) errors.push(...validation.errors);

  const deployConfig = resolveDeploy(result, deferred);
  const defaultBranch = resolveDefaultBranch(survey, result, notes);

  if (survey.gaps.length > 0) {
    notes.push(
      `Die Erhebung selbst hatte Lücken: ${survey.gaps.join(' · ')} Der Vorschlag ist ` +
        'in diesen Punkten nicht besser belegt als die Erhebung.',
    );
  }

  // **Kein Repository ist keine Lücke, sondern das Ende der Prüfbarkeit.**
  //
  // Die übrigen Lücken sind Notizen, und das ist richtig: eine unlesbare
  // GitHub-Workflow-Datei macht einen Vorschlag ärmer, nicht falsch. Ohne git
  // fällt dagegen **alles** weg, worauf dieser Vorschlag beruht — es gibt keine
  // Dateiliste (also prüft `verifyCommand` nichts und antwortet auf jeden
  // Befehl „unverifiable"), keinen Integrationszweig (§10 schneidet jeden
  // Aufgabenzweig davon ab) und keine Worktrees.
  //
  // Gemessen am 5.9.2026 beim ersten echten Lauf des Läufers: eine Einhängung,
  // die git wegen fremder Dateikennung verweigerte, ergab eine leere Erhebung
  // — und `verifyProposal` nannte den Vorschlag trotzdem **übernehmbar**, weil
  // seine eigenen Prüfungen bestanden hatten. `defaultBranch` stand auf `main`,
  // geraten aus dem Modellvorschlag statt gelesen aus dem Repository. Ein
  // `--apply-lauf` darauf hätte ein Projekt mit vier unbelegten Gate-Befehlen
  // angelegt, und §11s gesperrte sechs hätten es auf ewig blockiert.
  //
  // Ein Vorschlag, der auf nichts beruht und „übernehmbar" heisst, ist die
  // teuerste Form dieses Fehlers: er sieht aus wie eine Entlastung.
  if (!survey.git.isRepository) {
    errors.push(
      'Das Verzeichnis ist kein lesbares git-Repository. Damit gibt es keine Dateiliste, ' +
        'gegen die ein Gate-Befehl geprüft werden könnte, und keinen Integrationszweig, ' +
        'von dem §10 Aufgabenzweige abschneiden kann — der Vorschlag beruht dann auf ' +
        'nichts und wird nicht übernommen.',
    );
  }

  return {
    ok: errors.length === 0,
    errors,
    notes,
    config: errors.length === 0 ? (validation.config ?? null) : null,
    defaultBranch,
    claimGranularity: result.claimGranularity,
    deployConfig,
    commands,
    deferred,
    missingCommands,
  };
}

/**
 * What a gate command can actually spawn inside the orchestrator container.
 *
 * `verifyCommand` below answers whether the *project* declares the script. That
 * is one half. The other half is whether the programme in front of it exists
 * where `GateSuite` will run it — and nothing asked, so the studio shipped with
 * all four of its own gate commands starting with a `pnpm` the runtime image
 * did not have. Three of them failed to spawn (`infra`), the fourth exited 2
 * (a **finding** under A50), and because merge-queue takes the infra branch
 * only when there are no findings, every candidate would have gone red on its
 * first attempt with a machine fault in its learnings note.
 *
 * This list is the second half, and it is deliberately a **note** rather than a
 * fourth status: the image can gain a programme, this file cannot see the image
 * at run time, and refusing a correct proposal is the expensive direction (A72,
 * A80 — twice now). `gate-programme.test.ts` holds it against the runtime stage
 * of `Dockerfile.orchestrator`, so the two cannot drift silently.
 */
export const ORCHESTRATOR_PROGRAMMES: ReadonlySet<string> = new Set([
  // From the base image, node:22-bookworm-slim.
  'node',
  'npm',
  'npx',
  'corepack',
  'sh',
  'bash',
  // apt, runtime stage.
  'ca-certificates',
  'curl',
  'git',
  'openssh-client',
  'ripgrep',
  'tini',
  // Installed by name.
  'gitleaks',
  'claude',
  'pnpm',
]);

/**
 * The programme a gate command would spawn, when the image does not have it.
 *
 * `null` for everything that is fine, which includes every path into the
 * repository: `infra/scripts/with-test-db.sh` is spawned as a file and answers
 * to `verifyCommand`'s file check, not to PATH.
 */
export function missingProgramme(command: string): string | null {
  const head = command.trim().split(/\s+/)[0] ?? '';
  if (head.length === 0 || head.includes('/')) return null;
  return ORCHESTRATOR_PROGRAMMES.has(head) ? null : head;
}

/**
 * Does the project itself declare what this command runs?
 *
 * Three answers, and the middle one is why this is not a boolean. `declared` is
 * a fact we established; `undeclared` is a fact we established the other way and
 * is the only one that refuses; `unverifiable` is honest ignorance — a `cargo
 * test`, a `go build`, a project with no manifest — which must not refuse a
 * correct proposal for a stack this function does not read.
 */
export function verifyCommand(
  gate: GateId,
  command: string,
  context: {
    scripts: ReadonlySet<string> | null;
    makeTargets: ReadonlySet<string> | null;
    survey: RepositorySurvey;
  },
): VerifiedCommand {
  const label = gateDefinition(gate).label;
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  const head = tokens[0] ?? '';
  const rest = tokens.slice(1);

  const unverifiable = (why: string): VerifiedCommand => ({
    gate,
    command,
    status: 'unverifiable',
    detail: `Der Befehl für „${label}" (\`${command}\`) ist nicht gegen das Projekt prüfbar: ${why} Er wird übernommen, ist aber unbelegt.`,
  });

  if (PACKAGE_MANAGERS.has(head)) {
    if (rest.some((token) => BINARY_SUBCOMMANDS.has(token))) {
      return unverifiable('er ruft ein Programm auf, kein Skript aus dem Manifest.');
    }
    const scope = resolveScriptScope(context, rest);
    if (!scope) {
      return unverifiable('das Projekt hat keine lesbare `package.json` mit Skripten.');
    }
    if (scope.packagesButNoRoot) {
      // The reason has to be *true*, which is the whole of A72's rule. This
      // branch used to fall through to "das Projekt hat keine lesbare
      // package.json mit Skripten" — said about das Pilotprojekt, whose `web/package.json`
      // the survey had read and quoted in the same document. A false reason is
      // worse than a refusal: it sends the reader looking for a manifest that is
      // right there.
      const dirs = scope.packagesButNoRoot.map((dir) => `\`${dir}/\``).join(', ');
      return unverifiable(
        `der Befehl wählt kein Paket aus, und dieses Projekt hat keine \`package.json\` im ` +
          `Wurzelverzeichnis — die vorhandene(n) liegen in ${dirs}. Ein Auswahl-Schalter ` +
          '(`--filter`, `--prefix`, `--workspace`) oder `-r` machte den Befehl belegbar.',
      );
    }
    if (scope.unresolved) {
      // A selector naming a package this survey did not read. Unverifiable rather
      // than undeclared, for the rule this whole file follows: only a fact we
      // established may refuse a proposal (A72). The flag is quoted as written —
      // answering `--prefix web` with a sentence about `--filter` would be a
      // second false fact in the place built to avoid the first.
      return unverifiable(
        `\`${scope.selectorFlag ?? '--filter'} ${scope.unresolved}\` benennt ein Paket, das in ` +
          'dieser Erhebung nicht vorkommt; welche Skripte es deklariert, ist hier nicht ' +
          'feststellbar.',
      );
    }
    const candidates = rest.filter(
      (token) => !token.startsWith('-') && token !== 'run' && token !== scope.filter,
    );
    const hit = candidates.find((token) => scope.scripts.has(token));
    if (hit) {
      return {
        gate,
        command,
        status: 'declared',
        detail: `${scope.where} deklariert das Skript \`${hit}\`.`,
      };
    }
    return {
      gate,
      command,
      status: 'undeclared',
      detail:
        `Der Befehl für „${label}" (\`${command}\`) benennt kein Skript, das ${scope.where} ` +
        `deklariert. Vorhanden sind: ${[...scope.scripts].sort().join(', ') || '(keine)'}. ` +
        'Ein Gate mit einem Befehl, den es nicht gibt, blockiert nie und wird nie rot — es ' +
        'meldet auf Dauer einen Infrastrukturfehler (A25/A55.3).',
    };
  }

  if (INTERPRETERS.has(head)) {
    // `node scripts/check.mjs` is checkable exactly like `./scripts/check.mjs`:
    // the interpreter is a program we cannot vouch for, the script it runs is a
    // file in this repository or it is not.
    const script = rest.find((token) => !token.startsWith('-'));
    if (script?.includes('/') || script?.includes('.')) {
      const relative = script.replace(/^\.\//, '');
      const known = survivesInRepository(context.survey, relative);
      if (known === true) {
        return {
          gate,
          command,
          status: 'declared',
          detail: `\`${relative}\` liegt im Repository.`,
        };
      }
      if (known === false) {
        return {
          gate,
          command,
          status: 'undeclared',
          detail:
            `Der Befehl für „${label}" (\`${command}\`) führt \`${relative}\` aus, und diese ` +
            'Datei liegt nicht im Repository. Ein Gate-Befehl, der vom Host abhängt, läuft nur dort.',
        };
      }
    }
    return unverifiable(`\`${head}\` führt nichts aus, was sich hier im Repository wiederfindet.`);
  }

  if (head === 'make') {
    if (!context.makeTargets) {
      return unverifiable('das Projekt hat kein lesbares `Makefile`.');
    }
    const target = rest.find((token) => !token.startsWith('-'));
    if (!target) return unverifiable('es wird kein Ziel genannt (`make` ohne Argument).');
    if (context.makeTargets.has(target)) {
      return {
        gate,
        command,
        status: 'declared',
        detail: `Das \`Makefile\` deklariert das Ziel \`${target}\`.`,
      };
    }
    return {
      gate,
      command,
      status: 'undeclared',
      detail:
        `Der Befehl für „${label}" (\`${command}\`) nennt das make-Ziel \`${target}\`, das im ` +
        `\`Makefile\` nicht vorkommt. Vorhanden sind: ${[...context.makeTargets].sort().join(', ')}.`,
    };
  }

  if (head.includes('/')) {
    // A path into the repository is checkable exactly, against the survey's
    // complete file list — and a gate command pointing at a script that is not
    // in the repository depends on the host it runs on, which is worse than an
    // unverified one: it works on the machine somebody tried it on.
    const relative = head.replace(/^\.\//, '');
    const known = survivesInRepository(context.survey, relative);
    if (known === true) {
      return {
        gate,
        command,
        status: 'declared',
        detail: `\`${relative}\` liegt im Repository.`,
      };
    }
    if (known === null) return unverifiable('die Dateiliste des Repositories ist unvollständig.');
    return {
      gate,
      command,
      status: 'undeclared',
      detail:
        `Der Befehl für „${label}" (\`${command}\`) verweist auf \`${relative}\`, und diese ` +
        'Datei liegt nicht im Repository. Ein Gate-Befehl, der vom Host abhängt, läuft nur dort.',
    };
  }

  return unverifiable(
    `\`${head}\` ist ein Programm; ob es auf dem Zielsystem liegt, ist hier nicht feststellbar.`,
  );
}

/**
 * §10's integration branch, decided between two sources that can disagree.
 *
 * When `origin/HEAD` is set it is the mechanical statement of what a
 * repository's integration branch *is*, and it wins — the same rule that makes
 * `claimsRespected` a computed answer. When it is not set, the survey fell back
 * to whatever branch happened to be checked out, which is a statement about
 * where somebody last stood; there the agent's reading of the project's own
 * documentation is the better evidence, and A41 names a real project that
 * develops on `dev`. Either way a divergence is recorded rather than resolved
 * silently, because §10 cuts every task branch from this.
 */
function resolveDefaultBranch(
  survey: RepositorySurvey,
  result: OnboardingResult,
  notes: string[],
): string | null {
  const proposed = result.defaultBranch.trim() || null;
  const observed = survey.git.defaultBranch;
  if (!observed) return proposed;
  if (!proposed || proposed === observed) return observed;

  const authoritative = survey.git.defaultBranchSource.includes('symbolic-ref');
  if (authoritative) {
    notes.push(
      `Der Vorschlag nennt „${proposed}" als Integrationszweig, das Repository selbst ` +
        `„${observed}" (${survey.git.defaultBranchSource}). Übernommen wird „${observed}" — ` +
        'die mechanische Auskunft schlägt die Einschätzung.',
    );
    return observed;
  }
  notes.push(
    `Der Vorschlag nennt „${proposed}" als Integrationszweig, ausgecheckt war „${observed}". ` +
      'origin/HEAD ist nicht gesetzt, also ist der ausgecheckte Zweig nur ein Zufall des ' +
      `Arbeitsstands; übernommen wird „${proposed}". Bitte gegenprüfen.`,
  );
  return proposed;
}

/** §12 today: the recommendation is kept, the configuration says `none`. */
function resolveDeploy(
  result: OnboardingResult,
  deferred: DeferredItem[],
): Record<string, unknown> {
  const proposal = { ...result.deploy };
  if (IMPLEMENTED_DEPLOY_METHODS.has(proposal.method)) {
    return { method: proposal.method, rationale: proposal.rationale };
  }
  deferred.push({
    subject: 'deploy',
    reason:
      `Vorgeschlagen ist „${proposal.method}". Die Maschine dafür gibt es seit Phase 5 — was ` +
      'fehlt, ist der Zielhost, und den kann nur der Betreiber nennen (A99). Bis dahin steht „none": ' +
      `ein grüner Merge ist der Endzustand (A24). Begründung des Vorschlags: ${proposal.rationale}`,
  });
  // Kept in the stored document, not only in the report, because Phase 5 step 1
  // is "per-project deploy config" and this is its input. A recommendation that
  // lives only in a markdown file is one Phase 5 has to be told about.
  return { method: 'none', rationale: proposal.rationale, proposed: proposal };
}

interface ScriptScope {
  scripts: ReadonlySet<string>;
  /** German: which manifest answered, for the detail line. */
  where: string;
  /** The selector's argument, so it is not mistaken for the script name. */
  filter?: string;
  /** Set when a selector named a package this survey did not read. */
  unresolved?: string;
  /** The selector flag as the command wrote it, so no message invents one. */
  selectorFlag?: string;
  /**
   * Set when the command selects no package and there is no root manifest.
   *
   * Distinct from `null`, which means "no manifest anywhere". A single-package
   * repository whose one manifest sits in a subdirectory is the common case
   * (the pilot project: only `web/package.json`), and it needs a reason that says so.
   */
  packagesButNoRoot?: readonly string[];
}

/**
 * Which manifest a package-manager command's script must be declared in (A72).
 *
 * A monorepo's gate commands do not live in the root manifest. `pnpm --filter
 * web build` is correct in a workspace where `apps/web` declares `build`, and
 * `pnpm -r test` is correct when any member does — so reading only the root
 * would refuse two shapes that are not merely common but idiomatic. The first
 * live run of this checker refused exactly that, on a real repository.
 *
 * Widening it does not soften the check: `pnpm run tests` still finds nothing
 * anywhere, which is the case the refusal exists for. What it fixes is the
 * namespace the question is asked in.
 */
function resolveScriptScope(
  context: { scripts: ReadonlySet<string> | null; survey: RepositorySurvey },
  rest: readonly string[],
): ScriptScope | null {
  const packages = context.survey.packages ?? [];
  const selector = readSelector(rest);

  if (selector) {
    // One matcher for both dialects on purpose: pnpm's `--filter` names a
    // package, npm's `--prefix` names a directory, and the four comparisons
    // below already answer either. Two resolvers would be two places for the
    // same question to be answered differently.
    const hit = packages.find(
      (entry) =>
        entry.name === selector.value ||
        entry.dir === selector.value ||
        entry.dir.split('/').at(-1) === selector.value ||
        entry.name?.split('/').at(-1) === selector.value,
    );
    if (!hit) {
      return {
        scripts: new Set(),
        where: '',
        unresolved: selector.value,
        selectorFlag: selector.flag,
      };
    }
    return {
      scripts: new Set(hit.scripts),
      where: `\`${hit.dir === '.' ? '' : `${hit.dir}/`}package.json\``,
      filter: selector.value,
      selectorFlag: selector.flag,
    };
  }

  if (rest.some((token) => RECURSIVE_FLAGS.has(token))) {
    if (packages.length === 0) {
      return context.scripts ? { scripts: context.scripts, where: '`package.json`' } : null;
    }
    return {
      scripts: new Set(packages.flatMap((entry) => entry.scripts)),
      where: `eines der ${packages.length} Pakete dieses Workspace`,
    };
  }

  const root = packages.find((entry) => entry.dir === '.');
  if (root) return { scripts: new Set(root.scripts), where: '`package.json`' };
  if (context.scripts) return { scripts: context.scripts, where: '`package.json`' };
  // Manifests exist, none of them at the root, and the command chose none of
  // them. That is a different fact from "there is no manifest", and the caller
  // has to be able to say which — see `packagesButNoRoot`.
  if (packages.length > 0) {
    return { scripts: new Set(), where: '', packagesButNoRoot: packages.map((entry) => entry.dir) };
  }
  return null;
}

/**
 * The package a command selects, and the flag it used to select it.
 *
 * Both dialects, because both appear in real projects and only one of them was
 * understood: pnpm writes `--filter web` / `-F web`, npm writes
 * `--prefix web` / `-C web` for a directory and `--workspace web` / `-w web`
 * for a workspace name. the pilot project is the case that found this — its build command
 * is `npm --prefix web run build`, which fell through every branch here and was
 * then reported as "this project has no readable package.json", about a project
 * whose `web/package.json` the same survey had read.
 *
 * The flag is returned alongside the value so a message can quote what was
 * actually written.
 */
function readSelector(rest: readonly string[]): { value: string; flag: string } | null {
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index] ?? '';
    if (SELECTOR_FLAGS.has(token)) {
      const value = rest[index + 1];
      return value ? { value, flag: token } : null;
    }
    const equals = token.indexOf('=');
    if (equals > 0 && SELECTOR_FLAGS.has(token.slice(0, equals))) {
      const value = token.slice(equals + 1);
      return value ? { value, flag: token.slice(0, equals) } : null;
    }
  }
  return null;
}

/**
 * The root `package.json`'s script names, or null when there is none to read.
 *
 * Read off `survey.packages`, which the survey parsed once — not re-parsed from
 * `survey.manifests`. Those would be two answers to one question, and the second
 * one would be the one that disagreed after a survey change nobody thought about
 * here. `manifests` carries the raw text because the prompt quotes it; this
 * carries the parsed truth because the verification decides on it.
 *
 * Null and not an empty set when the manifest could not be parsed: treating a
 * truncated manifest as "declares nothing" would turn every proposed command
 * into a refusal.
 */
export function declaredScripts(survey: RepositorySurvey): ReadonlySet<string> | null {
  const root = (survey.packages ?? []).find((entry) => entry.dir === '.');
  return root ? new Set(root.scripts) : null;
}

/** `Makefile` targets, or null when there is no readable Makefile. */
export function declaredMakeTargets(survey: RepositorySurvey): ReadonlySet<string> | null {
  const makefile = survey.manifests.find((file) => file.path === 'Makefile');
  if (!makefile?.content) return null;
  const targets = new Set<string>();
  for (const line of makefile.content.split('\n')) {
    const match = /^([A-Za-z0-9._/-]+)\s*:(?!=)/.exec(line);
    if (match?.[1]) targets.add(match[1]);
  }
  return targets;
}

/**
 * Is this path in the repository?
 *
 * `null` rather than `false` when the survey has no file list at all — a
 * directory that is not a git repository, or a `git ls-files` that failed. "I
 * could not look" and "it is not there" are different answers and only the
 * second may refuse a proposal, so they are different values here.
 *
 * `survey.files` is complete and uncapped for exactly this question; the capped
 * inventory listings could only ever have answered "I did not see it".
 */
function survivesInRepository(survey: RepositorySurvey, path: string): boolean | null {
  if (!survey.git.isRepository || survey.files.length === 0) return null;
  return survey.files.includes(path);
}
