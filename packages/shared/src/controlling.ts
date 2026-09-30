/**
 * §17.8's Controlling page: what the two switches mean, and how a budget number
 * has to be labelled before a person is allowed to read it.
 *
 * Same arrangement as `./gates.ts`, `./personas.ts` and `./quellen.ts`, and for
 * the same reason: three parties need these rules and only one of them may
 * touch a database. The page renders the switches, the API validates a change
 * against them, and the orchestrator reads the stored values. A catalogue
 * beside the component would drag Postgres into the dashboard's import graph.
 *
 * Browser-safe by construction: this module imports `zod` and two sibling
 * *type* modules. Reachable through `@vorschicht/shared/controlling` for the
 * reason the other four subpaths exist — the barrel re-exports `worktree.js`
 * and `containment.js`, which pull `node:path` (A75.5).
 *
 * **English identifiers, German values**, this house's rule.
 *
 * Five decisions are not transcription of the spec.
 *
 *   1. **The pause is three named modes, not two booleans.** A26 gives the operator
 *      "Pause" and "Hard pause"; `ManualPause` inside the guardian is
 *      `{active, hard}`, which makes `{active: false, hard: true}` expressible
 *      and meaningless. `personas.ts` decision 1 settled the same question the
 *      same way, and here the stakes are higher: the incoherent pair would be
 *      *stored*, and a later reader would have to guess what the operator meant. Three
 *      modes in a total order — `normal` < `pause` < `hart` — and
 *      `manualPauseFor` is the one place the guardian's shape is produced.
 *
 *   2. **An unreadable pause row means paused; an unreadable Sparbetrieb row
 *      means off.** The asymmetry is the decision, not an oversight.
 *      `PersonaSettings` decision 4 reads a corrupt value as the default,
 *      correctly, because failing closed there would mean `aus` — a *different*
 *      setting rather than a refusal. A pause is not a display setting: it is a
 *      safety instruction with no second device behind it, so "we could not
 *      find out whether we are allowed to run" and "we are allowed to run" must
 *      not be the same sentence (A83.6, A87.6, A99.4 — three subsystems, one
 *      rule). It falls back to `pause` and not to `hart`, because what is known
 *      is that a pause was intended and not which of the two.
 *
 *      Sparbetrieb goes the other way and the reason is that §7.2 does not
 *      depend on it: the guardian stops the studio at 85 % and 95 % whatever
 *      this switch says, so a broken value here endangers no budget. What it
 *      would cost is quality, which §1 ranks first — so an unparsable value is
 *      the default, loudly, exactly as `personas.ts` decided.
 *
 *   3. **A22's effects travel as data with a `wirksam` flag, and the flag is
 *      checked against the daemon.** A22 names four effects. Three of them have
 *      no consumer in the running system: `Scheduler`'s concurrency comes from
 *      the plan profile, `AgentRunnerDeps.modelPolicy` is supplied by nobody, and
 *      `RADAR_INTERVAL_MS` is a constant. Building a switch that claims four
 *      effects and delivers one would be the exact shape this project has found
 *      five times (A71, A74.2, A86, A105, A108) — so the page says which is
 *      which, and `controlling-wiring.test.ts` greps the daemon so that the flag
 *      is falsifiable rather than decorative.
 *
 *   4. **The tier table is computed by the server from `resolveTier`, never
 *      written out here.** §8.2 rule 3 exempts *the auditor* from the
 *      Sparbetrieb downgrade and A22 switches *idle audits* off — two different
 *      things, one sentence apart, and a hand-written German list is where they
 *      would be merged. The page shows the real function's answer for every
 *      profile, so an auditor that ever started downgrading would show up on the
 *      page rather than in a later audit.
 *
 *   5. **A number below 75 % is an estimate and has to say so.** A64 measured
 *      that `get_usage` reports nothing under `CLAUDE_CODE_OAUTH_TOKEN` auth,
 *      and A73 measured that the pushed `rate_limit_event` carries a percentage
 *      only from the vendor's own 75 % warning upward. So in the band the page
 *      spends most of its life in there *is* no official figure, and rendering
 *      the estimate as though there were is the one thing this page must not do.
 *      `budgetVertrauen` is the single implementation of that rule.
 */

