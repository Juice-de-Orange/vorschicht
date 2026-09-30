/**
 * §12's deployment engine — the order, and everything that may stop it.
 *
 * §12 makes deployment automatic after a green merge, with a health check and
 * an automatic rollback. That is the most consequential unattended action this
 * system performs, so the shape here is chosen so that the dangerous parts are
 * the ones that are hardest to skip:
 *
 *  1. **Three refusals come before any artifact is built**, and each is a
 *     different kind of "not now": the guardian (§12: no new deploys in
 *     `wrap_up`/`hard_stop`), A12's approval for a self-deploy, and A24's stop
 *     for a migration the reviewer found not backward-compatible. All three
 *     leave the task in a state it can be resumed from rather than failing it —
 *     none of them is a statement about the change.
 *
 *  2. **A24's order is not a parameter.** migrate → swap → health, and the
 *     migration runs *after* the artifact exists and *before* anything serves
 *     it. The reason is asymmetry, not tidiness: a rollback restores the
 *     previous release's **code** and cannot undo what a migration did to the
 *     data, so the migration is the one step whose failure must happen while
 *     nothing has been swapped yet.
 *
 *  3. **The rollback is a deploy, not an inverse.** It swaps the last release
 *     that actually served *and was healthy* back in, then checks health again
 *     — because a rollback nobody verified is a second outage with a reassuring
 *     log line. `DeployRecords.lastGood` deliberately excludes the deployment
 *     being rolled back from, which is the one candidate that must never be the
 *     destination.
 *
 *  4. **Everything is recorded as it happens**, not summarised at the end. A
 *     deploy that crashes mid-swap must leave behind which step it reached; a
 *     record written once at the finish would leave exactly the interesting
 *     cases blank.
 *
 *  5. **The service never marks a task `done` on a rollback.** §12 says a
 *     rollback marks the merged change red, and §9's red path then applies —
 *     first red requeues, second escalates. The P0 card is raised *in addition*,
 *     because the two answer different questions: the card tells the operator production
 *     is on the previous release, the red path decides what happens to the work.
 */
import { readDeployConfig } from '@vorschicht/shared';
import type { EscalationService } from '../escalation-service.js';
import type { EventLog } from '../event-log.js';
import type { ProjectRecord } from '../project-service.js';
import type { Queryable } from '../sql.js';
import type { TaskRecord, TaskService } from '../task-service.js';
import type { DeployRecords } from './records.js';
import { type DeployTarget, type HealthProbe, httpHealthProbe } from './target.js';

export type DeployOutcome =
  /** Rolled out and healthy. The task is `done`. */
  | 'deployed'
  /** Health failed, the previous release is serving again. The task is red. */
  | 'rolled_back'
  /** Rolled back and the rollback *also* failed health. Production is unknown. */
  | 'rollback_failed'
  /**
   * The rollout broke and **nothing was rolled back** (A93).
   *
   * Three branches reach it: a migration that failed before the swap (the
   * previous release is still serving, so this is the mild one), a crash
   * anywhere in `deploy()` (production is in an unknown state), and a health
   * failure with no earlier good release to return to (the broken release is
   * what is serving). All three are `kind: 'failed'` in `deployment_events`;
   * this is the value the scheduler and the caller see, and until A93 it was
   * `rolled_back` — which said "we put it back" for three cases in which
   * nothing was put back, the worst of them being the one where production is
   * broken and there is no remedy.
   */
  | 'failed'
  /** Waiting for the operator — A12's approval or A24's migration stop. */
  | 'needs_decision'
  /** The guardian said not now. Nothing was touched. */
  | 'deferred'
  /** The method has no executor here. A scheduler defect, like A54.6's. */
  | 'unsupported';

export interface DeployResult {
  outcome: DeployOutcome;
  deploymentId: string | null;
  problem: string | null;
}

