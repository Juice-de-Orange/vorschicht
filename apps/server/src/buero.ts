/**
 * The office snapshot (§17.2, §17 realtime).
 *
 * One request answers the whole room: who is seated, at which task, in which
 * state, and how much of §8's persona layer is switched on. The *changes* then
 * arrive over `/events` and the page patches its own copy — see
 * `@vorschicht/shared/buero` for why the wire carries the inputs and never the
 * bubble, and `apps/web/src/buero-format.ts` for the reducer that applies them.
 *
 * Three decisions this module makes, and one limit it states.
 *
 *  1. **A seat is `(role, task)`, resolved to the newest run of that pair.**
 *     §8.1 runs the coder up to three times over one task's review rounds; a
 *     seat keyed on the run id would empty the desk and seat a stranger between
 *     them. The room therefore holds a desk for every live run **and** for every
 *     finished run whose task has not reached §9's terminus — which is what
 *     makes the office a room rather than a process list: Paul is still at his
 *     desk while Clara codes what he planned.
 *
 *  2. **The names are resolved here, the labels are not.** Which chair wears
 *     "Clara" and which "Chris" depends on seat *order*, and order is a property
 *     of the snapshot — a page patching desks event by event would have to
 *     re-derive it from a list that has moved, and two answers to "who is the
 *     older coder" is two names for one person. Whether a chair shows "Clara" or
 *     "Entwicklung" at all is the other question, and that one belongs to
 *     `personaLabel` on the page (A9, `personaRosterEntry` decision 4).
 *
 *  3. **A role the profile table does not know is still seated.** It renders
 *     under its own id rather than being dropped: a session running in this
 *     studio that the office hides is precisely the shape §8.2's sixth domain
 *     hunts, and a strange name on a desk is a question somebody asks.
 *
 * **Stated limit:** a task blocked behind another task's claims (A100) sits in a
 * dispatchable state with no live run, so its desk reads `ruht` — honest about
 * the desk, silent about the collision. §17.1 carries that sentence with the
 * holder named, and repeating it here would need `ClaimRegistry` per project on
 * a page that redraws on every event.
 */

import { AGENT_PROFILES, type ProfileId } from '@vorschicht/core';
import type { TaskState } from '@vorschicht/shared';
import {
  BUERO_MAX_DESKS,
  type BueroDesk,
  type BueroPayload,
  seatBelongsInRoom,
  seatId,
  seatName,
} from '@vorschicht/shared/buero';
import type { PersonaMode } from '@vorschicht/shared/personas';
import type postgres from 'postgres';

export interface BueroDeps {
  sql: postgres.Sql;
  /** §8's switch. Read, never decided here (`PersonaSettings` owns it). */
  personaMode(): Promise<PersonaMode>;
  /** Injected so the snapshot's timestamp is assertable (`UsageMeter`'s posture). */
  now?(): number;
  /**
   * How many chairs this pass will draw. `BUERO_MAX_DESKS` unless told otherwise.
   *
   * Injectable for the reason the clock is, and with more at stake: the cap and
   * the sentence that admits to it (`ausgelassenText`) are the pair that keeps a
   * shortened room from reading as "that is everyone", and a pair nothing ever
   * exercises with a real overflow is a pair nobody has checked. Reaching the
   * real ceiling from a fixture would mean seeding twenty-five walked tasks to
   * prove one subtraction.
   */
  maxDesks?: number;
}

/** What one occupied chair looks like before the cap and before ordering. */
interface SeatRow {
  run_id: string;
  role: string;
  task_id: string | null;
  since: Date | null;
  is_finished: boolean;
  title: string | null;
  state: string | null;
  slug: string | null;
  read_only: boolean | null;
}

export async function buildBuero(deps: BueroDeps): Promise<BueroPayload> {
  const now = deps.now?.() ?? Date.now();
  const [personaMode, rows] = await Promise.all([deps.personaMode(), occupiedSeats(deps.sql)]);

  // The SQL narrows and `seatBelongsInRoom` decides, so this snapshot and the
  // page's reducer answer "is this chair still occupied" with the same function
  // rather than with a `WHERE` clause and a `filter` that merely agree today.
  const seats = rows.map((row) => toSeat(row)).filter((seat) => seatBelongsInRoom(seat));

  // Names first, over the *whole* room and oldest chair first, so the cap below
  // cannot rename anybody: Clara stays Clara even on a pass where Chris is the
  // one that fits.
  nameSeats(seats);

  // Newest activity first: what the cap drops is the quietest corner of the
  // office, not the busiest.
  seats.sort(bySinceDesc);

  const desks = seats.slice(0, deps.maxDesks ?? BUERO_MAX_DESKS);
  return {
    personaMode,
    desks,
    omitted: seats.length - desks.length,
    generatedAt: new Date(now).toISOString(),
  };
}

