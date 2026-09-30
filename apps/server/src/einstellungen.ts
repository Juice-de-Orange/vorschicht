/**
 * §17.9's settings page, over HTTP — for now the one setting §8 defines: how
 * much of the persona layer is switched on.
 *
 * `@vorschicht/shared/personas` owns what the three modes mean and
 * `PersonaSettings` owns persistence and §19's trail. Nothing here re-decides
 * either. What this module adds is the translation a transport needs.
 *
 * Four decisions, three of them this house's and stated because the next
 * setting to arrive on this page should follow them.
 *
 *  1. **A refusal is a value, never an exception** — `quellen.ts`, `dokumente.ts`
 *     and `inbox.ts`'s posture, and load-bearing rather than tidy: there is no
 *     `app.onError` anywhere in this app, so a throw becomes a plain-text 500
 *     with an English stack behind it, on a page whose every other string is
 *     German (§2).
 *
 *  2. **The actor is the session, never a default.** `PersonaSettings.setMode`
 *     takes it as a required argument for A75.3's reason, and this layer's only
 *     job is to pass what the session says rather than what would be convenient.
 *     A trail in which every persona change was made by `system` answers *that*
 *     something changed and loses the question §19 keeps it for.
 *
 *  3. **A read is never refused because the *write* half is missing.** The GET
 *     needs no actor and no transaction, so it answers from the same deps with
 *     no extra ceremony; the roster travels with the mode because the page needs
 *     both to render one line, and two round trips for one page is two chances
 *     to render a mode against a roster that no longer matches it.
 *
 *  4. **The response carries the raw identity, never a rendered label.** §8's
 *     "neutral role labels" rule lives in `personaLabel`, and the page applies
 *     it. A server that sent the finished string would be a second implementation
 *     of the one rule this whole feature turns on — and the browser test that
 *     proves the rule would then be proving the server's copy of it.
 */
import { CONCURRENCY_RANGE } from '@vorschicht/shared';
import {
  type BenachrichtigungenView,
  type EinstellungenSeiteResponse,
  PRUEFPROTOKOLL_LIMIT,
  type PruefprotokollEintragView,
  SICHERUNG_ERGEBNISSE,
  type SicherungErgebnis,
  type SicherungStatusView,
} from '@vorschicht/shared/einstellungen';
import {
  type EinstellungenBody,
  germanPersonaIssues,
  type PersonaMode,
  type PersonaRosterEntry,
  parsePersonaModeSubmission,
} from '@vorschicht/shared/personas';
import type postgres from 'postgres';
import {
  readSicherung,
  SICHERUNG_KOMPONENTEN,
  SICHERUNG_KOMPONENTEN_LABELS,
  sicherungKachel,
} from './betrieb.js';

/** Exactly the calls this module makes (`SmokeRunner`'s posture, A57.6). */
export interface EinstellungenDeps {
  mode(): Promise<PersonaMode>;
  setMode(mode: PersonaMode, actor: string): Promise<{ before: PersonaMode; after: PersonaMode }>;
  roster(): PersonaRosterEntry[];
}

/**
 * Three outcomes, three status codes.
 *
 * No `unknown`: there is exactly one settings document and it always exists,
 * because a missing row is the default rather than an absence (0022 decision 3).
 * `failed` is a 500 that still answers in German rather than as a naked stack.
 */
export type EinstellungenResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'invalid'; errors: string[] }
  | { ok: false; reason: 'failed'; errors: string[] };

export const EINSTELLUNGEN_STATUS = { invalid: 422, failed: 500 } as const;

/** The page's whole payload: the mode in force and the desks it applies to. */
export async function getPersonaSettings(
  deps: EinstellungenDeps,
): Promise<EinstellungenResult<EinstellungenBody>> {
  try {
    const mode = await deps.mode();
    return { ok: true, value: { personas: { mode, roster: deps.roster() } } };
  } catch (cause) {
    return failed(cause);
  }
}

/**
 * Move the switch (§8), audited (§19).
 *
 * The reply is the whole payload rather than an acknowledgement, so the page
 * renders what was actually stored instead of what it hoped it had sent — the
 * difference matters here because the mode decides how every name on that same
 * page is rendered.
 */
export async function setPersonaMode(
  deps: EinstellungenDeps,
  body: unknown,
  actor: string,
): Promise<EinstellungenResult<EinstellungenBody>> {
  const parsed = parsePersonaModeSubmission(body);
  if (!parsed.ok) return { ok: false, reason: 'invalid', errors: parsed.errors };
  try {
    const change = await deps.setMode(parsed.value.mode, actor);
    return { ok: true, value: { personas: { mode: change.after, roster: deps.roster() } } };
  } catch (cause) {
    return failed(cause);
  }
}

/**
 * §17.9s ganze Seite, über die vier Dinge hinaus, die der Persona-Schalter
 * braucht.
 *
 * Die Kanäle kommen als **Werte** herein und werden nicht aus `loadConfig`
 * gelesen: dieser Prozess hat die Konfiguration beim Start geladen, und ein
 * zweiter Zugriff hier wäre eine zweite Wahrheit über denselben Wert. Der
 * Aufrufer reicht durch, was er selbst fährt — dieselbe Haltung, die
 * `controllingDeps.betrieb` für A7s Nebenläufigkeit hat.
 */
