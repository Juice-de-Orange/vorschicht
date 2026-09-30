/**
 * Can the daemon actually write where it is about to write?
 *
 * Every path here is one the orchestrator writes to during normal operation,
 * and each of them is a docker **named volume** at runtime. Docker seeds a
 * fresh volume from whatever the image has at the mount point — and where the
 * image has nothing, it creates the mount point as `root:root`, which a daemon
 * running as uid 10001 cannot write.
 *
 * That is not hypothetical. It was the state of every installation until the
 * Dockerfile was corrected, and the two consequences were both silent:
 *
 *  - `/data/transcripts` unwritable → §6.2's transcript copy fails on every
 *    run. The runner treats that correctly as "traceability lost for one run,
 *    never lose the run over it", so the only symptom is a warning line — while
 *    §18's chain from a decision to the transcript line that made it, and
 *    A14's backup of those transcripts, are both empty.
 *  - `/data/worktrees` unwritable → `WorktreeManager.ensure()` cannot create
 *    anything, so **no dev-chain task can run at all**. Every task would have
 *    ended as an infra failure with a git error nobody would connect to a
 *    volume permission.
 *
 * Both were found by starting the daemon and reading its first EACCES, which is
 * an argument for this check rather than against it: the failures are loud in
 * exactly one place and invisible everywhere else. Checking costs one write per
 * directory at start-up and turns both into a refusal that names the fix.
 *
 * The Dockerfile now creates all four with the right ownership, so new
 * installations are correct. An *existing* volume keeps the ownership it was
 * created with, which is why this check exists at all and why its message
 * carries the repair command.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface PathCheck {
  path: string;
  ok: boolean;
  /** German, naming what breaks if this stays. Null when it is fine. */
  problem: string | null;
}

/** What each directory is for, so a refusal says why it matters. */
const CONSEQUENCE: Record<string, string> = {
  transcripts:
    'ohne sie schlägt die Transkript-Kopie aus §6.2 bei jedem Lauf fehl — die ' +
    'Nachvollziehbarkeit aus §18 und die Sicherung aus A14 bleiben leer',
  worktrees:
    'ohne sie kann keine einzige Aufgabe der Entwicklungskette starten (§10) — ' +
    'jede scheitert mit einem Git-Fehler, der wie ein Codeproblem aussieht',
  runs: 'ohne sie startet keine Sitzung — die Containment-Datei aus §6.6 wird pro Lauf geschrieben',
  docs: 'ohne sie nimmt das Dokumenten-Depot aus §13 nichts an',
};

/**
 * Try to create and write each directory, and report per path.
 *
 * A real write rather than a `stat`: the failure mode is ownership, and a
 * directory that exists and is readable tells us nothing about whether we may
 * put a file in it.
 */
export async function checkWritablePaths(paths: readonly string[]): Promise<PathCheck[]> {
  const results: PathCheck[] = [];
  for (const path of paths) {
    const label = path.split('/').filter(Boolean).pop() ?? path;
    try {
      await mkdir(path, { recursive: true });
      const probe = join(path, `.vorschicht-write-probe-${process.pid}`);
      await writeFile(probe, '');
      await rm(probe, { force: true });
      results.push({ path, ok: true, problem: null });
    } catch (error) {
      const why = CONSEQUENCE[label] ?? 'sie wird im Betrieb beschrieben';
      results.push({
        path,
        ok: false,
        problem: `${path} ist nicht beschreibbar (${(error as Error).message}) — ${why}.`,
      });
    }
  }
  return results;
}

/**
 * The message a human needs, including the command that fixes it.
 *
 * Written out rather than left to whoever reads the log, because the cause is
 * two layers away from the symptom: the daemon runs as 10001, the volume was
 * created before the image knew to seed it, and neither fact is visible from
 * "EACCES".
 */
export function repairAdvice(failures: readonly PathCheck[]): string {
  return [
    ...failures.map((failure) => `• ${failure.problem}`),
    '',
    'Ursache: ein bereits vorhandenes Docker-Volume behält die Eigentümerschaft, mit der',
    'es angelegt wurde — das Image legt diese Verzeichnisse inzwischen selbst an, aber nur',
    'für neue Volumes. Einmalig auf dem Host beheben:',
    '',
    '  docker compose -f infra/docker-compose.yml --env-file .env \\',
    '    run --rm --user root --entrypoint chown orchestrator -R 10001:10001 /data',
    '',
    'Danach den Stack neu starten. Siehe docs/OPERATIONS.md.',
  ].join('\n');
}
