/**
 * An in-process deploy target, for the same reason `FakeBackend` exists (A37).
 *
 * §12's order — migrate → swap → health → succeed or roll back — is the part
 * that must be provable, and every exit gate of Phase 5 is about *that* rather
 * than about docker or rsync. A target that keeps its releases in an array
 * makes the whole engine testable without a machine, and it doubles as the
 * fault injector: a swap that throws, a prepare that fails, a release list that
 * is empty because this is the project's first deploy.
 *
 * The rule A37 states applies here too and is the reason this is not a
 * throwaway stub: **a fake that drifts from the real thing tests nothing.** It
 * implements the full `DeployTarget` contract, and the two real targets are
 * held to the same shared suite.
 */
import type { Artifact, DeployContext, DeployTarget } from './target.js';

export interface FakeTargetOptions {
  /** Releases already on the "machine", newest first. */
  existing?: Artifact[];
  failPrepare?: string;
  failSwap?: string;
}

export class FakeDeployTarget implements DeployTarget {
  readonly method = 'compose' as const;
  /** Newest first, like a real target reports. */
  releasesOnMachine: Artifact[];
  /** What is being served right now — null before the first swap. */
  serving: Artifact | null = null;
  readonly swaps: string[] = [];
  readonly pruned: string[] = [];

  constructor(private readonly options: FakeTargetOptions = {}) {
    this.releasesOnMachine = [...(options.existing ?? [])];
  }

  async prepare(context: DeployContext): Promise<Artifact> {
    if (this.options.failPrepare) throw new Error(this.options.failPrepare);
    const artifact = { id: `image:${context.sha}`, sha: context.sha };
    this.releasesOnMachine.unshift(artifact);
    return artifact;
  }

  async swap(_context: DeployContext, artifact: Artifact): Promise<void> {
    if (this.options.failSwap) throw new Error(this.options.failSwap);
    this.swaps.push(artifact.id);
    this.serving = artifact;
  }

  async releases(): Promise<Artifact[]> {
    return [...this.releasesOnMachine];
  }

  /**
   * A11's keep-N, and the one refusal it has to make.
   *
   * The first version was `slice(keep)` and nothing else, which happily deleted
   * the release that was being served — a drift from `DeployTarget`'s own
   * wording ("a prune that silently removed the release a rollback was about to
   * need would be invisible until the rollback") that survived because nothing
   * held this class to the contract it implements. The shared suite does now,
   * and it found this. A37's rule earns its keep here: a fake that drifts from
   * the thing it stands in for tests nothing.
   */
  async prune(_context: DeployContext, keep: number): Promise<string[]> {
    const removed = this.releasesOnMachine
      .slice(keep)
      .filter((artifact) => artifact.id !== this.serving?.id);
    this.releasesOnMachine = this.releasesOnMachine.filter(
      (artifact) => !removed.includes(artifact),
    );
    for (const artifact of removed) this.pruned.push(artifact.id);
    return removed.map((artifact) => artifact.id);
  }
}
