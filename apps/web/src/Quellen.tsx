import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  AKT_FELDER,
  ALLE,
  type Filter,
  filterUrl,
  isSourceActAllowed,
  type KuratierEingabe,
  kuratierPlan,
  LEERER_FILTER,
  leerText,
  leseQuelle,
  leseQuellen,
  punktzahl,
  QUELLEN_PFAD,
  quellenFehler,
  quellenKennung,
  quellenPfad,
  SOURCE_ACT_LABELS,
  SOURCE_STATE_LABELS,
  SOURCE_STATES,
  type SourceAct,
  type SourceDetailView,
  type SourceView,
  stufenText,
  TRUST_LEVELS,
  trustLevelCode,
  verlaufsBegruendung,
  verlaufszeile,
  zitierbarkeit,
} from './quellen-format.js';
import { navigate, segmentAfter, usePath } from './router.js';

/**
 * §14's source registry (§17.7): the list, one source in full, and curation.
 *
 * Two paths, one component, the arrangement `Dokumente.tsx` already uses:
 * `/quellen` is the register and `/quellen/<uuid>` is one source with its whole
 * history. The second is not a filtered view of the first — it fetches by id, so
 * a link still works when the list has moved on, and it survives a reload
 * because the server serves the app shell for every non-API path.
 *
 * **The history is the page, not an appendix.** A registry that shows only the
 * current standing throws away the thing 0021 chose an append-only log *for*:
 * §14 makes level ≥ L4 the condition for citing anything, so "who raised this to
 * L5, when, and on what grounds" is the evidence a Rechtsgutachten rests on, and
 * a page answering only "L5 today" cannot support the one question anybody asks
 * of it a year later. So every station is rendered, with its actor, its time and
 * its reason.
 *
 * **The buttons are the contract's table, not a guess.** `SOURCE_ACTS_BY_STATE`
 * decides which acts a source admits and the route refuses everything else with
 * a 409 — so rendering anything wider here would offer the operator a button that cannot
 * work, and rendering anything narrower would hide an act the registry allows.
 * One declaration, two readers (`@vorschicht/shared/quellen`).
 *
 * Every payload is **parsed** through that module rather than cast (A81), and
 * the parse lives in `quellen-format.ts` so that removing it breaks a test
 * rather than only a browser.
 */
export function Quellen() {
  const path = usePath();
  const segment = segmentAfter(path, QUELLEN_PFAD);
  const kennung = quellenKennung(segment);

  // A segment that is not a usable id is *not* the list page. Showing the whole
  // register for `/quellen/kaputt` reads as "deine Quelle ist weg" rather than
  // as "dieser Link ist kaputt" (A81.5).
  if (segment !== null && kennung === null) {
    return (
      <Rahmen>
        <p data-testid="quelle-unbekannt" role="alert" className="streifen" data-ton="fehler">
          „{segment}" ist keine Quellenkennung. Ein Dauerlink sieht aus wie
          <code> {QUELLEN_PFAD}/11111111-2222-4333-8444-555555555555</code>.
        </p>
        <Zurueck />
      </Rahmen>
    );
  }

  return kennung !== null ? <Detail kennung={kennung} /> : <Liste />;
}

function Rahmen({ children }: { children: ReactNode }) {
  return (
    <section className="karte">
      <h2>Quellen</h2>
      {children}
    </section>
  );
}

function Zurueck() {
  return (
    <p className="knopfreihe">
      <button
        type="button"
        data-testid="zu-den-quellen"
        className="knopf"
        onClick={() => navigate(QUELLEN_PFAD)}
      >
        Zum Quellenregister
      </button>
    </p>
  );
}

/**
 * Welchen Ton der Zustand einer Quelle trägt — reine Darstellung.
 *
 * §14 macht „aufgenommen" zur Bedingung für jede Zitation, also ist das die
 * eine Stellung, die anders aussehen muss als die drei übrigen. Der deutsche
 * Name steht daneben, Farbe trägt hier nichts allein.
 */
function zustandsTon(state: string): 'ok' | 'warnung' | 'stopp' | undefined {
  if (state === 'accepted') return 'ok';
  if (state === 'proposed') return 'warnung';
  if (state === 'rejected') return 'stopp';
  return undefined;
}

// --- the register ------------------------------------------------------------

