/**
 * §12's `static-rsync` method (A11, A24): Capistrano's shape, and the flip is
 * the whole point.
 *
 * A24 states it in one clause — "`releases/<sha>` + atomic `current` symlink
 * (keep 5)" — and the word carrying the weight is *atomic*. The obvious build
 * is `rm current && ln -s <release> current`, and it is wrong in a way no test
 * of the outcome can see: between those two calls the path does not exist, and
 * every request arriving in that window is a 404. The window is small, which is
 * exactly why it would be found in production and not before.
 *
 * So the flip is `ln -sfn` to a **temporary** name followed by `mv -T` onto
 * `current`. `mv -T` is `rename(2)`, which replaces the symlink in one step:
 * there is no instant at which `current` is absent, only an instant before and
 * an instant after. The rollback A24 promises in milliseconds is the same pair
 * pointed at an older release — `swap` to an older artifact, which is what
 * `target.ts` says a rollback is.
 *
 * Four further decisions:
 *
 *  1. **`releases()` does not sort, because `ls -1t` does.** `-t` is the flag
 *     whose entire purpose is "newest first"; re-sorting its output here would
 *     be a second answer to a question the machine already answered. Contrast
 *     `compose.ts`, which does sort — there is no such flag on `docker image ls`
 *     and its ordering is an undocumented default.
 *
 *  2. **A missing releases directory is an empty list, and every other failure
 *     is an error.** The first deploy of a project finds nothing there, and
 *     reporting that as a fault would make every project's first rollout fail.
 *     Anything else — an unreachable host, a permission error — must not read
 *     as "there are no releases", because the very next thing a caller does
 *     with an empty list is decide nothing needs pruning. The same distinction
 *     is drawn again, and more carefully, for `current`: `readlink` exits 1
 *     both when the link is not there yet *and* when something is there that is
 *     not a link, and those two authorise opposite things — the first is the
 *     first deploy, the second is a host somebody has been editing by hand. So
 *     the failure path asks `test -e` and only the genuine absence yields
 *     "nothing is serving". An unreadable answer fails closed: it is the
 *     reading that decides whether `prune` may delete the live release, and
 *     "we could not find out" and "it is safe" are the same sentence only to a
 *     system that has decided not to notice (A83.6).
 *
 *  3. **The remote side is a shell and there is nothing to be done about it.**
 *     `ssh host cmd` and rsync's remote path are both interpreted over there.
 *     `DeployContext.run` keeps §19's promise locally; what keeps it remotely is
 *     that no configured value reaching the far side carries a metacharacter,
 *     checked once in `target-guards.ts`. `BatchMode=yes` is set for the second
 *     half of the same posture: an unattended deploy must fail rather than sit
 *     at a passphrase prompt nobody will ever answer.
 *
 *  4. **A name that came back from the machine is checked before it is
 *     deleted.** `prune` feeds `ls` output into `rm -rf`, and the one entry that
 *     must never survive that trip is `..`.
 */
import { parseGateCommand } from '../gate-suite.js';
import type { Artifact, CommandResult, DeployContext, DeployTarget } from './target.js';
import {
  assertReleaseName,
  assertRemoteSafe,
  DeployTargetError,
  isReleaseName,
} from './target-guards.js';

/** Where releases live under the configured target path. */
const RELEASES_DIR = 'releases';
/** The name every request resolves through; the only thing a swap moves. */
const CURRENT_LINK = 'current';

/** Never prompt, never hang — an unattended deploy has nobody to answer. */
const SSH_OPTIONS = ['-o', 'BatchMode=yes'] as const;

/**
 * ssh's own exit code when it could not run the command at all.
 *
 * It is the one code that means "the remote command never ran", as opposed to
 * "it ran and said no" — and the difference decides whether a failed `readlink`
 * is information or an outage.
 */
const SSH_TRANSPORT_FAILURE = 255;

interface RemoteTarget {
  host: string;
  /** Absolute, no trailing slash. */
  path: string;
}

export class StaticRsyncDeployTarget implements DeployTarget {
  readonly method = 'static-rsync' as const;

