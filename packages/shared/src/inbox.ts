/**
 * The wire between the dashboard and the API, for the inbox and the overview
 * (§15, §17.1, §17.5).
 *
 * This module exists because of a defect, and the defect is the specification.
 * The HTTP surface and the pages were built in two git worktrees in one session
 * and merged without a conflict. `pnpm gate` was nine of nine green. And the two
 * halves had never agreed on a single field:
 *
 *   * the routes answered `{ posteingang: […] }`, `{ eskalation: … }` and
 *     `{ entscheidungen: […] }`; the pages read `koerper.items`;
 *   * the server sent `number`/`question`/`urgency`/`options[{index,title,…}]`,
 *     the pages read `nummer`/`titel`/`dringlichkeit`/`optionen[{id,text,…}]`;
 *   * the answer form posted `{ optionId, freitext }` against a schema taking
 *     `optionIndex`/`freeText`;
 *   * the overview sent `decisions:{open,tasksWaiting}` and the page read
 *     `offeneEskalationen`.
 *
 * So the decision log hung in its loading state forever, the inbox rendered one
 * card made out of the envelope, §15's counter never appeared, and answering
 * could not succeed. Nothing caught it: each side was tested against its own
 * fixture, each declared its own local interface, and the inbox had no
 * browser-level test at all.
 *
 * Two properties follow, and neither is available from a hand-written interface
 * on each side:
 *
 *   1. **The producer is type-checked against the contract.** `toCard` returns
 *      `EscalationCardView` inferred from here, so renaming a field breaks `tsc`
 *      in `apps/server` rather than breaking a page at runtime.
 *   2. **The consumer parses instead of casting.** `as` is an assertion nobody
 *      checks — it is precisely how `{posteingang:[…]}` became a card rendering
 *      an envelope. A `safeParse` turns a contract violation into a German
 *      sentence on the page instead of `undefined` in the DOM.
 *
 * **Naming: German envelope keys, English fields.** Not a new rule — `/api/projekte`
 * already answers `{ projekte: [{ id, slug, rootPath, gateConfig }] }`. §2 makes
 * the text a *person* reads German, and on these payloads it already is: the
 * source label, the summary, the context, the option titles, every refusal. A
 * JSON key is read by a program.
 *
 * Browser-safe by construction, and it has to be: the barrel re-exports
 * `worktree.js` and `containment.js`, which import `node:path`, so the dashboard
 * reaches this through the `@vorschicht/shared/inbox` subpath the way it already
 * reaches `./gates` (A75.5). Only `zod` and the leaf modules below may be
 * imported here.
 */
import { z } from 'zod';
import { INBOX_PATH, PRIORITIES } from './constants.js';
import { deployMethodSchema } from './deploy.js';
import {
  ANSWER_WITHOUT_DECISION_MESSAGE,
  answerFields,
  ESCALATION_SOURCES,
  ESCALATION_STATES,
  hasAnswerDecision,
} from './escalation.js';
import { GUARDIAN_STATES } from './guardian.js';
import { inboxUrl } from './mail.js';

/**
 * Re-exported so the two builders of §15's deep link are reachable together.
 *
 * `inboxUrl` is the absolute form a notification carries and `inboxPath` the
 * in-app one; both read `INBOX_PATH`. Offering them from one module is what lets
 * a single test assert that a pushed link is a link the dashboard can read —
 * the assertion that was missing while the two disagreed. `./mail.js` imports
 * only `./constants.js` and `./escalation.js`, so this stays browser-safe.
 */
export { INBOX_PATH, inboxUrl };

/** Where the decision log lives. Its sibling `INBOX_PATH` is in `./constants.js`. */
export const DECISIONS_PATH = '/entscheidungen';

/**
 * §15's deep link, built from the one path constant (A77.7).
 *
 * `inboxUrl` in `./mail.js` builds the absolute form for notifications; this is
 * the in-app form. Both read `INBOX_PATH`, which is the whole point — they used
 * to disagree, and every push landed on the overview.
 */
export function inboxPath(number: number): string {
  return `${INBOX_PATH}/${number}`;
}

// --- the card ----------------------------------------------------------------

/**
 * A near-miss shown on a card: context, never an answer (A77.6).
 *
 * Declared here rather than in `packages/core` because it travels on the wire,
 * and a shape declared where it is produced plus a copy where it is consumed is
 * the arrangement this module exists to remove. Core re-exports it.
 */
