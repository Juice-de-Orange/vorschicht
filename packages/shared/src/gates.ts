/**
 * The gate registry (§11) — what gates exist, which may be switched off, and
 * what a project's checkbox configuration is allowed to say.
 *
 * §11 has two halves. Six gates are **locked** and apply to every project, "not
 * un-checkable"; the rest are an optional catalogue a project ticks on. Phase 2
 * built the locked half as a hardcoded list inside the runner. This is the
 * generalisation: the catalogue is data, the per-project configuration is a
 * validated document, and the runner iterates whatever the two resolve to.
 *
 * The catalogue lives in `@vorschicht/shared` and not beside the runner, because
 * three components need it and only one of them may shell out: the API validates
 * a settings change against it, the dashboard renders the checkboxes from it, and
 * the orchestrator runs it. A catalogue in `@vorschicht/core` would drag docker
 * and Postgres into the server's import graph for the sake of a list of labels.
 *
 * Six decisions here are not transcription of §11:
 *
 *  1. **The configuration says `false`, not "absent".** §11 asks for a checkbox
 *     set, and the exit gate asks that removing a baseline gate be *refused and
 *     audit-logged* — which needs the removal to be expressible in the first
 *     place. A shape where `enabled: GateId[]` only ever adds would make the
 *     guarantee structural and the exit gate unprovable: there would be no
 *     attempt to refuse. So the document is a map to booleans, `false` against a
 *     locked gate is a well-formed sentence, and the validator answers it.
 *
 *  2. **A gate whose runner does not exist yet cannot be enabled.** Legal review
 *     is Lena in Phase 6 and the migration review is Milo's session; both are in
 *     §11's catalogue and neither runs today. Listing them without saying so
 *     would be §8.2's sixth domain exactly — configuration that reads as covered
 *     and cannot carry a signal. `availableFrom` names what each waits for, the
 *     validator refuses to tick it, and the refusal is tested. When the runner
 *     lands, one field changes.
 *
 *  3. **Enabling a command gate without a command is refused at write time.**
 *     The runner reports it as a finding as well (§11: a missing command means
 *     ungeprüft, never green) and both layers are wanted: the write-time refusal
 *     reaches the person who typed it, the run-time finding covers a document
 *     that arrived some other way. The locked six are deliberately *not* refused
 *     at write time — a project must be creatable before its commands are known,
 *     which is exactly what onboarding's dry-run does.
 *
 *  4. **Commands are parsed at write time, too.** §19's reasoning about gate
 *     commands — a model proposes them and a human waves them through — argues
 *     for catching a shell metacharacter at the moment it is typed rather than
 *     at the moment a merge is blocked by it. `parseGateCommand` in the runner
 *     stays as the second layer.
 *
 *  5. **SAST and the dependency audit are two gates, not §11's one bullet.**
 *     They are two tools with two commands and two failure modes; a project that
 *     wants `npm audit --audit-level=high` and does not want semgrep should not
 *     have to take both. The threshold §11 mentions lives *in* the command,
 *     which is what makes it per-project config rather than a number invented
 *     here.
 *
 *  6. **Order is the catalogue's order, and the catalogue is ordered by cost.**
 *     The suite runs every gate regardless (§11 has no early exit — a coder sent
 *     back one finding at a time takes six rounds), but the cheapest failures
 *     should still be *readable* first in a timeline.
 */
import { z } from 'zod';
import { InvalidClaimGlobError, validateClaimGlobs } from './claims.js';

/**
 * §11's locked six, in the order they are cheapest to fail.
 *
 * `review` first because it is one query, `build` last because it is the
 * slowest thing that is not a test suite.
 */
export const BASELINE_GATE_IDS = [
  'review',
  'typecheck',
  'lint',
  'test',
  'secrets',
  'build',
] as const;
export type BaselineGateId = (typeof BASELINE_GATE_IDS)[number];

