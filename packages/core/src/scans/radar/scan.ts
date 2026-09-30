/**
 * §8's sixth department, as a scheduled scan (§22 Phase 6 step 4).
 *
 * Rado watches three things and this is all of them: §6.0's billing change,
 * A27's CLI release, and A10's dependency and advisory policy. They share one
 * cadence because A22 turns "radar" down as one thing, one dedup memory because
 * the rule they all obey is the same, and one row per run because that row is
 * the deadline (`periodic-pass.ts` decision 3).
 *
 * Nine decisions.
 *
 *  1. **`radar.finished`, not `scan.finished`.** The obvious reuse is a defect:
 *     `PeriodicJob.lastRunKind` reads the newest row *of that kind*, so a radar
 *     writing `scan.finished` every six hours would make §6.6's nightly
 *     transcript scan (A105) permanently look as if it had just run — and it
 *     would starve, silently, in the channel whose entire purpose is that a
 *     leaked credential reaches the operator quickly. Two jobs, two kinds. `radar.applied`
 *     is the second, and it is `source.curated`'s exact counterpart: the memory
 *     that keeps an answered card from being carried out twice.
 *
 *  2. **The scan reports what it did not look at, every run.** §6.0's two
 *     channels have no default URL (`feeds.ts` decision 2), so the ordinary
 *     state of a fresh installation is that the billing watch is configured with
 *     nothing. A scan that answered "nothing found" there would be the exact
 *     sentence A104.4 measured the cost of. `limits` is part of the outcome and
 *     part of the row, and the periodic pass logs it.
 *
 *  3. **Answered cards are carried out before new ones are raised.** Otherwise a
 *     card raised and answered within one interval would wait a whole further
 *     interval to act, for no reason other than statement order. It also keeps
 *     the two halves from meeting: a card this run raises is not one this run
 *     applies.
 *
 *  4. **Dedup is by a namespaced key and the memory is the event log.** A10's
 *     branches all repeat: the same outdated package is outdated tomorrow, and
 *     the same page still says the same thing. Without the memory this is one
 *     P0 per night per advisory (A105.3's arithmetic, and the fourth time this
 *     repository has written the rule down — A67.6, A86.5, A102). The memory is
 *     a row rather than a field on the process because a deploy is a restart
 *     (A57) and a nightly job is rarer than a restart.
 *
 *  5. **Only the non-urgent cards are capped.** A first run against a real
 *     repository can find twenty outdated majors, and twenty cards at once is an
 *     inbox nobody reads. `MAX_ROUTINE_CARDS_PER_RUN` defers the rest — they are
 *     not marked reported, so the next run raises them — and the deferral is
 *     said out loud. P0 is never capped: an advisory and a billing change are the
 *     two things A10 and §6.0 make urgent, and deferring an urgent card to keep
 *     an inbox tidy is the wrong trade in the one place it matters.
 *
 *  6. **A task is created even where the project is read-only, and the report
 *     says so.** A85 made Vorschicht's own project `read_only` until the build
 *     is finished, and the scheduler skips such projects entirely — so a task
 *     filed there waits rather than runs. Suppressing it instead would mean the
 *     studio notices a CLI release or a security fix and records nothing
 *     actionable at all. The cost is stated rather than hidden: while A85 stands,
 *     these tasks accumulate in `queued`. Dedup bounds it to one task per
 *     distinct version.
 *
 *  7. **The choice is read, never the state.** A93.5 and A97 are one defect
 *     found twice — a card that checked `state === 'answered'` let the option
 *     written to say no release the act. `applyOne` reads `chosenIndex` against
 *     `RADAR_APPROVE_INDEX` and treats a free-text-only answer as no decision, because
 *     "ja mach" and "auf keinen Fall" are both free text and inferring consent
 *     from prose is guessing (§1 principle 6).
 *
 *  8. **Nothing here pushes a notification.** `EscalationService.raise` is the
 *     only call, and `escalation-push.ts`'s observer turns every new item into a
 *     ntfy card with a working deep link. A86.2 is the reason it is worth saying:
 *     the one producer that raised *and* pushed in the same block was also the
 *     one place §15's deep link was missing.
 *
 *  9. **It never throws.** It runs from the daemon's loop; each of the four
 *     sub-scans and each card is guarded on its own, so a channel that 500s must
 *     not cost the dependency scan its run. `runPeriodicPass` would catch a
 *     throw, and then the whole radar would be one line in a log instead of
 *     three scans and a named limit.
 */