function Liste() {
  const [quellen, setQuellen] = useState<SourceView[]>([]);
  const [filter, setFilter] = useState<Filter>(LEERER_FILTER);
  const [laden, setLaden] = useState(true);
  const [ladefehler, setLadefehler] = useState<string | null>(null);

  const laden_ = useCallback(async (aktuell: Filter) => {
    setLaden(true);
    setLadefehler(null);
    try {
      const antwort = await fetch(filterUrl(aktuell), { credentials: 'same-origin' });
      if (!antwort.ok) {
        const koerper = await antwort.json().catch(() => null);
        setLadefehler(quellenFehler(antwort.status, koerper).join(' '));
        return;
      }
      const gelesen = leseQuellen(await antwort.json());
      if (!gelesen.ok) {
        setLadefehler(gelesen.fehler);
        return;
      }
      setQuellen(gelesen.wert.quellen);
    } catch (grund) {
      setLadefehler(grund instanceof Error ? grund.message : String(grund));
    } finally {
      setLaden(false);
    }
  }, []);

  useEffect(() => {
    void laden_(filter);
  }, [laden_, filter]);

  return (
    <Rahmen>
      <p>
        §14 gewichtet, es verbietet nichts: eine kuratierte Quelle steht im Ranking weiter oben, die
        Abteilungen recherchieren weiterhin frei. Ab L4 darf eine rechtliche Aussage sie zitieren.
      </p>

      <p className="werkzeugleiste">
        <span className="feld">
          <label htmlFor="zustands-filter">Zustand</label>
          <select
            id="zustands-filter"
            data-testid="zustands-filter"
            value={filter.zustand}
            onChange={(ereignis) => setFilter({ ...filter, zustand: ereignis.target.value })}
          >
            <option value={ALLE}>Alle</option>
            {SOURCE_STATES.map((zustand) => (
              <option key={zustand} value={zustand}>
                {SOURCE_STATE_LABELS[zustand]}
              </option>
            ))}
          </select>
        </span>
        <span className="feld">
          <label htmlFor="stufen-filter">Mindestens</label>
          <select
            id="stufen-filter"
            data-testid="stufen-filter"
            value={filter.abStufe}
            onChange={(ereignis) => setFilter({ ...filter, abStufe: ereignis.target.value })}
          >
            <option value={ALLE}>Alle</option>
            {TRUST_LEVELS.map((stufe) => (
              <option key={stufe} value={String(stufe)}>
                {trustLevelCode(stufe)}
              </option>
            ))}
          </select>
        </span>
      </p>

      {ladefehler && (
        <p data-testid="quellen-fehler" role="alert" className="streifen" data-ton="fehler">
          Quellen nicht ladbar: {ladefehler}
        </p>
      )}

      {laden ? (
        <p data-testid="quellen-laden" className="leise">
          Wird geladen…
        </p>
      ) : quellen.length === 0 ? (
        <p data-testid="quellen-leer" className="leerstand">
          {leerText(filter)}
        </p>
      ) : (
        <ul data-testid="quellenliste" className="liste">
          {quellen.map((quelle) => (
            <li key={quelle.id} data-testid={`quelle-${quelle.id}`}>
              <a href={quellenPfad(quelle.id)} data-testid={`quelle-link-${quelle.id}`}>
                {quelle.title}
              </a>
              {/*
                Die Zeile bleibt **ein** Textlauf: ein Browserfall liest
                „Punktzahl 4,17" als zusammenhängend, ein eingeschobener Block
                mittendrin wäre ein Umbruch. Die Marke steht deshalb vorn und
                trägt nur den Zustandsnamen, der ohnehin dort stand.
              */}
              <p data-testid={`stand-${quelle.id}`} className="leise">
                <span className="plakette" data-ton={zustandsTon(quelle.state)}>
                  {SOURCE_STATE_LABELS[quelle.state]}
                </span>{' '}
                · {stufenText(quelle.level)} · Punktzahl {punktzahl(quelle.score)}
              </p>
            </li>
          ))}
        </ul>
      )}
    </Rahmen>
  );
}

// --- one source --------------------------------------------------------------

