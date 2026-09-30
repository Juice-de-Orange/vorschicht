/**
 * The office view (§17.2), as a contract — what a desk is, what a bubble means,
 * and the wire both halves read.
 *
 * §17.2 asks for "desks/avatars for every active persona, live status bubbles
 * (idle / working / in review / blocked / escalating) with current task title;
 * click any employee → their current task and trace. Built as a lightweight
 * SVG/DOM scene fed by SSE (no heavy engine)."
 *
 * Browser-safe by construction: this module imports `zod`, `./personas.js` and
 * `./task-state.js`, and none of the three touches `node:`. It is reachable
 * through the `@vorschicht/shared/buero` subpath for `./gates`', `./inbox`' and
 * `./personas`' reason — the barrel re-exports `worktree.js` and
 * `containment.js`, which pull `node:path` (A75.5).
 *
 * **English identifiers, German values**, and German envelope keys on the wire
 * (A81). Four things §17.2's sentence does not settle are settled here.
 *
 *   1. **A desk is a seat, and a seat is `(profile, task)`.** §8 lists eighteen
 *      profiles; an office showing eighteen empty desks is a table with
 *      pictures, and §17.2 says "every **active** persona". So a seat exists
 *      because a *run* put someone in it, and its identity is the pair, not the
 *      profile — which is exactly A46.5's arrangement: `coder` serving two tasks
 *      at once is Clara and Chris at two desks, one profile, and `alternates`
 *      names the second. A run with no task at all (the auditor, the smoke
 *      probe, onboarding — A56.5) seats one desk that leaves when the run ends,
 *      because there is no task to keep it there.
 *
 *   2. **The wire carries the inputs, never the verdict.** A desk reports
 *      `taskState`, `runLive` and `projectReadOnly`; `deskState()` turns those
 *      into one of §17.2's five bubbles, and both halves call it. A payload
 *      carrying the finished bubble would be a second implementation of the one
 *      rule this view turns on — `personaRosterEntry`'s decision 4, and the same
 *      reason: the browser test proving the rule would then be proving the
 *      server's copy of it. It also makes the SSE reducer trivially honest —
 *      `task.state_changed` sets one field and the bubble follows, rather than
 *      the page deciding a second time what a state means.
 *
 *   3. **The bubbles are §9's states, mapped, and nothing is invented.**
 *      `deskState` is total over `TaskState`, so a new state is a compile error
 *      rather than a desk that silently reads "ruht". The line between the two
 *      that could be confused is drawn once and drawn plainly:
 *
 *        * **eskaliert** — a question is waiting for the operator (`needs_decision`,
 *          `escalated`). This is A100's `fragend`: the desk asked.
 *        * **blockiert** — work is in hand and cannot continue, and nobody has
 *          been asked (`parked`, `interrupted`, `red`, or a `read_only` project,
 *          which is A119.6's third kind).
 *        * **ruht** — the desk holds nothing and could take new work.
 *
 *      That last sentence is what separates `ruht` from `blockiert`, and it is
 *      checkable rather than a matter of taste: a parked task still holds its
 *      claims (§10), so its desk is *not* available and must not read as idle.
 *
 *   4. **A `read_only` project reads as blocked, and a claim collision does
 *      not.** Both are real ways to be stuck (A119.6), and only the first is
 *      visible from a task's own row. A100's claim-blocked task sits in a
 *      dispatchable state with no live run, so it renders `ruht` here — honest
 *      about this desk ("holds nothing to show") and silent about the
 *      collision. §17.1 is where §15 puts that sentence, with the holder named,
 *      and repeating it here would need `ClaimRegistry` per project on a page
 *      that redraws on every event. Stated as a limit rather than left to be
 *      discovered.
 */
import { z } from 'zod';
import { personaModeSchema } from './personas.js';
import { TASK_STATE_LABELS, TASK_STATES, type TaskState } from './task-state.js';

/**
 * §9's states travel through this door, re-exported rather than re-declared.
 *
 * The dashboard cannot import the barrel — it re-exports `worktree.js` and
 * `containment.js`, which pull `node:path` (A75.5) — and the office needs all
 * three: the list to validate a frame's `to` field, the type to hold it, and the
 * German labels to say *which* kind of blocked a desk is. A re-export is the
 * same object, so unlike a second copy it cannot drift; `einstellungen-format.ts`
 * passes `personaLabel` through for exactly this reason.
 */
export { TASK_STATE_LABELS, TASK_STATES, type TaskState };

// ---------------------------------------------------------------------------
// §17.2's five bubbles
// ---------------------------------------------------------------------------

/**
 * The five, in §17.2's own order: idle / working / in review / blocked /
 * escalating.
 *
 * German identifiers here rather than English ones, against this house's usual
 * rule, because every one of them is also a `data-testid` a browser test reads
 * and a class name the scene styles — and a bubble called `in_review` rendering
 * "prüft" would be one more pair of names to keep in step for no gain.
 */
