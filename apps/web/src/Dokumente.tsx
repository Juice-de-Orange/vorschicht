import { type ReactNode, useCallback, useEffect, useMemo, useState } from 'react';
import {
  ALLE_ABTEILUNGEN,
  abteilungsoptionen,
  DATEI_FILTER,
  DOKUMENTE_API,
  DOKUMENTE_PFAD,
  type DocumentDetailView,
  dateitypLabel,
  dokumentDurchsuchbarkeit,
  dokumentKennung,
  dokumentPfad,
  durchsuchbarkeit,
  type Eintrag,
  ERLAUBTE_TYPEN,
  eintraegeAusSuche,
  eintragAusDetail,
  groesse,
  leseDokument,
  leseSuche,
  MAX_UPLOAD_MB,
  passtZurAbteilung,
  sucheUrl,
  suchhinweis,
  uploadFehler,
  uploadPlan,
  zeitpunkt,
  zusammenfuehren,
} from './dokumente-format.js';
import { navigate, segmentAfter, usePath } from './router.js';

/**
 * §13's document vault (§17.6): upload, search, one document in full.
 *
 * Two paths, one component, the arrangement `Posteingang.tsx` already uses:
 * `/dokumente` is the list and `/dokumente/<uuid>` is one document with its
 * whole version history. The second is not a filtered view of the first — it
 * fetches by id, so a link still works when the list has moved on, and it
 * survives a reload because the server serves the app shell for every non-API
 * path.
 *
 * **The list is what this page has seen, and it says so.** There is no
 * "list everything" route and that is not an omission: §13's vault is reached
 * through full-text search, which is the only thing that can rank a corpus of
 * contracts by relevance. So a search *replaces* the list with its hits, an
 * upload *prepends* to it, and the empty state says which of the two has not
 * happened yet. Rows left over from before a search would make "the search
 * found it" true whether or not it did.
 *
 * **A stored document that nobody could read says so on every row.** Extraction
 * covers text and Markdown today; a PDF is stored, listed and counted, and no
 * text comes out of it. Reporting that as an ordinary document would make it
 * silently unfindable — the one failure §13's own search answer is built to
 * avoid, with `nochNichtDurchsuchbar` — so every row carries the state of its
 * text and the search carries the vault's.
 *
 * Every payload is **parsed** through `@vorschicht/shared/dokumente` rather than
 * cast (A81), and the parse lives in `dokumente-format.ts` so that removing it
 * breaks a test rather than only a browser.
 */
