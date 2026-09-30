/**
 * The Prüfbericht (§8.2).
 *
 * > "German (§2), hard length cap, archived with `reports`, linked from the
 * > timeline of every finding it raises, and it ends with exactly one verdict
 * > from a closed set. Structure: 1. Prüfumfang und Stichprobe · 2. Bestätigte
 * > Funde (mit Beleg, je mit Task-Verweis) · 3. Verdachtsmomente · 4. Nicht
 * > prüfbar · 5. Revidierte Annahmen · 6. Urteil."
 *
 * **Rendered here, not written by the model.** Those six sections map exactly
 * onto the fields the auditor already returns — sample, findings, suspicions,
 * scope limits, expired assumptions, verdict — so asking the model to also
 * produce six headings would add a way for the report and the record to
 * disagree, and would make the length cap a request rather than a fact. What
 * the model writes is the one thing a template cannot: the prose that says what
 * this audit actually found. Everything around it is assembled from the data.
 *
 * **The cap truncates the prose, never the findings.** A report trimmed to fit
 * that dropped its last finding would be the worst possible artefact — shorter,
 * plausible, and missing the thing it exists to carry.
 */
import type { AuditorResult } from '@vorschicht/shared';

/**
 * Hard cap, in characters (§8.2).
 *
 * Sized so a full audit — a dozen findings with their evidence — fits, while a
 * model in a bad mood cannot produce something nobody reads. §16's weekly
 * report inherits the same posture.
 */
export const REPORT_MAX_CHARS = 16_000;

/**
 * What a truncated prose section says instead of the prose.
 *
 * The first real audit produced a report whose findings alone filled the cap,
 * and the reader was told "(Der Bericht enthielt keinen Fließtext.)" — which
 * was false, and false in the direction that matters: it read as an auditor
 * that had nothing to say. A report that dropped something has to say it
 * dropped something. The full text is on the audit's `finished` event either
 * way, so nothing is lost, only moved.
 */
const PROSE_CUT =
  '_Der Fließtext wurde vollständig gekürzt: die Funde hatten Vorrang vor der ' +
  'Längengrenze. Der ungekürzte Wortlaut steht am Prüfungsdatensatz._';
const PROSE_MISSING = '(Der Bericht enthielt keinen Fließtext.)';

/** Section 5 is exactly this class; the taxonomy already separates them. */
const ASSUMPTION_CLASS = 'assumption_expired';
const SUSPICION_CLASS = 'suspicion';

/**
 * How many characters of the audit id identify a report — in its heading and
 * in its filename, from **one** constant, because those two must not drift.
 */
const ID_PREFIX = 8;

/**
 * Where a Prüfbericht is archived (§8.2, `docs/pruefberichte/`).
 *
 * **The id is in the name because a date and a domain are not unique, and the
 * file is the durable half of the record.** A phase close always draws
 * `gate_truth` (A56.1) and a phase can close on a day another audit already
 * ran; on 2026-08-02 exactly that happened, and the Phase-3 report was
 * overwritten by the Phase-4 one. §8.2 makes the committed report the part
 * that survives a throwaway database (A56's recorded limitation), so an
 * overwrite there does not lose a duplicate — it loses the only copy, and
 * leaves the gate that cites it pointing at a document about a different
 * audit. Which is what happened: `CLAUDE.md`'s P3.G7 evidence line named a
 * file that by then held audit `67ac096c`.
 *
 * Note what the caller pairs this with: `flag: 'wx'`. The id makes a
 * collision practically impossible, and if one ever occurs the run must fail
 * rather than replace the older report. A safety property with no way to fire
 * is one nobody can trust.
 */
export function pruefberichtDateiname(input: {
  auditId: string;
  /** ISO date, `YYYY-MM-DD`. */
  date: string;
  domain: string;
}): string {
  return `${input.date}-${input.auditId.slice(0, ID_PREFIX)}-${input.domain}.md`;
}

export interface ReportInput {
  auditId: string;
  /** German domain label, e.g. "Gate-Wahrheit". */
  domainLabel: string;
  domain: string;
  scope: string;
  trigger: string;
  /** What the service drew, as opposed to what the auditor says it examined. */
  proposedSample: readonly string[];
  result: AuditorResult;
  /** Finding id → the fix task it produced, so section 2 carries the reference. */
  taskRefs?: Readonly<Record<string, string>>;
  /**
   * Finding id → what the consequence did, or why it could not. German.
   *
   * Called `applied` until 0018, one letter from the boolean column of that name
   * meaning "was it carried out". Two different facts must not share a name in
   * the artefact whose job is to tell a claim from its evidence.
   */
  consequences?: Readonly<Record<string, string>>;
  /** ISO date. Injected so the report is not a clock. */
  date: string;
}

const VERDICT_TEXT: Record<AuditorResult['verdict'], string> = {
  unbedenklich: 'unbedenklich — nichts gefunden, das etwas ändert.',
  funde_zu_beheben: 'funde_zu_beheben — echte Funde, keiner davon entwertet ein Gate.',
  phase_nicht_abschliessbar:
    'phase_nicht_abschliessbar — mindestens ein Gate ist entwertet; die Phase ist wieder offen.',
};

const CLASS_LABEL: Record<string, string> = {
  gate_invalid: 'Gate entwertet',
  defect: 'Defekt',
  process: 'Verfahren',
  coverage_gap: 'Fehlender Nachweis',
  assumption_expired: 'Annahme überholt',
  suspicion: 'Verdacht',
};

