/**
 * The runner against the **real** pinned CLI. Costs subscription budget.
 *
 * Skipped unless `VORSCHICHT_REAL_BACKEND=1`; run it with
 * `pnpm check:runner`. Everything else about the runner is proven against the
 * `fake` backend (A37) and costs nothing — this file exists for the handful of
 * claims a fake cannot settle, because they are claims about the vendor:
 *
 *  1. **The transcript path.** `HeadlessRunHandle.transcriptPath()` derives
 *     `<config dir>/projects/<slug>/<session id>.jsonl` from a slug rule we
 *     inferred by looking at a directory. §6.2 requires the copy and §18 keeps
 *     it for a year; if the rule is wrong, every run silently archives nothing
 *     and the traceability chain of principle 4 ends one link early. Nothing
 *     else in the suite can catch that.
 *  2. **The argument vector is accepted.** `gate:cli-contract` proves each flag
 *     parses in isolation; this proves the combination the runner actually
 *     builds — role settings, inline `--json-schema`, tool whitelist, empty
 *     `--setting-sources` — starts a session that works.
 *  3. **The result satisfies the role contract when a real model produces it.**
 *     A schema the CLI accepts and zod also accepts is one thing; a schema a
 *     model can *fill* is another.
 *
 * The three previous iterations each found a severe defect exactly at this
 * boundary — the `--json-schema` path, the session that never ended, the
 * `tool_use` events that never fired — and every one of them was invisible to a
 * scripted stand-in. That is the argument for spending a few cents here.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import type postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HeadlessBackend } from './backend/headless.js';
import { EventLog } from './event-log.js';
import { AGENT_PROFILES } from './profiles/index.js';
import { ProjectService } from './project-service.js';
import { writeRoleSettings } from './role-settings.js';
import { AgentRunner } from './runner.js';
import { TaskService } from './task-service.js';

const enabled = process.env.VORSCHICHT_REAL_BACKEND === '1' && !!process.env.TEST_DATABASE_URL;

/** The compiled containment hook — the same file the daemon points sessions at. */
const HOOK_ENTRY = join(process.cwd(), 'packages/core/dist/hook-entry.js');

