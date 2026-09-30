import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createSql } from '@vorschicht/db';
import { BUERO_PFAD } from '@vorschicht/shared/buero';

/**
 * §17.4's trace explorer in a browser, against the real API.
 *
 * Three things can only be settled here, and the first *is* §22's Phase 7 exit
 * gate:
 *
 *   * that the path from **a dot in the office view** to the exact transcript
 *     line of a decision is short enough. It is walked in one piece, starting
 *     on `/buero`, and every click is counted **by the browser** rather than by
 *     this file — see `zaehleKlicks`. Until 18.8.2026 the evidence for that gate
 *     was the shorter path from the task list plus a sentence claiming the dot
 *     leads to the same address. The sentence was true and was not a
 *     demonstration, and nothing in this repository could tell the difference
 *     (A76.4);
 *   * that transcript content is rendered as **text**. It is model output and
 *     foreign file content copied verbatim into a file, and a `<pre>` fed
 *     through `dangerouslySetInnerHTML` would execute it. Only a browser can
 *     tell the difference between a string and an element;
 *   * that the five availability answers survive the whole chain. Reader,
 *     adapter and page each get them right in their own suite; what none of
 *     those can show is that an *expired* transcript reaches the operator as "abgelaufen"
 *     rather than as an empty page.
 *
 * Conventions from `dokumente.spec.ts` and `quellen.spec.ts`, binding because
 * six Playwright projects share one database: fixtures are seeded through **raw
 * SQL** (`TraceReader` is the component under examination, and a fixture that
 * used a higher-level writer could seat a defect in it and pass in the same
 * run), every assertion is scoped to this file's own ids, and every count is a
 * relation rather than an absolute number.
 */

const WEB_PORT = process.env.E2E_WEB_PORT ?? '5173';
const API_PORT = process.env.E2E_API_PORT ?? '8421';

/**
 * §22 Phase 7, Gate 5: „in ≤ 4 clicks". Als Konstante, damit die Zahl an einer
 * Stelle steht und der Gate-Satz daneben — zwei Zweien in zwei Fällen wären
 * zwei Zahlen, die auseinanderlaufen können.
 */
const KLICKGRENZE = 4;

/** Must equal `VORSCHICHT_TRANSCRIPTS_ROOT` in `playwright.config.ts`. */
const TRANSKRIPTE = join(tmpdir(), 'vorschicht-e2e-transkripte');

/** Nonsense names, so every assertion is about this file and nothing else. */
const MARKE = randomUUID().slice(0, 8);
const PROJEKT_SLUG = `e2e-spuren-${MARKE}`;
const TITEL = `E2E Steinkauz ${MARKE}`;
const TITEL_ABGELAUFEN = `E2E Waldkauz ${MARKE}`;

/**
 * The seeded XSS attempt.
 *
 * A real transcript carries exactly this class of string: a model quoting a
 * file, a tool result containing markup. Rendered as markup it becomes an
 * element with a handler; rendered as text it is six words.
 */
const XSS = '<img src=x onerror="window.__spurenXss=1">';

const projektId = randomUUID();
const projektNurLesendId = randomUUID();
const taskId = randomUUID();
const taskAbgelaufenId = randomUUID();
const runId = randomUUID();
const runAbgelaufenId = randomUUID();
/**
 * The two runs that make the sharpest pair in this feature.
 *
 * `runFehlendId` ended three days ago and its file is not there; `runOhneId`
 * never had one. Together with `runAbgelaufenId` they are three absences that a
 * naive viewer renders identically, and only one of them is A15 working.
 */
const runFehlendId = randomUUID();
const runOhneId = randomUUID();

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

/**
 * A signed-in page, standing wherever the ceremony left it.
 *
 * Split out of `zurListe` because the click-path case below must not arrive at
 * the office through the task list — the gate counts from a dot in the office
 * view, and a helper that navigates on the way in would put a page in front of
 * the first click that the gate's sentence does not have.
 */
async function anmelden(context: BrowserContext, page: Page): Promise<void> {
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
  await page.getByTestId('label').fill('E2E-Spuren');
  await page.getByTestId('register').click();
  await expect(page.getByTestId('logout')).toBeVisible();
}

/** A signed-in page standing on the task list. */
async function zurListe(context: BrowserContext, page: Page): Promise<void> {
  await anmelden(context, page);
  await page.getByTestId('nav-aufgaben').click();
  await expect(page.getByTestId('spuren-filter')).toBeVisible();
}

