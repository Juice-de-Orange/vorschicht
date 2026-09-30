/**
 * What the radar puts in front of the operator, and what it puts in the queue.
 *
 * Pure, so every sentence §2 requires in German and every rule §15 requires of
 * an option set is testable without a database, a network or a model turn. The
 * scan (`scan.ts`) decides *whether* to raise these; this file decides what they
 * say.
 *
 * Six decisions.
 *
 *  1. **Three sources, not one.** `billing_change` for §6.0, `dependency_major`
 *     for A10's breaking branch, `dependency_advisory` for its security branch.
 *     A91 is the reason and it is worth restating because the temptation is
 *     real: §16's weekly report counts by source, so filing a CVE under
 *     "Größeres Abhängigkeits-Update" would answer "how many major updates did
 *     we defer" with a number that silently includes security findings — a wrong
 *     label is invisible to every test and surfaces first in a number somebody
 *     trusts.
 *
 *  2. **`RADAR_APPROVE_INDEX` is a constant with its own assertion.** A93.5 and A97
 *     are the same defect found twice: a card read `state === 'answered'` rather
 *     than *which option was chosen*, so the option written to say no released
 *     the act. Both dependency cards put the acting option first and pin it by
 *     title in a test, so a reordered option list fails the build instead of
 *     quietly promoting "Zurückstellen" to "Aktualisieren".
 *
 *  3. **The billing card recommends stopping, and says why in the card.** §2's
 *     hard rule is that this studio never spends money and §6.0 calls a billing
 *     change the #1 external risk; the one thing the studio cannot do is judge
 *     an announcement about its own funding. So the recommendation is the option
 *     that costs throughput rather than the one that costs a decision the operator never
 *     made. The other two options are real — the common outcome is a false
 *     positive on a documentation page, and the card says that too.
 *
 *  4. **The major-update card states what was *not* researched.** §22's gate for
 *     the dependency radar asks for "researched options", and this scan is
 *     deliberately deterministic (`dependencies.ts`): nobody read the changelog,
 *     because reading it is a model session. Claiming research that did not
 *     happen is the class A76.4 keeps finding — an evidence line no test reads.
 *     So the card carries what *was* established (the versions, which workspace
 *     members declare it, runtime or dev) and names the gap in the same
 *     sentence.
 *
 *  5. **The recommendation to update is argued from §11, not from taste.** A
 *     major bump proposed here becomes an ordinary task on an ordinary branch
 *     through the ordinary baseline gates, so a breaking upgrade that breaks
 *     visibly never reaches `main`. That is a project-specific reason and it is
 *     the honest one; "majors are usually fine" is not.
 *
 *  6. **Every free-text part is clipped, and says that it was.** A77.10 found
 *     this the hard way: a thorough diagnosis produced a card the schema
 *     refused, so the task escalated correctly and had no card to answer. A
 *     lockfile with two hundred outdated packages is exactly that shape.
 */
import type { Priority } from '@vorschicht/shared';
import type { BillingSignal, CliRelease } from './billing.js';
import type { AdvisoryFinding, DependencyUpdate } from './dependencies.js';

/** The option that *acts*, on both dependency cards (decision 2). */
export const RADAR_APPROVE_INDEX = 0;

/** A10: patch and minor merge unattended, so they never preempt the operator's goals. */
export const ROUTINE_TASK_PRIORITY: Priority = 'P3';
/** A27's CLI bump and an update the operator asked for are ordinary work. */
export const RADAR_TASK_PRIORITY: Priority = 'P2';

/** Enough to judge, not enough to fill an inbox card with a lockfile. */
const MAX_LISTED = 12;

export interface RadarCard {
  urgency: Priority;
  question: string;
  context: string;
  options: Array<{ title: string; pros: string[]; cons: string[]; recommended: boolean }>;
}

export interface RadarTaskSpec {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: Priority;
}

/** `a, b, c und 4 weitere` — decision 6, in one place so every card clips. */
function list(items: readonly string[], max = MAX_LISTED): string {
  const shown = items.slice(0, max);
  const more = items.length - shown.length;
  return more > 0 ? `${shown.join(', ')} und ${more} weitere` : shown.join(', ');
}

/**
 * §6.0's P0 (decision 3).
 *
 * Quotes the matched sentence rather than paraphrasing it: the studio's rule
 * fired on two words in one sentence, and whether that sentence means what the
 * rule thinks it means is exactly the judgement being escalated.
 */
