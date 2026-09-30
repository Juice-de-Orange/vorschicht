/**
 * §18's missing producer: "Backup success/failure events → Ops tile + ntfy on
 * failure."
 *
 * There was none. No code in this repository read or wrote a backup event of
 * any kind, so the sentence described a channel with no sender — A71's shape
 * and §8.2's sixth domain, in the one subsystem whose whole job is to still be
 * there after everything else is gone. The only thing that ever reported on a
 * backup was the container healthcheck, and it speaks to the watchdog rather
 * than to the operator, 48 hours late, without naming a component.
 *
 * What that cost, observed rather than imagined: for seven nights the sidecar
 * aborted after `pg_dump` had already succeeded, because it could not read the
 * transcripts it was told to archive. Nothing said so. `docs/OPERATIONS.md` carries
 * the incident.
 *
 * Modelled on `notifications-pass.ts` — its own module with its own test, state
 * in an object rather than in `let` variables in `main()`, for the reason that
 * file gives at length and that `incident-cycle.ts` gave before it. Six
 * decisions here.
 *
 *  1. **The sidecar never writes to the database itself.** It has the
 *     credentials — `PGPASSWORD` is right there in its environment — which is
 *     exactly why the rule matters instead of being a convenience:
 *     `EventLog.append` is the only sanctioned way into the log (§18), and a
 *     second writer in a `postgres:alpine` container speaking hand-written SQL
 *     is a second definition of what an event is. So the sidecar leaves a file
 *     and this pass reports it. The file is also the only channel that survives
 *     the case worth reporting most: a run that died before it could have
 *     talked to anything.
 *
 *  2. **It never throws.** Same reason as `notifications-pass.ts` property 1,
 *     and it is not theoretical here: this reads a file off a mounted volume
 *     and runs two queries. The guard is inside this function rather than at
 *     the call site, because that is the only arrangement its test can observe.
 *
 *  3. **A run is identified by its own `finished_at`, and the memory is the
 *     event log.** Not a variable: the process holding it is restarted more
 *     often than a nightly job runs, and a counter that resets on restart
 *     re-announces the same night forever. Not our own clock either — the
 *     identity of a run belongs to the run, and comparing "did I already see
 *     this" against a timestamp we made up would re-report the same file after
 *     every deploy. This pass therefore needs no injected clock at all, which
 *     is worth saying out loud because every neighbouring module has one.
 *
 *  4. **ntfy on the transition, never per run — and never per pass.** A67.6 and
 *     A86.5, applied to a third channel. The pass runs every tick; a push per
 *     tick for as long as a volume is unreadable is a channel that gets muted,
 *     and then the next real alert is invisible. At most one alert per outage
 *     and one recovery, and the previous state is *derived from the log* so a
 *     restart mid-outage does not start a second one.
 *
 *  5. **The event is written only after the alert was delivered.**
 *     `escalation-push.ts` decision 2 and `escalation-mail.ts` decision 2,
 *     verbatim: an alert ntfy refused is an alert nobody got, and recording the
 *     run would retire the retry. Stated cost, because it is a real one: while
 *     ntfy is unreachable the Ops tile lags by however long that lasts. The
 *     alternative trades a lagging tile for a lost alarm, and §18 names the
 *     alarm. A crash between the send and the write costs one duplicate
 *     notification, which is the direction to fail in.
 *
 *  6. **Nothing here repairs anything.** It does not re-run the backup, prune,
 *     touch `.last-run` or open an inbox item. §18 asks for an event and an
 *     alert; a pass that also acted would be the one component able to erase
 *     the evidence it exists to report.
 */
import { readFile } from 'node:fs/promises';
import type { EventLog, Notification, Notifier, Queryable } from '@vorschicht/core';

/** The components `backup-run.sh` reports, in the order it runs them. */
export const BACKUP_COMPONENTS = ['db', 'docs', 'transcripts', 'prune'] as const;
export type BackupComponent = (typeof BACKUP_COMPONENTS)[number];

/**
 * `skipped` is a real answer, not a missing one: the script starts every
 * component there and an abort leaves the ones it never reached saying so.
 * `unbekannt` is different again — it means the producer did not mention this
 * component at all, which is a drift between the two halves of the document and
 * must not be readable as "fine".
 */
export type BackupComponentOutcome = 'ok' | 'failed' | 'skipped' | 'unbekannt';

/** The document `backup-run.sh` writes, once parsed. */
export interface BackupResult {
  /** Epoch seconds, from the producer. The identity of the run (decision 3). */
  finishedAt: number;
  startedAt: number | null;
  /** The timestamp the run's artefacts are named after, for the message. */
  stamp: string | null;
  outcome: 'ok' | 'failed';
  components: Record<BackupComponent, BackupComponentOutcome>;
  /** The German sentence the script's own `fail` produced, when there was one. */
  problem: string | null;
}

export type BackupResultParse = { ok: true; result: BackupResult } | { ok: false; problem: string };

