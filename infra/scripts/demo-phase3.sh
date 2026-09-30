#!/usr/bin/env bash
# =============================================================================
# Phase 3 exit-gate demonstration (§22).
#
#   infra/scripts/demo-phase3.sh [--on-host] [--with-real-sessions]
#
# Runs the assertions behind each Phase 3 gate rather than describing them, and
# says plainly which of the seven are not settled yet — this phase is in
# progress, so an honest report has open lines in it. Gate states follow A38:
# [x] green · [~] deferred with the command that will prove it · [ ] open, with
# the step of §22 that will close it.
#
# The pattern is demo-phase2.sh's and the reasoning behind it is the same: the
# integration specs skip themselves without TEST_DATABASE_URL, so the database
# is started once for the whole run and its absence is a hard stop rather than
# a skip — a script that reports green while asserting nothing is worse than no
# script.
#
# Exit codes: 0 = no gate is red · 1 = a gate that should hold does not.
# Open gates do not make this script fail; they make it say what is left.
# =============================================================================
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 2
ON_HOST=0
REAL=0
for arg in "$@"; do
  [ "$arg" = '--on-host' ] && ON_HOST=1
  [ "$arg" = '--with-real-sessions' ] && REAL=1
done

pass=0; fail=0; deferred=0; open=0
green()    { printf '  \033[32m[x]\033[0m %s\n' "$1"; pass=$((pass+1)); }
red()      { printf '  \033[31m[ ]\033[0m %s\n' "$1"; fail=$((fail+1)); }
defer()    { printf '  \033[33m[~]\033[0m %s\n       → %s\n' "$1" "$2"; deferred=$((deferred+1)); }
todo()     { printf '  \033[34m[ ]\033[0m %s\n       → %s\n' "$1" "$2"; open=$((open+1)); }
headline() { printf '\n\033[1m%s\033[0m\n' "$1"; }

# Ein Pfad je **Lauf**, nicht je Skript (A121). Auf dieser Maschine liegen
# vierzehn Worktrees; zwei gleichzeitige Nachweislaeufe leerten sonst dieselbe
# Datei, aus der der andere gerade liest. Das ist kein Absturz, sondern ein
# falsches Rot — und ein falsches Rot liest sich wie ein Befund.
LOG="${TMPDIR:-/tmp}/vorschicht-demo-phase3-$$.log"
: > "$LOG"

# Die Suiten unter `apps/` importieren `@vorschicht/core` als **gebautes**
# Artefakt, nicht als Quelltext. Ohne diesen Schritt prüft ein Lauf hier also
# `packages/*/dist` — und das kann in beide Richtungen falsch sein: ein
# korrigierter Baum bleibt rot, weil der alte Fehler noch im Build steht, und
# ein kaputter Baum bleibt grün, weil der alte Stand noch dort steht. Das
# zweite ist das gefährliche, und ein Demo-Skript ist genau die Stelle, an der
# es niemandem auffiele. Gefunden beim Bau von Phase 5, hier nachgezogen.
# `--force`, weil `tsc --build` sonst Zeitstempeln vertraut, und diese Annahme
# soll hier nicht tragen.
printf 'Baue die Pakete neu, damit die Suiten den Baum prüfen … '
if ! npx tsc --build --force >>"$LOG" 2>&1; then
  printf '\n'
  red "der Build schlug fehl — ohne ihn prüfen die Suiten ein altes Artefakt. Siehe $LOG"
  printf '\n\033[1mErgebnis:\033[0m %d grün · %d verschoben · %d offen · %d rot\n' \
    "$pass" "$deferred" "$open" "$fail"
  exit 1
fi
printf 'fertig.\n'

suite() {
  ./infra/scripts/with-test-db.sh ./node_modules/.bin/vitest run --reporter=verbose "$@" \
    >>"$LOG" 2>&1
}

# A test that ran *and passed*, by name. The verbose reporter puts the mark and
# the name at opposite ends of one line, so the match is the name anywhere on a
# line that begins with the pass mark — a failed test carries `×` and therefore
# does not satisfy it, which is the whole reason to look at the mark.
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

assertions() {
  sed "s/${ESC}\[[0-9;]*m//g" "$LOG" | grep -oE 'Tests +[0-9]+ passed' | tail -1 | grep -oE '[0-9]+' | head -1
}

printf '\033[1mPhase 3 — Gates-System & Onboarding (§22)\033[0m\n'
[ "$ON_HOST" = 1 ] && printf 'Lauf auf dem Produktionshost.\n'