function Detail({ kennung }: { kennung: string }) {
  const [quelle, setQuelle] = useState<SourceDetailView | null>(null);
  const [ladefehler, setLadefehler] = useState<string | null>(null);
  const [unbekannt, setUnbekannt] = useState(false);
  const [fehler, setFehler] = useState<string[]>([]);
  const [erfolg, setErfolg] = useState<string | null>(null);

  const laden = useCallback(async () => {
    try {
      const antwort = await fetch(`/api/quellen/${encodeURIComponent(kennung)}`, {
        credentials: 'same-origin',
      });
      if (antwort.status === 404) {
        setUnbekannt(true);
        setLadefehler(null);
        return;
      }
      if (!antwort.ok) {
        const koerper = await antwort.json().catch(() => null);
        setLadefehler(quellenFehler(antwort.status, koerper).join(' '));
        return;
      }
      const gelesen = leseQuelle(await antwort.json());
      if (!gelesen.ok) {
        setLadefehler(gelesen.fehler);
        return;
      }
      setQuelle(gelesen.wert);
      setUnbekannt(false);
      setLadefehler(null);
    } catch (grund) {
      setLadefehler(grund instanceof Error ? grund.message : String(grund));
    }
  }, [kennung]);

  useEffect(() => {
    void laden();
  }, [laden]);

  if (ladefehler) {
    return (
      <Rahmen>
        <p data-testid="quellen-fehler" role="alert" className="streifen" data-ton="fehler">
          Quelle nicht ladbar: {ladefehler}
        </p>
        <Zurueck />
      </Rahmen>
    );
  }

  if (unbekannt) {
    return (
      <Rahmen>
        <p data-testid="quelle-unbekannt" role="alert" className="streifen" data-ton="fehler">
          Keine Quelle mit der Kennung {kennung}.
        </p>
        <Zurueck />
      </Rahmen>
    );
  }

  if (!quelle) {
    return (
      <Rahmen>
        <p data-testid="quellen-laden" className="leise">
          Wird geladen…
        </p>
      </Rahmen>
    );
  }

  const source = quelle.source;

  return (
    <Rahmen>
      <Zurueck />
      {/* Ein Quellentitel ist Inhalt und trägt Paragraphen und Jahreszahlen. */}
      <h3 data-testid="detail-titel" data-inhalt="daten">
        {source.title}
      </h3>

      <p data-testid="detail-fundstelle">
        Fundstelle:{' '}
        {source.url ? (
          <a href={source.url} rel="noreferrer noopener" target="_blank">
            {source.url}
          </a>
        ) : source.documentId ? (
          `Dokument aus dem Tresor (${source.documentId})`
        ) : (
          'keine'
        )}
      </p>

      <p data-testid="detail-stand" className="leise">
        <span className="plakette" data-ton={zustandsTon(source.state)}>
          {SOURCE_STATE_LABELS[source.state]}
        </span>{' '}
        · {stufenText(source.level)} · vorgeschlagen mit {trustLevelCode(source.proposedLevel)} ·
        Punktzahl {punktzahl(source.score)}
      </p>
      {/*
        §14s eine harte Regel: zitierfähig ist nur, was aufgenommen ist und
        mindestens L4 trägt. Sie steht als Blase statt als Absatz, weil es die
        Auskunft ist, wegen der ein Rechtsgutachten diese Seite überhaupt
        aufschlägt.
      */}
      <p
        data-testid="detail-zitierfaehig"
        className="blase"
        data-zustand={
          source.state === 'accepted' && (source.level ?? 0) >= 4 ? 'normal' : 'wrap_up'
        }
      >
        {zitierbarkeit(source)}
      </p>

      {source.assessment && (
        <p data-testid="detail-einschaetzung">
          Einschätzung der vorschlagenden Abteilung: {source.assessment}
        </p>
      )}
      {source.levelReason && (
        <p data-testid="detail-stufenbegruendung">
          Begründung für {trustLevelCode(source.level)}: {source.levelReason}
        </p>
      )}
      {source.stateReason && (
        <p data-testid="detail-zustandsbegruendung">
          Begründung für „{SOURCE_STATE_LABELS[source.state]}": {source.stateReason}
        </p>
      )}

      <h4>Verlauf (§14: der Beleg hinter der Stufe)</h4>
      <ul data-testid="verlauf" className="liste">
        {quelle.history.map((eintrag) => (
          <li key={eintrag.seq} data-testid={`verlauf-${eintrag.seq}`}>
            {verlaufszeile(eintrag)}
            {verlaufsBegruendung(eintrag) && (
              <>
                <br />
                <span data-testid={`verlauf-${eintrag.seq}-grund`} className="leise">
                  {verlaufsBegruendung(eintrag)}
                </span>
              </>
            )}
          </li>
        ))}
      </ul>

      <h4>Kuratieren</h4>
      {fehler.length > 0 && (
        <ul data-testid="kuratier-fehler" role="alert" className="streifen" data-ton="fehler">
          {fehler.map((grund) => (
            <li key={grund}>{grund}</li>
          ))}
        </ul>
      )}
      {erfolg && (
        <p data-testid="kuratier-erfolg" className="streifen" data-ton="hinweis">
          {erfolg}
        </p>
      )}

      {source.acts.map((act) => (
        <Akt
          key={act}
          act={act}
          source={source}
          onFertig={(aktualisiert, meldung) => {
            setQuelle(aktualisiert);
            setErfolg(meldung);
            setFehler([]);
          }}
          onFehler={(gruende) => {
            setFehler(gruende);
            setErfolg(null);
          }}
        />
      ))}
    </Rahmen>
  );
}

