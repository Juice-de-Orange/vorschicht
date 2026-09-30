/**
 * What a deploy method has to be able to do (§12, A11, A24).
 *
 * The seam exists for the reason `ModelBackend` exists one subsystem over: §12
 * names three methods, two of them touch a real machine, and the orchestration
 * around them — migrate, swap, health, roll back, escalate — is the same for
 * all three and is the part that must be provable without one. So the *order*
 * lives in `DeployService` and only the four verbs below live per method.
 *
 * Four things are deliberately **not** on this interface:
 *
 *   * **Rollback is not a verb.** §12 rolls back by deploying the last-good
 *     release again — `swap` to an older artifact — rather than by an inverse
 *     operation each method would implement differently and nobody would test.
 *     For `static-rsync` that is the symlink flip A24 names; for `compose` it is
 *     redeploying the previous image tag. One code path, two behaviours.
 *   * **The health check.** It is an HTTP poll against a URL in the config and
 *     is identical everywhere, so a method that could override it would be a
 *     method that could weaken it.
 *   * **Deciding anything.** A target does what it is told and reports what
 *     happened. Whether a deploy may start at all is the guardian's and A12's
 *     question, and it is answered before any of this is called.
 *   * **Writing records.** `deployment_events` is written by the service, so
 *     the log cannot disagree with the orchestration that produced it.
 */
import type { DeployConfig, DeployMethod } from '@vorschicht/shared';

export interface DeployContext {
  /** The commit that is being rolled out. Also the artifact's name. */
  sha: string;
  /** Absolute path to the project checkout the release is built from. */
  projectRoot: string;
  config: DeployConfig;
  /** Runs a configured command as argv, never through a shell (§19). */
  run(command: string, argv: readonly string[]): Promise<CommandResult>;
}

export interface CommandResult {
  ok: boolean;
  code: number | null;
  /** Trimmed and capped — §12 escalates "with full logs", not with a core dump. */
  output: string;
}

/**
 * One releasable thing, named the way the target names it on the machine.
 *
 * An image tag for `compose`, a release directory for `static-rsync`. The
 * *name* travels rather than the sha, because a rollback has to point at
 * something that still exists after a prune — and after `keep` releases, the
 * sha is a fact about history while the artifact is a fact about the disk.
 */
export interface Artifact {
  id: string;
  sha: string;
}

export interface DeployTarget {
  readonly method: DeployMethod;

  /**
   * Build and publish, without serving it yet.
   *
   * The split from `swap` is what makes A24's order possible: a migration runs
   * between them, and a failure here has changed nothing a user can see.
   */
  prepare(context: DeployContext): Promise<Artifact>;

  /** Make this artifact the one being served. Also the rollback path. */
  swap(context: DeployContext, artifact: Artifact): Promise<void>;

  /** Everything currently on the target, newest first. */
  releases(context: DeployContext): Promise<Artifact[]>;

  /**
   * Delete all but the newest `keep` (A11).
   *
   * Returns what it removed, so the record says it rather than implying it. A
   * prune that silently removed the release a rollback was about to need would
   * be invisible until the rollback.
   */
  prune(context: DeployContext, keep: number): Promise<string[]>;
}

/** Polling a health URL is the same question whatever produced the release. */
export type HealthProbe = (url: string) => Promise<{ ok: boolean; detail: string }>;

/**
 * The default probe: any 2xx is healthy, everything else is not.
 *
 * A redirect is deliberately **not** followed. §12's health URL names the thing
 * that is supposed to be serving; a 302 to a login page is a server that came
 * up and is not doing its job, and following it would turn that into a green.
 */
export async function httpHealthProbe(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(url, { redirect: 'manual', signal: controller.signal });
      return {
        ok: response.status >= 200 && response.status < 300,
        detail: `HTTP ${response.status}`,
      };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { ok: false, detail: (error as Error).message };
  }
}
