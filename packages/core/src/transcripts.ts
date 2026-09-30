/**
 * Archiving a session's transcript (§6.2, §18, A15).
 *
 * §6.2 requires that every run persists "a copy of the session JSONL transcript
 * into the transcripts volume", and §18 keeps it: raw for 90 days, gzipped for
 * a year. Principle 4 is why — the traceability chain goal → task → run →
 * transcript → diff ends at a line in this file, and the original lives in the
 * CLI's own config directory, which is a volume nobody backs up and which a
 * `claude` update is free to reorganise.
 *
 * A copy, not a move. The CLI owns its file: `--resume` reads it, and §6.4's
 * escalation round-trip resumes a parked session days later. Moving the
 * transcript out from under a session that is about to be continued would break
 * the one mechanism the inbox depends on.
 *
 * Laid out by date rather than flat, because the retention job §18 asks for
 * ("raw 90 days, then gzip") is then a directory-level sweep instead of a stat
 * per file — and after a year of unattended operation there are a lot of files.
 * The date is UTC: it names a directory, not a report, so §2's Europe/Vienna
 * rule does not apply and an unambiguous name is worth more than a local one.
 */
import { copyFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface ArchiveTranscriptInput {
  /** `<dataRoot>/transcripts` — see `Config.transcriptsRoot`. */
  transcriptsRoot: string;
  runId: string;
  /** Where the backend left it, or null if it keeps none. */
  source: string | null;
  now?: () => number;
}

export type ArchiveTranscriptResult =
  | { archived: true; path: string; bytes: number }
  /** Not an error: some backends keep no transcript, and that is a fact, not a fault. */
  | { archived: false; problem: string };

export function transcriptArchivePath(transcriptsRoot: string, runId: string, at: number): string {
  const day = new Date(at).toISOString().slice(0, 10);
  return join(transcriptsRoot, day, `${runId}.jsonl`);
}

/**
 * Copy the transcript into the archive.
 *
 * Never throws. A run reaches this point having already done its work, and a
 * failure to copy its log is a gap in the record, not a reason to discard the
 * record — the caller reports the problem on the run's `terminated` event,
 * where an auditor looking for the transcript will find out why there is none
 * instead of finding nothing at all.
 */
export async function archiveTranscript(
  input: ArchiveTranscriptInput,
): Promise<ArchiveTranscriptResult> {
  if (!input.source) {
    return {
      archived: false,
      problem: 'Das Backend führt kein Sitzungsprotokoll.',
    };
  }

  const at = input.now?.() ?? Date.now();
  const target = transcriptArchivePath(input.transcriptsRoot, input.runId, at);
  try {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(input.source, target);
    const { size } = await stat(target);
    return { archived: true, path: target, bytes: size };
  } catch (error) {
    return {
      archived: false,
      problem: `Sitzungsprotokoll ${input.source} nicht archivierbar: ${(error as Error).message}`,
    };
  }
}