/** §11's optional catalogue, ticked on per project. */
export const OPTIONAL_GATE_IDS = [
  'changelog',
  'docs',
  'licenses',
  'deps-audit',
  'sast',
  'migration-review',
  'legal',
  'a11y',
  'e2e',
  'lighthouse',
] as const;
export type OptionalGateId = (typeof OPTIONAL_GATE_IDS)[number];

export type GateId = BaselineGateId | OptionalGateId;

export const GATE_IDS = [...BASELINE_GATE_IDS, ...OPTIONAL_GATE_IDS] as const;

/**
 * How a gate is executed.
 *
 * `command` — the project supplies an argv; the runner executes it and reads the
 * exit code (A50: any non-zero exit is a finding, because third-party tools do
 * not speak A25's convention).
 *
 * `internal` — Vorschicht implements the check itself and may therefore
 * distinguish a finding from an infra failure honestly.
 */
export type GateKind = 'command' | 'internal';

export interface GateDefinition {
  id: GateId;
  /** German (§2) — the checkbox label and the timeline heading. */
  label: string;
  /** German, one sentence — what the checkbox means. */
  description: string;
  /** §11's locked six. A locked gate is always in the resolved set. */
  locked: boolean;
  kind: GateKind;
  /** Whether this gate is a project command (`gateConfig.commands[id]`). */
  needsCommand: boolean;
  /**
   * Null when the runner exists; otherwise a German sentence naming what it
   * waits for. A gate with a value here cannot be enabled (decision 2 above).
   */
  availableFrom: string | null;
}

/**
 * The catalogue.
 *
 * Ordered: the locked six first in §11's own order, then the optional ones from
 * cheapest to most expensive, so a project that enables several gets a timeline
 * that reads in the order the failures arrive.
 */
