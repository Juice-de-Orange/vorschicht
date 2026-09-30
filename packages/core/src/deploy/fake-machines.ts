/**
 * The two machines the real deploy targets talk to, in process (A37).
 *
 * `FakeDeployTarget` makes §12's *engine* provable without a machine. These
 * make the two real *targets* provable without one — which is a different and
 * harder job, because what has to be checked there is exactly the part a stub
 * would paper over: which command, with which arguments, in which order, and
 * what the target concludes from what comes back.
 *
 * A37's rule governs and is the reason these are as long as they are: **a fake
 * that drifts from the real thing tests nothing.** So both are modelled in the
 * machine's own vocabulary rather than in the target's. `FakeDockerHost` knows
 * about image ids and tags that point at them, because that is what docker is;
 * it does not know that `swap` re-tags. `FakeReleaseHost` knows about
 * directories and symlinks, and `mv -T` moves a link in one step because
 * `rename(2)` does. Every behaviour either of them shows was measured against
 * docker 29.3.1 / compose v5.1.1 first, and the two places where they
 * deliberately differ from the real thing are marked and argued.
 *
 * Neither needs docker, ssh or a network, which is why the suites built on them
 * are `*.test.ts` and run in `gate:test` on any machine.
 */
import type { DeployConfig } from '@vorschicht/shared';
import { ComposeDeployTarget } from './compose.js';
import { FakeDeployTarget } from './fake-target.js';
import { StaticRsyncDeployTarget } from './static-rsync.js';
import type { CommandResult, DeployContext, DeployTarget } from './target.js';

/** One invocation, as the target issued it. */
export interface RecordedCommand {
  command: string;
  argv: string[];
}

