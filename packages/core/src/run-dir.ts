/**
 * The per-run scratch directory (§6.2).
 *
 * Two documents live here and both are written before a spawn and removed
 * after: the `--mcp-config` that binds a session to exactly one task, and the
 * containment policy that binds it to exactly one set of paths. They share a
 * directory so that ending a run is one `rm`, and so that neither can outlive
 * the other — a stale policy beside a fresh config would be the shape of a
 * session contained against the wrong claim set.
 *
 * Not a volume, on purpose: everything in here belongs to a run in flight, and
 * a restart ends every run it could belong to (`reconcile()`).
 */
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

export function runDirFor(runsRoot: string, runId: string): string {
  return join(runsRoot, runId);
}

/**
 * Remove a run's scratch directory.
 *
 * Never throws: this runs on the way out of a run that may already have failed,
 * and a cleanup error masking the real failure would be the worst possible
 * trade. The daily GC sweeps whatever is left.
 */
export async function removeRunDir(runsRoot: string, runId: string): Promise<void> {
  await rm(runDirFor(runsRoot, runId), { recursive: true, force: true }).catch(() => undefined);
}