import type { EscalationService } from '../../escalation-service.js';
import type { EventLog } from '../../event-log.js';
import type { ProjectRecord, ProjectService } from '../../project-service.js';
import type { Queryable } from '../../sql.js';
import type { TaskService } from '../../task-service.js';
import { detectBillingChange, detectCliRelease, extractCliVersion } from './billing.js';
import {
  advisoryCard,
  approvedUpdateTask,
  billingCard,
  cliUpdateTask,
  majorUpdateCard,
  RADAR_APPROVE_INDEX,
  type RadarCard,
  routineUpdateTask,
} from './cards.js';
import {
  type AdvisoryFinding,
  applyRadarPolicy,
  type DependencyUpdate,
  planUpdates,
  readDependencies,
  separateAdvisories,
} from './dependencies.js';
import type { RadarFeeds } from './feeds.js';

/** §22 Phase 6 step 4 gives no cadence; six hours is the reasoning below. */
export const RADAR_INTERVAL_MS = 6 * 60 * 60_000;

/** Decision 5. Enough to make progress, few enough to still be an inbox. */
export const MAX_ROUTINE_CARDS_PER_RUN = 3;

/** Decision 3: how many answered cards one pass carries out. */
const MAX_APPLIED_PER_RUN = 20;

/** Rado (§8 row 6) — the actor on every row this scan writes. */
const RADAR_ACTOR = 'research';

/** What a raised card remembers about itself, for decision 7's lookup. */
export interface RaisedRadarCard {
  escalationId: string;
  number: number;
  key: string;
  kind: 'billing' | 'dependency_major' | 'dependency_advisory';
  projectId: string | null;
  projectName: string | null;
  name: string | null;
  current: string | null;
  latest: string | null;
}

/** One answered card, carried out or deliberately not (decision 7). */
export interface AppliedRadarAnswer {
  escalationNumber: number;
  outcome: 'aufgabe_angelegt' | 'abgelehnt' | 'unentschieden' | 'uebersprungen';
  detail: string;
  taskId: string | null;
}

export interface RadarOutcome {
  /** German, one line, for the pass's log. Null when there is nothing to say. */
  report: string | null;
  cards: RaisedRadarCard[];
  tasks: string[];
  applied: AppliedRadarAnswer[];
  /** Decision 2: what was not checked, and why. Never empty by accident. */
  limits: string[];
  problems: string[];
}

export interface RadarScanDeps {
  sql: Queryable;
  eventLog: EventLog;
  feeds: RadarFeeds;
  /** The real services, so a drifted signature fails the build (A57.6). */
  escalations: Pick<EscalationService, 'raise'>;
  tasks: Pick<TaskService, 'create'>;
  projects: Pick<ProjectService, 'listActive'>;
  /** A27's pin, from `CLAUDE_CLI_VERSION`. What the channel is compared against. */
  pinnedCliVersion: string;
  now?: () => number;
}

export class RadarScan {
  constructor(private readonly deps: RadarScanDeps) {}