export function renderPruefbericht(input: ReportInput): string {
  const { result } = input;
  const confirmed = result.findings.filter(
    (finding) => finding.class !== SUSPICION_CLASS && finding.class !== ASSUMPTION_CLASS,
  );
  const suspicions = result.findings.filter((finding) => finding.class === SUSPICION_CLASS);
  const assumptions = result.findings.filter((finding) => finding.class === ASSUMPTION_CLASS);

  const head = [
    `# Prüfbericht ${input.auditId.slice(0, ID_PREFIX)} — ${input.domainLabel}`,
    '',
    `**Datum:** ${input.date} · **Anlass:** ${input.trigger} · **Domäne:** \`${input.domain}\``,
    '',
    '## 1. Prüfumfang und Stichprobe',
    '',
    input.scope,
    '',
    `Gezogen (${input.proposedSample.length}): ${list(input.proposedSample)}`,
    `Geprüft laut Bericht (${result.sample.length}): ${list(result.sample)}`,
    ...divergenceNote(input.proposedSample, result.sample),
  ];

  const body = [
    '',
    '## 2. Bestätigte Funde',
    '',
    ...(confirmed.length > 0
      ? confirmed.flatMap((finding, index) => {
          const id = findingKey(finding);
          return [
            `**${index + 1}. ${CLASS_LABEL[finding.class] ?? finding.class}${
              finding.gate ? ` (${finding.gate})` : ''
            }** — ${finding.summary}`,
            `   Beleg: ${finding.evidence}`,
            ...(finding.guard
              ? [`   Vorgeschlagene mechanische Absicherung: ${finding.guard}`]
              : []),
            ...(finding.reopens ? [`   Wiederaufgenommen: Fund ${finding.reopens}`] : []),
            ...(input.taskRefs?.[id] ? [`   Aufgabe: ${input.taskRefs[id]}`] : []),
            ...(input.consequences?.[id] ? [`   Folge: ${input.consequences[id]}`] : []),
            '',
          ];
        })
      : ['Keine.', '']),
    '## 3. Verdachtsmomente',
    '',
    ...(suspicions.length > 0
      ? suspicions.flatMap((finding) => [
          `- ${finding.summary}`,
          `  Anhaltspunkt: ${finding.evidence}`,
        ])
      : ['Keine.']),
    '',
    '## 4. Nicht prüfbar',
    '',
    // §8.2: reported as prominently as a finding — an unexamined area is not a
    // clean one, and an empty list here is itself a claim.
    ...(result.scopeLimits.length > 0
      ? result.scopeLimits.map((limit) => `- ${limit}`)
      : [
          'Keine Einschränkungen gemeldet — der Bericht behauptet damit, den ganzen Umfang geprüft zu haben.',
        ]),
    '',
    '## 5. Revidierte Annahmen',
    '',
    ...(assumptions.length > 0
      ? assumptions.flatMap((finding) => [
          `- ${finding.summary}`,
          `  Beleg: ${finding.evidence}`,
          ...(input.consequences?.[findingKey(finding)]
            ? [`  Folge: ${input.consequences[findingKey(finding)]}`]
            : []),
        ])
      : ['Keine.']),
  ];

  const tail = ['', '## 6. Urteil', '', VERDICT_TEXT[result.verdict]];

  // The prose is the only part that may be cut, and it is cut last: everything
  // structural is assembled first so the cap is applied to what is left over.
  const fixed = [...head, ...body, ...tail].join('\n');
  const budget = REPORT_MAX_CHARS - fixed.length - PROSE_HEADING.length - PROSE_CUT.length - 8;
  const written = result.summary.trim();
  const prose = clamp(written, Math.max(0, budget));

  return [
    ...head,
    '',
    PROSE_HEADING,
    '',
    written === '' ? PROSE_MISSING : prose === '' ? PROSE_CUT : prose,
    ...body,
    ...tail,
    '',
  ].join('\n');
}

const PROSE_HEADING = '### Zusammenfassung des Prüfers';

/** A stable key for a finding inside one result. */
export function findingKey(finding: AuditorResult['findings'][number]): string {
  return `${finding.class}:${finding.summary}`;
}

function list(items: readonly string[]): string {
  return items.length > 0 ? items.map((item) => `\`${item}\``).join(', ') : '—';
}

/**
 * Did the auditor examine what it was handed?
 *
 * The cheapest possible check on the auditor itself, and the reason `audits`
 * keeps both samples: a run whose reported sample shares nothing with the drawn
 * one examined something else, and only the pair can say so. Reported, never
 * acted on — this is an observation for whoever reads the report, not a verdict
 * about the verdict.
 */
function divergenceNote(proposed: readonly string[], reported: readonly string[]): string[] {
  if (proposed.length === 0) return [];
  const drawn = new Set(proposed);
  const covered = reported.filter((item) => drawn.has(item)).length;
  if (covered === proposed.length) return [];
  const missing = proposed.filter((item) => !reported.includes(item));
  return [
    '',
    `**Hinweis:** ${covered} von ${proposed.length} gezogenen Positionen tauchen im Bericht ` +
      `wieder auf. Nicht wiedergefunden: ${list(missing)}. Das ist kein Urteil über den ` +
      'Bericht — Positionen können unter anderem Namen geprüft worden sein —, aber es ist ' +
      'der einzige Abgleich, den die Aufzeichnung selbst erlaubt.',
  ];
}

function clamp(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 1) return '';
  return `${text.slice(0, max - 1).trimEnd()}…`;
}
