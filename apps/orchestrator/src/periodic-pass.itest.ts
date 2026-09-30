/**
 * The Taktgeber and its one consumer, against a real event log.
 *
 * The property under examination is the one the whole module exists for and the
 * one a stub cannot carry: **the deadline is a row, not a variable.** A pass
 * whose memory lived in the process would re-run every nightly job after every
 * rollout, and a deploy is a restart (A57) — so the test that means anything is
 * one that throws the pass away and builds a new one, which is what a restart
 * looks like from the database's side.
 *
 * A fresh database per case, following `backup-pass.itest.ts` and for the same
 * reason: the question "when did this last run" is global by construction,
 * `event_log` is append-only, and its guards refuse DELETE and TRUNCATE — so
 * one case's rows would decide the next one's and the suite would pass or fail
 * by declaration order.
 *
 * No clock is injected anywhere here. That is the point of decision 2: the age
 * of a row is computed by the database that stamped it, so a test warps time by
 * writing an older `occurred_at` rather than by lying to the code about `now`.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog, type Notification } from '@vorschicht/core';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DISK_CHECK_INTERVAL_MS, runDiskWatch } from './disk-watch.js';
import { type PeriodicJob, runPeriodicPass } from './periodic-pass.js';

const url = process.env.TEST_DATABASE_URL;

function silentLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function recordingNotifier() {
  const sent: Notification[] = [];
  const notifier = {
    sent,
    refuse: false,
    send: async (notification: Notification) => {
      if (notifier.refuse) return { ok: false as const, status: 503, error: 'ntfy antwortete 503' };
      sent.push(notification);
      return { ok: true as const, status: 200 };
    },
  };
  return notifier;
}

describe.skipIf(!url)('runPeriodicPass', () => {
  let database: TestDatabase;
  let sql: postgres.Sql;
  let eventLog: EventLog;

  beforeEach(async () => {
    database = await createTestDatabase('periodic');
    sql = createSql({ url: database.url, max: 4 });
    eventLog = new EventLog(sql);
  }, 60_000);

  afterEach(async () => {
    await sql?.end({ timeout: 5 }).catch(() => undefined);
    await database?.drop();
  });

  /** A job that counts its runs and writes the row its own deadline reads. */
  function countingJob(over: Partial<PeriodicJob> = {}) {
    const runs: number[] = [];
    const job: PeriodicJob = {
      name: 'zaehler',
      intervalMs: 60 * 60_000,
      lastRunKind: 'disk.checked',
      run: async () => {
        runs.push(Date.now());
        await eventLog.append({ kind: 'disk.checked', actor: 'system', payload: {} });
        return null;
      },
      ...over,
    };
    return { job, runs };
  }

  it('läuft sofort, wenn es zu diesem Job noch keine Zeile gibt', async () => {
    const { job, runs } = countingJob();

    const result = await runPeriodicPass({ jobs: [job], sql, logger: silentLogger() });

    expect(result.ran).toEqual(['zaehler']);
    expect(runs).toHaveLength(1);
  });

  it('läuft danach nicht noch einmal, solange die Frist nicht um ist', async () => {
    const { job, runs } = countingJob();
    await runPeriodicPass({ jobs: [job], sql, logger: silentLogger() });

    const result = await runPeriodicPass({ jobs: [job], sql, logger: silentLogger() });

    expect(result.ran).toEqual([]);
    expect(result.waiting).toEqual(['zaehler']);
    expect(runs).toHaveLength(1);
  });

  /**
   * The case the module exists for.
   *
   * Nothing is carried between the two calls: fresh job objects, and the second
   * pass is handed a `run` the first one never saw. If the deadline lived
   * anywhere but in the row, this would run twice.
   */
  it('überlebt den Neustart des Prozesses, weil die Frist eine Zeile ist', async () => {
    const first = countingJob();
    await runPeriodicPass({ jobs: [first.job], sql, logger: silentLogger() });
    expect(first.runs).toHaveLength(1);

    // Everything the previous "process" held is gone.
    const second = countingJob();
    const result = await runPeriodicPass({ jobs: [second.job], sql, logger: silentLogger() });

    expect(second.runs).toHaveLength(0);
    expect(result.waiting).toEqual(['zaehler']);
  });

  it('läuft wieder, sobald die Frist abgelaufen ist', async () => {
    const { job, runs } = countingJob();

    // Time-warp by writing an older row rather than by lying about `now`: the
    // code asks Postgres how old its own newest row is, and `event_log` refuses
    // UPDATE (0001), so this is both the only lever there is and what the real
    // situation looks like — a run that happened, an hour ago.
    await sql`
      INSERT INTO event_log (kind, actor, payload, occurred_at)
      VALUES ('disk.checked', 'system', '{}'::jsonb, now() - interval '61 minutes')
    `;

    const result = await runPeriodicPass({ jobs: [job], sql, logger: silentLogger() });
    expect(result.ran).toEqual(['zaehler']);
    expect(runs).toHaveLength(1);
  });

  it('nimmt die jüngste Zeile, nicht irgendeine', async () => {
    // An old row and a fresh one. Reading by `occurred_at` alone without an
    // ordering would be a coin toss; the query orders by id, which is the only
    // total order two rows in the same millisecond have.
    await sql`
      INSERT INTO event_log (kind, actor, payload, occurred_at)
      VALUES ('disk.checked', 'system', '{}'::jsonb, now() - interval '10 hours')
    `;
    await eventLog.append({ kind: 'disk.checked', actor: 'system', payload: {} });
    const { job, runs } = countingJob();

    const result = await runPeriodicPass({ jobs: [job], sql, logger: silentLogger() });

    expect(result.waiting).toEqual(['zaehler']);
    expect(runs).toHaveLength(0);
  });

  it('lässt einen geworfenen Job die anderen nicht kosten', async () => {
    const { job: healthy, runs } = countingJob({ name: 'gesund' });
    const broken: PeriodicJob = {
      name: 'kaputt',
      intervalMs: 60 * 60_000,
      // A kind that will never be written by this job, so it is due every pass
      // — which is exactly what happens to a job that throws before recording.
      lastRunKind: 'system.started',
      run: async () => {
        throw new Error('Sensor antwortet nicht');
      },
    };

    const result = await runPeriodicPass({
      jobs: [broken, healthy],
      sql,
      logger: silentLogger(),
    });

    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('Sensor antwortet nicht');
    expect(result.ran).toEqual(['gesund']);
    expect(runs).toHaveLength(1);
  });

  it('läuft nicht ins Blaue, wenn die Fristen nicht lesbar sind', async () => {
    const { job, runs } = countingJob();
    // A connection that is gone. `Queryable` is a tagged-template function, so
    // the stand-in is simply a function that throws when it is used as one.
    const failing = (() => {
      throw new Error('Verbindung weg');
    }) as unknown as postgres.Sql;

    const result = await runPeriodicPass({ jobs: [job], sql: failing, logger: silentLogger() });

    // Running everything anyway would turn an unreachable database into a radar
    // scan every fifteen seconds; skipping costs an hour of latency at most.
    expect(result.ran).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(runs).toHaveLength(0);
  });
});