/**
 * Count the clicks the **browser** saw, not the ones this file remembers.
 *
 * A counter kept in the test is bookkeeping: a later `click()` that nobody
 * increments leaves the number saying three while the path costs four, and no
 * assertion in this repository can see the difference — the only readers of a
 * printed figure are a human and the auditor (A76.4). This is the same class of
 * defect the old evidence line in this file carried, so the replacement is
 * built not to be able to carry it.
 *
 * A capture-phase listener on `document` counts every click before its default
 * action runs, and the tally lives in `sessionStorage` because one step of this
 * path is an `<a href>` — a real navigation, after which a counter in a page
 * variable would be back at zero. The listener is installed through
 * `addInitScript`, so it survives that load and re-arms itself on the page it
 * lands on.
 *
 * Deliberately counts *every* click, including one this file did not intend:
 * an over-count is a red case somebody reads, an under-count is a gate that
 * quietly measures a shorter path than the one a person walks.
 */
const KLICKZAEHLER = 'vorschicht-e2e-klicks';

/**
 * Der Lauscher selbst, einmal geschrieben und an zwei Stellen angebracht.
 *
 * `addInitScript` läuft nur auf **künftigen** Dokumenten. Der zweite Fall unten
 * navigiert über den Router (`pushState`, kein Dokumentwechsel), also wäre dort
 * nie ein Lauscher installiert worden — gemessen, nicht befürchtet: der erste
 * vollständige Lauf meldete dort `Expected: 2, Received: 0`. Gefangen hat es die
 * Gleichheit gegen die eigene Zählung, also genau die Zusicherung, für die sie
 * eingebaut wurde; ohne sie hätte die Zeile „0 Klicks" gedruckt und die Grenze
 * von vier mühelos eingehalten.
 *
 * Zwei Anbringungen und **eine** Deklaration: zwei Kopien wären A81s Klasse, und
 * hier würde die Abweichung als Zahl erscheinen statt als Fehler. Der Riegel auf
 * `window` verhindert, dass beide Wege auf demselben Dokument doppelt zählen.
 */
const KLICK_LAUSCHER = (schluessel: string) => {
  const fenster = window as unknown as { __vorschichtKlickLauscher?: boolean };
  if (fenster.__vorschichtKlickLauscher) return;
  fenster.__vorschichtKlickLauscher = true;
  if (sessionStorage.getItem(schluessel) === null) sessionStorage.setItem(schluessel, '0');
  document.addEventListener(
    'click',
    () => {
      const bisher = Number(sessionStorage.getItem(schluessel) ?? '0');
      sessionStorage.setItem(schluessel, String(bisher + 1));
    },
    true,
  );
};

async function zaehleKlicks(page: Page): Promise<void> {
  // Für jedes künftige Dokument …
  await page.addInitScript(KLICK_LAUSCHER, KLICKZAEHLER);
  // … und für das, das gerade offen ist.
  await page.evaluate(KLICK_LAUSCHER, KLICKZAEHLER);
}

async function setzeZaehlerZurueck(page: Page): Promise<void> {
  await page.evaluate((schluessel: string) => {
    sessionStorage.setItem(schluessel, '0');
  }, KLICKZAEHLER);
}

async function gezaehlteKlicks(page: Page): Promise<number> {
  return page.evaluate(
    (schluessel: string) => Number(sessionStorage.getItem(schluessel) ?? '-1'),
    KLICKZAEHLER,
  );
}

/**
 * The archived transcript, in the shape the CLI really writes.
 *
 * Line 4 is the escalation: one `tool_use` block carrying the MCP wire name of
 * `escalate.ask`. That is what the jump resolves against, mechanically — a tool
 * name is exact, which is why the mark is derived rather than searched for.
 */
async function schreibeTranskript(pfad: string): Promise<void> {
  const zeilen = [
    JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [], tools: [] }),
    JSON.stringify({ type: 'mode', mode: 'default' }),
    JSON.stringify({
      type: 'assistant',
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: XSS }] },
    }),
    JSON.stringify({
      type: 'assistant',
      message: {
        id: 'm2',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            name: 'mcp__vorschicht__escalate_ask',
            input: { question: `Welche Option, ${MARKE}?` },
          },
        ],
      },
    }),
    JSON.stringify({ type: 'result', is_error: false, result: 'fertig' }),
  ];
  await mkdir(join(pfad, '..'), { recursive: true });
  await writeFile(pfad, `${zeilen.join('\n')}\n`, 'utf8');
}

