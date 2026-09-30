/**
 * §15's push, against a real Postgres.
 *
 * The property under test is idempotence, and the memory that provides it is a
 * row in `event_log` — the same arrangement `escalation-mail.itest.ts` runs
 * under, and the same reason for the database: a stubbed store would let this
 * suite assert whatever it was told, while the failure it exists to catch is
 * precisely that store not being consulted. A tick every fifteen seconds turns
 * "push on creation" into "push forever" the moment nothing remembers.
 *
 * Nothing is faked except ntfy itself, which is proved against a real socket in
 * `notify.test.ts`.
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import { INBOX_PATH, type Priority } from '@vorschicht/shared';
import type postgres from 'postgres';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EscalationPushService } from './escalation-push.js';
import { EscalationService } from './escalation-service.js';
import { EventLog } from './event-log.js';
import type { Notification, NotifyResult } from './notify.js';

const url = process.env.TEST_DATABASE_URL;

const OPTIONS = [
  { title: 'So lassen', pros: ['billig'], cons: ['langsam'], recommended: true },
  { title: 'Umbauen', pros: ['schnell'], cons: ['teuer'], recommended: false },
];
const CONTEXT = 'Der Läufer braucht eine Entscheidung, bevor er weiterarbeitet.';
const ORIGIN = 'https://vorschicht.example';

/** ntfy, recorded rather than sent, and able to refuse on command. */
class RecordingNotifier {
  readonly sent: Notification[] = [];
  refuse = false;

  async send(notification: Notification): Promise<NotifyResult> {
    if (this.refuse) return { ok: false, status: 503, error: 'ntfy antwortete 503' };
    this.sent.push(notification);
    return { ok: true, status: 200 };
  }
}

describe.skipIf(!url)('§15: Push auf den Inbox-Kanal (§16)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let escalations: EscalationService;
  let eventLog: EventLog;
  let notifier: RecordingNotifier;
  let service: EscalationPushService;
  let caseNumber = 0;

  /**
   * A fresh database per **case**, for `escalation-mail.itest.ts`'s reason:
   * `event_log` and `escalation_events` are append-only and their guards refuse
   * DELETE and TRUNCATE, while the question asked here — "has this already been
   * announced" — reads the whole log. Shared state would make the suite pass or
   * fail by declaration order.
   */
  beforeEach(async () => {
    caseNumber += 1;
    database = await createTestDatabase(`esc_push_${caseNumber}`);
    sql = createSql({ url: database.url, max: 3 });
    eventLog = new EventLog(sql);
    escalations = new EscalationService({ sql, eventLog });
    notifier = new RecordingNotifier();
    service = new EscalationPushService({
      sql,
      eventLog,
      escalations,
      notifier,
      publicOrigin: ORIGIN,
    });
  });

  afterEach(async () => {
    await sql?.end();
    await database?.drop();
  });

  async function raise(question: string, urgency: Priority = 'P1'): Promise<number> {
    const record = await escalations.raise({
      source: 'agent_question',
      question,
      context: CONTEXT,
      urgency,
      options: OPTIONS,
      raisedBy: 'coder',
    });
    return record.number;
  }

  async function countPushed(): Promise<number> {
    const [row] = await sql<Array<{ count: string }>>`
      SELECT count(*)::text AS count FROM event_log WHERE kind = 'escalation.pushed'`;
    return Number(row?.count ?? 0);
  }

  it('meldet eine neue Eskalation genau einmal — auch über drei Durchläufe', async () => {
    const number = await raise('Darf Vorschicht undici ergänzen?');

    expect((await service.push()).pushed).toEqual([number]);
    // Der Tick läuft alle fünfzehn Sekunden. Das hier ist die Zusicherung.
    expect((await service.push()).pushed).toEqual([]);
    expect((await service.push()).pushed).toEqual([]);

    expect(notifier.sent).toHaveLength(1);
    expect(await countPushed()).toBe(1);
  });

  it('verlinkt auf die Karte, nicht auf die Liste (§15)', async () => {
    const number = await raise('Darf Vorschicht undici ergänzen?');
    await service.push();

    const sent = notifier.sent[0];
    // Gegen `inboxUrl` zu prüfen hieße, die Implementierung gegen sich selbst zu
    // halten. Was §15 verlangt, ist der Weg *auf die Karte*: der Pfad endet auf
    // der Nummer, und die Liste allein wäre „hier ist alles" statt „hier ist es".
    expect(sent?.clickUrl).toBe(`${ORIGIN}${INBOX_PATH}/${number}`);
    expect(sent?.clickUrl?.endsWith(`/${number}`)).toBe(true);
    expect(sent?.clickUrl).not.toBe(`${ORIGIN}${INBOX_PATH}`);
  });

  it('trägt die Dringlichkeit in die ntfy-Priorität (§9, §16)', async () => {
    await raise('Aufgabe „Migration 0018" ist zweimal gescheitert — wie weiter?', 'P0');
    await raise('Soll die Doku nachgezogen werden?', 'P3');

    await service.push();

    const byTitle = new Map(notifier.sent.map((push) => [push.title, push.priority]));
    const [urgent, quiet] = [...byTitle.values()];
    // Die Inbox ist nach Dringlichkeit sortiert (§17.5), P0 kommt zuerst.
    expect(urgent).toBe('urgent');
    expect(quiet).toBe('default');
  });

  it('vermerkt einen abgelehnten Push nicht und versucht ihn erneut', async () => {
    const number = await raise('Darf Vorschicht undici ergänzen?');

    notifier.refuse = true;
    const refused = await service.push();
    expect(refused.pushed).toEqual([]);
    expect(refused.failures[0]).toContain('503');
    expect(await countPushed()).toBe(0);

    notifier.refuse = false;
    expect((await service.push()).pushed).toEqual([number]);
    expect(await countPushed()).toBe(1);
  });

  it('meldet eine bereits beantwortete Eskalation gar nicht', async () => {
    const number = await raise('Darf Vorschicht undici ergänzen?');
    const record = await escalations.byNumber(number);
    if (!record) throw new Error('unerreichbar');
    await escalations.answer(record.id, { optionIndex: 0, actor: 'max' });

    const outcome = await service.push();

    // Der Fall, der beim Neustart zählt: ein Daemon, der wieder hochkommt, darf
    // nicht eine Woche entschiedener Fragen erneut auf des Betreibers Telefon schicken.
    expect(outcome.pushed).toEqual([]);
    expect(notifier.sent).toHaveLength(0);
    expect(await countPushed()).toBe(0);
  });

  it('schreibt deutschen Text mit der Nummer im Titel (§2, §15)', async () => {
    const number = await raise('Darf Vorschicht die Abhängigkeit „undici" ergänzen?');
    await service.push();

    const sent = notifier.sent[0];
    if (!sent) throw new Error('nichts versendet');
    expect(sent.topic).toBe('inbox');
    expect(sent.title).toBe(`Vorschicht: Entscheidung #${number} wartet`);
    expect(sent.message).toContain('Darf Vorschicht die Abhängigkeit');
    expect(sent.message).toContain('Frage aus einer Sitzung');
    expect(sent.message).toContain('2 vorbereitete Optionen');
  });

  it('meldet mehrere offene Einträge in einem Durchlauf und danach keinen mehr', async () => {
    const first = await raise('Frage eins — undici?');
    const second = await raise('Frage zwei — auf dev schreiben?');

    expect((await service.push()).pushed).toEqual([first, second]);

    const third = await raise('Frage drei — Zweig umbenennen?');
    expect((await service.push()).pushed).toEqual([third]);
    expect(await countPushed()).toBe(3);
  });
});
