/**
 * §17.8's Controlling page — the budget, and the operator's two switches.
 *
 * Every rule this page follows lives elsewhere and is tested there:
 * `@vorschicht/shared/controlling` decides what a switch position means and what
 * a number is worth, `./controlling-format.ts` parses the payload and computes
 * the graph. This file renders.
 *
 * Three things about the arrangement are deliberate.
 *
 *  1. **No number appears without the sentence saying what it is worth.** Below
 *     the vendor's 75 % warning threshold there *is* no official figure (A73),
 *     so most of the time every percentage on this page is our own estimate —
 *     and a page that printed it like a measurement would be the one defect this
 *     page must not have. The badge is rendered from the payload, beside the
 *     number, never behind a tooltip.
 *
 *  2. **The pause is confirmed, the Sparbetrieb is not.** A hard pause costs
 *     every running task a §7.2 integrity re-check, so it is not something to
 *     hit by accident on a phone; Sparbetrieb is reversible and costs nothing to
 *     try. Asking for confirmation everywhere would train the reflex that makes
 *     confirmation useless.
 *
 *  3. **The server's answer replaces the local state, never the submission**
 *     (`Einstellungen.tsx`'s decision 2). Here it matters more: the guardian
 *     line is a *consequence* of the pause, so redrawing from what we hoped we
 *     had sent could show "Pause" above a guardian still reading Normalbetrieb.
 */
import { type CSSProperties, useCallback, useEffect, useState } from 'react';
import {
  CONTROLLING_API,
  type ControllingBody,
  fensterReihenfolge,
  fensterTitel,
  kopfzeile,
  leseControlling,
  PAUSE_MODE_DESCRIPTIONS,
  PAUSE_MODE_LABELS,
  PAUSE_MODES,
  type PauseMode,
  prozent,
  restzeit,
  verlaufPfad,
  verlaufReihen,
  verlaufSpanne,
  vertrauensEtikett,
} from './controlling-format.js';

const DIAGRAMM = { breite: 320, hoehe: 80 };

/**
 * Welche Farbe ein Fenster trägt — reine Darstellung, wie `windowTon` auf der
 * Übersicht, und aus demselben Grund hier statt in `controlling-format.ts`.
 *
 * Es sagt nichts, was die Seite nicht ohnehin zeigt: der Prozentwert, beide
 * Schwellen und die Vertrauensstufe stehen als Text daneben. Die *dritte*
 * Schwelle ist der Punkt — bei einer Schätzung räumt der Wächter schon ab
 * `degradedWrapUpPercent` auf (A73), und eine Zeile, die bis 85 % ruhig
 * aussähe, während der Wächter bei 75 % anhält, wäre eine beruhigende Farbe
 * über einem Studio, das gleich stehenbleibt.
 */
function fensterTon(
  fenster: { usedPercent: number; vertrauen: { stufe: string } },
  schwellen: { wrapUpPercent: number; hardStopPercent: number; degradedWrapUpPercent: number },
): 'ok' | 'warnung' | 'stopp' | 'unbekannt' {
  if (fenster.vertrauen.stufe === 'blind') return 'unbekannt';
  if (fenster.usedPercent >= schwellen.hardStopPercent) return 'stopp';
  const aufraeumen =
    fenster.vertrauen.stufe === 'offiziell'
      ? schwellen.wrapUpPercent
      : schwellen.degradedWrapUpPercent;
  return fenster.usedPercent >= aufraeumen ? 'warnung' : 'ok';
}

