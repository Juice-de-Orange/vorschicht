#!/usr/bin/env node
/**
 * Lena against the real CLI — the paid half of §22's Phase 6 exit gate 1.
 *
 * The gate sentence is: "a question about the Verein is answered by Lena using
 * an uploaded Statuten document + an L5 legal source, with citations and trust
 * levels shown in the trace". `legal-review.itest.ts` proves everything around
 * that for free, with the model doubled: that a citation is resolved against a
 * real registry, that an L2-only opinion goes red, that a fabricated id is
 * distinguishable from a weak one, that an unreadable registry is `infra` and
 * never green. All of it with Lena's judgement scripted, because that half is
 * an *input* to the gate and a gate that only goes red when a model happens to
 * cooperate is not one anybody can regression-test.
 *
 * What none of that can settle is the question the department exists to ask:
 * does a real `legal` session, running the real prompt at its configured tier,
 * actually find the Statuten in the vault, actually read the statute, and
 * actually cite the source that carries its answer? A scripted reviewer
 * returning `sourceId: ris` proves that a fixture returned the string it was
 * handed.
 *
 * Seven decisions.
 *
 *  1. **Two sessions, and the assertion is that the two verdicts differ.** This
 *     is A63.6's design, inherited deliberately from `check-migration-review`.
 *     One session would be cheaper and would prove nothing: a Lena that cites
 *     whatever she is shown — or that answers "I cannot conclude" out of
 *     caution — passes a one-sided check and then blocks every legal question
 *     this studio ever asks. So the same question is asked twice against
 *     registries that differ in exactly the property under test, and a run in
 *     which both answers agree is reported as *having distinguished nothing*,
 *     which is a finding rather than a pass.
 *
 *  2. **The counter-case runs first, then the L5 source is accepted.** One
 *     database rather than two, because `legalReviewPrompt` lists every
 *     accepted source — with both accepted from the start, the counter-case
 *     would see the RIS entry and the comparison would be meaningless. Running
 *     weak-first also makes the pair §11's own sentence for an optional gate:
 *     it blocks, and it passes after the fix. The sessions are independent
 *     processes with no shared history, so the second cannot remember the
 *     first.
 *
 *  3. **`DATABASE_URL` is re-pointed at the database this script creates**, and
 *     it is the single most breakable wire here. `with-test-db.sh` exports a
 *     URL for `vorschicht_test`; `createTestDatabase` then makes a *different*
 *     database and migrates that one. The MCP server is spawned by the CLI and
 *     inherits its environment (`mcp-config.ts`: "the database URL is inherited
 *     from the orchestrator's environment"), so without this line Lena's
 *     `docs.search` would connect to an empty, unmigrated database and answer
 *     honestly that the vault holds nothing — and the carrying case would fail
 *     as though the model had not looked. `check-migration-review` never met
 *     this because it runs with `mcpServerEntry: null`.
 *
 *  4. **The document id is evidence, not a claim.** The carrying case asserts
 *     that `result.documents` names the Statuten. That is the session's own
 *     report of what it read, which would be weak — except that the uuid
 *     appears nowhere in the prompt, in the question or in the source list. The
 *     only way to produce it is to have called `docs.search`, so the id is a
 *     fact about a tool call rather than a claim about a reading.
 *
 *  5. **`AgentLegalReviewer` + the real `judgeLegalReview`, not `GateSuite`.**
 *     The judgement is the real one — `GateSuite.legal` is a one-line call to
 *     the same function — but the gate sentence asks about a *question*, and
 *     the suite only ever produces `kind: 'change'` reviews over a merge
 *     candidate. Driving a candidate repository here to reach the question
 *     shape would be a second gate for the sake of the word "gate".
 *
 *  6. **The Statuten are generated at run time and never checked in.** A54.5's
 *     argument: a plausible Vereinsstatut in this repository is a plausible
 *     Vereinsstatut in this repository, whatever the intent, and it would sit
 *     in the tree looking like one of the operator's papers. It is a Muster, it is
 *     written by this file, and it is removed again. The bytes go onto a
 *     scratch docs volume through the real `DocumentStorage`, and the row
 *     through the real `DocumentVault` — the vault path the upload route uses.
 *
 *  7. **Exit codes are A25/A50's, and the classification is the point.** An
 *     auth incident, an exhausted budget, an unreachable CLI, a missing
 *     database and an unreadable registry are all "nothing was checked" and
 *     leave with 2. Only the gate behaving wrongly is a finding and leaves with
 *     1. A script that reported red because nobody gave it a database would
 *     produce exactly the misclassification A50 records.
 *
 * **Measured instability, stated rather than discovered later.** Over four runs
 * with clean production code the carrying case came back green three times and
 * `changes_requested` with **zero** citations once — so this check is about 1 in
 * 4 red on a tree where nothing is wrong. That matters because §11 has no
 * warning mode: a spurious red here is a legal gate blocking a merge for no
 * reason. The leading hypothesis is that it is Lena behaving *correctly* rather
 * than a defect — her prompt forbids stating a provision she did not read, the
 * RIS page is 207 KB (verified: HTTP 200, 0.73 s), and a fetch she could not
 * extract the paragraph from produces exactly that shape: a refusal with
 * nothing cited. It is a hypothesis and not a finding, because the run that
 * went red predates the transcript-keeping below and its evidence is gone.
 * Whoever picks this up has three honest options and they are not equivalent:
 * keep the URL and treat "could not read the source" as `infra` (A25) rather
 * than as a finding; back the L5 entry with a vault document so the provision
 * is readable without the network, which costs the "real resolvable
 * Fundstelle" the gate sentence implies; or accept the rate and re-run. A
 * silent retry is *not* on that list — it would hide the one signal that
 * distinguishes the two cases.
 *
 * **This one costs money.** Two `legal` sessions at the strongest tier (A8),
 * over one short question. Example figures from six runs on one subscription: 87–731 s per session,
 * 0.35–0.85 USD-Äquivalent each (§2 — nothing is billed; A6's unit). Not part
 * of `pnpm gate`.
 *
 * Usage:  pnpm check:legal-review      (wraps this in `with-test-db.sh`)
 * Exit:   0 = the gate distinguished them · 1 = finding · 2 = infra (A25)
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { exit } from 'node:process';
import { pathToFileURL } from 'node:url';

const CORE = resolve('packages/core/dist/index.js');
const DB = resolve('packages/db/dist/index.js');
const SHARED = resolve('packages/shared/dist/index.js');
const MCP_ENTRY = resolve(process.env.VORSCHICHT_MCP_SERVER ?? 'packages/mcp/dist/main.js');
const HOOK_ENTRY = resolve(process.env.VORSCHICHT_HOOK_ENTRY ?? 'packages/core/dist/hook-entry.js');

/** What could not be checked, and why — printed whatever the verdict (§8.2). */
const SCOPE_LIMITS = [
  'Die RIS-URL wird nicht abgerufen: das Register speichert sie, und ob ris.bka.gv.at ' +
    'heute antwortet, ist eine Aussage über das Netz und nicht über dieses Gate. Ob Lena ' +
    'sie selbst geholt hat, steht in ihrem Transkript.',
  'Das Statut ist ein generiertes Muster, kein echtes Dokument des Betreibers — die Rechtsfrage ' +
    'ist an ihm nachprüfbar, seine Antwort ist es nicht.',
  'Geprüft wird die Mechanik des Gates (löst die Zitation auf, trägt die Stufe, ' +
    'unterscheidet die beiden Register), nicht die juristische Richtigkeit ihrer Auskunft. ' +
    'Dafür gibt es in diesem Haus keinen Prüfer.',
  'Zwei Sitzungen sind zwei Stichproben. Ein Modell, das bei der dritten anders antwortet, ' +
    'ist von diesem Lauf nicht ausgeschlossen — und genau das ist gemessen worden: über vier ' +
    'Läufe mit sauberem Code war der tragende Fall dreimal grün und einmal rot. Ein rotes ' +
    'Ergebnis dieses Skripts ist deshalb ein Anlass nachzusehen, kein Beweis für einen Defekt; ' +
    'die Begründung steht im Kopf der Datei.',
];

