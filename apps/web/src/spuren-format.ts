/**
 * Everything §17.4's trace explorer decides that is not JSX.
 *
 * Same split as `dokumente-format.ts` and `quellen-format.ts`, and for the same
 * stated reason: a `safeParse` inside a component is a guarantee no unit test
 * can break on purpose. Every payload this page renders is **parsed** through
 * `@vorschicht/shared/spuren` here, so removing the parse fails a test rather
 * than only a browser.
 *
 * `lies`, `Leser`, `Gelesen` and `zeitpunkt` come from `./inbox-format.js`
 * rather than being declared again — a second `zeitpunkt` would be a second
 * answer to "how does this dashboard write a date", and the two drift the first
 * time one of them is improved. `dringlichkeitLabel` comes from there too, for
 * the sharper version of the same reason: P0–P3 already have one set of German
 * words in this dashboard, and a task showing "P3 — später" beside an inbox card
 * showing "P3 — wenn Zeit ist" is one fact with two spellings.
 */
import {
  AUFGABEN_API,
  aufgabePfad,
  DIFF_BASIS_LABELS,
  type DiffBasis,
  ereignisLabel,
  LAEUFE_API,
  laufPfad,
  SPUREN_ALLE,
  SPUREN_QUERY,
  type SpurAufgabeDetail,
  type SpurAufgabeZeile,
  type SpurDiff,
  type SpurenListeAntwort,
  type SpurLauf,
  type SpurLaufDetail,
  type SpurTranskript,
  type SpurTranskriptZeile,
  spurAufgabeAntwort,
  spurDiffAntwort,
  spurenListeAntwort,
  spurKennung,
  spurLaufAntwort,
  TRANSCRIPT_CONVERSATION_KINDS,
  TRANSCRIPT_LINE_LABELS,
  TRANSCRIPT_MARK_LABELS,
  type TranscriptMarkKind,
  zustandLabel,
} from '@vorschicht/shared/spuren';
import { type Gelesen, lies, zeitpunkt } from './inbox-format.js';

export {
  AUFGABEN_PFAD,
  aufgabePfad,
  dauer,
  ereignisLabel,
  kappen,
  LAEUFE_PFAD,
  laufAusgang,
  laufPfad,
  PRIORITAET_OPTIONEN,
  spurKennung,
  TRANSCRIPT_LINE_LABELS,
  TRANSCRIPT_MARK_LABELS,
  TRANSCRIPT_STATE_LABELS,
  ZUSTAND_OPTIONEN,
  zustandLabel,
} from '@vorschicht/shared/spuren';
export { dringlichkeitLabel, zeitpunkt } from './inbox-format.js';

// --- the list ----------------------------------------------------------------

export interface ListenFilter {
  projekt: string;
  zustand: string;
  prioritaet: string;
  von: string;
  bis: string;
}

export const LEERER_FILTER: ListenFilter = {
  projekt: SPUREN_ALLE,
  zustand: SPUREN_ALLE,
  prioritaet: SPUREN_ALLE,
  von: '',
  bis: '',
};

/**
 * The list URL, built from the contract's own query keys.
 *
 * `SPUREN_QUERY` rather than the literals, for the reason A81.3 records: the one
 * time this project wrote a path in two packages, every deep link in every
 * notification landed on the wrong page and three test files encoded the wrong
 * one. A key that is only ever written once cannot disagree with itself.
 */
export function listenUrl(filter: ListenFilter): string {
  const params = new URLSearchParams();
  const setze = (key: string, wert: string) => {
    // `alle` and the empty string are *absence*, and absence is not sent. A
    // parameter carrying the word "alle" would have to be understood identically
    // on both sides; not sending it needs no agreement at all.
    if (wert && wert !== SPUREN_ALLE) params.set(key, wert);
  };
  setze(SPUREN_QUERY.project, filter.projekt);
  setze(SPUREN_QUERY.state, filter.zustand);
  setze(SPUREN_QUERY.priority, filter.prioritaet);
  setze(SPUREN_QUERY.from, filter.von);
  setze(SPUREN_QUERY.to, filter.bis);
  const query = params.toString();
  return query ? `${AUFGABEN_API}?${query}` : AUFGABEN_API;
}

export async function leseListe(filter: ListenFilter): Promise<Gelesen<SpurenListeAntwort>> {
  return lies(spurenListeAntwort, await hole(listenUrl(filter)), 'die Aufgabenliste');
}

export async function leseAufgabe(
  taskId: string,
): Promise<Gelesen<{ aufgabe: SpurAufgabeDetail }>> {
  return lies(spurAufgabeAntwort, await hole(`${AUFGABEN_API}/${taskId}`), 'die Aufgabe');
}

export async function leseDiff(taskId: string): Promise<Gelesen<{ diff: SpurDiff }>> {
  return lies(spurDiffAntwort, await hole(`${AUFGABEN_API}/${taskId}/diff`), 'den Vergleich');
}

