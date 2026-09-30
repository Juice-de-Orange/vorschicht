/**
 * Vorschicht as its own project (§12, A42) — onboarded without asking a model.
 *
 * §12 onboards this repository as a project with `selfManaged: true` and A42
 * makes it the primary pilot; the daemon has been saying so on every start
 * ("Kein selbstverwaltetes Projekt gefunden — die Betriebsprüfung (§8.2) läuft
 * nicht"), because there was no row and therefore no cadence for §8.2's audit.
 *
 * This is that row, and it is **not** produced by the onboarding agent. §20's
 * flow exists because a strange repository has to be *read* before anyone can
 * say what checks belong to it. This repository's checks are not a question:
 * they are in its own `package.json` and in `infra/scripts/gate.mjs`, and every
 * session in it already runs them before committing (§0.6). Asking a model to
 * guess them would be spending a session to learn what a query answers — the
 * scheduler's rule (A57.3) — and, worse, would put a guess in charge of the
 * gate configuration of the one project that has no other owner.
 *
 * What it does *not* skip is the checking. The deterministic proposal is built
 * in exactly the shape the agent produces and pushed through exactly the same
 * `verifyProposal`, so a renamed script in this repository refuses the
 * self-onboarding by name rather than configuring a gate that reports an
 * infrastructure failure forever (A55.3). Two paths to a project row would have
 * been two places for the rules to live; there is one, and this is a different
 * source for its input.
 */
import type { OnboardingResult } from '@vorschicht/shared';
import type { ProjectRecord, ProjectService } from '../project-service.js';
import type { OnboardingService } from './service.js';
import { type RepositorySurvey, surveyRepository } from './survey.js';
import { type VerifiedProposal, verifyProposal } from './verify.js';

export const SELF_SLUG = 'vorschicht';
export const SELF_NAME = 'Vorschicht';
/** Who appears in `audit_log` as having approved it — §12 did, in writing. */
export const SELF_ACTOR = 'system:self-onboarding';

/**
 * The gate configuration this repository actually has.
 *
 * Two entries are worth reading twice.
 *
 * **`test` runs the integration tests too.** `pnpm gate:test` is the unit half;
 * A61 is the record of what happens when the integration half is silently
 * skipped — 285 assertions reporting green having checked nothing, for weeks.
 * `with-test-db.sh` provides the database and runs the whole suite, so the one
 * command covers both halves rather than re-creating the split that failed.
 *
 * **Six of §11's optional command gates are off, and that is a statement.**
 * This repository has no licence checker, no dependency audit, no semgrep
 * configuration, no axe run and no performance budget. Enabling one without a
 * command would be a gate that reports ungeprüft on every merge (§11); naming a
 * command that does not exist would be worse. They are off, and `risks` says so
 * where the operator reads it.
 */
export const SELF_GATE_COMMANDS = {
  typecheck: 'pnpm run gate:typecheck',
  lint: 'pnpm run gate:lint',
  test: 'infra/scripts/with-test-db.sh pnpm exec vitest run',
  build: 'pnpm run gate:build',
} as const;

/**
 * The proposal, as the agent would have written it.
 *
 * A function of the survey rather than a constant, because two of its fields are
 * facts about the checkout — the integration branch and whether this repository
 * has migrations — and hard-coding either would make this file the second place
 * they are stated.
 */
