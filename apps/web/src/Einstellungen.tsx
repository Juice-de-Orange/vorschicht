/**
 * §17.9's settings page — today §8's persona switch and the roster it governs.
 *
 * Every rule this page follows lives elsewhere and is tested there:
 * `@vorschicht/shared/personas` decides what the three modes mean and what a
 * desk is called under each, `./einstellungen-format.ts` composes the line and
 * parses the payload. This file renders.
 *
 * Two things about the arrangement are deliberate.
 *
 *  1. **The roster is on the same page as the switch, and re-renders with it.**
 *     Moving the switch to `Aus` changes seventeen names into seventeen role
 *     labels in front of the operator, without a round trip and without a save button he
 *     has to trust. A settings page that described the effect in a sentence
 *     would be asking him to imagine it — and §8's third state is the one whose
 *     whole substance is what the interface looks like afterwards.
 *
 *  2. **The server's answer replaces the local state, never the submission.**
 *     `setPersonaMode` returns the whole payload for exactly this: the page
 *     redraws from what was stored, so a refusal or a stale write shows as
 *     itself instead of as a mode the page believes it is in.
 */
import { useCallback, useEffect, useState } from 'react';
import {
  EINSTELLUNGEN_API,
  type EinstellungenSeite,
  gateKlassen,
  gesetztText,
  komponenteZeile,
  leseEinstellungen,
  leseEinstellungenSeite,
  mailZustand,
  PERSONA_MODE_DESCRIPTIONS,
  PERSONA_MODE_LABELS,
  PERSONA_MODES,
  type PersonaMode,
  personaWirkung,
  personaZeile,
  protokollWert,
  protokollZeile,
} from './einstellungen-format.js';