/**
 * One curation act as a form.
 *
 * Rendered only for the acts `source.acts` names, which is the contract's table
 * rather than this component's opinion — so the page can never offer a button
 * the route answers with a 409, and the 409 stays reachable for the case it is
 * *for*: a page that has gone stale since it was rendered.
 */
function Akt({
  act,
  source,
  onFertig,
  onFehler,
}: {
  act: SourceAct;
  source: SourceView;
  onFertig: (quelle: SourceDetailView, meldung: string) => void;
  onFehler: (gruende: string[]) => void;
}) {
  const felder = AKT_FELDER[act];
  // The proposed level as the default for an acceptance: it is what the
  // department assessed and the most likely answer — but it is a *default* in a
  // control the operator has to look at, never an inherited value, because §14 makes
  // granting the level his act rather than the proposal's (`acceptSubmission`).
  const [stufe, setStufe] = useState(String(source.level ?? source.proposedLevel));
  const [grund, setGrund] = useState('');
  const [laeuft, setLaeuft] = useState(false);

  async function senden() {
    const eingabe: KuratierEingabe = { stufe, grund };
    const plan = kuratierPlan(source, act, eingabe);
    if (!plan.ok) {
      onFehler(plan.fehler);
      return;
    }
    setLaeuft(true);
    try {
      const antwort = await fetch(plan.url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(plan.koerper),
      });
      if (!antwort.ok) {
        const koerper = await antwort.json().catch(() => null);
        onFehler(quellenFehler(antwort.status, koerper));
        return;
      }
      const gelesen = leseQuelle(await antwort.json());
      if (!gelesen.ok) {
        onFehler([gelesen.fehler]);
        return;
      }
      onFertig(gelesen.wert, `„${SOURCE_ACT_LABELS[act]}" ist eingetragen.`);
      setGrund('');
    } catch (grundFehler) {
      onFehler([grundFehler instanceof Error ? grundFehler.message : String(grundFehler)]);
    } finally {
      setLaeuft(false);
    }
  }

  return (
    <fieldset data-testid={`akt-${act}`}>
      <legend>{SOURCE_ACT_LABELS[act]}</legend>
      {felder.stufe && (
        <p className="feld">
          <label htmlFor={`akt-${act}-stufe`}>Vertrauensstufe</label>
          <select
            id={`akt-${act}-stufe`}
            data-testid={`akt-${act}-stufe`}
            value={stufe}
            onChange={(ereignis) => setStufe(ereignis.target.value)}
          >
            {TRUST_LEVELS.map((wert) => (
              <option key={wert} value={String(wert)}>
                {stufenText(wert)}
              </option>
            ))}
          </select>
        </p>
      )}
      <p className="feld">
        <label htmlFor={`akt-${act}-grund`}>
          {felder.grund ? 'Begründung (§14: der Beleg hinter der Stufe)' : 'Notiz (optional)'}
        </label>
        <input
          id={`akt-${act}-grund`}
          data-testid={`akt-${act}-grund`}
          value={grund}
          onChange={(ereignis) => setGrund(ereignis.target.value)}
        />
      </p>
      <p className="knopfreihe">
        <button
          type="button"
          data-testid={`akt-${act}-senden`}
          className="knopf"
          data-ton="haupt"
          disabled={laeuft || !isSourceActAllowed(source.state, act)}
          onClick={() => void senden()}
        >
          {SOURCE_ACT_LABELS[act]}
        </button>
      </p>
    </fieldset>
  );
}