export async function leseLauf(
  runId: string,
  anchor: { zeile?: number | null; marke?: TranscriptMarkKind | null; seite?: number | null },
): Promise<Gelesen<{ lauf: SpurLaufDetail }>> {
  const params = new URLSearchParams();
  if (anchor.zeile) params.set(SPUREN_QUERY.line, String(anchor.zeile));
  else if (anchor.marke) params.set(SPUREN_QUERY.mark, anchor.marke);
  if (anchor.seite && !anchor.zeile && !anchor.marke) {
    params.set(SPUREN_QUERY.page, String(anchor.seite));
  }
  const query = params.toString();
  return lies(
    spurLaufAntwort,
    await hole(`${LAEUFE_API}/${runId}${query ? `?${query}` : ''}`),
    'den Lauf',
  );
}

/**
 * A GET whose body is returned whatever the status was.
 *
 * A non-2xx answer from this surface still carries `{ errors: [...] }`, and the
 * parse below turns it into the page's own sentence. Throwing on the status
 * instead would replace a German explanation with a network error, which is the
 * less informative half of what the server said.
 */
async function hole(url: string): Promise<unknown> {
  const antwort = await fetch(url, { headers: { accept: 'application/json' } });
  return await antwort.json().catch(() => null);
}

/**
 * The sentence an empty list gets — and it names *which* emptiness.
 *
 * An unfiltered empty studio and a filter that hides everything are different
 * facts, and one wording for both is how "nothing has run yet" comes to mean
 * "your filter is too narrow" (and the other way round, which is worse: it hides
 * that the studio has been idle).
 */
export function leerText(filter: ListenFilter): string {
  return gefiltert(filter)
    ? 'Kein Treffer für diese Filter. Setze sie zurück, um alle Aufgaben zu sehen.'
    : 'Es gibt noch keine Aufgaben. Sobald das Studio arbeitet, steht hier jede einzelne.';
}

export function gefiltert(filter: ListenFilter): boolean {
  return (
    filter.projekt !== SPUREN_ALLE ||
    filter.zustand !== SPUREN_ALLE ||
    filter.prioritaet !== SPUREN_ALLE ||
    filter.von !== '' ||
    filter.bis !== ''
  );
}

// --- the timeline ------------------------------------------------------------

/**
 * The one-line German summary of a timeline row.
 *
 * The payload is rendered in full underneath; this is the line a person scans.
 * A `state_changed` says what it changed *to* and carries the reason the writer
 * gave, because a timeline of "Zustandswechsel" seventeen times is a list, not a
 * trace.
 */
export function ereignisZeile(event: {
  kind: string;
  state: string;
  actor: string;
  payload: unknown;
}): string {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const grund = typeof payload.reason === 'string' ? payload.reason : null;
  const kopf =
    event.kind === 'state_changed'
      ? `${ereignisLabel(event.kind)} → ${zustandLabel(event.state)}`
      : ereignisLabel(event.kind);
  return grund ? `${kopf}: ${grund}` : kopf;
}

/**
 * The run a timeline row points at, if it points at one.
 *
 * §22's four-click path runs through here: an `escalation_requested` row carries
 * the run whose session asked, so the timeline can link straight into that
 * session's transcript at the line where it asked. Without this the only way in
 * is to find the run in the list underneath and page through it, which is the
 * two extra clicks the exit gate does not have room for.
 */
export function ereignisLauf(payload: unknown): string | null {
  const werte = (payload ?? {}) as Record<string, unknown>;
  for (const key of ['runId', 'run_id', 'agentRunId']) {
    const kandidat = spurKennung(typeof werte[key] === 'string' ? (werte[key] as string) : null);
    if (kandidat) return kandidat;
  }
  return null;
}

/** Where an `escalation_requested` row links to: that session, at that line. */
export function entscheidungsZiel(runId: string): string {
  return laufPfad(runId, { marke: 'decision' });
}

export function aufgabenZiel(taskId: string): string {
  return aufgabePfad(taskId);
}

// --- the transcript ----------------------------------------------------------

export function zeilenLabel(kind: SpurTranskriptZeile['kind']): string {
  return TRANSCRIPT_LINE_LABELS[kind];
}

export function markeLabel(kind: TranscriptMarkKind): string {
  return TRANSCRIPT_MARK_LABELS[kind];
}

/** How many jump marks the list shows before it stops being a jump list. */
export const MARKEN_ANZEIGE = 25;

/**
 * Which marks the jump list offers, decisions first.
 *
 * Found by working out what the third mutation of this feature would really
 * prove: with a plain `slice`, a coding session that makes two hundred tool
 * calls before it asks a question pushes the one mark §22's exit gate addresses
 * off the end of the list. The direct link from the timeline would still work —
 * but the *fallback* route (open the session, find the line) would then need
 * paging, and the gate's four clicks are gone on exactly the busiest runs.
 *
 * So the cap stays, because a list of two hundred entries is not a jump list,
 * and it is applied to everything *except* decisions: `Math.max` keeps every
 * decision even when there are more of them than the cap. The reader already
 * refuses to drop a decision mark for the same reason, one layer down; this is
 * the display half of that rule.
 */
