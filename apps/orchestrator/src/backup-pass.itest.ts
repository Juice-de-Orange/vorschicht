/**
 * §18's backup report, driven by real documents against a real event log.
 *
 * The three properties this pass exists for are all properties of a *memory* —
 * "one event per run", "one notification per transition", "nothing repeated
 * across passes" — and the memory is a row in `event_log`. A stubbed store
 * would let this suite assert whatever it was told, while the failure being
 * defended against is precisely that store not being consulted: a pass whose
 * state lived in a variable would re-announce the same night after every
 * restart, and a deploy is a restart (A57).
 *
 * So: a real database, real files written to a real temp directory, and only
 * ntfy faked — which is what `escalation-mail.itest.ts` does with the transport
 * and for the same reason (the socket is proved elsewhere; what is under
 * examination here is the policy above it).
 *
 * No clock is injected, and that is a decision rather than an omission. A run's
 * identity is the `finished_at` its own producer wrote; a timestamp of ours
 * would make "have I seen this" a question about our process rather than about
 * the run, and every restart would answer it wrongly.
 *
 * A fresh database **per case**, following `escalation-mail.itest.ts`: the
 * question this pass asks — "what was the last recorded backup" — is global by
 * construction, `event_log` is append-only and its guards refuse DELETE and
 * TRUNCATE, so one case's events would decide the next one's and the suite
 * would pass or fail by declaration order.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventLog, type Notification } from '@vorschicht/core';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBackupPass } from './backup-pass.js';

const url = process.env.TEST_DATABASE_URL;

/** ntfy as this module sees it: something that delivers, or refuses. */
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

function silentLogger() {
  const lines: Array<{ level: string; message: string }> = [];
  const at = (level: string) => (_obj: unknown, message?: string) => {
    lines.push({ level, message: message ?? '' });
  };
  return { lines, info: at('info'), warn: at('warn'), error: at('error') };
}

/** What `backup-run.sh` leaves behind, as it leaves it. */
function document(over: { finishedAt: number; outcome: 'ok' | 'failed' }): string {
  const failed = over.outcome === 'failed';
  return `${[
    'schema=1',
    `started_at=${over.finishedAt - 40}`,
    `finished_at=${over.finishedAt}`,
    'stamp=20260803-023000',
    `outcome=${over.outcome}`,
    // Genau der beobachtete Teilerfolg: die Datenbank und die Dokumente lagen
    // schon gesichert, als der Lauf an den Transkripten abbrach.
    'db=ok',
    'docs=ok',
    `transcripts=${failed ? 'failed' : 'ok'}`,
    `prune=${failed ? 'skipped' : 'ok'}`,
    `problem=${failed ? 'tar für transcripts fehlgeschlagen' : ''}`,
  ].join('\n')}\n`;
}