/** `docker`-style timestamps: `2026-08-02 21:39:14 +0200 CEST` (measured). */
function dockerTime(minute: number): string {
  const at = new Date(Date.UTC(2026, 7, 2, 18, 0, 0) + minute * 60_000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} ` +
    `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())} +0000 UTC`
  );
}

const OK: CommandResult = { ok: true, code: 0, output: '' };

function fail(output: string, code = 1): CommandResult {
  return { ok: false, code, output };
}

/**
 * Docker and compose, as far as `ComposeDeployTarget` can see them.
 *
 * The model is docker's: an **image** is an id with a creation time, a **tag**
 * is a name pointing at an id, and a **container** runs an id. Everything the
 * target concludes — which releases exist, which one is live — has to come out
 * of that, exactly as it does on a real host.
 */
export class FakeDockerHost {
  readonly calls: RecordedCommand[] = [];
  /** image id → creation time, in docker's own format. */
  private readonly images = new Map<string, string>();
  /** `repo:tag` → image id. */
  private readonly tags = new Map<string, string>();
  /** The image the service's container is running, or null before the first up. */
  private container: string | null = null;
  private minute = 0;
  private built = 0;

  constructor(
    /** What the compose file names for the service — the `current` pointer. */
    private readonly composeImage: string,
    /**
     * A fault, returned as a whole `CommandResult` rather than a message.
     *
     * The exit code carries meaning the message cannot: ssh answers 255 when it
     * never reached the host at all, and a target that treats that the same as
     * "the command ran and said no" fails open at the worst moment.
     */
    private readonly faults: { failOn?: (argv: string[]) => CommandResult | null } = {},
  ) {}

  run = async (command: string, argv: readonly string[]): Promise<CommandResult> => {
    const args = [...argv];
    this.calls.push({ command, argv: args });

    const injected = this.faults.failOn?.(args);
    if (injected) return injected;
    if (command !== 'docker') return fail(`fake: ${command} ist auf diesem Host nicht bekannt`);

    if (args[0] === 'compose') return this.compose(args);
    if (args[0] === 'tag') return this.tag(args[1], args[2]);
    if (args[0] === 'image' && args[1] === 'ls') return this.imageLs(args);
    if (args[0] === 'image' && args[1] === 'rm') return this.imageRm(args[2]);
    return fail(`fake: docker ${args.join(' ')} ist nicht nachgebildet`);
  };

  /** Which release the container is actually running — read from the machine. */
  servingRef(): string | null {
    if (this.container === null) return null;
    for (const [ref, id] of this.tags) {
      if (id === this.container && ref !== this.composeImage) return ref;
    }
    return null;
  }

  /** Tags in existence, for an assertion that a prune really deleted one. */
  refs(): string[] {
    return [...this.tags.keys()];
  }

  private compose(args: string[]): CommandResult {
    const rest = args.slice(1).filter((arg, index, all) => arg !== '-f' && all[index - 1] !== '-f');
    if (rest[0] === 'config' && rest[1] === '--images') {
      return { ...OK, output: `${this.composeImage}\n` };
    }
    if (rest[0] === 'build') {
      // A build produces a *new* image and points the compose file's own name
      // at it. The container keeps running whatever it was running — which is
      // the whole reason `ComposeDeployTarget` reads "serving" from the
      // container rather than from this pointer.
      this.minute += 1;
      this.built += 1;
      const id = `sha256:${String(this.built).padStart(64, '0')}`;
      this.images.set(id, dockerTime(this.minute));
      this.tags.set(this.composeImage, id);
      return OK;
    }
    if (rest[0] === 'up') {
      const id = this.tags.get(this.composeImage);
      if (id === undefined) return fail(`fake: ${this.composeImage} existiert nicht`);
      this.container = id;
      return OK;
    }
    if (rest[0] === 'images') {
      return {
        ...OK,
        output: this.container === null ? '[]' : `[{"ID":"${this.container}","Tag":"current"}]`,
      };
    }
    return fail(`fake: docker compose ${rest.join(' ')} ist nicht nachgebildet`);
  }

  private tag(source: string | undefined, destination: string | undefined): CommandResult {
    if (!source || !destination) return fail('fake: docker tag braucht zwei Argumente');
    const id = this.tags.get(source);
    if (id === undefined) return fail(`Error response from daemon: No such image: ${source}`);
    this.tags.set(destination, id);
    return OK;
  }

  private imageLs(args: string[]): CommandResult {
    const repository = args.at(-1) ?? '';
    const lines: string[] = [];
    for (const [ref, id] of this.tags) {
      const colon = ref.lastIndexOf(':');
      if (ref.slice(0, colon) !== repository) continue;
      lines.push(`${ref.slice(colon + 1)}|${id}|${this.images.get(id) ?? ''}`);
    }
    // **A deliberate divergence, and the only one here.** Real `docker image ls`
    // emits newest-first; this emits oldest-first, i.e. tag-creation order. A
    // fake that mirrored docker would let a target which simply forwarded the
    // listing pass — and `releases()` promises an order rather than a relay
    // (A82's lesson: a fixture improved into the blind spot proves nothing).
    return { ...OK, output: `${lines.join('\n')}\n` };
  }

  private imageRm(ref: string | undefined): CommandResult {
    if (!ref) return fail('fake: docker image rm braucht ein Argument');
    if (!this.tags.delete(ref)) return fail(`Error: No such image: ${ref}`);
    return OK;
  }
}

/**
 * A release host over ssh and rsync, as far as `StaticRsyncDeployTarget` can
 * see it.
 *
 * The model is a filesystem's: directories that have to be created before they
 * can be listed, release directories with modification times, and symlinks. The
 * two operations that carry A24's guarantee are modelled as what they are —
 * `ln -sfn` writes a link, `mv -T` moves one in a single step — so a target
 * that flipped `current` by removing and re-creating it would be *visible*
 * here as two operations on the live name rather than one.
 */
export class FakeReleaseHost {
  readonly calls: RecordedCommand[] = [];
  /** release name → modification time, which is what `ls -1t` sorts by. */
  private readonly releases = new Map<string, number>();
  /** link path → the path it points at. */
  private readonly links = new Map<string, string>();
  private readonly directories = new Set<string>();
  /** Things that exist and are not symlinks — what `readlink` refuses. */
  private readonly plainFiles = new Set<string>();
  private tick = 0;

  constructor(
    /** The absolute path on the far side, without a trailing slash. */
    private readonly basePath: string,
    /** As `FakeDockerHost`'s, and for the same reason: the exit code matters. */
    private readonly faults: {
      failOn?: (program: string, argv: string[]) => CommandResult | null;
    } = {},
  ) {}

  run = async (command: string, argv: readonly string[]): Promise<CommandResult> => {
    const args = [...argv];
    this.calls.push({ command, argv: args });

    const injected = this.faults.failOn?.(command, args);
    if (injected) return injected;
    if (command === 'ssh') return this.ssh(args);
    if (command === 'rsync') return this.rsync(args);
    // Anything else is the project's own build command, which this host does
    // not model and does not need to: it runs locally and produces a directory
    // rsync then reads.
    return OK;
  };

  /** What `current` points at, or null before the first swap. */
  servingRelease(): string | null {
    const target = this.links.get(`${this.basePath}/current`);
    return target === undefined ? null : (target.split('/').pop() ?? null);
  }

  /** The releases that exist on disk, for an assertion that a prune deleted one. */
  releaseNames(): string[] {
    return [...this.releases.keys()];
  }

  /**
   * Put something at a path that is not a symlink.
   *
   * The state a host gets into when somebody copies a build over `current` by
   * hand, or when a swap died between its two commands. `readlink` refuses it
   * exactly as it refuses a path that is not there at all, which is why the
   * target has to ask a second question.
   */
  plantPlainFile(path: string): void {
    this.plainFiles.add(path);
  }

  /**
   * Put a name into the releases listing without going through rsync.
   *
   * `ls` answers with whatever is on that disk, and what is on that disk is not
   * only what this system put there — `.`, `..`, a half-finished upload, a
   * directory somebody made by hand. `prune` feeds that listing into `rm -rf`,
   * so the listing is an *input from outside* and has to be testable as one.
   */
  plantRelease(name: string): void {
    this.tick += 1;
    this.releases.set(name, this.tick);
  }

  private ssh(args: string[]): CommandResult {
    // Drop the options and the host; what is left is the remote command.
    const hostIndex = args.findIndex((_arg, index) => index > 0 && args[index - 1] !== '-o');
    const remote = args.slice(hostIndex + 1);
    const [program, ...rest] = remote;

    if (program === 'mkdir' && rest[0] === '-p') {
      if (rest[1]) this.directories.add(rest[1]);
      return OK;
    }
    if (program === 'ls' && rest[0] === '-1t') {
      const path = rest[1] ?? '';
      if (!this.directories.has(path)) {
        return fail(`ls: cannot access '${path}': No such file or directory`, 2);
      }
      const names = [...this.releases.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
      return { ...OK, output: `${names.join('\n')}\n` };
    }
    if (program === 'readlink') {
      // Exit 1 with no output, for a path that is absent *and* for a path that
      // is there but is not a link — real `readlink` does not distinguish, and
      // a fake that did would hide the reason the target asks twice.
      const target = this.links.get(rest[0] ?? '');
      return target === undefined ? fail('', 1) : { ...OK, output: `${target}\n` };
    }
    if (program === 'test' && rest[0] === '-e') {
      const path = rest[1] ?? '';
      const there = this.links.has(path) || this.plainFiles.has(path) || this.directories.has(path);
      return there ? OK : fail('', 1);
    }
    if (program === 'ln' && rest[0] === '-sfn') {
      const [, target, link] = rest;
      if (!target || !link) return fail('ln: missing operand');
      this.links.set(link, target);
      return OK;
    }
    if (program === 'mv' && rest[0] === '-T') {
      const [, source, destination] = rest;
      if (!source || !destination) return fail('mv: missing operand');
      const target = this.links.get(source);
      if (target === undefined) {
        return fail(`mv: cannot stat '${source}': No such file or directory`);
      }
      // rename(2): the destination is replaced in one step. There is no instant
      // in which it does not exist, and that is the guarantee A24 is asking for.
      this.links.set(destination, target);
      this.links.delete(source);
      return OK;
    }
    if (program === 'rm') {
      // Any flag combination, and links as well as release directories. The
      // first version modelled only `rm -rf <release>` — the one call the
      // target makes — and a mutation replacing the atomic flip with `rm -f
      // current && ln -sfn …` then died on "not modelled" instead of on the
      // assertion written for it. A fake that only knows the commands its
      // target happens to issue cannot say anything about the ones it does not
      // (A37, and A82's warning about a fixture improved into the blind spot —
      // here in the direction that makes a mutation answerable).
      const path = rest.find((arg) => !arg.startsWith('-')) ?? '';
      const prefix = `${this.basePath}/releases/`;
      if (path.startsWith(prefix)) this.releases.delete(path.slice(prefix.length));
      this.links.delete(path);
      this.plainFiles.delete(path);
      return OK;
    }
    return fail(`fake: ssh … ${remote.join(' ')} ist nicht nachgebildet`);
  }

  private rsync(args: string[]): CommandResult {
    const destination = args.at(-1) ?? '';
    const colon = destination.indexOf(':');
    const path = colon < 0 ? destination : destination.slice(colon + 1);
    const prefix = `${this.basePath}/releases/`;
    if (!path.startsWith(prefix)) return fail(`fake: unerwartetes rsync-Ziel „${destination}"`);
    if (!this.directories.has(`${this.basePath}/releases`)) {
      return fail(`rsync: mkdir "${path}" failed: No such file or directory (2)`, 12);
    }
    const name = path.slice(prefix.length).replace(/\/+$/, '');
    this.tick += 1;
    this.releases.set(name, this.tick);
    return OK;
  }
}

