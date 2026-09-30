import { execFileSync } from 'node:child_process';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createSql } from '@vorschicht/db';

/**
 * §8's persona switch (§17.9), in a browser, against the real API.
 *
 * Three things can only be settled here, and the third is the one the Phase 6
 * exit gate turns on.
 *
 *   * **That §8's third state actually reaches the interface.** "Personas can be
 *     fully disabled (neutral role labels)" is a claim about what a person sees.
 *     `personaLabel` is unit-tested and `personaZeile` is unit-tested, and both
 *     would stay green against a page that never called them — which is exactly
 *     the shape §8.2's sixth domain hunts, and exactly what a browser can see
 *     and no unit test in this repository can.
 *
 *   * **That the change is stored and survives a reload**, rather than living in
 *     React state and reading as saved.
 *
 *   * **That §19's trail names the session** (`dashboard:<credentialId>`), not
 *     `'system'` (A75.3). Asserted as the value `/api/me` reports for *this*
 *     browser rather than as "not the default", because the defect it guards
 *     against writes a perfectly well-formed row.
 *
 * Conventions from `quellen.spec.ts` and `dokumente.spec.ts`, binding because
 * six Playwright projects share one database: every count is a **relation**
 * rather than an absolute number, and this suite restores the default at the end
 * so the mode it leaves behind cannot decide what a later suite renders.
 */

const WEB_PORT = process.env.E2E_WEB_PORT ?? '5173';
const API_PORT = process.env.E2E_API_PORT ?? '8421';

let sql: ReturnType<typeof createSql>;

function mintRescueInvite(): string {
  const output = execFileSync(
    process.execPath,
    ['apps/server/dist/cli/invite.js', '--purpose=rescue'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        DATABASE_URL: process.env.TEST_DATABASE_URL ?? '',
        PUBLIC_ORIGIN: `http://localhost:${WEB_PORT}`,
        WEBAUTHN_RP_ID: 'localhost',
        APP_PORT: API_PORT,
        SESSION_SECRET: 'e2e-only-session-secret-that-is-long-enough-xxxx',
        CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-placeholder-e2e-kein-echter-token',
        CLAUDE_CLI_VERSION: '2.1.220',
        NTFY_SERVER: 'http://127.0.0.1:9',
        NTFY_TOKEN: 'tk_e2e_placeholder',
      },
    },
  );
  const match = output.match(/#([A-Za-z0-9_-]{43})/);
  if (!match?.[1]) throw new Error(`Kein Token in der CLI-Ausgabe:\n${output}`);
  return match[1];
}

/** A signed-in page standing on the settings page. */
async function zuDenEinstellungen(context: BrowserContext, page: Page): Promise<void> {
  const client = await context.newCDPSession(page);
  await client.send('WebAuthn.enable');
  await client.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  await page.goto(`/#${mintRescueInvite()}`);
  await page.getByTestId('label').fill('E2E-Einstellungen');
  await page.getByTestId('register').click();
  await expect(page.getByTestId('logout')).toBeVisible();

  await page.getByTestId('nav-einstellungen').click();
  await expect(page.getByTestId('persona-stufen')).toBeVisible();
}

/** Who the browser is, as the server sees it — the actor the trail must name. */
async function sessionUser(page: Page): Promise<string> {
  const body = (await (await page.request.get('/api/me')).json()) as {
    session: { userId: string } | null;
  };
  if (!body.session) throw new Error('Keine Sitzung — die Registrierung hat nicht angemeldet');
  return body.session.userId;
}

async function trailCount(): Promise<number> {
  const rows = await sql<{ n: string }[]>`
    SELECT count(*) AS n FROM audit_log WHERE action = 'config.personas_changed'
  `;
  return Number(rows[0]?.n ?? 0);
}

test.beforeAll(async () => {
  sql = createSql({ url: process.env.TEST_DATABASE_URL ?? '', max: 2 });
});

test.afterAll(async () => {
  // Restore the default, so the mode this suite leaves behind cannot decide what
  // a later suite renders. Through the table rather than the page: the browser
  // is gone by now, and what matters is the row.
  await sql`DELETE FROM config WHERE key = 'personas.mode'`;
  await sql?.end();
});