export interface DeployServiceDeps {
  /** A24's stop reads `gate.migration_review` from the event log. */
  sql: Queryable;
  records: DeployRecords;
  eventLog: EventLog;
  tasks: Pick<TaskService, 'transition' | 'get'>;
  escalations: Pick<EscalationService, 'raise' | 'latestForTask'>;
  /** Keyed by method — `none` never reaches here. */
  targets: Map<string, DeployTarget>;
  /** §12: no new deploys outside `normal`. */
  guardianState: () => Promise<'normal' | 'wrap_up' | 'hard_stop'>;
  health?: HealthProbe;
  now?: () => number;
  newId?: () => string;
  /** Runs a configured command as argv. Injected so a test needs no machine. */
  run: (
    projectRoot: string,
    command: string,
    argv: readonly string[],
  ) => Promise<{ ok: boolean; code: number | null; output: string }>;
}

/**
 * Welche Option einer Karte den Rollout **freigibt** (A93, A97).
 *
 * Eine Zahl und keine Titelsuche: der Titel ist deutscher Fließtext, den
 * jemand beim Umformulieren der Karte verbessert, und eine Freigabe, die an
 * einer Zeichenkette hängt, verfällt dabei stillschweigend in die eine
 * Richtung, die niemand bemerkt. Der Index steht neben den Optionen, die er
 * meint, und `service.itest.ts` prüft für **beide**, dass er auf die Option
 * zeigt, die er meint — sonst ist die Zahl dieselbe Falle eine Ebene tiefer.
 *
 * **Die beiden sind nicht dieselbe Zahl, und das ist der Grund für zwei
 * Konstanten statt einer.** Bei A12 steht „Ausrollen" oben, weil es die
 * empfohlene Option ist; bei A24 steht „Warten" oben, aus demselben Grund —
 * dort ist die Freigabe die *zweite*. Eine geteilte Konstante hätte genau die
 * Verwechslung festgeschrieben, die A97 gefunden hat.
 */
export const APPROVE_INDEX = 0;

/**
 * A24s Freigabe: „Trotzdem ausrollen — ich nehme das fehlende Zurück in Kauf".
 *
 * Die empfohlene Option dieser Karte ist die **erste** („Warten — ich mache
 * die Migration erst rückwärtskompatibel"), und bis A97 gab sie den Rollout
 * frei: das Studio empfahl warten, der Betreiber wählte warten, und die nicht
 * rückwärtskompatible Migration ging raus. Von den beiden Fällen dieser Klasse
 * war das der schärfere, weil er über den *empfohlenen* Weg lief.
 */
export const MIGRATION_APPROVE_INDEX = 1;

export class DeployService {
  private readonly health: HealthProbe;
  private readonly now: () => number;

  constructor(private readonly deps: DeployServiceDeps) {
    this.health = deps.health ?? httpHealthProbe;
    this.now = deps.now ?? Date.now;
  }

