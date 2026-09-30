import { execFileSync } from 'node:child_process';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createSql } from '@vorschicht/db';

/**
 * Phase 3 gate — *baseline gates verified non-removable via UI and API (attempt
 * is refused + audit-logged)*.
 *
 * The API half is `packages/core/src/project-service.itest.ts` and its
 * transport is `apps/server/src/projects.itest.ts`. This file is the other
 * word in the gate sentence, and it is the one that cannot be faked from the
 * server side: a page that hid the checkbox, or dropped the `false` before
 * submitting, or swallowed the 422, would leave every server-side test green
 * while §11's guarantee became unobservable — which A62 rejected on purpose by
 * making the attempt expressible in the first place.
 *
 * So the checkbox for `Tests` is operable, unticking it really is submitted,
 * and what is asserted is the whole round trip: the German refusal on the page,
 * the configuration unchanged in the database, and the attempt in `audit_log`
 * with **the session** as its actor rather than `system`.
 *
 * Runs as the `dashboard` Playwright project, after `passkey` — see the
 * ordering note in `playwright.config.ts`.
 */

const WEB_PORT = process.env.E2E_WEB_PORT ?? '5173';
const API_PORT = process.env.E2E_API_PORT ?? '8421';
const SLUG = 'e2e-projekt';

let sql: ReturnType<typeof createSql>;
let projectId: string;
/** Damit gesäte Rollouts unterscheidbare Startzeiten bekommen. */
let seedOffset = 0;

/** Mint a rescue invite: it works after the bootstrap lock, which by now holds. */
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

/** A signed-in page, standing on the settings sheet of the fixture project. */
async function openSettings(context: BrowserContext, page: Page): Promise<void> {
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

  await page.getByTestId('nav-projekte').click();
  await page.getByTestId(`projekt-${SLUG}`).click();
  await expect(page.getByTestId('projekt-name')).toContainText('E2E-Projekt');
}

/** Who the browser is, as the server sees it — the actor the trail must name. */
async function sessionUser(page: Page): Promise<string> {
  const body = (await (await page.request.get('/api/me')).json()) as {
    session: { userId: string } | null;
  };
  if (!body.session) throw new Error('Keine Sitzung — die Registrierung hat nicht angemeldet');
  return body.session.userId;
}

async function auditRows(): Promise<Array<{ action: string; actor: string }>> {
  return sql<Array<{ action: string; actor: string }>>`
    SELECT action, actor FROM audit_log WHERE subject = ${SLUG} ORDER BY id
  `;
}

async function storedGates(): Promise<Record<string, boolean>> {
  const rows = await sql<Array<{ gate_config: { gates?: Record<string, boolean> } }>>`
    SELECT gate_config FROM projects WHERE slug = ${SLUG}
  `;
  return rows[0]?.gate_config?.gates ?? {};
}

/**
 * Ein vollständiger Rollout in `deployment_events`, per rohem SQL.
 *
 * Absichtlich **nicht** über `DeployRecords`: das ist der Produzent, dessen
 * Ausgabe dieser Test liest, und eine Fixture, die ihn benutzt, kann einen
 * Fehler in ihm aufsetzen und im selben Zug bestehen lassen — dieselbe
 * Begründung, die die `beforeAll` dieser Datei für `projects` gibt.
 *
 * `occurred_at` wird gesetzt statt der Vorgabe überlassen: die Sicht sortiert
 * nach `started_at`, und zwei Zeilen aus derselben Millisekunde machen die
 * Reihenfolge-Zusicherung zu einem Münzwurf.
 */