test.describe('§17.9 — die Persona-Stufe', () => {
  test('zeigt in der Voreinstellung Namen und schaltet auf „Aus" zu Rollen um', async ({
    context,
    page,
  }) => {
    await zuDenEinstellungen(context, page);

    // A9's default: display-only. Rita is the reviewer's persona; `Review` is
    // her desk, and §8's neutral label for the same seat.
    await expect(page.getByTestId('persona-stufe-anzeige')).toBeChecked();
    await expect(page.getByTestId('persona-reviewer')).toContainText('Rita');
    await expect(page.getByTestId('persona-reviewer')).not.toContainText('Review');

    // §8's "fully disabled (neutral role labels)". This is the assertion the
    // exit gate's third state consists of, and the one that goes red if the page
    // ever renders the name regardless of the mode.
    await page.getByTestId('persona-stufe-aus').check();
    await expect(page.getByTestId('einstellungen-notiz')).toBeVisible();
    await expect(page.getByTestId('persona-reviewer')).toContainText('Review');
    await expect(page.getByTestId('persona-reviewer')).not.toContainText('Rita');

    // §8's two coders (A7): an alternate is a name, so it goes with the names.
    await expect(page.getByTestId('persona-coder')).not.toContainText('Chris');
    await page.getByTestId('persona-stufe-anzeige').check();
    await expect(page.getByTestId('persona-coder')).toContainText('Chris');
  });

  test('speichert die Stufe wirklich — sie überlebt einen Neuladen', async ({ context, page }) => {
    await zuDenEinstellungen(context, page);

    await page.getByTestId('persona-stufe-prompt').check();
    await expect(page.getByTestId('einstellungen-notiz')).toBeVisible();
    // A9's claim, on the page: this is the one step that changes a prompt, and
    // the page says so rather than leaving the operator to infer it.
    await expect(page.getByTestId('persona-wirkung')).toContainText('Charakter');

    await page.reload();
    await expect(page.getByTestId('persona-stufe-prompt')).toBeChecked();

    const rows = await sql<{ value: string }[]>`
      SELECT value #>> '{}' AS value FROM config WHERE key = 'personas.mode'
    `;
    expect(rows[0]?.value).toBe('prompt');

    // And back, so the two lower steps are shown to say the opposite.
    await page.getByTestId('persona-stufe-anzeige').check();
    await expect(page.getByTestId('persona-wirkung')).toContainText('Wort für Wort');
  });

  test('trägt jede Änderung mit der Sitzung ins Prüfprotokoll (§19, A75.3)', async ({
    context,
    page,
  }) => {
    await zuDenEinstellungen(context, page);
    // `sessionActor` prefixes the channel; `projekte.spec.ts` composes it the
    // same way, so the two suites assert one convention rather than two.
    const actor = `dashboard:${await sessionUser(page)}`;
    // A relation, never an absolute: six projects share this database.
    const vorher = await trailCount();

    await page.getByTestId('persona-stufe-aus').check();
    await expect(page.getByTestId('einstellungen-notiz')).toBeVisible();

    expect(await trailCount()).toBe(vorher + 1);
    const rows = await sql<{ actor: string; before: unknown; after: unknown }[]>`
      SELECT actor, before, after FROM audit_log
      WHERE action = 'config.personas_changed' ORDER BY occurred_at DESC, id DESC LIMIT 1
    `;
    expect(rows[0]?.actor).toBe(actor);
    expect(rows[0]?.actor).toContain('dashboard:');
    expect(rows[0]?.after).toEqual({ mode: 'aus' });

    await page.getByTestId('persona-stufe-anzeige').check();
  });
});

/**
 * §17.9s übrige fünf Abschnitte: §16s Kanäle, das Tarifprofil, §11s Katalog,
 * §18s Sicherungsstand und §19s Prüfprotokoll.
 *
 * Bis heute trug diese Seite ausschliesslich den Persona-Schalter, obwohl §17.9
 * sechs Dinge nennt. Der Sicherungsstand ist der, den der Betreiber nach A103 wirklich
 * sehen will: die Transkript-Sicherung schrieb vier Nächte lang 130 Byte, und
 * bemerkt hat es niemand.
 *
 * Der Zustand wird **roh über SQL** gesät und nicht über `backup-pass.ts` —
 * derselbe Grund wie überall in dieser Kette: der Dienst ist der geprüfte
 * Erzeuger.
 */
