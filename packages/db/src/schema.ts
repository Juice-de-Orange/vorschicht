/**
 * Drizzle schema — the typed query surface over the SQL in `migrations/`.
 *
 * The SQL files are authoritative (they carry roles, grants and guard triggers
 * that no generator produces). This file mirrors them for type safety, and
 * `schema.itest.ts` asserts the two have not drifted apart by querying the
 * live catalog. Mirror-by-hand plus a test that fails on drift beats
 * generate-and-hope, because the interesting part of this schema is precisely
 * the part a generator would omit.
 */
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  index,
  inet,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';

/** Onboarded projects. Mutable configuration (§5); changes go to `auditLog`. */
export const projects = pgTable('projects', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  rootPath: text('root_path').notNull(),
  repoUrl: text('repo_url'),
  /** Reference into the secret regime — never the token itself (§19, A20). */
  gitAccessRef: text('git_access_ref'),
  gateConfig: jsonb('gate_config').notNull().default({}),
  deployConfig: jsonb('deploy_config').notNull().default({ method: 'none' }),
  claimGranularity: text('claim_granularity').notNull().default('file'),
  /** Vorschicht itself; self-deploy always needs the operator's approval (§12, A12). */
  selfManaged: boolean('self_managed').notNull().default(false),
  /** A41: analysis only — no worktree, no branch, no task. Never written to. */
  readOnly: boolean('read_only').notNull().default(false),
  /** §10: what task branches are cut from. Not always `main` (A41). */
  defaultBranch: text('default_branch').notNull().default('main'),
  active: boolean('active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The system's source of truth (§18). Append-only, enforced by the
 * `event_log_append_only` trigger — inserts only, forever.
 */
export const eventLog = pgTable(
  'event_log',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind').notNull(),
    projectId: uuid('project_id'),
    taskId: uuid('task_id'),
    runId: uuid('run_id'),
    deployId: uuid('deploy_id'),
    actor: text('actor').notNull(),
    payload: jsonb('payload').notNull().default({}),
  },
  (t) => [
    index('event_log_occurred_at_idx').on(sql`${t.occurredAt} DESC`),
    index('event_log_kind_idx').on(t.kind, sql`${t.occurredAt} DESC`),
  ],
);

/** Every dashboard action and config change (§19). Append-only. */
export const auditLog = pgTable(
  'audit_log',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    actor: text('actor').notNull(),
    action: text('action').notNull(),
    subject: text('subject'),
    before: jsonb('before'),
    after: jsonb('after'),
    ip: inet('ip'),
    userAgent: text('user_agent'),
  },
  (t) => [index('audit_log_occurred_at_idx').on(sql`${t.occurredAt} DESC`)],
);

/**
 * The task lifecycle log (§5, §9). Append-only, and additionally guarded by
 * `task_events_lifecycle`, which refuses an illegal transition, a stale `seq`
 * and a resume that skips the §7.2 integrity re-check.
 *
 * There is deliberately no `tasks` table here: `tasks` is a view over this log
 * (migration 0006), for the same reason `agent_runs` is.
 */
export const taskEvents = pgTable(
  'task_events',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey().generatedAlwaysAsIdentity(),
    taskId: uuid('task_id').notNull(),
    /** Gap-free per task; doubles as the optimistic-concurrency token. */
    seq: integer('seq').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    kind: text('kind').notNull(),
    projectId: uuid('project_id').notNull(),
    state: text('state').notNull(),
    priority: text('priority').notNull(),
    /** Where a suspended task returns to; null in every other state (§7.3). */
    resumeState: text('resume_state'),
    actor: text('actor').notNull(),
    payload: jsonb('payload').notNull().default({}),
  },
  (t) => [
    unique('task_events_task_id_seq_key').on(t.taskId, t.seq),
    index('task_events_task_idx').on(t.taskId, t.seq),
    index('task_events_occurred_at_idx').on(sql`${t.occurredAt} DESC`),
    index('task_events_project_idx').on(t.projectId, sql`${t.occurredAt} DESC`),
  ],
);

/** The §9 transition map as data. Mirrors `TASK_TRANSITIONS` in `shared`. */
export const taskTransitions = pgTable(
  'task_transitions',
  {
    stateFrom: text('state_from').notNull(),
    stateTo: text('state_to').notNull(),
  },
  (t) => [primaryKey({ columns: [t.stateFrom, t.stateTo] })],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
export type EventLogRow = typeof eventLog.$inferSelect;
export type NewEvent = typeof eventLog.$inferInsert;
export type AuditLogRow = typeof auditLog.$inferSelect;
export type NewAuditEntry = typeof auditLog.$inferInsert;
export type TaskEventRow = typeof taskEvents.$inferSelect;
export type NewTaskEvent = typeof taskEvents.$inferInsert;
