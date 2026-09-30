#!/usr/bin/env bash
# §10's second layer against the real pinned CLI — the Phase 2 exit gate.
#
# "Reviewer catches an out-of-claim edit (seeded, with hook deliberately
# bypassed via Bash) as a blocker — proving the second layer works
# independently."
#
# Costs subscription budget: one Reviewer session at the strongest tier (A8),
# over a diff of two files. That is why it is not part of `pnpm gate`. It cannot
# be made cheaper without changing what it proves — the gate is a statement about
# what the *Reviewer profile as configured* notices, so downgrading the tier here
# would prove something about a role that does not exist.
#
# See the header of packages/core/src/reviewer-claims.itest.ts for why a
# scripted Reviewer would prove nothing.
#
# Exit codes follow A25: 0 = clean · 1 = finding · 2 = infra failure.
set -euo pipefail

cd "$(dirname "$0")/../.."

if ! command -v claude >/dev/null 2>&1; then
  echo "check-reviewer-claims — die Claude-CLI ist nicht im PATH." >&2
  exit 2
fi

# The hook the session is armed with has to exist as a file, or the run reports
# broken containment for a reason that has nothing to do with the review.
if [ ! -f packages/core/dist/hook-entry.js ]; then
  echo "  … baue packages/core (der Containment-Hook wird als Datei gebraucht)"
  pnpm -r --if-present build >/dev/null
fi

VORSCHICHT_REAL_BACKEND=1 exec infra/scripts/with-test-db.sh \
  pnpm vitest run packages/core/src/reviewer-claims.itest.ts
