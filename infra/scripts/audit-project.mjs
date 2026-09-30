/**
 * The pure half of `run-audit.mjs`'s project bookkeeping.
 *
 * Split out for A125.3's reason, learned two directories over: `run-audit.mjs`
 * connects to Postgres and spawns a paid model session at import time, so a
 * test that imported it to pin one decision would run an audit instead. The
 * decision lives here, the side effect lives there.
 *
 * ## Why this file exists at all
 *
 * Found on 2026-08-18, by running the auditor on the build machine rather than
 * by reading it. `run-audit.sh` died before its first line of work:
 *
 *     PostgresError: new row for relation "projects"
 *     violates check constraint "projects_root_path_absolute"
 *
 * `0001_foundation.sql:67` declares `CHECK (root_path LIKE '/%')` — the schema
 * says a project root is a POSIX absolute path, because the studio runs in
 * Linux containers. `run-audit.mjs` handed it `join(dirname(fileURLToPath(…)),
 * '../..')`, which on a Windows build machine is `C:\src\project`. On Linux that
 * expression happens to be POSIX-absolute and the constraint never notices; on
 * Windows it can never satisfy it.
 *
 * That is A130's class exactly, one layer down: A130 fixed six scripts whose
 * `await import()` took an absolute path where a `file://` URL was required —
 * also invisible on Linux, also fatal here — and this is the next wall behind
 * it. Both share a shape worth naming: **a script that is correct on Linux by
 * accident of what a path looks like there.** It hit the one department whose
 * purpose is to check this project's claims about itself, which is why it went
 * unnoticed: nothing in `pnpm gate` runs the auditor.
 *
 * ## The limit of what `posixRootPath` produces, stated rather than implied
 *
 * `/c/src/project` is Git Bash's own mapping of `C:\src\project`
 * and resolves in the shell `run-audit.sh` runs in. It does **not** resolve in
 * Node on Windows. So a caller may store it, print it and compare it — and must
 * never `join()` it and hand the result to `fs`. Today nobody does:
 * `AuditService` takes `specPath` as its own argument (`run-audit.mjs`), and
 * the one caller that does derive a path from the stored row —
 * `build-scheduler.ts:263`, `join(selfProject.rootPath, 'CLAUDE.md')` — is the
 * daemon, which runs on Linux against `/opt/vorschicht`. A future caller that
 * breaks that rule gets a path that does not exist rather than a wrong file,
 * which is the safe direction, but it is a rule and it is written down here.
 */

/** Windows drive-letter root, either slash direction: `C:\x`, `c:/x`. */
const DRIVE = /^([A-Za-z]):[\\/]/;

/**
 * The form `projects.root_path` requires (`LIKE '/%'`), or `null` when the
 * input cannot be expressed as one.
 *
 * `null` rather than a throw, and rather than a guess: the caller is the only
 * party that knows whether a missing project row should stop the run or be
 * asked of the operator, and a guessed path in the row that records *which
 * repository was audited* is worse than no row at all.
 */
export function posixRootPath(input) {
  if (typeof input !== 'string' || input.length === 0) return null;
  const drive = DRIVE.exec(input);
  if (drive) {
    const rest = input.slice(drive[0].length).replace(/\\/g, '/');
    // Lower-cased to match Git Bash, which maps `C:\` to `/c/` and not `/C/`.
    return `/${drive[1].toLowerCase()}/${rest}`.replace(/\/+$/, '') || '/';
  }
  if (input.startsWith('/')) return input.replace(/\\/g, '/').replace(/(.)\/+$/, '$1');
  // A relative path, a UNC share, anything else: not representable, say so.
  return null;
}

/**
 * The row `run-audit.mjs` creates when a database has no `vorschicht` project
 * yet (A42 — Vorschicht is its own pilot, so the fix tasks a `defect` produces
 * belong to this repository's own project).
 *
 * **`readOnly: true` is the point of this function.** The daemon's path,
 * `ensureSelfManagedProject` (`packages/core/src/onboarding/self.ts:308`), has
 * passed it since A85; `run-audit.mjs` called `ProjectService.create()` raw and
 * did not, and `0008_worktrees.sql:30` defaults the column to `false`. So a
 * fresh database got a **writable** self-managed project from the auditor.
 *
 * Stated precisely, because the first version of this note claimed more than it
 * could carry and a refuter took it apart: that did **not** let a `gate_invalid`
 * edit `CLAUDE.md`. `AuditService.writeRefusal` (`audit-service.ts:843-872`) has
 * four branches, and `run-audit.mjs` is stopped by the *second* — it passes
 * `projectId` and no `projects`, so the service cannot look the flag up at all
 * and fails closed before `readOnly` is ever read. `audit-service.itest.ts:700`
 * pins exactly that arrangement against a deliberately **writable** project.
 * The documents are right; my diagnosis was wrong.
 *
 * What remains is a real but latent defect: the row is left writable, and the
 * day someone hands `AuditService` a `projects` lookup — which is the obvious
 * improvement, since it turns a blanket refusal into an informed one — that row
 * would start authorising unattended edits to this file. A85 is the decision;
 * the two creation paths should not disagree about it.
 */
export function selfProjectSpec(rootPath) {
  const posix = posixRootPath(rootPath);
  if (posix === null) return null;
  return {
    slug: 'vorschicht',
    name: 'Vorschicht',
    rootPath: posix,
    selfManaged: true,
    readOnly: true,
    defaultBranch: 'main',
  };
}
