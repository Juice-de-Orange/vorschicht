/**
 * The parts of §18's disk watch that need no database.
 *
 * Two of them are pure and one is not, deliberately: the prune runs against
 * **real files in a real temp directory**, gzipped by the real `node:zlib`. A
 * faked filesystem here would let the suite assert whatever it was told about
 * the one operation in this change that deletes something, and A15's raw
 * transcripts are the traceability chain §1 principle 4 rests on.
 *
 * `runDiskWatch` itself is proved in `disk-watch.itest.ts` — the properties it
 * carries (one event per run, one notification per transition) are properties
 * of a memory that lives in `event_log`.
 */

import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  classifyDisk,
  DISK_ALERT_PERCENT,
  DISK_WARNING_PERCENT,
  decideDiskTransition,
  measureMounts,
  pruneExpiredTranscripts,
  usedPercentOf,
} from './disk-watch.js';

/**
 * the production host's root filesystem on 2026-08-09, as the kernel reported it and as
 * `df` printed it, one command after the other:
 *
 * ```
 * $ stat -f -c 'bsize=%s blocks=%b bfree=%f bavail=%a' /
 * bsize=4096 blocks=63209564 bfree=15794669 bavail=15790573
 * $ df --output=source,size,used,avail,pcent -B1 /
 * /dev/sda1  258906374144  194211409920  64678187008  76%
 * ```
 *
 * These are the raw `statfs` fields Node hands us, not a reconstruction from
 * rounded `df -h` output — which matters, because the whole point of the case
 * below is to agree with a printed number to the digit.
 */
const PROD_HOST = { bsize: 4096, blocks: 63209564, bfree: 15794669, bavail: 15790573 };
const PROD_HOST_DF_PERCENT = 76;
const PROD_HOST_DF_USED_BYTES = 194211409920;
const PROD_HOST_DF_AVAIL_BYTES = 64678187008;

describe('usedPercentOf — `df`s Arithmetik und `df`s Rundung (Entscheidung 1)', () => {
  it('sagt für des Produktionshosts Wurzel dieselbe Zahl wie df', () => {
    const usage = usedPercentOf(PROD_HOST);

    // The load-bearing assertion of this file: the number an operator sees in
    // the tool they reach for, and the number this watch classifies on, are the
    // same number. Nothing weaker demonstrates that — the exact value is 75.02
    // and `df` prints 76, so "close enough" would have hidden the rounding.
    expect(usage.displayPercent).toBe(PROD_HOST_DF_PERCENT);
    expect(usage.usedPercent).toBeCloseTo(75.02, 2);
    expect(usage.usedBytes).toBe(PROD_HOST_DF_USED_BYTES);
    expect(usage.availableBytes).toBe(PROD_HOST_DF_AVAIL_BYTES);
  });

  /**
   * Where the two formulas actually diverge — and where they do not.
   *
   * On the production host they agree: `bfree` and `bavail` differ by 4096 blocks (16 MiB
   * of 242 GiB), so that host's root reserve is effectively nil and the naive
   * expression lands on the same printed 76. Asserted, because the first
   * version of this file claimed the opposite and the run said otherwise —
   * a header that generalises from one filesystem is A76.4's shape.
   *
   * The divergence is real on a filesystem carrying ext4's customary 5%
   * reserve, which is what an operator gets by default and therefore what this
   * watch will meet on the next host. Synthetic and labelled as such: there is
   * no such filesystem here to measure.
   */
  it('folgt df auch dort, wo die naive Formel abweicht', () => {
    // 5% reserved for root, 80% of the *usable* space in use.
    const stats = { bsize: 4096, blocks: 100_000, bfree: 24_000, bavail: 19_000 };

    const naive = ((stats.blocks - stats.bfree) / stats.blocks) * 100;
    expect(naive).toBeCloseTo(76, 0);

    // What `df` reports for the same numbers: 76000 used of 95000 usable.
    expect(usedPercentOf(stats).displayPercent).toBe(80);
    expect(classifyDisk(Math.ceil(naive))).toBe('ok');
    expect(classifyDisk(usedPercentOf(stats).displayPercent)).toBe('warning');
  });

  it('stimmt auf dem Produktionshost mit der naiven Formel überein — die Reserve ist dort nil', () => {
    // Recorded rather than glossed over: 15794669 free against 15790573
    // available is a 16 MiB reserve on 242 GiB. The case above is why the
    // denominator is still `used + bavail`; this one is why that fix is
    // invisible on the one host we can measure.
    const naive = ((PROD_HOST.blocks - PROD_HOST.bfree) / PROD_HOST.blocks) * 100;
    expect(Math.ceil(naive)).toBe(PROD_HOST_DF_PERCENT);
  });

  it('rundet auf, nicht kaufmännisch', () => {
    // 1 block of 1000 used: 0.1%. `df` prints 1%, and so must this — the
    // direction that alerts at or before the operator's own tool does.
    expect(usedPercentOf({ bsize: 1, blocks: 1000, bfree: 999, bavail: 999 }).displayPercent).toBe(
      1,
    );
    // And an exactly-round value is not pushed a point higher.
    expect(usedPercentOf({ bsize: 1, blocks: 100, bfree: 20, bavail: 20 }).displayPercent).toBe(80);
  });

  it('meldet 0 % statt NaN für ein Dateisystem ohne Blöcke', () => {
    const usage = usedPercentOf({ bsize: 4096, blocks: 0, bfree: 0, bavail: 0 });
    expect(usage.usedPercent).toBe(0);
    expect(usage.displayPercent).toBe(0);
  });

  it('rechnet Bytes aus der Blockgröße, nicht aus Blöcken', () => {
    const usage = usedPercentOf({ bsize: 4096, blocks: 1000, bfree: 400, bavail: 400 });
    expect(usage.usedBytes).toBe(600 * 4096);
    expect(usage.availableBytes).toBe(400 * 4096);
  });
});