export function Einstellungen() {
  const [daten, setDaten] = useState<EinstellungenSeite | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [beschaeftigt, setBeschaeftigt] = useState(false);
  const [notiz, setNotiz] = useState<string | null>(null);

  const laden = useCallback(async () => {
    try {
      const antwort = await fetch(EINSTELLUNGEN_API.seite, { credentials: 'same-origin' });
      if (!antwort.ok) {
        setFehler(`Serverfehler ${antwort.status}`);
        return;
      }
      const gelesen = leseEinstellungenSeite(await antwort.json());
      if (!gelesen.ok) {
        setFehler(gelesen.fehler);
        return;
      }
      setDaten(gelesen.wert.einstellungen);
      setFehler(null);
    } catch (cause) {
      setFehler(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void laden();
  }, [laden]);

  async function speichern(mode: PersonaMode) {
    setBeschaeftigt(true);
    setNotiz(null);
    // Move the switch now, reconcile with the server below.
    //
    // Not a flourish: a radio whose `checked` comes only from the server does
    // not move under the pointer until a round trip finishes, so the control
    // reads as broken — and the roster below it, which is the whole visible
    // substance of §8's third state, would redraw a beat later than the click
    // that asked for it. Every exit below either replaces this with what was
    // stored or re-reads the server, so an optimistic value never survives a
    // refusal.
    setDaten((vorher) => (vorher ? { ...vorher, personas: { ...vorher.personas, mode } } : vorher));
    try {
      const antwort = await fetch(EINSTELLUNGEN_API.personas, {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      if (!antwort.ok) {
        const koerper = (await antwort.json().catch(() => null)) as { errors?: string[] } | null;
        setFehler(koerper?.errors?.join(' ') ?? `Serverfehler ${antwort.status}`);
        // Undo the optimistic move by re-reading, never by remembering what it
        // was: what the switch should show is what is stored, and this page has
        // just demonstrated that its idea of that can be wrong.
        await laden();
        return;
      }
      const gelesen = leseEinstellungen(await antwort.json());
      if (!gelesen.ok) {
        setFehler(gelesen.fehler);
        await laden();
        return;
      }
      // Decision 2: what the server stored, not what we sent.
      //
      // Der PUT antwortet mit **dem Persona-Ausschnitt**, nicht mit der ganzen
      // Seite: der Schalter ändert nur ihn, und eine zweite Antwort, die auch
      // §18s Sicherungsstand und §19s Protokoll mitschickt, wäre eine zweite
      // Erzeugung derselben Seite — zwei Dokumente, die auseinanderlaufen
      // können (A81). Also wird der Ausschnitt eingefügt.
      setDaten((vorher) => (vorher ? { ...vorher, personas: gelesen.wert.personas } : vorher));
      setFehler(null);
      setNotiz('Gespeichert.');
    } catch (cause) {
      setFehler(cause instanceof Error ? cause.message : String(cause));
      await laden();
    } finally {
      setBeschaeftigt(false);
    }
  }

  if (fehler && !daten) {
    return (
      <section className="karte">
        <h2>Einstellungen</h2>
        <p role="alert" data-testid="einstellungen-fehler" className="streifen" data-ton="fehler">
          {fehler}
        </p>
      </section>
    );
  }

  if (!daten) {
    return (
      <section className="karte">
        <h2>Einstellungen</h2>
        <p data-testid="einstellungen-laden" className="leise">
          Wird geladen…
        </p>
      </section>
    );
  }

  const mode = daten.personas.mode;

  return (
    <section className="karte">
      <h2>Einstellungen</h2>

      {fehler && (
        <p role="alert" data-testid="einstellungen-fehler" className="streifen" data-ton="fehler">
          {fehler}
        </p>
      )}

      <h3>Personas</h3>
      <p>
        §8 gibt dem Studio Namen und Schreibtische. Sie sind Anzeige — auf die Arbeit wirken sie
        erst auf der letzten Stufe, und auch dort nur als ein vorangestellter Satz über den
        Charakter der Rolle. Der Auftrag selbst bleibt in jeder Stufe unverändert.
      </p>

      <fieldset data-testid="persona-stufen">
        <legend>Stufe</legend>
        {/*
          `data-gewaehlt` markiert die stehende Stellung ein zweites Mal — über
          den Papierton und die breitere Kante, nicht über Farbe. Es ist
          dieselbe Größe, die den Knopf füllt, also kann es nicht auseinander
          laufen.
        */}
        {PERSONA_MODES.map((kandidat) => (
          <p key={kandidat} className="wahl" data-gewaehlt={mode === kandidat ? '' : undefined}>
            <label>
              <input
                type="radio"
                name="persona-mode"
                value={kandidat}
                checked={mode === kandidat}
                disabled={beschaeftigt}
                onChange={() => void speichern(kandidat)}
                data-testid={`persona-stufe-${kandidat}`}
              />{' '}
              {PERSONA_MODE_LABELS[kandidat]}
            </label>
            <br />
            <small>{PERSONA_MODE_DESCRIPTIONS[kandidat]}</small>
          </p>
        ))}
      </fieldset>

      <p data-testid="persona-wirkung" className="blase">
        {personaWirkung(mode)}
      </p>
      {notiz && (
        <p data-testid="einstellungen-notiz" className="streifen" data-ton="hinweis">
          {notiz}
        </p>
      )}

      <h3>Das Studio</h3>
      <p>
        So heißen die Schreibtische mit der gewählten Stufe. Auf „Aus" stehen hier
        Rollenbezeichnungen statt Namen.
      </p>
      <ul data-testid="persona-liste" className="liste">
        {daten.personas.roster.map((persona) => (
          <li key={persona.id} data-testid={`persona-${persona.id}`}>
            <strong>{personaZeile(mode, persona)}</strong> ·{' '}
            <span className="etikett">{persona.department}</span>
          </li>
        ))}
      </ul>

      {/*
        §18s Sicherungsstand. Dieselbe Kachel wie auf der Übersicht — eine
        Ableitung, zwei Leser — plus die Einzelheiten, die auf eine Kachel nicht
        passen. A103: der Ausfall war ein *partieller*, und „die Sicherung ist
        fehlgeschlagen" hätte die eine Tatsache verborgen, auf die es ankam.
      */}
      <h3>Sicherung</h3>
      <p data-testid="sicherung-kachel" className="blase" data-ton={daten.sicherung.kachel.state}>
        <strong>{daten.sicherung.kachel.label}</strong> — {daten.sicherung.kachel.detail}
      </p>
      {daten.sicherung.komponenten.length === 0 ? (
        <p data-testid="sicherung-ohne-meldung" className="leise">
          Es liegt noch keine Meldung eines nächtlichen Laufs vor (§18, A14).
        </p>
      ) : (
        <ul data-testid="sicherung-komponenten" className="liste">
          {daten.sicherung.komponenten.map((komponente) => (
            <li key={komponente.id} data-testid={`sicherung-${komponente.id}`}>
              {komponenteZeile(komponente)}
            </li>
          ))}
        </ul>
      )}
      {daten.sicherung.problem && (
        <p data-testid="sicherung-problem" className="streifen" data-ton="fehler">
          {daten.sicherung.problem}
        </p>
      )}

      {/*
        §16s Kanäle, lesbar und nicht änderbar — sie kommen aus der Umgebung und
        werden beim Start gelesen. Der Nutzen ist konkret: bis hierher konnte
        niemand nachsehen, an welches ntfy-Thema ein Ausfallalarm überhaupt
        geht, und A86 hat gezeigt, was ein Kanal kostet, den niemand prüfen kann.
      */}
      <h3>Benachrichtigungen</h3>
      <p className="leise">
        Diese Werte kommen aus der Umgebung (<code>.env</code> auf dem Host) und werden beim Start
        gelesen — sie sind hier absichtlich nicht änderbar. Ruhezeiten gibt es keine: §16 meldet
        rund um die Uhr.
      </p>
      <ul data-testid="benachrichtigungen" className="liste">
        <li data-testid="kanal-ntfy">
          <strong>ntfy</strong> — {daten.benachrichtigungen.ntfy.server} · Posteingang „
          {daten.benachrichtigungen.ntfy.themen.inbox}" · Alarme „
          {daten.benachrichtigungen.ntfy.themen.alerts}" · Hinweise „
          {daten.benachrichtigungen.ntfy.themen.info}" · Token{' '}
          {gesetztText(daten.benachrichtigungen.ntfy.tokenGesetzt)}
        </li>
        <li data-testid="kanal-mail">
          <strong>E-Mail</strong> — {mailZustand(daten.benachrichtigungen.mail)} · Passwort{' '}
          {gesetztText(daten.benachrichtigungen.mail.passwortGesetzt)}
        </li>
      </ul>

      {/*
        §17.9s Tarifprofil. Aus derselben Konstante gelesen, aus der auch der
        Ablaufplaner seine Nebenläufigkeit nimmt (A7) — eine Zahl, die zweimal
        hergeleitet wird, stimmt so lange, bis jemand eine der beiden ändert.
      */}
      <h3>Tarifprofil</h3>
      <p data-testid="tarifprofil">
        {daten.betrieb.planProfile} · {daten.betrieb.concurrency} parallele Sitzungen (A7;
        einstellbar {daten.betrieb.concurrencyRange.min}–{daten.betrieb.concurrencyRange.max} im
        Controlling)
      </p>

      {/*
        §11s Katalog. Rein clientseitig: `GATE_CATALOGUE` ist browser-seitig
        importierbar, und ein Server, der diese Tabelle schickte, wäre eine
        zweite Deklaration derselben Liste (A75.5).
      */}
      <h3>Gate-Katalog</h3>
      {gateKlassen().map((klasse) => (
        <section key={klasse.id} data-testid={`gate-klasse-${klasse.id}`}>
          <h4>
            {klasse.titel} ({klasse.gates.length})
          </h4>
          <p className="leise">{klasse.erklaerung}</p>
          <ul className="liste">
            {klasse.gates.map((gate) => (
              <li key={gate.id} data-testid={`katalog-${gate.id}`}>
                <strong>{gate.label}</strong> — {gate.description}
                {gate.availableFrom ? ` (${gate.availableFrom})` : ''}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {/*
        §19s Prüfprotokoll. Gedeckelt, und die Grenze steht daneben: §19 hebt
        die Tabelle für immer auf, und eine gedeckelte Liste, die das nicht
        sagt, liest sich als vollständige Antwort.
      */}
      <h3>Prüfprotokoll</h3>
      <p className="leise">
        Die jüngsten {daten.pruefprotokoll.limit} Einträge aus <code>audit_log</code> (§19). Die
        Tabelle selbst wird nie gelöscht — hier steht nur ein Ausschnitt.
      </p>
      {daten.pruefprotokoll.eintraege.length === 0 ? (
        <p data-testid="pruefprotokoll-leer" className="leise">
          Noch nichts protokolliert.
        </p>
      ) : (
        // Rollbar, also mit der Tastatur erreichbar und benannt — siehe die
        // Begründung am gleichnamigen Element in `Overview.tsx`.
        <ul
          data-testid="pruefprotokoll"
          className="protokoll"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: axe verlangt für einen rollbaren Bereich genau das (scrollable-region-focusable, WCAG 2.1.1); die Listensemantik bleibt erhalten, anders als bei role="region"
          tabIndex={0}
          aria-label="Prüfprotokoll"
        >
          {daten.pruefprotokoll.eintraege.map((eintrag) => {
            const vorher = protokollWert(eintrag.before);
            const nachher = protokollWert(eintrag.after);
            return (
              <li key={eintrag.id} data-testid={`protokoll-${eintrag.id}`}>
                {new Date(eintrag.occurredAt).toLocaleString('de-AT')} · {protokollZeile(eintrag)}
                {/*
                  Als Text, nie als Markup: diese Werte stammen aus fremden
                  Diensten und werden hier nur wiedergegeben (`spurEreignis`,
                  Entscheidung 5, eine Seite weiter).
                */}
                {vorher !== null && <div className="leise">vorher: {vorher}</div>}
                {nachher !== null && <div className="leise">nachher: {nachher}</div>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