export const relatedDecision = z.object({
  number: z.number().int().positive(),
  question: z.string(),
  /** German, one line: what was decided (`decisionSummary`). */
  summary: z.string(),
  decidedAt: z.string(),
});
export type RelatedDecision = z.infer<typeof relatedDecision>;

/**
 * One prepared option, as §15 requires it to be shown.
 *
 * `index` travels rather than being left to the array position: it is what an
 * answer sends back, and a page deriving it from its own rendering order would
 * be one sort away from submitting the wrong decision.
 */
export const escalationOptionView = z.object({
  index: z.number().int().min(0),
  title: z.string(),
  pros: z.array(z.string()),
  cons: z.array(z.string()),
  recommended: z.boolean(),
});
export type EscalationOptionView = z.infer<typeof escalationOptionView>;

/**
 * §15's inbox card, complete.
 *
 * Everything the format names travels: context, source, project, urgency,
 * created-at, the options with their pros and cons and the one recommendation.
 * `runId` is the link from a card to the session that asked (§6.4, Phase 7's
 * trace explorer). Nothing here points into the secret regime, which is why the
 * whole record can travel where `ProjectSettingsView` had to be selective.
 *
 * `state` and the four `answered*`/`chosen*` fields are on the *card*, not only
 * on the decision log, because `GET /api/posteingang/:nummer` does not filter by
 * state — a deep link from a notification the operator opens after answering elsewhere
 * returns the answered card, and the page has to be able to tell.
 */
export const escalationCardView = z.object({
  id: z.string(),
  /** §15's "#X" — permanent, and what every deep link names (A77.7). */
  number: z.number().int().positive(),
  source: z.enum(ESCALATION_SOURCES),
  /** German (§2): who is asking, in words the operator reads. */
  sourceLabel: z.string(),
  urgency: z.enum(PRIORITIES),
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  runId: z.string().nullable(),
  question: z.string(),
  context: z.string(),
  options: z.array(escalationOptionView),
  related: z.array(relatedDecision),
  /** ISO 8601. */
  raisedAt: z.string(),
  raisedBy: z.string(),
  state: z.enum(ESCALATION_STATES),
  answeredAt: z.string().nullable(),
  answeredBy: z.string().nullable(),
  chosenIndex: z.number().int().nullable(),
  chosenTitle: z.string().nullable(),
  freeText: z.string().nullable(),
});
export type EscalationCardView = z.infer<typeof escalationCardView>;

/**
 * One row of the decision log (§15, §17.5).
 *
 * The context linkage §22's exit gate asks for is the four ids plus the question
 * itself. `summary` is the one German line that renders in a timeline, assembled
 * by `decisionSummary` so the wording exists once.
 */
export const decisionView = z.object({
  escalationId: z.string(),
  number: z.number().int().positive(),
  source: z.enum(ESCALATION_SOURCES),
  sourceLabel: z.string(),
  projectId: z.string().nullable(),
  taskId: z.string().nullable(),
  question: z.string(),
  /** German, one line: what was decided. */
  summary: z.string(),
  options: z.array(escalationOptionView),
  chosenIndex: z.number().int().nullable(),
  chosenTitle: z.string().nullable(),
  freeText: z.string().nullable(),
  decidedAt: z.string(),
  decidedBy: z.string(),
});
export type DecisionView = z.infer<typeof decisionView>;

// --- the overview ------------------------------------------------------------

/**
 * A task that cannot move until the operator answers (§15, §9).
 *
 * **One row per blocked task, never per open item**, and that is the fix for the
 * defect where the overview's counter and its list disagreed: the counter
 * de-duplicated by task while the list rendered every raw row, so one task with
 * two open questions produced "1 Aufgabe wartet" above two `<li>`s sharing a
 * React key. The de-duplication now happens once, on the server, and the page
 * counts the array it renders — agreement between two derivations can rot,
 * identity cannot.
 *
 * `number` is the escalation *number*, not its id: it is what §15's sentence
 * says out loud and what the deep link addresses. Where a task waits on more
 * than one, it is the newest — that is the question actually in front of the operator.
 */