export interface EinstellungenSeitenDeps extends EinstellungenDeps {
  sql: postgres.Sql;
  /** Was der Daemon fährt (A7), aus derselben Konstante wie dort. */
  betrieb: { planProfile: string; concurrency: number };
  /**
   * §16s Kanäle, ohne jedes Geheimnis.
   *
   * Der Aufrufer entscheidet, was „gesetzt" heisst, und gibt **nie** den Wert
   * weiter — §19 hält `ntfyToken` und `smtpPassword` aus jedem Transport, und
   * hier gibt es strukturell kein Feld dafür.
   */
  benachrichtigungen: BenachrichtigungenView;
  /** Injiziert, damit die Altersaussage der Sicherungskachel prüfbar ist. */
  now?: () => number;
}

export async function getEinstellungenSeite(
  deps: EinstellungenSeitenDeps,
): Promise<EinstellungenResult<EinstellungenSeiteResponse>> {
  try {
    const [mode, sicherung, pruefprotokoll] = await Promise.all([
      deps.mode(),
      readSicherung(deps.sql),
      readPruefprotokoll(deps.sql),
    ]);
    return {
      ok: true,
      value: {
        einstellungen: {
          personas: { mode, roster: deps.roster() },
          // A7s Bandbreite kommt aus derselben Konstante, die §17.8s Seite
          // liest, statt vom Aufrufer: der weiss, was der Daemon *fährt*, und
          // nicht, was einstellbar wäre.
          betrieb: {
            ...deps.betrieb,
            concurrencyRange: { min: CONCURRENCY_RANGE.min, max: CONCURRENCY_RANGE.max },
          },
          benachrichtigungen: deps.benachrichtigungen,
          sicherung: sicherungStatus(sicherung, deps.now?.() ?? Date.now()),
          pruefprotokoll: { eintraege: pruefprotokoll, limit: PRUEFPROTOKOLL_LIMIT },
        },
      },
    };
  } catch (cause) {
    return failed(cause);
  }
}

/**
 * §18s Sicherungsstand für die Seite: dieselbe Kachel wie auf der Übersicht,
 * plus die Einzelheiten, die auf eine Kachel nicht passen.
 *
 * Die Komponenten werden über `SICHERUNG_KOMPONENTEN` **abgeleitet** statt über
 * das aufgezählt, was die Nutzlast mitbringt. Der Unterschied ist der ganze
 * Punkt: eine Komponente, die der Erzeuger gar nicht gemeldet hat, erscheint so
 * als `unbekannt` — und verschwindet nicht einfach aus der Liste, wo ihr Fehlen
 * wie „in Ordnung" aussähe (A103s Ausfall war ein partieller).
 */
export function sicherungStatus(
  beobachtung: Awaited<ReturnType<typeof readSicherung>>,
  jetzt: number,
): SicherungStatusView {
  const kachel = sicherungKachel(beobachtung, jetzt);
  if (!beobachtung) {
    return { kachel, stand: null, komponenten: [], problem: null, gemeldetAm: null };
  }
  return {
    kachel,
    stand: beobachtung.stamp,
    komponenten: SICHERUNG_KOMPONENTEN.map((id) => ({
      id,
      label: SICHERUNG_KOMPONENTEN_LABELS[id],
      ergebnis: alsErgebnis(beobachtung.components[id]),
    })),
    problem: beobachtung.problem,
    gemeldetAm: beobachtung.occurredAt.toISOString(),
  };
}

/** Ein Wert, den dieser Leser nicht kennt, ist `unbekannt` und nie `ok`. */
function alsErgebnis(roh: string | undefined): SicherungErgebnis {
  return (SICHERUNG_ERGEBNISSE as readonly string[]).includes(roh ?? '')
    ? (roh as SicherungErgebnis)
    : 'unbekannt';
}

/**
 * §19s jüngste Einträge.
 *
 * Gedeckelt, und die Grenze reist mit (`pruefprotokollView.limit`): §19 hebt
 * diese Tabelle für immer auf, und eine gedeckelte Liste, die das nicht sagt,
 * liest sich als vollständige Antwort.
 */
async function readPruefprotokoll(sql: postgres.Sql): Promise<PruefprotokollEintragView[]> {
  const rows = await sql<
    Array<{
      id: string | number;
      occurred_at: Date;
      actor: string;
      action: string;
      subject: string | null;
      before: unknown;
      after: unknown;
    }>
  >`
    SELECT id, occurred_at, actor, action, subject, before, after
    FROM audit_log ORDER BY id DESC LIMIT ${PRUEFPROTOKOLL_LIMIT}
  `;
  return rows.map((row) => ({
    id: Number(row.id),
    occurredAt: row.occurred_at.toISOString(),
    actor: row.actor,
    action: row.action,
    subject: row.subject,
    before: row.before,
    after: row.after,
  }));
}

function failed(cause: unknown): EinstellungenResult<never> {
  // The message rather than the stack: this reaches a page (§2), and a stack
  // trace on it would be both unreadable and more than a reader needs.
  const detail = cause instanceof Error ? cause.message : String(cause);
  return {
    ok: false,
    reason: 'failed',
    errors: [`Einstellung konnte nicht gespeichert werden: ${detail}`],
  };
}

/** Re-exported so a caller assembling a refusal uses the same wording. */
export { germanPersonaIssues };
