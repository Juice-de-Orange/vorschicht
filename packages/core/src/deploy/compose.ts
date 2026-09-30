/**
 * §12's `compose` method (A11): an image per commit, and the swap is a re-tag.
 *
 * §12 describes it in one line — "build image tagged with git SHA → run
 * migrations if configured → `docker compose up -d` the service → poll health
 * URL" — and the migrations and the polling belong to `DeployService`. What is
 * left is the four verbs of `DeployTarget`, and building them settled five
 * things the line does not say.
 *
 *  1. **The compose file's own image reference is the `current` pointer.** A
 *     compose file names an image (`image: vorschicht/app:current`); that name
 *     is what `up -d` will run, so it is exactly the compose analogue of A24's
 *     `current` symlink. `prepare` builds and gives the result a second name
 *     (`<repo>:<sha>`), and `swap` re-points the first name at it. One rollback
 *     story for both methods — `swap` to an older artifact — which is what
 *     `target.ts` says a rollback is, rather than an inverse operation each
 *     method would implement differently.
 *
 *  2. **`--env-file` is deliberately not passed.** §12's config is "compose file
 *     + service names" and `DeployConfig` carries no env file, so a path here
 *     would be one no configuration could ever set — dead wiring (§8.2 domain 6)
 *     in the component that replaces production. The tag reaches compose through
 *     `docker tag` instead, which needs nothing the document does not have.
 *
 *  3. **What is *serving* is the running container's image, never the pointer.**
 *     `prepare` moves the pointer (compose's `build` writes to the name in the
 *     file) while the container keeps running the old image, so a "serving"
 *     read off the pointer would report the new release as live before anything
 *     had been swapped — and the prune would then protect the wrong one. It is
 *     read from `docker compose images`, which reports the id of the image the
 *     container actually runs. Verified against docker 29.3.1 / compose v5.1.1.
 *
 *  4. **`releases()` sorts, even though docker already does.** `docker image ls`
 *     happens to emit newest-first, and a target that merely forwarded that
 *     would be resting its ordering on an undocumented default — and would
 *     still be wrong on a tie. `CreatedAt` is parsed and sorted descending, and
 *     the sort is stable, so docker's order survives as the tie-break. Ties are
 *     real: two tags on one image share a timestamp exactly (measured), which is
 *     the one case where the order between them means nothing anyway.
 *
 *  5. **Nothing here interprets a failure.** A command that exits non-zero
 *     raises `DeployTargetError` with the command and its output; §12's engine
 *     decides what that means for the task. A target does what it is told and
 *     reports what happened (`target.ts`).
 */
import type { Artifact, CommandResult, DeployContext, DeployTarget } from './target.js';
import { assertReleaseName, DeployTargetError, isReleaseName } from './target-guards.js';

/** One row of `docker image ls`, as the machine reports it. */
interface ImageRow {
  tag: string;
  /** `sha256:…`, full length — `--no-trunc` so it can be compared to a container's. */
  id: string;
  createdAt: string;
}

/**
 * Everything one `docker image ls` answers about a project, read once.
 *
 * `releases()` and `prune()` both need it and `prune()` needs the ids as well,
 * so it is one call rather than three — a prune runs after every green deploy.
 */
interface Inventory {
  repository: string;
  /** The tag the compose file names; never a release. */
  pointer: string;
  rows: ImageRow[];
}

export class ComposeDeployTarget implements DeployTarget {
  readonly method = 'compose' as const;

  async prepare(context: DeployContext): Promise<Artifact> {
    const config = composeConfig(context);
    const sha = assertReleaseName(context.sha, 'Der auszurollende Stand');
    const { repository, pointer } = await this.inventory(context);

    await this.docker(context, [...composeArgs(context), 'build', config.service]);
    await this.docker(context, ['tag', `${repository}:${pointer}`, `${repository}:${sha}`]);

    return { id: `${repository}:${sha}`, sha };
  }

  async swap(context: DeployContext, artifact: Artifact): Promise<void> {
    const config = composeConfig(context);
    const { repository, pointer } = await this.inventory(context);

    // Two commands, and both are idempotent: re-tagging a name onto the image
    // it already names changes nothing, and `--force-recreate` on the image
    // that is already running produces the same container again. §12 calls a
    // rollback a deploy of the last-good release, so the *same* pair runs
    // whether this is a rollout or the way back.
    await this.docker(context, ['tag', artifact.id, `${repository}:${pointer}`]);
    await this.docker(context, [
      ...composeArgs(context),
      'up',
      '-d',
      '--force-recreate',
      config.service,
    ]);
  }

  async releases(context: DeployContext): Promise<Artifact[]> {
    return toArtifacts(await this.inventory(context));
  }

  async prune(context: DeployContext, keep: number): Promise<string[]> {
    const inventory = await this.inventory(context);
    const serving = await this.servingImageId(context);
    const byTag = new Map(inventory.rows.map((row) => [row.tag, row.id]));

    const removed: string[] = [];
    for (const artifact of toArtifacts(inventory).slice(keep)) {
      // A11 keeps five, so this normally never fires. It fires on a project
      // configured `keep: 2` that is sitting on a rollback — precisely the
      // moment when deleting what is serving would take production with it.
      if (serving !== null && byTag.get(artifact.sha) === serving) continue;
      await this.docker(context, ['image', 'rm', artifact.id]);
      removed.push(artifact.id);
    }
    return removed;
  }

