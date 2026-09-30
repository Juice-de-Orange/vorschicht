/**
 * The findings pipeline (§11, §22 Phase 3 step 4) — "finding → fix task → gate
 * re-run → only then merge."
 *
 * §11's sentence has three arrows and the studio already had the first and the
 * third: a gate goes red, §9 requeues the task, the next pass runs the gates
 * again. What it did not have is the middle one. A requeued task arrived at its
 * next Planner knowing only that *something* had failed — the gate output lived
 * in a `gate.finished` payload and in the prose of a note nothing read — so
 * every fix attempt began by re-deriving the failure it was created to fix.
 * That is a loop, but it is not a pipeline, and the difference is the whole of
 * this module.
 *
 * Four properties are the design.
 *
 *  1. **A finding is a record, not a message.** §5 asks for the entity and
 *     migration 0015 provides it: `gate_runs` holds every execution with its
 *     full output, `findings` is the red steps of those runs. Until now the
 *     only durable form of a gate failure was a German sentence inside a JSON
 *     payload, which can be read by a human and by nothing else. "Which
 *     findings does this project owe?" was unanswerable.
 *
 *  2. **Nothing here resolves a finding.** There is no `resolve()` and no
 *     status write, because §11 gives a finding exactly one way to stop
 *     blocking: the work goes back through the gates and comes out green. The
 *     view derives that from a *later gate run in which the same gate reported
 *     green*, so "resolved" is a claim about evidence rather than about
 *     somebody having called a method. A method would also be the place where a
 *     future convenience quietly closes a finding without a green run behind
 *     it, which is the warning mode §11 does not have.
 *
 *  3. **The fix task for a gate finding is the task itself, requeued.** §9 says
 *     so and §10 makes any other answer impossible: a separate fix task would
 *     need the same paths, the original task still holds those claims, and the
 *     two would serialise against each other forever. So this module does not
 *     create tasks — it briefs the one that already exists, and the linkage in
 *     the view records which task is carrying the fix and when nothing is.
 *
 *  4. **The briefing is written twice, on purpose.** `findingsNote` is German
 *     and lands in the timeline the operator reads (§2); `findingsBriefing` is English
 *     and goes into the next session's prompt. They are not translations of
 *     each other — one says "here is why this came back", the other says "fix
 *     exactly these and do not work around them" — and merging them would make
 *     one of the two audiences read something written for the other.
 */
import { type GateId, gateDefinition, isGateId, type TaskState } from '@vorschicht/shared';
import type postgres from 'postgres';
import type { GateSuiteResult } from './gate-suite.js';
import type { Queryable } from './sql.js';

/** Where in the pipeline a gate run happened. Phase 5's deploy engine is next. */
export type GateRunStage = 'merge_queue';

/**
 * §11 derives this from evidence; nothing writes it.
 *
 * `abandoned` is a distinct value rather than a flavour of resolved because on
 * a `done` task it is an anomaly worth an audit's attention: the only ordinary
 * way to reach it is a gate that produced a finding and then stopped running.
 */
export type FindingStatus = 'open' | 'resolved' | 'abandoned';

export interface GateRunRecord {
  id: string;
  taskId: string;
  projectId: string;
  stage: GateRunStage;
  startedAt: Date;
  finishedAt: Date;
  durationMs: number;
  ok: boolean;
  headSha: string | null;
  baseRef: string | null;
}

export interface FindingRecord {
  /** Stable and derived: this run, this gate. Nothing stores it (0015). */
  id: string;
  gateRunId: string;
  taskId: string;
  projectId: string;
  gateId: GateId;
  stage: string;
  raisedAt: Date;
  /** The sha of the tree that was checked. §8.2's red → green question needs it. */
  raisedOnSha: string | null;
  /** German, and written to be acted on rather than logged (`GateStepResult.detail`). */
  detail: string;
  /** What the gate actually printed, capped at 16 KB by the suite. */
  output: string;
  exitCode: number | null;
  command: string[] | null;
  /** §11 has one, and it is a literal in the view rather than a column. */
  severity: 'blocker';
  taskState: TaskState;
  status: FindingStatus;
  resolvedByGateRunId: string | null;
  resolvedAt: Date | null;
  resolvedOnSha: string | null;
  /** The task carrying the fix, or null while nobody is (§9, 0015 decision 4). */
  fixTaskId: string | null;
}

