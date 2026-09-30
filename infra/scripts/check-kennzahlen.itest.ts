import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSql, createTestDatabase, type TestDatabase } from '@vorschicht/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * §22 Phase 8, Gate 2: der Abgleich selbst, an Daten, die ihn etwas fragen.
 *
 * `check-kennzahlen.mjs` rechnet §16s Kopfzahlen ein zweites Mal und anders
 * nach. Gegen die Betriebsdaten auf dem Produktionshost lief es am 24.8.2026 grün — und
 * sagte im selben Atemzug, was das wert war: **1 von 6** Zahlen wirklich
 * nachgerechnet, die anderen fünf beidseitig 0. Solange kein schreibbares
 * Projekt onboardet ist (A85), gibt es keine Merges und keine Rollouts, und ein
 * Vergleich `0 === 0` geht auch dann durch, wenn eine der beiden Ableitungen
 * beliebig falsch ist.
 *
 * Das ist die Lücke, die diese Datei schliesst, und sie ist eine andere als die
 * des Produktionslaufs: dort steht die **Datenquelle** zur Prüfung, hier die
 * **Rechnung**. Beide zusammen tragen den Gate-Satz; keiner allein.
 *
 * Gesät wird über rohes SQL statt über die Dienste — dieselbe Regel wie in den
 * Browsersuiten: `MetricsService` ist eine der beiden verglichenen Seiten, und
 * eine Fixture, die ihn benutzt, könnte einen Defekt in ihm aufsetzen und im
 * selben Lauf bestehen.
 *
 * Die Zusicherung, die man weglässt und die hier die tragende ist: **jede der
 * sechs Zahlen muss grösser als null sein.** Ohne sie prüft diese Datei
 * dasselbe wie der grüne Produktionslauf — nämlich nichts.
 */

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SKRIPT = join(REPO, 'infra', 'scripts', 'check-kennzahlen.mjs');

const VON = '2019-03-01T00:00:00.000Z';
const BIS = '2019-03-08T00:00:00.000Z';
const IM_FENSTER = '2019-03-03T12:00:00.000Z';
const DAVOR = '2019-02-20T12:00:00.000Z';

/*
 * Eine **eigene**, migrierte Datenbank statt der nackten Verbindung: die
 * Zusicherungen zählen Zeilen je Art über ein festes Fenster, und in der
 * geteilten Datenbank läge jederzeit fremdes Rauschen darin. Der erste Anlauf
 * verband sich direkt und scheiterte an `42P01` — dort sind gar keine Tabellen.
 */
const vorhanden = Boolean(process.env.TEST_DATABASE_URL);
let datenbank: TestDatabase;
let url = '';
let sql: ReturnType<typeof createSql>;

async function ereignis(
  kind: string,
  occurredAt: string,
  payload: Record<string, unknown> = {},
  taskId: string | null = null,
): Promise<void> {
  await sql`
    INSERT INTO event_log (kind, actor, payload, occurred_at, task_id)
    VALUES (${kind}, 'itest-kennzahlen', ${sql.json(payload as never)}, ${occurredAt}::timestamptz, ${taskId})
  `;
}

