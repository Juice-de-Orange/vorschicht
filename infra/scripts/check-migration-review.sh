#!/usr/bin/env bash
# §11's migration gate against the real pinned CLI — the Phase 3 exit gate.
#
# "Every optional gate demonstrably blocks a seeded violation in the sandbox
# project and passes after fix." For fifteen of the sixteen gates that is a
# command or a question git answers, and `merge-queue.itest.ts` settles it for
# free. This one is an agent session (A63), and the half a scripted reviewer
# cannot prove is whether a real `db-review` run actually notices that a
# migration breaks the release that is currently deployed.
#
# Costs subscription budget: **two** sessions at the strongest tier (A8), over
# two one-line migrations. Two rather than one deliberately — a reviewer that
# answered "not backward-compatible" to everything would pass a one-sided check
# and would then block every schema change this studio ever makes. The assertion
# is that the two answers differ. See the header of
# packages/core/src/migration-review.itest.ts.
#
# Exit codes follow A25: 0 = clean · 1 = finding · 2 = infra failure.
set -euo pipefail

cd "$(dirname "$0")/../.."

if ! command -v claude >/dev/null 2>&1; then
  echo "check-migration-review — die Claude-CLI ist nicht im PATH." >&2
  exit 2
fi

# The hook the session is armed with has to exist as a file, or the run reports
# broken containment for a reason that has nothing to do with the migration.
if [ ! -f packages/core/dist/hook-entry.js ]; then
  echo "  … baue packages/core (der Containment-Hook wird als Datei gebraucht)"
  pnpm -r --if-present build >/dev/null
fi

VORSCHICHT_REAL_BACKEND=1 exec infra/scripts/with-test-db.sh \
  pnpm vitest run packages/core/src/migration-review.itest.ts
