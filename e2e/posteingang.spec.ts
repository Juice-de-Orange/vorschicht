import { execFileSync } from 'node:child_process';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createSql } from '@vorschicht/db';

/**
 * Phase 4 gates — the inbox, in a browser, against the real API and real rows.
 *
 * This file exists because of what shipped without it. The HTTP surface and
 * these pages were built in two worktrees, merged without a conflict, and
 * `pnpm gate` was nine of nine green over an inbox that could not load: the
 * routes answered `{ posteingang: … }` and the page read `koerper.items`, the
 * field names were disjoint, and the answer form posted `optionId` against a
 * schema taking `optionIndex`. Each side was tested against its own fixture and
 * both were right about their own half. Nothing put one half's output into the
 * other half's input, and that is exactly what a browser does.
 *
 * Three exit gates are settled here and nowhere else: that the cards, options
 * and copy render in German (§2), that a blocked task says *"blockiert durch
 * Entscheidung #X"* with a working deep link and a counter that matches, and
 * that every decision reaches the log with its context linkage.
 *
 * Two rules the assertions follow, because the three Playwright projects share
 * one database:
 *
 *   * every assertion is scoped to **this file's own escalation numbers**, and
 *   * every count is a **relation** (counter equals rendered rows), never an
 *     absolute — so what else is waiting cannot decide whether this passes.
 *
 * Fixtures are raw SQL rather than `EscalationService.raise`, following the
 * principle `projekte.spec.ts` already states: a fixture built by the component
 * under test can set up the test and pass it in the same move. `raise()` would
 * additionally run the precedent and similarity passes, which is a second
 * subsystem deciding what this gate sees.
 */

const WEB_PORT = process.env.E2E_WEB_PORT ?? '5173';
const API_PORT = process.env.E2E_API_PORT ?? '8421';

const SLUG = 'e2e-posteingang';
const TASK = '77777777-7777-4777-8777-777777777777';
const TASK_TITLE = 'Wartende Aufgabe für den Nachweis';

let sql: ReturnType<typeof createSql>;
let projectId: string;

interface Seed {
  id: string;
  number: number;
}

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

async function signIn(context: BrowserContext, page: Page): Promise<void> {
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
  await page.getByTestId('label').fill('E2E-Posteingang');
  await page.getByTestId('register').click();
  await expect(page.getByTestId('logout')).toBeVisible();
}

/** Who the browser is, as the server sees it — the actor a decision must name. */
async function sessionUser(page: Page): Promise<string> {
  const body = (await (await page.request.get('/api/me')).json()) as {
    session: { userId: string } | null;
  };
  if (!body.session) throw new Error('Keine Sitzung — die Registrierung hat nicht angemeldet');
  return body.session.userId;
}

async function seed(options: {
  question: string;
  urgency?: 'P0' | 'P1' | 'P2' | 'P3';
  taskId?: string | null;
  context?: string;
}): Promise<Seed> {
  const payload = {
    source: 'agent_question',
    urgency: options.urgency ?? 'P1',
    projectId,
    taskId: options.taskId ?? null,
    runId: null,
    question: options.question,
    context:
      options.context ?? 'Der Coder steht an dieser Stelle und kommt ohne dich nicht weiter.',
    options: [
      {
        title: 'Auf einem Aufgabenzweig arbeiten',
        pros: ['main bleibt unberührt'],
        cons: ['ein Merge mehr'],
        recommended: true,
      },
      {
        title: 'Gar nicht anfassen',
        pros: ['null Risiko'],
        cons: ['die Aufgabe bleibt liegen'],
        recommended: false,
      },
    ],
    precedentKey: null,
    related: [],
  };
  const [row] = await sql<Array<{ escalation_id: string; number: string }>>`
    INSERT INTO escalation_events (escalation_id, seq, kind, actor, number, payload)
    VALUES (
      gen_random_uuid(), 1, 'raised', 'coder',
      nextval('escalation_number_seq'),
      ${sql.json(payload as never)}
    )
    RETURNING escalation_id, number::text AS number
  `;
  if (!row) throw new Error('Eskalation konnte nicht angelegt werden');
  return { id: row.escalation_id, number: Number(row.number) };
}

