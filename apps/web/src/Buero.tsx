import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import {
  aufgabenPfad,
  ausgelassenText,
  BUERO_API,
  BUERO_EREIGNISARTEN,
  BUERO_LEER,
  type BueroDesk,
  DESK_STATE_COLORS,
  DESK_STATE_HINTS,
  DESK_STATE_LABELS,
  deskState,
  type Ereignis,
  laufPfad,
  leseBuero,
  type PersonaMode,
  personaAlternates,
  platzBegruendung,
  platzName,
  platzZeile,
  SCHNAPPSCHUSS_MS,
  seitZeile,
  wendeEreignisAn,
} from './buero-format.js';
import './buero.css';
import { personaLook } from './buero-pixel.js';
import { Fenster, Pflanze, Szene, Uhr } from './buero-szene.js';
import { POSTEINGANG_PFAD } from './inbox-format.js';

/**
 * The office (§17.2) — an actual room.
 *
 * §17.2 asks for "desks/avatars for every active persona … built as a
 * lightweight SVG/DOM scene (no heavy engine)", and the operator asked for it to look
 * like something: **„verpixelter Office Style, gemütlich und gut leserlich."**
 * The first build of this page answered the machinery and not the picture — a
 * grid of cards with a coloured circle on each — and his verdict was that he
 * saw no visualisation at all. So: a wall with a window and a clock, a plank
 * floor, and a desk drawn in half-perspective for every colleague who is at
 * something, each with a nameplate under it.
 *
 * **This component still decides nothing.** Which chair is occupied is
 * `apps/server/src/buero.ts`, what its bubble is is `deskState`, what it is
 * called is `personaLabel`, what a frame does to it is `wendeEreignisAn`, and
 * what any of it *looks* like is `buero-pixel.ts` — all of them somewhere a
 * test without a browser can reach, because `apps/web` has no DOM test
 * environment (`einstellungen-format.ts`). What is left here is two effects and
 * some markup: the snapshot with its slow backstop, and the stream.
 *
 * **A list of buttons with a scene inside each, rather than one `<svg>` room.**
 * The floor plan is CSS grid, so every desk stays a real focusable control with
 * a real accessible name and the pixels inside it are `aria-hidden` decoration.
 * §22's Phase 7 has an axe gate over every page here, and a room painted as one
 * big canvas or one big SVG would answer it with a single unlabelled graphic —
 * plus a click layer, a focus order and a set of names all invented by hand and
 * checked by nothing.
 *
 * **Never a colour alone.** Every desk carries its German word, and the bubble
 * above it differs in outline *and* glyph before it differs in hue —
 * `buero-pixel.test.ts` asserts that with the colour taken away. A room that
 * can only be read by hue answers nothing at a glance for the roughly one man
 * in twelve who does not see hue.
 *
 * **The empty room is the view the operator sees most.** With the guardian latched there
 * is nobody at any desk, so "nothing is running" had to look like a room after
 * hours rather than like a page that failed to load: the same furniture, the
 * lights down, the window gone to evening, and a sentence saying where the
 * reason lives.
 */

/** Stable across renders, so a `data-testid` is derivable from a task. */
function testId(desk: BueroDesk): string {
  return `platz-${desk.profileId}-${desk.taskId ?? 'ohne'}`;
}