  /**
   * @param sha The commit being rolled out. **Required, and deliberately not
   * derived here.** The first version read `task.branch ?? 'HEAD'`, which was
   * wrong twice: `branch` is a *branch name* (`vorschicht/task-<id>`), never a
   * sha, and the merge queue releases the worktree with `deleteBranch: true`,
   * after which the `tasks` view projects it as NULL. So every deploy handed
   * over from a merge got `sha = 'HEAD'` — `deployments.sha` was worthless, the
   * artifact was `image:HEAD` for every release, and **the rollback became a
   * no-op**, because the previous release carried the same artifact id as the
   * broken one. Reported by the stream wiring this up; the merge already knows
   * the right value (`forwarded.head`) and now has to say it.
   */
  async deploy(task: TaskRecord, project: ProjectRecord, sha: string): Promise<DeployResult> {
    const config = readDeployConfig(project.deployConfig);
    if (config.method === 'none') {
      // The merge queue ends that pipeline itself (A24); reaching here means a
      // caller asked for something the configuration does not describe.
      return { outcome: 'unsupported', deploymentId: null, problem: 'Kein Deployment (A24)' };
    }

    const target = this.deps.targets.get(config.method);
    if (!target) {
      return {
        outcome: 'unsupported',
        deploymentId: null,
        problem: `Für die Methode "${config.method}" ist kein Ziel registriert.`,
      };
    }

    const guardian = await this.deps.guardianState();
    if (guardian !== 'normal') {
      // §12: no new deploys in wrap-up or hard-stop. The task stays where it is
      // and the next tick asks again — deferring is not a verdict on the change.
      return {
        outcome: 'deferred',
        deploymentId: null,
        problem: `Wächter steht auf "${guardian}" — kein neues Deployment (§12).`,
      };
    }

    const blocked = await this.awaitingDecision(task, project);
    if (blocked) return blocked;

    const deploymentId = this.deps.newId?.() ?? crypto.randomUUID();
    const context = {
      sha,
      projectRoot: project.rootPath,
      config,
      run: (command: string, argv: readonly string[]) =>
        this.deps.run(project.rootPath, command, argv),
    };

    await this.deps.records.start({
      deploymentId,
      projectId: project.id,
      taskId: task.id,
      sha,
      method: config.method,
      actor: 'orchestrator',
    });

    try {
      const artifact = await target.prepare(context);

      // A24: migrations first, and only then does anything serve the new code.
      if (config.migrateCommand) {
        const result = await context.run(config.migrateCommand, []);
        await this.deps.records.append(deploymentId, 'migrated', 'orchestrator', {
          ok: result.ok,
          output: result.output,
        });
        if (!result.ok) {
          return await this.fail(
            deploymentId,
            task,
            project,
            'previous',
            `Die Migration ist fehlgeschlagen, bevor etwas getauscht wurde: ${result.output}`,
          );
        }
      }

      await target.swap(context, artifact);
      await this.deps.records.append(deploymentId, 'swapped', 'orchestrator', {
        artifact: artifact.id,
      });

      const health = await this.poll(
        config.healthUrl,
        config.healthTimeoutMs,
        config.healthIntervalMs,
      );
      await this.deps.records.append(deploymentId, 'health_checked', 'orchestrator', health);

      if (!health.ok) {
        return await this.rollback(deploymentId, task, project, target, context, health.detail);
      }

      if (config.smokeCommand) {
        const smoke = await context.run(config.smokeCommand, []);
        await this.deps.records.append(deploymentId, 'smoke_checked', 'orchestrator', {
          ok: smoke.ok,
          output: smoke.output,
        });
        if (!smoke.ok) {
          return await this.rollback(deploymentId, task, project, target, context, smoke.output);
        }
      }

      const removed = await target.prune(context, config.keep);
      await this.deps.records.append(deploymentId, 'succeeded', 'orchestrator', {
        artifact: artifact.id,
        pruned: removed,
      });
      await this.deps.eventLog.append({
        kind: 'deploy.succeeded',
        actor: 'orchestrator',
        projectId: project.id,
        taskId: task.id,
        payload: { deploymentId, sha, artifact: artifact.id, method: config.method },
      });
      await this.deps.tasks.transition(task.id, 'done', {
        actor: 'orchestrator',
        reason: `Ausgerollt und gesund (${config.method}, ${artifact.id})`,
        payload: { deploymentId },
      });
      return { outcome: 'deployed', deploymentId, problem: null };
    } catch (error) {
      // A crash mid-deploy leaves production in an unknown state, which is the
      // one thing that must never be silent — but it is *not* a rollback, and
      // saying so is the difference between "we put it back" and "we do not
      // know what is serving".
      return await this.fail(deploymentId, task, project, 'unknown', (error as Error).message);
    }
  }

