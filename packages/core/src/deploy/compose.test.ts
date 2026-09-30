/**
 * What only the `compose` target can be asked.
 *
 * The shared contract (`target-contract.test.ts`) settles the four verbs and
 * their promises; three implementations answer it identically and that is the
 * point of it. What it cannot ask is *how* — which command, with which
 * arguments, in which order — and for a component whose job is to replace what
 * is running in production, the argv is the behaviour.
 *
 * Every command shape asserted here was measured against docker 29.3.1 /
 * compose v5.1.1 before it was written: `config --images <service>` prints the
 * one reference, `image ls --no-trunc --format` prints `sha256:` ids in full,
 * `compose images --format json` reports the id of the image the container is
 * actually running, and two tags on one image share a `CreatedAt` exactly.
 */
import { describe, expect, it } from 'vitest';
import { ComposeDeployTarget } from './compose.js';
import { COMPOSE_FIXTURE, composeUnderTest, FakeDockerHost } from './fake-machines.js';
import { DeployTargetError } from './target-guards.js';

/** The recorded invocations as one string each, which is what reads. */
function lines(host: FakeDockerHost): string[] {
  return host.calls.map((call) => `${call.command} ${call.argv.join(' ')}`);
}

describe('ComposeDeployTarget: die Befehle selbst (§12)', () => {
  it('baut, gibt dem Ergebnis den Release-Namen und liefert nichts aus', async () => {
    const under = composeUnderTest();
    const artefakt = await under.target.prepare(under.context('a1b2c3d'));

    expect(lines(under.host)).toEqual([
      'docker compose -f docker-compose.yml -f docker-compose.prod.yml config --images app',
      'docker image ls --no-trunc --format {{.Tag}}|{{.ID}}|{{.CreatedAt}} beispiel/app',
      'docker compose -f docker-compose.yml -f docker-compose.prod.yml build app',
      'docker tag beispiel/app:current beispiel/app:a1b2c3d',
    ]);
    expect(artefakt).toEqual({ id: 'beispiel/app:a1b2c3d', sha: 'a1b2c3d' });
    // Nothing was started, so nothing changed for a user.
    expect(lines(under.host).some((line) => line.includes(' up '))).toBe(false);
  });

  it('reicht die Compose-Dateien in der konfigurierten Reihenfolge durch', async () => {
    // `-f` is order-significant to compose and A11 puts the overlay last, so a
    // sort or a de-duplication here would silently change which settings win.
    const under = composeUnderTest();
    await under.target.prepare(under.context('r1'));

    const build = lines(under.host).find((line) => line.includes(' build app'));
    expect(build).toContain('-f docker-compose.yml -f docker-compose.prod.yml');
    expect(build?.indexOf('docker-compose.yml')).toBeLessThan(
      build?.indexOf('docker-compose.prod.yml') ?? -1,
    );
  });

  it('tauscht, indem es den Zeiger umhängt und den Dienst neu erzeugt', async () => {
    const under = composeUnderTest();
    const artefakt = await under.target.prepare(under.context('r1'));
    under.host.calls.length = 0;

    await under.target.swap(under.context('r1'), artefakt);

    // The order is the guarantee: the pointer moves first, so the recreate can
    // only ever start the release that was asked for.
    expect(lines(under.host).slice(-2)).toEqual([
      'docker tag beispiel/app:r1 beispiel/app:current',
      'docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d ' +
        '--force-recreate app',
    ]);
  });

  it('sortiert selbst, auch wenn die Maschine falsch herum antwortet', async () => {
    // The fake emits tag-creation order (oldest first) on purpose. Real docker
    // emits newest-first, so a target that merely relayed the listing would
    // pass against a fake that mirrored docker — and `releases()` promises an
    // order rather than a relay.
    const under = composeUnderTest();
    await under.target.prepare(under.context('r1'));
    await under.target.prepare(under.context('r2'));
    under.host.calls.length = 0;

    const liste = await under.target.releases(under.context('egal'));
    const rohzeilen = under.host.calls.find((call) => call.argv[1] === 'ls');
    expect(rohzeilen).toBeDefined();

    // What the machine handed over, in the order it handed it over.
    const roh = await under.host.run('docker', [
      'image',
      'ls',
      '--no-trunc',
      '--format',
      '{{.Tag}}|{{.ID}}|{{.CreatedAt}}',
      'beispiel/app',
    ]);
    const tags = roh.output
      .trim()
      .split('\n')
      .map((line) => line.split('|')[0]);
    expect(tags).toEqual(['current', 'r1', 'r2']);
    expect(liste.map((artefakt) => artefakt.sha)).toEqual(['r2', 'r1']);
  });

  it('hält den Zeiger-Tag niemals für ein Release', async () => {
    // `current` is what decides which image runs. A prune that considered it a
    // release would eventually consider deleting it.
    const under = composeUnderTest();
    await under.target.prepare(under.context('r1'));

    const liste = await under.target.releases(under.context('egal'));
    expect(liste.map((artefakt) => artefakt.sha)).not.toContain('current');
    expect(under.host.refs()).toContain('beispiel/app:current');
  });

  it('trennt Registry-Port und Tag richtig', async () => {
    // `registry.example:5000/app:current` has two colons and only the second
    // one separates a tag. Splitting on the first would name the repository
    // `registry.example` and tag releases onto somebody else's images.
    const host = new FakeDockerHost('registry.example:5000/app:current');
    const target = new ComposeDeployTarget();
    const context = {
      sha: 'r1',
      projectRoot: '/opt/beispiel',
      config: COMPOSE_FIXTURE,
      run: host.run,
    };

    const artefakt = await target.prepare(context);
    expect(artefakt.id).toBe('registry.example:5000/app:r1');
  });

  it('weist einen Stand ab, der kein Docker-Tag sein kann — vor jedem Befehl', async () => {
    // `DeployService` fills `sha` from `task.branch ?? 'HEAD'` today, and a
    // branch is `vorschicht/task-<id>` (§10). A slash is not a legal docker tag
    // and would be a directory level deeper than the prune ever looks, so the
    // refusal happens before anything is built rather than as a docker error
    // three commands later.
    const under = composeUnderTest();
    await expect(under.target.prepare(under.context('vorschicht/task-7'))).rejects.toThrow(
      DeployTargetError,
    );
    expect(under.host.calls).toEqual([]);
  });

  it('löscht nichts, wenn unklar ist, welches Image läuft', async () => {
    // The reading decides whether a prune may delete the live image, so an
    // unreadable answer must not read as "nothing is running" (A83.6).
    const under = composeUnderTest({
      failOn: (argv) =>
        argv.includes('images') ? { ok: true, code: 0, output: 'nicht json' } : null,
    });
    for (const sha of ['r1', 'r2', 'r3']) await under.target.prepare(under.context(sha));
    const vorher = under.host.refs();

    await expect(under.target.prune(under.context('egal'), 1)).rejects.toThrow(DeployTargetError);
    expect(under.host.refs()).toEqual(vorher);
  });

  it('meldet einen fehlgeschlagenen Befehl mit seiner Ausgabe weiter', async () => {
    const under = composeUnderTest({
      failOn: (argv) =>
        argv.includes('build')
          ? { ok: false, code: 17, output: 'failed to solve: dockerfile parse error' }
          : null,
    });

    await expect(under.target.prepare(under.context('r1'))).rejects.toThrow(
      /dockerfile parse error/,
    );
  });

  it('verweigert die Arbeit, wenn die Konfiguration eine andere Methode nennt', async () => {
    // A54.6's class: not a rollout that failed, a wiring that is wrong.
    const under = composeUnderTest();
    const context = { ...under.context('r1'), config: { method: 'none' as const } };
    await expect(under.target.prepare(context)).rejects.toThrow(/Verdrahtung/);
  });
});