describe('classifyDisk — A30s zwei Schwellen', () => {
  it('trifft die Schwellen genau', () => {
    expect(classifyDisk(DISK_WARNING_PERCENT - 0.1)).toBe('ok');
    expect(classifyDisk(DISK_WARNING_PERCENT)).toBe('warning');
    expect(classifyDisk(DISK_ALERT_PERCENT - 0.1)).toBe('warning');
    expect(classifyDisk(DISK_ALERT_PERCENT)).toBe('alert');
  });

  it('hält des Produktionshosts gemessene 76 % unterhalb der Warnung', () => {
    // Measured, not assumed — the brief for this change said 81%, the host says
    // 76%. So this ships without an alarm already waiting for it, which is the
    // honest state and the one a reader should be able to check.
    expect(classifyDisk(usedPercentOf(PROD_HOST).displayPercent)).toBe('ok');
  });
});

describe('decideDiskTransition — Meldung beim Übergang (Entscheidung 5)', () => {
  it('meldet den ersten Befund nur, wenn er nicht in Ordnung ist', () => {
    expect(decideDiskTransition(null, 'ok')).toBe(false);
    expect(decideDiskTransition(null, 'warning')).toBe(true);
    expect(decideDiskTransition(null, 'alert')).toBe(true);
  });

  it('schweigt, solange sich nichts ändert', () => {
    expect(decideDiskTransition('warning', 'warning')).toBe(false);
    expect(decideDiskTransition('alert', 'alert')).toBe(false);
  });

  it('meldet auch die Entwarnung', () => {
    // The one piece of good news an operator is waiting for. Without it,
    // "the disk is fine again" and "the channel is dead" look identical.
    expect(decideDiskTransition('alert', 'ok')).toBe(true);
    expect(decideDiskTransition('alert', 'warning')).toBe(true);
  });
});