describe.skipIf(!url)('runDiskWatch (§18, A30)', () => {
  let database: TestDatabase;
  let sql: postgres.Sql;
  let eventLog: EventLog;
  let root: string;

  beforeEach(async () => {
    database = await createTestDatabase('diskwatch');
    sql = createSql({ url: database.url, max: 4 });
    eventLog = new EventLog(sql);
    root = await mkdtemp(join(tmpdir(), 'vorschicht-diskwatch-'));
  }, 60_000);

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await sql?.end({ timeout: 5 }).catch(() => undefined);
    await database?.drop();
  });

  async function events(): Promise<Array<{ level: string; announced: boolean }>> {
    const rows = await sql<Array<{ level: string; announced: boolean }>>`
      SELECT payload ->> 'level' AS level, (payload ->> 'announced')::boolean AS announced
      FROM event_log WHERE kind = 'disk.checked' ORDER BY id
    `;
    return rows;
  }

  function deps(notifier: ReturnType<typeof recordingNotifier>) {
    return {
      paths: [root],
      transcriptsRoot: join(root, 'transcripts'),
      eventLog,
      sql,
      notifier,
      logger: silentLogger(),
    };
  }

  /**
   * Decision 6, and the reason the pass has a deadline at all.
   *
   * A watch that wrote only on a transition would leave `periodic-pass.ts` with
   * no row to date, and the job would then run on every tick forever — the
   * opposite of the flood A30 is trying to be quiet about.
   */
  it('schreibt bei jedem Lauf eine Zeile, auch wenn sich nichts geändert hat', async () => {
    const notifier = recordingNotifier();

    await runDiskWatch(deps(notifier));
    await runDiskWatch(deps(notifier));

    expect(await events()).toHaveLength(2);
  });

  it('meldet einen nicht messbaren Pfad als Warnung statt als in Ordnung', async () => {
    const notifier = recordingNotifier();

    const report = await runDiskWatch({
      ...deps(notifier),
      paths: [join(root, 'gibt-es-nicht')],
    });

    // Decision 4: "we could not look" and "it is fine" are the same sentence
    // only to a system that has decided not to notice.
    expect(report.level).toBe('warning');
    expect(report.reading.unreadable).toHaveLength(1);
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.topic).toBe('info');
  });

  it('meldet dieselbe Lage kein zweites Mal', async () => {
    const notifier = recordingNotifier();
    const unreadable = { ...deps(notifier), paths: [join(root, 'gibt-es-nicht')] };

    await runDiskWatch(unreadable);
    await runDiskWatch(unreadable);

    // A67.6 and A86.5, fourth channel: hourly pushes about a disk that is still
    // at 81% is a channel that gets muted.
    expect(notifier.sent).toHaveLength(1);
    const rows = await events();
    expect(rows.map((row) => row.announced)).toEqual([true, false]);
  });

  it('merkt sich die Lage über einen Neustart hinweg', async () => {
    const first = recordingNotifier();
    await runDiskWatch({ ...deps(first), paths: [join(root, 'gibt-es-nicht')] });
    expect(first.sent).toHaveLength(1);

    // A brand-new notifier and a brand-new deps object: nothing of the previous
    // "process" survives except the row.
    const second = recordingNotifier();
    await runDiskWatch({ ...deps(second), paths: [join(root, 'gibt-es-nicht')] });

    expect(second.sent).toHaveLength(0);
  });

  it('merkt eine abgewiesene Meldung nicht als zugestellt vor', async () => {
    const notifier = recordingNotifier();
    notifier.refuse = true;
    const unreadable = { ...deps(notifier), paths: [join(root, 'gibt-es-nicht')] };

    const first = await runDiskWatch(unreadable);
    expect(first.announced).toBe(false);

    // The row is written either way — otherwise the pass loses its deadline and
    // hammers the check — but `announced: false` means the *next* run tries
    // again rather than treating the outage as announced.
    notifier.refuse = false;
    const second = await runDiskWatch(unreadable);
    expect(second.announced).toBe(true);
    expect(notifier.sent).toHaveLength(1);
  });

  it('räumt unterhalb der Alarmschwelle nichts weg', async () => {
    // An expired raw transcript on a filesystem that is nowhere near full: A30
    // ties the prune to ≥ 90%, and a watch that compressed on every run would
    // be a different feature with a different risk.
    //
    // **Die Belegung wird eingespeist, nicht gemessen — und das ist eine
    // Korrektur.** Bis zum 11.8.2026 las dieser Fall das *echte* Dateisystem,
    // und an dem Tag lief die Entwicklungsmaschine auf 100 % voll: der Fall
    // wurde rot mit `expected 'alert' not to be 'alert'`, also mit einer
    // vollkommen korrekten Messung. Ein Test, der die Maschine benotet statt
    // den Code, ist genau A68s Klasse — er sagt nichts über die Zusicherung,
    // die in seinem Namen steht, und er blockiert einen Commit aus einem Grund,
    // der nicht im Baum liegt. `DiskWatchDeps.stat` ist die dafür vorgesehene
    // Naht und stand die ganze Zeit da.
    const day = join(root, 'transcripts', '2020-01-01');
    await mkdir(day, { recursive: true });
    await writeFile(join(day, 'alt.jsonl'), 'x'.repeat(100));

    // 40 % belegt: deutlich unter A30s Warnung (80 %) und Alarm (90 %), damit
    // der Fall auch dann noch dasselbe prüft, wenn jemand die Schwellen
    // verschiebt — er hinge sonst an einer Zahl, die er nicht nennt.
    const stat = async () => ({ type: 0, bsize: 4096, blocks: 1000, bfree: 600, bavail: 600 });
    const report = await runDiskWatch({ ...deps(recordingNotifier()), stat });

    expect(report.level).not.toBe('alert');
    expect(report.pruned).toBeNull();
  });

  it('nennt die Kadenz, die der Pass liest', () => {
    // A30 says nothing about frequency; an hour is this build's choice and it
    // has to agree with what `main.ts` registers.
    expect(DISK_CHECK_INTERVAL_MS).toBe(60 * 60_000);
  });
});