  /**
   * A12 — the self-deploy approval. A24's stop runs first, in `migrationStop`.
   *
   * Both check for an **answered** escalation first, because this runs again on
   * every tick: without that, an approved self-deploy would raise a second card
   * the moment the scheduler came back round, and §15's inbox would fill with
   * the same question.
   *
   * **But "answered" is not "approved" (A93).** The first version released the
   * rollout on `state === 'answered'` alone, which reads *whether* the operator replied
   * and not *what* he replied — so picking "Noch nicht — später von Hand", the
   * option written for exactly this, authorised the deploy. A12 is one of the
   * sharpest rules in the spec ("an autonomous system must not hot-swap its own
   * brain unsupervised"), and it was defeated by the answer that says no.
   *
   * So approval is `chosenIndex === APPROVE_INDEX`, and everything else —
   * option 2, or a free-text answer, which §15 always permits — is **not**
   * approval. Free text is the interesting one: "ja mach" and "auf keinen Fall"
   * are both free text, and inferring intent from prose is a guess about the
   * most consequential unattended action this system performs (§1 principle 6).
   * The card says so in its own text, so the rule is visible where the decision
   * is made rather than only here.
   */
  private async awaitingDecision(
    task: TaskRecord,
    project: ProjectRecord,
  ): Promise<DeployResult | null> {
    const migration = await this.migrationStop(task, project);
    if (migration) return migration;

    if (!project.selfManaged) return null;

    const latest = await this.deps.escalations.latestForTask(task.id);
    if (latest?.source === 'self_deploy' && latest.state === 'answered') {
      if (latest.chosenIndex === APPROVE_INDEX) return null;
      // Answered, and the answer was not "roll out". The task stays parked and
      // no second card is raised: he has decided, and asking again every tick
      // would be the inbox spam the `answered` check exists to prevent.
      return {
        outcome: 'needs_decision',
        deploymentId: null,
        problem:
          `Entscheidung #${latest.number} ist beantwortet, aber nicht mit „Ausrollen" ` +
          `(${latest.chosenTitle ?? 'Freitextantwort'}) — A12 gibt den Selbst-Deploy nicht frei.`,
      };
    }
    if (latest?.source === 'self_deploy' && latest.state === 'open') {
      return {
        outcome: 'needs_decision',
        deploymentId: null,
        problem: `Wartet auf Entscheidung #${latest.number} (A12).`,
      };
    }

    const escalation = await this.deps.escalations.raise({
      source: 'self_deploy',
      question: `Soll Vorschicht sich selbst auf den Stand von "${task.title}" ausrollen?`,
      context:
        'Ein Merge in dieses Repository ist grün durch alle Gates gegangen. §12 rollt danach ' +
        'automatisch aus — außer bei Vorschicht selbst: A12 behält jeden Selbst-Deploy dir vor, ' +
        'weil ein autonomes System sein eigenes Gehirn nicht unbeaufsichtigt tauscht. Bis du ' +
        'antwortest, bleibt die Aufgabe stehen und hält ihre Claims; die Produktion läuft ' +
        'unverändert weiter. **Nur „Ausrollen" gibt frei** — die zweite Option und jede ' +
        'Freitextantwort lassen den Server, wo er ist. Absicht: aus Prosa herauszulesen, ob ' +
        'du zugestimmt hast, wäre bei genau dieser Frage geraten.',
      options: [
        {
          title: 'Ausrollen',
          pros: ['Der Server läuft auf dem geprüften Stand'],
          cons: ['Ein Neustart unterbricht laufende Sitzungen kurz'],
          recommended: true,
        },
        {
          title: 'Noch nicht — später von Hand',
          pros: ['Du wählst den Zeitpunkt'],
          cons: ['Der Server hinkt bis dahin hinter dem Repository her'],
          recommended: false,
        },
      ],
      urgency: 'P2',
      projectId: project.id,
      taskId: task.id,
      runId: null,
      raisedBy: 'orchestrator',
    });

    await this.deps.tasks.transition(task.id, 'needs_decision', {
      actor: 'orchestrator',
      reason: `Selbst-Deploy braucht deine Freigabe (A12) — Entscheidung #${escalation.number}`,
      payload: { escalationId: escalation.id, number: escalation.number },
    });

    return {
      outcome: 'needs_decision',
      deploymentId: null,
      problem: `Freigabe erbeten als Entscheidung #${escalation.number} (A12).`,
    };
  }

