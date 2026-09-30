import { execFileSync } from 'node:child_process';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createSql } from '@vorschicht/db';

/**
 * §17.2's office, in a browser, against the real API and real rows — and the one
 * exit gate that asks for a **measured** number.
 *
 * > "Office view reflects real state changes < 1s end-to-end (measured),
 * > including park/resume and escalation states."
 *
 * Three things about how that is measured here, because a number is only worth
 * what its arrangement is worth.
 *
 *   1. **The clock starts before the write and stops when the DOM says so.**
 *      `t0` is taken immediately before the two rows are inserted; the wait polls
 *      the desk's `data-kugel` every 10 ms. What the number therefore covers is
 *      the whole chain — Postgres trigger, `NOTIFY`, the hub's re-read, the SSE
 *      frame, the reducer, React's render — plus up to 10 ms of the test's own
 *      granularity. It is an upper bound on the truth, which is the direction a
 *      measurement of a promise should err in.
 *
 *   2. **The page must not be able to cheat.** `SCHNAPPSCHUSS_MS` is 30 s, so
 *      nothing here can be explained by the backstop poll: a run in which the
 *      stream is switched off cannot pass this file, and that mutation was
 *      executed rather than argued.
 *
 *   3. **The fixture writes what `TaskService.transition` writes, and the schema
 *      holds it to §9.** Two rows: `task_events` (whose trigger refuses a
 *      transition §9 does not draw, an out-of-order `seq`, or a park with no
 *      return point) and `event_log` (whose trigger fires the `NOTIFY` the hub
 *      listens on). Raw SQL rather than the service, following the rule
 *      `posteingang.spec.ts` states — a fixture built by the component under test
 *      can set the test up and pass it in the same move — and what is under test
 *      here is the *page*, whose producer is the `event_log` row.
 *
 * The other half of §17.2 settled here and nowhere else: with personas switched
 * off (§8's "fully disabled", A9) the room shows role labels and **no** person's
 * name — asserted as an absence, because that is what "fully" means.
 */

const WEB_PORT = process.env.E2E_WEB_PORT ?? '5173';
const API_PORT = process.env.E2E_API_PORT ?? '8421';

const SLUG = 'e2e-buero';
const TASK = '66666666-6666-4666-8666-666666666666';
const TASK_TITLE = 'Die Büro-Ansicht mit Leben füllen';
const LIVE_RUN = '66666666-6666-4666-8666-666666660001';
const DONE_RUN = '66666666-6666-4666-8666-666666660002';

/** The desk that carries every measurement: Clara, at that task. */
const CLARA = `platz-coder-${TASK}`;
/** And the one that proves a room is not a process list: Paul, handed over. */
const PAUL = `platz-planner-${TASK}`;

let sql: ReturnType<typeof createSql>;
let projectId: string;
let seq = 0;

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
  await page.getByTestId('label').fill('E2E-Büro');
  await page.getByTestId('register').click();
  await expect(page.getByTestId('logout')).toBeVisible();
}

/**
 * One §9 transition, written the way `TaskService.transition` writes it.
 *
 * The `task_events` row goes first because its trigger is the one that can
 * refuse: a transition the map does not draw, a `seq` out of order, a park with
 * no return point. Only once §9 has accepted the move does the `event_log` row
 * announce it — which is also the order that keeps the page from ever seeing a
 * frame about a transition the database rejected.
 */
async function wechsle(to: string, options: { resumeState?: string | null } = {}): Promise<void> {
  seq += 1;
  await sql`
    INSERT INTO task_events (task_id, project_id, seq, kind, actor, state, priority, resume_state, payload)
    VALUES (${TASK}, ${projectId}, ${seq}, 'state_changed', 'orchestrator', ${to}, 'P2',
            ${options.resumeState ?? null}, '{}'::jsonb)
  `;
  await sql`
    INSERT INTO event_log (kind, actor, project_id, task_id, run_id, deploy_id, payload)
    VALUES ('task.state_changed', 'orchestrator', ${projectId}, ${TASK}, NULL, NULL,
            ${sql.json({ to, reason: null } as never)})
  `;
}

/**
 * Write the transition, then wait for the room to show it — and return the
 * milliseconds in between.
 *
 * `polling: 10` rather than Playwright's default: at the default interval a
 * sub-second promise would be measured in units a fifth of its own budget, and
 * the number would mostly describe the poller. The `timeout` is the gate's own
 * figure, so the case fails on the promise rather than on an assertion after it.
 */
async function messeWechsel(
  page: Page,
  to: string,
  erwartet: string,
  options: { resumeState?: string | null } = {},
): Promise<number> {
  const t0 = Date.now();
  await wechsle(to, options);
  await page.waitForFunction(
    ([id, kugel]) =>
      document.querySelector(`[data-testid="${id}"]`)?.getAttribute('data-kugel') === kugel,
    [CLARA, erwartet],
    { polling: 10, timeout: 1000 },
  );
  return Date.now() - t0;
}

