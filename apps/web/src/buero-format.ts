/**
 * §17.2's office in plain functions — above all the reducer the exit gate rests
 * on.
 *
 * Same arrangement as `./einstellungen-format.ts` and for the same reason:
 * `apps/web` has **no DOM test environment**, so a rule living inside a
 * component is a rule only Playwright can reach. `Buero.tsx` renders and decides
 * nothing; everything that can be wrong without a browser noticing is here.
 *
 * The shapes are `@vorschicht/shared/buero`'s and they are **parsed**, never
 * cast (A81). §8's neutral-label rule and §17.2's bubble rule are re-exported
 * rather than wrapped, for `einstellungen-format.ts`'s reason — two answers to
 * "what is this desk called" or "what state is it in" is the defect, and a
 * convenience wrapper on one side is how they start to differ.
 *
 * **Why the state is patched and not re-fetched.** The exit gate asks that the
 * office reflect a real state change in under a second, end to end. A page that
 * answered an event by asking the server again would be a page whose latency is
 * a round trip plus a query plus whatever else is in flight — and, worse, one
 * whose freshness is a property of the poll interval rather than of the event.
 * So a frame changes the desk in the same tick it arrives, and the *only* thing
 * that triggers a fresh snapshot is a colleague the room has never seen: a
 * `run.created` naming a seat we do not hold, whose task title the stream does
 * not carry. That is a new desk, not a state change, and it is outside the
 * sentence the gate measures.
 *
 * `SCHNAPPSCHUSS_MS` is the backstop for everything the stream cannot express —
 * a desk that left the room because its project was deleted, a reducer that
 * dropped a frame during a reconnect. It is deliberately slow: a page that
 * polled quickly would pass the gate's measurement without the stream working at
 * all, and then the measurement would be proving the poll.
 */
import {
  BUERO_API,
  BUERO_PFAD,
  type BueroDesk,
  type BueroPayload,
  bueroResponse,
  DESK_STATE_COLORS,
  DESK_STATE_HINTS,
  DESK_STATE_LABELS,
  type DeskState,
  deskState,
  seatBelongsInRoom,
  seatId,
  TASK_STATE_LABELS,
  TASK_STATES,
  type TaskState,
} from '@vorschicht/shared/buero';
import { type PersonaMode, personaAlternates, personaLabel } from '@vorschicht/shared/personas';
import { type Gelesen, lies } from './inbox-format.js';

export type { BueroDesk, BueroPayload, DeskState, PersonaMode };
export {
  BUERO_API,
  BUERO_PFAD,
  DESK_STATE_COLORS,
  DESK_STATE_HINTS,
  DESK_STATE_LABELS,
  deskState,
  personaAlternates,
  personaLabel,
};

/**
 * How often the page asks for the whole room again, as a backstop only.
 *
 * Thirty seconds, the same figure `Overview.tsx` uses for the same job. Sharp
 * enough that a dropped frame is not permanent, slow enough that it cannot be
 * mistaken for the live path — which is what makes the gate's measurement a
 * statement about the stream.
 */
export const SCHNAPPSCHUSS_MS = 30_000;

export function leseBuero(koerper: unknown): Gelesen<BueroPayload> {
  const gelesen = lies(bueroResponse, koerper, 'das Büro');
  return gelesen.ok ? { ok: true, wert: gelesen.wert.buero } : gelesen;
}

// ---------------------------------------------------------------------------
// The stream
// ---------------------------------------------------------------------------

/** One frame off `/events`, as far as the office reads it. */
export interface Ereignis {
  kind: string;
  taskId?: string | null;
  runId?: string | null;
  payload?: unknown;
}

export interface Aenderung {
  desks: BueroDesk[];
  /**
   * Did this frame name somebody the room does not know?
   *
   * Only ever true for a seat we do not hold — the stream carries a task's *id*
   * and never its title, so a new colleague cannot be drawn from a frame alone.
   * Never true for a state change, which is the case the exit gate measures.
   */
  brauchtSchnappschuss: boolean;
}

/**
 * Which frames the office subscribes to — and why this list exists at all.
 *
 * `formatEvent` names every frame it sends (`event: <kind>`), and
 * `EventSource.onmessage` fires only for the default `message` type. A page
 * wired to `onmessage` therefore receives **nothing** off this stream while
 * reporting a healthy connection — found by a browser run that connected, said
 * "Live verbunden.", and then timed out on a park that had certainly been
 * written. So the page registers a listener per kind, and the kinds have to be
 * enumerable.
 *
 * Which makes this list the one place the two halves can drift: a case added to
 * `wendeEreignisAn` and not added here is a rule that runs in every test and
 * never once in a browser — §8.2's sixth domain, in the shape that is hardest to
 * see. `buero-format.test.ts` walks it against the reducer for that reason.
 */
