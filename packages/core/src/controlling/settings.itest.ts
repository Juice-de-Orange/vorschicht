/**
 * §17.8's two switches against a real Postgres (migration 0022), and the one
 * assertion the Phase 7 gate turns on: that moving the switch on the page
 * reaches the guardian in the daemon.
 *
 * Five of the things this suite can fail are properties of the database or of
 * the wiring rather than of a class, which is why it is an integration test.
 *
 *   1. **§19's row and the change are one act.** A `config` row keeps no
 *      history of its own, so a trail write that failed after the setting
 *      changed would leave the studio paused with nothing recording who
 *      stopped it. Asserted by making the trail write fail *for real* — the
 *      audit table's own `NOT NULL` on `actor`, reached by going around the
 *      service — and then reading the setting back. A sequential implementation
 *      passes every other case in this file.
 *
 *   2. **A missing row is the default**, so the first read of a fresh database
 *      is the interesting one and runs before anything is written.
 *
 *   3. **The two unreadable-value fallbacks go in opposite directions**, which
 *      is the decision `settings.ts` argues for and the one thing about this
 *      module a reader is most likely to "fix" into consistency. Both rows are
 *      written by hand into a state the service cannot produce — which is the
 *      state a human editing the table produces.
 *
 *   4. **The actor is the session's**, not `'system'` (A75.3). Asserted as the
 *      value that was passed, because the failure it guards against writes a
 *      perfectly well-formed row.
 *
 *   5. **The pause crosses the process boundary.** `GuardianService` lives in
 *      the daemon and the page lives in the API; the switch is a `config` row
 *      and nothing else. So the last block drives a real `GuardianService`
 *      against this table and asserts §7.2's consequences — no new work, the
 *      running sessions asked to stop, and for the hard position the kill after
 *      the grace. Without it this module would be a pair of well-tested writers
 *      that stop nothing.
 */
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import { PAUSE_KEY, SPARBETRIEB_KEY } from '@vorschicht/shared/controlling';
import type postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { StoppableRun } from '../active-runs.js';
import { EventLog } from '../event-log.js';
import { GuardianService } from '../guardian-service.js';
import { UsageMeter } from '../usage-meter.js';
import {
  ControllingSettings,
  ControllingSettingsError,
  PAUSE_AUDIT_ACTION,
  SPARBETRIEB_AUDIT_ACTION,
} from './settings.js';

const url = process.env.TEST_DATABASE_URL;

/** What `sessionActor` produces for a real browser session (A75.3). */
const MAX = 'dashboard:cred-abc';