export const GATE_CATALOGUE: readonly GateDefinition[] = [
  {
    id: 'review',
    label: 'Peer-Review (§8.1)',
    description:
      'Der letzte Übergang nach „Prüfungen laufen" stammt vom Review und von niemandem sonst.',
    locked: true,
    kind: 'internal',
    needsCommand: false,
    availableFrom: null,
  },
  {
    id: 'typecheck',
    label: 'Typprüfung',
    description: 'Der Typprüfer des Projekts läuft ohne Fehler durch.',
    locked: true,
    kind: 'command',
    needsCommand: true,
    availableFrom: null,
  },
  {
    id: 'lint',
    label: 'Lint & Format',
    description: 'Linter und Formatierung des Projekts sind sauber.',
    locked: true,
    kind: 'command',
    needsCommand: true,
    availableFrom: null,
  },
  {
    id: 'test',
    label: 'Tests',
    description: 'Die Testsuite des Projekts ist grün.',
    locked: true,
    kind: 'command',
    needsCommand: true,
    availableFrom: null,
  },
  {
    id: 'secrets',
    label: 'Secrets-Scan (gitleaks)',
    description: 'gitleaks findet keine Zugangsdaten in den versionierbaren Dateien des Baums.',
    locked: true,
    kind: 'internal',
    needsCommand: false,
    availableFrom: null,
  },
  {
    id: 'build',
    label: 'Build',
    description: 'Das Projekt lässt sich bauen.',
    locked: true,
    kind: 'command',
    needsCommand: true,
    availableFrom: null,
  },
  {
    id: 'changelog',
    label: 'CHANGELOG geführt',
    description: 'Die Änderung fasst sich selbst in der CHANGELOG-Datei des Projekts zusammen.',
    locked: false,
    kind: 'internal',
    needsCommand: false,
    availableFrom: null,
  },
  {
    id: 'docs',
    label: 'Dokumentation mitgeführt',
    description:
      'Eine Änderung, die nicht nur Dokumentation ist, führt auch Dokumentation nach (§23).',
    locked: false,
    kind: 'internal',
    needsCommand: false,
    availableFrom: null,
  },
  {
    id: 'licenses',
    label: 'Lizenzprüfung der Abhängigkeiten',
    description: 'Der Lizenzprüfer des Projekts meldet keine unzulässige Abhängigkeit.',
    locked: false,
    kind: 'command',
    needsCommand: true,
    availableFrom: null,
  },
  {
    id: 'deps-audit',
    label: 'Abhängigkeits-Audit',
    description:
      'Der Audit-Befehl des Projekts bleibt unter seiner Schwelle — die Schwelle steht im Befehl, ' +
      'etwa „npm audit --audit-level=high".',
    locked: false,
    kind: 'command',
    needsCommand: true,
    availableFrom: null,
  },
  {
    id: 'sast',
    label: 'Statische Sicherheitsanalyse (SAST)',
    description: 'Die statische Sicherheitsanalyse des Projekts, etwa semgrep, meldet keinen Fund.',
    locked: false,
    kind: 'command',
    needsCommand: true,
    availableFrom: null,
  },
  {
    id: 'migration-review',
    label: 'Migrationsprüfung (Milo)',
    description:
      'Eine Datenbankmigration wird vom Datenbank-Spezialisten geprüft, bevor sie zusammengeführt ' +
      'wird — insbesondere auf Rückwärtskompatibilität (§12, A24).',
    locked: false,
    kind: 'internal',
    needsCommand: false,
    availableFrom: null,
  },
  {
    id: 'legal',
    label: 'DSGVO-/Rechtsprüfung (Lena)',
    description:
      'Die Rechtsabteilung prüft die Änderung mit Belegen aus Quellen der Stufe L4 oder höher (§14).',
    locked: false,
    kind: 'internal',
    needsCommand: false,
    // Lena exists (§8 row 5, Phase 6 step 1) and `GateSuite.legal` runs her.
    // This field was the third of three locks on this gate — the validator
    // refuses to tick an unavailable gate, `resolveGates` drops it from a
    // document that got past the validator, and `assertInternalRunnersComplete`
    // fails the *import* while the catalogue and the runner disagree. Clearing
    // it last is what makes that third lock do its job: until the runner was
    // there, this line was the thing that would not let the chain load.
    availableFrom: null,
  },
  {
    id: 'a11y',
    label: 'Barrierefreiheit (axe)',
    description: 'Der Barrierefreiheits-Scan des Projekts meldet keinen Verstoß.',
    locked: false,
    kind: 'command',
    needsCommand: true,
    availableFrom: null,
  },
  {
    id: 'e2e',
    label: 'E2E-/Smoke-Suite',
    description: 'Die durchgehende Testsuite des Projekts ist grün.',
    locked: false,
    kind: 'command',
    needsCommand: true,
    availableFrom: null,
  },
  {
    id: 'lighthouse',
    label: 'Performance-Budget (Lighthouse)',
    description: 'Das Projekt hält sein hinterlegtes Performance-Budget ein.',
    locked: false,
    kind: 'command',
    needsCommand: true,
    availableFrom: null,
  },
];

const BY_ID = new Map<GateId, GateDefinition>(GATE_CATALOGUE.map((gate) => [gate.id, gate]));

/** Every catalogue entry appears exactly once, and the locked set is §11's six. */
export function assertCatalogueConsistent(): void {
  if (BY_ID.size !== GATE_CATALOGUE.length) {
    throw new Error('Der Gate-Katalog enthält eine doppelte Kennung');
  }
  for (const id of GATE_IDS) {
    if (!BY_ID.has(id)) throw new Error(`Der Gate-Katalog kennt "${id}" nicht`);
  }
  const locked = GATE_CATALOGUE.filter((gate) => gate.locked).map((gate) => gate.id);
  if (locked.join(',') !== BASELINE_GATE_IDS.join(',')) {
    throw new Error('Die gesperrten Gates weichen von §11s Grundgerüst ab');
  }
}
// At module load, so a catalogue edit that breaks either invariant fails the
// import rather than a merge six weeks later — the posture
// `assertNoWhitelistCollision` already takes for the MCP tool names.
assertCatalogueConsistent();

