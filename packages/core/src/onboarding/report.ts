/**
 * The onboarding proposal as the operator reads it (§20, §15, §2).
 *
 * §20 ends with "the operator confirms/edits via one multiple-choice escalation", and §15
 * fixes what such an item looks like: context in three to five sentences, the
 * department it came from, two to four researched options each with pros and
 * cons, exactly one marked as the recommendation, and a free-text answer always
 * available. This renders that.
 *
 * **Rendered here, not written by the model** — the same decision the
 * Prüfbericht made (A56.3), for the same reason. Every section maps onto data
 * that already exists: the gate list, the command verdicts, the deferrals, the
 * survey. Asking the model to also produce the German document would add a
 * second place for the proposal and the record to disagree, and would turn the
 * options into something a model chooses rather than something the situation
 * dictates. What the model wrote is quoted — its rationales and its summary —
 * and everything around them is assembled.
 *
 * The options are derived from the project's own state rather than invented per
 * call, because there are genuinely only a few things the operator can do with a
 * proposal, and which of them apply depends on whether the project is
 * analysis-only (A41) and whether the proposal survived verification at all.
 *
 * The document is still written to `docs/onboarding/` — it is longer than a card
 * and it is the artefact somebody reads before deciding — but the decision
 * itself now goes where §20 says it goes: `proposalEscalation` renders the same
 * options as a §15 inbox item, and `onboard.mjs` raises it. Until this existed
 * the options were built, formatted, and posted nowhere.
 */
import {
  gateDefinition,
  MAX_ESCALATION_CONTEXT_LENGTH,
  MAX_ESCALATION_QUESTION_LENGTH,
  type OnboardingResult,
} from '@vorschicht/shared';
import type { EscalationService } from '../escalation-service.js';
import type { RepositorySurvey } from './survey.js';
import type { VerifiedProposal } from './verify.js';

export interface OnboardingReportInput {
  slug: string;
  /** Human name of the project. */
  name: string;
  survey: RepositorySurvey;
  result: OnboardingResult;
  verification: VerifiedProposal;
  /** A41 — the project is analysed and never written to. Decides the options. */
  readOnly: boolean;
  /** The run that produced it, so the trace is reachable from the document. */
  runId: string;
  /** ISO date. Injected so this function is not a clock. */
  date: string;
}

export interface ReportOption {
  title: string;
  pros: string[];
  cons: string[];
  recommended: boolean;
}