import { z } from 'zod';
import { GUARDIAN_THRESHOLDS, USAGE_WINDOWS, type UsageWindowKind } from './constants.js';

// ---------------------------------------------------------------------------
// The pause (A26, §7.2)
// ---------------------------------------------------------------------------

/**
 * A26's switch positions, in the order they stop more of the studio.
 *
 * The order is meaningful and is asserted: `normal` < `pause` < `hart`. That is
 * what makes one enum honest rather than merely compact — `hart` is `pause`
 * plus §7.2's grace and the integrity re-check, never something else.
 */
export const PAUSE_MODES = ['normal', 'pause', 'hart'] as const;
export type PauseMode = (typeof PAUSE_MODES)[number];

/** Nothing set means the studio runs. */
export const PAUSE_MODE_DEFAULT: PauseMode = 'normal';

/**
 * What an unparsable stored value means (decision 2).
 *
 * Deliberately not `PAUSE_MODE_DEFAULT`. A switch that cannot be read must not
 * read as "go", and `pause` rather than `hart` because a wrap-up preserves the
 * work while a hard stop costs every running task a §7.2 integrity re-check —
 * so the milder reading is the one that is recoverable if the value was junk.
 */
export const PAUSE_MODE_UNREADABLE: PauseMode = 'pause';

/** The key `config` stores it under (§5, 0022). */
export const PAUSE_KEY = 'controlling.pause';

/** What the switch says on the page (§2, §17.8). */
export const PAUSE_MODE_LABELS: Record<PauseMode, string> = {
  normal: 'Normalbetrieb',
  pause: 'Pause — laufende Arbeit sauber wegräumen',
  hart: 'Harte Pause — sofort anhalten',
};

/**
 * What each position does, in the operator's language, including what it costs.
 *
 * The third says its price out loud because it is the only one that has one,
 * and a switch whose price is invisible is a switch nobody weighs (the reason
 * `PERSONA_MODE_DESCRIPTIONS` states the third mode's cost).
 */
export const PAUSE_MODE_DESCRIPTIONS: Record<PauseMode, string> = {
  normal: 'Der Wächter entscheidet allein nach dem Budget (§7.2). Nichts ist von Hand angehalten.',
  pause:
    'Es wird nichts Neues begonnen. Laufende Sitzungen bekommen das Aufräumprotokoll (§7.3): ' +
    'aktueller Schritt zu Ende, WIP-Commit, Übergabenotiz, Claims bleiben. Beim Fortsetzen ' +
    'läuft die Arbeit weiter, wo sie stand.',
  hart:
    'Wie „Pause", zusätzlich bekommen laufende Sitzungen 60 Sekunden und werden dann beendet. ' +
    'Jede betroffene Aufgabe gilt danach als unterbrochen und muss vor dem Fortsetzen die ' +
    'Integritätsprüfung bestehen (§7.2) — das kostet je Aufgabe eine Debugger-Sitzung.',
};

/**
 * The guardian's own shape, produced in exactly one place.
 *
 * `GuardianService` takes `{active, hard}` and `evaluateGuardian` branches on
 * it. Two translations of the three modes would be two chances for `hart` to
 * arrive as a soft pause, which is a failure nothing downstream could notice —
 * the studio would look paused and would still be killing nothing.
 */
export function manualPauseFor(mode: PauseMode): { active: boolean; hard: boolean } {
  return { active: mode !== 'normal', hard: mode === 'hart' };
}

/** The inverse, for reporting a guardian that was paused in-process. */
export function pauseModeFor(pause: { active: boolean; hard: boolean }): PauseMode {
  if (!pause.active) return 'normal';
  return pause.hard ? 'hart' : 'pause';
}

/** Is the studio held by the operator rather than by the budget? */
export function pausiert(mode: PauseMode): boolean {
  return mode !== 'normal';
}

// ---------------------------------------------------------------------------
// Sparbetrieb (A22, §6.0)
// ---------------------------------------------------------------------------

/** The key `config` stores it under (§5, 0022). */
export const SPARBETRIEB_KEY = 'controlling.sparbetrieb';

