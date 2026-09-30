import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * E2E configuration for the passkey gate (§22 Phase 0, gate 6).
 *
 * The ceremony is driven through Chrome's **virtual authenticator** — the
 * stand-in `docs/build-prompt.md` explicitly sanctions. It is not a mock of our
 * code: the browser performs the real WebAuthn ceremony against the real
 * `@simplewebauthn` verification, with a software authenticator in place of
 * silicon. Everything the gate asserts (two credentials before the bootstrap
 * counts as complete, registration refused without invite or session, the CLI
 * rescue invite working) is a property of the server, not of the hardware.
 *
 * Run it with a throwaway database:
 *   infra/scripts/with-test-db.sh pnpm exec playwright test
 */
/*
 * Ports je Lauf, nicht je Repository (A121).
 *
 * Beide Vorgaben waren fest, und `reuseExistingServer: false` macht daraus
 * einen harten Zusammenstoss: ein zweiter Nachweislauf auf derselben Maschine
 * bricht mit „is already used" ab, **bevor ein einziger Browserfall lief** —
 * und ein Phasenskript, das daraufhin rot meldet, behauptet einen Befund, wo
 * nichts geprüft wurde (A25). Auf einem Rechner mit vierzehn Worktrees ist das
 * kein Randfall.
 *
 * Der Versatz kommt aus dem **Arbeitsverzeichnis**, und das ist eine Korrektur:
 * der erste Anlauf nahm `process.pid`, und Playwright wertet die Konfiguration
 * in mehreren Prozessen aus — der Webserver startete auf einem Port, die Fälle
 * riefen einen anderen, und der Lauf endete in `ERR_CONNECTION_REFUSED` auf
 * zwei verschiedenen Ports in derselben Ausgabe. Das Verzeichnis teilen alle
 * Prozesse eines Laufs und es unterscheidet genau das, was hier kollidiert:
 * zwei Worktrees. Zwei gleichzeitige Läufe im *selben* Verzeichnis kollidieren
 * weiterhin — das ist der seltenere Fall und wird hier nicht gelöst, sondern
 * benannt.
 *
 * Die Umgebungsvariablen bleiben vorrangig, damit ein Lauf gegen einen
 * bekannten Port weiterhin möglich ist. `ORIGIN` und `serverEnv` leiten sich
 * aus **denselben** Konstanten ab — ein zweiter Ursprung wäre eine Stelle, an
 * der die WebAuthn-Zeremonie auseinanderläuft.
 */
const PORT_OFFSET =
  [...process.cwd()].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 900, 7) % 900;
const API_PORT = Number(process.env.E2E_API_PORT ?? 8421 + PORT_OFFSET);
const WEB_PORT = Number(process.env.E2E_WEB_PORT ?? 5173 + PORT_OFFSET);
// Zurück in die Umgebung, damit die Spezifikationen dieselben Zahlen sehen.
// Drei von ihnen erklären die Vorgaben ein zweites Mal (`?? '5173'`), und zwei
// unabhängige Deklarationen desselben Werts sind A81s Klasse — hier ist der
// Preis ein Lauf, der den Webserver auf dem einen Port startet und den anderen
// abfragt. Die Konfiguration wird in jedem Worker geladen, und alle leiten den
// Versatz aus demselben Verzeichnis ab, also sehen alle dasselbe.
process.env.E2E_API_PORT = String(API_PORT);
process.env.E2E_WEB_PORT = String(WEB_PORT);

const ORIGIN = `http://localhost:${WEB_PORT}`;

const serverEnv = {
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
  APP_BIND: '127.0.0.1',
  APP_PORT: String(API_PORT),
  PUBLIC_ORIGIN: ORIGIN,
  WEBAUTHN_RP_ID: 'localhost',
  WEBAUTHN_RP_NAME: 'Vorschicht (E2E)',
  SESSION_SECRET: 'e2e-only-session-secret-that-is-long-enough-xxxx',
  // Shape-valid but non-functional: the server validates the format at startup
  // and never makes a model call in this suite.
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-placeholder-e2e-kein-echter-token',
  CLAUDE_CLI_VERSION: '2.1.220',
  NTFY_SERVER: 'http://127.0.0.1:9',
  NTFY_TOKEN: 'tk_e2e_placeholder',
  // §13's docs volume. Named explicitly rather than left to the default
  // (`<dataRoot>/docs` = `/srv/vorschicht/docs`), which does not exist on a
  // developer's machine and would make every upload a 500 — and the vault suite
  // would then be proving that a page renders a server fault.
  VORSCHICHT_DOCS_ROOT: join(tmpdir(), 'vorschicht-e2e-docs'),
  // §18's transcript archive. Named for the same reason as the docs volume
  // above: the default (`<dataRoot>/transcripts` = `/srv/vorschicht/transcripts`)
  // does not exist on a developer's machine, and §17.4's viewer would then
  // report every transcript as `missing` — which is a real state of its own, so
  // the suite would be asserting the wrong one while looking green.
  VORSCHICHT_TRANSCRIPTS_ROOT: join(tmpdir(), 'vorschicht-e2e-transkripte'),
  LOG_LEVEL: 'warn',
};