  /**
   * A24's stop — the refusal this file's header claimed for a day before it
   * existed.
   *
   * §12: *"if the migration review (Milo) flags a non-backward-compatible
   * migration, the deploy **stops and escalates** instead of auto-deploying —
   * safety over automation."* The reason is the asymmetry the order above
   * already turns on, one step further out: a rollback restores the previous
   * release's **code**, so a migration that the previous code cannot read makes
   * the rollback itself the outage. Automation is fine right up to the point
   * where its undo does not work, and this is that point.
   *
   * The verdict is read from `gate.migration_review`, which `MigrationReview`
   * has been writing since Phase 3 with a comment saying **"§12/A24 reads this
   * one"** — and until now nothing did. A63.7 recorded that producer as one
   * that becomes dead wiring "if Phase 5 forgets", and Phase 5 nearly did: the
   * header of this file listed three refusals while `awaitingDecision`
   * implemented two, in three separate comments, for a day. §8.2's sixth
   * domain, in the file written to hold §12's order.
   *
   * **A missing review is not a stop.** Most projects have no migration gate at
   * all, and treating silence as "not backward compatible" would park every
   * deploy of every project that never enabled it. The gate's absence is
   * answered by the gate's own configuration, not here.
   */
  private async migrationStop(
    task: TaskRecord,
    project: ProjectRecord,
  ): Promise<DeployResult | null> {
    const [row] = await this.deps.sql<Array<{ backward_compatible: boolean | null }>>`
      SELECT (payload ->> 'backwardCompatible')::boolean AS backward_compatible
      FROM event_log
      WHERE kind = 'gate.migration_review' AND task_id = ${task.id}
      ORDER BY id DESC LIMIT 1
    `;
    if (row?.backward_compatible !== false) return null;

    // Same shape as A12's approval, and for the same reason: this runs on every
    // tick, so an answered card must not raise a second one.
    const latest = await this.deps.escalations.latestForTask(task.id);
    if (latest?.source === 'migration_stop' && latest.state === 'answered') {
      // A97 — dieselbe Verwechslung wie bei A12, und hier die gefährlichere:
      // die **empfohlene** Option dieser Karte ist „Warten", und sie gab den
      // Rollout frei. Das Studio empfahl warten, der Betreiber wählte warten, und die
      // Migration ohne Rückweg ging raus. Freigabe ist ausschließlich
      // „Trotzdem ausrollen"; alles andere, Freitext eingeschlossen, hält an.
      if (latest.chosenIndex === MIGRATION_APPROVE_INDEX) return null;
      return {
        outcome: 'needs_decision',
        deploymentId: null,
        problem:
          `Entscheidung #${latest.number} ist beantwortet, aber nicht mit „Trotzdem ausrollen" ` +
          `(${latest.chosenTitle ?? 'Freitextantwort'}) — A24 hält den Rollout an.`,
      };
    }
    if (latest?.source === 'migration_stop' && latest.state === 'open') {
      return {
        outcome: 'needs_decision',
        deploymentId: null,
        problem: `Wartet auf Entscheidung #${latest.number} (A24).`,
      };
    }

    const escalation = await this.deps.escalations.raise({
      // Its own source, not `rollback`: this rollout never happened, and folding
      // the two would make §16's "how often did we roll back" count deploys that
      // never touched production.
      source: 'migration_stop',
      question: `Die Migration von "${task.title}" ist nicht rückwärtskompatibel — trotzdem ausrollen?`,
      context:
        'Milos Migrationsprüfung hat festgestellt, dass diese Änderung das Schema so ' +
        'verändert, dass die **vorherige** Version des Codes damit nicht mehr arbeiten kann. ' +
        'Der Merge ist korrekt durchgelaufen — §11 hat nichts dagegen. Was §12 hier anhält, ' +
        'ist der Rollout: ein Rollback stellt den *Code* der vorherigen Version wieder her ' +
        'und kann nicht rückgängig machen, was eine Migration mit den Daten getan hat. Es ' +
        'gäbe also kein Zurück mehr. Bis du antwortest, bleibt die Aufgabe stehen und die ' +
        'Produktion läuft unverändert weiter. **Nur „Trotzdem ausrollen" gibt frei** — die ' +
        'erste Option und jede Freitextantwort halten den Rollout an.',
      options: [
        {
          title: 'Warten — ich mache die Migration erst rückwärtskompatibel',
          pros: ['Der Rollback bleibt möglich', 'Kein Zeitdruck bei der Entscheidung'],
          cons: ['Die Änderung liegt bis dahin auf Eis'],
          recommended: true,
        },
        // Die Reihenfolge ist bindend: `MIGRATION_APPROVE_INDEX` zeigt auf die
        // zweite Option, und `service.itest.ts` prüft, dass dort wirklich
        // „Trotzdem ausrollen" steht. Wer hier umsortiert, gibt sonst „Warten"
        // frei — genau der Fehler, den A97 behoben hat.
        {
          title: 'Trotzdem ausrollen — ich nehme das fehlende Zurück in Kauf',
          pros: ['Die Änderung ist sofort draußen'],
          cons: [
            'Ab dem Rollout gibt es keinen automatischen Weg zurück',
            'Ein Fehler in dieser Version braucht dann dich und eine Datensicherung',
          ],
          recommended: false,
        },
      ],
      // Nothing is on fire: production is serving the old version and will keep
      // doing so until he answers. §15 reserves P0 for what burns without him.
      urgency: 'P1',
      projectId: project.id,
      taskId: task.id,
      runId: null,
      raisedBy: 'orchestrator',
    });

    await this.deps.tasks.transition(task.id, 'needs_decision', {
      actor: 'orchestrator',
      reason:
        'Nicht rückwärtskompatible Migration — der Rollout wartet auf deine Freigabe (A24, §12), ' +
        `Entscheidung #${escalation.number}`,
      payload: { escalationId: escalation.id, number: escalation.number },
    });

    return {
      outcome: 'needs_decision',
      deploymentId: null,
      problem: `Nicht rückwärtskompatible Migration, erbeten als Entscheidung #${escalation.number} (A24).`,
    };
  }

