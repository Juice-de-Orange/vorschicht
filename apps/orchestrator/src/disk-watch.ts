/**
 * §18's disk pressure watch (A30) — the first consumer of the periodic pass.
 *
 * "Ops monitors filesystem usage of the relevant mounts; ≥ 80% → warning (Ops
 * tile + `vorschicht-info`), ≥ 90% → alert (`vorschicht-alerts`) + automatic
 * prune of already-eligible artifacts only (images/releases beyond keep-N,
 * expired raw transcripts) — the event log is never touched."
 *
 * Nothing in this repository measured a filesystem. The two failures of the
 * last week — a budget meter that wedged the studio for seven days and a backup
 * that had never once archived a transcript — were both found by a human
 * looking at the server rather than by anything in here.
 *
 * **Measured on the production host, 2026-08-09**, rather than taken on trust: the brief
 * for this change reported 81% and the host says otherwise, which is why the
 * number is quoted with the command that produced it.
 *
 * ```
 * $ df -h / /var/lib/docker /srv/vorschicht
 * Filesystem      Size  Used Avail Use% Mounted on
 * /dev/sda1       242G  181G   61G  76% /
 * /dev/sda1       242G  181G   61G  76% /
 * /dev/sda1       242G  181G   61G  76% /
 * $ docker run --rm -v vorschicht_backups:/x alpine df -h /x
 * /dev/sda1     241.1G    180.9G     60.2G  75% /x
 * ```
 *
 * Two things follow, and both are load-bearing below. The warning threshold is
 * four points away rather than crossed — so this ships without an alarm waiting
 * for it, which is the honest state. And a named volume, A33's `/srv/vorschicht`
 * bind mounts and the container's own root are all **one filesystem**
 * (`/dev/sda1`), measured from inside the volume rather than inferred from a
 * mountpoint path — so the duplicate-reading case decision 2 handles is the
 * ordinary one on the target host and not an edge case. (The two figures differ
 * by a point because busybox's `df` and coreutils' round the same filesystem
 * differently; quoted as measured rather than reconciled.)
 *
 * Seven decisions.
 *
 *  1. **`df`'s arithmetic *and* `df`'s rounding.** Two separate things, and the
 *     second was found by measuring rather than by reading. The arithmetic:
 *     `used / blocks` counts the root-reserved blocks as free, so the
 *     denominator is `used + bavail` — what an unprivileged process can still
 *     write. The rounding: coreutils prints the **ceiling**, so the same
 *     filesystem that computes to 75.02% is displayed as 76%.
 *
 *     Stated no more strongly than it was measured, because the first draft of
 *     this paragraph generalised and the test said otherwise: **on the production host the
 *     two formulas agree**, since `bfree` and `bavail` differ by 4096 blocks —
 *     a 16 MiB reserve on 242 GiB, effectively nil. The divergence that makes
 *     the denominator worth getting right shows up on a filesystem carrying
 *     ext4's customary 5% reserve, which is the default an operator gets and
 *     therefore what this watch meets on the next host: there the naive
 *     expression reads 76% where `df` reads 80%, which is the whole band
 *     between silence and A30's warning.
 *
 *     Measured on the production host rather than assumed, and the two commands are one
 *     line apart on purpose:
 *
 *     ```
 *     $ stat -f -c 'bsize=%s blocks=%b bfree=%f bavail=%a' /
 *     bsize=4096 blocks=63209564 bfree=15794669 bavail=15790573
 *     $ df --output=source,size,used,avail,pcent -B1 /
 *     /dev/sda1  258906374144  194211409920  64678187008  76%
 *     ```
 *
 *     Those numbers give exactly 75.0167%, and `df` printed 76%. A30's
 *     thresholds are `df` numbers, so a watch that classified on 75.02 would
 *     stay quiet through a whole band in which the operator's own tool already
 *     says 80% — the threshold nobody trusts twice. So `displayPercent` is the
 *     ceiling and it is what `classifyDisk` and the message use; `usedPercent`
 *     stays exact and goes into the record, where a history somebody plots
 *     should not be rounded. The direction is also the safe one: the ceiling
 *     alerts at or before `df` does, never after.
 *
 *  2. **Paths on one filesystem collapse to one line, and a collision keeps the
 *     fuller reading.** Several of the configured paths are named volumes on
 *     one host filesystem (measured above) and would otherwise print the same
 *     number six times.
 *
 *     The key is type, block size and total blocks — the identity of the
 *     filesystem. The first draft added the free-block count to it, on the
 *     reasoning that two same-sized filesystems at different fullness must
 *     never be merged; the full test suite then failed it, because free blocks
 *     drift between two `statfs` calls microseconds apart on a busy host, and
 *     six paths on one volume produced six lines again. That is a test finding
 *     a design that only worked on an idle machine.
 *
 *     What replaces it is safe without depending on timing: on a collision the
 *     **higher** reading wins, path label included. Two genuinely distinct
 *     filesystems of identical type and size then report as the fuller of the
 *     two, which loses a line of information and cannot lose an alert — the
 *     verdict is the maximum over mounts (decision 3), and a maximum is exactly
 *     what merging by maximum preserves.
 *
 *  3. **The verdict is the worst mount, not the average.** A full transcripts
 *     volume beside four empty ones is a full transcripts volume.
 *
 *  4. **A path that cannot be measured is reported, never treated as empty.**
 *     `statfs` on a path that is not mounted answers ENOENT, and reading that
 *     as 0% would make an unmounted volume the healthiest thing in the report
 *     (A83.6, A87.6, A99.4 — "we could not look" and "it is fine" are the same
 *     sentence only to a system that has decided not to notice).
 *
 *  5. **Notification on the transition, never per run — and the transition is
 *     measured against what was *announced*.** A67.6 and A86.5, now for a
 *     fourth channel: hourly pushes about a disk that is still at 81% is a
 *     channel that gets muted, and then the next real alert is invisible. The
 *     previous level is read from the log rather than held in a variable, so a
 *     restart does not re-announce (`periodic-pass.ts` decision 1).
 *
 *     The qualifier is not decoration; the integration test found its absence.
 *     Comparing against the last *recorded* level meant that a run whose alert
 *     ntfy refused still moved the comparison forward, so the retry that
 *     `announced: false` was supposed to buy never happened. See
 *     `lastAnnouncedLevel`.
 *
 *  6. **The event is written on every run, including the ones that measured
 *     nothing.** It is the pass's only deadline (`periodic-pass.ts` decision
 *     3); a run that writes only on a transition would run again on every tick
 *     forever. It is also §18's "Ops tile": an hourly measurement kept forever
 *     is a disk-usage history, which is exactly what anybody wants the first
 *     time a volume fills.
 *
 *  7. **The prune removes expired *raw* transcripts and nothing else.** A15
 *     gives them 90 days raw, then a gzip archive for a year — so a raw
 *     transcript older than 90 days is A30's "already-eligible artifact" by the
 *     project's own rule, and compressing it is A15's own next step rather than
 *     a decision taken under pressure. The raw file is unlinked only after its
 *     `.gz` exists and is non-empty. What is deliberately **not** built here is
 *     stated where it can be found again: deleting archives past A15's one-year
 *     boundary (a hard data loss decided by a threshold nobody watched), and
 *     pruning deploy releases beyond keep-N (A11 already prunes after every
 *     rollout, and reaching a production host from a disk-pressure pass is a
 *     bigger decision than this change). A15's *standing* retention sweep — the
 *     one that would gzip at 90 days whether or not the disk is full — has no
 *     producer either; this only fires at ≥ 90%.
 */
