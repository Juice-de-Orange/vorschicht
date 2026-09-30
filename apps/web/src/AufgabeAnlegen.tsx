import {
  AUFGABE_ANFANGSZUSTAENDE,
  AUFGABE_ANFANGSZUSTAND_LABEL,
  type AufgabeAngelegt,
  type AufgabeProjektwahl,
  PRIORITIES,
} from '@vorschicht/shared/aufgaben';
import { useCallback, useEffect, useState } from 'react';

/**
 * The form that puts work into the studio (§17.4).
 *
 * It lives inside the task list rather than on a page of its own: `/aufgaben`
 * already exists and already lists tasks, and a second page about the same
 * object would make "where do I look" a question. Folded into a `<details>` so
 * the list stays the page's subject — creating a task is the rarer act.
 *
 * Three decisions the markup carries:
 *
 *  1. **The acceptance criteria are one line each in a textarea**, not a
 *     growing list of inputs. §8.1 needs at least one and the route refuses
 *     zero; what it does not need is a widget. One line per criterion is how a
 *     person writes them down anyway, and it cannot get into a state where an
 *     empty row looks like a criterion.
 *  2. **A read-only project stays in the list and says why.** Removing it would
 *     leave the operator wondering where Vorschicht went; disabling it silently would
 *     make the refusal unattackable, which is A62's argument for the locked
 *     gates one page over. It is selectable, and the sentence appears before
 *     anything is submitted.
 *  3. **Every field has a real `<label htmlFor>`.** P7.G4 asserts zero axe
 *     violations *and* zero `incomplete` on twelve pages; a placeholder as a
 *     label is exactly what that finds.
 */

interface Props {
  /** Called after a successful create, so the list behind reloads. */
  readonly onAngelegt: () => void;
}

const LEER = {
  projektId: '',
  titel: '',
  beschreibung: '',
  kriterien: '',
  prioritaet: 'P2' as (typeof PRIORITIES)[number],
  anfangszustand: 'queued' as (typeof AUFGABE_ANFANGSZUSTAENDE)[number],
};