export const BUERO_EREIGNISARTEN = [
  'task.state_changed',
  'run.created',
  'run.finished',
  'run.interrupted',
] as const;

const UNVERAENDERT = (desks: BueroDesk[]): Aenderung => ({
  desks,
  brauchtSchnappschuss: false,
});

/**
 * Apply one frame to the room.
 *
 * Pure and synchronous, so the render happens in the tick the frame arrives in.
 * Returns the same array object when nothing matched, which lets the component
 * skip a re-render for the overwhelming majority of frames — this stream carries
 * everything the studio does, and most of it is not about a desk.
 */
export function wendeEreignisAn(desks: BueroDesk[], ereignis: Ereignis): Aenderung {
  switch (ereignis.kind) {
    case 'task.state_changed':
      return aufgabeGewechselt(desks, ereignis);
    case 'run.created':
      return laufBegonnen(desks, ereignis);
    case 'run.finished':
    case 'run.interrupted':
      return laufBeendet(desks, ereignis);
    default:
      return UNVERAENDERT(desks);
  }
}

/**
 * §9's transition, straight onto the desk.
 *
 * This is the whole live path: one field, and the bubble follows from
 * `deskState`. Park, resume, escalation and the answer that ends it are all this
 * one frame — which is why the gate can name three of them and measure one
 * mechanism.
 *
 * A frame naming no task is ignored rather than treated as a miss: §7.3's
 * wrap-up writes a summary row with no `taskId` at all, and asking the server
 * for a fresh room on every guardian transition would be a poll wearing an
 * event's clothes.
 */
function aufgabeGewechselt(desks: BueroDesk[], ereignis: Ereignis): Aenderung {
  const taskId = ereignis.taskId ?? null;
  const nach = zielZustand(ereignis.payload);
  if (!taskId || nach === null) return UNVERAENDERT(desks);
  if (!desks.some((desk) => desk.taskId === taskId)) return UNVERAENDERT(desks);

  const naechste = desks
    .map((desk) => (desk.taskId === taskId ? { ...desk, taskState: nach } : desk))
    .filter((desk) => seatBelongsInRoom(desk));
  return { desks: naechste, brauchtSchnappschuss: false };
}

/**
 * Somebody sat down.
 *
 * A seat we already hold — the coder returning for a second review round (§8.1)
 * — is patched in place, because the desk is the pair `(profile, task)` and that
 * pair has not changed. A seat we do not hold is a new colleague whose task
 * title the stream cannot tell us, so the room is asked for again.
 */
function laufBegonnen(desks: BueroDesk[], ereignis: Ereignis): Aenderung {
  const role = zeichenkette(ereignis.payload, 'role');
  const runId = ereignis.runId ?? null;
  if (!role || !runId) return UNVERAENDERT(desks);

  const platz = seatId(role, ereignis.taskId ?? null);
  const sitzt = desks.some((desk) => desk.seatId === platz);
  if (!sitzt) return { desks, brauchtSchnappschuss: true };

  return {
    desks: desks.map((desk) => (desk.seatId === platz ? { ...desk, runId, runLive: true } : desk)),
    brauchtSchnappschuss: false,
  };
}

/**
 * The session ended — the desk stays if its task has not finished.
 *
 * Matched on the run id rather than on the seat, because that is the identity
 * the frame carries and because a desk whose seat has since been re-taken by a
 * newer run must not be emptied by the older one's ending.
 */
function laufBeendet(desks: BueroDesk[], ereignis: Ereignis): Aenderung {
  const runId = ereignis.runId ?? null;
  if (!runId || !desks.some((desk) => desk.runId === runId)) return UNVERAENDERT(desks);

  const naechste = desks
    .map((desk) => (desk.runId === runId ? { ...desk, runLive: false } : desk))
    .filter((desk) => seatBelongsInRoom(desk));
  return { desks: naechste, brauchtSchnappschuss: false };
}

/**
 * `payload.to`, if it names a state §9 has.
 *
 * Checked against `TASK_STATES` rather than trusted: this is the one value on
 * the whole live path, and an unrecognised string written straight onto the desk
 * would make `deskState` throw inside a render — turning a strange event into a
 * blank dashboard.
 */
function zielZustand(payload: unknown): TaskState | null {
  const roh = zeichenkette(payload, 'to');
  return roh && (TASK_STATES as readonly string[]).includes(roh) ? (roh as TaskState) : null;
}

