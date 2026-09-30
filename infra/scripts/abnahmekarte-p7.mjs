/**
 * P7.G7: die Design-Abnahme als Karte in des Betreibers Posteingang.
 *
 *   node infra/scripts/abnahmekarte-p7.mjs [--dry-run]
 *
 * ## Warum es dieses Skript gibt, und nicht eine Karte von Hand
 *
 * §22s Gate P7.G7 verlangt des Betreibers Abnahme ausdrücklich „via an inbox item", und
 * A38 lässt ein Gate nur dann als verschoben gelten, wenn die Sache, die es
 * schliessen wird, **mitgeliefert** ist. Für eine Abnahme ist das die Karte.
 *
 * Der unmittelbare Anlass ist ein Fehler von mir: die Belegzeile von P7.G7 sagte
 * am 18.8.2026 „die Karte liegt fertig im Posteingang", während sie als Entwurf
 * in einem Wegwerf-Verzeichnis lag. Eine Abfrage der laufenden Anlage —
 * `SELECT source, count(*) FROM escalations GROUP BY source` — kannte
 * `design_signoff` überhaupt nicht. Das ist dieselbe überzeichnende Belegzeile,
 * für die die Betriebsprüfung 49c549b4 wenige Stunden zuvor P0.G5 entwertet
 * hatte (A76.4: für jeden Test im Repository unsichtbar, nur ein Mensch oder
 * der Prüfer liest sie). Die Antwort darauf ist nicht, die Zeile abzuschwächen,
 * sondern die Karte anzulegen — und zwar so, dass der nächste Lauf es wieder
 * kann, statt dass jemand sie noch einmal von Hand tippt (§22: „demo means a
 * scripted, repeatable check").
 *
 * ## Zwei Entscheidungen
 *
 * 1. **Eigene Quelle `design_signoff` statt `agent_question`** (A137). §15s
 *    Präzedenzgedächtnis beantwortet eine gleichlautende Frage aus einer
 *    früheren Entscheidung. „Nimmst du Gestaltung und Sprache ab?" ist über
 *    Phasen hinweg wortgleich — über `agent_question` hätte des Betreibers Ja von heute
 *    die **nächste** Abnahme beantwortet, also ein Design freigegeben, das er
 *    nie gesehen hat. `POLICY_MEMORY_SOURCES` führt `design_signoff` deshalb
 *    nicht.
 * 2. **Idempotent über die offene Karte, nicht über einen Zeitstempel.** Läuft
 *    dieses Skript zweimal, entsteht keine zweite Karte — es sei denn, die
 *    erste ist beantwortet. Ein zweiter Durchgang nach des Betreibers Antwort ist die
 *    nächste Abnahme und soll eine Karte erzeugen.
 *
 * Exit: 0 = Karte liegt (neu oder schon da) · 1 = Befund · 2 = nichts geprüft
 * (A25/A50: keine Datenbank erreichbar ist keine Feststellung).
 */
import { dirname, join } from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

// `pathToFileURL`, nie ein nackter Pfad: `import()` nimmt sein Argument als URL,
// und ein Windows-Pfad wird dort als Schema `c:` gelesen (A130).
const { EscalationService, EventLog } = await import(
  pathToFileURL(join(REPO_ROOT, 'packages/core/dist/index.js')).href
);
const { createSql } = await import(
  pathToFileURL(join(REPO_ROOT, 'packages/db/dist/index.js')).href
);

const trockenlauf = argv.includes('--dry-run');

const FRAGE =
  'Nimmst du Gestaltung, deutsche Oberfläche und Übersicht des Dashboards ab (§22 Phase 7, G7)?';

const KONTEXT = [
  'Phase 7 ist gebaut: elf Seiten, ein Gestaltungsdurchgang, PWA-Symbole und ein',
  'Service Worker. Sieben der acht Exit-Gates sind mit gemessenen Zahlen',
  'geschlossen — Büro-Reaktion 37/14/17 ms, Kaltstart 1.856 ms gegen eine Grenze',
  'von 2.000, Lighthouse 96 Punkte, zwölf Seiten ohne einen einzigen',
  'axe-Verstoss, drei Klicks vom Büropunkt zur Transkriptzeile.',
  '',
  'Was keine Maschine beantworten kann, ist die Frage, ob es dir gefällt und ob',
  'die deutschen Texte sitzen. Am 11.8. fiel dein Urteil noch deutlich negativ aus',
  '(eine rohe, ungestaltete Seite) — das war vor dem Gestaltungsdurchgang und',
  'bei null CSS-Dateien. Seither hat die Anwendung ein eigenes Aussehen, und die',
  'Überschriften sind flacher geworden, weil die Textschatten axe das Rechnen',
  'des Kontrasts unmöglich machten.',
  '',
  'Bis du antwortest, bleibt P7.G7 nach A38 als „verschoben" stehen. Es blockiert',
  'Phase 8 nicht, aber Phase 9s Abnahme hängt daran.',
].join('\n');