/**
 * One target wired to one machine, which is what the shared contract suite
 * takes.
 *
 * It lives here rather than in the suite for a mundane reason with a sharp
 * consequence: the per-target suites need the same wiring, and importing it
 * from a `*.test.ts` would re-execute that file's registrations and run the
 * whole contract three more times under the wrong file names.
 *
 * `serving()` is the load-bearing member. It reads the **machine**, never the
 * target — a target asked what it is serving agrees with itself in exactly the
 * case where it is wrong.
 */
export interface DeployTargetUnderTest {
  target: DeployTarget;
  /** A context for one release, wired to whatever stands in for the machine. */
  context(sha: string): DeployContext;
  /** What the machine is serving, by artifact id. */
  serving(): Promise<string | null>;
}

/**
 * Typed as the *member*, not as the union.
 *
 * `DeployConfig` is a discriminated union, and spreading a value typed as the
 * whole union produces a union of every shape it might have been — which a test
 * building a variant (`{ ...STATIC_FIXTURE, target: '…' }`) then cannot assign
 * back. Naming the member keeps the spread meaning what it reads as.
 */
export type ComposeConfig = Extract<DeployConfig, { method: 'compose' }>;
export type StaticConfig = Extract<DeployConfig, { method: 'static-rsync' }>;

export const COMPOSE_FIXTURE: ComposeConfig = {
  method: 'compose',
  composeFiles: ['docker-compose.yml', 'docker-compose.prod.yml'],
  service: 'app',
  healthUrl: 'https://example.test/healthz',
  healthTimeoutMs: 90_000,
  healthIntervalMs: 3_000,
  keep: 5,
};