  async run(): Promise<RadarOutcome> {
    const outcome: RadarOutcome = {
      report: null,
      cards: [],
      tasks: [],
      applied: [],
      limits: [],
      problems: [],
    };

    // Decision 3: what the operator already decided acts first.
    try {
      outcome.applied = await this.applyAnswers();
    } catch (error) {
      outcome.problems.push(`Beantwortete Radar-Karten nicht lesbar: ${message(error)}`);
    }

    let reported: Set<string>;
    try {
      reported = await this.alreadyReported();
    } catch (error) {
      // Without the memory every finding reads as new, which is decision 4's
      // flood. Skipping the run entirely is the direction that costs an
      // interval rather than an inbox.
      outcome.problems.push(`Radar-Gedächtnis nicht lesbar: ${message(error)}`);
      outcome.report = 'Radar übersprungen: das Gedächtnis war nicht lesbar.';
      await this.record(outcome, []);
      return outcome;
    }

    const fresh: string[] = [];
    let routineCardBudget = MAX_ROUTINE_CARDS_PER_RUN;

    await this.guard(outcome, 'Abrechnungs-Radar', () => this.billing(outcome, reported, fresh));
    await this.guard(outcome, 'CLI-Radar', () => this.cli(outcome, reported, fresh));

    let projects: ProjectRecord[] = [];
    try {
      projects = await this.deps.projects.listActive();
    } catch (error) {
      outcome.problems.push(`Projektliste nicht lesbar: ${message(error)}`);
    }
    if (projects.length === 0) {
      outcome.limits.push('Kein aktives Projekt — Abhängigkeiten wurden nirgends geprüft.');
    }
    for (const project of projects) {
      await this.guard(outcome, `Abhängigkeiten (${project.slug})`, async () => {
        routineCardBudget = await this.dependencies(
          project,
          outcome,
          reported,
          fresh,
          routineCardBudget,
        );
      });
    }

    await this.record(outcome, fresh);
    outcome.report = summarise(outcome);
    return outcome;
  }

  /** Decision 9: one sub-scan's failure never costs the others their run. */
  private async guard(
    outcome: RadarOutcome,
    label: string,
    work: () => Promise<void>,
  ): Promise<void> {
    try {
      await work();
    } catch (error) {
      outcome.problems.push(`${label} ist gescheitert: ${message(error)}`);
    }
  }

  // ---------------------------------------------------------------- §6.0 -----

  private async billing(
    outcome: RadarOutcome,
    reported: ReadonlySet<string>,
    fresh: string[],
  ): Promise<void> {
    const channels = await this.deps.feeds.billingChannels();
    if (channels.length === 0) {
      outcome.limits.push(
        'Abrechnungs-Radar (§6.0): kein Kanal konfiguriert ' +
          '(`VORSCHICHT_RADAR_BILLING_URLS`) — in diesem Lauf wurde nichts abgefragt. ' +
          'Das ist keine Entwarnung.',
      );
      return;
    }

    const signals = [];
    for (const channel of channels) {
      for (const problem of channel.problems ?? []) outcome.problems.push(problem);
      if (!channel.live) {
        outcome.limits.push(
          `Abrechnungs-Radar: «${channel.origin}» wurde in diesem Lauf nicht wirklich ` +
            'abgefragt — der Text stammt aus einer Fixture oder der Abruf ist gescheitert.',
        );
      }
      signals.push(...detectBillingChange(channel.value, channel.origin));
    }

    const news = signals.filter((signal) => !reported.has(billingKey(signal.signature)));
    if (news.length === 0) return;

    // One card for the whole finding (A105.5): rotation of attention is per
    // event, not per matched sentence.
    const card = billingCard(news);
    const raised = await this.raise(card, {
      source: 'billing_change',
      key: billingKey(news[0]?.signature ?? 'unbekannt'),
      kind: 'billing',
      projectId: null,
      projectName: null,
      name: null,
      current: null,
      latest: null,
    });
    outcome.cards.push(raised);
    for (const signal of news) fresh.push(billingKey(signal.signature));
  }

  // ----------------------------------------------------------------- A27 -----

