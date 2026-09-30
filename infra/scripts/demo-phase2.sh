#!/usr/bin/env bash
# =============================================================================
# Phase 2 exit-gate demonstration (§22).
#
#   infra/scripts/demo-phase2.sh [--on-host] [--with-real-sessions]
#
# Runs the assertions behind each Phase 2 gate rather than describing them.
# Gate states follow A38: [x] green · [~] deferred with the command that will
# prove it · [ ] genuinely open.
#
# Three gates cannot be settled without a real model session, and each says so
# with the command that settles it. They are skipped by default because they
# cost subscription budget — the operator works on the same account — and run with
# `--with-real-sessions`. What they prove is recorded in the gate texts of
# CLAUDE.md and cannot be moved into a fixture: a scripted Reviewer returning
# `claimsRespected: false` proves that a fixture returned the string it was
# handed.
#
# Exit codes: 0 = every gate green or deferred · 1 = a gate is red.
# =============================================================================
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 2
ON_HOST=0
REAL=0
for arg in "$@"; do
  [ "$arg" = '--on-host' ] && ON_HOST=1
  [ "$arg" = '--with-real-sessions' ] && REAL=1
done

pass=0; fail=0; deferred=0
green()    { printf '  \033[32m[x]\033[0m %s\n' "$1"; pass=$((pass+1)); }
red()      { printf '  \033[31m[ ]\033[0m %s\n' "$1"; fail=$((fail+1)); }
defer()    { printf '  \033[33m[~]\033[0m %s\n       → %s\n' "$1" "$2"; deferred=$((deferred+1)); }
headline() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Ein Pfad je **Lauf**, nicht je Skript (A121). Auf dieser Maschine liegen
# vierzehn Worktrees; zwei gleichzeitige Nachweislaeufe leerten sonst dieselbe
# Datei, aus der der andere gerade liest. Das ist kein Absturz, sondern ein
# falsches Rot — und ein falsches Rot liest sich wie ein Befund.
LOG="${TMPDIR:-/tmp}/vorschicht-demo-phase2-$$.log"
: > "$LOG"

# Every integration spec here needs a real Postgres, and every one of them
# skips itself without TEST_DATABASE_URL — which would make this script report
# green while asserting nothing. So the database is started once for the whole
# run rather than per gate, and its absence is a hard stop rather than a skip.
# `--reporter=verbose`, deliberately: the default reporter prints only the slow
# tests, so grepping the log for a test name would silently answer "not run" for
# a test that ran and passed. Two gates below are settled by a named test inside
# a file another gate already runs, and a grep that cannot see it would report
# them red for the wrong reason — or, with the condition inverted, green for it.
suite() {
  ./infra/scripts/with-test-db.sh ./node_modules/.bin/vitest run --reporter=verbose "$@" \
    >>"$LOG" 2>&1
}

# A test that ran and passed, by name.
#
# The verbose reporter writes `✓ <file> > <describe> > … > <name> <duration>`,
# so the mark and the name are at opposite ends of the line: the match is the
# name anywhere on a line that begins with the pass mark. A failed test carries
# `×` and therefore does not satisfy this — which is the point of looking at the
# mark rather than at the name alone.
# Ein Escape-Zeichen, portabel erzeugt: \x1b in einem sed-Ausdruck ist eine
# GNU-Erweiterung, und diese Skripte sollen auch dort laufen, wo sed das nicht
# kennt.
ESC=$(printf '\033')

ran_green() {
  # Farbenblind, und zwar absichtlich. Vitest faerbt auch dann, wenn seine
  # Ausgabe in eine Datei geht (gemessen am 16.8.2026 im Gate-Container), und
  # das Haekchen steht dann nicht mehr am Zeilenanfang. Die Demo meldete
  # daraufhin "haelt seine Zusicherungen nicht", waehrend alle neunzehn
  # Zusicherungen gruen waren — ein Fehlalarm derselben Klasse, die A115 eine
  # Ebene hoeher behoben hat. Eine Pruefung, die aus einem Grund rot wird, der
  # mit ihrem Gegenstand nichts zu tun hat, ist eine Pruefung, die niemand mehr
  # liest.
  sed "s/${ESC}\[[0-9;]*m//g" "$LOG" | grep -F "$1" | grep -q '^ *✓'
}

# The count vitest reported, so a gate can say how much it stands on.
assertions() {
  sed "s/${ESC}\[[0-9;]*m//g" "$LOG" | grep -oE 'Tests +[0-9]+ passed' | tail -1 | grep -oE '[0-9]+' | head -1
}

headline 'G1 — zwei parallele Aufgaben mit getrennten Claims mergen sauber nacheinander'
if suite packages/core/src/merge-queue.itest.ts; then
  green "$(assertions) Zusicherungen: beide Kandidaten durch die Kette, dann seriell gemerged"
  printf '       Der zweite rebased auf den Commit des ersten — das beweist die Serialisierung,\n'
  printf '       statt sie anzunehmen (§10).\n'
else
  red "Merge-Queue-Nachweis rot — siehe $LOG"
fi

headline 'G2 — überlappende Claims werden erkannt und serialisiert'
if suite packages/core/src/claim-registry.itest.ts packages/shared/src/claims.test.ts; then
  green "$(assertions) Zusicherungen; die Sperre wird von außen gehalten, nicht per Promise.all geraten"
else
  red "Claim-Nachweis rot — siehe $LOG"
fi