export interface RecordedGateRun {
  run: GateRunRecord;
  /** The findings this run raised, in catalogue order. Empty on a green run. */
  findings: FindingRecord[];
}

export interface RecordGateRunInput {
  taskId: string;
  projectId: string;
  stage: GateRunStage;
  result: GateSuiteResult;
  /** The tree that was checked, and what it was compared against. */
  headSha?: string | null;
  baseRef?: string | null;
}

export interface FindingsServiceDeps {
  sql: Queryable;
}

export class FindingsService {
  constructor(private readonly deps: FindingsServiceDeps) {}

  /**
   * Persist one suite run and hand back the findings it raised.
   *
   * Written for *every* run, green ones included. §8.2's seventh domain asks
   * whether a commit reached the integration branch without a gate run behind
   * it, and a table that only records failures cannot answer it; the green runs
   * are also what closes earlier findings, so dropping them would leave every
   * finding open forever.
   *
   * `started_at` is computed from the suite's own duration rather than taken
   * from the caller. The caller would have to remember to take a timestamp
   * before the run and pass it through three layers, and the one thing that
   * cannot drift is a number the suite already measured.
   */
  async record(input: RecordGateRunInput): Promise<RecordedGateRun> {
    const { result } = input;
    const steps = result.steps.map((step) => ({
      id: step.id,
      verdict: step.verdict,
      detail: step.detail,
      output: step.output,
      exitCode: step.exitCode,
      durationMs: step.durationMs,
      command: step.command,
      attempts: step.attempts,
      retries: step.retries,
    }));

    const [row] = await this.deps.sql<Array<{ id: string }>>`
      INSERT INTO gate_runs (
        task_id, project_id, stage, started_at, duration_ms, ok, head_sha, base_ref, steps
      ) VALUES (
        ${input.taskId},
        ${input.projectId},
        ${input.stage},
        now() - make_interval(secs => ${result.durationMs} / 1000.0),
        ${result.durationMs},
        ${result.ok},
        ${input.headSha ?? null},
        ${input.baseRef ?? null},
        ${this.deps.sql.json(steps as unknown as postgres.JSONValue)}
      )
      RETURNING id
    `;
    const id = row?.id;
    /* c8 ignore next 3 */
    if (!id) {
      throw new Error('Gate-Lauf konnte nicht gespeichert werden — kein Datensatz zurückgegeben.');
    }

    const [run] = await this.runs({ id });
    /* c8 ignore next 3 */
    if (!run) {
      throw new Error(`Gate-Lauf ${id} ist unmittelbar nach dem Schreiben nicht lesbar.`);
    }
    return { run, findings: await this.byGateRun(id) };
  }

  /** Every gate run of one task, newest first. */
  async runsFor(taskId: string): Promise<GateRunRecord[]> {
    return this.runs({ taskId });
  }

  /**
   * The findings this task still owes (§11).
   *
   * Newest first, so a prompt that has to cut the list keeps the most recent
   * verdict rather than the oldest one — the earlier runs of a task that has
   * been round the loop twice describe a tree that no longer exists.
   */
  async open(taskId: string): Promise<FindingRecord[]> {
    const rows = await this.deps.sql<FindingRow[]>`
      SELECT * FROM findings WHERE task_id = ${taskId} AND status = 'open'
      ORDER BY raised_at DESC, gate_id`;
    return map(rows);
  }

  /** Everything ever raised against one task, newest first — the trace. */
  async forTask(taskId: string): Promise<FindingRecord[]> {
    const rows = await this.deps.sql<FindingRow[]>`
      SELECT * FROM findings WHERE task_id = ${taskId}
      ORDER BY raised_at DESC, gate_id`;
    return map(rows);
  }