  private async cli(
    outcome: RadarOutcome,
    reported: ReadonlySet<string>,
    fresh: string[],
  ): Promise<void> {
    const channel = await this.deps.feeds.cliChannel();
    for (const problem of channel.problems ?? []) outcome.problems.push(problem);
    if (!channel.live) {
      outcome.limits.push(
        `CLI-Radar (A27): «${channel.origin}» wurde in diesem Lauf nicht wirklich abgefragt.`,
      );
    }
    if (channel.value === null) return;

    const release = detectCliRelease(this.deps.pinnedCliVersion, extractCliVersion(channel.value));
    if (release === null) return;
    const key = cliKey(release.latest);
    if (reported.has(key)) return;

    const project = await this.selfManagedProject();
    if (!project) {
      // Nowhere to file it. Reported as a limit rather than dropped: A27's whole
      // point is that a CLI bump is examined, and silence here would look
      // exactly like "no new version".
      outcome.limits.push(
        `CLI-Radar: ${release.latest} ist verfügbar (fest: ${release.pinned}), aber es gibt ` +
          'kein selbstverwaltetes Projekt, in dem die Aufgabe entstehen könnte.',
      );
      return;
    }

    const spec = cliUpdateTask(release);
    const task = await this.deps.tasks.create({
      projectId: project.id,
      title: spec.title,
      description: spec.description,
      acceptanceCriteria: spec.acceptanceCriteria,
      priority: spec.priority,
      department: 'Research/Radar',
      type: 'radar',
      actor: RADAR_ACTOR,
    });
    outcome.tasks.push(task.id);
    fresh.push(key);
    if (project.readOnly) {
      // Decision 6, said where a reader will see it.
      outcome.limits.push(
        `Die CLI-Aufgabe wartet: «${project.slug}» ist nach A85 schreibgeschützt, der ` +
          'Ablaufplaner überspringt solche Projekte.',
      );
    }
  }

  // ----------------------------------------------------------------- A10 -----

  private async dependencies(
    project: ProjectRecord,
    outcome: RadarOutcome,
    reported: ReadonlySet<string>,
    fresh: string[],
    routineCardBudget: number,
  ): Promise<number> {
    const inventory = await readDependencies(project.rootPath);
    for (const problem of inventory.problems) outcome.problems.push(`${project.slug}: ${problem}`);
    if (inventory.source === 'none' || inventory.dependencies.length === 0) {
      outcome.limits.push(
        `Abhängigkeits-Radar: «${project.slug}» hat unter ${project.rootPath} weder ein ` +
          'lesbares `package.json` noch ein `pnpm-lock.yaml` — nichts geprüft.',
      );
      return routineCardBudget;
    }

    const names = [...new Set(inventory.dependencies.map((entry) => entry.name))];
    const latest = await this.deps.feeds.latestVersions(names);
    for (const problem of latest.problems ?? [])
      outcome.problems.push(`${project.slug}: ${problem}`);
    if (!latest.live) {
      outcome.limits.push(
        `Abhängigkeits-Radar: «${project.slug}» — der Kanal (${latest.origin}) hat in diesem ` +
          'Lauf nicht geantwortet, es wurden also keine Versionen verglichen.',
      );
    }

    const advisoryFeed = await this.deps.feeds.advisories(
      inventory.dependencies.map((entry) => ({ name: entry.name, version: entry.current })),
    );
    for (const problem of advisoryFeed.problems ?? []) {
      outcome.problems.push(`${project.slug}: ${problem}`);
    }
    if (!advisoryFeed.live) {
      outcome.limits.push(
        `Advisory-Radar: «${project.slug}» — ${advisoryFeed.origin} wurde in diesem Lauf ` +
          'nicht wirklich abgefragt. Kein Hinweis heißt hier nicht: kein Problem.',
      );
    }

    const updates = planUpdates(inventory, latest.value);
    const byName = new Map(updates.map((update) => [update.name, update]));

    // Decision 7 of `dependencies.ts`: advisories claim their packages first.
    for (const [name, group] of groupAdvisories(advisoryFeed.value)) {
      const keys = group.map((advisory) => advisoryKey(project.id, advisory.id));
      if (keys.every((key) => reported.has(key))) continue;
      const card = advisoryCard(group, project.name, byName.get(name) ?? null);
      const update = byName.get(name);
      const raised = await this.raise(card, {
        source: 'dependency_advisory',
        key: keys[0] ?? advisoryKey(project.id, name),
        kind: 'dependency_advisory',
        projectId: project.id,
        projectName: project.name,
        name,
        current: group[0]?.version ?? null,
        latest: update?.latest ?? null,
      });
      outcome.cards.push(raised);
      fresh.push(...keys);
    }

    const plan = applyRadarPolicy(separateAdvisories(updates, advisoryFeed.value));

    // A10's breaking branch: one card each, capped (decision 5).
    let budget = routineCardBudget;
    let deferred = 0;
    for (const update of plan.breaking) {
      const key = dependencyKey(project.id, update);
      if (reported.has(key)) continue;
      if (budget <= 0) {
        deferred += 1;
        continue;
      }
      budget -= 1;
      const raised = await this.raise(majorUpdateCard(update, project.name), {
        source: 'dependency_major',
        key,
        kind: 'dependency_major',
        projectId: project.id,
        projectName: project.name,
        name: update.name,
        current: update.current,
        latest: update.latest,
      });
      outcome.cards.push(raised);
      fresh.push(key);
    }
    if (deferred > 0) {
      outcome.limits.push(
        `Abhängigkeits-Radar: ${deferred} weitere Hauptversion(en) in «${project.slug}» warten ` +
          `auf den nächsten Lauf — höchstens ${MAX_ROUTINE_CARDS_PER_RUN} solche Karten je Lauf.`,
      );
    }

    // A10's routine branch: exactly one task for all of them, and no card.
    const routine = plan.routine.filter(
      (update) => !reported.has(dependencyKey(project.id, update)),
    );
    if (routine.length > 0) {
      const spec = routineUpdateTask(routine, project.name);
      const task = await this.deps.tasks.create({
        projectId: project.id,
        title: spec.title,
        description: spec.description,
        acceptanceCriteria: spec.acceptanceCriteria,
        priority: spec.priority,
        department: 'Research/Radar',
        type: 'radar',
        actor: RADAR_ACTOR,
      });
      outcome.tasks.push(task.id);
      for (const update of routine) fresh.push(dependencyKey(project.id, update));
      if (project.readOnly) {
        outcome.limits.push(
          `Die Update-Aufgabe für «${project.slug}» wartet: das Projekt ist nach A85 ` +
            'schreibgeschützt, der Ablaufplaner überspringt es.',
        );
      }
    }

    return budget;
  }

