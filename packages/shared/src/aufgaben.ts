import { z } from 'zod';
import { PRIORITIES, type Priority } from './constants.js';

/**
 * Re-exported so the form has **one** import.
 *
 * `constants.ts` is browser-safe (it imports nothing) but is only reachable
 * through the barrel, which pulls `node:path` (A75.5). Adding a second subpath
 * export for one array would be a second door to the same table; the contract
 * that already needs it hands it on.
 */
export { PRIORITIES, type Priority };

/**
 * §17's missing door: the place where work enters this studio.
 *
 * Until now a task could only appear as a **side effect** — a Betriebsprüfung
 * finding (`audit-service.ts`), an idle audit (`idle-audit.ts`), a radar scan
 * (`scans/radar/scan.ts`). There was no route, no MCP tool, no page and no
 * production script, so the only work the studio could do was work it had
 * assigned itself. §17.1 has the operator entering goals in the dashboard and §8 has the
 * Product Lead decomposing them; neither exists, and `goals` is an entity in §5
 * with no table. This is the smaller half, and the one that unblocks a pilot:
 * a task, with acceptance criteria, created by a person.
 *
 * The data model has been expecting it. `CreateTaskSpec.runId`, in
 * `packages/core/src/task-service.ts`, says so in as many words: *"Absent for a
 * task a human or the Product Lead created, which is the ordinary case."*
 *
 * Four decisions, and the first is the only one with teeth.
 *
 *  1. **At least one acceptance criterion, enforced here.** §8.1 has the
 *     Planner work from "task + acceptance criteria + project conventions", and
 *     A48.3 records what happens without them: "a title is not a mandate, and an
 *     agent handed only a title has to guess what 'done' means — which is
 *     exactly what §1 principle 6 forbids". `CreateTaskSpec` makes them
 *     optional because the audit and radar producers fill them from their own
 *     findings; a human filling a form can leave them out by accident, so this
 *     is the layer that refuses. `.min(1)` on the array is the whole mechanism.
 *
 *  2. **`draft` or `queued`, and nothing else.** Those are the two initial
 *     states `task_events`' own trigger accepts (0006), and offering a third
 *     would be a form that produces a database error. `draft` exists so the operator can
 *     write a task down without the scheduler picking it up on the next tick.
 *
 *  3. **English identifiers, German values** — `./dokumente.ts`'s rule. Every
 *     string a person reads is German (§2); the JSON keys are read by a
 *     program.
 *
 *  4. **No `runId`, no `parentTaskId`, no `worktreePath`.** They are fields the
 *     machine fills, and a route that accepted them would let a form claim a
 *     task came from a session that never ran. §18's chain is only worth
 *     something if nothing but the runner can write that link.
 *
 * Browser-safe by construction: this module imports `zod` and `./constants.js`
 * (a table of literals) and nothing else. Reachable through the
 * `@vorschicht/shared/aufgaben` subpath for the reason `./gates` and
 * `./dokumente` are — the barrel pulls `node:path` (A75.5).
 */

/** Where the page lives. One declaration, because A81.3 is what two cost. */
export const AUFGABE_ANLEGEN_PFAD = '/aufgaben';

/** The two states `task_events` accepts as a first row (migration 0006). */
export const AUFGABE_ANFANGSZUSTAENDE = ['queued', 'draft'] as const;
export type AufgabeAnfangszustand = (typeof AUFGABE_ANFANGSZUSTAENDE)[number];

/** German labels for the form; the values above are what travels. */
export const AUFGABE_ANFANGSZUSTAND_LABEL: Record<AufgabeAnfangszustand, string> = {
  queued: 'Sofort einplanen',
  draft: 'Erst nur notieren',
};

/**
 * Caps, so a form cannot write a row nobody can read back.
 *
 * The numbers are not arbitrary: the title goes into an agent prompt and into
 * every list in the dashboard, and the criteria are read out to three sessions
 * per attempt (Planner, Coder, Reviewer). What they protect against is not
 * malice but a pasted document, which is the ordinary accident.
 */
export const AUFGABE_TITEL_MAX = 200;
export const AUFGABE_BESCHREIBUNG_MAX = 8_000;
export const AUFGABE_KRITERIUM_MAX = 1_000;
export const AUFGABE_KRITERIEN_MAX = 20;

const nichtLeer = (feld: string) => z.string().trim().min(1, `${feld} darf nicht leer sein.`);

export const aufgabeAnlegenEingabe = z.object({
  projektId: z.uuid('Die Projektkennung ist keine gültige uuid.'),
  titel: nichtLeer('Der Titel').max(
    AUFGABE_TITEL_MAX,
    `Der Titel ist länger als ${AUFGABE_TITEL_MAX} Zeichen.`,
  ),
  beschreibung: z
    .string()
    .trim()
    .max(
      AUFGABE_BESCHREIBUNG_MAX,
      `Die Beschreibung ist länger als ${AUFGABE_BESCHREIBUNG_MAX} Zeichen.`,
    )
    .optional(),
  // §8.1 and A48.3: at least one, and this is the layer that refuses.
  akzeptanzkriterien: z
    .array(
      nichtLeer('Ein Akzeptanzkriterium').max(
        AUFGABE_KRITERIUM_MAX,
        `Ein Akzeptanzkriterium ist länger als ${AUFGABE_KRITERIUM_MAX} Zeichen.`,
      ),
    )
    .min(1, 'Ohne mindestens ein Akzeptanzkriterium weiß niemand, wann die Aufgabe fertig ist.')
    .max(AUFGABE_KRITERIEN_MAX, `Mehr als ${AUFGABE_KRITERIEN_MAX} Kriterien sind zu viele.`),
  prioritaet: z.enum(PRIORITIES).default('P2'),
  abteilung: z.string().trim().min(1).max(60).optional(),
  // Free text like `CreateTaskSpec.type`: the producers use `audit_finding`,
  // `radar` and `idle_audit`, and a human-created task says so.
  art: z.string().trim().min(1).max(60).default('manuell'),
  anfangszustand: z.enum(AUFGABE_ANFANGSZUSTAENDE).default('queued'),
});

export type AufgabeAnlegenEingabe = z.infer<typeof aufgabeAnlegenEingabe>;

/** What the route answers with — enough for the page to link to the new task. */
export const aufgabeAngelegt = z.object({
  aufgabe: z.object({
    id: z.uuid(),
    titel: z.string(),
    zustand: z.string(),
    prioritaet: z.enum(PRIORITIES),
    projektId: z.uuid(),
  }),
});

export type AufgabeAngelegt = z.infer<typeof aufgabeAngelegt>;

/** The projects a task can be filed against, for the form's select. */
export const aufgabeProjektwahl = z.object({
  projekte: z.array(
    z.object({
      id: z.uuid(),
      slug: z.string(),
      name: z.string(),
      /** A83.6/A44.3: a read-only project takes no work, and the form says so. */
      readOnly: z.boolean(),
    }),
  ),
});

export type AufgabeProjektwahl = z.infer<typeof aufgabeProjektwahl>;