export function Buero() {
  const [desks, setDesks] = useState<BueroDesk[]>([]);
  const [personaMode, setPersonaMode] = useState<PersonaMode>('anzeige');
  const [omitted, setOmitted] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [geladen, setGeladen] = useState(false);
  const [live, setLive] = useState(false);
  const [gewaehlt, setGewaehlt] = useState<string | null>(null);
  /**
   * Latest desks, for the stream's effect.
   *
   * The `EventSource` is opened once and its handler closes over whatever it saw
   * at that moment. Re-opening the stream on every desk change would reconnect
   * several times a second under load and re-replay the backlog each time; a ref
   * keeps one connection and still lets the handler patch the current room.
   */
  const raum = useRef<BueroDesk[]>([]);

  const uebernehmen = useCallback((naechste: BueroDesk[]) => {
    raum.current = naechste;
    setDesks(naechste);
  }, []);

  const laden = useCallback(async () => {
    try {
      const response = await fetch(BUERO_API.buero, { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`Serverfehler ${response.status}`);
      const gelesen = leseBuero(await response.json());
      if (!gelesen.ok) {
        setError(gelesen.fehler);
        return;
      }
      uebernehmen(gelesen.wert.desks);
      setPersonaMode(gelesen.wert.personaMode);
      setOmitted(gelesen.wert.omitted);
      setError(null);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setGeladen(true);
    }
  }, [uebernehmen]);

  useEffect(() => {
    void laden();
    // The backstop, and deliberately slow (`SCHNAPPSCHUSS_MS`): it exists for
    // what the stream cannot express, not for what it can. A page that polled
    // quickly would meet §22's "< 1s end-to-end" with the stream switched off,
    // and then the measurement would be about the poll.
    const timer = setInterval(() => void laden(), SCHNAPPSCHUSS_MS);
    return () => clearInterval(timer);
  }, [laden]);

  /**
   * The live path — and the one thing about it that is not obvious.
   *
   * **`addEventListener` per kind, never `onmessage`.** `formatEvent` writes
   * `event: <kind>` on every frame it sends, and `EventSource.onmessage` fires
   * only for frames whose type is the default `message`. So an office wired to
   * `onmessage` receives **nothing at all** — which is exactly how this was
   * found: the first browser run reported "Live verbunden." and then timed out
   * waiting for a park that had certainly been written. A stream that connects
   * and delivers nothing looks, from the page, precisely like a studio in which
   * nothing happened.
   *
   * Naming the kinds also means the room is woken only by frames it can use,
   * rather than re-entering the reducer for every gate result and usage sample
   * the studio produces.
   */
  useEffect(() => {
    const source = new EventSource('/events');
    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);

    const auf = (event: MessageEvent<string>) => {
      let frame: Ereignis;
      try {
        frame = JSON.parse(event.data) as Ereignis;
      } catch {
        // A frame we cannot read is not worth emptying the room over.
        return;
      }
      const aenderung = wendeEreignisAn(raum.current, frame);
      // Same array object means nothing matched — the reducer is asked about
      // frames it has no desk for too, and re-rendering on those would make the
      // page's cost a function of the whole studio's throughput.
      if (aenderung.desks !== raum.current) uebernehmen(aenderung.desks);
      // The one thing a frame cannot carry: a task's title. A colleague the room
      // has never seen therefore costs a snapshot — and nothing else does.
      if (aenderung.brauchtSchnappschuss) void laden();
    };

    for (const art of BUERO_EREIGNISARTEN) source.addEventListener(art, auf as EventListener);
    return () => {
      for (const art of BUERO_EREIGNISARTEN) source.removeEventListener(art, auf as EventListener);
      source.close();
    };
  }, [laden, uebernehmen]);

  const gewaehlterPlatz = desks.find((desk) => desk.seatId === gewaehlt) ?? null;
  const ausgelassen = ausgelassenText(omitted);

  return (
    <section>
      <h2>Büro</h2>

      {error && (
        <p role="alert" data-testid="buero-fehler">
          Büro nicht ladbar: {error}
        </p>
      )}

      <p data-testid="buero-verbindung">{live ? 'Live verbunden.' : 'Nicht verbunden.'}</p>

      {!geladen ? (
        <p>Wird geladen…</p>
      ) : (
        <Raum feierabend={desks.length === 0}>
          {desks.length === 0 ? (
            <Feierabend />
          ) : (
            <ul className="px-plaetze" data-testid="buero-raum">
              {desks.map((desk) => (
                <Schreibtisch
                  key={desk.seatId}
                  desk={desk}
                  mode={personaMode}
                  gewaehlt={desk.seatId === gewaehlt}
                  onWahl={() => setGewaehlt(desk.seatId === gewaehlt ? null : desk.seatId)}
                />
              ))}
            </ul>
          )}
        </Raum>
      )}

      {ausgelassen && <p data-testid="buero-ausgelassen">{ausgelassen}</p>}

      {gewaehlterPlatz && <Detail desk={gewaehlterPlatz} mode={personaMode} />}
    </section>
  );
}

/**
 * Wall, floor, and whatever is standing on the floor.
 *
 * The wall is what makes the difference between a room and a grid: a band of
 * papered wall with a window, a clock and a plant in the corner, then the
 * skirting board, then planks. All three are `aria-hidden` — they say nothing,
 * and an office that made a screen reader listen to its houseplant would be
 * worse than one with no plant.
 */
function Raum({ feierabend, children }: { feierabend: boolean; children: ReactNode }) {
  return (
    <div className={feierabend ? 'px-buero px-buero--feierabend' : 'px-buero'}>
      <div className="px-wand" aria-hidden="true">
        <Fenster abend={feierabend} />
        <Uhr />
        <Pflanze />
      </div>
      <div className="px-boden">{children}</div>
    </div>
  );
}

/**
 * Nobody here — drawn as an office after hours rather than as an absence.
 *
 * This is the state the operator opens the page in for as long as the guardian holds, so
 * it is the one that had to be a picture and not a blank. Three empty desks
 * (the same scene with the person and the bubble left out, so the two rooms
 * cannot drift apart), the lights down by a variable, the window gone to
 * evening — and then the sentence, because a quiet office and a broken page
 * look identical without one.
 *
 * The second line is the half §17.2 does not ask for and a person does: *why*
 * nobody is here is a budget and guardian question, and those live on the
 * overview. A link rather than a duplicated number — this page reads the office
 * and nothing else, and a second reader of the guardian's state would be a
 * second thing that can disagree with it.
 */
