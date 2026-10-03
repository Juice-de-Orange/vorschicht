/**
 * §17.1 — der Verlauf auf der Übersicht ist wirklich live (A123).
 *
 * Warum dieser Fall existiert: `Overview.tsx` benutzte seit Phase 1
 * `source.onmessage`, während `formatEvent` auf **jeden** Rahmen
 * `event: <art>` schreibt. Nach der EventSource-Spezifikation feuert
 * `onmessage` nur für Rahmen des Typs `message` — die Seite war also
 * verbunden und empfing nichts. Sie zeigte „Verlauf (live)" über einer Liste
 * mit „Noch nichts passiert.", und **kein einziger Test im Repository wurde
 * davon rot**: die Serverseite ist unit-getestet (`sse.test.ts` fixiert die
 * Rahmennamen sogar ausdrücklich), die Clientseite hatte nichts.
 *
 * Ein Signalpfad, der verbunden aussieht und nichts trägt, ist §8.2s sechste
 * Domäne — hier auf der Seite, die ohne einen Klick beantworten soll, ob alles
 * in Ordnung ist. „Live" über einer leeren Liste ist von „es passiert gerade
 * nichts" nicht zu unterscheiden.
 *
 * Der Fall schreibt deshalb ein **echtes** Ereignis in die Datenbank — nicht in
 * den Strom — und wartet darauf, dass es im Browser erscheint. Damit ist die
 * ganze Kette geprüft: `event_log` → NOTIFY → SSE-Nabe → Rahmen → Abonnement →
 * Liste. Jede Attrappe auf einer der Zwischenstationen hätte den Defekt
 * überlebt.
 */
import { execFileSync } from 'node:child_process';
import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import { createSql } from '@vorschicht/db';

const sql = createSql({ url: process.env.TEST_DATABASE_URL ?? '', max: 1 });

test.afterAll(async () => {
  await sql?.end({ timeout: 5 });
});

const WEB_PORT = process.env.E2E_WEB_PORT ?? '5173';
const API_PORT = process.env.E2E_API_PORT ?? '8421';

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
  await page.getByTestId('label').fill('E2E-Ueberblick');
  await page.getByTestId('register').click();
  await expect(page.getByTestId('logout')).toBeVisible();
}

test.describe('Überblick (§17.1) — der Verlauf ist live', () => {
  test('zeigt ein Ereignis, das währenddessen in die Datenbank geschrieben wird', async ({
    context,
    page,
  }) => {
    await signIn(context, page);

    // Die Übersicht ist die Startseite; die Verbindung muss stehen, bevor
    // gesät wird — sonst prüft der Fall den Nachhol-Pfad statt des Live-Pfads,
    // und der ist eine andere Zusicherung.
    await expect(page.getByTestId('verlauf-verbindung')).toContainText('live', {
      timeout: 15_000,
    });

    const marke = `a123-${Date.now()}`;
    const begonnen = Date.now();
    await sql`
      INSERT INTO event_log (kind, actor, payload)
      VALUES ('system.started', ${marke}, '{}'::jsonb)
    `;

    // Die tragende Zusicherung: die Zeile erscheint, ohne dass die Seite neu
    // geladen wird. Der 30-Sekunden-Rückfall in Overview.tsx lädt nur die
    // Kennzahlen nach, nicht den Verlauf — der Verlauf kann also nur über den
    // Strom kommen.
    await expect(page.getByTestId('feed')).toContainText(marke, { timeout: 10_000 });
    const gebraucht = Date.now() - begonnen;
    console.log(`  [A123] Ereignis im Browser nach ${gebraucht} ms`);
    expect(gebraucht).toBeLessThan(10_000);
  });
});

/**
 * §17.1s drei fehlende Abschnitte: Merge-Queue, letzte Rollouts, Gesundheit.
 *
 * Alle drei werden **roh über SQL** gesät und nicht über ihre Dienste. Der
 * Grund ist derselbe, den `projekte.spec.ts` für `DeployRecords` gibt: der
 * Dienst ist der geprüfte Erzeuger, und eine Fixture, die ihn benutzt, kann
 * einen Fehler in ihm aufsetzen und im selben Zug bestehen lassen.
 *
 * Eine Sitzung für alle drei Fälle (`zugaenglichkeit.spec.ts`' Anordnung und
 * deren Begründung): jede Anmeldung legt einen weiteren Passkey an, den
 * `/register/options` danach jeder folgenden als `excludeCredentials`
 * beilegt — die Kette wird also mit jeder Registrierung langsamer.
 */
const QUEUE_PROJEKT = 'e2e-ueberblick';
const QUEUE_TASK = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const QUEUE_TITEL = 'Merge-Queue auf der Übersicht zeigen';

/** §9s Weg bis `merge_queue`, Zustand für Zustand — der Trigger prüft die Kanten. */
const WEG_ZUR_QUEUE = ['planning', 'claimed', 'coding', 'review', 'gates', 'merge_queue'] as const;