export default defineConfig({
  testDir: 'e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI ? 'list' : [['list']],
  use: {
    baseURL: ORIGIN,
    trace: 'retain-on-failure',
  },
  /**
   * Three suites against one database, in a stated order rather than an
   * alphabetical accident.
   *
   * `passkey` asserts credential *counts* (Phase 0 gate 6: two before the
   * bootstrap locks), so anything that registers another passkey must run
   * after it. `dashboard` does — it needs a session to reach §17.3 at all —
   * and `inbox` does too. Left to file ordering that would hold today and break
   * silently the first time a suite is renamed, which is the shape §8.2's sixth
   * domain hunts.
   *
   * `dependencies` also means a red passkey suite skips the ones below it
   * instead of reporting a second, derived failure. Each suite hangs off the
   * previous one rather than all off `passkey`, so they form one declared total
   * order rather than a fork whose branches race for the same rows.
   */
  projects: [
    { name: 'passkey', testMatch: /passkey\.spec\.ts/ },
    { name: 'dashboard', testMatch: /projekte\.spec\.ts/, dependencies: ['passkey'] },
    { name: 'inbox', testMatch: /posteingang\.spec\.ts/, dependencies: ['dashboard'] },
    { name: 'vault', testMatch: /dokumente\.spec\.ts/, dependencies: ['inbox'] },
    // §14's registry goes last, and it hangs off `vault` rather than off
    // `passkey` for the reason above: one declared total order, not a fork whose
    // branches race for the same rows. It seeds its own sources through raw SQL
    // and scopes every assertion to their ids, so it neither depends on nor
    // disturbs what the suites before it left behind.
    { name: 'sources', testMatch: /quellen\.spec\.ts/, dependencies: ['vault'] },
    // §17.9 goes last, and its place in the chain is not a preference. It is the
    // only suite that changes a **global** setting — the persona mode decides how
    // every name in the dashboard renders — so anything running after it would be
    // rendering under whatever this suite left behind. It restores the default in
    // `afterAll`, and running last means a crash between the two cannot mislead a
    // later suite either.
    { name: 'settings', testMatch: /einstellungen\.spec\.ts/, dependencies: ['sources'] },
    // Eine erklärte Gesamtordnung, kein Fork (A75.6): jedes Phase-7-Projekt
    // hängt am vorigen statt vier Zweige an `settings`. Drei davon bewegen
    // globalen Zustand — der Persona-Schalter, die Pause, gesäte Ereignisse —,
    // und parallele Zweige an derselben Wurzel würden um dieselben Zeilen
    // rennen. Beim Zusammenführen der drei Stränge entstand hier zweimal
    // derselbe Textkonflikt; die Kette ist die Auflösung, nicht die Umgehung.
    { name: 'ueberblick', testMatch: /ueberblick\.spec\.ts/, dependencies: ['settings'] },
    { name: 'office', testMatch: /buero\.spec\.ts/, dependencies: ['ueberblick'] },
    { name: 'controlling', testMatch: /controlling\.spec\.ts/, dependencies: ['office'] },
    { name: 'traces', testMatch: /spuren\.spec\.ts/, dependencies: ['controlling'] },
    // §18s Log-Explorer. Er säht Ereignisse in `event_log` — eine append-only
    // Tabelle, aus der niemand aufräumt —, also steht er hinter allen Suiten,
    // deren Zusicherungen Zeilen zählen könnten, und vor `a11y`, das ihn
    // scannen soll.
    { name: 'log', testMatch: /log\.spec\.ts/, dependencies: ['traces'] },
    /*
     * Der axe-Scan geht zuletzt, und das ist kein Ordnungssinn (§22 Phase 7:
     * „axe scan on all pages: zero violations"). Die sieben Suiten davor lassen
     * Projekte, Aufgaben, Läufe, Dokumente, Quellen und Eskalationen in der
     * geteilten Datenbank zurück, und eine gefüllte Seite hat mehr zu prüfen
     * als eine leere. Er schreibt selbst nichts und stört daher niemanden
     * hinter sich — was zugleich der Grund ist, warum er der letzte sein *kann*.
     */
    // §16s Archiv. Es säht in `reports` — eine Tabelle, aus der niemand
    // aufräumt — und steht deshalb wie `log` hinter allem, was Zeilen zählt,
    // und vor `a11y`, das die Seite scannen soll.
    { name: 'berichte', testMatch: /berichte\.spec\.ts/, dependencies: ['log'] },
    { name: 'a11y', testMatch: /zugaenglichkeit\.spec\.ts/, dependencies: ['berichte'] },
  ],
  webServer: [
    {
      command: 'node apps/server/dist/main.js',
      url: `http://127.0.0.1:${API_PORT}/healthz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: serverEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // **Der gebaute Bundle, nicht der Entwicklungsserver** (A120). `vite dev`
      // liefert jedes Modul als eigene Anfrage aus; mit den Seiten aus Phase 6
      // sind das beim Neuladen mehrere hundert, und Chrome bricht auf einer
      // ausgelasteten Maschine reproduzierbar mit `ERR_INSUFFICIENT_RESOURCES`
      // ab — beobachtet als „nav-projekte erscheint nach page.reload() nie".
      // `preview` liefert dasselbe Artefakt aus, das nginx in Produktion
      // ausliefert, ist damit **treuer** und nebenbei schneller.
      command: `pnpm --filter @vorschicht/web exec sh -c 'vite build && vite preview --port ${WEB_PORT} --strictPort'`,
      url: ORIGIN,
      reuseExistingServer: false,
      timeout: 180_000,
      env: { VITE_API_TARGET: `http://127.0.0.1:${API_PORT}` },
      stdout: 'pipe',
      stderr: 'pipe',
    },
  ],
});