export function gateDefinition(id: GateId): GateDefinition {
  const definition = BY_ID.get(id);
  if (!definition) throw new Error(`Unbekanntes Gate "${id}"`);
  return definition;
}

export function isGateId(value: string): value is GateId {
  return BY_ID.has(value as GateId);
}

// --- the per-project document ------------------------------------------------

/**
 * A project's gate configuration (§11), as stored in `projects.gate_config`.
 *
 * `gates` is the checkbox state. Absent means "not ticked" for an optional gate
 * and changes nothing for a locked one; the only value that carries information
 * about a locked gate is an explicit `false`, which is the attempt the validator
 * exists to refuse.
 */
export interface ProjectGateConfig {
  gates: Partial<Record<GateId, boolean>>;
  commands: Partial<Record<GateId, string>>;
  /**
   * The Bash scopes a Coder in this project may use (A46.4).
   *
   * Project data rather than part of a role profile: a guessed `Bash(pnpm:*)`
   * would be too wide for a project that uses make and useless to one that uses
   * cargo.
   */
  tools: string[];
  /**
   * Which paths in this project are database migrations (§11's migration gate).
   *
   * Path globs in the claim grammar, relative to the project root. Empty means
   * `DEFAULT_MIGRATION_GLOBS`, which is deliberately broad — see there.
   */
  migrationPaths: string[];
}

/**
 * What counts as a migration when a project has not said (§11, A24).
 *
 * Broad on purpose, and the direction is the point. Missing a migration means
 * an unreviewed schema change reaches `main` and then deploys, where §12's
 * rollback restores the previous release's *code* and cannot undo it. Matching
 * one file too many costs a model session on that merge — and the gate names
 * the files that triggered it, so a project paying for sessions it does not
 * need finds out on its first merge rather than on a budget report. A45.4 made
 * the same trade for claim overlap and for the same reason: the two errors are
 * not symmetric.
 */
export const DEFAULT_MIGRATION_GLOBS = [
  '**/migrations/**',
  '**/migration/**',
  '**/migrate/**',
  '**/*.sql',
] as const;

export const EMPTY_GATE_CONFIG: ProjectGateConfig = {
  gates: {},
  commands: {},
  tools: [],
  migrationPaths: [],
};

/** The globs this project's migration gate matches against (§11). */
export function migrationGlobs(config: ProjectGateConfig): readonly string[] {
  return config.migrationPaths.length > 0 ? config.migrationPaths : DEFAULT_MIGRATION_GLOBS;
}

/**
 * Shape only — the keys are checked in `validateProjectGateConfig`.
 *
 * `z.record` over a refined key type produces a *total* record in TypeScript,
 * which is the wrong shape (a project ticks a few boxes, not all sixteen) and
 * would make an empty document a type error. Unknown ids are therefore rejected
 * a few lines further down, where the message can name them.
 */
const projectGateConfigSchema = z.object({
  gates: z.record(z.string(), z.boolean()).default({}),
  commands: z.record(z.string(), z.string()).default({}),
  tools: z.array(z.string()).default([]),
  migrationPaths: z.array(z.string()).default([]),
});

/**
 * Characters that mean something to a shell and nothing to `execFile`.
 *
 * Duplicated from the runner deliberately rather than imported: `@vorschicht/core`
 * depends on `@vorschicht/shared` and not the other way round, and this is four
 * tokens of regex against an import cycle. `gate-suite.test.ts` asserts the two
 * agree, so a change to one that is not made to the other fails the build.
 */