export function angezeigteMarken<T extends { kind: TranscriptMarkKind }>(
  marken: readonly T[],
  limit = MARKEN_ANZEIGE,
): T[] {
  const entscheidungen = marken.filter((marke) => marke.kind === 'decision');
  const rest = marken.filter((marke) => marke.kind !== 'decision');
  return [...entscheidungen, ...rest].slice(0, Math.max(limit, entscheidungen.length));
}

/**
 * Only the conversation, or every line.
 *
 * A real transcript is more than half CLI bookkeeping — `mode`, `bridge-session`,
 * `file-history-delta`, `ai-title` — and a viewer that shows nothing else drowns
 * the six lines that matter. Hiding them by default would be worse: §18 makes
 * this file the evidence, and a viewer that silently drops rows decides for the
 * auditor what the session consisted of. So the toggle exists, it defaults to
 * showing everything, and the count of what a filter is hiding is on the page.
 */
export function sichtbareZeilen(
  zeilen: SpurTranskriptZeile[],
  nurGespraech: boolean,
): SpurTranskriptZeile[] {
  if (!nurGespraech) return zeilen;
  return zeilen.filter((zeile) => TRANSCRIPT_CONVERSATION_KINDS.includes(zeile.kind));
}

/** How many rows the conversation filter is currently hiding. */
export function verborgeneZeilen(zeilen: SpurTranskriptZeile[], nurGespraech: boolean): number {
  return nurGespraech ? zeilen.length - sichtbareZeilen(zeilen, true).length : 0;
}

/**
 * The transcript's headline, which always says which of the five answers this is.
 *
 * `present` is the only one that reports a count, and it reports it even when it
 * is zero — an archived file that is genuinely empty is a fact, and the whole
 * point of the five states is that it is not the same fact as the file being
 * gone.
 */
export function transkriptKopf(transkript: SpurTranskript): string {
  if (transkript.state !== 'present') return transkript.erklaerung;
  const gepackt = transkript.compressed ? ' (gepacktes Archiv)' : '';
  return transkript.totalLines === 0
    ? `Das Sitzungsprotokoll ist vorhanden${gepackt} und enthält keine Zeile.`
    : `${transkript.totalLines} Zeilen${gepackt} · Seite ${transkript.page} von ${transkript.pages}`;
}

// --- the diff ----------------------------------------------------------------

/**
 * What was compared, in one sentence.
 *
 * Never just "Diff": for two of the three bases the left end is a fork point and
 * for one it is a recorded commit, and an empty file list means something
 * different in each case. The sentence is assembled here rather than on the
 * server so that there is one wording rather than two (A69.5's split: the
 * machine-readable fields travel, the prose is written where it is read).
 */
export function diffKopf(diff: SpurDiff): string {
  if (!diff.ok || !diff.basis) return diff.erklaerung;
  const trenner = diff.forkPoint ? '…' : '→';
  return (
    `${DIFF_BASIS_LABELS[diff.basis as DiffBasis]}: ` +
    `${kurz(diff.fromRef)} ${trenner} ${kurz(diff.toRef)}`
  );
}

/**
 * A sha shortened, a ref name left alone.
 *
 * Cutting a branch name to twelve characters would produce a string that looks
 * like a sha and names nothing.
 */
export function kurz(ref: string | null): string {
  if (!ref) return '—';
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 12) : ref;
}

export function diffZusammenfassung(diff: SpurDiff): string {
  if (!diff.ok) return diff.erklaerung;
  if (diff.files.length === 0) {
    // A real and ordinary answer, and it has to be distinguishable from every
    // refusal above — hence its own sentence rather than an empty table.
    return 'Dieser Vergleich enthält keine Änderung. Die beiden Stände sind identisch.';
  }
  const plus = diff.files.reduce((summe, datei) => summe + datei.added, 0);
  const minus = diff.files.reduce((summe, datei) => summe + datei.removed, 0);
  const dateien = diff.files.length === 1 ? '1 Datei' : `${diff.files.length} Dateien`;
  return `${dateien} · +${plus} / −${minus}`;
}

// --- rows --------------------------------------------------------------------

/** One list row, formatted. Kept out of the JSX so a test can assert it. */
export function aufgabenZeile(aufgabe: SpurAufgabeZeile): {
  titel: string;
  projekt: string;
  zustand: string;
  bewegt: string;
} {
  return {
    // A task with no title is a task from before 0010 gave `created` one. Shown
    // by id rather than as an empty cell, because a blank row reads as a broken
    // page and an id is something a person can search for.
    titel: aufgabe.title ?? `ohne Titel (${aufgabe.id.slice(0, 8)})`,
    projekt: aufgabe.projectSlug ?? 'Projekt nicht mehr eingetragen',
    zustand: zustandLabel(aufgabe.state),
    bewegt: zeitpunkt(aufgabe.updatedAt),
  };
}

/** One run, as the line under a task shows it. */
export function laufZeile(lauf: SpurLauf): { rolle: string; modell: string } {
  return {
    rolle: lauf.role ?? 'ohne Rolle',
    // Null for a run whose `created` event predates the field. Named rather than
    // blank, same reason as the title above.
    modell: lauf.model ?? 'Modell nicht aufgezeichnet',
  };
}
