/**
 * §22 Phase 8, Gate 2: „Spot audit: every headline number reconciles with the
 * event log via an audit script."
 *
 *   node infra/scripts/check-kennzahlen.mjs [--von <ISO>] [--bis <ISO>]
 *
 * ## Der Punkt, an dem so ein Skript wertlos wird
 *
 * Ein Prüfskript, das dieselbe Abfrage noch einmal fährt, beweist nichts — es
 * zeigt, dass Postgres deterministisch ist. Dieses Haus hat den Fall zweimal
 * gehabt: A89 baute die Deploy-Strecke gegen einen echten Daemon, weil eine
 * Attrappe „aus demselben Modell antwortet, gegen das das Ziel geschrieben
 * wurde, und ein geteiltes Missverständnis sich lautlos aufhebt"; A49 zog
 * dieselbe Konsequenz für den MCP-Handschlag und liess den **fremden** Client
 * gegen den eigenen Server sprechen.
 *
 * Also rechnet dieses Skript **anders**, nicht noch einmal:
 *
 * | `MetricsService` | hier |
 * |---|---|
 * | `count(*) FILTER (WHERE kind = …)` in SQL | rohe Zeilen holen und **in JavaScript** zählen |
 * | ein `SELECT` für alle vier Durchsatzzahlen | eine Abfrage je Art |
 * | Fensterprüfung teils in SQL, teils in TS | ausschliesslich in JS, gegen die abgeholten Zeitstempel |
 * | `count(DISTINCT task_id) FILTER` | `Set` über die Aufgabenkennungen |
 *
 * Was beide teilen, ist die Datenquelle — und das ist der Punkt. Weicht eine
 * Zahl ab, liegt der Fehler in genau einer der beiden Ableitungen, und das
 * Skript sagt in welche Richtung.
 *
 * ## Was es nicht prüft, ausdrücklich
 *
 * Nur die vier Durchsatzzahlen von §16.1 und die Eskalationszahlen. Die
 * Budget-Auslastung kommt nach A143 **nicht** aus `event_log`, sondern aus
 * `usage_samples`; sie hier über dieselbe Tabelle nachzurechnen wäre eine
 * Aussage über eine andere Quelle als die, die der Gate-Satz nennt. Die
 * Gate-Durchlaufquote und die Zeit-bis-grün sind Ableitungen über
 * Schrittlisten, keine Kopfzahlen — sie stehen in §16.3 und haben ihre eigenen
 * 42 reinen Testfälle.
 *
 * Exit: 0 = alles stimmt überein · 1 = eine Zahl weicht ab (Befund) ·
 * 2 = nichts geprüft (A25/A50: keine Datenbank, kein leeres Fenster).
 */
import { dirname, join } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// A130: `import()` nimmt sein Argument als URL, und ein Windows-Pfad wird dort
// als Schema `c:` gelesen.
const { MetricsService } = await import(
  pathToFileURL(join(REPO_ROOT, 'packages/core/dist/metrics/index.js')).href
);
const { createSql } = await import(
  pathToFileURL(join(REPO_ROOT, 'packages/db/dist/index.js')).href
);