function zeichenkette(payload: unknown, feld: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const wert = (payload as Record<string, unknown>)[feld];
  return typeof wert === 'string' && wert.length > 0 ? wert : null;
}

// ---------------------------------------------------------------------------
// Sentences (§2)
// ---------------------------------------------------------------------------

/** What one chair is called under the mode in force (§8, A9). */
export function platzName(desk: BueroDesk, mode: PersonaMode): string {
  return personaLabel(mode, { name: desk.name, desk: desk.desk });
}

/**
 * The line under the avatar: what this desk is holding.
 *
 * §17.2 asks for the bubble "with current task title", so the title is the
 * sentence and the state is its qualifier. A desk with no task says so rather
 * than showing an empty line — a session with no task is a real thing in this
 * studio (§8.2's auditor, §20's onboarding, §6.1's probe) and A56.5 is why.
 */
export function platzZeile(desk: BueroDesk): string {
  const zustand = DESK_STATE_LABELS[deskState(desk)];
  if (!desk.taskId) return `${zustand} · ohne Aufgabe`;
  return `${zustand} · ${desk.taskTitle ?? 'Aufgabe ohne Titel'}`;
}

/**
 * The detail panel's sentence about why this desk is where it is.
 *
 * It names §9's state in German, because "blockiert" alone does not distinguish
 * a task waiting for its integrity check from one whose project is read-only —
 * and those are two different things to do next.
 */
export function platzBegruendung(desk: BueroDesk): string {
  const kugel = deskState(desk);
  const teile = [DESK_STATE_HINTS[kugel]];
  if (desk.taskState) teile.push(`Aufgabenzustand: ${TASK_STATE_LABELS[desk.taskState]}.`);
  if (desk.projectReadOnly) {
    teile.push('Das Projekt steht auf Nur-Lesen — der Ablaufplaner überspringt es (A44.3).');
  }
  return teile.join(' ');
}

/**
 * "seit 14:03" — when this chair was taken.
 *
 * The clock rather than a duration, because a duration on a page that redraws
 * every few seconds is a number that keeps moving for no reason, and because
 * "seit 14:03" is what a person compares against everything else on their screen.
 */
export function seitZeile(desk: BueroDesk): string | null {
  if (!desk.since) return null;
  const zeit = new Date(desk.since);
  if (Number.isNaN(zeit.getTime())) return null;
  return `seit ${zeit.toLocaleTimeString('de-AT', { hour: '2-digit', minute: '2-digit' })}`;
}

/**
 * §17.2's second half: where a desk leads.
 *
 * "click any employee → their current task **and trace**." The trace explorer is
 * Phase 7 step 3 and is being built in parallel; these are *its* routes, written
 * down here because a link is all this view owes. Nothing in the office imports
 * the explorer, so a desk keeps working whether or not that page exists yet —
 * and a link that does not resolve is a visibly broken link, which is a better
 * failure than a click that silently does nothing.
 *
 * **Stated plainly: this is one path declared in two places, which is A81.3's
 * defect** — one `/inbox` against one `/posteingang` cost this project every
 * deep link in every notification, silently. It is accepted here only because
 * both alternatives are worse: importing the explorer's module would couple this
 * page to work in flight, and inventing a route of my own would put a *third*
 * spelling in the tree. The moment the explorer exports its own constants these
 * two lines should be deleted in favour of them — a one-line change, named in
 * the handover rather than left to be found by whoever clicks first.
 */
export const SPUR_AUFGABE_PFAD = '/aufgaben';
export const SPUR_LAUF_PFAD = '/laeufe';

/** The task's page in the explorer — its timeline, diffs and gate output. */
export function aufgabenPfad(taskId: string): string {
  return `${SPUR_AUFGABE_PFAD}/${encodeURIComponent(taskId)}`;
}

/** The session's page — where §22's "exact transcript line" lives. */
export function laufPfad(runId: string): string {
  return `${SPUR_LAUF_PFAD}/${encodeURIComponent(runId)}`;
}

/** The room's own line when nobody is in it — and why that is not an error. */
export const BUERO_LEER =
  'Gerade sitzt niemand im Büro. Sobald eine Sitzung startet, erscheint hier ein Schreibtisch.';

/** What a truncated room says, so a cap never reads as "that is everyone". */
export function ausgelassenText(omitted: number): string | null {
  if (omitted <= 0) return null;
  return omitted === 1
    ? '1 weiterer Platz wird nicht gezeigt.'
    : `${omitted} weitere Plätze werden nicht gezeigt.`;
}