export function billingCard(signals: readonly BillingSignal[]): RadarCard {
  const origins = [...new Set(signals.map((signal) => signal.origin))];
  const quoted = signals
    .slice(0, 3)
    .map((signal) => `  «${signal.sentence}»\n  — ${signal.origin}`)
    .join('\n\n');

  return {
    urgency: 'P0',
    question:
      'Anthropic-Kanal meldet möglicherweise eine Änderung an der Abrechnung ' +
      'programmatischer Nutzung — Betrieb anhalten?',
    context:
      'Der Abrechnungs-Radar (§6.0) hat in einem beobachteten Kanal einen Satz gefunden, ' +
      'der sowohl programmatische Nutzung als auch eine Änderung der Abrechnung nennt. ' +
      'Genau diese Kombination war die Ankündigung vom 14.5.2026, die am 15.6.2026 ' +
      'ausgesetzt wurde: `claude -p` und das Agent SDK sollten nicht mehr aus den ' +
      'Abo-Grenzen bezahlt werden, sondern aus einem getrennten, kostenpflichtigen ' +
      'Guthaben. §2 verbietet diesem Studio jede kostenpflichtige Nutzung ohne Ausnahme, ' +
      'und §6.0 führt diese Änderung als externes Risiko Nr. 1.\n\n' +
      `Gefunden in: ${list(origins, 5)}\n\n${quoted}\n\n` +
      'Die Regel ist bewusst grob: ein Fachbegriff für programmatische Nutzung und ein ' +
      'Abrechnungsbegriff im selben Satz. Ein Fehlalarm auf einer Dokumentationsseite ' +
      'ist damit möglich und die dritte Option ist dafür da. Was das Studio nicht kann, ' +
      'ist eine Ankündigung über seine eigene Finanzierung beurteilen.',
    options: [
      {
        title: 'Harte Pause — ich lese die Ankündigung selbst',
        pros: [
          'Nichts kann in der Zwischenzeit unbeabsichtigt abgerechnet werden (§2).',
          'A26s harte Pause parkt laufende Arbeit sauber; nichts geht verloren.',
        ],
        cons: [
          'Der Betrieb ruht, bis du geantwortet hast — bei einem Fehlalarm umsonst.',
          'Laufende Aufgaben brauchen danach die Integritätsprüfung nach §7.2.',
        ],
        recommended: true,
      },
      {
        title: 'Sparbetrieb (A22) einschalten und weiterlaufen',
        pros: [
          'Der Durchsatz sinkt, statt auf null zu gehen.',
          'Richtig, wenn die Änderung angekündigt, aber noch nicht wirksam ist.',
        ],
        cons: [
          'Ändert nichts am Mechanismus: bei einer echten Umstellung greift sie trotzdem.',
          'Verschiebt die Entscheidung nur, statt sie zu treffen.',
        ],
        recommended: false,
      },
      {
        title: 'Fehlalarm — weiterlaufen wie bisher',
        pros: ['Passend, wenn die Seite nur headless-Betrieb beschreibt, ohne etwas zu ändern.'],
        cons: [
          'Wenn die Einschätzung falsch ist, läuft Risiko Nr. 1 unbeobachtet weiter.',
          'Dieselbe Wortkombination meldet sich nicht noch einmal (die Fundstelle gilt als gemeldet).',
        ],
        recommended: false,
      },
    ],
  };
}