  /**
   * §8.2's `gate_flip` trigger: a gate that went red and then green on a tree
   * that had not changed.
   *
   * 0015's decision 3 built the view for exactly this question and named it
   * there — "both runs carry the sha of the tree they checked, so the answer is
   * a comparison rather than a belief" — and until now nothing asked it. The
   * comparison is `raised_on_sha = resolved_on_sha`: identical trees, so there
   * was no intervening code change whatever happened between the two runs, and
   * no reasoning about "the next run" is needed. A NULL sha is excluded rather
   * than treated as equal; two runs that both failed to record what they
   * checked prove nothing about each other.
   *
   * Bounded by `withinMs` because this is asked from the scheduler's tick and
   * the view is a lateral expansion of every step of every gate run: a flip
   * nobody noticed within a couple of days is not worth a model session, and
   * the bound is what keeps the result set from growing with the table. The
   * scan itself does not — stated rather than hidden, and the reason the caller
   * asks for one row.
   */
  async flipsWithoutCodeChange(
    withinMs: number,
    limit = 1,
  ): Promise<Array<{ gateId: GateId; taskId: string; projectId: string; resolvedAt: Date }>> {
    const rows = await this.deps.sql<
      Array<{ gate_id: string; task_id: string; project_id: string; resolved_at: Date }>
    >`
      SELECT gate_id, task_id, project_id, resolved_at
      FROM findings
      WHERE status = 'resolved'
        AND raised_on_sha IS NOT NULL
        AND raised_on_sha = resolved_on_sha
        AND resolved_at > now() - make_interval(secs => ${withinMs} / 1000.0)
      ORDER BY resolved_at DESC
      LIMIT ${limit}
    `;
    return rows
      .filter((row) => isGateId(row.gate_id))
      .map((row) => ({
        gateId: row.gate_id as GateId,
        taskId: row.task_id,
        projectId: row.project_id,
        resolvedAt: row.resolved_at,
      }));
  }

  /** What a project currently owes, across all its tasks. */
  async openForProject(projectId: string): Promise<FindingRecord[]> {
    const rows = await this.deps.sql<FindingRow[]>`
      SELECT * FROM findings WHERE project_id = ${projectId} AND status = 'open'
      ORDER BY raised_at DESC, gate_id`;
    return map(rows);
  }

  private async byGateRun(gateRunId: string): Promise<FindingRecord[]> {
    const rows = await this.deps.sql<FindingRow[]>`
      SELECT * FROM findings WHERE gate_run_id = ${gateRunId} ORDER BY gate_id`;
    return map(rows);
  }

  private async runs(where: { id?: string; taskId?: string }): Promise<GateRunRecord[]> {
    const rows = where.id
      ? await this.deps.sql<GateRunRow[]>`SELECT * FROM gate_runs WHERE id = ${where.id}`
      : await this.deps.sql<GateRunRow[]>`
          SELECT * FROM gate_runs WHERE task_id = ${where.taskId ?? ''} ORDER BY seq DESC`;
    return rows.map((row) => ({
      id: row.id,
      taskId: row.task_id,
      projectId: row.project_id,
      stage: row.stage as GateRunStage,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      ok: row.ok,
      headSha: row.head_sha,
      baseRef: row.base_ref,
    }));
  }
}

/**
 * Rows to records, dropping any gate id the catalogue no longer knows.
 *
 * The filter is not defensive noise: `gate_runs` is append-only and kept
 * forever, so a gate removed from §11's catalogue in a year leaves rows behind
 * that name it. Returning those as a `GateId` would be a lie the type system
 * cannot catch, and `gateDefinition` throws on them — inside a prompt builder,
 * which is the worst place to find out.
 */
function map(rows: readonly FindingRow[]): FindingRecord[] {
  return rows.filter((row) => isGateId(row.gate_id)).map(toFinding);
}

interface GateRunRow {
  id: string;
  task_id: string;
  project_id: string;
  stage: string;
  started_at: Date;
  finished_at: Date;
  duration_ms: number;
  ok: boolean;
  head_sha: string | null;
  base_ref: string | null;
}

interface FindingRow {
  id: string;
  gate_run_id: string;
  task_id: string;
  project_id: string;
  gate_id: string;
  stage: string;
  raised_at: Date;
  raised_on_sha: string | null;
  detail: string | null;
  output: string | null;
  exit_code: number | null;
  command: string[] | null;
  severity: string;
  task_state: string;
  status: string;
  resolved_by_gate_run_id: string | null;
  resolved_at: Date | null;
  resolved_on_sha: string | null;
  fix_task_id: string | null;
}

function toFinding(row: FindingRow): FindingRecord {
  return {
    id: row.id,
    gateRunId: row.gate_run_id,
    taskId: row.task_id,
    projectId: row.project_id,
    gateId: row.gate_id as GateId,
    stage: row.stage,
    raisedAt: row.raised_at,
    raisedOnSha: row.raised_on_sha,
    detail: row.detail ?? '',
    output: row.output ?? '',
    exitCode: row.exit_code,
    command: row.command,
    severity: 'blocker',
    taskState: row.task_state as TaskState,
    status: row.status as FindingStatus,
    resolvedByGateRunId: row.resolved_by_gate_run_id,
    resolvedAt: row.resolved_at,
    resolvedOnSha: row.resolved_on_sha,
    fixTaskId: row.fix_task_id,
  };
}