function lauf(): { code: number; ausgabe: string } {
  try {
    const ausgabe = execFileSync(process.execPath, [SKRIPT, '--von', VON, '--bis', BIS], {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: url },
      cwd: REPO,
    });
    return { code: 0, ausgabe };
  } catch (fehler) {
    const e = fehler as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, ausgabe: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

describe.skipIf(!vorhanden)('§22 P8.G2 — der Abgleich an Daten, die ihn etwas fragen', () => {
  beforeAll(async () => {
    datenbank = await createTestDatabase('kennzahlen');
    url = datenbank.url;
    sql = createSql({ url, max: 2 });

    // Zwei verschiedene Aufgaben nach `done`, plus ein zweiter Wechsel auf
    // derselben Aufgabe: „Aufgaben erledigt" zählt **verschiedene** Aufgaben,
    // und ohne den Doppelgänger ginge eine Ableitung durch, die Zeilen zählt.
    const a = '11111111-1111-4111-8111-111111111111';
    const b = '22222222-2222-4222-8222-222222222222';
    await ereignis('task.state_changed', IM_FENSTER, { to: 'done' }, a);
    await ereignis('task.state_changed', IM_FENSTER, { to: 'done' }, a);
    await ereignis('task.state_changed', IM_FENSTER, { to: 'done' }, b);
    // Ein Wechsel, der **nicht** `done` ist — beide Seiten müssen ihn auslassen.
    await ereignis('task.state_changed', IM_FENSTER, { to: 'red' }, b);
    // Und einer ausserhalb des Fensters, damit die Fensterprüfung etwas zu tun hat.
    await ereignis('task.state_changed', DAVOR, { to: 'done' }, b);

    await ereignis('merge.finished', IM_FENSTER, { ok: true });
    await ereignis('merge.finished', IM_FENSTER, { ok: true });
    await ereignis('merge.finished', DAVOR, { ok: true });

    await ereignis('deploy.succeeded', IM_FENSTER, {});
    await ereignis('deploy.rolled_back', IM_FENSTER, { status: 503 });
    await ereignis('deploy.rolled_back', IM_FENSTER, { status: 500 });
    await ereignis('deploy.failed', IM_FENSTER, {});

    // §16.1s Eskalationen — und **beide** Zahlen, seit A151. „Offen" ist
    // ausdrücklich nicht `gestellt − beantwortet`: Karte 1 wird im Fenster
    // gestellt **und** beantwortet, Karte 4 bleibt offen, und Karte 3 wurde
    // vor dem Fenster beantwortet. Eine Differenzrechnung ergäbe hier −1.
    await ereignis('escalation.raised', IM_FENSTER, { escalationId: 'e1', number: 1 });
    await ereignis('escalation.answered', IM_FENSTER, { escalationId: 'e1', number: 1 });
    await ereignis('escalation.answered', IM_FENSTER, { escalationId: 'e2', number: 2 });
    await ereignis('escalation.answered', DAVOR, { escalationId: 'e3', number: 3 });
    await ereignis('escalation.raised', IM_FENSTER, { escalationId: 'e4', number: 4 });

    // §16.1s Gate-Durchlaufquote (A151). Drei Läufe, drei Ausgänge — und der
    // dritte ist der, den man weglässt: ein `infra`-Schritt heisst **nichts
    // geprüft** (A25) und zählt weder als bestanden noch als durchgefallen.
    // Ohne ihn ginge eine Ableitung durch, die ihn zur einen oder anderen
    // Seite schlägt, und das ist die eine Richtung, in die eine Kennzahl über
    // Gates nicht falsch liegen darf.
    // Ein Gate-Lauf gehört zu einer Aufgabe, und jeder Schritt trägt eine
    // Kennung — ohne beides liest `parseGateRun` die Zeile gar nicht als Lauf.
    await ereignis(
      'gate.finished',
      IM_FENSTER,
      {
        steps: [
          { id: 'test', verdict: 'green' },
          { id: 'lint', verdict: 'green' },
        ],
      },
      a,
    );
    await ereignis(
      'gate.finished',
      IM_FENSTER,
      {
        steps: [
          { id: 'test', verdict: 'green' },
          { id: 'lint', verdict: 'finding' },
        ],
      },
      a,
    );
    await ereignis(
      'gate.finished',
      IM_FENSTER,
      {
        steps: [
          { id: 'test', verdict: 'green' },
          { id: 'secrets', verdict: 'infra' },
        ],
      },
      b,
    );
    await ereignis('gate.finished', DAVOR, { steps: [{ id: 'test', verdict: 'green' }] }, b);
  });

  afterAll(async () => {
    // Kein `DELETE`: `event_log` ist append-only (§18), und die Datenbank
    // gehört ohnehin nur diesem Lauf.
    await sql?.end({ timeout: 5 });
    await datenbank?.drop();
  });

  it('rechnet alle acht Kopfzahlen nach, und keine davon ist trivial', () => {
    const { code, ausgabe } = lauf();
    expect(code, ausgabe).toBe(0);

    // Die tragende Zusicherung: das Skript sagt selbst, wie viele Zahlen es
    // wirklich nachgerechnet hat, und hier müssen es alle sechs sein. Ohne
    // diese Zeile prüft die Datei dasselbe wie der grüne Produktionslauf —
    // nämlich, dass 0 gleich 0 ist.
    expect(ausgabe).not.toMatch(/Davon wirklich nachgerechnet/);
    expect(ausgabe).not.toMatch(/belegt nichts/);
  });

  it('zählt verschiedene Aufgaben und nicht Zustandswechsel', () => {
    const { ausgabe } = lauf();
    // Zwei Aufgaben, drei `done`-Zeilen, eine davon doppelt auf derselben
    // Aufgabe. Wer Zeilen zählt, bekommt 3.
    expect(ausgabe).toMatch(/Aufgaben erledigt\s+Dienst\s+2\s+unabhängig\s+2/);
  });

  it('lässt aus, was ausserhalb des Fensters liegt', () => {
    const { ausgabe } = lauf();
    // Je eine Zeile jeder Art liegt zwei Wochen davor. Wer das Fenster
    // ignoriert, bekommt bei Merges 3 statt 2.
    expect(ausgabe).toMatch(/Merges\s+Dienst\s+2\s+unabhängig\s+2/);
    expect(ausgabe).toMatch(/Entscheidungen beantwortet\s+Dienst\s+2\s+unabhängig\s+2/);
  });

  it('unterscheidet die drei Rollout-Ausgänge voneinander', () => {
    const { ausgabe } = lauf();
    // Drei Arten, drei Zahlen — eine Ableitung, die `deploy.*` zusammenwirft,
    // bekäme überall 4.
    expect(ausgabe).toMatch(/Rollouts erfolgreich\s+Dienst\s+1\s+unabhängig\s+1/);
    expect(ausgabe).toMatch(/Rollbacks\s+Dienst\s+2\s+unabhängig\s+2/);
    expect(ausgabe).toMatch(/Rollouts gescheitert\s+Dienst\s+1\s+unabhängig\s+1/);
  });

  it('endet mit 2 statt mit einem Urteil, wenn das Fenster leer ist', () => {
    // A25/A50: nichts geprüft ist keine Feststellung. Ein leeres Fenster, das
    // grün meldet, wäre die gefährlichste Antwort dieses Skripts — genau die,
    // die der Produktionslauf beinahe gegeben hätte.
    try {
      execFileSync(
        process.execPath,
        [SKRIPT, '--von', '2001-01-01T00:00:00Z', '--bis', '2001-01-08T00:00:00Z'],
        { encoding: 'utf8', env: { ...process.env, DATABASE_URL: url }, cwd: REPO },
      );
      throw new Error('erwartet war Exit 2 für ein leeres Fenster');
    } catch (fehler) {
      expect((fehler as { status?: number }).status).toBe(2);
    }
  });
});