/**
 * The schema version this reader understands.
 *
 * Asserted rather than ignored, and that is the whole defence available here.
 * The producer is a POSIX shell script and the consumer is TypeScript, so the
 * document is declared twice with nothing able to typecheck one against the
 * other — A81's defect shape, which cannot be removed the way A81 removed it
 * (a shared zod schema) because `sh` cannot import one. What is left is: refuse
 * a shape we do not know instead of silently reading fields out of it, and a
 * test that greps the script for the keys this parser requires.
 */
export const BACKUP_RESULT_SCHEMA = 1;

/**
 * `key=value` lines → a result, or a German sentence saying why not.
 *
 * Split on the **first** `=` only: `problem` carries a message from a tool and
 * may well contain one. Unknown keys are ignored rather than refused, so the
 * producer can add a fact without this becoming a released-in-lockstep pair;
 * an unknown *schema* is refused, which is the other half of the same rule.
 */
export function parseBackupResult(text: string): BackupResultParse {
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }

  const schema = Number(fields.get('schema'));
  if (!Number.isInteger(schema) || schema !== BACKUP_RESULT_SCHEMA) {
    return {
      ok: false,
      problem:
        `.last-result nennt schema=${fields.get('schema') ?? '<fehlt>'}, ` +
        `gelesen wird ${BACKUP_RESULT_SCHEMA} — backup-run.sh und dieser Leser ` +
        'sind nicht mehr dasselbe Dokument.',
    };
  }

  const finishedAt = Number(fields.get('finished_at'));
  if (!Number.isInteger(finishedAt) || finishedAt <= 0) {
    return {
      ok: false,
      problem: '.last-result hat kein brauchbares finished_at — der Lauf ist nicht unterscheidbar.',
    };
  }

  const outcome = fields.get('outcome');
  if (outcome !== 'ok' && outcome !== 'failed') {
    return { ok: false, problem: `.last-result nennt outcome=${outcome ?? '<fehlt>'}.` };
  }

  const startedAt = Number(fields.get('started_at'));
  const problem = fields.get('problem');
  const components = {} as Record<BackupComponent, BackupComponentOutcome>;
  for (const component of BACKUP_COMPONENTS) {
    const value = fields.get(component);
    components[component] =
      value === 'ok' || value === 'failed' || value === 'skipped' ? value : 'unbekannt';
  }

  return {
    ok: true,
    result: {
      finishedAt,
      startedAt: Number.isInteger(startedAt) && startedAt > 0 ? startedAt : null,
      stamp: fields.get('stamp') || null,
      outcome,
      components,
      problem: problem && problem.length > 0 ? problem : null,
    },
  };
}

export interface BackupPassDeps {
  /** `VORSCHICHT_BACKUP_RESULT`; the compose mount has to agree with it. */
  resultPath: string;
  eventLog: EventLog;
  sql: Queryable;
  /** Only ever used for decision 4's transition alert. */
  notifier: Pick<Notifier, 'send'>;
  logger: {
    info(obj: unknown, message?: string): void;
    warn(obj: unknown, message?: string): void;
    error(obj: unknown, message?: string): void;
  };
}

export interface BackupPassResult {
  /** False when no document exists yet — a fresh stack, not a fault. */
  observed: boolean;
  outcome: 'ok' | 'failed' | null;
  /** True when this pass wrote an event for a run the log had not seen. */
  recorded: boolean;
  /** The transition alert this pass delivered, if any (decision 4). */
  alerted: 'failure' | 'recovery' | null;
  /** Sends ntfy refused. Never thrown, always reported. */
  failures: string[];
  /** Exceptions this pass swallowed (decision 2), German, for the caller. */
  problems: string[];
}

/** The last backup run this log knows about, or null if it knows none. */
interface RecordedRun {
  outcome: 'ok' | 'failed';
  finishedAt: number | null;
}

