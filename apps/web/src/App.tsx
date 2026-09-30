import { BERICHTE_PATH } from '@vorschicht/shared/berichte';
import { useCallback, useEffect, useState } from 'react';
import { Auth } from './Auth.js';
import { type BootstrapInfo, fetchAuthState } from './auth-api.js';
import { Berichte } from './Berichte.js';
import { Buero } from './Buero.js';
import { Build } from './Build.js';
import { BUERO_PFAD } from './buero-format.js';
import { Controlling } from './Controlling.js';
import { CONTROLLING_PFAD } from './controlling-format.js';
import { Dokumente } from './Dokumente.js';
import { DOKUMENTE_PFAD } from './dokumente-format.js';
import { Einstellungen } from './Einstellungen.js';
import { Entscheidungen } from './Entscheidungen.js';
import { EINSTELLUNGEN_PFAD } from './einstellungen-format.js';
import { Fehlergrenze } from './Fehlergrenze.js';
import { ENTSCHEIDUNGEN_PFAD, POSTEINGANG_PFAD } from './inbox-format.js';
import { Log } from './Log.js';
import { LOG_PFAD } from './log-format.js';
import { Overview } from './Overview.js';
import { Posteingang } from './Posteingang.js';
import { Projekte } from './Projekte.js';
import { Quellen } from './Quellen.js';
import { QUELLEN_PFAD } from './quellen-format.js';
import { navigate, usePath } from './router.js';
import { Spuren } from './Spuren.js';
import { AUFGABEN_PFAD, LAEUFE_PFAD } from './spuren-format.js';

/**
 * Application shell.
 *
 * All UI copy is German (§2). What is shown depends on whether there is a
 * session, and the split is deliberate: the overview needs the API, and the API
 * is closed until a passkey has been used. Showing an empty dashboard to a
 * signed-out visitor would suggest the system had nothing to report, rather
 * than that they are not allowed to see it.
 *
 * The same rule decides the navigation: without a session there is nothing to
 * navigate *to*, so the links are not offered either.
 */