/**
 * Ein abgeschlossener Rollout in `deployment_events`.
 *
 * `occurred_at` wird gesetzt statt der Vorgabe überlassen: die Übersicht
 * sortiert nach `started_at` und deckelt bei fünf, und zwei Zeilen aus
 * derselben Millisekunde machten die Auflösung des Rollback-Ziels zu einem
 * Münzwurf.
 */
async function saeRollout(input: {
  projectId: string;
  minute: number;
  sha: string;
  artifact: string;
  outcome: 'succeeded' | 'rolled_back';
  rolledBackTo?: string;
}): Promise<string> {
  const [row] = await sql<Array<{ id: string }>>`SELECT gen_random_uuid() AS id`;
  const id = row?.id ?? '';
  expect(id).not.toBe('');
  const start = new Date(Date.UTC(2026, 7, 18, 9, input.minute)).toISOString();
  const ende = new Date(Date.UTC(2026, 7, 18, 9, input.minute, 30)).toISOString();
  const schritte: Array<[string, Record<string, unknown>, string]> = [
    [
      'started',
      { projectId: input.projectId, taskId: null, sha: input.sha, method: 'compose' },
      start,
    ],
    ['swapped', { artifact: input.artifact }, start],
    [input.outcome, input.rolledBackTo ? { rolledBackTo: input.rolledBackTo } : {}, ende],
  ];
  for (const [seq, [kind, payload, at]] of schritte.entries()) {
    await sql`
      INSERT INTO deployment_events (deployment_id, seq, kind, actor, occurred_at, payload)
      VALUES (${id}, ${seq}, ${kind}, 'e2e', ${at}, ${sql.json(payload as never)})
    `;
  }
  return id;
}

