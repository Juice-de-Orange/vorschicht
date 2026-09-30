/**
 * Die Ereignisarten, die über den SSE-Strom laufen — und warum sie hier liegen.
 *
 * `formatEvent` schreibt auf **jeden** Rahmen `event: <art>`; es gibt auf
 * diesem Strom keinen einzigen unbenannten Datenrahmen. Nach der
 * EventSource-Spezifikation feuert `onmessage` aber ausschliesslich für Rahmen
 * des Typs `message` — ein Client, der `onmessage` benutzt, ist verbunden und
 * bekommt **nichts**. Genau so stand `Overview.tsx` seit Phase 1: „Verlauf
 * (live)" mit dauerhaft „Noch nichts passiert.", und kein Test wurde davon rot
 * (A123).
 *
 * Die Liste stand bis dahin in `@vorschicht/core`, das ein Browser nicht laden
 * kann (Drizzle, pg-boss, `node:*`). Eine Seite konnte also gar nicht
 * abonnieren, was sie abonnieren müsste. Sie liegt jetzt hier, im
 * browser-sicheren Subpfad, und `core` bezieht sie von hier — **eine**
 * Deklaration, weil zwei unabhängige Listen genau die Klasse sind, die A81
 * beschreibt: der Server sendet eine Art, die der Client nicht abonniert, und
 * niemandem fällt es auf.
 */