# --- G2, G3 and G5 are the three that hold today -----------------------------
# Run once, assert three times: all three gates live in specs that share a
# database, and starting it once per gate would triple the slowest part of this
# script for nothing.
headline 'G2 — jedes optionale Gate blockiert eine gesäte Verletzung und lässt danach durch'
suite packages/core/src/sandbox-gates.test.ts packages/core/src/gate-suite.test.ts \
      packages/core/src/findings.test.ts packages/core/src/findings.itest.ts \
      packages/core/src/dev-chain-prompts.test.ts packages/core/src/merge-queue.itest.ts \
      packages/core/src/onboarding/

g2=0
# The six command gates, each against its own seed, with all six enabled at
# once — "red on this gate and on no other" is the assertion that carries the
# weight (A66), and a per-gate grep is what proves each one actually ran.
for pair in 'licenses" blockiert die Saat „bad_license' \
            'deps-audit" blockiert die Saat „vulnerable_dependency' \
            'sast" blockiert die Saat „sast_finding' \
            'a11y" blockiert die Saat „a11y_violation' \
            'e2e" blockiert die Saat „broken_smoke' \
            'lighthouse" blockiert die Saat „oversized_bundle'; do
  ran_green "$pair" || g2=1
done
ran_green 'ist auf dem ungesäten Baum vollständig grün' || g2=1
ran_green 'deckt genau die optionalen Befehls-Gates des Katalogs mit einer Saat ab' || g2=1
# The two internal diff gates and the un-tickable tenth.
ran_green 'blockiert eine Änderung ohne CHANGELOG-Eintrag' || g2=1
ran_green 'lässt dieselbe Änderung mit CHANGELOG-Eintrag durch' || g2=1
ran_green 'lässt den CHANGELOG allein das Dokumentations-Gate nicht erfüllen' || g2=1
# A66s Umkehrbeweis ist aufgebraucht: solange Lena fehlte, war die ehrliche
# Demonstration die inverse — das Gate liess sich nicht anhaken. Seit sie
# gebaut ist, laesst es sich anhaken, und die Pruefung muss das Gegenteil
# behaupten. Bis zum 16.8.2026 stand hier die alte Zusicherung und traf ins
# Leere; gefunden von `demo-names.test.ts` (A128).
ran_green 'lässt das Rechts-Gate jetzt anhaken — A66s Umkehrbeweis ist aufgebraucht' || g2=1
# The migration gate, end to end through a refused and then allowed merge.
ran_green 'blockiert eine Migration, an der Milo Nachbesserung verlangt' || g2=1
ran_green 'ein angehaktes optionales Gate blockiert den Merge und lässt ihn nach der Behebung durch' || g2=1

if [ "$g2" = 0 ]; then
  green "alle zehn optionalen Gates — sechs Befehls-Gates je mit eigener Saat, changelog/docs, migration-review, legal als nicht anhakbar nachgewiesen ($(assertions) Zusicherungen)"
else
  red 'mindestens ein optionales Gate ist nicht nachgewiesen — siehe '"$LOG"
fi

headline 'G3 — Fehlerklassifikation: Infrastruktur wiederholt mit Wartezeit und wird nie rot'
g3=0
# The unit half: the retry sits at the step, stops on green, never touches a
# finding, waits and doubles, and says so when its budget runs out.
ran_green 'wiederholt einen Infrastrukturfehler und hört auf, sobald er grün ist' || g3=1
ran_green 'gibt nach genau drei Versuchen auf und bleibt "infra", nicht rot' || g3=1
ran_green 'wiederholt einen Befund niemals' || g3=1
ran_green 'wiederholt nur den kaputten Schritt, nicht die Suite' || g3=1
ran_green 'bricht ab, wenn das Wiederholungsbudget der Suite erschöpft ist' || g3=1
# The end-to-end half, and both directions of the exit-gate sentence in one
# test: a persistent simulated outage never colours the task and reaches Ops
# exactly once, and a real test failure on the same candidate still goes red.
ran_green 'stellt den Kandidaten zurück und lässt die Aufgabe in der Warteschlange' || g3=1
ran_green 'meldet einen anhaltenden Infrastrukturfehler genau einmal an Ops, ohne rot zu werden' || g3=1

if [ "$g3" = 0 ]; then
  green 'simulierter Registry-Ausfall: Wiederholung je Schritt mit verdoppelter Wartezeit, Aufgabe bleibt in der Warteschlange, ein Ops-Alarm — ein echter Testfehler wird weiterhin rot'
