/**
 * Integration tests for the Phase 1 event tables (migration 0003).
 *
 * The point of interest is `agent_runs`: it is a view, not a table, so these
 * tests are really asking "can a run be reconstructed from nothing but the
 * events it emitted?" — which is the same question the chaos test asks after a
 * SIGKILL, only cheaper to run.
 */
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSql } from './client.js';
import { migrate } from './migrate.js';

const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)('Läufe und Budget (0003)', () => {
  let sql: postgres.Sql;
  const runId = '11111111-2222-3333-4444-555555555555';

  beforeAll(async () => {
    sql = createSql({ url: url as string, max: 1 });
    await migrate(sql);
  });

  afterAll(async () => {
    await sql?.end();
  });

  describe('agent_runs als abgeleitete Sicht', () => {
    it('rekonstruiert einen Lauf allein aus seinen Ereignissen', async () => {
      const events: Array<[number, string, Record<string, unknown>]> = [
        [
          0,
          'created',
          {
            role: 'planner',
            model: 'opus',
            backend: 'headless',
            cwd: '/projects/sandbox',
            sessionId: 'sess-abc',
            taskId: '99999999-8888-7777-6666-555555555555',
          },
        ],
        [1, 'started', { pid: 4242, transcriptPath: '/data/transcripts/sess-abc.jsonl' }],
        [2, 'tool_use', { tool: 'Read' }],
        [3, 'hook_event', { hook: 'PreToolUse', decision: 'allow' }],
        [4, 'result', { tokensIn: 1200, tokensOut: 340, costUsd: 0.12, raw: { status: 'done' } }],
        [5, 'terminated', { reason: 'completed', exitCode: 0 }],
      ];
      for (const [seq, kind, payload] of events) {
        await sql`
          INSERT INTO agent_run_events (run_id, seq, kind, payload)
          VALUES (${runId}, ${seq}, ${kind}, ${sql.json(payload as postgres.JSONValue)})
        `;
      }

      const [run] = await sql<
        Array<{
          role: string;
          model: string;
          cwd: string;
          session_id: string;
          terminal_reason: string;
          exit_code: number;
          tokens_in: string;
          tokens_out: string;
          transcript_path: string;
          hook_events: string;
          tool_uses: string;
          is_finished: boolean;
        }>
      >`SELECT * FROM agent_runs WHERE run_id = ${runId}`;

      expect(run?.role).toBe('planner');
      expect(run?.model).toBe('opus');
      // §6.2: resume is scoped to the directory the session started in, so the
      // (session_id, cwd) pair has to survive a restart.
      expect(run?.session_id).toBe('sess-abc');
      expect(run?.cwd).toBe('/projects/sandbox');
      expect(run?.transcript_path).toBe('/data/transcripts/sess-abc.jsonl');
      expect(run?.terminal_reason).toBe('completed');
      expect(run?.exit_code).toBe(0);
      expect(Number(run?.tokens_in)).toBe(1200);
      expect(Number(run?.tokens_out)).toBe(340);
      expect(Number(run?.hook_events)).toBe(1);
      expect(Number(run?.tool_uses)).toBe(1);
      expect(run?.is_finished).toBe(true);
    });

    // A run killed mid-flight leaves exactly the events it managed to emit.
    // The reconciler recognises it by the absence of `terminated`, which is
    // what §7.2 turns into an `interrupted` task and a mandatory re-check.
    it('erkennt einen abgebrochenen Lauf am fehlenden terminated-Ereignis', async () => {
      const crashed = '22222222-3333-4444-5555-666666666666';
      await sql`
        INSERT INTO agent_run_events (run_id, seq, kind, payload)
        VALUES (${crashed}, 0, 'created', ${sql.json({ role: 'coder', cwd: '/projects/x' })}),
               (${crashed}, 1, 'started', ${sql.json({ pid: 77 })})
      `;
      const [run] = await sql<Array<{ is_finished: boolean; terminal_reason: string | null }>>`
        SELECT is_finished, terminal_reason FROM agent_runs WHERE run_id = ${crashed}
      `;
      expect(run?.is_finished).toBe(false);
      expect(run?.terminal_reason).toBeNull();
    });

    it('erzwingt eindeutige Reihenfolge je Lauf', async () => {
      await expect(
        sql`INSERT INTO agent_run_events (run_id, seq, kind) VALUES (${runId}, 0, 'started')`,
      ).rejects.toThrow(/duplicate key|unique/i);
    });

    it('weist unbekannte Ereignisarten ab', async () => {
      await expect(
        sql`INSERT INTO agent_run_events (run_id, seq, kind) VALUES (${runId}, 99, 'geplauder')`,
      ).rejects.toThrow(/agent_run_events_kind/);
    });
  });

  describe('Append-only auf den neuen Tabellen', () => {
    // Seeded first: a row-level trigger has nothing to fire on in an empty
    // table, so testing against one would prove nothing. That gap is what
    // TRUNCATE exploits — hence the separate statement-level guard below.
    beforeAll(async () => {
      await sql`INSERT INTO usage_samples (window_kind, used_percent, source)
                VALUES ('five_hour', 1, 'official')`;
      await sql`INSERT INTO guardian_events (state, reason)
                VALUES ('normal', ${sql.json({ kind: 'below_thresholds' })})`;
    });

    it.each([
      ['agent_run_events', 'kind'],
      ['usage_samples', 'window_kind'],
      ['guardian_events', 'state'],
    ])('%s verweigert UPDATE und DELETE auch dem Eigentümer', async (table, column) => {
      await expect(sql.unsafe(`UPDATE ${table} SET ${column} = ${column}`)).rejects.toThrow(
        /append-only/i,
      );
      await expect(sql.unsafe(`DELETE FROM ${table}`)).rejects.toThrow(/append-only/i);
    });

    // TRUNCATE fires no row-level triggers at all, so the guards from 0001-0003
    // did not cover it. Migration 0004 adds a statement-level trigger; without
    // it, one statement could empty the source of truth in silence.
    it.each([
      'event_log',
      'audit_log',
      'auth_events',
      'agent_run_events',
      'usage_samples',
      'guardian_events',
    ])('%s verweigert TRUNCATE auch dem Eigentümer', async (table) => {
      await expect(sql.unsafe(`TRUNCATE ${table}`)).rejects.toThrow(/append-only/i);
    });
  });

  describe('usage_samples', () => {
    it('nimmt eine Probe samt rohem Payload auf', async () => {
      const raw = { five_hour: { utilization: 2 }, iguana_necktie: null };
      await sql`
        INSERT INTO usage_samples (window_kind, used_percent, source, raw)
        VALUES ('five_hour', 2.0, 'official', ${sql.json(raw)})
      `;
      const [row] = await sql<Array<{ raw: Record<string, unknown> }>>`
        SELECT raw FROM usage_samples ORDER BY id DESC LIMIT 1
      `;
      // ADR 0001: the verbatim payload is what makes a wrongly guessed scale
      // recoverable after the fact.
      expect(row?.raw).toHaveProperty('iguana_necktie');
    });

    it('lässt keine Prozentwerte außerhalb 0–100 zu', async () => {
      for (const bad of [-1, 101]) {
        await expect(
          sql`INSERT INTO usage_samples (window_kind, used_percent, source)
              VALUES ('five_hour', ${bad}, 'official')`,
        ).rejects.toThrow(/usage_samples_percent_range/);
      }
    });

    it('kennt nur die beiden dokumentierten Quellen', async () => {
      await expect(
        sql`INSERT INTO usage_samples (window_kind, used_percent, source)
            VALUES ('five_hour', 1, 'geraten')`,
      ).rejects.toThrow(/usage_samples_source/);
    });
  });

  describe('guardian_events', () => {
    it('nimmt nur die drei spezifizierten Zustände an', async () => {
      await sql`
        INSERT INTO guardian_events (state, reason, governing_window)
        VALUES ('wrap_up', ${sql.json({ kind: 'threshold', usedPercent: 86 })}, 'five_hour')
      `;
      await expect(
        sql`INSERT INTO guardian_events (state, reason) VALUES ('gemuetlich', ${sql.json({})})`,
      ).rejects.toThrow(/guardian_events_state/);
    });
  });
});
