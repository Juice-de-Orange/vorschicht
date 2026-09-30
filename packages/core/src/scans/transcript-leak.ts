/**
 * §6.6's nightly gitleaks run over new transcripts, and A21's P0 card.
 *
 * Both halves have existed separately since Phase 2 and were never joined:
 * `transcripts.ts` archives every session's JSONL (§6.2, A15), the gitleaks
 * scanner has run the merge gate since Phase 3, and `transcript_leak` has sat in
 * `ESCALATION_SOURCES` with a German label and no producer. A signal path that
 * cannot carry a signal is §8.2's sixth domain, and this one guards the file
 * class most likely to contain a credential by accident: a session's own log,
 * where a model may have echoed an environment variable, a config file or a
 * command it was asked to run.
 *
 * Six decisions.
 *
 *  1. **Only new transcripts, and "new" is a day directory.** §6.6 says "over
 *     new transcripts"; the archive keeps a year (A15), so re-scanning the whole
 *     volume every night would cost more every night and would re-report the
 *     same file forever. The layout is `<root>/<YYYY-MM-DD>/<runId>.jsonl`, so
 *     the unit is the day: everything from the last scan's day onward, which
 *     deliberately includes that day again — the directory was still growing
 *     when it was last read.
 *
 *  2. **The marker is the event log, never a process variable.** A nightly job
 *     is rarer than a restart, and a deploy is a restart (A57): a counter that
 *     resets would re-announce the whole archive every time. Same rule and same
 *     reason as `escalation-mail.ts`'s `lastDigestAt` and `backup-pass.ts`.
 *
 *  3. **Dedup is by (file, rule) and it is load-bearing, not tidiness.**
 *     Decision 1 rescans the current day, so without it the same finding raises
 *     a card every night until the day rolls over — and A21 makes this P0, so
 *     that is a P0 a night for one leak. The rule this project has written down
 *     three times (A67.6, A86.5, A102): a channel that repeats gets muted, and
 *     then the next real alarm is invisible.
 *
 *  4. **The card names the class and the file, never the finding.** A21 asks for
 *     "the secret class so the operator can rotate immediately", and a secret quoted into
 *     an escalation is the same secret in a second place — one that §18 keeps
 *     forever and that the dashboard renders. The card is built from
 *     `SecretScanFinding`, which carries `rule`, `file` and `line` and has no
 *     field for the match, so this is structural rather than a filter somebody
 *     could forget. `--redact` is on in `gitleaksArgv` besides.
 *
 *  5. **One card per scan, not one per finding.** Rotation is per class: ten
 *     findings of `anthropic-oauth-token` are one action. Ten cards would be the
 *     muted channel of decision 3 arriving through the other door.
 *
 *  6. **A scan that could not read is `infra`, never "clean".** A104.4 measured
 *     why this matters here specifically: `gitleaks dir` on a missing directory
 *     exits 0 with an empty report, and so does an unreadable file — and A103's
 *     transcripts are mode 0600. "We could not look" and "there is nothing" are
 *     the same sentence only to a system that has decided not to notice
 *     (A83.6, A87.6, A99.4).
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { EscalationSource } from '@vorschicht/shared';
import type { EventLog } from '../event-log.js';
import type { DirectoryScanner, SecretScanFinding } from '../secret-scan.js';

/** `<root>/<YYYY-MM-DD>/` — the archive's own layout (`transcripts.ts`). */
const DAY_DIRECTORY = /^\d{4}-\d{2}-\d{2}$/;

/** A21/§6.6: a leaked credential is the one thing that burns without the operator. */
const LEAK_URGENCY = 'P0' as const;
const LEAK_SOURCE: EscalationSource = 'transcript_leak';

export interface TranscriptLeakScanDeps {
  /** `<dataRoot>/transcripts` — `Config.transcriptsRoot`. */
  transcriptsRoot: string;
  /** Passed, never discovered — A104.5: an archive directory has no repo config. */
  gitleaksConfigPath: string;
  scanner: DirectoryScanner;
  eventLog: EventLog;
  escalations: {
    raise(input: {
      source: EscalationSource;
      urgency: 'P0' | 'P1' | 'P2' | 'P3';
      question: string;
      context: string;
      options: Array<{ title: string; pros: string[]; cons: string[]; recommended: boolean }>;
      raisedBy: string;
    }): Promise<{ number: number }>;
  };
  now?: () => number;
}