export const GATE_SHELL_METACHARACTERS = /[;&|<>$`\\!*?(){}[\]'"\n\r]/;

export interface GateConfigValidation {
  ok: boolean;
  /** German, one per problem. Empty when `ok`. */
  errors: string[];
  /** Present when `ok`; the normalised document to store. */
  config: ProjectGateConfig | null;
}

/**
 * Validate a submitted gate configuration against §11 and the catalogue.
 *
 * Returns every problem rather than the first: a settings form that reveals one
 * mistake per submission is a settings form nobody finishes.
 */
export function validateProjectGateConfig(input: unknown): GateConfigValidation {
  const parsed = projectGateConfigSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return {
      ok: false,
      config: null,
      errors: parsed.error.issues.map((issue) => {
        const path = issue.path.join('.');
        return path ? `${path}: ${issue.message}` : issue.message;
      }),
    };
  }

  const document = parsed.data as ProjectGateConfig;
  const errors: string[] = [];

  for (const id of [...Object.keys(parsed.data.gates), ...Object.keys(parsed.data.commands)]) {
    if (!isGateId(id)) {
      errors.push(
        `„${id}" ist kein Gate aus dem Katalog nach §11. Ein unbekanntes Gate wird nicht ` +
          'stillschweigend übergangen, weil ein Tippfehler sonst als abgeschaltete Prüfung endet.',
      );
    }
  }
  if (errors.length > 0) return { ok: false, errors, config: null };

  for (const [id, enabled] of Object.entries(document.gates) as Array<[GateId, boolean]>) {
    const gate = gateDefinition(id);
    if (gate.locked && !enabled) {
      // The refusal §11 calls for, and the reason the document can express the
      // attempt at all. Named rather than generic: "Gate gesperrt" in an audit
      // row is a sentence somebody has to go and decode.
      errors.push(
        `„${gate.label}" gehört zum gesperrten Grundgerüst nach §11 und kann für kein Projekt ` +
          'abgewählt werden.',
      );
      continue;
    }
    if (!enabled) continue;
    const unavailable = gateUnavailableReason(gate);
    if (unavailable) {
      errors.push(`„${gate.label}" ist noch nicht verfügbar: ${unavailable}`);
      continue;
    }
    // Deliberately not applied to the locked six: a project must be creatable
    // before its commands are known — which is precisely what onboarding's
    // dry-run does (§20) — and the runner reports the missing command as a
    // finding on the first merge attempt anyway. For an optional gate the
    // opposite holds: ticking the box is a deliberate act, and doing it without
    // a command is an incomplete configuration the person in front of the form
    // can fix in the same submission.
    if (!gate.locked && gate.needsCommand && !document.commands[id]?.trim()) {
      errors.push(
        `Für „${gate.label}" ist kein Befehl hinterlegt — ein angehaktes Gate ohne Befehl ist ` +
          'nicht grün, sondern ungeprüft (§11).',
      );
    }
  }

  for (const [id, spec] of Object.entries(document.commands) as Array<[GateId, string]>) {
    const gate = gateDefinition(id);
    if (!gate.needsCommand) {
      errors.push(
        `„${gate.label}" ist kein Befehls-Gate — Vorschicht führt diese Prüfung selbst aus; ` +
          'ein hinterlegter Befehl würde nie ausgeführt.',
      );
      continue;
    }
    if (spec.trim() === '') {
      errors.push(`Der Befehl für „${gate.label}" ist leer.`);
      continue;
    }
    const offending = GATE_SHELL_METACHARACTERS.exec(spec.trim());
    if (offending) {
      errors.push(
        `Der Befehl für „${gate.label}" enthält das Sonderzeichen „${offending[0]}". Vorschicht ` +
          'führt Gate-Befehle ohne Shell aus (§19); ein Befehl, der eine Shell braucht, gehört ' +
          'als Skript ins Projekt, wo er selbst geprüft wird.',
      );
    }
  }

  // Same grammar as a claim set, and the same validator — a second dialect of
  // "which paths does this mean" would be one more thing that can disagree with
  // §6.6's hook about what a path is. Normalised into the stored document, so
  // `db/migrate/` and `db/migrate/**` are one entry rather than two.
  try {
    document.migrationPaths = validateClaimGlobs(document.migrationPaths);
  } catch (error) {
    errors.push(
      error instanceof InvalidClaimGlobError
        ? `Migrationspfad abgelehnt: ${error.message}`
        : `Migrationspfade ungültig: ${(error as Error).message}`,
    );
  }

  if (errors.length > 0) return { ok: false, errors, config: null };
  return { ok: true, errors: [], config: document };
}