/**
 * Eine Aufgabe, die auf eine Entscheidung wartet — auf **eine von zwei Arten**.
 *
 * §9 und §15 kennen beide, und bis zur Betriebsprüfung 767db82c (3.8.2026)
 * rendete die Übersicht nur die erste:
 *
 *   * `fragend` — diese Aufgabe hat die Frage selbst gestellt und steht auf
 *     `needs_decision`. Sie *ist* Entscheidung #X.
 *   * `blockiert` — diese Aufgabe wartet nach §10 hinter den Claims einer
 *     anderen, und die andere wartet auf #X. Genau der Fall, den §9s Satz
 *     „tasks waiting **behind** a parked task's claims" benennt, und der
 *     überhaupt nicht angezeigt wurde: die Aufgabe verschwand von der
 *     Übersicht, obwohl §15 ihre Sichtbarkeit als Gegengewicht dafür wählt,
 *     dass eine Entscheidung keine Frist hat.
 *
 * `haltendeAufgabe` steht nur bei `blockiert` und nennt, *wer* im Weg ist —
 * ohne das ist „blockiert durch #X" für eine Aufgabe, die diese Frage nie
 * gestellt hat, nicht nachvollziehbar.
 */
export const blockedTaskView = z.object({
  taskId: z.string(),
  title: z.string(),
  number: z.number().int().positive(),
  art: z.enum(['fragend', 'blockiert']),
  haltendeAufgabe: z.string().nullable(),
});
export type BlockedTaskView = z.infer<typeof blockedTaskView>;

export const windowView = z.object({
  window: z.string(),
  modelClass: z.string().nullable(),
  usedPercent: z.number(),
  /** Epoch millis, or null when the source did not say. */
  resetsAt: z.number().nullable(),
  source: z.enum(['official', 'estimated']),
  /** Set when the number could not be trusted at face value. */
  anomaly: z.string().nullable(),
});
export type WindowView = z.infer<typeof windowView>;

export const runView = z.object({
  runId: z.string(),
  role: z.string().nullable(),
  model: z.string().nullable(),
  startedAt: z.string().nullable(),
});
export type RunView = z.infer<typeof runView>;

/**
 * The two numbers §15 and §17 ask for, and they are not the same number.
 *
 * §17.1's copy is *"N Tasks warten auf deine Entscheidung"*; §17.5's badge counts
 * inbox items. An escalation raised without a task (a source proposal, a billing
 * alert) has no task waiting behind it, and a task that has asked twice has two
 * items — so one count rendered under the other's label is wrong in both
 * directions. Both travel, each named for what it counts.
 *
 * `tasksWaiting` is `blockedTasks.length` and is asserted to be, rather than
 * being a second derivation that agrees today.
 */
export const pendingDecisions = z.object({
  /** §17.5's inbox badge: escalations waiting for an answer. */
  open: z.number().int().min(0),
  /** §17.1's counter: distinct tasks blocked behind one of them (§15). */
  tasksWaiting: z.number().int().min(0),
  /** The rows behind that number, one per task, newest question first. */
  blockedTasks: z.array(blockedTaskView),
});
export type PendingDecisions = z.infer<typeof pendingDecisions>;

/**
 * Eine Aufgabe, die liegt, weil ihr Projekt auf Nur-Lesen steht (A44.3, A85).
 *
 * Die **dritte** Art des Stillstands, und sie steht bewusst nicht im `art`-Feld
 * von `blockedTaskView`, obwohl sie dort auf den ersten Blick hingehört. §17.1s
 * Zähler heißt „N Tasks warten auf deine **Entscheidung**", und `tasksWaiting`
 * *ist* `blockedTasks.length` — keine zweite Ableitung, sondern Identität, weil
 * genau diese Identität die Betriebsprüfung 767db82c wiederhergestellt hat.
 * Eine dritte Art in derselben Liste ließe nur zwei Auswege: den Zähler wieder
 * aus einer gefilterten Zählung bilden — also die Fäulnis zurückholen, die
 * A81.4 entfernt hat — oder Aufgaben mitzählen, über die niemand etwas zu
 * entscheiden hat. Beides ist falsch, also eine eigene Liste mit eigenem Satz.
 *
 * Was diese Aufgaben verbindet, ist trotzdem eine Entscheidung des Betreibers: A85
 * nennt das Zurücksetzen der Kennzeichnung ausdrücklich als seine, ein
 * `setReadOnly`-Aufruf. Sie warten also auf ihn — nur nicht über eine Karte im
 * Postfach, und deshalb hätten sie ohne diese Liste **nirgends** gestanden: der
 * Ablaufplaner übersprang sie vor jedem Zähler, und die Übersicht kannte sie
 * nicht. Genau A100s Fund, eine Tür weiter.
 */
