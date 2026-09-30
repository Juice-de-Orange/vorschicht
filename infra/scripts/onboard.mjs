#!/usr/bin/env node
/**
 * §20's dry-run onboarding: analyse a repository and write the proposal the operator
 * decides on.
 *
 * This is the entry point the Phase 3 exit gate names ("Dry-run onboarding of
 * a pilot project produces a sensible, human-plausible proposal … reviewed by the operator via
 * inbox-style MC"). The inbox arrives in Phase 4, so the proposal is written to
 * `docs/onboarding/<slug>.md` and pointed at from `README.md` — the
 * escalation route an unattended build has (§0.5).
 *
 * **Nothing is written to the analysed repository and no project is created.**
 * That is not a flag on this script: `OnboardingService.propose()` has no
 * `ProjectService`, so there is no code path that could. `--apply` is a separate
 * step for a proposal that has already been read, and it refuses to run on one
 * the verification rejected.
 *
 *   infra/scripts/onboard.sh --path /path/to/example-app --slug example-app \
 *     --name "Example App" --read-only
 *   infra/scripts/onboard.sh --path … --slug … --apply --actor <actor>
 *
 * Costs subscription budget: one session at the strongest tier (A70 — the
 * proposal is permanent and rare). Not part of `pnpm gate`.
 *
 * Exit codes:
 *   0  a proposal was produced and it is storable
 *   1  a proposal was produced and the verification refused it
 *   2  infra: the analysis could not be carried out (A25) — retry, nothing red
 *   3  the session ran and delivered nothing usable
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const {
  AgentRunner,
  EscalationService,
  EventLog,
  HeadlessBackend,
  OnboardingProposals,
  OnboardingService,
  ProjectService,
  raiseProposal,
  renderOnboardingProposal,
  writeRoleSettings,
} = await import(pathToFileURL(join(REPO_ROOT, 'packages/core/dist/index.js')).href);
const { createSql, migrate } = await import(
  pathToFileURL(join(REPO_ROOT, 'packages/db/dist/index.js')).href
);

function arg(name, fallback = null) {
  const index = argv.indexOf(`--${name}`);
  return index === -1 ? fallback : (argv[index + 1] ?? fallback);
}

const rootPath = arg('path') ? resolve(arg('path')) : null;
const slug = arg('slug');
const name = arg('name', slug);
const readOnly = argv.includes('--read-only');
const apply = argv.includes('--apply');
const actor = arg('actor', 'max');

/**
 * §20s zweiter Akt: einen **gelesenen** Vorschlag übernehmen, ohne Sitzung.
 *
 * Ohne diesen Weg fährt jeder Lauf `propose()` und `apply()` im selben Prozess,
 * und wer den Vorschlag lesen lassen will, braucht einen zweiten Lauf — also
 * eine zweite Modellsitzung, die einen **anderen** Vorschlag liefern darf als
 * den, den der Betreiber gelesen hat. Die Entscheidung, die §20 beschreibt, war damit
 * nicht überprüfbar: das Bestätigte und das Angewandte waren nie nachweislich
 * dasselbe.
 */
const applyRun = arg('apply-lauf');

if (applyRun === null && (!rootPath || !slug)) {
  console.error('onboard — --path und --slug sind erforderlich (oder --apply-lauf <runId>).');
  exit(2);
}
if (applyRun === null && !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
  console.error(`onboard — "${slug}" ist kein taugliches Kürzel (a-z, 0-9, Bindestrich).`);
  exit(2);
}

const url = env.DATABASE_URL ?? env.TEST_DATABASE_URL;
if (!url) {
  console.error('onboard — DATABASE_URL fehlt. Für einen lokalen Lauf: infra/scripts/onboard.sh');
  exit(2);
}

const sql = createSql({ url, max: 4 });
let scratch = null;