export const DESK_STATES = ['ruht', 'arbeitet', 'prueft', 'blockiert', 'eskaliert'] as const;
export type DeskState = (typeof DESK_STATES)[number];

/** What the bubble says (§2). Short: it sits under an avatar. */
export const DESK_STATE_LABELS: Record<DeskState, string> = {
  ruht: 'ruht',
  arbeitet: 'arbeitet',
  prueft: 'prüft',
  blockiert: 'blockiert',
  eskaliert: 'fragt nach',
};

/**
 * The same five as a sentence, for the detail panel and the `title` attribute.
 *
 * A bubble that only shows a word makes the viewer guess what the word means,
 * and the two that are easiest to confuse — blocked and escalating — are
 * precisely the two where guessing costs something: one needs an answer from
 * the operator, the other does not.
 */
export const DESK_STATE_HINTS: Record<DeskState, string> = {
  ruht: 'Nichts in der Hand — dieser Platz könnte neue Arbeit annehmen.',
  arbeitet: 'Eine Sitzung läuft gerade.',
  prueft: 'Die Arbeit wird geprüft — Review oder Gates.',
  blockiert: 'Arbeit in der Hand, die gerade nicht weitergeht. Niemand wurde gefragt.',
  eskaliert: 'Eine Frage wartet auf deine Entscheidung im Posteingang.',
};

/**
 * A desk's colour, for the scene only.
 *
 * Never load-bearing: every assertion in this feature reads a word, because a
 * bubble that can only be told apart by hue is one a colour-blind reader cannot
 * tell apart at all — and §17.2's whole promise is that the office answers a
 * question at a glance.
 */
export const DESK_STATE_COLORS: Record<DeskState, string> = {
  ruht: '#8a8f98',
  arbeitet: '#2f8f4e',
  prueft: '#2f6f9f',
  blockiert: '#b8862b',
  eskaliert: '#b8422b',
};

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/** Exactly what deciding a bubble needs, so a caller cannot pass a verdict. */
export interface DeskPosition {
  /** §9's state of the task this seat serves, or null for a run without one. */
  readonly taskState: TaskState | null;
  /** Is a model session at this desk right now (`agent_runs.is_finished` is false)? */
  readonly runLive: boolean;
  /** A44.3's flag: the scheduler skips this project entirely (A119.6's third kind). */
  readonly projectReadOnly: boolean;
}

/**
 * §9's state → §17.2's bubble.
 *
 * The order of the branches is the content of this function and is asserted as
 * such: **the reasons a desk cannot continue outrank the question of whether a
 * session happens to be alive.** A task parks while its run is still recorded as
 * live — §7.3 finishes the atomic step, writes the WIP commit and the handover
 * note, and only then does the session end — so a rule that asked `runLive`
 * first would show a parked desk as "arbeitet" for exactly as long as the
 * wrap-up takes, which is the one moment §7.3 exists to make legible.
 */
export function deskState(position: DeskPosition): DeskState {
  const state = position.taskState;

  // A question is out; that outranks everything, including a session that is
  // still winding down (§6.4 parks the task and the run ends afterwards).
  if (state === 'needs_decision' || state === 'escalated') return 'eskaliert';

  // Work in hand that cannot continue, with nobody asked.
  if (state === 'parked' || state === 'interrupted' || state === 'red') return 'blockiert';

  // A44.3: the tick skips this project, so nothing here will move on its own.
  // After the two branches above, because a read-only project whose task asked a
  // question is still waiting on the answer.
  if (position.projectReadOnly && state !== null && !isFinishedState(state)) return 'blockiert';

  // No session: whatever the task's state, *this* desk holds nothing right now.
  // The planner that finished handing over is idle even while the task codes on.
  //
  // This guard is also the one invariant the whole view can be checked against:
  // past it a session is alive, so **`ruht` implies no live run**. An idle chair
  // is one that could take new work, and a chair with a model session running at
  // it could not — nor should the room let a running session look like nothing.
  if (!position.runLive) return 'ruht';

  if (state === null) return 'arbeitet';

  switch (state) {
    case 'review':
    case 'gates':
      // §17.2's "in review" covers both: from the desk's side the difference
      // between a reviewer reading the diff and the gate suite running over it
      // is who is judging, not that the work is being judged.
      return 'prueft';
    case 'planning':
    case 'claimed':
    case 'coding':
    case 'merge_queue':
    case 'merging':
    case 'deploying':
      return 'arbeitet';
    case 'draft':
    case 'queued':
    case 'done':
    case 'aborted':
      // Reachable only past the guard above, so a session **is** alive here on
      // a task §9 no longer calls active — a run still winding down after its
      // task reached the terminus. Still "arbeitet", never "ruht": `ruht` means
      // this chair could take new work, and a chair with a model burning budget
      // at it could not. Written as its own case rather than folded into the one
      // above so that the exhaustive switch stays exhaustive — a state added to
      // §9 must be a type error here, not a desk that quietly picks a bubble.
      return 'arbeitet';
    default:
      // Unreachable: every member of `TaskState` is named above or returned
      // earlier. Kept so that adding one to §9 is a type error here rather than
      // a desk that quietly reads "ruht" — the state machine grew twice already.
      return assertNever(state);
  }
}

