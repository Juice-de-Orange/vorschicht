#!/usr/bin/env bash
# §20's dry-run onboarding against the real pinned CLI.
#
#   infra/scripts/onboard.sh --path /path/to/example-app \
#     --slug example-app --name "Example App" --read-only
#
# Analyses a repository and writes the proposal to docs/onboarding/<slug>.md.
# Nothing is written to the analysed repository and no project is created —
# `--apply` is a separate step for a proposal somebody has read (§20).
#
# Costs subscription budget: one session at the strongest tier. Not in
# `pnpm gate`.
#
# Uses DATABASE_URL when one is set (the deployed stack), otherwise a throwaway
# Postgres — in which case the machine-readable record does not survive the run
# and the committed proposal is the durable half, exactly as for run-audit.sh.
#
# Exit codes: 0 übernehmbar · 1 abgelehnt · 2 infra · 3 keine Antwort
set -euo pipefail

cd "$(dirname "$0")/../.."

if ! command -v claude >/dev/null 2>&1; then
  echo "onboard — die Claude-CLI ist nicht im PATH." >&2
  exit 2
fi

# The hook the session is armed with has to exist as a file, or the run reports
# broken containment for a reason that has nothing to do with the analysis.
if [ ! -f packages/core/dist/hook-entry.js ] || [ ! -f packages/core/dist/index.js ]; then
  echo "  … baue die Pakete (der Containment-Hook wird als Datei gebraucht)"
  pnpm -r --if-present build >/dev/null
fi

if [ -n "${DATABASE_URL:-}" ]; then
  exec node infra/scripts/onboard.mjs "$@"
fi

exec infra/scripts/with-test-db.sh node infra/scripts/onboard.mjs "$@"