export function renderOnboardingProposal(input: OnboardingReportInput): string {
  const { survey, result, verification } = input;
  const options = proposalOptions(input);

  const lines: string[] = [
    `# Onboarding-Vorschlag: ${input.name} (\`${input.slug}\`)`,
    '',
    `**Von:** Produktleitung (Petra) · **Projekt:** \`${input.slug}\` · ` +
      `**Dringlichkeit:** P2 · **Datum:** ${input.date}`,
    `**Lauf:** \`${input.runId}\` · **Pfad:** \`${survey.rootPath}\``,
    '',
    '## Kontext',
    '',
    ...contextParagraph(input),
    '',
    '## Vorgeschlagene Konfiguration',
    '',
    `**Stack:** ${result.stack}`,
    '',
    `**Integrationszweig:** \`${verification.defaultBranch ?? '(unbestimmt)'}\` — ` +
      `${survey.git.defaultBranchSource}`,
    ...(survey.git.checkedOutBranch && survey.git.checkedOutBranch !== verification.defaultBranch
      ? [
          '',
          `Im Arbeitsverzeichnis ausgecheckt ist allerdings \`${survey.git.checkedOutBranch}\`. ` +
            '§10 schneidet jeden Task-Zweig vom Integrationszweig ab, also ist das die Zeile, ' +
            'die du prüfen solltest, bevor in diesem Projekt je etwas geschrieben wird.',
        ]
      : []),
    '',
    `**Anspruchs-Granularität (§10):** \`${verification.claimGranularity}\` — ${result.claimRationale}`,
    '',
    `**Deployment (§12):** \`${String(verification.deployConfig.method)}\` — ${result.deploy.rationale}`,
    '',
    '### Gates (§11)',
    '',
    ...gateTable(input),
    '',
  ];

  if (verification.commands.length > 0) {
    lines.push(
      '### Woher die Befehle stammen',
      '',
      'Jeder vorgeschlagene Befehl ist gegen das Projekt selbst geprüft worden, nicht',
      'nur übernommen — ein Gate mit einem Befehl, den es nicht gibt, blockiert nie und',
      'wird nie rot, sondern meldet auf Dauer einen Infrastrukturfehler (A25/A55.3).',
      '',
      ...verification.commands.map(
        (command) =>
          `- \`${command.command}\` (${gateDefinition(command.gate).label}) — ` +
          `${statusWord(command.status)}: ${command.detail}`,
      ),
      '',
    );
  }

  if (verification.errors.length > 0) {
    lines.push(
      '### Was so nicht übernommen werden kann',
      '',
      'Diese Punkte sind nachweislich falsch, nicht bloß ungeprüft. Der Vorschlag ist',
      'in dieser Form **nicht** übernehmbar.',
      '',
      ...verification.errors.map((error) => `- ${error}`),
      '',
    );
  }

  if (verification.deferred.length > 0) {
    lines.push(
      '### Richtig, aber noch nicht baubar',
      '',
      ...verification.deferred.map((item) => `- **${item.subject}** — ${item.reason}`),
      '',
    );
  }

  if (verification.notes.length > 0) {
    lines.push('### Was offen bleibt', '', ...verification.notes.map((note) => `- ${note}`), '');
  }

  if (result.personalData.present || result.personalData.evidence.length > 0) {
    lines.push(
      '### Personenbezogene Daten',
      '',
      result.personalData.present
        ? 'Der Vorschlag sieht Anhaltspunkte für personenbezogene Daten:'
        : 'Keine personenbezogenen Daten erkannt; gefundene Anhaltspunkte trotzdem gelistet:',
      '',
      ...result.personalData.evidence.map((evidence) => `- \`${evidence}\``),
      '',
      'Ob daraus ein Rechts-Gate folgt, ist deine Entscheidung und Lenas Fach (Phase 6).',
      '',
    );
  }

  if (result.risks.length > 0) {
    lines.push('### Risiken laut Vorschlag', '', ...result.risks.map((risk) => `- ${risk}`), '');
  }

  if (result.departments.length > 0) {
    lines.push(`**Zuständige Abteilungen (§8):** ${result.departments.join(', ')}`, '');
  }

  lines.push(
    '## Einschätzung der Produktleitung',
    '',
    result.summary.trim() || '(keine)',
    '',
    '## Optionen',
    '',
    ...options.flatMap((option, index) => [
      `### ${index + 1}. ${option.title}${option.recommended ? ' *(Empfehlung)*' : ''}`,
      '',
      ...option.pros.map((pro) => `- **Dafür:** ${pro}`),
      ...option.cons.map((con) => `- **Dagegen:** ${con}`),
      '',
    ]),
    '**Freitext ist wie immer möglich** — etwa ein anderer Befehl, ein anderer',
    'Integrationszweig, oder ein Gate mehr oder weniger.',
    '',
    '## Erhebung, auf der das beruht',
    '',
    ...survey.sources.map((source) => `- ${source}`),
    ...(survey.gaps.length > 0
      ? ['', '**Lücken der Erhebung:**', ...survey.gaps.map((gap) => `- ${gap}`)]
      : []),
    '',
  );

  return lines.join('\n');
}

function contextParagraph(input: OnboardingReportInput): string[] {
  const { survey, verification } = input;
  return [
    `Das Repository unter \`${survey.rootPath}\` ist analysiert worden: ` +
      `${survey.inventory.fileCount} versionierte Dateien, ` +
      `${survey.git.commitCount ?? '?'} Commits, zuletzt ${survey.git.lastCommit ?? 'unbekannt'}.`,
    'Der Vorschlag legt fest, welche Prüfungen künftig vor jedem Merge in diesem ' +
      'Projekt laufen, wie fein Arbeit darin aufgeteilt wird und ob es ausgerollt wird.',
    verification.ok
      ? 'Er ist maschinell geprüft und in dieser Form übernehmbar.'
      : 'Er ist maschinell geprüft und in dieser Form **nicht** übernehmbar — siehe unten.',
    'Bis du entscheidest, ist nichts angelegt und nichts angefasst worden: die Analyse ' +
      'ist ein Trockenlauf ohne jeden Schreibzugriff auf das Projekt (§20).',
  ];
}