function infra(message) {
  console.error(`check-legal-review — ${message} (Infra-Fehler, kein Finding).`);
  exit(2);
}

// --- preflight, before anything costs anything -------------------------------

const cli = process.env.VORSCHICHT_CLAUDE_BIN ?? 'claude';
if (spawnSync(cli, ['--version'], { encoding: 'utf8' }).status !== 0) {
  infra(`${cli} nicht ausführbar`);
}

for (const path of [CORE, DB, SHARED, MCP_ENTRY, HOOK_ENTRY]) {
  if (!existsSync(path)) infra(`${path} fehlt — erst \`pnpm gate:build\` laufen lassen`);
}

if (!process.env.TEST_DATABASE_URL) {
  infra(
    'TEST_DATABASE_URL fehlt. Dieses Skript braucht eine echte Postgres; ' +
      '`pnpm check:legal-review` startet sie über infra/scripts/with-test-db.sh',
  );
}

const {
  AgentLegalReviewer,
  AgentRunner,
  DocumentStorage,
  DocumentVault,
  EventLog,
  HeadlessBackend,
  ProjectService,
  SourceRegistry,
  TaskService,
  judgeLegalReview,
  writeRoleSettings,
} = await import(pathToFileURL(CORE).href);
const { createSql, createTestDatabase } = await import(pathToFileURL(DB).href);
const { CITATION_MIN_LEVEL, trustLevelCode } = await import(pathToFileURL(SHARED).href);

