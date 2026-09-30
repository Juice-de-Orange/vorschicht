import type {
  SpurAufgabeDetail,
  SpurDiff,
  SpurenListeAntwort,
  SpurLaufDetail,
  SpurTranskriptZeile,
} from '@vorschicht/shared/spuren';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { AufgabeAnlegen } from './AufgabeAnlegen.js';
import { navigate, segmentAfter, usePath } from './router.js';
import {
  AUFGABEN_PFAD,
  angezeigteMarken,
  aufgabenZeile,
  aufgabePfad,
  dauer,
  diffKopf,
  diffZusammenfassung,
  dringlichkeitLabel,
  entscheidungsZiel,
  ereignisLauf,
  ereignisZeile,
  kappen,
  kurz,
  LAEUFE_PFAD,
  LEERER_FILTER,
  type ListenFilter,
  laufAusgang,
  laufPfad,
  laufZeile,
  leerText,
  leseAufgabe,
  leseDiff,
  leseLauf,
  leseListe,
  markeLabel,
  PRIORITAET_OPTIONEN,
  sichtbareZeilen,
  spurKennung,
  transkriptKopf,
  verborgeneZeilen,
  ZUSTAND_OPTIONEN,
  zeilenLabel,
  zeitpunkt,
} from './spuren-format.js';

/**
 * §17.4's task and trace explorer — the page in which §1 principle 4 stops being
 * a promise.
 *
 * "Every error and every decision must be traceable end-to-end: goal → task →
 * agent run → transcript → diff → gate results → merge → deploy." All of it has
 * been recorded since Phase 1 and none of it has been readable. Three routes
 * carry it: `/aufgaben` is the filtered list, `/aufgaben/<uuid>` is one task's
 * whole timeline with its runs, gate results, findings and diff, and
 * `/laeufe/<uuid>` is one session with its transcript.
 *
 * Four things are deliberate.
 *
 *  1. **A run has its own top-level route.** §22's exit gate starts at a dot in
 *     the office view, which is a *run*, and a route nested under the task would
 *     force whoever links to it to know which task it served first. The office
 *     view (built in a parallel strand) needs one link and no join.
 *
 *  2. **The decision link is the whole exit gate.** A timeline row for
 *     `escalation_requested` links to `/laeufe/<run>?marke=decision`, and the
 *     server resolves that mark to the line where the session called
 *     `escalate.ask` and highlights it. That is what keeps the path to a
 *     transcript line at two clicks from a task and three from a dot. The link
 *     is rendered only when the row names a run, and the page says so when it
 *     does not — a jump target that quietly is not there is exactly what the
 *     gate's click count would fail to notice.
 *
 *  3. **Nothing here is rendered as markup.** Every transcript line and every
 *     diff hunk is model output or foreign file content, copied verbatim from a
 *     file. It goes into JSX as a child, where React escapes it. There is no
 *     `dangerouslySetInnerHTML` on this page and there must never be; the
 *     browser suite asserts a seeded `<img onerror>` arrives as text.
 *
 *  4. **The diff is fetched on demand.** It shells out to git twice; a timeline
 *     that loaded it eagerly would pay for it on every view, including the ones
 *     where nobody scrolls that far.
 */
export function Spuren() {
  const path = usePath();

  const laufSegment = segmentAfter(path, LAEUFE_PFAD);
  if (path.startsWith(LAEUFE_PFAD)) {
    const runId = spurKennung(laufSegment);
    return runId ? (
      <LaufSeite runId={runId} />
    ) : (
      <Rahmen titel="Lauf">
        <Unbekannt segment={laufSegment} was="Laufkennung" beispiel={LAEUFE_PFAD} />
      </Rahmen>
    );
  }

  const aufgabeSegment = segmentAfter(path, AUFGABEN_PFAD);
  if (aufgabeSegment !== null) {
    const taskId = spurKennung(aufgabeSegment);
    return taskId ? (
      <AufgabeSeite taskId={taskId} />
    ) : (
      <Rahmen titel="Aufgabe">
        <Unbekannt segment={aufgabeSegment} was="Aufgabenkennung" beispiel={AUFGABEN_PFAD} />
      </Rahmen>
    );
  }

  return <Liste />;
}