export class GateConfigError extends Error {
  constructor(readonly errors: string[]) {
    super(`Gate-Konfiguration abgelehnt:\n${errors.map((line) => `- ${line}`).join('\n')}`);
    this.name = 'GateConfigError';
  }
}

/** Throwing variant, for the call sites where a rejection is exceptional. */
export function parseProjectGateConfig(input: unknown): ProjectGateConfig {
  const result = validateProjectGateConfig(input);
  if (!result.ok || !result.config) throw new GateConfigError(result.errors);
  return result.config;
}

/**
 * Read a stored document without refusing it.
 *
 * A configuration that reached the column some other way — a migration, a seed
 * script, a hand-edited row — must not stop the studio from merging; the runner
 * is the second layer and reports the same problems as findings. So this drops
 * what it cannot use and keeps everything else, and the locked six are added by
 * `resolveGates` regardless of what the document says.
 */
export function readProjectGateConfig(input: unknown): ProjectGateConfig {
  const result = validateProjectGateConfig(input);
  if (result.ok && result.config) return result.config;
  const raw = (input ?? {}) as Record<string, unknown>;
  const gates: Partial<Record<GateId, boolean>> = {};
  const commands: Partial<Record<GateId, string>> = {};
  for (const [id, value] of Object.entries((raw.gates as object) ?? {})) {
    if (isGateId(id) && typeof value === 'boolean') gates[id] = value;
  }
  for (const [id, value] of Object.entries((raw.commands as object) ?? {})) {
    if (isGateId(id) && typeof value === 'string' && value.trim() !== '') commands[id] = value;
  }
  const tools = Array.isArray(raw.tools)
    ? raw.tools.filter((tool): tool is string => typeof tool === 'string')
    : [];
  // A stored glob that no longer parses is dropped rather than fatal, and the
  // consequence is deliberately the safe one: with none left, `migrationGlobs`
  // falls back to the broad defaults, so the gate over-triggers instead of
  // silently examining nothing.
  const migrationPaths: string[] = [];
  for (const entry of Array.isArray(raw.migrationPaths) ? raw.migrationPaths : []) {
    if (typeof entry !== 'string') continue;
    try {
      migrationPaths.push(...validateClaimGlobs([entry]));
    } catch {
      // dropped
    }
  }
  return { gates, commands, tools, migrationPaths };
}

/**
 * Which gates run for this project, in catalogue order.
 *
 * The locked six are unconditional: they are added here, from the catalogue,
 * rather than read from the document. That is the structural half of §11's
 * "not un-checkable" — the validator refuses the attempt, and even a document
 * that got past it by some other route cannot subtract from this list.
 */

/**
 * Why this gate may not be ticked yet, or `null` when it may.
 *
 * Its own function, and that is not decoration: `availableFrom` was the third
 * of three locks on the `legal` gate, and when Lena arrived (A115) the last
 * catalogue entry carrying it became `null`. Two tests that proved the lock had
 * used `legal` as their example and went red — correctly, their subject was
 * gone. Testing the mechanism through whichever gate happens to be unbuilt is
 * how a guard disappears the moment nothing needs it, and the next unavailable
 * gate then arrives with no proof at all. So the decision lives here, is
 * exercised against a synthetic definition, and the two call sites below are
 * one expression each.
 */
export function gateUnavailableReason(gate: GateDefinition): string | null {
  return gate.availableFrom ?? null;
}

export function resolveGates(config: ProjectGateConfig): GateDefinition[] {
  return GATE_CATALOGUE.filter(
    (gate) =>
      gate.locked || (config.gates[gate.id] === true && gateUnavailableReason(gate) === null),
  );
}