  // ------------------------------------------------------------ decision 7 ---

  /** Carry out every answered radar card that has not been carried out yet. */
  private async applyAnswers(): Promise<AppliedRadarAnswer[]> {
    const applied: AppliedRadarAnswer[] = [];
    for (const row of await this.pendingAnswers()) {
      try {
        applied.push(await this.remember(await this.applyOne(row)));
      } catch (error) {
        // Nothing remembered, so the next pass tries again — the same direction
        // `SourceProposals.applyAnswers` takes and for the same reason.
        applied.push({
          escalationNumber: row.number,
          outcome: 'uebersprungen',
          detail: `Nicht ausführbar: ${message(error)}`,
          taskId: null,
        });
      }
    }
    return applied;
  }

  private async applyOne(row: PendingRow): Promise<AppliedRadarAnswer> {
    const base = { escalationNumber: row.number, taskId: null };

    if (row.chosenIndex === null) {
      // Decision 7: prose is not consent.
      return {
        ...base,
        outcome: 'unentschieden',
        detail:
          'Die Antwort war reiner Freitext und nennt damit keine der Optionen. Aus Prosa ' +
          'herauszulesen, ob aktualisiert werden soll, wäre geraten (§1 Prinzip 6).',
      };
    }
    if (row.chosenIndex !== RADAR_APPROVE_INDEX) {
      return {
        ...base,
        outcome: 'abgelehnt',
        detail: `Gewählt wurde «${row.chosenTitle ?? `Option ${row.chosenIndex}`}» — kein Update.`,
      };
    }
    if (row.name === null || row.latest === null || row.projectId === null) {
      return {
        ...base,
        outcome: 'uebersprungen',
        detail:
          'Die gespeicherte Karte nennt kein Paket mit Zielversion, also gibt es nichts ' +
          'anzulegen. (Eine Abrechnungskarte kommt hier nicht an.)',
      };
    }

    const spec = approvedUpdateTask({
      name: row.name,
      current: row.current ?? 'unbekannt',
      latest: row.latest,
      projectName: row.projectName ?? row.projectId,
      escalationNumber: row.number,
      advisory: row.kind === 'dependency_advisory',
    });
    const task = await this.deps.tasks.create({
      projectId: row.projectId,
      title: spec.title,
      description: spec.description,
      acceptanceCriteria: spec.acceptanceCriteria,
      priority: spec.priority,
      department: 'Research/Radar',
      type: 'radar',
      actor: RADAR_ACTOR,
    });
    return {
      escalationNumber: row.number,
      outcome: 'aufgabe_angelegt',
      detail: `${row.name} → ${row.latest}`,
      taskId: task.id,
    };
  }

