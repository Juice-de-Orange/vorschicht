import {
  type AufgabeAngelegt,
  type AufgabeAnlegenEingabe,
  type AufgabeProjektwahl,
  aufgabeAnlegenEingabe,
} from '@vorschicht/shared/aufgaben';

/**
 * `POST /api/aufgaben` — the one place a person can put work into this studio.
 *
 * Everything below is translation. What a task *is*, which states it may start
 * in and what happens to it next belongs to `TaskService` and §9's transition
 * map; what the shape of a submission is belongs to
 * `@vorschicht/shared/aufgaben`. This module adds three things a transport
 * needs and one the model deliberately does not do.
 *
 *  1. **A refusal is a value, never an exception.** `quellen.ts` and
 *     `dokumente.ts`'s posture, and load-bearing rather than tidy: there is no
 *     `app.onError` anywhere in this app, so a throw becomes a plain-text 500
 *     with an English stack behind it — for a mistyped field.
 *
 *  2. **The order of the checks is the design.** Unknown project first (there
 *     is nothing to talk about), then whether that project can take work *at
 *     all*, and only then whether the body is well formed. That middle step
 *     before the parse is `quellen.ts`'s reasoning: a caller filing against a
 *     read-only project has nothing to fix in their submission, and sending
 *     them to correct a form whose submission can never succeed is the least
 *     useful answer available.
 *
 *  3. **§19's row is written in the task's own transaction.** A44.3's rule —
 *     a guarantee that depends on every future caller remembering it is not a
 *     guarantee. `anlegen` takes a handle that carries both, so a task with
 *     nothing saying who created it is not a state this can reach.
 *
 *  4. **A read-only project is refused here, not left to the scheduler.** It
 *     would otherwise be accepted, sit in `queued` forever and appear in
 *     `TickReport.readOnly` — a task that looks filed and is not. A44.3 holds
 *     that boundary at the worktree manager's door; this is the door before it,
 *     and the one a person knocks on.
 */

export type AufgabenRefusal = 'unknown' | 'conflict' | 'invalid';

export type AufgabenResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: AufgabenRefusal; errors: string[] };

export const AUFGABEN_STATUS: Record<AufgabenRefusal, 404 | 409 | 422> = {
  unknown: 404,
  conflict: 409,
  invalid: 422,
};

/** What the module needs to know about a project, and nothing more. */
export interface AufgabenProjekt {
  id: string;
  slug: string;
  name: string;
  readOnly: boolean;
}

/** The task the write produced, as the page needs it back. */
export interface AngelegteAufgabe {
  id: string;
  title: string;
  state: string;
  priority: string;
  projectId: string;
}

export interface AufgabenTransaction {
  create(input: {
    projectId: string;
    title: string;
    description?: string;
    acceptanceCriteria: readonly string[];
    priority: AufgabeAnlegenEingabe['prioritaet'];
    department?: string;
    type: string;
    initialState: AufgabeAnlegenEingabe['anfangszustand'];
    actor: string;
  }): Promise<AngelegteAufgabe>;
  audit(entry: {
    actor: string;
    taskId: string;
    projectId: string;
    title: string;
    priority: string;
    initialState: string;
    acceptanceCriteria: readonly string[];
  }): Promise<void>;
}

export interface AufgabenDeps {
  projekte(): Promise<readonly AufgabenProjekt[]>;
  anlegen<T>(fn: (tx: AufgabenTransaction) => Promise<T>): Promise<T>;
}

const UNBEKANNTES_PROJEKT = 'Dieses Projekt gibt es nicht.';

/** The select on the form: which projects can currently take a task. */
export async function listProjektwahl(
  deps: AufgabenDeps,
): Promise<AufgabenResult<AufgabeProjektwahl>> {
  const projekte = await deps.projekte();
  return {
    ok: true,
    value: {
      projekte: projekte.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        readOnly: p.readOnly,
      })),
    },
  };
}

export async function anlegenAufgabe(
  deps: AufgabenDeps,
  body: unknown,
  actor: string,
): Promise<AufgabenResult<AufgabeAngelegt>> {
  // The project id is needed before the parse, because decision 2 puts
  // "can this project take work" ahead of "is this form filled in correctly".
  // Reading it defensively rather than through the schema keeps that order.
  const rohProjekt =
    typeof body === 'object' && body !== null && 'projektId' in body
      ? (body as { projektId: unknown }).projektId
      : undefined;

  const projekte = await deps.projekte();
  const projekt =
    typeof rohProjekt === 'string' ? projekte.find((p) => p.id === rohProjekt) : undefined;

  if (!projekt) {
    return { ok: false, reason: 'unknown', errors: [UNBEKANNTES_PROJEKT] };
  }

  if (projekt.readOnly) {
    return {
      ok: false,
      reason: 'conflict',
      errors: [
        `„${projekt.name}" ist auf nur-lesend gestellt und nimmt keine Arbeit an. ` +
          'Der Ablaufplaner würde die Aufgabe überspringen, sie stünde also für immer ' +
          'in der Warteschlange (A85/A44.3).',
      ],
    };
  }

  const parsed = aufgabeAnlegenEingabe.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      reason: 'invalid',
      errors: parsed.error.issues.map((issue) =>
        issue.path.length > 0 ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
      ),
    };
  }

  const eingabe = parsed.data;

  const aufgabe = await deps.anlegen(async (tx) => {
    const angelegt = await tx.create({
      projectId: eingabe.projektId,
      title: eingabe.titel,
      ...(eingabe.beschreibung !== undefined ? { description: eingabe.beschreibung } : {}),
      acceptanceCriteria: eingabe.akzeptanzkriterien,
      priority: eingabe.prioritaet,
      ...(eingabe.abteilung !== undefined ? { department: eingabe.abteilung } : {}),
      type: eingabe.art,
      initialState: eingabe.anfangszustand,
      actor,
    });
    await tx.audit({
      actor,
      taskId: angelegt.id,
      projectId: angelegt.projectId,
      title: angelegt.title,
      priority: angelegt.priority,
      initialState: angelegt.state,
      acceptanceCriteria: eingabe.akzeptanzkriterien,
    });
    return angelegt;
  });

  return {
    ok: true,
    value: {
      aufgabe: {
        id: aufgabe.id,
        titel: aufgabe.title,
        zustand: aufgabe.state,
        prioritaet: aufgabe.priority as AufgabeAnlegenEingabe['prioritaet'],
        projektId: aufgabe.projectId,
      },
    },
  };
}