try {
  await migrate(sql, join(REPO_ROOT, 'packages/db/migrations'));
  const eventLog = new EventLog(sql);
  const projects = new ProjectService(sql);

  // §20s zweiter Akt, und er fährt **keine** Sitzung: alles kommt aus dem
  // `onboarding.proposed`-Ereignis, also aus genau dem Vorschlag, der der Betreiber
  // vorgelegt wurde. Er steht **vor** dem Scratch-Verzeichnis und vor dem
  // Runner, weil beides hier nichts zu tun hätte — ein Modellzugang, den dieser
  // Weg nicht braucht, wäre eine Voraussetzung, die er nicht hat.
  if (applyRun !== null) {
    const onboardingOhneSitzung = new OnboardingService({ eventLog });
    const project = await onboardingOhneSitzung.applyFromRun(
      projects,
      new OnboardingProposals(sql),
      applyRun,
      actor,
    );
    console.log(`Übernommen aus Lauf ${applyRun} — keine neue Sitzung.`);
    console.log(`  ${project.name} (${project.slug}) — ${project.id}`);
    console.log(`  Pfad: ${project.rootPath}`);
    console.log(`  Nur Analyse: ${project.readOnly ? 'ja' : 'nein'}`);
    console.log(`  Freigegeben von: ${actor}`);
    exit(0);
  }

  scratch = await mkdtemp(join(tmpdir(), 'vorschicht-onboard-'));
  // A70: a scratch cwd, never the repository — a project must not be able to
  // instruct the session that decides which checks will ever run against it.
  const scratchCwd = join(scratch, 'analyse');
  await mkdir(scratchCwd, { recursive: true });
  await writeRoleSettings(join(scratch, 'claude'), {
    hookEntry: join(REPO_ROOT, 'packages/core/dist/hook-entry.js'),
  });

  const onboarding = new OnboardingService({
    runner: new AgentRunner({
      sql,
      eventLog,
      backend: new HeadlessBackend(),
      paths: {
        roleSettingsDir: join(scratch, 'claude'),
        runsRoot: join(scratch, 'runs'),
        transcriptsRoot: join(scratch, 'transcripts'),
        mcpServerEntry: null,
      },
      onWarning: (message) => console.warn(`  ! ${message}`),
    }),
    eventLog,
    scratchDir: scratchCwd,
    onWarning: (message) => console.warn(`  ! ${message}`),
  });

  console.log(`Onboarding-Trockenlauf — ${name} (${slug})`);
  console.log(`  Pfad: ${rootPath}`);
  console.log(`  Nur Analyse: ${readOnly ? 'ja (A41)' : 'nein'}`);

  const proposal = await onboarding.propose({ rootPath, slug, readOnly, name });
  if (proposal.status !== 'proposed') {
    console.error(`\nKein Vorschlag: ${proposal.problem}`);
    exit(proposal.status === 'infra' ? 2 : 3);
  }

  const reportInput = {
    slug,
    name,
    survey: proposal.survey,
    result: proposal.result,
    verification: proposal.verification,
    readOnly,
    runId: proposal.runId,
    date: new Date().toISOString().slice(0, 10),
  };
  const document = renderOnboardingProposal(reportInput);
  const dir = join(REPO_ROOT, 'docs/onboarding');
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${slug}.md`);
  await writeFile(path, `${document}\n`, 'utf8');

  // §20: "the operator confirms/edits via one multiple-choice escalation" (§22 Phase 4
  // step 5). The card was built by `proposalOptions` long before anything
  // posted it; the document stays as the long form the card points at.
  //
  // Everything about the item — source, urgency, the deliberate nulls — lives in
  // `raiseProposal`, which is typed and tested. This file is `.mjs` and outside
  // every step of `pnpm gate`, so what it may contain is one call.
  const escalationNumber = await raiseProposal(
    new EscalationService({ sql, eventLog }),
    reportInput,
    {
      documentPath: `docs/onboarding/${slug}.md`,
      onWarning: (message) => console.warn(`  ! ${message}`),
    },
  );

  const { verification } = proposal;
  console.log(`\nVorschlag: ${verification.ok ? 'übernehmbar' : 'NICHT übernehmbar'}`);
  console.log(`  Integrationszweig: ${verification.defaultBranch ?? '(unbestimmt)'}`);
  console.log(`  Granularität: ${verification.claimGranularity}`);
  console.log(`  Deployment: ${verification.deployConfig.method}`);
  for (const command of verification.commands) {
    console.log(`  [${command.status}] ${command.gate}: ${command.command}`);
  }
  for (const error of verification.errors) console.log(`  ✗ ${error}`);
  for (const item of verification.deferred) console.log(`  → verschoben: ${item.subject}`);
  for (const note of verification.notes) console.log(`  · ${note}`);
  console.log(`\nVorschlag: ${path}`);
  if (escalationNumber !== null) {
    console.log(`Entscheidung im Postfach: #${escalationNumber}`);
  }

  if (apply) {
    if (!verification.ok) {
      console.error('\n--apply verweigert: die Prüfung hat den Vorschlag abgelehnt.');
      exit(1);
    }
    const project = await onboarding.apply(
      projects,
      { slug, name, rootPath, readOnly, verification, runId: proposal.runId },
      actor,
    );
    console.log(`\nProjekt angelegt: ${project.id} (freigegeben von ${actor})`);
  }

  exit(verification.ok ? 0 : 1);
} catch (error) {
  console.error(`onboard — ${error instanceof Error ? error.stack : String(error)}`);
  exit(2);
} finally {
  await sql.end().catch(() => undefined);
  if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
}