  /** §12: back to the last release that served and was healthy, then verify. */
  private async rollback(
    deploymentId: string,
    task: TaskRecord,
    project: ProjectRecord,
    target: DeployTarget,
    context: Parameters<DeployTarget['swap']>[0],
    detail: string,
  ): Promise<DeployResult> {
    const previous = await this.deps.records.lastGood(project.id);
    if (!previous?.artifact) {
      // Nothing to go back to — the first release of a project is the case, and
      // pretending otherwise would swap in something that does not exist.
      return await this.fail(
        deploymentId,
        task,
        project,
        'broken',
        `Gesundheitsprüfung fehlgeschlagen (${detail}) und es gibt kein früheres gesundes ` +
          'Release, auf das zurückgefallen werden könnte.',
      );
    }

    await target.swap(context, { id: previous.artifact, sha: previous.sha });
    const after = await this.poll(
      context.config.method === 'none' ? '' : context.config.healthUrl,
      context.config.method === 'none' ? 0 : context.config.healthTimeoutMs,
      context.config.method === 'none' ? 0 : context.config.healthIntervalMs,
    );

    await this.deps.records.append(deploymentId, 'rolled_back', 'orchestrator', {
      rolledBackTo: previous.id,
      artifact: previous.artifact,
      problem: detail,
      healthAfter: after,
    });

    await this.deps.eventLog.append({
      kind: 'deploy.rolled_back',
      actor: 'orchestrator',
      projectId: project.id,
      taskId: task.id,
      payload: { deploymentId, rolledBackTo: previous.id, problem: detail, healthAfter: after },
    });

    await this.raiseRollbackCard(project, task, previous.artifact, detail, after);

    // §12: a rollback also marks the merged change red, and §9's red path takes
    // it from there. Deliberately not `done` and deliberately not `aborted` —
    // the change is not fine and it is not withdrawn, it needs another attempt.
    await this.deps.tasks.transition(task.id, 'red', {
      actor: 'orchestrator',
      reason: `Rollback nach fehlgeschlagener Gesundheitsprüfung: ${detail}`,
      payload: { deploymentId, rolledBackTo: previous.id },
    });

    return {
      outcome: after.ok ? 'rolled_back' : 'rollback_failed',
      deploymentId,
      problem: detail,
    };
  }

