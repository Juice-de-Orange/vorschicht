/**
 * §18s Log-Explorer (§17, §22 Phase 7 Schritt 4).
 *
 * Das Werkzeug, mit dem der Betreiber nachsieht, warum etwas schiefging, statt zu fragen.
 * Bis hierher gab es nichts davon — keine Datei, keine Route, keinen Reiter —,
 * und damit war §1s Prinzip 4 („every error traceable end to end") genau an der
 * Stelle unterbrochen, an der jemand ohne Vorwissen anfängt.
 *
 * Alle Regeln liegen in `./log-format.ts` und `@vorschicht/shared/log`; diese
 * Datei rendert. Zwei Dinge an der Anordnung sind Entscheidungen:
 *
 *  1. **Der Rauschhinweis steht über der Liste und nicht darunter.** Er sagt,
 *     was diese Seite *nicht* zeigt, und das gehört gelesen, bevor jemand aus
 *     einer Liste schliesst, dass nichts passiert ist.
 *
 *  2. **Ein Filterwechsel setzt den Cursor zurück.** Sonst blättert man mit
 *     einem Cursor aus der alten Frage in der neuen weiter und sieht einen
 *     Ausschnitt, den niemand angefordert hat.
 */
import { LOG_API, LOG_KIND_OPTIONEN, LOG_LEVELS } from '@vorschicht/shared/log';
import { useCallback, useEffect, useState } from 'react';
import {
  korrelationen,
  LOG_ALLE,
  LOG_LEVEL_LABELS,
  LOG_PFAD,
  type LogAntwort,
  type LogFilter,
  liesLog,
  logAbfrage,
  logAnfangsfilter,
  logZeilenId,
  nutzlastText,
  rauschHinweis,
  zeitpunkt,
} from './log-format.js';
import { segmentAfter, usePath } from './router.js';

type Eingabe = Pick<
  LogFilter,
  'from' | 'to' | 'kind' | 'level' | 'projectId' | 'search' | 'noise'
> & {
  before: number | null;
};

