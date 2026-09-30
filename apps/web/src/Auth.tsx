import { useEffect, useState } from 'react';
import { type BootstrapInfo, fetchAuthState, login, logout, register } from './auth-api.js';

/**
 * Registration and login (§19). All copy is German (§2).
 *
 * The invite token is taken from the URL fragment and removed from the address
 * bar as soon as it has been read, so it does not survive in history or in a
 * screenshot.
 */
export function Auth({ onChanged }: { onChanged?: () => void } = {}) {
  const [state, setState] = useState<BootstrapInfo | null>(null);
  const [invite, setInvite] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    // Also listens for later hash changes: pasting an invite link into an
    // already-open tab is a same-document navigation, so without this the
    // token would simply be ignored and the user would be told registration is
    // locked — with the invite sitting right there in the address bar.
    const readInvite = () => {
      const fragment = window.location.hash.replace(/^#/, '');
      if (fragment.length === 0) return;
      setInvite(fragment);
      setError(null);
      history.replaceState(null, '', window.location.pathname);
    };

    readInvite();
    window.addEventListener('hashchange', readInvite);
    // Inlined rather than calling the shared helper: the helper is recreated on
    // every render, so depending on it would re-subscribe the listener each time.
    void fetchAuthState()
      .then(setState)
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    return () => window.removeEventListener('hashchange', readInvite);
  }, []);

  function showError(cause: unknown) {
    setError(cause instanceof Error ? cause.message : String(cause));
  }

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      showError(cause);
    } finally {
      setBusy(false);
    }
  }

  const onRegister = () =>
    run(async () => {
      const next = await register(label.trim(), invite ?? undefined);
      // Registration also signs you in — the server issues the session cookie
      // in the same response — so the full state has to be re-read rather than
      // patched from the registration payload, or the UI keeps offering a
      // login button to someone who is already logged in.
      setState(await fetchAuthState());
      onChanged?.();
      setInvite(null);
      setLabel('');
      setNote(
        next.bootstrap.complete
          ? 'Passkey gespeichert. Die Einrichtung ist vollständig.'
          : `Passkey gespeichert. Noch ${next.bootstrap.missing} bis zur vollständigen Einrichtung.`,
      );
    });

  const onLogin = () =>
    run(async () => {
      const result = await login();
      setNote(`Angemeldet mit „${result.passkey}“.`);
      setState(await fetchAuthState());
      onChanged?.();
    });

  const onLogout = () =>
    run(async () => {
      await logout();
      setNote('Abgemeldet.');
      setState(await fetchAuthState());
      onChanged?.();
    });

  /*
   * Gestaltung, keine Umstellung: dies ist die erste Seite, die ein
   * eingeladener Mensch sieht, und ohne Sitzung ist sie die **einzige**.
   *
   * Sie sah bisher aus wie ein Fehlerdialog — drei nackte Absätze und zwei
   * Browserknöpfe unter einer gestrichelten Linie, angeführt von dem Satz, dass
   * die Registrierung gesperrt sei. Der Satz stimmt und bleibt; was sich
   * ändert, ist sein Gewicht. Eine erkannte Einladung ist jetzt ein Hinweis auf
   * Papier („komm rein"), der gesperrte Fall leise gesetzter Fließtext („so
   * kommst du rein"), und ein echter Fehler bleibt der einzige Streifen, der
   * rot ist. Kein Text und kein `data-testid` ist verändert.
   */
  return (
    <section className="karte">
      <h2>Zugang</h2>

      {/*
        Ein Fach mit reserviertem Platz, kein loser Streifen.

        Gemessen am 18.8.2026: `check-leistungsbudget.mjs` meldete CLS zwischen
        0,088 und 0,122 gegen eine Grenze von 0,1 — die Streuung entschied also
        über P7.G3. Lighthouse nannte die verschobenen Knoten selbst, und es
        waren „Zugang" und „Gerätename" dieser Seite: der Streifen wird nach
        dem ersten Anstrich eingehängt und schiebt alles unter sich nach unten.

        Es wäre bequem, das als Messartefakt abzutun — der Messlauf fährt
        `vite preview` ohne API, deshalb steht dort „Serverfehler (500)". Aber
        derselbe Sprung passiert in Produktion: `state.hinweis` kommt aus einem
        Abruf, der nach dem Anstrich antwortet, und auf einer frischen
        Installation ist das der Bootstrap-Hinweis. Der Sprung ist echt, die
        Messung hat ihn nur zuverlässig ausgelöst.

        Das Fach ist immer da und hoch genug für einen Streifen, also ändert
        dessen Ankunft die Höhe nicht mehr. Zwei Streifen gleichzeitig wachsen
        weiterhin — selten und bewusst nicht wegkonstruiert, weil eine feste
        Höhe für n Streifen eine Zahl wäre, die beim ersten längeren Text lügt.
      */}
      <div className="streifenfach">
        {state?.hinweis && (
          <p data-testid="bootstrap-hinweis" className="streifen" data-ton="hinweis">
            {state.hinweis}
          </p>
        )}
        {note && (
          <p data-testid="note" className="streifen" data-ton="hinweis">
            {note}
          </p>
        )}
        {error && (
          <p data-testid="error" role="alert" className="streifen" data-ton="fehler">
            {error}
          </p>
        )}
      </div>

      <p className="knopfreihe">
        {state?.angemeldet ? (
          <button
            type="button"
            data-testid="logout"
            className="knopf"
            onClick={onLogout}
            disabled={busy}
          >
            Abmelden
          </button>
        ) : (
          <button
            type="button"
            data-testid="login"
            className="knopf"
            data-ton="haupt"
            onClick={onLogin}
            disabled={busy}
          >
            Mit Passkey anmelden
          </button>
        )}
      </p>

      <h3>Passkey hinterlegen</h3>
      {invite ? (
        <p className="streifen" data-ton="hinweis">
          Einladung erkannt. Gib dem Gerät einen Namen.
        </p>
      ) : (
        <p className="leise">
          Ohne gültige Einladung oder angemeldete Sitzung ist die Registrierung gesperrt.
        </p>
      )}
      <p className="feld">
        <label htmlFor="passkey-label">Gerätename</label>
        <input
          id="passkey-label"
          data-testid="label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="z. B. Handy"
        />
      </p>
      <p className="knopfreihe">
        <button
          type="button"
          data-testid="register"
          className="knopf"
          onClick={onRegister}
          disabled={busy || label.trim().length === 0}
        >
          Passkey registrieren
        </button>
      </p>

      {state && (
        <p data-testid="credential-count" className="leise">
          Hinterlegte Passkeys: {state.bootstrap.credentialCount}
        </p>
      )}
    </section>
  );
}