/** A10's breaking branch (decisions 4 and 5). */
export function majorUpdateCard(update: DependencyUpdate, projectName: string): RadarCard {
  const unreadable = update.bump === 'unknown';
  return {
    urgency: 'P2',
    question:
      `${projectName}: ${update.name} ${update.current} → ${update.latest} ` +
      `(${unreadable ? 'Version nicht lesbar' : 'Hauptversion'}) — aktualisieren?`,
    context:
      `Der Abhängigkeits-Radar (A10) hat für «${projectName}» ein Update gefunden, das ` +
      `nicht unbeaufsichtigt eingespielt wird: ${update.name} steht bei ${update.current}, ` +
      `der Kanal bietet ${update.latest}.\n\n` +
      (unreadable
        ? 'Die Versionsangabe ließ sich nicht als Semver lesen, die Größe des Schritts ist ' +
          'also unbekannt. Unlesbar wird hier immer wie «brechend» behandelt — die andere ' +
          'Richtung wäre ein unbeaufsichtigter Merge einer Änderung, die niemand eingeordnet hat.\n\n'
        : 'A10 lässt Patch- und Minor-Updates als Aufgabe durch die Gates laufen; eine ' +
          'Hauptversion kommt zu dir.\n\n') +
      `Deklariert in: ${list(update.importers)}\n\n` +
      'Was hier **nicht** geprüft wurde: der Changelog. Diese Erhebung ist bewusst ' +
      'deterministisch — sie liest Manifest und Lockfile und fragt den Kanal nach der ' +
      'neuesten Version. Ein Changelog zu lesen wäre eine Modellsitzung, und die ist ' +
      'nicht Teil dieses Scans. Die Optionen unten stützen sich deshalb auf die ' +
      'Versionen und darauf, welche Gates der Umstieg durchlaufen müsste, nicht auf ' +
      'eine Recherche der Änderungen.',
    options: [
      {
        title: 'Aktualisieren — Aufgabe anlegen',
        pros: [
          'Der Umstieg läuft über einen eigenen Zweig durch die vollen Basis-Gates (§11): ' +
            'was sichtbar bricht, erreicht `main` nicht.',
          'Der Rückstand wächst nicht weiter; jede weitere Version macht den Schritt größer.',
        ],
        cons: [
          'Eine Hauptversion kann sich zur Laufzeit anders verhalten, ohne dass ein Gate ' +
            'es sieht.',
          'Kostet einen vollen Durchlauf der Entwicklungskette.',
        ],
        recommended: true,
      },
      {
        title: 'Vorerst nicht — bei der nächsten Version erneut fragen',
        pros: [
          'Kostet nichts und ändert nichts.',
          'Richtig, wenn du den Changelog erst selbst lesen willst.',
        ],
        cons: [
          `Der Rückstand bleibt; die nächste Karte betrifft einen größeren Schritt.`,
          'Bei einem Sicherheitshinweis zu diesem Paket meldet sich der Radar getrennt — ' +
            'aber erst dann.',
        ],
        recommended: false,
      },
    ],
  };
}

/** A10's third branch: an advisory is P0 whatever the version class says. */
export function advisoryCard(
  advisories: readonly AdvisoryFinding[],
  projectName: string,
  update: DependencyUpdate | null,
): RadarCard {
  const first = advisories[0];
  const name = first?.name ?? 'unbekannt';
  const severities = [...new Set(advisories.map((advisory) => advisory.severity))].sort();

  return {
    urgency: 'P0',
    question: `${projectName}: Sicherheitshinweis zu ${name} — jetzt aktualisieren?`,
    context:
      `Der Advisory-Radar (A10) meldet ${advisories.length} Hinweis(e) zu ${name} ` +
      `in «${projectName}». Eingestuft als: ${severities.join(', ')}.\n\n` +
      `${list(
        advisories.map(
          (advisory) =>
            `${advisory.id} (${advisory.severity}): ${advisory.title}` +
            `${advisory.url ? ` — ${advisory.url}` : ''}`,
        ),
        5,
      )}\n\n` +
      (update
        ? `Verfügbar wäre ${update.latest} (installiert: ${update.current}). Ob diese ` +
          'Version den Hinweis tatsächlich behebt, ist hier nicht geprüft — der Radar ' +
          'vergleicht Versionen, er liest keine Sicherheitsmeldung.\n\n'
        : 'Der Kanal nennt keine neuere Version. Ein Update allein löst das hier also ' +
          'vermutlich nicht.\n\n') +
      'A10 macht Sicherheitshinweise ausdrücklich P0 — unabhängig davon, wie groß der ' +
      'Versionssprung wäre.',
    options: [
      {
        title: 'Aktualisieren — Aufgabe anlegen',
        pros: [
          'Der übliche Weg aus einem Hinweis heraus, und er läuft durch die vollen Gates.',
          'Auch dann sinnvoll, wenn unklar ist, ob genau diese Version es behebt.',
        ],
        cons: [
          update
            ? 'Der Sprung kann brechend sein; das Update wird nicht vorab bewertet.'
            : 'Ohne neuere Version im Kanal läuft die Aufgabe womöglich ins Leere.',
        ],
        recommended: true,
      },
      {
        title: 'Zur Kenntnis genommen — ich sehe es mir selbst an',
        pros: [
          'Richtig, wenn der Hinweis eine Fläche betrifft, die dieses Projekt nicht benutzt.',
          'Kostet keinen Durchlauf.',
        ],
        cons: [
          'Der Hinweis bleibt bestehen und meldet sich nicht noch einmal.',
          'Ein späterer Hinweis mit derselben Id ist damit ebenfalls still.',
        ],
        recommended: false,
      },
    ],
  };
}