export async function runBackupPass(deps: BackupPassDeps): Promise<BackupPassResult> {
  const result: BackupPassResult = {
    observed: false,
    outcome: null,
    recorded: false,
    alerted: null,
    failures: [],
    problems: [],
  };

  try {
    const document = await readDocument(deps.resultPath);
    // No document at all: the sidecar has not finished a run on this volume
    // yet. Silent on purpose — a fresh stack says this on every tick for as
    // long as it takes to reach 02:30, and so does a developer machine with no
    // backups volume mounted. The condition that *is* worth reporting, a
    // sidecar that has stopped running, is the healthcheck's and the watchdog's
    // (§18.1); it needs a clock, and this pass deliberately has none.
    if (document === null) return result;

    const parsed = parseBackupResult(document);
    if (!parsed.ok) {
      // Reported once per pass rather than suppressed: unlike a missing file
      // this is a real disagreement between two halves of one document, and it
      // means §18's channel is carrying nothing while looking wired up.
      result.problems.push(parsed.problem);
      deps.logger.error({ path: deps.resultPath }, parsed.problem);
      return result;
    }

    const run = parsed.result;
    result.observed = true;
    result.outcome = run.outcome;

    const last = await lastRecordedRun(deps.sql);
    // Already recorded. Silent, and this is the ordinary case: the pass runs
    // every tick and a backup runs once a night, so all but a handful of the
    // day's ~5700 passes end here.
    if (last && last.finishedAt === run.finishedAt) return result;

    const transition = decideTransition(last, run.outcome);
    if (transition !== null) {
      const sent = await deps.notifier.send(notificationFor(transition, run));
      if (!sent.ok) {
        // Decision 5: nothing is recorded, so the whole pass is retried — the
        // alert and the event travel together or not at all.
        const failure = `Backup-${transition === 'failure' ? 'Alarm' : 'Entwarnung'}: ${sent.error}`;
        result.failures.push(failure);
        deps.logger.warn({ transition, error: sent.error }, `${failure} — erneuter Versuch`);
        return result;
      }
      result.alerted = transition;
    }

    await deps.eventLog.append({
      kind: run.outcome === 'ok' ? 'backup.succeeded' : 'backup.failed',
      actor: 'system',
      payload: {
        finishedAt: run.finishedAt,
        startedAt: run.startedAt,
        stamp: run.stamp,
        components: run.components,
        problem: run.problem,
        alerted: transition,
      },
    });
    result.recorded = true;

    const report = { stamp: run.stamp, components: run.components, problem: run.problem };
    if (run.outcome === 'ok') {
      deps.logger.info(report, 'Sicherung vollständig durchgelaufen (§18, A14)');
    } else {
      deps.logger.error(report, `Sicherung fehlgeschlagen: ${run.problem ?? 'ohne Angabe'}`);
    }
  } catch (error) {
    const problem = `§18s Sicherungsmeldung konnte nicht laufen: ${(error as Error).message}`;
    result.problems.push(problem);
    deps.logger.error({ err: error }, problem);
  }

  return result;
}

/** The document, or null when there is none. Anything else is a real fault. */
async function readDocument(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOENT: no run yet. ENOTDIR: the volume is not mounted here, which on a
    // developer machine is the normal state and not something to report nightly.
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/**
 * The most recent backup run the event log knows about.
 *
 * One indexed lookup (`event_log_kind_idx` is `(kind, occurred_at DESC)`), by
 * id rather than by timestamp so that two events in the same millisecond still
 * have an order — the reason `EventLog.since` gives.
 */
async function lastRecordedRun(sql: Queryable): Promise<RecordedRun | null> {
  const rows = await sql<Array<{ kind: string; finished_at: string | null }>>`
    SELECT kind, payload ->> 'finishedAt' AS finished_at
    FROM event_log
    WHERE kind IN ('backup.succeeded', 'backup.failed')
    ORDER BY id DESC
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  const finishedAt = Number(row.finished_at);
  return {
    outcome: row.kind === 'backup.succeeded' ? 'ok' : 'failed',
    finishedAt: Number.isInteger(finishedAt) ? finishedAt : null,
  };
}

/**
 * Decision 4, as a pure function.
 *
 * The first observation is a special case and it is deliberately asymmetric: a
 * studio whose very first recorded backup failed must say so, and one whose
 * first recorded backup worked has nothing to announce. Anything else would
 * either open with good news nobody asked for or swallow the one case where
 * the backup has never worked at all.
 */
export function decideTransition(
  last: { outcome: 'ok' | 'failed' } | null,
  outcome: 'ok' | 'failed',
): 'failure' | 'recovery' | null {
  if (last === null) return outcome === 'failed' ? 'failure' : null;
  if (last.outcome === outcome) return null;
  return outcome === 'failed' ? 'failure' : 'recovery';
}

/**
 * German (§2). The message names the components, because the failure this
 * whole path was built for was a *partial* one and "die Sicherung ist
 * fehlgeschlagen" would have hidden exactly the fact that mattered.
 *
 * `alerts` at `high`: the studio keeps working and yesterday's backup is still
 * there, so nothing needs doing at 03:00 — but every further night widens the
 * gap between what exists and what §22's restore drill would need, and this is
 * the failure class that went unnoticed for a week. The recovery goes to `info`
 * at ordinary priority, following `incident-cycle.ts`, which puts "it is over"
 * on the quiet channel.
 */
function notificationFor(transition: 'failure' | 'recovery', run: BackupResult): Notification {
  const parts = BACKUP_COMPONENTS.map((name) => `${name}: ${run.components[name]}`).join(' · ');

  if (transition === 'failure') {
    return {
      topic: 'alerts',
      title: 'Vorschicht: Sicherung fehlgeschlagen',
      message:
        `${run.problem ?? 'Der Lauf endete ohne Angabe eines Grundes.'}\n\n` +
        `${parts}\n\n` +
        'Bis das behoben ist, entsteht keine neue Sicherung (§18, A14). ' +
        'Ältere Stände sind unberührt. docs/OPERATIONS.md, Abschnitt „Restore a backup“.',
      priority: 'high',
      tags: ['floppy_disk', 'warning'],
    };
  }
  return {
    topic: 'info',
    title: 'Vorschicht: Sicherung läuft wieder',
    message: `Der letzte Lauf war vollständig.\n\n${parts}`,
    tags: ['floppy_disk'],
  };
}