export const stalledTaskView = z.object({
  taskId: z.string(),
  title: z.string(),
  /** Welches Projekt — ohne das ist „nur lesbar" nicht handlungsfähig. */
  projectSlug: z.string(),
  /**
   * Warum sie liegt. Heute genau ein Grund, und das ist der Punkt: eine zweite
   * Art Stillstand ohne Entscheidung dahinter wäre eine Vertragsänderung, die
   * jemand sieht, statt einer Zeile, die stillschweigend etwas anderes meint.
   */
  reason: z.literal('read_only'),
});
export type StalledTaskView = z.infer<typeof stalledTaskView>;

/**
 * Ein Kandidat in §10s Warteschlange, so weit die Übersicht ihn braucht.
 *
 * `position` reist mit, statt aus dem Listenindex zu folgen, und das ist keine
 * Bequemlichkeit: §10 serialisiert **je Projekt**, die Liste hier ist über alle
 * Projekte gemischt, und eine Seite, die durchzählt, schriebe „3." an eine
 * Aufgabe, die in ihrem eigenen Projekt die erste ist. Genau die Klasse, die
 * `escalationOptionView.index` schon einmal geschlossen hat — ein Wert, den der
 * Erzeuger kennt und der Verbraucher nur schätzen kann, gehört auf die Leitung.
 *
 * `enteredAt` ist der **jüngste** Eintritt in `merge_queue`, nicht der erste
 * (Migration 0012): ein Kandidat, der nach einem Infrastrukturfehler
 * zurückkam, hat einen Versuch hinter sich, und ihn auf seinen ursprünglichen
 * Eintritt an die Spitze zu setzen liesse eine kaputte Maschine jede andere
 * Aufgabe verhungern. Null nur für eine Zeile, deren Zustandswechsel nicht im
 * Protokoll steht — dann sagt die Seite das, statt „gerade eben" zu zeigen.
 */
export const mergeCandidateView = z.object({
  taskId: z.string(),
  title: z.string(),
  projectId: z.string(),
  projectSlug: z.string().nullable(),
  priority: z.enum(PRIORITIES),
  branch: z.string().nullable(),
  enteredAt: z.string().nullable(),
  /** 1-basiert, **innerhalb des eigenen Projekts** (§10). */
  position: z.number().int().positive(),
});
export type MergeCandidateView = z.infer<typeof mergeCandidateView>;

/**
 * §10s Warteschlange auf der Übersicht: die vordersten Kandidaten und wie viele
 * es insgesamt sind.
 *
 * `total` statt eines `truncated`-Schalters, aus A81.4s Grund: „gekürzt" ist
 * aus `total > candidates.length` **ableitbar**, ein zweites Feld daneben wäre
 * eine zweite Ableitung derselben Tatsache, und die beiden können auseinander
 * laufen. Umgekehrt ist `total` aus der Liste *nicht* ableitbar — eine gedeckelte
 * Liste liest sich sonst als vollständige Antwort, was eine Warteschlange nie
 * tun darf.
 */
export const mergeQueueView = z.object({
  candidates: z.array(mergeCandidateView),
  total: z.number().int().min(0),
});
export type MergeQueueView = z.infer<typeof mergeQueueView>;

/** Wie viele Kandidaten die Übersicht namentlich zeigt. */
export const OVERVIEW_MERGE_QUEUE_LIMIT = 8;

/**
 * §17.1s Gesundheitskacheln — und was sie **nicht** sind.
 *
 * `/healthz` meldet Lebendigkeit für nginx, den Compose-Healthcheck und den
 * Watchdog (§18.1) und ist deshalb bewusst arm: kein Zählwert, kein Projektname,
 * nichts über des Betreibers Arbeit. Diese Kacheln stehen hinter dem Passkey und tragen
 * genau das, was dort fehlen muss und was §18 dem Ops-Bereich zuschreibt: der
 * Zustand der nächtlichen Sicherung (A14, A103) und der Plattendruck (A30).
 *
 * Sie sind aus `event_log` abgeleitet und aus nichts sonst. Die Kachel für die
 * Datenbank liegt bewusst **nicht** hier: sie käme aus derselben Abfrage, die
 * diese Antwort erzeugt, könnte also nie etwas anderes als „ok" sagen — eine
 * Kachel, die nur einen Zustand annehmen kann, ist §8.2s sechste Domäne mit
 * beruhigendem Gesicht. Die Seite liest sie aus `/healthz`, und zwar auch dann,
 * wenn `/api/overview` gescheitert ist, weil genau das der Fall ist, für den
 * eine Gesundheitskachel existiert.
 */