/**
 * Der Seitenrahmen.
 *
 * `daten` sagt, ob die Überschrift ein Etikett ist oder Inhalt. Der Unterschied
 * ist keine Geschmacksfrage: die Anzeigeschrift zeichnet `0` und `O` als
 * dieselbe Glyphe (siehe den Kopf von `basis.css`), und die Überschrift dieser
 * Seite trägt in zwei von vier Fällen einen Aufgabentitel oder eine Rolle —
 * also Text, den jemand mit einer Kennung im Ereignisprotokoll vergleicht.
 */
function Rahmen({
  titel,
  daten,
  children,
}: {
  titel: string;
  daten?: boolean;
  children: ReactNode;
}) {
  return (
    <section className="karte">
      <h2 data-inhalt={daten ? 'daten' : undefined}>{titel}</h2>
      {children}
    </section>
  );
}

/**
 * A segment that is not a usable id is *not* the list page.
 *
 * Showing the whole list for `/aufgaben/kaputt` reads as "your task is gone"
 * rather than as "that link is broken" (A81.5).
 */
function Unbekannt({
  segment,
  was,
  beispiel,
}: {
  segment: string | null;
  was: string;
  beispiel: string;
}) {
  return (
    <>
      <p data-testid="spur-unbekannt" role="alert" className="streifen" data-ton="fehler">
        „{segment}" ist keine {was}. Ein Dauerlink sieht aus wie
        <code> {beispiel}/11111111-2222-4333-8444-555555555555</code>.
      </p>
      <ZurListe />
    </>
  );
}

function ZurListe() {
  return (
    <p className="knopfreihe">
      <button
        type="button"
        data-testid="zur-aufgabenliste"
        className="knopf"
        onClick={() => navigate(AUFGABEN_PFAD)}
      >
        Zur Aufgabenliste
      </button>
    </p>
  );
}

// --- the list ----------------------------------------------------------------