function argument(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

/**
 * Ohne Angabe: die letzten sieben Tage. Bewusst **nicht** „die letzte
 * Kalenderwoche" — das wäre eine zweite Deklaration von `report-schedule.ts`s
 * Fensterlogik, und zwei Stellen, die dasselbe berechnen, laufen auseinander
 * (A81). Wer eine bestimmte Berichtswoche prüfen will, gibt sie an.
 */
const bis = argument('--bis') ? new Date(argument('--bis')) : new Date();
const von = argument('--von')
  ? new Date(argument('--von'))
  : new Date(bis.getTime() - 7 * 24 * 60 * 60 * 1000);

if (Number.isNaN(von.getTime()) || Number.isNaN(bis.getTime())) {
  console.error('check-kennzahlen: --von/--bis müssen ISO-Zeitpunkte sein.');
  exit(2);
}
if (von >= bis) {
  console.error('check-kennzahlen: das Fenster ist leer — nichts geprüft (A25).');
  exit(2);
}

const url = env.DATABASE_URL;
if (!url) {
  console.error('check-kennzahlen: kein DATABASE_URL — nichts geprüft, keine Feststellung (A25).');
  exit(2);
}

let sql;
try {
  sql = createSql({ url, max: 4 });
  await sql`SELECT 1`;
} catch (fehler) {
  console.error(`check-kennzahlen: Datenbank nicht erreichbar (${fehler.message}) — A25.`);
  exit(2);
}

/**
 * Die zweite Ableitung: rohe Zeilen, eine Abfrage je Art, gezählt in
 * JavaScript. Die Fensterprüfung passiert hier und nicht in SQL — halboffen
 * `[von, bis)`, wie `window.ts` es festlegt, aber unabhängig davon
 * ausgeschrieben, damit eine Änderung dort hier auffällt statt mitzuwandern.
 */
async function zeilen(kind) {
  const rows = await sql`
    SELECT task_id, occurred_at, payload
    FROM event_log
    WHERE kind = ${kind}
      AND occurred_at >= ${von}
      AND occurred_at <  ${bis}
    ORDER BY id`;
  return rows.filter((r) => {
    const t = new Date(r.occurred_at).getTime();
    return t >= von.getTime() && t < bis.getTime();
  });
}

const abweichungen = [];
const zeilenGesamt = { wert: 0 };

/**
 * Zahlen, die auf beiden Seiten 0 sind, stimmen **trivial** überein: sie
 * belegen nichts über die Ableitung, nur dass im Fenster nichts passiert ist.
 * Sie werden gezählt und am Ende benannt.
 *
 * Ohne diese Unterscheidung liest sich ein Lauf, in dem fünf von sechs Zahlen
 * null sind, wie eine vollständige Bestätigung — und genau das ist heute der
 * Normalfall, weil Vorschichts eigenes Projekt nach A85 `read_only` ist und
 * kein zweites onboardet ist. Ein Prüfskript, das den Unterschied zwischen
 * „nachgerechnet" und „es gab nichts nachzurechnen" nicht macht, ist A122s
 * Schritt, der nie etwas prüft, mit einem grünen Haken davor.
 */
const trivial = [];

function vergleiche(name, dienst, selbst, hinweis) {
  const gleich = dienst === selbst;
  const leer = gleich && dienst === 0;
  const zeichen = leer ? '\x1b[33m·\x1b[0m' : gleich ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(
    `  ${zeichen} ${name.padEnd(28)} Dienst ${String(dienst).padStart(5)}  ` +
      `unabhängig ${String(selbst).padStart(5)}${leer ? '   (beide 0 — belegt nichts)' : ''}`,
  );
  if (leer) trivial.push(name);
  if (!gleich) {
    abweichungen.push(
      `${name}: der Dienst sagt ${dienst}, die unabhängige Zählung ${selbst}` +
        (hinweis ? ` — ${hinweis}` : ''),
    );
  }
}

try {
  const metrics = new MetricsService({ sql });
  const kopf = await metrics.headline({ from: von, to: bis });

  console.log(
    `\n\x1b[1mKennzahlen gegengerechnet\x1b[0m  ${von.toISOString()} bis ${bis.toISOString()}\n`,
  );

  // §16.1s vier Durchsatzzahlen.
  const abschluesse = await zeilen('task.state_changed');
  const erledigt = new Set(
    abschluesse.filter((r) => r.payload?.to === 'done').map((r) => String(r.task_id)),
  );
  zeilenGesamt.wert += abschluesse.length;

  const merges = await zeilen('merge.finished');
  const erfolge = await zeilen('deploy.succeeded');
  const rollbacks = await zeilen('deploy.rolled_back');
  const gescheitert = await zeilen('deploy.failed');
  zeilenGesamt.wert += merges.length + erfolge.length + rollbacks.length + gescheitert.length;

  vergleiche(
    'Aufgaben erledigt',
    kopf.throughput.tasksDone,
    erledigt.size,
    'verschiedene Aufgaben mit einem Wechsel nach `done`',
  );
  vergleiche('Merges', kopf.throughput.merges, merges.length);
  vergleiche('Rollouts erfolgreich', kopf.throughput.deploys, erfolge.length);
  vergleiche('Rollbacks', kopf.throughput.rollbacks, rollbacks.length);
  vergleiche(
    'Rollouts gescheitert',
    kopf.throughput.failedDeploys,
    gescheitert.length,
    'nicht zurückgerollt — die Klasse, die bis A143 keine Protokollzeile hatte',
  );

  // §16.1s Gate-Durchlaufquote (A151).
  //
  // **Bis zum 25.8.2026 fehlte sie hier**, zusammen mit „Entscheidungen offen"
  // — die Betriebsprüfung 52a68316 hat P8.G2 dafür entwertet, und zu Recht: der
  // Gate-Satz sagt „**every** headline number", §16.1 zählt acht auf, und
  // dieses Skript rechnete sechs nach. Beide fehlenden kommen aus `event_log`,
  // waren also nicht unerreichbar, sondern übersehen.
  //
  // Unabhängig abgeleitet wie die anderen: `MetricsService` klassifiziert über
  // `classifyGateRun`, hier wird die Nutzlast selbst gelesen. Ein Lauf ohne
  // `verdict` zählt **nirgends** mit — A25s „nichts geprüft" ist weder
  // bestanden noch durchgefallen, und ihn zur einen oder anderen Seite zu
  // schlagen wäre genau die Fehlklassifikation, die A50 einmal quer durchs
  // Gate-System gezogen hat.
  const gateLaeufe = await zeilen('gate.finished');
  zeilenGesamt.wert += gateLaeufe.length;
  let bestanden = 0;
  let gefallen = 0;
  for (const r of gateLaeufe) {
    // Das Urteil steht in den **Schritten**, nicht obenauf. Von Hand
    // abgeleitet und nicht über `classifyGateRun`: sonst prüfte dieses Skript
    // dieselbe Funktion ein zweites Mal, statt zu ihr eine zweite Meinung zu
    // haben. Die Regeln sind dieselben, ausgeschrieben:
    //   ein Schritt `finding` → durchgefallen
    //   ein Schritt `infra`   → **nichts entschieden** (A25) — zählt nirgends
    //   alle Schritte `green` → bestanden
    //   alles andere          → nichts entschieden
    // Die **Einschlussregel** ist dieselbe wie beim Dienst, und das ist kein
    // Abschreiben: „eine Zeile ohne Aufgabe ist kein Gate-Lauf" und „ein
    // Schritt braucht eine Kennung" sind Aussagen über das Datenmodell, nicht
    // über das Urteil. Unabhängig abgeleitet wird, was daraus **folgt** — und
    // genau das steht unten ausgeschrieben statt `classifyGateRun` zu rufen.
    if (!r.task_id) continue;
    const schritte = Array.isArray(r.payload?.steps) ? r.payload.steps : [];
    if (schritte.length === 0) continue;
    if (schritte.some((x) => typeof x?.id !== 'string' || typeof x?.verdict !== 'string')) continue;
    const urteile = schritte.map((x) => x?.verdict);
    if (urteile.includes('finding')) gefallen += 1;
    else if (urteile.includes('infra')) continue;
    else if (urteile.every((v) => v === 'green')) bestanden += 1;
  }
  vergleiche('Gate-Läufe bestanden', kopf.gates.passed, bestanden);
  vergleiche('Gate-Läufe mit Befund', kopf.gates.failed, gefallen);

  // §16.1s Eskalationen. „Beantwortet" wird über die Karte gepaart, nicht über
  // die Aufgabe: eine Karte kann ohne Aufgabe entstehen (Audit, Budget, Radar).
  const gestellt = await zeilen('escalation.raised');
  const beantwortet = await zeilen('escalation.answered');
  zeilenGesamt.wert += gestellt.length + beantwortet.length;
  vergleiche('Entscheidungen beantwortet', kopf.escalations.answered, beantwortet.length);

  // „Offen" ist **nicht** `gestellt − beantwortet`: eine Karte, die vor dem
  // Fenster gestellt und darin beantwortet wurde, zöge die Zahl sonst ins
  // Negative. Gezählt wird, was am Fensterende ohne Antwort dastand — dieselbe
  // Frage, die der Dienst mit `NOT EXISTS` stellt, hier über Mengen.
  const beantworteteIds = new Set(
    beantwortet.map((r) => r.payload?.escalationId).filter((id) => id != null),
  );
  const offen = gestellt.filter((r) => !beantworteteIds.has(r.payload?.escalationId)).length;
  vergleiche(
    'Entscheidungen offen',
    kopf.escalations.open,
    offen,
    'am Fensterende ohne Antwort — nicht „gestellt minus beantwortet"',
  );

  if (zeilenGesamt.wert === 0) {
    console.log(
      '\n\x1b[33mcheck-kennzahlen: in diesem Fenster steht keine einzige passende Zeile.\x1b[0m',
    );
    console.log(
      '  Alle Zahlen sind 0 und stimmen deshalb trivial überein — das ist **keine**\n' +
        '  Bestätigung (A25). Gib mit --von/--bis ein Fenster an, in dem etwas passiert ist.',
    );
    exit(2);
  }

  if (abweichungen.length > 0) {
    console.error(`\n\x1b[31mcheck-kennzahlen: ${abweichungen.length} Abweichung(en).\x1b[0m`);
    for (const zeile of abweichungen) console.error(`  - ${zeile}`);
    exit(1);
  }

  const geprueft = 6 - trivial.length;
  console.log(
    `\n\x1b[32mcheck-kennzahlen: alle Kopfzahlen stimmen mit der unabhängigen Zählung überein\x1b[0m ` +
      `(${zeilenGesamt.wert} Zeilen gelesen).`,
  );
  if (trivial.length > 0) {
    console.log(
      `  \x1b[33mDavon wirklich nachgerechnet: ${geprueft} von 6.\x1b[0m ` +
        `Trivial (beide Seiten 0): ${trivial.join(', ')}.`,
    );
    console.log(
      '  Das ist keine Beanstandung, sondern der Zustand des Studios: solange kein\n' +
        '  schreibbares Projekt onboardet ist (A85), gibt es keine Merges und keine\n' +
        '  Rollouts zu zählen. Es steht hier, damit ein grüner Lauf nicht mehr\n' +
        '  behauptet, als er geprüft hat.',
    );
  }
  exit(0);
} catch (fehler) {
  console.error(`check-kennzahlen: ${fehler.message}`);
  exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
