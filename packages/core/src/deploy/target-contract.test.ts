/**
 * The shared `DeployTarget` contract suite (§12, A11, A24).
 *
 * `backend/contract.test.ts` is the model and the argument is the same one A31
 * makes for `ModelBackend`: every implementation is held to the same promises,
 * in the same file, so an implementation that drifts **fails** rather than
 * being differently correct. Three are held to it here — `FakeDeployTarget`
 * included, because A37's rule is that a fake which drifts from the thing it
 * stands in for tests nothing, and because §12's whole engine is proven against
 * that fake in `service.itest.ts`.
 *
 * It found one on its first run: `FakeDeployTarget.prune` deleted the release
 * it was serving. `target.ts` says in as many words that "a prune that silently
 * removed the release a rollback was about to need would be invisible until the
 * rollback", and nothing had ever asked the fake that question.
 *
 * Two properties of how this is written matter more than the cases:
 *
 *  1. **"What is serving" is asked of the machine, never of the target.** A
 *     target that reported its own idea of what it had swapped would agree with
 *     itself in exactly the case where it is wrong. So `DeployTargetUnderTest`
 *     supplies a `serving()` that reads the stand-in host — the running
 *     container's image for `compose`, the `current` symlink for
 *     `static-rsync`.
 *
 *  2. **No docker, no ssh, no database.** Everything the targets do goes
 *     through `DeployContext.run`, so the machines are in-process
 *     (`fake-machines.ts`) and this is a `*.test.ts` that runs in `gate:test`
 *     on a laptop with neither daemon installed.
 */
import { describe, expect, it } from 'vitest';
import {
  composeUnderTest,
  type DeployTargetUnderTest,
  fakeTargetUnderTest,
  staticUnderTest,
} from './fake-machines.js';
import type { Artifact } from './target.js';

export function describeDeployTarget(name: string, make: () => DeployTargetUnderTest): void {
  describe(`${name}: DeployTarget-Vertrag (§12, A11, A24)`, () => {
    /** Build and publish one release, the way `DeployService` does. */
    async function publish(under: DeployTargetUnderTest, sha: string): Promise<Artifact> {
      return under.target.prepare(under.context(sha));
    }

    async function serve(under: DeployTargetUnderTest, artifact: Artifact): Promise<void> {
      await under.target.swap(under.context(artifact.sha), artifact);
    }

    async function ids(under: DeployTargetUnderTest): Promise<string[]> {
      return (await under.target.releases(under.context('egal'))).map((artifact) => artifact.id);
    }

    it('gibt ein Artefakt zurück, das den ausgerollten Stand benennt', async () => {
      const under = make();
      const artifact = await publish(under, 'r1');
      expect(artifact.sha).toBe('r1');
      expect(artifact.id).not.toBe('');
      expect(await ids(under)).toContain(artifact.id);
    });

    it('veröffentlicht, ohne auszuliefern — das Bisherige läuft weiter', async () => {
      // The split between `prepare` and `swap` is what makes A24's order
      // possible at all: the migration runs between them, and a failure there
      // must have changed nothing a user can see.
      const under = make();
      const erste = await publish(under, 'r1');
      await serve(under, erste);
      expect(await under.serving()).toBe(erste.id);

      const zweite = await publish(under, 'r2');
      expect(await ids(under)).toContain(zweite.id);
      expect(await under.serving()).toBe(erste.id);
    });

    it('zählt die Releases neueste zuerst auf', async () => {
      // Everything downstream assumes it, and `prune` turns it into deletions.
      const under = make();
      await publish(under, 'r1');
      await publish(under, 'r2');
      const dritte = await publish(under, 'r3');

      const liste = await under.target.releases(under.context('egal'));
      expect(liste.map((artifact) => artifact.sha)).toEqual(['r3', 'r2', 'r1']);
      expect(liste[0]?.id).toBe(dritte.id);
    });

    it('tauscht zweimal auf dasselbe Artefakt, ohne dass sich etwas ändert', async () => {
      // A deploy that is retried after a wobble must not produce a second
      // release or a different answer to "what is running".
      const under = make();
      const artifact = await publish(under, 'r1');
      await serve(under, artifact);
      const vorher = await ids(under);

      await serve(under, artifact);
      expect(await under.serving()).toBe(artifact.id);
      expect(await ids(under)).toEqual(vorher);
    });

    it('tauscht auch auf ein älteres Artefakt — das *ist* der Rollback (§12)', async () => {
      // `target.ts`: rollback is not a verb. §12 goes back by deploying the
      // last-good release again, so this one case is the entire rollback path
      // of both methods.
      const under = make();
      const alt = await publish(under, 'r1');
      const neu = await publish(under, 'r2');

      await serve(under, alt);
      await serve(under, neu);
      expect(await under.serving()).toBe(neu.id);

      await serve(under, alt);
      expect(await under.serving()).toBe(alt.id);
    });

    it('behält beim Aufräumen genau keep und gibt zurück, was es entfernt hat', async () => {
      const under = make();
      const artefakte: Artifact[] = [];
      for (const sha of ['r1', 'r2', 'r3', 'r4']) artefakte.push(await publish(under, sha));
      await serve(under, artefakte[3] as Artifact);

      const entfernt = await under.target.prune(under.context('egal'), 2);

      expect([...entfernt].sort()).toEqual([artefakte[0]?.id, artefakte[1]?.id].sort() as string[]);
      expect(await ids(under)).toEqual([artefakte[3]?.id, artefakte[2]?.id]);
    });

    it('entfernt niemals das Release, das gerade ausgeliefert wird', async () => {
      // A11 keeps five, so this cannot normally bite. It bites on a project
      // configured `keep: 2` in the middle of a rollback — production is on an
      // *old* release, and the prune would delete exactly that one.
      const under = make();
      const artefakte: Artifact[] = [];
      for (const sha of ['r1', 'r2', 'r3', 'r4']) artefakte.push(await publish(under, sha));
      const bedient = artefakte[0] as Artifact;
      await serve(under, bedient);

      const entfernt = await under.target.prune(under.context('egal'), 2);

      expect(entfernt).not.toContain(bedient.id);
      expect(entfernt).toEqual([artefakte[1]?.id]);
      expect(await ids(under)).toContain(bedient.id);
      expect(await under.serving()).toBe(bedient.id);
    });

    it('entfernt nichts, wenn es weniger Releases gibt als keep', async () => {
      const under = make();
      await publish(under, 'r1');
      const zweite = await publish(under, 'r2');
      await serve(under, zweite);

      expect(await under.target.prune(under.context('egal'), 5)).toEqual([]);
      expect(await ids(under)).toHaveLength(2);
    });
  });
}

describeDeployTarget('fake', fakeTargetUnderTest);
describeDeployTarget('compose', () => composeUnderTest());
describeDeployTarget('static-rsync', () => staticUnderTest());