export type TranscriptLeakOutcome =
  /** Nothing new, or nothing found in what was new. */
  | { kind: 'clean'; daysScanned: number }
  /** Findings that were not reported before — exactly one card was raised. */
  | { kind: 'leak'; daysScanned: number; findings: SecretScanFinding[]; escalation: number }
  /** Findings, all of them already reported. No card, and that is the point. */
  | { kind: 'already_reported'; daysScanned: number; findings: SecretScanFinding[] }
  /** Could not look. Never "clean" — decision 6. */
  | { kind: 'infra'; problem: string };

/** The classes found, deduplicated and ordered, for the card's headline. */
export function secretClasses(findings: readonly SecretScanFinding[]): string[] {
  return [...new Set(findings.map((f) => f.rule))].sort();
}

/**
 * The §15 card. Pure, so its wording is testable without a scan.
 *
 * The options are the three things the operator can actually do with a leaked credential,
 * and the recommendation does not move: rotating is cheap, and a token that
 * might be in an archive is a token to replace. The other two exist because
 * §15 requires a real choice — "I have already rotated it" is the common case
 * after he acts, and "it is a false positive" is what a `generic-api-key` hit on
 * a fixture deserves.
 */
export function leakCard(findings: readonly SecretScanFinding[]): {
  question: string;
  context: string;
  urgency: typeof LEAK_URGENCY;
  options: Array<{ title: string; pros: string[]; cons: string[]; recommended: boolean }>;
} {
  const classes = secretClasses(findings);
  const files = [...new Set(findings.map((f) => f.file))].sort();
  const shown = files.slice(0, 5);
  const more = files.length - shown.length;

  return {
    question: `Zugangsdaten in Sitzungsprotokollen gefunden (${classes.join(', ')}) — rotieren?`,
    context:
      `Der nächtliche Scan nach §6.6 hat in archivierten Sitzungsprotokollen ${findings.length} ` +
      `Fundstelle${findings.length === 1 ? '' : 'n'} der Klasse${classes.length === 1 ? '' : 'n'} ` +
      `${classes.join(', ')} gemeldet.\n\n` +
      `Betroffen: ${shown.join(', ')}${more > 0 ? ` und ${more} weitere` : ''}.\n\n` +
      'Der Fund selbst steht bewusst nirgends — weder hier noch im Ereignisprotokoll. ' +
      'Er wäre dann dasselbe Geheimnis an einem zweiten Ort, und §18 hebt das ' +
      'Ereignisprotokoll für immer auf. Genannt sind die Klasse und die Datei, was ' +
      'zum Rotieren reicht (A21).\n\n' +
      'Ein Transkript ist keine versionierte Datei: es liegt im Transkript-Volume und ' +
      'ist Teil der nächtlichen Sicherung (A14). Ein Geheimnis darin ist damit auch ' +
      'in den Sicherungen.',
    urgency: LEAK_URGENCY,
    options: [
      {
        title: 'Rotieren',
        pros: [
          'Beendet die Frage sofort, unabhängig davon, ob der Fund echt ist.',
          'Der einzige Weg, der auch die Kopien in den Sicherungen entwertet.',
        ],
        cons: ['Kostet einen Handgriff je betroffenem Zugangsdatum.'],
        recommended: true,
      },
      {
        title: 'Schon rotiert — Karte schließen',
        pros: ['Richtig, wenn du es bereits getan hast.'],
        cons: [
          'Ändert nichts an den Fundstellen im Archiv; ein späterer Scan schweigt dazu (die Fundstelle gilt als gemeldet).',
        ],
        recommended: false,
      },
      {
        title: 'Fehlalarm — keine Rotation',
        pros: ['Passend für einen Treffer auf eine Fixture oder einen Platzhalter.'],
        cons: [
          'Wenn die Einschätzung falsch ist, bleibt ein gültiges Zugangsdatum in Archiv und Sicherung.',
          'Die Regel bleibt unverändert; derselbe Platzhalter trifft beim nächsten Mal wieder.',
        ],
        recommended: false,
      },
    ],
  };
}

/** Day directories at or after `sinceDay`, oldest first. */
export function daysToScan(entries: readonly string[], sinceDay: string | null): string[] {
  return entries
    .filter((name) => DAY_DIRECTORY.test(name))
    .filter((name) => sinceDay === null || name >= sinceDay)
    .sort();
}