async function seedDeployment(input: {
  sha: string;
  artifact: string;
  outcome: 'succeeded' | 'rolled_back' | 'failed';
  rolledBackTo?: string;
  problem?: string;
}): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`SELECT gen_random_uuid() AS id`;
  const id = row?.id ?? '';
  expect(id).not.toBe('');
  seedOffset += 1;
  const start = new Date(Date.UTC(2026, 7, 3, 12, seedOffset)).toISOString();
  const ende = new Date(Date.UTC(2026, 7, 3, 12, seedOffset, 42)).toISOString();

  const schritte: Array<[string, Record<string, unknown>, string]> = [
    [
      'started',
      { projectId, taskId: null, sha: input.sha, method: 'compose', artifact: null },
      start,
    ],
    ['swapped', { artifact: input.artifact }, start],
    [
      'health_checked',
      { ok: input.outcome === 'succeeded', detail: input.problem ?? 'HTTP 200' },
      start,
    ],
    [
      input.outcome,
      {
        ...(input.rolledBackTo ? { rolledBackTo: input.rolledBackTo } : {}),
        ...(input.problem ? { problem: input.problem } : {}),
      },
      ende,
    ],
  ];
  for (const [seq, [kind, payload, at]] of schritte.entries()) {
    await sql`
      INSERT INTO deployment_events (deployment_id, seq, kind, actor, occurred_at, payload)
      VALUES (${id}, ${seq}, ${kind}, 'e2e', ${at}, ${sql.json(payload as never)})
    `;
  }
  return id;
}