/** A22 is an emergency profile: off until the operator says otherwise. */
export const SPARBETRIEB_DEFAULT = false;

/**
 * One of A22's four effects, and whether the running system carries it out.
 *
 * `wirksam` is not documentation. `controlling-wiring.test.ts` greps the daemon
 * for the call site named in `verdrahtung`, and asserts the flag both ways — a
 * `true` whose wiring vanished fails, and a `false` that quietly grew a
 * consumer fails too, so the page cannot keep understating an effect either.
 */
export interface SparbetriebWirkung {
  id: string;
  /** What A22 says it does (§2). */
  text: string;
  /** Does the daemon do it today? */
  wirksam: boolean;
  /** Where the wiring is, or would have to be. Read by the wiring test. */
  verdrahtung: string;
  /** Why not, when it is not — never left for a reader to infer. */
  offen?: string;
}

/**
 * A22's four effects, as data (decision 3).
 *
 * Written down in the order A22 writes them, so a reader comparing the two is
 * not also doing a matching exercise.
 */
export const SPARBETRIEB_WIRKUNGEN: readonly SparbetriebWirkung[] = [
  {
    id: 'concurrency',
    text: 'Nebenläufigkeit auf 1 — es läuft höchstens eine Agentensitzung gleichzeitig.',
    wirksam: false,
    verdrahtung: 'apps/orchestrator/src/main.ts → concurrency',
    offen:
      'Der Ablaufplaner bekommt die Nebenläufigkeit einmalig aus dem Tarifprofil ' +
      '(`CONCURRENCY_BY_PLAN`) und liest sie nicht erneut. Der Schalter erreicht sie heute nicht.',
  },
  {
    id: 'tier',
    text:
      'Standardstufe für alle Rollen — außer der Reviewerin, die auf der stärksten bleibt (A22), ' +
      'und der Betriebsprüfung, die §8.2 Regel 3 ausdrücklich ausnimmt.',
    wirksam: false,
    verdrahtung: 'apps/orchestrator/src/main.ts → modelPolicy',
    offen:
      '`resolveTier` setzt die Obergrenze korrekt und wird von `AgentRunner` gelesen — ' +
      'aber `AgentRunnerDeps.modelPolicy` wird von niemandem gesetzt, also gilt immer die ' +
      'Voreinstellung. Die Tabelle unten zeigt, was der Schalter bewirken *würde*.',
  },
  {
    id: 'idle_audits',
    text: 'Leerlauf-Audits (§21) aus — freie Kapazität wird nicht mehr mit Prüfungen gefüllt.',
    wirksam: true,
    verdrahtung: 'apps/orchestrator/src/build-scheduler.ts → sparbetrieb',
  },
  {
    id: 'radar',
    text: 'Radar (§8 Nr. 6) nur noch wöchentlich statt alle sechs Stunden.',
    wirksam: false,
    verdrahtung: 'apps/orchestrator/src/main.ts → intervalMs: RADAR_INTERVAL_MS',
    offen:
      '`RADAR_INTERVAL_MS` ist eine Konstante und der periodische Auftrag liest sie einmal ' +
      'beim Start. Eine Kadenz, die sich zur Laufzeit ändert, gibt es noch nicht.',
  },
] as const;

/** How much of A22 the switch actually reaches — the sentence the page leads with. */
export function sparbetriebAbdeckung(wirkungen: readonly SparbetriebWirkung[]): {
  wirksam: number;
  gesamt: number;
  satz: string;
} {
  const wirksam = wirkungen.filter((w) => w.wirksam).length;
  const gesamt = wirkungen.length;
  return {
    wirksam,
    gesamt,
    satz:
      wirksam === gesamt
        ? `Alle ${gesamt} Wirkungen aus A22 sind verdrahtet.`
        : `${wirksam} von ${gesamt} Wirkungen aus A22 sind verdrahtet. ` +
          'Die übrigen sind unten benannt — der Schalter setzt sie, aber niemand liest sie.',
  };
}

// ---------------------------------------------------------------------------
// How trustworthy is a number (decision 5 — A64, A73)
// ---------------------------------------------------------------------------

/** Below this the vendor sends no percentage of its own (A73). */
export const OFFICIAL_REPORTING_FLOOR_PERCENT = 75;