export function AufgabeAnlegen({ onAngelegt }: Props) {
  const [wahl, setWahl] = useState<AufgabeProjektwahl | null>(null);
  const [form, setForm] = useState(LEER);
  const [fehler, setFehler] = useState<readonly string[]>([]);
  const [angelegt, setAngelegt] = useState<AufgabeAngelegt | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let abgebrochen = false;
    void (async () => {
      try {
        const antwort = await fetch('/api/aufgaben/projektwahl');
        if (!antwort.ok) return;
        const koerper = (await antwort.json()) as AufgabeProjektwahl;
        if (!abgebrochen) setWahl(koerper);
      } catch {
        // Die Seite bleibt bedienbar; das Absenden meldet den Fehler dann selbst.
      }
    })();
    return () => {
      abgebrochen = true;
    };
  }, []);

  const projekt = wahl?.projekte.find((p) => p.id === form.projektId);

  const absenden = useCallback(async () => {
    setBusy(true);
    setFehler([]);
    setAngelegt(null);
    try {
      const antwort = await fetch('/api/aufgaben', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          projektId: form.projektId,
          titel: form.titel,
          ...(form.beschreibung.trim() === '' ? {} : { beschreibung: form.beschreibung }),
          akzeptanzkriterien: form.kriterien
            .split('\n')
            .map((zeile) => zeile.trim())
            .filter((zeile) => zeile.length > 0),
          prioritaet: form.prioritaet,
          anfangszustand: form.anfangszustand,
        }),
      });
      const koerper = (await antwort.json().catch(() => null)) as
        | AufgabeAngelegt
        | { errors?: string[] }
        | null;
      if (!antwort.ok) {
        const meldungen =
          koerper !== null && 'errors' in koerper && Array.isArray(koerper.errors)
            ? koerper.errors
            : ['Die Aufgabe konnte nicht angelegt werden.'];
        setFehler(meldungen);
        return;
      }
      setAngelegt(koerper as AufgabeAngelegt);
      setForm({ ...LEER, projektId: form.projektId });
      onAngelegt();
    } catch (grund) {
      setFehler([grund instanceof Error ? grund.message : String(grund)]);
    } finally {
      setBusy(false);
    }
  }, [form, onAngelegt]);

  return (
    <details data-testid="aufgabe-anlegen" className="ausklapp">
      <summary>Neue Aufgabe anlegen</summary>

      <form
        onSubmit={(event) => {
          event.preventDefault();
          void absenden();
        }}
      >
        <p className="feld">
          <label htmlFor="aufgabe-projekt">Projekt</label>
          <select
            id="aufgabe-projekt"
            data-testid="aufgabe-projekt"
            value={form.projektId}
            onChange={(event) => setForm((v) => ({ ...v, projektId: event.target.value }))}
          >
            <option value="">— bitte wählen —</option>
            {(wahl?.projekte ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.readOnly ? ' (nur lesend)' : ''}
              </option>
            ))}
          </select>
        </p>

        {projekt?.readOnly === true && (
          <p data-testid="aufgabe-nur-lesend" className="streifen" data-ton="warnung">
            „{projekt.name}" ist auf nur-lesend gestellt und nimmt keine Arbeit an. Die Aufgabe
            würde für immer in der Warteschlange stehen, weil der Ablaufplaner das Projekt
            überspringt.
          </p>
        )}

        <p className="feld">
          <label htmlFor="aufgabe-titel">Titel</label>
          <input
            id="aufgabe-titel"
            data-testid="aufgabe-titel"
            value={form.titel}
            onChange={(event) => setForm((v) => ({ ...v, titel: event.target.value }))}
          />
        </p>

        <p className="feld">
          <label htmlFor="aufgabe-beschreibung">Beschreibung (optional)</label>
          <textarea
            id="aufgabe-beschreibung"
            data-testid="aufgabe-beschreibung"
            rows={3}
            value={form.beschreibung}
            onChange={(event) => setForm((v) => ({ ...v, beschreibung: event.target.value }))}
          />
        </p>

        <p className="feld">
          <label htmlFor="aufgabe-kriterien">
            Akzeptanzkriterien — eines je Zeile, mindestens eins
          </label>
          <textarea
            id="aufgabe-kriterien"
            data-testid="aufgabe-kriterien"
            rows={4}
            value={form.kriterien}
            onChange={(event) => setForm((v) => ({ ...v, kriterien: event.target.value }))}
          />
        </p>

        <p className="feld">
          <label htmlFor="aufgabe-prioritaet">Priorität</label>
          <select
            id="aufgabe-prioritaet"
            data-testid="aufgabe-prioritaet"
            value={form.prioritaet}
            onChange={(event) =>
              setForm((v) => ({
                ...v,
                prioritaet: event.target.value as (typeof PRIORITIES)[number],
              }))
            }
          >
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </p>

        <p className="feld">
          <label htmlFor="aufgabe-zustand">Was danach passiert</label>
          <select
            id="aufgabe-zustand"
            data-testid="aufgabe-zustand"
            value={form.anfangszustand}
            onChange={(event) =>
              setForm((v) => ({
                ...v,
                anfangszustand: event.target.value as (typeof AUFGABE_ANFANGSZUSTAENDE)[number],
              }))
            }
          >
            {AUFGABE_ANFANGSZUSTAENDE.map((zustand) => (
              <option key={zustand} value={zustand}>
                {AUFGABE_ANFANGSZUSTAND_LABEL[zustand]}
              </option>
            ))}
          </select>
        </p>

        {fehler.length > 0 && (
          <ul data-testid="aufgabe-fehler" role="alert" className="streifen" data-ton="fehler">
            {fehler.map((meldung) => (
              <li key={meldung}>{meldung}</li>
            ))}
          </ul>
        )}

        {angelegt !== null && (
          <p data-testid="aufgabe-angelegt" className="streifen" data-ton="gut">
            Angelegt: <strong>{angelegt.aufgabe.titel}</strong> ({angelegt.aufgabe.prioritaet},{' '}
            {angelegt.aufgabe.zustand}).
          </p>
        )}

        <p className="knopfreihe">
          <button
            type="submit"
            data-testid="aufgabe-absenden"
            className="knopf"
            data-ton="haupt"
            disabled={busy}
          >
            Aufgabe anlegen
          </button>
        </p>
      </form>
    </details>
  );
}