function Liste() {
  const [antwort, setAntwort] = useState<SpurenListeAntwort | null>(null);
  const [filter, setFilter] = useState<ListenFilter>(LEERER_FILTER);
  const [fehler, setFehler] = useState<string | null>(null);
  const [laden, setLaden] = useState(true);

  const laden_ = useCallback(async (aktuell: ListenFilter) => {
    setLaden(true);
    const gelesen = await leseListe(aktuell);
    if (gelesen.ok) {
      setAntwort(gelesen.wert);
      setFehler(null);
    } else {
      setFehler(gelesen.fehler);
    }
    setLaden(false);
  }, []);

  useEffect(() => {
    void laden_(filter);
  }, [laden_, filter]);

  return (
    <Rahmen titel="Aufgaben">
      <p>
        Jede Aufgabe des Studios mit ihrer vollständigen Spur: Zeitstrahl, Sitzungen,
        Sitzungsprotokolle, Vergleich, Gate-Ergebnisse.
      </p>

      {/*
        §17.4s andere Hälfte. Bis hierher konnte eine Aufgabe nur als
        Nebenwirkung entstehen — Prüfungsfund, Leerlauf-Audit, Radar —, das
        Studio also nur Arbeit tun, die es sich selbst zugeteilt hatte. Das
        Formular steht auf **dieser** Seite und nicht auf einer eigenen, weil
        `/aufgaben` den Gegenstand schon besitzt.
      */}
      <AufgabeAnlegen onAngelegt={() => void laden_(filter)} />

      <form
        data-testid="spuren-filter"
        className="werkzeugleiste"
        onSubmit={(event) => {
          event.preventDefault();
          void laden_(filter);
        }}
      >
        <label>
          Projekt{' '}
          <select
            data-testid="filter-projekt"
            value={filter.projekt}
            onChange={(event) => setFilter({ ...filter, projekt: event.target.value })}
          >
            <option value="alle">alle Projekte</option>
            {(antwort?.projekte ?? []).map((projekt) => (
              <option key={projekt.id} value={projekt.id}>
                {projekt.name}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Zustand{' '}
          <select
            data-testid="filter-zustand"
            value={filter.zustand}
            onChange={(event) => setFilter({ ...filter, zustand: event.target.value })}
          >
            <option value="alle">alle Zustände</option>
            {ZUSTAND_OPTIONEN.map((option) => (
              <option key={option.wert} value={option.wert}>
                {option.label}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          Priorität{' '}
          <select
            data-testid="filter-prioritaet"
            value={filter.prioritaet}
            onChange={(event) => setFilter({ ...filter, prioritaet: event.target.value })}
          >
            <option value="alle">alle Prioritäten</option>
            {PRIORITAET_OPTIONEN.map((priority) => (
              <option key={priority} value={priority}>
                {dringlichkeitLabel(priority)}
              </option>
            ))}
          </select>
        </label>{' '}
        <label>
          von{' '}
          <input
            type="date"
            data-testid="filter-von"
            value={filter.von}
            onChange={(event) => setFilter({ ...filter, von: event.target.value })}
          />
        </label>{' '}
        <label>
          bis{' '}
          <input
            type="date"
            data-testid="filter-bis"
            value={filter.bis}
            onChange={(event) => setFilter({ ...filter, bis: event.target.value })}
          />
        </label>{' '}
        <button
          type="button"
          data-testid="filter-zuruecksetzen"
          className="knopf"
          onClick={() => setFilter(LEERER_FILTER)}
        >
          Filter zurücksetzen
        </button>
      </form>

      {fehler && (
        <p role="alert" data-testid="spuren-fehler" className="streifen" data-ton="fehler">
          {fehler}
        </p>
      )}

      {laden && !antwort ? (
        <p data-testid="spuren-laden" className="leise">
          Wird geladen…
        </p>
      ) : null}

      {antwort && antwort.aufgaben.length === 0 ? (
        <p data-testid="spuren-leer" className="leerstand">
          {leerText(filter)}
        </p>
      ) : null}

      {antwort && antwort.aufgaben.length > 0 ? (
        <>
          {antwort.truncated ? (
            // Said out loud: a list silently cut at its limit reads as a
            // complete answer, which is the one thing a filter surface must not
            // do.
            <p data-testid="spuren-gekuerzt" className="streifen" data-ton="warnung">
              Es gibt mehr Aufgaben, als hier stehen. Grenze den Zeitraum ein, um den Rest zu sehen.
            </p>
          ) : null}
          <div className="tabellenfeld">
            <table data-testid="spuren-tabelle">
              <thead>
                <tr>
                  <th scope="col">Aufgabe</th>
                  <th scope="col">Projekt</th>
                  <th scope="col">Zustand</th>
                  <th scope="col">Priorität</th>
                  <th scope="col">zuletzt bewegt</th>
                </tr>
              </thead>
              <tbody>
                {antwort.aufgaben.map((aufgabe) => {
                  const zeile = aufgabenZeile(aufgabe);
                  return (
                    <tr key={aufgabe.id} data-testid="spuren-zeile">
                      <td>
                        <button
                          type="button"
                          data-testid="spur-oeffnen"
                          data-aufgabe={aufgabe.id}
                          className="knopf"
                          data-inhalt="daten"
                          onClick={() => navigate(aufgabePfad(aufgabe.id))}
                        >
                          {zeile.titel}
                        </button>
                      </td>
                      <td>{zeile.projekt}</td>
                      <td>{zeile.zustand}</td>
                      <td>{dringlichkeitLabel(aufgabe.priority)}</td>
                      <td>{zeile.bewegt}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </Rahmen>
  );
}

// --- one task ----------------------------------------------------------------

function AufgabeSeite({ taskId }: { taskId: string }) {
  const [detail, setDetail] = useState<SpurAufgabeDetail | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);

  useEffect(() => {
    let abgebrochen = false;
    void (async () => {
      const gelesen = await leseAufgabe(taskId);
      if (abgebrochen) return;
      if (gelesen.ok) setDetail(gelesen.wert.aufgabe);
      else setFehler(gelesen.fehler);
    })();
    return () => {
      abgebrochen = true;
    };
  }, [taskId]);

  if (fehler) {
    return (
      <Rahmen titel="Aufgabe">
        <p role="alert" data-testid="spuren-fehler" className="streifen" data-ton="fehler">
          {fehler}
        </p>
        <ZurListe />
      </Rahmen>
    );
  }

  if (!detail) {
    return (
      <Rahmen titel="Aufgabe">
        <p data-testid="spuren-laden" className="leise">
          Wird geladen…
        </p>
      </Rahmen>
    );
  }

  const zeile = aufgabenZeile(detail.aufgabe);

  return (
    <Rahmen titel={zeile.titel} daten>
      <ZurListe />

      <dl data-testid="aufgabe-kopf">
        <dt>Projekt</dt>
        <dd>{zeile.projekt}</dd>
        <dt>Zustand</dt>
        <dd data-testid="aufgabe-zustand">{zeile.zustand}</dd>
        <dt>Priorität</dt>
        <dd>{dringlichkeitLabel(detail.aufgabe.priority)}</dd>
        <dt>Zweig</dt>
        <dd>{detail.aufgabe.branch ?? 'kein Zweig (mehr) eingetragen'}</dd>
        <dt>rote Durchgänge</dt>
        <dd>{detail.aufgabe.retryCount}</dd>
      </dl>

      {detail.description ? <p data-testid="aufgabe-beschreibung">{detail.description}</p> : null}

      {detail.acceptanceCriteria.length > 0 ? (
        <>
          <h3>Abnahmekriterien</h3>
          <ul data-testid="aufgabe-kriterien" className="liste">
            {detail.acceptanceCriteria.map((kriterium) => (
              <li key={kriterium}>{kriterium}</li>
            ))}
          </ul>
        </>
      ) : null}

      <Zeitstrahl detail={detail} />
      <Laeufe detail={detail} />
      <GateErgebnisse detail={detail} />
      <Vergleich taskId={taskId} />
    </Rahmen>
  );
}

function Zeitstrahl({ detail }: { detail: SpurAufgabeDetail }) {
  return (
    <>
      <h3>Zeitstrahl</h3>
      <ol data-testid="zeitstrahl" className="zeitstrahl">
        {detail.ereignisse.map((ereignis) => {
          const runId = ereignisLauf(ereignis.payload);
          const istEntscheidung = ereignis.kind === 'escalation_requested';
          return (
            <li key={ereignis.seq} data-testid="zeitstrahl-eintrag" data-kind={ereignis.kind}>
              <span data-testid="zeitstrahl-zeit" className="leise">
                {zeitpunkt(ereignis.occurredAt)}
              </span>{' '}
              <span data-testid="zeitstrahl-text">{ereignisZeile(ereignis)}</span>{' '}
              <small>({ereignis.actor})</small>{' '}
              {/* Decision 2: the two-click path to a transcript line. */}
              {istEntscheidung && runId ? (
                <button
                  type="button"
                  data-testid="zur-entscheidungszeile"
                  data-lauf={runId}
                  className="knopf"
                  data-ton="ruf"
                  onClick={() => navigate(entscheidungsZiel(runId))}
                >
                  Zur Entscheidung im Sitzungsprotokoll
                </button>
              ) : null}
              {istEntscheidung && !runId ? (
                // A jump target that is quietly absent is precisely what a click
                // count cannot see, so it is stated instead.
                <em data-testid="ohne-sprungziel">
                  Dieser Eintrag nennt keine Sitzung — es gibt kein Sprungziel ins Protokoll.
                </em>
              ) : null}
              {!istEntscheidung && runId ? (
                <button
                  type="button"
                  data-testid="zum-lauf"
                  data-lauf={runId}
                  className="knopf"
                  onClick={() => navigate(laufPfad(runId))}
                >
                  Zur Sitzung
                </button>
              ) : null}
              <Nutzlast payload={ereignis.payload} />
            </li>
          );
        })}
      </ol>
    </>
  );
}

/**
 * The event payload, whole and as text.
 *
 * §18 makes `task_events` the source of truth, so a timeline that showed only
 * the keys it recognised would decide for the reader which facts exist. Rendered
 * inside `<pre>` as a child, never as markup (decision 3).
 */
function Nutzlast({ payload }: { payload: unknown }) {
  if (payload === null || payload === undefined) return null;
  const text = JSON.stringify(payload, null, 2);
  if (!text || text === '{}') return null;
  return (
    <details data-testid="zeitstrahl-nutzlast">
      <summary>Nutzlast</summary>
      <pre>{text}</pre>
    </details>
  );
}

function Laeufe({ detail }: { detail: SpurAufgabeDetail }) {
  return (
    <>
      <h3>Sitzungen</h3>
      {detail.laeufe.length === 0 ? (
        <p data-testid="laeufe-leer" className="leerstand">
          Für diese Aufgabe ist noch keine Sitzung gelaufen.
        </p>
      ) : (
        <div className="tabellenfeld">
          <table data-testid="laeufe-tabelle">
            <thead>
              <tr>
                <th scope="col">Rolle</th>
                <th scope="col">Modell</th>
                <th scope="col">Dauer</th>
                <th scope="col">Ausgang</th>
                <th scope="col">Kappen</th>
                <th scope="col">
                  <span className="nur-vorleser">Sitzungsprotokoll</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {detail.laeufe.map((lauf) => {
                const zeile = laufZeile(lauf);
                return (
                  <tr key={lauf.runId} data-testid="lauf-zeile">
                    <td>{zeile.rolle}</td>
                    <td>{zeile.modell}</td>
                    <td>{dauer(lauf.durationMs)}</td>
                    <td data-testid="lauf-ausgang">{laufAusgang(lauf)}</td>
                    <td data-testid="lauf-kappen">{kappen(lauf.caps)}</td>
                    <td>
                      <button
                        type="button"
                        data-testid="lauf-oeffnen"
                        data-lauf={lauf.runId}
                        className="knopf"
                        onClick={() => navigate(laufPfad(lauf.runId))}
                      >
                        Sitzungsprotokoll
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function GateErgebnisse({ detail }: { detail: SpurAufgabeDetail }) {
  return (
    <>
      <h3>Gate-Ergebnisse</h3>
      {detail.gateLaeufe.length === 0 ? (
        <p data-testid="gates-leer" className="leerstand">
          Für diese Aufgabe ist noch kein Gate-Lauf aufgezeichnet.
        </p>
      ) : (
        <ul data-testid="gate-laeufe" className="liste">
          {detail.gateLaeufe.map((lauf) => (
            <li key={lauf.id} data-testid="gate-lauf">
              <span className="plakette" data-ton={lauf.ok ? 'ok' : 'stopp'}>
                {lauf.ok ? 'grün' : 'rot'}
              </span>{' '}
              · {lauf.stage} · {zeitpunkt(lauf.finishedAt)} · {dauer(lauf.durationMs)} · Baum{' '}
              {kurz(lauf.headSha)}
              <ul>
                {lauf.steps.map((schritt) => (
                  <li key={schritt.id} data-testid="gate-schritt" data-verdict={schritt.verdict}>
                    {schritt.id}: {schritt.verdict}
                    {schritt.detail ? ` — ${schritt.detail}` : ''}
                    {schritt.output ? (
                      <details>
                        <summary>Ausgabe</summary>
                        <pre>{schritt.output}</pre>
                      </details>
                    ) : null}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <h3>Befunde</h3>
      {detail.befunde.length === 0 ? (
        <p data-testid="befunde-leer" className="leerstand">
          Kein Befund — kein Gate-Schritt dieser Aufgabe war rot.
        </p>
      ) : (
        <ul data-testid="befunde" className="liste">
          {detail.befunde.map((befund) => (
            <li key={befund.id} data-testid="befund" data-status={befund.status}>
              <strong>{befund.gateId}</strong> · {befund.severity} · {befund.status} ·{' '}
              {zeitpunkt(befund.raisedAt)}
              {befund.detail ? ` — ${befund.detail}` : ''}
              {befund.resolvedAt ? (
                <>
                  {' '}
                  · grün geworden {zeitpunkt(befund.resolvedAt)} auf {kurz(befund.resolvedOnSha)}
                </>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

function Vergleich({ taskId }: { taskId: string }) {
  const [diff, setDiff] = useState<SpurDiff | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [laden, setLaden] = useState(false);

  return (
    <>
      <h3>Vergleich</h3>
      {diff === null ? (
        <p>
          <button
            type="button"
            data-testid="diff-laden"
            className="knopf"
            disabled={laden}
            onClick={() => {
              setLaden(true);
              void (async () => {
                const gelesen = await leseDiff(taskId);
                if (gelesen.ok) setDiff(gelesen.wert.diff);
                else setFehler(gelesen.fehler);
                setLaden(false);
              })();
            }}
          >
            {laden ? 'Wird geladen…' : 'Vergleich laden'}
          </button>{' '}
          {/* Decision 4, said rather than implied. */}
          <small>Der Vergleich ruft git auf und wird deshalb erst auf Anforderung geholt.</small>
        </p>
      ) : null}

      {fehler ? (
        <p role="alert" data-testid="diff-fehler" className="streifen" data-ton="fehler">
          {fehler}
        </p>
      ) : null}

      {diff ? (
        <div data-testid="diff">
          <p data-testid="diff-kopf" className="etikett" data-inhalt="daten">
            {diffKopf(diff)}
          </p>
          <p data-testid="diff-zusammenfassung">{diffZusammenfassung(diff)}</p>
          {diff.truncated ? (
            <p data-testid="diff-gekuerzt" className="streifen" data-ton="warnung">
              Der Vergleich ist zu groß, um ihn ganz zu zeigen. Was hier steht, ist ein Ausschnitt.
            </p>
          ) : null}
          {diff.files.map((datei) => (
            <details key={datei.path} data-testid="diff-datei">
              <summary>
                {datei.path} · +{datei.added} / −{datei.removed}
                {datei.binary ? ' · binär' : ''}
              </summary>
              {datei.binary ? (
                <p>Binärdatei — dafür gibt es keinen Patch-Text.</p>
              ) : (
                // Untrusted, and rendered as a child so React escapes it.
                <pre data-testid="diff-patch">{datei.patch}</pre>
              )}
              {datei.patchTruncated ? <p>Dieser Patch ist gekürzt.</p> : null}
            </details>
          ))}
        </div>
      ) : null}
    </>
  );
}

// --- one run -----------------------------------------------------------------

/**
 * The query string, re-read whenever navigation changes it.
 *
 * `usePath` is not enough, and the reason is a genuine defect it would otherwise
 * have hidden: it stores `window.location.pathname`, and every jump inside one
 * run — from `?marke=decision` to `?zeile=12` — leaves the pathname identical.
 * `navigate` does push and does dispatch `popstate`, but `setPath` is then called
 * with the value it already holds, React bails out of the re-render, and the
 * effect that fetches the transcript never runs again. The anchor would appear
 * to work on the first click of a session and silently stop on every later one.
 *
 * Deliberately a local hook rather than a change to `router.ts`: the fix belongs
 * to the one page that navigates within a path, and `router.ts` is shared with
 * every other strand building on it right now.
 */
function useSuche(): string {
  const [suche, setSuche] = useState(() =>
    typeof window === 'undefined' ? '' : window.location.search,
  );
  useEffect(() => {
    const sync = () => setSuche(window.location.search);
    window.addEventListener('popstate', sync);
    // A query string that changed between the first render and this effect would
    // otherwise be missed for good — `usePath`'s own reasoning, one field over.
    sync();
    return () => window.removeEventListener('popstate', sync);
  }, []);
  return suche;
}

function LaufSeite({ runId }: { runId: string }) {
  const [detail, setDetail] = useState<SpurLaufDetail | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [nurGespraech, setNurGespraech] = useState(false);
  const [seite, setSeite] = useState<number | null>(null);

  // The anchor lives in the URL rather than in state, so a link from the
  // timeline, a reload and a pasted permalink all resolve identically.
  const suche = useSuche();

  /**
   * Paging drops the anchor.
   *
   * An anchor outranks a page number in `leseLauf` — it has to, or a permalink
   * to line 900 would be overruled by whatever page happened to be in state. The
   * consequence is that paging away from a jump has to clear it, otherwise the
   * server keeps answering with the anchor's page and the buttons do nothing.
   */
  const blaettern = useCallback(
    (ziel: number) => {
      setSeite(ziel);
      navigate(laufPfad(runId));
    },
    [runId],
  );

  useEffect(() => {
    let abgebrochen = false;
    const params = new URLSearchParams(suche);
    const zeile = Number(params.get('zeile'));
    const marke = params.get('marke');
    void (async () => {
      const gelesen = await leseLauf(runId, {
        zeile: Number.isSafeInteger(zeile) && zeile > 0 ? zeile : null,
        marke: (marke as never) ?? null,
        seite,
      });
      if (abgebrochen) return;
      if (gelesen.ok) {
        setDetail(gelesen.wert.lauf);
        setFehler(null);
      } else {
        setFehler(gelesen.fehler);
      }
    })();
    return () => {
      abgebrochen = true;
    };
  }, [runId, suche, seite]);

  if (fehler) {
    return (
      <Rahmen titel="Sitzung">
        <p role="alert" data-testid="spuren-fehler" className="streifen" data-ton="fehler">
          {fehler}
        </p>
        <ZurListe />
      </Rahmen>
    );
  }

  if (!detail) {
    return (
      <Rahmen titel="Sitzung">
        <p data-testid="spuren-laden" className="leise">
          Wird geladen…
        </p>
      </Rahmen>
    );
  }

  const { lauf, aufgabe, transkript } = detail;
  const sichtbar = sichtbareZeilen(transkript.lines, nurGespraech);
  const verborgen = verborgeneZeilen(transkript.lines, nurGespraech);

  return (
    <Rahmen titel={`Sitzung — ${lauf.role ?? 'ohne Rolle'}`} daten>
      <p>
        {aufgabe ? (
          <button
            type="button"
            data-testid="zur-aufgabe"
            className="knopf"
            data-inhalt="daten"
            onClick={() => navigate(aufgabePfad(aufgabe.id))}
          >
            Zurück zur Aufgabe: {aufgabenZeile(aufgabe).titel}
          </button>
        ) : (
          // A56.5: an audit session serves no task, by design. Named rather than
          // rendered as a dead button.
          <span data-testid="lauf-ohne-aufgabe" className="leise">
            Diese Sitzung gehört zu keiner Aufgabe — sie ist eine Prüfung des Studios selbst.
          </span>
        )}
      </p>

      <dl data-testid="lauf-kopf">
        <dt>Modell</dt>
        <dd>{laufZeile(lauf).modell}</dd>
        <dt>Backend</dt>
        <dd>{lauf.backend ?? 'nicht aufgezeichnet'}</dd>
        <dt>Sitzung</dt>
        <dd>{lauf.sessionId ?? 'keine Sitzungskennung aufgezeichnet'}</dd>
        <dt>Arbeitsverzeichnis</dt>
        <dd>{lauf.cwd ?? 'nicht aufgezeichnet'}</dd>
        <dt>Dauer</dt>
        <dd>{dauer(lauf.durationMs)}</dd>
        <dt>Ausgang</dt>
        <dd data-testid="lauf-ausgang">{laufAusgang(lauf)}</dd>
        <dt>Kappen (A32)</dt>
        <dd data-testid="lauf-kappen">{kappen(lauf.caps)}</dd>
        <dt>Werkzeugaufrufe / Hooks / Verweigerungen</dt>
        <dd>
          {lauf.toolUses} / {lauf.hookEvents} / {lauf.permissionDenials}
        </dd>
        <dt>Verbrauch</dt>
        {/* Never "Kosten": nothing is billed under §2's subscription rule, and a
            number labelled as money reads as money spent. */}
        <dd>
          {lauf.costUsd === null
            ? 'nicht aufgezeichnet'
            : `${lauf.costUsd.toFixed(2)} USD-Äquivalent (nicht abgerechnet)`}
        </dd>
      </dl>

      <h3>Sitzungsprotokoll</h3>
      <p data-testid="transkript-kopf" className="blase">
        {transkriptKopf(transkript)}
      </p>
      {transkript.path ? (
        <p data-testid="transkript-pfad" className="leise">
          <code>{transkript.path}</code>
        </p>
      ) : null}

      {transkript.focusProblem ? (
        <p
          role="alert"
          data-testid="transkript-sprungfehler"
          className="streifen"
          data-ton="warnung"
        >
          {transkript.focusProblem}
        </p>
      ) : null}

      {transkript.state !== 'present' ? null : (
        <>
          {transkript.marks.length > 0 ? (
            <ul data-testid="transkript-marken" className="knopfreihe">
              {angezeigteMarken(transkript.marks).map((marke) => (
                <li key={`${marke.kind}-${marke.nr}`}>
                  <button
                    type="button"
                    data-testid="transkript-marke"
                    data-kind={marke.kind}
                    className="knopf"
                    data-inhalt="daten"
                    onClick={() => navigate(laufPfad(runId, { zeile: marke.nr }))}
                  >
                    Zeile {marke.nr}: {markeLabel(marke.kind)}
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <p className="wahl" data-gewaehlt={nurGespraech ? '' : undefined}>
            <label>
              <input
                type="checkbox"
                data-testid="nur-gespraech"
                checked={nurGespraech}
                onChange={(event) => setNurGespraech(event.target.checked)}
              />{' '}
              nur das Gespräch zeigen
            </label>{' '}
            {verborgen > 0 ? (
              <small data-testid="verborgene-zeilen">
                {verborgen} Protokollzeilen ausgeblendet
              </small>
            ) : null}
          </p>

          <ol data-testid="transkript" className="transkript">
            {sichtbar.map((zeile) => (
              <Transkriptzeile
                key={zeile.nr}
                zeile={zeile}
                fokussiert={transkript.focus === zeile.nr}
              />
            ))}
          </ol>

          <p data-testid="transkript-blaettern" className="knopfreihe">
            <button
              type="button"
              data-testid="transkript-zurueck"
              className="knopf"
              disabled={transkript.page <= 1}
              onClick={() => blaettern(transkript.page - 1)}
            >
              vorige Seite
            </button>{' '}
            <span className="etikett" data-inhalt="daten">
              Seite {transkript.page} von {transkript.pages}
            </span>{' '}
            <button
              type="button"
              data-testid="transkript-weiter"
              className="knopf"
              disabled={transkript.page >= transkript.pages}
              onClick={() => blaettern(transkript.page + 1)}
            >
              nächste Seite
            </button>
          </p>
        </>
      )}
    </Rahmen>
  );
}

/**
 * One line of the JSONL.
 *
 * The body goes into `<pre>` **as a child**. That is decision 3 and it is the
 * whole of the escaping guarantee: this text is model output and foreign file
 * content, and `dangerouslySetInnerHTML` here would execute it.
 */
function Transkriptzeile({
  zeile,
  fokussiert,
}: {
  zeile: SpurTranskriptZeile;
  fokussiert: boolean;
}) {
  return (
    <li
      data-testid={fokussiert ? 'transkript-zeile-fokus' : 'transkript-zeile'}
      data-nr={zeile.nr}
      data-kind={zeile.kind}
      // Die angesprungene Zeile ist über den Baustein ausgezeichnet und nicht
      // über einen Inline-Stil: die Auszeichnung gehört ins System, wo sie
      // neben den übrigen Zuständen steht. Der Sprung bleibt hier — er braucht
      // das Element.
      data-fokus={fokussiert ? '' : undefined}
      ref={
        fokussiert
          ? (element) => element?.scrollIntoView({ block: 'center', behavior: 'auto' })
          : undefined
      }
    >
      {/* Die Zeilennummer ist die, die ein Dauerlink nennt. */}
      <strong className="etikett" data-inhalt="daten">
        {zeile.nr} · {zeilenLabel(zeile.kind)}
      </strong>{' '}
      <span data-testid="transkript-titel">{zeile.titel}</span>
      {zeile.marks.map((marke) => (
        <span key={marke} data-testid="transkript-zeile-marke" data-kind={marke}>
          {' '}
          [{markeLabel(marke)}]
        </span>
      ))}
      {/*
        Fremder Text: Modellausgabe und Dateiinhalte, wörtlich aus einer Datei
        kopiert. Er steht als **Kind** im `<pre>`, wo React ihn maskiert
        (Entscheidung 3) — und `<pre>` bringt aus `basis.css` sein eigenes
        Rollfeld mit, damit eine einzige lange Protokollzeile nicht die ganze
        Seite waagrecht aufzieht.
      */}
      <pre data-testid="transkript-text">{zeile.text}</pre>
      {zeile.truncated ? <small>Diese Zeile ist gekürzt.</small> : null}
    </li>
  );
}