export function Dokumente() {
  const path = usePath();
  const segment = segmentAfter(path, DOKUMENTE_PFAD);
  const kennung = dokumentKennung(segment);

  // A segment that is not a usable id is *not* the list page. Showing the whole
  // list for `/dokumente/kaputt` reads as "your document is gone" rather than as
  // "that link is broken" (A81.5).
  if (segment !== null && kennung === null) {
    return (
      <Rahmen>
        <p data-testid="dokument-unbekannt" role="alert" className="streifen" data-ton="fehler">
          „{segment}" ist keine Dokumentenkennung. Ein Dauerlink sieht aus wie
          <code> {DOKUMENTE_PFAD}/11111111-2222-4333-8444-555555555555</code>.
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
      <h2>Dokumente</h2>
      {children}
    </section>
  );
}

function Zurueck() {
  return (
    <p className="knopfreihe">
      <button
        type="button"
        data-testid="zu-den-dokumenten"
        className="knopf"
        onClick={() => navigate(DOKUMENTE_PFAD)}
      >
        Zur Dokumentenliste
      </button>
    </p>
  );
}

// --- the list ----------------------------------------------------------------

function Liste() {
  const [eintraege, setEintraege] = useState<Eintrag[]>([]);
  const [letzteSuche, setLetzteSuche] = useState<string | null>(null);
  const [nichtDurchsucht, setNichtDurchsucht] = useState(0);
  const [suche, setSuche] = useState('');
  const [abteilung, setAbteilung] = useState(ALLE_ABTEILUNGEN);
  const [laden, setLaden] = useState(false);
  const [ladefehler, setLadefehler] = useState<string | null>(null);

  const abteilungen = useMemo(
    () => abteilungsoptionen(eintraege, abteilung),
    [eintraege, abteilung],
  );
  const sichtbar = useMemo(
    () => eintraege.filter((eintrag) => passtZurAbteilung(eintrag, abteilung)),
    [eintraege, abteilung],
  );

  async function suchen() {
    const begriff = suche.trim();
    if (begriff === '') {
      setLadefehler('Die Suche braucht einen Suchbegriff.');
      return;
    }
    setLaden(true);
    setLadefehler(null);
    try {
      const antwort = await fetch(sucheUrl(begriff), { credentials: 'same-origin' });
      if (!antwort.ok) {
        const koerper = await antwort.json().catch(() => null);
        setLadefehler(uploadFehler(antwort.status, koerper).join(' '));
        return;
      }
      const gelesen = leseSuche(await antwort.json());
      if (!gelesen.ok) {
        setLadefehler(gelesen.fehler);
        return;
      }
      // Replaces rather than merges — see the note in the module header.
      setEintraege(eintraegeAusSuche(gelesen.wert));
      setNichtDurchsucht(gelesen.wert.nochNichtDurchsuchbar);
      setLetzteSuche(begriff);
    } catch (grund) {
      setLadefehler(grund instanceof Error ? grund.message : String(grund));
    } finally {
      setLaden(false);
    }
  }

  const hinweis = letzteSuche !== null ? suchhinweis(nichtDurchsucht) : null;

  return (
    <Rahmen>
      <Upload
        onAbgelegt={(detail) =>
          setEintraege((vorher) => zusammenfuehren([eintragAusDetail(detail)], vorher))
        }
      />

      <h3>Suchen (§13)</h3>
      <p>
        Die Volltextsuche liest den ausgelesenen Text der Fassungen, nicht die Dateinamen.
        Ungelesene Dateien können auf keine Suche passen — wie viele es sind, steht unter dem
        Ergebnis.
      </p>
      <p className="werkzeugleiste">
        <span className="feld">
          <label htmlFor="dokumente-suche">Suchbegriff</label>
          <input
            id="dokumente-suche"
            data-testid="dokumente-suche"
            value={suche}
            placeholder="z. B. Kündigung"
            onChange={(ereignis) => setSuche(ereignis.target.value)}
            onKeyDown={(ereignis) => {
              if (ereignis.key === 'Enter') void suchen();
            }}
          />
        </span>
        <button
          type="button"
          data-testid="dokumente-suchen"
          className="knopf"
          data-ton="haupt"
          onClick={() => void suchen()}
        >
          Suchen
        </button>
        {abteilungen.length > 0 && (
          <span className="feld">
            <label htmlFor="abteilungs-filter">Abteilung</label>
            <select
              id="abteilungs-filter"
              data-testid="abteilungs-filter"
              value={abteilung}
              onChange={(ereignis) => setAbteilung(ereignis.target.value)}
            >
              <option value={ALLE_ABTEILUNGEN}>Alle</option>
              {abteilungen.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </span>
        )}
      </p>

      {ladefehler && (
        <p data-testid="dokumente-fehler" role="alert" className="streifen" data-ton="fehler">
          Dokumente nicht ladbar: {ladefehler}
        </p>
      )}

      {laden ? (
        <p data-testid="dokumente-laden" className="leise">
          Wird geladen…
        </p>
      ) : eintraege.length === 0 ? (
        letzteSuche === null ? (
          <p data-testid="dokumente-leer" className="leerstand">
            Noch nichts gesucht und in dieser Sitzung nichts abgelegt. Diese Liste zeigt, was du
            hochlädst und was eine Suche findet — der Tresor selbst kann größer sein.
          </p>
        ) : (
          <p data-testid="dokumente-nichts-gefunden" className="leerstand">
            Nichts gefunden zu „{letzteSuche}".
            {hinweis ? ` ${hinweis}` : ''}
          </p>
        )
      ) : sichtbar.length === 0 ? (
        <p data-testid="dokumente-gefiltert-leer" className="leerstand">
          Kein Dokument mit dieser Abteilung. Es sind {eintraege.length} andere in der Liste.
        </p>
      ) : (
        <>
          {hinweis && (
            <p data-testid="suchhinweis" className="streifen" data-ton="warnung">
              {hinweis}
            </p>
          )}
          <ul data-testid="dokumentenliste" className="stapel">
            {sichtbar.map((eintrag) => {
              /*
                Die drei Zustände aus §13 bekommen drei Erscheinungen, aber
                keinen zusätzlichen Text: die Auszeichnung sitzt am Absatz. Ein
                eingeschobenes Abzeichen wäre ein zweiter Textknoten mitten in
                einer Zeile, die Browserfälle als zusammenhängend lesen.
              */
              const lesbarkeit =
                eintrag.art === 'hochgeladen'
                  ? dokumentDurchsuchbarkeit(eintrag.versionen).art
                  : 'lesbar';
              return (
                <li
                  key={eintrag.dokument.id}
                  data-testid={`dokument-${eintrag.dokument.id}`}
                  className="karte"
                >
                  <h3 data-inhalt="daten">
                    <a
                      href={dokumentPfad(eintrag.dokument.id)}
                      data-testid={`dokument-link-${eintrag.dokument.id}`}
                    >
                      {eintrag.dokument.title}
                    </a>
                  </h3>
                  <p data-testid={`schlagworte-${eintrag.dokument.id}`} className="leise">
                    Abteilungen: {beschriftung(eintrag.dokument.departmentTags)} · Schlagworte:{' '}
                    {beschriftung(eintrag.dokument.tags)}
                  </p>
                  <p
                    data-testid={`zustand-${eintrag.dokument.id}`}
                    className="lesbarkeit"
                    data-lesbarkeit={lesbarkeit}
                  >
                    {eintrag.art === 'hochgeladen'
                      ? `Abgelegt · ${dokumentDurchsuchbarkeit(eintrag.versionen).text}`
                      : `Gefunden in Fassung ${eintrag.version}${
                          eintrag.departmentMatch ? ' · für diese Abteilung verschlagwortet' : ''
                        }`}
                  </p>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Rahmen>
  );
}

/** A tag list, or the sentence that says there is none — never an empty gap. */
function beschriftung(tags: readonly string[]): string {
  return tags.length > 0 ? tags.join(', ') : 'keine';
}

// --- the upload (§13: "Upload via dashboard (drag & drop)") ------------------

function Upload({ onAbgelegt }: { onAbgelegt: (detail: DocumentDetailView) => void }) {
  const [titel, setTitel] = useState('');
  const [abteilungen, setAbteilungen] = useState('');
  const [schlagworte, setSchlagworte] = useState('');
  const [datei, setDatei] = useState<File | null>(null);
  const [fehler, setFehler] = useState<string[]>([]);
  const [erfolg, setErfolg] = useState<string | null>(null);
  const [ueber, setUeber] = useState(false);
  const [laeuft, setLaeuft] = useState(false);

  async function ablegen() {
    // Checked here **and** in the route, and the route is the boundary that
    // counts (A111.1). What this buys is that an oversized file is refused
    // before it is pushed up the wire, in German, instead of after a minute.
    const plan = uploadPlan({ titel, datei, abteilungen, schlagworte });
    if (!plan.ok) {
      setFehler(plan.fehler);
      setErfolg(null);
      return;
    }
    if (!datei) return;

    setLaeuft(true);
    setFehler([]);
    setErfolg(null);
    try {
      // A raw body, never a `FormData`: the metadata rides in the query string
      // so the size cap can be counted per chunk rather than after the whole
      // document has been buffered (A111.1).
      const antwort = await fetch(plan.url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': plan.contentType },
        body: datei,
      });
      if (!antwort.ok) {
        // Read defensively: a 413 from a proxy carries no JSON, and a form that
        // broke on that would hide the reason it was refused.
        const koerper = await antwort.json().catch(() => null);
        setFehler(uploadFehler(antwort.status, koerper));
        return;
      }
      const gelesen = leseDokument(await antwort.json());
      if (!gelesen.ok) {
        setFehler([gelesen.fehler]);
        return;
      }
      onAbgelegt(gelesen.wert);
      setErfolg(`„${gelesen.wert.document.title}" liegt im Tresor.`);
      setTitel('');
      setAbteilungen('');
      setSchlagworte('');
      setDatei(null);
    } catch (grund) {
      setFehler([grund instanceof Error ? grund.message : String(grund)]);
    } finally {
      setLaeuft(false);
    }
  }

  return (
    <>
      <h3>Ablegen</h3>
      <p data-testid="upload-grenze" className="leise">
        Höchstens {MAX_UPLOAD_MB} MB. Angenommen werden: {ERLAUBTE_TYPEN}.
      </p>

      {fehler.length > 0 && (
        <ul data-testid="upload-fehler" role="alert" className="streifen" data-ton="fehler">
          {fehler.map((grund) => (
            <li key={grund}>{grund}</li>
          ))}
        </ul>
      )}
      {erfolg && (
        <p data-testid="upload-erfolg" className="streifen" data-ton="hinweis">
          {erfolg}
        </p>
      )}

      <p className="feld">
        <label htmlFor="dokument-titel">Titel</label>
        <input
          id="dokument-titel"
          data-testid="dokument-titel"
          value={titel}
          placeholder="z. B. Vereinsstatuten 2026"
          onChange={(ereignis) => setTitel(ereignis.target.value)}
        />
      </p>
      <p className="feld">
        <label htmlFor="dokument-abteilungen">
          Abteilungen, denen dieses Dokument dient (§13; Komma-getrennt)
        </label>
        <input
          id="dokument-abteilungen"
          data-testid="dokument-abteilungen"
          value={abteilungen}
          placeholder="z. B. Recht, Doku"
          onChange={(ereignis) => setAbteilungen(ereignis.target.value)}
        />
      </p>
      <p className="feld">
        <label htmlFor="dokument-schlagworte">Freie Schlagworte (Komma-getrennt)</label>
        <input
          id="dokument-schlagworte"
          data-testid="dokument-schlagworte"
          value={schlagworte}
          placeholder="z. B. Verein, Statuten"
          onChange={(ereignis) => setSchlagworte(ereignis.target.value)}
        />
      </p>

      {/* biome-ignore lint/a11y/noStaticElementInteractions: the drop target is
          an area, and the file input beside it is the keyboard-reachable half */}
      <div
        data-testid="ablegezone"
        className="ablegezone"
        data-ueber={ueber ? '' : undefined}
        onDragOver={(ereignis) => {
          ereignis.preventDefault();
          setUeber(true);
        }}
        onDragLeave={() => setUeber(false)}
        onDrop={(ereignis) => {
          ereignis.preventDefault();
          setUeber(false);
          const abgelegt = ereignis.dataTransfer?.files?.[0];
          if (abgelegt) {
            setDatei(abgelegt);
            setFehler([]);
          }
        }}
      >
        {/* Eine echte Beschriftung, kein Absatz darüber: axe fand hier `label`
            als einzigen Verstoss der ganzen Oberfläche. Ein `<p>` neben einem
            Eingabefeld sieht für einen Sehenden aus wie eine Beschriftung und
            ist für einen Screenreader keine — genau die Sorte Unterschied, die
            das Gate „zero violations" sichtbar macht. */}
        <label htmlFor="dokument-datei">
          {ueber ? 'Loslassen zum Übernehmen.' : 'Datei hierher ziehen — oder auswählen:'}
        </label>
        <input
          id="dokument-datei"
          data-testid="dokument-datei"
          type="file"
          accept={DATEI_FILTER}
          onChange={(ereignis) => {
            setDatei(ereignis.target.files?.[0] ?? null);
            setFehler([]);
          }}
        />
      </div>

      <p data-testid="gewaehlte-datei" className="leise">
        {datei
          ? `${datei.name} · ${dateitypLabel(datei.type)} · ${groesse(datei.size)}`
          : 'Noch keine Datei gewählt.'}
      </p>

      <p className="knopfreihe">
        <button
          type="button"
          data-testid="dokument-hochladen"
          className="knopf"
          data-ton="haupt"
          onClick={() => void ablegen()}
          disabled={laeuft}
        >
          Ablegen
        </button>
      </p>
    </>
  );
}

// --- one document ------------------------------------------------------------

function Detail({ kennung }: { kennung: string }) {
  const [dokument, setDokument] = useState<DocumentDetailView | null>(null);
  const [ladefehler, setLadefehler] = useState<string | null>(null);
  const [unbekannt, setUnbekannt] = useState(false);

  const laden = useCallback(async () => {
    try {
      const antwort = await fetch(DOKUMENTE_API.document(kennung), { credentials: 'same-origin' });
      if (antwort.status === 404) {
        setUnbekannt(true);
        setLadefehler(null);
        return;
      }
      if (!antwort.ok) {
        const koerper = await antwort.json().catch(() => null);
        setLadefehler(uploadFehler(antwort.status, koerper).join(' '));
        return;
      }
      const gelesen = leseDokument(await antwort.json());
      if (!gelesen.ok) {
        setLadefehler(gelesen.fehler);
        return;
      }
      setDokument(gelesen.wert);
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
        <p data-testid="dokumente-fehler" role="alert" className="streifen" data-ton="fehler">
          Dokument nicht ladbar: {ladefehler}
        </p>
        <Zurueck />
      </Rahmen>
    );
  }

  if (unbekannt) {
    return (
      <Rahmen>
        <p data-testid="dokument-unbekannt" role="alert" className="streifen" data-ton="fehler">
          Kein Dokument mit der Kennung {kennung}.
        </p>
        <Zurueck />
      </Rahmen>
    );
  }

  if (!dokument) {
    return (
      <Rahmen>
        <p data-testid="dokumente-laden" className="leise">
          Wird geladen…
        </p>
      </Rahmen>
    );
  }

  const gesamt = dokumentDurchsuchbarkeit(dokument.versions);

  return (
    <Rahmen>
      <Zurueck />
      {/* Ein Dokumententitel ist Inhalt, keine Beschriftung — und trägt hier
          regelmäßig Jahreszahlen. Deshalb Textschrift (siehe `basis.css`). */}
      <h3 data-testid="detail-titel" data-inhalt="daten">
        {dokument.document.title}
      </h3>
      <p data-testid="detail-schlagworte" className="leise">
        Abteilungen: {beschriftung(dokument.document.departmentTags)} · Schlagworte:{' '}
        {beschriftung(dokument.document.tags)}
      </p>
      <p data-testid="detail-zustand" className="lesbarkeit" data-lesbarkeit={gesamt.art}>
        {gesamt.text}
      </p>

      <h4>Fassungen (§13: append-only)</h4>
      <ul data-testid="versionsliste" className="liste">
        {dokument.versions.map((version) => {
          const stand = durchsuchbarkeit(version);
          return (
            <li key={version.id} data-testid={`version-${version.version}`}>
              Fassung {version.version} · {version.filename} · {dateitypLabel(version.mimeType)} ·{' '}
              {groesse(version.byteSize)} · {zeitpunkt(version.uploadedAt)} · {version.uploadedBy}
              <span
                data-testid={`version-${version.version}-zustand`}
                className="lesbarkeit"
                data-lesbarkeit={stand.art}
              >
                {stand.text}
              </span>
            </li>
          );
        })}
      </ul>
    </Rahmen>
  );
}