export function Log() {
  const pfad = usePath();
  // Der Deep-Link öffnet das Protokoll **an** einer Zeile: sie steht oben, die
  // älteren darunter. `id + 1` als Cursor, weil `vor` echt kleiner vergleicht.
  const angesteuert = logZeilenId(segmentAfter(pfad, LOG_PFAD));

  // Der Anfangsfilter kommt aus der Adresszeile. Bis zum 18.8.2026 stand hier
  // eine leere Vorgabe, und `?suche=…` war damit wirkungslos — die Begründung
  // und wie es gefunden wurde, stehen bei `logAnfangsfilter`.
  const [eingabe, setEingabe] = useState<Eingabe>(() =>
    logAnfangsfilter(new URLSearchParams(window.location.search), angesteuert),
  );
  const [daten, setDaten] = useState<LogAntwort | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);

  const laden = useCallback(async (aktuell: Eingabe) => {
    try {
      const abfrage = logAbfrage(aktuell);
      const antwort = await fetch(abfrage ? `${LOG_API}?${abfrage}` : LOG_API, {
        credentials: 'same-origin',
      });
      if (!antwort.ok) {
        const koerper = (await antwort.json().catch(() => null)) as { errors?: string[] } | null;
        setFehler(koerper?.errors?.join(' ') ?? `Serverfehler ${antwort.status}`);
        return;
      }
      const gelesen = liesLog(await antwort.json());
      if (!gelesen.ok) {
        setFehler(gelesen.fehler);
        return;
      }
      setDaten(gelesen.wert.log);
      setFehler(null);
    } catch (cause) {
      setFehler(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void laden(eingabe);
  }, [laden, eingabe]);

  /** Entscheidung 2: ein neuer Filter fängt wieder oben an. */
  const setzeFilter = (teil: Partial<Eingabe>) =>
    setEingabe((vorher) => ({ ...vorher, ...teil, before: null }));

  const hinweis = daten ? rauschHinweis(daten.unterdrueckt, eingabe.noise) : null;

  return (
    <section className="karte">
      <h2>Log</h2>
      <p className="leise">
        §18s Ereignisprotokoll. Die <strong>Stufe</strong> steht nicht in der Datenbank — sie wird
        aus der Ereignisart abgeleitet, weil `event_log` keine Stufenspalte hat und eine erfundene
        eine Zahl wäre, die wie eine Messung aussieht.
      </p>

      {fehler && (
        <p role="alert" data-testid="log-fehler" className="streifen" data-ton="fehler">
          {fehler}
        </p>
      )}

      <fieldset data-testid="log-filter">
        <legend>Filter</legend>
        <p>
          <label>
            Volltext{' '}
            <input
              type="search"
              data-testid="log-suche"
              defaultValue={eingabe.search ?? ''}
              onChange={(event) => setzeFilter({ search: event.target.value || null })}
            />
          </label>{' '}
          <label>
            Stufe{' '}
            <select
              data-testid="log-stufe"
              value={eingabe.level ?? LOG_ALLE}
              onChange={(event) =>
                setzeFilter({
                  level:
                    event.target.value === LOG_ALLE
                      ? null
                      : (event.target.value as LogFilter['level']),
                })
              }
            >
              <option value={LOG_ALLE}>alle Stufen</option>
              {LOG_LEVELS.map((stufe) => (
                <option key={stufe} value={stufe}>
                  {LOG_LEVEL_LABELS[stufe]}
                </option>
              ))}
            </select>
          </label>{' '}
          <label>
            Art{' '}
            <select
              data-testid="log-art"
              value={eingabe.kind ?? LOG_ALLE}
              onChange={(event) =>
                setzeFilter({ kind: event.target.value === LOG_ALLE ? null : event.target.value })
              }
            >
              <option value={LOG_ALLE}>alle Arten</option>
              {LOG_KIND_OPTIONEN.map((art) => (
                <option key={art} value={art}>
                  {art}
                </option>
              ))}
            </select>
          </label>{' '}
          <label>
            Projekt{' '}
            <select
              data-testid="log-projekt"
              value={eingabe.projectId ?? LOG_ALLE}
              onChange={(event) =>
                setzeFilter({
                  projectId: event.target.value === LOG_ALLE ? null : event.target.value,
                })
              }
            >
              <option value={LOG_ALLE}>alle Projekte</option>
              {(daten?.projekte ?? []).map((projekt) => (
                <option key={projekt.id} value={projekt.id}>
                  {projekt.slug}
                </option>
              ))}
            </select>
          </label>
        </p>
        <p>
          <label>
            Von{' '}
            <input
              type="date"
              data-testid="log-von"
              defaultValue={eingabe.from ?? ''}
              onChange={(event) => setzeFilter({ from: event.target.value || null })}
            />
          </label>{' '}
          <label>
            Bis{' '}
            <input
              type="date"
              data-testid="log-bis"
              defaultValue={eingabe.to ?? ''}
              onChange={(event) => setzeFilter({ to: event.target.value || null })}
            />
          </label>{' '}
          <label>
            <input
              type="checkbox"
              data-testid="log-rauschen"
              checked={eingabe.noise}
              onChange={(event) => setzeFilter({ noise: event.target.checked })}
            />{' '}
            Rauschen einblenden
          </label>
        </p>
      </fieldset>

      {/*
        Entscheidung 1: über der Liste. Er sagt, was diese Seite nicht zeigt, und
        das gehört gelesen, bevor jemand aus einer kurzen Liste schliesst, dass
        nichts passiert ist.
      */}
      {hinweis && (
        <p data-testid="log-rauschhinweis" className="streifen" data-ton="hinweis">
          {hinweis}
        </p>
      )}

      {daten === null ? (
        <p className="leise">Wird geladen…</p>
      ) : daten.eintraege.length === 0 ? (
        <p data-testid="log-leer" className="leise">
          Keine Zeile passt zu diesem Filter.
        </p>
      ) : (
        // Rollbar, also mit der Tastatur erreichbar und benannt — siehe die
        // Begründung am gleichnamigen Element in `Overview.tsx`.
        <ul
          data-testid="log-liste"
          className="protokoll"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: axe verlangt für einen rollbaren Bereich genau das (scrollable-region-focusable, WCAG 2.1.1); die Listensemantik bleibt erhalten, anders als bei role="region"
          tabIndex={0}
          aria-label="Protokollzeilen"
        >
          {daten.eintraege.map((eintrag) => {
            const nutzlast = nutzlastText(eintrag.payload);
            return (
              <li
                key={eintrag.id}
                data-testid={`log-zeile-${eintrag.id}`}
                data-ton={eintrag.level === 'info' ? undefined : eintrag.level}
                data-angesteuert={eintrag.id === angesteuert ? '' : undefined}
              >
                {zeitpunkt(eintrag.occurredAt)} ·{' '}
                {/* Die Stufe als Wort, nicht nur als Ton: Farbe trägt hier
                    keine Aussage allein (a11y). */}
                <strong>{LOG_LEVEL_LABELS[eintrag.level]}</strong> ·{' '}
                <span className="etikett">{eintrag.kind}</span> · {eintrag.actor}
                {korrelationen(eintrag).map(([label, id]) => (
                  <div key={label} className="leise">
                    {label}: {id}
                  </div>
                ))}
                {/*
                  Als Text, nie als Markup: eine Nutzlast stammt aus fremden
                  Werkzeugen und wird hier nur wiedergegeben (`spurEreignis`,
                  Entscheidung 5).
                */}
                {nutzlast && <div className="leise">{nutzlast}</div>}
              </li>
            );
          })}
        </ul>
      )}

      {daten?.naechsteSeite !== null && daten !== null && (
        <p>
          <button
            type="button"
            data-testid="log-weiter"
            className="knopf"
            onClick={() => setEingabe((vorher) => ({ ...vorher, before: daten.naechsteSeite }))}
          >
            Ältere Zeilen
          </button>
        </p>
      )}
    </section>
  );
}
