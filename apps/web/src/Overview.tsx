import { EVENT_KINDS } from '@vorschicht/shared/events';
import {
  HEALTHZ_PATH,
  INBOX_API,
  type OverviewPayload,
  overviewPayload,
} from '@vorschicht/shared/inbox';
import { type CSSProperties, useEffect, useRef, useState } from 'react';
import {
  blockiertHinweis,
  eskalationsPfad,
  lies,
  POSTEINGANG_PFAD,
  wartendeText,
} from './inbox-format.js';
import {
  type HealthReportView,
  type HealthTileView,
  healthzKachel,
  KACHEL_ZUSTAND_LABELS,
  kandidatZeile,
  liesHealthz,
  rolloutZeile,
  warteschlangeText,
} from './overview-format.js';
import { navigate } from './router.js';

/**
 * The overview (§17.1).
 *
 * The design target is that opening this page answers "is everything fine"
 * with zero clicks — so the guardian's verdict comes first, in words, before
 * any number. A dial you have to interpret is a click you have to spend.
 *
 * Everything here is read-only. The one thing it must never do is imply calm
 * it cannot vouch for: a window whose reading is stale or unreadable says so
 * instead of showing a reassuring percentage.
 */

/**
 * The payload is `@vorschicht/shared/inbox`'s and it is **parsed**, not cast.
 *
 * This interface used to be declared here, and it named two fields the endpoint
 * has never sent (`offeneEskalationen`, `blockierteAufgaben`) while ignoring the
 * one it does (`decisions`). So §15's counter never rendered and the blocked-task
 * list never appeared — silently, because `as` asserts and checks nothing. The
 * old comment explaining that `blockierteAufgaben` was optional "because no
 * route exposes it yet" was wrong twice over: a route did expose a task-level
 * number, under another name.
 */
type Overview = OverviewPayload;

interface FeedEntry {
  id: string;
  at: string;
  kind: string;
  actor: string;
}

const WINDOW_LABEL: Record<string, string> = {
  five_hour: '5-Stunden-Fenster',
  seven_day: 'Wochenfenster',
  seven_day_model: 'Wochenfenster je Modell',
};

const STATE_LABEL: Record<Overview['guardian']['state'], string> = {
  normal: 'Normalbetrieb',
  wrap_up: 'Aufräummodus',
  hard_stop: 'Angehalten',
};