/** `(file, rule)` — the identity a repeat is measured against (decision 3). */
export function transcriptFindingKey(finding: SecretScanFinding): string {
  return `${finding.file}::${finding.rule}`;
}

export class TranscriptLeakScan {
  constructor(private readonly deps: TranscriptLeakScanDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  async run(): Promise<TranscriptLeakOutcome> {
    const sinceDay = await this.lastScannedDay();

    let entries: string[];
    try {
      entries = await readdir(this.deps.transcriptsRoot);
    } catch (error) {
      // Decision 6. An unreadable archive is the case this scan exists for, so
      // it must not be the case it reports as clean.
      return {
        kind: 'infra',
        problem: `Transkript-Archiv nicht lesbar: ${(error as Error).message}`,
      };
    }

    const days = daysToScan(entries, sinceDay);
    const findings: SecretScanFinding[] = [];

    for (const day of days) {
      const result = await this.deps.scanner.scanDirectory(join(this.deps.transcriptsRoot, day), {
        configPath: this.deps.gitleaksConfigPath,
      });
      if (result.verdict === 'infra') {
        return { kind: 'infra', problem: `${day}: ${result.detail}` };
      }
      // Relative to the day directory; prefix it so the card names a path that
      // exists from the archive's root and two days cannot collide on a run id.
      for (const finding of result.findings) {
        findings.push({ ...finding, file: join(day, finding.file) });
      }
    }

    if (findings.length === 0) {
      await this.recordFinished(days, []);
      return { kind: 'clean', daysScanned: days.length };
    }

    const reported = await this.alreadyReported();
    const fresh = findings.filter((f) => !reported.has(transcriptFindingKey(f)));

    if (fresh.length === 0) {
      await this.recordFinished(days, findings);
      return { kind: 'already_reported', daysScanned: days.length, findings };
    }

    const card = leakCard(fresh);
    const { number } = await this.deps.escalations.raise({
      source: LEAK_SOURCE,
      urgency: card.urgency,
      question: card.question,
      context: card.context,
      options: card.options,
      raisedBy: 'security',
    });

    // Written after the card, for `escalation-push.ts`'s reason: a finding
    // recorded as reported before the card exists is a finding nobody will hear
    // about again. A crash between the two costs one duplicate card.
    await this.recordFinished(days, findings, { escalation: number, fresh });

    return { kind: 'leak', daysScanned: days.length, findings: fresh, escalation: number };
  }

  /** The day the last completed scan covered, so the next one resumes there. */
  private async lastScannedDay(): Promise<string | null> {
    const rows = await this.deps.eventLog.recentOfKind('scan.finished', 50);
    for (const event of rows) {
      if (event.kind !== 'scan.finished') continue;
      const payload = event.payload as { kind?: string; throughDay?: string } | null;
      if (payload?.kind !== 'transcript_leak') continue;
      return typeof payload.throughDay === 'string' ? payload.throughDay : null;
    }
    return null;
  }

  /** Every `(file, rule)` this scan has already put in front of the operator. */
  private async alreadyReported(): Promise<Set<string>> {
    const rows = await this.deps.eventLog.recentOfKind('scan.finished', 200);
    const seen = new Set<string>();
    for (const event of rows) {
      if (event.kind !== 'scan.finished') continue;
      const payload = event.payload as { kind?: string; reported?: string[] } | null;
      if (payload?.kind !== 'transcript_leak') continue;
      for (const key of payload.reported ?? []) seen.add(key);
    }
    return seen;
  }

  private async recordFinished(
    days: readonly string[],
    findings: readonly SecretScanFinding[],
    raised?: { escalation: number; fresh: readonly SecretScanFinding[] },
  ): Promise<void> {
    const throughDay = days.length > 0 ? days[days.length - 1] : null;
    await this.deps.eventLog.append({
      kind: 'scan.finished',
      actor: 'security',
      payload: {
        kind: 'transcript_leak',
        at: this.now(),
        daysScanned: days.length,
        throughDay,
        findingCount: findings.length,
        // Classes and paths only — never the match itself (decision 4).
        classes: secretClasses(findings),
        reported: (raised?.fresh ?? []).map(transcriptFindingKey),
        ...(raised ? { escalation: raised.escalation } : {}),
      },
    });
  }
}