const TRANSKRIPT_PFAD = join(TRANSKRIPTE, '2026-08-01', `${runId}.jsonl`);
/** Deliberately never written: the run is old enough for A15 to have removed it. */
const ABGELAUFEN_PFAD = join(TRANSKRIPTE, '2025-01-05', `${runAbgelaufenId}.jsonl`);

async function seedRun(
  id: string,
  task: string,
  pfad: string | null,
  endedAt: string,
  problem: string | null = null,
): Promise<void> {
  await sql`
    INSERT INTO agent_run_events (run_id, seq, kind, occurred_at, payload) VALUES (
      ${id}, 0, 'created', ${endedAt}::timestamptz,
      ${sql.json({
        taskId: task,
        role: 'coder',
        model: 'sonnet-class',
        backend: 'headless',
        cwd: '/data/worktrees/e2e',
        caps: { maxTurns: 40, maxBudgetUsd: 16, wallClockMs: 5_400_000 },
      })})`;
  await sql`
    INSERT INTO agent_run_events (run_id, seq, kind, occurred_at, payload) VALUES (
      ${id}, 1, 'started', ${endedAt}::timestamptz, ${sql.json({ sessionId: `sess-${MARKE}` })})`;
  await sql`
    INSERT INTO agent_run_events (run_id, seq, kind, occurred_at, payload) VALUES (
      ${id}, 2, 'terminated', ${endedAt}::timestamptz,
      ${sql.json({ reason: 'completed', exitCode: 0, transcriptPath: pfad, transcriptProblem: problem })})`;
}

test.beforeAll(async () => {
  sql = createSql({ url: process.env.TEST_DATABASE_URL ?? '', max: 2 });

  await sql`
    INSERT INTO projects (id, slug, name, root_path, default_branch)
    VALUES (${projektId}, ${PROJEKT_SLUG}, ${`E2E Spuren ${MARKE}`}, '/opt/e2e-spuren', 'main')`;

  // Ein zweites Projekt, nur-lesend, für die Ablehnung des Anlegeformulars.
  // Es muss ein echtes sein: A85 hält Vorschichts eigenes so, und das ist der
  // Zustand, in dem eine angenommene Aufgabe für immer in `queued` stünde.
  await sql`
    INSERT INTO projects (id, slug, name, root_path, default_branch, read_only)
    VALUES (${projektNurLesendId}, ${`${PROJEKT_SLUG}-ro`}, ${`E2E Nurlesend ${MARKE}`},
            '/opt/e2e-spuren-ro', 'main', true)`;

  // The task whose timeline carries the decision. `escalation_requested` names
  // the run that asked — that link is what keeps the path short enough.
  const seedTask = async (id: string, titel: string) => {
    await sql`
      INSERT INTO task_events (task_id, seq, kind, project_id, state, priority, actor, payload)
      VALUES (${id}, 0, 'created', ${projektId}, 'queued', 'P1', 'produktleitung',
              ${sql.json({ title: titel, description: 'Von der E2E-Suite gesät.', acceptanceCriteria: ['nachvollziehbar sein'] })})`;
    await sql`
      INSERT INTO task_events (task_id, seq, kind, project_id, state, priority, actor, payload)
      VALUES (${id}, 1, 'state_changed', ${projektId}, 'planning', 'P1', 'orchestrator',
              ${sql.json({ reason: 'Planung beginnt' })})`;
  };

  await seedTask(taskId, TITEL);
  await sql`
    INSERT INTO task_events (task_id, seq, kind, project_id, state, priority, actor, payload)
    VALUES (${taskId}, 2, 'escalation_requested', ${projektId}, 'planning', 'P1', 'planner',
            ${sql.json({ runId, question: `Welche Option, ${MARKE}?` })})`;

  await seedTask(taskAbgelaufenId, TITEL_ABGELAUFEN);
  await sql`
    INSERT INTO task_events (task_id, seq, kind, project_id, state, priority, actor, payload)
    VALUES (${taskAbgelaufenId}, 2, 'escalation_requested', ${projektId}, 'planning', 'P1', 'planner',
            ${sql.json({ runId: runAbgelaufenId, question: 'alt' })})`;

  await schreibeTranskript(TRANSKRIPT_PFAD);
  await seedRun(runId, taskId, TRANSKRIPT_PFAD, '2026-08-01T09:00:00Z');
  // Ended long enough ago that A15's archive window has closed, and its file was
  // never written — which is what "the retention job removed it" looks like.
  await seedRun(
    runAbgelaufenId,
    taskAbgelaufenId,
    ABGELAUFEN_PFAD,
    new Date(Date.now() - 400 * 86_400_000).toISOString(),
  );
  // Three days old and its file is not there. Same filesystem state as the run
  // above, opposite meaning — and only the age separates them.
  await seedRun(
    runFehlendId,
    taskId,
    join(TRANSKRIPTE, '2026-08-01', `${runFehlendId}.jsonl`),
    new Date(Date.now() - 3 * 86_400_000).toISOString(),
  );
  // And one that never had a transcript at all, with §6.2's recorded reason.
  await seedRun(
    runOhneId,
    taskId,
    null,
    new Date(Date.now() - 3 * 86_400_000).toISOString(),
    'Das Backend führt kein Sitzungsprotokoll.',
  );
});

