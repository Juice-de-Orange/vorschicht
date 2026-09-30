#!/usr/bin/env bash
# One Betriebsprüfung (§8.2) against the real pinned CLI.
#
#   infra/scripts/run-audit.sh --domain gate_truth --trigger phase_close \
#     --scope "Phasen 0–2, rückwirkend."
#   infra/scripts/run-audit.sh --domain dead_wiring --dry-run
#
# Costs subscription budget: one session at the strongest tier, which §8.2
# makes non-negotiable — "Cutting the auditor first is how a studio stops
# noticing." That is why this is not part of `pnpm gate`.
#
# DATABASE_URL is required for a real run, and that is a repair rather than a
# convenience (A76, A117).
#
# This used to fall back to a throwaway Postgres, and the fallback quietly threw
# away half of what an audit produces. §8.2's consequences are *writes*: a
# `coverage_gap` files a P2 task unconditionally (A65), a `gate_invalid` raises a
# P1 inbox item, a dismissal is counted so the next audit can re-open it exactly
# once. All of that landed in a container that was deleted seconds later, while
# the run reported success. It happened twice — the Phase-3 close filed four
# correctly-evidenced findings that evaporated (A76), and they were only rescued
# because a human read the committed report.
#
# The committed Prüfbericht under docs/pruefberichte/ is still the durable half
# and still carries the prose. What it cannot carry is a task somebody works on.
# So: `--dry-run` may use a throwaway database, because it files nothing; a real
# run refuses instead of writing into a database with a lifetime shorter than
# its own findings. "We could not record it" and "we recorded it" are the same
# sentence only to a system that has decided not to notice (A83.6).
#
# Exit codes carry the verdict:
#   0 unbedenklich · 1 funde_zu_beheben · 3 phase_nicht_abschliessbar · 2 infra
set -euo pipefail

cd "$(dirname "$0")/../.."

if ! command -v claude >/dev/null 2>&1; then
  echo "run-audit — die Claude-CLI ist nicht im PATH." >&2
  exit 2
fi

# The hook the session is armed with has to exist as a file, or the run reports
# broken containment for a reason that has nothing to do with the audit.
if [ ! -f packages/core/dist/hook-entry.js ] || [ ! -f packages/core/dist/index.js ]; then
  echo "  … baue die Pakete (der Containment-Hook wird als Datei gebraucht)"
  pnpm -r --if-present build >/dev/null
fi

if [ -n "${DATABASE_URL:-}" ]; then
  exec node infra/scripts/run-audit.mjs "$@"
fi

# No durable database. A dry run files nothing, so a throwaway one is honest
# there; a real run would lose its own consequences.
for arg in "$@"; do
  if [ "$arg" = "--dry-run" ]; then
    exec infra/scripts/with-test-db.sh node infra/scripts/run-audit.mjs "$@"
  fi
done

cat >&2 <<'EOF'
run-audit — kein DATABASE_URL gesetzt, und ohne eine dauerhafte Datenbank
verliert dieser Lauf genau die Hälfte, für die er läuft.

Eine Betriebsprüfung schreibt: P2-Aufgaben aus `coverage_gap`-Funden (A65),
eine P1-Karte aus einem `gate_invalid`, und die Zählung, mit der die nächste
Prüfung eine Verwerfung genau einmal wieder aufmacht (§8.2). In einer
Wegwerf-Postgres ist das nach dem Lauf weg, während der Lauf Erfolg meldet.
Genau so sind am 2.8. vier belegte Funde verschwunden (A76).

Zwei Wege:
  DATABASE_URL=postgres://…  infra/scripts/run-audit.sh …    (echter Lauf)
  infra/scripts/run-audit.sh --dry-run …                     (schreibt nichts)
EOF
exit 2