export const HEALTH_TILE_STATES = ['ok', 'warnung', 'fehler', 'unbekannt'] as const;
export type HealthTileState = (typeof HEALTH_TILE_STATES)[number];

/**
 * Welche Kacheln es gibt. Ein Enum, damit eine neue eine Vertragsänderung ist.
 *
 * `anwendung` ist die eine, die **die Seite** erzeugt und nicht der Server — aus
 * `/healthz`, siehe oben. Sie steht trotzdem hier: die Aufzählung beantwortet
 * „welche Kacheln zeigt §17.1", und eine, die in der Aufzählung fehlt, weil sie
 * anderswo entsteht, wäre eine Kachel, die niemand beim Lesen des Vertrags
 * findet. `OVERVIEW_HEALTH_TILE_IDS` nennt daneben die Teilmenge, für die der
 * Server zuständig ist, damit ein Erzeuger sich nicht an der falschen Menge
 * ausrichtet.
 */
export const HEALTH_TILE_IDS = ['anwendung', 'sicherung', 'platte'] as const;
export type HealthTileId = (typeof HEALTH_TILE_IDS)[number];

/** Die Kacheln, die `/api/overview` liefert. `anwendung` gehört der Seite. */
export const OVERVIEW_HEALTH_TILE_IDS = ['sicherung', 'platte'] as const;

export const healthTileView = z.object({
  id: z.enum(HEALTH_TILE_IDS),
  /** Deutsch (§2), die Überschrift der Kachel. */
  label: z.string(),
  state: z.enum(HEALTH_TILE_STATES),
  /**
   * Deutsch, ein Satz, fertig zum Rendern — und er sagt bei `unbekannt`
   * ausdrücklich, dass nichts gemessen wurde. „Wir haben nicht nachgesehen" und
   * „es ist in Ordnung" sind derselbe Satz nur für ein System, das sich
   * entschieden hat, nicht hinzusehen (A83.6, A99.4, A104.4).
   */
  detail: z.string(),
  /** Wann die Messung war. ISO 8601, null wenn es keine gibt. */
  at: z.string().nullable(),
});
export type HealthTileView = z.infer<typeof healthTileView>;

/**
 * Was `/healthz` antwortet — hier deklariert, damit `buildHealthReport` gegen
 * denselben Vertrag typgeprüft wird, den die Seite **parst** (A81).
 *
 * Der Endpunkt ist öffentlich und bleibt es; was hier steht, ändert an seinem
 * Inhalt nichts, sondern nur daran, dass beide Enden dieselbe Deklaration
 * lesen. Bis heute las ihn keine Seite überhaupt.
 */
export const healthReportView = z.object({
  status: z.enum(['ok', 'degraded']),
  uptimeSeconds: z.number(),
  checks: z.object({ database: z.enum(['ok', 'error']) }),
});
export type HealthReportView = z.infer<typeof healthReportView>;

/** Der öffentliche Lebendigkeitsendpunkt (§22 Phase 0, §18.1). */
export const HEALTHZ_PATH = '/healthz';

// --- §12's release history ---------------------------------------------------

/**
 * What a finished deployment ended as (§12, `deployments.outcome`).
 *
 * Null is a fourth answer and not a missing one: a deploy that is running, or
 * one the orchestrator died inside, has no outcome yet — and `lastStep` is then
 * the only thing that says how far it got. A page that rendered null as
 * "erfolgreich" would report a rollout that may never have swapped anything.
 */
export const DEPLOY_OUTCOMES = ['succeeded', 'rolled_back', 'failed'] as const;

/** German (§2) — the words the project page puts on a release row. */
export const DEPLOY_OUTCOME_LABELS: Record<(typeof DEPLOY_OUTCOMES)[number], string> = {
  succeeded: 'ausgerollt',
  rolled_back: 'zurückgerollt',
  failed: 'fehlgeschlagen',
};