else
  red 'die Fehlerklassifikation ist nicht nachgewiesen — siehe '"$LOG"
fi

headline 'G5 — Befund-Schleife: Gate rot → Korrekturaufgabe → grün → Merge, durchgängig'
g5=0
# The record §5 asks for: a red step becomes a blocker with the gate's own
# output, an infra step explicitly does not, and nothing closes a finding
# except a *later* green run of the *same* gate on the *same* task.
ran_green 'ein roter Schritt wird zum Befund, mit voller Ausgabe und Blocker-Stufe' || g5=1
ran_green 'ein Infrastrukturfehler ist ausdrücklich kein Befund (A25)' || g5=1
ran_green 'ein späterer grüner Lauf desselben Gates schließt den Befund' || g5=1
ran_green 'ein *früherer* grüner Lauf schließt nichts' || g5=1
ran_green 'ein grüner Lauf einer *anderen* Aufgabe schließt nichts' || g5=1
ran_green 'ein grüner Lauf eines *anderen* Gates schließt nichts' || g5=1
ran_green 'ein Gate-Lauf kann weder geändert noch gelöscht noch geleert werden' || g5=1
# The middle arrow — that the next session is actually told. Both directions,
# because a briefing that is always present makes "this failed before"
# unreadable and every first attempt would be told to fix nothing in particular.
ran_green 'erreicht den Planner' || g5=1
ran_green 'erreicht den Coder mit der wörtlichen Ausgabe' || g5=1
ran_green 'erreicht den Reviewer, samt der Frage, die nur ein Leser beantworten kann' || g5=1
ran_green 'fehlt beim ersten Anlauf vollständig — in allen drei Rollen' || g5=1
# And the loop itself, on one candidate, from the refused merge to the merged one.
ran_green 'führt die Schleife bis grün und schreibt jeden Schritt in die Spur' || g5=1
ran_green 'brieft einen ersten Anlauf mit nichts' || g5=1

if [ "$g5" = 0 ]; then
  green 'ein gesäter Testfehler blockiert den Merge, wird als §5-Befund mit echter Ausgabe festgehalten, steht im Auftrag aller drei Rollen des nächsten Anlaufs, und gilt erst als erledigt, weil ein späterer Lauf dasselbe Gate grün meldet'
else
  red 'die Befund-Schleife ist nicht nachgewiesen — siehe '"$LOG"
fi

# --- G1: the dry run exists; only the operator's reading of it is left (A38) ----------
headline 'G1 — Trockenlauf-Onboarding eines Pilotprojekts (example-app, §20)'
g1=0
# The boundary A41 draws, read off the directory rather than off the design.
ran_green 'fasst das Projekt nicht an und legt nichts an' || g1=1
ran_green 'schickt den absoluten Pfad wirklich in die Sitzung' || g1=1
ran_green 'hält das Ergebnis samt Prüfurteil im Ereignislog fest' || g1=1
# The half that is checked rather than believed — including the case a real run
# found: a monorepo's script lives in a workspace manifest, not in the root (A72).
ran_green 'verweigert ein Skript, das es nicht gibt — und nennt die vorhandenen' || g1=1
ran_green 'findet ein Skript im gefilterten Paket, nicht nur im Wurzelmanifest (A72)' || g1=1
ran_green 'nennt ein unbekanntes Filterziel nicht prüfbar statt falsch' || g1=1
ran_green 'lässt §11 den Versuch ablehnen, ein gesperrtes Gate abzuwählen' || g1=1
# Dieselbe Umkehr eine Ebene weiter: der Onboarding-Vorschlag verschob `legal`,
# solange es nichts zu uebernehmen gab, und uebernimmt es jetzt.
ran_green 'übernimmt das Rechts-Gate jetzt, statt es zu verschieben' || g1=1
# §15's form, because the gate says "reviewed by the operator via inbox-style MC".
ran_green 'hat die §15-Form: Kontext, Optionen mit Pro und Contra, genau eine Empfehlung, Freitext' || g1=1
ran_green 'bietet „übernehmen" gar nicht an, wenn der Vorschlag abgelehnt wurde' || g1=1
# A42: the studio has itself as a project, so §8.2's cadence can fire at all.
ran_green 'legt sich selbst genau einmal an und rührt sich beim zweiten Mal nicht' || g1=1
ran_green 'verweigert sich, wenn dieses Repository die genannten Skripte nicht mehr hat' || g1=1