function Feierabend() {
  return (
    <>
      <div className="px-moebel" aria-hidden="true">
        <Szene state={null} look={null} id="leer-1" />
        <Szene state={null} look={null} id="leer-2" />
        <Szene state={null} look={null} id="leer-3" />
      </div>
      <div className="px-leer">
        <p data-testid="buero-leer">{BUERO_LEER}</p>
        <p>
          Warum gerade nichts läuft, steht im <a href="/">Überblick</a> — Wächterzustand,
          Budgetfenster und offene Entscheidungen.
        </p>
      </div>
    </>
  );
}

function Schreibtisch({
  desk,
  mode,
  gewaehlt,
  onWahl,
}: {
  desk: BueroDesk;
  mode: PersonaMode;
  gewaehlt: boolean;
  onWahl: () => void;
}) {
  const kugel = deskState(desk);
  const name = platzName(desk, mode);
  const seit = seitZeile(desk);
  return (
    <li>
      <button
        type="button"
        className="px-platz"
        data-testid={testId(desk)}
        // The verdict as an attribute as well as a word: an assertion that reads
        // the bubble should not have to read around a task title that happens to
        // contain the word "blockiert".
        data-kugel={kugel}
        aria-pressed={gewaehlt}
        onClick={onWahl}
        title={DESK_STATE_HINTS[kugel]}
        // The one colour this component decides, and only on the desk that is
        // already selected — everything else lives in `buero.css` where the
        // design system can reach it.
        style={gewaehlt ? { borderColor: DESK_STATE_COLORS[kugel] } : undefined}
      >
        {/*
          The face is derived from the *profile*, not from the seat, so a
          colleague keeps it across a park, a resume and three review rounds.
          §8's neutral mode (A9) switches the name and never the picture: a desk
          with no drawing on it would make "personas off" cost the view rather
          than the theatre.
        */}
        <Szene state={kugel} look={personaLook(desk.profileId)} id={desk.seatId} />
        <span className="px-schild">
          <strong className="px-name" data-testid={`${testId(desk)}-name`}>
            {name}
          </strong>
          <small className="px-abteilung">{desk.department}</small>
          {/* The word, always — the bubble above is the second and third channel. */}
          <span className="px-zeile" data-testid={`${testId(desk)}-zeile`}>
            {platzZeile(desk)}
          </span>
          {seit && <small className="px-seit">{seit}</small>}
        </span>
      </button>
    </li>
  );
}

/**
 * §17.2's click-through — "their current task **and trace**".
 *
 * Both halves now, and the second one is a link and nothing more. The trace
 * explorer is Phase 7 step 3, built in parallel; this panel points at its routes
 * without importing a line of it, so the office does not wait on that page and
 * does not break when it changes shape. `aufgabenPfad`/`laufPfad` carry the
 * whole arrangement and the A81.3 risk it accepts.
 *
 * The run link is the one §22's drill-down gate actually needs — the transcript
 * hangs off the session, not off the task — so it is offered whenever there is a
 * run at all, finished ones included. A desk whose session ended is precisely
 * the one somebody wants to read afterwards.
 */
function Detail({ desk, mode }: { desk: BueroDesk; mode: PersonaMode }) {
  const kugel = deskState(desk);
  const weitere = personaAlternates(mode, { name: desk.name, desk: desk.desk });
  return (
    <section data-testid="buero-detail">
      <h3>
        {platzName(desk, mode)} — {DESK_STATE_LABELS[kugel]}
      </h3>
      <p data-testid="buero-detail-begruendung">{platzBegruendung(desk)}</p>
      <dl>
        <dt>Abteilung</dt>
        <dd>{desk.department}</dd>
        <dt>Aufgabe</dt>
        <dd data-testid="buero-detail-aufgabe">
          {desk.taskTitle ?? 'Diese Sitzung dient keiner Aufgabe.'}
        </dd>
        <dt>Projekt</dt>
        <dd>{desk.projectSlug ?? '—'}</dd>
        <dt>Sitzung</dt>
        <dd data-testid="buero-detail-lauf">
          {desk.runId ?? '—'} {desk.runLive ? '(läuft)' : '(beendet)'}
        </dd>
        {weitere.length > 0 && (
          <>
            <dt>Weitere Namen dieses Profils</dt>
            <dd>{weitere.join(', ')}</dd>
          </>
        )}
      </dl>
      <p>
        {desk.taskId && (
          <>
            <a href={aufgabenPfad(desk.taskId)} data-testid="buero-detail-aufgabe-link">
              Zur Aufgabe und ihrer Spur
            </a>{' '}
          </>
        )}
        {desk.runId && (
          <a href={laufPfad(desk.runId)} data-testid="buero-detail-lauf-link">
            Zur Sitzung und ihrem Transkript
          </a>
        )}
      </p>
      {kugel === 'eskaliert' && (
        <p>
          {/*
            Ohne Nummer kein Tiefenlink: §15s „#X" kommt aus einer Sequenz, und
            eine geratene Nummer führt auf eine fremde Karte. Der Posteingang
            selbst ist die ehrliche Adresse.
          */}
          <a href={POSTEINGANG_PFAD} data-testid="buero-detail-posteingang">
            Zum Posteingang
          </a>
        </p>
      )}
    </section>
  );
}