const OPTIONEN = [
  {
    title: 'Abgenommen',
    pros: [
      'Schliesst P7.G7 und damit Phase 7 vollständig ab.',
      'Die Gestaltung gilt als Grundlage, auf der Phase 8 weiterbaut.',
    ],
    cons: ['Spätere Änderungswünsche werden dann eigene Aufgaben statt Teil dieser Abnahme.'],
    recommended: true,
  },
  {
    title: 'Abgenommen mit Anmerkungen',
    pros: [
      'Du kannst es freigeben und trotzdem sagen, was dich stört.',
      'Jede Anmerkung wird eine P2-Aufgabe und geht durch die normalen Gates.',
    ],
    cons: ['Braucht von dir eine Liste — sonst weiss niemand, was gemeint war.'],
    recommended: false,
  },
  {
    title: 'Noch nicht — ich will es erst ansehen',
    pros: [
      'Kostet nichts und hält nichts auf: das Gate bleibt verschoben, Phase 8 läuft weiter.',
      'Ehrlicher als eine Abnahme, die du nicht angesehen hast.',
    ],
    cons: ['Phase 9s Endabnahme verlangt, dass alle verschobenen Gates geschlossen sind.'],
    recommended: false,
  },
];

const url = env.DATABASE_URL;
if (!url) {
  console.error('abnahmekarte-p7: kein DATABASE_URL — nichts geprüft, keine Feststellung (A25).');
  exit(2);
}

let sql;
try {
  sql = createSql({ url, max: 4 });
  await sql`SELECT 1`;
} catch (fehler) {
  console.error(
    `abnahmekarte-p7: Datenbank nicht erreichbar (${fehler.message}) — nichts geprüft (A25).`,
  );
  exit(2);
}

try {
  const eventLog = new EventLog(sql);
  const escalations = new EscalationService({ sql, eventLog });
  // `EventLog` nimmt `sql` **direkt**, `EscalationService` ein Abhängigkeits-
  // objekt. Der erste Lauf am 18.8.2026 übergab `new EventLog({ sql })`, also
  // war `this.sql` das Umschlagobjekt und `this.sql.json` keine Funktion. Die
  // Karte entstand trotzdem — `escalations` ist eine Sicht über
  // `escalation_events`, und die Zeile dort wurde geschrieben, bevor der
  // Eintrag in `event_log` scheiterte. Ergebnis: eine gültige Karte ohne ihre
  // Zeile im Verlauf. Der Posteingang und der ntfy-Beobachter (A86) fragen die
  // Sicht ab und sind davon unberührt; verloren ist eine Zeile im Zeitstrahl.
  // Nicht von Hand nachgetragen: ein zweiter Schreiber mit selbstgebautem SQL
  // in ein append-only-Protokoll ist genau das, was A103.4 verbietet.

  const offen = await escalations.open();
  const schon = offen.find((eintrag) => eintrag.source === 'design_signoff');
  if (schon) {
    console.log(`abnahmekarte-p7: Karte #${schon.number} liegt bereits offen im Posteingang.`);
    exit(0);
  }

  if (trockenlauf) {
    console.log('abnahmekarte-p7: --dry-run, es würde eine Karte angelegt:');
    console.log(`  Frage:     ${FRAGE}`);
    console.log(`  Optionen:  ${OPTIONEN.map((o) => o.title).join(' · ')}`);
    console.log(`  Empfehlung: ${OPTIONEN.findIndex((o) => o.recommended)}`);
    exit(0);
  }

  const karte = await escalations.raise({
    source: 'design_signoff',
    urgency: 'P2',
    raisedBy: 'orchestrator',
    question: FRAGE,
    context: KONTEXT,
    options: OPTIONEN,
  });
  console.log(`abnahmekarte-p7: Karte #${karte.number} angelegt (Quelle design_signoff, P2).`);
  exit(0);
} catch (fehler) {
  console.error(`abnahmekarte-p7: ${fehler.message}`);
  exit(1);
} finally {
  await sql.end({ timeout: 5 });
}