/**
 * Every chair that is occupied right now.
 *
 * The filter is what makes this a room and not a log: a run counts if it is
 * still going, or if the task it served has not finished. Deliberately
 * unbounded, like `stalledTasks` beside it — the predicate is "work in flight",
 * which the studio's own concurrency bounds, and an outer `LIMIT` would make
 * `omitted` a floor dressed up as a count.
 */
async function occupiedSeats(sql: postgres.Sql): Promise<SeatRow[]> {
  return sql<SeatRow[]>`
    WITH kandidat AS (
      SELECT
        r.run_id,
        r.role,
        r.task_id,
        COALESCE(r.started_at, r.created_at) AS since,
        r.is_finished,
        row_number() OVER (
          PARTITION BY r.role, COALESCE(r.task_id, '')
          ORDER BY r.created_at DESC
        ) AS rang
      FROM agent_runs r
      LEFT JOIN tasks t ON t.id::text = r.task_id
      WHERE r.role IS NOT NULL
        AND (NOT r.is_finished OR (t.id IS NOT NULL AND t.state <> ALL(ARRAY['done','aborted'])))
    )
    SELECT k.run_id, k.role, k.task_id, k.since, k.is_finished,
           t.title, t.state, p.slug, p.read_only
    FROM kandidat k
    LEFT JOIN tasks t ON t.id::text = k.task_id
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE k.rang = 1
  `;
}

function toSeat(row: SeatRow): BueroDesk {
  const profile = AGENT_PROFILES[row.role as ProfileId];
  return {
    seatId: seatId(row.role, row.task_id),
    profileId: row.role,
    // A role the table does not know keeps its id in all three places, so the
    // desk is visibly odd rather than invisibly absent.
    department: profile?.department ?? row.role,
    name: profile?.persona.name ?? row.role,
    desk: profile?.persona.desk ?? row.role,
    taskId: row.task_id,
    taskTitle: row.title,
    taskState: (row.state as TaskState | null) ?? null,
    projectSlug: row.slug,
    projectReadOnly: row.read_only ?? false,
    runId: row.run_id,
    runLive: !row.is_finished,
    since: row.since?.toISOString() ?? null,
  };
}

/**
 * Which of a profile's names each of its chairs wears (§8, A46.5).
 *
 * Oldest chair first, so a second coder arriving beside Clara becomes Chris
 * rather than pushing her out of her own name.
 */
function nameSeats(seats: BueroDesk[]): void {
  const byProfile = new Map<string, BueroDesk[]>();
  for (const seat of seats) {
    const list = byProfile.get(seat.profileId);
    if (list) list.push(seat);
    else byProfile.set(seat.profileId, [seat]);
  }
  for (const [profileId, chairs] of byProfile) {
    const persona = AGENT_PROFILES[profileId as ProfileId]?.persona;
    chairs.sort(bySinceAsc);
    chairs.forEach((chair, index) => {
      chair.name = persona ? seatName(persona, index) : chair.name;
    });
  }
}

/**
 * A chair with no timestamp sorts **last in both directions**, which is why the
 * two comparators substitute different sentinels rather than sharing one.
 *
 * `since` is null only for a run whose `created` event carries no time, which
 * this schema does not produce — the fallback exists so that a row of a shape
 * nobody anticipated cannot take the front of the room, in either order. Finite
 * sentinels rather than infinities: two nulls would otherwise subtract to `NaN`
 * and `Array.sort` would leave the room in whatever order it found it.
 */
function bySinceAsc(a: BueroDesk, b: BueroDesk): number {
  return sinceValue(a, Number.MAX_SAFE_INTEGER) - sinceValue(b, Number.MAX_SAFE_INTEGER);
}

function bySinceDesc(a: BueroDesk, b: BueroDesk): number {
  return sinceValue(b, 0) - sinceValue(a, 0);
}

function sinceValue(desk: BueroDesk, fallback: number): number {
  if (!desk.since) return fallback;
  const parsed = Date.parse(desk.since);
  return Number.isNaN(parsed) ? fallback : parsed;
}