export function selfOnboardingResult(survey: RepositorySurvey): OnboardingResult {
  return {
    status: 'done',
    summary:
      'Vorschicht selbst, als Projekt nach §12/A42. Die Gate-Konfiguration ist nicht ' +
      'geschätzt, sondern aus dem eigenen Repository übernommen und gegen dessen ' +
      '`package.json` geprüft.',
    artifacts: [],
    followups: [],
    stack:
      'TypeScript-Monorepo (pnpm workspaces, Node 22), Hono-API, Vite/React-PWA, ' +
      'PostgreSQL mit Drizzle-Migrationen, Docker-Compose-Stack.',
    defaultBranch: survey.git.defaultBranch ?? 'main',
    gates: [
      {
        id: 'typecheck',
        enabled: true,
        command: SELF_GATE_COMMANDS.typecheck,
        rationale:
          'Die `package.json` deklariert `gate:typecheck`; es baut die Quellprojekte und ' +
          'zusätzlich `tsconfig.test.json`, ohne das nie eine Testdatei typgeprüft war.',
      },
      {
        id: 'lint',
        enabled: true,
        command: SELF_GATE_COMMANDS.lint,
        rationale: 'Die `package.json` deklariert `gate:lint` (Biome, Lint und Format in einem).',
      },
      {
        id: 'test',
        enabled: true,
        command: SELF_GATE_COMMANDS.test,
        rationale:
          'Läuft Unit- und Integrationstests in einem Lauf gegen eine echte Postgres — ' +
          '`pnpm gate:test` allein überspringt jede `*.itest.ts` still (A61).',
      },
      {
        id: 'build',
        enabled: true,
        command: SELF_GATE_COMMANDS.build,
        rationale: 'Die `package.json` deklariert `gate:build` über alle Workspaces.',
      },
      {
        id: 'changelog',
        enabled: true,
        rationale: '§0.6 verlangt für jede Sitzung einen CHANGELOG-Eintrag.',
      },
      {
        id: 'docs',
        enabled: true,
        rationale:
          '§0.6 verlangt, dass betroffene Dokumentation mitgeführt wird; das Gate prüft ' +
          'die mechanische Hälfte davon.',
      },
      {
        id: 'migration-review',
        enabled: survey.inventory.migrationCandidates.length > 0,
        rationale:
          survey.inventory.migrationCandidates.length > 0
            ? 'Das Repository führt Drizzle-Migrationen unter `packages/db/migrations`; §12/A24 ' +
              'macht deren Rückwärtskompatibilität zur Deploy-Entscheidung.'
            : 'Im Checkout sind keine Migrationsdateien gefunden worden.',
      },
    ],
    claimGranularity: 'package',
    claimRationale:
      'pnpm-Workspace mit echten Paketgrenzen — zwei Aufgaben in verschiedenen Paketen ' +
      'kollidieren nach §10 nicht, zwei im selben Paket sollen es.',
    migrationPaths: ['packages/db/migrations/**'],
    tools: ['Bash(pnpm:*)'],
    deploy: {
      method: 'none',
      rationale:
        'A12: Vorschicht rollt sich niemals unbeaufsichtigt selbst aus. Ein grüner Merge ' +
        'ist der Endzustand, bis der Betreiber einen Rollout ausdrücklich freigibt.',
    },
    personalData: {
      present: false,
      evidence: [],
    },
    departments: ['Entwicklung', 'Betriebsprüfung', 'Ops/SRE', 'Doku & Archiv', 'Controlling'],
    risks: [
      'Drei eigene Prüfschritte dieses Repositories haben keinen Platz im Katalog nach §11 — ' +
        '`contracts`, `cli-contract` und `migrations` aus `infra/scripts/gate.mjs`. Sie laufen ' +
        'bei `pnpm gate` vor jedem Commit, aber nicht in der Merge-Warteschlange. Das ist eine ' +
        'bewusst benannte Lücke, kein Versehen (A71).',
      '`gate:commits` (Conventional Commits, §0.6) läuft überhaupt nirgends: das Skript hat ' +
        'keinen Aufrufer — weder `pnpm gate` noch einen git-Hook. Tote Verdrahtung, benannt ' +
        'statt im Vorbeigehen behoben (A71).',
      'Sechs optionale Befehls-Gates sind aus, weil dieses Projekt keinen Befehl dafür hat: ' +
        'Lizenzen, Abhängigkeits-Audit, SAST, Barrierefreiheit, E2E und Performance-Budget.',
      'A12 gilt unverändert: ein Merge in dieses Projekt bedeutet keinen Rollout.',
    ],
  };
}

export interface SelfOnboardingDeps {
  onboarding: OnboardingService;
  projects: ProjectService;
  /** Absolute path of this repository inside the orchestrator container. */
  rootPath: string;
  /** Where `enforceSelfReadOnly` reports that it could not do its job. */
  onWarning?(message: string): void;
}

export type SelfOnboardingOutcome =
  /** A self-managed project was already there. Nothing was written. */
  | { status: 'present'; project: ProjectRecord }
  | { status: 'created'; project: ProjectRecord; verification: VerifiedProposal }
  /** The repository does not look the way this file says it does. */
  | { status: 'refused'; problem: string; verification: VerifiedProposal | null };

/**
 * Carry A85's decision forward onto a row that predates it.
 *
 * A85 is the operator's decision of 2026-08-02 that the self-managed project is
 * `read_only` until the studio is built and audited. It was implemented where
 * the project is **created** — and a project created before that day therefore
 * kept `read_only = false` forever, because nothing ever asked again. That is
 * not hypothetical: the local development stack carries exactly such a row
 * (created 2026-08-01 20:29 UTC, `read_only = f`) pointing at a clone eight
 * days behind `main`, and `AuditService`'s un-tick asks only the flag — so a
 * `gate_invalid` there would have opened a gate in a `CLAUDE.md` nobody merges,
 * recorded `applied = true`, and told the operator the phase had reopened.
 *
 * A85.2's refusal does not catch it, and the reason is worth stating because it
 * is the natural place to look: that check compares the stored path with the
 * configured one, and here they **agree**. What is stale is the flag, not the
 * path, and the two need different answers.
 *
 * *This* answer is to re-assert rather than refuse, on three grounds. It
 * carries out a decision the operator already made instead of inventing one. It leaves
 * the studio working, where refusing would stop the Betriebsprüfung entirely
 * and a silent auditor is the failure §8.2's fifth rule names. And it cannot
 * override him, because A85 names the way out — one audit-logged
 * `setReadOnly` — and `readOnlyEverDecided` reads that trail: once he has
 * decided, this never touches the flag again.
 *
 * Never throws. It runs inside the start-up path, and a studio that will not
 * boot because it could not tighten a flag is worse than one that boots and
 * says so — but it does report, because a guard nobody hears about is a guard
 * that gets quietly removed.
 */