export const VERTRAUEN_STUFEN = ['offiziell', 'geschaetzt', 'strittig', 'blind'] as const;
export type VertrauensStufe = (typeof VERTRAUEN_STUFEN)[number];

export interface Vertrauen {
  stufe: VertrauensStufe;
  /** One German sentence, shown beside the number and never omitted. */
  satz: string;
}

/** What the four levels are called on the page (§2). */
export const VERTRAUEN_LABELS: Record<VertrauensStufe, string> = {
  offiziell: 'Gemessen',
  geschaetzt: 'Geschätzt',
  strittig: 'Strittig',
  blind: 'Keine Messung',
};

/**
 * How much a window's number is worth, and why (decision 5).
 *
 * The whole point is that this is never optional: every number the page prints
 * carries the answer beside it. An estimate rendered like a measurement is the
 * failure A59 made in prose and A64 had to correct — and on this page it would
 * be a percentage the operator acts on.
 */
export function budgetVertrauen(fenster: {
  usedPercent: number;
  source: 'official' | 'estimated';
  anomaly: string | null;
}): Vertrauen {
  if (fenster.anomaly === 'unavailable') {
    return {
      stufe: 'blind',
      satz:
        'Das Budget ist gerade nicht lesbar. Der Wächter hält deshalb an, statt ' +
        'weiterzumachen — eine unlesbare Anzeige ist kein freies Budget (§7.1).',
    };
  }
  if (fenster.anomaly === 'divergence') {
    return {
      stufe: 'strittig',
      satz:
        'Die offizielle Messung und die Schätzung widersprechen sich. Es gilt die ' +
        'offizielle Zahl; die Abweichung ist als Controlling-Anomalie vermerkt (§7.1).',
    };
  }
  if (fenster.source === 'official') {
    return {
      stufe: 'offiziell',
      satz: 'Zahl des Anbieters, nicht geschätzt.',
    };
  }
  return {
    stufe: 'geschaetzt',
    satz:
      `Eigene Schätzung aus den Kosten-Äquivalenten der Sitzungen. Der Anbieter liefert ` +
      `erst ab ${OFFICIAL_REPORTING_FLOOR_PERCENT} % eine eigene Zahl (A73), darunter gibt es ` +
      'keine zum Vergleichen. Der Wächter räumt bei geschätzten Zahlen deshalb früher auf.',
  };
}

/** German name of a window, in one place (§2). */
export const WINDOW_LABELS: Record<UsageWindowKind, string> = {
  five_hour: '5-Stunden-Fenster',
  seven_day: 'Wochenfenster',
  seven_day_model: 'Wochenfenster je Modellklasse',
};

/** Stable display order, so two renders of the same data do not reorder. */
export const WINDOW_ORDER: readonly UsageWindowKind[] = USAGE_WINDOWS;

// ---------------------------------------------------------------------------
// The wire (§17.8) — A81: one declaration, the producer typed from it, the
// page parses rather than casts.
// ---------------------------------------------------------------------------

export const pauseModeSchema = z.enum(PAUSE_MODES);

const windowKindSchema = z.enum(USAGE_WINDOWS);

export const vertrauenSchema = z.object({
  stufe: z.enum(VERTRAUEN_STUFEN),
  satz: z.string(),
});

/**
 * One window as the API reports it.
 *
 * `vertrauen` travels rather than being derived on the page, and that is the
 * opposite of `personas.ts` decision 4's posture on purpose: `personaLabel` is
 * re-applied on every mode change without a round trip, while this answer
 * depends on the *sample* and changes only when a new one arrives. Computing it
 * server-side keeps one implementation on the path that also feeds §16's report
 * later. `budgetVertrauen` stays exported so the page's own test can assert the
 * server's answer equals the rule rather than trusting the string.
 */
export const fensterSchema = z.object({
  window: windowKindSchema,
  modelClass: z.string().nullable(),
  usedPercent: z.number(),
  resetsAt: z.number().nullable(),
  source: z.enum(['official', 'estimated']),
  anomaly: z.string().nullable(),
  vertrauen: vertrauenSchema,
});
export type FensterView = z.infer<typeof fensterSchema>;