// --- the two briefings ---------------------------------------------------------

/** How much of a gate's output a prompt carries per finding. */
export const FINDING_OUTPUT_IN_PROMPT = 4_000;

/** Enough for the timeline to be readable; the full text is on the gate run. */
export const FINDING_OUTPUT_IN_NOTE = 600;

/** What either briefing needs. Structural, so a caller can build one by hand. */
export interface BriefableFinding {
  id: string;
  gateId: GateId;
  detail: string;
  output: string;
}

/**
 * The German note that goes onto the task timeline when a merge is refused (§2).
 *
 * Addressed to the operator, and therefore about *why the task came back* rather than
 * about what to type. The finding id is quoted short: it is the handle that
 * ties this line to the `findings` row, to the gate run, and to the output the
 * dashboard will render, and eight characters is enough to find it.
 */
export function findingsNote(findings: readonly BriefableFinding[]): string {
  if (findings.length === 0) return 'Keine Befunde.';
  const lines = [
    findings.length === 1
      ? 'Ein Befund blockiert den Merge (§11 — jeder Befund ist ein Blocker):'
      : `${findings.length} Befunde blockieren den Merge (§11 — jeder Befund ist ein Blocker):`,
    '',
  ];
  for (const finding of findings) {
    lines.push(`**${gateDefinition(finding.gateId).label}** · Befund ${finding.id.slice(0, 8)}`);
    lines.push(finding.detail);
    const output = clip(finding.output, FINDING_OUTPUT_IN_NOTE);
    if (output) lines.push('```', output, '```');
    lines.push('');
  }
  lines.push(
    'Der nächste Anlauf bekommt diese Befunde in seinen Auftrag geschrieben und gilt erst ' +
      'als erledigt, wenn dieselben Prüfungen grün sind.',
  );
  return lines.join('\n');
}

/**
 * The prompt section the next attempt gets (§2: prompts are English).
 *
 * The gate details themselves stay German — they were written for the timeline
 * and translating them here would create a second wording of the same fact that
 * nothing keeps in step. `debuggerPrompt` already carries a German problem
 * statement into an English prompt for the same reason.
 *
 * Two instructions in the text are load-bearing rather than polite. "Do not
 * disable, skip or weaken the check" is §0.3 and §11 stated to the one party
 * with both the motive and the means; and "if you believe a finding is wrong,
 * say so in your result" is the escape hatch that keeps the first instruction
 * from producing a coder that fakes a pass rather than arguing.
 */
export function findingsBriefing(findings: readonly BriefableFinding[]): string[] {
  if (findings.length === 0) return [];
  const sections = [
    '## Gates that blocked this change — fix these first',
    '',
    'This task has been through the merge queue and was refused. Every item below is',
    'a blocker: this system has no warning level and no severity beneath "blocker".',
    'The same gates run again on the rebased tree, so the change merges only once all',
    'of them are green.',
    '',
    'Do not disable, skip, weaken or work around a check to make it pass — that is the',
    'one failure mode this pipeline cannot detect. If you believe a finding is wrong,',
    'say so in your result and leave the check as it is.',
    '',
    'The one-line summaries are German (they are written for the timeline); the',
    'captured output beneath each one is verbatim.',
  ];
  for (const finding of findings) {
    sections.push(
      '',
      `### ${gateDefinition(finding.gateId).label} (\`${finding.gateId}\`) — finding ${finding.id.slice(0, 8)}`,
      '',
      finding.detail,
    );
    const output = clip(finding.output, FINDING_OUTPUT_IN_PROMPT);
    if (output) sections.push('', '```', output, '```');
  }
  return sections;
}

/**
 * Cut long output and say that it was cut.
 *
 * A silently truncated log reads as a complete one, and a session that believes
 * it has seen the whole failure stops looking at the point the cut happened.
 */
function clip(text: string, limit: number): string {
  const clean = text.trim();
  if (clean.length <= limit) return clean;
  return `${clean.slice(0, limit)}\n… (${clean.length - limit} Zeichen gekürzt — der vollständige Text steht am Gate-Lauf)`;
}