function formatReset(resetsAt: number | null): string {
  if (resetsAt === null) return 'Reset unbekannt';
  const minutes = Math.round((resetsAt - Date.now()) / 60_000);
  if (minutes <= 0) return 'Reset überfällig';
  if (minutes < 90) return `Reset in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `Reset in ${hours} h` : `Reset in ${Math.round(hours / 24)} Tagen`;
}

/**
 * Welche Farbe ein Fenster trägt — reine Darstellung.
 *
 * Es sagt nichts, was die Seite nicht ohnehin schon zeigt: der Prozentwert und
 * beide Schwellen (§7.2) stehen als Text daneben, und deshalb ist Farbe hier
 * auch nirgends das einzige Merkmal. Der Balken darunter zeichnet in demselben
 * Ton, damit „ist etwas los" in drei Sekunden beantwortet ist, ohne zwei Zahlen
 * gegeneinander lesen zu müssen (§17.1).
 */
function windowTon(
  window: Overview['windows'][number],
  thresholds: Overview['thresholds'],
): 'ok' | 'warnung' | 'stopp' | 'unbekannt' {
  if (window.anomaly === 'unavailable') return 'unbekannt';
  if (window.usedPercent >= thresholds.hardStopPercent) return 'stopp';
  if (window.usedPercent >= thresholds.wrapUpPercent) return 'warnung';
  return 'ok';
}

/**
 * Eine Gesundheitskachel (§17.1, §18). Der Zustand steht als **Wort** daneben
 * und nicht nur als Ton: Farbe allein trägt hier keine Aussage, was das
 * a11y-Gate dieser Phase ausdrücklich verlangt.
 */
function Kachel({ kachel }: { kachel: HealthTileView }) {
  return (
    <li data-testid={`kachel-${kachel.id}`} data-ton={kachel.state}>
      <span className="etikett">{kachel.label}:</span>{' '}
      <strong>{KACHEL_ZUSTAND_LABELS[kachel.state]}</strong> — {kachel.detail}
    </li>
  );
}

export function Overview() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [feed, setFeed] = useState<FeedEntry[]>([]);
  const [connected, setConnected] = useState(false);
  /*
   * §17.1s Gesundheitskachel für die Anwendung selbst, aus `/healthz`.
   *
   * Ein **zweiter** Aufruf, und das ist der ganze Punkt: käme diese Kachel vom
   * Übersichtsendpunkt, wäre sie aus derselben Abfrage abgeleitet, die die
   * Antwort erzeugt hat — sie könnte dann nie etwas anderes sagen als „ok".
   * Und der Fall, für den eine Gesundheitskachel existiert, ist genau der, in
   * dem `/api/overview` nicht antwortet; deshalb wird sie unten auch im
   * Fehlerzweig gerendert. Bis heute las **keine** Seite diesen Endpunkt, obwohl
   * der Proxy und die Route seit Phase 0 stehen.
   */
  const [healthz, setHealthz] = useState<HealthReportView | null>(null);
  const [healthzProblem, setHealthzProblem] = useState<string | null>(null);
  const sourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(INBOX_API.overview, { credentials: 'same-origin' });
        if (!response.ok) throw new Error(`Serverfehler ${response.status}`);
        const gelesen = lies(overviewPayload, await response.json(), 'den Überblick');
        if (cancelled) return;
        if (!gelesen.ok) {
          setError(gelesen.fehler);
          return;
        }
        setData(gelesen.wert);
        setError(null);
      } catch (cause) {
        if (!cancelled) setError((cause as Error).message);
      }
    };
    const pruefeGesundheit = async () => {
      try {
        // `/healthz` antwortet 503, wenn die Datenbank nicht antwortet — der
        // Körper ist dann trotzdem der Bericht, und genau der ist die Aussage.
        // `response.ok` abzufragen würde den einen Fall verwerfen, für den diese
        // Kachel gebaut ist.
        const response = await fetch(HEALTHZ_PATH, { credentials: 'same-origin' });
        const gelesen = liesHealthz(await response.json());
        if (cancelled) return;
        if (!gelesen.ok) {
          setHealthz(null);
          setHealthzProblem(gelesen.fehler);
          return;
        }
        setHealthz(gelesen.wert);
        setHealthzProblem(null);
      } catch (cause) {
        if (cancelled) return;
        setHealthz(null);
        setHealthzProblem(cause instanceof Error ? cause.message : String(cause));
      }
    };

    void load();
    void pruefeGesundheit();
    // The feed is live; the summary is polled slowly as a backstop for the
    // case where a state change produced no event we happen to listen for.
    const timer = setInterval(() => {
      void load();
      void pruefeGesundheit();
    }, 30_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const source = new EventSource('/events');
    sourceRef.current = source;
    source.onopen = () => setConnected(true);
    source.onerror = () => setConnected(false);
    /*
     * `addEventListener` je Art, **nicht** `onmessage` (A123).
     *
     * `formatEvent` schreibt auf jeden Rahmen `event: <art>`; unbenannte
     * Datenrahmen gibt es auf diesem Strom nicht. Nach der
     * EventSource-Spezifikation feuert `onmessage` aber nur für Rahmen des Typs
     * `message` — mit ihm ist die Seite **verbunden und empfängt nichts**.
     * Genau so stand es hier seit Phase 1: „Verlauf (live)" über einer Liste,
     * die dauerhaft „Noch nichts passiert." zeigte, und kein Test wurde davon
     * rot. Ein Signalpfad, der verbunden aussieht und nichts trägt, ist §8.2s
     * sechste Domäne in ihrer unangenehmsten Form — auf der Seite, die §17.1
     * zufolge ohne einen Klick beantworten soll, ob alles in Ordnung ist.
     */
    const onFrame = (event: MessageEvent) => {
      try {
        const parsed = JSON.parse(event.data) as FeedEntry;
        setFeed((previous) => [parsed, ...previous].slice(0, 50));
      } catch {
        // A frame we cannot read is not worth breaking the page over.
      }
    };
    for (const kind of EVENT_KINDS) source.addEventListener(kind, onFrame);
    return () => {
      for (const kind of EVENT_KINDS) source.removeEventListener(kind, onFrame);
      source.close();
      sourceRef.current = null;
    };
  }, []);

  // Die Kachel für die Anwendung selbst wird in **jedem** der drei Zweige
  // gerendert. Der interessante ist der erste: wenn `/api/overview` nicht
  // antwortet, ist die Seite leer, und diese eine Zeile ist dann das Einzige,
  // was noch etwas sagen kann — und meistens auch, warum.
  const anwendung = healthzKachel(healthz, healthzProblem);
  const anwendungsKachel = (
    <ul data-testid="gesundheit-kacheln" className="kennzahlen">
      <Kachel kachel={anwendung} />
    </ul>
  );

  if (error) {
    return (
      <section className="karte">
        <h2>Überblick</h2>
        <p role="alert" className="streifen" data-ton="fehler">
          Überblick nicht ladbar: {error}
        </p>
        <h3>Gesundheit</h3>
        {anwendungsKachel}
      </section>
    );
  }

  if (!data) {
    return (
      <section className="karte">
        <h2>Überblick</h2>
        <p className="leise">Wird geladen…</p>
        <h3>Gesundheit</h3>
        {anwendungsKachel}
      </section>
    );
  }

  // One array, read once: the counter's number is this list's length and the
  // rows below are this list's entries. They cannot disagree, which is not true
  // of two derivations that merely agree today (§17.1).
  const blockiert = data.decisions.blockedTasks;
  const wartende = wartendeText(data.decisions.open, blockiert);
  const warteschlange = warteschlangeText(data.mergeQueue);

  return (
    <section className="karte">
      <h2>Überblick</h2>

      {/* The verdict in words, before any number. */}
      <p data-testid="guardian-state" className="blase" data-zustand={data.guardian.state}>
        <strong>{STATE_LABEL[data.guardian.state]}</strong> — {data.guardian.text}
      </p>

      {/*
        §15's counter, directly under the verdict: a studio that has stopped
        asking because nobody answered looks exactly like a studio with nothing
        to do, and this line is the only thing that separates the two. It is
        absent at zero — a permanent "0 Entscheidungen" is a badge you stop
        reading, and then the first real one is invisible.
      */}
      {wartende !== null && (
        <p data-testid="wartende-entscheidungen">
          <button
            type="button"
            data-testid="zur-inbox"
            className="knopf"
            data-ton="ruf"
            onClick={() => navigate(POSTEINGANG_PFAD)}
          >
            {wartende}
          </button>
        </p>
      )}

      {/*
        Kein Umbau dieser Liste: mehrere Browserfälle zählen `> li` direkt
        darunter (§15s „blockiert durch Entscheidung #X"). Sie bekommt eine
        Klasse und sonst nichts.
      */}
      {blockiert.length > 0 && (
        <ul data-testid="blockierte-aufgaben" className="liste">
          {blockiert.map((eintrag) => (
            <li key={eintrag.taskId} data-testid={`blockiert-${eintrag.taskId}`}>
              „{eintrag.title}" — {blockiertHinweis(eintrag.number)}
              {/*
                Wer hinter fremden Claims wartet, hat die Frage nie gestellt —
                ohne den Halter ist „blockiert durch #7" für diese Zeile nicht
                nachvollziehbar. §9s Fall, den die Übersicht bis zur
                Betriebsprüfung 767db82c gar nicht kannte.
              */}
              {eintrag.art === 'blockiert' && eintrag.haltendeAufgabe && (
                <> (wartet auf „{eintrag.haltendeAufgabe}")</>
              )}{' '}
              <a
                href={eskalationsPfad(eintrag.number)}
                data-testid={`blockiert-link-${eintrag.taskId}`}
              >
                zur Karte
              </a>
            </li>
          ))}
        </ul>
      )}

      {/*
        Die dritte Art Stillstand (A44.3, A85): das Projekt ist auf Nur-Lesen
        gestellt, also überspringt der Ablaufplaner diese Aufgaben — bis zu
        dieser Zeile in jeder Liste, die er führt, und auf dieser Seite
        überhaupt nicht. Eigener Abschnitt statt einer dritten `art` oben:
        §17.1s Zähler dort zählt Aufgaben, die auf eine *Entscheidung* im
        Postfach warten, und diese warten auf eine Kennzeichnung. Der Satz
        nennt deshalb auch, was zu tun wäre — eine Liste, die nur meldet,
        erzeugt genau die Ratlosigkeit, gegen die §17.1 gebaut ist.
      */}
      {data.stalledTasks.length > 0 && (
        <section data-testid="liegengeblieben" className="streifen" data-ton="warnung">
          <h3>Liegt, weil das Projekt nur lesbar ist</h3>
          <p>
            {data.stalledTasks.length === 1
              ? '1 Aufgabe wird nicht bearbeitet'
              : `${data.stalledTasks.length} Aufgaben werden nicht bearbeitet`}
            , weil ihr Projekt auf Nur-Lesen steht (A44.3). Das löst sich nicht von selbst — du
            gibst das Projekt frei, oder die Aufgaben bleiben liegen.
          </p>
          <ul className="liste">
            {data.stalledTasks.map((eintrag) => (
              <li key={eintrag.taskId} data-testid={`liegengeblieben-${eintrag.taskId}`}>
                „{eintrag.title}" — Projekt „{eintrag.projectSlug}" ist nur lesbar
              </li>
            ))}
          </ul>
        </section>
      )}

      {data.weeklyExhaustedUntil && (
        <p data-testid="weekly-exhausted" className="streifen" data-ton="warnung">
          Wochenbudget erschöpft — Betrieb ruht bis{' '}
          {new Date(data.weeklyExhaustedUntil).toLocaleString('de-AT')}.
        </p>
      )}

      {/*
        §17.1s Gesundheitskacheln. Die erste kommt aus `/healthz` und die
        übrigen aus dem Ereignisprotokoll (§18): der Zustand der nächtlichen
        Sicherung (A14, A103) und der Plattendruck (A30). Alle drei nennen
        ihren Zustand als Wort, nicht nur als Ton.
      */}
      <h3>Gesundheit</h3>
      <ul data-testid="gesundheit-kacheln" className="kennzahlen">
        <Kachel kachel={anwendung} />
        {data.health.map((kachel) => (
          <Kachel key={kachel.id} kachel={kachel} />
        ))}
      </ul>

      {/*
        §10s Warteschlange. Sie ist absent, wenn nichts wartet — ein dauerhaftes
        „0 Kandidaten" ist eine Zeile, die man zu übersehen lernt, und dann ist
        die erste echte unsichtbar (§15s Zähler eine Ebene höher macht es
        genauso).
      */}
      {warteschlange !== null && (
        <>
          <h3>Merge-Queue</h3>
          <p data-testid="merge-queue">{warteschlange}</p>
          <ul data-testid="merge-queue-liste" className="liste">
            {data.mergeQueue.candidates.map((kandidat) => (
              <li key={kandidat.taskId} data-testid={`merge-kandidat-${kandidat.taskId}`}>
                „{kandidat.title}" — {kandidatZeile(kandidat)}
              </li>
            ))}
          </ul>
        </>
      )}

      <h3>Letzte Rollouts</h3>
      {data.deploys.length === 0 ? (
        <p data-testid="keine-deploys" className="leise">
          Noch nichts ausgerollt.
        </p>
      ) : (
        <ul data-testid="deploys" className="liste">
          {data.deploys.map((eintrag) => (
            <li
              key={eintrag.deployment.id}
              data-testid={`deploy-${eintrag.deployment.id}`}
              data-ton={
                eintrag.deployment.outcome === 'succeeded'
                  ? 'ok'
                  : eintrag.deployment.outcome === null
                    ? 'unbekannt'
                    : 'warnung'
              }
            >
              {rolloutZeile(eintrag)}
              {eintrag.deployment.problem ? ` · ${eintrag.deployment.problem}` : ''}
            </li>
          ))}
        </ul>
      )}

      <h3>Budget</h3>
      {/*
        Die Kennzahlen. Der Balken unter jeder Zeile ist reine Darstellung und
        hat kein eigenes Markup — `data-balken` schaltet ihn ein, `--fuellung`
        sagt wie weit. Ein Fenster **ohne** Messung bekommt beides nicht: ein
        leerer Balken wäre eine beruhigende Aussage über eine Zahl, die es nicht
        gibt, und das ist genau der Fall, den die Zeile darunter in Worten
        ablehnt.
      */}
      <ul data-testid="windows" className="kennzahlen">
        {data.windows.map((window) => {
          const messbar = window.anomaly !== 'unavailable';
          return (
            <li
              key={`${window.window}:${window.modelClass ?? ''}`}
              data-ton={windowTon(window, data.thresholds)}
              data-balken={messbar ? '' : undefined}
              style={
                messbar
                  ? ({
                      '--fuellung': Math.min(100, Math.max(0, window.usedPercent)).toFixed(1),
                    } as CSSProperties)
                  : undefined
              }
            >
              <span className="etikett">
                {WINDOW_LABEL[window.window] ?? window.window}
                {window.modelClass ? ` (${window.modelClass})` : ''}:
              </span>{' '}
              {messbar ? (
                <>
                  <strong>{window.usedPercent.toFixed(1).replace('.', ',')} %</strong>
                  {window.source === 'estimated' && ' (geschätzt)'} · {formatReset(window.resetsAt)}
                </>
              ) : (
                // Never a reassuring number for a reading we do not have.
                <strong>nicht lesbar</strong>
              )}
            </li>
          );
        })}
      </ul>
      <p className="leise">
        Aufräummodus ab {data.thresholds.wrapUpPercent} %, Stopp ab{' '}
        {data.thresholds.hardStopPercent} % — die restlichen {100 - data.thresholds.hardStopPercent}{' '}
        % gehören dir.
      </p>

      <h3>Laufende Sitzungen</h3>
      {data.activeRuns.length === 0 ? (
        <p data-testid="no-runs" className="leise">
          Gerade keine.
        </p>
      ) : (
        <ul data-testid="active-runs" className="liste">
          {data.activeRuns.map((run) => (
            <li key={run.runId}>
              {run.role ?? 'unbekannt'} · {run.model ?? 'kein Modell vermerkt'}
            </li>
          ))}
        </ul>
      )}

      <h3>
        Verlauf{' '}
        <span
          data-testid="verlauf-verbindung"
          className="puls"
          data-zustand={connected ? 'live' : 'getrennt'}
        >
          {connected ? '(live)' : '(getrennt)'}
        </span>
      </h3>
      {feed.length === 0 ? (
        <p data-testid="verlauf-leer" className="leise">
          Noch nichts passiert.
        </p>
      ) : (
        // `.protokoll` rollt (`max-height` + `overflow-y: auto`), und ein
        // rollbarer Bereich muss mit der Tastatur erreichbar sein — sonst kommt
        // niemand ohne Maus an den unteren Teil. axe meldet das erst, wenn der
        // Inhalt wirklich überläuft, weshalb es hier monatelang latent war und
        // am 18.8.2026 mit mehr Zeilen auf drei Seiten gleichzeitig auftauchte
        // (`scrollable-region-focusable`, WCAG 2.1.1). Der Name gehört dazu und
        // ist nicht Zierde: fokussierbar ohne Namen heisst für einen Vorleser
        // nur „Liste".
        <ul
          data-testid="feed"
          className="protokoll"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: axe verlangt für einen rollbaren Bereich genau das (scrollable-region-focusable, WCAG 2.1.1); die Listensemantik bleibt erhalten, anders als bei role="region"
          tabIndex={0}
          aria-label="Verlauf"
        >
          {feed.map((entry) => (
            <li key={entry.id}>
              {new Date(entry.at).toLocaleTimeString('de-AT')} · {entry.kind} · {entry.actor}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