  private async raiseRollbackCard(
    project: ProjectRecord,
    task: TaskRecord,
    artifact: string,
    detail: string,
    after: { ok: boolean; detail: string },
  ): Promise<void> {
    const healthy = after.ok
      ? `Die vorherige Version (${artifact}) läuft wieder und ist gesund.`
      : `**Auch das Zurückrollen ist nicht gesund geworden** (${after.detail}) — der Zustand der ` +
        'Produktion ist damit ungeklärt und das ist der dringende Teil.';
    await this.deps.escalations.raise({
      source: 'rollback',
      question: `Deployment von "${project.slug}" ist zurückgerollt worden — wie weiter?`,
      context:
        `Der Rollout der Aufgabe „${task.title}" hat die Gesundheitsprüfung nicht bestanden: ` +
        `${detail}. ${healthy} Die Aufgabe ist nach §9 rot markiert und läuft den roten Pfad; ` +
        'du musst dafür nichts tun. Was hier zu entscheiden ist, betrifft die Produktion.',
      options: [
        {
          title: 'So lassen — der rote Pfad kümmert sich',
          pros: ['Die vorherige Version läuft', 'Ein zweiter Fehlschlag kommt mit Diagnose zu dir'],
          cons: ['Bis dahin liegt die Änderung auf Eis'],
          recommended: after.ok,
        },
        {
          title: 'Ich sehe mir den Server selbst an',
          pros: ['Bei ungeklärtem Zustand die einzige verlässliche Antwort'],
          cons: ['Kostet dich Zeit'],
          recommended: !after.ok,
        },
      ],
      /*
       * **P0, ausser der Rollback kam selbst gesund zurück — dann P1** (A133).
       *
       * Die Geschichte dieser Zeile gehört dazu, weil sie zweimal die Richtung
       * gewechselt hat und beide Male aus einem guten Grund. Der erste Anlauf
       * meldete P1 im gesunden Fall, mit §15s Lesart von P0 („brennt ohne ihn")
       * als Begründung. A96 hat das zurückgenommen: §12 sagte in einem Satz
       * „escalate with full logs (P0 inbox item + ntfy)", ohne
       * Fallunterscheidung, und §0.3 verbietet, ein Gate abzuschwächen, damit es
       * passt — das Urteil war vertretbar und stand mir nicht zu.
       *
       * Am 17.8.2026 hat der Betreiber §12 geändert und die Unterscheidung angeordnet.
       * Damit ist es keine Abschwächung mehr, sondern der Wortlaut: die
       * Spezifikation trifft die Unterscheidung, die Umsetzung folgt ihr. Der
       * Unterschied zu A96 ist nicht das Ergebnis, sondern wer entschieden hat.
       *
       * Verloren geht nichts: welcher der beiden Fälle eintrat, steht weiterhin
       * im Text der Karte (`healthy` oben), und der ist das, was ein Mensch um
       * drei Uhr nachts liest. Die Dringlichkeit steuert nur, wie laut es
       * klingelt.
       */
      urgency: after.ok ? 'P1' : 'P0',
      projectId: project.id,
      taskId: null,
      runId: null,
      raisedBy: 'orchestrator',
    });
  }

  /**
   * The three endings that are neither a success nor a rollback (A93).
   *
   * `serving` is what production is doing **now**, and it is a required
   * argument rather than something derived here, because only the call site
   * knows: a migration that failed before the swap left the previous release
   * untouched, a crash left the state unknown, and a health failure with
   * nothing to fall back to left the broken release serving. The three differ
   * in exactly one respect that matters to a human — whether anything is on
   * fire — so they differ in urgency, and the card says which case it is.
   *
   * §12 escalates a rollback "with full logs"; two of these are *worse* than a
   * rollback, because the automatic remedy did not run. Until A93 none of them
   * raised anything at all: the task went red, the scheduler was told
   * `rolled_back`, and nobody was notified.
   */
  private async fail(
    deploymentId: string,
    task: TaskRecord,
    project: ProjectRecord,
    serving: 'previous' | 'unknown' | 'broken',
    problem: string,
  ): Promise<DeployResult> {
    await this.deps.records.append(deploymentId, 'failed', 'orchestrator', { problem, serving });
    /*
     * **Die Zeile im Ereignisprotokoll, die dieser Pfad bis zum 18.8.2026 nicht
     * schrieb.**
     *
     * Der Dienst hatte genau zwei `eventLog.append`: `deploy.succeeded` und
     * `deploy.rolled_back`. Ein Rollout, der scheiterte und *nicht*
     * zurückgerollt werden konnte — der schwerwiegendste Betriebsfall, den §12
     * kennt —, hinterliess im Protokoll **nichts**. `deployment_events` trug
     * ihn, die Eskalation auch, aber §18 macht `event_log` zur Wahrheitsquelle,
     * und §16s Kopfzahlen werden daraus gerechnet.
     *
     * Die Folge war eine Zahl, die stimmt und trotzdem falsch ist: der
     * Wochenbericht hätte „3 Deploys, 0 Rollbacks" gemeldet, während eine
     * Produktion die kaputte Version bediente. Gefunden vom Strang, der §16s
     * Kennzahlen baute — er konnte diese Grösse nicht herleiten und hat gesagt
     * warum, statt sie zu schätzen.
     *
     * Eigene Art statt `deploy.rolled_back`, aus A93.4s Grund eine Ebene
     * tiefer: ein Rollout, der *nicht* zurückgerollt werden konnte, ist kein
     * Rollback, und eine gemeinsame Art beantwortete „wie oft haben wir
     * zurückgerollt" mit einer Zahl, die etwas anderes meint. `serving` reist
     * mit, weil es die eine Angabe ist, die einen Menschen um drei Uhr nachts
     * interessiert.
     */
    await this.deps.eventLog.append({
      kind: 'deploy.failed',
      actor: 'orchestrator',
      projectId: project.id,
      taskId: task.id,
      payload: { deploymentId, serving, problem },
    });
    await this.deps.tasks.transition(task.id, 'red', {
      actor: 'orchestrator',
      reason: `Deployment fehlgeschlagen: ${problem}`,
      payload: { deploymentId, serving },
    });
    await this.raiseFailureCard(project, task, serving, problem);
    return { outcome: 'failed', deploymentId, problem };
  }