function isFinishedState(state: TaskState): boolean {
  return state === 'done' || state === 'aborted';
}

function assertNever(value: never): never {
  throw new Error(`Unbehandelter Aufgabenzustand: ${String(value)}`);
}

/**
 * Is this chair still part of the room?
 *
 * The snapshot's SQL narrows to the same predicate and this function decides it,
 * so the reducer that patches the page and the query that draws it cannot answer
 * differently. Without one shared answer a desk removed by a reload would linger
 * for a whole polling interval after the event that finished it — which reads as
 * "Clara is still on that" about work that shipped.
 *
 * A live session is always in the room, whatever its task says: something is
 * running, and an office that hides a running session is worse than one that
 * shows a stale name.
 */
export function seatBelongsInRoom(position: {
  taskState: TaskState | null;
  runLive: boolean;
}): boolean {
  if (position.runLive) return true;
  return position.taskState !== null && !isFinishedState(position.taskState);
}

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

/**
 * A seat's stable identity: the profile and the task it serves.
 *
 * The run id would be the obvious key and is the wrong one — a task runs its
 * coder three times over three review rounds (§8.1), and keying on the run
 * would empty the desk and seat a stranger between them. The pair survives that,
 * and it is what makes `coder` at two tasks two desks rather than one that
 * flickers.
 */
export function seatId(profileId: string, taskId: string | null): string {
  return `${profileId}#${taskId ?? '-'}`;
}

/**
 * Which of a profile's names this seat wears (§8, A46.5).
 *
 * `index` is the seat's position among that profile's occupied desks, oldest
 * first, so Clara keeps her chair while Chris arrives and leaves beside her.
 * Beyond the declared alternates the name is numbered rather than repeated: two
 * desks reading "Clara" would be worse than one reading "Clara 3", because the
 * first is wrong and the second is merely plain.
 */
export function seatName(
  persona: { name: string; alternates?: readonly string[] },
  index: number,
): string {
  if (index <= 0) return persona.name;
  const alternate = persona.alternates?.[index - 1];
  return alternate ?? `${persona.name} ${index + 1}`;
}

// ---------------------------------------------------------------------------
// The wire (§17.2)
// ---------------------------------------------------------------------------

export const taskStateSchema = z.enum(TASK_STATES);

/**
 * One desk as the API reports it.
 *
 * `seatName` is resolved on the server because seat *order* is a property of the
 * snapshot — the page would have to re-derive "which coder is the older one"
 * from a list it patches event by event, and two answers to that question is two
 * names for one person. The persona's own `name`/`desk` travel beside it
 * unrendered, because §8's neutral-label rule is `personaLabel`'s and the page
 * applies it (A9, `personaRosterEntry` decision 4).
 */
export const bueroDesk = z.object({
  seatId: z.string(),
  profileId: z.string(),
  department: z.string(),
  /** Which of the profile's names this chair wears, personas on. */
  name: z.string(),
  /** The neutral role label, personas off (§8's "fully disabled"). */
  desk: z.string(),
  taskId: z.string().nullable(),
  taskTitle: z.string().nullable(),
  taskState: taskStateSchema.nullable(),
  projectSlug: z.string().nullable(),
  projectReadOnly: z.boolean(),
  runId: z.string().nullable(),
  runLive: z.boolean(),
  /** When this seat was last taken — ISO, for the "seit …" line. */
  since: z.string().nullable(),
});
export type BueroDesk = z.infer<typeof bueroDesk>;

export const bueroPayload = z.object({
  personaMode: personaModeSchema,
  desks: z.array(bueroDesk),
  /**
   * Seats the cap left out, so a truncated office says so.
   *
   * A silently shortened list is the shape this project keeps finding: it reads
   * as "that is everyone" and there is no way to tell it from an office that is
   * genuinely that size.
   */
  omitted: z.number().int().min(0),
  generatedAt: z.string(),
});
export type BueroPayload = z.infer<typeof bueroPayload>;

export const bueroResponse = z.object({ buero: bueroPayload });

/** Every path exactly once (A81.3). */
export const BUERO_API = { buero: '/api/buero' } as const;

/** Where the dashboard puts the page (§17.2). */
export const BUERO_PFAD = '/buero';

/**
 * How many desks the snapshot will draw.
 *
 * A ceiling rather than a page size: §17.2 is a room, and a room with a hundred
 * desks in it answers nothing at a glance. Twenty-four is four times the
 * concurrency ceiling A7 allows (0–4) times a handful of handed-over seats per
 * task, which is the size an office actually reaches.
 */
export const BUERO_MAX_DESKS = 24;