export const EVENT_KINDS = [
  'system.started',
  'system.stopped',
  'system.selfcheck_failed',
  'auth.incident',
  'guardian.state_changed',
  'guardian.anomaly',
  'usage.sampled',
  'run.created',
  'run.started',
  'run.finished',
  'run.interrupted',
  'task.created',
  'task.state_changed',
  /** §9's red path: the work did not get done. Never an infra or auth failure. */
  'task.failed',
  /** §9: the second failure. Carries the Debugger's diagnosis when there is one. */
  'task.escalated',
  /** One pass of §8.1's Planner → Coder → Reviewer chain, and how it ended. */
  'chain.finished',
  /** §7.2's re-check on a worktree an interrupt cut off. The only way out of `interrupted`. */
  'task.integrity_checked',
  /**
   * The scheduler was asked for something impossible (A54.6, A57).
   *
   * Not a task failure and never on the red path: a task in a state its handler
   * refuses to start from is a defect in the dispatcher, and the task is put
   * aside rather than blamed. Recorded because an in-memory quarantine is
   * invisible otherwise, and an invisible quarantine is a task that stopped
   * moving for no reason anybody can find.
   */
  'scheduler.defect',
  'worktree.created',
  'worktree.released',
  'worktree.gc',
  'claims.acquired',
  'claims.released',
  /** An agent named a defect through the MCP channel (§11). Always a blocker. */
  'finding.reported',
  /**
   * An agent prepared a decision for the operator (§6.4).
   *
   * Distinct from `escalation.raised`, and the pair carries information neither
   * does alone: an agent asked, and *then* either an inbox item exists or §15's
   * policy memory answered the question from a decision the operator already made. The
   * second case emits `escalation.precedent_applied` and no item at all, so
   * "how often did the studio avoid asking twice" is a countable fact rather
   * than an absence.
   */
  'escalation.requested',
  /** An inbox item exists and is waiting (§15). Carries its permanent number. */
  'escalation.raised',
  /** The operator decided. The decision joins the policy memory the next agent searches. */
  'escalation.answered',
  /** The question had already been answered; the decision was applied instead (§15). */
  'escalation.precedent_applied',
  /**
   * §6.4's round trip closed: the parked session went back to work.
   *
   * Its own kind rather than a note, because it is the only durable statement
   * that an answer in the inbox *reached* the session that asked. `answered`
   * says the operator decided; without this one, whether the studio then acted on it is
   * an inference from the absence of a stuck task — and an inference is exactly
   * what §18's traceability chain is not allowed to end in.
   */
  'escalation.resumed',
  /**
   * §15's push went out for one item: "ntfy push immediately on creation".
   *
   * The same role `escalation.reminded` plays for A13, and for the same reason:
   * the rule is idempotent only because something remembers that it already
   * fired, and the tick that runs it comes round every few seconds. Without this
   * row the operator's phone would repeat every open decision until he answered it —
   * §15's guarantee turned into the thing that makes the channel unusable. So it
   * is not observability that happens to be useful; it is the memory the policy
   * reads (`EscalationPushService`).
   *
   * In `event_log` rather than in `escalation_events` for the reason given
   * below (0016 numbers the raise `seq = 1` and the answer as the only other
   * row), and it carries the deep link that was sent — so "was the link the operator got
   * the right one" is answerable from the record rather than from the code.
   */
  'escalation.pushed',
  /**
   * A13's reminder went out for one item, over one channel.
   *
   * Its own kind, and in *this* log rather than in `escalation_events`, because
   * 0016 numbers an escalation's own events `seq = 1` for the raise with the
   * answer as the only other row — an arbitrary number of reminders in between
   * does not fit that scheme. It is also the row that makes the rule
   * idempotent: A13 says "unanswered > 24h → reminder", and without a record
   * that one already went out the tick sends another every few seconds. So this
   * is not observability that happens to be useful; it is the memory the policy
   * reads (`EscalationMailService`).
   */
  'escalation.reminded',
  /** A13's daily digest went out, and which items it covered. Same role. */
  'escalation.digest_sent',
  'gate.finished',
  /**
   * §11's migration gate answered (A63).
   *
   * Its own kind rather than a field on `gate.finished`, because it is the one
   * gate whose result is read *after* the merge: §12/A24 has the deploy engine
   * stop and escalate on a migration that is not backward-compatible, and
   * `backwardCompatible: false` deliberately does not block the merge. A payload
   * buried in a gate summary would be a fact nobody could query for.
   */
  'gate.migration_review',
  'merge.finished',
  /**
   * A25's second half: an infra failure that stopped being transient.
   *
   * "Infra failures retry up to 3× with backoff and never count as red;
   * persistent infra failure → Ops alert, task stays queued." The retry is
   * inside `GateSuite`; this is what is left over when the retry did not help
   * across several whole merge attempts — a machine that is not coming back on
   * its own, and the one outcome of A25 that must reach a human. Its own kind
   * rather than a warning line, because "how often did the studio sit blocked
   * on a machine" is a question the weekly report will want to count.
   */
  'ops.alert',
  /**
   * A scheduled scan finished (§6.6's transcript sweep first; §6.0's radar and
   * A30's disk watch join it in Phase 6).
   *
   * Its own kind rather than a field on `ops.alert`, because a scan that found
   * **nothing** is the common case and the one this record exists for: it is
   * the marker the next run resumes from, and §8.2's sixth domain asks "did
   * this ever run", which only a row for the quiet case can answer. It carries
   * the deduplication memory too — a nightly job is rarer than a restart, and a
   * deploy is a restart (A57), so the memory cannot live in the process.
   *
   * What it never carries is a match. §6.6's scan finds credentials; the class
   * and the file are recorded, the secret is not, because §18 keeps this table
   * forever and a secret quoted here is the same secret in a second place (A21).
   */
  'scan.finished',
  /**
   * §6.0's, A27's and A10's radar ran (§22 Phase 6 step 4).
   *
   * **Deliberately not `scan.finished`**, although the comment above named the
   * radar as one of its users, and the reason is mechanical rather than
   * editorial: `PeriodicJob.lastRunKind` dates a job by the newest row *of that
   * kind*, so a radar sharing the kind would make §6.6's nightly transcript scan
   * look as though it had just run — every six hours, forever. The leak scan
   * would starve, silently, in the one channel whose purpose is that a leaked
   * credential reaches the operator quickly (A105). Two jobs need two deadlines, and a
   * deadline is a kind.
   *
   * Written on **every** run including the quiet ones, for `disk.checked`'s two
   * reasons: it is the deadline, and "did the billing watch ever actually run"
   * is §8.2's sixth domain asked about the project's own #1 external risk. It
   * carries the dedup memory (`reported`) and, for each card raised, the facts
   * that card was built from — so an answer can be carried out without parsing
   * the card's own prose (A112.1).
   *
   * It also carries `limits`: the surfaces this run did **not** examine, which
   * for a fresh installation is both Anthropic channels, since neither has a
   * default URL. A radar row that recorded only findings would make "nothing
   * announced" and "nobody looked" the same row (A83.6, A99.4, A104.4).
   */
  'radar.finished',
  /**
   * An answered radar card was carried out — or deliberately was not.
   *
   * `source.curated`'s exact counterpart, and it exists for the same reason:
   * without it the same answered card creates the same task on every pass. Both
   * outcomes are recorded, including "the operator chose the option that declines" and
   * "the answer was free text and therefore named no option", because a memory
   * of successes alone would re-examine those two forever (A93.5, A97 — the
   * defect where a card read *that* it was answered rather than *what* was
   * chosen was found twice in this project, and both times in a deploy path).
   */
  'radar.applied',
  /**
   * §18's nightly backup ran and every component came back clean (A14).
   *
   * Its own kind rather than a field on one `backup.finished`, following the
   * `deploy.succeeded`/`deploy.rolled_back` precedent below and for the same
   * reason: §18 asks for "backup success/failure **events**" as two things, the
   * Ops tile filters by kind, and "how many nights did the backup fail" must
   * not become a `WHERE payload ->> …` over a kind that also carries every
   * success — countable, but only by someone who already knows to look.
   *
   * The success is recorded and not only the failure, deliberately. A log of
   * failures alone cannot answer "when did a backup last work", which is the
   * first question anybody asks when a restore is needed (§22 Phase 9's drill),
   * and it cannot tell a healthy studio from one whose sidecar has been dead
   * for a month — both look like silence.
   *
   * Not `ops.alert`: that kind is A25's persistent-infra signal for a *task*,
   * and reusing it would make "how often did the studio sit blocked on a
   * machine" silently start counting nights (A91's lesson — a wrong label is
   * invisible to every test and surfaces first in a number somebody trusts).
   */
  'backup.succeeded',
  /**
   * A backup run ended without completing (§18).
   *
   * Carries the outcome **per component** (`db`, `docs`, `transcripts`,
   * `prune`), because the failure this kind was introduced for was a partial
   * one: `pg_dump` and the docs archive succeeded, the transcript archive could
   * not be read, and the run aborted — while everything a reader could see said
   * only that the night was lost. A single boolean would throw away the one
   * fact that points at the cause, which is the fact this record exists for.
   */
  'backup.failed',
  /**
   * §18's disk pressure watch ran (A30).
   *
   * Written on **every** run, not only when a threshold is crossed, and for two
   * reasons that pull the same way. It is the periodic pass's only deadline
   * (`periodic-pass.ts` decision 1): a kind that appeared only on a transition
   * would leave the watch with no memory of ever having run, and it would run
   * on every tick forever. And an hourly measurement kept forever *is* §18's
   * Ops tile — "when did this volume start filling" is the first question
   * anybody asks the first time one does, and it is unanswerable from a log of
   * alarms alone.
   *
   * Twenty-four rows a day is deliberate rather than tolerated. A98 and A101
   * both ended a flood, and both floods were a *false signal* repeating; a
   * measurement somebody would want to plot is the opposite case.
   */
  'disk.checked',
  'deploy.finished',
  /**
   * §12's two outcomes, as their own kinds rather than as a field on one.
   *
   * A rollback is not "a deploy that finished"; it is the event Phase 8's
   * quality trend counts, the one §16's weekly report names, and the one that
   * says production is serving something other than `main`. Collapsing the two
   * would make "how often did we roll back" a `WHERE payload ->> …` over a kind
   * that also carries every success — countable, but only by someone who
   * already knows to look.
   */
  'deploy.succeeded',
  'deploy.rolled_back',
  'deploy.failed',
  /**
   * §20's dry run produced a proposal, and what the verification made of it.
   *
   * Written for a run that creates nothing (A70): the proposal itself is the
   * artefact, it is what the operator decides on, and a decision whose input is not
   * recorded cannot be checked afterwards. Carries the verification verdict
   * beside the model's answer, so "what was proposed" and "what of it held" stay
   * distinguishable in the record rather than only in the report.
   */
  'onboarding.proposed',
  /** §20's analysis did not deliver one — the harness, or the session itself. */
  'onboarding.failed',
  /** §20's last step: a confirmed proposal became a project, and by whose word. */
  'onboarding.applied',
  /**
   * §14: a source was put to the operator as an inbox item, and which item it is.
   *
   * A112's second decision deferred every `source.*` kind with the sentence
   * "when the producer lands it appends there, where the reader is" — and this
   * pair lands with both. This one is the **linkage** and not merely a feed row:
   * §15's escalation carries `projectId`, `taskId` and `runId`, and a source is
   * none of the three, so without a record naming both ids the answer the operator gives
   * to a proposal card could never be connected back to the source it is about.
   * Reading the id out of the question's prose was the alternative, and this
   * repository refuses to parse its own sentences for facts it could store.
   */
  'source.proposed',
  /**
   * §14: an answered proposal card was carried out — or deliberately was not.
   *
   * The memory that keeps `SourceProposals.applyAnswers` idempotent, in the
   * event log rather than in the process for `periodic-pass.ts`'s decision 1:
   * the process that would hold it is exactly the one a deploy restarts (A57).
   * Written **after** the act (A86.4), so a crash in between costs a repeat that
   * the source's own state then absorbs, rather than a curation that is recorded
   * and never happened.
   *
   * It is written for every outcome including the ones where nothing was
   * curated — a free-text-only answer decides no act (A93.5), and a card whose
   * chosen act is no longer admissible in the state the source has *since*
   * reached is skipped (`SOURCE_ACTS_BY_STATE`). Note the criterion precisely:
   * not "somebody touched it in the dashboard", but "the act it names cannot be
   * carried out from here" — a source rejected by hand still admits `accept`, so
   * an open card answered with "Aufnehmen" does take it in. A memory that
   * recorded only the successes would leave those two re-examined on every tick,
   * forever, which is the flood A98 and A101 both ended.
   */
  'source.curated',
  /** §8.2: a Betriebsprüfung began. Written before the session is spawned. */
  'audit.started',
  /** §8.2: the verdict, the counts, and any gate this audit un-ticked. */
  'audit.finished',
  /** One audit finding, with the consequence that was carried out for it. */
  'audit.finding',

  /**
   * §16s Wochenbericht ist erzeugt und archiviert.
   *
   * **Die einzige Zeile, die der Berichtsdurchlauf schreibt** — und damit sein
   * ganzes Gedächtnis. `report-pass.ts` fragt sie über `recentOfKind` ab und
   * lässt `evaluateReportSchedule` daraus entscheiden, ob wieder etwas fällig
   * ist. Bewusst **keine** zweite Art für „nachgesehen und nichts fällig": das
   * wären bei einem stündlichen Blick rund 8 700 Zeilen im Jahr, in einem
   * Protokoll, das §18 für immer aufhebt — A101 hat gemessen, was solche
   * Zeilen kosten.
   */
  'report.generated',
  'report.sent',
  /**
   * §21: an idle audit of one project in one domain began.
   *
   * Deliberately its own pair rather than `audit.*` with a flag: §8.2's
   * cadence and this one examine different objects, and `idle_audit.finished`
   * is *the* rotation memory (`IdleAuditService.nextSlot`). Sharing a kind
   * would make an idle audit of a project shift the Betriebsprüfung's own
   * rotation, and the two would drift apart in the direction nobody watches.
   */
  'idle_audit.started',
  /**
   * §21: the run ended — with its domain, its findings and its transcript.
   *
   * Written for a failed session too, with `outcome: 'failed'`, **and the
   * rotation counts it**. That is the loop-free direction: a slot excluded on
   * failure would be picked again on the very next idle tick, and a machine
   * that is down would then spend a model session every few minutes on the
   * same pair, which is the shape A57.4 and A84 both exist to stop. Counting
   * it sends the slot to the back of a rotation that is ten domains long, so
   * it comes round again by itself, and nothing waits on it in the meantime.
   */
  'idle_audit.finished',
] as const;

export type EventKind = (typeof EVENT_KINDS)[number];