  private async raiseFailureCard(
    project: ProjectRecord,
    task: TaskRecord,
    serving: 'previous' | 'unknown' | 'broken',
    problem: string,
  ): Promise<void> {
    // The whole point of the parameter: what a human has to know first.
    const lage = {
      previous:
        'Getauscht wurde **nichts** — die bisherige Version läuft unverändert weiter. ' +
        'Das ist der harmlose Fall dieser drei.',
      unknown:
        '**Was gerade ausgeliefert wird, ist ungeklärt** — der Rollout ist mitten im ' +
        'Ablauf abgebrochen, und ob der Tausch davor stattgefunden hat, geht aus dem ' +
        'Fehler nicht hervor.',
      broken:
        '**Die kaputte Version bedient die Produktion** — die Gesundheitsprüfung ist ' +
        'fehlgeschlagen, und es gibt kein früheres gesundes Release, auf das ' +
        'zurückgefallen werden könnte. Automatisch ist hier nichts mehr zu holen.',
    }[serving];

    await this.deps.escalations.raise({
      source: 'deploy_failed',
      question: `Rollout von "${project.slug}" ist gescheitert, ohne Rückweg — wie weiter?`,
      context:
        `Der Rollout der Aufgabe „${task.title}" ist gescheitert: ${problem} ${lage} ` +
        'Die Aufgabe ist nach §9 rot markiert und läuft den roten Pfad; dafür musst du ' +
        'nichts tun. Zu entscheiden ist, was mit der Produktion geschieht.',
      options: [
        {
          title: 'So lassen — der rote Pfad kümmert sich um die Änderung',
          pros: ['Kostet dich nichts', 'Ein zweiter Fehlschlag kommt mit Diagnose zu dir'],
          cons:
            serving === 'previous'
              ? ['Bis dahin liegt die Änderung auf Eis']
              : ['Die Produktion bleibt in diesem Zustand, bis du oder der rote Pfad sie ändert'],
          recommended: serving === 'previous',
        },
        {
          title: 'Ich sehe mir den Server selbst an',
          pros: ['Bei ungeklärtem oder kaputtem Zustand die einzige verlässliche Antwort'],
          cons: ['Kostet dich Zeit'],
          recommended: serving !== 'previous',
        },
      ],
      // Same rule as the rollback card: P0 is what is on fire without him. A
      // migration that stopped before the swap is not; the other two are.
      urgency: serving === 'previous' ? 'P1' : 'P0',
      projectId: project.id,
      taskId: null,
      runId: null,
      raisedBy: 'orchestrator',
    });
  }

  /**
   * Poll until healthy or the budget runs out (§12).
   *
   * The first probe happens immediately rather than after one interval: a
   * service that was already up should not cost a deploy its interval, and the
   * timeout is what bounds the unhappy case.
   */
  private async poll(
    url: string,
    timeoutMs: number,
    intervalMs: number,
  ): Promise<{ ok: boolean; detail: string }> {
    const deadline = this.now() + timeoutMs;
    let last = { ok: false, detail: 'nie geprüft' };
    for (;;) {
      last = await this.health(url);
      if (last.ok) return last;
      if (this.now() >= deadline) {
        return { ok: false, detail: `${last.detail} (Zeitgrenze ${timeoutMs} ms erreicht)` };
      }
      await new Promise((done) => setTimeout(done, intervalMs));
    }
  }
}
