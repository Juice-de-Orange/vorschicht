import {
  escalationCardView,
  INBOX_API,
  inboxCardResponse,
  inboxListResponse,
} from '@vorschicht/shared/inbox';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ALLE_DRINGLICHKEITEN,
  type AntwortEingabe,
  antwortFehler,
  antwortNutzlast,
  dringlichkeitLabel,
  type EscalationCardView,
  eskalationsNummer,
  eskalationsPfad,
  konfliktKarte,
  lies,
  POSTEINGANG_PFAD,
  passtZurDringlichkeit,
  zeitpunkt,
} from './inbox-format.js';
import { navigate, segmentAfter, usePath } from './router.js';

/**
 * The escalation inbox (§15, §17.5).
 *
 * §15 is the "studio owner" model: every question arrives already researched,
 * so a card is not a prompt — it is a briefing. Everything the section
 * mandates is on it and none of it is optional: the context in prose, who is
 * asking and from which project, the urgency, two to four options each with
 * its pros and cons and exactly one marked as the recommendation, and **always
 * a free-text field**, even when the options look complete. An inbox that only
 * offered the prepared options would quietly turn a decision into a
 * multiple-choice exam.
 *
 * Two paths, one component. `/posteingang` is the list; `/posteingang/42` is
 * the single card every notification deep-links to (§15, §16). The second is
 * not a filtered view of the first — it fetches the item by number, so a link
 * still works when the list has moved on.
 *
 * **An answered card renders read-only rather than 404ing.** The route has
 * never filtered by state, and that is right: a push the operator opens an hour after
 * answering on his laptop should show him what was decided, not a dead end. A
 * form on an answered card would be worse than useless — every submission would
 * be refused with 409, which reads as a broken page rather than as "this is
 * done".
 */

interface Antwortstand {
  eingabe: AntwortEingabe;
  fehler: string[];
  laeuft: boolean;
}

const LEER: Antwortstand = {
  eingabe: { optionIndex: null, freitext: '' },
  fehler: [],
  laeuft: false,
};

/**
 * Welchen Ton die Dringlichkeit trägt — reine Darstellung, wie `windowTon` auf
 * der Übersicht.
 *
 * Es sagt nichts, was die Karte nicht ohnehin in Worten sagt: `dringlichkeitLabel`
 * setzt „P0 — sofort" daneben, Farbe ist also nirgends das einzige Merkmal.
 * P2 und P3 bekommen bewusst **keinen** Ton — wenn jede Karte eine farbige
 * Marke trägt, trägt keine mehr eine.
 */
function dringlichkeitTon(urgency: string): 'stopp' | 'warnung' | undefined {
  if (urgency === 'P0') return 'stopp';
  if (urgency === 'P1') return 'warnung';
  return undefined;
}