/**
 * What can be cleaned up, and what deliberately cannot.
 *
 * `task_events` and `agent_run_events` are append-only and the guard triggers
 * refuse a DELETE from anyone, the owner included (0004, 0006). The first
 * version of this teardown tried anyway and the database answered
 * *"Tabelle agent_run_events ist append-only (§5/§18): DELETE ist nicht
 * erlaubt"* — which is the guarantee this whole page exists to make readable,
 * working. The rows stay; they are scoped to ids nothing else in this suite
 * names, and the database is a throwaway. `projects` is the one mutable table
 * (§5) and is removed, so no later reader sees a project that was never real.
 */
test.afterAll(async () => {
  await sql`DELETE FROM projects WHERE id = ${projektId}`;
  await sql.end({ timeout: 5 });
  await rm(join(TRANSKRIPTE, '2026-08-01'), { recursive: true, force: true });
});

test('die Liste zeigt die gesäte Aufgabe und lässt sich filtern', async ({ context, page }) => {
  await zurListe(context, page);

  const zeile = page.getByTestId('spuren-zeile').filter({ hasText: TITEL });
  await expect(zeile).toHaveCount(1);
  await expect(zeile).toContainText(PROJEKT_SLUG);
  await expect(zeile).toContainText('In Planung');
  await expect(zeile).toContainText('P1 — dringend');

  // Narrowing to a state this task is not in must remove it — a filter that
  // widens or does nothing looks identical to one that works, on a list this
  // short.
  await page.getByTestId('filter-zustand').selectOption('done');
  await expect(page.getByTestId('spuren-zeile').filter({ hasText: TITEL })).toHaveCount(0);

  await page.getByTestId('filter-zuruecksetzen').click();
  await expect(page.getByTestId('spuren-zeile').filter({ hasText: TITEL })).toHaveCount(1);
});

/**
 * §22 Phase 7, Gate 5 — und der Weg beginnt da, wo der Gate-Satz beginnt.
 *
 * > "Full drill-down demo: from a dot in the office view to the exact
 * > transcript line of a decision in ≤ 4 clicks"
 *
 * Bis zum 18.8.2026 stand der Nachweis dafür eine Ebene tiefer: der Fall
 * darunter beginnt in der **Aufgabenliste** und druckte trotzdem
 * `Klickpfad Büro-Punkt → Transkriptzeile`. Die Begründung war, dass der Punkt
 * im Büro auf dieselbe Adresse zeigt wie die Zeile der Liste — was stimmt und
 * ein **Argument** ist, keine Vorführung: der Sprung Punkt → Aufgabe lag in
 * `buero.spec.ts` und wurde dort nie geklickt, sondern als `href` gelesen. Zwei
 * Hälften in zwei Dateien, dazwischen ein Satz. Keine Zusicherung im Repository
 * konnte das sehen; gelesen wird so eine Zeile nur von einem Menschen oder vom
 * Prüfer (A76.4).
 *
 * Dieser Fall geht den Weg in einem Stück:
 *
 *   /buero → Platz anklicken → „Aufgabe öffnen" → „Zur Entscheidung im
 *   Sitzungsprotokoll" → die hervorgehobene Zeile
 *
 * Drei Klicks von vier erlaubten, und die drei sind **gemessen** (siehe
 * `zaehleKlicks`), nicht mitgeschrieben. Die eigene Zählung steht daneben und
 * muss mit der gemessenen übereinstimmen — die Gleichheit ist die Zusicherung,
 * die einen später eingefügten Klick auffallen lässt, auch wenn niemand die
 * Variable erhöht.
 *
 * Was am Ende steht, ist ausdrücklich nicht „die Seite" und nicht „die Liste",
 * sondern **die** Zeile: die, auf der die Sitzung `escalate.ask` gerufen hat,
 * mit der Frage, die sie gestellt hat.
 */