function gateTable(input: OnboardingReportInput): string[] {
  const { result, verification } = input;
  const byId = new Map(result.gates.map((gate) => [gate.id, gate]));
  const config = verification.config;

  const rows: string[] = ['| Gate | Zustand | Befehl | Begründung |', '|---|---|---|---|'];
  for (const entry of result.gates) {
    const definition = gateDefinition(entry.id);
    const deferred = verification.deferred.some((item) => item.subject === entry.id);
    const active = config
      ? definition.locked || config.gates[entry.id] === true
      : entry.enabled && !deferred;
    const state = deferred
      ? 'verschoben'
      : definition.locked
        ? 'gesperrt (läuft immer)'
        : active
          ? 'an'
          : 'aus';
    const command = config?.commands[entry.id] ?? entry.command ?? '—';
    rows.push(
      `| ${definition.label} | ${state} | \`${command}\` | ${entry.rationale.replace(/\|/g, '\\|')} |`,
    );
  }
  // Locked gates the proposal did not mention at all still run, and a table that
  // silently omitted them would be a table of what the model thought about
  // rather than of what will happen.
  for (const id of ['review', 'typecheck', 'lint', 'test', 'secrets', 'build'] as const) {
    if (byId.has(id)) continue;
    const definition = gateDefinition(id);
    rows.push(
      `| ${definition.label} | gesperrt (läuft immer) | — | Vom Vorschlag nicht erwähnt; ` +
        `läuft nach §11 trotzdem${definition.needsCommand ? ' — ohne Befehl also ungeprüft' : ''}. |`,
    );
  }
  return rows;
}

function statusWord(status: 'declared' | 'unverifiable' | 'undeclared'): string {
  if (status === 'declared') return 'belegt';
  if (status === 'unverifiable') return 'nicht prüfbar';
  return 'nicht vorhanden';
}

/**
 * The same proposal as an inbox item (§20's "one multiple-choice escalation").
 *
 * §22's Phase 4 step 5 lists `gate_proposal` among the producers to wire, and
 * the card was already here — `proposalOptions` has always produced §15's two
 * to four researched options with their pros, cons and single recommendation.
 * What was missing was somebody calling `EscalationService.raise` with them, so
 * the format existed and the inbox did not.
 *
 * The context is deliberately short and points at the document rather than
 * reproducing it: a gate table does not fit on a card, and a card that tries is
 * one nobody reads to the end. §15 asks for three to five sentences and this is
 * the one place where the long form genuinely exists elsewhere.
 *
 * Both free-text fields are clipped to what the schema accepts. A proposal
 * refused *by its own card* would be the worst of both worlds — the session is
 * paid for, the document is written, and the decision never arrives.
 */