describe.skipIf(!url)('§18: Sicherungsereignisse und ihr Alarm', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let eventLog: EventLog;
  let notifier: ReturnType<typeof recordingNotifier>;
  let logger: ReturnType<typeof silentLogger>;
  let directory: string;
  let resultPath: string;
  let caseNumber = 0;

  beforeEach(async () => {
    caseNumber += 1;
    database = await createTestDatabase(`backup_pass_${caseNumber}`);
    sql = createSql({ url: database.url, max: 3 });
    eventLog = new EventLog(sql);
    notifier = recordingNotifier();
    logger = silentLogger();
    directory = await mkdtemp(join(tmpdir(), 'vorschicht-backup-'));
    resultPath = join(directory, '.last-result');
  });

  /*
   * Optional chaining, and it is not tidiness.
   *
   * When `beforeEach` fails — a database that could not be created under load,
   * say — `sql` was never assigned, and an unguarded `sql.end()` here throws
   * `TypeError: Cannot read properties of undefined (reading 'end')` **over**
   * the real cause. Vitest reports the teardown error, so whoever reads the run
   * goes looking in the cleanup for a fault that happened in the setup. Observed
   * on 2026-08-10, where the actual failure was
   * `duplicate key value violates unique constraint "pg_authid_rolname_index"`
   * and none of that appeared.
   *
   * Same class as A93.7 and A96: an error path that reports something other
   * than what happened. Cheap here, expensive at three in the morning.
   */
  afterEach(async () => {
    await sql?.end({ timeout: 5 });
    await database?.drop();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const pass = () => runBackupPass({ resultPath, eventLog, sql, notifier, logger });

  /** Every backup event this log holds, oldest first. */
  async function events() {
    return sql<Array<{ kind: string; payload: Record<string, unknown> }>>`
      SELECT kind, payload FROM event_log
      WHERE kind IN ('backup.succeeded', 'backup.failed')
      ORDER BY id ASC
    `;
  }

  it('sagt gar nichts, solange kein Lauf stattgefunden hat', async () => {
    // Frischer Stapel oder eine Entwicklermaschine ohne gemountetes Volume.
    // Beides ist der Normalzustand und keine Störung — und der Durchlauf läuft
    // alle fünfzehn Sekunden, also wäre eine Zeile hier eine Zeile zu viel.
    const result = await pass();

    expect(result.observed).toBe(false);
    expect(result.problems).toEqual([]);
    expect(logger.lines).toEqual([]);
    expect(notifier.sent).toEqual([]);
    expect(await events()).toEqual([]);
  });

  it('zeichnet einen erfolgreichen Lauf auf und alarmiert dabei nicht', async () => {
    await writeFile(resultPath, document({ finishedAt: 1_754_180_042, outcome: 'ok' }));

    const result = await pass();

    expect(result).toMatchObject({ observed: true, outcome: 'ok', recorded: true, alerted: null });
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('backup.succeeded');
    // §18 will das Ereignis für die Ops-Kachel — den Alarm ausdrücklich nur
    // beim Fehlschlag. Eine gelungene Nacht ist keine Nachricht.
    expect(notifier.sent).toEqual([]);
  });

  it('meldet einen Fehlschlag genau einmal und nennt dabei die Bestandteile', async () => {
    await writeFile(resultPath, document({ finishedAt: 1_754_180_042, outcome: 'failed' }));

    const result = await pass();

    expect(result).toMatchObject({ recorded: true, alerted: 'failure' });
    const rows = await events();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe('backup.failed');
    // Der Teilerfolg überlebt bis in die Zeile: das war der ganze Grund, die
    // Bestandteile einzeln zu führen.
    expect(rows[0]?.payload.components).toEqual({
      db: 'ok',
      docs: 'ok',
      transcripts: 'failed',
      prune: 'skipped',
    });
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]?.topic).toBe('alerts');
    expect(notifier.sent[0]?.message).toContain('transcripts: failed');
    expect(notifier.sent[0]?.message).toContain('tar für transcripts fehlgeschlagen');
  });

  it('wiederholt über zwanzig Durchläufe weder Ereignis noch Alarm', async () => {
    // Die eigentliche Zusicherung. Der Durchlauf läuft alle fünfzehn Sekunden
    // und eine Sicherung einmal pro Nacht: ohne Gedächtnis wären das ~5700
    // Ereignisse und ~5700 Pushes am Tag — der Verstärker, der aus einer
    // stillen Störung eine unbrauchbare Meldekette macht (A67.6, A86.5).
    await writeFile(resultPath, document({ finishedAt: 1_754_180_042, outcome: 'failed' }));

    for (let i = 0; i < 20; i += 1) await pass();

    expect(await events()).toHaveLength(1);
    expect(notifier.sent).toHaveLength(1);
  });

  it('meldet die Erholung genau einmal, wenn die nächste Nacht durchläuft', async () => {
    await writeFile(resultPath, document({ finishedAt: 1_754_180_042, outcome: 'failed' }));
    await pass();
    await pass();

    await writeFile(resultPath, document({ finishedAt: 1_754_266_442, outcome: 'ok' }));
    const back = await pass();
    await pass();

    expect(back.alerted).toBe('recovery');
    expect((await events()).map((row) => row.kind)).toEqual(['backup.failed', 'backup.succeeded']);
    expect(notifier.sent.map((notification) => notification.topic)).toEqual(['alerts', 'info']);
  });

  it('alarmiert bei einer zweiten schlechten Nacht nicht erneut', async () => {
    // Der Übergang ist das Ereignis, nicht der Zustand: eine Störung, die drei
    // Nächte dauert, ist ein Alarm — sonst schaltet der Betreiber den Kanal stumm und der
    // nächste echte Ausfall ist unsichtbar.
    await writeFile(resultPath, document({ finishedAt: 1_754_180_042, outcome: 'failed' }));
    await pass();
    await writeFile(resultPath, document({ finishedAt: 1_754_266_442, outcome: 'failed' }));
    const second = await pass();

    expect(second.recorded).toBe(true);
    expect(second.alerted).toBeNull();
    // Aufgezeichnet wird trotzdem jede Nacht — die Kachel muss zählen können,
    // wie lange es schon so geht.
    expect(await events()).toHaveLength(2);
    expect(notifier.sent).toHaveLength(1);
  });

  it('merkt sich einen von ntfy abgelehnten Alarm nicht und versucht ihn erneut', async () => {
    // Entscheidung 5: Alarm und Ereignis reisen zusammen. Würde die Nacht schon
    // aufgezeichnet, wäre sie beim nächsten Durchlauf „schon gesehen" und der
    // Alarm für immer verloren.
    await writeFile(resultPath, document({ finishedAt: 1_754_180_042, outcome: 'failed' }));

    notifier.refuse = true;
    const refused = await pass();
    expect(refused.alerted).toBeNull();
    expect(refused.recorded).toBe(false);
    expect(refused.failures).toHaveLength(1);
    expect(await events()).toEqual([]);

    notifier.refuse = false;
    const retried = await pass();
    expect(retried.alerted).toBe('failure');
    expect(retried.recorded).toBe(true);
    expect(await events()).toHaveLength(1);
    expect(notifier.sent).toHaveLength(1);
  });

  it('überlebt einen Neustart, ohne dieselbe Nacht erneut zu melden', async () => {
    // Der Unterschied zwischen „Zustand im Ereignisprotokoll" und „Zustand in
    // einer Prozessvariablen", und er ist nicht theoretisch: ein Rollout ist ein
    // Neustart (A57), und eine Störung dauert länger als einer.
    //
    // Der Neustart muss dabei wirklich einer sein. Nur eine neue Verbindung zu
    // nehmen würde nichts beweisen — ein Modulzustand überlebt die — also wird
    // das Modul verworfen und neu geladen, was in einem Prozess dem Nächsten am
    // nächsten kommt. Genau daran hängt die Mutation: ein `let` im Modul lässt
    // diesen Fall rot werden, eine Abfrage gegen das Protokoll nicht.
    await writeFile(resultPath, document({ finishedAt: 1_754_180_042, outcome: 'failed' }));
    await pass();

    vi.resetModules();
    const neuGeladen = await import('./backup-pass.js');
    const fresh = createSql({ url: database.url, max: 3 });
    const freshNotifier = recordingNotifier();
    try {
      const after = await neuGeladen.runBackupPass({
        resultPath,
        eventLog: new EventLog(fresh),
        sql: fresh,
        notifier: freshNotifier,
        logger: silentLogger(),
      });

      expect(after.recorded).toBe(false);
      expect(after.alerted).toBeNull();
      expect(freshNotifier.sent).toEqual([]);
      expect(await events()).toHaveLength(1);
    } finally {
      await fresh.end({ timeout: 5 });
    }
  });

  it('meldet ein unlesbares Dokument, statt es für einen sauberen Lauf zu halten', async () => {
    await writeFile(resultPath, 'schema=7\nfinished_at=1\noutcome=ok\n');

    const result = await pass();

    expect(result.observed).toBe(false);
    expect(result.recorded).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(logger.lines.at(-1)?.level).toBe('error');
    expect(await events()).toEqual([]);
    expect(notifier.sent).toEqual([]);
  });

  it('reißt den Daemon nicht mit, wenn die Datenbank weg ist', async () => {
    // Eigenschaft 2. `main.ts` umschließt den Aufruf bewusst nicht mit `try`,
    // und eine Ablehnung dort erreicht `main().catch()` — unter compose ein
    // Neustartkarussell, ausgelöst ausgerechnet von der Meldekette.
    await writeFile(resultPath, document({ finishedAt: 1_754_180_042, outcome: 'failed' }));
    const broken = createSql({ url: database.url, max: 3 });
    await broken.end({ timeout: 5 });

    const result = await runBackupPass({
      resultPath,
      eventLog: new EventLog(broken),
      sql: broken,
      notifier,
      logger,
    });

    expect(result.problems).toHaveLength(1);
    expect(result.recorded).toBe(false);
    expect(logger.lines.at(-1)?.level).toBe('error');
  });
});