describe.skipIf(!enabled)('AgentRunner gegen die echte CLI', () => {
  let sql: postgres.Sql;
  let database: TestDatabase;
  let scratch: string;
  let worktree: string;
  let projectId: string;

  beforeAll(async () => {
    database = await createTestDatabase('runner_real');
    sql = createSql({ url: database.url, max: 2 });
    scratch = await mkdtemp(join(tmpdir(), 'vs-runner-real-'));
    worktree = join(scratch, 'worktree');
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, 'README.md'), '# Sandkasten\n');
    await writeRoleSettings(join(scratch, 'claude'), { hookEntry: HOOK_ENTRY });
    projectId = (
      await new ProjectService(sql).create({
        slug: 'runner-real',
        name: 'Echtlauf',
        rootPath: worktree,
      })
    ).id;
  }, 60_000);

  afterAll(async () => {
    await sql?.end();
    await database?.drop();
    await rm(scratch, { recursive: true, force: true });
  });

  it(
    'führt eine echte Sitzung aus, archiviert ihr Protokoll und erfüllt den Vertrag',
    async () => {
      const eventLog = new EventLog(sql);
      const tasks = new TaskService({ sql, eventLog });
      const task = await tasks.create({
        projectId,
        title: 'Eine Datei anlegen',
        description: 'Lege hallo.txt mit dem Wort "hallo" an.',
        acceptanceCriteria: ['hallo.txt existiert und enthält "hallo".'],
      });

      const warnings: string[] = [];
      const runner = new AgentRunner({
        sql,
        eventLog,
        backend: new HeadlessBackend({ onWarning: (m) => warnings.push(m) }),
        paths: {
          roleSettingsDir: join(scratch, 'claude'),
          runsRoot: join(scratch, 'runs'),
          transcriptsRoot: join(scratch, 'transcripts'),
          // No MCP: this run is about the CLI surface, and a server would add a
          // second thing that can fail to a test with one question.
          mcpServerEntry: null,
        },
        // Economy tier and two turns: the cheapest shape that still exercises a
        // tool call, a hook decision and a structured result.
        modelPolicy: { overrides: { coder: 'economy' } },
        onWarning: (m) => warnings.push(m),
      });

      const outcome = await runner.run({
        taskId: task.id,
        projectId,
        profile: AGENT_PROFILES.coder,
        prompt:
          'Create a file named hallo.txt in the current directory containing exactly ' +
          'the word "hallo". Then finish. Do not do anything else.',
        cwd: worktree,
        containment: { writeRoot: worktree, claims: ['**'], readOnlyProject: false },
        capsCeiling: { maxTurns: 8, maxBudgetUsd: 1, wallClockMs: 4 * 60_000 },
      });

      expect(outcome.status, `warnings: ${warnings.join(' | ')}`).toBe('ok');
      if (outcome.status !== 'ok') return;
      expect(outcome.result.status).toBe('done');
      expect(await readFile(join(worktree, 'hallo.txt'), 'utf8')).toMatch(/hallo/);

      // (1) The claim this file exists for: the transcript was found where the
      // backend expected it, and copied where §6.2 asks.
      expect(outcome.run.transcriptPath).toBeTruthy();
      const archived = await readFile(outcome.run.transcriptPath ?? '', 'utf8');
      expect(archived.split('\n').filter(Boolean).length).toBeGreaterThan(1);
      expect(archived).toContain(outcome.run.sessionId ?? 'keine-sitzung');

      // Containment was live and it checked the write (§6.6). This is the
      // comparison that read a constant zero until `tool_use` was fixed.
      expect(outcome.run.hookEvents).toBeGreaterThan(0);
      expect(outcome.run.toolUses).toBeGreaterThan(0);

      const [row] = await sql<
        Array<{
          session_id: string;
          is_finished: boolean;
          model: string;
          cost_usd: string | null;
          cache_read_tokens: string | null;
          by_model: Record<string, number> | null;
          spent_at: Date | null;
        }>
      >`
        SELECT session_id, is_finished, model, cost_usd, cache_read_tokens, by_model, spent_at
        FROM agent_runs WHERE run_id = ${outcome.run.runId}
      `;
      expect(row?.is_finished).toBe(true);
      expect(row?.model).toBe('haiku');
      expect(row?.session_id).toBe(outcome.run.sessionId);

      /**
       * (2) What §7.1's estimating meter actually meters on (A6, A60).
       *
       * Three separate claims, none of which a stand-in can settle:
       *   · `total_cost_usd` is populated under subscription auth — nothing is
       *     billed, but the figure exists, and the whole estimate rests on it;
       *   · `cache_read_input_tokens` dwarfs `input_tokens`, which is why the
       *     estimate is *not* built on the narrow pair (measured elsewhere at
       *     200 against 19.2 million — here, on a one-turn session, merely far
       *     larger);
       *   · both reach `agent_runs`, whose `cost_usd` column was read by the
       *     view from migration 0003 and written by nobody until 0014.
       */
      expect(outcome.run.costUsd).toBeGreaterThan(0);
      expect(row?.cost_usd).not.toBeNull();
      expect(Number(row?.cost_usd)).toBeCloseTo(outcome.run.costUsd, 6);
      expect(row?.spent_at).not.toBeNull();

      expect(outcome.run.cacheReadTokens).toBeGreaterThan(outcome.run.tokensIn);
      expect(Number(row?.cache_read_tokens)).toBe(outcome.run.cacheReadTokens);

      // Keyed by canonical model class — what a per-model weekly cap is about.
      expect(Object.keys(row?.by_model ?? {}).length).toBeGreaterThan(0);

      /**
       * (3) The window boundary, when the CLI chose to send one.
       *
       * `rate_limit_event` is pushed rather than requested and does not arrive
       * on every session, so its *presence* is not asserted — an assertion that
       * passes for the wrong reason is worse than none. What is asserted is
       * that anything recorded is well-formed and in the future, because an
       * anchor in the past would move a window start backwards and silently
       * drop spend that still counts.
       */
      const anchors = await sql<Array<{ window_kind: string; resets_at: Date; status: string }>>`
        SELECT window_kind, resets_at, status FROM usage_window_anchors
        WHERE run_id = ${outcome.run.runId}
      `;
      for (const anchor of anchors) {
        expect(['five_hour', 'seven_day']).toContain(anchor.window_kind);
        expect(anchor.resets_at.getTime()).toBeGreaterThan(Date.now());
        expect(anchor.status).not.toBe('');
      }
      warnings.push(`Fenstergrenzen in dieser Sitzung: ${anchors.length}`);
    },
    5 * 60_000,
  );
});