describe('measureMounts (Entscheidungen 2 und 4)', () => {
  it('meldet einen nicht messbaren Pfad, statt ihn als leer zu führen', async () => {
    const reading = await measureMounts([join(tmpdir(), 'vorschicht-gibt-es-nicht-1234567')]);

    // A83.6's sentence, one subsystem over: an unmounted volume must not be the
    // healthiest thing in the report.
    expect(reading.mounts).toHaveLength(0);
    expect(reading.unreadable).toHaveLength(1);
    expect(reading.unreadable[0]?.problem).toMatch(/ENOENT|no such file/i);
  });

  /**
   * The ordinary case on the production host: every Vorschicht volume lives on
   * `/dev/sda1` (measured, see the header), so six configured paths would
   * otherwise print the same number six times.
   *
   * This case failed under the full suite and passed on its own, which is what
   * found the design defect: the key used to include the free-block count, and
   * free blocks drift between two `statfs` calls on a busy host. The key is now
   * the filesystem's identity and a collision keeps the fuller reading — a
   * property that does not depend on how loaded the machine is.
   */
  it('führt denselben Mount nicht doppelt auf, egal wie beschäftigt die Maschine ist', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'vorschicht-disk-'));
    try {
      const nested = join(directory, 'unten');
      await mkdir(nested);

      // Write between the two measurements, which is what the full suite was
      // doing by accident: the free-block count moves and the two readings of
      // one filesystem differ.
      const churn = join(directory, 'unruhe.bin');
      await writeFile(churn, Buffer.alloc(8 * 1024 * 1024));

      const reading = await measureMounts([directory, nested]);
      expect(reading.mounts).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  /**
   * The rule the key cannot guarantee, and the reason `statfs` is injectable.
   *
   * Two *distinct* filesystems of identical type and size collide on the key,
   * and no test can create a second filesystem — so with the real `statfs` the
   * mutation that keeps the first reading instead of the fuller one passed the
   * entire suite. The seam is what makes the rule falsifiable at all.
   *
   * What it protects: the verdict is a maximum over mounts, and a merge that
   * discarded the fuller reading would lower it — an alert lost to a tidy-up.
   */
  it('behält bei einer Kollision die vollere Messung', async () => {
    // Same type, same block size, same total blocks — one key. Different
    // fullness: 50% and 95%.
    const fake = async (path: string) => ({
      type: 61267,
      bsize: 4096,
      blocks: 1000,
      bfree: path === '/leer' ? 500 : 50,
      bavail: path === '/leer' ? 500 : 50,
    });

    const reading = await measureMounts(['/leer', '/voll'], fake);

    expect(reading.mounts).toHaveLength(1);
    expect(reading.mounts[0]?.path).toBe('/voll');
    expect(reading.mounts[0]?.displayPercent).toBe(95);
  });

  it('behält die vollere Messung auch, wenn sie zuerst kommt', async () => {
    const fake = async (path: string) => ({
      type: 61267,
      bsize: 4096,
      blocks: 1000,
      bfree: path === '/leer' ? 500 : 50,
      bavail: path === '/leer' ? 500 : 50,
    });

    const reading = await measureMounts(['/voll', '/leer'], fake);

    expect(reading.mounts).toHaveLength(1);
    expect(reading.mounts[0]?.path).toBe('/voll');
  });
});