/** A27: a CLI bump is a task, never an automatic update. */
export function cliUpdateTask(release: CliRelease): RadarTaskSpec {
  return {
    title: `Claude Code CLI ${release.pinned} → ${release.latest} prüfen (A27)`,
    description:
      `Der Release-Kanal meldet Version ${release.latest}; das Orchestrator-Image ist auf ` +
      `${release.pinned} festgenagelt (A27, \`CLAUDE_CLI_VERSION\`).\n\n` +
      'A27 lässt CLI-Updates ausdrücklich nur als Radar-Aufgabe durch die normalen Gates ' +
      'laufen, niemals automatisch: Anthropic verändert das headless-Verhalten aktiv, und ' +
      'eine feste Version plus vollständig ausgeschriebene Flags ist das, was den Runner ' +
      'überhaupt vorhersagbar macht.\n\n' +
      'Zu prüfen sind mindestens die Flächen, die dieses Projekt an der CLI bestreitet: ' +
      'A32s Laufgrenzen (`--max-turns` ist auf 2.1.220 aus `--help` verschwunden und wird ' +
      'nur noch von `gate:cli-contract` gehalten), §6.2s `stream-json`, A47s ' +
      '`--json-schema` inline und in draft-07, A49s MCP-Handschlag und A51s Hooks.',
    acceptanceCriteria: [
      `CLAUDE_CLI_VERSION steht auf ${release.latest} und das Image baut damit.`,
      '`pnpm gate:cli-contract` ist mit der neuen Version grün (A32).',
      '`pnpm check:mcp-handshake` und `pnpm check:hook-containment` sind grün (A49, A51).',
      'Abweichungen im Flag- oder Ereignisverhalten sind als Annahme angehängt (§0.5).',
    ],
    priority: RADAR_TASK_PRIORITY,
  };
}

/** A10's auto-task: one task, all routine updates (decision 6 of `dependencies.ts`). */
export function routineUpdateTask(
  updates: readonly DependencyUpdate[],
  projectName: string,
): RadarTaskSpec {
  const lines = updates.map(
    (update) => `- ${update.name}: ${update.current} → ${update.latest} (${update.bump})`,
  );
  return {
    title: `Abhängigkeiten aktualisieren: ${updates.length} Paket(e) (Patch/Minor)`,
    description:
      `Der Abhängigkeits-Radar (A10) hat für «${projectName}» ${updates.length} Update(s) ` +
      'gefunden, die nach A10 ohne Rückfrage durch die Gates laufen dürfen — Patch und ' +
      'Minor.\n\n' +
      `${list(lines, 40).replace(/, /g, '\n')}\n\n` +
      'Hauptversionen sind hier bewusst nicht dabei; die kommen als eigene Karte zum Betreiber. ' +
      'Ebenso wenig Pakete, zu denen ein Sicherheitshinweis vorliegt — die laufen über ' +
      'ihre eigene P0-Karte.',
    acceptanceCriteria: [
      'Alle genannten Pakete stehen auf der genannten Zielversion.',
      'Die Sperrdatei ist mit aktualisiert und eingecheckt.',
      '`pnpm gate` ist grün (§11s Basis-Gates, inklusive Tests und Typprüfung).',
    ],
    priority: ROUTINE_TASK_PRIORITY,
  };
}

/** The task the operator asked for by choosing `RADAR_APPROVE_INDEX` on a card (decision 2). */
export function approvedUpdateTask(input: {
  name: string;
  current: string;
  latest: string;
  projectName: string;
  escalationNumber: number;
  advisory: boolean;
}): RadarTaskSpec {
  return {
    title: `${input.name} ${input.current} → ${input.latest} aktualisieren`,
    description:
      `Der Betreiber hat das über Entscheidung #${input.escalationNumber} freigegeben ` +
      `(${input.advisory ? 'Sicherheitshinweis' : 'Hauptversion'}, A10).\n\n` +
      `Projekt: ${input.projectName}. Installiert: ${input.current}. Ziel: ${input.latest}.\n\n` +
      (input.advisory
        ? 'Der Anlass ist ein Sicherheitshinweis. Ob die Zielversion ihn behebt, ist ' +
          'nicht vorab geprüft — falls nicht, gehört das als Fund zurück in die Karte, ' +
          'statt die Aufgabe grün zu melden.'
        : 'Es ist ein Sprung über eine Hauptversion: mit brechenden Änderungen ist zu ' +
          'rechnen, und Tests, die deshalb angepasst werden, gehören einzeln begründet.'),
    acceptanceCriteria: [
      `${input.name} steht auf ${input.latest}.`,
      'Die Sperrdatei ist mit aktualisiert und eingecheckt.',
      '`pnpm gate` ist grün.',
    ],
    priority: RADAR_TASK_PRIORITY,
  };
}