async function setzePersonaModus(page: Page, mode: string): Promise<void> {
  const antwort = await page.request.put('/api/einstellungen/personas', { data: { mode } });
  expect(antwort.status(), await antwort.text()).toBe(200);
}

test.beforeAll(async () => {
  sql = createSql({ url: process.env.TEST_DATABASE_URL ?? '', max: 3 });

  const rows = await sql<Array<{ id: string }>>`
    INSERT INTO projects (slug, name, root_path)
    VALUES (${SLUG}, 'E2E-Büro', '/tmp/e2e-buero')
    RETURNING id
  `;
  projectId = rows[0]?.id ?? '';
  expect(projectId).not.toBe('');

  // §9 refuses a task born anywhere but `draft`/`queued`, so the fixture walks
  // one to `coding` the way the studio would.
  await sql`
    INSERT INTO task_events (task_id, project_id, seq, kind, actor, state, priority, payload)
    VALUES (${TASK}, ${projectId}, 0, 'created', 'orchestrator', 'queued', 'P2',
      ${sql.json({ title: TASK_TITLE, department: 'entwicklung', type: 'feature' } as never)})
  `;
  for (const state of ['planning', 'claimed', 'coding']) await wechsle(state);

  // Paul finished and handed over; Clara is at it now. Two runs, one task, two
  // desks — which is the whole difference between a room and a process list.
  const vorhin = new Date(Date.now() - 9 * 60_000);
  const jetzt = new Date(Date.now() - 60_000);
  await sql`
    INSERT INTO agent_run_events (run_id, seq, kind, occurred_at, payload) VALUES
      (${DONE_RUN}, 0, 'created', ${vorhin},
        ${sql.json({ role: 'planner', taskId: TASK, model: 'test' } as never)}),
      (${DONE_RUN}, 1, 'started', ${vorhin}, ${sql.json({ sessionId: DONE_RUN } as never)}),
      (${DONE_RUN}, 2, 'terminated', ${vorhin}, ${sql.json({ reason: 'completed' } as never)}),
      (${LIVE_RUN}, 0, 'created', ${jetzt},
        ${sql.json({ role: 'coder', taskId: TASK, model: 'test' } as never)}),
      (${LIVE_RUN}, 1, 'started', ${jetzt}, ${sql.json({ sessionId: LIVE_RUN } as never)})
  `;
});

test.afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