  /**
   * The image the compose file names, plus every tag that repository carries.
   *
   * `docker compose config --images <service>` is the only honest source for
   * the first: the compose file is what decides which image the service runs,
   * and guessing it from the project slug would be a second answer to a
   * question the file already answers.
   */
  private async inventory(context: DeployContext): Promise<Inventory> {
    const config = composeConfig(context);
    const ref = (
      await this.docker(context, [...composeArgs(context), 'config', '--images', config.service])
    ).output.trim();
    if (ref === '') {
      throw new DeployTargetError(
        'docker compose config --images',
        `Die Compose-Dateien nennen für den Dienst „${config.service}" kein Image. Ohne einen ` +
          'Image-Namen gibt es nichts zu bauen und nichts zu tauschen (§12).',
      );
    }
    const { repository, tag } = splitImageRef(ref.split('\n')[0]?.trim() ?? ref);

    const listed = await this.docker(context, [
      'image',
      'ls',
      '--no-trunc',
      '--format',
      '{{.Tag}}|{{.ID}}|{{.CreatedAt}}',
      repository,
    ]);

    return { repository, pointer: tag, rows: parseImageRows(listed.output) };
  }

  /**
   * The id of the image the service's container is actually running, or null
   * when nothing runs yet (the first deploy of a project).
   */
  private async servingImageId(context: DeployContext): Promise<string | null> {
    const config = composeConfig(context);
    const listed = await this.docker(context, [
      ...composeArgs(context),
      'images',
      '--format',
      'json',
      config.service,
    ]);
    const text = listed.output.trim();
    if (text === '') return null;
    try {
      const parsed: unknown = JSON.parse(text);
      const entries = Array.isArray(parsed) ? parsed : [parsed];
      const first = entries[0] as { ID?: unknown } | undefined;
      return typeof first?.ID === 'string' && first.ID !== '' ? first.ID : null;
    } catch {
      // Unreadable is not "nothing is running": that reading decides whether a
      // prune may delete the live image, so it fails closed rather than
      // guessing (§12 — a rollback needs the release it goes back to).
      throw new DeployTargetError(
        'docker compose images --format json',
        `Die Antwort auf „welches Image läuft" war nicht lesbar: ${text.slice(0, 300)}`,
      );
    }
  }

  private async docker(context: DeployContext, argv: string[]): Promise<CommandResult> {
    const result = await context.run('docker', argv);
    if (!result.ok) {
      throw new DeployTargetError(
        `docker ${argv.join(' ')}`,
        `„docker ${argv.join(' ')}" ist mit Code ${result.code} fehlgeschlagen: ${result.output}`,
      );
    }
    return result;
  }
}

/** The `compose -f a -f b` prefix every invocation shares, in config order. */
function composeArgs(context: DeployContext): string[] {
  const config = composeConfig(context);
  // A11 puts the overlay last, and `-f` is order-significant to compose, so the
  // configured order is passed through rather than sorted or de-duplicated.
  return ['compose', ...config.composeFiles.flatMap((file) => ['-f', file])];
}

function composeConfig(context: DeployContext) {
  if (context.config.method !== 'compose') {
    throw new DeployTargetError(
      context.config.method,
      `Das Compose-Ziel ist mit einer „${context.config.method}"-Konfiguration aufgerufen worden. ` +
        'Das ist ein Fehler der Verdrahtung, nicht des Rollouts.',
    );
  }
  return context.config;
}

/**
 * `repo:tag` → the two halves, with docker's implicit `latest`.
 *
 * The last colon *after* the last slash, because a registry may carry a port
 * (`registry.example:5000/app`) and that colon is not a tag separator.
 */
function splitImageRef(ref: string): { repository: string; tag: string } {
  const slash = ref.lastIndexOf('/');
  const colon = ref.lastIndexOf(':');
  if (colon > slash) return { repository: ref.slice(0, colon), tag: ref.slice(colon + 1) };
  return { repository: ref, tag: 'latest' };
}

function parseImageRows(output: string): ImageRow[] {
  const rows: ImageRow[] = [];
  for (const line of output.split('\n')) {
    const parts = line.trim().split('|');
    const [tag, id, createdAt] = parts;
    if (parts.length < 3 || !tag || !id) continue;
    rows.push({ tag, id, createdAt: createdAt ?? '' });
  }
  return rows;
}

/**
 * The releases, newest first.
 *
 * `<none>` is a dangling image and never a release; the pointer tag is the
 * compose file's own name and never a release either — treating it as one would
 * make every prune consider deleting the thing that decides what runs.
 */
function toArtifacts(inventory: Inventory): Artifact[] {
  return inventory.rows
    .filter((row) => row.tag !== inventory.pointer && isReleaseName(row.tag))
    .map((row) => ({ row, at: parseDockerTime(row.createdAt) }))
    .sort((a, b) => b.at - a.at)
    .map(({ row }) => ({ id: `${inventory.repository}:${row.tag}`, sha: row.tag }));
}

/**
 * `2026-08-02 21:39:14 +0200 CEST` → epoch ms, or 0.
 *
 * The trailing zone abbreviation is dropped before parsing: it is decoration
 * next to the numeric offset and V8 refuses the string with it. An unparseable
 * timestamp sorts last rather than throwing — an odd `CreatedAt` should cost a
 * release its place in the order, never cost the deploy its prune.
 */
function parseDockerTime(value: string): number {
  const match = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} [+-]\d{4})/.exec(value.trim());
  if (!match?.[1]) return 0;
  const parsed = Date.parse(match[1]);
  return Number.isNaN(parsed) ? 0 : parsed;
}