// --- the fixture -------------------------------------------------------------

/**
 * A Muster-Vereinsstatut. Deliberately ordinary, and deliberately silent on the
 * one point the question turns on: it says who elects the Rechnungsprüfer and
 * not who may *be* one. An answer therefore cannot come from this document
 * alone — it needs the statute, which is what makes the L5 source load-bearing
 * rather than decorative.
 */
const STATUTEN = `Statuten des Vereins "Musterverein für digitale Nachbarschaft"
(Muster — zu Testzwecken erzeugt, kein Dokument eines realen Vereins)

§ 1 Name und Sitz
Der Verein führt den Namen "Musterverein für digitale Nachbarschaft" und hat
seinen Sitz in Musterstadt. Seine Tätigkeit erstreckt sich auf ganz Österreich.

§ 2 Zweck
Der Verein ist nicht auf Gewinn gerichtet und bezweckt die Förderung der
digitalen Teilhabe in der Nachbarschaft.

§ 8 Organe des Vereins
Organe des Vereins sind die Generalversammlung, der Vorstand, die
Rechnungsprüfer und das Schiedsgericht.

§ 9 Vorstand
Der Vorstand besteht aus vier Mitgliedern: Obfrau/Obmann, Schriftführer/in,
Kassier/in und eine/n Stellvertreter/in. Er wird von der Generalversammlung auf
zwei Jahre gewählt.

§ 12 Rechnungsprüfer
Zwei Rechnungsprüfer werden von der Generalversammlung auf die Dauer von zwei
Jahren gewählt. Ihnen obliegt die laufende Geschäftskontrolle sowie die Prüfung
der Finanzgebarung des Vereins im Hinblick auf die Ordnungsmäßigkeit der
Rechnungslegung und die statutengemäße Verwendung der Mittel. Sie haben der
Generalversammlung über das Ergebnis der Überprüfung zu berichten.

§ 14 Schiedsgericht
Zur Schlichtung von Streitigkeiten aus dem Vereinsverhältnis ist das
vereinsinterne Schiedsgericht berufen.
`;

/**
 * The question. Narrow on purpose — it costs turns at the strongest tier — and
 * chosen because it has one crisp answer that the Statuten above do **not**
 * contain: VerG 2002 § 5 Abs 5 forbids a Rechnungsprüfer from belonging to the
 * organ whose activity is under review.
 */
const FRAGE =
  'Unser Vorstand möchte zwei seiner eigenen Mitglieder zu Rechnungsprüfern des ' +
  'Vereins bestellen. Ist das zulässig? Antworte kurz und nenne die Bestimmung, ' +
  'auf die du dich stützt.';

const RIS_URL =
  'https://www.ris.bka.gv.at/GeltendeFassung.wxe?Abfrage=Bundesnormen&Gesetzesnummer=20001917';

// --- run ---------------------------------------------------------------------

let database;
let sql;
let scratch;
let docsRoot;
let projectRoot;
const problems = [];
const notes = [];

/**
 * Everything that must come down whatever happened.
 *
 * The database and the scratch docs volume go unconditionally: they are what
 * holds the Muster-Statut, and a document left in a vault is a finding for the
 * next Betriebsprüfung. The **transcripts** are kept when the run reports a
 * finding, because they are the only record of *why* Lena answered as she did —
 * and a check that deletes the evidence for its own red is one nobody can act
 * on (§18). The path is printed, so the leftover is announced rather than
 * discovered.
 */