test.describe
  .serial('Büro-Ansicht (§17.2) im Browser', () => {
    test('setzt jede aktive Persona an einen Schreibtisch, mit Zustand und Aufgabentitel', async ({
      context,
      page,
    }) => {
      await signIn(context, page);
      await page.goto('/buero');

      const clara = page.getByTestId(CLARA);
      await expect(clara).toBeVisible();
      await expect(clara).toHaveAttribute('data-kugel', 'arbeitet');
      // §17.2 verlangt die Kugel „mit dem Titel der aktuellen Aufgabe".
      await expect(page.getByTestId(`${CLARA}-zeile`)).toContainText('arbeitet');
      await expect(page.getByTestId(`${CLARA}-zeile`)).toContainText(TASK_TITLE);
      await expect(page.getByTestId(`${CLARA}-name`)).toHaveText('Clara');

      // Und der Platz, den eine Abfrage nach `NOT is_finished` verlieren würde:
      // Paul hat übergeben, sitzt aber noch im Raum und hält nichts in der Hand.
      const paul = page.getByTestId(PAUL);
      await expect(paul).toBeVisible();
      await expect(paul).toHaveAttribute('data-kugel', 'ruht');
      await expect(page.getByTestId(`${PAUL}-name`)).toHaveText('Paul');

      // Der Strom steht, bevor irgendetwas gemessen wird.
      await expect(page.getByTestId('buero-verbindung')).toHaveText('Live verbunden.');
    });

    /**
     * Das Gate. Drei Wechsel, drei Messungen, eine Mechanik.
     *
     * Park, Fortsetzung und Eskalation sind im Gate-Satz einzeln genannt und
     * laufen hier durch **denselben** Weg — ein `task.state_changed`-Rahmen, ein
     * Feld auf dem Schreibtisch, `deskState` entscheidet den Rest. Dass es eine
     * Mechanik ist, ist keine Abkürzung: drei getrennte Wege wären drei Stellen,
     * an denen eine Kugel stehenbleiben kann.
     */
    test('spiegelt Parken, Fortsetzen und Eskalation in unter einer Sekunde', async ({
      context,
      page,
    }, testInfo) => {
      await signIn(context, page);
      await page.goto('/buero');
      await expect(page.getByTestId(CLARA)).toHaveAttribute('data-kugel', 'arbeitet');
      await expect(page.getByTestId('buero-verbindung')).toHaveText('Live verbunden.');

      // §7.3: geparkt wird mit Rückkehrpunkt, sonst verweigert die Datenbank.
      const geparkt = await messeWechsel(page, 'parked', 'blockiert', { resumeState: 'coding' });
      const fortgesetzt = await messeWechsel(page, 'coding', 'arbeitet');
      const eskaliert = await messeWechsel(page, 'needs_decision', 'eskaliert', {
        resumeState: 'coding',
      });

      const zeilen = [
        `Parken:      ${geparkt} ms`,
        `Fortsetzen:  ${fortgesetzt} ms`,
        `Eskalation:  ${eskaliert} ms`,
      ].join('\n');
      // In die Ausgabe *und* in den Bericht: eine gemessene Zahl, die nur im
      // Terminal steht, ist beim nächsten Lauf weg.
      console.log(`\nBüro — Ereignis bis Bildschirm (§22 Phase 7, Gate 1):\n${zeilen}\n`);
      testInfo.annotations.push({ type: 'messung', description: zeilen.replace(/\n/g, ' · ') });

      for (const [was, ms] of [
        ['Parken', geparkt],
        ['Fortsetzen', fortgesetzt],
        ['Eskalation', eskaliert],
      ] as const) {
        expect(ms, `${was} brauchte ${ms} ms`).toBeLessThan(1000);
      }

      // Die Kugel ist kein Selbstzweck: „fragt nach" heißt, dass der Betreiber dran ist,
      // und genau dann bietet die Ansicht den Weg dorthin an.
      await page.getByTestId(CLARA).click();
      await expect(page.getByTestId('buero-detail-posteingang')).toHaveAttribute(
        'href',
        '/posteingang',
      );

      // Zurück auf `coding`, damit die folgenden Fälle von einem bekannten
      // Zustand aus lesen — diese Datei läuft `serial`.
      await messeWechsel(page, 'coding', 'arbeitet');
    });

    test('führt von einem Schreibtisch zur Aufgabe, die dort liegt (§17.2)', async ({
      context,
      page,
    }) => {
      await signIn(context, page);
      await page.goto('/buero');

      await expect(page.getByTestId('buero-detail')).toHaveCount(0);
      await page.getByTestId(CLARA).click();

      const detail = page.getByTestId('buero-detail');
      await expect(detail).toBeVisible();
      await expect(page.getByTestId('buero-detail-aufgabe')).toHaveText(TASK_TITLE);
      await expect(page.getByTestId('buero-detail-lauf')).toContainText('(läuft)');

      // §17.2s zweite Hälfte: „und ihre Spur". Der Explorer entsteht parallel;
      // geprüft wird deshalb nicht seine Seite, sondern dass dieser Punkt auf
      // **seine** Kennungen zeigt — eine falsche Vorlage („/aufgabe/", „/runs/")
      // fällt hier auf und nicht erst beim ersten Klick eines Menschen.
      await expect(page.getByTestId('buero-detail-aufgabe-link')).toHaveAttribute(
        'href',
        `/aufgaben/${TASK}`,
      );
      await expect(page.getByTestId('buero-detail-lauf-link')).toHaveAttribute(
        'href',
        `/laeufe/${LIVE_RUN}`,
      );
      await expect(detail).toContainText(SLUG);
      // Der Satz muss die Art der Blockade unterscheiden können — hier sagt er
      // schlicht, dass eine Sitzung läuft.
      await expect(page.getByTestId('buero-detail-begruendung')).toContainText('Sitzung');
    });

    /**
     * §8s „fully disabled" (A9), und die Zusicherung ist die **Abwesenheit**.
     *
     * Dass „Entwicklung" erscheint, könnte auch eine Ansicht behaupten, die den
     * Namen daneben stehen lässt. Was das Wort *fully* bedeutet, prüft nur die
     * Gegenrichtung: „Clara" kommt auf dieser Seite nirgends mehr vor.
     */
    test('zeigt bei abgeschalteten Personas Rollen statt Namen', async ({ context, page }) => {
      await signIn(context, page);
      await page.goto('/buero');
      await expect(page.getByTestId(`${CLARA}-name`)).toHaveText('Clara');

      try {
        await setzePersonaModus(page, 'aus');
        await page.reload();

        await expect(page.getByTestId(`${CLARA}-name`)).toHaveText('Entwicklung');
        await expect(page.getByTestId(`${PAUL}-name`)).toHaveText('Planung');
        const raum = page.getByTestId('buero-raum');
        await expect(raum).not.toContainText('Clara');
        await expect(raum).not.toContainText('Chris');
        await expect(raum).not.toContainText('Paul');
      } finally {
        // Die Voreinstellung ist global; sie hier zu lassen, hieße jede spätere
        // Suite unter einem Zustand laufen zu lassen, den sie nicht gesetzt hat.
        await setzePersonaModus(page, 'anzeige');
      }
    });
  });