export function proposalEscalation(
  input: OnboardingReportInput,
  documentPath?: string,
): { question: string; context: string; urgency: 'P2'; options: ReportOption[] } {
  const { survey, verification } = input;
  const gates = Object.entries(verification.config?.gates ?? {}).filter(([, on]) => on).length;

  const context = [
    `Das Repository \`${survey.rootPath}\` ist analysiert worden (${survey.inventory.fileCount} ` +
      `versionierte Dateien). Der Vorschlag legt fest, welche Prüfungen künftig vor jedem Merge ` +
      `in diesem Projekt laufen — ${gates} Gate(s) aktiv —, wie fein Arbeit darin aufgeteilt ` +
      `wird (\`${verification.claimGranularity}\`) und ob es ausgerollt wird ` +
      `(\`${String(verification.deployConfig.method)}\`).`,
    verification.ok
      ? 'Er ist maschinell geprüft und in dieser Form übernehmbar.'
      : `Er ist maschinell geprüft und in dieser Form **nicht** übernehmbar: ` +
        `${verification.errors.join(' ')}`,
    'Bis du entscheidest, ist nichts angelegt und nichts angefasst worden — die Analyse war ' +
      'ein Trockenlauf ohne jeden Schreibzugriff auf das Projekt (§20).',
    documentPath
      ? `Die vollständige Tabelle mit Befehlen, Begründungen und Lücken steht in \`${documentPath}\`.`
      : 'Die vollständige Tabelle mit Befehlen, Begründungen und Lücken steht im Vorschlagsdokument.',
  ].join(' ');

  return {
    question: cut(
      `Onboarding-Vorschlag für ${input.name} (\`${input.slug}\`) übernehmen?`,
      MAX_ESCALATION_QUESTION_LENGTH,
    ),
    context: cut(context, MAX_ESCALATION_CONTEXT_LENGTH),
    urgency: 'P2',
    options: proposalOptions(input),
  };
}

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 2)}…`;
}

/**
 * Put the proposal in front of the operator, and say whether it got there.
 *
 * The delivery lives here rather than in the script that runs an onboarding for
 * the same reason `AuditService.deliver` does: `infra/scripts/onboard.mjs` is
 * untyped `.mjs`, outside every step of `pnpm gate`, and its only exercise is a
 * paid model session. A producer whose *content* — the source, the urgency, the
 * options, the deliberate nulls — is checked by nothing would be the shape this
 * whole change set exists to remove, one directory over. What is left in the
 * script is one call.
 *
 * Returns null rather than throwing. The analysis is the expensive half and it
 * is already on disk by the time this runs, so an unreachable inbox must cost
 * the notification, never the proposal.
 */
export async function raiseProposal(
  inbox: Pick<EscalationService, 'raise'>,
  input: OnboardingReportInput,
  options: { documentPath?: string; raisedBy?: string; onWarning?(message: string): void } = {},
): Promise<number | null> {
  const card = proposalEscalation(input, options.documentPath);
  try {
    const raised = await inbox.raise({
      source: 'gate_proposal',
      question: card.question,
      context: card.context,
      urgency: card.urgency,
      options: card.options,
      // No project yet — that is the whole point of a dry run (§20, A70.3), and
      // it is what the answer decides. No task and no session either: nobody is
      // parked on this, so `Scheduler.resumeDecided` must never see it.
      projectId: null,
      taskId: null,
      runId: null,
      raisedBy: options.raisedBy ?? 'onboarding',
    });
    return raised.number;
  } catch (error) {
    options.onWarning?.(
      `Der Onboarding-Vorschlag für ${input.slug} konnte nicht ins Postfach gelegt werden: ` +
        `${(error as Error).message}. Das Dokument steht trotzdem.`,
    );
    return null;
  }
}

/**
 * The two to four things the operator can actually do (§15).
 *
 * Derived, not written: which options exist depends on whether the proposal
 * survived verification and whether the project is analysis-only, and a fixed
 * list would offer him "übernehmen" for a proposal that cannot be taken over.
 */
export function proposalOptions(input: OnboardingReportInput): ReportOption[] {
  const { verification } = input;

  if (!verification.ok) {
    return [
      {
        title: 'Vorschlag zurückweisen und neu erheben lassen',
        pros: [
          'Die genannten Punkte sind nachweislich falsch, nicht Geschmackssache — ' +
            'sie kosten einen zweiten Lauf und keine Diskussion.',
        ],
        cons: ['Kostet eine weitere Sitzung.'],
        recommended: true,
      },
      {
        title: 'Die beanstandeten Punkte selbst korrigieren und dann übernehmen',
        pros: ['Schneller, wenn du ohnehin weißt, wie die Befehle in diesem Projekt heißen.'],
        cons: [
          'Die übrigen Vorschläge sind dann von einem Lauf, dessen Ausgabe in Teilen ' +
            'falsch war — das ist ein Grund, den Rest genauer zu lesen.',
        ],
        recommended: false,
      },
    ];
  }

  const mergeRisk =
    verification.missingCommands.length > 0
      ? 'Gesperrte Gates ohne Befehl melden beim ersten Merge einen Befund — das Projekt ' +
        'käme so nicht durch die Warteschlange.'
      : 'Der erste echte Merge in einem fremden Projekt ist der Moment, in dem sich zeigt, ' +
        'ob die Befehle stimmen.';

  return [
    {
      title: input.readOnly
        ? 'So übernehmen — Projekt anlegen, weiterhin nur analysieren'
        : 'So übernehmen — Projekt anlegen und für Arbeit freigeben',
      pros: [
        input.readOnly
          ? 'Das Projekt ist danach im Studio sichtbar und seine Gate-Konfiguration steht ' +
            'fest, ohne dass irgendetwas darin geschrieben werden darf (A41).'
          : 'Das Studio kann in diesem Projekt planen, bauen, prüfen und zusammenführen — ' +
            'unter den Gates aus der Tabelle oben.',
        'Jede spätere Änderung an dieser Konfiguration ist ein eigener, protokollierter Schritt.',
      ],
      cons: [
        input.readOnly
          ? 'Es passiert zunächst nichts — das Projekt liegt da und wird nicht bearbeitet.'
          : mergeRisk,
      ],
      recommended: true,
    },
    input.readOnly
      ? {
          title: 'Übernehmen und Schreibrechte freigeben',
          pros: [
            'Das Studio kann in diesem Projekt planen, bauen, prüfen und zusammenführen — ' +
              'unter den Gates aus der Tabelle oben.',
          ],
          cons: [
            'A41 hält dieses Projekt bewusst bei reiner Analyse; die Freigabe ist die ' +
              'Entscheidung, die diese Grenze aufhebt.',
            mergeRisk,
          ],
          recommended: false,
        }
      : {
          title: 'Übernehmen, aber zunächst nur lesend',
          pros: [
            'Die Konfiguration steht, und der erste Merge wartet, bis du sie einmal gegen ' +
              'ein echtes Vorhaben gesehen hast.',
          ],
          cons: ['Das Projekt bleibt so lange unbearbeitet.'],
          recommended: false,
        },
    {
      title: 'Nicht übernehmen',
      pros: ['Nichts ändert sich; der Vorschlag bleibt als Dokument liegen.'],
      cons: ['Die Analyse ist bezahlt und verfällt; ein späterer Anlauf beginnt wieder von vorn.'],
      recommended: false,
    },
  ];
}