if [ "$g1" != 0 ]; then
  red 'der Onboarding-Trockenlauf ist nicht nachgewiesen — siehe '"$LOG"
elif [ -f docs/onboarding/example-app.md ]; then
  defer 'Trockenlauf-Onboarding eines Pilotprojekts (example-app), vom Betreiber gesichtet' \
        'der Vorschlag liegt in docs/onboarding/example-app.md (Beispielvorschlag, nichts geschrieben); es fehlt nur die Sichtung durch den Betreiber. Neu erzeugen: pnpm onboard -- --path … --slug example-app --read-only'
else
  red 'docs/onboarding/example-app.md fehlt — der Vorschlag ist nicht erzeugt worden'
fi

# --- G4: not removable via UI *and* API --------------------------------------
headline 'G4 — Basis-Gates weder über die API noch über die Oberfläche entfernbar (§11)'
suite packages/core/src/project-service.itest.ts apps/server/src/projects.itest.ts \
      apps/server/src/app.test.ts

g4=0
# The rule itself, against a real database …
ran_green 'weist das Abwählen eines gesperrten Gates zurück — und hält den Versuch fest' || g4=1
ran_green 'nennt in einer Ablehnung jeden Grund, nicht nur den ersten' || g4=1
ran_green 'liest eine von Hand verbogene Zeile nachsichtig und lässt die sechs trotzdem laufen' || g4=1
# … the translation a page can consume, since the service reports a refusal by
# throwing and a route needs a value …
ran_green 'lehnt das Abwählen eines gesperrten Gates ab, mit allen Gründen' || g4=1
ran_green 'hinterlässt die Ablehnung im Prüfpfad und die Konfiguration unverändert' || g4=1
# … and the transport, including the actor, which is §19's whole point here.
ran_green 'gibt eine abgelehnte Konfiguration mit 422 und allen Gründen zurück' || g4=1
ran_green 'reicht die Sitzung als Urheber durch, nicht „system"' || g4=1
if [ "$g4" != 0 ]; then
  red 'die API-Hälfte hält nicht — siehe '"$LOG"
else
  # The UI half needs a browser, so it is its own suite rather than a vitest
  # spec. Two mutations were run against it: a greyed-out checkbox kills the
  # "bedienbar" assertion, and a form that drops the explicit `false` kills the
  # refusal assertion. Both are why this is more than a screenshot.
  if ./infra/scripts/with-test-db.sh pnpm exec playwright test --project=dashboard \
       >/tmp/vorschicht-demo-phase3-e2e.log 2>&1; then
    # Count the dashboard cases rather than the run's total: the `passkey`
    # project runs first as a declared dependency, and reporting its six as
    # part of this gate would inflate what the gate proves.
    green "Oberfläche: $(grep -cF '[dashboard]' /tmp/vorschicht-demo-phase3-e2e.log) Fälle — Häkchen bedienbar, Ablehnung sichtbar, Versuch im Prüfpfad"
  else
    red 'die Oberflächen-Hälfte ist rot — siehe /tmp/vorschicht-demo-phase3-e2e.log'
  fi
fi

# --- the two that are still open ----------------------------------------------
headline 'Noch offen — was diese Phase zum Abschluss braucht'
todo '`pnpm gate` grün; Doku aktuell' \
     'wird beim Phasenabschluss angehakt, nicht davor'
todo 'Betriebsprüfung (§8.2) gelaufen und Urteil festgehalten' \
     'läuft nach §8.2s Kadenz beim Phasenabschluss: ./infra/scripts/run-audit.sh'

if [ "$REAL" = 1 ]; then
  headline 'Mit echten Sitzungen'
  if ./infra/scripts/check-migration-review.sh >>"$LOG" 2>&1; then
    green 'pnpm check:migration-review — zwei echte Sitzungen, und ihre Antworten unterscheiden sich'
  else
    red 'pnpm check:migration-review fehlgeschlagen — siehe '"$LOG"
  fi
else
  defer 'Migrations-Gate gegen die echte CLI' 'pnpm check:migration-review (zwei Sitzungen, ~3,5 min)'
fi

printf '\n\033[1mErgebnis:\033[0m %d grün · %d verschoben · %d offen · %d rot\n' \
  "$pass" "$deferred" "$open" "$fail"
printf 'Protokoll: %s\n' "$LOG"
[ "$fail" = 0 ] || exit 1