describe('pruneExpiredTranscripts — A15s abgelaufene Rohtranskripte (Entscheidung 7)', () => {
  let root: string;
  const NOW = Date.parse('2026-08-09T12:00:00Z');
  /** 120 days before NOW: past A15's 90, so expired. */
  const OLD = '2026-04-11';
  /** 10 days before NOW: raw retention has not run out. */
  const RECENT = '2026-07-30';

  async function seed(day: string, name: string, content: string): Promise<string> {
    await mkdir(join(root, day), { recursive: true });
    const path = join(root, day, name);
    await writeFile(path, content);
    return path;
  }

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vorschicht-transcripts-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('komprimiert ein abgelaufenes Transkript und entfernt erst danach die Rohdatei', async () => {
    // Repetitive on purpose: a transcript is JSONL and compresses about
    // tenfold, which is the whole reason this reclaims anything.
    const body = `${'{"type":"assistant","text":"immer dasselbe"}\n'.repeat(500)}`;
    const raw = await seed(OLD, 'lauf-1.jsonl', body);

    const result = await pruneExpiredTranscripts({ transcriptsRoot: root, now: () => NOW });

    expect(result.compressed).toBe(1);
    expect(result.problems).toEqual([]);
    expect(result.freedBytes).toBeGreaterThan(0);

    // The assertion is the filesystem afterwards, never that `pipeline`
    // resolved: the raw file is gone and its archive is readable.
    await expect(stat(raw)).rejects.toThrow();
    const archive = `${raw}.gz`;
    expect((await stat(archive)).size).toBeGreaterThan(0);

    // And the content survived the round trip — a `.gz` that unpacks to
    // something else would be a silent loss of the traceability chain.
    const chunks: Buffer[] = [];
    const collect = new Writable({
      write(chunk, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    });
    await pipeline(createReadStream(archive), createGunzip(), collect);
    expect(Buffer.concat(chunks).toString()).toBe(body);
  });

  /**
   * The ordering that matters, in the direction that is reachable.
   *
   * A raw transcript is unlinked only after its archive exists — so a
   * compression that fails must leave the raw file exactly where it was. A
   * directory named `*.jsonl` is the cheapest way to make `createReadStream`
   * reject; what it stands for is a full disk, a read error, a killed process.
   *
   * Recorded honestly: the neighbouring guard (`after.size <= 0` before the
   * unlink) is *not* covered, and its mutation survives — gzip of any input
   * produces a non-empty file, so the branch is unreachable through this path.
   * It is defence against a filesystem that reports a zero-size file after a
   * successful rename, and nothing here can produce one.
   */
  it('lässt die Rohdatei liegen, wenn das Komprimieren scheitert', async () => {
    await mkdir(join(root, OLD, 'kaputt.jsonl'), { recursive: true });

    const result = await pruneExpiredTranscripts({ transcriptsRoot: root, now: () => NOW });

    expect(result.compressed).toBe(0);
    expect(result.problems).toHaveLength(1);
    // Still there — the unlink never ran, because the archive never appeared.
    expect((await stat(join(root, OLD, 'kaputt.jsonl'))).isDirectory()).toBe(true);
  });

  it('fasst ein Transkript innerhalb der Aufbewahrungsfrist nicht an', async () => {
    const raw = await seed(RECENT, 'lauf-2.jsonl', 'noch frisch\n');

    const result = await pruneExpiredTranscripts({ transcriptsRoot: root, now: () => NOW });

    expect(result.compressed).toBe(0);
    expect((await stat(raw)).size).toBeGreaterThan(0);
  });

  it('lässt alles liegen, was nicht nach A15s Ablage aussieht', async () => {
    // A directory that is not a day, and a file in an expired day that is not a
    // transcript. The prune is the only thing in this change that removes a
    // file; its blast radius is asserted rather than intended.
    await mkdir(join(root, 'archiv'), { recursive: true });
    const stray = join(root, 'archiv', 'wichtig.jsonl');
    await writeFile(stray, 'nicht anfassen\n');
    const notes = await seed(OLD, 'notizen.txt', 'auch nicht\n');

    const result = await pruneExpiredTranscripts({ transcriptsRoot: root, now: () => NOW });

    expect(result.compressed).toBe(0);
    expect((await stat(stray)).size).toBeGreaterThan(0);
    expect((await stat(notes)).size).toBeGreaterThan(0);
  });

  it('lässt bereits komprimierte Archive unberührt', async () => {
    // A15's second boundary — deleting archives after a year — is deliberately
    // not built (decision 7). This pins that: the `.gz` of an expired day stays.
    await mkdir(join(root, OLD), { recursive: true });
    const archive = join(root, OLD, 'lauf-3.jsonl.gz');
    await writeFile(archive, 'schon komprimiert\n');

    const result = await pruneExpiredTranscripts({ transcriptsRoot: root, now: () => NOW });

    expect(result.compressed).toBe(0);
    expect((await stat(archive)).size).toBeGreaterThan(0);
  });

  it('meldet ein fehlendes Transkriptverzeichnis nicht als Fehler', async () => {
    const result = await pruneExpiredTranscripts({
      transcriptsRoot: join(root, 'gibt-es-nicht'),
      now: () => NOW,
    });

    // A developer machine with no transcripts volume, on every alert-level run.
    expect(result).toEqual({ compressed: 0, freedBytes: 0, problems: [] });
  });

  it('lässt einen unlesbaren Tag nicht die anderen kosten', async () => {
    const body = 'x'.repeat(200);
    await seed(OLD, 'lauf-4.jsonl', body);
    // A day directory that is a file: `readdir` on it fails with ENOTDIR.
    await writeFile(join(root, '2026-04-12'), 'kein Verzeichnis\n');

    const result = await pruneExpiredTranscripts({ transcriptsRoot: root, now: () => NOW });

    expect(result.compressed).toBe(1);
    // Not a directory, so it is skipped by the `isDirectory()` guard rather
    // than reported — what matters is that the good day still ran.
    expect(await readdir(join(root, OLD))).toEqual(['lauf-4.jsonl.gz']);
  });
});