export function Controlling() {
  const [daten, setDaten] = useState<ControllingBody | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [beschaeftigt, setBeschaeftigt] = useState(false);
  const [notiz, setNotiz] = useState<string | null>(null);

  const laden = useCallback(async () => {
    try {
      const antwort = await fetch(CONTROLLING_API.root, { credentials: 'same-origin' });
      if (!antwort.ok) {
        setFehler(`Serverfehler ${antwort.status}`);
        return;
      }
      const gelesen = leseControlling(await antwort.json());
      if (!gelesen.ok) {
        setFehler(gelesen.fehler);
        return;
      }
      setDaten(gelesen.wert);
      setFehler(null);
    } catch (cause) {
      setFehler(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void laden();
  }, [laden]);

  /**
   * Submit one switch, moving it now and reconciling with the server below.
   *
   * The optimistic move is not a flourish — `Einstellungen.tsx` records the
   * same finding and this page reproduced it: a radio whose `checked` comes
   * only from the server does not move under the pointer until a round trip
   * finishes, so the control reads as broken, and Playwright reports it as a
   * click that changed nothing. Every exit below either replaces this with what
   * was stored or re-reads the server, so an optimistic value never survives a
   * refusal — which matters more here than on the settings page, because the
   * value in question is whether the studio is running.
   */
  async function senden(
    pfad: string,
    koerper: unknown,
    erfolg: string,
    sofort: (vorher: ControllingBody) => ControllingBody,
  ) {
    setBeschaeftigt(true);
    setNotiz(null);
    setDaten((vorher) => (vorher ? sofort(vorher) : vorher));
    try {
      const antwort = await fetch(pfad, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(koerper),
      });
      if (!antwort.ok) {
        const body = (await antwort.json().catch(() => null)) as { errors?: string[] } | null;
        setFehler(body?.errors?.join(' ') ?? `Serverfehler ${antwort.status}`);
        // Re-read rather than remember: what the switch should show is what is
        // stored, and this page has just demonstrated its idea of that can be
        // wrong.
        await laden();
        return;
      }
      const gelesen = leseControlling(await antwort.json());
      if (!gelesen.ok) {
        setFehler(gelesen.fehler);
        await laden();
        return;
      }
      setDaten(gelesen.wert);
      setFehler(null);
      setNotiz(erfolg);
    } catch (cause) {
      setFehler(cause instanceof Error ? cause.message : String(cause));
      await laden();
    } finally {
      setBeschaeftigt(false);
    }
  }

  function pauseSetzen(modus: PauseMode) {
    // Decision 2: only the position that costs something asks twice. The
    // sentence names the consequence rather than asking "are you sure", which
    // is a question nobody can answer usefully.
    if (modus === 'hart') {
      const bestaetigt = window.confirm(
        'Harte Pause: laufende Sitzungen bekommen 60 Sekunden und werden dann beendet. ' +
          'Jede betroffene Aufgabe muss danach die Integritätsprüfung bestehen (§7.2). ' +
          'Wirklich anhalten?',
      );
      if (!bestaetigt) return;
    }
    void senden(CONTROLLING_API.pause, { modus }, 'Gespeichert.', (vorher) => ({
      controlling: { ...vorher.controlling, pause: { modus, unlesbar: false } },
    }));
  }

  if (fehler && !daten) {
    return (
      <section className="karte">
        <h2>Controlling</h2>
        <p role="alert" data-testid="controlling-fehler" className="streifen" data-ton="fehler">
          {fehler}
        </p>
      </section>
    );
  }

  if (!daten) {
    return (
      <section className="karte">
        <h2>Controlling</h2>
        <p data-testid="controlling-laden" className="leise">
          Wird geladen…
        </p>
      </section>
    );
  }

  const c = daten.controlling;
  const jetzt = Date.now();
  const reihen = verlaufReihen(c.verlauf);
  const spanne = verlaufSpanne(c.verlauf);

  return (
    <section className="karte">
      <h2>Controlling</h2>

      {fehler && (
        <p role="alert" data-testid="controlling-fehler" className="streifen" data-ton="fehler">
          {fehler}
        </p>
      )}

      <p data-testid="controlling-kopfzeile" className="blase" data-zustand={c.waechter.state}>
        <strong>{kopfzeile(c)}</strong>
      </p>
      <p data-testid="controlling-waechter" className="leise">
        Wächter: {c.waechter.state} · Aufräumen ab {c.schwellen.wrapUpPercent} %, Stopp ab{' '}
        {c.schwellen.hardStopPercent} % · bei geschätzten Zahlen schon ab{' '}
        {c.schwellen.degradedWrapUpPercent} %
      </p>

      <h3>Auslastung</h3>
      {c.fenster.length === 0 ? (
        <p data-testid="controlling-keine-fenster" className="leerstand">
          Es liegt keine Messung vor. Der Wächter hält deshalb an, statt weiterzumachen — eine
          unlesbare Anzeige ist kein freies Budget (§7.1).
        </p>
      ) : (
        /*
          Dieselben Kennzahlen wie auf der Übersicht, aus demselben Baustein:
          es ist dieselbe Aussage über dasselbe Fenster, und zwei Gestaltungen
          dafür wären zwei Stellen, die sich später widersprechen.

          Der Balken zeichnet **nur** bei einer Messung — ein Fenster der Stufe
          „Keine Messung" bekommt kein `data-balken`, weil ein halb gefüllter
          Balken eine beruhigende Aussage über eine Zahl wäre, die es nicht
          gibt. Bewusst **keine** verschachtelte Liste hier: ein Browserfall
          zählt jedes `li` unterhalb dieses Behälters und verlangt von jedem das
          Vertrauensetikett.
        */
        <ul data-testid="controlling-fenster" className="kennzahlen">
          {fensterReihenfolge(c.fenster).map((fenster) => {
            const rest = restzeit(fenster.resetsAt, jetzt);
            const key = `${fenster.window}:${fenster.modelClass ?? ''}`;
            const messbar = fenster.vertrauen.stufe !== 'blind';
            return (
              <li
                key={key}
                data-testid={`controlling-fenster-${key}`}
                data-ton={fensterTon(fenster, c.schwellen)}
                data-balken={messbar ? '' : undefined}
                style={
                  messbar
                    ? ({
                        '--fuellung': Math.min(100, Math.max(0, fenster.usedPercent)).toFixed(1),
                      } as CSSProperties)
                    : undefined
                }
              >
                <span className="etikett">{fensterTitel(fenster)}</span>{' '}
                {/* Never behind a tooltip: A73 means most of these numbers are
                    estimates, and an estimate that reads like a measurement is
                    the one defect this page must not have. Die Plakette
                    unterscheidet die vier Stufen zusätzlich in der Strichart —
                    gemessen ist gefüllt, geschätzt ist gestrichelt —, damit die
                    Unterscheidung nicht an einem Farbton hängt. */}
                <span
                  data-testid={`controlling-vertrauen-${key}`}
                  className="plakette"
                  data-vertrauen={fenster.vertrauen.stufe}
                >
                  [{vertrauensEtikett(fenster.vertrauen.stufe)}]
                </span>
                <strong>{prozent(fenster.usedPercent)}</strong>
                <small>{fenster.vertrauen.satz}</small>
                {rest && <small>{rest}</small>}
              </li>
            );
          })}
        </ul>
      )}

      <h3>Verlauf (24 Stunden)</h3>
      {reihen.length === 0 || !spanne ? (
        <p data-testid="controlling-kein-verlauf" className="leerstand">
          Noch keine Messwerte aufgezeichnet.
        </p>
      ) : (
        <ul data-testid="controlling-verlauf" className="liste">
          {reihen.map((reihe) => {
            const key = `${reihe.window}:${reihe.modelClass ?? ''}`;
            const pfad = verlaufPfad(reihe.punkte, DIAGRAMM, spanne);
            return (
              <li key={key} data-testid={`controlling-verlauf-${key}`}>
                <span className="etikett">{fensterTitel(reihe)}</span> · {reihe.punkte.length}{' '}
                Messwerte
                <br />
                {pfad ? (
                  // `.tafel` setzt die Textfarbe, und die Kurve zeichnet mit
                  // `currentColor` — die Farbe steht damit im System statt in
                  // dieser Datei.
                  <svg
                    className="tafel"
                    width={DIAGRAMM.breite}
                    height={DIAGRAMM.hoehe}
                    role="img"
                    aria-label={`Verlauf ${fensterTitel(reihe)}, 0 bis 100 Prozent`}
                  >
                    <title>{`Verlauf ${fensterTitel(reihe)}`}</title>
                    <polyline points={pfad} fill="none" stroke="currentColor" strokeWidth="2" />
                  </svg>
                ) : (
                  <small>Ein einzelner Messwert ergibt noch keinen Verlauf.</small>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <h3>Pause</h3>
      <p>
        A26 gibt dir zwei Stellungen neben dem Normalbetrieb. Der Wächter (§7.2) entscheidet
        weiterhin selbst nach dem Budget — diese Schalter kommen dazu, sie ersetzen ihn nicht.
      </p>
      {c.pause.unlesbar && (
        <p
          role="alert"
          data-testid="controlling-pause-unlesbar"
          className="streifen"
          data-ton="fehler"
        >
          Die gespeicherte Stellung ist nicht lesbar. Das Studio bleibt vorsichtshalber angehalten,
          bis du sie neu setzt.
        </p>
      )}
      <fieldset data-testid="controlling-pause">
        <legend>Stellung</legend>
        {PAUSE_MODES.map((kandidat) => (
          <p
            key={kandidat}
            className="wahl"
            data-gewaehlt={c.pause.modus === kandidat ? '' : undefined}
          >
            <label>
              <input
                type="radio"
                name="controlling-pause"
                value={kandidat}
                checked={c.pause.modus === kandidat}
                disabled={beschaeftigt}
                onChange={() => pauseSetzen(kandidat)}
                data-testid={`controlling-pause-${kandidat}`}
              />{' '}
              {PAUSE_MODE_LABELS[kandidat]}
            </label>
            <br />
            <small>{PAUSE_MODE_DESCRIPTIONS[kandidat]}</small>
          </p>
        ))}
      </fieldset>

      <h3>Sparbetrieb</h3>
      <p>
        A22s Notprofil. Es ist keine Sicherheitseinrichtung — das Budget begrenzt der Wächter
        unabhängig davon. Was der Schalter tut, steht darunter, und ebenso, was er heute noch nicht
        erreicht.
      </p>
      {c.sparbetrieb.unlesbar && (
        <p
          role="alert"
          data-testid="controlling-sparbetrieb-unlesbar"
          className="streifen"
          data-ton="warnung"
        >
          Die gespeicherte Stellung ist nicht lesbar; es gilt „aus".
        </p>
      )}
      <p className="wahl" data-gewaehlt={c.sparbetrieb.aktiv ? '' : undefined}>
        <label>
          <input
            type="checkbox"
            checked={c.sparbetrieb.aktiv}
            disabled={beschaeftigt}
            onChange={(event) => {
              const aktiv = event.target.checked;
              void senden(CONTROLLING_API.sparbetrieb, { aktiv }, 'Gespeichert.', (vorher) => ({
                controlling: {
                  ...vorher.controlling,
                  sparbetrieb: { ...vorher.controlling.sparbetrieb, aktiv, unlesbar: false },
                },
              }));
            }}
            data-testid="controlling-sparbetrieb"
          />{' '}
          Sparbetrieb einschalten
        </label>
      </p>
      {/*
        Jede Wirkung mit ihrem Stand, und der Stand ist eine Plakette: „Noch
        nicht verdrahtet" ist die Aussage, die diese Liste überhaupt trägt (drei
        von A22s vier Wirkungen haben keinen Leser), und sie darf nicht als
        Kleingedrucktes unter dem Satz verschwinden, den sie einschränkt.
      */}
      <ul data-testid="controlling-wirkungen" className="liste">
        {c.sparbetrieb.wirkungen.map((wirkung) => (
          <li key={wirkung.id} data-testid={`controlling-wirkung-${wirkung.id}`}>
            <span className="plakette" data-ton={wirkung.wirksam ? 'ok' : 'warnung'}>
              {wirkung.wirksam ? 'Verdrahtet' : 'Noch nicht verdrahtet'}
            </span>{' '}
            {wirkung.text}
            <br />
            <small>
              {wirkung.verdrahtung}
              {wirkung.offen && ` — ${wirkung.offen}`}
            </small>
          </li>
        ))}
      </ul>

      <h4>Modellstufen im Sparbetrieb</h4>
      <p>
        Errechnet aus der Regel selbst, nicht abgeschrieben: die Reviewerin bleibt nach A22 auf der
        stärksten Stufe, die Betriebsprüfung nach §8.2 Regel 3 ebenfalls — bei ihr sinkt stattdessen
        die Häufigkeit.
      </p>
      <ul data-testid="controlling-stufen" className="liste">
        {c.sparbetrieb.stufen.map((zeile) => (
          <li key={zeile.profileId} data-testid={`controlling-stufe-${zeile.profileId}`}>
            <span className="etikett">{zeile.department}</span> ({zeile.profileId}): {zeile.normal}{' '}
            → {zeile.sparbetrieb}
          </li>
        ))}
      </ul>

      <h3>Betrieb</h3>
      <p data-testid="controlling-betrieb">
        Tarifprofil {c.betrieb.planProfile} · Nebenläufigkeit {c.betrieb.concurrency} (zulässig{' '}
        {c.betrieb.concurrencyRange.min}–{c.betrieb.concurrencyRange.max})
      </p>
      <p>
        <small>
          Nebenläufigkeit und Modellzuordnung sind hier zur Ansicht. Sie über die Oberfläche zu
          ändern ist noch nicht gebaut — der Ablaufplaner liest beide beim Start.
        </small>
      </p>

      {notiz && (
        <p data-testid="controlling-notiz" className="streifen" data-ton="hinweis">
          {notiz}
        </p>
      )}
    </section>
  );
}