export function App() {
  const [auth, setAuth] = useState<BootstrapInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const path = usePath();

  const refresh = useCallback(async () => {
    try {
      setAuth(await fetchAuthState());
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onProjects = path.startsWith('/projekte');
  // §17.2. Prefix wie überall sonst, damit ein späteres `/buero/<platz>` hier
  // landet statt auf den Überblick durchzufallen.
  const onBuero = path.startsWith(BUERO_PFAD);
  // Prefix rather than equality: `/posteingang/42` is the deep link every
  // notification carries (§15, §16), and it has to land on the inbox rather
  // than fall through to the overview.
  const onInbox = path.startsWith(POSTEINGANG_PFAD);
  const onDecisions = path.startsWith(ENTSCHEIDUNGEN_PFAD);
  const onReports = path.startsWith(BERICHTE_PATH);
  // Prefix again, for the same reason: `/dokumente/<uuid>` is the permalink a
  // row links to and a reload has to land on the vault rather than fall through
  // to the overview.
  const onDocuments = path.startsWith(DOKUMENTE_PFAD);
  // And once more for `/quellen/<uuid>`, the permalink a row links to.
  const onSources = path.startsWith(QUELLEN_PFAD);
  // §17.9. Prefix like the rest, so a future `/einstellungen/<abschnitt>` lands
  // here rather than falling through to the overview.
  const onSettings = path.startsWith(EINSTELLUNGEN_PFAD);
  // §18s Log-Explorer. Prefix, weil `/log/<id>` der Deep-Link auf eine Zeile
  // ist und ein Neuladen dort landen muss statt auf dem Überblick.
  const onLog = path.startsWith(LOG_PFAD);
  // §17.8. Prefix like the rest, so a future `/controlling/<fenster>` lands here
  // rather than falling through to the overview.
  const onControlling = path.startsWith(CONTROLLING_PFAD);
  // §17.4. Two prefixes, one page: `/aufgaben/<uuid>` is a task's whole trace
  // and `/laeufe/<uuid>` one session's transcript. The run is addressed at the
  // top level on purpose — §22's office view links straight to it, and having to
  // know which task it served first would put a join in front of every dot.
  const onTraces = path.startsWith(AUFGABEN_PFAD) || path.startsWith(LAEUFE_PFAD);
  // Names the failing page in the boundary's sentence, and resets it when the operator
  // navigates away — a boundary that latched would make one bad link look like
  // a broken dashboard.
  const bereich = onBuero
    ? 'Büro'
    : onControlling
      ? 'Controlling'
      : onTraces
        ? 'Aufgaben'
        : onProjects
          ? 'Projekte'
          : onInbox
            ? 'Posteingang'
            : onDecisions
              ? 'Entscheidungen'
              : onDocuments
                ? 'Dokumente'
                : onSources
                  ? 'Quellen'
                  : onSettings
                    ? 'Einstellungen'
                    : onLog
                      ? 'Log'
                      : onReports
                        ? 'Wochenberichte'
                        : 'Überblick';

  const angemeldet = auth?.angemeldet === true;

  /*
   * §17: Kopfleiste, Navigation, Bereich — die Hülle ist ab hier ein
   * Schreibtisch mit einer Holzkante oben und Papierbögen darunter
   * (`apps/web/src/styles/`).
   *
   * Zwei Dinge daran sind Entscheidungen und keine Verzierung:
   *
   * `aria-current="page"` markiert den offenen Reiter. Das ist zuerst
   * Zugänglichkeit — ohne es ist die Navigation für einen Vorleser eine Liste
   * gleichwertiger Ziele — und erst danach der Aufhänger, an dem die
   * Gestaltung den Reiter hervorhebt. Farbe allein trägt die Aussage also
   * nicht, was das a11y-Gate der Phase 7 ausdrücklich verlangt.
   *
   * Die Kopfleiste klebt **nicht** (kein `position: sticky`). Playwright rollt
   * ein Element vor dem Klick ins Bild, und unter einer klebenden Leiste
   * landet es verdeckt; der Klick scheitert dann an „intercepts pointer
   * events". 65 Browserfälle hängen daran, und eine bequemere Leiste ist das
   * nicht wert.
   */
  return (
    <div className="rahmen">
      <header className="kopf">
        <div className="kopf-zeile">
          <h1 className="marke">Vorschicht</h1>
          {angemeldet && <span className="marke-zusatz">{bereich}</span>}
        </div>

        {angemeldet && (
          <nav data-testid="navigation" className="navigation">
            <button
              type="button"
              data-testid="nav-ueberblick"
              aria-current={bereich === 'Überblick' ? 'page' : undefined}
              onClick={() => navigate('/')}
            >
              Überblick
            </button>{' '}
            <button
              type="button"
              data-testid="nav-buero"
              aria-current={onBuero ? 'page' : undefined}
              onClick={() => navigate(BUERO_PFAD)}
            >
              Büro
            </button>{' '}
            <button
              type="button"
              data-testid="nav-projekte"
              aria-current={onProjects ? 'page' : undefined}
              onClick={() => navigate('/projekte')}
            >
              Projekte
            </button>{' '}
            <button
              type="button"
              data-testid="nav-aufgaben"
              aria-current={onTraces ? 'page' : undefined}
              onClick={() => navigate(AUFGABEN_PFAD)}
            >
              Aufgaben
            </button>{' '}
            <button
              type="button"
              data-testid="nav-posteingang"
              aria-current={onInbox ? 'page' : undefined}
              onClick={() => navigate(POSTEINGANG_PFAD)}
            >
              Posteingang
            </button>{' '}
            <button
              type="button"
              data-testid="nav-entscheidungen"
              aria-current={onDecisions ? 'page' : undefined}
              onClick={() => navigate(ENTSCHEIDUNGEN_PFAD)}
            >
              Entscheidungen
            </button>{' '}
            <button
              type="button"
              data-testid="nav-dokumente"
              aria-current={onDocuments ? 'page' : undefined}
              onClick={() => navigate(DOKUMENTE_PFAD)}
            >
              Dokumente
            </button>{' '}
            <button
              type="button"
              data-testid="nav-quellen"
              aria-current={onSources ? 'page' : undefined}
              onClick={() => navigate(QUELLEN_PFAD)}
            >
              Quellen
            </button>{' '}
            <button
              type="button"
              data-testid="nav-berichte"
              aria-current={onReports ? 'page' : undefined}
              onClick={() => navigate(BERICHTE_PATH)}
            >
              Berichte
            </button>{' '}
            <button
              type="button"
              data-testid="nav-controlling"
              aria-current={onControlling ? 'page' : undefined}
              onClick={() => navigate(CONTROLLING_PFAD)}
            >
              Controlling
            </button>{' '}
            <button
              type="button"
              data-testid="nav-einstellungen"
              aria-current={onSettings ? 'page' : undefined}
              onClick={() => navigate(EINSTELLUNGEN_PFAD)}
            >
              Einstellungen
            </button>{' '}
            <button
              type="button"
              data-testid="nav-log"
              aria-current={onLog ? 'page' : undefined}
              onClick={() => navigate(LOG_PFAD)}
            >
              Log
            </button>
          </nav>
        )}
      </header>

      <main className="inhalt">
        {error && (
          <p role="alert" className="streifen" data-ton="fehler">
            Server nicht erreichbar: {error}
          </p>
        )}

        {angemeldet ? (
          <Fehlergrenze bereich={bereich}>
            {onBuero ? (
              <Buero />
            ) : onTraces ? (
              <Spuren />
            ) : onProjects ? (
              <Projekte />
            ) : onInbox ? (
              <Posteingang />
            ) : onReports ? (
              <Berichte />
            ) : onDecisions ? (
              <Entscheidungen />
            ) : onDocuments ? (
              <Dokumente />
            ) : onSources ? (
              <Quellen />
            ) : onSettings ? (
              <Einstellungen />
            ) : onLog ? (
              <Log />
            ) : onControlling ? (
              <Controlling />
            ) : (
              <>
                <Overview />
                <Build />
              </>
            )}
          </Fehlergrenze>
        ) : (
          <p className="karte">
            Autonomes Software-Studio. Melde dich mit einem Passkey an, um den Überblick zu sehen.
          </p>
        )}

        {/*
          Der Zugang steht auf jeder Seite unten. Der Umschlag ist Gestaltung
          und kein Umbau: `Auth.tsx` gehört zur Hülle, wird in diesem Durchgang
          aber nicht angefasst — die abgesetzte Fußzeile nimmt ihm das Gewicht
          eines eigenen Kapitels, ohne eine Zeile darin zu ändern.
        */}
        <div className="fusszeile">
          <Auth onChanged={refresh} />
        </div>
      </main>
    </div>
  );
}
