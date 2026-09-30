import {
  BERICHTE_PATH,
  BerichteListeSchema,
  BerichtSchema,
  type BerichtUebersicht,
  zeitraumText,
} from '@vorschicht/shared/berichte';
import { useEffect, useState } from 'react';
import { lies } from './inbox-format.js';

/**
 * §16s Wochenbericht-Archiv (§17, §22 Phase 8 Schritt 2).
 *
 * §16 lässt den Bericht per Mail gehen **und** im Dashboard archiviert werden.
 * Die zweite Hälfte ist nicht die Bequemlichkeit, für die sie aussieht: eine
 * Mail lässt sich löschen, verschieben und übersehen, und §22s Gate für diese
 * Phase verlangt ausdrücklich, dass das Archiv **Historie** zeigt — also den
 * Vergleich zweier Wochen, den eine einzelne Mail nie leistet.
 *
 * Drei Entscheidungen an dieser Seite.
 *
 *   1. **Der Klartext in einem `<pre>`, nicht das Mail-HTML.** Die Begründung
 *      steht in `@vorschicht/shared/berichte`: der Klartext ist nach §16 eine
 *      vollwertige Fassung, trägt dieselben sechs Abschnitte und ist die
 *      einzige, die ohne `dangerouslySetInnerHTML` auf diese Seite kommt. Der
 *      Bericht ist für eine feste Breite gesetzt, also bleibt er es hier auch.
 *
 *   2. **Der Zeitraum ist der Schlüssel, nicht die uuid.** `reports` ist über
 *      `UNIQUE (period_start)` eindeutig (0024), also ist `/berichte/2026-09-01`
 *      dieselbe Adresse für denselben Bericht — auch wenn er einmal neu erzeugt
 *      werden musste und eine andere Kennung trägt. Eine uuid im Pfad wäre eine
 *      Adresse, die sich ändern kann, ohne dass sich der Inhalt ändert.
 *
 *   3. **Leer heisst „noch keiner", und das steht da.** Ein Archiv ohne
 *      Einträge sieht aus wie ein Ladefehler; §16 erzeugt den ersten Bericht am
 *      ersten Montag nach der Inbetriebnahme, und bis dahin ist die leere Liste
 *      die richtige Antwort und keine Störung. Derselbe Unterschied, den A110.3
 *      für den Tresor zieht: „nicht vorhanden" und „nicht gelesen" sind zwei
 *      Zustände, und wer sie zusammenwirft, schickt jemanden auf Fehlersuche.
 */
export function Berichte() {
  const [liste, setListe] = useState<BerichtUebersicht[] | null>(null);
  const [ladefehler, setLadefehler] = useState<string | null>(null);
  const [offen, setOffen] = useState<string | null>(null);
  const [volltext, setVolltext] = useState<{ periode: string; text: string } | null>(null);
  const [detailfehler, setDetailfehler] = useState<string | null>(null);

  useEffect(() => {
    let abgebrochen = false;
    const laden = async () => {
      try {
        const antwort = await fetch('/api/berichte', { credentials: 'same-origin' });
        if (!antwort.ok) throw new Error(`Serverfehler ${antwort.status}`);
        const gelesen = lies(BerichteListeSchema, await antwort.json(), 'das Berichtsarchiv');
        if (abgebrochen) return;
        if (!gelesen.ok) {
          setLadefehler(gelesen.fehler);
          return;
        }
        setListe(gelesen.wert.berichte);
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

  const oeffnen = async (bericht: BerichtUebersicht) => {
    const periode = bericht.periodStart.slice(0, 10);
    if (offen === periode) {
      setOffen(null);
      return;
    }
    setOffen(periode);
    setDetailfehler(null);
    // Einmal geholt, dann behalten: der Bericht ändert sich nicht mehr, und ein
    // erneuter Abruf beim Zuklappen und Wiederaufklappen wäre Arbeit für nichts.
    if (volltext?.periode === periode) return;
    try {
      const antwort = await fetch(`/api/berichte/${periode}`, { credentials: 'same-origin' });
      if (!antwort.ok) throw new Error(`Serverfehler ${antwort.status}`);
      const gelesen = lies(BerichtSchema, (await antwort.json()).bericht, 'einen Wochenbericht');
      if (!gelesen.ok) {
        setDetailfehler(gelesen.fehler);
        return;
      }
      setVolltext({ periode, text: gelesen.wert.bodyText });
    } catch (grund) {
      setDetailfehler(grund instanceof Error ? grund.message : String(grund));
    }
  };

  return (
    <section className="karte" data-testid="berichte">
      <h2>Wochenberichte</h2>
      <p className="leise">
        Jeden Montag um 07:00 (Europe/Vienna) für die abgelaufene Woche. Der Bericht geht zusätzlich
        per E-Mail; hier steht er dauerhaft.
      </p>

      {ladefehler && (
        <p data-testid="berichte-fehler" role="alert" className="streifen" data-ton="fehler">
          {ladefehler}
        </p>
      )}

      {liste !== null && liste.length === 0 && (
        <p data-testid="berichte-leer" className="leise">
          Noch kein Bericht erzeugt. Der erste entsteht am nächsten Montag um 07:00.
        </p>
      )}

      {liste !== null && liste.length > 0 && (
        <ul data-testid="berichte-liste" className="liste">
          {liste.map((bericht) => {
            const periode = bericht.periodStart.slice(0, 10);
            const aufgeklappt = offen === periode;
            return (
              <li key={bericht.id} data-testid={`bericht-${periode}`}>
                <button
                  type="button"
                  className="knopf"
                  aria-expanded={aufgeklappt}
                  onClick={() => void oeffnen(bericht)}
                >
                  {zeitraumText(bericht.periodStart, bericht.periodEnd)}
                </button>{' '}
                <span className="leise">{bericht.subject}</span>
                {aufgeklappt && detailfehler && (
                  <p role="alert" className="streifen" data-ton="fehler">
                    {detailfehler}
                  </p>
                )}
                {aufgeklappt && !detailfehler && volltext?.periode === periode && (
                  <pre data-testid={`bericht-text-${periode}`} className="bericht-text">
                    {volltext.text}
                  </pre>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export { BERICHTE_PATH };