test.describe
  .serial('§17.9 — die übrigen Abschnitte', () => {
    test.beforeAll(async () => {
      await sql`
      INSERT INTO event_log (kind, actor, payload)
      VALUES ('backup.failed', 'system', ${sql.json({
        finishedAt: Math.floor(Date.now() / 1000),
        stamp: '2026-08-18',
        // `prune` fehlt absichtlich: die Nutzlast ist ein Dokument, das `sh`
        // schreibt, und eine Komponente, die es nicht nennt, muss als
        // „nicht gemeldet" erscheinen statt aus der Liste zu fallen.
        components: { db: 'ok', docs: 'ok', transcripts: 'failed' },
        problem: 'Permission denied beim Lesen der Transkripte',
      } as never)})
    `;
    });

    test('zeigt §18s Sicherungsstand mit der Komponente, die scheiterte (A103)', async ({
      context,
      page,
    }) => {
      await zuDenEinstellungen(context, page);

      await expect(page.getByTestId('sicherung-kachel')).toContainText('fehlgeschlagen');
      await expect(page.getByTestId('sicherung-transcripts')).toContainText(
        'Transkripte: fehlgeschlagen',
      );
      // Die Komponente, die lief, steht als gelaufen daneben — „die Sicherung ist
      // fehlgeschlagen" allein hätte genau diese Unterscheidung verborgen.
      await expect(page.getByTestId('sicherung-db')).toContainText('Datenbank: gelaufen');
      // Und die, die der Erzeuger gar nicht genannt hat, fällt nicht heraus.
      await expect(page.getByTestId('sicherung-prune')).toContainText('Aufräumen: nicht gemeldet');
      await expect(page.getByTestId('sicherung-problem')).toContainText('Permission denied');
    });

    /**
     * §19 verlangt eine Zeile je Dashboard-Aktion, und bis hierher konnte man sie
     * nur in der Datenbank lesen. Der Fall schreibt eine **echte** Zeile, indem er
     * den Persona-Schalter bedient, und liest sie auf derselben Seite wieder.
     */
    test('zeigt §19s Prüfprotokoll mit einer Zeile, die dieser Browser erzeugt hat', async ({
      context,
      page,
    }) => {
      await zuDenEinstellungen(context, page);
      const actor = `dashboard:${await sessionUser(page)}`;

      await page.getByTestId('persona-stufe-prompt').check();
      await expect(page.getByTestId('einstellungen-notiz')).toBeVisible();
      await page.reload();

      const protokoll = page.getByTestId('pruefprotokoll');
      await expect(protokoll).toContainText('config.personas_changed');
      await expect(protokoll).toContainText(actor);
      // §19s Zeilen tragen den Vorher/Nachher-Stand; ohne ihn beantwortet das
      // Protokoll „etwas wurde geändert" und verliert die Frage, wofür es da ist.
      await expect(protokoll).toContainText('"mode":"prompt"');

      await page.getByTestId('persona-stufe-anzeige').check();
    });

    test('zeigt §16s Kanäle und §11s Katalog, ohne ein Geheimnis zu bewegen', async ({
      context,
      page,
    }) => {
      await zuDenEinstellungen(context, page);

      // §16s drei Themen einzeln — A86 hatte hier einen Defekt, bei dem die drei
      // `NTFY_TOPIC_*`-Variablen wirkungslos waren und niemand es nachsehen konnte.
      const ntfy = page.getByTestId('kanal-ntfy');
      await expect(ntfy).toContainText('vorschicht-inbox');
      await expect(ntfy).toContainText('vorschicht-alerts');
      await expect(ntfy).toContainText('vorschicht-info');
      await expect(ntfy).toContainText('Token gesetzt');
      // §19: nur *ob*, nie der Wert. `playwright.config.ts` setzt ihn.
      await expect(page.getByTestId('benachrichtigungen')).not.toContainText('tk_e2e_placeholder');

      // Die E2E-Umgebung setzt kein SMTP, also ist der Mailweg nicht eingerichtet
      // — und das muss als solches dastehen statt als leerer Satz.
      await expect(page.getByTestId('kanal-mail')).toContainText('Nicht eingerichtet');

      await expect(page.getByTestId('tarifprofil')).toContainText('max_20x');

      // §11s drei Klassen. Die dritte ist die, die man weglässt: ein Gate mit
      // `availableFrom` kann nicht angehakt werden, und es unter „optional" zu
      // führen wäre eine Einladung zu einem Versuch, den der Katalog ablehnt.
      await expect(page.getByTestId('gate-klasse-gesperrt')).toContainText('Peer-Review');
      await expect(page.getByTestId('katalog-a11y')).toBeVisible();
    });
  });