/** An answer written past the dashboard — what a second tab, or an agent, did. */
async function answerBehindTheBack(id: string, chosenTitle: string): Promise<void> {
  await sql`
    INSERT INTO escalation_events (escalation_id, seq, kind, actor, payload)
    VALUES (${id}, 2, 'answered', 'max',
      ${sql.json({ optionIndex: 0, chosenTitle, freeText: null } as never)})
  `;
}

async function decisionRow(number: number): Promise<{
  actor: string;
  option_index: number | null;
  free_text: string | null;
} | null> {
  const rows = await sql<Array<{ actor: string; option_index: number | null; free_text: string }>>`
    SELECT a.actor,
           (a.payload ->> 'optionIndex')::int AS option_index,
           a.payload ->> 'freeText'           AS free_text
    FROM escalation_events a
    JOIN escalation_events r ON r.escalation_id = a.escalation_id AND r.kind = 'raised'
    WHERE a.kind = 'answered' AND r.number = ${number}
  `;
  return rows[0] ?? null;
}

test.beforeAll(async () => {
  sql = createSql({ url: process.env.TEST_DATABASE_URL ?? '', max: 3 });
  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO projects (slug, name, root_path)
    VALUES (${SLUG}, 'E2E-Posteingang', '/tmp/e2e-posteingang')
    RETURNING id
  `;
  projectId = rows[0]?.id ?? '';
  expect(projectId).not.toBe('');
  await sql`
    INSERT INTO task_events (task_id, project_id, seq, kind, actor, state, priority, payload)
    VALUES (${TASK}, ${projectId}, 0, 'created', 'orchestrator', 'queued', 'P2',
      ${sql.json({ title: TASK_TITLE, department: 'entwicklung', type: 'feature' } as never)})
  `;
});

test.afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

test.describe
  .serial('Posteingang (§15, §17.5) im Browser', () => {
    test('zeigt eine Karte vollständig und auf Deutsch (§2)', async ({ context, page }) => {
      const item = await seed({ question: 'Darf Vorschicht einen Aufgabenzweig anlegen?' });
      await signIn(context, page);
      await page.goto(`/posteingang/${item.number}`);

      const karte = page.getByTestId(`eskalation-${item.number}`);
      await expect(karte).toBeVisible();
      await expect(karte).toContainText('Darf Vorschicht einen Aufgabenzweig anlegen?');

      // §15's "From" line: who asks, about what, how urgent — all German.
      const herkunft = page.getByTestId(`herkunft-${item.number}`);
      await expect(herkunft).toContainText('Frage aus einer Sitzung');
      await expect(herkunft).toContainText('P1 — dringend');

      await expect(page.getByTestId(`kontext-${item.number}`)).toContainText('kommt ohne dich');

      // 2–4 options, each with a pro and a con, exactly one recommendation.
      const optionen = page.getByTestId(`optionen-${item.number}`);
      await expect(optionen.locator('> li')).toHaveCount(2);
      await expect(optionen).toContainText('main bleibt unberührt');
      await expect(optionen).toContainText('ein Merge mehr');
      await expect(optionen.getByText('Empfehlung der Abteilung')).toHaveCount(1);

      // And the free-text field is there even though the options look complete.
      await expect(page.getByTestId(`freitext-${item.number}`)).toBeVisible();
    });

    test('nimmt eine Antwort an, schreibt sie mit der Sitzung als Urheber und leert die Karte aus dem Posteingang', async ({
      context,
      page,
    }) => {
      const item = await seed({ question: 'Soll der Cache vor dem Build geleert werden?' });
      await signIn(context, page);
      const actor = `dashboard:${await sessionUser(page)}`;

      await page.goto(`/posteingang/${item.number}`);
      await page.getByTestId(`option-${item.number}-1`).check();
      await page.getByTestId(`antworten-${item.number}`).click();

      // The card is answered, so it renders read-only rather than 404ing.
      await expect(page.getByTestId(`entschieden-${item.number}`)).toBeVisible();

      // §19's trail: the session decided, not `system`. This is A75.3 proven end
      // to end for the one operation carrying the operator's authority (§6.4).
      const row = await decisionRow(item.number);
      expect(row?.option_index).toBe(1);
      expect(row?.actor).toBe(actor);
      expect(actor).not.toContain('system');

      // And it has left the inbox.
      await page.getByTestId('nav-posteingang').click();
      await expect(page.getByTestId(`eskalation-${item.number}`)).toHaveCount(0);
    });

    test('gibt des Betreibers eigene Worte wörtlich weiter', async ({ context, page }) => {
      const worte = 'Bitte nur auf „dev“ – und heb die Migration für später auf.';
      const item = await seed({ question: 'Welchen Zweig nehmen wir für den Umbau?' });
      await signIn(context, page);

      await page.goto(`/posteingang/${item.number}`);
      await page.getByTestId(`freitext-${item.number}`).fill(worte);
      await page.getByTestId(`antworten-${item.number}`).click();
      await expect(page.getByTestId(`entschieden-${item.number}`)).toBeVisible();

      // Byte-identical: A78 has this sentence travel into the resumed session
      // verbatim, and a page that trimmed or normalised it would break that
      // promise here, where nothing else would notice.
      const row = await decisionRow(item.number);
      expect(row?.free_text).toBe(worte);
      expect(row?.option_index).toBeNull();
    });

    test('führt jede Entscheidung im Protokoll, und der Zähler stimmt mit den Zeilen überein', async ({
      context,
      page,
    }) => {
      const item = await seed({
        question: 'Darf die Nachtsicherung auf dieselbe Platte schreiben?',
      });
      await signIn(context, page);

      await page.goto(`/posteingang/${item.number}`);
      await page.getByTestId(`option-${item.number}-0`).check();
      await page.getByTestId(`antworten-${item.number}`).click();
      await expect(page.getByTestId(`entschieden-${item.number}`)).toBeVisible();

      await page.getByTestId('nav-entscheidungen').click();
      const eintrag = page.getByTestId(`entscheidung-${item.number}`);
      await expect(eintrag).toBeVisible();
      await expect(eintrag).toContainText('Darf die Nachtsicherung');
      await expect(eintrag).toContainText('Auf einem Aufgabenzweig arbeiten');

      // The counter and the list are one derivation — asserted as a relation,
      // because the three Playwright projects share a database and an absolute
      // number here would depend on what else ran.
      const zahl = await page.getByTestId('entscheidungen-zahl').innerText();
      const [gezeigt] = zahl.match(/\d+/g) ?? [];
      await expect(page.getByTestId('entscheidungsliste').locator('> li')).toHaveCount(
        Number(gezeigt),
      );

      // Search narrows rather than widens: `#<n>` finds exactly this one.
      await page.getByTestId('entscheidungen-suche').fill(`#${item.number}`);
      await expect(page.getByTestId('entscheidungsliste').locator('> li')).toHaveCount(1);
      await expect(page.getByTestId(`entscheidung-${item.number}`)).toBeVisible();
    });

    /**
     * §9s zweite Art, im Browser — der Fall, an dem die Betriebsprüfung
     * 767db82c P4.G5 entwertet hat.
     *
     * Der Gate-Satz lautet „a task waiting **behind** a parked task's claims
     * displays 'blockiert durch Entscheidung #X'". Der Fall darüber sät zwei
     * Fragen auf **eine** Aufgabe — das ist die *fragende*, und sie war die
     * einzige, die je gerendert wurde. Eine zweite Aufgabe, die nach §10 hinter
     * deren Claims wartet, kam auf der Übersicht überhaupt nicht vor.
     *
     * Deshalb steht hier eine echte Claim-Kollision: `halter` belegt `src/**`
     * und wartet auf eine Entscheidung, `wartend` meldet `src/x.ts` an und
     * kommt nicht heran. Roh über SQL gesät, aus demselben Grund wie überall in
     * dieser Datei — `ClaimRegistry` ist der geprüfte Produzent.
     */
    /**
     * A44.3s dritte Art Stillstand, im Browser.
     *
     * Der Ablaufplaner überspringt Aufgaben eines nur lesbaren Projekts — und
     * tat das bis heute vor jedem Sammler, also erschienen sie weder in seinem
     * eigenen Bericht noch auf dieser Seite. Dieselbe Klasse wie der Fall
     * darunter, eine Tür weiter, und §21s Leerlauf-Audits machen sie real: ein
     * P2-Fund auf einem nur lesbaren Projekt *ist* so eine Aufgabe.
     *
     * Ein **eigener** Abschnitt statt einer dritten `art` oben, und der Test
     * prüft genau das mit: §17.1s Zähler zählt Aufgaben, die auf eine
     * Entscheidung im Postfach warten, und diese wartet auf eine
     * Kennzeichnung. Stünde sie in derselben Liste, wäre der Zähler entweder
     * falsch oder wieder eine zweite Ableitung (A81.4).
     */
    test('zeigt eine Aufgabe, die liegt, weil ihr Projekt nur lesbar ist (A44.3)', async ({
      context,
      page,
    }) => {
      const [gesperrt] = await sql<Array<{ id: string }>>`
        INSERT INTO projects (slug, name, root_path, read_only)
        VALUES ('e2e-nur-lesbar', 'E2E nur lesbar', '/tmp/e2e-nur-lesbar', true)
        RETURNING id
      `;
      const liegend = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      await sql`
        INSERT INTO task_events (task_id, project_id, seq, kind, actor, state, priority, payload)
        VALUES (${liegend}, ${gesperrt?.id ?? null}, 0, 'created', 'auditor', 'queued', 'P2',
          ${sql.json({
            title: 'Sicherheit: kein Timeout am fetch',
            department: 'Security',
            type: 'idle_audit_finding',
          } as never)})
      `;

      await signIn(context, page);
      await page.goto('/');

      const zeile = page.getByTestId(`liegengeblieben-${liegend}`);
      await expect(zeile).toHaveCount(1);
      await expect(zeile).toContainText('Sicherheit: kein Timeout am fetch');
      // Ohne das Projekt ist „nur lesbar" nicht handlungsfähig — der Betreiber muss
      // wissen, welche Kennzeichnung er zurücknehmen soll.
      await expect(zeile).toContainText('e2e-nur-lesbar');
      // Und der Satz sagt, was zu tun wäre, statt nur zu melden.
      await expect(page.getByTestId('liegengeblieben')).toContainText('gibst das Projekt frei');

      // Die Trennung, im Browser: sie steht **nicht** in der Liste der
      // blockierten Aufgaben und zählt nicht in §17.1s Entscheidungszähler.
      await expect(page.getByTestId(`blockiert-${liegend}`)).toHaveCount(0);
      const wartende = page.getByTestId('wartende-entscheidungen');
      if ((await wartende.count()) > 0) {
        await expect(wartende).not.toContainText('Sicherheit: kein Timeout');
      }
    });

    test('zeigt auch die Aufgabe, die hinter fremden Claims wartet (§9, §15)', async ({
      context,
      page,
    }) => {
      const halter = '88888888-8888-4888-8888-888888888888';
      const wartend = '99999999-9999-4999-8999-999999999999';
      for (const [id, titel] of [
        [halter, 'Hält die Dateien'],
        [wartend, 'Steht dahinter'],
      ] as const) {
        await sql`
          INSERT INTO task_events (task_id, project_id, seq, kind, actor, state, priority, payload)
          VALUES (${id}, ${projectId}, 0, 'created', 'orchestrator', 'queued', 'P2',
            ${sql.json({ title: titel, department: 'entwicklung', type: 'feature' } as never)})
        `;
      }
      // `claims` ist eine Sicht über `task_events`, also wird die echte
      // Ereignisfolge gesät. Der Halter geht bis `claimed` — das macht seine
      // Claims `active`; die zweite Aufgabe bleibt bei `planning`, ihre bleiben
      // `pending`. Genau A45.1/.2s Unterscheidung, und ohne sie blockierte eine
      // bloße Absichtserklärung das ganze Projekt.
      await sql`
        INSERT INTO task_events (task_id, project_id, seq, kind, actor, state, priority, payload)
        VALUES
          (${halter}, ${projectId}, 1, 'state_changed', 'orchestrator', 'planning', 'P2', '{}'::jsonb),
          (${halter}, ${projectId}, 2, 'claims_registered', 'planner', 'planning', 'P2',
            ${sql.json({ globs: ['src/**'] } as never)}),
          (${halter}, ${projectId}, 3, 'state_changed', 'orchestrator', 'claimed', 'P2', '{}'::jsonb),
          (${wartend}, ${projectId}, 1, 'state_changed', 'orchestrator', 'planning', 'P2', '{}'::jsonb),
          (${wartend}, ${projectId}, 2, 'claims_registered', 'planner', 'planning', 'P2',
            ${sql.json({ globs: ['src/x.ts'] } as never)})
      `;
      const frage = await seed({ question: 'Worauf der Halter wartet', taskId: halter });

      await signIn(context, page);
      await page.goto('/');

      // Die fragende Aufgabe — wie bisher.
      await expect(page.getByTestId(`blockiert-${halter}`)).toContainText(
        `blockiert durch Entscheidung #${frage.number}`,
      );
      // Und die dahinter, mit **derselben** Nummer: sie hat nie gefragt.
      const zeile = page.getByTestId(`blockiert-${wartend}`);
      await expect(zeile).toHaveCount(1);
      await expect(zeile).toContainText('Steht dahinter');
      await expect(zeile).toContainText(`blockiert durch Entscheidung #${frage.number}`);
      // Ohne den Halter wäre „blockiert durch #X" für diese Zeile nicht
      // nachvollziehbar — sie hat diese Frage nie gestellt.
      await expect(zeile).toContainText('Hält die Dateien');

      // Und der Zähler zählt sie mit: §15 wählt genau diese Sichtbarkeit
      // anstelle einer Frist für Entscheidungen.
      const zeilen = await page.getByTestId('blockierte-aufgaben').locator('> li').count();
      expect(zeilen).toBeGreaterThanOrEqual(2);
      await expect(page.getByTestId('wartende-entscheidungen')).toContainText(
        `${zeilen} Aufgaben warten`,
      );
    });

    test('sagt „blockiert durch Entscheidung #X" einmal je Aufgabe, mit funktionierendem Deep-Link', async ({
      context,
      page,
    }) => {
      // Two open questions on **one** task: the arrangement in which the counter
      // and the list used to disagree, and in which two `<li>`s shared a React key
      // and a `data-testid`. Playwright's strict mode fails on the duplicate by
      // itself, so this cannot pass silently.
      await seed({ question: 'Erste Frage der wartenden Aufgabe', taskId: TASK });
      const zweite = await seed({ question: 'Zweite Frage derselben Aufgabe', taskId: TASK });

      await signIn(context, page);
      await page.goto('/');

      const zeile = page.getByTestId(`blockiert-${TASK}`);
      await expect(zeile).toHaveCount(1);
      await expect(zeile).toContainText(TASK_TITLE);
      // §15's sentence, verbatim, naming the newer of the two questions.
      await expect(zeile).toContainText(`blockiert durch Entscheidung #${zweite.number}`);

      // The counter says tasks, and it says as many as there are rows.
      const zeilen = await page.getByTestId('blockierte-aufgaben').locator('> li').count();
      await expect(page.getByTestId('wartende-entscheidungen')).toContainText(
        zeilen === 1 ? '1 Aufgabe wartet' : `${zeilen} Aufgaben warten`,
      );

      // And the deep link lands on that card rather than on the overview.
      await page.getByTestId(`blockiert-link-${TASK}`).click();
      await expect(page.getByTestId(`eskalation-${zweite.number}`)).toBeVisible();
    });

    test('zeigt bei einer zweiten Antwort, was entschieden wurde, statt nur „nein"', async ({
      context,
      page,
    }) => {
      const item = await seed({ question: 'Wer bekommt den Ops-Alarm zuerst?' });
      await signIn(context, page);
      await page.goto(`/posteingang/${item.number}`);
      // Wait for the *open* card first. `page.goto` resolves on load, not on
      // the fetch this page makes afterwards, so without this the write below
      // can win the race and the card arrives already read-only — which is a
      // different case, and the one the next test covers.
      await expect(page.getByTestId(`antworten-${item.number}`)).toBeVisible();

      // Somebody else answers while this page stands open.
      await answerBehindTheBack(item.id, 'Gar nicht anfassen');

      await page.getByTestId(`option-${item.number}-0`).check();
      await page.getByTestId(`antworten-${item.number}`).click();

      const fehler = page.getByTestId(`antwort-fehler-${item.number}`);
      await expect(fehler).toBeVisible();
      await expect(fehler).toContainText('beantwortet');
      // The 409 carries the answered card so the page can show what it was —
      // a field with a stated purpose that used to be thrown away.
      await expect(page.getByTestId(`entschieden-${item.number}`)).toContainText(
        'Gar nicht anfassen',
      );
    });

    test('zeigt eine beantwortete Karte read-only statt eines Formulars, das nur 409 werden kann', async ({
      context,
      page,
    }) => {
      const item = await seed({ question: 'Bleibt die Wochenzahl bei 1120?' });
      await answerBehindTheBack(item.id, 'Auf einem Aufgabenzweig arbeiten');

      await signIn(context, page);
      await page.goto(`/posteingang/${item.number}`);

      await expect(page.getByTestId(`eskalation-${item.number}`)).toBeVisible();
      await expect(page.getByTestId(`entschieden-${item.number}`)).toContainText('Entschieden');
      // No form: neither the free-text box nor the submit button exists.
      await expect(page.getByTestId(`freitext-${item.number}`)).toHaveCount(0);
      await expect(page.getByTestId(`antworten-${item.number}`)).toHaveCount(0);
    });

    test('verweigert eine leere Antwort und eine Option samt Freitext', async ({
      context,
      page,
    }) => {
      const item = await seed({ question: 'Soll der Radar täglich oder wöchentlich laufen?' });
      await signIn(context, page);
      await page.goto(`/posteingang/${item.number}`);

      await page.getByTestId(`antworten-${item.number}`).click();
      await expect(page.getByTestId(`antwort-fehler-${item.number}`)).toContainText('leer');

      await page.getByTestId(`option-${item.number}-0`).check();
      await page.getByTestId(`freitext-${item.number}`).fill('aber bitte ohne Migration');
      await page.getByTestId(`antworten-${item.number}`).click();
      await expect(page.getByTestId(`antwort-fehler-${item.number}`)).toContainText(
        'Entweder eine Option',
      );

      // Nothing was written on either attempt.
      expect(await decisionRow(item.number)).toBeNull();
    });

    test('überlebt einen Pfad, den der Browser nicht dekodieren kann', async ({
      context,
      page,
    }) => {
      // `/posteingang/%` raises `URIError` inside `segmentAfter`, which runs during
      // render. Before the guard this blanked the entire dashboard — not the page,
      // the application: no heading, no navigation, no way back.
      await signIn(context, page);
      await page.goto('/posteingang/%25');
      await expect(page.getByTestId('navigation')).toBeVisible();
      await expect(page.getByTestId('eskalation-unbekannt')).toBeVisible();
    });

    test('bleibt ohne Sitzung verschlossen', async ({ page }) => {
      await page.goto('/posteingang');
      await expect(page.getByTestId('nav-posteingang')).toHaveCount(0);
      expect((await page.request.get('/api/posteingang')).status()).toBe(401);
      expect((await page.request.get('/api/entscheidungen')).status()).toBe(401);
      expect(
        (
          await page.request.post('/api/posteingang/1/antwort', { data: { optionIndex: 0 } })
        ).status(),
      ).toBe(401);
    });
  });