import { createReadStream, createWriteStream, type Dirent } from 'node:fs';
import { readdir, rename, stat, statfs, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import type { EventLog, Notification, Notifier, Queryable } from '@vorschicht/core';

/** A30's two thresholds, as percentages of a `df`-style used figure. */
export const DISK_WARNING_PERCENT = 80;
export const DISK_ALERT_PERCENT = 90;

/**
 * How often the watch runs.
 *
 * Hourly: far below the speed at which a volume of this size fills, far above
 * the tick, and 24 permanent rows a day — a disk-usage history, not a flood
 * (A98's lesson was about a false signal every 44 seconds, not about a
 * measurement anybody would want).
 */
export const DISK_CHECK_INTERVAL_MS = 60 * 60_000;

/** A15: raw for 90 days, then the gzip archive. */
export const RAW_TRANSCRIPT_DAYS = 90;

export type DiskLevel = 'ok' | 'warning' | 'alert';

export interface MountUsage {
  /** The configured path, as the operator wrote it. */
  path: string;
  /** Exact, for the record. Never compared against a threshold (decision 1). */
  usedPercent: number;
  /** What `df` would print for this filesystem: the ceiling. Decides and displays. */
  displayPercent: number;
  usedBytes: number;
  availableBytes: number;
  totalBytes: number;
}

export interface DiskReading {
  mounts: MountUsage[];
  /** Paths that could not be measured, with the reason (decision 4). */
  unreadable: Array<{ path: string; problem: string }>;
}

/** Which level a percentage falls into (A30). */
export function classifyDisk(usedPercent: number): DiskLevel {
  if (usedPercent >= DISK_ALERT_PERCENT) return 'alert';
  if (usedPercent >= DISK_WARNING_PERCENT) return 'warning';
  return 'ok';
}

/**
 * Decision 5, as a pure function.
 *
 * Asymmetric on the first observation for the reason `backup-pass.ts` gives:
 * a studio whose first measurement is already over a threshold must say so, and
 * one that starts healthy has nothing to announce. Every later change of level
 * is reported in both directions, because "the disk is no longer full" is the
 * one piece of good news an operator is actually waiting for.
 */
export function decideDiskTransition(previous: DiskLevel | null, level: DiskLevel): boolean {
  if (previous === null) return level !== 'ok';
  return previous !== level;
}

/**
 * `df`'s used percentage for one path (decision 1).
 *
 * Exported for the test: the arithmetic is three lines and one of them is the
 * difference between agreeing with `df` and disagreeing with it by five points.
 */
export function usedPercentOf(stats: {
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
}): MountUsage {
  const used = Math.max(0, stats.blocks - stats.bfree);
  const capacity = used + Math.max(0, stats.bavail);
  const exact = capacity > 0 ? (used / capacity) * 100 : 0;
  return {
    path: '',
    usedPercent: exact,
    displayPercent: Math.ceil(exact),
    usedBytes: used * stats.bsize,
    availableBytes: Math.max(0, stats.bavail) * stats.bsize,
    totalBytes: capacity * stats.bsize,
  };
}

/** What `statfs` answers, as the two fields below actually use it. */
export type StatfsLike = (path: string) => Promise<{
  type: number;
  bsize: number;
  blocks: number;
  bfree: number;
  bavail: number;
}>;

/**
 * Measure every configured path (decisions 2 and 4).
 *
 * Keyed by the identity of the filesystem — type, block size, total blocks —
 * and a collision keeps the fuller of the two readings, so the merge can never
 * lower the verdict whatever the key gets wrong. Order of first appearance is
 * preserved: the operator wrote the paths in the order they care about.
 *
 * `stat` is injectable for one reason, and it is the honest one: the collision
 * this merge rule exists for is two *distinct* filesystems of identical type
 * and size, and no test can create a second filesystem. Without the seam the
 * rule went unproven — the mutation that keeps the first reading instead of the
 * fuller one passed the whole suite. Production always passes the real
 * `statfs`; the shape above is exactly the shape it returns, so a stand-in
 * cannot drift from what is measured (A37).
 */
export async function measureMounts(
  paths: readonly string[],
  stat: StatfsLike = statfs,
): Promise<DiskReading> {
  const reading: DiskReading = { mounts: [], unreadable: [] };
  const byFilesystem = new Map<string, MountUsage>();
  const order: string[] = [];

  for (const path of paths) {
    let stats: Awaited<ReturnType<StatfsLike>>;
    try {
      stats = await stat(path);
    } catch (error) {
      reading.unreadable.push({ path, problem: (error as Error).message });
      continue;
    }

    const key = `${stats.type}:${stats.bsize}:${stats.blocks}`;
    const usage = { ...usedPercentOf(stats), path };
    const seen = byFilesystem.get(key);
    if (!seen) {
      byFilesystem.set(key, usage);
      order.push(key);
      continue;
    }
    // Decision 2: the fuller reading wins, label included, so a wrong merge
    // hides the emptier filesystem rather than the fuller one.
    if (usage.usedPercent > seen.usedPercent) byFilesystem.set(key, usage);
  }

  for (const key of order) {
    const usage = byFilesystem.get(key);
    if (usage) reading.mounts.push(usage);
  }

  return reading;
}

export interface TranscriptPruneResult {
  /** Raw transcripts compressed and removed, by A15's 90-day rule. */
  compressed: number;
  freedBytes: number;
  /** Files this pass could not handle. Never thrown (§18 must keep reporting). */
  problems: string[];
}

const DAY_DIRECTORY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Decision 7: expired raw transcripts, compressed in place.
 *
 * The layout is `transcripts.ts`'s: `<root>/<YYYY-MM-DD>/<runId>.jsonl`, chosen
 * there precisely so that a retention sweep is a directory-level decision
 * rather than a `stat` per file. This reads the directory *name* rather than
 * any file's mtime — a copy or a restore rewrites an mtime and would make a
 * restored archive look expired the moment it landed.
 *
 * Never throws, and never unlinks a raw file whose archive it has not seen on
 * disk with a non-zero size afterwards.
 */
export async function pruneExpiredTranscripts(input: {
  transcriptsRoot: string;
  now?: () => number;
  maxRawAgeDays?: number;
}): Promise<TranscriptPruneResult> {
  const result: TranscriptPruneResult = { compressed: 0, freedBytes: 0, problems: [] };
  const now = input.now?.() ?? Date.now();
  const cutoff = now - (input.maxRawAgeDays ?? RAW_TRANSCRIPT_DAYS) * 24 * 60 * 60_000;

  let days: Dirent[];
  try {
    days = await readdir(input.transcriptsRoot, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // No transcripts volume here at all — a developer machine, not a fault.
    if (code === 'ENOENT' || code === 'ENOTDIR') return result;
    result.problems.push(`Transkriptverzeichnis nicht lesbar: ${(error as Error).message}`);
    return result;
  }

  for (const day of days) {
    if (!day.isDirectory() || !DAY_DIRECTORY.test(day.name)) continue;
    // Midnight *after* the named day, so a directory is only ever expired once
    // its whole day is more than the retention behind us.
    const dayEnd = Date.parse(`${day.name}T23:59:59.999Z`);
    if (!Number.isFinite(dayEnd) || dayEnd > cutoff) continue;

    const directory = join(input.transcriptsRoot, day.name);
    let entries: string[];
    try {
      entries = await readdir(directory);
    } catch (error) {
      result.problems.push(`${directory}: ${(error as Error).message}`);
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue;
      try {
        result.freedBytes += await compressOne(join(directory, entry));
        result.compressed += 1;
      } catch (error) {
        result.problems.push(`${join(directory, entry)}: ${(error as Error).message}`);
      }
    }
  }

  return result;
}

/**
 * Compress one transcript and remove the raw file. Returns the bytes reclaimed.
 *
 * Written to a `.part` and renamed, so a run killed mid-stream leaves either
 * the raw file or a complete archive and never a truncated `.gz` that the next
 * pass would trust. The raw file is unlinked only after the archive has been
 * `stat`ed at a non-zero size — the assertion is the filesystem afterwards,
 * never that `pipeline` resolved.
 */
async function compressOne(raw: string): Promise<number> {
  const before = await stat(raw);
  const archive = `${raw}.gz`;
  const partial = `${archive}.part`;

  await pipeline(createReadStream(raw), createGzip(), createWriteStream(partial));
  await rename(partial, archive);

  const after = await stat(archive);
  if (after.size <= 0) throw new Error('Das Archiv ist leer geblieben — die Rohdatei bleibt.');

  await unlink(raw);
  return Math.max(0, before.size - after.size);
}

export interface DiskWatchDeps {
  /** The mounts A30 calls "relevant". Order is the order they are reported in. */
  paths: readonly string[];
  /** Where A15's raw transcripts live; the only thing decision 7 ever touches. */
  transcriptsRoot: string;
  eventLog: EventLog;
  sql: Queryable;
  notifier: Pick<Notifier, 'send'>;
  logger: {
    info(obj: unknown, message?: string): void;
    warn(obj: unknown, message?: string): void;
    error(obj: unknown, message?: string): void;
  };
  now?: () => number;
  /** Only tests pass one; production measures the real filesystem. */
  stat?: StatfsLike;
}

export interface DiskWatchResult {
  level: DiskLevel;
  worst: MountUsage | null;
  reading: DiskReading;
  /** True when this run crossed a threshold and said so (decision 5). */
  announced: boolean;
  pruned: TranscriptPruneResult | null;
}

/**
 * One run of the watch. Always writes `disk.checked` (decision 6).
 *
 * The order is: measure, prune if the alert threshold is met, notify on a
 * transition, record. Pruning *before* the notification is deliberate — the
 * message then says how much was reclaimed, which is the difference between
 * "your disk is full" and "your disk is full, and here is what I already did".
 */
export async function runDiskWatch(deps: DiskWatchDeps): Promise<DiskWatchResult> {
  const reading = await measureMounts(deps.paths, deps.stat ?? statfs);
  const worst = reading.mounts.reduce<MountUsage | null>(
    (max, mount) => (max === null || mount.displayPercent > max.displayPercent ? mount : max),
    null,
  );
  // Nothing measurable: not "ok". Decision 4 — an unmounted volume must not be
  // the healthiest thing in the report, and the row still has to be written so
  // the deadline advances and the problem is visible in the log.
  const level: DiskLevel = worst === null ? 'warning' : classifyDisk(worst.displayPercent);

  let pruned: TranscriptPruneResult | null = null;
  if (level === 'alert') {
    pruned = await pruneExpiredTranscripts({
      transcriptsRoot: deps.transcriptsRoot,
      ...(deps.now ? { now: deps.now } : {}),
    });
    if (pruned.problems.length > 0) {
      deps.logger.warn(
        { problems: pruned.problems.length, first: pruned.problems[0] },
        'Abgelaufene Rohtranskripte konnten nicht vollständig komprimiert werden (A15)',
      );
    }
  }

  const previous = await lastAnnouncedLevel(deps.sql);
  let announced = false;
  if (decideDiskTransition(previous, level)) {
    const sent = await deps.notifier.send(notificationFor(level, worst, reading, pruned));
    // A refused alert is an alert nobody got, so it is not recorded as sent —
    // but the run *is* recorded either way, or the pass loses its deadline and
    // hammers the check every fifteen seconds (decision 6).
    announced = sent.ok;
    if (!sent.ok) {
      deps.logger.warn({ level, error: sent.error }, 'Platten-Meldung nicht zugestellt');
    }
  }

  await deps.eventLog.append({
    kind: 'disk.checked',
    actor: 'system',
    payload: {
      level,
      announced,
      worstPercent: worst ? Math.round(worst.usedPercent * 100) / 100 : null,
      worstDisplayPercent: worst?.displayPercent ?? null,
      worstPath: worst?.path ?? null,
      mounts: reading.mounts.map((mount) => ({
        path: mount.path,
        usedPercent: Math.round(mount.usedPercent * 100) / 100,
        displayPercent: mount.displayPercent,
        availableBytes: mount.availableBytes,
        totalBytes: mount.totalBytes,
      })),
      unreadable: reading.unreadable,
      pruned: pruned ? { compressed: pruned.compressed, freedBytes: pruned.freedBytes } : null,
    },
  });

  return { level, worst, reading, announced, pruned };
}

/**
 * The last level the operator was actually told about, or null if he never was.
 *
 * **Announced, not merely recorded** — and the difference is a defect the
 * integration test found rather than something foreseen. The first version read
 * the most recent `disk.checked` row of any kind, so a run whose alert ntfy
 * refused still moved the "previous level" forward: the next run compared
 * warning against warning, decided nothing had changed, and never retried. The
 * refusal was recorded honestly and the retry it was supposed to buy did not
 * exist, which is the failure `escalation-push.ts` decision 2 exists to
 * prevent, reintroduced one layer up.
 *
 * A transition is a statement about what the operator has been told, so the
 * comparison has to be against the last thing they were told.
 */
async function lastAnnouncedLevel(sql: Queryable): Promise<DiskLevel | null> {
  const rows = await sql<Array<{ level: string | null }>>`
    SELECT payload ->> 'level' AS level
    FROM event_log
    WHERE kind = 'disk.checked' AND (payload ->> 'announced')::boolean IS TRUE
    ORDER BY id DESC
    LIMIT 1
  `;
  const level = rows[0]?.level;
  return level === 'ok' || level === 'warning' || level === 'alert' ? level : null;
}

/** German (§2). §18 puts the warning on `info` and the alert on `alerts`. */
function notificationFor(
  level: DiskLevel,
  worst: MountUsage | null,
  reading: DiskReading,
  pruned: TranscriptPruneResult | null,
): Notification {
  const lines = reading.mounts.map(
    (mount) => `${mount.path}: ${mount.displayPercent} % (${gib(mount.availableBytes)} frei)`,
  );
  for (const bad of reading.unreadable) lines.push(`${bad.path}: nicht messbar — ${bad.problem}`);
  const body = lines.join('\n');

  if (level === 'ok') {
    return {
      topic: 'info',
      title: 'Vorschicht: Plattenplatz wieder in Ordnung',
      message: `Alle überwachten Ablagen liegen wieder unter ${DISK_WARNING_PERCENT} %.\n\n${body}`,
      tags: ['floppy_disk'],
    };
  }

  if (level === 'warning') {
    return {
      topic: 'info',
      title: 'Vorschicht: Plattenplatz wird knapp',
      message:
        `${worst ? `${worst.path} steht bei ${worst.displayPercent} %.` : 'Keine der überwachten Ablagen war messbar.'}\n\n` +
        `${body}\n\n` +
        `Ab ${DISK_ALERT_PERCENT} % räumt Vorschicht abgelaufene Rohtranskripte selbst weg (A15, A30); ` +
        'das Ereignisprotokoll wird dabei nie angefasst.',
      tags: ['floppy_disk'],
    };
  }

  const reclaimed =
    pruned && pruned.compressed > 0
      ? `\n\nBereits weggeräumt: ${pruned.compressed} abgelaufene Rohtranskript(e), ${gib(pruned.freedBytes)} frei geworden (A15).`
      : '\n\nEs gab nichts, was nach A15 schon abgelaufen wäre — der Platz muss von Hand kommen.';

  return {
    topic: 'alerts',
    title: 'Vorschicht: Plattenplatz kritisch',
    message:
      `${worst ? `${worst.path} steht bei ${worst.displayPercent} %.` : 'Keine der überwachten Ablagen war messbar.'}\n\n` +
      `${body}${reclaimed}\n\n` +
      'Das Ereignisprotokoll wird nie gekürzt (§18). docs/OPERATIONS.md, Abschnitt „Disk space“.',
    priority: 'high',
    tags: ['floppy_disk', 'warning'],
  };
}

function gib(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
}