test('vom Punkt im Büro zur genauen Transkriptzeile — durchgehend, in gemessenen Klicks', async ({
  context,
  page,
}) => {
  await anmelden(context, page);
  await zaehleKlicks(page);

  await page.goto(BUERO_PFAD);
  // Der Platz, den die Aufgabe dieser Datei im Raum belegt (§17.2: ein Sitz ist
  // (Rolle, Aufgabe)). Er trägt den Punkt, von dem der Gate-Satz ausgeht.
  const platz = page.getByTestId(`platz-coder-${taskId}`);
  await expect(platz).toBeVisible();

  // Erst hier auf null: die Anmeldung oben kostet einen Klick, der nicht zum
  // Weg gehört, und `page.goto` ist kein Klick, sondern das Öffnen der App.
  await setzeZaehlerZurueck(page);
  let klicks = 0;

  await platz.click();
  klicks += 1;

  const aufgabenLink = page.getByTestId('buero-detail-aufgabe-link');
  // Dieselbe Adresse, die `buero.spec.ts` als `href` liest — hier wird sie
  // wirklich benutzt, was der Unterschied zwischen den beiden Nachweisen ist.
  await expect(aufgabenLink).toHaveAttribute('href', `/aufgaben/${taskId}`);
  await aufgabenLink.click();
  klicks += 1;
  // Ein echter Seitenwechsel (ein `<a href>`, kein Router-Aufruf): die Zählung
  // muss ihn überleben, und `sessionStorage` ist der Grund, warum sie es tut.
  await expect(page.getByTestId('aufgabe-zustand')).toHaveText('In Planung');

  await page.getByTestId('zur-entscheidungszeile').click();
  klicks += 1;

  const fokus = page.getByTestId('transkript-zeile-fokus');
  await expect(fokus).toHaveCount(1);
  await expect(fokus).toContainText('mcp__vorschicht__escalate_ask');
  await expect(fokus).toContainText(`Welche Option, ${MARKE}?`);
  await expect(fokus).toHaveAttribute('data-nr', '4');

  const gemessen = await gezaehlteKlicks(page);
  console.log(
    `Klickpfad Büro-Punkt → Transkriptzeile: ${gemessen} Klicks (Grenze ${KLICKGRENZE}), ` +
      `Weg: Platz → Aufgabe öffnen → Zur Entscheidung im Sitzungsprotokoll`,
  );

  // Zuerst die Gleichheit: sie fängt einen Klick, den jemand später einfügt,
  // ohne die Variable zu erhöhen. Danach erst die Grenze des Gates.
  expect(gemessen, 'der Browser hat andere Klicks gezählt als dieser Fall').toBe(klicks);
  expect(gemessen).toBeLessThanOrEqual(KLICKGRENZE);
});

/**
 * Der zweite Einstieg in denselben Endpunkt: die Aufgabenliste.
 *
 * Er ist **nicht** der Gate-Nachweis — das ist der Fall darüber — und trägt
 * deshalb seit dem 18.8.2026 auch nicht mehr dessen Satz in der Ausgabe. Was er
 * belegt, ist die Abkürzung, die §17.4 zusätzlich anbietet: wer schon in der
 * Liste steht, ist mit zwei Klicks an derselben Zeile.
 */