async function cleanup({ keepTranscripts = false } = {}) {
  await sql?.end().catch(() => {});
  await database?.drop().catch(() => {});
  for (const dir of [docsRoot, projectRoot]) {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  if (keepTranscripts) return;
  if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
}

function report(code, headline) {
  console.log('');
  console.log('  Nicht geprüft:');
  for (const limit of SCOPE_LIMITS) console.log(`      · ${limit}`);
  if (headline) console.error(headline);
  exit(code);
}

try {
  database = await createTestDatabase('legal_review_real');
  sql = createSql({ url: database.url, max: 4 });

  // Decision 3 — the wire the MCP server travels on. Set before any session.
  process.env.DATABASE_URL = database.url;

  scratch = await mkdtemp(join(tmpdir(), 'vs-lena-real-'));
  docsRoot = await mkdtemp(join(tmpdir(), 'vs-lena-tresor-'));
  projectRoot = await mkdtemp(join(tmpdir(), 'vs-lena-projekt-'));
  await writeRoleSettings(join(scratch, 'claude'), { hookEntry: HOOK_ENTRY });

  const eventLog = new EventLog(sql);
  const tasks = new TaskService({ sql, eventLog });
  const projects = new ProjectService(sql);
  const sources = new SourceRegistry(sql);
  const vault = new DocumentVault(sql);

  // §13's upload path, both halves: the bytes through the real storage, the row
  // through the real vault. `Recht` is §8's label for Lena's department, and
  // A110.1 derives the search boost from exactly that string.
  const storage = new DocumentStorage({ root: docsRoot, maxBytes: 8 * 1024 * 1024 });
  const bytes = Buffer.from(STATUTEN, 'utf8');
  const stored = await storage.store(new Uint8Array(bytes));
  const { document } = await vault.create(
    {
      title: 'Statuten Musterverein für digitale Nachbarschaft',
      departmentTags: ['Recht'],
      tags: ['Statuten', 'Verein'],
      version: {
        filename: 'statuten-musterverein.txt',
        storagePath: stored.storagePath,
        mimeType: 'text/plain',
        byteSize: stored.byteSize,
        checksum: stored.checksum,
        // A107.6 / decision 4 of the vault: the text is supplied at write time
        // or never — the versions table is append-only, so nothing can fill it
        // in afterwards.
        extractedText: STATUTEN,
      },
    },
    'max',
  );

  const projectId = (
    await projects.create({
      slug: 'lena-pruefung',
      name: 'Musterverein',
      rootPath: projectRoot,
      defaultBranch: 'main',
    })
  ).id;

  // §14's registry, as it describes itself: a department proposes, the operator grants a
  // level. Both acts through the real service, so the state a citation resolves
  // to is derived from a log rather than asserted into a column.
  const blog = (
    await sources.propose(
      {
        title: 'Vereinsblog: Der Vorstand und seine Prüfer',
        url: 'https://example.org/vereinsblog/rechnungspruefer',
        level: 2,
        assessment: 'Sekundär, ohne erkennbare Redaktion — §14 L2.',
      },
      'research',
    )
  ).id;
  await sources.accept(blog, { level: 2 }, 'max');

  const ris = (
    await sources.propose(
      {
        title: 'Vereinsgesetz 2002 (RIS, geltende Fassung)',
        url: RIS_URL,
        level: 5,
        assessment: 'Primärquelle: Gesetzestext beim Rechtsinformationssystem des Bundes.',
      },
      'research',
    )
  ).id;
  // Deliberately *not* accepted yet — decision 2.

  const reviewer = new AgentLegalReviewer({
    runner: new AgentRunner({
      sql,
      eventLog,
      backend: new HeadlessBackend(),
      paths: {
        roleSettingsDir: join(scratch, 'claude'),
        runsRoot: join(scratch, 'runs'),
        transcriptsRoot: join(scratch, 'transcripts'),
        // The whole point of this check that the itest cannot reach: Lena has
        // to find the Statuten herself.
        mcpServerEntry: MCP_ENTRY,
      },
    }),
    sources,
    scratchDir: scratch,
    onWarning: (message) => notes.push(message),
  });

  /**
   * What the run cost in §7.1's unit, read from the record the runner wrote.
   *
   * Never throws and never decides anything: a missing row costs a line of
   * output, and a check that failed because it could not find out what a
   * session weighed would be reporting on itself. "Kostenäquivalent" rather
   * than "Kosten" deliberately — under §2's subscription rule nothing here is
   * billed, and the word matters (A6, A60.1).
   */
  async function costOf(runId) {
    try {
      const [row] = await sql`
        SELECT cost_usd, tokens_out, cache_read_tokens FROM agent_runs WHERE run_id = ${runId}
      `;
      if (!row?.cost_usd) return ', Kostenäquivalent nicht aufgezeichnet';
      return (
        `, ${Number(row.cost_usd).toFixed(4)} USD-Äquivalent` +
        `, ${row.tokens_out ?? '?'} Token aus / ${row.cache_read_tokens ?? '?'} aus dem Cache`
      );
    } catch (error) {
      // Said out loud rather than swallowed. The first version returned '' here
      // and queried `id` — a column this view does not have (it is `run_id`) —
      // so the line was silently absent on every run and the whole branch was
      // wiring that could not carry a signal (§8.2 domain 6). Found by mutation
      // A, which was looking for something else entirely.
      return `, Kostenäquivalent nicht lesbar: ${error.message}`;
    }
  }

  /** One real session, and its verdict through the real judge. */
  async function ask(label) {
    const task = await tasks.create({
      projectId,
      title: `Rechtsfrage: Rechnungsprüfer (${label})`,
      description: FRAGE,
      acceptanceCriteria: ['Die Frage ist mit Fundstelle beantwortet'],
    });
    const started = Date.now();
    const report_ = await reviewer.review({
      kind: 'question',
      taskId: task.id,
      projectId,
      readOnlyProject: true,
      question: FRAGE,
    });
    const seconds = ((Date.now() - started) / 1000).toFixed(0);
    if (report_.status === 'infra') {
      // A25: an auth incident, an exhausted budget or a CLI that could not run.
      // Nothing was checked, so this is never a finding.
      await cleanup({ keepTranscripts: true });
      console.log(`  Transkripte für die Nachschau behalten: ${scratch}`);
      report(2, `check-legal-review — ${label}: ${report_.problem}`);
    }
    if (report_.status === 'failed') {
      problems.push(
        `${label}: die Sitzung lief und lieferte kein verwertbares Urteil — ${report_.problem}`,
      );
      return null;
    }
    const outcome = judgeLegalReview(report_.result, report_.citations);
    console.log(
      `  · ${label}: ${outcome.verdict} (${seconds}s, Lauf ${report_.runId}` +
        `${await costOf(report_.runId)})`,
    );
    for (const { citation, check } of report_.citations) {
      console.log(
        `      Zitation ${citation.sourceId} — behauptet ${trustLevelCode(citation.claimedLevel)}, ` +
          `Register: ${trustLevelCode(check.level)}${check.ok ? '' : ' — nicht tragend'}`,
      );
    }
    return { report: report_, outcome };
  }

  // --- 1. the counter-case: only an L2 source is citable ---------------------

  console.log('  Sitzung 1 von 2 — Register: nur eine L2-Quelle.');
  const schwach = await ask('nur L2 im Register');
  if (schwach) {
    if (schwach.outcome.verdict !== 'finding') {
      problems.push(
        `Der Gegenfall wurde nicht blockiert (${schwach.outcome.verdict}). Im Register stand ` +
          `keine Quelle auf ${trustLevelCode(CITATION_MIN_LEVEL)} oder höher, also darf eine ` +
          'rechtliche Aussage nach §14 nicht tragen.',
      );
    } else if (!schwach.outcome.detail.includes('§14')) {
      problems.push(
        'Der Gegenfall wurde blockiert, aber die Begründung nennt §14 nicht — dann steht in ' +
          `der Spur nicht, welche Regel gegriffen hat: ${schwach.outcome.detail}`,
      );
    }
    // A citation to a source that does not exist is a different defect and
    // would make the block above right for the wrong reason.
    const erfunden = schwach.report.citations.filter((entry) => entry.check.reason === 'unknown');
    if (erfunden.length > 0) {
      notes.push(
        `Der Gegenfall nannte ${erfunden.length} Kennung(en), die es im Register nicht gibt — ` +
          'blockiert hat er dadurch aus zwei Gründen statt aus einem.',
      );
    }
  }

  // --- 2. the fix: the L5 source is accepted, and the same question again ----

  await sources.accept(ris, { level: 5, note: 'Primärquelle, zitierfähig nach §14.' }, 'max');

  console.log('  Sitzung 2 von 2 — dieselbe Frage, RIS-Fundstelle jetzt aufgenommen (L5).');
  const stark = await ask('L5 im Register');
  if (stark) {
    const { report: r, outcome } = stark;
    if (outcome.verdict !== 'green') {
      problems.push(
        `Der tragende Fall wurde nicht erteilt (${outcome.verdict}): ${outcome.detail}`,
      );
    }
    if (r.citations.length === 0) {
      problems.push(
        'Der tragende Fall nennt gar keine Quelle — dann ist die Zitationsprüfung an diesem ' +
          'Lauf unbeteiligt, und das Gate hat nichts geprüft.',
      );
    }
    const unbekannt = r.citations.filter((entry) => entry.check.reason === 'unknown');
    if (unbekannt.length > 0) {
      problems.push(
        `${unbekannt.length} Zitation(en) lösen im Register nicht auf: ` +
          `${unbekannt.map((entry) => entry.citation.sourceId).join(', ')} — erfundene Fundstellen.`,
      );
    }
    const tragend = r.citations.filter((entry) => entry.check.ok);
    if (tragend.length === 0) {
      problems.push(
        `Keine Zitation erreicht ${trustLevelCode(CITATION_MIN_LEVEL)} — die aufgenommene ` +
          'L5-Fundstelle wurde also nicht benutzt, obwohl sie im Prompt stand.',
      );
    }
    // Decision 4: the uuid is nowhere in the prompt, so naming it is a fact
    // about a `docs.search` call rather than a claim about a reading.
    if (!r.result.documents.includes(document.id)) {
      problems.push(
        `Die Statuten (${document.id}) tauchen nicht in \`documents\` auf. Diese Kennung steht ` +
          'in keinem Prompt — sie ist nur über `docs.search` zu bekommen, also hat die Sitzung ' +
          'den Tresor nicht benutzt. §22s Gate-Satz verlangt genau das.',
      );
    }
  }

  // --- 3. the assertion the two sessions exist for (decision 1) --------------

  if (schwach && stark) {
    if (schwach.outcome.verdict === stark.outcome.verdict) {
      problems.push(
        `Beide Sitzungen endeten auf "${stark.outcome.verdict}". Dieser Lauf hat nichts ` +
          'unterschieden: eine Rechtsprüferin, die auf jedes Register dieselbe Antwort gibt, ' +
          'besteht einen einseitigen Test und blockiert danach jede Rechtsfrage — oder erteilt ' +
          'jede. Genau dafür laufen hier zwei Sitzungen (A63.6).',
      );
    }
  } else {
    problems.push(
      'Mindestens eine der beiden Sitzungen lieferte kein Urteil — der Vergleich, der dieses ' +
        'Skript ausmacht, konnte nicht gezogen werden.',
    );
  }

  for (const note of notes) console.log(`      Hinweis: ${note}`);

  if (problems.length > 0) {
    // What she actually said, before the evidence goes away. Without this the
    // red is a verdict with no reason attached, and the two cases that look
    // identical from outside — she could not reach the source, or she read it
    // and disagreed — are the two a human most needs told apart.
    console.log('');
    console.log('  Was Lena geantwortet hat:');
    for (const [label, entry] of [
      ['Gegenfall (nur L2)', schwach],
      ['tragender Fall (L5)', stark],
    ]) {
      if (!entry) continue;
      console.log(`      ${label} — verdict ${entry.report.result.verdict}:`);
      console.log(`        ${entry.report.result.summary.replace(/\s+/g, ' ').slice(0, 700)}`);
      for (const followup of entry.report.result.followups.slice(0, 4)) {
        console.log(`        → ${followup.replace(/\s+/g, ' ').slice(0, 200)}`);
      }
    }
    await cleanup({ keepTranscripts: true });
    console.log('');
    console.log(`  Transkripte für die Nachschau behalten: ${scratch}`);
    report(
      1,
      `check-legal-review — §11s legal-Gate (§14) unvollständig:\n${problems
        .map((p) => `  • ${p}`)
        .join('\n')}`,
    );
  }

  await cleanup();

  console.log('');
  console.log('  ✓ Lena unterscheidet die beiden Register (§14, §22 Phase 6 Gate 1)');
  console.log(`      Gegenfall (nur L2):  ${schwach.outcome.verdict}`);
  console.log(`      tragender Fall (L5): ${stark.outcome.verdict}`);
  console.log(`      Statuten aus dem Tresor gelesen: ${document.id}`);
  console.log(
    `      tragende Zitationen: ${stark.report.citations
      .filter((entry) => entry.check.ok)
      .map((entry) => `${entry.citation.sourceId} (${trustLevelCode(entry.check.level)})`)
      .join(', ')}`,
  );
  report(0);
} catch (error) {
  await cleanup();
  // Anything that got this far is the harness, not the gate: a database that
  // went away, a dist artifact that does not export what it used to. A25 again.
  report(2, `check-legal-review — ${error?.stack ?? error}`);
}