interface AuditRow {
  actor: string;
  action: string;
  subject: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

describe.skipIf(!url)('Controlling-Einstellungen (§17.8, A26, A22)', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let warnings: string[];
  let settings: ControllingSettings;

  beforeAll(async () => {
    database = await createTestDatabase('controlling');
    sql = createSql({ url: database.url, max: 4 });
  });

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
  });

  beforeEach(async () => {
    warnings = [];
    settings = new ControllingSettings(sql, (message) => warnings.push(message));
    await sql`DELETE FROM config WHERE key IN (${PAUSE_KEY}, ${SPARBETRIEB_KEY})`;
  });

  async function auditRows(action: string): Promise<AuditRow[]> {
    return await sql<AuditRow[]>`
      SELECT actor, action, subject, before, after
      FROM audit_log WHERE action = ${action} ORDER BY id
    `;
  }

  describe('A26 — die Pause', () => {
    it('läuft, solange niemand etwas gesetzt hat', async () => {
      // Decision 2 of 0022: nothing is seeded, so "the operator hat nie etwas angefasst"
      // ist ein echter Zustand und nicht von „zurückgestellt" zu unterscheiden.
      expect(await settings.pause()).toEqual({ wert: 'normal', unlesbar: false });
      expect(await settings.manualPause()).toEqual({ active: false, hard: false });
    });

    it('speichert jede der drei Stellungen und gibt sie als Wächterpaar zurück', async () => {
      await settings.setPause('pause', MAX);
      expect(await settings.manualPause()).toEqual({ active: true, hard: false });

      await settings.setPause('hart', MAX);
      expect(await settings.manualPause()).toEqual({ active: true, hard: true });

      await settings.setPause('normal', MAX);
      expect(await settings.manualPause()).toEqual({ active: false, hard: false });
    });

    it('trägt jede Betätigung mit der Sitzung ins Prüfprotokoll ein (§19, A75.3)', async () => {
      const vorher = (await auditRows(PAUSE_AUDIT_ACTION)).length;
      await settings.setPause('hart', MAX);
      const rows = (await auditRows(PAUSE_AUDIT_ACTION)).slice(vorher);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.actor).toBe(MAX);
      expect(rows[0]?.subject).toBe(PAUSE_KEY);
      // Beide Seiten, weil „von wo nach wo" die Frage ist, für die das
      // Protokoll geführt wird — „nach hart" allein sagt nicht, ob das
      // Studio vorher lief.
      expect(rows[0]?.before).toEqual({ modus: 'normal' });
      expect(rows[0]?.after).toEqual({ modus: 'hart' });
    });

    it('protokolliert auch eine Betätigung, die nichts ändert', async () => {
      // §19 unterscheidet nicht: die Stellung erneut abzuschicken ist eine
      // Handlung im Dashboard. Sie zu unterdrücken hieße, das Protokoll
      // antwortet „der Betreiber hat es nie versucht" auf einen Versuch, den es gab.
      const vorher = (await auditRows(PAUSE_AUDIT_ACTION)).length;
      await settings.setPause('normal', MAX);
      const rows = (await auditRows(PAUSE_AUDIT_ACTION)).slice(vorher);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.before).toEqual({ modus: 'normal' });
      expect(rows[0]?.after).toEqual({ modus: 'normal' });
    });

    it('hält bei einem unlesbaren Wert an, statt weiterzulaufen', async () => {
      await sql`
        INSERT INTO config (key, value) VALUES (${PAUSE_KEY}, ${sql.json('halb' as never)})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `;
      const gelesen = await settings.pause();
      // Die Kernentscheidung: nicht die Voreinstellung. Eine unlesbare
      // Anweisung ist keine Erlaubnis weiterzuarbeiten.
      expect(gelesen).toEqual({ wert: 'pause', unlesbar: true });
      expect(await settings.manualPause()).toEqual({ active: true, hard: false });
      expect(warnings.join(' ')).toContain(PAUSE_KEY);
      expect(warnings.join(' ')).toContain('halb');
    });

    it('verweigert eine Betätigung ohne Urheber, und ändert dabei nichts', async () => {
      // `audit_log` ist append-only, also kann kein `beforeEach` es leeren und
      // eine absolute Zahl wäre eine Aussage darüber, welche Fälle vorher
      // liefen. Gezählt wird deshalb die Differenz — dieselbe Konvention, die
      // die Browserstrecken dieses Repositories aus demselben Grund führen.
      const vorher = (await auditRows(PAUSE_AUDIT_ACTION)).length;
      await expect(settings.setPause('hart', '  ')).rejects.toBeInstanceOf(
        ControllingSettingsError,
      );
      expect((await settings.pause()).wert).toBe('normal');
      expect(await auditRows(PAUSE_AUDIT_ACTION)).toHaveLength(vorher);
    });

    it('lässt die Einstellung unverändert, wenn die Protokollzeile scheitert', async () => {
      // Decision 1, und der Grund, warum `setPause` überhaupt eine Transaktion
      // öffnet. Erzwungen über die echte `NOT NULL`-Bedingung auf `actor`,
      // nicht über einen Stub: eine sequenzielle Umsetzung besteht jeden
      // anderen Fall dieser Datei.
      await settings.setPause('pause', MAX);
      await expect(
        sql.begin(async (tx) => {
          await tx`
            INSERT INTO config (key, value, updated_at) VALUES (${PAUSE_KEY}, ${tx.json(
              'hart' as never,
            )}, now())
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()
          `;
          await tx`
            INSERT INTO audit_log (actor, action, subject, before, after)
            VALUES (${null as unknown as string}, ${PAUSE_AUDIT_ACTION}, ${PAUSE_KEY}, NULL, NULL)
          `;
        }),
      ).rejects.toThrow();
      expect((await settings.pause()).wert).toBe('pause');
    });
  });

  describe('A22 — der Sparbetrieb', () => {
    it('ist aus, solange niemand etwas gesetzt hat', async () => {
      expect(await settings.sparbetrieb()).toEqual({ wert: false, unlesbar: false });
    });

    it('speichert beide Stellungen und protokolliert sie mit der Sitzung', async () => {
      const vorher = (await auditRows(SPARBETRIEB_AUDIT_ACTION)).length;
      expect(await settings.setSparbetrieb(true, MAX)).toEqual({ before: false, after: true });
      expect((await settings.sparbetrieb()).wert).toBe(true);
      expect(await settings.setSparbetrieb(false, MAX)).toEqual({ before: true, after: false });

      const rows = (await auditRows(SPARBETRIEB_AUDIT_ACTION)).slice(vorher);
      expect(rows).toHaveLength(2);
      expect(rows.map((row) => row.actor)).toEqual([MAX, MAX]);
      expect(rows[0]?.after).toEqual({ aktiv: true });
      expect(rows[1]?.after).toEqual({ aktiv: false });
    });

    it('fällt bei einem unlesbaren Wert auf „aus" zurück — anders als die Pause', async () => {
      // Die Asymmetrie ist die Entscheidung. Der Wächter (§7.2) begrenzt das
      // Budget unabhängig von diesem Schalter, also gefährdet ein kaputter
      // Wert hier kein Budget — er kostet Qualität, und §1 stellt Qualität
      // voran. Bei der Pause gibt es kein zweites Gerät dahinter.
      await sql`
        INSERT INTO config (key, value) VALUES (${SPARBETRIEB_KEY}, ${sql.json('ja' as never)})
        ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
      `;
      expect(await settings.sparbetrieb()).toEqual({ wert: false, unlesbar: true });
      expect(warnings.join(' ')).toContain(SPARBETRIEB_KEY);
    });

    it('verweigert eine Betätigung ohne Urheber', async () => {
      await expect(settings.setSparbetrieb(true, '')).rejects.toBeInstanceOf(
        ControllingSettingsError,
      );
      expect((await settings.sparbetrieb()).wert).toBe(false);
    });

    it('teilt sich keinen Schlüssel mit der Pause', async () => {
      // Zwei Schalter, eine Tabelle: derselbe Schlüssel wäre ein Sparbetrieb,
      // der die Pause überschreibt, und die Anzeige sähe in beiden Fällen
      // plausibel aus.
      await settings.setPause('hart', MAX);
      await settings.setSparbetrieb(true, MAX);
      expect((await settings.pause()).wert).toBe('hart');
      expect((await settings.sparbetrieb()).wert).toBe(true);
      expect(PAUSE_KEY).not.toBe(SPARBETRIEB_KEY);
    });
  });

  describe('§7.2 — die gesetzte Pause erreicht den Wächter im Daemon', () => {
    interface Stopped {
      interrupted: string[];
      killed: number;
    }

    /** Eine gesunde Messung, damit „normal" überhaupt erreichbar ist. */
    function usage(percent: number) {
      return {
        rate_limits_available: true,
        rate_limits: {
          limits: [
            { kind: 'session', percent, resets_at: null, scope: null },
            { kind: 'weekly_all', percent, resets_at: null, scope: null },
          ],
        },
      };
    }

    function guardianFor(stopped: Stopped, graceMs = 5) {
      const eventLog = new EventLog(sql);
      const run: StoppableRun = {
        // Eine echte uuid, weil `event_log.run_id` eine ist: nach der Frist
        // schreibt der Wächter `run.interrupted` mit dieser Kennung, und eine
        // Attrappe, die dort nicht durchkommt, prüft etwas anderes als das,
        // wofür sie steht (A37). Der erste Anlauf hier hatte „run-controlling"
        // stehen — der Kill wurde gezählt, die Zeile danach flog asynchron.
        runId: '22222222-2222-4222-8222-222222222222',
        interrupt: async (reason: string) => {
          stopped.interrupted.push(reason);
        },
        kill: async () => {
          stopped.killed += 1;
        },
      } as unknown as StoppableRun;
      const queue = {
        isPaused: false,
        pause: async () => {
          queue.isPaused = true;
        },
        resume: async () => {
          queue.isPaused = false;
        },
      };
      const meter = new UsageMeter({ sql, eventLog, now: () => clock });
      const guardian = new GuardianService({
        sql,
        meter,
        eventLog,
        queue,
        activeRuns: () => [run],
        // Der ganze Punkt: der Wächter liest die Stellung aus `config`,
        // nicht aus einem Feld im eigenen Prozess.
        manualPause: () => settings.manualPause(),
        now: () => clock,
        graceMs,
      });
      return { guardian, queue, meter };
    }

    let clock = Date.parse('2026-08-01T06:00:00Z');

    beforeEach(async () => {
      // **Nicht löschen.** `guardian_events` und `usage_samples` sind
      // append-only (§5/§18) und die Datenbank weist ein DELETE zurück — was
      // der erste Anlauf dieser Datei gelernt hat, indem es rot wurde. Der
      // Zustand des Wächters ist absichtlich global (es gibt ein Budget), also
      // beginnt jeder Fall damit, eine saubere Grundlinie **anzuhängen**; aus
      // Sicht der Projektion ist genau das ein Fensterwechsel.
      clock += 6 * 60 * 60_000;
      await sql`
        INSERT INTO guardian_events (state, reason, latches)
        VALUES ('normal', ${sql.json({ kind: 'below_thresholds' })}, ${sql.json([])})
      `;
    });

    it('hält das Studio an, sobald die Stellung in config steht', async () => {
      const stopped: Stopped = { interrupted: [], killed: 0 };
      const { guardian, queue, meter } = guardianFor(stopped);
      // Ein gesundes Budget, damit dieser Fall etwas beweist. Ohne Messung
      // meldet der Wächter ohnehin `wrap_up` (`no_data`, §7.1 fail-closed) —
      // die Zusicherung wäre dann grün, egal ob der Schalter gelesen wird.
      await meter.ingestOfficial(usage(20));

      await settings.setPause('pause', MAX);
      const decision = await guardian.evaluate();

      expect(decision.state).toBe('wrap_up');
      expect(decision.reason).toEqual({ kind: 'manual_pause', hard: false });
      // §7.2s „no new tasks start" und §7.3s Schritt 1 — unterbrechen, nicht
      // töten: ein Kill hier wäre der Stopp mitten im Schreiben, den §7.3
      // ausdrücklich verbietet.
      expect(queue.isPaused).toBe(true);
      expect(stopped.interrupted).toEqual(['guardian_wrap_up']);
      expect(stopped.killed).toBe(0);
    });

    it('unterscheidet die harte Pause von der weichen — sie tötet nach der Frist', async () => {
      const stopped: Stopped = { interrupted: [], killed: 0 };
      const { guardian, meter } = guardianFor(stopped, 5);
      await meter.ingestOfficial(usage(20));

      await settings.setPause('hart', MAX);
      const decision = await guardian.evaluate();

      expect(decision.state).toBe('hard_stop');
      expect(decision.reason).toEqual({ kind: 'manual_pause', hard: true });
      expect(stopped.interrupted).toEqual(['guardian_hard_stop']);
      await new Promise((resolve) => setTimeout(resolve, 40));
      // Die Zusicherung, die die beiden Stellungen trennt. Ohne sie wäre eine
      // harte Pause, die sich wie eine weiche verhält, von aussen unsichtbar:
      // beide melden „angehalten", und nur diese Zeile sagt, ob die 60
      // Sekunden aus §7.2 überhaupt existieren.
      expect(stopped.killed).toBe(1);
    });

    it('lässt das Studio wieder laufen, wenn der Betreiber zurückstellt', async () => {
      const stopped: Stopped = { interrupted: [], killed: 0 };
      const { guardian, queue, meter } = guardianFor(stopped);
      await meter.ingestOfficial(usage(20));

      await settings.setPause('pause', MAX);
      expect((await guardian.evaluate()).state).toBe('wrap_up');

      await settings.setPause('normal', MAX);
      const zurueck = await guardian.evaluate();
      // Kein Latch: A26s Pause ist keine Budgetschwelle, also gibt es nichts,
      // worauf ein Reset gewartet werden müsste. Wäre sie eine, käme das
      // Studio ohne einen Fensterwechsel nie zurück.
      expect(zurueck.state).toBe('normal');
      expect(queue.isPaused).toBe(false);
    });

    it('räumt auf, wenn die Stellung gar nicht gelesen werden kann', async () => {
      // Fail closed, und der Fall ist nicht theoretisch: er ist genau das,
      // was ein Ausfall der Einstellungsabfrage erzeugt. „Wir konnten nicht
      // herausfinden, ob der Betreiber uns angehalten hat" darf nicht heissen „der Betreiber hat
      // uns nicht angehalten".
      const stopped: Stopped = { interrupted: [], killed: 0 };
      const eventLog = new EventLog(sql);
      const meter = new UsageMeter({ sql, eventLog, now: () => clock });
      // Wieder ein gesundes Budget: sonst wäre `wrap_up` schon die Antwort auf
      // die fehlende Messung und dieser Fall bewiese nichts über den Schalter.
      await meter.ingestOfficial(usage(20));
      const guardian = new GuardianService({
        sql,
        meter,
        eventLog,
        queue: { isPaused: false, pause: async () => {}, resume: async () => {} },
        activeRuns: () => [],
        manualPause: async () => {
          throw new Error('config nicht erreichbar');
        },
        now: () => clock,
      });

      const decision = await guardian.evaluate();
      expect(decision.state).toBe('wrap_up');
      expect(decision.reason).toEqual({ kind: 'manual_pause', hard: false });
      const anomalies = await sql<{ payload: { kind: string } }[]>`
        SELECT payload FROM event_log WHERE kind = 'guardian.anomaly' ORDER BY id DESC LIMIT 1
      `;
      expect(anomalies[0]?.payload.kind).toBe('pause_unreadable');
      expect(stopped.killed).toBe(0);
    });
  });
});
