import { decisionLogResponse, INBOX_API } from '@vorschicht/shared/inbox';
import { useEffect, useMemo, useState } from 'react';
import {
  type DecisionView,
  eskalationsPfad,
  lies,
  passtZurSuche,
  zeitpunkt,
} from './inbox-format.js';

/**
 * The decision log (§15, §17.5).
 *
 * §15 makes decisions **policy memory**: before escalating, an agent searches
 * what the operator has already decided, and the same question is never asked twice. So
 * this page is not an archive — it is the corpus that answers for him, and it
 * has to be readable by the person whose authority it carries. Two things
 * follow: every entry names what it was attached to (task, project), and the
 * search is over everything on the entry rather than over the question alone.
 *
 * **The rows link back to their card.** A comment here used to claim the
 * opposite — that `GET /api/posteingang/:nummer` serves only the *inbox*, so a
 * link from an answered entry would land on "Kein offener Eintrag". That was
 * never true: `EscalationService.byNumber` does not filter by state and the
 * route 404s only when the row does not exist. What was missing was the other
 * half, and it is built now: the card renders read-only once it is answered, so
 * following a decision back to the question it settled shows the question, the
 * options and what was chosen.
 */
export function Entscheidungen() {
  const [eintraege, setEintraege] = useState<DecisionView[] | null>(null);
  const [ladefehler, setLadefehler] = useState<string | null>(null);
  const [suche, setSuche] = useState('');

  useEffect(() => {
    let abgebrochen = false;
    const laden = async () => {
      try {
        const antwort = await fetch(INBOX_API.decisions, { credentials: 'same-origin' });
        if (!antwort.ok) throw new Error(`Serverfehler ${antwort.status}`);
        const gelesen = lies(decisionLogResponse, await antwort.json(), 'das Entscheidungslog');
        if (abgebrochen) return;
        if (!gelesen.ok) {
          setLadefehler(gelesen.fehler);
          return;
        }
        setEintraege(gelesen.wert.entscheidungen);
        setLadefehler(null);
      } catch (grund) {
        if (!abgebrochen) setLadefehler(grund instanceof Error ? grund.message : String(grund));
      }
    };
    void laden();
    return () => {
      abgebrochen = true;
    };
  }, []);

  const gefiltert = useMemo(
    () => (eintraege ?? []).filter((eintrag) => passtZurSuche(eintrag, suche)),
    [eintraege, suche],
  );

  if (ladefehler) {
    return (
      <section className="karte">
        <h2>Entscheidungen</h2>
        <p data-testid="entscheidungen-fehler" role="alert" className="streifen" data-ton="fehler">
          Entscheidungen nicht ladbar: {ladefehler}
        </p>
      </section>
    );
  }

  if (!eintraege) {
    return (
      <section className="karte">
        <h2>Entscheidungen</h2>
        <p className="leise">Wird geladen…</p>
      </section>
    );
  }

  return (
    <section className="karte">
      <h2>Entscheidungen</h2>

      <p className="feld">
        <label htmlFor="entscheidungen-suche">
          Suchen (Nummer, Frage, Antwort, Aufgabe, Projekt)
        </label>
        <input
          id="entscheidungen-suche"
          data-testid="entscheidungen-suche"
          value={suche}
          placeholder="z. B. #12 oder main"
          onChange={(ereignis) => setSuche(ereignis.target.value)}
        />
      </p>

      {eintraege.length === 0 ? (
        <p data-testid="entscheidungen-leer" className="leerstand">
          Noch nichts entschieden. Was du beantwortest, steht danach hier — und die Abteilungen
          lesen es, bevor sie erneut fragen (§15).
        </p>
      ) : (
        <>
          <p data-testid="entscheidungen-zahl" className="etikett">
            {gefiltert.length} von {eintraege.length} Entscheidungen
          </p>
          {gefiltert.length === 0 ? (
            <p data-testid="entscheidungen-nichts-gefunden" className="leerstand">
              Keine Entscheidung passt zu „{suche}".
            </p>
          ) : (
            /*
             * Ein Stapel und keine Aufzählung: jeder Eintrag ist ein Vorgang mit
             * Kopf, Frage und Antwort. `> li` bleibt unverändert direkt unter
             * der Liste — dazwischen darf nichts eingezogen werden.
             */
            <ul data-testid="entscheidungsliste" className="stapel">
              {gefiltert.map((eintrag) => (
                <li
                  key={eintrag.number}
                  data-testid={`entscheidung-${eintrag.number}`}
                  className="karte"
                >
                  <p className="leise">
                    <strong>#{eintrag.number}</strong> · {zeitpunkt(eintrag.decidedAt)} ·{' '}
                    {eintrag.sourceLabel} · {eintrag.projectId ?? 'projektübergreifend'}
                    {eintrag.taskId && ` · Aufgabe: ${eintrag.taskId}`}
                  </p>
                  <p>{eintrag.question}</p>
                  <p className="blase">
                    <strong>Deine Antwort:</strong> {eintrag.summary}
                  </p>
                  <p>
                    <a
                      href={eskalationsPfad(eintrag.number)}
                      data-testid={`entscheidung-link-${eintrag.number}`}
                    >
                      Zur Karte #{eintrag.number}
                    </a>
                  </p>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