export const STATIC_FIXTURE: StaticConfig = {
  method: 'static-rsync',
  buildCommand: 'pnpm build',
  distDir: 'dist',
  target: 'app-host:/srv/beispiel',
  healthUrl: 'https://example.test/healthz',
  healthTimeoutMs: 90_000,
  healthIntervalMs: 3_000,
  keep: 5,
};

/** The image the fixture's compose file names — the `current` pointer. */
export const COMPOSE_POINTER = 'beispiel/app:current';
/** The path the fixture's `static-rsync` target names on the far side. */
export const STATIC_BASE = '/srv/beispiel';

export function composeUnderTest(
  faults?: ConstructorParameters<typeof FakeDockerHost>[1],
): DeployTargetUnderTest & { host: FakeDockerHost } {
  const host = new FakeDockerHost(COMPOSE_POINTER, faults);
  return {
    host,
    target: new ComposeDeployTarget(),
    context: (sha) => ({
      sha,
      projectRoot: '/opt/beispiel',
      config: COMPOSE_FIXTURE,
      run: host.run,
    }),
    serving: async () => host.servingRef(),
  };
}

export function staticUnderTest(
  faults?: ConstructorParameters<typeof FakeReleaseHost>[1],
): DeployTargetUnderTest & { host: FakeReleaseHost } {
  const host = new FakeReleaseHost(STATIC_BASE, faults);
  return {
    host,
    target: new StaticRsyncDeployTarget(),
    context: (sha) => ({
      sha,
      projectRoot: '/opt/beispiel',
      config: STATIC_FIXTURE,
      run: host.run,
    }),
    // `current` names a release directory; the artifact id names the same
    // directory the way the target does, so the two compare without asking it.
    serving: async () => {
      const name = host.servingRelease();
      return name === null ? null : `releases/${name}`;
    },
  };
}

export function fakeTargetUnderTest(): DeployTargetUnderTest {
  const target = new FakeDeployTarget();
  return {
    target,
    context: (sha) => ({
      sha,
      projectRoot: '/opt/beispiel',
      config: COMPOSE_FIXTURE,
      run: async () => ({ ok: true, code: 0, output: '' }),
    }),
    serving: async () => target.serving?.id ?? null,
  };
}
