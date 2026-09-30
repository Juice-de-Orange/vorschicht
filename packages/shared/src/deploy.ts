/**
 * What deploying a project means, as configuration (§12, A11, A24).
 *
 * §12 makes deployment automatic after a green merge, with a health check and
 * an automatic rollback. That is a lot of authority to hand a config document,
 * so five things are decided here rather than left to the engine:
 *
 *  1. **The method is a discriminated union, not a bag of optional fields.**
 *     A `compose` deploy needs a service name and a `static-rsync` one needs a
 *     target path, and a shape where both are optional would let a half-filled
 *     document pass validation and fail at the moment it swaps production. The
 *     three methods of A11/A24 are three shapes, and `none` genuinely has no
 *     fields — §12 ends that pipeline at merge.
 *
 *  2. **Every command is argv, and a shell metacharacter is refused here.**
 *     A deploy command is proposed by an onboarding agent (§20) and waved
 *     through by a human, which is precisely the input a shell must never see.
 *     `GATE_SHELL_METACHARACTERS` is reused rather than restated: two dialects
 *     of "which characters are dangerous" would be two answers to one question,
 *     and the day they differ is the day the narrower one is the only guard.
 *
 *  3. **A health check needs a URL *and* a bound.** §12 says "poll interval /
 *     timeout" and the rollback hangs off the timeout expiring. A configuration
 *     that could omit it would produce a deploy that waits forever on a service
 *     that never comes up — which is the one outcome worse than a rollback,
 *     because nothing else is allowed to start meanwhile.
 *
 *  4. **`keep` is bounded on both sides.** A11 says keep the last 5. Zero would
 *     delete the release currently serving; unbounded is a disk filling up
 *     silently, which A30 then has to notice. The default is 5 and the floor
 *     is 2 — one to serve and one to roll back to, which is the minimum that
 *     makes §12's rollback possible at all.
 *
 *  5. **Approval is not in this document.** A12 requires the operator's explicit
 *     approval for every self-deploy, and that is `projects.self_managed` plus
 *     an inbox item — deliberately *not* a field here, because a config flag
 *     called `requiresApproval` is a flag somebody can set to false. The engine
 *     reads the project, not the deploy config.
 */
import { z } from 'zod';
import { type DeployMethod, deployMethodSchema } from './agent-result.js';
import { GATE_SHELL_METACHARACTERS } from './gates.js';

/**
 * The methods are `agent-result.ts`'s, not a second list.
 *
 * `deployMethodSchema` has been there since the onboarding proposal needed it,
 * and declaring the same three values again here is exactly the shape this
 * project spent a day removing: two lists that agree until they do not. The
 * labels below key off that type, so a fourth method breaks this file rather
 * than silently rendering `undefined`.
 */
export { type DeployMethod, deployMethodSchema };

/** German (§2) — shown on the project page and in the onboarding proposal. */
export const DEPLOY_METHOD_LABELS: Record<DeployMethod, string> = {
  none: 'Kein Deployment — ein grüner Merge ist der Schluss',
  compose: 'Docker Compose (Image je Commit, Dienst-Tausch)',
  'static-rsync': 'Statische Dateien (Releases + current-Symlink)',
};

/** How many releases or images survive a prune (A11: keep the last 5). */
export const DEFAULT_KEEP_RELEASES = 5;

/**
 * How long a health check may take before §12 calls it a failure.
 *
 * Ninety seconds is a container start plus a migration plus slack; the point of
 * a default is that a project which never thought about it still gets a bound
 * rather than an unbounded wait.
 */
export const DEFAULT_HEALTH_TIMEOUT_MS = 90_000;
export const DEFAULT_HEALTH_INTERVAL_MS = 3_000;

/**
 * One command, as argv.
 *
 * Split on whitespace, never handed to a shell. The refusal names the offending
 * character, following the posture A51 took for hook paths and A55 for gate
 * commands: a message that says "invalid" sends somebody hunting.
 */
export const deployCommand = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    if (!GATE_SHELL_METACHARACTERS.test(value)) return;
    ctx.addIssue({
      code: 'custom',
      message:
        `Der Befehl „${value}" enthält ein Shell-Sonderzeichen. Deploy-Befehle werden als ` +
        'Argumentliste ausgeführt und nie an eine Shell übergeben (§19) — schreib ihn ohne ' +
        ';, &, |, <, >, $, Anführungszeichen oder Klammern.',
    });
  });

