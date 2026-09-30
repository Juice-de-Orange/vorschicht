#!/usr/bin/env bash
# The runner against the real pinned CLI (§6.2, §6.3).
#
# Costs subscription budget — one economy-tier session, a few cents — which is
# why it is not part of `pnpm gate`. What it buys is the set of claims a
# scripted stand-in cannot settle, chief among them that the transcript really
# lands where `HeadlessRunHandle.transcriptPath()` looks for it. See the header
# of packages/core/src/runner-real.itest.ts.
#
# Exit codes follow A25: 0 = clean · 1 = finding · 2 = infra failure.
set -euo pipefail

cd "$(dirname "$0")/../.."

if ! command -v claude >/dev/null 2>&1; then
  echo "check-runner — die Claude-CLI ist nicht im PATH." >&2
  exit 2
fi

# The hook the sessions are armed with has to be compiled, or every run would
# report broken containment for a reason that has nothing to do with the CLI.
if [ ! -f packages/core/dist/hook-entry.js ]; then
  echo "  … baue packages/core (der Containment-Hook wird als Datei gebraucht)"
  pnpm -r --if-present build >/dev/null
fi

VORSCHICHT_REAL_BACKEND=1 exec infra/scripts/with-test-db.sh \
  pnpm vitest run packages/core/src/runner-real.itest.ts