test('von der Aufgabenliste zur genauen Transkriptzeile einer Entscheidung — in gezählten Klicks', async ({
  context,
  page,
}) => {
  await anmelden(context, page);
  await zaehleKlicks(page);
  await page.getByTestId('nav-aufgaben').click();
  await expect(page.getByTestId('spuren-filter')).toBeVisible();
  await setzeZaehlerZurueck(page);

  let klicks = 0;

  await page
    .getByTestId('spuren-zeile')
    .filter({ hasText: TITEL })
    .getByTestId('spur-oeffnen')
    .click();
  klicks += 1;
  await expect(page.getByTestId('aufgabe-zustand')).toHaveText('In Planung');

  await page.getByTestId('zur-entscheidungszeile').click();
  klicks += 1;

  const fokus = page.getByTestId('transkript-zeile-fokus');
  await expect(fokus).toHaveCount(1);
  // Not merely "a line is highlighted": *the* line, the one on which the session
  // called `escalate.ask`, carrying the question it asked.
  await expect(fokus).toContainText('mcp__vorschicht__escalate_ask');
  await expect(fokus).toContainText(`Welche Option, ${MARKE}?`);
  await expect(fokus).toHaveAttribute('data-nr', '4');

  const gemessen = await gezaehlteKlicks(page);
  console.log(`Klickpfad Aufgabenliste → Transkriptzeile: ${gemessen} Klicks`);
  expect(gemessen, 'der Browser hat andere Klicks gezählt als dieser Fall').toBe(klicks);
  expect(gemessen).toBeLessThanOrEqual(KLICKGRENZE);
});

test('Transkriptinhalt wird als Text dargestellt, nicht als Markup', async ({ context, page }) => {
  await zurListe(context, page);
  await page.goto(`/laeufe/${runId}`);
  await expect(page.getByTestId('transkript')).toBeVisible();

  const transkript = page.getByTestId('transkript');

  // The literal string arrives — six words, not an element.
  await expect(transkript).toContainText(XSS);
  // And nothing was built out of it. Both halves are needed: the text could be
  // present *and* an element could have been created alongside it.
  await expect(transkript.locator('img')).toHaveCount(0);
  expect(
    await page.evaluate(() => (window as unknown as { __spurenXss?: number }).__spurenXss),
  ).toBeUndefined();
});

test('ein abgelaufenes Sitzungsprotokoll sagt, dass es abgelaufen ist', async ({
  context,
  page,
}) => {
  await zurListe(context, page);
  await page.goto(`/laeufe/${runAbgelaufenId}`);

  const kopf = page.getByTestId('transkript-kopf');
  await expect(kopf).toContainText('abgelaufen');
  // The distinction this whole feature is built on: A15 removing a file on
  // purpose must not look like a file that is missing, and neither may look like
  // an empty page.
  await expect(kopf).toContainText('Ereignisprotokoll');
  await expect(kopf).not.toContainText('enthält keine Zeile');
  await expect(page.getByTestId('transkript')).toHaveCount(0);
});

test('ein fehlendes Protokoll heißt „Lücke im Nachweis" und ausdrücklich nicht „abgelaufen"', async ({
  context,
  page,
}) => {
  await zurListe(context, page);
  await page.goto(`/laeufe/${runFehlendId}`);

  const kopf = page.getByTestId('transkript-kopf');
  // The sharper half of the pair, end to end. The file is absent exactly as it
  // is for the expired run one test above; what differs is the run's age, and
  // the whole chain — reader, adapter, page — has to carry that difference all
  // the way to this sentence. One is A15 doing its job, the other is a hole in
  // the evidence §18 promises, and calling the second one "abgelaufen" would
  // explain away a lost record with a policy that did not cause it.
  await expect(kopf).toContainText('Lücke im Nachweis');
  await expect(kopf).not.toContainText('abgelaufen');
  await expect(kopf).not.toContainText('enthält keine Zeile');
  await expect(page.getByTestId('transkript')).toHaveCount(0);
});

test('ein nie archiviertes Protokoll nennt den aufgezeichneten Grund', async ({
  context,
  page,
}) => {
  await zurListe(context, page);
  await page.goto(`/laeufe/${runOhneId}`);

  const kopf = page.getByTestId('transkript-kopf');
  // §6.2 records *why* on the run's `terminated` event precisely so a later
  // reader finds out instead of finding nothing. The third distinct absence.
  await expect(kopf).toContainText('kein Sitzungsprotokoll archiviert');
  await expect(kopf).toContainText('Das Backend führt kein Sitzungsprotokoll.');
  await expect(kopf).not.toContainText('abgelaufen');
  await expect(kopf).not.toContainText('Lücke im Nachweis');
});

