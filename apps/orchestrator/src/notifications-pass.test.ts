/**
 * The daemon's notification pass, driven with injected failures.
 *
 * No database: what is under test here is the *caller's* five properties, not
 * what either service does with Postgres — `escalation-push.itest.ts` and
 * `escalation-mail.itest.ts` own that half against a real one. Stubbing the two
 * services is therefore not a shortcut around the hard part, it is the only way
 * to reach a case like "the mail pass throws" at all.
 *
 * The load-bearing case is the transition one. A per-pass alert and a per-outage
 * alert are indistinguishable on a single failing pass, and only differ over
 * ten — which is why the count is asserted across ten rather than across two.
 */
import type { EscalationMailOutcome, EscalationPushOutcome } from '@vorschicht/core';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAIL_PASS_INTERVAL_MS,
  type NotificationsPassDeps,
  type NotificationsPassState,
  notifierTopics,
  runNotificationsPass,
} from './notifications-pass.js';

/** Everything the pass said out loud, in order, so silence is assertable. */
function recordingLogger() {
  const lines: Array<{ level: string; message: string }> = [];
  const at = (level: string) => (_obj: unknown, message?: string) => {
    lines.push({ level, message: message ?? '' });
  };
  return { lines, info: at('info'), warn: at('warn'), error: at('error') };
}

/** ntfy, as this module sees it: a thing that can also refuse. */
function recordingNotifier() {
  const sent: Array<{ topic: string; title: string }> = [];
  const notifier = {
    sent,
    refuse: false,
    send: async (notification: { topic: string; title: string }) => {
      if (notifier.refuse) return { ok: false as const, status: 503, error: 'ntfy antwortete 503' };
      sent.push({ topic: notification.topic, title: notification.title });
      return { ok: true as const, status: 200 };
    },
  };
  return notifier;
}

function pushOutcome(over: Partial<EscalationPushOutcome> = {}): EscalationPushOutcome {
  return { pushed: [], failures: [], ...over };
}

function mailOutcome(over: Partial<EscalationMailOutcome> = {}): EscalationMailOutcome {
  return { enabled: true, reminded: [], digest: null, failures: [], ...over };
}