  async prepare(context: DeployContext): Promise<Artifact> {
    const config = staticConfig(context);
    const sha = assertReleaseName(context.sha, 'Der auszurollende Stand');
    const remote = parseTarget(config.target);
    const distDir = assertRemoteSafe('Das Verzeichnis mit dem Build-Ergebnis', config.distDir);

    // The command is parsed *here* rather than handed on whole, so the refusal
    // of a shell metacharacter happens before anything reaches a machine — and
    // it is `parseGateCommand`, the one splitter this project has (A55.3).
    const build = parseGateCommand(config.buildCommand);
    const [program, ...args] = build;
    if (!program) {
      throw new DeployTargetError(config.buildCommand, 'Der Build-Befehl ist leer.');
    }
    await this.run(context, program, args);

    await this.ssh(context, remote, ['mkdir', '-p', `${remote.path}/${RELEASES_DIR}`]);
    // The trailing slashes are load-bearing on both sides: rsync copies the
    // *contents* of the source into the destination directory, and `--delete`
    // makes a re-upload of the same sha idempotent rather than cumulative.
    await this.run(context, 'rsync', [
      '-a',
      '--delete',
      `${context.projectRoot}/${distDir}/`,
      `${remote.host}:${remote.path}/${RELEASES_DIR}/${sha}/`,
    ]);

    return { id: `${RELEASES_DIR}/${sha}`, sha };
  }

  async swap(context: DeployContext, artifact: Artifact): Promise<void> {
    const config = staticConfig(context);
    const remote = parseTarget(config.target);
    const name = releaseNameOf(artifact);
    const release = `${remote.path}/${RELEASES_DIR}/${name}`;
    const staging = `${remote.path}/.${CURRENT_LINK}.${name}.tmp`;

    // Two commands, and the order is the guarantee. `ln -sfn` writes a symlink
    // nobody is looking at yet; `mv -T` replaces `current` with it in one
    // `rename(2)`. Doing this as `rm` + `ln` would be one command shorter and
    // would serve a 404 to everything arriving in between.
    await this.ssh(context, remote, ['ln', '-sfn', release, staging]);
    await this.ssh(context, remote, ['mv', '-T', staging, `${remote.path}/${CURRENT_LINK}`]);
  }

  async releases(context: DeployContext): Promise<Artifact[]> {
    const remote = parseTarget(staticConfig(context).target);
    const listed = await context.run('ssh', [
      ...SSH_OPTIONS,
      remote.host,
      'ls',
      '-1t',
      `${remote.path}/${RELEASES_DIR}`,
    ]);

    if (!listed.ok) {
      // A project that has never been deployed has no releases directory, and
      // that is not a fault. Everything else is.
      if (/no such file or directory/i.test(listed.output)) return [];
      throw new DeployTargetError(
        `ssh ${remote.host} ls -1t ${remote.path}/${RELEASES_DIR}`,
        `Die Releases auf „${remote.host}" waren nicht lesbar (Code ${listed.code}): ` +
          listed.output,
      );
    }

    return listed.output
      .split('\n')
      .map((line) => line.trim())
      .filter((name) => name !== '' && isReleaseName(name))
      .map((name) => ({ id: `${RELEASES_DIR}/${name}`, sha: name }));
  }

  async prune(context: DeployContext, keep: number): Promise<string[]> {
    const remote = parseTarget(staticConfig(context).target);
    const serving = await this.serving(context, remote);

    const removed: string[] = [];
    for (const artifact of (await this.releases(context)).slice(keep)) {
      // A11 keeps five, so this is normally unreachable. It is reachable on a
      // project configured `keep: 2` in the middle of a rollback, which is the
      // one moment when deleting what `current` points at takes production down
      // and leaves nothing to go back to.
      if (serving !== null && artifact.sha === serving) continue;
      await this.ssh(context, remote, [
        'rm',
        '-rf',
        `${remote.path}/${RELEASES_DIR}/${artifact.sha}`,
      ]);
      removed.push(artifact.id);
    }
    return removed;
  }