/** One historical reading, for the graph. Deliberately tiny: this list is long. */
export const verlaufPunktSchema = z.object({
  window: windowKindSchema,
  modelClass: z.string().nullable(),
  usedPercent: z.number(),
  source: z.enum(['official', 'estimated']),
  observedAt: z.number(),
});
export type VerlaufPunkt = z.infer<typeof verlaufPunktSchema>;

export const waechterSchema = z.object({
  state: z.enum(['normal', 'wrap_up', 'hard_stop']),
  text: z.string(),
  governingWindow: windowKindSchema.nullable(),
  since: z.string().nullable(),
});

export const pauseSchema = z.object({
  modus: pauseModeSchema,
  /** Set when the stored value could not be parsed — the page says so (decision 2). */
  unlesbar: z.boolean(),
});

export const sparbetriebWirkungSchema = z.object({
  id: z.string(),
  text: z.string(),
  wirksam: z.boolean(),
  verdrahtung: z.string(),
  offen: z.string().nullable(),
});

/** One profile's tier under both regimes — computed from `resolveTier` (decision 4). */
export const stufenZeileSchema = z.object({
  profileId: z.string(),
  department: z.string(),
  normal: z.string(),
  sparbetrieb: z.string(),
});
export type StufenZeile = z.infer<typeof stufenZeileSchema>;

export const sparbetriebSchema = z.object({
  aktiv: z.boolean(),
  unlesbar: z.boolean(),
  wirkungen: z.array(sparbetriebWirkungSchema),
  stufen: z.array(stufenZeileSchema),
});

export const betriebSchema = z.object({
  planProfile: z.string(),
  concurrency: z.number(),
  concurrencyRange: z.object({ min: z.number(), max: z.number() }),
});

export const controllingResponse = z.object({
  controlling: z.object({
    waechter: waechterSchema,
    schwellen: z.object({
      wrapUpPercent: z.number(),
      hardStopPercent: z.number(),
      degradedWrapUpPercent: z.number(),
    }),
    fenster: z.array(fensterSchema),
    verlauf: z.array(verlaufPunktSchema),
    pause: pauseSchema,
    sparbetrieb: sparbetriebSchema,
    betrieb: betriebSchema,
  }),
});
export type ControllingBody = z.infer<typeof controllingResponse>;

export const pauseSubmission = z.object({ modus: pauseModeSchema });
export const sparbetriebSubmission = z.object({ aktiv: z.boolean() });

/** Every path exactly once (A81.3). */
export const CONTROLLING_API = {
  root: '/api/controlling',
  pause: '/api/controlling/pause',
  sparbetrieb: '/api/controlling/sparbetrieb',
} as const;

export const CONTROLLING_PFAD = '/controlling';

/**
 * German issue list for a refused submission (§2).
 *
 * Same shape as `germanPersonaIssues`: the page shows what was wrong, and the
 * wording is the API's rather than zod's English.
 */
export function germanControllingIssues(issues: readonly { path: PropertyKey[] }[]): string[] {
  return issues.map((issue) => {
    const feld = issue.path.map(String).join('.');
    if (feld === 'modus') {
      return `„modus" muss eine der drei Stellungen sein: ${PAUSE_MODES.join(', ')}.`;
    }
    if (feld === 'aktiv') return '„aktiv" muss wahr oder falsch sein.';
    return `Feld „${feld || '<Wurzel>'}" ist nicht wie erwartet.`;
  });
}

/** Parse a pause submission, answering in German (§2). */
export function parsePauseSubmission(
  body: unknown,
): { ok: true; value: { modus: PauseMode } } | { ok: false; errors: string[] } {
  const parsed = pauseSubmission.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, errors: germanControllingIssues(parsed.error.issues) };
}

/** Parse a Sparbetrieb submission, answering in German (§2). */
export function parseSparbetriebSubmission(
  body: unknown,
): { ok: true; value: { aktiv: boolean } } | { ok: false; errors: string[] } {
  const parsed = sparbetriebSubmission.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, errors: germanControllingIssues(parsed.error.issues) };
}

/** Re-exported so a caller assembling the page does not re-derive the thresholds. */
export { GUARDIAN_THRESHOLDS };