test('die Sitzung zeigt Rolle, Kappen und Ausgang und führt zur Aufgabe zurück', async ({
  context,
  page,
}) => {
  await zurListe(context, page);
  await page.goto(`/laeufe/${runId}`);

  await expect(page.getByTestId('lauf-kappen')).toContainText('40 Züge');
  await expect(page.getByTestId('lauf-kappen')).toContainText('16 USD-Äquivalent');
  await expect(page.getByTestId('lauf-ausgang')).toHaveText('abgeschlossen');

  await page.getByTestId('zur-aufgabe').click();
  await expect(page.getByTestId('aufgabe-kopf')).toContainText(PROJEKT_SLUG);
});

test('die Sprungmarken führen zu einzelnen Zeilen, und die Buchführung lässt sich ausblenden', async ({
  context,
  page,
}) => {
  await zurListe(context, page);
  await page.goto(`/laeufe/${runId}`);

  // Five lines seeded; one of them is a `mode` bookkeeping row.
  await expect(page.getByTestId('transkript-kopf')).toContainText('5 Zeilen');
  await expect(page.getByTestId('transkript-zeile')).toHaveCount(5);

  await page.getByTestId('nur-gespraech').check();
  await expect(page.getByTestId('verborgene-zeilen')).toContainText('2 Protokollzeilen');
  await expect(page.getByTestId('transkript-zeile')).toHaveCount(3);

  await page.getByTestId('nur-gespraech').uncheck();
  await page.getByTestId('transkript-marke').filter({ hasText: 'Zeile 5' }).click();
  await expect(page.getByTestId('transkript-zeile-fokus')).toHaveAttribute('data-nr', '5');
});

test('ein Verweis auf eine Zeile, die es nicht gibt, sagt das statt still Seite 1 zu zeigen', async ({
  context,
  page,
}) => {
  await zurListe(context, page);
  // There is exactly one decision in this transcript, so ask for a kind that is
  // not in it at all.
  await page.goto(`/laeufe/${runId}?marke=error`);

  await expect(page.getByTestId('transkript-sprungfehler')).toContainText('keine Zeile der Art');
  // The transcript itself is still shown — the link was wrong, the run was not.
  await expect(page.getByTestId('transkript')).toBeVisible();
});

test('eine kaputte Kennung ist ein kaputter Link, keine leere Liste', async ({ context, page }) => {
  await zurListe(context, page);
  await page.goto('/aufgaben/kaputt');

  // A81.5: showing the whole list here would read as "your task is gone".
  await expect(page.getByTestId('spur-unbekannt')).toContainText('keine Aufgabenkennung');
  await expect(page.getByTestId('spuren-tabelle')).toHaveCount(0);
});

test('der Vergleich wird erst auf Anforderung geholt und nennt seine Grundlage', async ({
  context,
  page,
}) => {
  await zurListe(context, page);
  await page.goto(`/aufgaben/${taskId}`);

  // Not loaded eagerly: it shells out to git, and a timeline nobody scrolls
  // should not pay for it.
  await expect(page.getByTestId('diff')).toHaveCount(0);
  await page.getByTestId('diff-laden').click();

  // This task has never merged, has no gate run and no branch, so the honest
  // answer is that there is no comparable state — named, never an empty patch.
  await expect(page.getByTestId('diff-kopf')).toContainText('kein Merge');
});

/*
 * §17.4s andere Hälfte: die Tür, durch die Arbeit hereinkommt.
 *
 * Nur hier prüfbar, und zwar als **Kette**: Formular → Route → eine Transaktion
 * → `task_events` → Liste. Jede Attrappe auf einer Zwischenstation liesse den
 * Fall bestehen, während in Wirklichkeit nichts geschrieben wurde — und die
 * tragende Zusicherung ist ohnehin eine, die kein Unittest stellen kann: dass
 * §19s Prüfzeile **die Sitzung** als Urheber trägt und nicht `system`. Ein
 * Prüfpfad, in dem jede Aufgabe von `system` stammt, beantwortet *dass* etwas
 * geschah und verliert die Frage, für die er geführt wird (A75.3).
 */

const NEUE_AUFGABE = `E2E Sperber ${MARKE}`;