describe('runNotificationsPass', () => {
  let clock = Date.parse('2026-08-02T09:00:00Z');
  let logger: ReturnType<typeof recordingLogger>;
  let notifier: ReturnType<typeof recordingNotifier>;
  let state: NotificationsPassState;

  beforeEach(() => {
    clock = Date.parse('2026-08-02T09:00:00Z');
    logger = recordingLogger();
    notifier = recordingNotifier();
    state = { nextMailAt: 0, mailFailing: false };
  });

  /** Deps with both halves stubbed; the clock is the suite's. */
  function deps(over: Partial<NotificationsPassDeps> = {}): NotificationsPassDeps {
    return {
      push: { push: async () => pushOutcome() },
      mail: { tick: async () => mailOutcome() },
      notifier,
      logger,
      now: () => clock,
      ...over,
    };
  }

  /** One pass, a minute later — the cadence the daemon actually produces. */
  async function pass(over: Partial<NotificationsPassDeps> = {}) {
    clock += MAIL_PASS_INTERVAL_MS;
    return runNotificationsPass(deps(over), state);
  }

  it('meldet einen erfolgreichen Durchlauf mit Zahlen und alarmiert dabei nicht', async () => {
    const result = await pass({
      push: { push: async () => pushOutcome({ pushed: [12, 13] }) },
      mail: { tick: async () => mailOutcome({ reminded: [7], digest: [7, 12, 13] }) },
    });

    expect(result.pushed).toEqual([12, 13]);
    expect(result.reminded).toEqual([7]);
    expect(result.digest).toEqual([7, 12, 13]);
    expect(result.failures).toEqual([]);
    expect(result.problems).toEqual([]);
    // Nichts ist kaputt, also geht auch nichts über ntfy raus: der Kanal aus
    // Eigenschaft 4 meldet Störungen, nicht Erfolge.
    expect(notifier.sent).toEqual([]);
    expect(logger.lines.map((line) => line.level)).toEqual(['info', 'info']);
  });

  it('sagt gar nichts, wenn SMTP nicht konfiguriert ist', async () => {
    const result = await pass({ mail: { tick: async () => mailOutcome({ enabled: false }) } });

    expect(result.mailRan).toBe(true);
    expect(result.mailEnabled).toBe(false);
    expect(result.alerted).toBeNull();
    // Entscheidung 3 aus `escalation-mail.ts`, eine Ebene höher: eine
    // Übersprungen-Zeile je Durchlauf ist dieselbe Flut wie eine Mail je
    // Durchlauf, nur im Protokoll.
    expect(logger.lines).toEqual([]);
    expect(notifier.sent).toEqual([]);
  });

  it('bricht den Durchlauf nicht ab, wenn der E-Mail-Teil wirft — und pusht trotzdem', async () => {
    const result = await pass({
      push: { push: async () => pushOutcome({ pushed: [4] }) },
      mail: {
        tick: async () => {
          throw new Error('Verbindung zur Datenbank verloren');
        },
      },
    });

    // Eigenschaft 1: `onReady` fängt nichts, und `main().catch()` beendet den
    // Prozess. Ein Wurf hier wäre ein Neustartkarussell unter compose.
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain('Verbindung zur Datenbank verloren');
    expect(logger.lines.at(-1)?.level).toBe('error');
    // Eigenschaft 2: der Push ist davon unberührt.
    expect(result.pushed).toEqual([4]);
  });

  it('bricht auch nicht ab, wenn der Push wirft — und schickt trotzdem die E-Mails', async () => {
    const result = await pass({
      push: {
        push: async () => {
          throw new Error('ntfy-Client kaputt');
        },
      },
      mail: { tick: async () => mailOutcome({ digest: [9] }) },
    });

    expect(result.problems[0]).toContain('ntfy-Client kaputt');
    expect(result.pushed).toEqual([]);
    expect(result.digest).toEqual([9]);
  });

  it('alarmiert genau einmal beim Übergang in den Fehlerfall — über zehn Durchläufe', async () => {
    const failing = { tick: async () => mailOutcome({ failures: ['#3: ECONNREFUSED'] }) };

    for (let i = 0; i < 10; i += 1) await pass({ mail: failing });

    // Die eigentliche Zusicherung (A67.6): ein Kanal, der zehnmal dasselbe
    // meldet, ist ein Kanal, den man stummschaltet.
    expect(notifier.sent).toEqual([
      { topic: 'alerts', title: 'Vorschicht: E-Mail-Versand schlägt fehl' },
    ]);
    expect(state.mailFailing).toBe(true);
    // Auch das Protokoll wiederholt sich nicht.
    expect(logger.lines.filter((line) => line.level === 'warn')).toHaveLength(1);
  });

  it('meldet die Erholung, sobald ein Durchlauf wieder gelingt', async () => {
    await pass({ mail: { tick: async () => mailOutcome({ failures: ['#3: ECONNREFUSED'] }) } });
    const back = await pass({ mail: { tick: async () => mailOutcome({ reminded: [3] }) } });
    await pass({ mail: { tick: async () => mailOutcome() } });

    expect(back.alerted).toBe('recovery');
    expect(notifier.sent).toEqual([
      { topic: 'alerts', title: 'Vorschicht: E-Mail-Versand schlägt fehl' },
      { topic: 'info', title: 'Vorschicht: E-Mail-Versand läuft wieder' },
    ]);
    expect(state.mailFailing).toBe(false);
  });

  it('merkt sich einen von ntfy abgelehnten Alarm nicht und versucht ihn erneut', async () => {
    const failing = { tick: async () => mailOutcome({ failures: ['#3: ECONNREFUSED'] }) };

    notifier.refuse = true;
    const refused = await pass({ mail: failing });
    expect(refused.alerted).toBeNull();
    expect(state.mailFailing).toBe(false);

    notifier.refuse = false;
    const retried = await pass({ mail: failing });
    expect(retried.alerted).toBe('failure');
    expect(notifier.sent).toHaveLength(1);
  });

  it('hält den E-Mail-Teil bis zum Intervall zurück, den Push aber nie', async () => {
    let mailPasses = 0;
    let pushPasses = 0;
    const both = {
      push: async () => {
        pushPasses += 1;
        return pushOutcome();
      },
    };
    const mail = {
      tick: async () => {
        mailPasses += 1;
        return mailOutcome();
      },
    };

    // Erster Durchlauf: `nextMailAt` ist 0, also läuft beides.
    await runNotificationsPass(deps({ push: both, mail }), state);
    // Fünfzehn Sekunden später — ein Tick, kein Mail-Intervall.
    clock += 15_000;
    const held = await runNotificationsPass(deps({ push: both, mail }), state);
    expect(held.mailRan).toBe(false);
    expect(mailPasses).toBe(1);

    clock += MAIL_PASS_INTERVAL_MS;
    expect((await runNotificationsPass(deps({ push: both, mail }), state)).mailRan).toBe(true);
    expect(mailPasses).toBe(2);
    // §15 sagt „sofort": der Push kennt diese Kadenz nicht.
    expect(pushPasses).toBe(3);
  });

  it('meldet abgelehnte Pushes gesammelt, nicht je Eintrag', async () => {
    await pass({
      push: { push: async () => pushOutcome({ failures: ['#1: 503', '#2: 503', '#3: 503'] }) },
    });

    const warnings = logger.lines.filter((line) => line.level === 'warn');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain('3 Push(es)');
  });
});

describe('notifierTopics', () => {
  it('verdrahtet jede Variable auf ihr eigenes Thema (§16)', () => {
    // Drei gleich geformte Namen neben drei gleich geformten Feldern: genau
    // hier schickt ein Copy-and-paste jede Inbox-Karte auf den Alarmkanal.
    expect(
      notifierTopics({
        ntfyTopicInbox: 'v-inbox',
        ntfyTopicAlerts: 'v-alerts',
        ntfyTopicInfo: 'v-info',
      }),
    ).toEqual({ inbox: 'v-inbox', alerts: 'v-alerts', info: 'v-info' });
  });
});
