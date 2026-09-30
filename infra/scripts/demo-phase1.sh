#!/usr/bin/env bash
# =============================================================================
# Phase 1 exit-gate demonstration (§22).
#
#   infra/scripts/demo-phase1.sh [--on-host]
#
# Runs the assertions behind each Phase 1 gate rather than describing them.
# Gate states follow A38: [x] green · [~] deferred with the command that will
# prove it · [ ] genuinely open.
#
# Most of this costs nothing: the guardian, the meter and the SSE hub are all
# provable against fixtures and the `fake` backend (A37). Only G1 involves a
# real model session, and its evidence is already recorded in ADR 0001.
#
# Exit codes: 0 = every gate green or deferred · 1 = a gate is red.
# =============================================================================
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 2
ON_HOST=0
[ "${1:-}" = '--on-host' ] && ON_HOST=1

pass=0; fail=0; deferred=0
green()    { printf '  \033[32m[x]\033[0m %s\n' "$1"; pass=$((pass+1)); }
red()      { printf '  \033[31m[ ]\033[0m %s\n' "$1"; fail=$((fail+1)); }
defer()    { printf '  \033[33m[~]\033[0m %s\n       → %s\n' "$1" "$2"; deferred=$((deferred+1)); }
headline() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Ein Pfad je **Lauf**, nicht je Skript (A121). Auf dieser Maschine liegen
# vierzehn Worktrees; zwei gleichzeitige Nachweislaeufe leerten sonst dieselbe
# Datei, aus der der andere gerade liest. Das ist kein Absturz, sondern ein
# falsches Rot — und ein falsches Rot liest sich wie ein Befund.
LOG="${TMPDIR:-/tmp}/vorschicht-demo-phase1-$$.log"
: > "$LOG"

headline 'G1 — offizieller Meter-Pfad an einer echten Sitzung belegt, Mechanismus als ADR'
if [ -f docs/adr/0001-rate-limit-capture.md ] && [ -f infra/scripts/spike-rate-limit.mjs ]; then
  if grep -q 'get_usage' docs/adr/0001-rate-limit-capture.md; then
    green 'ADR 0001 hält die beobachtete Antwort wörtlich fest; Spike jederzeit wiederholbar'
    printf '       Wiederholen: node infra/scripts/spike-rate-limit.mjs  (kostet eine kurze echte Sitzung)\n'
  else
    red 'ADR 0001 benennt den Erfassungsweg nicht'
  fi
else
  red 'ADR 0001 oder das Spike-Skript fehlt'
fi

headline 'G2 — simulierte Usage-Ströme beweisen 5h- UND Wochenfenster als Test'
if ./infra/scripts/with-test-db.sh ./node_modules/.bin/vitest run \
     packages/core/src/guardian-service.itest.ts packages/shared/src/guardian.test.ts >>"$LOG" 2>&1; then
  n="$(grep -oE 'Tests +[0-9]+ passed' "$LOG" | tail -1 | grep -oE '[0-9]+' | head -1)"
  green "${n:-?} Zusicherungen: Schwellen beider Fenster, Latch, Reset, Fail-closed, manuelle Pause"
  printf '       Kein einziger echter Modellaufruf — dafür gibt es das fake-Backend (A37)\n'
else
  red "Guardian-Nachweis rot — siehe $LOG"
fi

headline 'G6 — Kreuzprobe Token-Meter, Divergenz-Alarm'
if ./infra/scripts/with-test-db.sh ./node_modules/.bin/vitest run \
     packages/core/src/usage-meter.itest.ts packages/shared/src/usage.test.ts >>"$LOG" 2>&1; then
  green 'Divergenz wird gemeldet statt stillschweigend aufgelöst; Skalenverdacht ist fail-closed'
else
  red "Meter-Nachweis rot — siehe $LOG"
fi

headline 'G7 — SSE: Reconnect und Snapshot-Resync'
if ./infra/scripts/with-test-db.sh ./node_modules/.bin/vitest run \
     apps/server/src/sse.test.ts packages/core/src/event-log.itest.ts >>"$LOG" 2>&1; then
  green 'Nachholen per Last-Event-ID, Fan-out an mehrere Clients, 50-KB-Nutzlast durch die Kette'
else
  red "SSE-Nachweis rot — siehe $LOG"
fi

headline 'G8 — Append-only durchgesetzt, pnpm gate grün, Doku aktuell'
missing=()
for file in README.md CHANGELOG.md docs/adr/0001-rate-limit-capture.md; do
  [ -f "$file" ] || missing+=("$file")
done
if [ ${#missing[@]} -gt 0 ]; then
  printf '       fehlt: %s\n' "${missing[@]}"
  red 'Doku unvollständig'
elif pnpm gate >>"$LOG" 2>&1; then
  green 'Sieben Gate-Schritte grün; sieben Tabellen mit Guard-Trigger, TRUNCATE eingeschlossen'
else
  red "pnpm gate rot — siehe $LOG"
fi

# -----------------------------------------------------------------------------
# G3, G4 and G5 were deferred to Phase 2 step 1, because their gate texts name
# tasks and claims that §22's own Phase 1 step list never introduced. That step
# is done: the task model, the wrap-up protocol and the restart reconciliation
# all exist, and all three gates are proved by one suite — against a real
# Postgres and a real git repository, without spending a single token.
# -----------------------------------------------------------------------------
headline 'G3/G4/G5 — Aufräumprotokoll, Chaos-Abgleich, Auth-Vorfall'
if ./infra/scripts/with-test-db.sh ./node_modules/.bin/vitest run \
     packages/core/src/wrap-up.itest.ts packages/core/src/task-service.itest.ts \
     packages/db/src/tasks.itest.ts packages/shared/src/task-state.test.ts >>"$LOG" 2>&1; then
  n="$(grep -oE 'Tests +[0-9]+ passed' "$LOG" | tail -1 | grep -oE '[0-9]+' | head -1)"
  green "G3 — mitten in der Arbeit geparkt: WIP-Commit auf dem Task-Branch, Übergabenotiz, danach fortgesetzt und abgeschlossen"
  green 'G4 — verwaiste Läufe geschlossen, Aufgabe als "unterbrochen" markiert, Fortsetzung erst nach Integritätsprüfung'
  green 'G5 — Auth-Vorfall parkt laufende Arbeit; null rote Tasks; saubere Erholung nach Tokenwechsel'
  printf '       %s Zusicherungen; der WIP-Commit auf einem geschützten Branch wird verweigert (§7.3)\n' "${n:-?}"
else
  red "Aufräum-/Abgleichnachweis rot — siehe $LOG"
fi

if [ "$ON_HOST" -eq 1 ]; then
  printf '       Auf dem Produktionshost zusätzlich prüfbar: Container mit falschem Token starten,\n'
  printf '       danach `SELECT count(*) FROM tasks WHERE state = '"'"'red'"'"'` muss 0 bleiben.\n'
fi

printf '\n\033[1m── Phase 1 ────────────────────────────────────\033[0m\n'
printf '  grün: %d · verschoben: %d · rot: %d\n\n' "$pass" "$deferred" "$fail"
[ "$fail" -eq 0 ] || exit 1