test('legt eine Aufgabe über das Formular an — und §19s Zeile trägt die Sitzung', async ({
  context,
  page,
}) => {
  await zurListe(context, page);

  // Der Akteur, den diese Sitzung wirklich hält — nicht einer, den dieser Test
  // sich ausdenkt. Ohne das prüft die Zusicherung unten eine Zeichenkette.
  const me = (await (await page.request.get('/api/me')).json()) as {
    session: { userId: string } | null;
  };
  const sitzungsnutzer = me.session?.userId;
  expect(sitzungsnutzer, 'die Sitzung nennt keinen Nutzer').toBeTruthy();

  await page.getByTestId('aufgabe-anlegen').click();
  await page.getByTestId('aufgabe-projekt').selectOption(projektId);
  await page.getByTestId('aufgabe-titel').fill(NEUE_AUFGABE);
  await page
    .getByTestId('aufgabe-kriterien')
    .fill('Die Ablage legt die Bytes unverändert ab.\nEin zweiter Abruf legt nichts Neues an.');
  await page.getByTestId('aufgabe-prioritaet').selectOption('P1');
  await page.getByTestId('aufgabe-absenden').click();

  await expect(page.getByTestId('aufgabe-angelegt')).toContainText(NEUE_AUFGABE);

  // In der Liste dahinter, ohne Neuladen: das Formular stösst die Liste an.
  await expect(page.getByTestId('spuren-tabelle')).toContainText(NEUE_AUFGABE);

  // Die Zeile in `task_events` — mit beiden Kriterien, weil §8.1 den Planner
  // daran arbeiten lässt und ein leeres Feld dort eine Aufgabe ohne Mandat ist.
  const [zeile] = await sql<
    { task_id: string; actor: string; payload: { title: string; acceptanceCriteria: string[] } }[]
  >`
    SELECT task_id, actor, payload FROM task_events
    WHERE kind = 'created' AND payload ->> 'title' = ${NEUE_AUFGABE}`;
  expect(zeile).toBeDefined();
  expect(zeile?.payload.acceptanceCriteria).toHaveLength(2);

  // §19: die Prüfzeile, mit **dieser** Sitzung als Urheber.
  const [pruefung] = await sql<{ actor: string; subject: string }[]>`
    SELECT actor, subject FROM audit_log
    WHERE action = 'task.created' AND subject = ${zeile?.task_id ?? ''}`;
  expect(pruefung).toBeDefined();
  expect(pruefung?.actor).toBe(`dashboard:${sitzungsnutzer}`);
  expect(pruefung?.actor).not.toBe('system');
});

test('weist ein nur-lesendes Projekt ab — und legt nichts an', async ({ context, page }) => {
  await zurListe(context, page);

  const titel = `E2E Habicht ${MARKE}`;
  await page.getByTestId('aufgabe-anlegen').click();
  await page.getByTestId('aufgabe-projekt').selectOption(projektNurLesendId);

  // Der Hinweis steht **vor** dem Absenden da, damit niemand ein Formular
  // ausfüllt, dessen Einreichung nie gelingen kann.
  await expect(page.getByTestId('aufgabe-nur-lesend')).toContainText('nur-lesend');

  await page.getByTestId('aufgabe-titel').fill(titel);
  await page.getByTestId('aufgabe-kriterien').fill('Läuft.');
  await page.getByTestId('aufgabe-absenden').click();

  await expect(page.getByTestId('aufgabe-fehler')).toContainText('nimmt keine Arbeit an');

  // Die tragende Hälfte: nichts geschrieben. Eine Route, die 409 meldet und
  // trotzdem anlegt, bestünde jede Prüfung, die nur den Status liest.
  const zeilen = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM task_events WHERE payload ->> 'title' = ${titel}`;
  expect(zeilen[0]?.n).toBe(0);
});

test('verlangt mindestens ein Akzeptanzkriterium, bevor irgendetwas entsteht', async ({
  context,
  page,
}) => {
  await zurListe(context, page);

  const titel = `E2E Milan ${MARKE}`;
  await page.getByTestId('aufgabe-anlegen').click();
  await page.getByTestId('aufgabe-projekt').selectOption(projektId);
  await page.getByTestId('aufgabe-titel').fill(titel);
  await page.getByTestId('aufgabe-absenden').click();

  await expect(page.getByTestId('aufgabe-fehler')).toContainText('Akzeptanzkriterium');

  const zeilen = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM task_events WHERE payload ->> 'title' = ${titel}`;
  expect(zeilen[0]?.n).toBe(0);
});
