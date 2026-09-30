/**
 * What only the `static-rsync` target can be asked — and one thing that can
 * only be asked *this* way.
 *
 * A24's word is **atomic**, and the outcome cannot distinguish an atomic flip
 * from a careless one: `rm current && ln -s <release> current` ends with
 * `current` pointing at the right release, exactly like the correct version
 * does. What differs is the instant in between, in which the path does not
 * exist and every request arriving gets a 404. No assertion about the final
 * state can see it. So the assertion is about the **command shape**: the live
 * name is written exactly once, by a `mv -T`, and never removed.
 *
 * The rest is the ordinary half — which argv, in which order, and what the
 * target refuses.
 */
import { describe, expect, it } from 'vitest';
import { FakeReleaseHost, STATIC_FIXTURE, staticUnderTest } from './fake-machines.js';
import { StaticRsyncDeployTarget } from './static-rsync.js';
import { DeployTargetError } from './target-guards.js';

function lines(host: FakeReleaseHost): string[] {
  return host.calls.map((call) => `${call.command} ${call.argv.join(' ')}`);
}

describe('StaticRsyncDeployTarget: die Befehle selbst (§12, A24)', () => {
  it('baut, legt das Releases-Verzeichnis an und lädt genau dorthin hoch', async () => {
    const under = staticUnderTest();
    const artefakt = await under.target.prepare(under.context('a1b2c3d'));

    expect(lines(under.host)).toEqual([
      'pnpm build',
      'ssh -o BatchMode=yes app-host mkdir -p /srv/beispiel/releases',
      'rsync -a --delete /opt/beispiel/dist/ app-host:/srv/beispiel/releases/a1b2c3d/',
    ]);
    expect(artefakt).toEqual({ id: 'releases/a1b2c3d', sha: 'a1b2c3d' });
  });

  it('behält die abschließenden Schrägstriche auf beiden Seiten', async () => {
    // rsync copies the *contents* of a source ending in `/` into the
    // destination. Without them the upload lands one directory deeper and
    // `current` would point at a directory holding a directory.
    const under = staticUnderTest();
    await under.target.prepare(under.context('r1'));

    const upload = under.host.calls.find((call) => call.command === 'rsync');
    expect(upload?.argv.at(-2)).toBe('/opt/beispiel/dist/');
    expect(upload?.argv.at(-1)).toBe('app-host:/srv/beispiel/releases/r1/');
    expect(upload?.argv).toContain('--delete');
  });

  it('tauscht atomar: erst ein Hilfs-Symlink, dann ein mv -T auf current', async () => {
    // The assertion this file exists for. `mv -T` is `rename(2)`, which
    // replaces the link in one step; `rm` followed by `ln` reaches the same
    // final state through a window in which nothing is served.
    const under = staticUnderTest();
    const artefakt = await under.target.prepare(under.context('r1'));
    under.host.calls.length = 0;

    await under.target.swap(under.context('r1'), artefakt);

    expect(lines(under.host)).toEqual([
      'ssh -o BatchMode=yes app-host ln -sfn /srv/beispiel/releases/r1 ' +
        '/srv/beispiel/.current.r1.tmp',
      'ssh -o BatchMode=yes app-host mv -T /srv/beispiel/.current.r1.tmp /srv/beispiel/current',
    ]);
    // The live name is written once and never removed. Both halves matter: a
    // second write would be a second window, and an `rm` would be the window.
    const berührt = lines(under.host).filter((line) => line.endsWith('/srv/beispiel/current'));
    expect(berührt).toHaveLength(1);
    expect(lines(under.host).some((line) => / rm /.test(line))).toBe(false);
    expect(under.host.servingRelease()).toBe('r1');
  });

  it('liest die Releases mit ls -1t und sortiert deshalb nicht selbst', async () => {
    // `-t` is the flag whose entire purpose is "newest first". Re-sorting its
    // output here would be a second answer to a question the machine already
    // answered — the opposite trade from `compose.ts`, which has no such flag.
    const under = staticUnderTest();
    for (const sha of ['r1', 'r2']) await under.target.prepare(under.context(sha));
    under.host.calls.length = 0;

    await under.target.releases(under.context('egal'));
    expect(lines(under.host)).toEqual([
      'ssh -o BatchMode=yes app-host ls -1t /srv/beispiel/releases',
    ]);
  });

  it('liest ein fehlendes Releases-Verzeichnis als leere Liste — der erste Rollout', async () => {
    const under = staticUnderTest();
    expect(await under.target.releases(under.context('egal'))).toEqual([]);
  });

  it('liest jeden anderen Fehler nicht als „es gibt keine Releases"', async () => {
    // The next thing a caller does with an empty list is decide that nothing
    // needs pruning — so an unreachable host must not produce one.
    const under = staticUnderTest({
      failOn: (program, argv) =>
        program === 'ssh' && argv.includes('ls')
          ? { ok: false, code: 255, output: 'ssh: connect to host app-host port 22: No route' }
          : null,
    });

    await expect(under.target.releases(under.context('egal'))).rejects.toThrow(/No route/);
  });

  it('löscht nichts, wenn current da ist, aber kein Symlink', async () => {
    // `readlink` exits 1 for "not there" and for "there, but not a link", and
    // those authorise opposite things. This is the second one: somebody copied
    // a build over `current` by hand, or a swap died between its two commands.
    const under = staticUnderTest();
    for (const sha of ['r1', 'r2', 'r3']) await under.target.prepare(under.context(sha));
    under.host.plantPlainFile('/srv/beispiel/current');

    await expect(under.target.prune(under.context('egal'), 2)).rejects.toThrow(/kein Symlink/);
    expect(under.host.releaseNames()).toHaveLength(3);
  });

  it('löscht nichts, wenn der Host beim Nachsehen nicht erreichbar ist', async () => {
    const under = staticUnderTest({
      failOn: (program, argv) =>
        program === 'ssh' && argv.includes('readlink')
          ? { ok: false, code: 255, output: 'ssh: connect to host app-host port 22: No route' }
          : null,
    });
    for (const sha of ['r1', 'r2', 'r3']) await under.target.prepare(under.context(sha));

    await expect(under.target.prune(under.context('egal'), 2)).rejects.toThrow(/nicht erreichbar/);
    expect(under.host.releaseNames()).toHaveLength(3);
  });

  it('löscht ein Release mit rm -rf unter releases/, nie darüber', async () => {
    const under = staticUnderTest();
    for (const sha of ['r1', 'r2', 'r3']) await under.target.prepare(under.context(sha));
    await under.target.swap(under.context('r3'), { id: 'releases/r3', sha: 'r3' });
    under.host.calls.length = 0;

    expect(await under.target.prune(under.context('egal'), 2)).toEqual(['releases/r1']);
    expect(lines(under.host)).toContain(
      'ssh -o BatchMode=yes app-host rm -rf /srv/beispiel/releases/r1',
    );
    expect(under.host.releaseNames().sort()).toEqual(['r2', 'r3']);
  });

  it('löscht nichts, was die Maschine selbst aufzählt und kein Release ist', async () => {
    // `prune` feeds the machine's own `ls` output into `rm -rf`, which makes
    // that listing an input from outside: what is on that disk is not only what
    // this system put there. The entry that must never survive the trip is
    // `..`, because the path it produces is one level *above* the releases
    // directory.
    const under = staticUnderTest();
    for (const sha of ['r1', 'r2']) await under.target.prepare(under.context(sha));
    under.host.plantRelease('..');
    await under.target.swap(under.context('r2'), { id: 'releases/r2', sha: 'r2' });
    under.host.calls.length = 0;

    const liste = await under.target.releases(under.context('egal'));
    expect(liste.map((artefakt) => artefakt.sha)).not.toContain('..');

    await under.target.prune(under.context('egal'), 1);
    expect(lines(under.host).some((line) => line.includes('/releases/..'))).toBe(false);
  });

  it('weist ein Ziel ohne Host ab, statt ins lokale Dateisystem zu laden', async () => {
    // `rsync /a /b` and `rsync /a host:/b` do very different things, and
    // guessing which was meant is not a guess this may make.
    const host = new FakeReleaseHost('/srv/beispiel');
    const target = new StaticRsyncDeployTarget();
    const context = {
      sha: 'r1',
      projectRoot: '/opt/beispiel',
      config: { ...STATIC_FIXTURE, target: '/srv/beispiel' },
      run: host.run,
    };

    await expect(target.prepare(context)).rejects.toThrow(/host:\/absoluter\/pfad/);
    expect(host.calls).toEqual([]);
  });

  it('weist ein Ziel mit Shell-Sonderzeichen ab und benennt das Zeichen', async () => {
    // ssh and rsync both hand the far side to a shell, by construction. What
    // keeps §19's promise there is that nothing arriving carries a
    // metacharacter.
    const host = new FakeReleaseHost('/srv/beispiel');
    const target = new StaticRsyncDeployTarget();
    const context = {
      sha: 'r1',
      projectRoot: '/opt/beispiel',
      config: { ...STATIC_FIXTURE, target: 'app-host:/srv/beispiel;rm -rf /' },
      run: host.run,
    };

    await expect(target.prepare(context)).rejects.toThrow(/Sonderzeichen ";"/);
    expect(host.calls).toEqual([]);
  });

  it('weist einen Build-Befehl mit Shell-Sonderzeichen ab, bevor er läuft', async () => {
    const host = new FakeReleaseHost('/srv/beispiel');
    const target = new StaticRsyncDeployTarget();
    const context = {
      sha: 'r1',
      projectRoot: '/opt/beispiel',
      config: { ...STATIC_FIXTURE, buildCommand: 'pnpm build && curl example.test' },
      run: host.run,
    };

    await expect(target.prepare(context)).rejects.toThrow(/Sonderzeichen/);
    expect(host.calls).toEqual([]);
  });

  it('weist ein Artefakt ab, das kein Release dieses Ziels ist', async () => {
    // The id comes back out of `deployments.artifact` weeks later and is about
    // to be interpolated into a path on a remote machine.
    const under = staticUnderTest();
    await expect(
      under.target.swap(under.context('r1'), { id: '../../etc', sha: 'r1' }),
    ).rejects.toThrow(DeployTargetError);
    expect(under.host.calls).toEqual([]);
  });

  it('weist auch einen Namen ab, der sich aus releases/ heraus bewegt', async () => {
    // The second layer, and it needs its own case: the one above is stopped by
    // the `releases/` prefix, so it says nothing about the name check behind
    // it. This id has the right prefix and the wrong name — the shape that ends
    // up in a remote `rm -rf` a directory too high.
    const under = staticUnderTest();
    await expect(
      under.target.swap(under.context('r1'), { id: 'releases/../../etc', sha: 'r1' }),
    ).rejects.toThrow(/nicht verwendbar/);
    expect(under.host.calls).toEqual([]);
  });
});