export function Posteingang() {
  const path = usePath();
  const segment = segmentAfter(path, POSTEINGANG_PFAD);
  const nummer = eskalationsNummer(segment);
  // A segment that is not a usable number is *not* the list page. Treating the
  // two the same meant `/posteingang/abc` — or a link mangled by a mail client
  // — silently showed every open question instead of saying the address was
  // unusable, which reads as "your item is gone" rather than as "that link is
  // broken". Found by the browser suite, which is where a deep link lives.
  const unbrauchbar = segment !== null && nummer === null;
  const [eintraege, setEintraege] = useState<EscalationCardView[] | null>(null);
  const [ladefehler, setLadefehler] = useState<string | null>(null);
  const [unbekannt, setUnbekannt] = useState(false);
  const [dringlichkeit, setDringlichkeit] = useState<string>(ALLE_DRINGLICHKEITEN);

  const laden = useCallback(async () => {
    const einzeln = nummer !== null;
    const url = einzeln ? INBOX_API.card(nummer) : INBOX_API.list;
    try {
      const antwort = await fetch(url, { credentials: 'same-origin' });
      if (antwort.status === 404) {
        setUnbekannt(true);
        setEintraege([]);
        setLadefehler(null);
        return;
      }
      if (!antwort.ok) throw new Error(`Serverfehler ${antwort.status}`);
      const koerper = await antwort.json();
      const gelesen = einzeln
        ? lies(inboxCardResponse, koerper, 'diese Karte')
        : lies(inboxListResponse, koerper, 'den Posteingang');
      if (!gelesen.ok) {
        setLadefehler(gelesen.fehler);
        return;
      }
      setEintraege(
        'eskalation' in gelesen.wert ? [gelesen.wert.eskalation] : gelesen.wert.posteingang,
      );
      setUnbekannt(false);
      setLadefehler(null);
    } catch (grund) {
      setLadefehler(grund instanceof Error ? grund.message : String(grund));
    }
  }, [nummer]);

  useEffect(() => {
    if (unbrauchbar) return;
    void laden();
  }, [laden, unbrauchbar]);

  // The filter applies to the list only. On a deep link there is one card and
  // hiding it because of a filter setting from another page would answer a
  // notification with an empty screen.
  const sichtbar = useMemo(
    () =>
      nummer !== null
        ? (eintraege ?? [])
        : (eintraege ?? []).filter((eintrag) => passtZurDringlichkeit(eintrag, dringlichkeit)),
    [eintraege, dringlichkeit, nummer],
  );

  if (unbrauchbar) {
    return (
      <section className="karte">
        <h2>Posteingang</h2>
        <p data-testid="eskalation-unbekannt" role="alert" className="streifen" data-ton="fehler">
          „{segment}" ist keine Eintragsnummer. Ein Dauerlink sieht aus wie
          <code> /posteingang/42</code>.
        </p>
        <p className="knopfreihe">
          <button
            type="button"
            data-testid="zum-posteingang"
            className="knopf"
            onClick={() => navigate(POSTEINGANG_PFAD)}
          >
            Zum Posteingang
          </button>
        </p>
      </section>
    );
  }

  if (ladefehler) {
    return (
      <section className="karte">
        <h2>Posteingang</h2>
        <p data-testid="posteingang-fehler" role="alert" className="streifen" data-ton="fehler">
          Posteingang nicht ladbar: {ladefehler}
        </p>
      </section>
    );
  }

  if (!eintraege) {
    return (
      <section className="karte">
        <h2>Posteingang</h2>
        <p className="leise">Wird geladen…</p>
      </section>
    );
  }

  if (unbekannt) {
    return (
      <section className="karte">
        <h2>Posteingang</h2>
        <p data-testid="eskalation-unbekannt" role="alert" className="streifen" data-ton="fehler">
          Kein Eintrag mit der Nummer #{nummer}. Die Nummer stimmt nicht — beantwortete Fragen
          bleiben erreichbar und stehen im Entscheidungslog.
        </p>
        <p className="knopfreihe">
          <button
            type="button"
            data-testid="zum-posteingang"
            className="knopf"
            onClick={() => navigate(POSTEINGANG_PFAD)}
          >
            Zum Posteingang
          </button>
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2>Posteingang</h2>
      {nummer !== null && (
        <p className="knopfreihe">
          <button
            type="button"
            data-testid="zum-posteingang"
            className="knopf"
            onClick={() => navigate(POSTEINGANG_PFAD)}
          >
            Alle offenen Fragen
          </button>
        </p>
      )}

      {nummer === null && eintraege.length > 0 && (
        <p className="werkzeugleiste">
          <span className="feld">
            <label htmlFor="dringlichkeit-filter">Dringlichkeit</label>
            <select
              id="dringlichkeit-filter"
              data-testid="dringlichkeit-filter"
              value={dringlichkeit}
              onChange={(ereignis) => setDringlichkeit(ereignis.target.value)}
            >
              <option value={ALLE_DRINGLICHKEITEN}>Alle</option>
              <option value="P0">{dringlichkeitLabel('P0')}</option>
              <option value="P1">{dringlichkeitLabel('P1')}</option>
              <option value="P2">{dringlichkeitLabel('P2')}</option>
              <option value="P3">{dringlichkeitLabel('P3')}</option>
            </select>
          </span>
        </p>
      )}

      {eintraege.length === 0 ? (
        <p data-testid="posteingang-leer" className="leerstand">
          Nichts offen. Der Betrieb kommt gerade allein weiter.
        </p>
      ) : sichtbar.length === 0 ? (
        <p data-testid="posteingang-gefiltert-leer" className="leerstand">
          Keine offene Frage mit dieser Dringlichkeit. Es warten {eintraege.length} andere.
        </p>
      ) : (
        <ul data-testid="posteingang-liste" className="stapel">
          {sichtbar.map((eintrag) => (
            <li key={eintrag.number}>
              <Karte eintrag={eintrag} onBeantwortet={laden} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Karte({
  eintrag,
  onBeantwortet,
}: {
  eintrag: EscalationCardView;
  onBeantwortet: () => Promise<void>;
}) {
  const [stand, setStand] = useState<Antwortstand>(LEER);
  // The answered card a 409 carried. It is sent for exactly this (`AnswerResult`
  // says so), and the page used to discard it and print a fixed sentence.
  const [konflikt, setKonflikt] = useState<EscalationCardView | null>(null);
  const gezeigt = konflikt ?? eintrag;
  const beantwortet = gezeigt.state === 'answered';

  async function absenden() {
    const geprueft = antwortNutzlast(stand.eingabe);
    if (!geprueft.ok) {
      setStand((vorher) => ({ ...vorher, fehler: geprueft.fehler }));
      return;
    }
    setStand((vorher) => ({ ...vorher, laeuft: true, fehler: [] }));
    try {
      const antwort = await fetch(INBOX_API.answer(eintrag.number), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(geprueft.nutzlast),
      });
      if (!antwort.ok) {
        // The body is read defensively: a 409 from a proxy carries no JSON, and
        // a card that broke on that would hide the reason it was refused.
        const koerper = await antwort.json().catch(() => null);
        setStand((vorher) => ({
          ...vorher,
          laeuft: false,
          fehler: antwortFehler(antwort.status, koerper),
        }));
        if (antwort.status === 409) {
          setKonflikt(konfliktKarte(escalationCardView, koerper));
          await onBeantwortet();
        }
        return;
      }
      setStand(LEER);
      await onBeantwortet();
    } catch (grund) {
      setStand((vorher) => ({
        ...vorher,
        laeuft: false,
        fehler: [grund instanceof Error ? grund.message : String(grund)],
      }));
    }
  }

  const gewaehlt = stand.eingabe.optionIndex;

  return (
    <article data-testid={`eskalation-${gezeigt.number}`} className="karte">
      {/* Nummer und Frage sind Inhalt — und die Nummer ist die, die man aus
          einer Benachrichtigung abtippt (siehe `basis.css`). */}
      <h3 data-inhalt="daten">
        #{gezeigt.number} · {gezeigt.question}
      </h3>

      {/* §15's "From": who asks, about what, how urgent, since when. */}
      <p data-testid={`herkunft-${gezeigt.number}`} className="leise">
        {gezeigt.sourceLabel} · {gezeigt.projectId ?? 'projektübergreifend'} ·{' '}
        {/* Die Dringlichkeit ist die eine Angabe dieser Zeile, die entscheidet,
            ob die Karte heute Abend noch offen sein darf. */}
        <strong className="plakette" data-ton={dringlichkeitTon(gezeigt.urgency)}>
          {dringlichkeitLabel(gezeigt.urgency)}
        </strong>{' '}
        · {zeitpunkt(gezeigt.raisedAt)}
      </p>

      <p data-testid={`kontext-${gezeigt.number}`}>{gezeigt.context}</p>

      <h4>Optionen</h4>
      {/*
        §15 verlangt genau eine markierte Empfehlung, und man muss sie **sehen,
        ohne zu lesen**: die empfohlene Option liegt auf warmem Papier, trägt
        eine doppelt so breite Kante und einen Schatten. Der Text „Empfehlung
        der Abteilung" bleibt unverändert und bleibt genau einmal vorhanden —
        ein Browserfall zählt ihn, und eine zweite Textmarke wäre ein zweiter
        Empfehlungsträger statt einer Auszeichnung des einen.
      */}
      <ul data-testid={`optionen-${gezeigt.number}`} className="optionen">
        {gezeigt.options.map((option) => (
          <li key={option.index} data-empfohlen={option.recommended ? '' : undefined}>
            {beantwortet ? (
              <strong data-testid={`option-${gezeigt.number}-${option.index}`}>
                {option.title}
                {option.index === gezeigt.chosenIndex && ' — von dir gewählt'}
              </strong>
            ) : (
              <label htmlFor={`option-${gezeigt.number}-${option.index}`}>
                <input
                  id={`option-${gezeigt.number}-${option.index}`}
                  data-testid={`option-${gezeigt.number}-${option.index}`}
                  type="radio"
                  name={`antwort-${gezeigt.number}`}
                  checked={gewaehlt === option.index}
                  onChange={() =>
                    setStand((vorher) => ({
                      ...vorher,
                      eingabe: { ...vorher.eingabe, optionIndex: option.index },
                    }))
                  }
                />{' '}
                {option.title}
              </label>
            )}
            {option.recommended && (
              <strong className="empfehlung"> — Empfehlung der Abteilung</strong>
            )}
            <p className="etikett" data-ton="gut">
              Dafür:
            </p>
            <ul className="liste">
              {option.pros.map((punkt) => (
                <li key={punkt}>{punkt}</li>
              ))}
            </ul>
            <p className="etikett" data-ton="schlecht">
              Dagegen:
            </p>
            <ul className="liste">
              {option.cons.map((punkt) => (
                <li key={punkt}>{punkt}</li>
              ))}
            </ul>
          </li>
        ))}
      </ul>

      {/* Context on the card, never an answer (A77.6). Prepared when it was
          raised, so it is what was true then rather than a fresh search. */}
      {gezeigt.related.length > 0 && (
        <>
          <h4>Ähnliches hast du schon entschieden</h4>
          <ul data-testid={`aehnliches-${gezeigt.number}`} className="liste">
            {gezeigt.related.map((frueher) => (
              <li key={frueher.number}>
                <a href={eskalationsPfad(frueher.number)}>#{frueher.number}</a> · {frueher.question}
                <br />
                <span className="leise">{frueher.summary}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* One list, outside the split: a refusal must stay visible when the 409
          that caused it turned this card read-only, and two lists sharing a
          testid is the duplicate-key shape this whole change exists to remove. */}
      {stand.fehler.length > 0 && (
        <ul
          data-testid={`antwort-fehler-${gezeigt.number}`}
          role="alert"
          className="streifen"
          data-ton="fehler"
        >
          {stand.fehler.map((fehler) => (
            <li key={fehler}>{fehler}</li>
          ))}
        </ul>
      )}

      {beantwortet ? (
        <p data-testid={`entschieden-${gezeigt.number}`} className="blase" data-zustand="normal">
          <strong>Entschieden</strong> am {zeitpunkt(gezeigt.answeredAt ?? '')} von{' '}
          {gezeigt.answeredBy ?? 'unbekannt'}
          {gezeigt.chosenTitle && <> · Gewählt: {gezeigt.chosenTitle}</>}
          {gezeigt.freeText && (
            <>
              <br />
              Deine Worte: „{gezeigt.freeText}"
            </>
          )}
        </p>
      ) : (
        <>
          {/* §15: always available, even when the options look exhaustive. */}
          <p className="feld">
            <label htmlFor={`freitext-${gezeigt.number}`}>
              Oder antworte in eigenen Worten (wird der Sitzung wörtlich weitergegeben)
            </label>
            <textarea
              id={`freitext-${gezeigt.number}`}
              data-testid={`freitext-${gezeigt.number}`}
              rows={3}
              value={stand.eingabe.freitext}
              onChange={(ereignis) =>
                setStand((vorher) => ({
                  ...vorher,
                  eingabe: { ...vorher.eingabe, freitext: ereignis.target.value },
                }))
              }
            />
          </p>

          <p className="knopfreihe">
            <button
              type="button"
              data-testid={`antworten-${gezeigt.number}`}
              className="knopf"
              data-ton="haupt"
              onClick={absenden}
              disabled={stand.laeuft}
            >
              Antworten
            </button>{' '}
            {gewaehlt !== null && (
              <button
                type="button"
                data-testid={`auswahl-loeschen-${gezeigt.number}`}
                className="knopf"
                onClick={() =>
                  setStand((vorher) => ({
                    ...vorher,
                    eingabe: { ...vorher.eingabe, optionIndex: null },
                  }))
                }
              >
                Auswahl aufheben
              </button>
            )}
          </p>
        </>
      )}

      <p className="leise">
        <a href={eskalationsPfad(gezeigt.number)} data-testid={`dauerlink-${gezeigt.number}`}>
          Dauerlink auf diese Karte
        </a>
      </p>
    </article>
  );
}
