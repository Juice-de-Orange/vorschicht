/**
 * A13's reminder and digest, proved by moving the clock rather than by waiting.
 *
 * Against a real Postgres, because the property under test is *idempotence* and
 * the memory that provides it is a row in `event_log`. A stubbed store would let
 * this suite assert whatever it was told, and the failure it exists to catch —
 * a reminder that fires on every tick because nothing recorded the first one —
 * is precisely a failure of that store to be consulted.
 *
 * Two things are injected and nothing else is faked: the clock (`now`, as
 * `GuardianService`, `UsageMeter` and `Scheduler` already do it) and the
 * transport, which is proved against a real socket in `mail.test.ts`. Nothing
 * here sleeps.
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import {
  DIGEST_INTERVAL_MS,
  type EscalationSource,
  inboxUrl,
  type Priority,
  precedentKey,
  REMINDER_AFTER_MS,
} from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EscalationMailService } from './escalation-mail.js';
import { EscalationService } from './escalation-service.js';
import { EventLog } from './event-log.js';
import type { Mailer, MailResult, OutgoingMail } from './mail.js';

const url = process.env.TEST_DATABASE_URL;

const OPTIONS = [
  { title: 'So lassen', pros: ['billig'], cons: ['langsam'], recommended: true },
  { title: 'Umbauen', pros: ['schnell'], cons: ['teuer'], recommended: false },
];
const CONTEXT = 'Der Läufer braucht eine Entscheidung, bevor er weiterarbeitet.';

/**
 * A mailer that records instead of sending, and can be told to fail.
 *
 * `enabled` is a property of the real one too, and the "SMTP not configured"
 * case below depends on the service reading it rather than assuming it.
 */
class RecordingMailer implements Mailer {
  readonly sent: OutgoingMail[] = [];
  failNext = false;
  constructor(readonly enabled = true) {}

  async send(mail: OutgoingMail): Promise<MailResult> {
    if (this.failNext) {
      this.failNext = false;
      return { ok: false, skipped: false, error: 'ECONNREFUSED' };
    }
    this.sent.push(mail);
    return { ok: true };
  }
}