/**
 * Where a rollback went, resolved to something a person can read.
 *
 * `deployments.rolled_back_to` holds the *id* of the release that was swapped
 * back in, and an id is exactly the wrong answer to the question somebody opens
 * this page with — "what is serving now". So the sha and the artifact travel
 * beside it, resolved by the producer from the same window it is sending.
 *
 * Both are nullable because the window is capped: a rollback onto a release
 * older than `RELEASE_HISTORY_LIMIT` cannot be named from that page, and saying
 * so is better than an id dressed up as an answer or a second query per row.
 */
export const rolledBackToView = z.object({
  deploymentId: z.string(),
  sha: z.string().nullable(),
  artifact: z.string().nullable(),
});
export type RolledBackToView = z.infer<typeof rolledBackToView>;

/**
 * One release, as §12's "release history … visible per project" needs it.
 *
 * The sha and the artifact are two different facts and both travel: after a
 * prune the sha is a statement about history and the artifact is a statement
 * about the disk (`target.ts`), and a rollback can only point at the second.
 */
export const deploymentView = z.object({
  id: z.string(),
  /** The commit that was rolled out. */
  sha: z.string(),
  method: deployMethodSchema,
  /** Image tag or release directory — what the target called it. Null before `prepare`. */
  artifact: z.string().nullable(),
  outcome: z.enum(DEPLOY_OUTCOMES).nullable(),
  /** The last step that was recorded — how far an unfinished deploy got. */
  lastStep: z.string().nullable(),
  /** ISO 8601. */
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  durationMs: z.number().nullable(),
  /** German, from the engine: why it rolled back or failed. */
  problem: z.string().nullable(),
  rolledBackTo: rolledBackToView.nullable(),
  /** The task whose merge produced this release (§18's trace). */
  taskId: z.string().nullable(),
});
export type DeploymentView = z.infer<typeof deploymentView>;

/** Newest first, as `DeployRecords.forProject` answers. */
export const releaseHistoryView = z.array(deploymentView);

/**
 * How many releases travel with a project.
 *
 * On the wire rather than in the producer, because the page says the number out
 * loud — "die letzten N Releases" — and a window whose size only the server
 * knows is a window the page has to guess at. A11 keeps five artifacts on the
 * machine; the *record* of what was deployed is kept forever (§18), so this is
 * a page size and not a retention rule.
 */
export const RELEASE_HISTORY_LIMIT = 20;

// --- the overview payload ----------------------------------------------------

/**
 * Ein Rollout auf der Übersicht — dasselbe `deploymentView` wie auf der
 * Projektseite, plus das eine, was dort aus dem Kontext folgt und hier nicht:
 * welches Projekt.
 *
 * Wiederverwendet statt nachgebaut. Eine zweite, flachere „Release-Zeile" für
 * diese Seite wäre A81s Defekt in seiner ursprünglichen Form — zwei
 * Deklarationen eines Dokuments, von denen die eine gepflegt wird und die
 * andere nicht —, und `rolledBackTo` ist genau das Feld, das dabei als Erstes
 * zur uuid verkommt (A95.4).
 */
export const overviewDeployView = z.object({
  projectId: z.string(),
  projectSlug: z.string().nullable(),
  deployment: deploymentView,
});
export type OverviewDeployView = z.infer<typeof overviewDeployView>;

/** Wie viele Rollouts die Übersicht zeigt. §17.3 trägt die volle Historie. */
export const OVERVIEW_DEPLOY_LIMIT = 5;

/**
 * §17.1s ganze Startseite in einer Antwort.
 *
 * Sie steht **unterhalb** der Release-Historie und nicht mehr oben bei den
 * anderen Übersichtsformen, und der Grund ist mechanisch: `overviewDeployView`
 * baut auf `deploymentView` auf, zod-Schemata sind Werte, und ein Wert, der
 * beim Auswerten des Moduls noch nicht existiert, ist `undefined` — nicht ein
 * Fehler, den irgendwer sieht, sondern ein Schema, das alles durchlässt. Die
 * Reihenfolge ist also Teil der Zusicherung.
 *
 * Eine Antwort und nicht vier, weil §17.1s Ziel „null Klicks, um zu wissen, ob
 * alles in Ordnung ist" lautet: eine Seite, die für ihre Aussage einen zweiten
 * Aufruf braucht, hat dieses Ziel schon verfehlt. Die einzige Ausnahme ist
 * `/healthz`, und die ist begründet — siehe `healthTileView`.
 */