test.describe
  .serial('Überblick (§17.1) — Merge-Queue, Rollouts, Gesundheit', () => {
    let sitzung: BrowserContext;
    let seite: Page;
    let projectId = '';
    let gutesRollout = '';
    let rollbackRollout = '';

    test.beforeAll(async ({ browser }) => {
      const [projekt] = await sql<Array<{ id: string }>>`
      INSERT INTO projects (slug, name, root_path, deploy_config)
      VALUES (${QUEUE_PROJEKT}, 'E2E-Überblick', '/tmp/e2e-ueberblick',
              '{"method":"compose"}'::jsonb)
      RETURNING id
    `;
      projectId = projekt?.id ?? '';
      expect(projectId).not.toBe('');

      await sql`
      INSERT INTO task_events (task_id, project_id, seq, kind, actor, state, priority, payload)
      VALUES (${QUEUE_TASK}, ${projectId}, 0, 'created', 'orchestrator', 'queued', 'P1',
        ${sql.json({ title: QUEUE_TITEL, department: 'entwicklung', type: 'feature' } as never)})
    `;
      for (const [index, zustand] of WEG_ZUR_QUEUE.entries()) {
        await sql`
        INSERT INTO task_events (task_id, project_id, seq, kind, actor, state, priority, payload)
        VALUES (${QUEUE_TASK}, ${projectId}, ${index + 1}, 'state_changed', 'orchestrator',
                ${zustand}, 'P1', '{}'::jsonb)
      `;
      }

      gutesRollout = await saeRollout({
        projectId,
        minute: 10,
        sha: 'cccccccccc11111111112222222222333333333344',
        artifact: 'e2e-ueberblick:gut',
        outcome: 'succeeded',
      });
      rollbackRollout = await saeRollout({
        projectId,
        minute: 20,
        sha: 'dddddddddd11111111112222222222333333333344',
        artifact: 'e2e-ueberblick:kaputt',
        outcome: 'rolled_back',
        rolledBackTo: gutesRollout,
      });

      // §18s zwei Ops-Kacheln. Eine gescheiterte Sicherung mit **Teilergebnis**,
      // weil A103s Ausfall genau ein partieller war und „die Sicherung ist
      // fehlgeschlagen" die eine Tatsache verbergen würde, auf die es ankam.
      await sql`
      INSERT INTO event_log (kind, actor, payload)
      VALUES ('backup.failed', 'system', ${sql.json({
        finishedAt: Math.floor(Date.now() / 1000),
        stamp: '2026-08-18',
        components: { db: 'ok', docs: 'ok', transcripts: 'failed', prune: 'skipped' },
        problem: 'Permission denied beim Lesen der Transkripte',
      } as never)})
    `;
      await sql`
      INSERT INTO event_log (kind, actor, payload)
      VALUES ('disk.checked', 'system', ${sql.json({
        level: 'warning',
        worstDisplayPercent: 84,
        worstPath: '/data/transcripts',
        unreadable: [],
      } as never)})
    `;

      sitzung = await browser.newContext();
      seite = await sitzung.newPage();
      await signIn(sitzung, seite);
    });

    test.afterAll(async () => {
      await sitzung?.close();
    });

    /**
     * §10 serialisiert **je Projekt**, und die Position reist deshalb mit statt
     * aus der Renderreihenfolge zu folgen: diese Liste mischt alle Projekte, und
     * eine Seite, die ihre eigenen Zeilen durchzählt, schriebe „3." an eine
     * Aufgabe, die in ihrem Projekt die erste ist.
     */
    test('zeigt §10s Warteschlange mit Position und Projekt', async () => {
      await seite.goto('/');
      const zeile = seite.getByTestId(`merge-kandidat-${QUEUE_TASK}`);
      await expect(zeile).toBeVisible();
      await expect(zeile).toContainText(QUEUE_TITEL);
      await expect(zeile).toContainText(`1. in ${QUEUE_PROJEKT}`);
      await expect(zeile).toContainText('P1');
      // Der Satz darüber sagt, wie viele insgesamt warten. Geprüft wird die
      // Beziehung und keine absolute Zahl: die Suiten teilen sich eine Datenbank.
      await expect(seite.getByTestId('merge-queue')).toContainText('warte');
    });

    /**
     * A95.4: das Rollback-Ziel wird **aufgelöst** dargestellt. Eine uuid an
     * dieser Stelle sieht aus wie eine Antwort und ist keine — und keine der
     * beiden Seiten allein kann das belegen.
     */
    test('zeigt §12s letzte Rollouts und löst das Rollback-Ziel auf', async () => {
      await seite.goto('/');
      const gut = seite.getByTestId(`deploy-${gutesRollout}`);
      await expect(gut).toBeVisible();
      await expect(gut).toContainText(QUEUE_PROJEKT);
      await expect(gut).toContainText('ausgerollt');

      const zurueck = seite.getByTestId(`deploy-${rollbackRollout}`);
      await expect(zurueck).toContainText('zurückgerollt auf cccccccccc (e2e-ueberblick:gut)');
      await expect(zurueck).not.toContainText(gutesRollout);
    });

    /**
     * §17.1s Gesundheitskacheln. Die erste kommt aus `/healthz` — dem Endpunkt,
     * den bis heute **keine** Seite gelesen hat, obwohl Proxy und Route seit
     * Phase 0 stehen —, die anderen beiden aus dem Ereignisprotokoll (§18).
     */
    test('zeigt drei Gesundheitskacheln, jede mit ihrem Zustand als Wort', async () => {
      await seite.goto('/');

      const anwendung = seite.getByTestId('kachel-anwendung');
      await expect(anwendung).toContainText('in Ordnung');

      // A103s Ausfallbild: der Teilfehlschlag nennt die Komponente, die scheiterte.
      const sicherung = seite.getByTestId('kachel-sicherung');
      await expect(sicherung).toContainText('Fehler');
      await expect(sicherung).toContainText('Transkripte');

      const platte = seite.getByTestId('kachel-platte');
      await expect(platte).toContainText('Warnung');
      await expect(platte).toContainText('84 %');

      // Farbe trägt die Aussage nicht allein (a11y): jede Kachel nennt ihren
      // Zustand als Wort. Der Ton steht daneben und ist die zweite Schicht.
      await expect(platte).toHaveAttribute('data-ton', 'warnung');
    });

    /**
     * §6.1 auf der Startseite. Während eines Auth-Vorfalls sagte sie nur „Keine
     * Budgetdaten" — die Folge, nicht die Ursache; die stand im Log des
     * Orchestrators, dessen Container dabei `(healthy)` meldet. Gefunden bei
     * einer Funktionsprüfung mit einem Token, der sich nicht anmeldet.
     *
     * Roh gesät, in der Form, in der der Daemon die Zeile schreibt, und als
     * letzter Fall dieser Datei: `event_log` ist append-only, der Streifen
     * bleibt also stehen, bis die Zeile gealtert ist.
     */
    test('nennt einen laufenden Auth-Vorfall als Grund, statt nur „Keine Budgetdaten"', async () => {
      await seite.goto('/');
      await expect(seite.getByTestId('guardian-state')).toBeVisible();
      await expect(seite.getByTestId('auth-vorfall')).toHaveCount(0);

      await sql`
      INSERT INTO event_log (kind, actor, payload)
      VALUES ('auth.incident', 'system', ${sql.json({
        reasons: ['Die Sitzung konnte sich nicht anmelden (§6.1).'],
        announced: false,
        alertError: 'fetch failed',
      } as never)})
    `;

      await seite.goto('/');
      const vorfall = seite.getByTestId('auth-vorfall');
      await expect(vorfall).toBeVisible();
      await expect(vorfall).toContainText('Auth-Vorfall');
      await expect(vorfall).toContainText('Die Anmeldung bei Claude schlägt fehl');
      await expect(vorfall).toContainText('deshalb gibt es auch keine Budgetdaten');
      await expect(vorfall).toContainText('Die Sitzung konnte sich nicht anmelden');
      // N2s andere Hälfte: der Alarm kam nicht an, und die Seite sagt es.
      await expect(vorfall).toContainText('Der Alarm über ntfy kam nicht an');
      await expect(vorfall).toContainText('Renew the OAuth token');
      // Das Urteil darüber bleibt stehen — der Streifen ersetzt es nicht.
      await expect(seite.getByTestId('guardian-state')).toContainText('Keine Budgetdaten');
    });
  });