async function enforceSelfReadOnly(
  deps: SelfOnboardingDeps,
  project: ProjectRecord,
): Promise<ProjectRecord> {
  if (project.readOnly) return project;
  try {
    if (await deps.projects.readOnlyEverDecided(project.id)) return project;
    return await deps.projects.setReadOnly(project.id, true, SELF_ACTOR);
  } catch (error) {
    deps.onWarning?.(
      `Das selbstverwaltete Projekt „${project.slug}" steht auf beschreibbar, und A85s ` +
        `Entscheidung ließ sich nicht nachziehen: ${(error as Error).message}. Solange das so ` +
        'bleibt, darf die Betriebsprüfung in dessen CLAUDE.md schreiben (§8.2) und die ' +
        'Entwicklungskette in dessen Arbeitsbaum (A44.3).',
    );
    return project;
  }
}

/**
 * Make sure this studio has itself as a project (§12, A42). Idempotent.
 *
 * Called at daemon start, so it must be safe to run on every restart and it must
 * never throw into the start-up path: a studio that will not boot because it
 * could not onboard itself is worse than one that boots and says so.
 */
export async function ensureSelfManagedProject(
  deps: SelfOnboardingDeps,
): Promise<SelfOnboardingOutcome> {
  const existing = (await deps.projects.listActive()).find((project) => project.selfManaged);
  if (existing) {
    // The `rootPath` argument used to be ignored on every start after the first,
    // silently: whatever this function was told, the stored row won. That is
    // harmless right up to the moment the two differ, and then it is not, because
    // the Betriebsprüfung derives the file a `gate_invalid` edits from this row
    // (§8.2, `build-scheduler.ts`) — so a studio configured to run against one
    // checkout would un-tick gates in another. Refusing is the only answer that
    // does not pick a winner between two paths a human has reason to believe in.
    if (existing.rootPath !== deps.rootPath) {
      return {
        status: 'refused',
        problem:
          `Es gibt bereits ein selbstverwaltetes Projekt, aber unter einem anderen Pfad: ` +
          `gespeichert „${existing.rootPath}", konfiguriert „${deps.rootPath}". Solange nicht ` +
          'klar ist, welches Verzeichnis gemeint ist, arbeitet das Studio an keinem von beiden ' +
          '— die Betriebsprüfung (§8.2) leitet aus dieser Zeile ab, in welche CLAUDE.md sie ' +
          'einen Haken entfernt.',
        verification: null,
      };
    }
    return { status: 'present', project: await enforceSelfReadOnly(deps, existing) };
  }

  let survey: RepositorySurvey;
  try {
    survey = await surveyRepository(deps.rootPath);
  } catch (error) {
    return { status: 'refused', problem: (error as Error).message, verification: null };
  }
  if (!survey.git.isRepository) {
    return {
      status: 'refused',
      problem:
        `„${deps.rootPath}" ist kein git-Repository. Ohne Repository gibt es keinen ` +
        'Integrationszweig und damit kein selbstverwaltetes Projekt (§10).',
      verification: null,
    };
  }

  const verification = verifyProposal(survey, selfOnboardingResult(survey));
  if (!verification.ok) {
    return {
      status: 'refused',
      problem:
        'Die eigene Gate-Konfiguration passt nicht mehr zu diesem Repository:\n' +
        verification.errors.map((line) => `- ${line}`).join('\n'),
      verification,
    };
  }

  const project = await deps.onboarding.apply(
    deps.projects,
    {
      slug: SELF_SLUG,
      name: SELF_NAME,
      rootPath: deps.rootPath,
      // the operator, 2026-08-02: the self-managed project is read-only until the studio
      // is fully built and audited; after that it works on a *clone* of itself.
      // That dates A42 rather than replacing it — Vorschicht is still its own
      // pilot, it simply is not yet its own subject. The flag is what carries
      // the decision: A44.3 refuses worktree, branch and every write on it, and
      // since this change the Betriebsprüfung's un-tick asks it too, so a
      // `gate_invalid` reaches the operator as a P1 item instead of editing this file
      // unattended. Flipping it back is `ProjectService.setReadOnly`, one
      // audit-logged call, and it is the operator's to make.
      readOnly: true,
      selfManaged: true,
      verification,
    },
    SELF_ACTOR,
  );
  return { status: 'created', project, verification };
}