test.beforeAll(async () => {
  sql = createSql({ url: process.env.TEST_DATABASE_URL ?? '', max: 2 });
  // Raw SQL rather than `ProjectService`: the fixture must not be built by the
  // component the gate is about, or a bug that swallowed the configuration
  // would set up the test and pass it in the same move.
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO projects (slug, name, root_path, gate_config, deploy_config)
    VALUES (${SLUG}, 'E2E-Projekt', '/tmp/e2e-projekt', '{}'::jsonb, '{"method":"none"}'::jsonb)
    RETURNING id
  `;
  projectId = rows[0]?.id ?? '';
  expect(projectId).not.toBe('');
});

test.afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

test.describe
  .serial('Projekteinstellungen (§17.3) — gesperrte Gates über die Oberfläche', () => {
    test('zeigt die gesperrten sechs als angehakt und bedienbar an', async ({ context, page }) => {
      await openSettings(context, page);

      // Operable, not greyed out: A62's point is that a guarantee nobody can
      // attack is a guarantee nobody can prove.
      for (const id of ['review', 'typecheck', 'lint', 'test', 'secrets', 'build']) {
        await expect(page.getByTestId(`gate-${id}`)).toBeChecked();
        await expect(page.getByTestId(`gate-${id}`)).toBeEnabled();
      }
      await expect(page.getByTestId('gate-sast')).not.toBeChecked();
      // Bis A115 stand hier die Umkehrung: `legal` war das eine Gate, dessen
      // Runner erst kam, und die Seite sagte das. Mit Lena ist kein
      // Katalogeintrag mehr unverfügbar, also darf der Hinweis **nirgends**
      // stehen — und `legal` ist ein anhakbares Optionsgate wie jedes andere.
      // Die schärfere Zusicherung, weil ein Hinweis über ein Gate, das es gibt,
      // der Betreiber einen Haken vorenthält, den er setzen dürfte.
      await expect(page.getByTestId('gate-legal-noch-nicht')).toHaveCount(0);
      await expect(page.getByTestId('gate-legal')).toBeEnabled();
    });

    test('lehnt das Abwählen von „Tests" ab, sichtbar und im Prüfpfad', async ({
      context,
      page,
    }) => {
      await openSettings(context, page);
      const actor = `dashboard:${await sessionUser(page)}`;
      const before = await auditRows();

      await page.getByTestId('gate-test').uncheck();
      await expect(page.getByTestId('gate-test')).not.toBeChecked();
      await page.getByTestId('gates-speichern').click();

      // The refusal, in German, naming the gate rather than saying "ungültig".
      const errors = page.getByTestId('gate-fehler');
      await expect(errors).toBeVisible();
      await expect(errors).toContainText('Tests');
      await expect(errors).toContainText('gesperrten Grundgerüst');
      await expect(errors.locator('li')).toHaveCount(1);
      await expect(page.getByTestId('gate-gespeichert')).toHaveCount(0);

      // Nothing was stored …
      expect(await storedGates()).toEqual({});
      // … and the attempt is in the trail, as the session rather than as
      // `system`. A refusal that leaves no row is indistinguishable from an
      // attempt that never happened (§19, §8.2 Domäne 7).
      const after = await auditRows();
      expect(after.length).toBe(before.length + 1);
      expect(after.at(-1)).toEqual({ action: 'project.gate_config_rejected', actor });
      expect(actor).not.toContain('system');
    });

    test('nennt alle Gründe auf einmal, nicht einen pro Versuch', async ({ context, page }) => {
      await openSettings(context, page);

      await page.getByTestId('gate-test').uncheck();
      await page.getByTestId('gate-build').uncheck();
      // Ticked without a command: §11 calls that ungeprüft, not grün.
      await page.getByTestId('gate-licenses').check();
      await page.getByTestId('gates-speichern').click();

      const errors = page.getByTestId('gate-fehler');
      await expect(errors.locator('li')).toHaveCount(3);
      await expect(errors).toContainText('Tests');
      await expect(errors).toContainText('Build');
      await expect(errors).toContainText('kein Befehl hinterlegt');
    });

    test('nimmt eine gültige Änderung an und schreibt sie fort', async ({ context, page }) => {
      await openSettings(context, page);
      const actor = `dashboard:${await sessionUser(page)}`;

      await page.getByTestId('gate-sast').check();
      await page.getByTestId('befehl-sast').fill('pnpm run sast');
      await page.getByTestId('gates-speichern').click();

      await expect(page.getByTestId('gate-gespeichert')).toContainText('Gespeichert');
      await expect(page.getByTestId('gate-fehler')).toHaveCount(0);
      expect(await storedGates()).toEqual({ sast: true });
      expect((await auditRows()).at(-1)).toEqual({
        action: 'project.gate_config_changed',
        actor,
      });

      // Reload rather than trust the form: what matters is what a later merge
      // will read, and that is the row, not the component's state.
      await page.reload();
      await page.getByTestId('nav-projekte').click();
      await page.getByTestId(`projekt-${SLUG}`).click();
      await expect(page.getByTestId('gate-sast')).toBeChecked();
      await expect(page.getByTestId('befehl-sast')).toHaveValue('pnpm run sast');
      await expect(page.getByTestId('gates-aktiv')).toContainText('Statische Sicherheitsanalyse');
    });

    /**
     * §12's release history, in a browser, against the real payload.
     *
     * What this is for is the class A81 records: the page parses `releases`
     * through the same zod schema the server's view is typed from, so a producer
     * and a consumer that had drifted would render `releases-fehler` here — and
     * *only* here, because a unit test on either side sees its own fixture. That
     * is the assertion, and it is deliberately written so that it holds whether
     * or not this process reads deployments: the section is present, exactly one
     * of its three states is shown, and none of them is the contract violation.
     */
    test('zeigt die Release-Historie in einem der drei erklärten Zustände (§12)', async ({
      context,
      page,
    }) => {
      await openSettings(context, page);

      await expect(page.getByRole('heading', { name: 'Releases (§12)' })).toBeVisible();
      // The one state that must never appear: it means the server's payload and
      // the page's schema disagree about §12's shape.
      await expect(page.getByTestId('releases-fehler')).toHaveCount(0);

      const states = await Promise.all(
        ['releaseliste', 'keine-releases', 'releases-unverdrahtet'].map((id) =>
          page.getByTestId(id).count(),
        ),
      );
      // Exactly one, not "at least one": three branches with one output, and two
      // rendering at once would mean the page is reporting two answers to the
      // question of what has been deployed.
      expect(states.reduce((sum, count) => sum + count, 0)).toBe(1);
    });

    /**
     * §22s Phase-5-Gate: *release recorded, **visible in UI***.
     *
     * Der Test darüber ist absichtlich so geschrieben, dass er in jedem der drei
     * Zustände hält — er prüft den *Vertrag*, nicht den Inhalt. Damit blieb der
     * Satz des Gates unbelegt: ohne eine einzige `deployments`-Zeile nimmt die
     * Seite dauerhaft den `unwired`- bzw. `keine-releases`-Zweig, und „sichtbar"
     * hieße dann „die Überschrift ist da".
     *
     * Also echte Zeilen, und zwar per **rohem SQL** aus demselben Grund, den die
     * `beforeAll` dieser Datei schon nennt: `DeployRecords` ist der Produzent,
     * dessen Ausgabe hier gelesen wird. Eine Fixture, die ihn benutzt, könnte
     * einen Fehler in ihm aufsetzen und im selben Zug bestehen lassen.
     *
     * Gesät werden **zwei** Rollouts, weil ein einzelner die Aussage nicht
     * trägt, die §12 an der Historie interessiert: der Rollback ist der einzige
     * Eintrag, der ohne einen zweiten Datensatz gar nicht darstellbar ist — er
     * ist eine Beziehung zwischen zwei Deployments (0019, Punkt 3).
     */
    test('zeigt gesäte Rollouts mit Ergebnis, Artefakt und Rollback-Ziel (§12)', async ({
      context,
      page,
    }) => {
      const gut = await seedDeployment({
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        artifact: 'e2e:gut',
        outcome: 'succeeded',
      });
      const kaputt = await seedDeployment({
        sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        artifact: 'e2e:kaputt',
        outcome: 'rolled_back',
        rolledBackTo: gut,
        problem: 'HTTP 503',
      });

      await openSettings(context, page);

      // Der Zweig, den dieses Gate meint — und nicht bloß „einer von dreien".
      await expect(page.getByTestId('releaseliste')).toBeVisible();
      await expect(page.getByTestId('releases-fehler')).toHaveCount(0);
      await expect(page.getByTestId('keine-releases')).toHaveCount(0);
      await expect(page.getByTestId('releases-unverdrahtet')).toHaveCount(0);

      // Der erfolgreiche: gekürzte sha, Artefakt, deutsches Ergebniswort.
      const guteZeile = page.getByTestId(`release-${gut}`);
      await expect(guteZeile).toContainText('aaaaaaaaaa');
      await expect(guteZeile).toContainText('e2e:gut');
      await expect(page.getByTestId(`release-${gut}-ergebnis`)).toHaveText('ausgerollt');

      // Der zurückgerollte, und die tragende Zusicherung dieses Falls: das Ziel
      // wird **aufgelöst** dargestellt, nicht als uuid. Genau dafür reicht der
      // Server `rolledBackTo` als Objekt und nicht als Kennung durch, und genau
      // das kann eine Attrappe auf keiner der beiden Seiten belegen.
      const kaputteZeile = page.getByTestId(`release-${kaputt}`);
      await expect(kaputteZeile).toContainText('e2e:kaputt');
      await expect(kaputteZeile).toContainText('HTTP 503');
      const ergebnis = page.getByTestId(`release-${kaputt}-ergebnis`);
      await expect(ergebnis).toContainText('zurückgerollt auf');
      await expect(ergebnis).toContainText('aaaaaaaaaa');
      await expect(ergebnis).toContainText('e2e:gut');
      await expect(ergebnis).not.toContainText(gut);

      // Neueste zuerst — die Überschrift der Sektion sagt es zu, und eine
      // Historie in beliebiger Reihenfolge ist keine Historie.
      const ids = await page
        .getByTestId(/^release-[0-9a-f-]+$/)
        .evaluateAll((zeilen) => zeilen.map((zeile) => zeile.getAttribute('data-testid')));
      expect(ids).toEqual([`release-${kaputt}`, `release-${gut}`]);
    });

    test('bleibt ohne Sitzung verschlossen', async ({ page }) => {
      // The shell loads — the passkey ceremony happens in it — but the data
      // behind it does not, and the page offers no navigation to it either.
      await page.goto(`/projekte/${SLUG}`);
      await expect(page.getByTestId('nav-projekte')).toHaveCount(0);
      expect((await page.request.get('/api/projekte')).status()).toBe(401);
      expect(
        (
          await page.request.put(`/api/projekte/${projectId}/gates`, {
            data: { gates: { test: false } },
          })
        ).status(),
      ).toBe(401);
    });
  });
