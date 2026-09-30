/**
 * §17.8's Controlling page in plain functions.
 *
 * Same arrangement as `./einstellungen-format.ts`, `./quellen-format.ts` and
 * `./dokumente-format.ts`, and it exists for the reason those do: `apps/web` has
 * **no DOM test environment** — vitest runs in `node` and the repo carries
 * neither jsdom nor a component-testing library — so a rule living inside a
 * component is a rule only Playwright can reach. Anything about this page that
 * can be wrong without a browser noticing lives here; the component renders and
 * decides nothing.
 *
 * **The shapes are not declared here.** They are `@vorschicht/shared/controlling`'s
 * and they are *parsed*, never cast (A81): `leseControlling` is the only door a
 * payload comes through.
 *
 * **And `budgetVertrauen` is not re-implemented here either.** The server
 * computes it and the page renders what it sent; the rule is re-exported so the
 * server's test can assert its answer equals the rule (`controlling.test.ts`).
 * A convenience copy on this side is how two answers to "is this number
 * measured" start to differ — on the page whose whole job is that question.
 *
 * What this module adds is the two things a graph needs and no schema can carry:
 * the geometry, and the German sentence for a duration.
 */
import {
  budgetVertrauen,
  CONTROLLING_API,
  CONTROLLING_PFAD,
  type ControllingBody,
  controllingResponse,
  type FensterView,
  PAUSE_MODE_DESCRIPTIONS,
  PAUSE_MODE_LABELS,
  PAUSE_MODES,
  type PauseMode,
  pausiert,
  SPARBETRIEB_WIRKUNGEN,
  type StufenZeile,
  sparbetriebAbdeckung,
  VERTRAUEN_LABELS,
  type VerlaufPunkt,
  type VertrauensStufe,
  WINDOW_LABELS,
  WINDOW_ORDER,
} from '@vorschicht/shared/controlling';
import { type Gelesen, lies } from './inbox-format.js';

export type { ControllingBody, FensterView, PauseMode, StufenZeile, VerlaufPunkt };
export {
  budgetVertrauen,
  CONTROLLING_API,
  CONTROLLING_PFAD,
  PAUSE_MODE_DESCRIPTIONS,
  PAUSE_MODE_LABELS,
  PAUSE_MODES,
  pausiert,
  SPARBETRIEB_WIRKUNGEN,
  sparbetriebAbdeckung,
  VERTRAUEN_LABELS,
  WINDOW_LABELS,
};

/** The Controlling payload, or a German sentence saying it was not the agreed shape. */
export function leseControlling(koerper: unknown): Gelesen<ControllingBody> {
  return lies(controllingResponse, koerper, 'das Controlling');
}

/** What one window is called on the page, including its model class (§2). */
export function fensterTitel(fenster: {
  window: FensterView['window'];
  modelClass: string | null;
}): string {
  const basis = WINDOW_LABELS[fenster.window];
  return fenster.modelClass ? `${basis} — ${fenster.modelClass}` : basis;
}

/**
 * Stable order for the windows, so two renders of the same data do not reorder.
 *
 * Within a window kind the model class decides, alphabetically. Sorting by
 * percentage would look tidier and would move rows around whenever a number
 * changed, which on a page somebody watches is the opposite of useful.
 */
export function fensterReihenfolge<
  T extends { window: FensterView['window']; modelClass: string | null },
>(fenster: readonly T[]): T[] {
  return [...fenster].sort((a, b) => {
    const rang = WINDOW_ORDER.indexOf(a.window) - WINDOW_ORDER.indexOf(b.window);
    if (rang !== 0) return rang;
    return (a.modelClass ?? '').localeCompare(b.modelClass ?? '', 'de');
  });
}

/**
 * How long until this window resets, in German.
 *
 * `null` when the source did not say, which is a real and common answer:
 * `get_usage` carries no reset time at all, so a page that printed "in 0 min"
 * for it would be inventing a deadline (A73's evidence, one layer up).
 */
export function restzeit(resetsAt: number | null, jetzt: number): string | null {
  if (resetsAt === null) return null;
  const rest = resetsAt - jetzt;
  if (rest <= 0) return 'Fenster ist abgelaufen';
  const minuten = Math.floor(rest / 60_000);
  const stunden = Math.floor(minuten / 60);
  const tage = Math.floor(stunden / 24);
  if (tage >= 1) return `noch ${tage} ${tage === 1 ? 'Tag' : 'Tage'} ${stunden % 24} h`;
  if (stunden >= 1) return `noch ${stunden} h ${minuten % 60} min`;
  return `noch ${minuten} min`;
}