const healthCheck = {
  /** Polled until it answers or the timeout expires (§12). */
  healthUrl: z.url(),
  healthTimeoutMs: z.number().int().min(1_000).max(1_800_000).default(DEFAULT_HEALTH_TIMEOUT_MS),
  healthIntervalMs: z.number().int().min(250).max(60_000).default(DEFAULT_HEALTH_INTERVAL_MS),
};

const shared = {
  /**
   * Runs **before** the swap (A24: migrate → swap → health).
   *
   * Optional because most projects have no schema. Where it exists, the order
   * is not negotiable: a rollback restores the previous release's *code* and
   * cannot undo what a migration did to the data, which is why A24 also makes a
   * non-backward-compatible migration stop the deploy instead of running it.
   */
  migrateCommand: deployCommand.optional(),
  /** §12's optional post-deploy smoke, run after health is green. */
  smokeCommand: deployCommand.optional(),
  keep: z.number().int().min(2).max(50).default(DEFAULT_KEEP_RELEASES),
};

export const deployConfigSchema = z.discriminatedUnion('method', [
  /**
   * A24: the pipeline ends at merge. Not "deployment is broken" — a library, a
   * spec repository and an analysis-only project are all legitimately here, and
   * saying so explicitly is what keeps `done` from reading like a failure.
   */
  z.object({ method: z.literal('none') }),

  z.object({
    method: z.literal('compose'),
    /** In the order `docker compose -f` takes them; the overlay comes last. */
    composeFiles: z.array(z.string().min(1)).min(1),
    /** The one service that gets swapped. */
    service: z.string().min(1),
    ...healthCheck,
    ...shared,
  }),

  z.object({
    method: z.literal('static-rsync'),
    /** What produces the directory below. */
    buildCommand: deployCommand,
    /** Relative to the worktree — what gets uploaded. */
    distDir: z.string().min(1),
    /** `host:/path` — releases land in `<path>/releases/<sha>`, `current` flips. */
    target: z.string().min(1),
    ...healthCheck,
    ...shared,
  }),
]);

export type DeployConfig = z.infer<typeof deployConfigSchema>;

/** What a project with no configuration at all deploys: nothing (A24). */
export const NO_DEPLOY: DeployConfig = { method: 'none' };

export interface DeployConfigValidation {
  ok: boolean;
  /** German, ready to render. Empty exactly when `ok`. */
  errors: string[];
}

/**
 * Read a stored `deploy_config` column, or say why it cannot be used.
 *
 * Separate from `parseDeployConfig` for the reason `validateProjectGateConfig`
 * is separate: a route needs every reason at once to render them, and a caller
 * that only wants the value should not have to build an error list to get it.
 */
export function validateDeployConfig(input: unknown): DeployConfigValidation {
  const parsed = deployConfigSchema.safeParse(input);
  if (parsed.success) return { ok: true, errors: [] };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => {
      const field = issue.path.length > 0 ? issue.path.join('.') : 'method';
      // A refinement already carries its own German sentence; a shape error's
      // zod message is English, and §2 is unconditional about text a person
      // reads.
      return issue.code === 'custom'
        ? issue.message
        : `Das Feld „${field}" hat nicht die erwartete Form.`;
    }),
  };
}

/**
 * The configuration, or `none`.
 *
 * An unreadable document becomes `none` rather than throwing, and that is the
 * safe direction on purpose: §12 hands this document the authority to replace
 * what is running, so "we could not read it" must mean "deploy nothing", never
 * "deploy with whatever survived parsing". The project page and the merge queue
 * both surface the refusal separately, so it is loud rather than silent.
 */
export function readDeployConfig(input: unknown): DeployConfig {
  const parsed = deployConfigSchema.safeParse(input);
  return parsed.success ? parsed.data : NO_DEPLOY;
}

/** Does a green merge end the pipeline here (A24)? */
export function endsAtMerge(config: DeployConfig): boolean {
  return config.method === 'none';
}