  /**
   * Answered cards this scan raised and has not acted on.
   *
   * The facts come out of the row the scan wrote, never out of the card's prose
   * — A112.1's rule: this repository does not parse its own sentences for facts
   * it could store.
   */
  private async pendingAnswers(): Promise<PendingRow[]> {
    const rows = await this.deps.sql<PendingSqlRow[]>`
      SELECT c.value ->> 'kind'        AS kind,
             c.value ->> 'projectId'   AS project_id,
             c.value ->> 'projectName' AS project_name,
             c.value ->> 'name'        AS name,
             c.value ->> 'current'     AS current,
             c.value ->> 'latest'      AS latest,
             e.number::text            AS number,
             e.chosen_index            AS chosen_index,
             e.chosen_title            AS chosen_title
      FROM event_log p
      CROSS JOIN LATERAL jsonb_array_elements(
        CASE WHEN jsonb_typeof(p.payload -> 'cards') = 'array'
             THEN p.payload -> 'cards' ELSE '[]'::jsonb END
      ) AS c
      JOIN escalations e ON e.id = (c.value ->> 'escalationId')::uuid
      WHERE p.kind = 'radar.finished'
        AND e.state = 'answered'
        AND NOT EXISTS (
          SELECT 1 FROM event_log a
          WHERE a.kind = 'radar.applied'
            AND a.payload ->> 'escalationNumber' = e.number::text
        )
      ORDER BY p.id ASC
      LIMIT ${MAX_APPLIED_PER_RUN}
    `;
    return rows.map((row) => ({
      kind: row.kind,
      projectId: row.project_id,
      projectName: row.project_name,
      name: row.name,
      current: row.current,
      latest: row.latest,
      number: Number(row.number),
      chosenIndex: row.chosen_index,
      chosenTitle: row.chosen_title,
    }));
  }

  /** Decision 1's second kind: written *after* the act (A86.4). */
  private async remember(applied: AppliedRadarAnswer): Promise<AppliedRadarAnswer> {
    await this.deps.eventLog.append({
      kind: 'radar.applied',
      actor: RADAR_ACTOR,
      payload: {
        escalationNumber: applied.escalationNumber,
        outcome: applied.outcome,
        detail: applied.detail,
        taskId: applied.taskId,
      },
    });
    return applied;
  }

  // ---------------------------------------------------------------- shared ---

  private async raise(
    card: RadarCard,
    facts: Omit<RaisedRadarCard, 'escalationId' | 'number'> & {
      source: 'billing_change' | 'dependency_major' | 'dependency_advisory';
    },
  ): Promise<RaisedRadarCard> {
    // Decision 8: raise only. The push, with its deep link, is the observer's.
    const record = await this.deps.escalations.raise({
      source: facts.source,
      urgency: card.urgency,
      question: card.question,
      context: card.context,
      options: card.options,
      projectId: facts.projectId,
      raisedBy: RADAR_ACTOR,
    });
    return {
      escalationId: record.id,
      number: record.number,
      key: facts.key,
      kind: facts.kind,
      projectId: facts.projectId,
      projectName: facts.projectName,
      name: facts.name,
      current: facts.current,
      latest: facts.latest,
    };
  }