/**
 * Ein laufender Auth-Vorfall (§6.1) auf der Übersicht, oder `null`.
 *
 * Während eines Vorfalls nimmt der Daemon keine Arbeit an und misst auch kein
 * Budget — der Wächter sagt dann wahrheitsgemäss „Keine Budgetdaten", und das
 * war bis hierher **alles**, was die Startseite sagte. Die Ursache stand im
 * Log des Orchestrators und im Ereignisprotokoll, und der Container meldet
 * sich währenddessen als `(healthy)`: §17.1s „null Klicks, um zu wissen, ob
 * alles in Ordnung ist" traf für den einen Zustand nicht zu, in dem das Studio
 * auf den Betreiber wartet.
 *
 * Der Satz ist deutsch und fertig (§2), wie `guardian.text` und die Kacheln.
 */
export const authIncidentView = z.object({
  /** Wann der Daemon den Vorfall zuletzt gemeldet hat. ISO 8601. */
  at: z.string(),
  /** Deutsch, fertig zum Rendern: was los ist und was zu tun wäre. */
  text: z.string(),
});
export type AuthIncidentView = z.infer<typeof authIncidentView>;

export const overviewPayload = z.object({
  guardian: z.object({
    state: z.enum(GUARDIAN_STATES),
    /** German, ready to render (§2). */
    text: z.string(),
    governingWindow: z.string().nullable(),
    since: z.string().nullable(),
  }),
  windows: z.array(windowView),
  /** The thresholds, so the dial does not hard-code them in two places. */
  thresholds: z.object({ wrapUpPercent: z.number(), hardStopPercent: z.number() }),
  activeRuns: z.array(runView),
  /** Weekly budget spent and resting until the reset — §17.1 wants this loud. */
  weeklyExhaustedUntil: z.string().nullable(),
  decisions: pendingDecisions,
  /** Tasks lying still on a read-only project (A44.3, A85). See the schema. */
  stalledTasks: z.array(stalledTaskView),
  /** §10s Warteschlange, über alle Projekte, je Projekt in ihrer Reihenfolge. */
  mergeQueue: mergeQueueView,
  /** §12s jüngste Rollouts, neueste zuerst. */
  deploys: z.array(overviewDeployView),
  /** §17.1s Gesundheitskacheln (§18). Siehe `healthTileView`. */
  health: z.array(healthTileView),
  /** §6.1: der laufende Auth-Vorfall, `null` ohne einen. Siehe `authIncidentView`. */
  authIncident: authIncidentView.nullable(),
});
export type OverviewPayload = z.infer<typeof overviewPayload>;

// --- envelopes ---------------------------------------------------------------

/**
 * The envelope keys are German and they are the ones the routes already answer.
 *
 * Naming them here rather than re-deriving them on each side is the smallest
 * possible version of this whole module: the pages read `items` and the routes
 * wrote `posteingang`, and one shared literal would have made that impossible.
 */
export const inboxListResponse = z.object({ posteingang: z.array(escalationCardView) });
export const inboxCardResponse = z.object({ eskalation: escalationCardView });
export const decisionLogResponse = z.object({ entscheidungen: z.array(decisionView) });

/** 409: already decided, and the card travels so the page can show what it was. */
export const answerConflictResponse = z.object({
  errors: z.array(z.string()),
  eskalation: escalationCardView,
});

/** 422: the body parsed and §15 declined what it said. Every reason, German. */
export const answerRejectedResponse = z.object({ errors: z.array(z.string()) });

/**
 * What the browser POSTs to answer (§15).
 *
 * Built from `answerFields` and `hasAnswerDecision`, so the page and the service
 * enforce one rule rather than two that agree today. The **actor is absent on
 * purpose**: §19 takes it from the session and overwrites whatever the body
 * said, so a field here would describe something always discarded.
 */
export const answerSubmission = z
  .object(answerFields)
  .refine(hasAnswerDecision, { message: ANSWER_WITHOUT_DECISION_MESSAGE, path: ['optionIndex'] });
export type AnswerSubmission = z.infer<typeof answerSubmission>;

// --- routes ------------------------------------------------------------------

/** One place both the routes and the pages name these, for the same reason. */
export const INBOX_API = {
  list: '/api/posteingang',
  card: (number: number) => `/api/posteingang/${number}`,
  answer: (number: number) => `/api/posteingang/${number}/antwort`,
  decisions: '/api/entscheidungen',
  overview: '/api/overview',
} as const;