describe.skipIf(!url)('A13: Erinnerung und Digest (§16)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let escalations: EscalationService;
  let eventLog: EventLog;
  let mailer: RecordingMailer;
  let service: EscalationMailService;
  let caseNumber = 0;

  /** The test clock. Deliberately a fixed moment, not `Date.now()`. */
  let clock = Date.parse('2026-08-01T08:00:00Z');
  const now = (): number => clock;

  /**
   * A fresh database per **case**, not per file.
   *
   * The usual arrangement (one per file) does not work here, and the reason is
   * the subject matter: `escalation_events` and `event_log` are append-only and
   * their guards refuse DELETE *and* TRUNCATE — properties other suites prove
   * and this one has to live with — while both questions asked here are global.
   * "Has a reminder already gone out" reads the whole log, and "is a digest due"
   * is `max(occurred_at)` over every digest ever sent. One case's digest would
   * decide the next one's, and the suite would pass or fail by declaration order.
   *
   * The alternative was disabling the append-only triggers between cases, i.e. a
   * harness reaching around the guarantee it is meant to run under. A database
   * costs about a second; this is the right thing to spend it on.
   */
  beforeEach(async () => {
    caseNumber += 1;
    database = await createTestDatabase(`esc_mail_${caseNumber}`);
    sql = createSql({ url: database.url, max: 3 });
    eventLog = new EventLog(sql);
    escalations = new EscalationService({ sql, eventLog });
    clock = Date.parse('2026-08-01T08:00:00Z');
    mailer = new RecordingMailer();
    service = new EscalationMailService({
      sql,
      eventLog,
      escalations,
      mailer,
      publicOrigin: 'https://vorschicht.example',
      recipient: 'max@example.org',
      now,
    });
  });

  afterEach(async () => {
    await sql?.end();
    await database?.drop();
  });

  /**
   * An inbox item that was raised `ageMs` ago, on the test clock.
   *
   * `EscalationService.raise` stamps `occurred_at` with the *database's* `now()`
   * — correctly, since that is the moment it happened — which makes it useless
   * for a suite whose whole subject is how old an item is. So the raise is
   * written here with an explicit timestamp. The obvious risk of a fixture that
   * writes a row the service normally writes is drift, so the last case in this
   * file holds the two shapes against each other; if `raise()` starts recording
   * something else, that case goes red rather than these quietly testing a row
   * shape nothing produces.
   */
  async function seed(options: {
    question: string;
    ageMs?: number;
    urgency?: Priority;
    source?: EscalationSource;
  }): Promise<number> {
    const key = precedentKey(options.question);
    const payload = {
      source: options.source ?? ('agent_question' satisfies EscalationSource),
      urgency: options.urgency ?? ('P1' satisfies Priority),
      projectId: null,
      taskId: null,
      runId: null,
      question: options.question,
      context: CONTEXT,
      options: OPTIONS,
      precedentKey: key.length > 0 ? key : null,
      related: [],
    };
    const [row] = await sql<Array<{ number: string }>>`
      INSERT INTO escalation_events (escalation_id, seq, kind, actor, occurred_at, number, payload)
      VALUES (
        gen_random_uuid(), 1, 'raised', 'coder',
        ${new Date(clock - (options.ageMs ?? 0))},
        nextval('escalation_number_seq'),
        ${sql.json(payload as unknown as postgres.JSONValue)}
      )
      RETURNING number::text AS number
    `;
    if (!row) throw new Error('Fixture konnte keine Eskalation anlegen');
    return Number(row.number);
  }

  async function countEvents(kind: string): Promise<number> {
    const [row] = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM event_log WHERE kind = ${kind}`;
    return Number(row?.count ?? 0);
  }

  describe('die Erinnerung nach 24 Stunden', () => {
    it('schickt vor Ablauf der 24 Stunden nichts', async () => {
      await seed({ question: 'Darf Vorschicht undici ergänzen?', ageMs: REMINDER_AFTER_MS - 1 });

      const outcome = await service.tick();

      expect(outcome.reminded).toEqual([]);
      expect(await countEvents('escalation.reminded')).toBe(0);
      // Der Digest geht sehr wohl raus — die beiden sind unabhängig.
      expect(mailer.sent.every((mail) => !mail.subject.includes('wartet seit'))).toBe(true);
    });

    it('schickt danach genau eine Erinnerung — und beim nächsten Durchlauf keine zweite', async () => {
      const number = await seed({
        question: 'Darf Vorschicht undici ergänzen?',
        ageMs: REMINDER_AFTER_MS,
      });

      expect((await service.tick()).reminded).toEqual([number]);

      // Die eigentliche Zusicherung von A13: der Tick läuft alle paar Sekunden.
      clock += 60_000;
      expect((await service.tick()).reminded).toEqual([]);
      clock += 6 * 60 * 60_000;
      expect((await service.tick()).reminded).toEqual([]);

      expect(await countEvents('escalation.reminded')).toBe(1);
      expect(mailer.sent.filter((mail) => mail.subject.includes(`#${number} wartet`))).toHaveLength(
        1,
      );
    });

    it('erinnert nicht an eine beantwortete Frage', async () => {
      const number = await seed({
        question: 'Darf Vorschicht undici ergänzen?',
        ageMs: 3 * REMINDER_AFTER_MS,
      });
      const record = await escalations.byNumber(number);
      if (!record) throw new Error('unerreichbar');
      await escalations.answer(record.id, { optionIndex: 0, actor: 'max' });

      const outcome = await service.tick();

      expect(outcome.reminded).toEqual([]);
      expect(outcome.digest).toBeNull();
      expect(mailer.sent).toHaveLength(0);
    });

    // Entscheidung 2 in `escalation-mail.ts`: eine gescheiterte Zustellung darf
    // nicht als zugestellt vermerkt werden, sonst erinnert nie wieder jemand.
    it('vermerkt eine gescheiterte Zustellung nicht und versucht es erneut', async () => {
      const number = await seed({
        question: 'Darf Vorschicht undici ergänzen?',
        ageMs: REMINDER_AFTER_MS,
      });

      mailer.failNext = true;
      const failed = await service.tick();
      expect(failed.reminded).toEqual([]);
      expect(failed.failures[0]).toContain('ECONNREFUSED');
      expect(await countEvents('escalation.reminded')).toBe(0);

      clock += 60_000;
      expect((await service.tick()).reminded).toEqual([number]);
      expect(await countEvents('escalation.reminded')).toBe(1);
    });

    it('erinnert je Eintrag getrennt, sobald dieser selbst 24 Stunden alt ist', async () => {
      const older = await seed({ question: 'Frage eins — undici?', ageMs: REMINDER_AFTER_MS });
      const younger = await seed({
        question: 'Frage zwei — auf dev schreiben?',
        ageMs: REMINDER_AFTER_MS - 12 * 60 * 60_000,
      });

      expect((await service.tick()).reminded).toEqual([older]);

      clock += 12 * 60 * 60_000;
      expect((await service.tick()).reminded).toEqual([younger]);
      expect(await countEvents('escalation.reminded')).toBe(2);
    });
  });

  describe('der tägliche Digest', () => {
    it('geht sofort raus, solange etwas offen ist — und dann genau einmal pro Tag', async () => {
      const number = await seed({ question: 'Darf Vorschicht undici ergänzen?' });

      expect((await service.tick()).digest).toEqual([number]);

      clock += DIGEST_INTERVAL_MS - 60_000;
      expect((await service.tick()).digest).toBeNull();
      clock += 30_000;
      expect((await service.tick()).digest).toBeNull();

      clock += 30_000;
      expect((await service.tick()).digest).toEqual([number]);

      expect(await countEvents('escalation.digest_sent')).toBe(2);
    });

    it('bleibt still, wenn nichts offen ist', async () => {
      const outcome = await service.tick();
      expect(outcome).toEqual({ enabled: true, reminded: [], digest: null, failures: [] });
      expect(mailer.sent).toHaveLength(0);
      expect(await countEvents('escalation.digest_sent')).toBe(0);
    });

    it('vermerkt einen gescheiterten Digest nicht und versucht ihn erneut', async () => {
      const number = await seed({ question: 'Darf Vorschicht undici ergänzen?' });

      mailer.failNext = true;
      expect((await service.tick()).digest).toBeNull();
      expect(await countEvents('escalation.digest_sent')).toBe(0);

      expect((await service.tick()).digest).toEqual([number]);
    });

    it('führt jeden offenen Eintrag auf, in der Reihenfolge der Inbox (§17.5)', async () => {
      const normal = await seed({ question: 'Frage eins — undici?' });
      const urgent = await seed({
        question: 'Aufgabe „Migration 0018" ist zweimal gescheitert — wie weiter?',
        urgency: 'P0',
        source: 'task_red',
      });

      const outcome = await service.tick();
      expect(outcome.digest).toEqual([urgent, normal]); // P0 vor P1

      const digest = mailer.sent.at(-1);
      if (!digest) throw new Error('kein Digest versendet');
      expect(digest.subject).toBe('Vorschicht: 2 Entscheidungen warten');
      for (const part of [digest.text, digest.html]) {
        expect(part).toContain(inboxUrl('https://vorschicht.example', urgent));
        expect(part).toContain(inboxUrl('https://vorschicht.example', normal));
      }
    });

    // Entscheidung 5: Erinnerung und Digest beantworten verschiedene Fragen.
    it('nimmt einen Eintrag auf, der im selben Durchlauf erinnert wurde', async () => {
      const number = await seed({ question: 'Darf Vorschicht undici ergänzen?' });
      await service.tick(); // verbraucht den ersten Digest

      clock += DIGEST_INTERVAL_MS;
      const outcome = await service.tick();
      expect(outcome.reminded).toEqual([number]);
      expect(outcome.digest).toEqual([number]);
    });
  });

  describe('ohne SMTP', () => {
    it('versendet nichts, schreibt nichts und wirft nicht', async () => {
      const disabled = new EscalationMailService({
        sql,
        eventLog,
        escalations,
        mailer: new RecordingMailer(false),
        publicOrigin: 'https://vorschicht.example',
        recipient: 'max@example.org',
        now,
      });
      await seed({ question: 'Darf Vorschicht undici ergänzen?', ageMs: 3 * REMINDER_AFTER_MS });

      const outcome = await disabled.tick();
      expect(outcome).toEqual({ enabled: false, reminded: [], digest: null, failures: [] });
      expect(await countEvents('escalation.reminded')).toBe(0);
      expect(await countEvents('escalation.digest_sent')).toBe(0);
    });

    it('versendet auch ohne Empfänger nichts', async () => {
      const nobody = new EscalationMailService({
        sql,
        eventLog,
        escalations,
        mailer,
        publicOrigin: 'https://vorschicht.example',
        now,
      });
      await seed({ question: 'Darf Vorschicht undici ergänzen?', ageMs: 3 * REMINDER_AFTER_MS });

      expect((await nobody.tick()).enabled).toBe(false);
      expect(mailer.sent).toHaveLength(0);
    });
  });

  describe('die versendete Nachricht', () => {
    it('trägt beide Teile, deutschen Text und den Deep-Link auf die Karte', async () => {
      const number = await seed({
        question: 'Darf Vorschicht die Abhängigkeit „undici" ergänzen?',
        ageMs: REMINDER_AFTER_MS,
      });
      await service.tick();

      const reminder = mailer.sent.find((mail) => mail.subject.includes(`#${number} wartet`));
      if (!reminder) throw new Error('keine Erinnerung versendet');

      expect(reminder.to).toBe('max@example.org');
      expect(reminder.subject).toBe(`Vorschicht: Entscheidung #${number} wartet seit 24 Stunden`);
      for (const part of [reminder.text, reminder.html]) {
        expect(part).toContain(inboxUrl('https://vorschicht.example', number));
        expect(part).toContain('Darf Vorschicht die Abhängigkeit');
        expect(part).toContain('So lassen');
      }
      expect(reminder.text).toContain('Frage aus einer Sitzung');
      expect(reminder.html).toContain('<!doctype html>');
      expect(reminder.text).not.toContain('<!doctype html>');
    });
  });

  /**
   * The fixture guard. Everything above seeds a raise directly, so this asks
   * whether the row it writes is the row `EscalationService.raise` writes.
   */
  it('das Fixture schreibt dieselbe Zeile wie EscalationService.raise', async () => {
    const seeded = await seed({ question: 'Darf Vorschicht undici ergänzen?' });
    const raised = await escalations.raise({
      source: 'agent_question',
      question: 'Darf Vorschicht undici ergänzen?',
      context: CONTEXT,
      urgency: 'P1',
      options: OPTIONS,
      raisedBy: 'coder',
    });

    const fixture = await escalations.byNumber(seeded);
    if (!fixture) throw new Error('unerreichbar');

    const comparable = ({
      id: _id,
      number: _number,
      raisedAt: _raisedAt,
      ...rest
    }: typeof raised): unknown => rest;
    expect(comparable(fixture)).toEqual(comparable(raised));
  });
});