  /** Every key this radar has already put in front of the operator (decision 4). */
  private async alreadyReported(): Promise<Set<string>> {
    const rows = await this.deps.sql<Array<{ reported: unknown }>>`
      SELECT payload -> 'reported' AS reported
      FROM event_log
      WHERE kind = 'radar.finished'
      ORDER BY id DESC
      LIMIT ${REPORTED_HISTORY_ROWS}
    `;
    const seen = new Set<string>();
    for (const row of rows) {
      if (!Array.isArray(row.reported)) continue;
      for (const key of row.reported) if (typeof key === 'string') seen.add(key);
    }
    return seen;
  }

  private async selfManagedProject(): Promise<ProjectRecord | null> {
    const projects = await this.deps.projects.listActive();
    return projects.find((project) => project.selfManaged) ?? null;
  }

  /** Written on every run, quiet ones included — it is the deadline. */
  private async record(outcome: RadarOutcome, fresh: readonly string[]): Promise<void> {
    await this.deps.eventLog.append({
      kind: 'radar.finished',
      actor: RADAR_ACTOR,
      payload: {
        at: this.deps.now?.() ?? Date.now(),
        reported: [...fresh],
        cards: outcome.cards,
        tasks: outcome.tasks,
        limits: outcome.limits,
        problems: outcome.problems,
        applied: outcome.applied.length,
      },
    });
  }
}

/**
 * How far back the dedup memory reads.
 *
 * Bounded rather than complete, and the direction of the error is stated: past
 * this many runs a very old finding could be announced a second time, which
 * costs one card. Reading the whole table instead would grow with the log that
 * §18 keeps forever. At six-hour runs this is roughly two months.
 */
const REPORTED_HISTORY_ROWS = 250;

interface PendingSqlRow {
  kind: string | null;
  project_id: string | null;
  project_name: string | null;
  name: string | null;
  current: string | null;
  latest: string | null;
  number: string;
  chosen_index: number | null;
  chosen_title: string | null;
}

interface PendingRow {
  kind: string | null;
  projectId: string | null;
  projectName: string | null;
  name: string | null;
  current: string | null;
  latest: string | null;
  number: number;
  chosenIndex: number | null;
  chosenTitle: string | null;
}

export function billingKey(signature: string): string {
  return `billing::${signature}`;
}

export function cliKey(version: string): string {
  return `cli::${version}`;
}

export function advisoryKey(projectId: string, advisoryId: string): string {
  return `advisory::${projectId}::${advisoryId}`;
}

/** Namespaced by project *and* target version, so "not now" re-asks later. */
export function dependencyKey(projectId: string, update: DependencyUpdate): string {
  return `dep::${projectId}::${update.name}::${update.latest}`;
}

function groupAdvisories(
  advisories: readonly AdvisoryFinding[],
): Array<[string, AdvisoryFinding[]]> {
  const byName = new Map<string, AdvisoryFinding[]>();
  for (const advisory of advisories) {
    const group = byName.get(advisory.name);
    if (group) group.push(advisory);
    else byName.set(advisory.name, [advisory]);
  }
  return [...byName.entries()].sort((a, b) => a[0].localeCompare(b[0]));
}

/** German (§2), one line, and it names the limits rather than only the finds. */
function summarise(outcome: RadarOutcome): string | null {
  const parts: string[] = [];
  if (outcome.cards.length > 0) {
    parts.push(
      `${outcome.cards.length} Karte(n): #${outcome.cards.map((c) => c.number).join(', #')}`,
    );
  }
  if (outcome.tasks.length > 0) parts.push(`${outcome.tasks.length} Aufgabe(n) angelegt`);
  const acted = outcome.applied.filter((entry) => entry.outcome === 'aufgabe_angelegt').length;
  if (acted > 0) parts.push(`${acted} beantwortete Karte(n) ausgeführt`);
  if (outcome.problems.length > 0) parts.push(`${outcome.problems.length} Problem(e)`);
  // Decision 2: the limits are reported even when nothing else happened, which
  // is precisely the run that would otherwise read as "everything is fine".
  if (outcome.limits.length > 0) parts.push(`${outcome.limits.length} ungeprüfte Fläche(n)`);
  if (parts.length === 0) return null;
  return `Radar: ${parts.join(' · ')}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