/** One line per window, for the graph legend and the table. */
export interface VerlaufReihe {
  window: VerlaufPunkt['window'];
  modelClass: string | null;
  punkte: VerlaufPunkt[];
}

/**
 * The history split into one series per window (and per model class).
 *
 * `usage_samples` interleaves the windows, so a single polyline over the raw
 * rows would draw a saw-tooth between the five-hour and the weekly figure and
 * call it a trend. Grouping is therefore not presentation — it is the
 * difference between a graph and a lie.
 */
export function verlaufReihen(punkte: readonly VerlaufPunkt[]): VerlaufReihe[] {
  const reihen = new Map<string, VerlaufReihe>();
  for (const punkt of punkte) {
    const key = `${punkt.window}::${punkt.modelClass ?? ''}`;
    const reihe = reihen.get(key);
    if (reihe) reihe.punkte.push(punkt);
    else reihen.set(key, { window: punkt.window, modelClass: punkt.modelClass, punkte: [punkt] });
  }
  return fensterReihenfolge([...reihen.values()]);
}

export interface Geometrie {
  breite: number;
  hoehe: number;
}

/**
 * A series as SVG `points`, or null when there is nothing to draw.
 *
 * Two decisions worth stating, because both are ways a graph misleads.
 *
 *  1. **The y axis is fixed at 0–100 %**, never scaled to the data. An
 *     auto-scaled axis makes 3 % and 93 % produce the identical picture, which
 *     on a budget graph is the one mistake that matters: the shape would say
 *     "climbing steeply" for a studio that has spent nothing.
 *  2. **The x axis spans the *requested* window**, not the observed one, so a
 *     gap in the readings shows as a gap rather than being stretched out to
 *     look like continuous coverage.
 *
 * A single point yields a null path — one reading is not a trend, and a
 * one-pixel line implying one is worse than an empty box that says so.
 */
export function verlaufPfad(
  punkte: readonly VerlaufPunkt[],
  geometrie: Geometrie,
  spanne: { von: number; bis: number },
): string | null {
  if (punkte.length < 2) return null;
  const dauer = spanne.bis - spanne.von;
  if (dauer <= 0) return null;
  return punkte
    .map((punkt) => {
      const x = ((punkt.observedAt - spanne.von) / dauer) * geometrie.breite;
      const y =
        geometrie.hoehe - (Math.min(100, Math.max(0, punkt.usedPercent)) / 100) * geometrie.hoehe;
      return `${round(x)},${round(y)}`;
    })
    .join(' ');
}

/** The time span a set of readings covers, or null when there is none. */
export function verlaufSpanne(
  punkte: readonly VerlaufPunkt[],
): { von: number; bis: number } | null {
  if (punkte.length === 0) return null;
  let von = Number.POSITIVE_INFINITY;
  let bis = Number.NEGATIVE_INFINITY;
  for (const punkt of punkte) {
    if (punkt.observedAt < von) von = punkt.observedAt;
    if (punkt.observedAt > bis) bis = punkt.observedAt;
  }
  return { von, bis };
}

/** A percentage as a German number, one decimal — `91,4 %`. */
export function prozent(wert: number): string {
  return `${wert.toFixed(1).replace('.', ',')} %`;
}

/** The badge beside a number: what it is worth, in two words plus a sentence. */
export function vertrauensEtikett(stufe: VertrauensStufe): string {
  return VERTRAUEN_LABELS[stufe];
}

/**
 * What the page says about the studio right now, above everything else.
 *
 * The pause is named *before* the budget, and that ordering is the decision: a
 * studio the operator stopped himself and one the budget stopped look identical from a
 * guardian state alone (`wrap_up` either way), and telling him "Budget" when he
 * pressed the button is the sentence that makes a page untrustworthy.
 */
export function kopfzeile(controlling: ControllingBody['controlling']): string {
  if (controlling.pause.unlesbar) {
    return 'Angehalten, weil die gespeicherte Schalterstellung nicht lesbar ist — bitte neu setzen.';
  }
  if (pausiert(controlling.pause.modus)) {
    return controlling.pause.modus === 'hart'
      ? 'Von Hand hart angehalten. Laufende Sitzungen wurden beendet.'
      : 'Von Hand angehalten. Laufende Arbeit wird sauber weggeräumt.';
  }
  return controlling.waechter.text;
}

function round(value: number): number {
  return Math.round(value * 10) / 10;
}