  /**
   * Which release `current` points at, or null when there is genuinely no
   * `current` yet.
   *
   * Null is the *only* answer that lets `prune` delete anything, so every way
   * of not knowing has to raise instead. `readlink` cannot tell the two apart
   * on its own — it exits 1 for "not there" and for "there, but not a symlink"
   * alike — so the failure path asks a second question. Cheap, because it is
   * only ever asked when the first answer was a failure.
   */
  private async serving(context: DeployContext, remote: RemoteTarget): Promise<string | null> {
    const link = `${remote.path}/${CURRENT_LINK}`;
    const read = await context.run('ssh', [...SSH_OPTIONS, remote.host, 'readlink', link]);

    if (read.ok) {
      const name = read.output.trim().split('/').pop() ?? '';
      if (isReleaseName(name)) return name;
      throw new DeployTargetError(
        `ssh ${remote.host} readlink ${link}`,
        `„current" zeigt auf „${read.output.trim()}" — das ist kein Release dieses Ziels. ` +
          'Solange unklar ist, was ausgeliefert wird, wird nichts gelöscht.',
      );
    }
    if (read.code === SSH_TRANSPORT_FAILURE) {
      throw new DeployTargetError(
        `ssh ${remote.host} readlink ${link}`,
        `Der Host „${remote.host}" war nicht erreichbar (ssh-Code 255): ${read.output}`,
      );
    }

    const exists = await context.run('ssh', [...SSH_OPTIONS, remote.host, 'test', '-e', link]);
    if (exists.code === SSH_TRANSPORT_FAILURE) {
      throw new DeployTargetError(
        `ssh ${remote.host} test -e ${link}`,
        `Der Host „${remote.host}" war nicht erreichbar (ssh-Code 255): ${exists.output}`,
      );
    }
    if (exists.ok) {
      throw new DeployTargetError(
        `ssh ${remote.host} readlink ${link}`,
        `Unter „${link}" liegt etwas, das kein Symlink ist. Das ist ein Eingriff von Hand oder ` +
          'ein abgebrochener Tausch; bis das geklärt ist, wird kein Release gelöscht.',
      );
    }
    // Genuinely absent: the first deploy of a project, where there is at most
    // one release and `keep` has a floor of 2 — so this branch authorises
    // nothing that could hurt.
    return null;
  }

  private async ssh(
    context: DeployContext,
    remote: RemoteTarget,
    argv: string[],
  ): Promise<CommandResult> {
    return this.run(context, 'ssh', [...SSH_OPTIONS, remote.host, ...argv]);
  }

  private async run(
    context: DeployContext,
    program: string,
    argv: string[],
  ): Promise<CommandResult> {
    const result = await context.run(program, argv);
    if (!result.ok) {
      throw new DeployTargetError(
        `${program} ${argv.join(' ')}`,
        `„${program} ${argv.join(' ')}" ist mit Code ${result.code} fehlgeschlagen: ` +
          result.output,
      );
    }
    return result;
  }
}

function staticConfig(context: DeployContext) {
  if (context.config.method !== 'static-rsync') {
    throw new DeployTargetError(
      context.config.method,
      `Das static-rsync-Ziel ist mit einer „${context.config.method}"-Konfiguration aufgerufen ` +
        'worden. Das ist ein Fehler der Verdrahtung, nicht des Rollouts.',
    );
  }
  return context.config;
}

/**
 * `host:/path` → the two halves.
 *
 * The **first** colon separates them, because a path may contain one and a host
 * may not. A target without a colon is refused rather than read as a local
 * path: `rsync /a /b` and `rsync /a host:/b` do very different things, and
 * guessing which was meant is not a guess this may make.
 */
function parseTarget(target: string): RemoteTarget {
  assertRemoteSafe('Das Deploy-Ziel', target);
  const colon = target.indexOf(':');
  const host = colon < 0 ? '' : target.slice(0, colon);
  const path = colon < 0 ? '' : target.slice(colon + 1).replace(/\/+$/, '');
  if (host === '' || path === '' || !path.startsWith('/')) {
    throw new DeployTargetError(
      target,
      `Das Deploy-Ziel „${target}" hat nicht die Form „host:/absoluter/pfad". Ohne Host lädt ` +
        'rsync ins lokale Dateisystem, und ohne absoluten Pfad hängt das Ergebnis davon ab, in ' +
        'welchem Heimatverzeichnis die ssh-Sitzung landet.',
    );
  }
  return { host, path };
}

/**
 * The release directory an artifact names.
 *
 * The id is what survives in `deployments.artifact`, so a rollback arrives here
 * with a string written weeks ago (`target.ts`: the *name* travels rather than
 * the sha). It is checked rather than trusted — it is about to be interpolated
 * into a path on a remote machine.
 */
function releaseNameOf(artifact: Artifact): string {
  const prefix = `${RELEASES_DIR}/`;
  if (!artifact.id.startsWith(prefix)) {
    throw new DeployTargetError(
      artifact.id,
      `„${artifact.id}" ist kein Release dieses Ziels — erwartet wird „${prefix}<name>".`,
    );
  }
  return assertReleaseName(artifact.id.slice(prefix.length), 'Das Release');
}