headline 'G3 — Containment-Hooks verweigern vor der Ausführung (§6.6)'
if [ "$REAL" -eq 1 ]; then
  if pnpm -s check:hook-containment >>"$LOG" 2>&1; then
    green 'Eine echte Sitzung: 4 PreToolUse-Prüfungen, 3 Verweigerungen, 1 erlaubter Schreibzugriff'
  else
    red "Containment-Nachweis rot — siehe $LOG"
  fi
else
  defer 'Hook-Containment an der echten CLI (kostet eine Haiku-Sitzung)' \
        'pnpm check:hook-containment'
fi

headline 'G4 — gesäte Fehler blockieren den Merge einzeln, danach merged er'
if ran_green 'ein fehlschlagender Test' && ran_green 'ein Lint-Verstoß' \
   && ran_green 'ein eingeschmuggeltes Geheimnis — mit echtem gitleaks' \
   && ran_green 'und derselbe Kandidat merged, sobald der Fehler behoben ist'; then
  green 'Test, Lint und ein echtes gitleaks — jeder Defekt für sich blockierend (siehe G1-Lauf)'
  printf '       Der gesäte Token wird aus einem Hash abgeleitet: die erste Fassung hatte keine\n'
  printf '       Entropie und wurde von gitleaks gar nicht erkannt (A55).\n'
else
  red "Der Nachweis der gesäten Fehler lief nicht mit — siehe $LOG"
fi

headline 'G5 — das Review fängt eine Änderung außerhalb der Claims (§10, zweite Schicht)'
if [ "$REAL" -eq 1 ]; then
  if pnpm -s check:reviewer-claims >>"$LOG" 2>&1; then
    green 'Echte Reviewer-Sitzung: changes_requested, die Datei außerhalb der Claims benannt'
  else
    red "Reviewer-Nachweis rot — siehe $LOG"
  fi
else
  defer 'Review an der echten CLI (kostet eine Sitzung der stärksten Stufe)' \
        'pnpm check:reviewer-claims'
fi

headline 'G6 — roter Pfad: zweimal gescheitert → einmal requeued, dann eskaliert'
if suite packages/core/src/dev-chain.itest.ts; then
  green "$(assertions) Zusicherungen; auch der Fall, dass die Diagnose selbst scheitert"
else
  red "Nachweis des roten Pfads rot — siehe $LOG"
fi

headline 'G7 — Bot-Autorenschaft, keine verwaisten Worktrees und Branches'
if ran_green 'bringt nur Commits der Bot-Identität auf den Integrationsbranch (A20/A36)' \
   && ran_green 'lässt keinen verwaisten Worktree und keinen verwaisten Branch zurück' \
   && ran_green 'lässt keinen Task-Branch eines abgeschlossenen Tasks stehen'; then
  green 'foreignCommits() über den echten Commit-Bereich; GC-Lauf ohne removed/kept/strays'
  printf '       `removed` wird seit der ersten Betriebsprüfung mitgeprüft — vorher hätte die\n'
  printf '       Zusicherung eine vom Lauf selbst beseitigte Waise nicht sehen können.\n'
else
  red "Der Aufräumnachweis lief nicht mit — siehe $LOG"
fi

headline 'G8 — Betriebsprüfung gelaufen, Urteil aufgezeichnet (§8.2)'
if suite packages/core/src/audit; then
  n="$(assertions)"
  if ls docs/pruefberichte/*.md >/dev/null 2>&1; then
    verdict="$(grep -h '^## 6. Urteil' -A 2 docs/pruefberichte/*.md | tail -1)"
    green "${n} Zusicherungen zum Prüfdienst; Prüfbericht liegt vor"
    printf '       Letztes Urteil: %s\n' "${verdict:-unbekannt}"
    printf '       Ein Urteil ist eine Momentaufnahme: was aus seinen Funden wurde, steht am\n'
    printf '       jeweiligen Gate in CLAUDE.md — die erste Prüfung entwertete P1.G5 und P2.G7,\n'
    printf '       beide Funde sind behoben und beide Haken tragen den Vermerk.\n'
    printf '       Erneut prüfen: infra/scripts/run-audit.sh --domain <domäne> --trigger manual\n'
  else
    red 'Kein Prüfbericht unter docs/pruefberichte/ — das Urteil ist nicht aufgezeichnet'
  fi
else
  red "Nachweis des Prüfdienstes rot — siehe $LOG"
fi

headline 'Querschnitt — der interne MCP-Server gewinnt das Startrennen (A49)'
if [ "$REAL" -eq 1 ]; then
  if pnpm -s check:mcp-handshake >>"$LOG" 2>&1; then
    green 'Handshake gegen die gepinnte CLI innerhalb des system:init-Fensters'
  else
    red "MCP-Handshake rot — siehe $LOG"
  fi
else
  defer 'MCP-Handshake an der echten CLI (kostet keinen Modellzug, aber eine CLI)' \
        'pnpm check:mcp-handshake'
fi

if [ "$ON_HOST" -eq 1 ]; then
  printf '\n       Auf dem Produktionshost zusätzlich: `docker compose … exec orchestrator node dist/main.js`\n'
  printf '       muss die Migrationen 0006–0013 anwenden und die Rollen-Settings schreiben.\n'
fi

printf '\n\033[1m── Phase 2 ────────────────────────────────────\033[0m\n'
printf '  grün: %d · verschoben: %d · rot: %d\n\n' "$pass" "$deferred" "$fail"
[ "$fail" -eq 0 ] || exit 1
